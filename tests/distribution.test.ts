// Integration tests for «Разослать подразделениям» (Ф6 6.B1, 6.B2):
// POST /projects/:projectId/issues/distribute creates a parent assignment and one
// child per department (head = primary assignee, controller and deadline
// inherited) in one transaction; GET of the parent carries the per-department
// progress and offers closing once every child is done.
//
// Runs against a live Postgres. All created rows are removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `dst-${TS}`;
const DAY = 24 * 60 * 60 * 1000;
const emails = {
  rector: `dst-rector-${TS}@example.com`,
  econ: `dst-econ-${TS}@example.com`,
  law: `dst-law-${TS}@example.com`,
  it: `dst-it-${TS}@example.com`,
};

type Actor = { id: string; token: string };
type Item = {
  issue_id: string;
  title: string;
  department: { id: string; name: string };
  assignee: { id: string };
  state: { group: string };
  overdue: boolean;
};

let app: FastifyInstance;
let rector: Actor;
let econ: Actor;
let law: Actor;
let it_: Actor;
let projectId: string;
let privateProjectId: string;
const dept: Record<string, string> = {};
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

const distribute = (body: object, project = projectId) =>
  as(rector).post(api(`/projects/${project}/issues/distribute`), body);

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  rector = await register(emails.rector);
  econ = await register(emails.econ);
  law = await register(emails.law);
  it_ = await register(emails.it);

  await as(rector).post('/api/v1/workspaces', {
    name: 'Рассылка',
    slug: SLUG,
    timezone: 'Asia/Tashkent',
  });
  for (const u of [econ, law, it_])
    await as(rector).post(api('/members'), { user_id: u.id, role: 'member' });

  const mk = async (name: string, short: string, head?: Actor) => {
    const res = await as(rector).post(api('/departments'), {
      name,
      short_name: short,
      head_id: head?.id,
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };
  dept.econ = await mk('Экономический факультет', 'ЭФ', econ);
  dept.law = await mk('Юридический факультет', 'ЮФ', law);
  dept.it = await mk('IT-центр', 'ИТЦ', it_);
  dept.headless = await mk('Библиотека', 'Библ.');

  const project = await as(rector).post(api('/projects'), {
    name: 'Аккредитация',
    identifier: 'DST',
  });
  projectId = project.body.id;
  const priv = await as(rector).post(api('/projects'), {
    name: 'Закрытый',
    identifier: 'DSP',
    visibility: 'private',
  });
  privateProjectId = priv.body.id;
  const st = await as(rector).get(api(`/projects/${projectId}/states`));
  states = Object.fromEntries(st.body.map((s: { group: string; id: string }) => [s.group, s.id]));
});

afterAll(async () => {
  const list = Object.values(emails);
  await app.prisma.workspace.deleteMany({ where: { slug: SLUG } });
  await app.prisma.refreshToken.deleteMany({ where: { user: { email: { in: list } } } });
  await app.prisma.user.deleteMany({ where: { email: { in: list } } });
  await app.close();
});

