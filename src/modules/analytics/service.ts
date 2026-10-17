// Analytics endpoints (Ф10 10.B1): each one turns the scoped facts from data.ts
// into a response with the formulas in metrics.ts. Nothing here computes a
// metric on its own.

import type { AnalyticsData, DepartmentInfo, PersonInfo, ProjectInfo } from './data.js';
import { subtree } from './data.js';
import {
  buckets,
  counters,
  daysOverdue,
  inPeriod,
  isOpen,
  localDate,
  median,
  overdueAt,
  previousPeriod,
  snapshotAt,
  type Counters,
  type IssueFact,
} from './metrics.js';
import { daysBetween } from '../../lib/tz.js';

const base = (d: AnalyticsData) => ({ period: d.period, scope: d.scope });

/** Append to a list in a map (no copying: groups can hold thousands of facts). */
function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const countersOf = (d: AnalyticsData, facts: IssueFact[], period = d.period): Counters =>
  counters({
    facts,
    deadlines: d.deadlines,
    reviews: d.reviews,
    period,
    tz: d.timezone,
    now: d.now,
  });

type PersonBrief = Omit<PersonInfo, 'department_id' | 'position'> & { position: string | null };

function person(d: AnalyticsData, id: string | null): PersonBrief | null {
  const p = id ? d.people.get(id) : undefined;
  if (!p) return null;
  const { department_id: _department, ...brief } = p;
  return brief;
}

const departmentBrief = (d: DepartmentInfo | undefined) =>
  d ? { id: d.id, name: d.name, short_name: d.short_name } : null;

const projectBrief = (p: ProjectInfo | undefined) =>
  p ? { id: p.id, name: p.name, identifier: p.identifier, icon: p.icon, color: p.color } : null;

// ─── Summary ──────────────────────────────────────────────────────────────────

export function summary(d: AnalyticsData) {
  const previous = previousPeriod(d.period);
  return {
    ...base(d),
    previous_period: previous,
    current: countersOf(d, d.facts),
    previous: countersOf(d, d.facts, previous),
  };
}

// ─── By department ────────────────────────────────────────────────────────────

export interface DepartmentNode {
  id: string;
  name: string;
  short_name: string | null;
  head: PersonBrief | null;
  /** Work of this department itself. */
  own: Counters;
  /** Together with every sub-department. */
  total: Counters;
  children: DepartmentNode[];
}

const isEmpty = (c: Counters) => c.created + c.completed + c.open === 0;

export function byDepartment(d: AnalyticsData) {
  const byId = new Map(d.departments.map((x) => [x.id, x]));
  const factsOf = new Map<string, IssueFact[]>();
  for (const f of d.facts) {
    if (!f.department_id) continue;
    push(factsOf, f.department_id, f);
  }

  const build = (id: string): DepartmentNode => {
    const dept = byId.get(id)!;
    const ids = subtree([id], d.childrenOf);
    const facts = [...ids].flatMap((x) => factsOf.get(x) ?? []);
    const children = (d.childrenOf.get(id) ?? [])
      .map(build)
      .filter((n) => d.scope.kind !== 'self' || !isEmpty(n.total));
    return {
      id,
      name: dept.name,
      short_name: dept.short_name,
      head: person(d, dept.head_id),
      own: countersOf(d, factsOf.get(id) ?? []),
      total: countersOf(d, facts),
      children,
    };
  };

  // Roots: the headed departments for a head, the top of the tree otherwise.
  const roots =
    d.scope.kind === 'departments'
      ? d.scope.department_ids.filter(
          // A head of both a faculty and its chair sees the chair inside the faculty.
          (id) =>
            !d.scope.department_ids.some(
              (other) => other !== id && subtree([other], d.childrenOf).has(id),
            ),
        )
      : d.departments.filter((x) => !x.parent_id || !byId.has(x.parent_id)).map((x) => x.id);
  const tree = roots.map(build).filter((n) => d.scope.kind !== 'self' || !isEmpty(n.total));
  const orphans = d.facts.filter((f) => !f.department_id);
  return {
    ...base(d),
    tree,
    unassigned: d.scope.kind === 'all' && orphans.length > 0 ? countersOf(d, orphans) : null,
  };
}

// ─── By assignee ──────────────────────────────────────────────────────────────

