import type { PrismaClient, User, AuthIdentity, AuthProvider } from '@prisma/client';
import { config } from '../../config/index.js';
import { AppError } from '../../lib/errors.js';
import { hashSecret, verifySecret } from '../../lib/password.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../lib/jwt.js';
import { parseDurationMs } from '../../lib/duration.js';
import { sendOtpEmail } from '../../lib/email.js';
import { acceptInviteAfterRegister } from '../invites/service.js';
import { issueOtp, verifyOtp } from './otp.service.js';
import { findOrCreateFromProvider, type ProviderProfile } from './identity.service.js';
import { initLoginToken, confirmLoginToken, consumeLoginToken } from './telegram-login.service.js';
import {
  buildTelegramDeepLink,
  sendConfirmPrompt,
  sendBotMessage,
  answerCallbackQuery,
  CONFIRM_CALLBACK_PREFIX,
  type TelegramUpdate,
} from './telegram.service.js';
import type {
  RegisterBody,
  LoginBody,
  UpdateMeBody,
  EmailSignupBody,
  EmailVerifyBody,
} from './schema.js';

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  user: SafeUser;
}

export type SafeUser = Omit<User, 'password_hash'>;

function stripHash(user: User): SafeUser {
  const { password_hash: _ph, ...safe } = user;
  return safe;
}

/** Turn a JWT-style TTL string ("15m", "7d", "3600") into a future Date. */
function ttlToDate(ttl: string): Date {
  return new Date(Date.now() + parseDurationMs(ttl));
}

// ─── Public service functions ─────────────────────────────────────────────────

export async function register(prisma: PrismaClient, body: RegisterBody): Promise<AuthTokens> {
  const existing = await prisma.user.findUnique({ where: { email: body.email } });
  if (existing) throw AppError.conflict('An account with this email already exists');

  // If an invite_token is provided, validate it before creating the account.
  // We only check it exists + isn't expired/used here — the email on the invite must
  // match the registration email so we enforce that in acceptInviteAfterRegister.
  if (body.invite_token) {
    const invite = await prisma.workspaceInvite.findUnique({
      where: { token: body.invite_token },
    });
    if (!invite) throw AppError.notFound('Invite not found');
    if (invite.accepted_at) throw AppError.conflict('Invite has already been accepted');
    if (invite.expires_at < new Date()) throw AppError.gone('Invite has expired');
    if (invite.email.toLowerCase() !== body.email.toLowerCase()) {
      throw AppError.forbidden('This invite was sent to a different email address');
    }
  }

  const password_hash = await hashSecret(body.password);
  const user = await prisma.user.create({
    data: { email: body.email, password_hash, display_name: body.display_name },
  });

  if (body.invite_token) {
    await acceptInviteAfterRegister(prisma, body.invite_token, user.id);
  }

  return issueTokenPair(prisma, user);
}

export async function login(prisma: PrismaClient, body: LoginBody): Promise<AuthTokens> {
  const user = await prisma.user.findUnique({ where: { email: body.email } });

  // Account exists but was created via OAuth/Telegram and never set a password
  // (auth_tz.md §6): guide the user to their provider rather than a generic failure.
  if (user && user.password_hash === null) {
    throw AppError.badRequest(
      'This account has no password. Sign in with Google or GitHub, or set a password first.',
    );
  }

  // Constant-time check on miss prevents timing-based account enumeration.
  const valid =
    user !== null &&
    user.password_hash !== null &&
    (await verifySecret(user.password_hash, body.password));

  if (!user || !valid) throw AppError.unauthorized('Invalid email or password');
  if (!user.is_active) {
    // An email account that never confirmed its OTP is inactive + unverified —
    // guide it to verification rather than the generic "deactivated" (§6).
    if (!user.email_verified) {
      throw AppError.forbidden(
        'Please verify your email address first. Check your inbox for the verification code.',
      );
    }
    throw AppError.forbidden('This account has been deactivated');
  }

  return issueTokenPair(prisma, user);
}

// ─── Email + password with OTP verification (auth_tz.md §6) ─────────────────────

export interface OtpChallenge {
  status: 'otp_sent';
  email: string;
}

/**
 * Start email+password signup: create the account **inactive + unverified**, then
 * issue and email a 6-digit OTP. If the email already exists we never duplicate it
 * (§6): a still-unverified account may correct its password; a verified account is
 * left untouched and simply receives a code to verify into (the response is
 * identical either way, so account existence isn't leaked).
 */
