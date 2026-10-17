import type { PrismaClient, Issue, Prisma, StateGroup, WorkspaceMember } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { recordActivity, recordActivities, ACTIVITY_ACTIONS } from '../../lib/activity.js';
import { notify } from '../../lib/notifications.js';
import { sendIssueNotification, telegramConfigured } from '../auth/telegram.service.js';
import { sendIssueNotificationEmail } from '../../lib/email.js';
import type {
  CreateIssueBody,
  UpdateIssueBody,
  IssueFilterQuery,
  WorkspaceIssueQuery,
} from './schema.js';
import { expandDepartments, inDepartmentsWhere, visibleIssuesWhere } from './scope.js';
import { distributionProgress, type DistributionProgress } from './distribution-progress.js';
import { deliverIssueEvent } from '../../lib/deliver.js';
import { issueUrl } from '../../lib/urls.js';
import { publish } from '../../lib/realtime.js';
import { notificationButtons } from '../telegram/views.js';
import { addDays, localDate, startOfLocalDay } from '../../lib/tz.js';
import {
  OPEN_GROUPS,
  addWatchers,
  closePendingReview,
  isReviewer,
  memberRole,
  openReview,
  watcherIds,
} from '../control/rules.js';

/** Who is asking + the workspace clock — needed for `me` and date filters. */
export interface IssueViewer {
  userId: string;
  timeZone: string;
}

/** Coerce an issue field value to its stored string form for the activity trail. */
function activityValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Issue scalar fields whose changes are recorded in the activity trail. */
const TRACKED_FIELDS = [
  'title',
  'description',
  'state_id',
  'priority',
  'parent_id',
  'start_date',
  'due_date',
  'estimate_points',
  'kind',
  'controller_id',
  'requires_review',
  'basis',
] as const;

/** Issue with assignees and labels included (the standard response shape). */
type IssueWithRelations = Prisma.IssueGetPayload<{
  include: {
    assignees: {
      include: {
        user: { select: { id: true; email: true; display_name: true; avatar_url: true } };
      };
    };
    labels: { include: { label: true } };
    controller: { select: { id: true; email: true; display_name: true; avatar_url: true } };
    department: { select: { id: true; name: true; short_name: true } };
    state: { select: { id: true; name: true; group: true; color: true } };
    _count: {
      select: {
        watchers: true;
        deadline_requests: { where: { status: 'approved' } };
      };
    };
  };
}>;

const USER_BRIEF = { id: true, email: true, display_name: true, avatar_url: true } as const;

export const INCLUDE_RELATIONS = {
  assignees: {
    include: { user: { select: USER_BRIEF } },
    // Primary (ответственный) first, then in assignment order.
    orderBy: [{ is_primary: 'desc' }, { created_at: 'asc' }],
  },
  labels: { include: { label: true } },
  controller: { select: USER_BRIEF },
  department: { select: { id: true, name: true, short_name: true } },
  state: { select: { id: true, name: true, group: true, color: true } },
  _count: {
    select: {
      watchers: true,
      deadline_requests: { where: { status: 'approved' } },
    },
  },
} satisfies Prisma.IssueInclude;

/** The controller of an assignment must be a member of the workspace. */
async function assertWorkspaceMember(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  field: string,
): Promise<void> {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: userId } },
  });
  if (!member) throw AppError.badRequest(`${field} must be a member of this workspace`);
}

async function resolveProject(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
): Promise<void> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspace_id: workspaceId },
  });
  if (!project) throw AppError.notFound('Project not found');
}

async function resolveIssue(
  prisma: PrismaClient,
  projectId: string,
  issueId: string,
): Promise<IssueWithRelations> {
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, project_id: projectId, deleted_at: null },
    include: INCLUDE_RELATIONS,
  });
  if (!issue) throw AppError.notFound('Issue not found');
  return issue;
}

/** Next sequence_id for a project — use inside a serializable transaction. */
export async function nextSequenceId(
  prisma: Prisma.TransactionClient,
  projectId: string,
): Promise<number> {
  const last = await prisma.issue.findFirst({
    where: { project_id: projectId },
    orderBy: { sequence_id: 'desc' },
    select: { sequence_id: true },
  });
  return (last?.sequence_id ?? 0) + 1;
}

