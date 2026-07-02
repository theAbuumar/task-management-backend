// Refresh-token cookie helpers (auth_tz.md §8).
//
// The refresh token is delivered to browsers as an httpOnly cookie so client-side
// JS can never read it. `/auth/refresh` and `/auth/logout` read it back from the
// cookie. Every attribute is derived from validated env (see config/env.ts) and
// is shared by all auth flows (email now; OAuth/Telegram callbacks in later
// phases) so the cookie is always set/cleared with identical options.

import type { FastifyReply } from 'fastify';
import type { CookieSerializeOptions } from '@fastify/cookie';
import { config, isProd } from '../config/index.js';
import { parseDurationSeconds } from './duration.js';

/**
 * Base cookie attributes. `clearCookie` must use the same domain/path/sameSite as
 * `setCookie` or the browser won't match and remove the cookie, so both go
 * through here.
 */
function baseCookieOptions(): CookieSerializeOptions {
  return {
    httpOnly: true,
    // Default Secure on outside development; an explicit env value always wins.
    secure: config.SESSION_COOKIE_SECURE ?? isProd,
    sameSite: config.SESSION_COOKIE_SAMESITE,
    path: '/',
    ...(config.SESSION_COOKIE_DOMAIN ? { domain: config.SESSION_COOKIE_DOMAIN } : {}),
  };
}

/** Attach the (rotating) refresh token as an httpOnly cookie on the response. */
export function setRefreshCookie(reply: FastifyReply, refreshToken: string): void {
  reply.setCookie(config.SESSION_COOKIE_NAME, refreshToken, {
    ...baseCookieOptions(),
    maxAge: parseDurationSeconds(config.JWT_REFRESH_TTL),
  });
}

/** Remove the refresh cookie (logout). Mirrors the attributes used when setting it. */
export function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(config.SESSION_COOKIE_NAME, baseCookieOptions());
}

/** Read the refresh token from the request cookies, if present. */
export function readRefreshCookie(cookies: Record<string, string | undefined>): string | undefined {
  return cookies[config.SESSION_COOKIE_NAME];
}