describe('POST /issues/distribute', () => {
  let parentId: string;

  it('creates a parent and one child per department, the head as the primary assignee', async () => {
    const res = await distribute({
      title: 'Отчёт о самообследовании',
      basis: 'Приказ ректора №12',
      priority: 'high',
      due_date: dueIn(-2),
      controller_id: rector.id,
      department_ids: [dept.econ, dept.law, dept.it],
    });
    expect(res.status).toBe(201);
    parentId = res.body.id;
    expect(res.body).toMatchObject({
      is_distribution: true,
      kind: 'assignment',
      requires_review: true,
    });
    expect(res.body.assignees).toHaveLength(0);

    const progress = res.body.distribution;
    expect(progress).toMatchObject({
      total: 3,
      completed: 0,
      open: 3,
      overdue: 3,
      ready_to_close: false,
    });
    const byDept = Object.fromEntries((progress.items as Item[]).map((i) => [i.department.id, i]));
    expect(byDept[dept.econ]!.assignee.id).toBe(econ.id);
    expect(byDept[dept.law]!.title).toBe('Отчёт о самообследовании — ЮФ');

    const child = await app.prisma.issue.findUniqueOrThrow({
      where: { id: byDept[dept.it]!.issue_id },
      include: { assignees: true },
    });
    expect(child).toMatchObject({
      parent_id: parentId,
      department_id: dept.it,
      kind: 'assignment',
      controller_id: rector.id,
      requires_review: true,
      priority: 'high',
      basis: 'Приказ ректора №12',
      is_distribution: false,
    });
    expect(child.due_date?.toISOString()).toBe(res.body.due_date);
    expect(child.assignees).toEqual([
      expect.objectContaining({ user_id: it_.id, is_primary: true }),
    ]);

    // Each head is notified about their own task.
    const inbox = await as(law).get(api('/notifications'));
    expect(
      inbox.body.data.some(
        (n: { type: string; issue_id: string }) =>
          n.type === 'issue_assigned' && n.issue_id === byDept[dept.law]!.issue_id,
      ),
    ).toBe(true);
  });

  it('a department without a head fails the whole distribution', async () => {
    const before = await app.prisma.issue.count({ where: { project_id: projectId } });
    const res = await distribute({
      title: 'Не создастся',
      department_ids: [dept.econ, dept.headless],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DEPARTMENT_HAS_NO_HEAD');
    expect(res.body.error.details.departments).toEqual([{ id: dept.headless, name: 'Библиотека' }]);
    expect(await app.prisma.issue.count({ where: { project_id: projectId } })).toBe(before);
  });

  it('rejects departments of another workspace and an empty list', async () => {
    expect((await distribute({ title: 'x', department_ids: [crypto.randomUUID()] })).status).toBe(
      400,
    );
    expect((await distribute({ title: 'x', department_ids: [] })).status).toBe(400);
  });

  it('progress follows the children and offers closing when all are done', async () => {
    const parent = await as(rector).get(api(`/projects/${projectId}/issues/${parentId}`));
    const items = parent.body.distribution.items as Item[];
    const [first, second, third] = items;

    // A head hands in their work; the controller sees it "на проверке".
    const head =
      items[0]!.assignee.id === econ.id ? econ : items[0]!.assignee.id === law.id ? law : it_;
    const submit = await as(head).post(
      api(`/projects/${projectId}/issues/${first!.issue_id}/review/submit`),
      {
        report: 'Готово',
      },
    );
    expect(submit.status).toBe(200);
    let progress = (await as(rector).get(api(`/projects/${projectId}/issues/${parentId}`))).body
      .distribution;
    // Work under review is still open, so still overdue.
    expect(progress).toMatchObject({ review: 1, open: 3, overdue: 3 });

    await as(rector).post(
      api(`/projects/${projectId}/issues/${first!.issue_id}/review/approve`),
      {},
    );
    for (const i of [second!, third!]) {
      await as(rector).patch(api(`/projects/${projectId}/issues/${i.issue_id}`), {
        state_id: states.completed,
      });
    }
    progress = (await as(rector).get(api(`/projects/${projectId}/issues/${parentId}`))).body
      .distribution;
    expect(progress).toMatchObject({
      total: 3,
      completed: 3,
      open: 0,
      overdue: 0,
      ready_to_close: true,
    });
    expect(progress.items.every((i: { completed_late: boolean }) => i.completed_late)).toBe(true);

    await as(rector).patch(api(`/projects/${projectId}/issues/${parentId}`), {
      state_id: states.completed,
    });
    progress = (await as(rector).get(api(`/projects/${projectId}/issues/${parentId}`))).body
      .distribution;
    expect(progress.ready_to_close).toBe(false);
  });

  it('children are found by department in the workspace list', async () => {
    const res = await as(rector).get(api(`/issues?department=${dept.law}`));
    expect(res.body.data.map((i: { title: string }) => i.title)).toEqual([
      'Отчёт о самообследовании — ЮФ',
    ]);
  });

  it('in a private project the heads become project members', async () => {
    const res = await distribute(
      { title: 'Закрытая рассылка', department_ids: [dept.econ] },
      privateProjectId,
    );
    expect(res.status).toBe(201);
    const mine = await as(econ).get(api('/issues?assignee=me'));
    expect(mine.body.data.map((i: { title: string }) => i.title)).toContain(
      'Закрытая рассылка — ЭФ',
    );
  });
});
