// Burndown and burnup of a cycle or a module (Ф10 10.B7, ADR-032), by day in the
// workspace zone (ADR-012). Nothing extra is stored: the scope at the end of
// every day and whether each issue was done are rebuilt from the issue history —
// joining and leaving the cycle or module (ADR-031) and state changes. So the
// chart is right for cycles that started before it existed.
//
// Done = a state of the "completed" or "cancelled" group, as in the progress of a
// cycle (lib/progress.ts). Issues in the trash are left out, like there.

import type { PrismaClient, StateGroup } from '@prisma/client';
import { ACTIVITY_ACTIONS } from './activity.js';
import { addDays, daysBetween, localDate, startOfLocalDay } from './tz.js';

export type BurndownKind = 'cycle' | 'module';

export interface BurndownDay {
  date: string;
  /** Issues in the cycle or module at the end of the day; null after today. */
  scope: number | null;
  done: number | null;
  remaining: number | null;
  /** Straight line from the first day's scope to zero on the last day; null without both dates. */
  ideal: number | null;
}

export interface Burndown {
  kind: BurndownKind;
  id: string;
  name: string;
  /** First and last day of the chart (local dates, inclusive). */
  from: string;
  to: string;
  today: string;
  /** Both dates are set, so the ideal line is drawn. */
  has_ideal: boolean;
  current: { scope: number; done: number; remaining: number; completion_percentage: number };
  days: BurndownDay[];
}

/** A longer cycle is cut to its last year. */
const MAX_DAYS = 366;
const DONE: ReadonlySet<StateGroup> = new Set(['completed', 'cancelled']);

/** What the computation needs about one issue. */
export interface IssueHistory {
  created_at: Date;
  /** In the cycle or module now. */
  member: boolean;
  /** When it joined, if known without history (a module link's creation). */
  member_since?: Date | null;
  state_id: string;
  /** Joining (true) and leaving (false), oldest first. */
  membership: { at: Date; joined: boolean }[];
  /** State changes, oldest first. */
  states: { at: Date; from: string | null; to: string | null }[];
}

/** Periods the issue was in the cycle or module, as [start, end) in ms. */
function intervals(h: IssueHistory): [number, number][] {
  const out: [number, number][] = [];
  const born = h.created_at.getTime();
  if (h.membership.length === 0) {
    if (h.member) out.push([Math.max(born, h.member_since?.getTime() ?? born), Infinity]);
    return out;
  }
  // Before its first event the issue was in the scope if that event is leaving it.
  let inside = !h.membership[0]!.joined;
  let since = born;
  for (const e of h.membership) {
    const at = e.at.getTime();
    if (e.joined && !inside) since = at;
    if (!e.joined && inside) out.push([since, at]);
    inside = e.joined;
  }
  if (inside) out.push([since, Infinity]);
  // A history that disagrees with today (a record lost) trusts today from the last event.
  else if (h.member) out.push([h.membership.at(-1)!.at.getTime(), Infinity]);
  return out;
}

