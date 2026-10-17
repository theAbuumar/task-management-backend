// Integration tests for the analytics and reports of Ф10 (10.B1, 10.B3, 10.B4,
// 10.B6): the numbers match a hand count on a small university, every role sees
// only its area (admin — all, head — own subtree, employee — own work), the
// exports are real XLSX/PDF files and are logged, and a write drops the cache.
//
// Runs against a live Postgres. All created rows are removed in afterAll.

import request from 'supertest';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `anl-${TS}`;
const DAY = 24 * 60 * 60 * 1000;
const emails = {
  rector: `anl-rector-${TS}@example.com`,
  deanA: `anl-dean-a-${TS}@example.com`,
  chair: `anl-chair-${TS}@example.com`,
  worker: `anl-worker-${TS}@example.com`,
  deanB: `anl-dean-b-${TS}@example.com`,
};

type Actor = { id: string; token: string };
type Node = {
  id: string;
  name: string;
  own: Record<string, number>;
  total: Record<string, number>;
  children: Node[];
};

let app: FastifyInstance;
let rector: Actor;
let deanA: Actor;
let chair: Actor;
let worker: Actor;
let deanB: Actor;
let projectId: string;
let privateProjectId: string;
const dept: Record<string, string> = {};
const issue: Record<string, string> = {};
let states: Record<string, string> = {};

const api = (path: string) => `/api/v1/workspaces/${SLUG}${path}`;
const dueIn = (days: number) => new Date(Date.now() + days * DAY).toISOString();

async function register(email: string): Promise<Actor> {
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, display_name: email.split('@')[0] });
  expect(res.status).toBe(201);
  return { id: res.body.user.id, token: res.body.access_token };
}

