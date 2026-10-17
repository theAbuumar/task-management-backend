// Unit tests for the execution-discipline formulas (Ф10 10.B2): the edge cases
// the definitions in docs/METRICS.md hinge on — midnight in the workspace zone,
// the zone itself, a moved deadline, a reopened issue — plus periods, buckets
// and the counters that feed every dashboard and report. No database.

import { describe, expect, it } from 'vitest';
import {
  buckets,
  counters,
  deadlineOutcome,
  discipline,
  median,
  overdueAt,
  previousPeriod,
  snapshotAt,
  type IssueFact,
} from '../src/modules/analytics/metrics.js';

const TZ = 'Asia/Tashkent'; // UTC+5, no DST

function fact(over: Partial<IssueFact> = {}): IssueFact {
  return {
    id: crypto.randomUUID(),
    project_id: 'p',
    sequence_id: 1,
    title: 'Отчёт',
    kind: 'assignment',
    priority: 'none',
    basis: null,
    created_at: new Date('2026-10-01T05:00:00Z'),
    due_date: new Date('2026-10-20T00:00:00Z'),
    completed_at: null,
    state_group: 'started',
    state_name: 'В работе',
    controller_id: null,
    created_by_id: 'u0',
    assignee_id: 'u1',
    assigned_at: new Date('2026-10-01T05:00:00Z'),
    acknowledged_at: null,
    co_assignee_ids: [],
    department_id: null,
    ...over,
  };
}

const done = (completedAt: string, over: Partial<IssueFact> = {}) =>
  fact({ state_group: 'completed', completed_at: new Date(completedAt), ...over });

describe('deadlineOutcome — the due date is the whole local day', () => {
  it('23:59 local time on the due date is on time, 00:01 the next day is late', () => {
    expect(deadlineOutcome(done('2026-10-20T18:59:00Z'), TZ)).toBe('on_time'); // 23:59 in Tashkent
    expect(deadlineOutcome(done('2026-10-20T19:01:00Z'), TZ)).toBe('late'); // 00:01 on the 21st
  });

  it('is judged in the workspace zone, not in UTC', () => {
    const f = done('2026-10-20T20:00:00Z'); // the 20th in UTC, already the 21st in Tashkent
    expect(deadlineOutcome(f, 'UTC')).toBe('on_time');
    expect(deadlineOutcome(f, TZ)).toBe('late');
  });

  it('a moved deadline counts against the current due date', () => {
    const moved = done('2026-10-24T08:00:00Z', { due_date: new Date('2026-10-25T00:00:00Z') });
    expect(deadlineOutcome(moved, TZ)).toBe('on_time');
  });

  it('only completed work with a deadline has an outcome', () => {
    expect(deadlineOutcome(fact(), TZ)).toBeNull();
    expect(deadlineOutcome(done('2026-10-10T08:00:00Z', { due_date: null }), TZ)).toBeNull();
    expect(
      deadlineOutcome(fact({ state_group: 'cancelled', completed_at: new Date() }), TZ),
    ).toBeNull();
  });
});

describe('overdueAt', () => {
  const at = (iso: string) => new Date(iso);

  it('becomes overdue at local midnight after the due date', () => {
    const f = fact();
    expect(overdueAt(f, at('2026-10-20T18:59:00Z'), TZ)).toBe(false); // still the 20th locally
    expect(overdueAt(f, at('2026-10-20T19:01:00Z'), TZ)).toBe(true); // the 21st
  });

  it('a reopened issue (completed_at cleared) is open and overdue again', () => {
    const reopened = fact({ state_group: 'started', completed_at: null });
    expect(overdueAt(reopened, at('2026-10-25T10:00:00Z'), TZ)).toBe(true);
  });

  it('work completed later was overdue in between, not after', () => {
    const f = done('2026-10-23T08:00:00Z');
    expect(overdueAt(f, at('2026-10-22T10:00:00Z'), TZ)).toBe(true);
    expect(overdueAt(f, at('2026-10-24T10:00:00Z'), TZ)).toBe(false);
  });

  it('cancelled work and work without a deadline are never overdue', () => {
    expect(overdueAt(fact({ state_group: 'cancelled' }), at('2026-11-01T00:00:00Z'), TZ)).toBe(
      false,
    );
    expect(overdueAt(fact({ due_date: null }), at('2026-11-01T00:00:00Z'), TZ)).toBe(false);
  });
});

