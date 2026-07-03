// Telegram browser-session cookie (auth_tz.md §7).
//
// The deep-link login token is bound to the browser that started the flow. Since the
// user isn't authenticated yet, we mint a random session id at `telegram/init`, store
// it in this short-lived httpOnly cookie, and require the same value back when the
// site polls `telegram/status` — so only the initiating browser can consume the login.
// SameSite follows SESSION_COOKIE_SAMESITE (like the refresh cookie): a cross-origin
// SPA polls via fetch, so that deployment must set it to `none` (Secure) or the
// cookie won't be sent back and the session-binding check fails.

import type { FastifyReply } from 'fastify';
import type { CookieSerializeOptions } from '@fastify/cookie';
import { config, isProd } from '../config/index.js';

const TG_SESSION_COOKIE_NAME = 'tg_session';
const TG_SESSION_TTL_MS = 10 * 60 * 1000; // matches the login-token TTL

function tgSessionCookieOptions(): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: config.SESSION_COOKIE_SECURE ?? isProd,
    // The site polls `telegram/status` via fetch/XHR; when the SPA is on a different
    // origin than the API that is a cross-site request, so the cookie must be
    // `SameSite=None` (with Secure) to be sent back. Mirror the refresh cookie's
    // configured policy — set SESSION_COOKIE_SAMESITE=none for a cross-origin SPA.
    sameSite: config.SESSION_COOKIE_SAMESITE,
    path: '/',
    ...(config.SESSION_COOKIE_DOMAIN ? { domain: config.SESSION_COOKIE_DOMAIN } : {}),
  };
}

/** Store the browser-session id (expires with the login-token TTL). */
export function setTelegramSessionCookie(reply: FastifyReply, sessionId: string): void {
  reply.setCookie(TG_SESSION_COOKIE_NAME, sessionId, {
    ...tgSessionCookieOptions(),
    maxAge: TG_SESSION_TTL_MS / 1000,
  });
}

/** Read the browser-session id from the request cookies, if present. */
export function readTelegramSessionCookie(
  cookies: Record<string, string | undefined>,
): string | undefined {
  return cookies[TG_SESSION_COOKIE_NAME];
}
