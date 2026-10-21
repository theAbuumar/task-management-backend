// Making and sending a planned report (Ф10 10.B5, ADR-032): the scheduler pass
// (runReportSchedules) and «Отправить сейчас» both come here.
//
//   1. the author's membership decides whether the report may still go out;
//   2. the document is built from the author's analytics data (10.B3) for the
//      period before the day of sending — the same PDF/XLSX as «Аналитика»;
//   3. the file is stored with the sending (ReportRun) — «та самая справка»;
//   4. every active recipient gets the in-app «Отчёт готов» and the file in each
//      chosen channel they have (Telegram document, email attachment).
// A delivery that fails is recorded and not retried; nothing here throws past
// the run, so one broken report never stops the pass.

import { randomUUID } from 'node:crypto';
import type {
  Prisma,
  PrismaClient,
  ReportRun,
  ReportRunStatus,
  ReportSchedule,
  WorkspaceMember,
} from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { sendMail } from '../../lib/mailer.js';
import { notify } from '../../lib/notifications.js';
import type { StorageDriver } from '../../lib/storage.js';
import { addDays, localDate } from '../../lib/tz.js';
import { frontendUrl } from '../../lib/urls.js';
import { escapeHtml, sendBotDocument, telegramConfigured } from '../auth/telegram.service.js';
import { renderEmail } from '../../lib/notify/email-layout.js';
import { canLinkButtons } from '../telegram/views.js';
import { analyticsData, type AnalyticsData } from '../analytics/data.js';
import { assignmentsXlsx, disciplinePdf, projectPdf } from '../analytics/reports.js';
import { summary } from '../analytics/service.js';
import { seesAllProjects } from '../../plugins/workspace-hook.js';
import { isoWeekday, nextRunAfter, type Schedule } from '../recurring/schedule.js';
import { ReportFiltersSchema, type ReportFilters } from './schema.js';

/** Sendings kept per report; the files of older ones are deleted. */
export const KEEP_RUNS = 12;

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface Delivery {
  user_id: string;
  channel: 'telegram' | 'email';
  status: 'sent' | 'failed' | 'skipped';
  error?: string | null;
}

export interface RunSummary {
  created: number;
  completed: number;
  on_time: number;
  late: number;
  overdue: number;
  open: number;
  discipline: number | null;
}

// ─── Periods and schedule ─────────────────────────────────────────────────────

/** The quarter's first day of a local date ("2026-11-17" → "2026-10-01"). */
export function quarterStart(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return `${y}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
}

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Whole days before `today` that the report covers (ADR-032). */
export function reportPeriod(
  period: ReportSchedule['period'],
  today: string,
): { from: string; to: string } {
  switch (period) {
    case 'previous_week': {
      const monday = addDays(today, 1 - isoWeekday(today));
      return { from: addDays(monday, -7), to: addDays(monday, -1) };
    }
    case 'previous_month': {
      const to = addDays(monthStart(today), -1);
      return { from: monthStart(to), to };
    }
    case 'previous_quarter': {
      const to = addDays(quarterStart(today), -1);
      return { from: quarterStart(to), to };
    }
    case 'last_30_days': {
      const to = addDays(today, -1);
      return { from: addDays(to, -29), to };
    }
  }
}

/** The schedule math of recurring issues (ADR-030), with a quarter as the anchor. */
export function scheduleOf(
  s: Pick<ReportSchedule, 'frequency' | 'by_weekday' | 'by_monthday' | 'time' | 'start_date'>,
): Schedule {
  return {
    frequency: s.frequency,
    interval: 1,
    by_weekday: s.by_weekday,
    by_monthday: s.by_monthday,
    by_month: null,
    time: s.time,
    start_date: s.start_date,
    until: null,
  };
}

export function nextRun(
  s: Pick<ReportSchedule, 'frequency' | 'by_weekday' | 'by_monthday' | 'time' | 'start_date'>,
  timeZone: string,
  after: Date,
): Date | null {
  return nextRunAfter(scheduleOf(s), timeZone, after);
}

// ─── Texts ────────────────────────────────────────────────────────────────────

const ru = (date: string) => date.split('-').reverse().join('.');
const pct = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('ru-RU')} %`);

export const REPORT_TITLES: Record<ReportSchedule['report'], string> = {
  discipline: 'Справка об исполнении поручений',
  assignments: 'Реестр поручений',
  project: 'Отчёт по проекту',
};

export function periodText(from: string, to: string): string {
  return from === to ? ru(from) : `${ru(from)}–${ru(to)}`;
}

/** The figure lines of the message: the same numbers as the document's KPI. */
function figureLines(s: RunSummary): string[] {
  const closed = s.on_time + s.late;
  return [
    `Исполнено в срок: ${pct(s.discipline)}${closed > 0 ? ` (${s.on_time} из ${closed})` : ''}`,
    `Исполнено: ${s.completed} · Поступило: ${s.created}`,
    `Просрочено: ${s.overdue} · В работе: ${s.open}`,
  ];
}

