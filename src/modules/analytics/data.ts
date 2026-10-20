// Analytics data layer (Ф10 10.B1, 10.B3, 10.B6): load the workspace's facts in
// a few SQL queries, cache them, and cut them down to what the viewer may see.
//
// Who sees what (10.B3), enforced here for every analytics endpoint and export:
//   - owner / admin — the whole workspace;
//   - head of a department (Department.head_id) — issues of the departments they
//     head and everything below them;
//   - anyone else — only their own indicators: issues where they are the primary
//     assignee.
// Private projects follow the usual visibility rule on top of that.
//
// Cache: facts are kept per workspace and visibility class for
// ANALYTICS_CACHE_TTL seconds, and dropped on any write to the workspace
// (`invalidateAnalytics`, called from an onResponse hook in app.ts), so the
// dashboard is fast and never shows numbers older than the last change.

import type { PrismaClient, StateGroup, WorkspaceMember } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { config } from '../../config/index.js';
import { AppError } from '../../lib/errors.js';
import { addDays, daysBetween, localDate } from '../../lib/tz.js';
import { seesAllProjects } from '../../plugins/workspace-hook.js';
import type { DeadlineFact, IssueFact, Period, ReviewFact } from './metrics.js';
import type { AnalyticsQuery } from './schema.js';

export interface PersonInfo {
  id: string;
  display_name: string;
  last_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  avatar_url: string | null;
  position: string | null;
  department_id: string | null;
}

export interface DepartmentInfo {
  id: string;
  parent_id: string | null;
  name: string;
  short_name: string | null;
  head_id: string | null;
  order: number;
}

export interface ProjectInfo {
  id: string;
  name: string;
  identifier: string;
  icon: string | null;
  color: string | null;
  department_id: string | null;
}

export interface DeadlineRow extends DeadlineFact {
  id: string;
  old_due_date: Date | null;
  new_due_date: Date;
  reason: string;
  requested_by_id: string;
}

interface WorkspaceData {
  facts: IssueFact[];
  deadlines: DeadlineRow[];
  reviews: ReviewFact[];
  departments: DepartmentInfo[];
  projects: ProjectInfo[];
  people: Map<string, PersonInfo>;
}

export interface Scope {
  kind: 'all' | 'departments' | 'self';
  /** Departments the viewer heads (roots of their subtree), for `departments`. */
  department_ids: string[];
}

