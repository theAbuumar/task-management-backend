# Auth Roadmap — Multi-provider Authentication

> Single source of truth for the **authentication system** build. Derived from `auth_tz.md`.
> `/start-auth` reads this to find the next unchecked task, works the **current phase**, ticks
> off (`- [x]`) each finished item, and commits when the phase is fully done — then waits for
> the next `/start-auth`.
>
> This is separate from the product `ROADMAP.md` (`/start` / `/stop`). Do not mix the two.

## Current Status

- **Current Phase:** ✅ **Auth build complete** — all phases A0–A6 done (A6: **5/5**)
- **Last Session:** 2026-07-02 (**A6 complete**: Hardening & tests — centralized argon2id + min-8 password policy in new `src/lib/password.ts` (`ARGON2_OPTIONS` m=19 MiB/t=2/p=1, `hashSecret`/`verifySecret`, `passwordSchema`), with `service.ts`/`otp.service.ts`/`schema.ts` refactored onto it; registered `@fastify/rate-limit` (`global: false`) with per-IP 30/min on the sensitive auth/OTP endpoints, 429 → `RATE_LIMITED` envelope; audited CSRF (`state` double-submit on Google/GitHub, `tg_session` on Telegram) + secrets-from-`config`-only; completed OpenAPI docs — shared error envelope as the `default` response on every `/auth/*` route + filled missing descriptions. New `tests/auth-hardening.test.ts` (8) covers merge-by-verified-email, find, OTP expiry + attempt-cap, refresh-cookie rotation, CSRF double-submit, and rate-limit 429. Verified: build green, ESLint + Prettier clean on touched files, auth + multi-tenant suites **55/55** against the remote DB.)
- **Next Task:** None — the authentication system is complete. Optional follow-ups belong to the product roadmap's Phase 4 hardening (helmet + CORS per environment; extend rate limiting to product write endpoints; index review).
- **Env notes:** DB reachable only with `?sslmode=require&connect_timeout=30` appended to `DATABASE_URL` (Render free tier: high latency + idle spin-down; the URL lives in `.env` but is not loaded under `NODE_ENV=test`, so export it when running vitest). Heavier integration suites need a raised vitest `hookTimeout`/`testTimeout` here (e.g. `--hookTimeout 120000 --testTimeout 120000`); the light auth suites pass at the default.

---

## Resolved Decisions

Locked from `auth_tz.md` §9 and §1. Do not re-litigate during the build.

- **Account vs. identity:** `users` (the account) and `auth_identities` (login methods) are
  separate. One user may have many identities. Account identity is `email` when present;
  Telegram-only accounts are identified by `telegram_id`.
- **Find-or-create** for every OAuth/Telegram login (never "already exists" / "not found").
  The **only** exception is email+password login (honest "invalid credentials" on miss).
- **Auto-merge by email** is allowed only when the provider marks the email verified
  (Google/GitHub verified). Unverified emails never auto-merge.
