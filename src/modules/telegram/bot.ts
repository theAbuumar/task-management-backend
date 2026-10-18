// Telegram bot as a work tool, inside the backend (ADR-011, режим 6 дней).
//
// The webhook (auth/service handleTelegramUpdate) keeps the sign-in and invite
// flows and hands everything else here:
//   - the main menu (reply keyboard): my tasks, due today, overdue, waiting for my
//     review, under my control — paged lists across all my workspaces;
//   - an issue card with the buttons the user is entitled to: «Ознакомлен»,
//     «Сдать на проверку», «Выполнено», «Принять» / «Вернуть», deadline-change
//     decision, comment, link to the site;
//   - the same buttons under outgoing notifications (lib/deliver, issues/service);
//   - text answers: a report, a return remark, a comment or a new deadline the bot
//     asked for (TelegramPendingInput);
//   - files for a report: documents and photos sent after «Сдать на проверку», or
//     sent first and then given a task (TelegramPendingFile). They are fetched from
//     Telegram into attachment storage on hand-in, like files attached on the site.
//
// The tapping account is resolved from the Telegram user id (Telegram signs the
// update; the webhook checks its secret header). Every action then goes through
// the regular services, which enforce the same permissions as the web app, and
// reaches open browsers through the live event stream (8.B1).

import type { PrismaClient, TelegramPendingFile } from '@prisma/client';
import { config } from '../../config/index.js';
import { controlSettings } from '../../lib/control-settings.js';
import { AppError } from '../../lib/errors.js';
import { pluralize } from '../../lib/plural.js';
import { BLOCKED_EXTENSIONS, extensionOf } from '../../lib/file-policy.js';
import type { StorageDriver } from '../../lib/storage.js';
import { issueUrl } from '../../lib/urls.js';
import { addDays, localDate, startOfLocalDay } from '../../lib/tz.js';
import { assertCanWrite, seesAllProjects } from '../../plugins/workspace-hook.js';
import { visibleIssuesWhere } from '../issues/scope.js';
import * as issueService from '../issues/service.js';
import * as controlService from '../control/service.js';
import * as commentService from '../comments/service.js';
import * as attachmentService from '../attachments/service.js';
import { firstStateOfGroup, isReviewer, OPEN_GROUPS } from '../control/rules.js';
import {
  BOT_DOWNLOAD_LIMIT,
  answerCallbackQuery,
  downloadBotFile,
  editBotMessage,
  sendBotMessage,
  type InlineButton,
  type TelegramCallbackQuery,
  type TelegramMessage,
} from '../auth/telegram.service.js';
import {
  CB,
  FILES,
  MENU_BUTTONS,
  MENU_KEYBOARD,
  NOT_LINKED,
  PAGE_SIZE,
  PROMPTS,
  WELCOME,
  cardMessage,
  errorText,
  formatDate,
  formatTime,
  listMessage,
  parseDeadlineInput,
  pickIssueMessage,
  stagedFilesMessage,
  type ActionVerb,
  type CardRights,
  type ListFilter,
} from './views.js';

const INPUT_TTL_MS = 15 * 60 * 1000;
/** Files per hand-in — a Telegram album holds up to 10. */
const MAX_FILES = 10;
const COMMANDS: Record<string, ListFilter> = {
  '/my': 'my',
  '/today': 'today',
  '/overdue': 'overdue',
  '/review': 'review',
  '/control': 'control',
};
const FILTERS = new Set<ListFilter>(['my', 'today', 'overdue', 'review', 'control']);
const VERBS = new Set<ActionVerb>([
  'ack',
  'sub',
  'done',
  'ok',
  'ret',
  'cmt',
  'dok',
  'dno',
  'due',
  'fil',
  'snd',
]);
type InputAction = 'submit' | 'return' | 'comment' | 'deadline';

/** A file could not be fetched from Telegram (bot only, never an API response). */
class FileDownloadError extends Error {}

/** Russian text for whatever an action failed with. */
function failureText(err: unknown): string {
  if (err instanceof FileDownloadError) return errorText('FILE_DOWNLOAD_FAILED');
  return errorText(err instanceof AppError ? err.code : undefined);
}

interface BotUser {
  id: string;
  display_name: string;
}

/** The active account linked to this Telegram user, or null. */
async function botUser(prisma: PrismaClient, telegramId: number): Promise<BotUser | null> {
  const identity = await prisma.authIdentity.findFirst({
    where: { provider: 'telegram', provider_user_id: String(telegramId) },
    select: { user: { select: { id: true, display_name: true, is_active: true } } },
  });
  if (!identity || !identity.user.is_active) return null;
  return { id: identity.user.id, display_name: identity.user.display_name };
}

