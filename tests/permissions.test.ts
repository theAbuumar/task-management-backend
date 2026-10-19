// Integration tests for the role matrix (Ф12 12.B4, docs/PERMISSIONS.md): the
// guest role is read-only in every module — writes answer 403 GUEST_READ_ONLY,
// reads work, personal actions (own inbox, following a task, leaving) stay
// allowed — and a guest cannot be made an assignee or a controller.
//
// Runs against a live Postgres. All created rows are removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `perm-${TS}`;
const emails = {
  owner: `perm-owner-${TS}@example.com`,
  member: `perm-member-${TS}@example.com`,
  guest: `perm-guest-${TS}@example.com`,
};

type Actor = { id: string; token: string };
let app: FastifyInstance;
let owner: Actor;
let member: Actor;
let guest: Actor;
const ids: Record<string, string> = {};

const api = (path: string) => `/api/v1/workspaces/${SLUG}${path}`;
const p = (path = '') => api(`/projects/${ids.project}${path}`);
const i = (path = '') => p(`/issues/${ids.issue}${path}`);

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
    delete: (url: string) => auth(request(app.server).delete(url)),
  };
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  owner = await register(emails.owner);
  member = await register(emails.member);
  guest = await register(emails.guest);

  await as(owner).post('/api/v1/workspaces', { name: 'Права', slug: SLUG });
  await as(owner).post(api('/members'), { user_id: member.id, role: 'member' });
  await as(owner).post(api('/members'), { user_id: guest.id, role: 'guest' });

  const dept = await as(owner).post(api('/departments'), { name: 'Кафедра', head_id: owner.id });
  ids.department = dept.body.id;
  const project = await as(owner).post(api('/projects'), {
    name: 'Аккредитация',
    identifier: 'PRM',
    member_ids: [member.id, guest.id],
  });
  ids.project = project.body.id;
  const states = await as(owner).get(p('/states'));
  ids.state = states.body.find((s: { group: string }) => s.group === 'unstarted').id;
  const issue = await as(owner).post(p('/issues'), {
    title: 'Отчёт кафедры',
    state_id: ids.state,
    kind: 'assignment',
    controller_id: owner.id,
    assignee_ids: [member.id],
  });
  ids.issue = issue.body.id;
  const comment = await as(owner).post(i('/comments'), { body: 'Срок — пятница' });
  ids.comment = comment.body.id;
  const label = await as(owner).post(p('/labels'), { name: 'Срочно', color: '#ef4444' });
  ids.label = label.body.id;
});

afterAll(async () => {
  const list = Object.values(emails);
  await app.prisma.workspace.deleteMany({ where: { slug: SLUG } });
  await app.prisma.refreshToken.deleteMany({ where: { user: { email: { in: list } } } });
  await app.prisma.user.deleteMany({ where: { email: { in: list } } });
  await app.close();
});

// Every module's writes, as a guest would try them. Bodies are valid, so a 403
// can only come from the role check, not from validation.
const GUEST_WRITES: [string, (g: ReturnType<typeof as>) => request.Test][] = [
  ['create a project', (g) => g.post(api('/projects'), { name: 'X', identifier: 'GX' })],
  ['edit a project', (g) => g.patch(p(), { name: 'Переименован' })],
  ['create a task', (g) => g.post(p('/issues'), { title: 'Задача', state_id: ids.state })],
  ['edit a task', (g) => g.patch(i(), { title: 'Изменено' })],
  ['delete a task', (g) => g.delete(i())],
  ['add an assignee', (g) => g.post(i('/assignees'), { user_id: member.id })],
  ['attach a label', (g) => g.post(i('/labels'), { label_id: ids.label })],
  ['comment', (g) => g.post(i('/comments'), { body: 'Гость пишет' })],
  ['edit a comment', (g) => g.patch(i(`/comments/${ids.comment}`), { body: 'Правка' })],
  [
    'register an attachment',
    (g) => g.post(i('/attachments'), { file_name: 'a.txt', file_size: 1, mime_type: 'text/plain' }),
  ],
  ['hand in for review', (g) => g.post(i('/review/submit'), { report: 'Готово' })],
  [
    'request a deadline change',
    (g) =>
      g.post(i('/deadline-requests'), {
        new_due_date: new Date().toISOString(),
        reason: 'Нужно время',
      }),
  ],
  ['restore from the trash', (g) => g.post(api(`/trash/issue/${ids.issue}/restore`))],
  ['delete from the trash for good', (g) => g.delete(api(`/trash/issue/${ids.issue}`))],
  [
    'distribute to departments',
    (g) =>
      g.post(p('/issues/distribute'), {
        title: 'Рассылка',
        state_id: ids.state,
        department_ids: [ids.department],
      }),
  ],
];

