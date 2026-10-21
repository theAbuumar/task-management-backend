// Codes that confirm a sensitive action of a signed-in person: deleting the account,
// setting a password (12.B12) and handing a workspace over (12.B3).
//
// The code goes wherever the account can be reached — its email, otherwise the
// Telegram bot for a Telegram-only account — and is checked against the same target
// it was issued for. Issuing, expiry, attempts and single use are otp.service's.

import type { PrismaClient, User } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { sendOtpEmail } from '../../lib/email.js';
import { issueOtp, verifyOtp, type OtpTarget } from './otp.service.js';
import { sendCodeViaTelegram } from './telegram.service.js';

export type AccountCodePurpose = 'delete_account' | 'set_password' | 'transfer_ownership';

/** Where a confirmation code was sent. */
export interface CodeChallenge {
  status: 'otp_sent';
  channel: 'email' | 'telegram';
  /** Present only for the email channel (the address the code was sent to). */
  email?: string;
}

/** The OTP target a person's codes are bound to: the email if any, else the user id. */
export function codeTarget(user: Pick<User, 'id' | 'email'>): OtpTarget {
  return user.email ? { email: user.email } : { userId: user.id };
}

/**
 * Send `user` a code for `purpose`. A password is only useful with an email to sign
 * in with, so `set_password` needs one (400 `EMAIL_REQUIRED`); the other purposes fall
 * back to Telegram. An account with neither channel gets 400 `NO_CODE_CHANNEL`.
 */
export async function sendAccountCode(
  prisma: PrismaClient,
  user: User,
  purpose: AccountCodePurpose,
): Promise<CodeChallenge> {
  if (user.email) {
    const code = await issueOtp(prisma, { email: user.email }, purpose);
    await sendOtpEmail(user.email, code, purpose, user.locale === 'en' ? 'en' : 'ru');
    return { status: 'otp_sent', channel: 'email', email: user.email };
  }
  if (purpose === 'set_password') {
    throw new AppError(
      400,
      'EMAIL_REQUIRED',
      'A password signs in together with an email. Add an email to the account first.',
    );
  }

  // No email: the bot chat id of a private chat equals the linked telegram id.
  const telegram = await prisma.authIdentity.findFirst({
    where: { user_id: user.id, provider: 'telegram' },
  });
  if (telegram?.provider_user_id) {
    const code = await issueOtp(prisma, { userId: user.id }, purpose);
    await sendCodeViaTelegram(Number(telegram.provider_user_id), code, purpose);
    return { status: 'otp_sent', channel: 'telegram' };
  }

  throw new AppError(
    400,
    'NO_CODE_CHANNEL',
    'This account has no email or Telegram to send a confirmation code to. Link an email or Telegram sign-in method first, then try again.',
  );
}

/** Check (and consume) a code `user` received for `purpose`. */
export function verifyAccountCode(
  prisma: PrismaClient,
  user: Pick<User, 'id' | 'email'>,
  purpose: AccountCodePurpose,
  code: string,
): Promise<void> {
  return verifyOtp(prisma, codeTarget(user), purpose, code);
}
