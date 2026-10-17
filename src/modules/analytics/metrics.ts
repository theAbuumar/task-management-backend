// Execution-discipline metrics (Ф10 10.B2) — the single place where the numbers
// on the dashboard, in the PDF справка and in the XLSX реестр are computed.
// Definitions (docs/METRICS.md):
//
//   on time        completed_at ≤ end of the due_date day in the workspace zone
//   late           completed_at > end of the due_date day
//   overdue        not closed and the due_date day is before today
//   discipline     on time / (on time + late) × 100 over work completed in the period
//   reaction time  acknowledged_at − assigned_at (median, hours)
//   execution time completed_at − created_at (median, days)
//   deadline moves approved DeadlineChangeRequest decided in the period
//   returns        IssueReview `returned` decided in the period
//   load           open issues per person: primary assignee and co-assignee apart
//
// All calendar math is on local dates of the workspace time zone (ADR-012):
// a deadline is a date, the whole day counts. A reopened issue has no
// completed_at (the issues service clears it), so it is open again, and a moved
// deadline is judged against the current due_date. Pure functions only: the
// facts are loaded and scoped in data.ts.

import type { IssueKind, StateGroup } from '@prisma/client';
import { addDays, daysBetween, localDate as tzLocalDate, startOfLocalDay } from '../../lib/tz.js';

// Intl formatting is the hot path (every fact, every counter, every bucket), and
// the same instants come back on every call: memoize the local date per instant.
const days = new Map<string, string>();
export function localDate(date: Date, tz: string): string {
  const key = `${tz}|${date.getTime()}`;
  let day = days.get(key);
  if (day === undefined) {
    if (days.size > 500_000) days.clear();
    day = tzLocalDate(date, tz);
    days.set(key, day);
  }
  return day;
}

export interface IssueFact {
  id: string;
  project_id: string;
  sequence_id: number;
  title: string;
  kind: IssueKind;
  priority: string;
  basis: string | null;
  created_at: Date;
  due_date: Date | null;
  completed_at: Date | null;
  state_group: StateGroup;
  state_name: string;
  controller_id: string | null;
  created_by_id: string;
  /** Primary assignee (ответственный), else the earliest assignee. */
  assignee_id: string | null;
  assigned_at: Date | null;
  acknowledged_at: Date | null;
  co_assignee_ids: string[];
  /** Addressed department (distribution child), else the primary assignee's department. */
  department_id: string | null;
}

export interface DeadlineFact {
  issue_id: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: Date;
  decided_at: Date | null;
}

export interface ReviewFact {
  issue_id: string;
  decision: 'pending' | 'approved' | 'returned';
  decided_at: Date | null;
}

/** An inclusive range of local dates, "2026-10-01" … "2026-10-31". */
export interface Period {
  from: string;
  to: string;
}

const OPEN: StateGroup[] = ['backlog', 'unstarted', 'started', 'review'];

export const isOpen = (f: Pick<IssueFact, 'state_group'>): boolean => OPEN.includes(f.state_group);

export const inPeriod = (date: string, p: Period): boolean => date >= p.from && date <= p.to;

/** Same-length period right before `p`. */
export function previousPeriod(p: Period): Period {
  const days = daysBetween(p.from, p.to) + 1;
  return { from: addDays(p.from, -days), to: addDays(p.from, -1) };
}

/** First instant after the period (start of the day after `to`). */
export function periodEnd(p: Period, tz: string): Date {
  return startOfLocalDay(addDays(p.to, 1), tz);
}

/** Completed (not cancelled) within the period, by the local date of completion. */
export function completedIn(f: IssueFact, p: Period, tz: string): boolean {
  return (
    f.state_group === 'completed' &&
    f.completed_at !== null &&
    inPeriod(localDate(f.completed_at, tz), p)
  );
}

/** For completed work with a deadline: in time or late. Null without one of the two. */
export function deadlineOutcome(f: IssueFact, tz: string): 'on_time' | 'late' | null {
  if (f.state_group !== 'completed' || !f.completed_at || !f.due_date) return null;
  return localDate(f.completed_at, tz) <= localDate(f.due_date, tz) ? 'on_time' : 'late';
}

/**
 * Was the issue overdue at instant `at`: it existed, its deadline day had passed,
 * and it was not closed yet. Cancelled work is never overdue.
 */
export function overdueAt(f: IssueFact, at: Date, tz: string): boolean {
  if (f.state_group === 'cancelled' || !f.due_date || f.created_at > at) return false;
  if (localDate(f.due_date, tz) >= localDate(at, tz)) return false;
  if (f.completed_at) return f.completed_at > at;
  return isOpen(f);
}

