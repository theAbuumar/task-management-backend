// Integration tests for bulk changes of issues (Ф6 6.B6, ADR-030): every issue goes
// through the regular rules — a reviewed assignment is closed only by its controller
// (5.B3), its deadline is the controller's (5.B5) — so the answer is a partial
// success with reasons; history is written per issue; what applies to all (state,
// label, assignee) is checked once; a guest changes nothing.
//
// Runs against a live Postgres; everything is removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `bulk-${TS}`;
const emails = {
  rector: `bulk-rector-${TS}@example.com`,
  dean: `bulk-dean-${TS}@example.com`,
  clerk: `bulk-clerk-${TS}@example.com`,
  guest: `bulk-guest-${TS}@example.com`,
};

type Actor = { id: string; token: string };

let app: FastifyInstance;
let rector: Actor;
let dean: Actor;
let clerk: Actor;
let guest: Actor;
let projectId: string;
let otherProjectId: string;
let states: { id: string; group: string; is_default: boolean }[];
let labelId: string;
let tasks: string[];
let assignment: string;

const api = (path: string) => `/api/v1/workspaces/${SLUG}${path}`;
const bulk = () => api(`/projects/${projectId}/issues/bulk`);

async function register(email: string): Promise<Actor> {
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, display_name: `Массово ${email.split('-')[1]}` });
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

const issue = async (id: string) =>
  (await as(dean).get(api(`/projects/${projectId}/issues/${id}`))).body;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  rector = await register(emails.rector);
  dean = await register(emails.dean);
  clerk = await register(emails.clerk);
  guest = await register(emails.guest);
  await as(rector).post('/api/v1/workspaces', { name: 'Университет', slug: SLUG });
  await as(rector).post(api('/members'), { user_id: dean.id, role: 'member' });
  await as(rector).post(api('/members'), { user_id: clerk.id, role: 'member' });
  await as(rector).post(api('/members'), { user_id: guest.id, role: 'guest' });
  projectId = (await as(rector).post(api('/projects'), { name: 'Деканат', identifier: 'BLK' })).body
    .id;
  otherProjectId = (await as(rector).post(api('/projects'), { name: 'Другой', identifier: 'BLO' }))
    .body.id;
  states = (await as(rector).get(api(`/projects/${projectId}/states`))).body;
  labelId = (
    await as(rector).post(api(`/projects/${projectId}/labels`), {
      name: 'Срочно',
      color: '#E5484D',
    })
  ).body.id;
  const initial = states.find((s) => s.is_default)!.id;
  tasks = [];
  for (const title of ['Расписание', 'Ведомости', 'Журналы']) {
    tasks.push(
      (
        await as(dean).post(api(`/projects/${projectId}/issues`), {
          title,
          state_id: initial,
          assignee_ids: [dean.id],
        })
      ).body.id,
    );
  }
  // An assignment the rector controls: closed only by the rector, deadline the rector's.
  assignment = (
    await as(rector).post(api(`/projects/${projectId}/issues`), {
      title: 'Поручение ректора',
      state_id: initial,
      kind: 'assignment',
      controller_id: rector.id,
      assignee_ids: [dean.id],
      due_date: '2026-11-30T12:00:00.000Z',
    })
  ).body.id;
});

afterAll(async () => {
  const ws = await app.prisma.workspace.findUnique({ where: { slug: SLUG } });
  if (ws) await app.prisma.workspace.delete({ where: { id: ws.id } });
  await app.prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
  await app.close();
});

describe('bulk changes', () => {
  it('closing: tasks close, the reviewed assignment stays — with the reason', async () => {
    const done = states.find((s) => s.group === 'completed')!.id;
    const res = await as(dean).post(bulk(), { issue_ids: [...tasks, assignment], state_id: done });
    expect(res.status).toBe(200);
    expect(res.body.updated.sort()).toEqual([...tasks].sort());
    expect(res.body.failed).toEqual([
      expect.objectContaining({ issue_id: assignment, code: 'REVIEW_REQUIRED' }),
    ]);
    for (const id of tasks) expect((await issue(id)).state_id).toBe(done);
    // Each closed task has its own history row.
    const history = await as(dean).get(api(`/projects/${projectId}/issues/${tasks[0]}/activity`));
    const rows = history.body.data ?? history.body;
    expect(rows.some((a: { field: string }) => a.field === 'state_id')).toBe(true);
  });

  it('the deadline of an assignment is its controller’s', async () => {
    const due = '2026-12-15T12:00:00.000Z';
    const byDean = await as(dean).post(bulk(), {
      issue_ids: [tasks[0], assignment],
      due_date: due,
    });
    expect(byDean.body.updated).toEqual([tasks[0]]);
    expect(byDean.body.failed[0]).toMatchObject({
      issue_id: assignment,
      code: 'DEADLINE_CHANGE_FORBIDDEN',
    });
    const byRector = await as(rector).post(bulk(), { issue_ids: [assignment], due_date: due });
    expect(byRector.body.updated).toEqual([assignment]);
    expect((await issue(assignment)).due_date).toBe(due);
  });

  it('an assignee replaces the assignees; labels are added and removed', async () => {
    const res = await as(dean).post(bulk(), { issue_ids: tasks, assignee_id: clerk.id });
    expect(res.body.updated).toHaveLength(3);
    const after = await issue(tasks[1]!);
    expect(after.assignees).toEqual([
      expect.objectContaining({ user_id: clerk.id, is_primary: true }),
    ]);
    await as(dean).post(bulk(), { issue_ids: tasks, add_label_id: labelId });
    expect((await issue(tasks[2]!)).labels.map((l: { label_id: string }) => l.label_id)).toEqual([
      labelId,
    ]);
    // Adding again is not an error.
    expect(
      (await as(dean).post(bulk(), { issue_ids: tasks, add_label_id: labelId })).body.failed,
    ).toEqual([]);
    await as(dean).post(bulk(), { issue_ids: tasks.slice(0, 2), remove_label_id: labelId });
    expect((await issue(tasks[0]!)).labels).toEqual([]);
    expect((await issue(tasks[2]!)).labels).toHaveLength(1);
  });

  it('an issue of another project is not found; the others change', async () => {
    const stranger = (
      await as(dean).post(api(`/projects/${otherProjectId}/issues`), {
        title: 'Чужая',
        state_id: (await as(dean).get(api(`/projects/${otherProjectId}/states`))).body[0].id,
      })
    ).body.id;
    const res = await as(dean).post(bulk(), { issue_ids: [tasks[0], stranger], priority: 'high' });
    expect(res.body.updated).toEqual([tasks[0]]);
    expect(res.body.failed).toEqual([
      expect.objectContaining({ issue_id: stranger, code: 'NOT_FOUND' }),
    ]);
  });

  it('what applies to all is checked once', async () => {
    const otherState = (await as(dean).get(api(`/projects/${otherProjectId}/states`))).body[0].id;
    const bad = [
      { issue_ids: tasks, state_id: otherState },
      { issue_ids: tasks, assignee_id: guest.id },
      { issue_ids: tasks },
      { issue_ids: [], priority: 'low' },
      { issue_ids: tasks, priority: 'asap' },
      { issue_ids: Array.from({ length: 101 }, () => tasks[0]), priority: 'low' },
    ];
    for (const body of bad) {
      const res = await as(dean).post(bulk(), body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect(
      (await as(dean).post(bulk(), { issue_ids: tasks, add_label_id: projectId })).status,
    ).toBe(404);
  });

  it('a guest changes nothing', async () => {
    const res = await as(guest).post(bulk(), { issue_ids: tasks, priority: 'low' });
    expect(res.status).toBe(403);
  });
});
