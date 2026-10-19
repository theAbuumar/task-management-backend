// «🤖 Новое поручение» in the Telegram bot (Ф11 11.T1, ADR-028; the bot lives in
// the backend until the contest, ADR-011).
//
// 1. The menu button or /new asks for the assignment in plain words (and for the
//    workspace first, when the user works in several).
// 2. The text goes to the AI drafts (modules/ai/drafts.ts) — same org matching,
//    limit and usage log as the site. The draft comes back as a card with
//    «Создать», «Изменить» and «Отмена». Nothing exists yet.
// 3. «Изменить» takes a correction in plain words («срок — 25 октября») and
//    redraws the card. «Создать» asks for the project when there are several and
//    creates the assignment (or a distribution) with the regular services, in
//    the user's rights, marked `ai_assisted`.
// The pending step is one TelegramAiDraft row per chat, 30 minutes long.

import pino from 'pino';
import { Prisma, type PrismaClient, type WorkspaceMember } from '@prisma/client';
import { config } from '../../config/index.js';
import { AppError } from '../../lib/errors.js';
import { issueUrl } from '../../lib/urls.js';
import { assertCanWrite, seesAllProjects } from '../../plugins/workspace-hook.js';
import { draftOne, type Draft } from '../ai/drafts.js';
import type { AiContext } from '../ai/service.js';
import * as issueService from '../issues/service.js';
import { distributeIssue } from '../issues/distribution.js';
import {
  answerCallbackQuery,
  editBotMessage,
  escapeHtml,
  sendBotMessage,
  type InlineButton,
  type TelegramCallbackQuery,
} from '../auth/telegram.service.js';
import { CB, canLinkButtons, errorText } from './views.js';

export { AI_MENU_BUTTON } from './views.js';

const DRAFT_TTL_MS = 30 * 60 * 1000;
const MAX_PROJECTS = 8;
const FORCE_REPLY = {
  force_reply: true as const,
  input_field_placeholder: 'Поручение своими словами…',
};
const log = pino({ level: config.LOG_LEVEL ?? 'info' });

export const AI_CB = {
  /** `ai:w:<workspaceId>` — draft in this workspace */
  workspace: 'ai:w:',
  /** `ai:p:<projectId>` — create in this project */
  project: 'ai:p:',
  create: 'ai:ok',
  edit: 'ai:ed',
  cancel: 'ai:x',
} as const;

interface BotUser {
  id: string;
  display_name: string;
}

type Stage = 'text' | 'edit' | 'draft';

const ask = {
  text: [
    '🤖 <b>Новое поручение</b>',
    '',
    'Опишите поручение одним сообщением: что сделать, кому и к какому сроку. Например:',
    '<i>Деканам ФЭУ и ФИТ до 1 ноября представить отчёты о практике студентов, контроль — проректор по учебной работе.</i>',
    '',
    'AI подготовит черновик, вы проверите его перед созданием.',
    '',
    '/cancel — отменить',
  ].join('\n'),
  edit: [
    '✏️ Что поправить? Напишите своими словами, например:',
    '<i>срок — 25 октября</i> · <i>исполнитель — Петров</i> · <i>контроль — проректор по науке</i>',
    '',
    '/cancel — отменить',
  ].join('\n'),
};

