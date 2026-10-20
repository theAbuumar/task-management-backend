// Integration tests for the staff import (4.B1) and «Добавить сразу» (4.F10),
// ADR-031:
// - the XLSX template, with the workspace's departments as paths;
// - a check (dry_run) says per row what will happen and changes nothing;
// - a run skips error rows, creates missing departments, invites registered and
//   new people with their place in the org structure, updates members;
// - accepting such an invitation applies the department, the position and, for a
//   new account, the full name;
// - files: XLSX, CSV in Windows-1251 with «;», a file without headers, too many
//   rows, an old .xls;
// - admins only; adding a registered person by email right away.
//
// Runs against a live Postgres; everything is removed in afterAll.

import request from 'supertest';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `mimp-${TS}`;
const mail = (who: string) => `mi-${who}-${TS}@example.com`;
const emails = {
  admin: mail('admin'),
  member: mail('member'),
  known: mail('known'),
  direct: mail('direct'),
  // Never registered before the import: created when accepting.
  fresh: mail('fresh'),
  fresh2: mail('fresh2'),
};

type Actor = { id: string; token: string };
type Row = {
  row: number;
  email: string;
  status: string;
  result?: string;
  errors: { field: string; code: string }[];
  new_departments: string[];
};

let app: FastifyInstance;
let admin: Actor;
let member: Actor;
let known: Actor;
let direct: Actor;
let econId: string;

const api = (path: string) => `/api/v1/workspaces/${SLUG}${path}`;

async function register(email: string, extra: object = {}): Promise<Actor> {
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, display_name: email.split('@')[0], ...extra });
  expect(res.status).toBe(201);
  return { id: res.body.user.id, token: res.body.access_token };
}

