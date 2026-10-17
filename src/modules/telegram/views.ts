// Telegram bot texts and keyboards (ADR-011, режим 6 дней). Pure formatting:
// no database access, so the copy stays in one place and is easy to read.
// Messages are HTML; every piece of user text goes through `escapeHtml`.

import { config } from '../../config/index.js';
import { pluralize } from '../../lib/plural.js';
import { daysBetween, localDate } from '../../lib/tz.js';
import { escapeHtml, type InlineButton } from '../auth/telegram.service.js';

// ─── callback_data (≤ 64 bytes: prefix + uuid) ────────────────────────────────
export const CB = {
  /** `c:<issueId>` — show the issue card */
  card: 'c:',
  /** `l:<filter>:<page>` — a page of a list */
  list: 'l:',
  /** `a:<verb>:<issueId>` — an action on an issue */
  act: 'a:',
  /** page counter button, does nothing */
  noop: 'n',
} as const;

export type ListFilter = 'my' | 'today' | 'overdue' | 'review' | 'control';
export type ActionVerb = 'ack' | 'sub' | 'done' | 'ok' | 'ret' | 'cmt' | 'dok' | 'dno';

export const LIST_TITLES: Record<ListFilter, string> = {
  my: '📋 Мои задачи',
  today: '⏰ Срок сегодня',
  overdue: '🔥 Просрочено',
  review: '✅ Ждут моей проверки',
  control: '🎯 На контроле',
};

const EMPTY: Record<ListFilter, string> = {
  my: 'Открытых задач нет 🎉',
  today: 'На сегодня сроков нет.',
  overdue: 'Просроченных задач нет 👍',
  review: 'Никто не ждёт вашей проверки.',
  control: 'Поручений на вашем контроле нет.',
};

/** Reply-keyboard buttons → list (the persistent main menu). */
export const MENU_BUTTONS: Record<string, ListFilter> = {
  '📋 Мои задачи': 'my',
  '⏰ Сегодня': 'today',
  '🔥 Просрочено': 'overdue',
  '✅ Ждут проверки': 'review',
  '🎯 На контроле': 'control',
};

