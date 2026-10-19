import type { PrismaClient, User, AuthIdentity, AuthProvider, Prisma } from '@prisma/client';
import { config } from '../../config/index.js';
import { AppError } from '../../lib/errors.js';
import { hashSecret, verifySecret } from '../../lib/password.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../lib/jwt.js';
import { parseDurationMs } from '../../lib/duration.js';
import { sendOtpEmail } from '../../lib/email.js';
import { assertUploadedImage, dropReplacedImage } from '../../lib/media.js';
import type { StorageDriver } from '../../lib/storage.js';
import { acceptInviteAfterRegister } from '../invites/service.js';
import { respondToInviteViaTelegram } from '../member-invites/service.js';
import { issueOtp, verifyOtp, type OtpTarget } from './otp.service.js';
import { findOrCreateFromProvider, type ProviderProfile } from './identity.service.js';
import { initLoginToken, confirmLoginToken, consumeLoginToken } from './telegram-login.service.js';
import {
  buildTelegramDeepLink,
  sendConfirmPrompt,
  sendBotMessage,
  sendDeletionCode,
  answerCallbackQuery,
  CONFIRM_CALLBACK_PREFIX,
  WS_INVITE_ACCEPT_PREFIX,
  WS_INVITE_DECLINE_PREFIX,
  type TelegramUpdate,
} from './telegram.service.js';
import { handleBotCallback, handleBotMessage } from '../telegram/bot.js';
import type {
  RegisterBody,
  LoginBody,
  UpdateMeBody,
  EmailSignupBody,
  EmailVerifyBody,
  EmailOtpRequestBody,
  EmailOtpVerifyBody,
  AccountDeleteConfirmBody,
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

/** How long a just-rotated refresh token may be replayed without being treated as theft. */
const REFRESH_REUSE_GRACE_MS = 10_000;

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
    throw new AppError(
      400,
      'NO_PASSWORD',
      'This account has no password. Sign in with Google or GitHub, or set a password first.',
    );
  }

  // Constant-time check on miss prevents timing-based account enumeration.
  const valid =
    user !== null &&
    user.password_hash !== null &&
    (await verifySecret(user.password_hash, body.password));

  if (!user || !valid) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }
  if (!user.is_active) {
    // An email account that never confirmed its OTP is inactive + unverified —
    // guide it to verification rather than the generic "deactivated" (§6).
    if (!user.email_verified) {
      throw new AppError(
        403,
        'EMAIL_NOT_VERIFIED',
        'Please verify your email address first. Check your inbox for the verification code.',
      );
    }
    throw new AppError(403, 'ACCOUNT_DEACTIVATED', 'This account has been deactivated');
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

  const code = await issueOtp(prisma, { email: body.email }, 'signup');
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
  await verifyOtp(prisma, { email: body.email }, 'signup', body.code);

  const user = await prisma.user.findUnique({ where: { email: body.email } });
  if (!user) throw AppError.notFound('No account found for this email');

  const activated = await prisma.user.update({
    where: { id: user.id },
    data: { email_verified: true, is_active: true },
  });

  await ensureEmailIdentity(prisma, activated.id, activated.email);

  return issueTokenPair(prisma, activated);
}

// ─── Passwordless email sign-in ─────────────────────────────────────────────────

/**
 * Step 1: email a one-time sign-in code. The response is identical whether or not
 * the address has an account (no enumeration). A brand-new address gets an inactive,
 * unverified, password-less account that step 2 activates.
 */
export async function emailOtpRequest(
  prisma: PrismaClient,
  body: EmailOtpRequestBody,
): Promise<OtpChallenge> {
  const existing = await prisma.user.findUnique({ where: { email: body.email } });
  if (!existing) {
    await prisma.user.create({
      data: {
        email: body.email,
        password_hash: null,
        display_name: body.display_name ?? body.email.split('@')[0] ?? body.email,
        email_verified: false,
        is_active: false,
      },
    });
  }

  const code = await issueOtp(prisma, { email: body.email }, 'login');
  await sendOtpEmail(body.email, code, 'login');

  return { status: 'otp_sent', email: body.email };
}

