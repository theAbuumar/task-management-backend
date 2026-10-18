// Exports for the management (Ф10 10.B4, ADR-013): the XLSX реестр поручений and
// the PDF «Справка об исполнении поручений» / project report. Built on the same
// scoped facts and formulas as the dashboard, so a document always matches the
// screen. PDFs embed Roboto (shipped with pdfmake), which covers Cyrillic.

import { createRequire } from 'node:module';
import ExcelJS from 'exceljs';
import PdfPrinter from 'pdfmake';
import type { Content, TDocumentDefinitions, TableCell } from 'pdfmake/interfaces.js';
import type { AnalyticsData } from './data.js';
import {
  counters,
  deadlineOutcome,
  daysOverdue,
  isOpen,
  localDate,
  overdueAt,
  periodEnd,
  previousPeriod,
  snapshotAt,
  type Counters,
  type IssueFact,
} from './metrics.js';
import { byAssignee, byDepartment, overdueItems, type DepartmentNode } from './service.js';

// ─── Formatting ───────────────────────────────────────────────────────────────

/** "2026-10-31" → "31.10.2026". */
const ru = (date: string) => date.split('-').reverse().join('.');
const ruDate = (d: Date | null, tz: string) => (d ? ru(localDate(d, tz)) : '');
const pct = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('ru-RU')} %`);
const num = (n: number | null, digits = 1) =>
  n === null ? '—' : n.toLocaleString('ru-RU', { maximumFractionDigits: digits });

function fio(
  p: {
    last_name: string | null;
    first_name: string | null;
    middle_name: string | null;
    display_name: string;
  } | null,
): string {
  if (!p) return '';
  if (!p.last_name) return p.display_name;
  const initials = [p.first_name, p.middle_name]
    .filter(Boolean)
    .map((x) => `${x![0]}.`)
    .join('');
  return initials ? `${p.last_name} ${initials}` : p.last_name;
}

const KIND = { task: 'Задача', assignment: 'Поручение' } as const;

/** Deadline status of a row in the реестр. */
function deadlineStatus(f: IssueFact, at: Date, tz: string): string {
  if (f.state_group === 'cancelled') return 'Отменено';
  const outcome = deadlineOutcome(f, tz);
  if (outcome === 'on_time') return 'Исполнено в срок';
  if (outcome === 'late') return 'Исполнено с опозданием';
  if (f.state_group === 'completed') return 'Исполнено';
  if (overdueAt(f, at, tz)) return `Просрочено на ${daysOverdue(f, at, tz)} дн.`;
  if (f.state_group === 'review') return 'На проверке';
  return f.due_date ? 'В работе' : 'В работе, без срока';
}

/** Work active in the period: created before its end and not closed before its start. */
function activeInPeriod(d: AnalyticsData): IssueFact[] {
  const end = periodEnd(d.period, d.timezone);
  return d.facts
    .filter((f) => {
      if (f.created_at >= end) return false;
      if (isOpen(f)) return true;
      if (f.state_group === 'completed') {
        return f.completed_at !== null && localDate(f.completed_at, d.timezone) >= d.period.from;
      }
      return localDate(f.created_at, d.timezone) >= d.period.from;
    })
    .sort((a, b) => (a.due_date?.getTime() ?? Infinity) - (b.due_date?.getTime() ?? Infinity));
}

function filterLabel(
  d: AnalyticsData,
  query: { department?: string | string[]; project?: string | string[]; kind?: string },
): string[] {
  const lines: string[] = [];
  const list = (v?: string | string[]) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const departments = list(query.department)
    .map((id) => d.departments.find((x) => x.id === id)?.name)
    .filter(Boolean);
  if (departments.length) lines.push(`Подразделение: ${departments.join(', ')} (с подчинёнными)`);
  const projects = list(query.project)
    .map((id) => d.projects.find((x) => x.id === id)?.name)
    .filter(Boolean);
  if (projects.length) lines.push(`Проект: ${projects.join(', ')}`);
  if (query.kind) lines.push(`Вид: ${query.kind === 'assignment' ? 'поручения' : 'задачи'}`);
  if (d.scope.kind === 'departments') {
    const heads = d.scope.department_ids.map((id) => d.departments.find((x) => x.id === id)?.name);
    lines.push(`Область: ${heads.join(', ')} и подчинённые подразделения`);
  }
  if (d.scope.kind === 'self') lines.push('Область: собственные задачи');
  return lines;
}

/** Department rows for tables: depth-first, indented, only units with work. */
function departmentRows(
  tree: DepartmentNode[],
  maxDepth = 3,
): { node: DepartmentNode; depth: number }[] {
  const rows: { node: DepartmentNode; depth: number }[] = [];
  const walk = (nodes: DepartmentNode[], depth: number) => {
    for (const node of nodes) {
      const t = node.total;
      if (t.created + t.completed + t.open === 0) continue;
      rows.push({ node, depth });
      if (depth + 1 < maxDepth) walk(node.children, depth + 1);
    }
  };
  walk(tree, 0);
  return rows;
}

// ─── XLSX: реестр поручений ───────────────────────────────────────────────────

const RED = 'FFFDE2E2';
const AMBER = 'FFFEF3C7';
const GREEN = 'FFDCFCE7';
const HEADER = 'FF1E3A8A';

/** Excel date cell for a local date (Excel has no time zone; midnight UTC shows that day). */
function excelDate(d: Date | null, tz: string): Date | null {
  if (!d) return null;
  const [y, m, day] = localDate(d, tz).split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, day));
}

export async function assignmentsXlsx(
  d: AnalyticsData,
  query: { department?: string | string[]; project?: string | string[]; kind?: string },
): Promise<Buffer> {
  const tz = d.timezone;
  const at = snapshotAt(d.period, tz, d.now);
  const wb = new ExcelJS.Workbook();
  wb.creator = d.workspace.name;
  wb.created = d.now;

  const ws = wb.addWorksheet('Реестр', {
    pageSetup: {
      orientation: 'landscape',
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    },
  });
  const columns: { header: string; key: string; width: number }[] = [
    { header: '№', key: 'n', width: 5 },
    { header: 'Ключ', key: 'key', width: 11 },
    { header: 'Поручение / задача', key: 'title', width: 48 },
    { header: 'Вид', key: 'kind', width: 11 },
    { header: 'Основание', key: 'basis', width: 26 },
    { header: 'Проект', key: 'project', width: 22 },
    { header: 'Подразделение', key: 'department', width: 30 },
    { header: 'Ответственный', key: 'assignee', width: 22 },
    { header: 'Соисполнители', key: 'co', width: 24 },
    { header: 'Контролёр', key: 'controller', width: 22 },
    { header: 'Создано', key: 'created', width: 12 },
    { header: 'Срок', key: 'due', width: 12 },
    { header: 'Исполнено', key: 'completed', width: 12 },
    { header: 'Состояние', key: 'state', width: 16 },
    { header: 'Исполнение в срок', key: 'status', width: 24 },
    { header: 'Переносов срока', key: 'moves', width: 10 },
  ];
  ws.columns = columns.map((c) => ({ key: c.key, width: c.width }));

  // Title block above the table.
  ws.addRow([`Реестр поручений — ${d.workspace.name}`]).font = { bold: true, size: 14 };
  ws.addRow([`Период: ${ru(d.period.from)} — ${ru(d.period.to)}`]);
  for (const line of filterLabel(d, query)) ws.addRow([line]);
  ws.addRow([`Сформировано: ${ruDate(d.now, tz)}`]).font = {
    italic: true,
    color: { argb: 'FF6B7280' },
  };
  ws.addRow([]);

  const headerRow = ws.addRow(columns.map((c) => c.header));
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { bottom: { style: 'thin' } };
  });
  headerRow.height = 30;

  const projects = new Map(d.projects.map((p) => [p.id, p]));
  const departments = new Map(d.departments.map((x) => [x.id, x]));
  const moves = new Map<string, number>();
  for (const r of d.deadlines)
    if (r.status === 'approved') moves.set(r.issue_id, (moves.get(r.issue_id) ?? 0) + 1);
  const name = (id: string | null) => fio(id ? (d.people.get(id) ?? null) : null);

  activeInPeriod(d).forEach((f, i) => {
    const project = projects.get(f.project_id);
    const status = deadlineStatus(f, at, tz);
    const row = ws.addRow({
      n: i + 1,
      key: project ? `${project.identifier}-${f.sequence_id}` : f.sequence_id,
      title: f.title,
      kind: KIND[f.kind],
      basis: f.basis ?? '',
      project: project?.name ?? '',
      department: f.department_id ? (departments.get(f.department_id)?.name ?? '') : '',
      assignee: name(f.assignee_id),
      co: f.co_assignee_ids.map(name).filter(Boolean).join(', '),
      controller: name(f.controller_id ?? f.created_by_id),
      created: excelDate(f.created_at, tz),
      due: excelDate(f.due_date, tz),
      completed: f.state_group === 'completed' ? excelDate(f.completed_at, tz) : null,
      state: f.state_name,
      status,
      moves: moves.get(f.id) ?? 0,
    });
    row.alignment = { vertical: 'top', wrapText: true };
    for (const key of ['created', 'due', 'completed']) row.getCell(key).numFmt = 'dd.mm.yyyy';
    const fill = status.startsWith('Просрочено')
      ? RED
      : status.endsWith('опозданием')
        ? AMBER
        : status.endsWith('в срок')
          ? GREEN
          : null;
    if (fill)
      row.getCell('status').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  });

  ws.views = [{ state: 'frozen', ySplit: headerRow.number, xSplit: 3 }];
  ws.autoFilter = {
    from: { row: headerRow.number, column: 1 },
    to: { row: Math.max(headerRow.number, ws.rowCount), column: columns.length },
  };

  // Second sheet: the KPI and the department table, same as the справка.
  const sum = wb.addWorksheet('Сводка');
  sum.columns = [
    { width: 46 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
  ];
  sum.addRow([`Сводка за ${ru(d.period.from)} — ${ru(d.period.to)}`]).font = {
    bold: true,
    size: 13,
  };
  sum.addRow([]);
  const kpi = summaryRows(d);
  const kpiHead = sum.addRow(['Показатель', 'За период', 'Пред. период']);
  kpiHead.font = { bold: true };
  for (const [label, cur, prev] of kpi) sum.addRow([label, cur, prev]);
  sum.addRow([]);
  const deptHead = sum.addRow([
    'Подразделение',
    'Поступило',
    'Исполнено',
    'В срок',
    'С опозданием',
    'Просрочено',
    'Дисциплина, %',
  ]);
  deptHead.font = { bold: true };
  for (const { node, depth } of departmentRows(byDepartment(d).tree)) {
    const t = node.total;
    sum.addRow([
      `${'   '.repeat(depth)}${node.name}`,
      t.created,
      t.completed,
      t.on_time,
      t.late,
      t.overdue,
      t.discipline ?? '—',
    ]);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ─── PDF ──────────────────────────────────────────────────────────────────────

let printer: PdfPrinter | null = null;

function pdfPrinter(): PdfPrinter {
  if (!printer) {
    const require = createRequire(import.meta.url);
    const vfs = require('pdfmake/build/vfs_fonts.js') as Record<string, string>;
    const font = (file: string) => Buffer.from(vfs[file]!, 'base64');
    printer = new PdfPrinter({
      Roboto: {
        normal: font('Roboto-Regular.ttf'),
        bold: font('Roboto-Medium.ttf'),
        italics: font('Roboto-Italic.ttf'),
        bolditalics: font('Roboto-MediumItalic.ttf'),
      },
    });
  }
  return printer;
}

/** Render a pdfmake document (Roboto, Cyrillic) to bytes. Also used by the demo seed. */
export function renderPdf(doc: TDocumentDefinitions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = pdfPrinter().createPdfKitDocument(doc);
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    pdf.end();
  });
}

/** [label, current, previous] rows of the KPI table. */
function summaryRows(d: AnalyticsData): [string, string | number, string | number][] {
  const prev = previousPeriod(d.period);
  const c = counters({
    facts: d.facts,
    deadlines: d.deadlines,
    reviews: d.reviews,
    period: d.period,
    tz: d.timezone,
    now: d.now,
  });
  const p = counters({
    facts: d.facts,
    deadlines: d.deadlines,
    reviews: d.reviews,
    period: prev,
    tz: d.timezone,
    now: d.now,
  });
  return [
    ['Поступило поручений и задач', c.created, p.created],
    ['Исполнено', c.completed, p.completed],
    ['   из них в срок', c.on_time, p.on_time],
    ['   с опозданием', c.late, p.late],
    ['Исполнительская дисциплина', pct(c.discipline), pct(p.discipline)],
    ['Просрочено на конец периода', c.overdue, p.overdue],
    ['В работе на конец периода', c.open, p.open],
    ['Не ознакомлены с поручением', c.unacknowledged, p.unacknowledged],
    ['Переносов сроков (одобрено)', c.deadline_changes, p.deadline_changes],
    ['Возвратов на доработку', c.returns, p.returns],
    [
      'Медианное время исполнения, дней',
      num(c.median_execution_days),
      num(p.median_execution_days),
    ],
    ['Медианное время реакции, часов', num(c.median_reaction_hours), num(p.median_reaction_hours)],
  ];
}

const th = (text: string): TableCell => ({ text, style: 'th' });

function kpiTable(d: AnalyticsData): Content {
  const prev = previousPeriod(d.period);
  return {
    table: {
      headerRows: 1,
      widths: ['*', 80, 80],
      body: [
        [
          th('Показатель'),
          th(`${ru(d.period.from)}–${ru(d.period.to)}`),
          th(`${ru(prev.from)}–${ru(prev.to)}`),
        ],
        ...summaryRows(d).map(([label, cur, p]) => [
          // Sub-rows ("из них в срок") are indented with a margin: pdfmake trims leading spaces.
          {
            text: label.trim(),
            margin: [label.startsWith(' ') ? 12 : 0, 0, 0, 0] as [number, number, number, number],
          },
          { text: String(cur), alignment: 'right' as const, bold: true },
          { text: String(p), alignment: 'right' as const, color: '#6b7280' },
        ]),
      ],
    },
    layout: 'lightHorizontalLines',
  };
}

function departmentTable(d: AnalyticsData): Content {
  const rows = departmentRows(byDepartment(d).tree);
  if (rows.length === 0) return { text: 'Нет данных за период.', italics: true, color: '#6b7280' };
  return {
    table: {
      headerRows: 1,
      widths: ['*', 42, 42, 36, 42, 46, 50],
      body: [
        [
          th('Подразделение'),
          th('Поступило'),
          th('Исполнено'),
          th('В срок'),
          th('С опозд.'),
          th('Просрочено'),
          th('Дисциплина'),
        ],
        ...rows.map(({ node, depth }) => {
          const t: Counters = node.total;
          return [
            {
              text: node.name,
              margin: [depth * 10, 0, 0, 0] as [number, number, number, number],
              bold: depth === 0,
            },
            { text: String(t.created), alignment: 'right' as const },
            { text: String(t.completed), alignment: 'right' as const },
            { text: String(t.on_time), alignment: 'right' as const },
            { text: String(t.late), alignment: 'right' as const },
            {
              text: String(t.overdue),
              alignment: 'right' as const,
              color: t.overdue ? '#b91c1c' : undefined,
            },
            { text: pct(t.discipline), alignment: 'right' as const, bold: true },
          ];
        }),
      ],
    },
    layout: 'lightHorizontalLines',
  };
}

function overdueTable(d: AnalyticsData, limit = 40): Content {
  const items = overdueItems(d);
  if (items.length === 0)
    return { text: 'Просроченных поручений нет.', italics: true, color: '#047857' };
  const body: TableCell[][] = [
    [
      th('№'),
      th('Ключ'),
      th('Поручение'),
      th('Ответственный'),
      th('Подразделение'),
      th('Срок'),
      th('Дней'),
    ],
    ...items
      .slice(0, limit)
      .map((x, i) => [
        { text: String(i + 1) },
        { text: x.key, noWrap: true },
        { text: x.title },
        { text: fio(x.assignee) },
        { text: x.department?.short_name ?? x.department?.name ?? '' },
        { text: ruDate(x.due_date, d.timezone), noWrap: true },
        { text: String(x.days_overdue), alignment: 'right' as const, color: '#b91c1c', bold: true },
      ]),
  ];
  const more: Content[] =
    items.length > limit
      ? [{ text: `…и ещё ${items.length - limit}`, italics: true, margin: [0, 4, 0, 0] }]
      : [];
  return [
    {
      table: { headerRows: 1, widths: [16, 52, '*', 80, 80, 52, 26], body },
      layout: 'lightHorizontalLines',
    },
    ...more,
  ];
}

function assigneeTable(d: AnalyticsData, limit = 25): Content {
  const items = byAssignee(d).items.slice(0, limit);
  if (items.length === 0) return { text: 'Нет данных.', italics: true, color: '#6b7280' };
  return {
    table: {
      headerRows: 1,
      widths: ['*', 90, 44, 44, 52, 54],
      body: [
        [
          th('Исполнитель'),
          th('Подразделение'),
          th('В работе'),
          th('Просрочено'),
          th('Исполнено'),
          th('Дисциплина'),
        ],
        ...items.map((x) => [
          { text: fio(x.user) },
          { text: x.department?.short_name ?? x.department?.name ?? '' },
          { text: String(x.open_primary), alignment: 'right' as const },
          {
            text: String(x.overdue),
            alignment: 'right' as const,
            color: x.overdue ? '#b91c1c' : undefined,
          },
          { text: String(x.completed), alignment: 'right' as const },
          { text: pct(x.discipline), alignment: 'right' as const },
        ]),
      ],
    },
    layout: 'lightHorizontalLines',
  };
}

function signature(d: AnalyticsData): Content {
  return {
    margin: [0, 28, 0, 0],
    stack: [
      {
        columns: [
          { width: '*', text: 'Ответственный за контроль исполнения' },
          { width: 140, text: '____________________', alignment: 'center' },
          { width: 140, text: '/ ____________________ /', alignment: 'center' },
        ],
      },
      {
        columns: [
          { width: '*', text: '' },
          { width: 140, text: 'подпись', alignment: 'center', fontSize: 7, color: '#6b7280' },
          { width: 140, text: 'Ф. И. О.', alignment: 'center', fontSize: 7, color: '#6b7280' },
        ],
      },
      { text: `«____» ______________ ${d.now.getFullYear()} г.`, margin: [0, 14, 0, 0] },
    ],
  };
}

function documentShell(
  d: AnalyticsData,
  title: string,
  subtitle: string[],
  content: Content[],
): TDocumentDefinitions {
  return {
    pageSize: 'A4',
    pageMargins: [40, 48, 40, 48],
    info: { title, creator: d.workspace.name },
    defaultStyle: { font: 'Roboto', fontSize: 9, lineHeight: 1.15 },
    styles: {
      org: { fontSize: 11, bold: true, alignment: 'center' },
      title: { fontSize: 15, bold: true, alignment: 'center', margin: [0, 14, 0, 2] },
      subtitle: { fontSize: 10, alignment: 'center', color: '#374151' },
      h2: { fontSize: 11, bold: true, margin: [0, 16, 0, 6] },
      th: { bold: true, fontSize: 8, color: '#1f2937', fillColor: '#eef2ff' },
      muted: { color: '#6b7280', fontSize: 8 },
    },
    footer: (page: number, pages: number) => ({
      columns: [
        {
          text: `Сформировано ${ruDate(d.now, d.timezone)} · ${d.workspace.name}`,
          style: 'muted',
          margin: [40, 0, 0, 0],
        },
        {
          text: `Страница ${page} из ${pages}`,
          style: 'muted',
          alignment: 'right',
          margin: [0, 0, 40, 0],
        },
      ],
    }),
    content: [
      { text: d.workspace.name.toUpperCase(), style: 'org' },
      ...(d.workspace.short_name
        ? [{ text: d.workspace.short_name, style: 'subtitle' } as Content]
        : []),
      {
        canvas: [
          { type: 'line', x1: 0, y1: 6, x2: 515, y2: 6, lineWidth: 1, lineColor: '#1e3a8a' },
        ],
      },
      { text: title, style: 'title' },
      ...subtitle.map((text) => ({ text, style: 'subtitle' }) as Content),
      ...content,
    ],
  };
}

export function disciplinePdf(
  d: AnalyticsData,
  query: { department?: string | string[]; project?: string | string[]; kind?: string },
): Promise<Buffer> {
  return renderPdf(
    documentShell(
      d,
      'СПРАВКА',
      [
        `об исполнении поручений за период с ${ru(d.period.from)} по ${ru(d.period.to)}`,
        ...filterLabel(d, query),
      ],
      [
        { text: '1. Основные показатели', style: 'h2' },
        kpiTable(d),
        { text: '2. Исполнение по подразделениям', style: 'h2' },
        departmentTable(d),
        {
          text: `3. Просроченные поручения на ${ruDate(snapshotAt(d.period, d.timezone, d.now), d.timezone)}`,
          style: 'h2',
        },
        overdueTable(d),
        signature(d),
      ],
    ),
  );
}

export function projectPdf(
  d: AnalyticsData,
  project: { name: string; identifier: string },
): Promise<Buffer> {
  return renderPdf(
    documentShell(
      d,
      'ОТЧЁТ ПО ПРОЕКТУ',
      [
        `«${project.name}» (${project.identifier})`,
        `за период с ${ru(d.period.from)} по ${ru(d.period.to)}`,
      ],
      [
        { text: '1. Основные показатели', style: 'h2' },
        kpiTable(d),
        { text: '2. По подразделениям', style: 'h2' },
        departmentTable(d),
        { text: '3. По исполнителям', style: 'h2' },
        assigneeTable(d),
        { text: '4. Просроченные задачи', style: 'h2' },
        overdueTable(d),
        signature(d),
      ],
    ),
  );
}
