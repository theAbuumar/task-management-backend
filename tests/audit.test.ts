// Integration tests for the audit log (Ф12 12.B1): what gets written (sign-in and
// sign-out, member role changes and removal, deletions, settings, exports), who
// may read it (admins only), the group filter and pagination, and that entries
// cannot be changed or deleted even with direct DB access.
//
// Runs against a live Postgres. Audit rows are append-only, so they stay in the
// test database by design; everything else is removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `aud-${TS}`;
const emails = {
  rector: `aud-rector-${TS}@example.com`,
  dean: `aud-dean-${TS}@example.com`,
  clerk: `aud-clerk-${TS}@example.com`,
};

type Actor = { id: string; token: string };
type Row = {
  id: string;
  action: string;
  actor: { id: string; display_name: string } | null;
  target: { type: string; id: string | null; name: string | null } | null;
  meta: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
};

let app: FastifyInstance;
let rector: Actor;
let dean: Actor;
let clerk: Actor;
let projectId: string;

const api = (path: string) => `/api/v1/workspaces/${SLUG}${path}`;

async function register(email: string): Promise<Actor> {
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, display_name: `Аудитов ${email.split('-')[1]}` });
  expect(res.status).toBe(201);
  return { id: res.body.user.id, token: res.body.access_token };
}

function as(actor: Actor) {
  const auth = (r: request.Test) =>
    r.set('Authorization', `Bearer ${actor.token}`).set('User-Agent', 'audit-test-agent');
  return {
    get: (url: string) => auth(request(app.server).get(url)),
    post: (url: string, body?: object) => auth(request(app.server).post(url)).send(body ?? {}),
    patch: (url: string, body: object) => auth(request(app.server).patch(url)).send(body),
    delete: (url: string) => auth(request(app.server).delete(url)),
  };
}

async function audit(query = ''): Promise<Row[]> {
  const res = await as(rector).get(api(`/audit?limit=200${query}`));
  expect(res.status).toBe(200);
  return res.body.data;
}

/** Entries are written right after the reply goes out — give the write a moment. */
async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 2000;
  let value = await read();
  while (!ok(value) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    value = await read();
  }
  return value;
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  rector = await register(emails.rector);
  dean = await register(emails.dean);
  clerk = await register(emails.clerk);
  await as(rector).post('/api/v1/workspaces', { name: 'Университет', slug: SLUG });
  await as(rector).post(api('/members'), { user_id: dean.id, role: 'member' });
  await as(rector).post(api('/members'), { user_id: clerk.id, role: 'member' });
  const project = await as(rector).post(api('/projects'), {
    name: 'Аккредитация',
    identifier: 'AUD',
  });
  projectId = project.body.id;
});

afterAll(async () => {
  const list = Object.values(emails);
  await app.prisma.workspace.deleteMany({ where: { slug: SLUG } });
  await app.prisma.refreshToken.deleteMany({ where: { user: { email: { in: list } } } });
  await app.prisma.user.deleteMany({ where: { email: { in: list } } });
  await app.close();
});

