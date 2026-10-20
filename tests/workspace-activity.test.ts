// Integration tests for the workspace activity feed (Ф7 7.B3): an admin sees
// every project they can open, a department head — the work of their department
// with its sub-departments, anyone else gets 403. Filters (type, project,
// department, actor, period), names for ids, rows about trashed tasks, paging,
// and the `heads_department` flag of «my summary».
//
// Runs against a live Postgres; everything is removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `feed-${TS}`;
const emails = {
  rector: `feed-rector-${TS}@example.com`,
  dean: `feed-dean-${TS}@example.com`,
  clerk: `feed-clerk-${TS}@example.com`,
  other: `feed-other-${TS}@example.com`,
  guest: `feed-guest-${TS}@example.com`,
};

type Actor = { id: string; token: string };
type Item = {
  id: string;
  action: string;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  old_label: string | null;
  new_label: string | null;
  created_at: string;
  actor: { id: string; display_name: string };
  issue: {
    id: string;
    title: string;
    deleted_at: string | null;
    project: { id: string; identifier: string };
  };
};

let app: FastifyInstance;
let rector: Actor;
let dean: Actor;
let clerk: Actor;
let other: Actor;
let guest: Actor;
let projectId: string;
let privateId: string;
const dept: Record<string, string> = {};
const issue: Record<string, string> = {};
let todo: string;
let started: string;

const api = (path: string) => `/api/v1/workspaces/${SLUG}${path}`;

async function register(email: string, name: string): Promise<Actor> {
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, display_name: name });
  expect(res.status).toBe(201);
  return { id: res.body.user.id, token: res.body.access_token };
}

