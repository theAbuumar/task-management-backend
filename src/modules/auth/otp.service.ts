// Email OTP primitives (auth_tz.md §6, §9).
//
// Owns the lifecycle of the 6-digit email codes: issuing (with send rate limits),
// and verifying (expiry, attempt cap, single-use). Only the hash of a code is
// stored. The orchestration (create/find user, send the mail, issue a session)
// lives in service.ts — this module is pure persistence + policy.

import crypto from 'node:crypto';
import type { PrismaClient, EmailOtpPurpose } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { hashSecret, verifySecret } from '../../lib/password.js';

// Locked defaults (AUTH-ROADMAP Resolved Decisions / auth_tz.md §9).
const CODE_LENGTH = 6;
const TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;
const RATE_MIN_INTERVAL_MS = 60 * 1000; // at most 1 send / 60s
const RATE_WINDOW_MS = 60 * 60 * 1000; // rolling 1-hour window
const RATE_MAX_PER_WINDOW = 5; // at most 5 sends / hour

/** Cryptographically-random zero-padded 6-digit code. */
function generateCode(): string {
  const max = 10 ** CODE_LENGTH;
  return crypto.randomInt(0, max).toString().padStart(CODE_LENGTH, '0');
}

/**
 * Enforce the per-email send limits (auth_tz.md §9): no more than 1 code / 60s and
 * 5 codes / hour. Throws {@link AppError.rateLimited} (429) when exceeded.
 */
async function enforceSendRateLimit(prisma: PrismaClient, email: string): Promise<void> {
  const now = Date.now();

  const mostRecent = await prisma.emailOtp.findFirst({
    where: { email },
    orderBy: { created_at: 'desc' },
  });
  if (mostRecent && now - mostRecent.created_at.getTime() < RATE_MIN_INTERVAL_MS) {
    throw AppError.rateLimited('Please wait a minute before requesting another code.');
  }

  const recentCount = await prisma.emailOtp.count({
    where: { email, created_at: { gte: new Date(now - RATE_WINDOW_MS) } },
  });
  if (recentCount >= RATE_MAX_PER_WINDOW) {
    throw AppError.rateLimited('Too many codes requested. Try again later.');
  }
}

/**
 * Issue a fresh OTP for `email`/`purpose` and return the plaintext code (the caller
 * emails it). Rate-limited; any earlier un-consumed codes for the same
 * email+purpose are invalidated so only the latest one is valid.
 */
export async function issueOtp(
  prisma: PrismaClient,
  email: string,
  purpose: EmailOtpPurpose,
): Promise<string> {
  await enforceSendRateLimit(prisma, email);

  // Invalidate previous outstanding codes for this email+purpose.
  await prisma.emailOtp.updateMany({
    where: { email, purpose, consumed_at: null },
    data: { consumed_at: new Date() },
  });

  const code = generateCode();
  const code_hash = await hashSecret(code);
  await prisma.emailOtp.create({
    data: { email, code_hash, purpose, expires_at: new Date(Date.now() + TTL_MS) },
  });

  return code;
}

/**
 * Verify a submitted code against the latest outstanding OTP for `email`/`purpose`.
 * Enforces expiry, the {@link MAX_ATTEMPTS} cap, and single use. Throws
 * {@link AppError} on any failure; resolves (consuming the code) on success.
 */
export async function verifyOtp(
  prisma: PrismaClient,
  email: string,
  purpose: EmailOtpPurpose,
  code: string,
): Promise<void> {
  const otp = await prisma.emailOtp.findFirst({
    where: { email, purpose, consumed_at: null },
    orderBy: { created_at: 'desc' },
  });

  if (!otp) throw AppError.badRequest('No active verification code. Request a new one.');

  if (otp.expires_at < new Date()) {
    await prisma.emailOtp.update({ where: { id: otp.id }, data: { consumed_at: new Date() } });
    throw AppError.badRequest('This verification code has expired. Request a new one.');
  }

  if (otp.attempts >= MAX_ATTEMPTS) {
    await prisma.emailOtp.update({ where: { id: otp.id }, data: { consumed_at: new Date() } });
    throw AppError.badRequest('Too many incorrect attempts. Request a new code.');
  }

  const matches = await verifySecret(otp.code_hash, code);
  if (!matches) {
    const attempts = otp.attempts + 1;
    await prisma.emailOtp.update({
      where: { id: otp.id },
      // Invalidate immediately once the cap is reached so no further tries land.
      data: { attempts, ...(attempts >= MAX_ATTEMPTS ? { consumed_at: new Date() } : {}) },
    });
    throw AppError.badRequest('Invalid verification code.');
  }

  await prisma.emailOtp.update({ where: { id: otp.id }, data: { consumed_at: new Date() } });
}