describe('periods and buckets', () => {
  it('the previous period has the same length and ends the day before', () => {
    expect(previousPeriod({ from: '2026-10-01', to: '2026-10-31' })).toEqual({
      from: '2026-08-31',
      to: '2026-09-30',
    });
  });

  it('weeks start on Monday and are clipped to the period', () => {
    const b = buckets({ from: '2026-10-01', to: '2026-10-14' }, 'week');
    expect(b.map((x) => [x.from, x.to])).toEqual([
      ['2026-10-01', '2026-10-04'],
      ['2026-10-05', '2026-10-11'],
      ['2026-10-12', '2026-10-14'],
    ]);
    expect(b[0]!.key).toBe('2026-09-28');
  });

  it('months cross the year boundary', () => {
    const b = buckets({ from: '2026-11-15', to: '2027-01-10' }, 'month');
    expect(b.map((x) => [x.from, x.to])).toEqual([
      ['2026-11-15', '2026-11-30'],
      ['2026-12-01', '2026-12-31'],
      ['2027-01-01', '2027-01-10'],
    ]);
  });

  it('the snapshot of a past period is its end, of the current one — now', () => {
    const now = new Date('2026-10-17T07:00:00Z');
    expect(snapshotAt({ from: '2026-09-01', to: '2026-09-30' }, TZ, now).toISOString()).toBe(
      '2026-09-30T19:00:00.000Z',
    );
    expect(snapshotAt({ from: '2026-10-01', to: '2026-10-17' }, TZ, now)).toBe(now);
  });
});

describe('counters', () => {
  const period = { from: '2026-10-01', to: '2026-10-31' };
  const now = new Date('2026-11-05T07:00:00Z');

  it('discipline = on time / (on time + late); work without a deadline is left out', () => {
    const facts = [
      done('2026-10-15T08:00:00Z'), // on time
      done('2026-10-18T08:00:00Z'), // on time
      done('2026-10-22T08:00:00Z'), // late
      done('2026-10-22T08:00:00Z', { due_date: null }), // no deadline
      done('2026-09-25T08:00:00Z'), // completed before the period
    ];
    const c = counters({ facts, deadlines: [], reviews: [], period, tz: TZ, now });
    expect(c).toMatchObject({
      completed: 4,
      on_time: 2,
      late: 1,
      no_deadline: 1,
      discipline: 66.7,
    });
  });

  it('open and overdue are taken at the end of a past period', () => {
    const facts = [
      fact(), // open, due 20.10 → overdue at 31.10
      fact({ due_date: new Date('2026-11-03T00:00:00Z') }), // open, not yet due on 31.10
      done('2026-11-02T08:00:00Z'), // closed after the period: still open and overdue on 31.10
      fact({ created_at: new Date('2026-11-02T08:00:00Z') }), // did not exist yet
    ];
    const c = counters({ facts, deadlines: [], reviews: [], period, tz: TZ, now });
    expect(c).toMatchObject({ open: 3, overdue: 2, created: 3 });
  });

  it('reaction time is assigned → acknowledged, median in hours; unacknowledged assignments are counted', () => {
    const facts = [
      fact({ acknowledged_at: new Date('2026-10-01T07:00:00Z') }), // 2 h
      fact({ acknowledged_at: new Date('2026-10-01T09:00:00Z') }), // 4 h
      fact({ acknowledged_at: new Date('2026-10-02T05:00:00Z') }), // 24 h
      fact(), // not acknowledged
      fact({ kind: 'task' }), // tasks need no acknowledgement
    ];
    const c = counters({ facts, deadlines: [], reviews: [], period, tz: TZ, now });
    expect(c.median_reaction_hours).toBe(4);
    expect(c.unacknowledged).toBe(1);
  });

  it('deadline moves and returns are counted by the decision date, only for the given issues', () => {
    const f = fact();
    const decided = new Date('2026-10-10T08:00:00Z');
    const c = counters({
      facts: [f],
      deadlines: [
        { issue_id: f.id, status: 'approved', created_at: decided, decided_at: decided },
        { issue_id: f.id, status: 'rejected', created_at: decided, decided_at: decided },
        {
          issue_id: f.id,
          status: 'approved',
          created_at: decided,
          decided_at: new Date('2026-09-10T08:00:00Z'),
        },
        { issue_id: 'other', status: 'approved', created_at: decided, decided_at: decided },
      ],
      reviews: [
        { issue_id: f.id, decision: 'returned', decided_at: decided },
        { issue_id: f.id, decision: 'approved', decided_at: decided },
      ],
      period,
      tz: TZ,
      now,
    });
    expect(c).toMatchObject({ deadline_changes: 1, returns: 1 });
  });

  it('helpers: median and discipline', () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(discipline(0, 0)).toBeNull();
    expect(discipline(87, 13)).toBe(87);
  });
});