export interface AnalyticsData extends WorkspaceData {
  timezone: string;
  workspace: { id: string; name: string; short_name: string | null };
  scope: Scope;
  period: Period;
  now: Date;
  /** Every department visible in this scope (subtree ids). */
  visibleDepartmentIds: Set<string> | null;
  childrenOf: Map<string, string[]>;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const generations = new Map<string, number>();
const cache = new Map<string, { expires: number; value: Promise<WorkspaceData> }>();

/** Drop cached facts of a workspace (any write to it). */
export function invalidateAnalytics(workspaceId: string): void {
  generations.set(workspaceId, (generations.get(workspaceId) ?? 0) + 1);
  for (const key of cache.keys()) if (key.startsWith(`${workspaceId}:`)) cache.delete(key);
}

function cached(key: string, load: () => Promise<WorkspaceData>): Promise<WorkspaceData> {
  const ttl = config.ANALYTICS_CACHE_TTL * 1000;
  if (ttl === 0) return load();
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = load();
  cache.set(key, { expires: Date.now() + ttl, value });
  // A failed load must not stay cached.
  value.catch(() => cache.delete(key));
  return value;
}

// ─── Loading ──────────────────────────────────────────────────────────────────

interface FactRow {
  id: string;
  project_id: string;
  sequence_id: number;
  title: string;
  kind: IssueFact['kind'];
  priority: string;
  basis: string | null;
  created_at: Date;
  due_date: Date | null;
  completed_at: Date | null;
  state_group: StateGroup;
  state_name: string;
  controller_id: string | null;
  created_by_id: string;
  assignee_id: string | null;
  assigned_at: Date | null;
  acknowledged_at: Date | null;
  co_assignee_ids: string[] | null;
  department_id: string | null;
}

async function loadWorkspaceData(
  prisma: PrismaClient,
  workspaceId: string,
  viewer: { userId: string; seesAll: boolean },
): Promise<WorkspaceData> {
  // Distribution parents are summaries of their children and are not counted.
  const visibility = viewer.seesAll
    ? Prisma.empty
    : Prisma.sql`AND (p.visibility = 'public' OR EXISTS (
        SELECT 1 FROM "ProjectMember" pm WHERE pm.project_id = p.id AND pm.user_id = ${viewer.userId}))`;
  const facts = await prisma.$queryRaw<FactRow[]>`
    SELECT i.id, i.project_id, i.sequence_id, i.title, i.kind::text AS kind, i.priority::text AS priority,
           i.basis, i.created_at, i.due_date, i.completed_at,
           s."group"::text AS state_group, s.name AS state_name,
           i.controller_id, i.created_by_id,
           pa.user_id AS assignee_id, pa.created_at AS assigned_at, pa.acknowledged_at,
           ARRAY(SELECT a.user_id FROM "IssueAssignee" a
                 WHERE a.issue_id = i.id AND a.user_id IS DISTINCT FROM pa.user_id) AS co_assignee_ids,
           COALESCE(i.department_id, wm.department_id) AS department_id
    FROM "Issue" i
    JOIN "Project" p ON p.id = i.project_id AND p.deleted_at IS NULL
    JOIN "State" s ON s.id = i.state_id
    LEFT JOIN LATERAL (
      SELECT a.user_id, a.created_at, a.acknowledged_at FROM "IssueAssignee" a
      WHERE a.issue_id = i.id ORDER BY a.is_primary DESC, a.created_at ASC LIMIT 1
    ) pa ON true
    LEFT JOIN "WorkspaceMember" wm ON wm.workspace_id = i.workspace_id AND wm.user_id = pa.user_id
    WHERE i.workspace_id = ${workspaceId} AND i.deleted_at IS NULL AND i.is_distribution = false
    ${visibility}`;

  const [deadlines, reviews, departments, projects, members] = await Promise.all([
    prisma.deadlineChangeRequest.findMany({
      where: { workspace_id: workspaceId },
      select: {
        id: true,
        issue_id: true,
        status: true,
        created_at: true,
        decided_at: true,
        old_due_date: true,
        new_due_date: true,
        reason: true,
        requested_by_id: true,
      },
    }),
    prisma.issueReview.findMany({
      where: { workspace_id: workspaceId, decision: { not: 'pending' } },
      select: { issue_id: true, decision: true, decided_at: true },
    }),
    prisma.department.findMany({
      where: { workspace_id: workspaceId },
      select: {
        id: true,
        parent_id: true,
        name: true,
        short_name: true,
        head_id: true,
        order: true,
      },
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
    }),
    prisma.project.findMany({
      where: { workspace_id: workspaceId, deleted_at: null },
      select: {
        id: true,
        name: true,
        identifier: true,
        icon: true,
        color: true,
        department_id: true,
      },
    }),
    prisma.workspaceMember.findMany({
      where: { workspace_id: workspaceId },
      select: {
        position: true,
        department_id: true,
        user: {
          select: {
            id: true,
            display_name: true,
            last_name: true,
            first_name: true,
            middle_name: true,
            avatar_url: true,
          },
        },
      },
    }),
  ]);

  return {
    facts: facts.map((f) => ({ ...f, co_assignee_ids: f.co_assignee_ids ?? [] })),
    deadlines,
    reviews,
    departments,
    projects,
    people: new Map(
      members.map((m) => [
        m.user.id,
        { ...m.user, position: m.position, department_id: m.department_id },
      ]),
    ),
  };
}

// ─── Scope and filters ────────────────────────────────────────────────────────

export function treeIndex(
  departments: Pick<DepartmentInfo, 'id' | 'parent_id'>[],
): Map<string, string[]> {
  const childrenOf = new Map<string, string[]>();
  for (const d of departments) {
    if (d.parent_id) childrenOf.set(d.parent_id, [...(childrenOf.get(d.parent_id) ?? []), d.id]);
  }
  return childrenOf;
}

export function subtree(roots: string[], childrenOf: Map<string, string[]>): Set<string> {
  const result = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    stack.push(...(childrenOf.get(id) ?? []));
  }
  return result;
}

