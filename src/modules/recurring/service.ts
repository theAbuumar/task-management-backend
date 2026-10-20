// Recurring issues (Ф6 6.B4, ADR-030): «ежемесячный отчёт о посещаемости»
// creates itself on the 1st. A rule keeps a copy of the create form's fields and
// a schedule in the workspace zone (./schedule.ts). The scheduler pass
// (runRecurring) creates one issue per due rule through createIssue, on behalf of
// the rule's author, so every rule of creating an issue applies.
//
// Rights: everyone who sees the project sees its rules; a member who may create
// issues creates one (a guest is refused by the workspace hook); its author or an
// admin changes, runs and deletes it.

import { z } from 'zod';
import type { Prisma, PrismaClient, RecurringRule, WorkspaceMember } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { addDays, localDate, startOfLocalDay } from '../../lib/tz.js';
import { seesAllProjects } from '../../plugins/workspace-hook.js';
import { createIssue } from '../issues/service.js';
import {
  DueInDaysSchema,
  IssueFieldsSchema,
  assertIssueFields,
  createBodyFrom,
} from '../issues/fields.js';
import { isoWeekday, nextRunAfter, type Schedule } from './schedule.js';

const FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'] as const;

const LocalDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date like 2026-11-01')
  .refine(
    (d) =>
      !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) &&
      new Date(`${d}T00:00:00Z`).toISOString().startsWith(d),
    'Not a calendar date',
  );
const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected a time like 09:00');

const ScheduleFields = {
  frequency: z.enum(FREQUENCIES),
  interval: z.number().int().min(1).max(52),
  by_weekday: z.array(z.number().int().min(1).max(7)).max(7),
  by_monthday: z.number().int().min(1).max(31).nullable(),
  by_month: z.number().int().min(1).max(12).nullable(),
  time: TimeSchema,
  start_date: LocalDateSchema,
  until: LocalDateSchema.nullable(),
};

export const CreateRuleBodySchema = z
  .object({
    ...ScheduleFields,
    interval: ScheduleFields.interval.default(1),
    by_weekday: ScheduleFields.by_weekday.optional(),
    by_monthday: ScheduleFields.by_monthday.optional(),
    by_month: ScheduleFields.by_month.optional(),
    time: ScheduleFields.time.default('09:00'),
    start_date: ScheduleFields.start_date.optional(),
    until: ScheduleFields.until.optional(),
    data: IssueFieldsSchema,
    due_in_days: DueInDaysSchema.optional(),
    // «Повторять» in the create form: the first issue now, the rule for the next ones.
    create_now: z.boolean().optional(),
  })
  .strict();

export const UpdateRuleBodySchema = z
  .object({
    ...ScheduleFields,
    data: IssueFieldsSchema,
    due_in_days: DueInDaysSchema,
    is_active: z.boolean(),
  })
  .partial()
  .strict();

const INCLUDE = {
  created_by: { select: { id: true, display_name: true, avatar_url: true } },
  _count: { select: { issues: { where: { deleted_at: null } } } },
  issues: {
    where: { deleted_at: null },
    orderBy: { created_at: 'desc' },
    take: 1,
    select: { id: true, sequence_id: true, title: true, created_at: true },
  },
} as const satisfies Prisma.RecurringRuleInclude;

type Row = Prisma.RecurringRuleGetPayload<{ include: typeof INCLUDE }>;

function shape(row: Row, member: WorkspaceMember) {
  const { _count, issues, ...rule } = row;
  return {
    ...rule,
    issues_count: _count.issues,
    last_issue: issues[0] ?? null,
    can_edit: canEdit(rule, member),
  };
}

function canEdit(rule: Pick<RecurringRule, 'created_by_id'>, member: WorkspaceMember): boolean {
  return seesAllProjects(member) || rule.created_by_id === member.user_id;
}

/** The schedule with its defaults filled from the start date, kept only where it applies. */
function normalize(s: Schedule): Schedule {
  const [, startMonth, startDay] = s.start_date.split('-').map(Number);
  const weekly = s.frequency === 'weekly';
  const byMonthday = weekly || s.frequency === 'daily' ? null : (s.by_monthday ?? startDay!);
  return {
    ...s,
    by_weekday: weekly
      ? [...new Set(s.by_weekday.length ? s.by_weekday : [isoWeekday(s.start_date)])].sort()
      : [],
    by_monthday: byMonthday,
    by_month: s.frequency === 'yearly' ? (s.by_month ?? startMonth!) : null,
  };
}

function scheduleOf(rule: RecurringRule): Schedule {
  return {
    frequency: rule.frequency,
    interval: rule.interval,
    by_weekday: rule.by_weekday,
    by_monthday: rule.by_monthday,
    by_month: rule.by_month,
    time: rule.time,
    start_date: rule.start_date,
    until: rule.until,
  };
}

