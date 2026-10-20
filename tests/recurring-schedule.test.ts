// Unit tests for the schedule math of recurring rules (Ф6 6.B4, ADR-030): local
// dates in the workspace zone, «31-го» = the last day of a shorter month, weekly
// days and intervals, the end date, and the run time across a DST switch.

import { describe, expect, it } from 'vitest';
import {
  nextRunAfter,
  occurrenceOnOrAfter,
  type Schedule,
} from '../src/modules/recurring/schedule.js';
import { zonedTime } from '../src/lib/tz.js';

const base: Schedule = {
  frequency: 'monthly',
  interval: 1,
  by_weekday: [],
  by_monthday: 1,
  by_month: null,
  time: '09:00',
  start_date: '2026-01-01',
  until: null,
};

function runs(s: Schedule, from: string, n: number): string[] {
  const out: string[] = [];
  let d: string | null = from;
  while (out.length < n && d) {
    d = occurrenceOnOrAfter(s, d);
    if (d) {
      out.push(d);
      const next = new Date(`${d}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      d = next.toISOString().slice(0, 10);
    }
  }
  return out;
}

describe('monthly', () => {
  it('«31-го» falls on the last day of shorter months, February included', () => {
    const s = { ...base, by_monthday: 31 };
    expect(runs(s, '2026-01-01', 5)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
    ]);
    // A leap year: the 29th.
    expect(occurrenceOnOrAfter({ ...s, start_date: '2028-02-01' }, '2028-02-01')).toBe(
      '2028-02-29',
    );
  });

  it('every 2nd month on the 1st, from the start month', () => {
    expect(runs({ ...base, interval: 2, start_date: '2026-10-20' }, '2026-10-20', 3)).toEqual([
      '2026-12-01',
      '2027-02-01',
      '2027-04-01',
    ]);
  });

  it('quarterly and yearly', () => {
    expect(
      runs({ ...base, frequency: 'quarterly', start_date: '2026-01-01' }, '2026-02-01', 3),
    ).toEqual(['2026-04-01', '2026-07-01', '2026-10-01']);
    const yearly = { ...base, frequency: 'yearly' as const, by_month: 2, by_monthday: 29 };
    expect(runs({ ...yearly, start_date: '2026-03-01' }, '2026-03-01', 3)).toEqual([
      '2027-02-28',
      '2028-02-29',
      '2029-02-28',
    ]);
  });
});

describe('daily and weekly', () => {
  it('every 3 days from the start', () => {
    const s = { ...base, frequency: 'daily' as const, interval: 3, start_date: '2026-10-30' };
    expect(runs(s, '2026-10-01', 3)).toEqual(['2026-10-30', '2026-11-02', '2026-11-05']);
  });

  it('on Monday and Friday of every other week', () => {
    // 2026-10-20 is a Tuesday: its week's Monday has passed, Friday has not.
    const s = {
      ...base,
      frequency: 'weekly' as const,
      interval: 2,
      by_weekday: [5, 1],
      start_date: '2026-10-20',
    };
    expect(runs(s, '2026-10-20', 4)).toEqual([
      '2026-10-23',
      '2026-11-02',
      '2026-11-06',
      '2026-11-16',
    ]);
  });

  it('weekly without days runs on the start weekday', () => {
    const s = { ...base, frequency: 'weekly' as const, start_date: '2026-10-21' };
    expect(runs(s, '2026-10-21', 2)).toEqual(['2026-10-21', '2026-10-28']);
  });
});

describe('end date and run time', () => {
  it('nothing after `until`', () => {
    const s = { ...base, until: '2026-03-15' };
    expect(runs(s, '2026-01-01', 10)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
  });

  it('runs at the local time of the workspace zone', () => {
    const tashkent = nextRunAfter(base, 'Asia/Tashkent', new Date('2026-10-20T10:00:00Z'));
    // 1 November, 09:00 in Tashkent (UTC+5) = 04:00 UTC.
    expect(tashkent?.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    // Today's run is still ahead at 03:00 UTC on the 1st…
    expect(
      nextRunAfter(base, 'Asia/Tashkent', new Date('2026-11-01T03:00:00Z'))?.toISOString(),
    ).toBe('2026-11-01T04:00:00.000Z');
    // …and past it the next one is a month away.
    expect(
      nextRunAfter(base, 'Asia/Tashkent', new Date('2026-11-01T04:00:00Z'))?.toISOString(),
    ).toBe('2026-12-01T04:00:00.000Z');
  });

  it('keeps the wall-clock time across a DST switch', () => {
    // Berlin: UTC+2 in summer, UTC+1 from 25 October 2026.
    expect(zonedTime('2026-10-24', '09:00', 'Europe/Berlin').toISOString()).toBe(
      '2026-10-24T07:00:00.000Z',
    );
    expect(zonedTime('2026-10-26', '09:00', 'Europe/Berlin').toISOString()).toBe(
      '2026-10-26T08:00:00.000Z',
    );
  });

  it('no more runs once the end date has passed', () => {
    expect(
      nextRunAfter({ ...base, until: '2026-10-31' }, 'UTC', new Date('2026-10-20T00:00:00Z')),
    ).toBeNull();
  });
});