/** Days past the deadline at `at` (positive when overdue). */
export function daysOverdue(f: IssueFact, at: Date, tz: string): number {
  return f.due_date ? daysBetween(localDate(f.due_date, tz), localDate(at, tz)) : 0;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const round1 = (n: number | null): number | null => (n === null ? null : Math.round(n * 10) / 10);

/** on time / (on time + late) × 100, one decimal; null when nothing with a deadline was completed. */
export function discipline(onTime: number, late: number): number | null {
  return onTime + late === 0 ? null : round1((onTime / (onTime + late)) * 100);
}

export interface Counters {
  /** Created in the period. */
  created: number;
  /** Completed in the period (any deadline). */
  completed: number;
  on_time: number;
  late: number;
  /** Completed in the period without a deadline. */
  no_deadline: number;
  discipline: number | null;
  /** Open at the end of the period (or now for the current one). */
  open: number;
  overdue: number;
  /** Open assignments whose primary assignee has not acknowledged them. */
  unacknowledged: number;
  median_execution_days: number | null;
  median_reaction_hours: number | null;
  deadline_changes: number;
  returns: number;
}

export interface MetricInput {
  facts: IssueFact[];
  deadlines: DeadlineFact[];
  reviews: ReviewFact[];
  period: Period;
  tz: string;
  now: Date;
}

/**
 * Snapshot instant for "open" and "overdue": the end of the period, or now when
 * the period reaches today.
 */
export function snapshotAt(p: Period, tz: string, now: Date): Date {
  const end = periodEnd(p, tz);
  return end > now ? now : end;
}

/** Was the issue open at `at` (created, not yet completed, not cancelled). */
function openAt(f: IssueFact, at: Date): boolean {
  if (f.created_at > at || f.state_group === 'cancelled') return false;
  if (f.completed_at) return f.completed_at > at;
  return isOpen(f);
}

export function counters({ facts, deadlines, reviews, period, tz, now }: MetricInput): Counters {
  const at = snapshotAt(period, tz, now);
  let created = 0;
  let completed = 0;
  let onTime = 0;
  let late = 0;
  let noDeadline = 0;
  let open = 0;
  let overdue = 0;
  let unack = 0;
  const execution: number[] = [];
  const reaction: number[] = [];

  for (const f of facts) {
    if (inPeriod(localDate(f.created_at, tz), period)) created++;
    if (completedIn(f, period, tz)) {
      completed++;
      const outcome = deadlineOutcome(f, tz);
      if (outcome === 'on_time') onTime++;
      else if (outcome === 'late') late++;
      else noDeadline++;
      execution.push((f.completed_at!.getTime() - f.created_at.getTime()) / 86_400_000);
    }
    if (openAt(f, at)) {
      open++;
      if (
        f.kind === 'assignment' &&
        f.assignee_id &&
        (!f.acknowledged_at || f.acknowledged_at > at)
      )
        unack++;
    }
    if (overdueAt(f, at, tz)) overdue++;
    if (f.acknowledged_at && inPeriod(localDate(f.acknowledged_at, tz), period)) {
      const from = f.assigned_at ?? f.created_at;
      reaction.push(Math.max(0, f.acknowledged_at.getTime() - from.getTime()) / 3_600_000);
    }
  }

  const ids = new Set(facts.map((f) => f.id));
  const decidedIn = (d: Date | null) => d !== null && inPeriod(localDate(d, tz), period);
  return {
    created,
    completed,
    on_time: onTime,
    late,
    no_deadline: noDeadline,
    discipline: discipline(onTime, late),
    open,
    overdue,
    unacknowledged: unack,
    median_execution_days: round1(median(execution)),
    median_reaction_hours: round1(median(reaction)),
    deadline_changes: deadlines.filter(
      (d) => d.status === 'approved' && ids.has(d.issue_id) && decidedIn(d.decided_at),
    ).length,
    returns: reviews.filter(
      (r) => r.decision === 'returned' && ids.has(r.issue_id) && decidedIn(r.decided_at),
    ).length,
  };
}

export interface Bucket {
  key: string;
  from: string;
  to: string;
}

/** Monday of the ISO week containing local date `d`. */
function weekStart(d: string): string {
  const day = new Date(`${d}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(d, -((day + 6) % 7));
}

/** Split the period into calendar weeks or months, clipped to the period. */
export function buckets(p: Period, size: 'week' | 'month'): Bucket[] {
  const result: Bucket[] = [];
  let start = size === 'week' ? weekStart(p.from) : `${p.from.slice(0, 7)}-01`;
  while (start <= p.to) {
    let next: string;
    if (size === 'week') next = addDays(start, 7);
    else {
      const [y, m] = start.split('-').map(Number) as [number, number];
      next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    }
    const from = start < p.from ? p.from : start;
    const lastDay = addDays(next, -1);
    const to = lastDay > p.to ? p.to : lastDay;
    result.push({ key: start, from, to });
    start = next;
  }
  return result;
}
