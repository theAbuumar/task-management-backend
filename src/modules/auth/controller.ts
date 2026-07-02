import type { FastifyRequest, FastifyReply } from 'fastify';
import * as authService from './service.js';
import { buildGoogleAuthUrl, exchangeGoogleCode } from './google.service.js';
import { buildGithubAuthUrl, exchangeGithubCode } from './github.service.js';
import { config } from '../../config/index.js';
import { AppError } from '../../lib/errors.js';
import {
  setRefreshCookie,
  clearRefreshCookie,
  readRefreshCookie,
} from '../../lib/session-cookie.js';
import {
  createState,
  setStateCookie,
  clearStateCookie,
  verifyCallbackState,
} from '../../lib/oauth-state.js';
import { setTelegramSessionCookie, readTelegramSessionCookie } from '../../lib/telegram-session.js';
import { generateSessionId } from './telegram-login.service.js';
import type { ProviderProfile } from './identity.service.js';
import {
  RegisterBodySchema,
  LoginBodySchema,
  RefreshBodySchema,
  UpdateMeBodySchema,
  EmailSignupBodySchema,
  EmailVerifyBodySchema,
  GoogleCallbackQuerySchema,
  GithubCallbackQuerySchema,
  TelegramStatusQuerySchema,
  TelegramUpdateSchema,
  LinkIdentityParamsSchema,
  UnlinkIdentityParamsSchema,
  LinkIdentityBodySchema,
} from './schema.js';

/** Frontend URL to bounce the browser to after a successful OAuth login. */
function frontendSuccessUrl(accessToken: string): string {
  const url = new URL(config.FRONTEND_URL);
  // Access token in the fragment: never sent to servers, kept out of logs/history.
  // The refresh token rides along separately in the httpOnly cookie.
  url.hash = `access_token=${encodeURIComponent(accessToken)}`;
  return url.toString();
}

/** Frontend URL to bounce the browser to when an OAuth flow fails. */
function frontendErrorUrl(code: string): string {
  const url = new URL(config.FRONTEND_URL);
  url.hash = `error=${encodeURIComponent(code)}`;
  return url.toString();
}

export async function registerHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = RegisterBodySchema.parse(request.body);
  const result = await authService.register(request.server.prisma, body);
  setRefreshCookie(reply, result.refresh_token);
  reply.code(201).send(result);
}

export async function loginHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = LoginBodySchema.parse(request.body);
  const result = await authService.login(request.server.prisma, body);
  setRefreshCookie(reply, result.refresh_token);
  reply.send(result);
}

export async function emailSignupHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = EmailSignupBodySchema.parse(request.body);
  const result = await authService.emailSignup(request.server.prisma, body);
  reply.send(result);
}

export async function emailVerifyHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = EmailVerifyBodySchema.parse(request.body);
  const result = await authService.emailVerify(request.server.prisma, body);
  setRefreshCookie(reply, result.refresh_token);
  reply.send(result);
}

// ─── Google OAuth (auth_tz.md §3) ───────────────────────────────────────────────

export async function googleRedirectHandler(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const state = createState();
  const url = buildGoogleAuthUrl(state);
  setStateCookie(reply, state);
  reply.redirect(url); // 302 by default
}

export async function googleCallbackHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const query = GoogleCallbackQuerySchema.parse(request.query ?? {});

  // The state cookie is single-use regardless of outcome — clear it once we've read it.
  clearStateCookie(reply);

  // User declined consent (or Google reported an error) — bounce back cleanly.
  if (query.error) {
    reply.redirect(frontendErrorUrl(query.error));
    return;
  }

  // CSRF: `state` must match the browser cookie AND be a fresh token we minted.
  if (!verifyCallbackState(query.state, request.cookies)) {
    reply.redirect(frontendErrorUrl('invalid_state'));
    return;
  }

  if (!query.code) {
    reply.redirect(frontendErrorUrl('missing_code'));
    return;
  }

  let result: authService.AuthTokens;
  try {
    const profile = await exchangeGoogleCode(query.code);
    result = await authService.loginWithProvider(request.server.prisma, {
      provider: 'google',
      provider_user_id: profile.sub,
      email: profile.email,
      email_verified: profile.email_verified,
      display_name: profile.name,
      avatar_url: profile.picture,
    });
  } catch (err) {
    request.log.error({ err }, 'Google OAuth callback failed');
    reply.redirect(frontendErrorUrl('google_login_failed'));
    return;
  }

  setRefreshCookie(reply, result.refresh_token);
  reply.redirect(frontendSuccessUrl(result.access_token));
}

// ─── GitHub OAuth (auth_tz.md §4) ───────────────────────────────────────────────

export async function githubRedirectHandler(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const state = createState();
  const url = buildGithubAuthUrl(state);
  setStateCookie(reply, state);
  reply.redirect(url); // 302 by default
}

