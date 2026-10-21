// Transactional email builders.
//
// Each function shapes a specific message and hands it to the shared transport
// (`lib/mailer`). Every letter is the common HTML layout plus its plain-text version
// (Ф8 8.B4, ADR-033), in the reader's language when they have an account (`ru` for
// people who are not registered yet). Notification letters about tasks are built by
// the dispatcher (`lib/notify/render.ts`).

import { sendMail } from './mailer.js';
import type { EmailOtpPurpose } from '@prisma/client';
import { renderEmail, type EmailWorkspace } from './notify/email-layout.js';
import { longDate, type Locale } from './notify/texts.js';

const until = (expiresAt: Date, locale: Locale) =>
  locale === 'en'
    ? `The invitation is valid until ${longDate(expiresAt, locale, 'UTC')}.`
    : `Приглашение действует до ${longDate(expiresAt, locale, 'UTC')}.`;

export interface InviteEmailPayload {
  to: string;
  workspaceName: string;
  /** Logo and short name for the letter's header. */
  workspace?: EmailWorkspace;
  inviterName: string;
  inviteUrl: string;
  expiresAt: Date;
}

/** Invite a person who may not have an account yet: the link leads to sign-up. */
export async function sendInviteEmail(payload: InviteEmailPayload): Promise<void> {
  const heading = `${payload.inviterName} приглашает вас в «${payload.workspaceName}»`;
  const letter = renderEmail({
    locale: 'ru',
    workspace: payload.workspace ?? { name: payload.workspaceName },
    heading,
    paragraphs: [
      'Это система контроля поручений: здесь вы будете получать задачи и поручения, сдавать результат на проверку и следить за сроками.',
    ],
    button: { label: 'Принять приглашение', url: payload.inviteUrl },
    footer: [
      until(payload.expiresAt, 'ru'),
      'Если вы не ждали приглашения, просто проигнорируйте письмо.',
    ],
  });
  await sendMail({
    to: payload.to,
    subject: `Приглашение в «${payload.workspaceName}»`,
    ...letter,
  });
}

export interface MemberInviteEmailPayload {
  to: string;
  workspaceName: string;
  workspace?: EmailWorkspace;
  inviterName: string;
  /** Link to the recipient's in-app invitations inbox where they accept/decline. */
  inboxUrl: string;
  expiresAt: Date;
  locale?: Locale;
}

/**
 * Notify an ALREADY-REGISTERED user that they've been invited to a workspace. Unlike
 * {@link sendInviteEmail} (which links strangers to a token page to register), the
 * recipient already has an account, so the link points at their signed-in invitations
 * inbox where they accept or decline.
 */
export async function sendMemberInviteEmail(payload: MemberInviteEmailPayload): Promise<void> {
  const locale = payload.locale ?? 'ru';
  const en = locale === 'en';
  const heading = en
    ? `${payload.inviterName} invites you to «${payload.workspaceName}»`
    : `${payload.inviterName} приглашает вас в «${payload.workspaceName}»`;
  const letter = renderEmail({
    locale,
    workspace: payload.workspace ?? { name: payload.workspaceName },
    heading,
    paragraphs: [
      en
        ? 'Accept or decline the invitation on the «Invitations» page.'
        : 'Принять или отклонить приглашение можно на странице «Приглашения».',
    ],
    button: { label: en ? 'Open invitations' : 'Открыть приглашения', url: payload.inboxUrl },
    footer: [until(payload.expiresAt, locale)],
  });
  await sendMail({ to: payload.to, subject: heading, ...letter });
}

/** Send a one-time verification code (auth_tz.md §6). `purpose` tailors the copy. */
export async function sendOtpEmail(
  to: string,
  code: string,
  purpose: EmailOtpPurpose,
  locale: Locale = 'ru',
): Promise<void> {
  const en = locale === 'en';
  const action =
    purpose === 'signup'
      ? en
        ? 'confirm your email address'
        : 'подтвердить адрес электронной почты'
      : purpose === 'delete_account'
        ? en
          ? 'permanently delete your account'
          : 'безвозвратно удалить аккаунт'
        : en
          ? 'sign in'
          : 'войти в систему';
  // Deletion is destructive, so the "didn't request this" line nudges toward securing
  // the account rather than a neutral "ignore this email".
  const footer =
    purpose === 'delete_account'
      ? en
        ? 'The code is valid for 10 minutes. If you did not ask to delete your account, ignore this email and change your password.'
        : 'Код действует 10 минут. Если вы не запрашивали удаление аккаунта, проигнорируйте это письмо и смените пароль.'
      : en
        ? 'The code is valid for 10 minutes. If you did not ask for a code, just ignore this email.'
        : 'Код действует 10 минут. Если вы не запрашивали код, просто проигнорируйте это письмо.';
  const letter = renderEmail({
    locale,
    heading: en ? `Use this code to ${action}` : `Используйте этот код, чтобы ${action}`,
    code,
    footer: [footer],
  });
  await sendMail({
    to,
    subject: en ? `Verification code: ${code}` : `Код подтверждения: ${code}`,
    ...letter,
  });
}
