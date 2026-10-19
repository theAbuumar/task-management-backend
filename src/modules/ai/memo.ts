// The memo as a document (Ф11 11.B4): the text the person edited, in the simple
// markup the model writes — `## ` headings, `- ` and `1. ` lists, `**bold**`,
// paragraphs — laid out as PDF (pdfmake, the same Cyrillic fonts as the Ф10
// reports) or DOCX (Times New Roman 14, as university papers usually are).

import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
  type IParagraphOptions,
} from 'docx';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { renderPdf } from '../analytics/reports.js';
import { ruDate } from './prompts.js';

export interface Memo {
  organization: string;
  shortName: string | null;
  title: string;
  text: string;
  author: string;
  position: string | null;
  timeZone: string;
}

type Block =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'item'; marker: string | null; text: string };

/** Lines → blocks; consecutive plain lines join into one paragraph. */
export function parseMemo(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if (!line) flush();
    else if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
      flush();
      blocks.push({ type: 'heading', level: m[1]!.length as 1 | 2 | 3, text: m[2]! });
    } else if ((m = /^[-*•]\s+(.*)$/.exec(line))) {
      flush();
      blocks.push({ type: 'item', marker: null, text: m[1]! });
    } else if ((m = /^(\d{1,3}[.)])\s+(.*)$/.exec(line))) {
      flush();
      blocks.push({ type: 'item', marker: m[1]!, text: m[2]! });
    } else paragraph.push(line);
  }
  flush();
  return blocks;
}

/** `**bold**` spans of a line. */
export function spans(text: string): { text: string; bold: boolean }[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((part) =>
      part.startsWith('**') && part.endsWith('**') && part.length > 4
        ? { text: part.slice(2, -2), bold: true }
        : { text: part, bold: false },
    );
}

const AI_NOTE =
  'Текст подготовлен с помощью AI-ассистента, проверен и отредактирован составителем.';

function signer(memo: Memo): string {
  return [memo.position, memo.author].filter(Boolean).join(' ');
}

export function memoPdf(memo: Memo): Promise<Buffer> {
  const now = new Date();
  const body: Content[] = parseMemo(memo.text).map((b): Content => {
    if (b.type === 'heading') return { text: spans(b.text), style: b.level === 1 ? 'h1' : 'h2' };
    if (b.type === 'item') {
      return {
        columns: [
          { width: 16, text: b.marker ?? '•' },
          { width: '*', text: spans(b.text) },
        ],
        margin: [8, 1, 0, 1],
      };
    }
    return { text: spans(b.text), style: 'p' };
  });
  const doc: TDocumentDefinitions = {
    pageSize: 'A4',
    pageMargins: [56, 48, 48, 56],
    info: { title: memo.title, creator: memo.organization },
    defaultStyle: { font: 'Roboto', fontSize: 11, lineHeight: 1.25 },
    styles: {
      org: { fontSize: 11, bold: true, alignment: 'center' },
      title: { fontSize: 14, bold: true, alignment: 'center', margin: [0, 14, 0, 10] },
      h1: { fontSize: 13, bold: true, margin: [0, 12, 0, 4] },
      h2: { fontSize: 12, bold: true, margin: [0, 10, 0, 4] },
      p: { margin: [0, 2, 0, 4], alignment: 'justify' },
      muted: { color: '#6b7280', fontSize: 8 },
    },
    footer: (page: number, pages: number) => ({
      columns: [
        {
          text: `${ruDate(now, memo.timeZone)} · ${memo.organization}`,
          style: 'muted',
          margin: [56, 0, 0, 0],
        },
        {
          text: `Страница ${page} из ${pages}`,
          style: 'muted',
          alignment: 'right',
          margin: [0, 0, 48, 0],
        },
      ],
    }),
    content: [
      { text: memo.organization.toUpperCase(), style: 'org' },
      ...(memo.shortName ? [{ text: memo.shortName, alignment: 'center' } as Content] : []),
      {
        canvas: [
          { type: 'line', x1: 0, y1: 6, x2: 491, y2: 6, lineWidth: 1, lineColor: '#1e3a8a' },
        ],
      },
      { text: memo.title, style: 'title' },
      ...body,
      {
        margin: [0, 24, 0, 0],
        columns: [
          { width: '*', text: signer(memo) },
          { width: 160, text: '____________________', alignment: 'right' },
        ],
      },
      { text: `${ruDate(now, memo.timeZone)}`, margin: [0, 6, 0, 0] },
      { text: AI_NOTE, style: 'muted', margin: [0, 18, 0, 0] },
    ],
  };
  return renderPdf(doc);
}

const runs = (text: string, size?: number) =>
  spans(text).map((s) => new TextRun({ text: s.text, bold: s.bold, size }));

export async function memoDocx(memo: Memo): Promise<Buffer> {
  const now = new Date();
  const paragraphs: Paragraph[] = parseMemo(memo.text).map((b) => {
    if (b.type === 'heading') {
      return new Paragraph({
        heading: b.level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
        children: runs(b.text),
        spacing: { before: 240, after: 120 },
      });
    }
    if (b.type === 'item') {
      const options: IParagraphOptions = b.marker
        ? { children: runs(`${b.marker} ${b.text}`), indent: { left: 360 } }
        : { children: runs(b.text), bullet: { level: 0 } };
      return new Paragraph(options);
    }
    return new Paragraph({
      children: runs(b.text),
      alignment: AlignmentType.JUSTIFIED,
      indent: { firstLine: 709 },
      spacing: { after: 120 },
    });
  });
  const doc = new Document({
    creator: memo.organization,
    title: memo.title,
    styles: {
      default: {
        document: { run: { font: 'Times New Roman', size: 28 } },
        heading1: { run: { font: 'Times New Roman', size: 28, bold: true, color: '000000' } },
        heading2: { run: { font: 'Times New Roman', size: 28, bold: true, color: '000000' } },
      },
    },
    sections: [
      {
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: memo.organization.toUpperCase(), bold: true })],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 240, after: 240 },
            children: [new TextRun({ text: memo.title, bold: true })],
          }),
          ...paragraphs,
          new Paragraph({
            spacing: { before: 480 },
            children: [new TextRun({ text: `${signer(memo)}\t____________________` })],
          }),
          new Paragraph({ children: [new TextRun({ text: ruDate(now, memo.timeZone) })] }),
          new Paragraph({
            spacing: { before: 360 },
            children: [new TextRun({ text: AI_NOTE, size: 18, color: '6B7280' })],
          }),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}