function normalizeArrayParam(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

/** Build a `due_date`/`created_at` range filter from before/after bounds. */
function dateRange(after?: string, before?: string): Prisma.DateTimeFilter | undefined {
  if (after === undefined && before === undefined) return undefined;
  return {
    ...(after !== undefined && { gte: new Date(after) }),
    ...(before !== undefined && { lte: new Date(before) }),
  };
}

/** Filters shared by the project list and the workspace-wide list. */
type FilterQuery = Omit<IssueFilterQuery, 'group_by'>;

/** Translate the validated filter query into a Prisma `where` clause. */
export function buildWhere(
  projectId: string | undefined,
  query: FilterQuery,
  viewer?: IssueViewer,
): Prisma.IssueWhereInput {
  const me = (id: string | undefined) => (id === 'me' ? viewer?.userId : id);
  const states = normalizeArrayParam(query.state);
  const priorities = normalizeArrayParam(query.priority);
  const assignees = normalizeArrayParam(query.assignee)?.map((a) => me(a) ?? a);
  const labels = normalizeArrayParam(query.label);
  const dueDate = dateRange(query.due_after, query.due_before);
  const createdAt = dateRange(query.created_after, query.created_before);
  const completedAt = dateRange(query.completed_after, query.completed_before);
  const stateGroups = normalizeArrayParam(query.state_group) as StateGroup[] | undefined;

  // Calendar-day boundaries in the workspace zone for the deadline filters.
  const tz = viewer?.timeZone ?? 'UTC';
  const today = localDate(new Date(), tz);
  const startToday = startOfLocalDay(today, tz);
  const and: Prisma.IssueWhereInput[] = [];
  if (query.overdue) {
    and.push({ due_date: { lt: startToday } }, { state: { group: { in: OPEN_GROUPS } } });
  }
  if (query.due_within !== undefined) {
    and.push(
      { due_date: { gte: startToday, lt: startOfLocalDay(addDays(today, query.due_within + 1), tz) } },
      { state: { group: { in: OPEN_GROUPS } } },
    );
  }
  if (query.open !== undefined) {
    and.push({ state: { group: query.open ? { in: OPEN_GROUPS } : { notIn: OPEN_GROUPS } } });
  }
  if (query.review_pending !== undefined) {
    and.push({ state: { group: query.review_pending ? 'review' : { not: 'review' } } });
  }
  if (query.acknowledged !== undefined && viewer) {
    and.push(
      query.acknowledged
        ? { assignees: { some: { user_id: viewer.userId, acknowledged_at: { not: null } } } }
        : { assignees: { some: { user_id: viewer.userId, acknowledged_at: null } } },
    );
  }
  if (query.watcher !== undefined) {
    and.push({ watchers: { some: { user_id: me(query.watcher) } } });
  }
  if (query.reviewer !== undefined) {
    const reviewer = me(query.reviewer);
    and.push({ OR: [{ controller_id: reviewer }, { controller_id: null, created_by_id: reviewer }] });
  }
  if (stateGroups) and.push({ state: { group: { in: stateGroups } } });

  return {
    ...(projectId !== undefined && { project_id: projectId }),
    deleted_at: null,
    ...(and.length > 0 && { AND: and }),
    ...(states && { state_id: { in: states } }),
    ...(priorities && { priority: { in: priorities as Issue['priority'][] } }),
    ...(assignees && { assignees: { some: { user_id: { in: assignees } } } }),
    ...(labels && { labels: { some: { label_id: { in: labels } } } }),
    ...(query.cycle !== undefined && { cycle_id: query.cycle }),
    ...(query.module !== undefined && { modules: { some: { module_id: query.module } } }),
    ...(query.created_by !== undefined && { created_by_id: me(query.created_by) }),
    ...(query.parent_id !== undefined && { parent_id: query.parent_id }),
    ...(query.kind !== undefined && { kind: query.kind }),
    ...(query.controller !== undefined && { controller_id: me(query.controller) }),
    ...(query.search && {
      OR: [
        { title: { contains: query.search, mode: 'insensitive' as const } },
        { description: { contains: query.search, mode: 'insensitive' as const } },
      ],
    }),
    ...(dueDate && { due_date: dueDate }),
    ...(createdAt && { created_at: createdAt }),
    ...(completedAt && { completed_at: completedAt }),
  };
}

/** Sort by the requested column, with `id` as a deterministic tiebreaker for stable cursoring. */
function buildOrderBy(query: FilterQuery): Prisma.IssueOrderByWithRelationInput[] {
  return [{ [query.sort_by]: query.order }, { id: query.order }];
}

/** Hard cap on rows returned for a board-view (grouped) response. */
const GROUP_FETCH_CAP = 500;

export interface IssueGroup {
  key: string | null;
  issues: IssueWithRelations[];
}

export type ListIssuesResult =
  | { data: IssueWithRelations[]; next_cursor: string | null }
  | { group_by: NonNullable<IssueFilterQuery['group_by']>; groups: IssueGroup[] };

export async function listIssues(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  query: IssueFilterQuery,
  viewer?: IssueViewer,
): Promise<ListIssuesResult> {
  await resolveProject(prisma, workspaceId, projectId);

  const where = buildWhere(projectId, query, viewer);
  const orderBy = buildOrderBy(query);

  if (query.group_by) {
    const issues = await prisma.issue.findMany({
      where,
      include: INCLUDE_RELATIONS,
      orderBy,
      take: GROUP_FETCH_CAP,
    });
    return { group_by: query.group_by, groups: bucketIssues(issues, query.group_by) };
  }

  const limit = query.limit;
  const issues = await prisma.issue.findMany({
    where,
    include: INCLUDE_RELATIONS,
    orderBy,
    take: limit + 1, // fetch one extra to determine if there is a next page
    ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
  });

  const hasMore = issues.length > limit;
  const data = hasMore ? issues.slice(0, limit) : issues;
  const next_cursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

  return { data, next_cursor };
}

const PROJECT_BRIEF = { id: true, name: true, identifier: true, icon: true, color: true } as const;

/**
 * Issues across the whole workspace (7.B1): every project the member can see,
 * the same filters as a project list plus `project[]` and `department[]` (with
 * sub-departments). Replaces the per-project fan-out on Home and «Мои задачи».
 */
export async function listWorkspaceIssues(
  prisma: PrismaClient,
  workspace: { id: string; timezone: string },
  member: WorkspaceMember,
  query: WorkspaceIssueQuery,
): Promise<{ data: (IssueWithRelations & { project: { id: string } })[]; next_cursor: string | null }> {
  const viewer = { userId: member.user_id, timeZone: workspace.timezone };
  const projects = normalizeArrayParam(query.project);
  const departments = normalizeArrayParam(query.department);
  const and: Prisma.IssueWhereInput[] = [
    visibleIssuesWhere(workspace.id, member),
    buildWhere(undefined, query, viewer),
  ];
  if (projects) and.push({ project_id: { in: projects } });
  if (departments) {
    const ids = await expandDepartments(prisma, workspace.id, departments);
    and.push(inDepartmentsWhere(workspace.id, ids));
  }

  const limit = query.limit;
  const issues = await prisma.issue.findMany({
    where: { AND: and },
    include: { ...INCLUDE_RELATIONS, project: { select: PROJECT_BRIEF } },
    orderBy: buildOrderBy(query),
    take: limit + 1,
    ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
  });
  const hasMore = issues.length > limit;
  const data = hasMore ? issues.slice(0, limit) : issues;
  return { data, next_cursor: hasMore ? (data[data.length - 1]?.id ?? null) : null };
}

/**
 * Bucket issues for a board view. Buckets preserve the order in which keys are
 * first seen (i.e. the sort order). For `assignee`, an issue appears in every
 * assignee bucket it belongs to; unassigned issues fall into the `null` bucket.
 */
function bucketIssues(
  issues: IssueWithRelations[],
  groupBy: NonNullable<IssueFilterQuery['group_by']>,
): IssueGroup[] {
  const groups = new Map<string | null, IssueWithRelations[]>();
  const push = (key: string | null, issue: IssueWithRelations): void => {
    const bucket = groups.get(key);
    if (bucket) bucket.push(issue);
    else groups.set(key, [issue]);
  };

  for (const issue of issues) {
    if (groupBy === 'state') push(issue.state_id, issue);
    else if (groupBy === 'priority') push(issue.priority, issue);
    else if (issue.assignees.length === 0) push(null, issue);
    else for (const a of issue.assignees) push(a.user_id, issue);
  }

  return [...groups.entries()].map(([key, bucketIssuesList]) => ({
    key,
    issues: bucketIssuesList,
  }));
}

export async function createIssue(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  creatorId: string,
  body: CreateIssueBody,
): Promise<IssueWithRelations> {
  await resolveProject(prisma, workspaceId, projectId);

  // Validate state belongs to the project.
  const state = await prisma.state.findFirst({
    where: { id: body.state_id, project_id: projectId },
  });
  if (!state) throw AppError.badRequest('state_id does not belong to this project');

  // Validate parent (single-level only).
  if (body.parent_id) {
    const parent = await prisma.issue.findFirst({
      where: { id: body.parent_id, project_id: projectId, deleted_at: null },
    });
    if (!parent) throw AppError.badRequest('parent_id does not exist in this project');
    if (parent.parent_id)
      throw AppError.badRequest('Sub-issues cannot have sub-issues (single level only)');
  }

  if (body.controller_id) {
    await assertWorkspaceMember(prisma, workspaceId, body.controller_id, 'controller_id');
  }
  const assigneeIds = [...new Set(body.assignee_ids ?? [])];
  if (body.primary_assignee_id && !assigneeIds.includes(body.primary_assignee_id)) {
    throw AppError.badRequest('primary_assignee_id must be one of assignee_ids');
  }
  const primaryId = body.primary_assignee_id ?? assigneeIds[0];
  // An assignment with a controller is reviewed by default (ADR-008).
  const requiresReview =
    body.requires_review ?? (body.kind === 'assignment' && Boolean(body.controller_id));

  const issue = await prisma.$transaction(async (tx) => {
    const sequenceId = await nextSequenceId(tx, projectId);

    const issue = await tx.issue.create({
      data: {
        workspace_id: workspaceId,
        project_id: projectId,
        sequence_id: sequenceId,
        title: body.title,
        description: body.description,
        state_id: body.state_id,
        priority: body.priority,
        parent_id: body.parent_id ?? null,
        start_date: body.start_date ? new Date(body.start_date) : null,
        due_date: body.due_date ? new Date(body.due_date) : null,
        estimate_points: body.estimate_points ?? null,
        created_by_id: creatorId,
        kind: body.kind,
        controller_id: body.controller_id ?? null,
        requires_review: requiresReview,
        basis: body.basis ?? null,
        assignees: assigneeIds.length
          ? {
              createMany: {
                data: assigneeIds.map((uid) => ({ user_id: uid, is_primary: uid === primaryId })),
              },
            }
          : undefined,
        labels: body.label_ids?.length
          ? { createMany: { data: body.label_ids.map((lid) => ({ label_id: lid })) } }
          : undefined,
      },
      include: INCLUDE_RELATIONS,
    });

    await recordActivity(tx, {
      workspace_id: workspaceId,
      issue_id: issue.id,
      actor_id: creatorId,
      action: ACTIVITY_ACTIONS.ISSUE_CREATED,
    });

    // Author, assignees and controller follow the issue from the start.
    await addWatchers(tx, issue.id, [creatorId, ...assigneeIds, body.controller_id ?? null]);

    // Notify anyone assigned at creation time (the creator self-assigning is
    // filtered out inside `notify`).
    await notify(tx, {
      workspace_id: workspaceId,
      actor_id: creatorId,
      type: 'issue_assigned',
      recipient_ids: body.assignee_ids ?? [],
      issue_id: issue.id,
    });

    return issue;
  });

  // Best-effort out-of-band notifications, outside the transaction (network I/O). A task
  // with named assignees notifies them; a task with none notifies every project member
  // (the "task for everyone" case). Each recipient gets Telegram if linked, else email.
  // The mutation has already committed, so any failure here is swallowed — it must never
  // turn a created issue into an error response.
  try {
    const { recipientIds, assigned } = await issueCreatedRecipients(
      prisma,
      projectId,
      body.assignee_ids ?? [],
    );
    await notifyIssueRecipients(prisma, {
      projectId,
      actorId: creatorId,
      recipientIds,
      issue,
      assigned,
    });
  } catch {
    // Notification delivery is best-effort; the issue was created regardless.
  }

  return issue;
}

export async function getIssue(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  issueId: string,
): Promise<IssueWithRelations & { distribution?: DistributionProgress }> {
  await resolveProject(prisma, workspaceId, projectId);
  const issue = await resolveIssue(prisma, projectId, issueId);
  // The parent of a distribution carries the per-department progress (6.B2).
  if (!issue.is_distribution) return issue;
  return { ...issue, distribution: await distributionProgress(prisma, issue) };
}

export async function updateIssue(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  issueId: string,
  actorId: string,
  body: UpdateIssueBody,
): Promise<IssueWithRelations> {
  await resolveProject(prisma, workspaceId, projectId);
  const before = await resolveIssue(prisma, projectId, issueId);

  if (body.state_id) {
    const state = await prisma.state.findFirst({
      where: { id: body.state_id, project_id: projectId },
    });
    if (!state) throw AppError.badRequest('state_id does not belong to this project');
  }

  if (body.controller_id) {
    await assertWorkspaceMember(prisma, workspaceId, body.controller_id, 'controller_id');
  }

  // ─── Execution control (Ф5) ───
  const role = await memberRole(prisma, workspaceId, actorId);
  const reviewer = isReviewer(before, actorId, role);
  const fromGroup = before.state.group;
  const toState = body.state_id
    ? await prisma.state.findFirst({
        where: { id: body.state_id, project_id: projectId },
        select: { id: true, name: true, group: true },
      })
    : null;
  const toGroup = toState?.group;
  // Work that needs review can only be closed by its reviewer (5.B3).
  if (toGroup === 'completed' && fromGroup !== 'completed' && before.requires_review && !reviewer) {
    throw new AppError(
      409,
      'REVIEW_REQUIRED',
      'This assignment must be handed in for review; only its controller can close it',
    );
  }
  // An assignment's deadline moves through a deadline-change request (5.B5).
  if (
    body.due_date !== undefined &&
    before.kind === 'assignment' &&
    !reviewer &&
    activityValue(body.due_date ? new Date(body.due_date) : null) !== activityValue(before.due_date)
  ) {
    throw new AppError(
      403,
      'DEADLINE_CHANGE_FORBIDDEN',
      'Only the controller can change this deadline — request a deadline change instead',
    );
  }

  if (
    body.primary_assignee_id &&
    !before.assignees.some((a) => a.user_id === body.primary_assignee_id)
  ) {
    throw AppError.badRequest('primary_assignee_id must be an assignee of this issue');
  }

  if (body.parent_id) {
    if (body.parent_id === issueId) throw AppError.badRequest('An issue cannot be its own parent');
    const parent = await prisma.issue.findFirst({
      where: { id: body.parent_id, project_id: projectId, deleted_at: null },
    });
    if (!parent) throw AppError.badRequest('parent_id does not exist in this project');
    if (parent.parent_id)
      throw AppError.badRequest('Sub-issues cannot have sub-issues (single level only)');
  }

  const completedAt = body.state_id
    ? await (async () => {
        const state = await prisma.state.findUnique({ where: { id: body.state_id } });
        return state?.group === 'completed' ? new Date() : null;
      })()
    : undefined;

  const events: { kind: 'review_requested' | 'review_approved' | 'review_returned'; recipients: string[] }[] = [];

  return prisma.$transaction(async (tx) => {
    if (body.primary_assignee_id) {
      await tx.issueAssignee.updateMany({
        where: { issue_id: issueId },
        data: { is_primary: false },
      });
      await tx.issueAssignee.update({
        where: { issue_id_user_id: { issue_id: issueId, user_id: body.primary_assignee_id } },
        data: { is_primary: true },
      });
    }

    const after = await tx.issue.update({
      where: { id: issueId },
      data: {
        ...(body.title !== undefined && { title: body.title }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.state_id !== undefined && { state_id: body.state_id }),
        ...(body.priority !== undefined && { priority: body.priority }),
        ...(body.parent_id !== undefined && { parent_id: body.parent_id }),
        ...(body.start_date !== undefined && {
          start_date: body.start_date ? new Date(body.start_date) : null,
        }),
        ...(body.due_date !== undefined && {
          due_date: body.due_date ? new Date(body.due_date) : null,
        }),
        ...(body.estimate_points !== undefined && { estimate_points: body.estimate_points }),
        ...(body.sort_order !== undefined && { sort_order: body.sort_order }),
        ...(body.kind !== undefined && { kind: body.kind }),
        ...(body.controller_id !== undefined && { controller_id: body.controller_id }),
        ...(body.requires_review !== undefined && { requires_review: body.requires_review }),
        ...(body.basis !== undefined && { basis: body.basis }),
        ...(completedAt !== undefined && { completed_at: completedAt }),
      },
      include: INCLUDE_RELATIONS,
    });

    // Record one activity row per scalar field that actually changed.
    const changes = TRACKED_FIELDS.flatMap((field) => {
      const oldValue = activityValue(before[field]);
      const newValue = activityValue(after[field]);
      if (oldValue === newValue) return [];
      return [
        {
          workspace_id: workspaceId,
          issue_id: issueId,
          actor_id: actorId,
          action: ACTIVITY_ACTIONS.ISSUE_UPDATED,
          field,
          old_value: oldValue,
          new_value: newValue,
        },
      ];
    });
    await recordActivities(tx, changes);
    // A reorder (sort_order) leaves no activity row, but other boards must follow it.
    if (changes.length === 0) {
      await publish(tx, { t: 'issue.updated', w: workspaceId, a: actorId, i: issueId });
    }

    // State transitions drive the review cycle, so dragging a card behaves like
    // the explicit review buttons (5.B2): → review opens a hand-in; leaving review
    // approves (→ completed) or returns (anything else) the pending one.
    const assigneeIds = after.assignees.map((a) => a.user_id);
    if (toGroup && toGroup !== fromGroup) {
      if (toGroup === 'review') {
        await openReview(tx, after, actorId, null);
        events.push({ kind: 'review_requested', recipients: [after.controller_id ?? after.created_by_id] });
      } else if (fromGroup === 'review') {
        const decision = toGroup === 'completed' ? 'approved' : 'returned';
        const closed = await closePendingReview(tx, after, decision, actorId, null, assigneeIds);
        if (closed) {
          events.push({
            kind: decision === 'approved' ? 'review_approved' : 'review_returned',
            recipients: assigneeIds,
          });
        }
      }
      // Watchers hear about every state change (minus whoever just got a more
      // specific review notification for it).
      const notified = new Set(events.flatMap((e) => e.recipients));
      await notify(tx, {
        workspace_id: workspaceId,
        actor_id: actorId,
        type: 'state_changed',
        recipient_ids: (await watcherIds(tx, issueId)).filter((id) => !notified.has(id)),
        issue_id: issueId,
      });
    }

    return after;
  }).then(async (after) => {
    for (const e of events) {
      await deliverIssueEvent(prisma, {
        issueId,
        kind: e.kind,
        recipientIds: e.recipients,
        actorId,
      });
    }
    return after;
  });
}

export async function deleteIssue(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  issueId: string,
  actorId: string,
): Promise<void> {
  await resolveProject(prisma, workspaceId, projectId);
  await resolveIssue(prisma, projectId, issueId);

  await prisma.$transaction(async (tx) => {
    await tx.issue.update({
      where: { id: issueId },
      data: { deleted_at: new Date() },
    });
    await recordActivity(tx, {
      workspace_id: workspaceId,
      issue_id: issueId,
      actor_id: actorId,
      action: ACTIVITY_ACTIONS.ISSUE_DELETED,
    });
  });
}

// ─── Assignees ────────────────────────────────────────────────────────────────

export async function addAssignee(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  issueId: string,
  actorId: string,
  userId: string,
): Promise<IssueWithRelations> {
  await resolveProject(prisma, workspaceId, projectId);
  const issue = await resolveIssue(prisma, projectId, issueId);

  const existing = await prisma.issueAssignee.findUnique({
    where: { issue_id_user_id: { issue_id: issueId, user_id: userId } },
  });
  if (existing) throw AppError.conflict('User is already assigned to this issue');

  await prisma.$transaction(async (tx) => {
    // The first assignee of an issue becomes its primary (ответственный) one.
    await tx.issueAssignee.create({
      data: { issue_id: issueId, user_id: userId, is_primary: issue.assignees.length === 0 },
    });
    await addWatchers(tx, issueId, [userId]);
    await recordActivity(tx, {
      workspace_id: workspaceId,
      issue_id: issueId,
      actor_id: actorId,
      action: ACTIVITY_ACTIONS.ISSUE_ASSIGNEE_ADDED,
      field: 'assignee',
      new_value: userId,
    });
    await notify(tx, {
      workspace_id: workspaceId,
      actor_id: actorId,
      type: 'issue_assigned',
      recipient_ids: [userId],
      issue_id: issueId,
    });
  });

  // Best-effort notification to the newly assigned user (outside the transaction):
  // Telegram if linked, else email. The assignment already committed, so a delivery
  // failure is swallowed.
  try {
    await notifyIssueRecipients(prisma, {
      projectId,
      actorId,
      recipientIds: [userId],
      issue,
      assigned: true,
    });
  } catch {
    // Notification delivery is best-effort; the assignment succeeded regardless.
  }

  return resolveIssue(prisma, projectId, issueId);
}

export async function removeAssignee(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  issueId: string,
  actorId: string,
  userId: string,
): Promise<IssueWithRelations> {
  await resolveProject(prisma, workspaceId, projectId);
  await resolveIssue(prisma, projectId, issueId);

  const existing = await prisma.issueAssignee.findUnique({
    where: { issue_id_user_id: { issue_id: issueId, user_id: userId } },
  });
  if (!existing) throw AppError.notFound('Assignee not found on this issue');

  await prisma.$transaction(async (tx) => {
    await tx.issueAssignee.delete({
      where: { issue_id_user_id: { issue_id: issueId, user_id: userId } },
    });
    // Removing the primary assignee hands the role to the longest-standing co-assignee.
    if (existing.is_primary) {
      const next = await tx.issueAssignee.findFirst({
        where: { issue_id: issueId },
        orderBy: { created_at: 'asc' },
      });
      if (next) {
        await tx.issueAssignee.update({
          where: { issue_id_user_id: { issue_id: issueId, user_id: next.user_id } },
          data: { is_primary: true },
        });
      }
    }
    await recordActivity(tx, {
      workspace_id: workspaceId,
      issue_id: issueId,
      actor_id: actorId,
      action: ACTIVITY_ACTIONS.ISSUE_ASSIGNEE_REMOVED,
      field: 'assignee',
      old_value: userId,
    });
  });
  return resolveIssue(prisma, projectId, issueId);
}

// ─── Labels ───────────────────────────────────────────────────────────────────

export async function attachLabel(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  issueId: string,
  actorId: string,
  labelId: string,
): Promise<IssueWithRelations> {
  await resolveProject(prisma, workspaceId, projectId);
  await resolveIssue(prisma, projectId, issueId);

  const label = await prisma.label.findFirst({ where: { id: labelId, project_id: projectId } });
  if (!label) throw AppError.notFound('Label not found in this project');

  const existing = await prisma.issueLabel.findUnique({
    where: { issue_id_label_id: { issue_id: issueId, label_id: labelId } },
  });
  if (existing) throw AppError.conflict('Label is already attached to this issue');

  await prisma.$transaction(async (tx) => {
    await tx.issueLabel.create({ data: { issue_id: issueId, label_id: labelId } });
    await recordActivity(tx, {
      workspace_id: workspaceId,
      issue_id: issueId,
      actor_id: actorId,
      action: ACTIVITY_ACTIONS.ISSUE_LABEL_ADDED,
      field: 'label',
      new_value: labelId,
    });
  });
  return resolveIssue(prisma, projectId, issueId);
}

export async function detachLabel(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  issueId: string,
  actorId: string,
  labelId: string,
): Promise<IssueWithRelations> {
  await resolveProject(prisma, workspaceId, projectId);
  await resolveIssue(prisma, projectId, issueId);

  const existing = await prisma.issueLabel.findUnique({
    where: { issue_id_label_id: { issue_id: issueId, label_id: labelId } },
  });
  if (!existing) throw AppError.notFound('Label is not attached to this issue');

  await prisma.$transaction(async (tx) => {
    await tx.issueLabel.delete({
      where: { issue_id_label_id: { issue_id: issueId, label_id: labelId } },
    });
    await recordActivity(tx, {
      workspace_id: workspaceId,
      issue_id: issueId,
      actor_id: actorId,
      action: ACTIVITY_ACTIONS.ISSUE_LABEL_REMOVED,
      field: 'label',
      old_value: labelId,
    });
  });
  return resolveIssue(prisma, projectId, issueId);
}

// ─── Out-of-band notifications (best-effort) ─────────────────────────────────

/**
 * Recipients for a newly created issue's notifications: the named assignees when the
 * issue has any, otherwise every member of its project — the "task for everyone" case.
 * Returns whether the recipients are assignees so the message copy can differ.
 */
async function issueCreatedRecipients(
  prisma: PrismaClient,
  projectId: string,
  assigneeIds: string[],
): Promise<{ recipientIds: string[]; assigned: boolean }> {
  if (assigneeIds.length > 0) return { recipientIds: assigneeIds, assigned: true };
  const members = await prisma.projectMember.findMany({
    where: { project_id: projectId },
    select: { user_id: true },
  });
  return { recipientIds: members.map((m) => m.user_id), assigned: false };
}

/**
 * Best-effort out-of-band fan-out for a task event, one channel per recipient: a linked
 * Telegram account is messaged through the bot; everyone else falls back to email (when
 * they have an address). Must be called AFTER the mutation's transaction commits — never
 * inside it — because it performs network I/O. The actor is never notified about their own
 * action, recipients are de-duplicated, and every individual send is isolated (allSettled),
 * so a delivery problem can never fail the request or roll back the mutation. This is
 * additive to the in-app `Notification` rows written inside the transaction.
 */
export async function notifyIssueRecipients(
  prisma: PrismaClient,
  params: {
    projectId: string;
    actorId: string;
    recipientIds: string[];
    issue: Pick<Issue, 'id' | 'title' | 'sequence_id' | 'kind'>;
    assigned: boolean;
  },
): Promise<void> {
  const recipients = [...new Set(params.recipientIds)].filter((id) => id !== params.actorId);
  if (recipients.length === 0) return;

  const [project, actor, telegramIdentities] = await Promise.all([
    prisma.project.findUnique({
      where: { id: params.projectId },
      select: { name: true, identifier: true, workspace: { select: { slug: true } } },
    }),
    prisma.user.findUnique({ where: { id: params.actorId }, select: { display_name: true } }),
    // Only resolve Telegram links when the bot is actually configured.
    telegramConfigured()
      ? prisma.authIdentity.findMany({
          where: {
            provider: 'telegram',
            user_id: { in: recipients },
            provider_user_id: { not: null },
          },
          select: { user_id: true, provider_user_id: true },
        })
      : Promise.resolve([] as { user_id: string; provider_user_id: string | null }[]),
  ]);
  if (!project || !actor) return;

  const issueKey = `${project.identifier}-${params.issue.sequence_id}`;
  const link = issueUrl(project.workspace.slug, issueKey);
  const opts = {
    issueKey,
    issueUrl: link,
    issueTitle: params.issue.title,
    projectName: project.name,
    actorName: actor.display_name,
    assigned: params.assigned,
  };

  // Telegram for linked recipients.
  const telegramUserIds = new Set(telegramIdentities.map((i) => i.user_id));
  // «Ознакомлен» right under a new assignment; «Подробнее» opens the card in the bot.
  const buttons = notificationButtons('issue_assigned', params.issue.id, link, {
    acknowledge: params.assigned && params.issue.kind === 'assignment',
  });
  const sends: Promise<unknown>[] = telegramIdentities.map((i) =>
    sendIssueNotification(Number(i.provider_user_id), { ...opts, buttons }),
  );

  // Email fallback for recipients WITHOUT a linked Telegram, when they have an address.
  const emailFallbackIds = recipients.filter((id) => !telegramUserIds.has(id));
  if (emailFallbackIds.length > 0) {
    const emailTargets = await prisma.user.findMany({
      where: { id: { in: emailFallbackIds }, email: { not: null } },
      select: { email: true },
    });
    for (const u of emailTargets) {
      sends.push(sendIssueNotificationEmail({ to: u.email!, ...opts }));
    }
  }

  // allSettled so one failing channel/recipient can't stop the others (it never rejects).
  await Promise.allSettled(sends);
}
