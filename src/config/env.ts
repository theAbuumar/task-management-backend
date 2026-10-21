// Environment schema + parsing.
//
// Defines every environment variable the app reads, with types, coercion and
// defaults, via Zod. `parseEnv` validates a raw source (usually `process.env`)
// and returns a fully-typed, immutable config object — or throws a readable
// aggregated error listing every offending variable. No secrets are hardcoded:
// secrets are required from the environment (CLAUDE.md security rules).

import { z } from 'zod';

/** Accepts the JWT-style duration strings the auth layer will hand to its token lib (e.g. `15m`, `7d`, `3600`). */
const duration = z
  .string()
  .regex(/^\d+(ms|s|m|h|d|w|y)?$/, 'must be a duration like "15m", "7d", or a number of seconds');

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // --- HTTP server ---
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),

    // --- Logging ---
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
    /** Demo stand: quick login as seeded `@demo.local` accounts. Never enable in production data. */
    DEMO_MODE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    /**
     * Demo seed (13.B1): the presenter's Telegram user id, linked to one demo account
     * so bot messages and buttons reach the phone on stage. Unset — no link.
     */
    DEMO_TELEGRAM_ID: z
      .string()
      .regex(/^\d{3,15}$/, 'must be a numeric Telegram user id')
      .optional(),
    /** Which demo account gets that Telegram: rector | prorector | dean | employee. */
    DEMO_TELEGRAM_ROLE: z.enum(['rector', 'prorector', 'dean', 'employee']).default('dean'),
    /** Run background jobs (deadline reminders) in this process. Off under test by default. */
    JOBS_ENABLED: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => (v === undefined ? process.env.NODE_ENV !== 'test' : v === 'true')),
    /** How long analytics keep the loaded facts (seconds). Any write to the workspace drops them earlier. 0 = no cache. */
    ANALYTICS_CACHE_TTL: z.coerce.number().int().min(0).max(3600).default(300),

    // --- Database ---
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required')
      .refine(
        (v) => v.startsWith('postgres://') || v.startsWith('postgresql://'),
        'DATABASE_URL must be a PostgreSQL connection string',
      ),

    // --- Auth / JWT --- (secrets required; no defaults, never committed)
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    // Short-lived access token (kept in SPA memory) + ~30-day refresh token in an
    // httpOnly cookie; the SPA refreshes silently (DECISIONS.md ADR-004).
    JWT_ACCESS_TTL: duration.default('15m'),
    JWT_REFRESH_TTL: duration.default('30d'),

    // --- Session cookie --- (refresh token is delivered as an httpOnly cookie; auth_tz.md §8)
    SESSION_COOKIE_NAME: z.string().min(1).default('refresh_token'),
    /** Cookie Domain attribute; leave empty to scope to the exact host. */
    SESSION_COOKIE_DOMAIN: z.string().optional(),
    /** Send the cookie only over HTTPS. Defaults on outside development. */
    SESSION_COOKIE_SECURE: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true')),
    /** SameSite policy for the refresh cookie. `lax` works for top-level OAuth redirects. */
    SESSION_COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

    // --- Frontend --- (where OAuth/Telegram flows redirect the browser back to)
    FRONTEND_URL: z.string().url().default('http://localhost:5173'),

    // --- Email --- (transactional email: OTP codes, invites; auth_tz.md §6)
    // Delivery precedence (see lib/mailer): RESEND_API_KEY (HTTP API, port 443 —
    // preferred on hosts that throttle/block outbound SMTP like Render) → SMTP_* →
    // console stub in dev/test. A Resend SMTP_PASS doubles as the API key.
    RESEND_API_KEY: z.string().min(1).optional(),
    // Dev/test with no SMTP_HOST logs emails to the console. In production (or any
    // env with SMTP_HOST set) mail is sent via this SMTP transport.
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    /** Use implicit TLS (true for port 465); STARTTLS is negotiated otherwise. */
    SMTP_SECURE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASS: z.string().min(1).optional(),
    /** From: address on outgoing mail. */
    MAIL_FROM: z.string().min(1).default('Task Management <no-reply@taskmgmt.local>'),

    // --- OAuth: Google --- (required only when the Google flow is used; validated lazily)
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    GOOGLE_CALLBACK_URL: z.string().url().optional(),

    // --- OAuth: GitHub ---
    GITHUB_CLIENT_ID: z.string().min(1).optional(),
    GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
    GITHUB_CALLBACK_URL: z.string().url().optional(),

    // --- Telegram bot --- (deep-link login; auth_tz.md §7)
    TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
    TELEGRAM_BOT_USERNAME: z.string().min(1).optional(),
    /**
     * Shared secret registered with Telegram's `setWebhook` (`secret_token`). When
     * set, the webhook route requires a matching `X-Telegram-Bot-Api-Secret-Token`
     * header so only Telegram can post updates. Optional in dev/test.
     */
    TELEGRAM_WEBHOOK_SECRET: z.string().min(1).optional(),
    /** Bot updates (messages, taps) one Telegram user may send per minute (12.T1). */
    TELEGRAM_RATE_LIMIT: z.coerce.number().int().min(1).max(100000).default(30),

    // --- University directory: LDAP / Active Directory (12.B10, ADR-034) --- off unless set
    /** `ldap://dc.university.local` or `ldaps://…:636`. Unset — no «University account» sign-in. */
    LDAP_URL: z
      .string()
      .regex(/^ldaps?:\/\/.+/, 'must start with ldap:// or ldaps://')
      .optional(),
    /** Service account that looks people up (read-only); unset — anonymous search. */
    LDAP_BIND_DN: z.string().min(1).optional(),
    LDAP_BIND_PASSWORD: z.string().min(1).optional(),
    /** Where people are: `OU=Staff,DC=university,DC=local`. Required with LDAP_URL. */
    LDAP_SEARCH_BASE: z.string().min(1).optional(),
    /**
     * How a login maps to an entry; `{{login}}` is replaced (escaped). Default fits
     * Active Directory: sAMAccountName, userPrincipalName or mail.
     */
    LDAP_SEARCH_FILTER: z
      .string()
      .min(1)
      .default('(|(sAMAccountName={{login}})(userPrincipalName={{login}})(mail={{login}}))'),
    /** Stable entry id: objectGUID (AD), entryUUID (OpenLDAP) or any unique attribute. */
    LDAP_ID_ATTRIBUTE: z.string().min(1).default('objectGUID'),
    /** What the login page calls it. */
    LDAP_LABEL: z.string().min(1).max(60).default('Учётная запись университета'),
    /** Hint under the login field, e.g. «Логин как в компьютерных классах». */
    LDAP_LOGIN_HINT: z.string().max(120).optional(),
    /** Reject an ldaps:// certificate the server cannot verify (keep true in production). */
    LDAP_TLS_REJECT_UNAUTHORIZED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    /** Connect + operation timeout, milliseconds. */
    LDAP_TIMEOUT_MS: z.coerce.number().int().min(500).max(60000).default(5000),

    // --- AI assistant (Ф11, ADR-016, ADR-028) --- off unless the owner turns it on
    AI_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    /** Which provider class serves the requests (lib/ai). Only Claude API so far. */
    AI_PROVIDER: z.enum(['anthropic']).default('anthropic'),
    /** Provider API key; required when AI_ENABLED=true. */
    AI_API_KEY: z.string().min(1).optional(),
    AI_MODEL: z.string().min(1).default('claude-opus-5-5'),
    /** Optional gateway in front of the provider API. */
    AI_BASE_URL: z.string().url().optional(),
    /** Successful AI requests per user per day (from midnight in the workspace zone). */
    AI_DAILY_LIMIT: z.coerce.number().int().min(1).max(100000).default(50),
    /** Whole-operation deadline for one AI request, milliseconds. */
    AI_TIMEOUT_MS: z.coerce.number().int().min(5000).max(600000).default(120000),

    // --- «О системе» (13.D4, 13.F4) ---
    /** Commit the stand runs (dev/stand.sh up sets it); shown in «О системе». */
    APP_COMMIT: z.string().max(64).optional(),
    /** Whom to contact about the system: e-mail, phone, room — shown in «О системе». */
    SUPPORT_CONTACT: z.string().max(300).optional(),

    // --- Rate limits per signed-in user, per minute (12.B5, plugins/write-limits) ---
    /** Changes (POST/PATCH/PUT/DELETE) inside workspaces. */
    RATE_LIMIT_WRITES: z.coerce.number().int().min(1).max(100000).default(300),
    /** Report and memo exports (PDF, Excel, DOCX). */
    RATE_LIMIT_EXPORTS: z.coerce.number().int().min(1).max(100000).default(20),

    // --- CORS --- (comma-separated origins, or `*`; configured per environment)
    CORS_ORIGIN: z.string().min(1).default('*'),

    // --- Attachment storage ---
    // `local` (default) stores bytes on disk and serves them through internal API
    // routes; `s3` uses an S3-compatible object store (AWS S3 / MinIO) with
    // presigned URLs. The S3_* vars are required only when STORAGE_DRIVER=s3
    // (enforced by the superRefine below).
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    /** Lifetime (seconds) of presigned upload slots. */
    STORAGE_PRESIGN_TTL: z.coerce.number().int().min(30).max(86400).default(900),
    /**
     * Lifetime (seconds) of download links: long enough that an open task keeps its
     * files, short enough that a copied link stops working (ADR-027).
     */
    STORAGE_DOWNLOAD_TTL: z.coerce.number().int().min(60).max(604800).default(86400),
    /** Public base URL the app is reachable at — used to build local storage URLs. */
    PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
    /** Max accepted upload size in bytes (default 25 MiB). */
    ATTACHMENT_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1)
      .default(25 * 1024 * 1024),

    // local driver
    LOCAL_STORAGE_DIR: z.string().min(1).default('./uploads'),

    // s3 driver (optional unless STORAGE_DRIVER=s3)
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_BUCKET: z.string().min(1).optional(),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    /** MinIO and most non-AWS stores need path-style addressing. */
    S3_FORCE_PATH_STYLE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
  })
  .superRefine((env, ctx) => {
    if (env.LDAP_URL && !env.LDAP_SEARCH_BASE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LDAP_SEARCH_BASE'],
        message: 'LDAP_SEARCH_BASE is required when LDAP_URL is set',
      });
    }
    if (Boolean(env.LDAP_BIND_DN) !== Boolean(env.LDAP_BIND_PASSWORD)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LDAP_BIND_PASSWORD'],
        message: 'LDAP_BIND_DN and LDAP_BIND_PASSWORD go together',
      });
    }
    if (env.AI_ENABLED && !env.AI_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AI_API_KEY'],
        message: 'AI_API_KEY is required when AI_ENABLED=true',
      });
    }
    if (env.STORAGE_DRIVER === 's3') {
      for (const key of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when STORAGE_DRIVER=s3`,
          });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Parse + validate a raw environment source into a typed `Env`.
 * Throws an `Error` whose message aggregates every validation failure.
 */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  // An empty value means "not set": docker compose and `.env` files pass
  // `TELEGRAM_BOT_TOKEN=` as "", which would otherwise fail `min(1)` instead of
  // falling back to the default / leaving the optional setting off (13.D3).
  const present = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const result = envSchema.safeParse(present);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return Object.freeze(result.data);
}