function html(buttons?: InlineButton[][]) {
  return {
    parse_mode: 'HTML' as const,
    ...(buttons && { reply_markup: { inline_keyboard: buttons } }),
  };
}

// ─── Lists ────────────────────────────────────────────────────────────────────

async function listPage(prisma: PrismaClient, userId: string, filter: ListFilter, page: number) {
  // Workspaces where an admin turned the user's access off are skipped (12.B7).
  const memberships = await prisma.workspaceMember.findMany({
    where: { user_id: userId, deactivated_at: null },
    select: { user_id: true, role: true, workspace: { select: { id: true, timezone: true } } },
  });
  const now = new Date();
  const scopes = memberships.map((m) => {
    const tz = m.workspace.timezone;
    const today = localDate(now, tz);
    const startToday = startOfLocalDay(today, tz);
    const startTomorrow = startOfLocalDay(addDays(today, 1), tz);
    const visible = visibleIssuesWhere(m.workspace.id, m);
    const open = { ...visible, state: { group: { in: OPEN_GROUPS } } };
    const mine = { assignees: { some: { user_id: userId } } };
    const decidedByMe = [{ controller_id: userId }, { controller_id: null, created_by_id: userId }];
    switch (filter) {
      case 'my':
        return { ...open, ...mine };
      case 'today':
        return { ...open, ...mine, due_date: { gte: startToday, lt: startTomorrow } };
      case 'overdue':
        return { ...open, ...mine, due_date: { lt: startToday } };
      case 'review':
        return { ...visible, state: { group: 'review' as const }, OR: decidedByMe };
      case 'control':
        return { ...open, kind: 'assignment' as const, OR: decidedByMe };
    }
  });
  if (scopes.length === 0) return { rows: [], total: 0, page: 0 };

  const where = { OR: scopes };
  const total = await prisma.issue.count({ where });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(Math.max(page, 0), pages - 1);
  const issues = await prisma.issue.findMany({
    where,
    orderBy: [{ due_date: { sort: 'asc', nulls: 'last' } }, { created_at: 'desc' }],
    skip: current * PAGE_SIZE,
    take: PAGE_SIZE,
    select: {
      id: true,
      title: true,
      sequence_id: true,
      due_date: true,
      project: { select: { identifier: true } },
      workspace: { select: { timezone: true } },
      state: { select: { name: true, group: true } },
    },
  });
  const rows = issues.map((i) => ({
    id: i.id,
    key: `${i.project.identifier}-${i.sequence_id}`,
    title: i.title,
    due_date: i.due_date,
    state: i.state,
    timezone: i.workspace.timezone,
  }));
  return { rows, total, page: current };
}

async function sendList(prisma: PrismaClient, chatId: number, user: BotUser, filter: ListFilter) {
  const { rows, total, page } = await listPage(prisma, user.id, filter, 0);
  const view = listMessage(filter, rows, total, page);
  await sendBotMessage(chatId, view.text, html(view.buttons.length ? view.buttons : undefined));
}

// ─── Issue card ───────────────────────────────────────────────────────────────

/** The issue as this user may see it (membership + private projects), or null. */
async function loadCard(prisma: PrismaClient, userId: string, issueId: string) {
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, deleted_at: null, project: { deleted_at: null } },
    include: {
      project: { select: { id: true, name: true, identifier: true, visibility: true } },
      workspace: { select: { id: true, slug: true, timezone: true, settings: true } },
      state: { select: { name: true, group: true } },
      controller: { select: { display_name: true } },
      created_by: { select: { display_name: true } },
      assignees: {
        orderBy: [{ is_primary: 'desc' }, { created_at: 'asc' }],
        select: {
          user_id: true,
          is_primary: true,
          acknowledged_at: true,
          user: { select: { display_name: true } },
        },
      },
      reviews: {
        where: { decision: 'pending' },
        orderBy: { submitted_at: 'desc' },
        take: 1,
        select: {
          submitted_at: true,
          report: true,
          submitted_by: { select: { display_name: true } },
          attachments: { orderBy: { created_at: 'asc' }, select: { file_name: true } },
        },
      },
      deadline_requests: {
        where: { status: 'pending' },
        orderBy: { created_at: 'desc' },
        take: 1,
        select: { id: true, old_due_date: true, new_due_date: true, reason: true },
      },
    },
  });
  if (!issue) return null;
  const member = await prisma.workspaceMember.findUnique({
    where: { workspace_id_user_id: { workspace_id: issue.workspace_id, user_id: userId } },
  });
  // No card for a workspace the user was turned off from (12.B7) — as if not a member.
  if (!member || member.deactivated_at) return null;
  if (issue.project.visibility === 'private' && !seesAllProjects(member)) {
    const inProject = await prisma.projectMember.findUnique({
      where: { project_id_user_id: { project_id: issue.project.id, user_id: userId } },
    });
    if (!inProject) return null;
  }
  return { issue, member };
}