function aiErrorText(err: unknown): string {
  const code = err instanceof AppError ? err.code : undefined;
  switch (code) {
    case 'AI_LIMIT_REACHED':
      return 'Дневной лимит запросов к AI исчерпан. Попробуйте завтра или создайте поручение на сайте.';
    case 'AI_TIMEOUT':
      return 'AI не ответил вовремя. Пришлите текст ещё раз, лучше короче.';
    case 'AI_UNAVAILABLE':
      return 'AI сейчас недоступен. Попробуйте позже или создайте поручение на сайте.';
    case 'AI_REFUSED':
      return 'AI отказался обработать этот текст. Переформулируйте поручение.';
    case 'AI_BAD_OUTPUT':
      return 'Не получилось разобрать поручение. Пришлите текст ещё раз.';
    case 'AI_INPUT_TOO_LARGE':
      return 'Слишком длинный текст. Для протокола используйте сайт: «Создать из протокола».';
    case 'AI_DISABLED':
      return 'AI-ассистент на этом сервере выключен.';
    case 'DEPARTMENT_HAS_NO_HEAD':
      return 'У одного из подразделений нет руководителя. Нажмите «Изменить» и уберите его или выберите исполнителя.';
    case 'MEMBER_DEACTIVATED':
      return 'Исполнитель или контролёр отключён от пространства. Нажмите «Изменить» и выберите другого.';
    default:
      return errorText(code);
  }
}

/** Memberships where the user may create assignments: active, not a guest. */
function writableMemberships(prisma: PrismaClient, userId: string) {
  return prisma.workspaceMember.findMany({
    where: { user_id: userId, deactivated_at: null, role: { not: 'guest' } },
    include: { workspace: true },
    orderBy: { created_at: 'asc' },
  });
}

async function memberOf(prisma: PrismaClient, userId: string, workspaceId: string) {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: userId } },
    include: { workspace: true },
  });
  if (!member || member.deactivated_at || member.role === 'guest') return null;
  return member;
}

function contextOf(
  prisma: PrismaClient,
  member: WorkspaceMember & { workspace: AiContext['workspace'] },
): AiContext {
  return { prisma, workspace: member.workspace, member, log };
}

