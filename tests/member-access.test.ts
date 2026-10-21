// Members' access for admins (Ф12 12.B7, ADR-026):
//   - turning a member's access off answers 403 MEMBER_DEACTIVATED on their requests
//     to that workspace, hides it from their list and stops email/Telegram copies;
//   - a person left without any workspace is signed out everywhere and cannot sign
//     in; someone with another workspace keeps working there;
//   - a deactivated member cannot be assigned, made a controller or a department head;
//   - the owner and yourself cannot be changed, members cannot do it at all;
//   - access comes back with one call; admins see last sign-ins, devices, login
//     methods and open tasks, and can reset a member's Telegram/Google/GitHub;
//   - every action lands in the audit log.
//
// Runs against a live Postgres; created rows are removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { routeRecipients } from '../src/lib/notify/enqueue.js';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `macc-${TS}`;
const OTHER_SLUG = `macc-other-${TS}`;
const TG_ID = String(TS + 3);
const emails = {
  owner: `macc-owner-${TS}@example.com`,
  admin: `macc-admin-${TS}@example.com`,
  // In this workspace only: deactivation signs them out.
  solo: `macc-solo-${TS}@example.com`,
  // Also in another workspace: keeps working there.
  multi: `macc-multi-${TS}@example.com`,
};

type Actor = { id: string; token: string; refresh: string };
let app: FastifyInstance;
const a = {} as Record<keyof typeof emails, Actor>;
let workspaceId: string;
let projectId: string;
let stateId: string;

const api = (path: string, slug = SLUG) => `/api/v1/workspaces/${slug}${path}`;

async function login(email: string): Promise<Actor> {
  const res = await request(app.server)
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD });
  return {
    id: res.body.user?.id,
    token: res.body.access_token,
    refresh: res.body.refresh_token,
    ...res.body,
  };
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
  for (const [key, email] of Object.entries(emails)) {
    const res = await request(app.server)
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, display_name: email.split('@')[0] });
    expect(res.status).toBe(201);
    a[key as keyof typeof emails] = {
      id: res.body.user.id,
      token: res.body.access_token,
      refresh: res.body.refresh_token,
    };
  }
  const ws = await as(a.owner).post('/api/v1/workspaces', { name: 'Доступ', slug: SLUG });
  workspaceId = ws.body.id;
  await as(a.owner).post(api('/members'), { user_id: a.admin.id, role: 'admin' });
  await as(a.owner).post(api('/members'), { user_id: a.solo.id, role: 'member' });
  await as(a.owner).post(api('/members'), { user_id: a.multi.id, role: 'member' });
  // multi's own workspace elsewhere.
  await as(a.multi).post('/api/v1/workspaces', { name: 'Другое', slug: OTHER_SLUG });

  const project = await as(a.owner).post(api('/projects'), {
    name: 'Аттестация',
    identifier: 'MAC',
    member_ids: [a.solo.id, a.multi.id],
  });
  projectId = project.body.id;
  const states = await as(a.owner).get(api(`/projects/${projectId}/states`));
  stateId = states.body.find((s: { group: string }) => s.group === 'unstarted').id;
  // An open task assigned to solo — counted in the access view.
  await as(a.owner).post(api(`/projects/${projectId}/issues`), {
    title: 'Отчёт кафедры',
    state_id: stateId,
    assignee_ids: [a.solo.id],
  });
  // solo signs in by email code and Telegram; multi only by Telegram.
  await app.prisma.authIdentity.createMany({
    data: [
      { user_id: a.solo.id, provider: 'email', provider_email: emails.solo },
      { user_id: a.solo.id, provider: 'telegram', provider_user_id: TG_ID },
      { user_id: a.multi.id, provider: 'telegram', provider_user_id: `${TG_ID}1` },
    ],
  });
});

afterAll(async () => {
  const list = Object.values(emails);
  await app.prisma.workspace.deleteMany({ where: { slug: { in: [SLUG, OTHER_SLUG] } } });
  await app.prisma.user.deleteMany({ where: { email: { in: list } } });
  await app.close();
});