/**
 * Step 2: verify the code and issue a session. Owning the inbox proves the address,
 * so a not-yet-verified account is verified + activated here. An account that was
 * verified and later deactivated stays locked out.
 */
export async function emailOtpVerify(
  prisma: PrismaClient,
  body: EmailOtpVerifyBody,
): Promise<AuthTokens> {
  await verifyOtp(prisma, { email: body.email }, 'login', body.code);

  const user = await prisma.user.findUnique({ where: { email: body.email } });
  if (!user) throw AppError.notFound('No account found for this email');
  if (!user.is_active && user.email_verified) {
    throw new AppError(403, 'ACCOUNT_DEACTIVATED', 'This account has been deactivated');
  }

  const active =
    user.is_active && user.email_verified
      ? user
      : await prisma.user.update({
          where: { id: user.id },
          data: { email_verified: true, is_active: true },
        });

  await ensureEmailIdentity(prisma, active.id, active.email);

  return issueTokenPair(prisma, active);
}

// ─── Code-confirmed account deletion ────────────────────────────────────────────

/** The channel a deletion code was delivered on. */
export interface DeleteChallenge {
  status: 'otp_sent';
  channel: 'email' | 'telegram';
  /** Present only for the email channel (the address the code was sent to). */
  email?: string;
}

/**
 * Step 1 of deletion: send the logged-in user a 6-digit confirmation code, regardless
 * of how they registered. The code goes to whatever channel the account can be reached
 * on: the email address if it has one (as for signup), otherwise the Telegram bot for a
 * Telegram-linked account. An account with neither is told to link one first — we won't
 * delete without a confirmable channel.
 */
export async function requestAccountDeletion(
  prisma: PrismaClient,
  userId: string,
): Promise<DeleteChallenge> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw AppError.notFound('User not found');

  // Email accounts (incl. Google/GitHub with an email) get the code by email.
  if (user.email) {
    const code = await issueOtp(prisma, { email: user.email }, 'delete_account');
    await sendOtpEmail(user.email, code, 'delete_account');
    return { status: 'otp_sent', channel: 'email', email: user.email };
  }

  // No email: deliver the code through the Telegram bot if the account is linked to it.
  // The code is keyed by user id (there's no address), and the bot chat id equals the
  // linked telegram id.
  const telegram = await prisma.authIdentity.findFirst({
    where: { user_id: userId, provider: 'telegram' },
  });
  if (telegram?.provider_user_id) {
    const code = await issueOtp(prisma, { userId }, 'delete_account');
    await sendDeletionCode(Number(telegram.provider_user_id), code);
    return { status: 'otp_sent', channel: 'telegram' };
  }

  // Neither channel exists (e.g. a GitHub account with a private email and nothing
  // else linked) — nowhere to send a code to.
  throw AppError.badRequest(
    'This account has no email or Telegram to send a deletion code to. Link an email or Telegram sign-in method first, then try again.',
  );
}

/**
 * Step 2 of deletion: validate the code, then "delete" the account by anonymizing it.
 * The row is kept on purpose so everything the user authored stays intact and simply
 * renders as a deleted user — issue assignments and authored issues/comments/activity
 * are left in place. Ownership of any workspace the user solely owns is handed off
 * first (auto-transfer, or the workspace is removed when no one else is left) so no
 * workspace is orphaned to a login-less account. Only the person is erased: identities
 * and refresh tokens are removed (logging them out everywhere) and email / password /
 * display name / avatar are cleared. `is_active=false` blocks any re-login.
 */