async function save(
  prisma: PrismaClient,
  chatId: number,
  user: BotUser,
  workspaceId: string,
  stage: Stage,
  draft: Draft | null,
) {
  const data = {
    user_id: user.id,
    workspace_id: workspaceId,
    stage,
    draft: draft ? (draft as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    expires_at: new Date(Date.now() + DRAFT_TTL_MS),
  };
  await prisma.telegramAiDraft.upsert({
    where: { chat_id: String(chatId) },
    create: { chat_id: String(chatId), ...data },
    update: data,
  });
}

/** The live draft step of this chat and user, or null. */
async function current(prisma: PrismaClient, chatId: number, user: BotUser) {
  const row = await prisma.telegramAiDraft.findUnique({ where: { chat_id: String(chatId) } });
  if (!row || row.user_id !== user.id || row.expires_at < new Date()) return null;
  return row;
}

export async function dropAiDraft(prisma: PrismaClient, chatId: number): Promise<void> {
  await prisma.telegramAiDraft.deleteMany({ where: { chat_id: String(chatId) } });
}

const ruDate = (iso: string) => iso.split('-').reverse().join('.');

function cardText(d: Draft, workspace: string, many: boolean): string {
  const who =
    d.mode === 'distribution'
      ? `🏢 Рассылка: ${escapeHtml(d.departments.map((x) => x.short_name ?? x.name).join(', '))}`
      : `👤 Исполнитель: ${
          d.assignee
            ? escapeHtml(
                `${d.assignee.full_name}${d.assignee.position ? `, ${d.assignee.position}` : ''}`,
              )
            : '<i>не выбран</i>'
        }`;
  const description =
    d.description.length > 400 ? `${d.description.slice(0, 399)}…` : d.description;
  return [
    '🤖 <b>Черновик поручения</b> · подготовлен AI, проверьте перед созданием',
    many ? `🏛 ${escapeHtml(workspace)}` : null,
    '',
    `<b>${escapeHtml(d.title)}</b>`,
    description ? escapeHtml(description) : null,
    '',
    who,
    `🎯 Контролёр: ${d.controller ? escapeHtml(d.controller.full_name) : 'вы'}`,
    `📅 Срок: ${d.due_date ? ruDate(d.due_date) : 'не указан'}`,
    d.basis ? `📄 Основание: ${escapeHtml(d.basis)}` : null,
    ...(d.warnings.length ? ['', ...d.warnings.map((w) => `⚠️ ${escapeHtml(w)}`)] : []),
  ]
    .filter((line) => line !== null)
    .join('\n');
}

const cardButtons: InlineButton[][] = [
  [{ text: '✅ Создать', callback_data: AI_CB.create }],
  [
    { text: '✏️ Изменить', callback_data: AI_CB.edit },
    { text: '✖️ Отмена', callback_data: AI_CB.cancel },
  ],
];

async function askForText(
  prisma: PrismaClient,
  chatId: number,
  user: BotUser,
  workspaceId: string,
) {
  await save(prisma, chatId, user, workspaceId, 'text', null);
  await sendBotMessage(chatId, ask.text, { parse_mode: 'HTML', reply_markup: FORCE_REPLY });
}

/** The menu button or /new. */
export async function startAiDraft(
  prisma: PrismaClient,
  chatId: number,
  user: BotUser,
): Promise<void> {
  if (!config.AI_ENABLED) {
    await sendBotMessage(chatId, aiErrorText(new AppError(404, 'AI_DISABLED', '')));
    return;
  }
  const memberships = await writableMemberships(prisma, user.id);
  if (memberships.length === 0) {
    await sendBotMessage(chatId, 'Нет пространства, где вы можете создавать поручения.');
    return;
  }
  if (memberships.length === 1) {
    await askForText(prisma, chatId, user, memberships[0]!.workspace_id);
    return;
  }
  await dropAiDraft(prisma, chatId);
  await sendBotMessage(chatId, '🤖 В каком пространстве создать поручение?', {
    reply_markup: {
      inline_keyboard: [
        ...memberships.map((m) => [
          {
            text: m.workspace.short_name ?? m.workspace.name,
            callback_data: `${AI_CB.workspace}${m.workspace_id}`,
          },
        ]),
        [{ text: '✖️ Отмена', callback_data: AI_CB.cancel }],
      ],
    },
  });
}

/** A text message while the bot waits for an assignment or a correction. False — not ours. */
export async function handleAiDraftText(
  prisma: PrismaClient,
  chatId: number,
  user: BotUser,
  text: string,
): Promise<boolean> {
  const row = await current(prisma, chatId, user);
  if (!row || row.stage === 'draft' || !text) return false;
  const member = await memberOf(prisma, user.id, row.workspace_id);
  if (!member) {
    await dropAiDraft(prisma, chatId);
    await sendBotMessage(chatId, 'Нет доступа к пространству.');
    return true;
  }
  const previous = row.stage === 'edit' ? (row.draft as unknown as Draft | null) : null;
  try {
    const draft = await draftOne(contextOf(prisma, member), text, previous);
    const many = (await writableMemberships(prisma, user.id)).length > 1;
    await save(prisma, chatId, user, row.workspace_id, 'draft', draft);
    await sendBotMessage(chatId, cardText(draft, member.workspace.name, many), {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: cardButtons },
    });
  } catch (err) {
    // The question stays open: the user can send the text again.
    await sendBotMessage(chatId, `${aiErrorText(err)}\n\n/cancel — отменить`);
  }
  return true;
}

/** Projects of the workspace where the user may create (visible, not archived). */
function projectsFor(prisma: PrismaClient, member: WorkspaceMember) {
  return prisma.project.findMany({
    where: {
      workspace_id: member.workspace_id,
      deleted_at: null,
      is_archived: false,
      ...(!seesAllProjects(member) && {
        OR: [{ visibility: 'public' }, { members: { some: { user_id: member.user_id } } }],
      }),
    },
    orderBy: { created_at: 'asc' },
    take: MAX_PROJECTS,
    select: { id: true, name: true, identifier: true },
  });
}

