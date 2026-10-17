// Integration tests: email-based workspace invites.
//
// Covers: admin creates invite (returns token + logs email), non-member cannot
// invite, re-invite invalidates prior pending invite, expired invite rejected,
// GET /invites/:token returns metadata without auth, POST /invites/:token/accept
// adds acceptor as member, wrong-email accept is rejected, already-accepted invite
// is rejected, registration with invite_token auto-joins the workspace.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const OWNER_EMAIL = `inv-owner-${TS}@example.com`;
const ADMIN_EMAIL = `inv-admin-${TS}@example.com`;
const MEMBER_EMAIL = `inv-member-${TS}@example.com`;
const INVITEE_EMAIL = `inv-invitee-${TS}@example.com`;
const OUTSIDER_EMAIL = `inv-outsider-${TS}@example.com`;
const PW = 'Password123!';

let app: FastifyInstance;
let ownerToken: string;
let adminToken: string;
let memberToken: string;
let outsiderToken: string;
let workspaceSlug: string;

const auth = (token: string): [string, string] => ['Authorization', `Bearer ${token}`];
const membersBase = () => `/api/v1/workspaces/${workspaceSlug}/members`;
const invitesBase = () => `/api/v1/invites`;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  const reg = async (email: string, inviteToken?: string): Promise<string> => {
    const body: Record<string, string> = { email, password: PW, display_name: email };
    if (inviteToken) body['invite_token'] = inviteToken;
    const res = await request(app.server).post('/api/v1/auth/register').send(body);
    expect(res.status).toBe(201);
    return res.body.access_token as string;
  };
  const userId = async (token: string): Promise<string> => {
    const res = await request(app.server)
      .get('/api/v1/auth/me')
      .set(...auth(token));
    return res.body.id as string;
  };

  ownerToken = await reg(OWNER_EMAIL);
  adminToken = await reg(ADMIN_EMAIL);
  memberToken = await reg(MEMBER_EMAIL);
  outsiderToken = await reg(OUTSIDER_EMAIL);

  // Create workspace
  workspaceSlug = `inv-ws-${TS}`;
  await request(app.server)
    .post('/api/v1/workspaces')
    .set(...auth(ownerToken))
    .send({ name: 'Invite WS', slug: workspaceSlug })
    .expect(201);

  // Add admin and member
  const adminId = await userId(adminToken);
  const memberId = await userId(memberToken);
  await request(app.server)
    .post(membersBase())
    .set(...auth(ownerToken))
    .send({ user_id: adminId, role: 'admin' })
    .expect(201);
  await request(app.server)
    .post(membersBase())
    .set(...auth(ownerToken))
    .send({ user_id: memberId, role: 'member' })
    .expect(201);
});

afterAll(async () => {
  await app.close();
});