function assertUntil(s: Schedule): void {
  if (s.until && s.until < s.start_date) {
    throw AppError.badRequest('until must not be before start_date');
  }
}

async function findRule(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  ruleId: string,
): Promise<RecurringRule> {
  const rule = await prisma.recurringRule.findFirst({
    where: { id: ruleId, project_id: projectId, workspace_id: workspaceId },
  });
  if (!rule) throw AppError.notFound('Recurring rule not found');
  return rule;
}

async function editable(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  ruleId: string,
  member: WorkspaceMember,
): Promise<RecurringRule> {
  const rule = await findRule(prisma, workspaceId, projectId, ruleId);
  if (!canEdit(rule, member)) {
    throw AppError.forbidden('Only the author of the rule or an admin can change it');
  }
  return rule;
}

async function read(prisma: PrismaClient, ruleId: string, member: WorkspaceMember) {
  const row = await prisma.recurringRule.findUniqueOrThrow({
    where: { id: ruleId },
    include: INCLUDE,
  });
  return shape(row, member);
}

export async function listRules(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  member: WorkspaceMember,
) {
  const rows = await prisma.recurringRule.findMany({
    where: { workspace_id: workspaceId, project_id: projectId },
    include: INCLUDE,
    orderBy: [{ is_active: 'desc' }, { next_run_at: 'asc' }, { created_at: 'asc' }],
  });
  return { data: rows.map((r) => shape(r, member)) };
}

export async function getRule(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  ruleId: string,
  member: WorkspaceMember,
) {
  await findRule(prisma, workspaceId, projectId, ruleId);
  return read(prisma, ruleId, member);
}

/** An issue of the rule, created now (scheduler, «Создать сейчас», «Повторять»). */
async function createInstance(
  prisma: PrismaClient,
  workspace: { id: string; timezone: string },
  rule: Pick<RecurringRule, 'id' | 'project_id' | 'created_by_id' | 'data' | 'due_in_days'>,
  now: Date,
) {
  const fields = IssueFieldsSchema.parse(rule.data);
  const body = await createBodyFrom(
    prisma,
    rule.project_id,
    fields,
    rule.due_in_days,
    localDate(now, workspace.timezone),
  );
  return createIssue(prisma, workspace.id, rule.project_id, rule.created_by_id, body, {
    recurringRuleId: rule.id,
  });
}

export async function createRule(
  prisma: PrismaClient,
  workspace: { id: string; timezone: string },
  projectId: string,
  member: WorkspaceMember,
  body: z.infer<typeof CreateRuleBodySchema>,
  now = new Date(),
) {
  const today = localDate(now, workspace.timezone);
  const schedule = normalize({
    frequency: body.frequency,
    interval: body.interval,
    by_weekday: body.by_weekday ?? [],
    by_monthday: body.by_monthday ?? null,
    by_month: body.by_month ?? null,
    time: body.time,
    start_date: body.start_date ?? today,
    until: body.until ?? null,
  });
  assertUntil(schedule);
  await assertIssueFields(prisma, workspace.id, projectId, body.data);
  // The issue created now stands for today's run: the next one is on a later day.
  const after = body.create_now
    ? new Date(startOfLocalDay(addDays(today, 1), workspace.timezone).getTime() - 1)
    : now;
  const rule = await prisma.recurringRule.create({
    data: {
      workspace_id: workspace.id,
      project_id: projectId,
      created_by_id: member.user_id,
      data: body.data,
      due_in_days: body.due_in_days ?? null,
      ...schedule,
      next_run_at: nextRunAfter(schedule, workspace.timezone, after),
    },
  });
  if (!body.create_now) return { ...(await read(prisma, rule.id, member)), created_issue: null };
  try {
    const issue = await createInstance(prisma, workspace, rule, now);
    await prisma.recurringRule.update({ where: { id: rule.id }, data: { last_run_at: now } });
    return { ...(await read(prisma, rule.id, member)), created_issue: issue };
  } catch (err) {
    // The form makes both or neither.
    await prisma.recurringRule.delete({ where: { id: rule.id } });
    throw err;
  }
}

