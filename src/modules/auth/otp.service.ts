// Email OTP primitives (auth_tz.md §6, §9).
//
// Owns the lifecycle of the 6-digit email codes: issuing (with send rate limits),
// and verifying (expiry, attempt cap, single-use). Only the hash of a code is
// stored. The orchestration (create/find user, send the mail, issue a session)
// lives in service.ts — this module is pure persistence + policy.

import crypto from 'node:crypto';
import type { PrismaClient, EmailOtpPurpose, Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { hashSecret, verifySecret } from '../../lib/password.js';

/**
 * Who a code is bound to. `email` for the signup/login flows and email-account
 * deletion (the code is emailed); `userId` for deleting an account with no email,
 * where the code is delivered another way (e.g. the Telegram bot). Lookup and the
 * send rate-limit key off whichever column is set.
 */
export type OtpTarget = { email: string } | { userId: string };

/** The WHERE fragment that selects a target's rows. */
function targetWhere(target: OtpTarget): Prisma.EmailOtpWhereInput {
  return 'email' in target ? { email: target.email } : { user_id: target.userId };
}

/** The columns to persist for a target when creating a code. */
function targetData(target: OtpTarget): { email: string } | { user_id: string } {
  return 'email' in target ? { email: target.email } : { user_id: target.userId };
}

// Locked defaults (AUTH-ROADMAP Resolved Decisions / auth_tz.md §9).
const CODE_LENGTH = 6;
const TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;
const RATE_MIN_INTERVAL_MS = 60 * 1000; // at most 1 send / 60s
const RATE_WINDOW_MS = 60 * 60 * 1000; // rolling 1-hour window
const RATE_MAX_PER_WINDOW = 60; // at most 60 sends / hour

/** Cryptographically-random zero-padded 6-digit code. */
function generateCode(): string {
  const max = 10 ** CODE_LENGTH;
  return crypto.randomInt(0, max).toString().padStart(CODE_LENGTH, '0');
}

/**
 * Enforce the per-target send limits (auth_tz.md §9): no more than 1 code / 60s and
 * 5 codes / hour. Throws {@link AppError.rateLimited} (429) when exceeded.
 */
async function enforceSendRateLimit(prisma: PrismaClient, target: OtpTarget): Promise<void> {
  const now = Date.now();
  const where = targetWhere(target);

  const mostRecent = await prisma.emailOtp.findFirst({
    where,
    orderBy: { created_at: 'desc' },
  });
  if (mostRecent && now - mostRecent.created_at.getTime() < RATE_MIN_INTERVAL_MS) {
    throw AppError.rateLimited('Please wait a minute before requesting another code.');
  }

  const recentCount = await prisma.emailOtp.count({
    where: { ...where, created_at: { gte: new Date(now - RATE_WINDOW_MS) } },
  });
  if (recentCount >= RATE_MAX_PER_WINDOW) {
    throw AppError.rateLimited('Too many codes requested. Try again later.');
  }
}

/**
 * Issue a fresh OTP for `target`/`purpose` and return the plaintext code (the caller
 * delivers it). Rate-limited; any earlier un-consumed codes for the same
 * target+purpose are invalidated so only the latest one is valid.
 */
export async function issueOtp(
  prisma: PrismaClient,
  target: OtpTarget,
  purpose: EmailOtpPurpose,
): Promise<string> {
  await enforceSendRateLimit(prisma, target);

  // Invalidate previous outstanding codes for this target+purpose.
  await prisma.emailOtp.updateMany({
    where: { ...targetWhere(target), purpose, consumed_at: null },
    data: { consumed_at: new Date() },
  });

  const code = generateCode();
  const code_hash = await hashSecret(code);
  await prisma.emailOtp.create({
    data: { ...targetData(target), code_hash, purpose, expires_at: new Date(Date.now() + TTL_MS) },
  });

  return code;
}

/**
 * Verify a submitted code against the latest outstanding OTP for `target`/`purpose`.
 * Enforces expiry, the {@link MAX_ATTEMPTS} cap, and single use. Throws
 * {@link AppError} on any failure; resolves (consuming the code) on success.
 */
export async function verifyOtp(
  prisma: PrismaClient,
  target: OtpTarget,
  purpose: EmailOtpPurpose,
  code: string,
): Promise<void> {
  const otp = await prisma.emailOtp.findFirst({
    where: { ...targetWhere(target), purpose, consumed_at: null },
    orderBy: { created_at: 'desc' },
  });

  if (!otp)
    throw new AppError(400, 'OTP_NOT_FOUND', 'No active verification code. Request a new one.');

  if (otp.expires_at < new Date()) {
    await prisma.emailOtp.update({ where: { id: otp.id }, data: { consumed_at: new Date() } });
    throw new AppError(
      400,
      'OTP_EXPIRED',
      'This verification code has expired. Request a new one.',
    );
  }

  if (otp.attempts >= MAX_ATTEMPTS) {
    await prisma.emailOtp.update({ where: { id: otp.id }, data: { consumed_at: new Date() } });
    throw new AppError(
      400,
      'OTP_TOO_MANY_ATTEMPTS',
      'Too many incorrect attempts. Request a new code.',
    );
  }

  const matches = await verifySecret(otp.code_hash, code);
  if (!matches) {
    const attempts = otp.attempts + 1;
    await prisma.emailOtp.update({
      where: { id: otp.id },
      // Invalidate immediately once the cap is reached so no further tries land.
      data: { attempts, ...(attempts >= MAX_ATTEMPTS ? { consumed_at: new Date() } : {}) },
    });
    throw new AppError(400, 'OTP_INVALID', 'Invalid verification code.');
  }

  await prisma.emailOtp.update({ where: { id: otp.id }, data: { consumed_at: new Date() } });
}
