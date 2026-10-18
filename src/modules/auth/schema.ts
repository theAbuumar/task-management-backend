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

const nameField = z.string().trim().max(60);

export const UpdateMeBodySchema = z.object({
  display_name: z.string().min(1).max(100).optional(),
  avatar_url: z.string().url().optional().nullable(),
  // ФИО. When given without display_name, display_name is rebuilt as
  // "Фамилия Имя Отчество".
  last_name: nameField.optional().nullable(),
  first_name: nameField.optional().nullable(),
  middle_name: nameField.optional().nullable(),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{5,20}$/, 'Phone may contain digits, spaces, (), - and a leading +')
    .optional()
    .nullable(),
  locale: z.enum(['ru', 'en']).optional(),
  timezone: z
    .string()
    .max(64)
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Unknown time zone')
    .optional()
    .nullable(),
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

// Passwordless email sign-in: request a code. `display_name` is only used when the
// email has no account yet (one is created on first successful verification).
export const EmailOtpRequestBodySchema = z.object({
  email: z.string().email(),
  display_name: z.string().trim().min(1).max(100).optional(),
});

// Passwordless email sign-in: confirm the code.
export const EmailOtpVerifyBodySchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
});

// Confirm account deletion: the 6-digit code emailed to the logged-in user. The
// email/user is taken from the session, so only the code is sent.
export const AccountDeleteConfirmBodySchema = z.object({
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
        caption: z.string().optional(),
        document: z
          .object({
            file_id: z.string(),
            file_name: z.string().optional(),
            mime_type: z.string().optional(),
            file_size: z.number().optional(),
          })
          .optional(),
        photo: z
          .array(z.object({ file_id: z.string(), file_size: z.number().optional() }))
          .optional(),
        media_group_id: z.string().optional(),
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
export const LinkStartParamsSchema = z.object({
  provider: z.enum(['google', 'github']),
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
export type EmailOtpRequestBody = z.infer<typeof EmailOtpRequestBodySchema>;
export type EmailOtpVerifyBody = z.infer<typeof EmailOtpVerifyBodySchema>;
export type AccountDeleteConfirmBody = z.infer<typeof AccountDeleteConfirmBodySchema>;
export type GoogleCallbackQuery = z.infer<typeof GoogleCallbackQuerySchema>;
export type GithubCallbackQuery = z.infer<typeof GithubCallbackQuerySchema>;
export type TelegramStatusQuery = z.infer<typeof TelegramStatusQuerySchema>;
export type LinkIdentityParams = z.infer<typeof LinkIdentityParamsSchema>;
export const SessionParamsSchema = z.object({ id: z.string().uuid() });

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
    last_name: { type: 'string', nullable: true },
    first_name: { type: 'string', nullable: true },
    middle_name: { type: 'string', nullable: true },
    phone: { type: 'string', nullable: true },
    locale: { type: 'string' },
    timezone: { type: 'string', nullable: true },
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

export const emailOtpRequestRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'Passwordless sign-in, step 1 — email a 6-digit code',
  description:
    'Works for existing and new addresses alike (same response either way, so it does not reveal whether an account exists). For a new address an inactive account is prepared and activated on step 2. Per-email throttle: 1 code / 60 s.',
  body: {
    type: 'object',
    required: ['email'],
    properties: {
      email: { type: 'string', format: 'email' },
      display_name: { type: 'string', minLength: 1, maxLength: 100 },
    },
  },
  response: responses({
    200: otpChallenge,
  }),
};

export const emailOtpVerifyRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'Passwordless sign-in, step 2 — confirm the code and get a session',
  description:
    'Verifies the code (10 min TTL, 5 attempts, single use), activates a new account, and issues a session (sets the refresh cookie). Errors: `OTP_INVALID`, `OTP_EXPIRED`, `OTP_TOO_MANY_ATTEMPTS`, `OTP_NOT_FOUND`, `ACCOUNT_DEACTIVATED`.',
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
    'Reads the refresh token from the httpOnly cookie (browsers) or the request body (API/mobile clients). Sets a rotated refresh cookie on success; the sign-in session stays the same. `401 SESSION_REVOKED` when the session was ended (another device, an admin), `401 UNAUTHORIZED` when the token is invalid, expired or already rotated.',
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
  summary: 'Sign out: end the session of the current refresh token',
  description:
    'Ends the sign-in session of the refresh token from the httpOnly cookie (browsers) or the request body — every token of that session is revoked and its access tokens stop working — and clears the refresh cookie.',
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

export const linkStartRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'Start linking Google or GitHub to the current account (profile → connected accounts)',
  description:
    'Returns the provider consent `url` for the browser to navigate to and sets the `oauth_state` cookie. The state names the signed-in user (ADR-025), so the provider’s usual `…/callback` links the account to this user instead of signing in, then redirects to `FRONTEND_URL/profile#linked=<provider>` or `#link_error=<code>` (`linked_to_other_account`, `invalid_state`, `<provider>_link_failed`, or the provider’s own error such as `access_denied`). 400 when the provider is not configured on this deployment.',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['provider'],
    properties: {
      provider: { type: 'string', enum: ['google', 'github'] },
    },
  },
  response: responses({
    200: {
      type: 'object',
      required: ['url'],
      properties: { url: { type: 'string' } },
    },
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

// ─── Code-confirmed account deletion ──────────────────────────────────────────

const deleteChallenge = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['otp_sent'] },
    channel: { type: 'string', enum: ['email', 'telegram'] },
    // Present only for the email channel.
    email: { type: 'string', nullable: true },
  },
} as const;

export const accountDeleteRequestRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'Request account deletion — sends the current user a 6-digit confirmation code',
  description:
    'Starts the code-confirmed deletion flow for the logged-in account, regardless of how it was registered. Sends a 6-digit code (`delete_account` purpose) to the account’s email if it has one, otherwise through the Telegram bot for a Telegram-linked account; the response `channel` says which. The client then confirms via `POST /auth/account/delete/confirm`. Rejected (400) only when the account has neither an email nor Telegram to reach — link one first.',
  security: [{ bearerAuth: [] }],
  response: responses({
    200: deleteChallenge,
  }),
};

