// Integration tests for the Ф1 stabilization pass (ROADMAP.md, docs/roadmap/phase-01):
//   - 1.B1 links in invite emails point at the SPA (FRONTEND_URL), not the API host;
//   - 1.B2 passwordless email sign-in (request code → verify → session);
//   - 1.B3 refresh-token reuse detection revokes the whole session family;
//   - 1.B6 leaving a workspace (owner cannot leave).
//
// Runs against a live Postgres. OTP codes and email bodies are read from the console
// stub the mailer logs in dev/test. All created rows are removed in afterAll.

import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const emails = {
  otpNew: `stab-otp-new-${TS}@example.com`,
  owner: `stab-owner-${TS}@example.com`,
  member: `stab-member-${TS}@example.com`,
  invitee: `stab-invitee-${TS}@example.com`,
  reuse: `stab-reuse-${TS}@example.com`,
};
const SLUG = `stab-ws-${TS}`;

let app: FastifyInstance;
let consoleSpy: ReturnType<typeof vi.spyOn>;
let firstCode = '';
let usedCode = '';

function consoleText(): string {
  return consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

/** The most recent 6-digit code in the captured console output. */
function lastOtp(): string {
  const matches = consoleText().match(/\b\d{6}\b/g);
  if (!matches || matches.length === 0) throw new Error('No OTP found in console output');
  return matches[matches.length - 1]!;
}

async function register(email: string): Promise<{ id: string; token: string; refresh: string }> {
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, display_name: email.split('@')[0] });
  expect(res.status).toBe(201);
  return { id: res.body.user.id, token: res.body.access_token, refresh: res.body.refresh_token };
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  const list = Object.values(emails);
  await app.prisma.workspace.deleteMany({ where: { slug: SLUG } });
  await app.prisma.workspaceInvite.deleteMany({ where: { email: { in: list } } });
  await app.prisma.refreshToken.deleteMany({ where: { user: { email: { in: list } } } });
  await app.prisma.authIdentity.deleteMany({ where: { user: { email: { in: list } } } });
  await app.prisma.emailOtp.deleteMany({ where: { email: { in: list } } });
  await app.prisma.user.deleteMany({ where: { email: { in: list } } });
  await app.close();
});

beforeEach(() => {
  consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
});

describe('1.B2 passwordless email sign-in', () => {
  it('requests a code for a new address without revealing that it is new', async () => {
    const res = await request(app.server)
      .post('/api/v1/auth/email/otp/request')
      .send({ email: emails.otpNew, display_name: 'Иванов Иван' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'otp_sent', email: emails.otpNew });

    const user = await app.prisma.user.findUnique({ where: { email: emails.otpNew } });
    expect(user?.is_active).toBe(false);
    expect(user?.password_hash).toBeNull();
    expect(user?.display_name).toBe('Иванов Иван');
    firstCode = lastOtp();
  });

  it('rejects a wrong code with OTP_INVALID', async () => {
    const wrong = firstCode === '000000' ? '111111' : '000000';
    const res = await request(app.server)
      .post('/api/v1/auth/email/otp/verify')
      .send({ email: emails.otpNew, code: wrong });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OTP_INVALID');
  });

  it('verifies the code, activates the account and issues a session', async () => {
    // Re-request so the code is in this test's console capture (step past the 60 s
    // per-email throttle by back-dating the previous code row).
    await app.prisma.emailOtp.updateMany({
      where: { email: emails.otpNew },
      data: { created_at: new Date(Date.now() - 2 * 60 * 1000) },
    });
    await request(app.server).post('/api/v1/auth/email/otp/request').send({ email: emails.otpNew });

    usedCode = lastOtp();
    const res = await request(app.server)
      .post('/api/v1/auth/email/otp/verify')
      .send({ email: emails.otpNew, code: usedCode });

    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.user.email).toBe(emails.otpNew);
    expect(res.headers['set-cookie']?.toString()).toContain(config.SESSION_COOKIE_NAME);

    const user = await app.prisma.user.findUnique({ where: { email: emails.otpNew } });
    expect(user?.is_active).toBe(true);
    expect(user?.email_verified).toBe(true);
  });

  it('a code cannot be reused', async () => {
    const res = await request(app.server)
      .post('/api/v1/auth/email/otp/verify')
      .send({ email: emails.otpNew, code: usedCode });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OTP_NOT_FOUND');
  });
});

describe('1.B6 leave workspace + 1.B1 invite links', () => {
  let owner: { id: string; token: string };
  let member: { id: string; token: string };

  beforeAll(async () => {
    owner = await register(emails.owner);
    member = await register(emails.member);

    const ws = await request(app.server)
      .post('/api/v1/workspaces')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Stabilization', slug: SLUG });
    expect(ws.status).toBe(201);

    const add = await request(app.server)
      .post(`/api/v1/workspaces/${SLUG}/members`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ user_id: member.id, role: 'member' });
    expect(add.status).toBe(201);
  });

  it('the email invite links to the SPA invite page', async () => {
    const res = await request(app.server)
      .post(`/api/v1/workspaces/${SLUG}/members/invite`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: emails.invitee, role: 'member' });

    expect(res.status).toBe(201);
    const base = config.FRONTEND_URL.replace(/\/+$/, '');
    expect(consoleText()).toContain(`${base}/invites/${res.body.token}`);
    expect(consoleText()).not.toContain(`${config.PUBLIC_BASE_URL}/invites/`);
  });

  it('a member can leave', async () => {
    const res = await request(app.server)
      .post(`/api/v1/workspaces/${SLUG}/leave`)
      .set('Authorization', `Bearer ${member.token}`);

    expect(res.status).toBe(204);
    const workspace = await app.prisma.workspace.findUniqueOrThrow({ where: { slug: SLUG } });
    const row = await app.prisma.workspaceMember.findUnique({
      where: { workspace_id_user_id: { workspace_id: workspace.id, user_id: member.id } },
    });
    expect(row).toBeNull();
  });

  it('after leaving, the workspace is no longer accessible', async () => {
    const res = await request(app.server)
      .get(`/api/v1/workspaces/${SLUG}`)
      .set('Authorization', `Bearer ${member.token}`);
    expect([403, 404]).toContain(res.status);
  });

  it('the owner cannot leave', async () => {
    const res = await request(app.server)
      .post(`/api/v1/workspaces/${SLUG}/leave`)
      .set('Authorization', `Bearer ${owner.token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('OWNER_CANNOT_LEAVE');
  });
});

describe('1.B3 refresh-token reuse detection', () => {
  it('replaying a rotated refresh token revokes every session of the user', async () => {
    const user = await register(emails.reuse);

    const first = await request(app.server)
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: user.refresh });
    expect(first.status).toBe(200);
    const rotated: string = first.body.refresh_token;

    // Move the old token's revocation outside the multi-tab grace window.
    await app.prisma.refreshToken.updateMany({
      where: { user_id: user.id, revoked_at: { not: null } },
      data: { revoked_at: new Date(Date.now() - 60 * 1000) },
    });

    const replay = await request(app.server)
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: user.refresh });
    expect(replay.status).toBe(401);

    // The legitimate, newer token is now revoked too.
    const afterTheft = await request(app.server)
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: rotated });
    expect(afterTheft.status).toBe(401);
  });
});