export async function emailSignup(
  prisma: PrismaClient,
  body: EmailSignupBody,
): Promise<OtpChallenge> {
  const existing = await prisma.user.findUnique({ where: { email: body.email } });

  if (!existing) {
    const password_hash = await hashSecret(body.password);
    await prisma.user.create({
      data: {
        email: body.email,
        password_hash,
        display_name: body.display_name,
        email_verified: false,
        is_active: false,
      },
    });
  } else if (!existing.email_verified) {
    const password_hash = await hashSecret(body.password);
    await prisma.user.update({
      where: { id: existing.id },
      data: { password_hash, display_name: body.display_name, is_active: false },
    });
  }
  // else: verified account — do not modify; still send a code to verify into it.

  const code = await issueOtp(prisma, body.email, 'signup');
  await sendOtpEmail(body.email, code, 'signup');

  return { status: 'otp_sent', email: body.email };
}

/**
 * Complete signup: validate the OTP (expiry / attempts / single-use), mark the
 * account verified + active, ensure its `email` identity row, and issue a session.
 */
export async function emailVerify(
  prisma: PrismaClient,
  body: EmailVerifyBody,
): Promise<AuthTokens> {
  await verifyOtp(prisma, body.email, 'signup', body.code);

  const user = await prisma.user.findUnique({ where: { email: body.email } });
  if (!user) throw AppError.notFound('No account found for this email');

  const activated = await prisma.user.update({
    where: { id: user.id },
    data: { email_verified: true, is_active: true },
  });

  await ensureEmailIdentity(prisma, activated.id, activated.email);

  return issueTokenPair(prisma, activated);
}

// ─── OAuth / Telegram sign-in (auth_tz.md §1, §3–§5, §7) ────────────────────────

/**
 * Turn a resolved provider profile into a session: find-or-create the local
 * account (auto-merging onto an existing account by verified email; §5), then
 * issue a token pair. Shared by every OAuth/Telegram callback — email+password is
 * the only flow that does not go through here.
 */
export async function loginWithProvider(
  prisma: PrismaClient,
  profile: ProviderProfile,
): Promise<AuthTokens> {
  const user = await findOrCreateFromProvider(prisma, profile);
  return issueTokenPair(prisma, user);
}

// ─── Connected-accounts management (auth_tz.md §10) ─────────────────────────────

/** A linked login method as returned to the "Connected accounts" screen. */
export interface IdentitySummary {
  id: string;
  provider: AuthProvider;
  provider_email: string | null;
  created_at: Date;
}

function toIdentitySummary(identity: AuthIdentity): IdentitySummary {
  return {
    id: identity.id,
    provider: identity.provider,
    provider_email: identity.provider_email,
    created_at: identity.created_at,
  };
}

/** List the account's linked login methods, oldest first (auth_tz.md §10). */
export async function listIdentities(
  prisma: PrismaClient,
  userId: string,
): Promise<IdentitySummary[]> {
  const identities = await prisma.authIdentity.findMany({
    where: { user_id: userId },
    orderBy: { created_at: 'asc' },
  });
  return identities.map(toIdentitySummary);
}

/**
 * Attach a resolved provider identity to the current account (auth_tz.md §10).
 * "Find" semantics with an ownership guard: if the (provider, provider_user_id)
 * identity already exists it must belong to this user (idempotent) — otherwise it
 * is owned by someone else and we refuse rather than steal it. A brand-new identity
 * is created against this account. Runs in a transaction so the check + create are
 * atomic; the UNIQUE(provider, provider_user_id) constraint is the final backstop.
 */
export async function linkIdentity(
  prisma: PrismaClient,
  userId: string,
  profile: ProviderProfile,
): Promise<IdentitySummary> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.authIdentity.findUnique({
      where: {
        provider_provider_user_id: {
          provider: profile.provider,
          provider_user_id: profile.provider_user_id,
        },
      },
    });

    if (existing) {
      if (existing.user_id === userId) return toIdentitySummary(existing); // already linked
      throw AppError.conflict('This login method is already linked to a different account');
    }

    const created = await tx.authIdentity.create({
      data: {
        user_id: userId,
        provider: profile.provider,
        provider_user_id: profile.provider_user_id,
        provider_email: profile.email ?? null,
      },
    });
    return toIdentitySummary(created);
  });
}

