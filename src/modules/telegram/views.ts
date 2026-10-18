// Telegram bot texts and keyboards (ADR-011, режим 6 дней). Pure formatting:
// no database access, so the copy stays in one place and is easy to read.
// Messages are HTML; every piece of user text goes through `escapeHtml`.

import { config } from '../../config/index.js';
import { pluralize } from '../../lib/plural.js';
import { addDays, daysBetween, localDate } from '../../lib/tz.js';
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
  /** drop the pending question and the files sent for a hand-in */
  cancel: 'x',
} as const;

export type ListFilter = 'my' | 'today' | 'overdue' | 'review' | 'control';
/**
 * `fil` — hand in the files just sent, for this issue (asked when a file arrives
 * without a question); `snd` — hand in now with the files and their caption;
 * `due` — ask to move the deadline.
 */
export type ActionVerb =
  | 'ack'
  | 'sub'
  | 'done'
  | 'ok'
  | 'ret'
  | 'cmt'
  | 'dok'
  | 'dno'
  | 'due'
  | 'fil'
  | 'snd';

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
export const FILES: [string, string, string] = ['файл', 'файла', 'файлов'];

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
  pendingReview: {
    submitted_at: Date;
    report: string | null;
    by: { display_name: string };
    files: string[];
  } | null;
  pendingDeadline: { old_due: Date | null; new_due: Date; reason: string } | null;
}

export interface CardRights {
  acknowledge: boolean;
  submit: boolean;
  complete: boolean;
  decide: boolean;
  decideDeadline: boolean;
  requestDeadline: boolean;
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
    if (r.files.length) lines.push(`📎 ${r.files.map((f) => escapeHtml(f)).join(', ')}`);
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
  if (rights.requestDeadline)
    buttons.push([{ text: '📅 Перенести срок', callback_data: act('due') }]);
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
  opts: { acknowledge?: boolean; deadline?: boolean } = {},
): InlineButton[][] {
  const act = (verb: ActionVerb) => `${CB.act}${verb}:${issueId}`;
  const rows: InlineButton[][] = [];
  if (kind === 'issue_assigned') {
    const row: InlineButton[] = [];
    if (opts.acknowledge) row.push({ text: '👁 Ознакомлен', callback_data: act('ack') });
    if (opts.deadline) row.push({ text: '📅 Перенести срок', callback_data: act('due') });
    if (row.length) rows.push(row);
  }
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
  'Откройте на сайте «Профиль» → «Подключить Telegram» (или войдите кнопкой «Продолжить с Telegram») — после этого здесь появятся ваши задачи.',
].join('\n');

export const PROMPTS = {
  submit: (key: string) =>
    `📝 Напишите краткий отчёт по <b>${escapeHtml(key)}</b>: что сделано.\n\n📎 Файл — документ или фото — пришлите до отчёта или с подписью-отчётом.\n\n/cancel — отменить`,
  return: (key: string) =>
    `↩️ Напишите, что нужно доработать по <b>${escapeHtml(key)}</b> — замечание увидит исполнитель.\n\n/cancel — отменить`,
  comment: (key: string) =>
    `💬 Напишите комментарий к <b>${escapeHtml(key)}</b>.\n\n/cancel — отменить`,
  report: (key: string, files: number) =>
    `📝 Напишите краткий отчёт по <b>${escapeHtml(key)}</b>: что сделано. ${pluralize(files, FILES)} — приложатся к нему.\n\n/cancel — отменить`,
  deadline: (key: string, due: string | null) =>
    `📅 Напишите новый срок по <b>${escapeHtml(key)}</b> и причину переноса, например:\n<code>30.10 ждём данные от кафедр</code>${
      due ? `\n\nСейчас срок — ${due}. Решение примет контролёр.` : ''
    }\n\n/cancel — отменить`,
};

/** Files sent for a hand-in, with «Сдать» / «Отмена». */
export function stagedFilesMessage(
  issueId: string,
  key: string,
  files: string[],
  caption: string | null,
): { text: string; buttons: InlineButton[][] } {
  const lines = [
    `📎 К отчёту по <b>${escapeHtml(key)}</b> — ${pluralize(files.length, FILES)}:`,
    ...files.map((f) => `• ${escapeHtml(f)}`),
    '',
    caption
      ? `Отчёт — подпись к файлу: «${escapeHtml(truncate(caption, 300))}»\nНажмите «Сдать на проверку» или напишите другой отчёт сообщением.`
      : 'Напишите краткий отчёт сообщением — с ним работа уйдёт на проверку.',
  ];
  return {
    text: lines.join('\n'),
    buttons: [
      [
        { text: '📝 Сдать на проверку', callback_data: `${CB.act}snd:${issueId}` },
        { text: '✖️ Отмена', callback_data: CB.cancel },
      ],
    ],
  };
}

/** A file arrived without a question: which task is it a report for? */
export function pickIssueMessage(
  files: string[],
  rows: { id: string; key: string; title: string }[],
): { text: string; buttons: InlineButton[][] } {
  const got =
    files.length === 1
      ? `📎 Получен файл «${escapeHtml(files[0]!)}».`
      : `📎 Получено ${pluralize(files.length, FILES)}.`;
  if (rows.length === 0) {
    return {
      text: `${got}\n\nСейчас у вас нет задач, которые нужно сдать на проверку, поэтому файл не сохранён.`,
      buttons: [],
    };
  }
  return {
    text: `${got}\n\nПо какой задаче сдать отчёт?`,
    buttons: [
      ...rows.map((r) => [
        { text: `${r.key} · ${truncate(r.title, 40)}`, callback_data: `${CB.act}fil:${r.id}` },
      ]),
      [{ text: '✖️ Отмена', callback_data: CB.cancel }],
    ],
  };
}

/**
 * «30.10 ждём данные от кафедр» → the new deadline as the web sends it (noon UTC of
 * the chosen day) and the reason. Without a year the nearest such date is meant: a
 * date that passed more than two months ago is next year's.
 */
export function parseDeadlineInput(
  text: string,
  timeZone: string,
  now = new Date(),
): { new_due_date: string; reason: string } | { error: string } {
  const m = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{4}|\d{2}))?(?!\d)\s*[—–\-:,]?\s*([\s\S]*)$/.exec(
    text.trim(),
  );
  if (!m) return { error: 'Начните с даты, например: <code>30.10 ждём данные от кафедр</code>' };
  const today = localDate(now, timeZone);
  const [day, month] = [Number(m[1]), Number(m[2])];
  let year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : Number(today.slice(0, 4));
  const iso = (y: number) =>
    `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (!m[3] && daysBetween(iso(year), today) > 60) year += 1;
  const date = iso(year);
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    return { error: 'Такой даты нет. Напишите дату как 30.10 или 30.10.2026.' };
  }
  if (date < today) return { error: 'Эта дата уже прошла — укажите будущую.' };
  if (date > addDays(today, 3 * 366)) return { error: 'Слишком далёкая дата.' };
  const reason = m[4]!.trim();
  if (reason.length < 3) return { error: 'После даты напишите причину переноса.' };
  return { new_due_date: parsed.toISOString(), reason };
}

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
    case 'DEADLINE_REQUEST_PENDING':
      return 'Запрос на перенос срока уже ждёт решения контролёра.';
    case 'FILE_DOWNLOAD_FAILED':
      return 'Не удалось получить файл из Telegram. Пришлите его ещё раз или приложите на сайте.';
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
