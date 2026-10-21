import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { writeAudit } from '../../lib/audit.js';
import { exportMyData } from './data-export.js';
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
  passwordCodeRouteSchema,
  passwordSetRouteSchema,
  passwordChangeRouteSchema,
  ldapLoginRouteSchema,
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
  passwordCodeHandler,
  passwordSetHandler,
  passwordChangeHandler,
  ldapLoginHandler,
} from './controller.js';

// Per-IP rate limit for the sensitive auth endpoints — credential submission and
// login-token minting (@fastify/rate-limit is registered globally-disabled in
// app.ts, so only these opt in). This is the per-IP backstop; the per-email OTP
// throttle in otp.service is the separate business rule. Deliberately NOT applied
// to `/telegram/status` (polled ~every 2s while the user confirms) or the Telegram
// webhook (Telegram calls it, guarded by its secret header instead).
const authRateLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } };

// A browser renews and ends its session with the httpOnly cookie alone and may send
// no body at all; the body schema (refresh_token for API clients) would reject that
// with 400 — sign-out then silently left the session alive (found by E2E, 12.F2).
async function bodyOptional(request: FastifyRequest): Promise<void> {
  request.body ??= {};
}

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
  // University account: LDAP / Active Directory (12.B10), only with LDAP_URL set.
  app.post(
    '/ldap/login',
    { schema: ldapLoginRouteSchema, config: authRateLimit },
    ldapLoginHandler,
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
  app.post(
    '/refresh',
    { schema: refreshRouteSchema, config: authRateLimit, preValidation: bodyOptional },
    refreshHandler,
  );
  app.post('/logout', { schema: logoutRouteSchema, preValidation: bodyOptional }, logoutHandler);
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
  // A password as an additional sign-in method (12.B12): set by a code, change with
  // the current one.
  app.post(
    '/password/code',
    {
      schema: passwordCodeRouteSchema,
      preHandler: [authenticate],
      preValidation: bodyOptional,
      config: authRateLimit,
    },
    passwordCodeHandler,
  );
  app.post(
    '/password/set',
    { schema: passwordSetRouteSchema, preHandler: [authenticate], config: authRateLimit },
    passwordSetHandler,
  );
  app.post(
    '/password/change',
    { schema: passwordChangeRouteSchema, preHandler: [authenticate], config: authRateLimit },
    passwordChangeHandler,
  );
  app.get('/me', { schema: getMeRouteSchema, preHandler: [authenticate] }, getMeHandler);
  app.patch('/me', { schema: updateMeRouteSchema, preHandler: [authenticate] }, updateMeHandler);

  // «Скачать мои данные» (12.B13): everything kept about the caller, as a JSON file.
  app.get(
    '/me/export',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Download my personal data (JSON file)',
        description: [
          'Everything the system keeps about the caller: profile, sign-in methods and sessions, workspaces,',
          'issues they created, are assigned to, control or watch (by key and title), their comments, attachments',
          '(names only), review reports and deadline requests, notifications, AI dialogues and usage, and their own',
          'audit-log entries. No secrets (password hash, codes, tokens) and no texts of other people.',
          'Sent as an attachment; written to the audit log as `user.data_exported`. 5 per minute per IP.',
        ].join(' '),
        security: [{ bearerAuth: [] }],
      },
      preHandler: [authenticate],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const data = await exportMyData(app.prisma, request.userId);
      await writeAudit(
        app.prisma,
        {
          actor_id: request.userId,
          action: 'user.data_exported',
          target_type: 'user',
          target_id: request.userId,
        },
        request,
      );
      const day = new Date().toISOString().slice(0, 10);
      return reply
        .header('Content-Type', 'application/json; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(`Мои данные ${day}.json`)}`,
        )
        .header('Cache-Control', 'no-store')
        .send(JSON.stringify(data, null, 2));
    },
  );
}