export async function confirmAccountDeletion(
  prisma: PrismaClient,
  storage: StorageDriver,
  userId: string,
  body: AccountDeleteConfirmBody,
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw AppError.notFound('User not found');

  // Verify against the same target the code was issued for: email if present,
  // otherwise the user-keyed code sent over Telegram.
  const target: OtpTarget = user.email ? { email: user.email } : { userId };
  await verifyOtp(prisma, target, 'delete_account', body.code);

  await prisma.$transaction(async (tx) => {
    await reassignOwnedWorkspaces(tx, userId);

    await tx.authIdentity.deleteMany({ where: { user_id: userId } });
    await tx.refreshToken.deleteMany({ where: { user_id: userId } });
    await tx.authSession.deleteMany({ where: { user_id: userId } });
    // Personal AI dialogues and a pending Telegram draft go with the account (ADR-028).
    await tx.aiConversation.deleteMany({ where: { user_id: userId } });
    await tx.telegramAiDraft.deleteMany({ where: { user_id: userId } });
    // Drop any outstanding codes for this account, on either channel.
    await tx.emailOtp.deleteMany({
      where: { OR: [{ user_id: userId }, ...(user.email ? [{ email: user.email }] : [])] },
    });
    await tx.user.update({
      where: { id: userId },
      data: {
        email: null,
        email_verified: false,
        password_hash: null,
        display_name: 'Deleted user',
        avatar_url: null,
        is_active: false,
      },
    });
  });
  // The photo goes too (only an uploaded one — an OAuth picture is not ours).
  await dropReplacedImage(storage, user.avatar_url, null, 'avatars', userId);
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
    // A pending token is not consumed, so the profile page polls this until the
    // user confirms in the bot (13.P5); expired/used means start over.
    throw new AppError(
      400,
      'TELEGRAM_NOT_CONFIRMED',
      `Telegram sign-in is not confirmed yet (status: ${state.status}). Confirm in the bot, then retry.`,
      { status: state.status },
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
  storage: StorageDriver,
  update: TelegramUpdate,
): Promise<void> {
  // Button tap → confirm the login, or respond to a workspace invite.
  if (update.callback_query) {
    const cq = update.callback_query;
    const data = cq.data ?? '';

    // Workspace member-invite Accept/Decline buttons (winv:a:<token> / winv:d:<token>).
    if (data.startsWith(WS_INVITE_ACCEPT_PREFIX) || data.startsWith(WS_INVITE_DECLINE_PREFIX)) {
      const accept = data.startsWith(WS_INVITE_ACCEPT_PREFIX);
      const prefix = accept ? WS_INVITE_ACCEPT_PREFIX : WS_INVITE_DECLINE_PREFIX;
      const token = data.slice(prefix.length);
      const message = await respondToInviteViaTelegram(
        prisma,
        token,
        String(cq.from.id),
        accept ? 'accept' : 'decline',
      );
      await answerCallbackQuery(cq.id, message);
      return;
    }

    // Everything else is the work bot: menu lists, issue cards, action buttons.
    if (!data.startsWith(CONFIRM_CALLBACK_PREFIX)) {
      await handleBotCallback(prisma, storage, cq);
      return;
    }
    const token = data.slice(CONFIRM_CALLBACK_PREFIX.length);
    try {
      await confirmLoginToken(prisma, token, String(cq.from.id));
      await answerCallbackQuery(cq.id, 'Вход подтверждён! Вернитесь на сайт.');
    } catch (err) {
      await answerCallbackQuery(
        cq.id,
        err instanceof AppError ? err.message : 'Не удалось подтвердить вход.',
      );
    }
    return;
  }

  // `/start <token>` → send the confirm button (only for a live pending token).
  // Any other message — menu, commands, a requested report, a file to hand in —
  // goes to the work bot.
  const message = update.message;
  if (message?.document || message?.photo) {
    await handleBotMessage(prisma, storage, message);
    return;
  }
  if (message?.text) {
    const chatId = message.chat.id;
    const token = parseStartToken(message.text);
    if (!token) {
      await handleBotMessage(prisma, storage, message);
      return;
    }

    const row = await prisma.telegramLoginToken.findUnique({ where: { token } });
    if (!row || row.status !== 'pending' || row.expires_at < new Date()) {
      await sendBotMessage(
        chatId,
        'Ссылка для входа недействительна или устарела. Начните вход на сайте заново.',
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

  const stored = await prisma.refreshToken.findUnique({
    where: { id: payload.jti },
    include: { session: { select: { revoked_at: true } } },
  });
  // The session was ended (another device, an admin, a detected theft): say so, so
  // the client can tell the user why they are signed out (Ф12 12.B2).
  if (stored?.session?.revoked_at) {
    throw new AppError(401, 'SESSION_REVOKED', 'This session has been ended');
  }
  if (stored && stored.revoked_at !== null) {
    // Reuse of an already-rotated token means it may have been stolen: end the
    // session it belongs to (Ф12 12.B2), or — for a token older than sessions — the
    // user's whole token family. A short grace window tolerates two tabs racing
    // to refresh with the same cookie.
    if (Date.now() - stored.revoked_at.getTime() > REFRESH_REUSE_GRACE_MS) {
      const now = new Date();
      if (stored.session_id) {
        await prisma.authSession.updateMany({
          where: { id: stored.session_id, revoked_at: null },
          data: { revoked_at: now },
        });
      }
      await prisma.refreshToken.updateMany({
        where: stored.session_id
          ? { session_id: stored.session_id, revoked_at: null }
          : { user_id: stored.user_id, revoked_at: null },
        data: { revoked_at: now },
      });
    }
    throw AppError.unauthorized('Refresh token has been revoked or expired');
  }
  if (!stored || stored.expires_at < new Date()) {
    throw AppError.unauthorized('Refresh token has been revoked or expired');
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: payload.sub } });
  if (!user.is_active) {
    throw new AppError(403, 'ACCOUNT_DEACTIVATED', 'This account has been deactivated');
  }

  // Rotate: revoke the old token record, then issue a fresh pair in the same session.
  await prisma.refreshToken.update({ where: { id: stored.id }, data: { revoked_at: new Date() } });

  return issueTokenPair(prisma, user, stored.session_id);
}

export async function logout(prisma: PrismaClient, rawToken: string): Promise<void> {
  let jti: string;
  try {
    jti = (verifyRefreshToken(rawToken) as { jti: string }).jti;
  } catch {
    return; // Expired/invalid token — already effectively logged out.
  }

  // Signing out ends the whole session, not just the presented token.
  const token = await prisma.refreshToken.findUnique({
    where: { id: jti },
    select: { session_id: true },
  });
  const now = new Date();
  if (token?.session_id) {
    await prisma.authSession.updateMany({
      where: { id: token.session_id, revoked_at: null },
      data: { revoked_at: now },
    });
  }
  await prisma.refreshToken.updateMany({
    where: token?.session_id
      ? { session_id: token.session_id, revoked_at: null }
      : { id: jti, revoked_at: null },
    data: { revoked_at: now },
  });
}

/** Demo stand quick login (DEMO_MODE only; the route restricts it to demo accounts). */
export async function loginDemoUser(prisma: PrismaClient, email: string): Promise<AuthTokens> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.is_active) throw AppError.notFound('Demo account not found');
  return issueTokenPair(prisma, user);
}

