// The one email layout (Ф8 8.B4, ADR-033): every letter of the system — events,
// digests, codes, invitations, planned reports — is this HTML plus a plain-text
// version of the same content.
//
// Email clients (Outlook, Gmail, Яндекс Почта) ignore <style> blocks and modern CSS,
// so the markup is tables with inline styles, 560px wide, no images except the
// workspace logo (a square with initials when there is none).

import type { Locale } from './texts.js';

export interface EmailWorkspace {
  name: string;
  short_name?: string | null;
  logo_url?: string | null;
}

export interface EmailListItem {
  /** «ACCR-12». */
  key?: string;
  title: string;
  /** «срок 25 октября · Носирова Д. Р.». */
  note?: string;
  url?: string;
}

export interface EmailContent {
  locale: Locale;
  /** Whose letter it is: logo and name at the top. Null — a letter without a workspace. */
  workspace?: EmailWorkspace | null;
  /** Shown by mail clients next to the subject. */
  preheader?: string;
  heading: string;
  paragraphs?: string[];
  /** A remark, a reason — set off as a quote. */
  quote?: { label: string; text: string } | null;
  /** The task the letter is about. */
  card?: { key?: string; title: string; meta?: string[] } | null;
  /** A one-time code, shown large. */
  code?: string | null;
  /** Key figures in a row: «Исполнено в срок · 80%». */
  figures?: { label: string; value: string }[];
  /** Titled lists (digests). */
  sections?: { title: string; items: EmailListItem[]; more?: string }[];
  button?: { label: string; url: string } | null;
  /** Small print: why the letter came, how long a link works. */
  footer?: string[];
  /** «Настроить уведомления» — for notification letters only. */
  settingsUrl?: string | null;
}

const ACCENT = '#3f76ff';
const TEXT = '#1f2329';
const MUTED = '#6b7280';
const BORDER = '#e9e9ec';
const SOFT = '#f8f8f9';
const FONT = "Inter, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";

/** Escape text for HTML content and attribute values. */
export function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Two letters for the logo square: «ГУ» from «Государственный университет». */
export function initials(ws: EmailWorkspace): string {
  const source = ws.short_name?.trim() || ws.name.trim();
  if (ws.short_name && source.length <= 4) return source.toUpperCase();
  const words = source.split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1 ? words.slice(0, 2).map((w) => w[0]) : [...(words[0] ?? '?').slice(0, 2)];
  return letters.join('').toUpperCase();
}

