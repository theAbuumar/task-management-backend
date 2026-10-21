// Planned reports (Ф10 10.B5, ADR-032) — the schedule and its history.
//
// Rights, checked here:
//   - any member but a guest creates one (the workspace hook refuses guests);
//   - recipients other than the author only in a report of an admin or the owner;
//   - admins see every report of the workspace, anyone else — their own and the
//     ones they receive; the author or an admin changes, sends and deletes it;
//   - the file of a sending — the author, admins and that sending's recipients.

import type {
  Prisma,
  PrismaClient,
  ReportRun,
  ReportSchedule,
  Workspace,
  WorkspaceMember,
} from '@prisma/client';
import { AppError, type ErrorCode } from '../../lib/errors.js';
import type { StorageDriver } from '../../lib/storage.js';
import { localDate } from '../../lib/tz.js';
import { seesAllProjects } from '../../plugins/workspace-hook.js';
import { analyticsData } from '../analytics/data.js';
import { nextRun, quarterStart, runSchedule, type Delivery } from './run.js';
import {
  ReportFiltersSchema,
  type CreateScheduleBody,
  type ReportFilters,
  type UpdateScheduleBody,
} from './schema.js';

const PERSON = {
  id: true,
  display_name: true,
  last_name: true,
  first_name: true,
  middle_name: true,
  avatar_url: true,
} as const;

const DEFAULT_PERIOD: Record<ReportSchedule['frequency'], ReportSchedule['period']> = {
  daily: 'last_30_days',
  weekly: 'previous_week',
  monthly: 'previous_month',
  quarterly: 'previous_quarter',
  // Not offered (the schema refuses it); the closest whole period.
  yearly: 'previous_quarter',
};

type WorkspaceRef = Pick<Workspace, 'id' | 'name' | 'short_name' | 'timezone'>;
type Row = ReportSchedule & {
  created_by: Prisma.UserGetPayload<{ select: typeof PERSON }>;
  runs: ReportRun[];
};

export const canEdit = (s: Pick<ReportSchedule, 'created_by_id'>, member: WorkspaceMember) =>
  seesAllProjects(member) || s.created_by_id === member.user_id;

const sees = (s: Pick<ReportSchedule, 'created_by_id' | 'recipient_ids'>, m: WorkspaceMember) =>
  canEdit(s, m) || s.recipient_ids.includes(m.user_id);

/** A sending as the caller may see it: a recipient sees only their own deliveries. */
function runView(run: ReportRun, schedule: ReportSchedule, member: WorkspaceMember) {
  const editor = canEdit(schedule, member);
  const deliveries = (run.deliveries as unknown as Delivery[]).filter(
    (d) => editor || d.user_id === member.user_id,
  );
  return {
    id: run.id,
    schedule_id: run.schedule_id,
    triggered_by_id: run.triggered_by_id,
    period_from: run.period_from,
    period_to: run.period_to,
    status: run.status,
    error: run.error,
    file_name: run.file_name,
    file_size: run.file_size,
    summary: run.summary,
    deliveries,
    can_download:
      run.storage_key !== null && (editor || run.recipient_ids.includes(member.user_id)),
    created_at: run.created_at,
  };
}

async function views(prisma: PrismaClient, rows: Row[], member: WorkspaceMember) {
  const ids = [...new Set(rows.flatMap((r) => r.recipient_ids))];
  const [users, members] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: ids } },
      select: {
        ...PERSON,
        email: true,
        is_active: true,
        identities: {
          where: { provider: 'telegram', provider_user_id: { not: null } },
          select: { id: true },
          take: 1,
        },
      },
    }),
    prisma.workspaceMember.findMany({
      where: { workspace_id: member.workspace_id, user_id: { in: ids } },
      select: { user_id: true, deactivated_at: true },
    }),
  ]);
  const byId = new Map(users.map((u) => [u.id, u]));
  const memberOf = new Map(members.map((m) => [m.user_id, m]));
  return rows.map((row) => {
    const editor = canEdit(row, member);
    const { runs, ...schedule } = row;
    const last = runs[0];
    return {
      ...schedule,
      recipients: row.recipient_ids
        .map((id) => byId.get(id))
        .filter((u) => u !== undefined)
        .map(({ email, identities, is_active, ...u }) => {
          const m = memberOf.get(u.id);
          return {
            ...u,
            active: is_active && m !== undefined && m.deactivated_at === null,
            has_telegram: editor ? identities.length > 0 : null,
            has_email: editor ? Boolean(email) : null,
          };
        }),
      can_edit: editor,
      last_run: last && sees(row, member) ? runView(last, row, member) : null,
    };
  });
}

const INCLUDE = {
  created_by: { select: PERSON },
  runs: { orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 1 },
} satisfies Prisma.ReportScheduleInclude;

async function read(prisma: PrismaClient, id: string, member: WorkspaceMember) {
  const row = await prisma.reportSchedule.findUniqueOrThrow({ where: { id }, include: INCLUDE });
  return (await views(prisma, [row], member))[0]!;
}