describe('who may change access', () => {
  it('a member cannot; the owner and yourself cannot be changed', async () => {
    const byMember = await as(a.multi).post(api(`/members/${a.solo.id}/deactivate`));
    expect(byMember.status).toBe(403);
    const owner = await as(a.admin).post(api(`/members/${a.owner.id}/deactivate`));
    expect(owner.status).toBe(403);
    const self = await as(a.admin).post(api(`/members/${a.admin.id}/deactivate`));
    expect(self.status).toBe(403);
    expect((await as(a.multi).get(api('/members/access'))).status).toBe(403);
  });
});

describe('admin view of members’ access', () => {
  it('shows last sign-in, devices, login methods and open tasks', async () => {
    const res = await as(a.admin).get(api('/members/access'));
    expect(res.status).toBe(200);
    const solo = res.body.find((m: { user_id: string }) => m.user_id === a.solo.id);
    expect(solo).toMatchObject({
      deactivated_at: null,
      deactivated_by: null,
      active_sessions: 1,
      providers: expect.arrayContaining(['telegram']),
      open_issues: 1,
    });
    expect(solo.last_login_at).toBeTruthy();
  });
});

describe('deactivating a member with another workspace', () => {
  it('closes this workspace to them but keeps their account and the other workspace', async () => {
    const res = await as(a.admin).post(api(`/members/${a.multi.id}/deactivate`));
    expect(res.status).toBe(200);
    expect(res.body.signed_out).toBe(false);
    expect(res.body.member.deactivated_at).toBeTruthy();

    const denied = await as(a.multi).get(api('/projects'));
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('MEMBER_DEACTIVATED');
    expect((await as(a.multi).get(api('/projects', OTHER_SLUG))).status).toBe(200);

    const list = await as(a.multi).get('/api/v1/workspaces');
    expect(list.body.map((w: { slug: string }) => w.slug)).toEqual([OTHER_SLUG]);
    // Still signed in: their session works elsewhere.
    expect((await as(a.multi).get('/api/v1/auth/me')).status).toBe(200);

    // The list of members still shows them, marked.
    const members = await as(a.owner).get(api('/members'));
    const row = members.body.find((m: { user_id: string }) => m.user_id === a.multi.id);
    expect(row.deactivated_at).toBeTruthy();
  });

  it('a deactivated member cannot be assigned, controller or department head', async () => {
    const assign = await as(a.owner).post(api(`/projects/${projectId}/issues`), {
      title: 'Ему',
      state_id: stateId,
      assignee_ids: [a.multi.id],
    });
    expect(assign.status).toBe(400);
    expect(assign.body.error.code).toBe('MEMBER_DEACTIVATED');

    const control = await as(a.owner).post(api(`/projects/${projectId}/issues`), {
      title: 'Под его контролем',
      state_id: stateId,
      kind: 'assignment',
      controller_id: a.multi.id,
      assignee_ids: [a.solo.id],
    });
    expect(control.status).toBe(400);
    expect(control.body.error.code).toBe('MEMBER_DEACTIVATED');

    const head = await as(a.owner).post(api('/departments'), {
      name: 'Отдел',
      head_id: a.multi.id,
    });
    expect(head.status).toBe(400);
    expect(head.body.error.code).toBe('MEMBER_DEACTIVATED');
  });

  it('nothing about this workspace goes out to them by email or Telegram', async () => {
    const workspace = { id: workspaceId, timezone: 'UTC' };
    const routed = await routeRecipients(
      app.prisma,
      [a.multi.id, a.solo.id],
      'issue_assigned',
      workspace,
    );
    const ids = [...routed.email, ...routed.telegram].map((r) => r.userId);
    expect(ids).toContain(a.solo.id);
    expect(ids).not.toContain(a.multi.id);
  });

  it('access comes back with one call', async () => {
    const res = await as(a.admin).post(api(`/members/${a.multi.id}/activate`));
    expect(res.status).toBe(200);
    expect(res.body.deactivated_at).toBeNull();
    expect((await as(a.multi).get(api('/projects'))).status).toBe(200);
  });
});