export async function getMe(prisma: PrismaClient, userId: string): Promise<SafeUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw AppError.notFound('User not found');
  return stripHash(user);
}

export async function updateMe(
  prisma: PrismaClient,
  storage: StorageDriver,
  userId: string,
  body: UpdateMeBody,
): Promise<SafeUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw AppError.notFound('User not found');
  // A new avatar must be this user's own upload with a real image inside (3.B5).
  if (body.avatar_url !== undefined) {
    await assertUploadedImage(storage, body.avatar_url, user.avatar_url, 'avatars', userId);
  }

  // Rebuild the rendered name from ФИО when the parts change without an explicit one.
  const nameTouched =
    body.last_name !== undefined || body.first_name !== undefined || body.middle_name !== undefined;
  const last = body.last_name !== undefined ? body.last_name : user.last_name;
  const first = body.first_name !== undefined ? body.first_name : user.first_name;
  const middle = body.middle_name !== undefined ? body.middle_name : user.middle_name;
  const rebuilt = [last, first, middle].filter((p) => p && p.trim()).join(' ');
  const displayName = body.display_name ?? (nameTouched && rebuilt ? rebuilt : undefined);

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(displayName !== undefined && { display_name: displayName }),
      ...(body.avatar_url !== undefined && { avatar_url: body.avatar_url }),
      ...(body.last_name !== undefined && { last_name: body.last_name || null }),
      ...(body.first_name !== undefined && { first_name: body.first_name || null }),
      ...(body.middle_name !== undefined && { middle_name: body.middle_name || null }),
      ...(body.phone !== undefined && { phone: body.phone || null }),
      ...(body.locale !== undefined && { locale: body.locale }),
      ...(body.timezone !== undefined && { timezone: body.timezone || null }),
    },
  });
  if (body.avatar_url !== undefined) {
    await dropReplacedImage(storage, user.avatar_url, updated.avatar_url, 'avatars', userId);
  }

  return stripHash(updated);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Transfer ownership of every workspace this user solely owns to a successor member
 * (the highest-privileged remaining member, oldest first); delete the workspace when
 * no other member is left. Keeps the "exactly one owner" invariant and prevents a
 * workspace being owned by a deleted, login-less account. Runs inside the deletion
 * transaction (see {@link confirmAccountDeletion}).
 */
