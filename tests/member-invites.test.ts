// Integration tests: inviting ALREADY-REGISTERED users to a workspace.
//
// Covers the invite-existing-user flow (modules/member-invites): admin invites by email
// or user_id, the invite lands in the target's personal inbox (GET /api/v1/invitations),
// accept joins the workspace, decline does not. Also the Telegram delivery + accept path
// — the bot sendMessage is mocked at the `fetch` boundary and the accept `callback_query`
// is simulated against the webhook. Authorization (member/outsider 403), self-invite 400,
// already-member 409, wrong-target 404, and expired 410 are exercised too.
//
// Runs against the same Postgres as the other integration tests; created rows are cleaned
// up in afterAll. Requires TELEGRAM_* test env (tests/setup.ts).

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const OWNER_EMAIL = `mi-owner-${TS}@example.com`;
const ADMIN_EMAIL = `mi-admin-${TS}@example.com`;
const MEMBER_EMAIL = `mi-member-${TS}@example.com`;
const INVITEE_EMAIL = `mi-invitee-${TS}@example.com`;
const DECLINER_EMAIL = `mi-decliner-${TS}@example.com`;
const OUTSIDER_EMAIL = `mi-outsider-${TS}@example.com`;
const EXPIRED_EMAIL = `mi-expired-${TS}@example.com`;
const PW = 'Password123!';
const TG_ID = TS + 777; // Telegram numeric user id for the Telegram-only account

let app: FastifyInstance;
let ownerToken: string;
let adminToken: string;
let memberToken: string;
let outsiderToken: string;
let workspaceSlug: string;
let tgUserId: string;

const auth = (token: string): [string, string] => ['Authorization', `Bearer ${token}`];
const membersBase = (): string => `/api/v1/workspaces/${workspaceSlug}/members`;
const inviteUserUrl = (): string => `${membersBase()}/invite-user`;
const inbox = '/api/v1/invitations';
const webhook = '/api/v1/auth/telegram/webhook';

