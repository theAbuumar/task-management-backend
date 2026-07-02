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

/** Zod validator enforcing the minimum-length password rule (reused by every schema). */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`);

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