async function find(
  prisma: PrismaClient,
  workspaceId: string,
  id: string,
  member: WorkspaceMember,
): Promise<ReportSchedule> {
  const schedule = await prisma.reportSchedule.findFirst({
    where: { id, workspace_id: workspaceId },
  });
  // Someone else's report is "not found", not "forbidden".
  if (!schedule || !sees(schedule, member)) throw AppError.notFound('Planned report not found');
  return schedule;
}

async function editable(
  prisma: PrismaClient,
  workspaceId: string,
  id: string,
  member: WorkspaceMember,
): Promise<ReportSchedule> {
  const schedule = await find(prisma, workspaceId, id, member);
  if (!canEdit(schedule, member)) {
    throw AppError.forbidden('Only the author of the report or an admin can change it');
  }
  return schedule;
}

// ─── Checks ───────────────────────────────────────────────────────────────────

/** Recipients: active members; anyone but the author only in an admin's report. */
async function assertRecipients(
  prisma: PrismaClient,
  workspaceId: string,
  author: WorkspaceMember,
  recipientIds: string[],
): Promise<void> {
  const ids = [...new Set(recipientIds)];
  if (ids.some((id) => id !== author.user_id) && !seesAllProjects(author)) {
    throw new AppError(
      403,
      'REPORT_RECIPIENTS_FORBIDDEN',
      'Only a report of an admin or the owner can go to other people',
    );
  }
  const found = await prisma.workspaceMember.count({
    where: {
      workspace_id: workspaceId,
      user_id: { in: ids },
      deactivated_at: null,
      user: { is_active: true },
    },
  });
  if (found !== ids.length) {
    throw new AppError(
      400,
      'RECIPIENT_NOT_MEMBER',
      'Every recipient must be an active member of the workspace',
    );
  }
}

/**
 * The filters must make a document for the author now: departments inside their
 * area (the same check as «Аналитика»), one visible project for a project report.
 */