export const MENU_KEYBOARD = {
  keyboard: [
    [{ text: '📋 Мои задачи' }, { text: '⏰ Сегодня' }],
    [{ text: '🔥 Просрочено' }, { text: '✅ Ждут проверки' }],
    [{ text: '🎯 На контроле' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

export const PAGE_SIZE = 8;

const DAYS: [string, string, string] = ['день', 'дня', 'дней'];

/** URL buttons only for a public https frontend — Telegram rejects localhost links. */
export function canLinkButtons(): boolean {
  return (
    /^https:\/\//.test(config.FRONTEND_URL) && !/localhost|127\.0\.0\.1/.test(config.FRONTEND_URL)
  );
}

export function shortName(user: { display_name: string } | null | undefined): string {
  if (!user) return '—';
  const words = user.display_name.trim().split(/\s+/);
  if (words.length < 2) return user.display_name;
  const [last, ...rest] = words;
  return `${last} ${rest.map((w) => `${w[0]!.toUpperCase()}.`).join(' ')}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function formatDate(date: Date, timeZone: string, withYear = false): string {
  return date.toLocaleDateString('ru-RU', {
    timeZone,
    day: 'numeric',
    month: 'long',
    ...(withYear && { year: 'numeric' }),
  });
}

export function formatTime(date: Date, timeZone: string): string {
  return date.toLocaleTimeString('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit' });
}

/** «🔥 просрочено на 2 дня», «⏰ сегодня», «завтра», «до 25 октября» (open issues only). */
export function deadlineText(
  due: Date | null,
  group: string,
  timeZone: string,
  now = new Date(),
): string | null {
  if (!due) return null;
  if (group === 'completed' || group === 'cancelled') return formatDate(due, timeZone);
  const days = daysBetween(localDate(now, timeZone), localDate(due, timeZone));
  if (days < 0) return `🔥 просрочено на ${pluralize(-days, DAYS)}`;
  if (days === 0) return '⏰ сегодня';
  if (days === 1) return '⏳ завтра';
  return `до ${formatDate(due, timeZone)}`;
}

export interface ListRow {
  id: string;
  key: string;
  title: string;
  due_date: Date | null;
  state: { name: string; group: string };
  timezone: string;
}

export function listMessage(
  filter: ListFilter,
  rows: ListRow[],
  total: number,
  page: number,
): { text: string; buttons: InlineButton[][] } {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (total === 0) {
    return { text: `<b>${LIST_TITLES[filter]}</b>\n\n${EMPTY[filter]}`, buttons: [] };
  }
  const lines = rows.map((r, i) => {
    const n = page * PAGE_SIZE + i + 1;
    const due = deadlineText(r.due_date, r.state.group, r.timezone);
    const meta = [due, r.state.name].filter(Boolean).join(' · ');
    return `${n}. <b>${escapeHtml(r.key)}</b> ${escapeHtml(truncate(r.title, 70))}\n    <i>${escapeHtml(meta)}</i>`;
  });
  const head = `<b>${LIST_TITLES[filter]}</b> — ${total}${pages > 1 ? ` · стр. ${page + 1} из ${pages}` : ''}`;

  const buttons: InlineButton[][] = [];
  for (let i = 0; i < rows.length; i += 4) {
    buttons.push(
      rows.slice(i, i + 4).map((r) => ({ text: r.key, callback_data: `${CB.card}${r.id}` })),
    );
  }
  if (pages > 1) {
    buttons.push([
      { text: '‹', callback_data: `${CB.list}${filter}:${(page - 1 + pages) % pages}` },
      { text: `${page + 1}/${pages}`, callback_data: CB.noop },
      { text: '›', callback_data: `${CB.list}${filter}:${(page + 1) % pages}` },
    ]);
  }
  return {
    text: [head, '', ...lines, '', 'Нажмите на ключ, чтобы открыть карточку.'].join('\n'),
    buttons,
  };
}

export interface CardIssue {
  id: string;
  key: string;
  title: string;
  description: string | null;
  kind: 'task' | 'assignment';
  due_date: Date | null;
  state: { name: string; group: string };
  project: { name: string };
  timezone: string;
  url: string;
  primary: { display_name: string; acknowledged_at: Date | null } | null;
  others: { display_name: string }[];
  controller: { display_name: string } | null;
  pendingReview: { submitted_at: Date; report: string | null; by: { display_name: string } } | null;
  pendingDeadline: { old_due: Date | null; new_due: Date; reason: string } | null;
}

export interface CardRights {
  acknowledge: boolean;
  submit: boolean;
  complete: boolean;
  decide: boolean;
  decideDeadline: boolean;
}

export function cardMessage(
  issue: CardIssue,
  rights: CardRights,
  status?: string,
): { text: string; buttons: InlineButton[][] } {
  const tz = issue.timezone;
  const lines: string[] = [];
  if (status) lines.push(status, '');
  lines.push(
    `<b>${escapeHtml(issue.key)}</b> · ${issue.kind === 'assignment' ? 'Поручение' : 'Задача'}`,
  );
  lines.push(`<b>${escapeHtml(issue.title)}</b>`);
  if (issue.description?.trim())
    lines.push(`<i>${escapeHtml(truncate(issue.description.trim(), 300))}</i>`);
  lines.push('');
  lines.push(`📁 ${escapeHtml(issue.project.name)}`);
  lines.push(`📍 Статус: ${escapeHtml(issue.state.name)}`);
  const due = deadlineText(issue.due_date, issue.state.group, tz);
  if (issue.due_date) {
    const date = formatDate(issue.due_date, tz, true);
    lines.push(
      `📅 Срок: ${date}${due && !due.startsWith('до ') && due !== date ? ` — ${due}` : ''}`,
    );
  }
  if (issue.primary) {
    const ack =
      issue.kind === 'assignment'
        ? issue.primary.acknowledged_at
          ? ' · ✓ ознакомлен(а)'
          : ' · не ознакомлен(а)'
        : '';
    lines.push(`👤 Ответственный: ${escapeHtml(shortName(issue.primary))}${ack}`);
  }
  if (issue.others.length) {
    lines.push(`👥 Соисполнители: ${issue.others.map((u) => escapeHtml(shortName(u))).join(', ')}`);
  }
  if (issue.controller) lines.push(`🎯 Контролёр: ${escapeHtml(shortName(issue.controller))}`);
  if (issue.pendingReview) {
    const r = issue.pendingReview;
    lines.push('');
    lines.push(
      `📝 На проверке с ${formatDate(r.submitted_at, tz)} (${escapeHtml(shortName(r.by))})${
        r.report ? `:\n«${escapeHtml(truncate(r.report, 400))}»` : ''
      }`,
    );
  }
  if (issue.pendingDeadline) {
    const d = issue.pendingDeadline;
    lines.push('');
    lines.push(
      `📅 Просят перенести срок: ${d.old_due ? formatDate(d.old_due, tz) : '—'} → ${formatDate(d.new_due, tz)}\nПричина: ${escapeHtml(truncate(d.reason, 300))}`,
    );
  }
  if (!canLinkButtons()) lines.push('', escapeHtml(issue.url));

  const act = (verb: ActionVerb) => `${CB.act}${verb}:${issue.id}`;
  const buttons: InlineButton[][] = [];
  if (rights.acknowledge) buttons.push([{ text: '👁 Ознакомлен', callback_data: act('ack') }]);
  if (rights.submit) buttons.push([{ text: '📝 Сдать на проверку', callback_data: act('sub') }]);
  if (rights.complete) buttons.push([{ text: '✅ Выполнено', callback_data: act('done') }]);
  if (rights.decide) {
    buttons.push([
      { text: '✅ Принять', callback_data: act('ok') },
      { text: '↩️ Вернуть', callback_data: act('ret') },
    ]);
  }
  if (rights.decideDeadline) {
    buttons.push([
      { text: '📅 Одобрить перенос', callback_data: act('dok') },
      { text: '✖️ Отклонить', callback_data: act('dno') },
    ]);
  }
  buttons.push([
    { text: '💬 Комментарий', callback_data: act('cmt') },
    { text: '🔄 Обновить', callback_data: `${CB.card}${issue.id}` },
  ]);
  if (canLinkButtons()) buttons.push([{ text: '🌐 Открыть на сайте', url: issue.url }]);
  return { text: lines.join('\n'), buttons };
}

/** Buttons under an outgoing notification, by event (9.B3 in the 6-day mode). */
export function notificationButtons(
  kind:
    | 'issue_assigned'
    | 'review_requested'
    | 'review_returned'
    | 'deadline_change_requested'
    | 'other',
  issueId: string,
  url: string,
  opts: { acknowledge?: boolean } = {},
): InlineButton[][] {
  const act = (verb: ActionVerb) => `${CB.act}${verb}:${issueId}`;
  const rows: InlineButton[][] = [];
  if (kind === 'issue_assigned' && opts.acknowledge)
    rows.push([{ text: '👁 Ознакомлен', callback_data: act('ack') }]);
  if (kind === 'review_requested') {
    rows.push([
      { text: '✅ Принять', callback_data: act('ok') },
      { text: '↩️ Вернуть', callback_data: act('ret') },
    ]);
  }
  if (kind === 'review_returned')
    rows.push([{ text: '📝 Сдать повторно', callback_data: act('sub') }]);
  if (kind === 'deadline_change_requested') {
    rows.push([
      { text: '📅 Одобрить перенос', callback_data: act('dok') },
      { text: '✖️ Отклонить', callback_data: act('dno') },
    ]);
  }
  rows.push([{ text: '📋 Подробнее', callback_data: `${CB.card}${issueId}` }]);
  if (canLinkButtons()) rows[rows.length - 1]!.push({ text: '🌐 На сайте', url });
  return rows;
}

export const WELCOME = [
  '<b>Система поручений</b>',
  '',
  'Здесь приходят поручения, напоминания о сроках и запросы на проверку. Кнопки под сообщениями работают сразу: «Ознакомлен», «Принять», «Вернуть», «Сдать на проверку».',
  '',
  'Меню внизу — ваши списки: мои задачи, сроки на сегодня, просроченное, ждущее проверки и поручения на контроле.',
].join('\n');

export const NOT_LINKED = [
  'Этот Telegram не привязан к аккаунту системы поручений.',
  '',
  'Войдите на сайт кнопкой «Войти через Telegram» или привяжите Telegram в профиле — после этого здесь появятся ваши задачи.',
].join('\n');

export const PROMPTS = {
  submit: (key: string) =>
    `📝 Напишите краткий отчёт по <b>${escapeHtml(key)}</b>: что сделано. Файлы можно приложить на сайте.\n\n/cancel — отменить`,
  return: (key: string) =>
    `↩️ Напишите, что нужно доработать по <b>${escapeHtml(key)}</b> — замечание увидит исполнитель.\n\n/cancel — отменить`,
  comment: (key: string) =>
    `💬 Напишите комментарий к <b>${escapeHtml(key)}</b>.\n\n/cancel — отменить`,
};

/** Russian text for the error codes a bot action can hit. */
export function errorText(code: string | undefined): string {
  switch (code) {
    case 'NOT_ASSIGNEE':
      return 'Это может сделать только исполнитель.';
    case 'NOT_REVIEWER':
      return 'Решение принимает контролёр поручения.';
    case 'REVIEW_PENDING':
      return 'Работа уже на проверке.';
    case 'NO_PENDING_REVIEW':
      return 'Нет работы, которая ждёт проверки.';
    case 'REPORT_REQUIRED':
      return 'Нужен текстовый отчёт.';
    case 'NO_REVIEW_STATE':
      return 'В проекте нет состояния «На проверке».';
    case 'REVIEW_REQUIRED':
      return 'Поручение закрывает контролёр — сдайте его на проверку.';
    case 'FORBIDDEN':
      return 'Недостаточно прав.';
    case 'NOT_FOUND':
      return 'Задача не найдена или недоступна.';
    case 'CONFLICT':
      return 'Уже решено.';
    default:
      return 'Не удалось выполнить действие. Попробуйте на сайте.';
  }
}