/** Create the assignment of the draft in a project, in the user's rights. */
async function create(
  prisma: PrismaClient,
  member: WorkspaceMember & { workspace: { slug: string; timezone: string } },
  projectId: string,
  draft: Draft,
) {
  assertCanWrite(member.role);
  const due = draft.due_date ? `${draft.due_date}T12:00:00.000Z` : null;
  if (draft.mode === 'distribution') {
    return distributeIssue(prisma, member.workspace_id, projectId, member.user_id, {
      title: draft.title,
      description: draft.description || null,
      priority: draft.priority,
      due_date: due,
      controller_id: draft.controller?.id ?? null,
      basis: draft.basis,
      department_ids: draft.departments.map((d) => d.id),
      ai_assisted: true,
    });
  }
  const state =
    (await prisma.state.findFirst({ where: { project_id: projectId, is_default: true } })) ??
    (await prisma.state.findFirst({
      where: { project_id: projectId, group: 'unstarted' },
      orderBy: { order: 'asc' },
    }));
  if (!state) throw AppError.badRequest('The project has no starting state');
  return issueService.createIssue(prisma, member.workspace_id, projectId, member.user_id, {
    title: draft.title,
    description: draft.description || undefined,
    state_id: state.id,
    priority: draft.priority,
    assignee_ids: [draft.assignee!.id],
    primary_assignee_id: draft.assignee!.id,
    due_date: due,
    kind: 'assignment',
    controller_id: draft.controller?.id ?? null,
    basis: draft.basis,
    ai_assisted: true,
  });
}

async function createInProject(
  prisma: PrismaClient,
  cq: TelegramCallbackQuery,
  user: BotUser,
  projectId: string | null,
): Promise<void> {
  const chatId = cq.message?.chat.id ?? cq.from.id;
  const messageId = cq.message?.message_id;
  const row = await current(prisma, chatId, user);
  const draft = row?.stage === 'draft' ? (row.draft as unknown as Draft | null) : null;
  if (!row || !draft) {
    await answerCallbackQuery(
      cq.id,
      'Черновик устарел — начните заново: «🤖 Новое поручение».',
      true,
    );
    return;
  }
  if (draft.mode === 'person' && !draft.assignee) {
    await answerCallbackQuery(
      cq.id,
      'Не выбран исполнитель — нажмите «Изменить» и напишите, кому поручить.',
      true,
    );
    return;
  }
  const member = await memberOf(prisma, user.id, row.workspace_id);
  if (!member) {
    await answerCallbackQuery(cq.id, errorText('FORBIDDEN'), true);
    return;
  }
  const projects = await projectsFor(prisma, member);
  if (projects.length === 0) {
    await answerCallbackQuery(cq.id, 'Нет проекта, в котором вы можете создавать поручения.', true);
    return;
  }
  const project = projectId
    ? projects.find((p) => p.id === projectId)
    : projects.length === 1
      ? projects[0]
      : null;
  if (!project) {
    if (projectId) {
      await answerCallbackQuery(cq.id, 'Проект недоступен.', true);
      return;
    }
    await answerCallbackQuery(cq.id, '');
    const buttons: InlineButton[][] = [
      ...projects.map((p) => [
        { text: `${p.identifier} · ${p.name}`, callback_data: `${AI_CB.project}${p.id}` },
      ]),
      [{ text: '✖️ Отмена', callback_data: AI_CB.cancel }],
    ];
    const text = `${cardText(draft, member.workspace.name, false)}\n\n📁 <b>В каком проекте создать?</b>`;
    if (messageId) {
      await editBotMessage(chatId, messageId, text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons },
      }).catch(() =>
        sendBotMessage(chatId, text, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: buttons },
        }),
      );
    } else
      await sendBotMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons },
      });
    return;
  }

  // Claim the draft, so a double tap does not create twice.
  const claimed = await prisma.telegramAiDraft.deleteMany({
    where: { chat_id: String(chatId), user_id: user.id, stage: 'draft' },
  });
  if (claimed.count === 0) {
    await answerCallbackQuery(cq.id, '');
    return;
  }
  try {
    const issue = await create(prisma, member, project.id, draft);
    const key = `${project.identifier}-${issue.sequence_id}`;
    await answerCallbackQuery(cq.id, `Создано: ${key}`);
    const buttons: InlineButton[][] = [
      [{ text: '📄 Открыть карточку', callback_data: `${CB.card}${issue.id}` }],
    ];
    if (canLinkButtons()) {
      buttons[0]!.push({ text: '🌐 На сайте', url: issueUrl(member.workspace.slug, key) });
    }
    const done = [
      `✅ Создано поручение <b>${escapeHtml(key)}</b>`,
      escapeHtml(issue.title),
      draft.mode === 'distribution'
        ? `🏢 Рассылка: ${escapeHtml(draft.departments.map((d) => d.short_name ?? d.name).join(', '))}`
        : `👤 ${escapeHtml(draft.assignee!.full_name)}`,
      draft.due_date ? `📅 Срок: ${ruDate(draft.due_date)}` : null,
      '🤖 Подготовлено с помощью AI',
    ]
      .filter(Boolean)
      .join('\n');
    if (messageId) {
      await editBotMessage(chatId, messageId, done, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons },
      }).catch(() =>
        sendBotMessage(chatId, done, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: buttons },
        }),
      );
    } else
      await sendBotMessage(chatId, done, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons },
      });
  } catch (err) {
    // Nothing was created: give the draft back for a correction.
    await save(prisma, chatId, user, row.workspace_id, 'draft', draft);
    await answerCallbackQuery(cq.id, aiErrorText(err), true);
  }
}

