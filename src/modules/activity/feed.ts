// The workspace activity feed (Ф7 7.B3): who did what across all projects,
// newest first — for admins (everything they can see) and department heads (the
// work of their department with its subtree, the same scope as analytics 10.B3).
// Anyone else gets 403: the feed is a management tool, a member has the history
// of each task in its card.
//
// Rows come from the same ActivityLog as an issue's history. A row about a task
// in the trash stays in the feed (marked `deleted_at`), so «кто удалил» is seen.
// Ids in old/new values (state, person, label, cycle, module, another issue) are
// resolved to names here: the feed spans projects the client has not loaded.

import { z } from 'zod';
import type { Prisma, PrismaClient, Workspace, WorkspaceMember } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { addDays, startOfLocalDay } from '../../lib/tz.js';
import { seesAllProjects } from '../../plugins/workspace-hook.js';
import { inDepartmentsWhere, visibleIssuesWhere } from '../issues/scope.js';
import { subtree, treeIndex } from '../analytics/data.js';

/** Kinds of events the feed filters by (`?type=`, several = any of them). */
export const FEED_TYPES = [
  'created',
  'state',
  'review',
  'deadline',
  'people',
  'comments',
  'files',
  'checklist',
  'trash',
  // Cycles, modules, sub-issues and relations (4.F3–4.F7).
  'structure',
] as const;
export type FeedType = (typeof FEED_TYPES)[number];

const TYPE_WHERE: Record<FeedType, Prisma.ActivityLogWhereInput> = {
  created: { action: 'issue.created' },
  state: { action: 'issue.updated', field: 'state_id' },
  review: {
    action: {
      in: [
        'issue.review_submitted',
        'issue.review_approved',
        'issue.review_returned',
        'issue.acknowledged',
      ],
    },
  },
  deadline: {
    OR: [
      {
        action: {
          in: ['issue.deadline_requested', 'issue.deadline_approved', 'issue.deadline_rejected'],
        },
      },
      { action: 'issue.updated', field: { in: ['due_date', 'start_date'] } },
    ],
  },
  people: {
    OR: [
      { action: { in: ['issue.assignee_added', 'issue.assignee_removed'] } },
      { action: 'issue.updated', field: 'controller_id' },
    ],
  },
  comments: { action: { startsWith: 'comment.' } },
  files: { action: { in: ['issue.attachment_added', 'issue.attachment_removed'] } },
  checklist: { action: { startsWith: 'issue.checklist_' } },
  trash: { action: { in: ['issue.deleted', 'issue.restored'] } },
  structure: {
    OR: [
      { action: 'issue.updated', field: { in: ['cycle_id', 'parent_id'] } },
      {
        action: {
          in: [
            'issue.module_added',
            'issue.module_removed',
            'issue.relation_added',
            'issue.relation_removed',
          ],
        },
      },
    ],
  },
};

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date like 2026-10-31');
const ids = z
  .union([z.string().uuid(), z.array(z.string().uuid())])
  .transform((v) => (Array.isArray(v) ? v : [v]));