export function byAssignee(d: AnalyticsData) {
  const at = snapshotAt(d.period, d.timezone, d.now);
  const primary = new Map<string, IssueFact[]>();
  const coOpen = new Map<string, number>();
  for (const f of d.facts) {
    if (f.assignee_id) push(primary, f.assignee_id, f);
    if (isOpen(f)) for (const id of f.co_assignee_ids) coOpen.set(id, (coOpen.get(id) ?? 0) + 1);
  }
  const ids = new Set([...primary.keys(), ...coOpen.keys()]);
  const byDept = new Map(d.departments.map((x) => [x.id, x]));
  const items = [...ids]
    .map((id) => {
      const info = d.people.get(id);
      const c = countersOf(d, primary.get(id) ?? []);
      return {
        user: person(d, id),
        department: departmentBrief(
          info?.department_id ? byDept.get(info.department_id) : undefined,
        ),
        open_primary: c.open,
        open_co: coOpen.get(id) ?? 0,
        overdue: (primary.get(id) ?? []).filter((f) => overdueAt(f, at, d.timezone)).length,
        completed: c.completed,
        on_time: c.on_time,
        late: c.late,
        discipline: c.discipline,
      };
    })
    .filter((x) => x.user !== null)
    .sort(
      (a, b) => b.open_primary + b.open_co - (a.open_primary + a.open_co) || b.overdue - a.overdue,
    );
  return { ...base(d), items };
}

// ─── By project ───────────────────────────────────────────────────────────────

export function byProject(d: AnalyticsData) {
  const groups = new Map<string, IssueFact[]>();
  for (const f of d.facts) push(groups, f.project_id, f);
  const projects = new Map(d.projects.map((p) => [p.id, p]));
  const items = [...groups.entries()]
    .map(([id, facts]) => {
      const live = facts.filter((f) => f.state_group !== 'cancelled');
      const done = live.filter((f) => f.state_group === 'completed').length;
      return {
        project: projectBrief(projects.get(id)),
        total: live.length,
        done,
        progress: live.length === 0 ? 0 : Math.round((done / live.length) * 100),
        ...countersOf(d, facts),
      };
    })
    .filter((x) => x.project !== null)
    .sort((a, b) => b.open - a.open);
  return { ...base(d), items };
}

// ─── Trends ───────────────────────────────────────────────────────────────────

export function trends(d: AnalyticsData, bucket?: 'week' | 'month') {
  const size = bucket ?? (daysBetween(d.period.from, d.period.to) > 92 ? 'month' : 'week');
  const items = buckets(d.period, size).map((b) => {
    const c = countersOf(d, d.facts, { from: b.from, to: b.to });
    return {
      key: b.key,
      from: b.from,
      to: b.to,
      created: c.created,
      completed: c.completed,
      on_time: c.on_time,
      late: c.late,
      discipline: c.discipline,
      overdue: c.overdue,
      deadline_changes: c.deadline_changes,
      returns: c.returns,
    };
  });
  return { ...base(d), bucket: size, items };
}

// ─── Overdue ──────────────────────────────────────────────────────────────────

export function overdueItems(d: AnalyticsData) {
  const at = snapshotAt(d.period, d.timezone, d.now);
  const projects = new Map(d.projects.map((p) => [p.id, p]));
  const departments = new Map(d.departments.map((x) => [x.id, x]));
  const moves = new Map<string, number>();
  for (const r of d.deadlines) {
    if (r.status === 'approved') moves.set(r.issue_id, (moves.get(r.issue_id) ?? 0) + 1);
  }
  return d.facts
    .filter((f) => overdueAt(f, at, d.timezone))
    .map((f) => {
      const project = projects.get(f.project_id);
      return {
        id: f.id,
        key: project ? `${project.identifier}-${f.sequence_id}` : String(f.sequence_id),
        title: f.title,
        kind: f.kind,
        basis: f.basis,
        state_name: f.state_name,
        state_group: f.state_group,
        due_date: f.due_date,
        days_overdue: daysOverdue(f, at, d.timezone),
        deadline_changes: moves.get(f.id) ?? 0,
        project: projectBrief(project),
        department: departmentBrief(f.department_id ? departments.get(f.department_id) : undefined),
        assignee: person(d, f.assignee_id),
        controller: person(d, f.controller_id ?? f.created_by_id),
      };
    })
    .sort((a, b) => b.days_overdue - a.days_overdue || a.key.localeCompare(b.key));
}

