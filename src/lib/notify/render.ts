// A queued copy → the message itself (Ф8 8.B3, 8.B4, ADR-033), built at send time
// in the reader's language: Telegram text with action buttons, or an HTML email
// with a plain-text version.

import type { NotificationType } from '@prisma/client';
import type { BotMessageOptions } from '../../modules/auth/telegram.service.js';
import { notificationButtons } from '../../modules/telegram/views.js';
import { frontendUrl, issueUrl } from '../urls.js';
import { renderEmail, type EmailWorkspace } from './email-layout.js';
import {
  longDate,
  phrase,
  reasonLine,
  type DeliveryPayload,
  type EventContext,
  type Locale,
} from './texts.js';
import { digestEmail, digestTelegram, type DigestPayload } from './digest-render.js';

export interface RenderInput {
  type: NotificationType;
  locale: Locale;
  workspace: EmailWorkspace & { slug: string; timezone: string };
  issue: {
    id: string;
    key: string;
    title: string;
    project: string;
    kind: 'task' | 'assignment';
    due_date: Date | null;
  } | null;
  actor: string | null;
  payload: DeliveryPayload & Partial<DigestPayload>;
}

/** Where «Настроить уведомления» leads: the notification block of the profile. */
export const settingsUrl = (): string => frontendUrl('/profile#notifications');

function context(r: RenderInput): EventContext {
  return {
    type: r.type,
    actor: r.actor,
    workspace: r.workspace.name,
    key: r.issue?.key ?? '',
    title: r.issue?.title ?? '',
    project: r.issue?.project ?? '',
    kind: r.issue?.kind ?? 'task',
    timeZone: r.workspace.timezone,
    payload: r.payload,
  };
}

type ButtonKind = Parameters<typeof notificationButtons>[0];

function buttonKind(type: NotificationType): ButtonKind {
  return type === 'issue_assigned' ||
    type === 'review_requested' ||
    type === 'review_returned' ||
    type === 'deadline_change_requested'
    ? type
    : 'other';
}

/** The Telegram message: headline, task, link and buttons that act in the chat. */
export function telegramMessage(r: RenderInput): { text: string; opts: BotMessageOptions } {
  if (r.type === 'digest') return digestTelegram(r.payload as DigestPayload, r.workspace.timezone);
  const p = phrase(context(r), 'ru');
  if (!r.issue) return { text: `${p.emoji} ${p.line}`, opts: {} };

  const link = issueUrl(r.workspace.slug, r.issue.key);
  const assignment = r.issue.kind === 'assignment' && r.payload.assigned !== false;
  const reply_markup = {
    inline_keyboard: notificationButtons(buttonKind(r.type), r.issue.id, link, {
      acknowledge: assignment,
      deadline: assignment && Boolean(r.issue.due_date),
    }),
  };
  if (r.type === 'issue_assigned') {
    const text = [`${p.emoji} ${p.line}`, '', `${r.issue.key}  ${r.issue.title}`, '', link];
    return { text: text.join('\n'), opts: { reply_markup } };
  }
  const head = p.note
    ? `${p.emoji} ${p.line}\n${p.note.label}: ${p.note.text}`
    : `${p.emoji} ${p.line}`;
  return { text: `${head}\n${r.issue.title}\n\n${link}`, opts: { reply_markup } };
}

/** The email: subject, HTML and plain text. */
export function emailMessage(r: RenderInput): { subject: string; html: string; text: string } {
  if (r.type === 'digest') {
    return digestEmail(r.payload as DigestPayload, r.locale, r.workspace, settingsUrl());
  }
  const en = r.locale === 'en';
  const p = phrase(context(r), r.locale);
  const meta: string[] = [];
  if (r.issue) {
    meta.push(
      `${en ? 'Project' : 'Проект'}: ${r.issue.project}`,
      ...(r.issue.kind === 'assignment'
        ? [en ? 'Assignment with a controller' : 'Поручение с контролем']
        : []),
      ...(r.issue.due_date
        ? [`${en ? 'Due' : 'Срок'}: ${longDate(r.issue.due_date, r.locale, r.workspace.timezone)}`]
        : []),
    );
  }
  // «Каримова Н. А. поручил(а) вам» needs the key in the subject; other lines carry it.
  const keyed = r.type === 'issue_assigned' && r.issue && r.payload.assigned !== false;
  const heading = keyed ? `${p.line} ${r.issue!.key}` : p.line;
  const subject = r.issue ? `${heading}: ${r.issue.title}` : heading;
  const { html, text } = renderEmail({
    locale: r.locale,
    workspace: r.workspace,
    preheader: r.issue ? `${r.issue.key} · ${r.issue.title}` : undefined,
    heading,
    quote: p.note ?? null,
    card: r.issue ? { key: r.issue.key, title: r.issue.title, meta } : null,
    button: r.issue
      ? { label: en ? 'Open task' : 'Открыть задачу', url: issueUrl(r.workspace.slug, r.issue.key) }
      : { label: en ? 'Open the system' : 'Открыть систему', url: frontendUrl('/') },
    footer: [reasonLine(r.type, r.locale)],
    settingsUrl: settingsUrl(),
  });
  return { subject, html, text };
}
