// Transactional email builders.
//
// Each function shapes a specific message (subject + body) and hands it to the
// shared transport (`lib/mailer`). The transport decides delivery (console stub
// in dev/test, SMTP in prod), so these stay pure and easy to read/test.

import { sendMail } from './mailer.js';
import type { EmailOtpPurpose } from '@prisma/client';

// Copy is Russian (the product's primary locale, DECISIONS.md ADR-002); localized
// HTML templates per user locale come with the notification dispatcher (Ф8).

/** "23 октября 2026 г." — dates in emails are shown in the Russian long form. */
function formatDateRu(date: Date): string {
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

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
    subject: `Приглашение в «${payload.workspaceName}»`,
    text: [
      `${payload.inviterName} приглашает вас в рабочее пространство «${payload.workspaceName}».`,
      '',
      `Принять приглашение: ${payload.inviteUrl}`,
      `Приглашение действует до ${formatDateRu(payload.expiresAt)}.`,
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
    subject: `${payload.inviterName} приглашает вас в «${payload.workspaceName}»`,
    text: [
      `${payload.inviterName} приглашает вас в рабочее пространство «${payload.workspaceName}».`,
      '',
      `Посмотреть и принять приглашение: ${payload.inboxUrl}`,
      `Приглашение действует до ${formatDateRu(payload.expiresAt)}.`,
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
    ? `${payload.actorName} назначил(а) вам ${payload.issueKey}: ${payload.issueTitle}`
    : `Новая задача в «${payload.projectName}» — ${payload.issueKey}: ${payload.issueTitle}`;
  const lead = payload.assigned
    ? `${payload.actorName} назначил(а) вам задачу.`
    : `${payload.actorName} создал(а) задачу в проекте «${payload.projectName}».`;
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
      ? 'подтвердить адрес электронной почты'
      : purpose === 'delete_account'
        ? 'безвозвратно удалить аккаунт'
        : 'войти в систему';
  // Deletion is destructive, so the "didn't request this" line nudges toward securing
  // the account rather than a neutral "ignore this email".
  const footer =
    purpose === 'delete_account'
      ? 'Код действует 10 минут. Если вы не запрашивали удаление аккаунта, проигнорируйте это письмо и смените пароль.'
      : 'Код действует 10 минут. Если вы не запрашивали код, просто проигнорируйте это письмо.';
  await sendMail({
    to,
    subject: `Код подтверждения: ${code}`,
    text: [`Используйте этот код, чтобы ${action}:`, '', `    ${code}`, '', footer].join('\n'),
  });
}