export function overdue(d: AnalyticsData, limit: number) {
  const all = overdueItems(d);
  return { ...base(d), total: all.length, items: all.slice(0, limit) };
}

// ─── Deadline changes and returns ─────────────────────────────────────────────

export function deadlineChanges(d: AnalyticsData, limit: number) {
  const tz = d.timezone;
  const decidedIn = (x: Date | null) => x !== null && inPeriod(localDate(x, tz), d.period);
  const facts = new Map(d.facts.map((f) => [f.id, f]));
  const projects = new Map(d.projects.map((p) => [p.id, p]));
  const approved = d.deadlines
    .filter((r) => r.status === 'approved' && decidedIn(r.decided_at))
    .sort((a, b) => b.decided_at!.getTime() - a.decided_at!.getTime());
  return {
    ...base(d),
    approved: approved.length,
    rejected: d.deadlines.filter((r) => r.status === 'rejected' && decidedIn(r.decided_at)).length,
    pending: d.deadlines.filter((r) => r.status === 'pending').length,
    returns: d.reviews.filter((r) => r.decision === 'returned' && decidedIn(r.decided_at)).length,
    items: approved.slice(0, limit).map((r) => {
      const f = facts.get(r.issue_id)!;
      const project = projects.get(f.project_id);
      return {
        id: r.id,
        issue_id: f.id,
        key: project ? `${project.identifier}-${f.sequence_id}` : String(f.sequence_id),
        title: f.title,
        project: projectBrief(project),
        old_due_date: r.old_due_date,
        new_due_date: r.new_due_date,
        shift_days:
          r.old_due_date === null
            ? null
            : daysBetween(localDate(r.old_due_date, tz), localDate(r.new_due_date, tz)),
        reason: r.reason,
        requested_by: person(d, r.requested_by_id),
        decided_at: r.decided_at,
      };
    }),
  };
}

// ─── Reaction time ────────────────────────────────────────────────────────────

function reactionHours(d: AnalyticsData, facts: IssueFact[]): number[] {
  return facts
    .filter(
      (f) => f.acknowledged_at && inPeriod(localDate(f.acknowledged_at, d.timezone), d.period),
    )
    .map(
      (f) =>
        Math.max(0, f.acknowledged_at!.getTime() - (f.assigned_at ?? f.created_at).getTime()) /
        3_600_000,
    );
}

const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);

export function reactionTime(d: AnalyticsData) {
  const all = reactionHours(d, d.facts);
  const c = countersOf(d, d.facts);
  const visible = d.departments.filter(
    (x) => !d.visibleDepartmentIds || d.visibleDepartmentIds.has(x.id),
  );
  const by_department = visible
    .map((x) => {
      const ids = subtree([x.id], d.childrenOf);
      const hours = reactionHours(
        d,
        d.facts.filter((f) => f.department_id && ids.has(f.department_id)),
      );
      return {
        department: departmentBrief(x),
        parent_id: x.parent_id,
        median_hours: round1(median(hours)),
        acknowledged: hours.length,
      };
    })
    .filter((x) => x.acknowledged > 0);
  return {
    ...base(d),
    median_hours: round1(median(all)),
    acknowledged: all.length,
    unacknowledged: c.unacknowledged,
    by_department,
  };
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

/**
 * The compact dashboard of the home page (10.F3) in one request: KPI with the
 * previous period, the department rating one level below the top of the
 * viewer's area, the worst overdue work and the weekly trend.
 */
export function dashboard(d: AnalyticsData, limit: number) {
  const { tree } = byDepartment(d);
  // Ректорат → проректораты и отделы: a single root is rated by its children.
  const level = tree.length === 1 && tree[0]!.children.length > 0 ? tree[0]!.children : tree;
  const top = overdue(d, limit);
  return {
    ...summary(d),
    departments: level
      .filter((n) => !isEmpty(n.total))
      .map((n) => ({
        id: n.id,
        name: n.name,
        short_name: n.short_name,
        has_children: n.children.length > 0,
        total: n.total,
      })),
    overdue: { total: top.total, items: top.items },
    trend: trends(d, 'week').items,
  };
}
