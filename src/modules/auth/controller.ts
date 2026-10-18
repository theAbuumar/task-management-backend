import type { FastifyRequest, FastifyReply } from 'fastify';
import { auditLogin, writeAudit } from '../../lib/audit.js';
import { verifyRefreshToken } from '../../lib/jwt.js';
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
  readCallbackState,
  type LinkIntent,
  type LinkProvider,
  type StateClaims,
} from '../../lib/oauth-state.js';
import { frontendUrl } from '../../lib/urls.js';
import { setTelegramSessionCookie, readTelegramSessionCookie } from '../../lib/telegram-session.js';
import { generateSessionId } from './telegram-login.service.js';
import {
  listSessions,
  recordSessionClient,
  revokeOtherSessions,
  revokeSession,
  sessionIdOf,
  type SessionClient,
} from './sessions.service.js';
import type { ProviderProfile } from './identity.service.js';
import {
  RegisterBodySchema,
  LoginBodySchema,
  RefreshBodySchema,
  UpdateMeBodySchema,
  EmailSignupBodySchema,
  EmailVerifyBodySchema,
  EmailOtpRequestBodySchema,
  EmailOtpVerifyBodySchema,
  AccountDeleteConfirmBodySchema,
  GoogleCallbackQuerySchema,
  GithubCallbackQuerySchema,
  TelegramStatusQuerySchema,
  TelegramUpdateSchema,
  LinkIdentityParamsSchema,
  UnlinkIdentityParamsSchema,
  LinkIdentityBodySchema,
  LinkStartParamsSchema,
  SessionParamsSchema,
} from './schema.js';

/** The device a request came from, as stored on its session (Ф12 12.B2). */
function clientOf(request: FastifyRequest): SessionClient {
  return { ip: request.ip ?? null, user_agent: request.headers['user-agent'] ?? null };
}

/**
 * Every completed sign-in ends here: the new session learns its device and method,
 * the audit log gets `auth.login`, the browser gets the refresh cookie.
 */
export async function beginSession(
  request: FastifyRequest,
  reply: FastifyReply,
  result: authService.AuthTokens,
  method: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await recordSessionClient(request.server.prisma, sessionIdOf(result), clientOf(request), method);
  await auditLogin(request, result.user.id, method, extra);
  setRefreshCookie(reply, result.refresh_token);
}

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

/** Where a link flow (ADR-025) ends: the profile, with `#linked=…` or `#link_error=…`. */
function frontendLinkUrl(outcome: { linked: LinkProvider } | { error: string }): string {
  const url = new URL(frontendUrl('profile'));
  url.hash =
    'linked' in outcome
      ? `linked=${outcome.linked}`
      : `link_error=${encodeURIComponent(outcome.error)}`;
  return url.toString();
}

/**
 * The checks every OAuth callback shares (consent error, CSRF state, code). Returns
 * the verified state claims and the code, or null after redirecting the browser:
 * a link flow goes back to the profile, a sign-in to the login page.
 */
function checkCallback(
  provider: LinkProvider,
  query: { code?: string; state?: string; error?: string },
  request: FastifyRequest,
  reply: FastifyReply,
): { claims: StateClaims; code: string } | null {
  const claims = readCallbackState(query.state, request.cookies);
  // The state cookie is single-use regardless of outcome — clear it once we've read it.
  clearStateCookie(reply);
  const bounce = (code: string) =>
    reply.redirect(claims?.link ? frontendLinkUrl({ error: code }) : frontendErrorUrl(code));

  // User declined consent (or the provider reported an error) — bounce back cleanly.
  if (query.error) {
    bounce(query.error);
    return null;
  }
  // CSRF: `state` must match the browser cookie AND be a fresh token we minted —
  // for this provider when it is a link (a Google link state is no GitHub one).
  if (!claims || (claims.link && claims.link.provider !== provider)) {
    bounce('invalid_state');
    return null;
  }
  if (!query.code) {
    bounce('missing_code');
    return null;
  }
  return { claims, code: query.code };
}

