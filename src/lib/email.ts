// Transactional email builders.
//
// Each function shapes a specific message (subject + body) and hands it to the
// shared transport (`lib/mailer`). The transport decides delivery (console stub
// in dev/test, SMTP in prod), so these stay pure and easy to read/test.

import { sendMail } from './mailer.js';
import type { EmailOtpPurpose } from '@prisma/client';

export interface InviteEmailPayload {
  to: string;
  workspaceName: string;
  inviterName: string;
  inviteUrl: string;
  expiresAt: Date;
}

export async function sendInviteEmail(payload: InviteEmailPayload): Promise<void> {
  await sendMail({
    to: payload.to,
    subject: `You've been invited to join ${payload.workspaceName}`,
    text: [
      `${payload.inviterName} invited you to join the "${payload.workspaceName}" workspace.`,
      '',
      `Accept the invite: ${payload.inviteUrl}`,
      `This invite expires on ${payload.expiresAt.toISOString()}.`,
    ].join('\n'),
  });
}

/** Send a one-time verification code (auth_tz.md §6). `purpose` tailors the copy. */
export async function sendOtpEmail(
  to: string,
  code: string,
  purpose: EmailOtpPurpose,
): Promise<void> {
  const action =
    purpose === 'signup'
      ? 'confirm your email address'
      : purpose === 'delete_account'
        ? 'permanently delete your account'
        : 'sign in';
  // Deletion is destructive, so the "didn't request this" line nudges toward securing
  // the account rather than a neutral "ignore this email".
  const footer =
    purpose === 'delete_account'
      ? 'The code expires in 10 minutes. If you did not request account deletion, ignore this email and consider changing your password.'
      : 'The code expires in 10 minutes. If you did not request it, you can ignore this email.';
  await sendMail({
    to,
    subject: `Your verification code: ${code}`,
    text: [`Use this code to ${action}:`, '', `    ${code}`, '', footer].join('\n'),
  });
}
