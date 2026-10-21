// How a digest reads (Ф8 8.B5, ADR-033). The content is collected when the digest
// is queued (`digest.ts`) and kept in the copy; this file only turns it into a
// Telegram message or an email.

import type { BotMessageOptions } from '../../modules/auth/telegram.service.js';
import { escapeHtml } from '../../modules/auth/telegram.service.js';
import { pluralize } from '../plural.js';
import { frontendUrl, issueUrl } from '../urls.js';
import { renderEmail, type EmailListItem, type EmailWorkspace } from './email-layout.js';
import { longDate, reasonLine, type Locale } from './texts.js';

export interface DigestItem {
  key: string;
  title: string;
  /** Workspace slug, for the deep link. */
  slug: string;
  /** ISO deadline. */
  due?: string | null;
  /** Days overdue. */
  days?: number;
  /** Responsible person or the one who handed in. */
  who?: string | null;
  /** to_decide: what is waiting — a hand-in or a deadline change. */
  what?: 'review' | 'deadline';
}

export interface DailySection {
  workspace: string;
  slug: string;
  today: DigestItem[];
  overdue: DigestItem[];
  unacknowledged: DigestItem[];
  to_decide: DigestItem[];
  /** Full counts; the lists hold at most a few items each. */
  totals: { today: number; overdue: number; unacknowledged: number; to_decide: number };
}

export interface DepartmentSummary {
  workspace: string;
  slug: string;
  department_id: string;
  department: string;
  figures: {
    created: number;
    completed: number;
    on_time: number;
    late: number;
    overdue: number;
    open: number;
    discipline: number | null;
  };
  overdue_items: DigestItem[];
}

export type DigestContent =
  | { kind: 'daily'; date: string; manual?: boolean; sections: DailySection[] }
  | { kind: 'weekly'; from: string; to: string; departments: DepartmentSummary[] };

export interface DigestPayload {
  digest: DigestContent;
}

const DAYS: [string, string, string] = ['день', 'дня', 'дней'];
const SHOWN = 5;

export function isEmptyDaily(sections: DailySection[]): boolean {
  return sections.every(
    (s) => s.totals.today + s.totals.overdue + s.totals.unacknowledged + s.totals.to_decide === 0,
  );
}

const day = (date: string, locale: Locale) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString(locale === 'en' ? 'en-GB' : 'ru-RU', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
  });

/** «13–19 октября» / «13 October – 19 October». */
function range(from: string, to: string, locale: Locale): string {
  return `${day(from, locale)} – ${day(to, locale)}`;
}

const pct = (v: number | null) => (v === null ? '—' : `${v}%`);

function dailyLabels(locale: Locale) {
  const en = locale === 'en';
  return {
    today: en ? 'Due today' : 'Срок сегодня',
    overdue: en ? 'Overdue' : 'Просрочено',
    unacknowledged: en ? 'Waiting for «Acknowledged»' : 'Ждут отметки «Ознакомлен»',
    to_decide: en ? 'Waiting for your decision' : 'Ждут вашего решения',
  };
}

