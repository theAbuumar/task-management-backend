// Real files for the demo seed (13.B1): reports handed in with assignments, summary
// tables and meeting minutes. Every attachment on the demo stand opens — PDF via
// pdfmake (Roboto, Cyrillic: the same printer as the analytics reports) and Excel
// via exceljs. The seed decides the content (its RNG keeps runs deterministic);
// this module only lays it out.

import ExcelJS from 'exceljs';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { renderPdf } from '../../modules/analytics/reports.js';

export const PDF_MIME = 'application/pdf';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface ReportFile {
  university: string;
  issueKey: string;
  title: string;
  basis: string | null;
  executor: { name: string; short: string; position: string; department: string };
  controller: string | null;
  /** Formatted local dates. */
  due: string | null;
  date: string;
  /** The report text from the hand-in. */
  summary: string;
  /** What was done, one line per item. */
  steps: string[];
  /** A summary table is attached alongside. */
  withTable: boolean;
  /** First version that was later returned for rework. */
  draft: boolean;
}

const GRAY = '#6B7280';

function fieldsTable(rows: [string, string][]): Content {
  return {
    table: {
      widths: [130, '*'],
      body: rows.map(([label, value]) => [{ text: label, color: GRAY }, { text: value }]),
    },
    layout: 'lightHorizontalLines',
    margin: [0, 0, 0, 16],
  };
}

function signature(role: string, name: string, date: string): Content {
  return {
    columns: [
      { text: role, width: 110 },
      { text: '______________________', width: 150 },
      { text: name, width: '*' },
      { text: date, width: 80, alignment: 'right', color: GRAY },
    ],
    margin: [0, 28, 0, 0],
  };
}

const base = (title: string, author: string): Partial<TDocumentDefinitions> => ({
  pageSize: 'A4',
  pageMargins: [56, 48, 56, 56],
  info: { title, author, creator: 'Система контроля поручений' },
  defaultStyle: { font: 'Roboto', fontSize: 11, lineHeight: 1.25 },
});

/** «Отчёт о выполнении поручения» — what an assignee hands in for review. */
export function reportPdf(r: ReportFile): Promise<Buffer> {
  const content: Content[] = [
    { text: r.university, alignment: 'center', color: GRAY, fontSize: 9 },
    {
      text: r.executor.department,
      alignment: 'center',
      color: GRAY,
      fontSize: 9,
      margin: [0, 0, 0, 18],
    },
    { text: 'ОТЧЁТ', alignment: 'center', bold: true, fontSize: 15 },
    {
      text: `о выполнении поручения ${r.issueKey}`,
      alignment: 'center',
      margin: [0, 2, 0, 18],
    },
    fieldsTable([
      ['Поручение', r.title],
      ...(r.basis ? ([['Основание', r.basis]] as [string, string][]) : []),
      ['Исполнитель', `${r.executor.name}, ${r.executor.position}`],
      ...(r.controller ? ([['Контролёр', r.controller]] as [string, string][]) : []),
      ...(r.due ? ([['Срок исполнения', r.due]] as [string, string][]) : []),
      ['Дата отчёта', r.date],
    ]),
    { text: 'Содержание выполненной работы', bold: true, margin: [0, 0, 0, 6] },
    { text: r.summary, margin: [0, 0, 0, 6] },
    { text: 'В ходе исполнения поручения:', margin: [0, 0, 0, 4] },
    { ul: r.steps, margin: [0, 0, 0, 10] },
  ];
  if (r.withTable) {
    content.push({
      text: 'Приложение: сводная таблица показателей (Excel).',
      italics: true,
      color: GRAY,
    });
  }
  content.push(signature('Исполнитель', r.executor.short, r.date));

  return renderPdf({
    ...base(`Отчёт о выполнении поручения ${r.issueKey}`, r.executor.name),
    ...(r.draft && { watermark: { text: 'ПЕРВАЯ РЕДАКЦИЯ', opacity: 0.07, bold: true } }),
    content,
  } as TDocumentDefinitions);
}

export interface MinutesFile {
  university: string;
  department: string;
  number: number;
  date: string;
  chair: string;
  /** «Фамилия И. О.» for the signature line. */
  chairShort: string;
  attendees: string[];
  topic: string;
  decisions: string[];
}

/** «Протокол совещания» — attached to a comment that mentions the minutes. */
export function minutesPdf(m: MinutesFile): Promise<Buffer> {
  return renderPdf({
    ...base(`Протокол совещания №${m.number}`, m.chair),
    content: [
      { text: m.university, alignment: 'center', color: GRAY, fontSize: 9 },
      { text: m.department, alignment: 'center', color: GRAY, fontSize: 9, margin: [0, 0, 0, 18] },
      { text: `ПРОТОКОЛ №${m.number}`, alignment: 'center', bold: true, fontSize: 15 },
      { text: `рабочего совещания от ${m.date}`, alignment: 'center', margin: [0, 2, 0, 18] },
      fieldsTable([
        ['Председатель', m.chair],
        ['Присутствовали', m.attendees.join(', ')],
      ]),
      { text: 'Повестка', bold: true, margin: [0, 0, 0, 4] },
      { text: m.topic, margin: [0, 0, 0, 10] },
      { text: 'Решили', bold: true, margin: [0, 0, 0, 4] },
      { ol: m.decisions },
      signature('Председатель', m.chairShort, m.date),
    ],
  } as TDocumentDefinitions);
}

export interface SummaryRow {
  unit: string;
  plan: number;
  fact: number;
}

/** «Сводная таблица» — plan/fact by unit, attached to a report. */
export async function summaryXlsx(t: {
  title: string;
  author: string;
  created: Date;
  rows: SummaryRow[];
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = t.author;
  wb.created = t.created;
  const ws = wb.addWorksheet('Сводка');
  ws.columns = [{ width: 6 }, { width: 46 }, { width: 10 }, { width: 10 }, { width: 18 }];

  ws.mergeCells('A1:E1');
  ws.getCell('A1').value = t.title;
  ws.getCell('A1').font = { bold: true, size: 13 };

  const header = ws.addRow(['№', 'Подразделение', 'План', 'Факт', 'Выполнение, %']);
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } } };
  });
  ws.getRow(1).height = 22;

  t.rows.forEach((r, i) => {
    ws.addRow([i + 1, r.unit, r.plan, r.fact, Math.round((r.fact / r.plan) * 100)]);
  });
  const plan = t.rows.reduce((s, r) => s + r.plan, 0);
  const fact = t.rows.reduce((s, r) => s + r.fact, 0);
  const total = ws.addRow(['', 'Итого', plan, fact, plan ? Math.round((fact / plan) * 100) : 0]);
  total.font = { bold: true };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
