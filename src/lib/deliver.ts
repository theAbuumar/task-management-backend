// Out-of-band delivery of execution-control events (Ф5): one channel per
// recipient, chosen by their notification settings (8.B2) — Telegram when linked
// and wanted, else email as the fallback, nothing during quiet hours. Called AFTER the mutation commits; best-effort (never throws), like the
// issue-created fan-out in issues/service. The in-app Notification rows are written
// inside the transaction separately. Ф8 replaces this with the unified dispatcher.

import type { NotificationType, PrismaClient } from '@prisma/client';
import { channelFor } from './notification-prefs.js';
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

/**
 * Split recipients by out-of-band channel according to their notification settings
 * (8.B2): Telegram chat ids and email addresses; the rest get the in-app copy only.
 */
export async function routeRecipients(
  prisma: PrismaClient,
  userIds: string[],
  type: NotificationType,
  workspace: { id: string; timezone: string },
  now: Date = new Date(),
): Promise<{
  telegram: { userId: string; chatId: number }[];
  email: { userId: string; email: string }[];
}> {
  const users = await prisma.user.findMany({
    where: {
      id: { in: userIds },
      is_active: true,
      // Nothing leaves the app for a member whose access was turned off (12.B7).
      workspace_memberships: { some: { workspace_id: workspace.id, deactivated_at: null } },
    },
    select: {
      id: true,
      email: true,
      timezone: true,
      notification_settings: true,
      identities: telegramConfigured()
        ? {
            where: { provider: 'telegram', provider_user_id: { not: null } },
            select: { provider_user_id: true },
            take: 1,
          }
        : false,
    },
  });
  const out = {
    telegram: [] as { userId: string; chatId: number }[],
    email: [] as { userId: string; email: string }[],
  };
  for (const u of users) {
    const chat = u.identities?.[0]?.provider_user_id;
    const channel = channelFor(u.notification_settings, type, {
      hasTelegram: Boolean(chat),
      hasEmail: Boolean(u.email),
      now,
      timeZone: u.timezone ?? workspace.timezone,
    });
    if (channel === 'telegram') out.telegram.push({ userId: u.id, chatId: Number(chat) });
    else if (channel === 'email') out.email.push({ userId: u.id, email: u.email! });
  }
  return out;
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
        workspace: { select: { id: true, slug: true, timezone: true } },
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

    const routed = await routeRecipients(prisma, recipients, params.kind, issue.workspace);
    // Buttons act right in the chat: accept/return a hand-in, hand in again, decide
    // a deadline change; «Подробнее» opens the issue card (bot inside the backend).
    const buttonKind =
      params.kind === 'review_requested' ||
      params.kind === 'review_returned' ||
      params.kind === 'deadline_change_requested'
        ? params.kind
        : 'other';
    const reply_markup = { inline_keyboard: notificationButtons(buttonKind, params.issueId, link) };
    const sends: Promise<unknown>[] = routed.telegram.map((t) =>
      sendBotMessage(t.chatId, text, { reply_markup }),
    );
    const subject = `${head.split('\n')[0]!.replace(/^\S+\s/, '')}: ${issue.title}`;
    for (const u of routed.email) sends.push(sendMail({ to: u.email, subject, text }));
    await Promise.allSettled(sends);
  } catch {
    // Delivery is best-effort; the event itself already committed.
  }
}