type Loaded = NonNullable<Awaited<ReturnType<typeof loadCard>>>;

function rightsOf({ issue, member }: Loaded, userId: string): CardRights {
  // A guest only reads (12.B4): the card shows no action buttons.
  if (member.role === 'guest') {
    return {
      acknowledge: false,
      submit: false,
      complete: false,
      decide: false,
      decideDeadline: false,
      requestDeadline: false,
      comment: false,
    };
  }
  const group = issue.state.group;
  const open = (OPEN_GROUPS as string[]).includes(group);
  const mine = issue.assignees.find((a) => a.user_id === userId);
  const reviewed = issue.kind === 'assignment' || issue.requires_review;
  const reviewer = isReviewer(issue, userId, member.role);
  return {
    acknowledge: Boolean(mine && open && issue.kind === 'assignment' && !mine.acknowledged_at),
    submit: Boolean(mine && open && reviewed && group !== 'review'),
    complete: Boolean(mine && open && !reviewed),
    decide: reviewer && issue.reviews.length > 0,
    decideDeadline: reviewer && issue.deadline_requests.length > 0,
    // As on the site: the assignee of an assignment with a deadline, one request at a time.
    requestDeadline: Boolean(
      mine &&
      open &&
      issue.kind === 'assignment' &&
      issue.due_date &&
      issue.deadline_requests.length === 0,
    ),
    comment: true,
  };
}

function renderCard(loaded: Loaded, userId: string, status?: string) {
  const { issue } = loaded;
  const key = `${issue.project.identifier}-${issue.sequence_id}`;
  const primary = issue.assignees.find((a) => a.is_primary) ?? issue.assignees[0];
  const review = issue.reviews[0];
  const deadline = issue.deadline_requests[0];
  return cardMessage(
    {
      id: issue.id,
      key,
      title: issue.title,
      description: issue.description,
      kind: issue.kind,
      due_date: issue.due_date,
      state: issue.state,
      project: issue.project,
      timezone: issue.workspace.timezone,
      url: issueUrl(issue.workspace.slug, key),
      primary: primary
        ? { display_name: primary.user.display_name, acknowledged_at: primary.acknowledged_at }
        : null,
      others: issue.assignees.filter((a) => a !== primary).map((a) => a.user),
      controller: issue.controller ?? (issue.kind === 'assignment' ? issue.created_by : null),
      pendingReview: review
        ? {
            submitted_at: review.submitted_at,
            report: review.report,
            by: review.submitted_by,
            files: review.attachments.map((a) => a.file_name),
          }
        : null,
      pendingDeadline: deadline
        ? {
            old_due: deadline.old_due_date,
            new_due: deadline.new_due_date,
            reason: deadline.reason,
          }
        : null,
    },
    rightsOf(loaded, userId),
    status,
  );
}

async function showCard(
  prisma: PrismaClient,
  chatId: number,
  user: BotUser,
  issueId: string,
  opts: { editMessageId?: number; status?: string } = {},
): Promise<boolean> {
  const loaded = await loadCard(prisma, user.id, issueId);
  if (!loaded) return false;
  const view = renderCard(loaded, user.id, opts.status);
  if (opts.editMessageId) {
    await editBotMessage(chatId, opts.editMessageId, view.text, html(view.buttons)).catch(() =>
      // The original may be too old to edit — answer with a fresh card instead.
      sendBotMessage(chatId, view.text, html(view.buttons)),
    );
  } else {
    await sendBotMessage(chatId, view.text, html(view.buttons));
  }
  return true;
}

// ─── Actions ──────────────────────────────────────────────────────────────────

function ctxOf({ issue }: Loaded, userId: string) {
  return {
    workspaceId: issue.workspace_id,
    projectId: issue.project_id,
    issueId: issue.id,
    actorId: userId,
  };
}

