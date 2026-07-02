// Telegram browser-session cookie (auth_tz.md §7).
//
// The deep-link login token is bound to the browser that started the flow. Since the
// user isn't authenticated yet, we mint a random session id at `telegram/init`, store
// it in this short-lived httpOnly cookie, and require the same value back when the
// site polls `telegram/status` — so only the initiating browser can consume the login.
// Attributes mirror the OAuth state cookie (secure per env, `sameSite: lax`).

import type { FastifyReply } from 'fastify';
import type { CookieSerializeOptions } from '@fastify/cookie';
import { config, isProd } from '../config/index.js';

const TG_SESSION_COOKIE_NAME = 'tg_session';
const TG_SESSION_TTL_MS = 10 * 60 * 1000; // matches the login-token TTL

function tgSessionCookieOptions(): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: config.SESSION_COOKIE_SECURE ?? isProd,
    sameSite: 'lax',
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
