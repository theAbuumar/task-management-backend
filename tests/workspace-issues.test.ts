// Integration tests for GET /workspaces/:slug/issues (Ф7 7.B1): one list across
// every visible project with the project filters plus `project[]` and
// `department[]` (a department includes its sub-departments), the `reviewer`,
// `state_group` and `completed_*` filters, and cursor pagination. Private
// projects stay hidden from members who are not in them.
//
// Runs against a live Postgres. All created rows are removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `wsi-${TS}`;
const DAY = 24 * 60 * 60 * 1000;
const emails = {
  rector: `wsi-rector-${TS}@example.com`,
  dean: `wsi-dean-${TS}@example.com`,
  chair: `wsi-chair-${TS}@example.com`,
  outsider: `wsi-outsider-${TS}@example.com`,
};

type Actor = { id: string; token: string };
type Row = {
  id: string;
  title: string;
  project: { id: string; identifier: string; name: string };
  state: { group: string };
};

let app: FastifyInstance;
let rector: Actor; // owner
let dean: Actor; // member, Экономический факультет
let chair: Actor; // member, кафедра финансов (child of the faculty)
let outsider: Actor;
let publicProject: string;
let privateProject: string;
let facultyId: string;
let chairId: string;
const states: Record<string, Record<string, string>> = {};

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

async function list(actor: Actor, query = ''): Promise<Row[]> {
  const res = await as(actor).get(api(`/issues?limit=100${query}`));
  expect(res.status).toBe(200);
  return res.body.data;
}

const titles = (rows: Row[]) => rows.map((r) => r.title).sort();