/** A tap on an `ai:` button. False — not an AI draft button. */
export async function handleAiDraftCallback(
  prisma: PrismaClient,
  cq: TelegramCallbackQuery,
  user: BotUser,
): Promise<boolean> {
  const data = cq.data ?? '';
  if (!data.startsWith('ai:')) return false;
  const chatId = cq.message?.chat.id ?? cq.from.id;
  const messageId = cq.message?.message_id;

  if (data === AI_CB.cancel) {
    await dropAiDraft(prisma, chatId);
    await answerCallbackQuery(cq.id, 'Отменено');
    if (messageId) await editBotMessage(chatId, messageId, '✖️ Черновик удалён.').catch(() => {});
    return true;
  }
  if (!config.AI_ENABLED) {
    await answerCallbackQuery(cq.id, aiErrorText(new AppError(404, 'AI_DISABLED', '')), true);
    return true;
  }
  if (data.startsWith(AI_CB.workspace)) {
    const member = await memberOf(prisma, user.id, data.slice(AI_CB.workspace.length));
    if (!member) {
      await answerCallbackQuery(cq.id, errorText('FORBIDDEN'), true);
      return true;
    }
    await answerCallbackQuery(cq.id, member.workspace.name);
    await askForText(prisma, chatId, user, member.workspace_id);
    return true;
  }
  if (data === AI_CB.edit) {
    const row = await current(prisma, chatId, user);
    if (!row || row.stage !== 'draft') {
      await answerCallbackQuery(cq.id, 'Черновик устарел — начните заново.', true);
      return true;
    }
    await save(prisma, chatId, user, row.workspace_id, 'edit', row.draft as unknown as Draft);
    await answerCallbackQuery(cq.id, '');
    await sendBotMessage(chatId, ask.edit, { parse_mode: 'HTML', reply_markup: FORCE_REPLY });
    return true;
  }
  if (data === AI_CB.create) {
    await createInProject(prisma, cq, user, null);
    return true;
  }
  if (data.startsWith(AI_CB.project)) {
    await createInProject(prisma, cq, user, data.slice(AI_CB.project.length));
    return true;
  }
  await answerCallbackQuery(cq.id, 'Неизвестное действие.');
  return true;
}