async function assertFilters(
  prisma: PrismaClient,
  workspace: WorkspaceRef,
  author: WorkspaceMember,
  report: ReportSchedule['report'],
  filters: ReportFilters,
): Promise<void> {
  if (report === 'project' && filters.project?.length !== 1) {
    throw AppError.badRequest('A project report needs exactly one project in `filters.project`');
  }
  for (const id of filters.project ?? []) {
    const project = await prisma.project.findFirst({
      where: { id, workspace_id: workspace.id, deleted_at: null },
      select: { visibility: true, members: { where: { user_id: author.user_id } } },
    });
    const visible =
      project &&
      (project.visibility === 'public' || seesAllProjects(author) || project.members.length > 0);
    if (!visible) throw AppError.badRequest('Unknown project');
  }
  await analyticsData(prisma, workspace, author, { ...filters, limit: 10 });
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function listSchedules(
  prisma: PrismaClient,
  workspaceId: string,
  member: WorkspaceMember,
) {
  const rows = await prisma.reportSchedule.findMany({
    where: {
      workspace_id: workspaceId,
      ...(!seesAllProjects(member) && {
        OR: [{ created_by_id: member.user_id }, { recipient_ids: { has: member.user_id } }],
      }),
    },
    include: INCLUDE,
    orderBy: [{ is_active: 'desc' }, { next_run_at: 'asc' }, { created_at: 'asc' }],
  });
  return { data: await views(prisma, rows, member) };
}

export async function getSchedule(
  prisma: PrismaClient,
  workspaceId: string,
  id: string,
  member: WorkspaceMember,
) {
  await find(prisma, workspaceId, id, member);
  return read(prisma, id, member);
}

/** Weekday and day of the month kept only where the frequency uses them. */
function timing(
  frequency: ReportSchedule['frequency'],
  byWeekday: number[] | undefined,
  byMonthday: number | null | undefined,
) {
  return {
    by_weekday: frequency === 'weekly' ? [...new Set(byWeekday ?? [1])].sort() : [],
    by_monthday: frequency === 'monthly' || frequency === 'quarterly' ? (byMonthday ?? 1) : null,
  };
}

export async function createSchedule(
  prisma: PrismaClient,
  workspace: WorkspaceRef,
  member: WorkspaceMember,
  body: CreateScheduleBody,
  now = new Date(),
) {
  const recipients = [...new Set(body.recipient_ids ?? [member.user_id])];
  await assertRecipients(prisma, workspace.id, member, recipients);
  await assertFilters(prisma, workspace, member, body.report, body.filters);
  const schedule = {
    frequency: body.frequency,
    ...timing(body.frequency, body.by_weekday, body.by_monthday),
    time: body.time,
    // A quarter's first day anchors quarterly runs to January, April, July, October.
    start_date: quarterStart(localDate(now, workspace.timezone)),
  };
  const row = await prisma.reportSchedule.create({
    data: {
      workspace_id: workspace.id,
      created_by_id: member.user_id,
      name: body.name || null,
      report: body.report,
      filters: body.filters,
      period: body.period ?? DEFAULT_PERIOD[body.frequency],
      ...schedule,
      recipient_ids: recipients,
      channels: [...new Set(body.channels)],
      next_run_at: nextRun(schedule, workspace.timezone, now),
    },
  });
  return read(prisma, row.id, member);
}

export async function updateSchedule(
  prisma: PrismaClient,
  workspace: WorkspaceRef,
  id: string,
  member: WorkspaceMember,
  body: UpdateScheduleBody,
  now = new Date(),
) {
  const before = await editable(prisma, workspace.id, id, member);
  const report = body.report ?? before.report;
  const filters = body.filters ?? ReportFiltersSchema.parse(before.filters ?? {});
  const recipients = body.recipient_ids ? [...new Set(body.recipient_ids)] : before.recipient_ids;

  // The checks run as the author: the document is theirs, whoever edits it.
  const author = await prisma.workspaceMember.findUnique({
    where: {
      workspace_id_user_id: { workspace_id: workspace.id, user_id: before.created_by_id },
    },
  });
  if (body.recipient_ids || body.filters || body.report) {
    if (!author) {
      throw new AppError(
        409,
        'AUTHOR_NOT_MEMBER',
        'The author of the report has left the workspace',
      );
    }
    if (body.recipient_ids) await assertRecipients(prisma, workspace.id, author, recipients);
    if (body.filters || body.report)
      await assertFilters(prisma, workspace, author, report, filters);
  }

  const frequency = body.frequency ?? before.frequency;
  const scheduleChanged =
    body.frequency !== undefined ||
    body.by_weekday !== undefined ||
    body.by_monthday !== undefined ||
    body.time !== undefined;
  const schedule = {
    frequency,
    ...timing(
      frequency,
      body.by_weekday ?? before.by_weekday,
      body.by_monthday !== undefined ? body.by_monthday : before.by_monthday,
    ),
    time: body.time ?? before.time,
    start_date: scheduleChanged
      ? quarterStart(localDate(now, workspace.timezone))
      : before.start_date,
  };
  const isActive = body.is_active ?? before.is_active;
  const resumed = isActive && !before.is_active;
  await prisma.reportSchedule.update({
    where: { id },
    data: {
      ...(body.name !== undefined && { name: body.name || null }),
      report,
      filters,
      ...(body.period && { period: body.period }),
      ...(body.frequency && !body.period && { period: DEFAULT_PERIOD[frequency] }),
      ...schedule,
      recipient_ids: recipients,
      ...(body.channels && { channels: [...new Set(body.channels)] }),
      is_active: isActive,
      // A changed schedule or a resumed report counts from now: missed runs are not made up.
      ...((scheduleChanged || resumed) && {
        next_run_at: nextRun(schedule, workspace.timezone, now),
      }),
      ...((scheduleChanged || resumed || body.recipient_ids || body.filters || body.report) && {
        last_error: null,
      }),
    },
  });
  return read(prisma, id, member);
}

export async function deleteSchedule(
  prisma: PrismaClient,
  storage: StorageDriver,
  workspaceId: string,
  id: string,
  member: WorkspaceMember,
): Promise<ReportSchedule> {
  const schedule = await editable(prisma, workspaceId, id, member);
  const files = await prisma.reportRun.findMany({
    where: { schedule_id: id, storage_key: { not: null } },
    select: { storage_key: true },
  });
  await prisma.reportSchedule.delete({ where: { id } });
  for (const f of files) await storage.delete(f.storage_key!).catch(() => {});
  return schedule;
}

/** «Отправить сейчас». */
export async function sendNow(
  prisma: PrismaClient,
  storage: StorageDriver,
  workspace: WorkspaceRef,
  id: string,
  member: WorkspaceMember,
) {
  const schedule = await editable(prisma, workspace.id, id, member);
  const outcome = await runSchedule(
    prisma,
    storage,
    { ...schedule, workspace },
    { triggeredBy: member.user_id },
  );
  if (outcome.blocked) {
    throw new AppError(
      409,
      outcome.blocked as ErrorCode,
      'The author can no longer send this report',
    );
  }
  return runView(outcome.run!, schedule, member);
}

export async function listRuns(
  prisma: PrismaClient,
  workspaceId: string,
  id: string,
  member: WorkspaceMember,
) {
  const schedule = await find(prisma, workspaceId, id, member);
  const runs = await prisma.reportRun.findMany({
    where: {
      schedule_id: id,
      ...(!canEdit(schedule, member) && { recipient_ids: { has: member.user_id } }),
    },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
  });
  return { data: runs.map((r) => runView(r, schedule, member)) };
}

/** A short-lived link to the file of one sending (the caller writes the audit entry). */
export async function downloadRun(
  prisma: PrismaClient,
  storage: StorageDriver,
  workspaceId: string,
  runId: string,
  member: WorkspaceMember,
) {
  const run = await prisma.reportRun.findFirst({
    where: { id: runId, workspace_id: workspaceId },
    include: { schedule: true },
  });
  const allowed =
    run && (canEdit(run.schedule, member) || run.recipient_ids.includes(member.user_id));
  if (!run || !allowed || !run.storage_key || !run.file_name) {
    throw AppError.notFound('Report file not found');
  }
  return {
    run,
    url: await storage.presignDownload(run.storage_key, run.file_name),
    file_name: run.file_name,
  };
}