/** Run an action; the text tells what happened («✅ Вы приняли работу · 14:05»). */
async function perform(
  prisma: PrismaClient,
  loaded: Loaded,
  userId: string,
  verb: ActionVerb | Exclude<InputAction, 'submit'>,
  text?: string,
): Promise<string> {
  assertCanWrite(loaded.member.role);
  const ctx = ctxOf(loaded, userId);
  const at = formatTime(new Date(), loaded.issue.workspace.timezone);
  switch (verb) {
    case 'ack':
      await controlService.acknowledge(prisma, ctx);
      return `👁 Вы ознакомились · ${at}`;
    case 'ok':
      await controlService.decideReview(prisma, ctx, 'approved', {});
      return `✅ Вы приняли работу · ${at}`;
    case 'return':
      await controlService.decideReview(prisma, ctx, 'returned', { comment: text });
      return `↩️ Вы вернули на доработку · ${at}`;
    case 'done': {
      const done = await firstStateOfGroup(prisma, ctx.projectId, 'completed');
      if (!done) throw AppError.badRequest('The project has no completed state');
      await issueService.updateIssue(prisma, ctx.workspaceId, ctx.projectId, ctx.issueId, userId, {
        state_id: done.id,
      });
      return `✅ Отмечено выполненным · ${at}`;
    }
    case 'comment':
      await commentService.createComment(
        prisma,
        ctx.workspaceId,
        ctx.projectId,
        ctx.issueId,
        userId,
        {
          body: text!,
        },
      );
      return `💬 Комментарий добавлен · ${at}`;
    case 'deadline': {
      const parsed = parseDeadlineInput(text!, loaded.issue.workspace.timezone);
      if ('error' in parsed) throw AppError.badRequest(parsed.error);
      await controlService.requestDeadlineChange(prisma, ctx, parsed);
      return `📅 Запрос на перенос срока до ${formatDate(new Date(parsed.new_due_date), loaded.issue.workspace.timezone)} отправлен контролёру · ${at}`;
    }
    case 'dok':
    case 'dno': {
      const request = loaded.issue.deadline_requests[0];
      if (!request) throw AppError.conflict('No pending request');
      await controlService.decideDeadlineChange(prisma, ctx, request.id, verb === 'dok', {});
      return verb === 'dok'
        ? `📅 Перенос срока одобрен · ${at}`
        : `✖️ Перенос срока отклонён · ${at}`;
    }
    default:
      throw AppError.badRequest('Unknown action');
  }
}

/** Buttons that need text first: remember what the next message is for and ask. */
const NEEDS_TEXT: Partial<Record<ActionVerb, InputAction>> = {
  sub: 'submit',
  ret: 'return',
  cmt: 'comment',
  due: 'deadline',
};

const keyOf = ({ issue }: Loaded) => `${issue.project.identifier}-${issue.sequence_id}`;
const FORCE_REPLY = { force_reply: true as const, input_field_placeholder: 'Ваш текст…' };

async function rememberQuestion(
  prisma: PrismaClient,
  chatId: number,
  user: BotUser,
  loaded: Loaded,
  action: InputAction,
) {
  const data = {
    user_id: user.id,
    issue_id: loaded.issue.id,
    action,
    expires_at: new Date(Date.now() + INPUT_TTL_MS),
  };
  await prisma.telegramPendingInput.upsert({
    where: { chat_id: String(chatId) },
    create: { chat_id: String(chatId), ...data },
    update: data,
  });
}

async function askForText(
  prisma: PrismaClient,
  chatId: number,
  user: BotUser,
  loaded: Loaded,
  action: InputAction,
) {
  // A new hand-in starts without files left over from an abandoned one.
  if (action === 'submit') await dropFiles(prisma, chatId);
  await rememberQuestion(prisma, chatId, user, loaded, action);
  const key = keyOf(loaded);
  const { issue } = loaded;
  const prompt =
    action === 'deadline'
      ? PROMPTS.deadline(
          key,
          issue.due_date ? formatDate(issue.due_date, issue.workspace.timezone, true) : null,
        )
      : PROMPTS[action](key);
  await sendBotMessage(chatId, prompt, { parse_mode: 'HTML', reply_markup: FORCE_REPLY });
}

// ─── Files for a report ───────────────────────────────────────────────────────

/** Files sent to this chat for a hand-in in the last 15 minutes, oldest first. */
function stagedFiles(prisma: PrismaClient, chatId: number) {
  return prisma.telegramPendingFile.findMany({
    where: { chat_id: String(chatId), created_at: { gt: new Date(Date.now() - INPUT_TTL_MS) } },
    orderBy: { created_at: 'asc' },
  });
}

async function dropFiles(prisma: PrismaClient, chatId: number) {
  await prisma.telegramPendingFile.deleteMany({ where: { chat_id: String(chatId) } });
}

/** The pending question and the files sent for it. */
async function dropPending(prisma: PrismaClient, chatId: number) {
  await prisma.telegramPendingInput.deleteMany({ where: { chat_id: String(chatId) } });
  await dropFiles(prisma, chatId);
}

/** The latest caption among the files — the report written under a file. */
function captionOf(files: TelegramPendingFile[]): string | null {
  return [...files].reverse().find((f) => f.caption)?.caption ?? null;
}