/**
 * End of a link flow (ADR-025): attach the provider account to the user who started
 * it from the profile. Nothing is signed in or out; the browser goes back to the
 * profile. An account already linked to someone else is refused, never moved.
 */
async function finishLink(
  request: FastifyRequest,
  reply: FastifyReply,
  link: LinkIntent,
  resolve: () => Promise<ProviderProfile>,
): Promise<void> {
  try {
    const identity = await authService.linkIdentity(
      request.server.prisma,
      link.userId,
      await resolve(),
    );
    await writeAudit(
      request.server.prisma,
      {
        actor_id: link.userId,
        action: 'auth.identity_linked',
        target_type: 'user',
        target_id: link.userId,
        meta: { provider: identity.provider },
      },
      request,
    );
    reply.redirect(frontendLinkUrl({ linked: link.provider }));
  } catch (err) {
    const conflict = err instanceof AppError && err.statusCode === 409;
    if (!conflict) request.log.error({ err }, `${link.provider} link callback failed`);
    reply.redirect(
      frontendLinkUrl({
        error: conflict ? 'linked_to_other_account' : `${link.provider}_link_failed`,
      }),
    );
  }
}

export async function registerHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = RegisterBodySchema.parse(request.body);
  const result = await authService.register(request.server.prisma, body);
  await beginSession(request, reply, result, 'password', { signup: true });
  reply.code(201).send(result);
}

export async function loginHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = LoginBodySchema.parse(request.body);
  const result = await authService.login(request.server.prisma, body);
  await beginSession(request, reply, result, 'password');
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
  await beginSession(request, reply, result, 'email_code', { signup: true });
  reply.send(result);
}

export async function emailOtpRequestHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = EmailOtpRequestBodySchema.parse(request.body);
  const result = await authService.emailOtpRequest(request.server.prisma, body);
  reply.send(result);
}

export async function emailOtpVerifyHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = EmailOtpVerifyBodySchema.parse(request.body);
  const result = await authService.emailOtpVerify(request.server.prisma, body);
  await beginSession(request, reply, result, 'email_code');
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
  const checked = checkCallback('google', query, request, reply);
  if (!checked) return;
  const { claims, code } = checked;

  if (claims.link) {
    await finishLink(request, reply, claims.link, async () => googleIdentity(code));
    return;
  }

  let result: authService.AuthTokens;
  try {
    const profile = await exchangeGoogleCode(code);
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

  await beginSession(request, reply, result, 'google');
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
  const checked = checkCallback('github', query, request, reply);
  if (!checked) return;
  const { claims, code } = checked;

  if (claims.link) {
    await finishLink(request, reply, claims.link, async () => githubIdentity(code));
    return;
  }

  let result: authService.AuthTokens;
  try {
    const profile = await exchangeGithubCode(code);
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

  await beginSession(request, reply, result, 'github');
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
  await authService.handleTelegramUpdate(request.server.prisma, request.server.storage, update);
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
    await beginSession(request, reply, result, 'telegram');
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
  await recordSessionClient(request.server.prisma, sessionIdOf(result), clientOf(request));
  setRefreshCookie(reply, result.refresh_token);
  reply.send(result);
}

/** Who a refresh token belonged to (for the audit log), or null if it is not valid. */
function refreshTokenOwner(token: string): string | null {
  try {
    return verifyRefreshToken(token).sub;
  } catch {
    return null;
  }
}

export async function logoutHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { refresh_token: bodyToken } = RefreshBodySchema.parse(request.body ?? {});
  const token = readRefreshCookie(request.cookies) ?? bodyToken;
  if (token) {
    await authService.logout(request.server.prisma, token);
    const userId = refreshTokenOwner(token);
    if (userId) {
      await writeAudit(
        request.server.prisma,
        { actor_id: userId, action: 'auth.logout', target_type: 'user', target_id: userId },
        request,
      );
    }
  }
  clearRefreshCookie(reply);
  reply.code(204).send();
}

