// Telegram login-token lifecycle (auth_tz.md §7, §9).
//
// Owns the deep-link handshake token: issuing (bound to the initiating browser
// session), confirming (the bot attaches the telegram_id), and consuming (the site
// polls and we hand back the confirmed telegram_id exactly once). Enforces the
// locked policy: 10-minute TTL, one-time use, session binding, plus an opportunistic
// expiry sweep. Pure persistence + policy — the Bot API transport lives in
// telegram.service.ts and session issuing lives in service.ts.

import crypto from 'node:crypto';
import type { PrismaClient, TelegramLoginToken } from '@prisma/client';
import { AppError } from '../../lib/errors.js';

// Locked default (AUTH-ROADMAP Resolved Decisions / auth_tz.md §9).
const TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Random, URL-safe token. 24 bytes → 32 base64url chars, well within Telegram's
 * 64-char `start`-parameter and callback_data limits, and uses only `A-Za-z0-9_-`.
 */
function generateToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/** Opaque browser-session id stored in the `tg_session` cookie and on the token. */
export function generateSessionId(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Best-effort sweep: flip any still-`pending`/`confirmed` tokens whose TTL has
 * lapsed to `expired`. Called opportunistically at init so the table can't fill with
 * stale handshakes; correctness never relies on it (each read re-checks `expires_at`).
 */
export async function sweepExpiredTokens(prisma: PrismaClient): Promise<void> {
  await prisma.telegramLoginToken.updateMany({
    where: { status: { in: ['pending', 'confirmed'] }, expires_at: { lt: new Date() } },
    data: { status: 'expired' },
  });
}

/**
 * Create a fresh `pending` login token bound to `sessionId` (the initiating browser),
 * returning the token + its expiry. The caller builds the deep-link from the token.
 */
export async function initLoginToken(
  prisma: PrismaClient,
  sessionId: string,
): Promise<{ token: string; expires_at: Date }> {
  await sweepExpiredTokens(prisma);

  const token = generateToken();
  const expires_at = new Date(Date.now() + TTL_MS);
  await prisma.telegramLoginToken.create({
    data: { token, session_id: sessionId, status: 'pending', expires_at },
  });

  return { token, expires_at };
}

/**
 * Confirm a token on behalf of the bot: it must be `pending` and unexpired. Attaches
 * `telegramId` and flips the status to `confirmed`. Idempotent for a re-tap: a token
 * already `confirmed` by the same telegram_id resolves quietly. Throws {@link AppError}
 * (surfaced to the bot as a message) on an unknown/expired/used token.
 */
export async function confirmLoginToken(
  prisma: PrismaClient,
  token: string,
  telegramId: string,
): Promise<void> {
  const row = await prisma.telegramLoginToken.findUnique({ where: { token } });
  if (!row) throw AppError.notFound('This sign-in link is not valid.');

  if (row.status === 'confirmed' && row.telegram_id === telegramId) return; // re-tap
  if (row.status !== 'pending') throw AppError.badRequest('This sign-in link is no longer active.');

  if (row.expires_at < new Date()) {
    await prisma.telegramLoginToken.update({
      where: { id: row.id },
      data: { status: 'expired' },
    });
    throw AppError.gone('This sign-in link has expired. Start again from the website.');
  }

  await prisma.telegramLoginToken.update({
    where: { id: row.id },
    data: { status: 'confirmed', telegram_id: telegramId },
  });
}

export type TelegramTokenState =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'used' }
  | { status: 'confirmed'; telegram_id: string };

/**
 * Read a token on behalf of the polling site. Enforces session binding (the caller's
 * `tg_session` must match) and TTL. On a first `confirmed` read it atomically flips the
 * token to `used` (one-time) and returns the telegram_id so the caller can issue a
 * session; subsequent polls see `used`. `pending`/`expired`/`used` are returned as-is.
 */
export async function consumeLoginToken(
  prisma: PrismaClient,
  token: string,
  sessionId: string | undefined,
): Promise<TelegramTokenState> {
  const row = await prisma.telegramLoginToken.findUnique({ where: { token } });
  if (!row) throw AppError.notFound('Unknown sign-in token.');

  // Session binding: only the browser that started the flow may consume it (§7).
  if (!sessionId || sessionId !== row.session_id) {
    throw AppError.forbidden('This sign-in link was started in a different browser session.');
  }

  const expired = row.expires_at < new Date();

  if (row.status === 'pending') {
    if (expired) {
      await markExpired(prisma, row);
      return { status: 'expired' };
    }
    return { status: 'pending' };
  }

  if (row.status === 'confirmed') {
    if (expired || !row.telegram_id) {
      await markExpired(prisma, row);
      return { status: 'expired' };
    }
    // One-time consume: flip to `used` only if it is still `confirmed` (guards a race
    // between two concurrent polls — the loser sees 0 updated and reports `used`).
    const consumed = await prisma.telegramLoginToken.updateMany({
      where: { id: row.id, status: 'confirmed' },
      data: { status: 'used' },
    });
    if (consumed.count === 0) return { status: 'used' };
    return { status: 'confirmed', telegram_id: row.telegram_id };
  }

  // `used` or `expired`.
  return { status: row.status === 'used' ? 'used' : 'expired' };
}

async function markExpired(prisma: PrismaClient, row: TelegramLoginToken): Promise<void> {
  if (row.status === 'expired') return;
  await prisma.telegramLoginToken.update({ where: { id: row.id }, data: { status: 'expired' } });
}