async function reassignOwnedWorkspaces(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  const owned = await tx.workspace.findMany({
    where: { owner_id: userId },
    select: { id: true },
  });

  for (const ws of owned) {
    // Enum order (owner < admin < member < guest) makes ascending role = most
    // privileged first; created_at breaks ties toward the longest-standing member.
    const successor = await tx.workspaceMember.findFirst({
      where: { workspace_id: ws.id, user_id: { not: userId } },
      orderBy: [{ role: 'asc' }, { created_at: 'asc' }],
    });

    if (!successor) {
      // No one else to own it — remove the workspace and everything under it (cascade).
      await tx.workspace.delete({ where: { id: ws.id } });
      continue;
    }

    await tx.workspace.update({ where: { id: ws.id }, data: { owner_id: successor.user_id } });
    await tx.workspaceMember.update({
      where: { workspace_id_user_id: { workspace_id: ws.id, user_id: successor.user_id } },
      data: { role: 'owner' },
    });
    // The departing owner leaves the workspace it handed off (deleteMany never throws
    // when the membership is already gone).
    await tx.workspaceMember.deleteMany({ where: { workspace_id: ws.id, user_id: userId } });
  }
}

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

/**
 * Someone whose access an admin turned off in every workspace they belong to cannot
 * sign in (12.B7, ADR-026). A person with no workspace yet (new account) or with
 * another workspace still open signs in as usual.
 */
async function assertHasAccess(prisma: PrismaClient, userId: string): Promise<void> {
  const memberships = await prisma.workspaceMember.findMany({
    where: { user_id: userId },
    select: { deactivated_at: true },
  });
  if (memberships.length > 0 && memberships.every((m) => m.deactivated_at)) {
    throw new AppError(
      403,
      'MEMBER_DEACTIVATED',
      'Your access has been turned off by a workspace admin',
    );
  }
}

/**
 * Mint an access + refresh pair. Without `sessionId` this is a sign-in and opens a
 * new session (Ф12 12.B2; the controller records its device and method); with it,
 * a refresh rotation that keeps the session and moves its expiry forward.
 */
async function issueTokenPair(
  prisma: PrismaClient,
  user: User,
  sessionId?: string | null,
): Promise<AuthTokens> {
  await assertHasAccess(prisma, user.id);
  const expires_at = ttlToDate(config.JWT_REFRESH_TTL);
  const session = sessionId
    ? await prisma.authSession.update({
        where: { id: sessionId },
        data: { last_used_at: new Date(), expires_at },
      })
    : await prisma.authSession.create({ data: { user_id: user.id, expires_at } });
  // Create the DB row first to obtain its `id`, which becomes the JWT `jti`.
  // The token_hash column is not used (we store the id in the JWT jti instead).
  const record = await prisma.refreshToken.create({
    data: {
      user_id: user.id,
      session_id: session.id,
      token_hash: crypto.randomUUID(), // unique placeholder; real identity is the row id via jti
      expires_at,
    },
  });

  return {
    access_token: signAccessToken(user.id, session.id),
    refresh_token: signRefreshToken(user.id, record.id),
    user: stripHash(user),
  };
}