function analyticsLink(period: { from: string; to: string }, filters: ReportFilters): string {
  const q = new URLSearchParams({ from: period.from, to: period.to });
  if (filters.department?.length === 1) q.set('department', filters.department[0]!);
  if (filters.project?.length === 1) q.set('project', filters.project[0]!);
  if (filters.kind) q.set('kind', filters.kind);
  return frontendUrl(`/analytics?${q.toString()}`);
}

// ─── The author ───────────────────────────────────────────────────────────────

/** Why the author can no longer send this report, or null (ADR-032). */
export function authorBlock(
  member: (WorkspaceMember & { user: { is_active: boolean } }) | null,
  schedule: Pick<ReportSchedule, 'created_by_id' | 'recipient_ids'>,
): string | null {
  if (!member || !member.user.is_active) return 'AUTHOR_NOT_MEMBER';
  if (member.deactivated_at) return 'MEMBER_DEACTIVATED';
  if (member.role === 'guest') return 'GUEST_READ_ONLY';
  const others = schedule.recipient_ids.some((id) => id !== schedule.created_by_id);
  if (others && !seesAllProjects(member)) return 'AUTHOR_NOT_ADMIN';
  return null;
}

// ─── Building the document ────────────────────────────────────────────────────

export interface BuiltReport {
  data: Buffer;
  fileName: string;
  mimeType: string;
  title: string;
  summary: RunSummary;
}

/** The document of a planned report for a period, with the author's rights (also the demo seed). */
export async function buildReport(
  prisma: PrismaClient,
  workspace: { id: string; name: string; short_name: string | null; timezone: string },
  member: WorkspaceMember,
  schedule: ReportSchedule,
  period: { from: string; to: string },
  now: Date,
): Promise<BuiltReport> {
  const filters = ReportFiltersSchema.parse(schedule.filters ?? {});
  const query = { ...filters, from: period.from, to: period.to, limit: 10 };
  let project: { id: string; name: string; identifier: string } | null = null;
  if (schedule.report === 'project') {
    const id = filters.project?.[0];
    project = id
      ? await prisma.project.findFirst({
          where: { id, workspace_id: workspace.id, deleted_at: null },
          select: { id: true, name: true, identifier: true },
        })
      : null;
    if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', 'The project of the report is gone');
  }
  const data: AnalyticsData = await analyticsData(prisma, workspace, member, query, now);
  const c = summary(data).current;
  const figures: RunSummary = {
    created: c.created,
    completed: c.completed,
    on_time: c.on_time,
    late: c.late,
    overdue: c.overdue,
    open: c.open,
    discipline: c.discipline,
  };
  const range = `${period.from}—${period.to}`;
  if (schedule.report === 'assignments') {
    return {
      data: await assignmentsXlsx(data, query),
      fileName: `Реестр поручений ${range}.xlsx`,
      mimeType: XLSX,
      title: REPORT_TITLES.assignments,
      summary: figures,
    };
  }
  if (schedule.report === 'project') {
    return {
      data: await projectPdf(data, project!),
      fileName: `Отчёт по проекту ${project!.identifier} ${range}.pdf`,
      mimeType: 'application/pdf',
      title: `${REPORT_TITLES.project} «${project!.name}»`,
      summary: figures,
    };
  }
  return {
    data: await disciplinePdf(data, query),
    fileName: `Справка об исполнении поручений ${range}.pdf`,
    mimeType: 'application/pdf',
    title: REPORT_TITLES.discipline,
    summary: figures,
  };
}

/** Where the file of a sending is stored. */
export function reportStorageKey(workspaceId: string, runId: string, mimeType: string): string {
  return `reports/${workspaceId}/${runId}.${mimeType === XLSX ? 'xlsx' : 'pdf'}`;
}

// ─── Delivery ─────────────────────────────────────────────────────────────────

