// Password + secret hashing policy (auth_tz.md §9 / AUTH-ROADMAP Resolved Decisions).
//
// The single place that owns how we hash and how strong a password must be, so the
// rules can't drift between call sites. Everything that stores a secret at rest —
// account passwords and email OTP codes — hashes through here with the same
// argon2id parameters; every request that accepts a password validates it against
// `passwordSchema`.

import * as argon2 from 'argon2';
import { z } from 'zod';

/** Minimum password length (locked decision: argon2id, min 8 characters). */
export const PASSWORD_MIN_LENGTH = 8;
/** Upper bound: argon2 hashes anything, but a megabyte "password" is an attack. */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Passwords people pick first (12.B12). Compared case-insensitively with the whole
 * password; a short list on purpose — length + letters + digits do the rest.
 */
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  'qwerty123',
  'qwerty12',
  'qwertyuiop',
  'qwerty1234',
  '1q2w3e4r',
  '1q2w3e4r5t',
  'q1w2e3r4',
  'zaq12wsx',
  'qazwsxedc',
  'abc12345',
  'abcd1234',
  'admin123',
  'admin1234',
  'welcome1',
  'welcome123',
  'iloveyou1',
  'letmein1',
  'student1',
  'student123',
  'university1',
  'parol123',
  'пароль123',
  'йцукен123',
  'qwerty123456',
  'a1b2c3d4',
  'test1234',
]);

/** Why a password is refused (12.B12) — the client turns each into a hint. */
export type PasswordProblem =
  | 'too_short'
  | 'too_long'
  | 'needs_letter'
  | 'needs_digit'
  | 'common'
  | 'personal';

/**
 * Check a password against the policy: 8–128 characters, at least one letter and one
 * digit, not a well-known one, and — when `personal` is given — not built from the
 * person's email or name (a part of 4+ characters inside the password).
 */
export function passwordProblems(
  password: string,
  personal: (string | null)[] = [],
): PasswordProblem[] {
  const problems: PasswordProblem[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) problems.push('too_short');
  if (password.length > PASSWORD_MAX_LENGTH) problems.push('too_long');
  if (!/\p{L}/u.test(password)) problems.push('needs_letter');
  if (!/\p{Nd}/u.test(password)) problems.push('needs_digit');
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) problems.push('common');
  const parts = personal
    .flatMap((value) => (value ?? '').toLowerCase().split(/[@.\s_+-]+/))
    .filter((part) => part.length >= 4);
  if (parts.some((part) => lower.includes(part))) problems.push('personal');
  return problems;
}

/**
 * Argon2id parameters applied to every hash we compute (passwords + OTP codes).
 * argon2id is the recommended variant; the cost parameters follow the OWASP
 * baseline (m = 19 MiB, t = 2, p = 1). Centralized so hashing is uniform and can
 * be tuned in exactly one place. Verification reads the parameters embedded in the
 * stored hash, so raising these later does not invalidate existing hashes.
 */
export const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456, // KiB (19 MiB)
  timeCost: 2,
  parallelism: 1,
};

/**
 * Zod validator for a new password in a request (reused by every schema): the policy
 * of {@link passwordProblems} without the personal check, which needs the account.
 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`)
  .superRefine((password, ctx) => {
    for (const problem of passwordProblems(password)) {
      if (problem === 'too_short' || problem === 'too_long') continue;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Password policy: ${problem}` });
    }
  });

/** Hash a secret (password or OTP code) with the shared argon2id parameters. */
export function hashSecret(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS);
}

/**
 * Verify a secret against its stored hash. Resolves `false` — never throws — on a
 * mismatch or a malformed/foreign hash, so callers can treat it as a plain boolean
 * (and a miss stays constant-time against enumeration).
 */
export function verifySecret(hash: string, plain: string): Promise<boolean> {
  return argon2.verify(hash, plain).catch(() => false);
}