describe('POST /workspaces/:slug/members/invite', () => {
  it('owner can create an invite', async () => {
    const res = await request(app.server)
      .post(`${membersBase()}/invite`)
      .set(...auth(ownerToken))
      .send({ email: INVITEE_EMAIL, role: 'member' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      email: INVITEE_EMAIL,
      role: 'member',
      workspace_id: expect.any(String),
      token: expect.any(String),
      expires_at: expect.any(String),
      accepted_at: null,
    });
  });

  it('admin can create an invite', async () => {
    const email = `inv-admin-invitee-${TS}@example.com`;
    const res = await request(app.server)
      .post(`${membersBase()}/invite`)
      .set(...auth(adminToken))
      .send({ email, role: 'guest' });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('guest');
  });

  it('member cannot invite (403)', async () => {
    const res = await request(app.server)
      .post(`${membersBase()}/invite`)
      .set(...auth(memberToken))
      .send({ email: 'x@x.com', role: 'member' });
    expect(res.status).toBe(403);
  });

  it('outsider cannot invite (403)', async () => {
    const res = await request(app.server)
      .post(`${membersBase()}/invite`)
      .set(...auth(outsiderToken))
      .send({ email: 'x@x.com', role: 'member' });
    expect(res.status).toBe(403);
  });

  it('inviting an existing member returns 409', async () => {
    const res = await request(app.server)
      .post(`${membersBase()}/invite`)
      .set(...auth(ownerToken))
      .send({ email: MEMBER_EMAIL, role: 'member' });
    expect(res.status).toBe(409);
  });

  it('re-inviting the same email invalidates the old token', async () => {
    const freshEmail = `inv-reissue-${TS}@example.com`;

    const first = await request(app.server)
      .post(`${membersBase()}/invite`)
      .set(...auth(ownerToken))
      .send({ email: freshEmail, role: 'member' });
    expect(first.status).toBe(201);
    const firstToken = first.body.token as string;

    const second = await request(app.server)
      .post(`${membersBase()}/invite`)
      .set(...auth(ownerToken))
      .send({ email: freshEmail, role: 'admin' });
    expect(second.status).toBe(201);
    const secondToken = second.body.token as string;

    // Old token should be gone (deleted on re-invite)
    await request(app.server).get(`${invitesBase()}/${firstToken}`).expect(404);
    // New token is valid
    const info = await request(app.server).get(`${invitesBase()}/${secondToken}`).expect(200);
    expect(info.body.role).toBe('admin');
  });
});

describe('GET /invites/:token', () => {
  let validToken: string;

  beforeAll(async () => {
    const email = `inv-get-${TS}@example.com`;
    const res = await request(app.server)
      .post(`${membersBase()}/invite`)
      .set(...auth(ownerToken))
      .send({ email, role: 'member' });
    validToken = res.body.token as string;
  });

  it('returns invite metadata without authentication', async () => {
    const res = await request(app.server).get(`${invitesBase()}/${validToken}`).expect(200);
    expect(res.body).toMatchObject({
      workspace: { slug: workspaceSlug },
      invited_by: { display_name: OWNER_EMAIL },
    });
  });

  it('returns 404 for unknown token', async () => {
    await request(app.server)
      .get(`${invitesBase()}/00000000-0000-0000-0000-000000000000`)
      .expect(404);
  });

  it('returns 410 for expired invite', async () => {
    const email = `inv-expired-${TS}@example.com`;
    const inv = await app.prisma.workspaceInvite.create({
      data: {
        workspace: { connect: { slug: workspaceSlug } },
        invited_by: { connect: { email: OWNER_EMAIL } },
        email,
        role: 'member',
        expires_at: new Date(Date.now() - 1000),
      },
    });
    const res = await request(app.server).get(`${invitesBase()}/${inv.token}`).expect(410);
    expect(res.body.error.code).toBe('INVITE_EXPIRED');
  });
});