describe('audit log — what is written', () => {
  it('records a member role change with who, whom, the new role, IP and browser', async () => {
    const res = await as(rector).patch(api(`/members/${dean.id}`), { role: 'admin' });
    expect(res.status).toBe(200);
    const isRoleChange = (e: Row) => e.action === 'member.updated' && e.target?.id === dean.id;
    const entry = (
      await eventually(
        () => audit('&group=members'),
        (rows) => rows.some(isRoleChange),
      )
    ).find(isRoleChange);
    expect(entry).toMatchObject({
      actor: { id: rector.id, display_name: expect.stringContaining('Аудитов') },
      target: { type: 'user', id: dean.id, name: expect.stringContaining('Аудитов') },
      meta: { role: 'admin', fields: ['role'] },
      user_agent: 'audit-test-agent',
    });
    expect(entry!.ip).toBeTruthy();
  });

  it('records member removal and issue deletion as deletions', async () => {
    const st = await as(rector).get(api(`/projects/${projectId}/states`));
    const todo = st.body.find((s: { group: string }) => s.group === 'unstarted').id;
    const issue = await as(rector).post(api(`/projects/${projectId}/issues`), {
      title: 'Удаляемая задача',
      state_id: todo,
    });
    expect(
      (await as(rector).delete(api(`/projects/${projectId}/issues/${issue.body.id}`))).status,
    ).toBe(204);
    expect((await as(rector).delete(api(`/members/${clerk.id}`))).status).toBe(204);

    const deletions = await eventually(
      () => audit('&group=deletions'),
      (rows) => rows.some((e) => e.action === 'member.removed'),
    );
    expect(deletions.find((e) => e.action === 'issue.deleted')?.target).toMatchObject({
      type: 'issue',
      id: issue.body.id,
      name: expect.stringContaining('Удаляемая задача'),
    });
    expect(deletions.find((e) => e.action === 'member.removed')?.target?.id).toBe(clerk.id);
    expect(deletions.every((e) => e.action !== 'member.updated')).toBe(true);
  });

  it('records settings changes and report exports', async () => {
    await as(rector).patch(api('/control/settings'), { require_report: true });
    await as(rector).get(api('/reports/assignments.xlsx')).buffer(true);
    const settings = await eventually(
      () => audit('&group=settings'),
      (rows) => rows.some((e) => e.action === 'settings.control_updated'),
    );
    expect(settings.find((e) => e.action === 'settings.control_updated')?.meta).toMatchObject({
      fields: ['require_report'],
    });
    const exports = await audit('&group=exports');
    expect(exports[0]).toMatchObject({
      action: 'report.exported',
      target: { type: 'report', id: 'assignments.xlsx' },
    });
  });

  it("records members' sign-ins and sign-outs, never the password", async () => {
    const agent = request.agent(app.server);
    const login = await agent
      .post('/api/v1/auth/login')
      .send({ email: emails.dean, password: PASSWORD });
    expect(login.status).toBe(200);
    expect((await agent.post('/api/v1/auth/logout').send({})).status).toBe(204);

    const entries = (await audit('&group=auth')).filter((e) => e.actor?.id === dean.id);
    expect(entries.map((e) => e.action)).toEqual(
      expect.arrayContaining(['auth.login', 'auth.logout']),
    );
    expect(entries.find((e) => e.action === 'auth.login')?.meta).toMatchObject({
      method: 'password',
    });
    expect(JSON.stringify(entries)).not.toContain(PASSWORD);
  });

  it('a failed action leaves no entry', async () => {
    const before = (await audit()).length;
    const res = await as(rector).patch(api(`/members/${rector.id}`), { role: 'banana' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    await new Promise((r) => setTimeout(r, 200));
    expect((await audit()).length).toBe(before);
  });
});

describe('audit log — who reads it and how', () => {
  it('is for admins and the owner only', async () => {
    const outsider = await as(clerk).get(api('/audit'));
    expect(outsider.status).toBe(403); // removed above — not a member any more
    await as(rector).post(api('/members'), { user_id: clerk.id, role: 'member' });
    expect((await as(clerk).get(api('/audit'))).status).toBe(403);
    // The re-adding is in the log too.
    await eventually(
      () => audit('&group=members'),
      (rows) => rows.some((e) => e.action === 'member.added' && e.target?.id === clerk.id),
    );
    expect((await as(dean).get(api('/audit'))).status).toBe(200); // promoted to admin
  });

  it('pages newest first with a cursor', async () => {
    const first = await as(rector).get(api('/audit?limit=2'));
    expect(first.body.data).toHaveLength(2);
    expect(first.body.next_cursor).toBeTruthy();
    const second = await as(rector).get(api(`/audit?limit=2&cursor=${first.body.next_cursor}`));
    const ids = [...first.body.data, ...second.body.data].map((e: Row) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('entries are immutable even with direct database access', async () => {
    const [entry] = await audit();
    await expect(
      app.prisma.auditLog.update({ where: { id: entry!.id }, data: { action: 'forged' } }),
    ).rejects.toThrow(/append-only/);
    await expect(app.prisma.auditLog.delete({ where: { id: entry!.id } })).rejects.toThrow(
      /append-only/,
    );
    expect((await audit()).find((e) => e.id === entry!.id)?.action).toBe(entry!.action);
  });
});
