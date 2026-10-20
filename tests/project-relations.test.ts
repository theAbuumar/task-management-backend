// Integration tests for the project-wide relation list (Ф7 7.F4): the timeline
// reads every «блокирует» arrow with one request. Each pair comes once (no
// `blocked_by` mirrors, one row for a symmetric pair), deleted issues and links
// to other projects are left out, and a private project stays hidden.
//
// Runs against a live Postgres; everything is removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `prel-${TS}`;
const emails = {
  admin: `prel-admin-${TS}@example.com`,
  member: `prel-member-${TS}@example.com`,
};

type Actor = { id: string; token: string };
type Link = { id: string; issue_id: string; related_issue_id: string; relation_type: string };

let app: FastifyInstance;
let admin: Actor;
let member: Actor;
let projectId: string;
let otherProjectId: string;
let todo: string;
const ids: Record<string, string> = {};

const api = (path: string) => `/api/v1/workspaces/${SLUG}${path}`;

async function register(email: string): Promise<Actor> {
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, display_name: `Связев ${email.split('-')[1]}` });
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

async function issue(title: string, project = projectId): Promise<string> {
  const states = await as(admin).get(api(`/projects/${project}/states`));
  const state = states.body.find((s: { group: string }) => s.group === 'unstarted').id;
  const res = await as(admin).post(api(`/projects/${project}/issues`), { title, state_id: state });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function link(from: string, to: string, type: string) {
  const res = await as(admin).post(api(`/projects/${projectId}/issues/${from}/relations`), {
    related_issue_id: to,
    relation_type: type,
  });
  expect(res.status).toBe(201);
}

async function relations(actor: Actor, query = ''): Promise<Link[]> {
  const res = await as(actor).get(api(`/projects/${projectId}/relations${query}`));
  expect(res.status).toBe(200);
  return res.body.data;
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  admin = await register(emails.admin);
  member = await register(emails.member);
  await as(admin).post('/api/v1/workspaces', { name: 'Университет', slug: SLUG });
  await as(admin).post(api('/members'), { user_id: member.id, role: 'member' });
  projectId = (
    await as(admin).post(api('/projects'), { name: 'Приёмная кампания', identifier: 'PRL' })
  ).body.id;
  otherProjectId = (await as(admin).post(api('/projects'), { name: 'Наука', identifier: 'PRO' }))
    .body.id;
  const st = await as(admin).get(api(`/projects/${projectId}/states`));
  todo = st.body.find((s: { group: string }) => s.group === 'unstarted').id;
  expect(todo).toBeTruthy();

  ids.plan = await issue('Утвердить план приёма');
  ids.rules = await issue('Опубликовать правила приёма');
  ids.site = await issue('Обновить раздел на сайте');
  ids.old = await issue('Черновик правил');
  ids.foreign = await issue('Грант на оборудование', otherProjectId);

  // План блокирует правила; правила блокируют сайт; правила связаны с сайтом.
  await link(ids.plan, ids.rules, 'blocks');
  // Created from the blocked side: still read back as «rules blocks site».
  await link(ids.site, ids.rules, 'blocked_by');
  await link(ids.rules, ids.site, 'relates_to');
  await link(ids.old, ids.rules, 'duplicates');
  await link(ids.plan, ids.foreign, 'blocks');
  // The duplicate goes to the trash: its link is no longer shown.
  expect((await as(admin).delete(api(`/projects/${projectId}/issues/${ids.old}`))).status).toBe(
    204,
  );
});

afterAll(async () => {
  const ws = await app.prisma.workspace.findUnique({ where: { slug: SLUG } });
  if (ws) await app.prisma.workspace.delete({ where: { id: ws.id } });
  await app.prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
  await app.close();
});

describe('GET P/relations', () => {
  it('returns each pair once, without mirrors, deleted issues or other projects', async () => {
    const rows = await relations(member);
    const blocks = rows
      .filter((r) => r.relation_type === 'blocks')
      .map((r) => [r.issue_id, r.related_issue_id]);
    expect(blocks).toEqual([
      [ids.plan, ids.rules],
      [ids.rules, ids.site],
    ]);
    expect(rows.some((r) => r.relation_type === 'blocked_by')).toBe(false);

    const relates = rows.filter((r) => r.relation_type === 'relates_to');
    expect(relates).toHaveLength(1);
    expect([relates[0]!.issue_id, relates[0]!.related_issue_id].sort()).toEqual(
      [ids.rules, ids.site].sort(),
    );

    const all = new Set(rows.flatMap((r) => [r.issue_id, r.related_issue_id]));
    expect(all.has(ids.old!)).toBe(false);
    expect(all.has(ids.foreign!)).toBe(false);
  });

  it('narrows to one kind with ?type=', async () => {
    const rows = await relations(member, '?type=blocks');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.relation_type === 'blocks')).toBe(true);
    const bad = await as(member).get(api(`/projects/${projectId}/relations?type=blocked_by`));
    expect(bad.status).toBe(400);
  });

  it('hides a private project from a non-member (404)', async () => {
    expect(
      (await as(admin).patch(api(`/projects/${projectId}`), { visibility: 'private' })).status,
    ).toBe(200);
    const res = await as(member).get(api(`/projects/${projectId}/relations`));
    expect(res.status).toBe(404);
    expect(await relations(admin)).not.toHaveLength(0);
    await as(admin).patch(api(`/projects/${projectId}`), { visibility: 'public' });
  });
});