async function deliver(
  prisma: PrismaClient,
  workspace: { id: string; name: string },
  schedule: ReportSchedule,
  built: BuiltReport,
  period: { from: string; to: string },
  recipientIds: string[],
): Promise<Delivery[]> {
  const users = await prisma.user.findMany({
    where: {
      id: { in: recipientIds },
      is_active: true,
      workspace_memberships: { some: { workspace_id: workspace.id, deactivated_at: null } },
    },
    select: {
      id: true,
      email: true,
      identities: telegramConfigured()
        ? {
            where: { provider: 'telegram', provider_user_id: { not: null } },
            select: { provider_user_id: true },
            take: 1,
          }
        : false,
    },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  const filters = ReportFiltersSchema.parse(schedule.filters ?? {});
  const when = periodText(period.from, period.to);
  const link = analyticsLink(period, filters);
  const lines = figureLines(built.summary);
  const caption = [
    `📊 <b>${escapeHtml(built.title)}</b>`,
    `за ${when} · ${escapeHtml(workspace.name)}`,
    '',
    ...lines.map(escapeHtml),
  ].join('\n');
  const reply_markup = canLinkButtons()
    ? { inline_keyboard: [[{ text: '📈 Открыть аналитику', url: link }]] }
    : undefined;
  const subject = `${built.title} за ${when} — ${workspace.name}`;
  // The common letter layout (8.B4): figures as tiles, the file attached.
  const brand = await prisma.workspace.findUnique({
    where: { id: workspace.id },
    select: { name: true, short_name: true, logo_url: true },
  });
  const s = built.summary;
  const letter = renderEmail({
    locale: 'ru',
    workspace: brand ?? { name: workspace.name },
    heading: `${built.title} за ${when}`,
    paragraphs: ['Документ во вложении.'],
    figures: [
      { label: 'Исполнено в срок', value: pct(s.discipline) },
      { label: 'Исполнено', value: String(s.completed) },
      { label: 'Поступило', value: String(s.created) },
      { label: 'Просрочено', value: String(s.overdue) },
    ],
    button: { label: 'Открыть аналитику', url: link },
    footer: [
      `Отчёт отправлен по расписанию${schedule.name ? ` «${schedule.name}»` : ''}. ` +
        `Изменить или отключить: ${frontendUrl('/settings/reports')}`,
    ],
  });

  const deliveries: Delivery[] = [];
  const sends: Promise<void>[] = [];
  const short = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 200);

  for (const userId of recipientIds) {
    const user = byId.get(userId);
    for (const channel of schedule.channels as Delivery['channel'][]) {
      if (!user) {
        deliveries.push({ user_id: userId, channel, status: 'skipped', error: 'NOT_MEMBER' });
        continue;
      }
      const row: Delivery = { user_id: userId, channel, status: 'sent' };
      deliveries.push(row);
      if (channel === 'telegram') {
        const chat = user.identities?.[0]?.provider_user_id;
        if (!chat) {
          Object.assign(row, { status: 'skipped', error: 'NO_TELEGRAM' });
          continue;
        }
        sends.push(
          sendBotDocument(
            Number(chat),
            { name: built.fileName, data: built.data, mimeType: built.mimeType },
            { caption, parse_mode: 'HTML', ...(reply_markup && { reply_markup }) },
          ).catch((err) => void Object.assign(row, { status: 'failed', error: short(err) })),
        );
      } else {
        if (!user.email) {
          Object.assign(row, { status: 'skipped', error: 'NO_EMAIL' });
          continue;
        }
        sends.push(
          sendMail({
            to: user.email,
            subject,
            ...letter,
            attachments: [
              { filename: built.fileName, content: built.data, contentType: built.mimeType },
            ],
          }).catch((err) => void Object.assign(row, { status: 'failed', error: short(err) })),
        );
      }
    }
  }
  await Promise.all(sends);
  return deliveries;
}

// ─── One run ──────────────────────────────────────────────────────────────────

type ScheduleWithWorkspace = ReportSchedule & {
  workspace: { id: string; name: string; short_name: string | null; timezone: string };
};

export interface RunOutcome {
  run: ReportRun | null;
  /** Set when the author can no longer send the report: the schedule is paused. */
  blocked: string | null;
}

/**
 * Make the document and send it. `triggeredBy` — who pressed «Отправить сейчас»
 * (null for the schedule). A blocked author pauses a scheduled report; a manual
 * run is refused instead (the caller decides).
 */
export async function runSchedule(
  prisma: PrismaClient,
  storage: StorageDriver,
  schedule: ScheduleWithWorkspace,
  options: { now?: Date; triggeredBy?: string | null } = {},
): Promise<RunOutcome> {
  const now = options.now ?? new Date();
  const ws = schedule.workspace;
  const member = await prisma.workspaceMember.findUnique({
    where: { workspace_id_user_id: { workspace_id: ws.id, user_id: schedule.created_by_id } },
    include: { user: { select: { is_active: true } } },
  });
  const blocked = authorBlock(member, schedule);
  if (blocked) {
    if (!options.triggeredBy) {
      await prisma.reportSchedule.update({
        where: { id: schedule.id },
        data: { is_active: false, last_error: blocked },
      });
    }
    return { run: null, blocked };
  }

  const period = reportPeriod(schedule.period, localDate(now, ws.timezone));
  const runId = randomUUID();
  let built: BuiltReport | null = null;
  let error: string | null = null;
  try {
    built = await buildReport(prisma, ws, member!, schedule, period, now);
  } catch (err) {
    error = err instanceof AppError ? err.code : 'INTERNAL_ERROR';
  }

  let storageKey: string | null = null;
  let deliveries: Delivery[] = [];
  let status: ReportRunStatus = 'failed';
  if (built) {
    storageKey = reportStorageKey(ws.id, runId, built.mimeType);
    try {
      await storage.put(storageKey, built.data, built.mimeType);
    } catch {
      storageKey = null;
    }
  }
  const run = await prisma.reportRun.create({
    data: {
      id: runId,
      workspace_id: ws.id,
      schedule_id: schedule.id,
      triggered_by_id: options.triggeredBy ?? null,
      period_from: period.from,
      period_to: period.to,
      status,
      error,
      file_name: built?.fileName ?? null,
      mime_type: built?.mimeType ?? null,
      file_size: built?.data.length ?? null,
      storage_key: storageKey,
      summary: (built?.summary ?? {}) as unknown as Prisma.InputJsonValue,
      recipient_ids: schedule.recipient_ids,
      created_at: now,
    },
  });

  if (built) {
    // In the app for everyone who still works here; the bell rings at once.
    const active = await prisma.workspaceMember.findMany({
      where: {
        workspace_id: ws.id,
        user_id: { in: schedule.recipient_ids },
        deactivated_at: null,
        user: { is_active: true },
      },
      select: { user_id: true },
    });
    await notify(prisma, {
      workspace_id: ws.id,
      actor_id: schedule.created_by_id,
      type: 'report_ready',
      recipient_ids: active.map((m) => m.user_id),
      entity_id: run.id,
      include_actor: true,
    });
    deliveries = await deliver(prisma, ws, schedule, built, period, schedule.recipient_ids);
    status = deliveries.some((d) => d.status === 'failed') ? 'partial' : 'sent';
  }

  const saved = await prisma.reportRun.update({
    where: { id: run.id },
    data: { status, deliveries: deliveries as unknown as Prisma.InputJsonValue },
  });
  await prisma.reportSchedule.update({
    where: { id: schedule.id },
    data: { last_run_at: now, last_error: error },
  });
  await writeAudit(prisma, {
    workspace_id: ws.id,
    actor_id: options.triggeredBy ?? null,
    action: 'report.sent',
    target_type: 'report',
    target_id: schedule.id,
    meta: {
      report: schedule.report,
      name: schedule.name,
      from: period.from,
      to: period.to,
      recipients: schedule.recipient_ids.length,
      status,
      ...(error && { error }),
      manual: Boolean(options.triggeredBy),
    },
  });
  await prune(prisma, storage, schedule.id);
  return { run: saved, blocked: null };
}

/** Keep the latest KEEP_RUNS sendings; delete the files of the older ones. */
async function prune(prisma: PrismaClient, storage: StorageDriver, scheduleId: string) {
  const old = await prisma.reportRun.findMany({
    where: { schedule_id: scheduleId },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    skip: KEEP_RUNS,
    select: { id: true, storage_key: true },
  });
  if (old.length === 0) return;
  for (const r of old) if (r.storage_key) await storage.delete(r.storage_key).catch(() => {});
  await prisma.reportRun.deleteMany({ where: { id: { in: old.map((r) => r.id) } } });
}

// ─── The scheduler pass ───────────────────────────────────────────────────────

export interface ReportPassResult {
  sent: number;
  failed: number;
  paused: number;
}

/**
 * Every active report whose time has come is sent once. It is claimed first —
 * moved to its next run with a conditional update — so two passes never send the
 * same run, and a report that missed runs while the server was off goes out once.
 */
export async function runReportSchedules(
  prisma: PrismaClient,
  storage: StorageDriver,
  options: { now?: Date; workspaceId?: string } = {},
): Promise<ReportPassResult> {
  const now = options.now ?? new Date();
  const result: ReportPassResult = { sent: 0, failed: 0, paused: 0 };
  const due = await prisma.reportSchedule.findMany({
    where: {
      is_active: true,
      next_run_at: { lte: now },
      ...(options.workspaceId && { workspace_id: options.workspaceId }),
    },
    include: { workspace: { select: { id: true, name: true, short_name: true, timezone: true } } },
    orderBy: { next_run_at: 'asc' },
    take: 200,
  });
  for (const schedule of due) {
    const claimed = await prisma.reportSchedule.updateMany({
      where: { id: schedule.id, is_active: true, next_run_at: schedule.next_run_at },
      data: { next_run_at: nextRun(schedule, schedule.workspace.timezone, now) },
    });
    if (claimed.count === 0) continue;
    try {
      const outcome = await runSchedule(prisma, storage, schedule, { now });
      if (outcome.blocked) result.paused += 1;
      else if (outcome.run?.status === 'failed') result.failed += 1;
      else result.sent += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
