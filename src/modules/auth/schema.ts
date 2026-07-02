import { z } from 'zod';
import type { FastifySchema } from 'fastify';
import { PASSWORD_MIN_LENGTH, passwordSchema } from '../../lib/password.js';

// ─── Zod validators ──────────────────────────────────────────────────────────

export const RegisterBodySchema = z.object({
  email: z.string().email(),
  password: passwordSchema,
  display_name: z.string().min(1).max(100),
  // Clients (e.g. HTML forms) often send an empty string when the user leaves
  // the invite field blank. Treat "" / whitespace as "no invite" so a normal
  // first-time signup succeeds; a non-empty value must still be a valid UUID.
  invite_token: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().uuid().optional(),
  ),
});

export const LoginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// `refresh_token` is optional: browsers send it via the httpOnly cookie, so the
// body may be empty. The controller enforces "cookie or body must be present".
export const RefreshBodySchema = z.object({
  refresh_token: z.string().min(1).optional(),
});

export const UpdateMeBodySchema = z.object({
  display_name: z.string().min(1).max(100).optional(),
  avatar_url: z.string().url().optional().nullable(),
});

// Email+password signup — same fields as register, but no invite_token (OTP flow).
export const EmailSignupBodySchema = z.object({
  email: z.string().email(),
  password: passwordSchema,
  display_name: z.string().min(1).max(100),
});

// Confirm a signup OTP: the email it was sent to + the 6-digit code.
export const EmailVerifyBodySchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
});

// Google OAuth callback query params. All optional: Google sends `code` + `state`
// on success, or `error` (e.g. `access_denied`) when the user declines consent.
export const GoogleCallbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
});

// GitHub OAuth callback query params — same shape as Google (`code`+`state` on
// success, `error` on denial).
export const GithubCallbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
});

// Telegram deep-link login (auth_tz.md §7).
// The status poll carries the login token as a query param.
export const TelegramStatusQuerySchema = z.object({
  token: z.string().min(1),
});

// A Telegram webhook Update — only the fields the bot handler consumes are typed;
// `passthrough` keeps the rest so validation never rejects a well-formed update.
const TelegramUserSchema = z.object({
  id: z.number(),
  first_name: z.string().optional(),
  username: z.string().optional(),
});
export const TelegramUpdateSchema = z
  .object({
    message: z
      .object({
        chat: z.object({ id: z.number() }),
        from: TelegramUserSchema.optional(),
        text: z.string().optional(),
      })
      .optional(),
    callback_query: z
      .object({
        id: z.string(),
        from: TelegramUserSchema,
        data: z.string().optional(),
        message: z
          .object({ chat: z.object({ id: z.number() }), message_id: z.number() })
          .optional(),
      })
      .optional(),
  })
  .passthrough();

// ─── Connected-accounts management (auth_tz.md §10) ────────────────────────────

// Which login method a link/unlink request targets. Linking only makes sense for
// OAuth/Telegram (email = "set a password", out of scope here); unlinking may
// target any linked method, subject to the last-method guard in the service.
export const LinkIdentityParamsSchema = z.object({
  provider: z.enum(['google', 'github', 'telegram']),
});
export const UnlinkIdentityParamsSchema = z.object({
  provider: z.enum(['email', 'google', 'github', 'telegram']),
});

// Proof that the caller controls the identity being linked: an OAuth authorization
// `code` (Google/GitHub), or a confirmed Telegram login `token`. Exactly one is
// required depending on the path provider — the controller enforces which.
export const LinkIdentityBodySchema = z.object({
  code: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
});

export type RegisterBody = z.infer<typeof RegisterBodySchema>;
export type LoginBody = z.infer<typeof LoginBodySchema>;
export type RefreshBody = z.infer<typeof RefreshBodySchema>;
export type UpdateMeBody = z.infer<typeof UpdateMeBodySchema>;
export type EmailSignupBody = z.infer<typeof EmailSignupBodySchema>;
export type EmailVerifyBody = z.infer<typeof EmailVerifyBodySchema>;
export type GoogleCallbackQuery = z.infer<typeof GoogleCallbackQuerySchema>;
export type GithubCallbackQuery = z.infer<typeof GithubCallbackQuerySchema>;
export type TelegramStatusQuery = z.infer<typeof TelegramStatusQuerySchema>;
export type LinkIdentityParams = z.infer<typeof LinkIdentityParamsSchema>;
export type UnlinkIdentityParams = z.infer<typeof UnlinkIdentityParamsSchema>;
export type LinkIdentityBody = z.infer<typeof LinkIdentityBodySchema>;

// ─── Fastify route schemas (for OpenAPI + request validation) ─────────────────

const userShape = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    email: { type: 'string', nullable: true },
    email_verified: { type: 'boolean' },
    display_name: { type: 'string' },
    avatar_url: { type: 'string', nullable: true },
    is_active: { type: 'boolean' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
} as const;

const tokenPair = {
  type: 'object',
  properties: {
    access_token: { type: 'string' },
    refresh_token: { type: 'string' },
    user: userShape,
  },
} as const;

