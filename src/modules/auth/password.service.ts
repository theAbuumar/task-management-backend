// A password as an additional way to sign in (Ф12 12.B12, ADR-034).
//
// Main sign-in stays by code, Telegram, Google and GitHub; a password is something a
// person adds in the profile:
//   - set (or reset) — confirmed by a code sent to the account's email, which also
//     proves the address;
//   - change — with the current password.
// Either way the new password must pass the policy (lib/password), the other sessions
// are ended and a «Пароль изменён» letter goes to the inbox.
//
// Sign-in by password (`/auth/login`, service.login) is guarded by a per-account lock:
// after {@link PASSWORD_LOCK_AFTER} wrong passwords in a row password sign-in pauses for
// {@link PASSWORD_LOCK_MS}; codes, Telegram and OAuth still work. Wrong current
// passwords on «change» count the same.

import type { PrismaClient, User } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { hashSecret, passwordProblems, verifySecret } from '../../lib/password.js';
import { sendPasswordChangedEmail } from '../../lib/email.js';
import { sendAccountCode, verifyAccountCode, type CodeChallenge } from './account-code.js';
import { revokeOtherSessions } from './sessions.service.js';
import type { PasswordChangeBody, PasswordSetBody } from './schema.js';

export const PASSWORD_LOCK_AFTER = 10;
export const PASSWORD_LOCK_MS = 15 * 60_000;

/**
 * 429 PASSWORD_LOCKED. `just_locked` marks the attempt that caused the lock — the
 * controller writes that one to the audit log.
 */
function lockedError(until: Date, justLocked = false): AppError {
  const retry = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000));
  return new AppError(
    429,
    'PASSWORD_LOCKED',
    'Too many wrong passwords. Sign in with a code or try the password again later.',
    { retry_after_seconds: retry, ...(justLocked && { just_locked: true }) },
  );
}

/** 429 while password sign-in of this account is paused. */
export function assertPasswordNotLocked(user: User, now = new Date()): void {
  if (user.password_locked_until && user.password_locked_until > now) {
    throw lockedError(user.password_locked_until);
  }
}

/**
 * Count a wrong password; the one that reaches {@link PASSWORD_LOCK_AFTER} locks password
 * sign-in and throws 429 instead of returning.
 */
export async function recordPasswordFailure(prisma: PrismaClient, user: User): Promise<void> {
  // Increment in the database: parallel attempts must not undercount.
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { password_failures: { increment: 1 } },
    select: { password_failures: true },
  });
  if (updated.password_failures < PASSWORD_LOCK_AFTER) return;
  const until = new Date(Date.now() + PASSWORD_LOCK_MS);
  await prisma.user.update({
    where: { id: user.id },
    data: { password_failures: 0, password_locked_until: until },
  });
  throw lockedError(until, true);
}

/** A right password: the count of wrong ones starts over. */
export async function clearPasswordFailures(prisma: PrismaClient, user: User): Promise<void> {
  if (user.password_failures === 0 && !user.password_locked_until) return;
  await prisma.user.update({
    where: { id: user.id },
    data: { password_failures: 0, password_locked_until: null },
  });
}

/** 400 WEAK_PASSWORD with the reasons, checked with the person's email and name. */
function assertPolicy(user: User, password: string): void {
  const reasons = passwordProblems(password, [
    user.email,
    user.last_name,
    user.first_name,
    user.display_name,
  ]);
  if (reasons.length > 0) {
    throw new AppError(400, 'WEAK_PASSWORD', 'The password does not meet the policy', { reasons });
  }
}

export interface PasswordResult {
  has_password: true;
  password_changed_at: Date;
  /** How many other sessions were ended. */
  signed_out_sessions: number;
}

/** Store the new password, end other sessions, tell the inbox. */
async function storePassword(
  prisma: PrismaClient,
  user: User,
  password: string,
  keepSessionId: string | null,
  extra: { email_verified?: true } = {},
): Promise<PasswordResult> {
  const changedAt = new Date();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      password_hash: await hashSecret(password),
      password_changed_at: changedAt,
      password_failures: 0,
      password_locked_until: null,
      ...extra,
    },
  });
  // The email the code went to is a sign-in method from now on (as after a code login).
  if (extra.email_verified) {
    const identity = await prisma.authIdentity.findFirst({
      where: { user_id: user.id, provider: 'email' },
    });
    if (!identity) {
      await prisma.authIdentity.create({
        data: { user_id: user.id, provider: 'email', provider_email: user.email },
      });
    }
  }
  const ended = await revokeOtherSessions(prisma, user.id, keepSessionId);
  if (user.email) {
    await sendPasswordChangedEmail(
      user.email,
      changedAt,
      user.locale === 'en' ? 'en' : 'ru',
      user.timezone ?? 'UTC',
    );
  }
  return { has_password: true, password_changed_at: changedAt, signed_out_sessions: ended.length };
}

/**
 * Step 1 of setting a password: a code to the account's email (400 EMAIL_REQUIRED).
 * With the password it is going to confirm, the policy is checked first — a weak one
 * is refused before any code is sent (codes go out once a minute).
 */
export async function requestPasswordCode(
  prisma: PrismaClient,
  userId: string,
  password?: string,
): Promise<CodeChallenge> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (password !== undefined) assertPolicy(user, password);
  return sendAccountCode(prisma, user, 'set_password');
}

/**
 * Step 2: set a password — the first one, or a new one when the old is forgotten. The
 * policy is checked before the code, so a weak password does not use the code up.
 */
export async function setPassword(
  prisma: PrismaClient,
  userId: string,
  sessionId: string | null,
  body: PasswordSetBody,
): Promise<PasswordResult> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.email) {
    throw new AppError(400, 'EMAIL_REQUIRED', 'Add an email to the account first');
  }
  assertPolicy(user, body.password);
  await verifyAccountCode(prisma, user, 'set_password', body.code);
  return storePassword(prisma, user, body.password, sessionId, { email_verified: true });
}

/** Change the password knowing the current one. Wrong ones count toward the lock. */
export async function changePassword(
  prisma: PrismaClient,
  userId: string,
  sessionId: string | null,
  body: PasswordChangeBody,
): Promise<PasswordResult> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.password_hash) {
    throw new AppError(400, 'NO_PASSWORD', 'There is no password yet — set one with a code');
  }
  assertPasswordNotLocked(user);
  if (!(await verifySecret(user.password_hash, body.current_password))) {
    await recordPasswordFailure(prisma, user);
    throw new AppError(400, 'WRONG_PASSWORD', 'The current password is wrong');
  }
  await clearPasswordFailures(prisma, user);
  assertPolicy(user, body.password);
  if (body.password === body.current_password) {
    throw new AppError(400, 'WEAK_PASSWORD', 'The new password is the same as the current one', {
      reasons: ['same_as_current'],
    });
  }
  return storePassword(prisma, user, body.password, sessionId);
}