function as(actor: Actor) {
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${actor.token}`);
  return {
    get: (url: string) => auth(request(app.server).get(url)),
    post: (url: string, body?: object) => auth(request(app.server).post(url)).send(body ?? {}),
    patch: (url: string, body: object) => auth(request(app.server).patch(url)).send(body),
  };
}

async function get(actor: Actor, path: string, status = 200) {
  const res = await as(actor).get(api(path));
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
}

const summary = async (actor: Actor, q = '') =>
  (await get(actor, `/analytics/summary${q}`)).current;

async function create(title: string, assignee: Actor, extra: object = {}): Promise<string> {
  const res = await as(rector).post(api(`/projects/${projectId}/issues`), {
    title,
    state_id: states.unstarted,
    assignee_ids: [assignee.id],
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

const issueUrl = (id: string, suffix = '') => api(`/projects/${projectId}/issues/${id}${suffix}`);

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  rector = await register(emails.rector);
  deanA = await register(emails.deanA);
  chair = await register(emails.chair);
  worker = await register(emails.worker);
  deanB = await register(emails.deanB);

  await as(rector).post('/api/v1/workspaces', {
    name: 'Тестовый университет',
    slug: SLUG,
    timezone: 'Asia/Tashkent',
  });
  for (const u of [deanA, chair, worker, deanB])
    await as(rector).post(api('/members'), { user_id: u.id, role: 'member' });

  const mk = async (name: string, parent?: string, head?: Actor) => {
    const res = await as(rector).post(api('/departments'), {
      name,
      parent_id: parent,
      head_id: head?.id,
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };
  dept.root = await mk('Ректорат', undefined, rector);
  dept.a = await mk('Факультет А', dept.root, deanA);
  dept.a1 = await mk('Кафедра А1', dept.a, chair);
  dept.b = await mk('Факультет Б', dept.root, deanB);
  const place = (u: Actor, d: string) =>
    as(rector).patch(api(`/members/${u.id}`), { department_id: d });
  await place(rector, dept.root);
  await place(deanA, dept.a);
  await place(chair, dept.a1);
  await place(worker, dept.a1);
  await place(deanB, dept.b);

  const project = await as(rector).post(api('/projects'), {
    name: 'Аккредитация',
    identifier: 'ANL',
    member_ids: [deanA.id, chair.id, worker.id, deanB.id],
  });
  projectId = project.body.id;
  const priv = await as(rector).post(api('/projects'), {
    name: 'Закрытый',
    identifier: 'ANP',
    visibility: 'private',
  });
  privateProjectId = priv.body.id;
  const st = await as(rector).get(api(`/projects/${projectId}/states`));
  states = Object.fromEntries(st.body.map((s: { group: string; id: string }) => [s.group, s.id]));

  // Hand-countable picture (now = today in Tashkent):
  issue.a = await create('Отчёт факультета А', deanA, { due_date: dueIn(-3) }); // open, overdue 3 days
  issue.a1onTime = await create('Программы кафедры', chair, { due_date: dueIn(5) }); // done on time
  issue.a1late = await create('Справка кафедры', worker, { due_date: dueIn(-2) }); // done late
  issue.b = await create('Отчёт факультета Б', deanB, {
    due_date: dueIn(-1),
    kind: 'assignment',
    controller_id: rector.id,
  }); // overdue 1 day
  issue.bNoDue = await create('Без срока', deanB); // open, no deadline
  issue.moved = await create('Перенос срока', chair, {
    due_date: dueIn(2),
    kind: 'assignment',
    controller_id: rector.id,
  });

  for (const id of [issue.a1onTime, issue.a1late]) {
    expect((await as(rector).patch(issueUrl(id), { state_id: states.completed })).status).toBe(200);
  }
  // Acknowledged, deadline moved once (approved), handed in and returned once.
  expect((await as(chair).post(issueUrl(issue.moved, '/acknowledge'))).status).toBe(200);
  const reqDl = await as(chair).post(issueUrl(issue.moved, '/deadline-requests'), {
    new_due_date: dueIn(9),
    reason: 'Ждём данные из бухгалтерии',
  });
  expect(reqDl.status).toBe(201);
  expect(
    (await as(rector).post(issueUrl(issue.moved, `/deadline-requests/${reqDl.body.id}/approve`)))
      .status,
  ).toBe(200);
  expect(
    (await as(chair).post(issueUrl(issue.moved, '/review/submit'), { report: 'Готово' })).status,
  ).toBe(200);
  expect(
    (await as(rector).post(issueUrl(issue.moved, '/review/return'), { comment: 'Нет подписи' }))
      .status,
  ).toBe(200);
});

afterAll(async () => {
  const list = Object.values(emails);
  await app.prisma.workspace.deleteMany({ where: { slug: SLUG } });
  await app.prisma.refreshToken.deleteMany({ where: { user: { email: { in: list } } } });
  await app.prisma.user.deleteMany({ where: { email: { in: list } } });
  await app.close();
});

describe('analytics — numbers match a hand count', () => {
  it('summary: discipline, overdue, moves, returns, reaction', async () => {
    const body = await get(rector, '/analytics/summary');
    expect(body.scope.kind).toBe('all');
    expect(body.current).toMatchObject({
      created: 6,
      completed: 2,
      on_time: 1,
      late: 1,
      discipline: 50,
      open: 4,
      overdue: 2,
      deadline_changes: 1,
      returns: 1,
    });
    expect(body.current.median_reaction_hours).not.toBeNull();
    expect(body.previous).toMatchObject({ created: 0, completed: 0, discipline: null });
    expect(body.previous_period.to < body.period.from).toBe(true);
  });

  it('by-department rolls sub-departments up', async () => {
    const { tree } = await get(rector, '/analytics/by-department');
    expect(tree).toHaveLength(1);
    const root: Node = tree[0];
    expect(root.total).toMatchObject({ completed: 2, overdue: 2, open: 4 });
    const a = root.children.find((n) => n.id === dept.a)!;
    expect(a.own).toMatchObject({ open: 1, overdue: 1, completed: 0 });
    expect(a.total).toMatchObject({
      open: 2,
      overdue: 1,
      completed: 2,
      on_time: 1,
      late: 1,
      discipline: 50,
    });
    expect(a.children[0]!.total).toMatchObject({ completed: 2, open: 1, overdue: 0 });
    const b = root.children.find((n) => n.id === dept.b)!;
    expect(b.total).toMatchObject({ open: 2, overdue: 1 });
  });

  it('by-assignee, by-project, overdue top, deadline changes, reaction time, trends', async () => {
    const people = (await get(rector, '/analytics/by-assignee')).items;
    expect(people.find((p: { user: { id: string } }) => p.user.id === deanB.id)).toMatchObject({
      open_primary: 2,
      overdue: 1,
    });

    const projects = (await get(rector, '/analytics/by-project')).items;
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ total: 6, done: 2, progress: 33, overdue: 2 });

    const overdue = await get(rector, '/analytics/overdue');
    expect(overdue.total).toBe(2);
    expect(overdue.items.map((x: { title: string }) => x.title)).toEqual([
      'Отчёт факультета А',
      'Отчёт факультета Б',
    ]);
    expect(overdue.items[0]).toMatchObject({ key: 'ANL-1', department: { id: dept.a } });
    expect(overdue.items[0].days_overdue).toBeGreaterThanOrEqual(3);

    const moves = await get(rector, '/analytics/deadline-changes');
    expect(moves).toMatchObject({ approved: 1, rejected: 0, pending: 0, returns: 1 });
    expect(moves.items[0]).toMatchObject({
      title: 'Перенос срока',
      reason: 'Ждём данные из бухгалтерии',
      shift_days: 7,
    });

    const reaction = await get(rector, '/analytics/reaction-time');
    expect(reaction.acknowledged).toBe(1);
    expect(
      reaction.by_department.map((x: { department: { id: string } }) => x.department.id),
    ).toContain(dept.a1);

    const trends = await get(rector, '/analytics/trends?bucket=week');
    expect(trends.bucket).toBe('week');
    expect(trends.items.reduce((s: number, x: { completed: number }) => s + x.completed, 0)).toBe(
      2,
    );
  });

  it('filters: project, kind, department with subtree', async () => {
    expect(await summary(rector, `?project=${privateProjectId}`)).toMatchObject({ created: 0 });
    expect(await summary(rector, '?kind=assignment')).toMatchObject({ created: 2, overdue: 1 });
    expect(await summary(rector, `?department=${dept.a}`)).toMatchObject({
      created: 4,
      completed: 2,
    });
  });

  it('rejects a reversed period and a malformed date', async () => {
    await get(rector, '/analytics/summary?from=2026-10-10&to=2026-10-01', 400);
    await get(rector, '/analytics/summary?from=10.10.2026', 400);
  });
});

describe('analytics — who sees what (10.B3)', () => {
  it('a faculty head sees their faculty with its chairs', async () => {
    const body = await get(deanA, '/analytics/summary');
    expect(body.scope).toEqual({ kind: 'departments', department_ids: [dept.a] });
    expect(body.current).toMatchObject({ created: 4, completed: 2, overdue: 1 });
    const { tree } = await get(deanA, '/analytics/by-department');
    expect(tree.map((n: Node) => n.id)).toEqual([dept.a]);
  });

  it('a head cannot look at another department', async () => {
    await get(deanA, `/analytics/summary?department=${dept.b}`, 403);
    await get(deanA, `/reports/discipline.pdf?department=${dept.b}`, 403);
    expect(await summary(deanA, `?department=${dept.a1}`)).toMatchObject({ created: 3 });
  });

  it('a chair head sees only the chair', async () => {
    expect(await summary(chair)).toMatchObject({ created: 3, completed: 2, overdue: 0 });
  });

  it('an employee sees only their own work', async () => {
    const body = await get(worker, '/analytics/summary');
    expect(body.scope.kind).toBe('self');
    expect(body.current).toMatchObject({ created: 1, completed: 1, late: 1, discipline: 0 });
    const people = (await get(worker, '/analytics/by-assignee')).items;
    expect(people.map((p: { user: { id: string } }) => p.user.id)).toEqual([worker.id]);
    const { tree } = await get(worker, '/analytics/by-department');
    expect(JSON.stringify(tree)).not.toContain(dept.b);
  });
});

describe('analytics — cache is dropped by a write (10.B6)', () => {
  it('closing an overdue issue changes the numbers immediately', async () => {
    expect(await summary(rector)).toMatchObject({ overdue: 2 });
    expect((await as(rector).patch(issueUrl(issue.a), { state_id: states.completed })).status).toBe(
      200,
    );
    expect(await summary(rector)).toMatchObject({ overdue: 1, completed: 3, late: 2 });
  });
});

describe('reports (10.B4)', () => {
  it('реестр поручений: XLSX with a frozen header, autofilter and every row', async () => {
    const res = await as(rector)
      .get(api('/reports/assignments.xlsx'))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain("filename*=UTF-8''");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as Buffer);
    const sheet = wb.getWorksheet('Реестр')!;
    const text = JSON.stringify(sheet.getSheetValues());
    for (const title of ['Отчёт факультета Б', 'Справка кафедры', 'Перенос срока'])
      expect(text).toContain(title);
    expect(text).toContain('Исполнено с опозданием');
    expect(text).toContain('Просрочено на');
    expect(sheet.views[0]).toMatchObject({ state: 'frozen' });
    expect(sheet.autoFilter).toBeTruthy();
    expect(wb.getWorksheet('Сводка')).toBeTruthy();
  });

  it('справка: a PDF; an export is written to the activity log', async () => {
    const res = await as(rector).get(api('/reports/discipline.pdf')).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(String(res.body.subarray(0, 5))).toBe('%PDF-');
    const logged = await app.prisma.activityLog.findMany({
      where: { workspace: { slug: SLUG }, action: 'report.exported' },
    });
    expect(logged.map((l) => l.field)).toContain('discipline.pdf');
  });

  it('project report: PDF for a visible project, 404 for a hidden private one', async () => {
    const res = await as(deanA)
      .get(api(`/projects/${projectId}/report.pdf`))
      .buffer(true);
    expect(res.status).toBe(200);
    expect(String(res.body.subarray(0, 5))).toBe('%PDF-');
    await get(deanA, `/projects/${privateProjectId}/report.pdf`, 404);
  });
});
