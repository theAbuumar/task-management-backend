// Calendar math in a workspace's time zone (ADR-012). Deadlines are "end of that
// day" in the workspace zone, so "today", "overdue" and "due in N days" are all
// computed on local calendar dates (YYYY-MM-DD strings), never on raw UTC instants.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function parts(date: Date, timeZone: string): { date: string; hour: number } {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

/** The local calendar date of an instant in `timeZone`: "2026-10-17". */
export function localDate(date: Date, timeZone: string): string {
  return parts(date, timeZone).date;
}

/** The local hour (0–23) of an instant in `timeZone`. */
export function localHour(date: Date, timeZone: string): number {
  return parts(date, timeZone).hour;
}

/** Whole days from local date `a` to local date `b` (b − a). */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** Local date `days` after `date` ("2026-10-17" + 3 → "2026-10-20"). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The UTC instant at which local date `date` begins in `timeZone`. Used to turn
 * "due before today" into a DB filter. Resolves DST/offsets by probing the zone.
 */
export function startOfLocalDay(date: string, timeZone: string): Date {
  const guess = new Date(`${date}T00:00:00Z`);
  // Offset of the zone at that moment: local wall clock − UTC.
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(guess)
      .map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
  );
  const offset = asUtc - guess.getTime();
  return new Date(guess.getTime() - offset);
}
