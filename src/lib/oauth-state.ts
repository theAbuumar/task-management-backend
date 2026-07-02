// OAuth `state` parameter — CSRF protection for the redirect flows (auth_tz.md §9).
//
// Stateless design: a random nonce plus the time it was issued, authenticated by an
// HMAC keyed on the access-token secret. The route puts the token in the outgoing
// `state` query param (and typically mirrors it in a short-lived cookie); on callback
// `verifyState` checks the signature and freshness — no server-side storage needed.
//
// This only proves the callback's `state` was minted by us and is recent. Binding it
// to the specific browser (double-submit cookie) is the route's job on top of this.

import crypto from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { CookieSerializeOptions } from '@fastify/cookie';
import { config, isProd } from '../config/index.js';

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const STATE_COOKIE_NAME = 'oauth_state';

function sign(payload: string): string {
  return crypto.createHmac('sha256', config.JWT_ACCESS_SECRET).update(payload).digest('base64url');
}

/** Mint a fresh, self-authenticating state token. */
export function createState(): string {
  const nonce = crypto.randomBytes(16).toString('base64url');
  const issued = Date.now().toString(36);
  const payload = `${nonce}.${issued}`;
  return `${payload}.${sign(payload)}`;
}

/** True iff `state` was produced by `createState` and is within the TTL. */
export function verifyState(state: string | undefined | null): boolean {
  if (!state) return false;
  const parts = state.split('.');
  if (parts.length !== 3) return false;
  const [nonce, issued, sig] = parts;
  if (!nonce || !issued || !sig) return false;
  const expected = sign(`${nonce}.${issued}`);

  const given = Buffer.from(sig);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return false;

  const issuedMs = parseInt(issued, 36);
  if (!Number.isFinite(issuedMs)) return false;
  return Date.now() - issuedMs <= STATE_TTL_MS;
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
 * that is still within its TTL. Either check alone is insufficient.
 */
export function verifyCallbackState(
  stateParam: string | undefined | null,
  cookies: Record<string, string | undefined>,
): boolean {
  const cookieState = cookies[STATE_COOKIE_NAME];
  if (!stateParam || !cookieState) return false;

  const given = Buffer.from(stateParam);
  const want = Buffer.from(cookieState);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return false;

  return verifyState(stateParam);
}