// Standard error envelope (TZ §8). Attached as the `default` response on every auth
// route via `responses()` below, so every endpoint documents its failure shape.
// `additionalProperties: true` on `error` lets the optional `details` field
// serialize through untouched (it is unstructured — validation issues, requestId, …).
const errorResponse = {
  type: 'object',
  description: 'Error envelope: `{ error: { code, message, details? } }`',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['code', 'message'],
      additionalProperties: true,
    },
  },
} as const;

/**
 * Merge a route's success responses with the shared `default` error envelope so
 * OpenAPI documents both, and Fastify serializes any error status through it.
 */
function responses(map: Record<string, unknown>): Record<string, unknown> {
  return { ...map, default: errorResponse };
}

export const registerRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'Register a new user (optionally with an invite_token to auto-join a workspace)',
  description:
    'Creates an email+password account directly and issues a session (sets the refresh cookie). This is the classic register path; the OTP-verified flow is `/auth/email/signup` → `/auth/email/verify`.',
  body: {
    type: 'object',
    required: ['email', 'password', 'display_name'],
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string', minLength: PASSWORD_MIN_LENGTH },
      display_name: { type: 'string', minLength: 1, maxLength: 100 },
      // No `format: uuid` here so an empty string from a form isn't rejected at
      // the Fastify layer — the Zod schema normalizes "" to "no invite" and
      // still enforces UUID format for any real token.
      invite_token: { type: 'string' },
    },
  },
  response: responses({
    201: tokenPair,
  }),
};

export const loginRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'Login with email and password',
  description:
    'Honest "invalid email or password" on miss (no account enumeration). Accounts with no password are guided to their OAuth provider; unverified accounts are guided to verify first. Sets the refresh cookie on success. Alias of `/auth/email/login`.',
  body: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string', minLength: 1 },
    },
  },
  response: responses({
    200: tokenPair,
  }),
};

const otpChallenge = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['otp_sent'] },
    email: { type: 'string' },
  },
} as const;

export const emailSignupRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'Start email+password signup — creates an inactive account and emails a 6-digit OTP',
  description:
    'Creates the account inactive + unverified and sends a verification code. If the email already exists it is not duplicated; a code is still sent so the owner can verify into the existing account.',
  body: {
    type: 'object',
    required: ['email', 'password', 'display_name'],
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string', minLength: PASSWORD_MIN_LENGTH },
      display_name: { type: 'string', minLength: 1, maxLength: 100 },
    },
  },
  response: responses({
    200: otpChallenge,
  }),
};

export const emailVerifyRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'Confirm a signup OTP — verifies + activates the account and issues a session',
  body: {
    type: 'object',
    required: ['email', 'code'],
    properties: {
      email: { type: 'string', format: 'email' },
      code: { type: 'string', pattern: '^\\d{6}$' },
    },
  },
  response: responses({
    200: tokenPair,
  }),
};

export const emailLoginRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'Login with email and password',
  description:
    'Honest "invalid email or password" on miss. Accounts with no password are guided to their OAuth provider; unverified accounts are guided to verify first.',
  body: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string', minLength: 1 },
    },
  },
  response: responses({
    200: tokenPair,
  }),
};

export const googleRedirectRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'Begin Google OAuth — redirects to the Google consent screen',
  description:
    'Mints a CSRF `state`, stores it in a short-lived httpOnly cookie, and 302-redirects the browser to Google.',
  response: responses({
    302: { type: 'null', description: 'Redirect to Google' },
  }),
};

export const googleCallbackRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'Google OAuth callback — verifies state, exchanges the code, issues a session',
  description:
    'Verifies the `state` against the browser cookie (CSRF), exchanges the authorization code for the Google profile, find-or-creates the account (auto-merging by verified email), sets the refresh cookie and redirects to the frontend with an access token in the URL fragment. Failures redirect to the frontend with an `error` fragment.',
  querystring: {
    type: 'object',
    properties: {
      code: { type: 'string' },
      state: { type: 'string' },
      error: { type: 'string' },
    },
  },
  response: responses({
    302: { type: 'null', description: 'Redirect to the frontend (or an error page)' },
  }),
};

export const githubRedirectRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'Begin GitHub OAuth — redirects to the GitHub authorize screen',
  description:
    'Mints a CSRF `state`, stores it in a short-lived httpOnly cookie, and 302-redirects the browser to GitHub (scope `read:user user:email`).',
  response: responses({
    302: { type: 'null', description: 'Redirect to GitHub' },
  }),
};

export const githubCallbackRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'GitHub OAuth callback — verifies state, exchanges the code, issues a session',
  description:
    'Verifies the `state` against the browser cookie (CSRF), exchanges the authorization code for an access token, reads the profile (`GET /user`) and primary verified email (`GET /user/emails`), find-or-creates the account (auto-merging by verified email), sets the refresh cookie and redirects to the frontend with an access token in the URL fragment. Failures redirect to the frontend with an `error` fragment.',
  querystring: {
    type: 'object',
    properties: {
      code: { type: 'string' },
      state: { type: 'string' },
      error: { type: 'string' },
    },
  },
  response: responses({
    302: { type: 'null', description: 'Redirect to the frontend (or an error page)' },
  }),
};

