// What an event says (Ф8 8.B3, 8.B4, ADR-033): one phrase per notification type,
// in Russian and English. Telegram gets it with an emoji and action buttons (the bot
// stays Russian, 9.T9); the email gets the same phrase as its subject and heading.

import type { NotificationType } from '@prisma/client';
import { pluralize } from '../plural.js';

export type Locale = 'ru' | 'en';

export function localeOf(value: string | null | undefined): Locale {
  return value === 'en' ? 'en' : 'ru';
}

/**
 * Details remembered in the copy when the event happens (they may change later):
 * days to/after the deadline, the remark, old and new dates.
 */
export interface DeliveryPayload {
  /** issue_assigned: false — the «task for everyone» broadcast to project members. */
  assigned?: boolean;
  /** due_soon: days left (0 = today); overdue/escalated: days overdue. */
  days?: number;
  /** ISO dates. */
  due?: string | null;
  old_due?: string | null;
  new_due?: string | null;
  comment?: string | null;
  approved?: boolean;
  reason?: string | null;
  /** escalated: the responsible assignee. */
  responsible?: string | null;
  /** report_ready: the report's title. */
  title?: string | null;
}

export interface EventContext {
  type: NotificationType;
  /** Who caused it; null — the system (reminders). */
  actor: string | null;
  workspace: string;
  key: string;
  title: string;
  project: string;
  kind: 'task' | 'assignment';
  timeZone: string;
  payload: DeliveryPayload;
}

export interface Phrase {
  emoji: string;
  /** The headline: «Каримова Н. А. сдал(а) на проверку ACCR-12». */
  line: string;
  /** A quoted remark or reason under the headline. */
  note?: { label: string; text: string };
}

const DAYS_RU: [string, string, string] = ['день', 'дня', 'дней'];

function days(n: number, locale: Locale): string {
  return locale === 'en' ? `${n} ${n === 1 ? 'day' : 'days'}` : pluralize(n, DAYS_RU);
}

/** «25 октября» / «25 October». */
export function shortDate(iso: string | null | undefined, locale: Locale, timeZone: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(locale === 'en' ? 'en-GB' : 'ru-RU', {
    timeZone,
    day: 'numeric',
    month: 'long',
  });
}