function stateAt(h: IssueHistory, at: number): string | null {
  let state: string | null = h.states.length > 0 ? h.states[0]!.from : h.state_id;
  for (const s of h.states) {
    if (s.at.getTime() > at) break;
    state = s.to;
  }
  return state;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The chart's days from the issues' histories. `start`/`end` are the cycle's
 * dates (a module's start and target dates); `createdAt` — of the cycle itself.
 */
export function computeBurndown(input: {
  kind: BurndownKind;
  id: string;
  name: string;
  start: Date | null;
  end: Date | null;
  createdAt: Date;
  issues: IssueHistory[];
  groupOf: Map<string, StateGroup>;
  timeZone: string;
  now: Date;
}): Burndown {
  const tz = input.timeZone;
  const today = localDate(input.now, tz);
  let from = localDate(input.start ?? input.createdAt, tz);
  let to = input.end ? localDate(input.end, tz) : today;
  if (to < from) to = from;
  if (daysBetween(from, to) >= MAX_DAYS) from = addDays(to, -(MAX_DAYS - 1));

  const isDone = (state: string | null) => {
    const group = state ? input.groupOf.get(state) : undefined;
    return group !== undefined && DONE.has(group);
  };
  const prepared = input.issues.map((h) => ({ h, spans: intervals(h) }));

  const count = (at: number) => {
    let scope = 0;
    let done = 0;
    for (const { h, spans } of prepared) {
      if (h.created_at.getTime() > at) continue;
      if (!spans.some(([a, b]) => a <= at && at < b)) continue;
      scope += 1;
      if (isDone(stateAt(h, at))) done += 1;
    }
    return { scope, done };
  };

  const length = daysBetween(from, to) + 1;
  const days: BurndownDay[] = [];
  for (let i = 0; i < length; i += 1) {
    const date = addDays(from, i);
    if (date > today) {
      days.push({ date, scope: null, done: null, remaining: null, ideal: null });
      continue;
    }
    // The end of that day; today — the current moment.
    const at =
      date === today ? input.now.getTime() : startOfLocalDay(addDays(date, 1), tz).getTime() - 1;
    const { scope, done } = count(at);
    days.push({ date, scope, done, remaining: scope - done, ideal: null });
  }

  const current = (() => {
    let scope = 0;
    let done = 0;
    for (const h of input.issues) {
      if (!h.member) continue;
      scope += 1;
      if (isDone(h.state_id)) done += 1;
    }
    return {
      scope,
      done,
      remaining: scope - done,
      completion_percentage: scope === 0 ? 0 : Math.round((done / scope) * 100),
    };
  })();

  const hasIdeal = input.start !== null && input.end !== null;
  if (hasIdeal) {
    // An upcoming cycle starts from what it holds now.
    const first = days[0]!.scope ?? current.scope;
    for (let i = 0; i < days.length; i += 1) {
      days[i]!.ideal = length === 1 ? 0 : round1((first * (length - 1 - i)) / (length - 1));
    }
  }

  return {
    kind: input.kind,
    id: input.id,
    name: input.name,
    from,
    to,
    today,
    has_ideal: hasIdeal,
    current,
    days,
  };
}

// ─── Loading ──────────────────────────────────────────────────────────────────

interface Target {
  kind: BurndownKind;
  id: string;
  name: string;
  project_id: string;
  workspace_id: string;
  start: Date | null;
  end: Date | null;
  created_at: Date;
}

/** Load the issues and their history for a cycle or a module, then compute. */
export async function loadBurndown(
  prisma: PrismaClient,
  target: Target,
  now = new Date(),
): Promise<Burndown> {
  const isCycle = target.kind === 'cycle';
  // Membership events of this cycle or module.
  const membershipWhere = isCycle
    ? {
        action: ACTIVITY_ACTIONS.ISSUE_UPDATED,
        field: 'cycle_id',
        OR: [{ old_value: target.id }, { new_value: target.id }],
      }
    : {
        OR: [
          { action: ACTIVITY_ACTIONS.MODULE_ADDED, new_value: target.id },
          { action: ACTIVITY_ACTIONS.MODULE_REMOVED, old_value: target.id },
        ],
      };

  const [workspace, events, links] = await Promise.all([
    prisma.workspace.findUniqueOrThrow({
      where: { id: target.workspace_id },
      select: { timezone: true },
    }),
    prisma.activityLog.findMany({
      where: { workspace_id: target.workspace_id, issue_id: { not: null }, ...membershipWhere },
      select: { issue_id: true, created_at: true, old_value: true, new_value: true },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    }),
    isCycle
      ? Promise.resolve([] as { issue_id: string; created_at: Date }[])
      : prisma.moduleIssue.findMany({
          where: { module_id: target.id },
          select: { issue_id: true, created_at: true },
        }),
  ]);

  const linked = new Map(links.map((l) => [l.issue_id, l.created_at]));
  const ids = new Set<string>([...events.map((e) => e.issue_id!), ...linked.keys()]);
  const issues = await prisma.issue.findMany({
    where: {
      project_id: target.project_id,
      deleted_at: null,
      OR: [{ id: { in: [...ids] } }, ...(isCycle ? [{ cycle_id: target.id }] : [])],
    },
    select: { id: true, created_at: true, state_id: true, cycle_id: true },
  });
  const issueIds = issues.map((i) => i.id);

  const [stateEvents, states] = await Promise.all([
    issueIds.length === 0
      ? Promise.resolve([])
      : prisma.activityLog.findMany({
          where: {
            issue_id: { in: issueIds },
            action: ACTIVITY_ACTIONS.ISSUE_UPDATED,
            field: 'state_id',
          },
          select: { issue_id: true, created_at: true, old_value: true, new_value: true },
          orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        }),
    prisma.state.findMany({
      where: { project_id: target.project_id },
      select: { id: true, group: true },
    }),
  ]);

  const byIssue = <T extends { issue_id: string | null }>(rows: T[]) => {
    const map = new Map<string, T[]>();
    for (const r of rows) {
      const list = map.get(r.issue_id!);
      if (list) list.push(r);
      else map.set(r.issue_id!, [r]);
    }
    return map;
  };
  const membershipOf = byIssue(events);
  const statesOf = byIssue(stateEvents);

  return computeBurndown({
    kind: target.kind,
    id: target.id,
    name: target.name,
    start: target.start,
    end: target.end,
    createdAt: target.created_at,
    timeZone: workspace.timezone,
    now,
    groupOf: new Map(states.map((s) => [s.id, s.group])),
    issues: issues.map((i) => ({
      created_at: i.created_at,
      member: isCycle ? i.cycle_id === target.id : linked.has(i.id),
      member_since: linked.get(i.id) ?? null,
      state_id: i.state_id,
      membership: (membershipOf.get(i.id) ?? []).map((e) => ({
        at: e.created_at,
        // Joining puts this id into new_value: a move into the cycle, module_added.
        joined: e.new_value === target.id,
      })),
      states: (statesOf.get(i.id) ?? []).map((e) => ({
        at: e.created_at,
        from: e.old_value,
        to: e.new_value,
      })),
    })),
  });
}

/** Response schema of `GET P/cycles/:id/burndown` and `GET P/modules/:id/burndown`. */
export const BURNDOWN_SHAPE = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['cycle', 'module'] },
    id: { type: 'string' },
    name: { type: 'string' },
    from: { type: 'string', description: 'First day, local date YYYY-MM-DD' },
    to: { type: 'string', description: 'Last day (the end date, else today)' },
    today: { type: 'string' },
    has_ideal: { type: 'boolean', description: 'Both dates are set: `ideal` is filled' },
    current: {
      type: 'object',
      properties: {
        scope: { type: 'integer' },
        done: { type: 'integer' },
        remaining: { type: 'integer' },
        completion_percentage: { type: 'integer' },
      },
    },
    days: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          scope: { type: 'integer', nullable: true },
          done: { type: 'integer', nullable: true },
          remaining: { type: 'integer', nullable: true },
          ideal: { type: 'number', nullable: true },
        },
      },
    },
  },
} as const;

export const BURNDOWN_DESCRIPTION =
  'By day in the workspace time zone, rebuilt from the issue history (joining and leaving, state ' +
  'changes): `scope` — issues in it at the end of the day, `done` — of them in a completed or ' +
  'cancelled state, `remaining` = scope − done, `ideal` — a straight line from the first day’s ' +
  'scope to zero on the last day (only when both dates are set). Days after today are null. ' +
  'Issues in the trash are left out. Burnup = `scope` and `done`; burndown = `remaining` and `ideal`. ' +
  'The chart spans the start to the end date (no start — from creation, no end — to today), at most 366 days.';