- **Sessions:** JWT access token **3 hours**; refresh token **~30 days** in an `httpOnly`
  cookie. Refresh rotates; logout invalidates refresh. (Supersedes the product roadmap's ~15m.)
- **Email OTP:** 6 digits, 10-minute TTL, max 5 attempts then invalidate.
- **OTP send rate limit:** at most 1 / 60s and 5 / hour per email.
- **Telegram login token:** 10-minute TTL, one-time, bound to the initiating browser session.
- **Passwords:** argon2id (or bcrypt cost ≥ 12), minimum 8 characters.
- **CSRF:** every OAuth flow carries a `state` parameter that is verified on callback.
- **No phone number** collected on the site (unverifiable); if ever needed the bot asks via
  "share contact".

---

## Phase A0 — Data model & session foundations

- [x] Migrate `User`: make `email` nullable (keep unique), make `password_hash` nullable, add `email_verified Boolean @default(false)`
- [x] Reconcile existing `register` / `login` / `getMe` with now-nullable `email` / `password_hash` (no runtime breakage) — login now guides no-password accounts to OAuth (§6); comments/invites null-guarded; `userShape` response exposes nullable `email` + `email_verified`
- [x] `AuthProvider` enum (`email | google | github | telegram`) + `AuthIdentity` model (`user_id`, `provider`, `provider_user_id`, `provider_email`, `created_at`, `UNIQUE(provider, provider_user_id)`)
- [x] `EmailOtp` model (`email`, `code_hash`, `purpose` signup|login, `expires_at`, `attempts`, `consumed_at`)
- [x] `TelegramLoginToken` model (`token`, `session_id`, `telegram_id`, `status` pending|confirmed|expired|used, `expires_at`)
- [x] Migration applied + `prisma generate` — all **9** migrations applied via `npx prisma migrate deploy` to the (empty) remote DB; `prisma generate` re-run; `migrate status` → "Database schema is up to date!". Verified with auth integration tests (10/10). Note: reaching this DB needs `?sslmode=require&connect_timeout=30` appended to `DATABASE_URL` (Render free tier); not persisted to `.env` per user's choice.
- [x] Config/env additions (validated at boot): Google client id/secret + callback, GitHub client id/secret + callback, Telegram bot token/username, session cookie name/domain/secure flags, frontend redirect URL
- [x] Session change: access-token TTL → **3h**; refresh token set as `httpOnly` cookie (via `@fastify/cookie`, registered in `app.ts`); `/auth/refresh` + `/auth/logout` read it cookie-first with a body fallback for API/mobile clients, and logout clears it. Shared helpers `src/lib/session-cookie.ts` (set/clear/read) + `src/lib/duration.ts` (cookie `maxAge` from `JWT_REFRESH_TTL`); `refresh_token` now optional in the request schema
- [x] Reusable `state`/CSRF helper (`src/lib/oauth-state.ts`) + `find-or-create identity` service helper (`src/modules/auth/identity.service.ts`) shared by all providers

## Phase A1 — Email + password (OTP verification)

- [x] Email sender abstraction (`lib/mailer`) — `src/lib/mailer.ts`: `sendMail()` logs a stub to console in dev/test (no SMTP_HOST) and sends via nodemailer SMTP when configured (all behind env). `src/lib/email.ts` refactored to build messages (`sendInviteEmail`, new `sendOtpEmail`) on top of it
- [x] `POST /auth/email/signup` — creates user inactive + `email_verified=false`, issues a 6-digit OTP (argon2 `code_hash`) and emails it (`service.emailSignup` + `otp.service.issueOtp`). Existing email is never duplicated: unverified accounts may correct their password, verified accounts are untouched — both still get a code to verify into (existence not leaked)
- [x] `POST /auth/email/verify` — `otp.service.verifyOtp` enforces expiry / ≤5 attempts / single-use → sets `email_verified=true` + `is_active=true`, ensures the `email` identity, issues a session (+ refresh cookie)
- [x] Update `POST /auth/email/login` — reuses the `login` service: honest "invalid email or password" on miss; no-`password_hash` accounts guided to Google/GitHub; unverified accounts guided to verify first (route mounted at `/auth/email/login`, legacy `/auth/login` kept)
- [x] OTP send rate limit (1 / 60s, 5 / hour per email) + attempt/expiry invalidation — in `otp.service` (`enforceSendRateLimit` + attempt cap / expiry / single-use invalidation); 429 via new `AppError.rateLimited`
- [x] `email` identity row created/ensured on successful signup — idempotent `ensureEmailIdentity` (checks user+provider first, since `email` identities have a null `provider_user_id`)

## Phase A2 — Google OAuth

- [x] `GET /auth/google` — redirect to Google with `state` (CSRF) stored server-side/cookie — `googleRedirectHandler` mints `createState()`, stores it double-submit via new `setStateCookie` (short-lived httpOnly `oauth_state`, lax), 302s to `accounts.google.com/o/oauth2/v2/auth` (scope `openid email profile`, `prompt=select_account`); URL built by `google.service.ts` `buildGoogleAuthUrl`
- [x] `GET /auth/google/callback` — verify `state`, exchange `code`, read `sub` / `email` / `name` / `picture` — `googleCallbackHandler` clears the state cookie, checks `verifyCallbackState` (cookie match + signature/TTL), then `exchangeGoogleCode` POSTs the token endpoint and reads claims from the `id_token` (no sig check — token came straight from Google over TLS). `error`/CSRF/exchange failures redirect to the frontend with an `#error=` fragment
- [x] Find-or-create: identity by (`google`, `sub`) → else user by verified `email` (auto-merge) → else create; issue session, redirect to frontend — via new `service.loginWithProvider` reusing the existing `findOrCreateFromProvider`; on success sets the refresh cookie and 302s to `FRONTEND_URL` with `#access_token=` (fragment keeps it out of logs/history)
- [x] `google` identity row persisted with `provider_email` — handled by `findOrCreateFromProvider` (create + auto-merge paths both write `provider_email`); asserted by the happy-path test

## Phase A3 — GitHub OAuth

- [x] `GET /auth/github` — redirect with `state`, scope `read:user user:email` — `githubRedirectHandler` mints `createState()`, stores it double-submit via `setStateCookie`, 302s to `github.com/login/oauth/authorize` (scope `read:user user:email`, `allow_signup=true`); URL built by `github.service.ts` `buildGithubAuthUrl`
- [x] `GET /auth/github/callback` — verify `state`, exchange `code` for `access_token`, `GET /user` + `GET /user/emails` (primary + verified) — `githubCallbackHandler` clears the state cookie, checks `verifyCallbackState`, then `exchangeGithubCode` POSTs the token endpoint (`Accept: application/json`) and calls the API twice with a `User-Agent`; `selectEmail` picks the primary+verified address (falls back to any verified, else primary marked unverified). `error`/CSRF/exchange failures redirect to the frontend with `#error=`
- [x] Same find-or-create + auto-merge-by-verified-email logic as Google; issue session — via `service.loginWithProvider` reusing `findOrCreateFromProvider`; on success sets the refresh cookie and 302s to `FRONTEND_URL#access_token=`
- [x] `github` identity row persisted — handled by `findOrCreateFromProvider` (create + auto-merge paths both write `provider_email`); asserted by the happy-path test

## Phase A4 — Telegram deep-link login

- [x] `POST /auth/telegram/init` — create `TelegramLoginToken` (`pending`) bound to browser session; return `https://t.me/<bot>?start=<token>` deep-link — `telegramInitHandler` mints a random `session_id`, stores it double-submit in a short-lived httpOnly `tg_session` cookie (`src/lib/telegram-session.ts`) and stamps it on the token; `service.telegramInit` → `telegram-login.service.initLoginToken` (random base64url token, 10-min TTL, opportunistic `sweepExpiredTokens`) + `telegram.service.buildTelegramDeepLink`. Returns `{ deep_link, token, expires_at }`
- [x] Bot update handler — receive `/start <token>` with `telegram_id`; reply with confirm inline-button; on confirm set token `confirmed` + attach `telegram_id` — `POST /auth/telegram/webhook` (`telegramWebhookHandler`, guarded by `X-Telegram-Bot-Api-Secret-Token` when `TELEGRAM_WEBHOOK_SECRET` is set); `service.handleTelegramUpdate` sends the confirm inline-button (`confirm:<token>` callback_data) for a live pending `/start <token>`, and on the callback tap `confirmLoginToken` flips it to `confirmed` + attaches the tapper's `telegram_id`. Bot API (`sendMessage`/`answerCallbackQuery`) in `telegram.service.ts`; every branch answers in-chat so the bot never goes silent
- [x] `GET /auth/telegram/status?token=` — polling endpoint; on `confirmed` find-or-create by `telegram_id` (no email), mark token `used`, issue session — `telegramStatusHandler` reads the `tg_session` cookie; `service.telegramStatus` → `consumeLoginToken` (one-time flip to `used` via guarded `updateMany`) then `loginWithProvider` (telegram, no email) → sets the refresh cookie and returns `{ status: 'authenticated', access_token, refresh_token, user }`; `pending`/`expired`/`used` reported as-is
- [x] Token lifecycle enforced: 10-min TTL, one-time, session-bound, expiry sweep — TTL stamped at init + re-checked on every read; single-use via the `confirmed→used` guarded update; session binding rejects a mismatched/absent `tg_session` (403); `sweepExpiredTokens` bulk-expires lapsed pending/confirmed rows at init. Verified: build green, ESLint clean + Prettier clean on touched files, new `telegram-auth` tests 6/6, and auth 10/10 + google 4/4 + github 4/4 + email 5/5 + invites 17/17 (46/46, no regressions)

## Phase A5 — Connected-accounts management

- [x] `GET /auth/identities` — list the logged-in user's linked login methods — `listIdentitiesHandler` (authenticated) → `service.listIdentities` returns `{ id, provider, provider_email, created_at }` per row, oldest-first
- [x] `POST /auth/identities/:provider/link` — link a new OAuth/Telegram identity to the current account; reject if that identity already belongs to another user — `linkIdentityHandler` (authenticated): Google/GitHub reuse `exchangeGoogleCode`/`exchangeGithubCode` (code in body), Telegram via `service.linkTelegram` (consumes a confirmed `tg_session`-bound token). `service.linkIdentity` runs in a txn: find by (provider, provider_user_id) → own it (idempotent 200) / else-owned → 409 CONFLICT / else create; UNIQUE(provider, provider_user_id) is the backstop
- [x] `DELETE /auth/identities/:provider` — unlink, with hard guard: **cannot remove the last remaining login method** — `unlinkIdentityHandler` (authenticated) → `service.unlinkIdentity`: 404 when the provider isn't linked, 403 FORBIDDEN when it's the account's last method, else `deleteMany` by (user, provider) → 204

## Phase A6 — Hardening & tests

- [x] Verify `state`/CSRF on all OAuth flows; secrets only from validated env — audited: Google/GitHub redirect handlers mint `createState()` + `setStateCookie()`; callbacks gate on `verifyCallbackState` (double-submit cookie **and** HMAC signature **and** 10-min TTL); Telegram binds via the `tg_session` cookie. Secrets audit (`grep process.env`) confirms env is read only in `config/` (`parseEnv`) — no provider secret is touched outside validated `config`. New regression tests assert a callback with a **mismatched** state cookie, and one with a valid param but **no** cookie, both redirect `#error=invalid_state`.
- [x] Enforce argon2id params + min-8-char password rule centrally — new `src/lib/password.ts` owns it: `ARGON2_OPTIONS` (argon2id, m=19 MiB, t=2, p=1), `hashSecret`/`verifySecret` (verify is throw-safe → `false`), `passwordSchema` + `PASSWORD_MIN_LENGTH`. `service.ts` (register/login/emailSignup) and `otp.service.ts` (code hashing) route through the helpers; register/emailSignup Zod schemas use `passwordSchema` and the Fastify JSON schemas reference `PASSWORD_MIN_LENGTH`. No direct `argon2` calls remain in the auth module.
- [x] Rate limits verified on auth + OTP endpoints (`@fastify/rate-limit`) — registered `global: false` in `app.ts` (product routes untouched); per-IP 30/min opted-in on `/register`, `/login`, `/email/{signup,verify,login}`, `/telegram/init`, `/refresh` (deliberately **not** `/telegram/status`, which is polled ~2s, nor the webhook). 429 renders as the `RATE_LIMITED` envelope via the existing error-handler branch. Verified by a test that exhausts `/login` → 429 `RATE_LIMITED`. (The per-email OTP throttle in `otp.service` is the separate business rule.)
- [x] Integration tests: find-or-create, merge-by-verified-email, unlink-last guard, OTP expiry/attempts/single-use, Telegram token lifecycle, refresh-cookie rotation — new `tests/auth-hardening.test.ts` (8): merge-by-verified-email (Google login onto an existing verified-email account attaches the identity, no new user) + find (repeat login → same account, one identity); OTP expiry (forced past TTL → 400 + consumed) and ≤5-attempt cap (5 wrong → consumed → "no active code"); refresh-cookie rotation (cookie-driven refresh issues a fresh cookie, old one revoked); OAuth CSRF double-submit. unlink-last guard + single-use OTP replay already covered in `connected-accounts`/`email-auth`; Telegram token lifecycle in `telegram-auth`.
- [x] OpenAPI/Swagger docs complete for every `/auth/*` endpoint — added a shared error-envelope schema (`responses()` helper) attached as the `default` response on all 19 auth routes, so every endpoint documents its `{ error: { code, message, details? } }` failure shape (`additionalProperties: true` lets `details` serialize through untouched); filled the missing `description`s (register, login, getMe, updateMe, listIdentities). Serialization verified green by the full auth suite.