/** «25 октября 2026 г.» / «25 October 2026». */
export function longDate(iso: string | Date | null | undefined, locale: Locale, timeZone: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(locale === 'en' ? 'en-GB' : 'ru-RU', {
    timeZone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** The headline of an event for one reader. */
export function phrase(ctx: EventContext, locale: Locale): Phrase {
  const en = locale === 'en';
  const who = ctx.actor ?? (en ? 'The system' : 'Система');
  const { key, payload: p } = ctx;
  const date = (iso?: string | null) => shortDate(iso, locale, ctx.timeZone);
  switch (ctx.type) {
    case 'issue_assigned':
      if (p.assigned === false) {
        return {
          emoji: '🆕',
          line: en
            ? `${who} created a task in «${ctx.project}»`
            : `${who} создал(а) задачу в проекте «${ctx.project}»`,
        };
      }
      return ctx.kind === 'assignment'
        ? { emoji: '📌', line: en ? `${who} gave you an assignment` : `${who} поручил(а) вам` }
        : {
            emoji: '📋',
            line: en ? `${who} assigned you a task` : `${who} назначил(а) вам задачу`,
          };
    case 'review_requested':
      return {
        emoji: '📝',
        line: en ? `${who} submitted ${key} for review` : `${who} сдал(а) на проверку ${key}`,
      };
    case 'review_approved':
      return {
        emoji: '✅',
        line: en ? `${who} accepted the result of ${key}` : `${who} принял(а) результат по ${key}`,
      };
    case 'review_returned':
      return {
        emoji: '↩️',
        line: en ? `${who} returned ${key} for rework` : `${who} вернул(а) на доработку ${key}`,
        ...(p.comment && { note: { label: en ? 'Remark' : 'Замечание', text: p.comment } }),
      };
    case 'acknowledged':
      return {
        emoji: '👁',
        line: en
          ? `${who} acknowledged the assignment ${key}`
          : `${who} ознакомился(ась) с поручением ${key}`,
      };
    case 'due_soon':
      return {
        emoji: '⏰',
        line:
          (p.days ?? 0) === 0
            ? en
              ? `${key} is due today`
              : `Сегодня срок по ${key}`
            : en
              ? `${key} is due in ${days(p.days ?? 1, locale)} (${date(p.due)})`
              : `Через ${days(p.days ?? 1, locale)} срок по ${key} (${date(p.due)})`,
      };
    case 'overdue':
      return {
        emoji: '🔥',
        line: en
          ? `${key} is overdue by ${days(p.days ?? 1, locale)}`
          : `${key} просрочено на ${days(p.days ?? 1, locale)}`,
      };
    case 'escalated': {
      const base = en
        ? `Escalation: ${key} is overdue by ${days(p.days ?? 1, locale)}`
        : `Эскалация: ${key} просрочено на ${days(p.days ?? 1, locale)}`;
      const responsible = p.responsible
        ? en
          ? `. Responsible: ${p.responsible}`
          : `. Ответственный: ${p.responsible}`
        : '';
      return { emoji: '🚨', line: base + responsible };
    }
    case 'deadline_change_requested':
      return {
        emoji: '📅',
        line: en
          ? `${who} asks to move the deadline of ${key}: ${date(p.old_due)} → ${date(p.new_due)}`
          : `${who} просит перенести срок ${key}: ${date(p.old_due)} → ${date(p.new_due)}`,
        ...(p.reason && { note: { label: en ? 'Reason' : 'Причина', text: p.reason } }),
      };
    case 'deadline_change_decided':
      return p.approved
        ? {
            emoji: '📅',
            line: en
              ? `The deadline of ${key} moved to ${date(p.new_due)}: approved`
              : `Перенос срока ${key} на ${date(p.new_due)} одобрен`,
          }
        : {
            emoji: '📅',
            line: en
              ? `The deadline change of ${key} was declined`
              : `Перенос срока ${key} отклонён`,
            ...(p.comment && { note: { label: en ? 'Comment' : 'Комментарий', text: p.comment } }),
          };
    case 'comment_added':
      return {
        emoji: '💬',
        line: en ? `${who} commented on ${key}` : `${who} прокомментировал(а) ${key}`,
      };
    case 'mentioned':
      return {
        emoji: '💬',
        line: en ? `${who} mentioned you in ${key}` : `${who} упомянул(а) вас в ${key}`,
      };
    case 'state_changed':
      return {
        emoji: '🔄',
        line: en ? `${who} changed the state of ${key}` : `${who} изменил(а) состояние ${key}`,
      };
    case 'invite_received':
      return {
        emoji: '✉️',
        line: en
          ? `${who} invites you to «${ctx.workspace}»`
          : `${who} приглашает вас в «${ctx.workspace}»`,
      };
    case 'report_ready':
      return {
        emoji: '📊',
        line: en ? `Report «${p.title ?? ''}» is ready` : `Готов отчёт «${p.title ?? ''}»`,
      };
    case 'digest':
      return { emoji: '🗓', line: en ? 'Your digest' : 'Ваша сводка' };
  }
}

/** Why the reader got the email — the line above «Настроить уведомления». */
export function reasonLine(type: NotificationType, locale: Locale): string {
  const en = locale === 'en';
  switch (type) {
    case 'issue_assigned':
      return en
        ? 'You get this email because notifications about new tasks are on for email.'
        : 'Письмо пришло, потому что уведомления о новых задачах включены для почты.';
    case 'review_requested':
    case 'review_approved':
    case 'review_returned':
    case 'acknowledged':
      return en
        ? 'You get this email because notifications about reviews are on for email.'
        : 'Письмо пришло, потому что уведомления о проверке результата включены для почты.';
    case 'due_soon':
    case 'overdue':
    case 'deadline_change_requested':
    case 'deadline_change_decided':
      return en
        ? 'You get this email because notifications about deadlines are on for email.'
        : 'Письмо пришло, потому что уведомления о сроках включены для почты.';
    case 'escalated':
      return en
        ? 'You get this email because escalations are on for email.'
        : 'Письмо пришло, потому что уведомления об эскалации включены для почты.';
    case 'digest':
      return en
        ? 'You get this email because digests are on in your notification settings.'
        : 'Письмо пришло, потому что сводки включены в настройках уведомлений.';
    default:
      return en
        ? 'You get this email because you take part in this work.'
        : 'Письмо пришло, потому что вы участвуете в этой работе.';
  }
}