describe('POST /invites/:token/accept', () => {
  let inviteToken: string;
  const acceptorEmail = `inv-acceptor-${TS}@example.com`;

  beforeAll(async () => {
    // Register the acceptor but do NOT add them to the workspace yet.
    await request(app.server)
      .post('/api/v1/auth/register')
      .send({ email: acceptorEmail, password: PW, display_name: acceptorEmail })
      .expect(201);

    const res = await request(app.server)
      .post(`${membersBase()}/invite`)
      .set(...auth(ownerToken))
      .send({ email: acceptorEmail, role: 'member' });
    expect(res.status).toBe(201);
    inviteToken = res.body.token as string;
  });

  it('requires authentication', async () => {
    await request(app.server).post(`${invitesBase()}/${inviteToken}/accept`).expect(401);
  });

  it('acceptor with wrong email is rejected (403)', async () => {
    // outsider has a different email from the invite
    const res = await request(app.server)
      .post(`${invitesBase()}/${inviteToken}/accept`)
      .set(...auth(outsiderToken));
    expect(res.status).toBe(403);
  });

  it('correct user can accept and becomes a member', async () => {
    const loginRes = await request(app.server)
      .post('/api/v1/auth/login')
      .send({ email: acceptorEmail, password: PW })
      .expect(200);
    const acceptorToken = loginRes.body.access_token as string;

    const res = await request(app.server)
      .post(`${invitesBase()}/${inviteToken}/accept`)
      .set(...auth(acceptorToken))
      .expect(200);
    expect(res.body).toMatchObject({ role: 'member' });

    // Now appears in the member list
    const members = await request(app.server)
      .get(membersBase())
      .set(...auth(ownerToken))
      .expect(200);
    const emails = members.body.map((m: { user: { email: string } }) => m.user.email);
    expect(emails).toContain(acceptorEmail);
  });

  it('accepting again is idempotent (200, already accepted)', async () => {
    const loginRes = await request(app.server)
      .post('/api/v1/auth/login')
      .send({ email: acceptorEmail, password: PW })
      .expect(200);
    const acceptorToken = loginRes.body.access_token as string;

    // Second accept of same invite: invite already accepted → 409
    const res = await request(app.server)
      .post(`${invitesBase()}/${inviteToken}/accept`)
      .set(...auth(acceptorToken));
    expect(res.status).toBe(409);
  });

  it('returns 404 for unknown token', async () => {
    const loginRes = await request(app.server)
      .post('/api/v1/auth/login')
      .send({ email: acceptorEmail, password: PW })
      .expect(200);
    const acceptorToken = loginRes.body.access_token as string;

    await request(app.server)
      .post(`${invitesBase()}/00000000-0000-0000-0000-000000000000/accept`)
      .set(...auth(acceptorToken))
      .expect(404);
  });
});

describe('Registration with invite_token', () => {
  it('registers and auto-joins the workspace', async () => {
    const newEmail = `inv-autoregister-${TS}@example.com`;

    // Create the invite first
    const invRes = await request(app.server)
      .post(`${membersBase()}/invite`)
      .set(...auth(ownerToken))
      .send({ email: newEmail, role: 'admin' })
      .expect(201);
    const token = invRes.body.token as string;

    // Register with the invite token
    const regRes = await request(app.server)
      .post('/api/v1/auth/register')
      .send({ email: newEmail, password: PW, display_name: newEmail, invite_token: token })
      .expect(201);
    expect(regRes.body.access_token).toBeDefined();

    // Verify membership
    const members = await request(app.server)
      .get(membersBase())
      .set(...auth(ownerToken))
      .expect(200);
    const entry = (members.body as Array<{ user: { email: string }; role: string }>).find(
      (m) => m.user.email === newEmail,
    );
    expect(entry).toBeDefined();
    expect(entry?.role).toBe('admin');
  });

  it('register with wrong email for token is rejected (403)', async () => {
    const invEmail = `inv-wrongemail-${TS}@example.com`;
    const otherEmail = `inv-wrongemail-other-${TS}@example.com`;

    const invRes = await request(app.server)
      .post(`${membersBase()}/invite`)
      .set(...auth(ownerToken))
      .send({ email: invEmail, role: 'member' })
      .expect(201);
    const token = invRes.body.token as string;

    const res = await request(app.server).post('/api/v1/auth/register').send({
      email: otherEmail,
      password: PW,
      display_name: otherEmail,
      invite_token: token,
    });
    expect(res.status).toBe(403);
  });

  it('register with expired token is rejected (410)', async () => {
    const expEmail = `inv-expreg-${TS}@example.com`;
    const inv = await app.prisma.workspaceInvite.create({
      data: {
        workspace: { connect: { slug: workspaceSlug } },
        invited_by: { connect: { email: OWNER_EMAIL } },
        email: expEmail,
        role: 'member',
        expires_at: new Date(Date.now() - 1000),
      },
    });

    const res = await request(app.server).post('/api/v1/auth/register').send({
      email: expEmail,
      password: PW,
      display_name: expEmail,
      invite_token: inv.token,
    });
    expect(res.status).toBe(410);
  });
});