async function issue(project: string, title: string, extra: object = {}): Promise<string> {
  const res = await as(rector).post(api(`/projects/${project}/issues`), {
    title,
    state_id: states[project]!.unstarted,
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  rector = await register(emails.rector);
  dean = await register(emails.dean);
  chair = await register(emails.chair);
  outsider = await register(emails.outsider);

  await as(rector).post('/api/v1/workspaces', {
    name: 'Университет',
    slug: SLUG,
    timezone: 'Asia/Tashkent',
  });
  await as(rector).post(api('/members'), { user_id: dean.id, role: 'member' });
  await as(rector).post(api('/members'), { user_id: chair.id, role: 'member' });

  const faculty = await as(rector).post(api('/departments'), {
    name: 'Экономический факультет',
    head_id: dean.id,
  });
  facultyId = faculty.body.id;
  const sub = await as(rector).post(api('/departments'), {
    name: 'Кафедра финансов',
    parent_id: facultyId,
    head_id: chair.id,
  });
  chairId = sub.body.id;
  await as(rector).patch(api(`/members/${dean.id}`), { department_id: facultyId });
  await as(rector).patch(api(`/members/${chair.id}`), { department_id: chairId });

  const pub = await as(rector).post(api('/projects'), {
    name: 'Аккредитация',
    identifier: 'WSA',
    member_ids: [dean.id, chair.id],
  });
  publicProject = pub.body.id;
  const priv = await as(rector).post(api('/projects'), {
    name: 'Бюджет',
    identifier: 'WSB',
    visibility: 'private',
    member_ids: [dean.id],
  });
  privateProject = priv.body.id;
  for (const p of [publicProject, privateProject]) {
    const st = await as(rector).get(api(`/projects/${p}/states`));
    states[p] = Object.fromEntries(
      st.body.map((s: { group: string; id: string }) => [s.group, s.id]),
    );
  }

  await issue(publicProject, 'Отчёт декана', { assignee_ids: [dean.id], due_date: dueIn(-2) });
  await issue(publicProject, 'Отчёт кафедры', { assignee_ids: [chair.id], due_date: dueIn(3) });
  await issue(publicProject, 'Поручение под контролем декана', {
    kind: 'assignment',
    controller_id: dean.id,
    assignee_ids: [chair.id],
  });
  await issue(privateProject, 'Смета факультета', { assignee_ids: [dean.id] });
  const done = await issue(publicProject, 'Закрытая задача', { assignee_ids: [chair.id] });
  await as(rector).patch(api(`/projects/${publicProject}/issues/${done}`), {
    state_id: states[publicProject]!.completed,
  });
});

afterAll(async () => {
  const list = Object.values(emails);
  await app.prisma.workspace.deleteMany({ where: { slug: SLUG } });
  await app.prisma.refreshToken.deleteMany({ where: { user: { email: { in: list } } } });
  await app.prisma.user.deleteMany({ where: { email: { in: list } } });
  await app.close();
});

describe('GET /workspaces/:slug/issues', () => {
  it('requires workspace membership', async () => {
    const res = await as(outsider).get(api('/issues'));
    expect(res.status).toBe(403);
  });

  it('lists issues of every visible project with a project brief', async () => {
    const rows = await list(rector);
    expect(rows).toHaveLength(5);
    const row = rows.find((r) => r.title === 'Смета факультета')!;
    expect(row.project).toMatchObject({ id: privateProject, identifier: 'WSB', name: 'Бюджет' });
    expect(row.state.group).toBe('unstarted');
  });

  it('hides private projects from members who are not in them', async () => {
    expect(titles(await list(chair))).not.toContain('Смета факультета');
    expect(titles(await list(dean))).toContain('Смета факультета');
  });

  it('filters by project (one or many)', async () => {
    expect(await list(rector, `&project=${privateProject}`)).toHaveLength(1);
    expect(await list(rector, `&project=${privateProject}&project=${publicProject}`)).toHaveLength(
      5,
    );
  });

  it('filters by department including sub-departments (by the primary assignee)', async () => {
    expect(titles(await list(rector, `&department=${chairId}`))).toEqual([
      'Закрытая задача',
      'Отчёт кафедры',
      'Поручение под контролем декана',
    ]);
    // The faculty includes its chair.
    expect(await list(rector, `&department=${facultyId}`)).toHaveLength(5);
  });

  it('a department-addressed issue belongs to that department whoever executes it', async () => {
    const id = await issue(publicProject, 'Адресовано кафедре', { assignee_ids: [dean.id] });
    await app.prisma.issue.update({ where: { id }, data: { department_id: chairId } });
    expect(titles(await list(rector, `&department=${chairId}`))).toContain('Адресовано кафедре');
    await app.prisma.issue.update({ where: { id }, data: { deleted_at: new Date() } });
  });

  it('assignee=me, overdue, reviewer, state_group and completed_after', async () => {
    expect(titles(await list(dean, '&assignee=me'))).toEqual(['Отчёт декана', 'Смета факультета']);
    expect(titles(await list(rector, '&overdue=true'))).toEqual(['Отчёт декана']);
    // The dean decides on the assignment they control; the rector on everything they authored without a controller.
    expect(titles(await list(dean, '&reviewer=me'))).toEqual(['Поручение под контролем декана']);
    expect(await list(rector, '&reviewer=me')).toHaveLength(4);
    expect(titles(await list(rector, '&state_group=completed'))).toEqual(['Закрытая задача']);
    expect(await list(rector, '&state_group=completed&state_group=unstarted')).toHaveLength(5);
    const since = new Date(Date.now() - DAY).toISOString();
    expect(titles(await list(rector, `&completed_after=${since}`))).toEqual(['Закрытая задача']);
  });

  it('paginates with a cursor', async () => {
    const first = await as(rector).get(api('/issues?limit=2&sort_by=created_at&order=asc'));
    expect(first.body.data).toHaveLength(2);
    expect(first.body.next_cursor).toBeTruthy();
    const seen = new Set<string>(first.body.data.map((r: Row) => r.id));
    let cursor = first.body.next_cursor;
    while (cursor) {
      const page = await as(rector).get(
        api(`/issues?limit=2&sort_by=created_at&order=asc&cursor=${cursor}`),
      );
      for (const r of page.body.data as Row[]) seen.add(r.id);
      cursor = page.body.next_cursor;
    }
    expect(seen.size).toBe(5);
  });

  it('rejects an unknown state group', async () => {
    const res = await as(rector).get(api('/issues?state_group=nope'));
    expect(res.status).toBe(400);
  });
});