// ─── Telegram deep-link login (auth_tz.md §7) ─────────────────────────────────

export const telegramInitRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'Start a Telegram login — returns a t.me deep-link and a polling token',
  description:
    'Creates a short-lived (10 min) `pending` login token bound to the browser via an httpOnly `tg_session` cookie, and returns the `https://t.me/<bot>?start=<token>` deep-link. The client opens the link, then polls `GET /auth/telegram/status?token=` until the user confirms in the bot.',
  response: responses({
    200: {
      type: 'object',
      properties: {
        deep_link: { type: 'string' },
        token: { type: 'string' },
        expires_at: { type: 'string', format: 'date-time' },
      },
    },
  }),
};

export const telegramWebhookRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'Telegram bot webhook — receives bot updates (Telegram calls this)',
  description:
    'Endpoint Telegram posts bot updates to. A `/start <token>` message gets a confirm inline-button; tapping it confirms the login token and attaches the tapper’s telegram_id. Protected by the `X-Telegram-Bot-Api-Secret-Token` header when `TELEGRAM_WEBHOOK_SECRET` is configured. Not called by the frontend.',
  body: { type: 'object', additionalProperties: true },
  response: responses({
    200: { type: 'object', properties: { ok: { type: 'boolean' } } },
  }),
};

export const telegramStatusRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'Poll a Telegram login token — returns pending, or a session once confirmed',
  description:
    'Polled by the site (~every 2s). Enforces the `tg_session` cookie binding and the 10-minute TTL. Returns `{ status: "pending" }` until the user confirms in the bot, then consumes the token (one-time), find-or-creates the account by telegram_id, sets the refresh cookie and returns `{ status: "authenticated", access_token, refresh_token, user }`. Also reports `expired` / `used`.',
  querystring: {
    type: 'object',
    required: ['token'],
    properties: {
      token: { type: 'string' },
    },
  },
  response: responses({
    200: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'expired', 'used', 'authenticated'] },
        access_token: { type: 'string' },
        refresh_token: { type: 'string' },
        user: userShape,
      },
    },
  }),
};

export const refreshRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'Rotate the refresh token and issue a new access token',
  description:
    'Reads the refresh token from the httpOnly cookie (browsers) or the request body (API/mobile clients). Sets a rotated refresh cookie on success.',
  body: {
    type: 'object',
    properties: {
      refresh_token: { type: 'string' },
    },
  },
  response: responses({
    200: tokenPair,
  }),
};

export const logoutRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'Revoke the current refresh token',
  description:
    'Revokes the refresh token from the httpOnly cookie (browsers) or the request body, and clears the refresh cookie.',
  body: {
    type: 'object',
    properties: {
      refresh_token: { type: 'string' },
    },
  },
  response: responses({
    204: { type: 'null', description: 'Logged out' },
  }),
};

// ─── Connected-accounts management (auth_tz.md §10) ────────────────────────────

const identityShape = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    provider: { type: 'string', enum: ['email', 'google', 'github', 'telegram'] },
    provider_email: { type: 'string', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
  },
} as const;

export const listIdentitiesRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'List the current account’s linked login methods',
  description:
    'Returns the account’s linked identities (email / google / github / telegram), oldest first — the data behind a “Connected accounts” screen (auth_tz.md §10).',
  security: [{ bearerAuth: [] }],
  response: responses({
    200: { type: 'array', items: identityShape },
  }),
};

export const linkIdentityRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'Link a new OAuth/Telegram login method to the current account',
  description:
    'Attaches a provider identity to the logged-in account (auth_tz.md §10). Supply an OAuth authorization `code` (Google/GitHub) or a confirmed Telegram login `token`. Idempotent when the identity is already linked to this account; rejected (409) when it already belongs to a different user.',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['provider'],
    properties: {
      provider: { type: 'string', enum: ['google', 'github', 'telegram'] },
    },
  },
  body: {
    type: 'object',
    properties: {
      code: { type: 'string' },
      token: { type: 'string' },
    },
  },
  response: responses({
    200: identityShape,
  }),
};

export const unlinkIdentityRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'Unlink a login method from the current account',
  description:
    'Removes the account’s identity for the given provider (auth_tz.md §10). Guarded: the last remaining login method cannot be removed (would lock the user out).',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['provider'],
    properties: {
      provider: { type: 'string', enum: ['email', 'google', 'github', 'telegram'] },
    },
  },
  response: responses({
    204: { type: 'null', description: 'Unlinked' },
  }),
};

export const getMeRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'Get the current authenticated user',
  description:
    'Returns the account behind the bearer access token. Never includes the password hash.',
  security: [{ bearerAuth: [] }],
  response: responses({ 200: userShape }),
};

export const updateMeRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'Update the current authenticated user',
  description:
    'Updates the current account’s mutable profile fields (`display_name`, `avatar_url`).',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    properties: {
      display_name: { type: 'string', minLength: 1, maxLength: 100 },
      avatar_url: { type: 'string', nullable: true },
    },
  },
  response: responses({ 200: userShape }),
};
