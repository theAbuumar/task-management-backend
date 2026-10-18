// Out-of-band delivery of execution-control events (Ф5): one channel per
// recipient — Telegram when the account is linked (and the bot configured), else
// email. Called AFTER the mutation commits; best-effort (never throws), like the
// issue-created fan-out in issues/service. The in-app Notification rows are written
// inside the transaction separately. Ф8 replaces this with the unified dispatcher.

import type { PrismaClient } from '@prisma/client';
import { sendMail } from './mailer.js';
import { issueUrl } from './urls.js';
import { pluralize } from './plural.js';
import { sendBotMessage, telegramConfigured } from '../modules/auth/telegram.service.js';
import { notificationButtons } from '../modules/telegram/views.js';

export type IssueEventKind =
  | 'review_requested'
  | 'review_approved'
  | 'review_returned'
  | 'acknowledged'
  | 'due_soon'
  | 'overdue'
  | 'escalated'
  | 'deadline_change_requested'
  | 'deadline_change_decided';

export interface IssueEventDetails {
  /** due_soon: days left (0 = today); overdue/escalated: days overdue. */
  days?: number;
  comment?: string | null;
  approved?: boolean;
  oldDue?: Date | null;
  newDue?: Date | null;
  reason?: string;
  /** escalated: name of the responsible assignee. */
  responsible?: string | null;
}

const DAYS: [string, string, string] = ['день', 'дня', 'дней'];

function headline(
  kind: IssueEventKind,
  actor: string,
  key: string,
  d: IssueEventDetails,
  fmt: (x?: Date | null) => string,
) {
  switch (kind) {
    case 'review_requested':
      return `📝 ${actor} сдал(а) на проверку ${key}`;
    case 'review_approved':
      return `✅ ${actor} принял(а) результат по ${key}`;
    case 'review_returned':
      return `↩️ ${actor} вернул(а) на доработку ${key}${d.comment ? `\nЗамечание: ${d.comment}` : ''}`;
    case 'acknowledged':
      return `👁 ${actor} ознакомился(ась) с поручением ${key}`;
    case 'due_soon':
      return d.days === 0
        ? `⏰ Сегодня срок по ${key}`
        : `⏰ Через ${pluralize(d.days ?? 1, DAYS)} срок по ${key} (${fmt(d.newDue)})`;
    case 'overdue':
      return `🔥 ${key} просрочено на ${pluralize(d.days ?? 1, DAYS)}`;
    case 'escalated':
      return `🚨 Эскалация: ${key} просрочено на ${pluralize(d.days ?? 1, DAYS)}${d.responsible ? `. Ответственный: ${d.responsible}` : ''}`;
    case 'deadline_change_requested':
      return `📅 ${actor} просит перенести срок ${key}: ${fmt(d.oldDue)} → ${fmt(d.newDue)}${d.reason ? `\nПричина: ${d.reason}` : ''}`;
    case 'deadline_change_decided':
      return d.approved
        ? `📅 Перенос срока ${key} на ${fmt(d.newDue)} одобрен`
        : `📅 Перенос срока ${key} отклонён${d.comment ? `\nКомментарий: ${d.comment}` : ''}`;
  }
}

export async function deliverIssueEvent(
  prisma: PrismaClient,
  params: {
    issueId: string;
    kind: IssueEventKind;
    recipientIds: string[];
    /** null for system events (reminders); the actor is never messaged. */
    actorId: string | null;
    details?: IssueEventDetails;
  },
): Promise<void> {
  try {
    const recipients = [...new Set(params.recipientIds)].filter((id) => id !== params.actorId);
    if (recipients.length === 0) return;

    const issue = await prisma.issue.findUnique({
      where: { id: params.issueId },
      select: {
        title: true,
        sequence_id: true,
        project: { select: { identifier: true } },
        workspace: { select: { slug: true, timezone: true } },
      },
    });
    if (!issue) return;
    const actor = params.actorId
      ? await prisma.user.findUnique({
          where: { id: params.actorId },
          select: { display_name: true },
        })
      : null;

    const key = `${issue.project.identifier}-${issue.sequence_id}`;
    const fmt = (x?: Date | null) =>
      x
        ? x.toLocaleDateString('ru-RU', {
            timeZone: issue.workspace.timezone,
            day: 'numeric',
            month: 'long',
          })
        : '—';
    const head = headline(
      params.kind,
      actor?.display_name ?? 'Система',
      key,
      params.details ?? {},
      fmt,
    );
    const link = issueUrl(issue.workspace.slug, key);
    const text = `${head}\n${issue.title}\n\n${link}`;

    const telegram = telegramConfigured()
      ? await prisma.authIdentity.findMany({
          where: {
            provider: 'telegram',
            user_id: { in: recipients },
            provider_user_id: { not: null },
          },
          select: { user_id: true, provider_user_id: true },
        })
      : [];
    const viaTelegram = new Set(telegram.map((t) => t.user_id));
    // Buttons act right in the chat: accept/return a hand-in, hand in again, decide
    // a deadline change; «Подробнее» opens the issue card (bot inside the backend).
    const buttonKind =
      params.kind === 'review_requested' ||
      params.kind === 'review_returned' ||
      params.kind === 'deadline_change_requested'
        ? params.kind
        : 'other';
    const reply_markup = { inline_keyboard: notificationButtons(buttonKind, params.issueId, link) };
    const sends: Promise<unknown>[] = telegram.map((t) =>
      sendBotMessage(Number(t.provider_user_id), text, { reply_markup }),
    );

    const emailIds = recipients.filter((id) => !viaTelegram.has(id));
    if (emailIds.length > 0) {
      const users = await prisma.user.findMany({
        where: { id: { in: emailIds }, email: { not: null } },
        select: { email: true },
      });
      const subject = `${head.split('\n')[0]!.replace(/^\S+\s/, '')}: ${issue.title}`;
      for (const u of users) sends.push(sendMail({ to: u.email!, subject, text }));
    }
    await Promise.allSettled(sends);
  } catch {
    // Delivery is best-effort; the event itself already committed.
  }
}
