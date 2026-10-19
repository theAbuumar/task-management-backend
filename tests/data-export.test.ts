// Integration tests for «Скачать мои данные» (Ф12 12.B13): the file has the
// caller's profile, sign-ins, workspaces and own work, no secrets and no texts
// of other people, and the download is written to the audit log.
//
// Runs against a live Postgres; everything is removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `dex-${TS}`;
const emails = {
  me: `dex-me-${TS}@example.com`,
  colleague: `dex-colleague-${TS}@example.com`,
};

type Actor = { id: string; token: string };
let app: FastifyInstance;
let me: Actor;
let colleague: Actor;
let issueKey: string;

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
    patch: (url: string, body: object) => auth(request(app.server).patch(url)).send(body),
  };
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  me = await register(emails.me, 'Данных Мария');
  colleague = await register(emails.colleague, 'Коллегин Пётр');
  await as(me).patch('/api/v1/auth/me', { phone: '+992 90 123 45 67' });
  await as(me).post('/api/v1/workspaces', { name: 'Университет данных', slug: SLUG });
  await as(me).post(api('/members'), { user_id: colleague.id, role: 'member' });
  const project = await as(me).post(api('/projects'), { name: 'Проект', identifier: 'DEX' });
  const states = await as(me).get(api(`/projects/${project.body.id}/states`));
  const state = states.body.find((s: { group: string }) => s.group === 'unstarted').id;
  const issue = await as(me).post(api(`/projects/${project.body.id}/issues`), {
    title: 'Подготовить справку',
    state_id: state,
    assignee_ids: [me.id],
  });
  issueKey = `DEX-${issue.body.sequence_id}`;
  const comments = api(`/projects/${project.body.id}/issues/${issue.body.id}/comments`);
  await as(me).post(comments, { body: 'Мой комментарий' });
  await as(colleague).post(comments, { body: 'Чужой комментарий' });
});

afterAll(async () => {
  const list = Object.values(emails);
  await app.prisma.workspace.deleteMany({ where: { slug: SLUG } });
  await app.prisma.refreshToken.deleteMany({ where: { user: { email: { in: list } } } });
  await app.prisma.user.deleteMany({ where: { email: { in: list } } });
  await app.close();
});

describe('my data export (12.B13)', () => {
  it('is a JSON file with my profile, sign-ins, workspaces and my own work', async () => {
    const res = await as(me).get('/api/v1/auth/me/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename\*=UTF-8''/);
    expect(res.headers['cache-control']).toBe('no-store');

    const data = JSON.parse(res.text);
    expect(data.format).toBe('fulltask-personal-data/1');
    expect(data.profile).toMatchObject({
      id: me.id,
      email: emails.me,
      display_name: 'Данных Мария',
      phone: '+992 90 123 45 67',
    });
    // A password sign-up has no linked provider yet; the list is there all the same.
    expect(data.sign_in_methods).toEqual([]);
    expect(data.sessions.length).toBeGreaterThan(0);
    expect(data.workspaces).toEqual([
      expect.objectContaining({ name: 'Университет данных', slug: SLUG, role: 'owner' }),
    ]);
    expect(data.work.created_issues).toEqual([
      expect.objectContaining({ key: issueKey, title: 'Подготовить справку' }),
    ]);
    expect(data.work.assigned_issues[0]).toMatchObject({ key: issueKey, responsible: true });
    expect(data.work.comments).toEqual([
      expect.objectContaining({ issue: issueKey, body: 'Мой комментарий' }),
    ]);
    expect(data.audit_log.some((e: { action: string }) => e.action === 'auth.login')).toBe(true);
  });

  it('my phone is not shown to colleagues', async () => {
    const members = await as(colleague).get(api('/members'));
    expect(members.status).toBe(200);
    expect(JSON.stringify(members.body)).not.toContain('+992 90 123 45 67');
  });

  it('has no secrets and no texts of other people', async () => {
    const res = await as(me).get('/api/v1/auth/me/export');
    expect(res.text).not.toContain('Чужой комментарий');
    expect(res.text).not.toContain('password_hash');
    expect(res.text).not.toContain('code_hash');
    expect(res.text).not.toContain('token_hash');
    expect(res.text).not.toContain(me.token);
    // The colleague's own file has the colleague's comment, not mine.
    const theirs = await as(colleague).get('/api/v1/auth/me/export');
    expect(theirs.text).toContain('Чужой комментарий');
    expect(theirs.text).not.toContain('Мой комментарий');
  });

  it('goes to the audit log and needs a session', async () => {
    const deadline = Date.now() + 2000;
    let found = 0;
    while (found === 0 && Date.now() < deadline) {
      found = await app.prisma.auditLog.count({
        where: { actor_id: me.id, action: 'user.data_exported' },
      });
      if (found === 0) await new Promise((r) => setTimeout(r, 25));
    }
    expect(found).toBeGreaterThan(0);
    // An admin of my workspace sees it in the «Отчёты» group.
    const audit = await as(me).get(api('/audit?group=exports'));
    expect(audit.body.data.map((e: { action: string }) => e.action)).toContain(
      'user.data_exported',
    );

    expect((await request(app.server).get('/api/v1/auth/me/export')).status).toBe(401);
  });
});