function logo(ws: EmailWorkspace): string {
  if (ws.logo_url && /^https?:\/\//.test(ws.logo_url)) {
    return `<img src="${esc(ws.logo_url)}" width="32" height="32" alt="" style="display:block;width:32px;height:32px;border-radius:6px;border:0;">`;
  }
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="32" height="32" align="center" valign="middle" style="width:32px;height:32px;border-radius:6px;background:${ACCENT};color:#ffffff;font:600 12px ${FONT};">${esc(initials(ws))}</td></tr></table>`;
}

const paragraph = (text: string) =>
  `<p style="margin:0 0 12px;font:14px/1.55 ${FONT};color:${TEXT};">${esc(text).replace(/\n/g, '<br>')}</p>`;

function itemHtml(item: EmailListItem): string {
  const key = item.key
    ? `<span style="font:600 12px ${FONT};color:${MUTED};">${esc(item.key)}</span>&nbsp; `
    : '';
  const title = item.url
    ? `<a href="${esc(item.url)}" style="color:${TEXT};text-decoration:none;">${esc(item.title)}</a>`
    : esc(item.title);
  const note = item.note
    ? `<div style="font:12px/1.4 ${FONT};color:${MUTED};margin-top:2px;">${esc(item.note)}</div>`
    : '';
  return `<tr><td style="padding:8px 0;border-top:1px solid ${BORDER};font:14px/1.45 ${FONT};color:${TEXT};">${key}${title}${note}</td></tr>`;
}

/** The letter as HTML and as plain text. */
export function renderEmail(c: EmailContent): { html: string; text: string } {
  const en = c.locale === 'en';
  const parts: string[] = [];

  if (c.workspace) {
    parts.push(
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;"><tr><td valign="middle">${logo(c.workspace)}</td><td valign="middle" style="padding-left:10px;font:600 14px ${FONT};color:${TEXT};">${esc(c.workspace.name)}</td></tr></table>`,
    );
  }
  parts.push(
    `<h1 style="margin:0 0 14px;font:600 18px/1.35 ${FONT};color:${TEXT};">${esc(c.heading)}</h1>`,
  );
  for (const p of c.paragraphs ?? []) parts.push(paragraph(p));
  if (c.quote) {
    parts.push(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;"><tr><td style="border-left:3px solid ${ACCENT};background:${SOFT};padding:10px 12px;font:14px/1.5 ${FONT};color:${TEXT};"><div style="font:600 12px ${FONT};color:${MUTED};margin-bottom:4px;">${esc(c.quote.label)}</div>${esc(c.quote.text).replace(/\n/g, '<br>')}</td></tr></table>`,
    );
  }
  if (c.card) {
    const key = c.card.key
      ? `<div style="font:600 12px ${FONT};color:${MUTED};margin-bottom:4px;">${esc(c.card.key)}</div>`
      : '';
    const meta = (c.card.meta ?? [])
      .map((m) => `<div style="font:12px/1.5 ${FONT};color:${MUTED};">${esc(m)}</div>`)
      .join('');
    parts.push(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;border:1px solid ${BORDER};border-radius:8px;"><tr><td style="padding:12px 14px;">${key}<div style="font:600 15px/1.4 ${FONT};color:${TEXT};margin-bottom:4px;">${esc(c.card.title)}</div>${meta}</td></tr></table>`,
    );
  }
  if (c.code) {
    parts.push(
      `<div style="margin:4px 0 18px;padding:14px;background:${SOFT};border:1px solid ${BORDER};border-radius:8px;text-align:center;font:600 28px/1 'SFMono-Regular',Consolas,monospace;letter-spacing:6px;color:${TEXT};">${esc(c.code)}</div>`,
    );
  }
  if (c.figures?.length) {
    const cells = c.figures
      .map(
        (f) =>
          `<td valign="top" style="padding:10px 12px;border:1px solid ${BORDER};border-radius:8px;"><div style="font:600 18px ${FONT};color:${TEXT};">${esc(f.value)}</div><div style="font:12px/1.35 ${FONT};color:${MUTED};margin-top:2px;">${esc(f.label)}</div></td>`,
      )
      .join('<td width="8" style="width:8px;"></td>');
    parts.push(
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;"><tr>${cells}</tr></table>`,
    );
  }
  for (const s of c.sections ?? []) {
    if (!s.items.length) continue;
    const more = s.more
      ? `<tr><td style="padding:6px 0 0;font:12px ${FONT};color:${MUTED};">${esc(s.more)}</td></tr>`
      : '';
    parts.push(
      `<div style="font:600 13px ${FONT};color:${TEXT};margin:4px 0 4px;">${esc(s.title)}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">${s.items.map(itemHtml).join('')}${more}</table>`,
    );
  }
  if (c.button) {
    parts.push(
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 8px;"><tr><td style="border-radius:6px;background:${ACCENT};"><a href="${esc(c.button.url)}" style="display:inline-block;padding:10px 18px;font:600 14px ${FONT};color:#ffffff;text-decoration:none;border-radius:6px;">${esc(c.button.label)}</a></td></tr></table>`,
    );
  }

  const small: string[] = [...(c.footer ?? []).map(esc)];
  if (c.settingsUrl) {
    small.push(
      `<a href="${esc(c.settingsUrl)}" style="color:${MUTED};text-decoration:underline;">${en ? 'Notification settings' : 'Настроить уведомления'}</a>`,
    );
  }
  const footer = small.length
    ? `<tr><td style="padding:16px 4px 0;font:12px/1.5 ${FONT};color:${MUTED};">${small.join('<br>')}</td></tr>`
    : '';
  const preheader = c.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(c.preheader)}</div>`
    : '';

  const html = `<!doctype html>
<html lang="${c.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(c.heading)}</title></head>
<body style="margin:0;padding:0;background:${SOFT};">${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${SOFT};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;">
<tr><td style="background:#ffffff;border:1px solid ${BORDER};border-radius:10px;padding:24px;">${parts.join('\n')}</td></tr>
${footer}
</table></td></tr></table></body></html>`;

  return { html, text: renderText(c) };
}

/** The same letter as plain text, for clients that do not show HTML. */
function renderText(c: EmailContent): string {
  const en = c.locale === 'en';
  const lines: string[] = [];
  if (c.workspace) lines.push(c.workspace.name, '');
  lines.push(c.heading, '');
  for (const p of c.paragraphs ?? []) lines.push(p, '');
  if (c.quote) lines.push(`${c.quote.label}: ${c.quote.text}`, '');
  if (c.card) {
    lines.push(c.card.key ? `${c.card.key}  ${c.card.title}` : c.card.title);
    lines.push(...(c.card.meta ?? []), '');
  }
  if (c.code) lines.push(`    ${c.code}`, '');
  if (c.figures?.length) {
    lines.push(c.figures.map((f) => `${f.label}: ${f.value}`).join(' · '), '');
  }
  for (const s of c.sections ?? []) {
    if (!s.items.length) continue;
    lines.push(s.title);
    for (const i of s.items) {
      const head = i.key ? `${i.key}  ${i.title}` : i.title;
      lines.push(`— ${head}${i.note ? ` (${i.note})` : ''}`);
    }
    if (s.more) lines.push(s.more);
    lines.push('');
  }
  if (c.button) lines.push(`${c.button.label}: ${c.button.url}`, '');
  if (c.footer?.length || c.settingsUrl) {
    lines.push('—');
    lines.push(...(c.footer ?? []));
    if (c.settingsUrl)
      lines.push(`${en ? 'Notification settings' : 'Настроить уведомления'}: ${c.settingsUrl}`);
  }
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