function itemNote(item: DigestItem, locale: Locale, timeZone: string): string {
  const en = locale === 'en';
  const parts: string[] = [];
  if (item.days)
    parts.push(en ? `${item.days} d overdue` : `просрочено на ${pluralize(item.days, DAYS)}`);
  else if (item.due) parts.push(`${en ? 'due' : 'срок'} ${longDate(item.due, locale, timeZone)}`);
  if (item.what === 'review') parts.push(en ? 'handed in for review' : 'сдано на проверку');
  if (item.what === 'deadline')
    parts.push(en ? 'deadline change requested' : 'просят перенести срок');
  if (item.who) parts.push(item.who);
  return parts.join(' · ');
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

function tgItems(items: DigestItem[], total: number, timeZone: string): string[] {
  const lines = items.slice(0, SHOWN).map((i) => {
    const note = itemNote(i, 'ru', timeZone);
    return `  <a href="${escapeHtml(issueUrl(i.slug, i.key))}">${escapeHtml(i.key)}</a> ${escapeHtml(i.title)}${note ? ` — ${escapeHtml(note)}` : ''}`;
  });
  if (total > SHOWN) lines.push(`  и ещё ${total - SHOWN}`);
  return lines;
}

export function digestTelegram(
  payload: DigestPayload,
  timeZone: string,
): { text: string; opts: BotMessageOptions } {
  const d = payload.digest;
  const lines: string[] = [];
  if (d.kind === 'daily') {
    const labels = dailyLabels('ru');
    lines.push(`🗓 <b>Сводка на ${escapeHtml(day(d.date, 'ru'))}</b>`);
    if (isEmptyDaily(d.sections)) {
      lines.push('', 'Сроков на сегодня нет, просроченного нет. Хорошего дня!');
    }
    const many = d.sections.length > 1;
    for (const s of d.sections) {
      const groups: [string, keyof DailySection['totals']][] = [
        ['⏰', 'today'],
        ['🔥', 'overdue'],
        ['👁', 'unacknowledged'],
        ['📝', 'to_decide'],
      ];
      const body: string[] = [];
      for (const [emoji, key] of groups) {
        if (!s.totals[key]) continue;
        body.push(
          `${emoji} ${labels[key]} — ${s.totals[key]}`,
          ...tgItems(s[key], s.totals[key], timeZone),
        );
      }
      if (!body.length) continue;
      lines.push('');
      if (many) lines.push(`<b>${escapeHtml(s.workspace)}</b>`);
      lines.push(...body);
    }
  } else {
    lines.push(`📊 <b>Сводка по подразделению за ${escapeHtml(range(d.from, d.to, 'ru'))}</b>`);
    for (const dep of d.departments) {
      const f = dep.figures;
      lines.push(
        '',
        `<b>${escapeHtml(dep.department)}</b>`,
        `Поступило: ${f.created} · Исполнено: ${f.completed} (в срок ${f.on_time}, с опозданием ${f.late})`,
        `Исполнительская дисциплина: ${pct(f.discipline)}`,
        `Просрочено сейчас: ${f.overdue} · В работе: ${f.open}`,
        ...tgItems(dep.overdue_items, f.overdue, timeZone),
      );
    }
  }
  return { text: lines.join('\n'), opts: { parse_mode: 'HTML' } };
}

// ─── Email ────────────────────────────────────────────────────────────────────

function emailItems(items: DigestItem[], locale: Locale, timeZone: string): EmailListItem[] {
  return items.slice(0, SHOWN).map((i) => ({
    key: i.key,
    title: i.title,
    note: itemNote(i, locale, timeZone) || undefined,
    url: issueUrl(i.slug, i.key),
  }));
}

const more = (total: number, locale: Locale) =>
  total > SHOWN
    ? locale === 'en'
      ? `and ${total - SHOWN} more`
      : `и ещё ${total - SHOWN}`
    : undefined;

export function digestEmail(
  payload: DigestPayload,
  locale: Locale,
  workspace: EmailWorkspace & { timezone: string },
  settings: string,
): { subject: string; html: string; text: string } {
  const en = locale === 'en';
  const d = payload.digest;
  const tz = workspace.timezone;
  if (d.kind === 'daily') {
    const labels = dailyLabels(locale);
    const many = d.sections.length > 1;
    const sections = d.sections.flatMap((s) =>
      (['today', 'overdue', 'unacknowledged', 'to_decide'] as const).map((k) => ({
        title: `${many ? `${s.workspace}: ` : ''}${labels[k]} — ${s.totals[k]}`,
        items: emailItems(s[k], locale, tz),
        more: more(s.totals[k], locale),
      })),
    );
    const heading = en
      ? `Your digest for ${day(d.date, locale)}`
      : `Сводка на ${day(d.date, locale)}`;
    const empty = isEmptyDaily(d.sections);
    const { html, text } = renderEmail({
      locale,
      workspace: many ? null : workspace,
      heading,
      paragraphs: empty
        ? [
            en
              ? 'Nothing is due today and nothing is overdue. Have a good day!'
              : 'Сроков на сегодня нет, просроченного нет. Хорошего дня!',
          ]
        : undefined,
      sections,
      button: {
        label: en ? 'Open «My work»' : 'Открыть «Мои задачи»',
        url: frontendUrl('/your-work'),
      },
      footer: [reasonLine('digest', locale)],
      settingsUrl: settings,
    });
    return { subject: heading, html, text };
  }

  const heading = en
    ? `Department summary for ${range(d.from, d.to, locale)}`
    : `Сводка по подразделению за ${range(d.from, d.to, locale)}`;
  const first = d.departments[0];
  const sections = d.departments.map((dep) => ({
    title: `${dep.department}: ${en ? 'most overdue' : 'самые просроченные'}`,
    items: emailItems(dep.overdue_items, locale, tz),
    more: more(dep.figures.overdue, locale),
  }));
  const figures =
    d.departments.length === 1 && first
      ? [
          { label: en ? 'On time' : 'Исполнено в срок', value: pct(first.figures.discipline) },
          { label: en ? 'Completed' : 'Исполнено', value: String(first.figures.completed) },
          { label: en ? 'Received' : 'Поступило', value: String(first.figures.created) },
          { label: en ? 'Overdue now' : 'Просрочено сейчас', value: String(first.figures.overdue) },
        ]
      : undefined;
  // One department reads from the tiles; several get a line each.
  const paragraphs = (d.departments.length === 1 ? [] : d.departments).map((dep) => {
    const f = dep.figures;
    return en
      ? `${dep.department}: received ${f.created}, completed ${f.completed} (on time ${f.on_time}, late ${f.late}), on-time rate ${pct(f.discipline)}, overdue now ${f.overdue}, in progress ${f.open}.`
      : `${dep.department}: поступило ${f.created}, исполнено ${f.completed} (в срок ${f.on_time}, с опозданием ${f.late}), исполнительская дисциплина ${pct(f.discipline)}, просрочено сейчас ${f.overdue}, в работе ${f.open}.`;
  });
  const q = new URLSearchParams({ from: d.from, to: d.to });
  if (d.departments.length === 1 && first) q.set('department', first.department_id);
  const { html, text } = renderEmail({
    locale,
    workspace,
    heading,
    figures,
    paragraphs,
    sections,
    button: {
      label: en ? 'Open analytics' : 'Открыть аналитику',
      url: frontendUrl(`/analytics?${q.toString()}`),
    },
    footer: [reasonLine('digest', locale)],
    settingsUrl: settings,
  });
  return { subject: `${heading} — ${workspace.name}`, html, text };
}
