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

export interface MemberInviteEmailPayload {
  to: string;
  workspaceName: string;
  inviterName: string;
  /** Link to the recipient's in-app invitations inbox where they accept/decline. */
  inboxUrl: string;
  expiresAt: Date;
}

/**
 * Notify an ALREADY-REGISTERED user that they've been invited to a workspace. Unlike
 * {@link sendInviteEmail} (which links strangers to a token page to register), the
 * recipient already has an account, so the link points at their signed-in invitations
 * inbox where they accept or decline.
 */
export async function sendMemberInviteEmail(payload: MemberInviteEmailPayload): Promise<void> {
  await sendMail({
    to: payload.to,
    subject: `${payload.inviterName} invited you to join ${payload.workspaceName}`,
    text: [
      `${payload.inviterName} invited you to join the "${payload.workspaceName}" workspace.`,
      '',
      `Review and accept the invite here: ${payload.inboxUrl}`,
      `This invite expires on ${payload.expiresAt.toISOString()}.`,
    ].join('\n'),
  });
}

export interface IssueNotificationEmailPayload {
  to: string;
  /** Human-readable issue key, e.g. "MOB-123". */
  issueKey: string;
  issueTitle: string;
  projectName: string;
  actorName: string;
  /** true when assigned to the recipient; false for the "new task for everyone" broadcast. */
  assigned: boolean;
}

/**
 * Notify a user about a task by email. This is the fallback channel used for recipients
 * who have NO linked Telegram (Telegram-linked users are messaged through the bot
 * instead); the issues service routes each recipient to exactly one of the two.
 */
export async function sendIssueNotificationEmail(
  payload: IssueNotificationEmailPayload,
): Promise<void> {
  const subject = payload.assigned
    ? `${payload.actorName} assigned you ${payload.issueKey}: ${payload.issueTitle}`
    : `New task in ${payload.projectName} — ${payload.issueKey}: ${payload.issueTitle}`;
  const lead = payload.assigned
    ? `${payload.actorName} assigned you a task.`
    : `${payload.actorName} created a task in "${payload.projectName}".`;
  await sendMail({
    to: payload.to,
    subject,
    text: [lead, '', `${payload.issueKey}  ${payload.issueTitle}`].join('\n'),
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
