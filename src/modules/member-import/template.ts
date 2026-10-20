// The XLSX template of the staff import (4.B1): the «Сотрудники» sheet to fill,
// the workspace's departments as ready paths, and a sheet with an example. The
// texts are Russian — the file is for the university staff, like the reports.

import ExcelJS from 'exceljs';
import type { PrismaClient } from '@prisma/client';
import { TEMPLATE_HEADERS, MAX_ROWS } from './parse.js';

const ROLES = ['Участник', 'Администратор', 'Гость'];

export async function importTemplate(prisma: PrismaClient, workspaceId: string): Promise<Buffer> {
  const departments = await prisma.department.findMany({
    where: { workspace_id: workspaceId },
    orderBy: [{ order: 'asc' }, { created_at: 'asc' }],
    select: { id: true, name: true, parent_id: true },
  });
  const byId = new Map(departments.map((d) => [d.id, d]));
  const pathOf = (id: string): string => {
    const parts: string[] = [];
    for (let d = byId.get(id); d; d = d.parent_id ? byId.get(d.parent_id) : undefined) {
      parts.unshift(d.name);
    }
    return parts.join(' / ');
  };
  const paths = departments.map((d) => pathOf(d.id)).sort((a, b) => a.localeCompare(b, 'ru'));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Система поручений';

  const sheet = wb.addWorksheet('Сотрудники', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = [
    { header: TEMPLATE_HEADERS.full_name, key: 'full_name', width: 36 },
    { header: TEMPLATE_HEADERS.email, key: 'email', width: 30 },
    { header: TEMPLATE_HEADERS.department, key: 'department', width: 48 },
    { header: TEMPLATE_HEADERS.position, key: 'position', width: 28 },
    { header: TEMPLATE_HEADERS.role, key: 'role', width: 16 },
  ];
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEFF' } };
  for (let row = 2; row <= MAX_ROWS + 1; row++) {
    sheet.getCell(`E${row}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [`"${ROLES.join(',')}"`],
    };
  }

  const help = wb.addWorksheet('Как заполнить');
  help.columns = [{ width: 36 }, { width: 30 }, { width: 48 }, { width: 28 }, { width: 16 }];
  const lines = [
    'Одна строка — один сотрудник. Заполняйте лист «Сотрудники», строку заголовков не меняйте.',
    'ФИО — фамилия, имя и отчество через пробел. Email — рабочая почта: на неё придёт приглашение.',
    'Подразделение — путь через «/», например «Экономический факультет / Кафедра финансов».',
    'Недостающие подразделения будут созданы. Готовые пути — на листе «Подразделения».',
    `Роль — Участник (по умолчанию), Администратор или Гость. Не больше ${MAX_ROWS} строк за раз.`,
    'Перед запуском система покажет, что произойдёт с каждой строкой, и ошибки.',
    '',
    'Пример:',
  ];
  lines.forEach((text) => help.addRow([text]));
  const example = help.addRow(Object.values(TEMPLATE_HEADERS));
  example.font = { bold: true };
  help.addRow([
    'Иванова Мария Петровна',
    'm.ivanova@university.ru',
    'Экономический факультет / Кафедра финансов',
    'Доцент',
    'Участник',
  ]);
  help.addRow([
    'Петров Сергей Николаевич',
    's.petrov@university.ru',
    'Ректорат',
    'Проректор',
    'Администратор',
  ]);

  const list = wb.addWorksheet('Подразделения');
  list.columns = [{ header: 'Подразделение (путь)', key: 'path', width: 70 }];
  list.getRow(1).font = { bold: true };
  paths.forEach((path) => list.addRow({ path }));

  return Buffer.from(await wb.xlsx.writeBuffer());
}
