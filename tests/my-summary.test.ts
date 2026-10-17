// Integration tests for GET /workspaces/:slug/me/summary (Ф5 5.F6): the
// sidebar / «Мои задачи» counters follow the assignment, deadline, review and
// acknowledgement rules, and never count issues from private projects the
// caller cannot see.
//
// Runs against a live Postgres. All created rows are removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `sum-${TS}`;
const DAY = 24 * 60 * 60 * 1000;
const emails = {
  rector: `sum-rector-${TS}@example.com`,
  dean: `sum-dean-${TS}@example.com`,
  outsider: `sum-outsider-${TS}@example.com`,
};

type Actor = { id: string; token: string };
type Summary = Record<
  | 'assigned'
  | 'overdue'
  | 'due_today'
  | 'unacknowledged'
  | 'control'
  | 'control_overdue'
  | 'review_pending'
  | 'watching'
  | 'unread_notifications',
  number
>;

let app: FastifyInstance;
let rector: Actor; // owner, controller
let dean: Actor; // member, assignee
let outsider: Actor; // not a member of the workspace
let projectId: string;
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

async function summary(actor: Actor): Promise<Summary> {
  const res = await as(actor).get(api('/me/summary'));
  expect(res.status).toBe(200);
  return res.body;
}

async function createAssignment(project: string, extra: object = {}): Promise<{ id: string }> {
  const res = await as(rector).post(api(`/projects/${project}/issues`), {
    title: 'Сводный отчёт кафедры',
    state_id: states.unstarted,
    kind: 'assignment',
    controller_id: rector.id,
    assignee_ids: [dean.id],
    due_date: dueIn(10),
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body;
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  rector = await register(emails.rector);
  dean = await register(emails.dean);
  outsider = await register(emails.outsider);

  await as(rector).post('/api/v1/workspaces', {
    name: 'Сводка',
    slug: SLUG,
    timezone: 'Asia/Tashkent',
  });
  await as(rector).post(api('/members'), { user_id: dean.id, role: 'member' });
  const project = await as(rector).post(api('/projects'), {
    name: 'Аккредитация',
    identifier: 'SUM',
    member_ids: [dean.id],
  });
  projectId = project.body.id;
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

describe('GET /me/summary', () => {
  it('requires workspace membership', async () => {
    const res = await as(outsider).get(api('/me/summary'));
    expect(res.status).toBe(403);
  });

  it('starts at zero for a new member', async () => {
    const s = await summary(dean);
    expect(s.assigned).toBe(0);
    expect(s.control).toBe(0);
    expect(s.review_pending).toBe(0);
  });

  it('counts assigned, overdue, due today and unacknowledged for the assignee; control for the controller', async () => {
    const deanBefore = await summary(dean);
    const rectorBefore = await summary(rector);

    await createAssignment(projectId, { due_date: dueIn(-3) }); // overdue
    await createAssignment(projectId, { due_date: new Date().toISOString() }); // today
    await createAssignment(projectId); // in 10 days

    const deanAfter = await summary(dean);
    expect(deanAfter.assigned - deanBefore.assigned).toBe(3);
    expect(deanAfter.overdue - deanBefore.overdue).toBe(1);
    expect(deanAfter.due_today - deanBefore.due_today).toBe(1);
    expect(deanAfter.unacknowledged - deanBefore.unacknowledged).toBe(3);
    expect(deanAfter.watching - deanBefore.watching).toBe(3);
    expect(deanAfter.control).toBe(0);

    const rectorAfter = await summary(rector);
    expect(rectorAfter.control - rectorBefore.control).toBe(3);
    expect(rectorAfter.control_overdue - rectorBefore.control_overdue).toBe(1);
    expect(rectorAfter.assigned).toBe(rectorBefore.assigned);
  });

  it('acknowledging and handing in move the counters; closed work drops out', async () => {
    const issue = await createAssignment(projectId);
    const before = await summary(dean);
    const rectorBefore = await summary(rector);

    await as(dean).post(api(`/projects/${projectId}/issues/${issue.id}/acknowledge`));
    expect((await summary(dean)).unacknowledged).toBe(before.unacknowledged - 1);

    const submit = await as(dean).post(
      api(`/projects/${projectId}/issues/${issue.id}/review/submit`),
      {
        report: 'Готово',
      },
    );
    expect(submit.status).toBe(200);
    const rectorReview = await summary(rector);
    expect(rectorReview.review_pending).toBe(rectorBefore.review_pending + 1);
    // Still open while on review.
    expect(rectorReview.control).toBe(rectorBefore.control);

    await as(rector).post(api(`/projects/${projectId}/issues/${issue.id}/review/approve`), {});
    const rectorDone = await summary(rector);
    expect(rectorDone.review_pending).toBe(rectorBefore.review_pending);
    expect(rectorDone.control).toBe(rectorBefore.control - 1);
    expect((await summary(dean)).assigned).toBe(before.assigned - 1);
  });

  it('does not count issues of a private project the member cannot see', async () => {
    const hidden = await as(rector).post(api('/projects'), {
      name: 'Кадровые вопросы',
      identifier: 'HRS',
      visibility: 'private',
    });
    expect(hidden.status).toBe(201);
    const before = await summary(dean);
    const rectorBefore = await summary(rector);

    const st = await as(rector).get(api(`/projects/${hidden.body.id}/states`));
    const unstarted = st.body.find((s: { group: string }) => s.group === 'unstarted').id;
    const res = await as(rector).post(api(`/projects/${hidden.body.id}/issues`), {
      title: 'Штатное расписание',
      state_id: unstarted,
      kind: 'assignment',
      controller_id: rector.id,
      assignee_ids: [dean.id],
      due_date: dueIn(-1),
    });
    expect(res.status).toBe(201);

    const after = await summary(dean);
    expect(after.assigned).toBe(before.assigned);
    expect(after.overdue).toBe(before.overdue);
    // The owner sees every project, so their control counter does move.
    expect((await summary(rector)).control).toBe(rectorBefore.control + 1);
  });

  it('counts unread notifications in this workspace', async () => {
    const s = await summary(rector);
    const unread = await app.prisma.notification.count({
      where: { recipient_id: rector.id, is_read: false, workspace: { slug: SLUG } },
    });
    expect(s.unread_notifications).toBe(unread);
    expect(unread).toBeGreaterThan(0); // acknowledged + review_requested above
  });
});