/** A fetch mock that accepts any Telegram Bot API call and reports success. */
function telegramFetchMock(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    if (url.startsWith('https://api.telegram.org/bot')) {
      return { ok: true, json: async () => ({ ok: true }) };
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
}

function cookieValue(setCookie: string[] | undefined, name: string): string | undefined {
  const raw = (setCookie ?? []).find((c) => c.startsWith(`${name}=`));
  return raw?.split(';')[0]!.split('=').slice(1).join('=');
}

/** Create a Telegram-only account (no email) via the deep-link login handshake. */
async function createTelegramUser(): Promise<{ userId: string; accessToken: string }> {
  const init = await request(app.server).post('/api/v1/auth/telegram/init');
  const session = cookieValue(init.headers['set-cookie'] as unknown as string[], 'tg_session')!;
  const token = init.body.token as string;

  vi.stubGlobal('fetch', telegramFetchMock());
  await request(app.server)
    .post(webhook)
    .send({ message: { chat: { id: TG_ID }, from: { id: TG_ID }, text: `/start ${token}` } });
  await request(app.server)
    .post(webhook)
    .send({ callback_query: { id: 'cbq-login', from: { id: TG_ID }, data: `confirm:${token}` } });
  vi.unstubAllGlobals();

  const status = await request(app.server)
    .get(`/api/v1/auth/telegram/status?token=${token}`)
    .set('Cookie', `tg_session=${session}`);
  expect(status.body.status).toBe('authenticated');
  expect(status.body.user.email).toBeNull();
  return { userId: status.body.user.id as string, accessToken: status.body.access_token as string };
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  const reg = async (email: string): Promise<string> => {
    const res = await request(app.server)
      .post('/api/v1/auth/register')
      .send({ email, password: PW, display_name: email });
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
  await reg(INVITEE_EMAIL);
  await reg(DECLINER_EMAIL);
  await reg(EXPIRED_EMAIL);

  workspaceSlug = `mi-ws-${TS}`;
  await request(app.server)
    .post('/api/v1/workspaces')
    .set(...auth(ownerToken))
    .send({ name: 'Member Invite WS', slug: workspaceSlug })
    .expect(201);

  await request(app.server)
    .post(membersBase())
    .set(...auth(ownerToken))
    .send({ user_id: await userId(adminToken), role: 'admin' })
    .expect(201);
  await request(app.server)
    .post(membersBase())
    .set(...auth(ownerToken))
    .send({ user_id: await userId(memberToken), role: 'member' })
    .expect(201);

  const tg = await createTelegramUser();
  tgUserId = tg.userId;
});

afterAll(async () => {
  // Deleting the workspace cascades its member invites + memberships. Then remove the
  // Telegram-only account (cascades its identity). Email accounts use unique suffixes
  // and are left behind, matching the other integration suites.
  await app.prisma.workspace.deleteMany({ where: { slug: workspaceSlug } });
  if (tgUserId) await app.prisma.user.deleteMany({ where: { id: tgUserId } });
  await app.close();
});

const login = async (email: string): Promise<string> => {
  const res = await request(app.server)
    .post('/api/v1/auth/login')
    .send({ email, password: PW })
    .expect(200);
  return res.body.access_token as string;
};

describe('POST /workspaces/:slug/members/invite-user', () => {
  it('admin can invite an existing user by email → delivered to email, pending invite created', async () => {
    const res = await request(app.server)
      .post(inviteUserUrl())
      .set(...auth(ownerToken))
      .send({ email: INVITEE_EMAIL, role: 'member' });
    expect(res.status).toBe(201);
    expect(res.body.invite).toMatchObject({ role: 'member', status: 'pending' });
    expect(res.body.invite.token).toBeUndefined(); // token is never exposed
    expect(res.body.delivered_to).toContain('email');
  });

  it('member cannot invite (403)', async () => {
    const res = await request(app.server)
      .post(inviteUserUrl())
      .set(...auth(memberToken))
      .send({ email: OUTSIDER_EMAIL });
    expect(res.status).toBe(403);
  });

  it('outsider cannot invite (403)', async () => {
    const res = await request(app.server)
      .post(inviteUserUrl())
      .set(...auth(outsiderToken))
      .send({ email: INVITEE_EMAIL });
    expect(res.status).toBe(403);
  });

  it('inviting yourself is rejected (400)', async () => {
    const res = await request(app.server)
      .post(inviteUserUrl())
      .set(...auth(ownerToken))
      .send({ email: OWNER_EMAIL });
    expect(res.status).toBe(400);
  });

  it('inviting an existing member returns 409', async () => {
    const res = await request(app.server)
      .post(inviteUserUrl())
      .set(...auth(ownerToken))
      .send({ email: MEMBER_EMAIL });
    expect(res.status).toBe(409);
  });

  it('rejects a body with neither user_id nor email (400)', async () => {
    const res = await request(app.server)
      .post(inviteUserUrl())
      .set(...auth(ownerToken))
      .send({ role: 'member' });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown target (404)', async () => {
    const res = await request(app.server)
      .post(inviteUserUrl())
      .set(...auth(ownerToken))
      .send({ user_id: '00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/invitations + accept/decline', () => {
  it('invitee sees the invite in their inbox and can accept → becomes a member', async () => {
    const inviteeToken = await login(INVITEE_EMAIL);

    const list = await request(app.server)
      .get(inbox)
      .set(...auth(inviteeToken))
      .expect(200);
    const entry = (list.body as Array<{ id: string; workspace: { slug: string } }>).find(
      (i) => i.workspace.slug === workspaceSlug,
    );
    expect(entry).toBeDefined();

    const accept = await request(app.server)
      .post(`${inbox}/${entry!.id}/accept`)
      .set(...auth(inviteeToken))
      .expect(200);
    expect(accept.body.member).toMatchObject({ role: 'member' });

    // Now a member of the workspace.
    const members = await request(app.server)
      .get(membersBase())
      .set(...auth(ownerToken))
      .expect(200);
    const emails = members.body.map((m: { user: { email: string } }) => m.user.email);
    expect(emails).toContain(INVITEE_EMAIL);

    // The invite is no longer pending, so it drops out of the inbox.
    const after = await request(app.server)
      .get(inbox)
      .set(...auth(inviteeToken))
      .expect(200);
    expect((after.body as Array<{ id: string }>).some((i) => i.id === entry!.id)).toBe(false);
  });

  it('a second accept of the same invite is idempotent (200)', async () => {
    const inviteeToken = await login(INVITEE_EMAIL);
    const invite = await app.prisma.workspaceMemberInvite.findFirst({
      where: { target_user_id: await meId(inviteeToken), status: 'accepted' },
    });
    const res = await request(app.server)
      .post(`${inbox}/${invite!.id}/accept`)
      .set(...auth(inviteeToken));
    expect(res.status).toBe(200);
    expect(res.body.member).toMatchObject({ role: 'member' });
  });

  it('decline does not create a membership', async () => {
    await request(app.server)
      .post(inviteUserUrl())
      .set(...auth(ownerToken))
      .send({ email: DECLINER_EMAIL, role: 'guest' })
      .expect(201);

    const declinerToken = await login(DECLINER_EMAIL);
    const list = await request(app.server)
      .get(inbox)
      .set(...auth(declinerToken))
      .expect(200);
    const entry = (list.body as Array<{ id: string; workspace: { slug: string } }>).find(
      (i) => i.workspace.slug === workspaceSlug,
    )!;

    const res = await request(app.server)
      .post(`${inbox}/${entry.id}/decline`)
      .set(...auth(declinerToken))
      .expect(200);
    expect(res.body.member).toBeNull();
    expect(res.body.invite.status).toBe('declined');

    const members = await request(app.server)
      .get(membersBase())
      .set(...auth(ownerToken))
      .expect(200);
    const emails = members.body.map((m: { user: { email: string } }) => m.user.email);
    expect(emails).not.toContain(DECLINER_EMAIL);
  });

  it('a user cannot act on an invite that is not theirs (404)', async () => {
    await request(app.server)
      .post(inviteUserUrl())
      .set(...auth(ownerToken))
      .send({ email: OUTSIDER_EMAIL, role: 'member' })
      .expect(201);
    const invite = await app.prisma.workspaceMemberInvite.findFirst({
      where: { target_user_id: await meId(await login(OUTSIDER_EMAIL)), status: 'pending' },
    });

    // The admin (a different user) tries to accept the outsider's invite.
    const res = await request(app.server)
      .post(`${inbox}/${invite!.id}/accept`)
      .set(...auth(adminToken));
    expect(res.status).toBe(404);
  });

  it('accepting an expired invite returns 410', async () => {
    const expiredToken = await login(EXPIRED_EMAIL);
    const invite = await app.prisma.workspaceMemberInvite.create({
      data: {
        workspace: { connect: { slug: workspaceSlug } },
        inviter: { connect: { email: OWNER_EMAIL } },
        target: { connect: { email: EXPIRED_EMAIL } },
        role: 'member',
        expires_at: new Date(Date.now() - 1000),
      },
    });
    const res = await request(app.server)
      .post(`${inbox}/${invite.id}/accept`)
      .set(...auth(expiredToken));
    expect(res.status).toBe(410);
  });

  it('requires authentication', async () => {
    await request(app.server).get(inbox).expect(401);
  });
});

describe('Telegram delivery + accept', () => {
  it('inviting a Telegram-only user pushes an Accept button and the callback tap joins them', async () => {
    const fetchMock = telegramFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const invite = await request(app.server)
      .post(inviteUserUrl())
      .set(...auth(ownerToken))
      .send({ user_id: tgUserId, role: 'member' });
    vi.unstubAllGlobals();

    expect(invite.status).toBe(201);
    expect(invite.body.delivered_to).toContain('telegram');

    // The bot was sent a message carrying the accept button (winv:a:<token>).
    const sendCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/sendMessage'));
    expect(sendCall).toBeTruthy();
    expect(JSON.stringify(sendCall![1])).toContain('winv:a:');

    // Fetch the token straight from the DB (never exposed over the API).
    const row = await app.prisma.workspaceMemberInvite.findFirst({
      where: { target_user_id: tgUserId, status: 'pending' },
    });
    expect(row).toBeTruthy();

    // A tap from a DIFFERENT telegram id must not join anyone.
    vi.stubGlobal('fetch', telegramFetchMock());
    await request(app.server)
      .post(webhook)
      .send({
        callback_query: { id: 'cbq-wrong', from: { id: TG_ID + 1 }, data: `winv:a:${row!.token}` },
      })
      .expect(200);
    vi.unstubAllGlobals();
    let member = await app.prisma.workspaceMember.findUnique({
      where: {
        workspace_id_user_id: { workspace_id: row!.workspace_id, user_id: tgUserId },
      },
    });
    expect(member).toBeNull();

    // The real invitee taps Accept → membership created.
    vi.stubGlobal('fetch', telegramFetchMock());
    await request(app.server)
      .post(webhook)
      .send({
        callback_query: { id: 'cbq-accept', from: { id: TG_ID }, data: `winv:a:${row!.token}` },
      })
      .expect(200);
    vi.unstubAllGlobals();

    member = await app.prisma.workspaceMember.findUnique({
      where: {
        workspace_id_user_id: { workspace_id: row!.workspace_id, user_id: tgUserId },
      },
    });
    expect(member).toMatchObject({ role: 'member' });

    const updated = await app.prisma.workspaceMemberInvite.findUnique({ where: { id: row!.id } });
    expect(updated?.status).toBe('accepted');
  });
});

/** Resolve the authenticated user's id via /auth/me. */
async function meId(token: string): Promise<string> {
  const res = await request(app.server)
    .get('/api/v1/auth/me')
    .set(...auth(token));
  return res.body.id as string;
}
