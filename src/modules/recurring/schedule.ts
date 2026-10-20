// Schedule math of recurring rules (Ф6 6.B4, ADR-030) — pure functions over local
// calendar dates "YYYY-MM-DD" of the workspace zone (ADR-012).
//
//   daily      every `interval` days from `start_date`;
//   weekly     on `by_weekday` (ISO, 1 = Monday) of every `interval`-th week;
//   monthly    on day `by_monthday` of every `interval`-th month;
//   quarterly  the same, every 3 × `interval` months;
//   yearly     on `by_monthday` of month `by_month`, every `interval` years.
//
// A day past the month's end means its last day: «31-го» in February is the 28th
// (29th in a leap year), «30-го» in April — the 30th. Nothing runs before
// `start_date` or after `until`.

import type { RecurrenceFrequency } from '@prisma/client';
import { addDays, daysBetween, localDate, zonedTime } from '../../lib/tz.js';

export interface Schedule {
  frequency: RecurrenceFrequency;
  interval: number;
  by_weekday: number[];
  by_monthday: number | null;
  by_month: number | null;
  time: string;
  start_date: string;
  until: string | null;
}

/** Safety net: no schedule needs more steps than this to find its next run. */
const MAX_STEPS = 2000;

function ymd(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number);
  return [y!, m!, d!];
}

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** ISO weekday of a local date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Day `day` of a month, or its last day when the month is shorter. */
function dayOfMonth(year: number, month: number, day: number): string {
  return iso(year, month, Math.min(day, daysInMonth(year, month)));
}

function monthStep(s: Schedule): number {
  if (s.frequency === 'quarterly') return 3 * s.interval;
  if (s.frequency === 'yearly') return 12 * s.interval;
  return s.interval;
}

/** The first run date on or after `from` (and not before `start_date`), or null after `until`. */
export function occurrenceOnOrAfter(s: Schedule, from: string): string | null {
  const start = s.start_date;
  const since = from < start ? start : from;
  const found = ((): string | null => {
    if (s.frequency === 'daily') {
      const k = Math.ceil(daysBetween(start, since) / s.interval);
      return addDays(start, k * s.interval);
    }
    if (s.frequency === 'weekly') {
      const days = [...new Set(s.by_weekday.length ? s.by_weekday : [isoWeekday(start)])].sort();
      const monday = addDays(start, 1 - isoWeekday(start));
      let week = Math.floor(daysBetween(monday, since) / 7);
      week -= week % s.interval;
      for (let n = 0; n < MAX_STEPS; n += 1, week += s.interval) {
        for (const wd of days) {
          const d = addDays(monday, week * 7 + wd - 1);
          if (d >= since) return d;
        }
      }
      return null;
    }
    const [sy, sm, sd] = ymd(start);
    const day = s.by_monthday ?? sd;
    // A yearly rule counts its years from the given month of the start year.
    const anchor = sy * 12 + (s.frequency === 'yearly' && s.by_month ? s.by_month : sm) - 1;
    const [fy, fm] = ymd(since);
    const step = monthStep(s);
    let k = Math.max(0, Math.floor((fy * 12 + fm - 1 - anchor) / step));
    for (let n = 0; n < MAX_STEPS; n += 1, k += 1) {
      const month = anchor + k * step;
      const d = dayOfMonth(Math.floor(month / 12), (month % 12) + 1, day);
      if (d >= since) return d;
    }
    return null;
  })();
  if (!found || (s.until && found > s.until)) return null;
  return found;
}

/** The first run strictly after instant `after`, as a UTC instant; null — no more runs. */
export function nextRunAfter(s: Schedule, timeZone: string, after: Date): Date | null {
  let from = localDate(after, timeZone);
  for (let n = 0; n < 3; n += 1) {
    const d = occurrenceOnOrAfter(s, from);
    if (!d) return null;
    const at = zonedTime(d, s.time, timeZone);
    if (at > after) return at;
    from = addDays(d, 1);
  }
  return null;
}