function as(actor: Actor) {
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${actor.token}`);
  return {
    get: (url: string) => auth(request(app.server).get(url)),
    post: (url: string, body?: object) => auth(request(app.server).post(url)).send(body ?? {}),
  };
}

const importRows = (rows: object[], dryRun = true) =>
  as(admin).post(api('/members/import'), { rows, dry_run: dryRun });

async function xlsx(rows: string[][]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Сотрудники');
  sheet.addRow(['ФИО', 'Email', 'Подразделение', 'Должность', 'Роль']);
  rows.forEach((r) => sheet.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  admin = await register(emails.admin);
  member = await register(emails.member);
  known = await register(emails.known);
  direct = await register(emails.direct);
  await as(admin).post('/api/v1/workspaces', { name: 'Университет', slug: SLUG });
  await as(admin).post(api('/members'), { user_id: member.id, role: 'member' });
  econId = (
    await as(admin).post(api('/departments'), { name: 'Экономический факультет', short_name: 'ЭФ' })
  ).body.id;
});

afterAll(async () => {
  const ws = await app.prisma.workspace.findUnique({ where: { slug: SLUG } });
  if (ws) {
    await app.prisma.workspaceInvite.deleteMany({ where: { workspace_id: ws.id } });
    await app.prisma.workspace.delete({ where: { id: ws.id } });
  }
  await app.prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
  await app.close();
});

describe('template', () => {
  it('is an XLSX with the columns and the workspace departments', async () => {
    const res = await as(admin)
      .get(api('/members/import/template'))
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    expect(wb.worksheets.map((s) => s.name)).toEqual([
      'Сотрудники',
      'Как заполнить',
      'Подразделения',
    ]);
    expect(wb.getWorksheet('Сотрудники')!.getRow(1).values).toEqual([
      undefined,
      'ФИО',
      'Email',
      'Подразделение',
      'Должность',
      'Роль',
    ]);
    expect(wb.getWorksheet('Подразделения')!.getCell('A2').text).toBe('Экономический факультет');
  });
});

describe('check (dry_run)', () => {
  it('says what each row will do and changes nothing', async () => {
    const res = await importRows([
      {
        full_name: 'Знакомов Пётр Ильич',
        email: emails.known,
        department: 'ЭФ / Кафедра финансов',
        position: 'Доцент',
      },
      {
        full_name: 'Новикова Анна Сергеевна',
        email: emails.fresh.toUpperCase(),
        department: 'Ректорат',
        role: 'Администратор',
      },
      {
        full_name: 'Участников Иван',
        email: emails.member,
        department: 'Экономический факультет',
        position: 'Декан',
      },
      { full_name: 'Без Почты', email: '' },
      { full_name: 'Одно', email: 'one@example.com' },
      { full_name: 'Плохой Адрес', email: 'not-an-email' },
      { full_name: 'Двойник Пётр', email: emails.known },
      { full_name: 'Странная Роль', email: 'role@example.com', role: 'Ректор' },
    ]);
    expect(res.status).toBe(200);
    const rows = res.body.rows as Row[];
    expect(rows.map((r) => r.status)).toEqual([
      'invite_existing',
      'invite_new',
      'update',
      'error',
      'error',
      'error',
      'error',
      'error',
    ]);
    expect(rows[1]!.email).toBe(emails.fresh);
    expect(rows.slice(3).map((r) => r.errors[0]!.code)).toEqual([
      'EMAIL_REQUIRED',
      'NAME_INCOMPLETE',
      'EMAIL_INVALID',
      'EMAIL_DUPLICATE',
      'ROLE_INVALID',
    ]);
    // «ЭФ» is the short name of an existing faculty; the chair and «Ректорат» are new.
    expect(rows[0]!.new_departments).toEqual(['Экономический факультет / Кафедра финансов']);
    expect(res.body.summary).toMatchObject({
      total: 8,
      errors: 5,
      invite_existing: 1,
      invite_new: 1,
      update: 1,
      departments_to_create: ['Экономический факультет / Кафедра финансов', 'Ректорат'],
    });

    const ws = await app.prisma.workspace.findUniqueOrThrow({ where: { slug: SLUG } });
    expect(await app.prisma.department.count({ where: { workspace_id: ws.id } })).toBe(1);
    expect(await app.prisma.workspaceMemberInvite.count({ where: { workspace_id: ws.id } })).toBe(
      0,
    );
    expect(await app.prisma.workspaceInvite.count({ where: { workspace_id: ws.id } })).toBe(0);
  });

  it('is for admins only', async () => {
    const res = await as(member).post(api('/members/import'), {
      rows: [{ full_name: 'Кто Угодно', email: 'x@example.com' }],
    });
    expect(res.status).toBe(403);
  });
});

describe('run', () => {
  it('invites with the place in the org structure, updates members, skips errors', async () => {
    const content_base64 = await xlsx([
      ['Знакомов Пётр Ильич', emails.known, 'ЭФ / Кафедра финансов', 'Доцент', 'Участник'],
      ['Новикова Анна Сергеевна', emails.fresh, 'Ректорат', 'Проректор', 'Администратор'],
      ['Участников Иван', emails.member, 'Экономический факультет', 'Декан', ''],
      ['Ошибка', 'bad', '', '', ''],
    ]);
    const res = await as(admin).post(api('/members/import'), {
      file_name: 'Сотрудники.xlsx',
      content_base64,
      dry_run: false,
    });
    expect(res.status).toBe(200);
    expect((res.body.rows as Row[]).map((r) => r.result)).toEqual([
      'invited',
      'invited',
      'updated',
      'skipped',
    ]);
    expect(res.body.summary).toMatchObject({ invited: 2, updated: 1, failed: 0, errors: 1 });
    expect(res.body.rows[0].row).toBe(2);

    const ws = await app.prisma.workspace.findUniqueOrThrow({ where: { slug: SLUG } });
    const chair = await app.prisma.department.findFirstOrThrow({
      where: { workspace_id: ws.id, name: 'Кафедра финансов' },
    });
    expect(chair.parent_id).toBe(econId);
    const rectorate = await app.prisma.department.findFirstOrThrow({
      where: { workspace_id: ws.id, name: 'Ректорат' },
    });

    const m = await app.prisma.workspaceMember.findUniqueOrThrow({
      where: { workspace_id_user_id: { workspace_id: ws.id, user_id: member.id } },
    });
    expect(m).toMatchObject({ department_id: econId, position: 'Декан', role: 'member' });

    // The registered person: an invitation in their inbox; accepting places them.
    const inbox = await as(known).get('/api/v1/invitations');
    const invite = inbox.body.find(
      (i: { workspace: { slug: string } }) => i.workspace.slug === SLUG,
    );
    expect(invite).toBeTruthy();
    expect((await as(known).post(`/api/v1/invitations/${invite.id}/accept`)).status).toBe(200);
    const k = await app.prisma.workspaceMember.findUniqueOrThrow({
      where: { workspace_id_user_id: { workspace_id: ws.id, user_id: known.id } },
    });
    expect(k).toMatchObject({ department_id: chair.id, position: 'Доцент', role: 'member' });

    // The new person signs up by the emailed link: role, place and full name applied.
    const emailInvite = await app.prisma.workspaceInvite.findFirstOrThrow({
      where: { workspace_id: ws.id, email: emails.fresh },
    });
    const fresh = await register(emails.fresh, { invite_token: emailInvite.token });
    const user = await app.prisma.user.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(user).toMatchObject({
      last_name: 'Новикова',
      first_name: 'Анна',
      middle_name: 'Сергеевна',
      display_name: 'Новикова Анна Сергеевна',
    });
    const f = await app.prisma.workspaceMember.findUniqueOrThrow({
      where: { workspace_id_user_id: { workspace_id: ws.id, user_id: fresh.id } },
    });
    expect(f).toMatchObject({ department_id: rectorate.id, position: 'Проректор', role: 'admin' });

    const audit = await app.prisma.auditLog.findFirst({
      where: { workspace_id: ws.id, action: 'member.imported' },
    });
    expect(audit?.meta).toMatchObject({ rows: 4, invited: 2, updated: 1, skipped: 1 });
  });

  it('reads a CSV saved by Russian Excel (Windows-1251, «;»)', async () => {
    const text =
      'ФИО;Email;Подразделение;Должность;Роль\r\n' +
      `"Свежев; Олег Петрович";${emails.fresh2};Ректорат;"Советник ""по науке""";Гость\r\n`;
    const cp1251 = Buffer.from(
      [...text].map((ch) => {
        const code = ch.charCodeAt(0);
        if (code < 128) return code;
        if (ch === 'Ё') return 0xa8;
        if (ch === 'ё') return 0xb8;
        return code - 0x410 + 0xc0; // А..я
      }),
    );
    const res = await as(admin).post(api('/members/import'), {
      file_name: 'staff.csv',
      content_base64: cp1251.toString('base64'),
    });
    expect(res.status).toBe(200);
    expect(res.body.rows[0]).toMatchObject({
      full_name: 'Свежев; Олег Петрович',
      email: emails.fresh2,
      department: 'Ректорат',
      position: 'Советник "по науке"',
      role: 'guest',
      status: 'invite_new',
      new_departments: [],
    });
  });

  it('refuses a file it cannot read', async () => {
    const noHeader = await as(admin).post(api('/members/import'), {
      file_name: 'list.csv',
      content_base64: Buffer.from('Иванов;ivanov@example.com\n').toString('base64'),
    });
    expect(noHeader.status).toBe(400);
    expect(noHeader.body.error).toMatchObject({
      code: 'IMPORT_FILE_INVALID',
      details: { reason: 'NO_HEADER' },
    });

    const old = await as(admin).post(api('/members/import'), {
      file_name: 'list.xls',
      content_base64: Buffer.from('x').toString('base64'),
    });
    expect(old.body.error.details.reason).toBe('FORMAT');

    const lines = Array.from({ length: 501 }, (_, i) => `Сотрудник Номер${i};n${i}@example.com`);
    const many = await as(admin).post(api('/members/import'), {
      file_name: 'many.csv',
      content_base64: Buffer.from(['ФИО;Email', ...lines].join('\n')).toString('base64'),
    });
    expect(many.status).toBe(400);
    expect(many.body.error).toMatchObject({
      code: 'IMPORT_TOO_MANY_ROWS',
      details: { limit: 500 },
    });
  });
});

describe('«Добавить сразу» (POST WS/members by email)', () => {
  it('adds a registered person at once with department and position', async () => {
    const res = await as(admin).post(api('/members'), {
      email: emails.direct.toUpperCase(),
      role: 'member',
      department_id: econId,
      position: 'Методист',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      user_id: direct.id,
      department_id: econId,
      position: 'Методист',
    });

    const again = await as(admin).post(api('/members'), { email: emails.direct });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_MEMBER');

    const nobody = await as(admin).post(api('/members'), { email: `nobody-${TS}@example.com` });
    expect(nobody.status).toBe(404);
    expect(nobody.body.error.code).toBe('USER_NOT_FOUND');

    const both = await as(admin).post(api('/members'), {
      email: emails.direct,
      user_id: direct.id,
    });
    expect(both.status).toBe(400);
    expect((await as(member).post(api('/members'), { email: emails.known })).status).toBe(403);
  });
});
