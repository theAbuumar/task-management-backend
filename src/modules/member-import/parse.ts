// Reading a staff list for the import (4.B1, ADR-031): an XLSX made from the
// template, or a CSV saved from Excel — in UTF-8 or Windows-1251 (Russian Excel
// saves CSV in it), separated by «;» or «,». Columns are found by their headers,
// in any order; unknown columns are ignored. Only text leaves this file: the rows
// are checked in the service.

import ExcelJS from 'exceljs';
import { AppError } from '../../lib/errors.js';

export const MAX_ROWS = 500;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export type Column = 'full_name' | 'email' | 'department' | 'position' | 'role';

/** One line of the file as text; `row` is its line number (the header is above it). */
export interface RawRow {
  row: number;
  full_name: string;
  email: string;
  department: string;
  position: string;
  role: string;
}

/** Column titles of the template, in its order. */
export const TEMPLATE_HEADERS: Record<Column, string> = {
  full_name: 'ФИО',
  email: 'Email',
  department: 'Подразделение',
  position: 'Должность',
  role: 'Роль',
};

/** Lower case, «ё» as «е», no spaces or punctuation: «E-mail» → «email». */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\s\-_.:*()]/g, '');
}

const HEADER_ALIASES: Record<Column, string[]> = {
  full_name: ['фио', 'фамилияимяотчество', 'сотрудник', 'fullname', 'name'],
  email: ['email', 'почта', 'электроннаяпочта', 'адресэлектроннойпочты', 'mail'],
  department: ['подразделение', 'department'],
  position: ['должность', 'position'],
  role: ['роль', 'role', 'доступ'],
};

function columnOf(header: string): Column | null {
  const key = normalize(header);
  for (const [column, aliases] of Object.entries(HEADER_ALIASES) as [Column, string[]][]) {
    if (aliases.includes(key)) return column;
  }
  return null;
}

function invalid(reason: string, message: string, extra: Record<string, unknown> = {}): AppError {
  return new AppError(400, 'IMPORT_FILE_INVALID', message, { reason, ...extra });
}

/**
 * Rows of text under the header line: the first of the top ten lines that names
 * the «ФИО» and «Email» columns. Empty lines are skipped.
 */
function rowsFromTable(table: string[][]): RawRow[] {
  const headerIndex = table.slice(0, 10).findIndex((cells) => {
    const columns = cells.map(columnOf);
    return columns.includes('full_name') && columns.includes('email');
  });
  if (headerIndex === -1) {
    throw invalid('NO_HEADER', 'The file has no header line with the «ФИО» and «Email» columns', {
      required: [TEMPLATE_HEADERS.full_name, TEMPLATE_HEADERS.email],
    });
  }
  const positions = new Map<Column, number>();
  table[headerIndex]!.forEach((cell, i) => {
    const column = columnOf(cell);
    if (column && !positions.has(column)) positions.set(column, i);
  });
  const value = (cells: string[], column: Column) => {
    const i = positions.get(column);
    return i === undefined ? '' : (cells[i] ?? '').replace(/\s+/g, ' ').trim();
  };

  const rows: RawRow[] = [];
  table.slice(headerIndex + 1).forEach((cells, i) => {
    if (cells.every((c) => !c.trim())) return;
    rows.push({
      row: headerIndex + i + 2,
      full_name: value(cells, 'full_name'),
      email: value(cells, 'email'),
      department: value(cells, 'department'),
      position: value(cells, 'position'),
      role: value(cells, 'role'),
    });
  });
  if (rows.length === 0) throw invalid('EMPTY', 'The file has no rows under the header');
  if (rows.length > MAX_ROWS) {
    throw new AppError(400, 'IMPORT_TOO_MANY_ROWS', `At most ${MAX_ROWS} rows at a time`, {
      limit: MAX_ROWS,
      rows: rows.length,
    });
  }
  return rows;
}

async function xlsxTable(content: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(content as unknown as ArrayBuffer);
  } catch {
    throw invalid('UNREADABLE', 'The XLSX file could not be read');
  }
  // The first sheet with a header — the template keeps its help on other sheets.
  for (const sheet of workbook.worksheets) {
    const table: string[][] = [];
    sheet.eachRow({ includeEmpty: true }, (row, number) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        cells[col - 1] = cell.text ?? '';
      });
      table[number - 1] = Array.from(cells, (c) => c ?? '');
    });
    const filled = Array.from(table, (cells) => cells ?? []);
    const hasHeader = filled.slice(0, 10).some((cells) => {
      const columns = cells.map(columnOf);
      return columns.includes('full_name') && columns.includes('email');
    });
    if (hasHeader) return filled;
  }
  return [];
}

/** UTF-8 when it decodes cleanly, otherwise Windows-1251. */
function decodeText(content: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    text = new TextDecoder('windows-1251').decode(content);
  }
  return text.replace(/^\uFEFF/, '');
}

/** CSV by RFC 4180: quoted fields may hold separators, quotes («""») and line breaks. */
export function parseCsv(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const separator =
    (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const table: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === separator) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      table.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    table.push(row);
  }
  return table;
}

/** The rows of an uploaded file; `fileName` tells the format by its extension. */
export async function parseFile(fileName: string, content: Buffer): Promise<RawRow[]> {
  if (content.length === 0) throw invalid('EMPTY', 'The file is empty');
  if (content.length > MAX_FILE_BYTES) {
    throw invalid('TOO_LARGE', 'The file is larger than 5 MB', { limit: MAX_FILE_BYTES });
  }
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'xlsx') return rowsFromTable(await xlsxTable(content));
  if (ext === 'csv' || ext === 'txt') return rowsFromTable(parseCsv(decodeText(content)));
  throw invalid('FORMAT', 'Upload an .xlsx or .csv file (an old .xls must be saved as .xlsx)');
}
