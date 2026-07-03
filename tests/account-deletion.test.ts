// Integration tests for code-confirmed account deletion.
//
// Flow: an authenticated user requests deletion (POST /auth/account/delete/request),
// receives a 6-digit code by email, then confirms it (POST /auth/account/delete/confirm).
// As with the signup OTP, the plaintext code is never returned by the API — the dev/test
// mailer logs it to the console, so we spy on console.info and read it back. Deletion is a
// soft-delete + anonymize: the row stays (authored content keeps its FK) but every login
// path is severed and PII is scrubbed. Cleanup is by user id (the email is nulled out).

import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';

let app: FastifyInstance;
let consoleSpy: ReturnType<typeof vi.spyOn>;
const createdUserIds: string[] = [];
const emails: string[] = [];

/** Pull the most recent 6-digit code out of the captured console output. */
function lastOtp(): string {
  const text = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
  const matches = text.match(/\b\d{6}\b/g);
  if (!matches || matches.length === 0) throw new Error('No OTP found in console output');
  return matches[matches.length - 1]!;
}

/** Register a fresh account (no OTP) and return its access token + id. */
async function registerUser(email: string): Promise<{ token: string; userId: string }> {
  emails.push(email);
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, display_name: 'Delete Me' });
  expect(res.status).toBe(201);
  createdUserIds.push(res.body.user.id);
  return { token: res.body.access_token, userId: res.body.user.id };
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.prisma.emailOtp.deleteMany({ where: { email: { in: emails } } });
  await app.prisma.workspace.deleteMany({ where: { owner_id: { in: createdUserIds } } });
  await app.prisma.refreshToken.deleteMany({ where: { user_id: { in: createdUserIds } } });
  await app.prisma.authIdentity.deleteMany({ where: { user_id: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

beforeEach(() => {
  consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
});

describe('code-confirmed account deletion', () => {
  it('requires authentication', async () => {
    const res = await request(app.server).post('/api/v1/auth/account/delete/request').send();
    expect(res.status).toBe(401);
  });

  it('request → confirm soft-deletes and scrubs the account', async () => {
    const email = `del-happy-${TS}@example.com`;
    const { token, userId } = await registerUser(email);

    const reqRes = await request(app.server)
      .post('/api/v1/auth/account/delete/request')
      .set('Authorization', `Bearer ${token}`)
      .send();
    expect(reqRes.status).toBe(200);
    expect(reqRes.body).toEqual({ status: 'otp_sent', email });
    const code = lastOtp();

    // A wrong code is rejected but does not consume the still-valid code (cap is 5).
    const wrong = await request(app.server)
      .post('/api/v1/auth/account/delete/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '000000' });
    expect(wrong.status).toBe(400);

    const confirm = await request(app.server)
      .post('/api/v1/auth/account/delete/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ code });
    expect(confirm.status).toBe(204);

    // The row survives (referential integrity) but is fully scrubbed + deactivated.
    const user = await app.prisma.user.findUnique({ where: { id: userId } });
    expect(user).toBeTruthy();
    expect(user?.email).toBeNull();
    expect(user?.password_hash).toBeNull();
    expect(user?.email_verified).toBe(false);
    expect(user?.is_active).toBe(false);
    expect(user?.display_name).toBe('Deleted user');

    // Login methods and sessions are gone.
    expect(await app.prisma.authIdentity.count({ where: { user_id: userId } })).toBe(0);
    expect(await app.prisma.refreshToken.count({ where: { user_id: userId } })).toBe(0);

    // The freed email can no longer be used to sign in.
    const login = await request(app.server)
      .post('/api/v1/auth/email/login')
      .send({ email, password: PASSWORD });
    expect(login.status).toBe(401);
  });

  it('deletes the account but keeps owned workspaces + memberships (shown as a deleted user)', async () => {
    const email = `del-owner-${TS}@example.com`;
    const { token, userId } = await registerUser(email);

    // The user owns a workspace and is a member of it.
    const ws = await app.prisma.workspace.create({
      data: { name: 'Owned WS', slug: `del-owned-ws-${TS}`, owner_id: userId },
    });
    await app.prisma.workspaceMember.create({
      data: { workspace_id: ws.id, user_id: userId, role: 'owner' },
    });

    const reqRes = await request(app.server)
      .post('/api/v1/auth/account/delete/request')
      .set('Authorization', `Bearer ${token}`)
      .send();
    expect(reqRes.status).toBe(200);
    const code = lastOtp();

    const confirm = await request(app.server)
      .post('/api/v1/auth/account/delete/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ code });
    expect(confirm.status).toBe(204);

    // The person is erased (anonymized)...
    const user = await app.prisma.user.findUnique({ where: { id: userId } });
    expect(user?.email).toBeNull();
    expect(user?.display_name).toBe('Deleted user');

    // ...but the workspace they owned and their membership survive — now attributed to
    // the deleted user rather than removed.
    const wsAfter = await app.prisma.workspace.findUnique({ where: { id: ws.id } });
    expect(wsAfter?.owner_id).toBe(userId);
    const membership = await app.prisma.workspaceMember.findUnique({
      where: { workspace_id_user_id: { workspace_id: ws.id, user_id: userId } },
    });
    expect(membership).toBeTruthy();
  });
});
