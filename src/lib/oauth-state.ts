// OAuth `state` parameter — CSRF protection for the redirect flows (auth_tz.md §9).
//
// Stateless design: a random nonce plus the time it was issued, authenticated by an
// HMAC keyed on the access-token secret. The route puts the token in the outgoing
// `state` query param (and typically mirrors it in a short-lived cookie); on callback
// `verifyState` checks the signature and freshness — no server-side storage needed.
//
// This only proves the callback's `state` was minted by us and is recent. Binding it
// to the specific browser (double-submit cookie) is the route's job on top of this.
//
// A state may also carry a link intent (ADR-025, 4.F9): "attach the provider account
// to user X" — minted only by an authenticated `…/link/start`. The callback then links
// instead of signing in. The intent is inside the signed payload, so it can't be
// added or changed by whoever holds the URL.

import crypto from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { CookieSerializeOptions } from '@fastify/cookie';
import { config, isProd } from '../config/index.js';

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const STATE_COOKIE_NAME = 'oauth_state';

function sign(payload: string): string {
  return crypto.createHmac('sha256', config.JWT_ACCESS_SECRET).update(payload).digest('base64url');
}

export type LinkProvider = 'google' | 'github';

/** Who a link flow attaches the provider account to (ADR-025). */
export interface LinkIntent {
  provider: LinkProvider;
  userId: string;
}

/** What a verified state says: a sign-in (`link: null`) or a link to an account. */
export interface StateClaims {
  link: LinkIntent | null;
}

/** Mint a fresh, self-authenticating state token; with `link` — for a link flow. */
export function createState(link?: LinkIntent): string {
  const nonce = crypto.randomBytes(16).toString('base64url');
  const issued = Date.now().toString(36);
  const parts = [nonce, issued];
  if (link) parts.push(Buffer.from(`${link.provider}:${link.userId}`).toString('base64url'));
  const payload = parts.join('.');
  return `${payload}.${sign(payload)}`;
}

/** The claims of a state produced by `createState` within the TTL, else null. */
export function readState(state: string | undefined | null): StateClaims | null {
  if (!state) return null;
  const parts = state.split('.');
  if (parts.length !== 3 && parts.length !== 4) return null;
  const sig = parts.pop()!;
  const [nonce, issued, intent] = parts;
  if (!nonce || !issued || !sig || (parts.length === 3 && !intent)) return null;
  const expected = sign(parts.join('.'));

  const given = Buffer.from(sig);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;

  const issuedMs = parseInt(issued, 36);
  if (!Number.isFinite(issuedMs) || Date.now() - issuedMs > STATE_TTL_MS) return null;
  if (!intent) return { link: null };

  const decoded = Buffer.from(intent, 'base64url').toString();
  const sep = decoded.indexOf(':');
  const provider = decoded.slice(0, sep);
  const userId = decoded.slice(sep + 1);
  if (sep < 1 || !userId || (provider !== 'google' && provider !== 'github')) return null;
  return { link: { provider, userId } };
}

/** True iff `state` was produced by `createState` and is within the TTL. */
export function verifyState(state: string | undefined | null): boolean {
  return readState(state) !== null;
}

// ─── Double-submit state cookie ─────────────────────────────────────────────────
//
// The state token is mirrored in a short-lived httpOnly cookie so the callback can
// prove the request came from the same browser that started the flow (defeats a
// CSRF login where an attacker replays their own valid state). The cookie shares
// the refresh cookie's secure/domain settings; `sameSite: lax` lets it ride along
// on the top-level redirect back from the provider.

function stateCookieOptions(): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: config.SESSION_COOKIE_SECURE ?? isProd,
    sameSite: 'lax',
    path: '/',
    ...(config.SESSION_COOKIE_DOMAIN ? { domain: config.SESSION_COOKIE_DOMAIN } : {}),
  };
}

/** Store the outgoing state token in the browser (expires with the state TTL). */
export function setStateCookie(reply: FastifyReply, state: string): void {
  reply.setCookie(STATE_COOKIE_NAME, state, {
    ...stateCookieOptions(),
    maxAge: STATE_TTL_MS / 1000,
  });
}

/** Remove the state cookie once the callback has consumed it. */
export function clearStateCookie(reply: FastifyReply): void {
  reply.clearCookie(STATE_COOKIE_NAME, stateCookieOptions());
}

/**
 * Full CSRF check for an OAuth callback: the `state` query param must match the
 * value stored in the browser cookie (double-submit) **and** be a token we minted
 * that is still within its TTL. Either check alone is insufficient. Returns the
 * state's claims (sign-in or link intent), or null when the check fails.
 */
export function readCallbackState(
  stateParam: string | undefined | null,
  cookies: Record<string, string | undefined>,
): StateClaims | null {
  const cookieState = cookies[STATE_COOKIE_NAME];
  if (!stateParam || !cookieState) return null;

  const given = Buffer.from(stateParam);
  const want = Buffer.from(cookieState);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;

  return readState(stateParam);
}

/** Boolean form of {@link readCallbackState}. */
export function verifyCallbackState(
  stateParam: string | undefined | null,
  cookies: Record<string, string | undefined>,
): boolean {
  return readCallbackState(stateParam, cookies) !== null;
}