export async function githubCallbackHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const query = GithubCallbackQuerySchema.parse(request.query ?? {});

  // The state cookie is single-use regardless of outcome — clear it once we've read it.
  clearStateCookie(reply);

  // User declined authorization (or GitHub reported an error) — bounce back cleanly.
  if (query.error) {
    reply.redirect(frontendErrorUrl(query.error));
    return;
  }

  // CSRF: `state` must match the browser cookie AND be a fresh token we minted.
  if (!verifyCallbackState(query.state, request.cookies)) {
    reply.redirect(frontendErrorUrl('invalid_state'));
    return;
  }

  if (!query.code) {
    reply.redirect(frontendErrorUrl('missing_code'));
    return;
  }

  let result: authService.AuthTokens;
  try {
    const profile = await exchangeGithubCode(query.code);
    result = await authService.loginWithProvider(request.server.prisma, {
      provider: 'github',
      provider_user_id: profile.id,
      email: profile.email,
      email_verified: profile.email_verified,
      display_name: profile.name,
      avatar_url: profile.avatar_url,
    });
  } catch (err) {
    request.log.error({ err }, 'GitHub OAuth callback failed');
    reply.redirect(frontendErrorUrl('github_login_failed'));
    return;
  }

  setRefreshCookie(reply, result.refresh_token);
  reply.redirect(frontendSuccessUrl(result.access_token));
}

// ─── Telegram deep-link login (auth_tz.md §7) ───────────────────────────────────

export async function telegramInitHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Bind this handshake to the browser: mint a session id, store it in an httpOnly
  // cookie, and stamp it on the token so only this browser can consume the login.
  const sessionId = generateSessionId();
  const result = await authService.telegramInit(request.server.prisma, sessionId);
  setTelegramSessionCookie(reply, sessionId);
  reply.send(result);
}

export async function telegramWebhookHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // When a webhook secret is configured, only requests carrying the matching header
  // (registered with Telegram's setWebhook) are accepted.
  const expected = config.TELEGRAM_WEBHOOK_SECRET;
  if (expected) {
    const provided = request.headers['x-telegram-bot-api-secret-token'];
    if (provided !== expected) throw AppError.unauthorized('Invalid webhook secret');
  }

  const update = TelegramUpdateSchema.parse(request.body ?? {});
  await authService.handleTelegramUpdate(request.server.prisma, update);
  // Telegram only needs a 200; any per-update failure is reported to the user in-chat.
  reply.send({ ok: true });
}

export async function telegramStatusHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { token } = TelegramStatusQuerySchema.parse(request.query ?? {});
  const sessionId = readTelegramSessionCookie(request.cookies);
  const result = await authService.telegramStatus(request.server.prisma, token, sessionId);
  if (result.status === 'authenticated') {
    setRefreshCookie(reply, result.refresh_token);
  }
  reply.send(result);
}

export async function refreshHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Prefer the httpOnly cookie (browsers); fall back to the body for API/mobile
  // clients that can't use cookies. The token is also returned in the body so
  // those clients can rotate it.
  const { refresh_token: bodyToken } = RefreshBodySchema.parse(request.body ?? {});
  const token = readRefreshCookie(request.cookies) ?? bodyToken;
  if (!token) throw AppError.unauthorized('No refresh token provided');

  const result = await authService.refresh(request.server.prisma, token);
  setRefreshCookie(reply, result.refresh_token);
  reply.send(result);
}

export async function logoutHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { refresh_token: bodyToken } = RefreshBodySchema.parse(request.body ?? {});
  const token = readRefreshCookie(request.cookies) ?? bodyToken;
  if (token) await authService.logout(request.server.prisma, token);
  clearRefreshCookie(reply);
  reply.code(204).send();
}

// ─── Connected-accounts management (auth_tz.md §10) ─────────────────────────────
// All three use the `authenticate` preHandler, so request.userId is set.

export async function listIdentitiesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const identities = await authService.listIdentities(request.server.prisma, request.userId);
  reply.send(identities);
}

export async function linkIdentityHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { provider } = LinkIdentityParamsSchema.parse(request.params);
  const body = LinkIdentityBodySchema.parse(request.body ?? {});
  const { prisma } = request.server;

  // Telegram links from a confirmed login token (bound to this browser session);
  // Google/GitHub links from an OAuth authorization code the client just obtained.
  if (provider === 'telegram') {
    if (!body.token) throw AppError.badRequest('A confirmed Telegram token is required');
    const sessionId = readTelegramSessionCookie(request.cookies);
    const identity = await authService.linkTelegram(prisma, request.userId, body.token, sessionId);
    reply.send(identity);
    return;
  }

  if (!body.code) throw AppError.badRequest('An OAuth authorization code is required');
  let profile: ProviderProfile;
  if (provider === 'google') {
    const g = await exchangeGoogleCode(body.code);
    profile = {
      provider: 'google',
      provider_user_id: g.sub,
      email: g.email,
      email_verified: g.email_verified,
    };
  } else {
    const gh = await exchangeGithubCode(body.code);
    profile = {
      provider: 'github',
      provider_user_id: gh.id,
      email: gh.email,
      email_verified: gh.email_verified,
    };
  }

  const identity = await authService.linkIdentity(prisma, request.userId, profile);
  reply.send(identity);
}

export async function unlinkIdentityHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { provider } = UnlinkIdentityParamsSchema.parse(request.params);
  await authService.unlinkIdentity(request.server.prisma, request.userId, provider);
  reply.code(204).send();
}

// GET /me and PATCH /me use the `authenticate` preHandler (set in routes.ts).
// By the time these handlers run, request.userId is guaranteed to be set.

export async function getMeHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await authService.getMe(request.server.prisma, request.userId);
  reply.send(user);
}

export async function updateMeHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = UpdateMeBodySchema.parse(request.body);
  const user = await authService.updateMe(request.server.prisma, request.userId, body);
  reply.send(user);
}