/** Photos have no name: «Фото 18.10.2026 14-05.jpg», «… (2).jpg» for the same minute. */
function fileNames(files: TelegramPendingFile[], timeZone: string): string[] {
  const seen = new Map<string, number>();
  return files.map((f) => {
    if (f.file_name) return f.file_name;
    const stamp = f.created_at
      .toLocaleString('ru-RU', {
        timeZone,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
      .replace(',', '')
      .replace(':', '-');
    const n = (seen.get(stamp) ?? 0) + 1;
    seen.set(stamp, n);
    return `Фото ${stamp}${n > 1 ? ` (${n})` : ''}.jpg`;
  });
}

/** What can be handed in: the document, or the largest size of a photo. */
function incomingFile(message: TelegramMessage) {
  if (message.document) {
    const d = message.document;
    return {
      file_id: d.file_id,
      file_name: d.file_name?.trim() || 'Файл',
      mime_type: d.mime_type || 'application/octet-stream',
      file_size: d.file_size ?? null,
    };
  }
  const photo = message.photo?.at(-1);
  if (!photo) return null;
  return {
    file_id: photo.file_id,
    file_name: null,
    mime_type: 'image/jpeg',
    file_size: photo.file_size ?? null,
  };
}

/** My open work that waits to be handed in for review, across my workspaces. */
async function submittable(prisma: PrismaClient, userId: string) {
  const memberships = await prisma.workspaceMember.findMany({
    where: { user_id: userId, deactivated_at: null },
    orderBy: { created_at: 'asc' },
    select: { user_id: true, role: true, workspace: { select: { id: true, timezone: true } } },
  });
  const timezone = memberships[0]?.workspace.timezone ?? 'UTC';
  if (memberships.length === 0) return { rows: [], timezone };
  const issues = await prisma.issue.findMany({
    where: {
      OR: memberships.map((m) => visibleIssuesWhere(m.workspace.id, m)),
      assignees: { some: { user_id: userId } },
      state: { group: { in: OPEN_GROUPS.filter((g) => g !== 'review') } },
      AND: [{ OR: [{ kind: 'assignment' }, { requires_review: true }] }],
    },
    orderBy: [{ due_date: { sort: 'asc', nulls: 'last' } }, { created_at: 'desc' }],
    take: PAGE_SIZE,
    select: { id: true, title: true, sequence_id: true, project: { select: { identifier: true } } },
  });
  const rows = issues.map((i) => ({
    id: i.id,
    key: `${i.project.identifier}-${i.sequence_id}`,
    title: i.title,
  }));
  return { rows, timezone };
}

/** The card's «Сдать на проверку» rule; checked before any file is fetched. */
function assertCanHandIn(loaded: Loaded, userId: string) {
  if (rightsOf(loaded, userId).submit) return;
  if (loaded.issue.state.group === 'review') {
    throw new AppError(409, 'REVIEW_PENDING', 'The work is already waiting for review');
  }
  throw AppError.forbidden('This issue cannot be handed in by this user');
}

/**
 * Hand the work in with the files sent to this chat: every file is fetched from
 * Telegram first, then stored as an attachment of the issue, then the review is
 * submitted with them — the same hand-in as on the site. If the hand-in fails, the
 * new attachments are removed again.
 */
async function handIn(
  prisma: PrismaClient,
  storage: StorageDriver,
  chatId: number,
  loaded: Loaded,
  userId: string,
  report: string | null,
): Promise<string> {
  const { issue } = loaded;
  const ctx = ctxOf(loaded, userId);
  assertCanHandIn(loaded, userId);
  if (!report && controlSettings(issue.workspace.settings).require_report) {
    throw new AppError(400, 'REPORT_REQUIRED', 'A written report is required to hand the work in');
  }

  const files = await stagedFiles(prisma, chatId);
  const names = fileNames(files, issue.workspace.timezone);
  let blobs: Buffer[];
  try {
    blobs = await Promise.all(files.map((f) => downloadBotFile(f.file_id)));
  } catch {
    await dropFiles(prisma, chatId);
    throw new FileDownloadError();
  }

  const ids: string[] = [];
  try {
    for (const [i, f] of files.entries()) {
      const attachment = await attachmentService.storeAttachment(prisma, storage, {
        workspaceId: ctx.workspaceId,
        issueId: ctx.issueId,
        uploaderId: userId,
        fileName: names[i]!,
        mimeType: f.mime_type,
        data: blobs[i]!,
      });
      ids.push(attachment.id);
    }
    await controlService.submitReview(prisma, ctx, { report, attachment_ids: ids });
  } catch (err) {
    for (const id of ids) {
      await attachmentService
        .deleteAttachment(
          prisma,
          storage,
          ctx.workspaceId,
          ctx.projectId,
          id,
          userId,
          loaded.member.role,
        )
        .catch(() => undefined);
    }
    await dropFiles(prisma, chatId);
    throw err;
  }
  await prisma.telegramPendingFile.deleteMany({ where: { id: { in: files.map((f) => f.id) } } });
  const at = formatTime(new Date(), issue.workspace.timezone);
  return `📝 Сдано на проверку${files.length ? ` · 📎 ${pluralize(files.length, FILES)}` : ''} · ${at}`;
}

/** A document or photo: keep it for the hand-in being written, or ask which task it is for. */
async function receiveFile(
  prisma: PrismaClient,
  chatId: number,
  user: BotUser,
  message: TelegramMessage,
): Promise<void> {
  const file = incomingFile(message);
  // Files wait per chat: take them only in a private chat with the bot.
  if (!file || message.chat.id !== message.from?.id) return;
  const limit = Math.min(BOT_DOWNLOAD_LIMIT, config.ATTACHMENT_MAX_BYTES);
  if (file.file_size && file.file_size > limit) {
    await sendBotMessage(
      chatId,
      `Файл больше ${Math.floor(limit / 1024 / 1024)} МБ — через Telegram его не передать. Приложите его к отчёту на сайте.`,
    );
    return;
  }
  // Programs and scripts are refused by name right away; the content is checked
  // when the hand-in stores the file (12.B6).
  if (file.file_name && BLOCKED_EXTENSIONS.has(extensionOf(file.file_name))) {
    await sendBotMessage(chatId, `«${file.file_name}»: ${errorText('FILE_TYPE_NOT_ALLOWED')}`);
    return;
  }

  const pending = await prisma.telegramPendingInput.findUnique({
    where: { chat_id: String(chatId) },
  });
  const live =
    pending && pending.user_id === user.id && pending.expires_at > new Date() ? pending : null;
  if (live && live.action !== 'submit') {
    const waiting =
      live.action === 'return'
        ? 'замечание'
        : live.action === 'deadline'
          ? 'новый срок'
          : 'комментарий';
    await sendBotMessage(
      chatId,
      `Сейчас я жду текст — ${waiting}. Файлы принимаю к отчёту, когда вы сдаёте работу на проверку.\n\n/cancel — отменить`,
    );
    return;
  }

  await prisma.telegramPendingFile.deleteMany({
    where: { chat_id: String(chatId), created_at: { lte: new Date(Date.now() - INPUT_TTL_MS) } },
  });
  const before = await stagedFiles(prisma, chatId);
  if (before.length >= MAX_FILES) {
    await sendBotMessage(
      chatId,
      `К одному отчёту — не больше ${MAX_FILES} файлов. Остальные приложите на сайте.`,
    );
    return;
  }
  // An album arrives as one update per file: answer only the first of them.
  const albumGoesOn = Boolean(
    message.media_group_id && before.some((f) => f.media_group_id === message.media_group_id),
  );
  const created = await prisma.telegramPendingFile.create({
    data: {
      chat_id: String(chatId),
      ...file,
      caption: message.caption?.trim() || null,
      media_group_id: message.media_group_id ?? null,
    },
  });
  const files = [...before, created];

  if (live) {
    // The question stays open while the files arrive.
    await prisma.telegramPendingInput.update({
      where: { chat_id: String(chatId) },
      data: { expires_at: new Date(Date.now() + INPUT_TTL_MS) },
    });
    if (albumGoesOn) return;
    const loaded = await loadCard(prisma, user.id, live.issue_id);
    if (!loaded) {
      await dropPending(prisma, chatId);
      await sendBotMessage(chatId, 'Задача не найдена или недоступна.');
      return;
    }
    const view = stagedFilesMessage(
      loaded.issue.id,
      keyOf(loaded),
      fileNames(files, loaded.issue.workspace.timezone),
      captionOf(files),
    );
    await sendBotMessage(chatId, view.text, html(view.buttons));
    return;
  }

  if (albumGoesOn) return;
  const { rows, timezone } = await submittable(prisma, user.id);
  if (rows.length === 0) await dropFiles(prisma, chatId);
  const view = pickIssueMessage(fileNames(files, timezone), rows);
  await sendBotMessage(chatId, view.text, html(view.buttons.length ? view.buttons : undefined));
}

// ─── Entry points ─────────────────────────────────────────────────────────────

/** A button tap that is not sign-in or an invite. Always answers the tap. */
export async function handleBotCallback(
  prisma: PrismaClient,
  storage: StorageDriver,
  cq: TelegramCallbackQuery,
): Promise<void> {
  const data = cq.data ?? '';
  if (data === CB.noop) {
    await answerCallbackQuery(cq.id, '');
    return;
  }
  const user = await botUser(prisma, cq.from.id);
  if (!user) {
    await answerCallbackQuery(cq.id, 'Telegram не привязан к аккаунту — войдите на сайте.', true);
    return;
  }
  const chatId = cq.message?.chat.id ?? cq.from.id;
  const messageId = cq.message?.message_id;

  if (data === CB.cancel) {
    await dropPending(prisma, chatId);
    await answerCallbackQuery(cq.id, 'Отменено');
    if (messageId) await editBotMessage(chatId, messageId, '✖️ Отменено.').catch(() => {});
    return;
  }

  if (data.startsWith(CB.list)) {
    const [filter, pageText] = data.slice(CB.list.length).split(':');
    if (!FILTERS.has(filter as ListFilter)) {
      await answerCallbackQuery(cq.id, 'Неизвестный список.');
      return;
    }
    const { rows, total, page } = await listPage(
      prisma,
      user.id,
      filter as ListFilter,
      Number(pageText) || 0,
    );
    const view = listMessage(filter as ListFilter, rows, total, page);
    await answerCallbackQuery(cq.id, '');
    if (messageId)
      await editBotMessage(chatId, messageId, view.text, html(view.buttons)).catch(() => {});
    return;
  }

  if (data.startsWith(CB.card)) {
    const shown = await showCard(prisma, chatId, user, data.slice(CB.card.length), {
      editMessageId: messageId,
    });
    await answerCallbackQuery(cq.id, shown ? '' : 'Задача не найдена или недоступна.', !shown);
    return;
  }

  if (data.startsWith(CB.act)) {
    const [verb, issueId] = data.slice(CB.act.length).split(':') as [ActionVerb, string];
    const loaded = VERBS.has(verb) && issueId ? await loadCard(prisma, user.id, issueId) : null;
    if (!loaded) {
      await answerCallbackQuery(cq.id, 'Задача не найдена или недоступна.', true);
      return;
    }
    if (loaded.member.role === 'guest') {
      await answerCallbackQuery(cq.id, errorText('GUEST_READ_ONLY'), true);
      return;
    }
    if (verb === 'due' && !rightsOf(loaded, user.id).requestDeadline) {
      const why = loaded.issue.deadline_requests.length
        ? errorText('DEADLINE_REQUEST_PENDING')
        : 'Перенос срока запрашивает исполнитель открытого поручения со сроком.';
      await answerCallbackQuery(cq.id, why, true);
      return;
    }
    const input = NEEDS_TEXT[verb];
    if (input) {
      await answerCallbackQuery(cq.id, '');
      await askForText(prisma, chatId, user, loaded, input);
      return;
    }
    if (verb === 'fil' || verb === 'snd') {
      await handInFromButton(prisma, storage, cq, user, loaded, verb);
      return;
    }
    try {
      const status = await perform(prisma, loaded, user.id, verb);
      await answerCallbackQuery(cq.id, status.replace(/ · .*$/, ''));
      await showCard(prisma, chatId, user, issueId, { editMessageId: messageId, status });
    } catch (err) {
      await answerCallbackQuery(cq.id, failureText(err), true);
    }
    return;
  }

  await answerCallbackQuery(cq.id, 'Неизвестное действие.');
}

/**
 * «Сдать на проверку» under the files (`snd`), or a task picked for files sent
 * without a question (`fil`). The caption under a file is the report. A picked
 * task without a caption gets the same «Сдать» / «Отмена» message as a hand-in
 * started from the card; «Сдать» without a report asks for one if the workspace
 * requires it.
 */
async function handInFromButton(
  prisma: PrismaClient,
  storage: StorageDriver,
  cq: TelegramCallbackQuery,
  user: BotUser,
  loaded: Loaded,
  verb: 'fil' | 'snd',
): Promise<void> {
  const chatId = cq.message?.chat.id ?? cq.from.id;
  const messageId = cq.message?.message_id;
  const files = await stagedFiles(prisma, chatId);
  if (files.length === 0) {
    await answerCallbackQuery(cq.id, 'Файлы не найдены — пришлите их ещё раз.', true);
    return;
  }
  const report = captionOf(files);

  if (verb === 'fil') {
    try {
      assertCanHandIn(loaded, user.id);
    } catch (err) {
      await answerCallbackQuery(cq.id, failureText(err), true);
      return;
    }
    await rememberQuestion(prisma, chatId, user, loaded, 'submit');
    if (!report) {
      const view = stagedFilesMessage(
        loaded.issue.id,
        keyOf(loaded),
        fileNames(files, loaded.issue.workspace.timezone),
        null,
      );
      await answerCallbackQuery(cq.id, '');
      if (messageId) {
        await editBotMessage(chatId, messageId, view.text, html(view.buttons)).catch(() =>
          sendBotMessage(chatId, view.text, html(view.buttons)),
        );
      } else {
        await sendBotMessage(chatId, view.text, html(view.buttons));
      }
      return;
    }
  } else {
    const pending = await prisma.telegramPendingInput.findUnique({
      where: { chat_id: String(chatId) },
    });
    const current =
      pending?.action === 'submit' &&
      pending.issue_id === loaded.issue.id &&
      pending.user_id === user.id &&
      pending.expires_at > new Date();
    if (!current) {
      await answerCallbackQuery(
        cq.id,
        'Сдача устарела — откройте карточку и начните заново.',
        true,
      );
      return;
    }
    if (!report && controlSettings(loaded.issue.workspace.settings).require_report) {
      await answerCallbackQuery(cq.id, 'Нужен текстовый отчёт');
      await sendBotMessage(chatId, PROMPTS.report(keyOf(loaded), files.length), {
        parse_mode: 'HTML',
        reply_markup: FORCE_REPLY,
      });
      return;
    }
  }

  // Claim the hand-in, so a double tap does not hand in twice.
  const claimed = await prisma.telegramPendingInput.deleteMany({
    where: { chat_id: String(chatId) },
  });
  if (claimed.count === 0) {
    await answerCallbackQuery(cq.id, '');
    return;
  }
  try {
    const status = await handIn(prisma, storage, chatId, loaded, user.id, report);
    await answerCallbackQuery(cq.id, status.replace(/ · .*$/, ''));
    await showCard(prisma, chatId, user, loaded.issue.id, { editMessageId: messageId, status });
  } catch (err) {
    await answerCallbackQuery(cq.id, failureText(err), true);
  }
}

/** A message that is not `/start <login-token>`. */
export async function handleBotMessage(
  prisma: PrismaClient,
  storage: StorageDriver,
  message: TelegramMessage,
): Promise<void> {
  const chatId = message.chat.id;
  const text = (message.text ?? '').trim();
  const user = message.from ? await botUser(prisma, message.from.id) : null;
  if (!user) {
    await sendBotMessage(chatId, NOT_LINKED);
    return;
  }
  if (message.document || message.photo) {
    await receiveFile(prisma, chatId, user, message);
    return;
  }

  const command = text.split(/[\s@]/)[0]!.toLowerCase();
  const menuFilter = MENU_BUTTONS[text] ?? COMMANDS[command];
  if (menuFilter || command.startsWith('/')) {
    // Any command or menu button cancels a pending question and its files.
    await dropPending(prisma, chatId);
  }
  if (menuFilter) {
    await sendList(prisma, chatId, user, menuFilter);
    return;
  }
  if (command === '/cancel') {
    await sendBotMessage(chatId, 'Отменено.', { reply_markup: MENU_KEYBOARD });
    return;
  }
  if (command === '/start' || command === '/menu' || command === '/help') {
    await sendBotMessage(chatId, WELCOME, { parse_mode: 'HTML', reply_markup: MENU_KEYBOARD });
    return;
  }

  const pending = await prisma.telegramPendingInput.findUnique({
    where: { chat_id: String(chatId) },
  });
  if (!pending || pending.expires_at < new Date() || pending.user_id !== user.id || !text) {
    await sendBotMessage(
      chatId,
      'Выберите раздел в меню внизу или нажмите кнопку под сообщением.',
      {
        reply_markup: MENU_KEYBOARD,
      },
    );
    return;
  }
  const loaded = await loadCard(prisma, user.id, pending.issue_id);
  if (!loaded) {
    await dropPending(prisma, chatId);
    await sendBotMessage(chatId, 'Задача не найдена или недоступна.');
    return;
  }
  const action = pending.action as InputAction;
  if (action === 'deadline') {
    // A date that does not parse keeps the question open: fix it and send again.
    const parsed = parseDeadlineInput(text, loaded.issue.workspace.timezone);
    if ('error' in parsed) {
      await sendBotMessage(chatId, `${parsed.error}\n\n/cancel — отменить`, {
        parse_mode: 'HTML',
        reply_markup: FORCE_REPLY,
      });
      return;
    }
  }
  // Claim the question, so a repeated update is not handled twice.
  const claimed = await prisma.telegramPendingInput.deleteMany({
    where: { chat_id: String(chatId) },
  });
  if (claimed.count === 0) return;
  try {
    const status =
      action === 'submit'
        ? await handIn(prisma, storage, chatId, loaded, user.id, text)
        : await perform(prisma, loaded, user.id, action, text);
    await showCard(prisma, chatId, user, pending.issue_id, { status });
  } catch (err) {
    await sendBotMessage(chatId, failureText(err));
  }
}
