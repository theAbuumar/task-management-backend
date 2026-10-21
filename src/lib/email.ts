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
import { frontendUrl } from './urls.js';

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
  const ACTIONS: Record<EmailOtpPurpose, [string, string]> = {
    signup: ['confirm your email address', 'подтвердить адрес электронной почты'],
    login: ['sign in', 'войти в систему'],
    delete_account: ['permanently delete your account', 'безвозвратно удалить аккаунт'],
    set_password: ['set a password for signing in', 'задать пароль для входа'],
    transfer_ownership: [
      'hand your workspace over to another member',
      'передать владение пространством другому сотруднику',
    ],
  };
  const action = ACTIONS[purpose][en ? 0 : 1];
  // Destructive or account-changing codes nudge toward securing the account rather
  // than a neutral "ignore this email".
  const sensitive = purpose !== 'signup' && purpose !== 'login';
  const footer = sensitive
    ? en
      ? 'The code is valid for 10 minutes. If it was not you, ignore this email and end your other sessions in the profile («My sessions»).'
      : 'Код действует 10 минут. Если это были не вы, проигнорируйте письмо и завершите другие сеансы в профиле («Мои сессии»).'
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

/**
 * «Пароль изменён» (12.B12): a password was set or changed. Sent every time, so the
 * owner of the inbox learns of a change they did not make; other sessions are already
 * ended by then.
 */
export async function sendPasswordChangedEmail(
  to: string,
  changedAt: Date,
  locale: Locale = 'ru',
  timeZone = 'UTC',
): Promise<void> {
  const en = locale === 'en';
  const when = new Intl.DateTimeFormat(en ? 'en-GB' : 'ru-RU', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone,
  }).format(changedAt);
  const heading = en ? 'Your password was changed' : 'Пароль для входа изменён';
  const letter = renderEmail({
    locale,
    heading,
    paragraphs: [
      en
        ? `The password for signing in to the assignment system was set on ${when}. Your other sessions have been ended.`
        : `Пароль для входа в систему поручений задан ${when}. Другие сеансы входа завершены.`,
    ],
    button: {
      label: en ? 'Open the profile' : 'Открыть профиль',
      url: frontendUrl('profile#password'),
    },
    footer: [
      en
        ? 'If it was not you, sign in with a code sent to this email and set a new password in the profile.'
        : 'Если это были не вы, войдите по коду из письма на этот адрес и задайте новый пароль в профиле.',
    ],
  });
  await sendMail({ to, subject: heading, ...letter });
}