// ─── Sign-in sessions (Ф12 12.B2) ───────────────────────────────────────────────
// All three use the `authenticate` preHandler, so request.userId and sessionId are set.

export async function listSessionsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const data = await listSessions(request.server.prisma, request.userId, request.sessionId);
  reply.send({ data });
}

export async function revokeSessionHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = SessionParamsSchema.parse(request.params);
  await revokeSession(request.server.prisma, request.userId, id);
  await writeAudit(
    request.server.prisma,
    {
      actor_id: request.userId,
      action: 'auth.session_revoked',
      target_type: 'user',
      target_id: request.userId,
      meta: { session_id: id, current: id === request.sessionId },
    },
    request,
  );
  request.server.realtime.disconnect(request.userId, [id]);
  // Ending the session you are using is signing out of it.
  if (id === request.sessionId) clearRefreshCookie(reply);
  reply.code(204).send();
}

export async function revokeOtherSessionsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const ids = await revokeOtherSessions(request.server.prisma, request.userId, request.sessionId);
  if (ids.length > 0) {
    await writeAudit(
      request.server.prisma,
      {
        actor_id: request.userId,
        action: 'auth.sessions_revoked',
        target_type: 'user',
        target_id: request.userId,
        meta: { count: ids.length },
      },
      request,
    );
    request.server.realtime.disconnect(request.userId, ids);
  }
  reply.send({ revoked: ids.length });
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
  const profile =
    provider === 'google' ? await googleIdentity(body.code) : await githubIdentity(body.code);

  const identity = await authService.linkIdentity(prisma, request.userId, profile);
  reply.send(identity);
}

/** The Google account behind an authorization code, as an identity to link. */
async function googleIdentity(code: string): Promise<ProviderProfile> {
  const g = await exchangeGoogleCode(code);
  return {
    provider: 'google',
    provider_user_id: g.sub,
    email: g.email,
    email_verified: g.email_verified,
  };
}

/** The GitHub account behind an authorization code, as an identity to link. */
async function githubIdentity(code: string): Promise<ProviderProfile> {
  const gh = await exchangeGithubCode(code);
  return {
    provider: 'github',
    provider_user_id: gh.id,
    email: gh.email,
    email_verified: gh.email_verified,
  };
}

/**
 * Start linking Google/GitHub from the profile (ADR-025): a state that names the
 * signed-in user, mirrored in the browser cookie, and the provider's consent URL
 * for the client to navigate to. The provider's callback then links, not signs in.
 */
export async function linkStartHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { provider } = LinkStartParamsSchema.parse(request.params);
  const state = createState({ provider, userId: request.userId });
  // Built first: throws 400 when the provider isn't configured on this deployment.
  const url = provider === 'google' ? buildGoogleAuthUrl(state) : buildGithubAuthUrl(state);
  setStateCookie(reply, state);
  reply.send({ url });
}

export async function unlinkIdentityHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { provider } = UnlinkIdentityParamsSchema.parse(request.params);
  await authService.unlinkIdentity(request.server.prisma, request.userId, provider);
  await writeAudit(
    request.server.prisma,
    {
      actor_id: request.userId,
      action: 'auth.identity_unlinked',
      target_type: 'user',
      target_id: request.userId,
      meta: { provider },
    },
    request,
  );
  reply.code(204).send();
}

// ─── Code-confirmed account deletion ────────────────────────────────────────────
// Both require the `authenticate` preHandler, so request.userId is set.

export async function accountDeleteRequestHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const result = await authService.requestAccountDeletion(request.server.prisma, request.userId);
  reply.send(result);
}

export async function accountDeleteConfirmHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = AccountDeleteConfirmBodySchema.parse(request.body);
  await authService.confirmAccountDeletion(
    request.server.prisma,
    request.server.storage,
    request.userId,
    body,
  );
  // The account's sessions are revoked server-side; clear the browser's cookie too.
  clearRefreshCookie(reply);
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
  const user = await authService.updateMe(
    request.server.prisma,
    request.server.storage,
    request.userId,
    body,
  );
  reply.send(user);
}