describe('guest is read-only', () => {
  it.each(GUEST_WRITES)('guest cannot %s', async (_name, send) => {
    const res = await send(as(guest));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('GUEST_READ_ONLY');
  });

  it('guest reads projects, tasks, comments, attachments, activity, analytics and their counters', async () => {
    for (const url of [
      api('/projects'),
      p('/issues'),
      i(),
      i('/comments'),
      i('/attachments'),
      i('/activity'),
      api('/me/summary'),
      api('/analytics/summary'),
      api('/members'),
      api('/trash'),
    ]) {
      const res = await as(guest).get(url);
      expect(res.status, url).toBe(200);
    }
  });

  it('guest still manages their own inbox and follows a task', async () => {
    expect((await as(guest).post(api('/notifications/read-all'))).status).toBe(200);
    expect((await as(guest).post(i('/watchers'))).status).toBe(200);
    expect((await as(guest).delete(i('/watchers/me'))).status).toBe(200);
  });

  it('a member keeps write access (the check targets guests only)', async () => {
    const res = await as(member).post(i('/comments'), { body: 'Участник пишет' });
    expect(res.status).toBe(201);
  });

  it('promoting the guest to member lifts the restriction', async () => {
    await as(owner).patch(api(`/members/${guest.id}`), { role: 'member' });
    const res = await as(guest).post(i('/comments'), { body: 'Теперь можно' });
    expect(res.status).toBe(201);
    await as(owner).patch(api(`/members/${guest.id}`), { role: 'guest' });
  });

  it('a guest can leave the workspace', async () => {
    // Run last: afterwards the guest is no longer a member.
    const res = await as(guest).post(api('/leave'));
    expect(res.status).toBe(204);
    await as(owner).post(api('/members'), { user_id: guest.id, role: 'guest' });
  });
});

describe('a guest cannot be assigned', () => {
  it('not as an assignee or a controller of a new task', async () => {
    const asAssignee = await as(owner).post(p('/issues'), {
      title: 'Гостю',
      state_id: ids.state,
      assignee_ids: [guest.id],
    });
    expect(asAssignee.status).toBe(400);
    expect(asAssignee.body.error.code).toBe('GUEST_NOT_ASSIGNABLE');

    const asController = await as(owner).post(p('/issues'), {
      title: 'Под контролем гостя',
      state_id: ids.state,
      kind: 'assignment',
      controller_id: guest.id,
      assignee_ids: [member.id],
    });
    expect(asController.status).toBe(400);
    expect(asController.body.error.code).toBe('GUEST_NOT_ASSIGNABLE');
  });

  it('not added later or set as controller of an existing task', async () => {
    const add = await as(owner).post(i('/assignees'), { user_id: guest.id });
    expect(add.status).toBe(400);
    expect(add.body.error.code).toBe('GUEST_NOT_ASSIGNABLE');

    const ctl = await as(owner).patch(i(), { controller_id: guest.id });
    expect(ctl.status).toBe(400);
    expect(ctl.body.error.code).toBe('GUEST_NOT_ASSIGNABLE');
  });

  it('a non-member assignee is rejected too', async () => {
    const outsider = await register(`perm-outsider-${TS}@example.com`);
    const res = await as(owner).post(p('/issues'), {
      title: 'Постороннему',
      state_id: ids.state,
      assignee_ids: [outsider.id],
    });
    expect(res.status).toBe(400);
    await app.prisma.user.delete({ where: { id: outsider.id } });
  });

  it('distribution refuses a department whose head is a guest', async () => {
    const dept = await as(owner).post(api('/departments'), {
      name: 'Гостевой отдел',
      head_id: guest.id,
    });
    expect(dept.status).toBe(201);
    const res = await as(owner).post(p('/issues/distribute'), {
      title: 'Рассылка',
      state_id: ids.state,
      department_ids: [dept.body.id],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('GUEST_NOT_ASSIGNABLE');
  });
});