function as(actor: Actor) {
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${actor.token}`);
  return {
    get: (url: string) => auth(request(app.server).get(url)),
    post: (url: string, body?: object) => auth(request(app.server).post(url)).send(body ?? {}),
    patch: (url: string, body?: object) => auth(request(app.server).patch(url)).send(body ?? {}),
    delete: (url: string) => auth(request(app.server).delete(url)),
  };
}

async function feed(
  actor: Actor,
  query = '',
): Promise<{ data: Item[]; next_cursor: string | null }> {
  const res = await as(actor).get(api(`/activity?limit=100${query}`));
  expect(res.status).toBe(200);
  return res.body;
}

async function create(title: string, assignee: Actor, project = projectId): Promise<string> {
  const states = await as(rector).get(api(`/projects/${project}/states`));
  const state = states.body.find((s: { group: string }) => s.group === 'unstarted').id;
  const res = await as(rector).post(api(`/projects/${project}/issues`), {
    title,
    state_id: state,
    assignee_ids: [assignee.id],
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  rector = await register(emails.rector, 'Ректоров Рустам Рашидович');
  dean = await register(emails.dean, 'Деканова Дилноза Давлатовна');
  clerk = await register(emails.clerk, 'Кафедрин Камол Каримович');
  other = await register(emails.other, 'Прочий Пулод Пирович');
  guest = await register(emails.guest, 'Гостев Гафур Гулович');

  await as(rector).post('/api/v1/workspaces', { name: 'Университет', slug: SLUG });
  for (const u of [dean, clerk, other])
    await as(rector).post(api('/members'), { user_id: u.id, role: 'member' });
  await as(rector).post(api('/members'), { user_id: guest.id, role: 'guest' });

  const mk = async (name: string, parent?: string, head?: Actor) => {
    const res = await as(rector).post(api('/departments'), {
      name,
      parent_id: parent,
      head_id: head?.id,
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };
  dept.faculty = await mk('Факультет экономики', undefined, dean);
  dept.chair = await mk('Кафедра финансов', dept.faculty);
  dept.other = await mk('Отдел кадров');
  await as(rector).patch(api(`/members/${dean.id}`), { department_id: dept.faculty });
  await as(rector).patch(api(`/members/${clerk.id}`), { department_id: dept.chair });
  await as(rector).patch(api(`/members/${other.id}`), { department_id: dept.other });

  projectId = (await as(rector).post(api('/projects'), { name: 'Аккредитация', identifier: 'FED' }))
    .body.id;
  privateId = (
    await as(rector).post(api('/projects'), {
      name: 'Личный кабинет ректора',
      identifier: 'FEP',
      visibility: 'private',
      member_ids: [clerk.id],
    })
  ).body.id;
  const st = await as(rector).get(api(`/projects/${projectId}/states`));
  todo = st.body.find((s: { group: string }) => s.group === 'unstarted').id;
  started = st.body.find((s: { group: string }) => s.group === 'started').id;

  // The chair's work (faculty subtree), other department's work, a private task, a deleted one.
  issue.chair = await create('Отчёт кафедры о публикациях', clerk);
  issue.other = await create('Приказы о приёме на работу', other);
  issue.secret = await create('Подготовить доклад ректора', clerk, privateId);
  issue.trashed = await create('Черновик плана кафедры', clerk);

  expect(
    (
      await as(clerk).patch(api(`/projects/${projectId}/issues/${issue.chair}`), {
        state_id: started,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await as(rector).post(api(`/projects/${projectId}/issues/${issue.other}/assignees`), {
        user_id: clerk.id,
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await as(other).post(api(`/projects/${projectId}/issues/${issue.other}/comments`), {
        body: 'Приказы подписаны',
      })
    ).status,
  ).toBe(201);
  expect(
    (await as(rector).delete(api(`/projects/${projectId}/issues/${issue.trashed}`))).status,
  ).toBe(204);
});

afterAll(async () => {
  const ws = await app.prisma.workspace.findUnique({ where: { slug: SLUG } });
  if (ws) await app.prisma.workspace.delete({ where: { id: ws.id } });
  await app.prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
  await app.close();
});

describe('GET WS/activity — who sees the feed', () => {
  it('an admin sees every project, newest first, with names for ids', async () => {
    const { data } = await feed(rector);
    const issues = new Set(data.map((r) => r.issue.id));
    for (const id of Object.values(issue)) expect(issues.has(id)).toBe(true);

    const times = data.map((r) => r.created_at);
    expect([...times].sort().reverse()).toEqual(times);

    const moved = data.find((r) => r.issue.id === issue.chair && r.field === 'state_id')!;
    expect(moved.actor.id).toBe(clerk.id);
    expect(moved.old_value).toBe(todo);
    expect(moved.new_label).toBe(
      (await as(rector).get(api(`/projects/${projectId}/states`))).body.find(
        (s: { id: string }) => s.id === started,
      ).name,
    );
    const assigned = data.find(
      (r) => r.issue.id === issue.other && r.action === 'issue.assignee_added',
    )!;
    expect(assigned.new_value).toBe(clerk.id);
    expect(assigned.new_label).toBe('Кафедрин Камол Каримович');
  });

  it('a department head sees their department with sub-departments, not others or hidden projects', async () => {
    const { data } = await feed(dean);
    const issues = new Set(data.map((r) => r.issue.id));
    expect(issues.has(issue.chair!)).toBe(true);
    expect(issues.has(issue.trashed!)).toBe(true);
    expect(issues.has(issue.other!)).toBe(false);
    expect(issues.has(issue.secret!)).toBe(false);
    // Asking for a department outside the subtree finds nothing.
    expect((await feed(dean, `&department=${dept.other}`)).data).toHaveLength(0);
  });

  it('a member who heads nothing and a guest get 403 ACTIVITY_FORBIDDEN', async () => {
    for (const actor of [clerk, guest]) {
      const res = await as(actor).get(api('/activity'));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ACTIVITY_FORBIDDEN');
    }
  });

  it('«my summary» tells the client who heads a department', async () => {
    const mine = async (a: Actor) => (await as(a).get(api('/me/summary'))).body.heads_department;
    expect(await mine(dean)).toBe(true);
    expect(await mine(clerk)).toBe(false);
  });
});

describe('GET WS/activity — filters and paging', () => {
  it('type narrows to kinds of events; several types are any of them', async () => {
    const state = (await feed(rector, '&type=state')).data;
    expect(state.length).toBeGreaterThan(0);
    expect(state.every((r) => r.action === 'issue.updated' && r.field === 'state_id')).toBe(true);

    const mixed = (await feed(rector, '&type=comments&type=trash')).data;
    expect(new Set(mixed.map((r) => r.action))).toEqual(
      new Set(['comment.created', 'issue.deleted']),
    );
    expect((await as(rector).get(api('/activity?type=gossip'))).status).toBe(400);
  });

  it('a row about a trashed task stays, marked deleted', async () => {
    const trash = (await feed(rector, '&type=trash')).data;
    const row = trash.find((r) => r.issue.id === issue.trashed)!;
    expect(row.action).toBe('issue.deleted');
    expect(row.actor.id).toBe(rector.id);
    expect(row.issue.deleted_at).not.toBeNull();
  });

  it('project, department, actor and period combine with AND', async () => {
    const inPrivate = (await feed(rector, `&project=${privateId}`)).data;
    expect(inPrivate.length).toBeGreaterThan(0);
    expect(inPrivate.every((r) => r.issue.project.id === privateId)).toBe(true);

    const hr = (await feed(rector, `&department=${dept.other}`)).data;
    expect(new Set(hr.map((r) => r.issue.id))).toEqual(new Set([issue.other]));

    const byOther = (await feed(rector, `&actor=${other.id}`)).data;
    expect(byOther.length).toBeGreaterThan(0);
    expect(byOther.every((r) => r.actor.id === other.id)).toBe(true);

    const today = new Date().toISOString().slice(0, 10);
    const longAgo = '2020-01-01';
    expect((await feed(rector, `&from=${longAgo}&to=2020-12-31`)).data).toHaveLength(0);
    // The workspace zone (UTC by default here) makes «today» today.
    expect((await feed(rector, `&from=${longAgo}&to=${today}`)).data.length).toBeGreaterThan(0);
    expect((await as(rector).get(api(`/activity?from=${today}&to=${longAgo}`))).status).toBe(400);
  });

  it('pages with next_cursor without repeats', async () => {
    const all = (await feed(rector)).data.map((r) => r.id);
    const first = await as(rector).get(api('/activity?limit=2'));
    expect(first.body.data).toHaveLength(2);
    expect(first.body.next_cursor).toBeTruthy();
    const second = await as(rector).get(api(`/activity?limit=2&cursor=${first.body.next_cursor}`));
    const ids = [...first.body.data, ...second.body.data].map((r: Item) => r.id);
    expect(ids).toEqual(all.slice(0, 4));
  });
});
