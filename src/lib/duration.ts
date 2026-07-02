// Duration parsing shared by the auth/session layer.
//
// The env schema accepts JWT-style duration strings (e.g. "15m", "7d", "3600").
// This turns them into milliseconds so both refresh-token expiry (a future Date)
// and the refresh cookie's `maxAge` (seconds) derive from the same source.

const MS_PER_UNIT: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  y: 31_536_000_000,
};

/**
 * Parse a JWT-style duration string ("15m", "7d", "3600") into milliseconds.
 * A bare number is treated as seconds (matching the env schema regex).
 */
export function parseDurationMs(ttl: string): number {
  const match = /^(\d+)(ms|s|m|h|d|w|y)?$/.exec(ttl);
  if (!match || !match[1]) throw new Error(`Cannot parse duration: ${ttl}`);
  const n = parseInt(match[1], 10);
  const unit = match[2] ?? 's';
  return n * (MS_PER_UNIT[unit] ?? 1_000);
}

/** Same as {@link parseDurationMs} but rounded down to whole seconds. */
export function parseDurationSeconds(ttl: string): number {
  return Math.floor(parseDurationMs(ttl) / 1_000);
}