/**
 * Link a Telegram account to the current user (auth_tz.md §10). Consumes a
 * confirmed login token (enforces its session binding + TTL + one-time use via
 * {@link consumeLoginToken}), then attaches the tapper's telegram_id. The token
 * must already be `confirmed`; anything else means the handshake isn't complete.
 */
export async function linkTelegram(
  prisma: PrismaClient,
  userId: string,
  token: string,
  sessionId: string | undefined,
): Promise<IdentitySummary> {
  const state = await consumeLoginToken(prisma, token, sessionId);
  if (state.status !== 'confirmed') {
    throw AppError.badRequest(
      `Telegram sign-in is not confirmed yet (status: ${state.status}). Confirm in the bot, then retry.`,
    );
  }
  return linkIdentity(prisma, userId, {
    provider: 'telegram',
    provider_user_id: state.telegram_id,
  });
}

/**
 * Unlink the account's login method(s) for a provider (auth_tz.md §10). Hard guard:
 * the last remaining login method cannot be removed — that would lock the user out
 * of every sign-in flow. 404 when the provider isn't linked at all.
 */
export async function unlinkIdentity(
  prisma: PrismaClient,
  userId: string,
  provider: AuthProvider,
): Promise<void> {
  const identities = await prisma.authIdentity.findMany({ where: { user_id: userId } });
  const targeted = identities.filter((i) => i.provider === provider);

  if (targeted.length === 0) {
    throw AppError.notFound('No linked login method for this provider');
  }
  if (identities.length - targeted.length < 1) {
    throw AppError.forbidden(
      'Cannot remove your last login method — link another sign-in method first',
    );
  }

  await prisma.authIdentity.deleteMany({ where: { user_id: userId, provider } });
}

// ─── Telegram deep-link login (auth_tz.md §7) ───────────────────────────────────

export interface TelegramInitResult {
  deep_link: string;
  token: string;
  expires_at: Date;
}

/**
 * Start a Telegram handshake: mint a `pending` login token bound to the initiating
 * browser session, and return the `t.me` deep-link plus the token (the site polls
 * `telegramStatus` with it). The caller stores `sessionId` in the browser.
 */
export async function telegramInit(
  prisma: PrismaClient,
  sessionId: string,
): Promise<TelegramInitResult> {
  const { token, expires_at } = await initLoginToken(prisma, sessionId);
  return { deep_link: buildTelegramDeepLink(token), token, expires_at };
}

/**
 * Process a Telegram webhook update (auth_tz.md §7 steps 3–4). A `/start <token>`
 * message gets a confirm inline-button; tapping it sends a `callback_query` whose
 * `confirm:<token>` data confirms the token and attaches the tapper's `telegram_id`.
 * Every branch answers the user so the bot never goes silent; failures are surfaced
 * as friendly messages rather than thrown (Telegram just needs a 200).
 */
export async function handleTelegramUpdate(
  prisma: PrismaClient,
  update: TelegramUpdate,
): Promise<void> {
  // Button tap → confirm the login.
  if (update.callback_query) {
    const cq = update.callback_query;
    const data = cq.data ?? '';
    if (!data.startsWith(CONFIRM_CALLBACK_PREFIX)) {
      await answerCallbackQuery(cq.id, 'Unknown action.');
      return;
    }
    const token = data.slice(CONFIRM_CALLBACK_PREFIX.length);
    try {
      await confirmLoginToken(prisma, token, String(cq.from.id));
      await answerCallbackQuery(cq.id, 'Signed in! Head back to the website.');
    } catch (err) {
      await answerCallbackQuery(
        cq.id,
        err instanceof AppError ? err.message : 'Could not confirm sign-in.',
      );
    }
    return;
  }

  // `/start <token>` → send the confirm button (only for a live pending token).
  const message = update.message;
  if (message?.text) {
    const chatId = message.chat.id;
    const token = parseStartToken(message.text);
    if (!token) {
      await sendBotMessage(
        chatId,
        'Open this bot from the website’s “Sign in with Telegram” button to log in.',
      );
      return;
    }

    const row = await prisma.telegramLoginToken.findUnique({ where: { token } });
    if (!row || row.status !== 'pending' || row.expires_at < new Date()) {
      await sendBotMessage(
        chatId,
        'This sign-in link is invalid or has expired. Please start again from the website.',
      );
      return;
    }

    await sendConfirmPrompt(chatId, token);
  }
}