describe('deactivating a member with no other workspace', () => {
  it('ends their sessions at once and refuses sign-in', async () => {
    const res = await as(a.admin).post(api(`/members/${a.solo.id}/deactivate`));
    expect(res.status).toBe(200);
    expect(res.body.signed_out).toBe(true);

    // The access token is cut off now, the refresh token too.
    expect((await as(a.solo).get('/api/v1/auth/me')).status).toBe(401);
    const refreshed = await request(app.server)
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: a.solo.refresh });
    expect(refreshed.status).toBe(401);

    const signIn = await request(app.server)
      .post('/api/v1/auth/login')
      .send({ email: emails.solo, password: PASSWORD });
    expect(signIn.status).toBe(403);
    expect(signIn.body.error.code).toBe('MEMBER_DEACTIVATED');

    const access = await as(a.admin).get(api('/members/access'));
    const row = access.body.find((m: { user_id: string }) => m.user_id === a.solo.id);
    expect(row).toMatchObject({ active_sessions: 0, deactivated_by: { id: a.admin.id } });
    // Their task and history stay.
    expect(row.open_issues).toBe(1);
  });

  it('after activation they sign in again', async () => {
    await as(a.admin).post(api(`/members/${a.solo.id}/activate`));
    const signIn = await login(emails.solo);
    expect(signIn.token).toBeTruthy();
    a.solo = signIn;
  });
});

describe('a department whose head was deactivated', () => {
  it('counts as one without a head when distributing', async () => {
    const dept = await as(a.owner).post(api('/departments'), {
      name: 'Кафедра физики',
      head_id: a.multi.id,
    });
    expect(dept.status).toBe(201);
    await as(a.admin).post(api(`/members/${a.multi.id}/deactivate`));
    const res = await as(a.owner).post(api(`/projects/${projectId}/issues/distribute`), {
      title: 'Рассылка',
      state_id: stateId,
      department_ids: [dept.body.id],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DEPARTMENT_HAS_NO_HEAD');
    await as(a.admin).post(api(`/members/${a.multi.id}/activate`));
  });
});

describe('resetting a member’s login method', () => {
  it('unlinks their Telegram; the email and unknown providers are refused', async () => {
    const reset = await as(a.admin).delete(api(`/members/${a.solo.id}/identities/telegram`));
    expect(reset.status).toBe(204);
    expect(
      await app.prisma.authIdentity.count({ where: { user_id: a.solo.id, provider: 'telegram' } }),
    ).toBe(0);
    // Not linked any more.
    expect(
      (await as(a.admin).delete(api(`/members/${a.solo.id}/identities/telegram`))).status,
    ).toBe(404);
    // The email is the account's own.
    expect((await as(a.admin).delete(api(`/members/${a.solo.id}/identities/email`))).status).toBe(
      400,
    );
    // Not the last login method (multi has only Telegram), as for the user themselves.
    expect(
      (await as(a.admin).delete(api(`/members/${a.multi.id}/identities/telegram`))).status,
    ).toBe(403);
    // Not for the owner.
    expect((await as(a.admin).delete(api(`/members/${a.owner.id}/identities/google`))).status).toBe(
      403,
    );
  });
});

describe('audit', () => {
  it('records deactivation, activation and the reset with the admin as actor', async () => {
    const rows = await app.prisma.auditLog.findMany({
      where: { workspace_id: workspaceId, actor_id: a.admin.id },
      select: { action: true, target_id: true, meta: true },
    });
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(['member.deactivated', 'member.activated', 'member.identity_reset']),
    );
    const reset = rows.find((r) => r.action === 'member.identity_reset');
    expect(reset).toMatchObject({ target_id: a.solo.id, meta: { provider: 'telegram' } });
  });
});