/** The viewer's analytics scope (10.B3). */
export function resolveScope(member: WorkspaceMember, departments: DepartmentInfo[]): Scope {
  if (seesAllProjects(member)) return { kind: 'all', department_ids: [] };
  const headed = departments.filter((d) => d.head_id === member.user_id).map((d) => d.id);
  if (headed.length > 0) return { kind: 'departments', department_ids: headed };
  return { kind: 'self', department_ids: [] };
}

const MAX_PERIOD_DAYS = 3 * 366;

/** Period from the query (local dates); defaults to the last 30 days including today. */
export function resolvePeriod(
  query: Pick<AnalyticsQuery, 'from' | 'to'>,
  tz: string,
  now: Date,
): Period {
  const to = query.to ?? localDate(now, tz);
  const from = query.from ?? addDays(to, -29);
  if (from > to) throw AppError.badRequest('`from` must not be after `to`');
  if (daysBetween(from, to) > MAX_PERIOD_DAYS)
    throw AppError.badRequest('The period is limited to 3 years');
  return { from, to };
}

const asList = (v: string | string[] | undefined): string[] | undefined =>
  v === undefined ? undefined : Array.isArray(v) ? v : [v];

/**
 * Load (or reuse) the facts and keep only what the viewer may see and the
 * filters ask for: department (with subtree), project, kind, controller.
 */
export async function analyticsData(
  prisma: PrismaClient,
  workspace: { id: string; name: string; short_name: string | null; timezone: string },
  member: WorkspaceMember,
  query: AnalyticsQuery,
  now: Date = new Date(),
): Promise<AnalyticsData> {
  const seesAll = seesAllProjects(member);
  const key = `${workspace.id}:${generations.get(workspace.id) ?? 0}:${seesAll ? '*' : member.user_id}`;
  const data = await cached(key, () =>
    loadWorkspaceData(prisma, workspace.id, { userId: member.user_id, seesAll }),
  );
  const period = resolvePeriod(query, workspace.timezone, now);
  const scope = resolveScope(member, data.departments);
  const childrenOf = treeIndex(data.departments);
  const known = new Set(data.departments.map((d) => d.id));

  let visibleDepartmentIds: Set<string> | null = null;
  if (scope.kind === 'departments')
    visibleDepartmentIds = subtree(scope.department_ids, childrenOf);

  const requested = asList(query.department);
  let departmentFilter: Set<string> | null = null;
  if (requested) {
    for (const id of requested) {
      if (!known.has(id)) throw AppError.badRequest('Unknown department');
      if (visibleDepartmentIds && !visibleDepartmentIds.has(id)) {
        throw AppError.forbidden('This department is outside your area of responsibility');
      }
    }
    departmentFilter = subtree(requested, childrenOf);
  }
  const projects = asList(query.project);
  const controller = query.controller === 'me' ? member.user_id : query.controller;

  const keep = (f: IssueFact): boolean => {
    if (scope.kind === 'self' && f.assignee_id !== member.user_id) return false;
    if (visibleDepartmentIds && (!f.department_id || !visibleDepartmentIds.has(f.department_id)))
      return false;
    if (departmentFilter && (!f.department_id || !departmentFilter.has(f.department_id)))
      return false;
    if (projects && !projects.includes(f.project_id)) return false;
    if (query.kind && f.kind !== query.kind) return false;
    if (controller && (f.controller_id ?? f.created_by_id) !== controller) return false;
    return true;
  };
  const facts = data.facts.filter(keep);
  const ids = new Set(facts.map((f) => f.id));

  return {
    ...data,
    facts,
    deadlines: data.deadlines.filter((d) => ids.has(d.issue_id)),
    reviews: data.reviews.filter((r) => ids.has(r.issue_id)),
    timezone: workspace.timezone,
    workspace: { id: workspace.id, name: workspace.name, short_name: workspace.short_name },
    scope,
    period,
    now,
    visibleDepartmentIds,
    childrenOf,
  };
}
