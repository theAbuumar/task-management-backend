import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import {
  registerRouteSchema,
  loginRouteSchema,
  refreshRouteSchema,
  logoutRouteSchema,
  getMeRouteSchema,
  updateMeRouteSchema,
  emailSignupRouteSchema,
  emailVerifyRouteSchema,
  emailLoginRouteSchema,
  emailOtpRequestRouteSchema,
  emailOtpVerifyRouteSchema,
  accountDeleteRequestRouteSchema,
  accountDeleteConfirmRouteSchema,
  googleRedirectRouteSchema,
  googleCallbackRouteSchema,
  githubRedirectRouteSchema,
  githubCallbackRouteSchema,
  telegramInitRouteSchema,
  telegramWebhookRouteSchema,
  telegramStatusRouteSchema,
  listIdentitiesRouteSchema,
  linkIdentityRouteSchema,
  linkStartRouteSchema,
  unlinkIdentityRouteSchema,
  listSessionsRouteSchema,
  revokeSessionRouteSchema,
  revokeOtherSessionsRouteSchema,
} from './schema.js';
import {
  registerHandler,
  loginHandler,
  refreshHandler,
  logoutHandler,
  getMeHandler,
  updateMeHandler,
  emailSignupHandler,
  emailVerifyHandler,
  emailOtpRequestHandler,
  emailOtpVerifyHandler,
  accountDeleteRequestHandler,
  accountDeleteConfirmHandler,
  googleRedirectHandler,
  googleCallbackHandler,
  githubRedirectHandler,
  githubCallbackHandler,
  telegramInitHandler,
  telegramWebhookHandler,
  telegramStatusHandler,
  listIdentitiesHandler,
  linkIdentityHandler,
  linkStartHandler,
  unlinkIdentityHandler,
  listSessionsHandler,
  revokeSessionHandler,
  revokeOtherSessionsHandler,
} from './controller.js';

// Per-IP rate limit for the sensitive auth endpoints — credential submission and
// login-token minting (@fastify/rate-limit is registered globally-disabled in
// app.ts, so only these opt in). This is the per-IP backstop; the per-email OTP
// throttle in otp.service is the separate business rule. Deliberately NOT applied
// to `/telegram/status` (polled ~every 2s while the user confirms) or the Telegram
// webhook (Telegram calls it, guarded by its secret header instead).
const authRateLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } };

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/register', { schema: registerRouteSchema, config: authRateLimit }, registerHandler);
  app.post('/login', { schema: loginRouteSchema, config: authRateLimit }, loginHandler);
  // Email + password with OTP verification (auth_tz.md §6).
  app.post(
    '/email/signup',
    { schema: emailSignupRouteSchema, config: authRateLimit },
    emailSignupHandler,
  );
  app.post(
    '/email/verify',
    { schema: emailVerifyRouteSchema, config: authRateLimit },
    emailVerifyHandler,
  );
  app.post('/email/login', { schema: emailLoginRouteSchema, config: authRateLimit }, loginHandler);
  // Passwordless email sign-in: one code, no password (primary email flow for the SPA).
  app.post(
    '/email/otp/request',
    { schema: emailOtpRequestRouteSchema, config: authRateLimit },
    emailOtpRequestHandler,
  );
  app.post(
    '/email/otp/verify',
    { schema: emailOtpVerifyRouteSchema, config: authRateLimit },
    emailOtpVerifyHandler,
  );
  // Google OAuth 2.0 (auth_tz.md §3).
  app.get('/google', { schema: googleRedirectRouteSchema }, googleRedirectHandler);
  app.get('/google/callback', { schema: googleCallbackRouteSchema }, googleCallbackHandler);
  // GitHub OAuth 2.0 (auth_tz.md §4).
  app.get('/github', { schema: githubRedirectRouteSchema }, githubRedirectHandler);
  app.get('/github/callback', { schema: githubCallbackRouteSchema }, githubCallbackHandler);
  // Telegram deep-link login (auth_tz.md §7).
  app.post(
    '/telegram/init',
    { schema: telegramInitRouteSchema, config: authRateLimit },
    telegramInitHandler,
  );
  app.post('/telegram/webhook', { schema: telegramWebhookRouteSchema }, telegramWebhookHandler);
  app.get('/telegram/status', { schema: telegramStatusRouteSchema }, telegramStatusHandler);
  app.post('/refresh', { schema: refreshRouteSchema, config: authRateLimit }, refreshHandler);
  app.post('/logout', { schema: logoutRouteSchema }, logoutHandler);
  // Code-confirmed account deletion — both require a session; rate-limited like the
  // other sensitive endpoints (per-email OTP throttle in otp.service applies too).
  app.post(
    '/account/delete/request',
    { schema: accountDeleteRequestRouteSchema, preHandler: [authenticate], config: authRateLimit },
    accountDeleteRequestHandler,
  );
  app.post(
    '/account/delete/confirm',
    { schema: accountDeleteConfirmRouteSchema, preHandler: [authenticate], config: authRateLimit },
    accountDeleteConfirmHandler,
  );
  // Connected-accounts management (auth_tz.md §10) — all require a session.
  app.get(
    '/identities',
    { schema: listIdentitiesRouteSchema, preHandler: [authenticate] },
    listIdentitiesHandler,
  );
  app.post(
    '/identities/:provider/link',
    { schema: linkIdentityRouteSchema, preHandler: [authenticate] },
    linkIdentityHandler,
  );
  // Google/GitHub from the profile (ADR-025): the provider callback links, not signs in.
  app.post(
    '/identities/:provider/link/start',
    { schema: linkStartRouteSchema, preHandler: [authenticate], config: authRateLimit },
    linkStartHandler,
  );
  app.delete(
    '/identities/:provider',
    { schema: unlinkIdentityRouteSchema, preHandler: [authenticate] },
    unlinkIdentityHandler,
  );
  // «Мои сессии» (Ф12 12.B2) — where the account is signed in; ending sessions.
  app.get(
    '/sessions',
    { schema: listSessionsRouteSchema, preHandler: [authenticate] },
    listSessionsHandler,
  );
  app.post(
    '/sessions/revoke-all',
    { schema: revokeOtherSessionsRouteSchema, preHandler: [authenticate], config: authRateLimit },
    revokeOtherSessionsHandler,
  );
  app.delete(
    '/sessions/:id',
    { schema: revokeSessionRouteSchema, preHandler: [authenticate] },
    revokeSessionHandler,
  );
  app.get('/me', { schema: getMeRouteSchema, preHandler: [authenticate] }, getMeHandler);
  app.patch('/me', { schema: updateMeRouteSchema, preHandler: [authenticate] }, updateMeHandler);
}