export const accountDeleteConfirmRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'Confirm account deletion with the sent code — scrubs and deactivates the account',
  description:
    'Validates the 6-digit code from `POST /auth/account/delete/request` (email or Telegram, whichever it was sent on), then deletes the account by anonymizing it: removes all login methods and refresh tokens (logging the user out everywhere) and clears email / password / display name / avatar. Ownership of any workspace the user solely owns is auto-transferred to another member first (or the workspace is deleted when no one else remains). Authored issues/comments, activity, and issue assignments are retained and attributed to a deleted user. Clears the refresh cookie.',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['code'],
    properties: {
      code: { type: 'string', pattern: '^\\d{6}$' },
    },
  },
  response: responses({
    204: { type: 'null', description: 'Account deleted' },
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
    'Updates the profile: full name (ФИО), phone, language, time zone, avatar. Setting the name parts without `display_name` rebuilds it as "Фамилия Имя Отчество".',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    properties: {
      display_name: { type: 'string', minLength: 1, maxLength: 100 },
      avatar_url: {
        type: 'string',
        nullable: true,
        description:
          'The `url` from `POST /auth/me/avatar` after uploading, or null to remove. The stored file must be this user’s png/jpeg/webp up to 2 MB (`INVALID_IMAGE`); the replaced photo is deleted.',
      },
      last_name: { type: 'string', maxLength: 60, nullable: true },
      first_name: { type: 'string', maxLength: 60, nullable: true },
      middle_name: { type: 'string', maxLength: 60, nullable: true },
      phone: { type: 'string', maxLength: 20, nullable: true },
      locale: { type: 'string', enum: ['ru', 'en'] },
      timezone: { type: 'string', maxLength: 64, nullable: true },
    },
  },
  response: responses({ 200: userShape }),
};

// ─── Sign-in sessions (Ф12 12.B2) ───────────────────────────────────────────────

const sessionShape = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    method: {
      type: 'string',
      nullable: true,
      description:
        'How the user signed in: `password`, `email_code`, `google`, `github`, `telegram`, `demo`. Null for sessions that existed before this field.',
    },
    browser: { type: 'string', nullable: true, description: 'e.g. «Chrome 128» (from User-Agent)' },
    os: { type: 'string', nullable: true, description: 'e.g. «Windows», «iOS» (from User-Agent)' },
    mobile: { type: 'boolean' },
    ip: { type: 'string', nullable: true, description: 'Latest IP the session was used from' },
    user_agent: { type: 'string', nullable: true },
    created_at: { type: 'string', format: 'date-time', description: 'Sign-in time' },
    last_used_at: {
      type: 'string',
      format: 'date-time',
      description: 'Last sign-in or token refresh (≈ every 15 minutes while the site is open)',
    },
    expires_at: { type: 'string', format: 'date-time' },
    current: { type: 'boolean', description: 'The session of this request’s access token' },
  },
} as const;

export const listSessionsRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'List the account’s active sign-in sessions («Мои сессии»)',
  description:
    'One entry per sign-in on a device that has not signed out, been ended or expired: device, IP, sign-in method, sign-in and last activity time. The current session is first and marked `current: true`.',
  security: [{ bearerAuth: [] }],
  response: responses({
    200: {
      type: 'object',
      properties: { data: { type: 'array', items: sessionShape } },
    },
  }),
};

export const revokeSessionRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'End one of the account’s sessions',
  description:
    'Revokes the session and all its refresh tokens; its access tokens are refused from the next request (`401 SESSION_REVOKED`) and its live-update streams close. Ending the current session signs this device out and clears the refresh cookie. `404` for a session of another account or one already ended. Written to the audit log as `auth.session_revoked`.',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  response: responses({
    204: { type: 'null', description: 'Session ended' },
  }),
};

export const revokeOtherSessionsRouteSchema: FastifySchema = {
  tags: ['Auth'],
  summary: 'Sign out on every other device',
  description:
    'Ends every session of the account except the current one (the device making the request stays signed in). Returns how many were ended. Written to the audit log as `auth.sessions_revoked`.',
  security: [{ bearerAuth: [] }],
  response: responses({
    200: {
      type: 'object',
      properties: { revoked: { type: 'integer' } },
    },
  }),
};