export type TelegramStatusResult =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'used' }
  | ({ status: 'authenticated' } & AuthTokens);

/**
 * Poll a Telegram login token (auth_tz.md §7 step 6). On the first `confirmed` read
 * the token is consumed (one-time) and we find-or-create the account by `telegram_id`
 * (no email) and issue a session. `pending`/`expired`/`used` are reported as-is.
 * Session binding + TTL are enforced in {@link consumeLoginToken}.
 */
export async function telegramStatus(
  prisma: PrismaClient,
  token: string,
  sessionId: string | undefined,
): Promise<TelegramStatusResult> {
  const state = await consumeLoginToken(prisma, token, sessionId);
  if (state.status !== 'confirmed') return state;

  const tokens = await loginWithProvider(prisma, {
    provider: 'telegram',
    provider_user_id: state.telegram_id,
  });
  return { status: 'authenticated', ...tokens };
}

/** Extract the `start` payload from a `/start <token>` command, else null. */
function parseStartToken(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/start')) return null;
  const parts = trimmed.split(/\s+/);
  return parts[1] ?? null;
}

export async function refresh(prisma: PrismaClient, rawToken: string): Promise<AuthTokens> {
  let payload: { sub: string; jti: string };
  try {
    payload = verifyRefreshToken(rawToken) as { sub: string; jti: string };
  } catch {
    throw AppError.unauthorized('Invalid or expired refresh token');
  }

  const stored = await prisma.refreshToken.findUnique({ where: { id: payload.jti } });
  if (!stored || stored.revoked_at !== null || stored.expires_at < new Date()) {
    throw AppError.unauthorized('Refresh token has been revoked or expired');
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: payload.sub } });

  // Rotate: revoke the old token record, then issue a fresh pair.
  await prisma.refreshToken.update({ where: { id: stored.id }, data: { revoked_at: new Date() } });

  return issueTokenPair(prisma, user);
}

export async function logout(prisma: PrismaClient, rawToken: string): Promise<void> {
  let jti: string;
  try {
    jti = (verifyRefreshToken(rawToken) as { jti: string }).jti;
  } catch {
    return; // Expired/invalid token — already effectively logged out.
  }

  await prisma.refreshToken.updateMany({
    where: { id: jti, revoked_at: null },
    data: { revoked_at: new Date() },
  });
}

export async function getMe(prisma: PrismaClient, userId: string): Promise<SafeUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw AppError.notFound('User not found');
  return stripHash(user);
}

export async function updateMe(
  prisma: PrismaClient,
  userId: string,
  body: UpdateMeBody,
): Promise<SafeUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw AppError.notFound('User not found');

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(body.display_name !== undefined && { display_name: body.display_name }),
      ...(body.avatar_url !== undefined && { avatar_url: body.avatar_url }),
    },
  });

  return stripHash(updated);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Ensure the account has an `email` identity row (auth_tz.md §2). Idempotent:
 * `email` identities have a null `provider_user_id`, so the (provider,
 * provider_user_id) unique can't dedupe them — we check by user + provider first.
 */
async function ensureEmailIdentity(
  prisma: PrismaClient,
  userId: string,
  email: string | null,
): Promise<void> {
  const existing = await prisma.authIdentity.findFirst({
    where: { user_id: userId, provider: 'email' },
  });
  if (existing) return;

  await prisma.authIdentity.create({
    data: { user_id: userId, provider: 'email', provider_user_id: null, provider_email: email },
  });
}

async function issueTokenPair(prisma: PrismaClient, user: User): Promise<AuthTokens> {
  // Create the DB row first to obtain its `id`, which becomes the JWT `jti`.
  // The token_hash column is not used (we store the id in the JWT jti instead).
  const record = await prisma.refreshToken.create({
    data: {
      user_id: user.id,
      token_hash: crypto.randomUUID(), // unique placeholder; real identity is the row id via jti
      expires_at: ttlToDate(config.JWT_REFRESH_TTL),
    },
  });

  return {
    access_token: signAccessToken(user.id),
    refresh_token: signRefreshToken(user.id, record.id),
    user: stripHash(user),
  };
}