export async function updateRule(
  prisma: PrismaClient,
  workspace: { id: string; timezone: string },
  projectId: string,
  ruleId: string,
  member: WorkspaceMember,
  body: z.infer<typeof UpdateRuleBodySchema>,
  now = new Date(),
) {
  const before = await editable(prisma, workspace.id, projectId, ruleId, member);
  const merged = { ...scheduleOf(before) };
  for (const key of Object.keys(ScheduleFields) as (keyof Schedule)[]) {
    if (body[key] !== undefined) (merged as Record<string, unknown>)[key] = body[key];
  }
  const schedule = normalize(merged);
  assertUntil(schedule);
  if (body.data) await assertIssueFields(prisma, workspace.id, projectId, body.data);
  const isActive = body.is_active ?? before.is_active;
  const scheduleChanged = Object.keys(ScheduleFields).some((k) => k in body);
  // A changed schedule or a resumed rule starts from now: missed runs are not made up.
  const resumed = isActive && !before.is_active;
  await prisma.recurringRule.update({
    where: { id: ruleId },
    data: {
      ...(body.data && { data: body.data }),
      ...(body.due_in_days !== undefined && { due_in_days: body.due_in_days }),
      ...schedule,
      is_active: isActive,
      ...((scheduleChanged || resumed) && {
        next_run_at: nextRunAfter(schedule, workspace.timezone, now),
      }),
      ...((scheduleChanged || resumed || body.data) && { last_error: null }),
    },
  });
  return read(prisma, ruleId, member);
}

export async function deleteRule(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  ruleId: string,
  member: WorkspaceMember,
): Promise<void> {
  await editable(prisma, workspaceId, projectId, ruleId, member);
  // Issues it created stay; they only lose the link (onDelete: SetNull).
  await prisma.recurringRule.delete({ where: { id: ruleId } });
}

/** «Создать сейчас»: one issue of the rule outside its schedule (the schedule is kept). */
export async function runRuleNow(
  prisma: PrismaClient,
  workspace: { id: string; timezone: string },
  projectId: string,
  ruleId: string,
  member: WorkspaceMember,
  now = new Date(),
) {
  const rule = await editable(prisma, workspace.id, projectId, ruleId, member);
  return createInstance(prisma, workspace, rule, now);
}

export interface RecurringRunResult {
  created: number;
  failed: number;
  paused: number;
}

/** Why the author can no longer create issues here, or null when they can. */
async function authorBlocked(
  prisma: PrismaClient,
  rule: RecurringRule & { project: { visibility: string } },
): Promise<string | null> {
  const member = await prisma.workspaceMember.findUnique({
    where: {
      workspace_id_user_id: { workspace_id: rule.workspace_id, user_id: rule.created_by_id },
    },
    include: { user: { select: { is_active: true } } },
  });
  if (!member || !member.user.is_active) return 'AUTHOR_NOT_MEMBER';
  if (member.deactivated_at) return 'MEMBER_DEACTIVATED';
  if (member.role === 'guest') return 'GUEST_READ_ONLY';
  if (rule.project.visibility === 'private' && !seesAllProjects(member)) {
    const inProject = await prisma.projectMember.findUnique({
      where: { project_id_user_id: { project_id: rule.project_id, user_id: rule.created_by_id } },
    });
    if (!inProject) return 'AUTHOR_NOT_MEMBER';
  }
  return null;
}

/**
 * The scheduler pass: every active rule whose run is due creates one issue. The
 * rule is first claimed — moved to its next run with a conditional update — so two
 * passes never create the same run twice, and a rule that missed several runs
 * while the server was off creates one issue, not one per missed run.
 */
export async function runRecurring(
  prisma: PrismaClient,
  options: { now?: Date; workspaceId?: string } = {},
): Promise<RecurringRunResult> {
  const now = options.now ?? new Date();
  const result: RecurringRunResult = { created: 0, failed: 0, paused: 0 };
  const due = await prisma.recurringRule.findMany({
    where: {
      is_active: true,
      next_run_at: { lte: now },
      ...(options.workspaceId && { workspace_id: options.workspaceId }),
      project: { deleted_at: null },
    },
    include: {
      workspace: { select: { id: true, timezone: true } },
      project: { select: { visibility: true } },
    },
    orderBy: { next_run_at: 'asc' },
    take: 500,
  });
  for (const rule of due) {
    const claimed = await prisma.recurringRule.updateMany({
      where: { id: rule.id, is_active: true, next_run_at: rule.next_run_at },
      data: {
        next_run_at: nextRunAfter(scheduleOf(rule), rule.workspace.timezone, now),
        last_run_at: now,
      },
    });
    if (claimed.count === 0) continue;

    const blocked = await authorBlocked(prisma, rule);
    if (blocked) {
      await prisma.recurringRule.update({
        where: { id: rule.id },
        data: { is_active: false, last_error: blocked },
      });
      result.paused += 1;
      continue;
    }
    try {
      await createInstance(prisma, rule.workspace, rule, now);
      if (rule.last_error) {
        await prisma.recurringRule.update({ where: { id: rule.id }, data: { last_error: null } });
      }
      result.created += 1;
    } catch (err) {
      // An assignee was turned off, the controller became a guest…: the rule waits
      // for its next run, and the reason is shown next to it.
      const code = err instanceof AppError ? err.code : 'INTERNAL_ERROR';
      await prisma.recurringRule.update({ where: { id: rule.id }, data: { last_error: code } });
      result.failed += 1;
    }
  }
  return result;
}