export const FeedQuerySchema = z.object({
  type: z
    .union([z.enum(FEED_TYPES), z.array(z.enum(FEED_TYPES))])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
  project: ids.optional(),
  /** A department includes its sub-departments. */
  department: ids.optional(),
  actor: z.string().uuid().optional(),
  /** Local dates in the workspace time zone, both inclusive. */
  from: localDate.optional(),
  to: localDate.optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type FeedQuery = z.infer<typeof FeedQuerySchema>;

const PERSON = { id: true, display_name: true, avatar_url: true } as const;

const INCLUDE = {
  actor: { select: PERSON },
  issue: {
    select: {
      id: true,
      sequence_id: true,
      title: true,
      kind: true,
      deleted_at: true,
      project: { select: { id: true, name: true, identifier: true, icon: true, color: true } },
    },
  },
} as const;

type Row = Prisma.ActivityLogGetPayload<{ include: typeof INCLUDE }>;
export type FeedItem = Row & { old_label: string | null; new_label: string | null };

type RefKind = 'state' | 'person' | 'label' | 'cycle' | 'module' | 'issue';

/** Which of old/new value holds an id of what. */
function refKind(row: { action: string; field: string | null }): RefKind | null {
  if (row.action === 'issue.updated' && row.field === 'state_id') return 'state';
  if (row.action === 'issue.updated' && row.field === 'controller_id') return 'person';
  if (row.action === 'issue.updated' && row.field === 'cycle_id') return 'cycle';
  if (row.action === 'issue.updated' && row.field === 'parent_id') return 'issue';
  if (row.action === 'issue.assignee_added' || row.action === 'issue.assignee_removed')
    return 'person';
  if (row.action === 'issue.label_added' || row.action === 'issue.label_removed') return 'label';
  if (row.action === 'issue.module_added' || row.action === 'issue.module_removed') return 'module';
  if (row.action === 'issue.relation_added' || row.action === 'issue.relation_removed')
    return 'issue';
  return null;
}

/**
 * Old and new values that are ids → their names, one query per kind. Another
 * issue (a relation, a parent) is named «ABC-12 Название» only when the viewer
 * can see it; otherwise its label stays null.
 */
async function resolveLabels(
  prisma: PrismaClient,
  rows: Row[],
  workspaceId: string,
  viewer: WorkspaceMember,
): Promise<FeedItem[]> {
  const wanted: Record<RefKind, Set<string>> = {
    state: new Set(),
    person: new Set(),
    label: new Set(),
    cycle: new Set(),
    module: new Set(),
    issue: new Set(),
  };
  for (const row of rows) {
    const kind = refKind(row);
    if (!kind) continue;
    for (const v of [row.old_value, row.new_value]) if (v) wanted[kind].add(v);
  }
  const [states, people, labels, cycles, modules, issues] = await Promise.all([
    wanted.state.size
      ? prisma.state.findMany({
          where: { id: { in: [...wanted.state] } },
          select: { id: true, name: true },
        })
      : [],
    wanted.person.size
      ? prisma.user.findMany({
          where: { id: { in: [...wanted.person] } },
          select: { id: true, display_name: true },
        })
      : [],
    wanted.label.size
      ? prisma.label.findMany({
          where: { id: { in: [...wanted.label] } },
          select: { id: true, name: true },
        })
      : [],
    wanted.cycle.size
      ? prisma.cycle.findMany({
          where: { id: { in: [...wanted.cycle] } },
          select: { id: true, name: true },
        })
      : [],
    wanted.module.size
      ? prisma.module.findMany({
          where: { id: { in: [...wanted.module] } },
          select: { id: true, name: true },
        })
      : [],
    wanted.issue.size
      ? prisma.issue.findMany({
          where: {
            id: { in: [...wanted.issue] },
            ...visibleIssuesWhere(workspaceId, viewer),
            deleted_at: undefined,
          },
          select: {
            id: true,
            sequence_id: true,
            title: true,
            project: { select: { identifier: true } },
          },
        })
      : [],
  ]);
  const names: Record<RefKind, Map<string, string>> = {
    state: new Map(states.map((s) => [s.id, s.name])),
    person: new Map(people.map((p) => [p.id, p.display_name])),
    label: new Map(labels.map((l) => [l.id, l.name])),
    cycle: new Map(cycles.map((c) => [c.id, c.name])),
    module: new Map(modules.map((m) => [m.id, m.name])),
    issue: new Map(
      issues.map((i) => [i.id, `${i.project.identifier}-${i.sequence_id} ${i.title}`]),
    ),
  };
  return rows.map((row) => {
    const kind = refKind(row);
    const name = (v: string | null) => (kind && v ? (names[kind].get(v) ?? null) : null);
    return { ...row, old_label: name(row.old_value), new_label: name(row.new_value) };
  });
}

export async function listWorkspaceActivity(
  prisma: PrismaClient,
  workspace: Pick<Workspace, 'id' | 'timezone'>,
  member: WorkspaceMember,
  query: FeedQuery,
): Promise<{ data: FeedItem[]; next_cursor: string | null }> {
  if (query.from && query.to && query.from > query.to) {
    throw AppError.badRequest('`from` must not be after `to`');
  }

  // Scope: an admin sees every project they can open; a department head — the
  // work of the departments they head, with sub-departments.
  const departments = await prisma.department.findMany({
    where: { workspace_id: workspace.id },
    select: { id: true, parent_id: true, head_id: true },
  });
  const childrenOf = treeIndex(departments);
  let scope: Set<string> | null = null;
  if (!seesAllProjects(member)) {
    const headed = departments.filter((d) => d.head_id === member.user_id).map((d) => d.id);
    if (headed.length === 0) {
      throw new AppError(
        403,
        'ACTIVITY_FORBIDDEN',
        'The workspace feed is for admins and department heads',
      );
    }
    scope = subtree(headed, childrenOf);
  }
  let inDepartments = scope ? [...scope] : null;
  if (query.department) {
    const asked = subtree(query.department, childrenOf);
    inDepartments = [...asked].filter((id) => !scope || scope.has(id));
  }

  const issue: Prisma.IssueWhereInput = {
    // Rows about trashed tasks stay: who deleted what is part of the picture.
    ...visibleIssuesWhere(workspace.id, member),
    deleted_at: undefined,
    ...(query.project && { project_id: { in: query.project } }),
    ...(inDepartments && { AND: [inDepartmentsWhere(workspace.id, inDepartments)] }),
  };
  const tz = workspace.timezone;
  const where: Prisma.ActivityLogWhereInput = {
    workspace_id: workspace.id,
    issue,
    ...(query.actor && { actor_id: query.actor }),
    ...((query.from || query.to) && {
      created_at: {
        ...(query.from && { gte: startOfLocalDay(query.from, tz) }),
        ...(query.to && { lt: startOfLocalDay(addDays(query.to, 1), tz) }),
      },
    }),
    ...(query.type && { OR: query.type.map((t) => TYPE_WHERE[t]) }),
  };

  const rows = await prisma.activityLog.findMany({
    where,
    include: INCLUDE,
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
  });
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  return {
    data: await resolveLabels(prisma, page, workspace.id, member),
    next_cursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}
