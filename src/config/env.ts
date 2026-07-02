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
    // auth_tz.md §8: access token lives ~3h, refresh ~30 days (httpOnly cookie).
    JWT_ACCESS_TTL: duration.default('3h'),
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

    // --- Email / SMTP --- (transactional email: OTP codes, invites; auth_tz.md §6)
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

    // --- CORS --- (comma-separated origins, or `*`; configured per environment)
    CORS_ORIGIN: z.string().min(1).default('*'),

    // --- Attachment storage ---
    // `local` (default) stores bytes on disk and serves them through internal API
    // routes; `s3` uses an S3-compatible object store (AWS S3 / MinIO) with
    // presigned URLs. The S3_* vars are required only when STORAGE_DRIVER=s3
    // (enforced by the superRefine below).
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    /** Lifetime (seconds) of generated presigned upload/download URLs. */
    STORAGE_PRESIGN_TTL: z.coerce.number().int().min(30).max(86400).default(900),
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
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return Object.freeze(result.data);
}
