// Sign-in sessions (Ф12 12.B2): «Мои сессии» in the profile — where the account is
// signed in, and ending a session on one device or on all the others.
//
// A session is one sign-in on one device. Its refresh tokens rotate underneath it
// (service.refresh), the access token carries its id as `sid`, and the auth hook
// rejects a `sid` whose session was revoked — so ending a session cuts the device
// off at its next request instead of when its access token expires.

import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { verifyAccessToken } from '../../lib/jwt.js';
import { describeUserAgent, type DeviceInfo } from '../../lib/user-agent.js';

/** Where a request came from — stored on the session at sign-in and on every refresh. */
export interface SessionClient {
  ip: string | null;
  user_agent: string | null;
}

export interface SessionSummary extends DeviceInfo {
  id: string;
  method: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: Date;
  last_used_at: Date;
  expires_at: Date;
  current: boolean;
}

/** The session a freshly issued token pair belongs to (the `sid` of its access token). */
export function sessionIdOf(tokens: { access_token: string }): string | null {
  return verifyAccessToken(tokens.access_token).sid ?? null;
}

/**
 * Remember the device of a session: at sign-in (with the method) and on every
 * refresh (latest IP and browser). A session that no longer exists is skipped.
 */
export async function recordSessionClient(
  prisma: PrismaClient,
  sessionId: string | null,
  client: SessionClient,
  method?: string,
): Promise<void> {
  if (!sessionId) return;
  await prisma.authSession.updateMany({
    where: { id: sessionId },
    data: {
      ip: client.ip,
      user_agent: client.user_agent?.slice(0, 300) ?? null,
      ...(method && { method }),
    },
  });
}

/** Live sessions of the user, the current one first, then by last activity. */
export async function listSessions(
  prisma: PrismaClient,
  userId: string,
  currentSessionId: string | null,
): Promise<SessionSummary[]> {
  const sessions = await prisma.authSession.findMany({
    where: { user_id: userId, revoked_at: null, expires_at: { gt: new Date() } },
    orderBy: { last_used_at: 'desc' },
  });
  return sessions
    .map((s) => ({
      id: s.id,
      method: s.method,
      ip: s.ip,
      user_agent: s.user_agent,
      ...describeUserAgent(s.user_agent),
      created_at: s.created_at,
      last_used_at: s.last_used_at,
      expires_at: s.expires_at,
      current: s.id === currentSessionId,
    }))
    .sort((a, b) => Number(b.current) - Number(a.current));
}

/** Revoke sessions and every refresh token under them; returns the revoked ids. */
async function revokeWhere(
  prisma: PrismaClient,
  where: { user_id: string; id?: string | { not: string } },
): Promise<string[]> {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const live = await tx.authSession.findMany({
      where: { ...where, revoked_at: null },
      select: { id: true },
    });
    const ids = live.map((s) => s.id);
    if (ids.length === 0) return ids;
    await tx.authSession.updateMany({ where: { id: { in: ids } }, data: { revoked_at: now } });
    await tx.refreshToken.updateMany({
      where: { session_id: { in: ids }, revoked_at: null },
      data: { revoked_at: now },
    });
    return ids;
  });
}

/** End one of the user's own sessions (may be the current one — then it is a sign-out). */
export async function revokeSession(
  prisma: PrismaClient,
  userId: string,
  sessionId: string,
): Promise<void> {
  const revoked = await revokeWhere(prisma, { user_id: userId, id: sessionId });
  // Someone else's session and an already ended one look the same: not found.
  if (revoked.length === 0) throw AppError.notFound('Session not found');
}

/**
 * «Выйти на всех других устройствах»: every session of the user except the one making
 * the request. Tokens issued before sessions existed are revoked as well.
 */
export async function revokeOtherSessions(
  prisma: PrismaClient,
  userId: string,
  keepSessionId: string | null,
): Promise<string[]> {
  const ids = await revokeWhere(prisma, {
    user_id: userId,
    ...(keepSessionId && { id: { not: keepSessionId } }),
  });
  await prisma.refreshToken.updateMany({
    where: { user_id: userId, session_id: null, revoked_at: null },
    data: { revoked_at: new Date() },
  });
  return ids;
}

/** Every session of the user (deactivation by an admin, 12.B7). */
export function revokeAllSessions(prisma: PrismaClient, userId: string): Promise<string[]> {
  return revokeOtherSessions(prisma, userId, null);
}

/** Auth hook: is the session behind an access token still live? */
export async function isSessionLive(prisma: PrismaClient, sessionId: string): Promise<boolean> {
  const session = await prisma.authSession.findUnique({
    where: { id: sessionId },
    select: { revoked_at: true },
  });
  return Boolean(session && !session.revoked_at);
}
