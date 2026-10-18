// Integration tests for code-confirmed account deletion.
//
// Flow: an authenticated user requests deletion (POST /auth/account/delete/request),
// receives a 6-digit code, then confirms it (POST /auth/account/delete/confirm). The
// code reaches the user on whatever channel their account has: email (email/Google/
// GitHub accounts) or the Telegram bot (Telegram-only, no-email accounts). The
// plaintext code is never returned by the API — the dev/test mailer logs it to the
// console (we spy on console.info), and the bot "sends" it via the Bot API (we mock
// fetch and read it back). Deletion is a soft-delete + anonymize: the row stays (so
// authored content keeps its FK) but every login path is severed and PII is scrubbed.
// A workspace the user solely owns is auto-transferred to another member first (or
// deleted when no one else is left). Cleanup is by user id (the email is nulled out).

import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { signAccessToken } from '../src/lib/jwt.js';
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

/** A fetch mock that accepts any Telegram Bot API call and reports success. */
function telegramFetchMock(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    if (String(url).startsWith('https://api.telegram.org/bot')) {
      return { ok: true, json: async () => ({ ok: true }) };
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
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
  await app.prisma.emailOtp.deleteMany({ where: { user_id: { in: createdUserIds } } });
  await app.prisma.workspace.deleteMany({ where: { owner_id: { in: createdUserIds } } });
  await app.prisma.workspaceMember.deleteMany({ where: { user_id: { in: createdUserIds } } });
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
  vi.unstubAllGlobals();
});

describe('code-confirmed account deletion', () => {
  it('requires authentication', async () => {
    const res = await request(app.server).post('/api/v1/auth/account/delete/request').send();
    expect(res.status).toBe(401);
  });

  it('request → confirm soft-deletes and scrubs an email account', async () => {
    const email = `del-happy-${TS}@example.com`;
    const { token, userId } = await registerUser(email);

    // An uploaded photo (3.B5) — deleting the account removes the file too.
    const slot = await request(app.server)
      .post('/api/v1/auth/me/avatar')
      .set('Authorization', `Bearer ${token}`)
      .send({ mime_type: 'image/jpeg', size: 16 });
    const photoPath = new URL(slot.body.upload.url).pathname;
    await request(app.server)
      .put(photoPath)
      .set('Content-Type', 'image/jpeg')
      .send(
        Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]),
      );
    const withPhoto = await request(app.server)
      .patch('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ avatar_url: slot.body.url });
    expect(withPhoto.status).toBe(200);

    const reqRes = await request(app.server)
      .post('/api/v1/auth/account/delete/request')
      .set('Authorization', `Bearer ${token}`)
      .send();
    expect(reqRes.status).toBe(200);
    expect(reqRes.body).toEqual({ status: 'otp_sent', channel: 'email', email });
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
    expect(user?.avatar_url).toBeNull();
    expect((await request(app.server).get(photoPath)).status).toBe(404);

    // Login methods and sessions are gone.
    expect(await app.prisma.authIdentity.count({ where: { user_id: userId } })).toBe(0);
    expect(await app.prisma.refreshToken.count({ where: { user_id: userId } })).toBe(0);

    // The freed email can no longer be used to sign in.
    const login = await request(app.server)
      .post('/api/v1/auth/email/login')
      .send({ email, password: PASSWORD });
    expect(login.status).toBe(401);
  });

  it('deletes a Telegram-only (no-email) account via a code sent through the bot', async () => {
    // A Telegram account has no email — build one directly (id + telegram identity) and
    // mint a session for it, then drive the delete flow with the bot as the channel.
    const tgId = TS + 1;
    const user = await app.prisma.user.create({
      data: { display_name: 'TG Delete', email_verified: false },
    });
    createdUserIds.push(user.id);
    await app.prisma.authIdentity.create({
      data: { user_id: user.id, provider: 'telegram', provider_user_id: String(tgId) },
    });
    const token = signAccessToken(user.id);

    // The bot "sends" the code; capture the Bot API sendMessage so we can read it back.
    const fetchMock = telegramFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const reqRes = await request(app.server)
      .post('/api/v1/auth/account/delete/request')
      .set('Authorization', `Bearer ${token}`)
      .send();
    expect(reqRes.status).toBe(200);
    expect(reqRes.body).toEqual({ status: 'otp_sent', channel: 'telegram' });

    const sendCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/sendMessage'));
    expect(sendCall).toBeTruthy();
    const sentTo = JSON.parse((sendCall![1] as { body: string }).body) as {
      chat_id: number;
      text: string;
    };
    expect(sentTo.chat_id).toBe(tgId); // delivered to the linked telegram id
    const code = sentTo.text.match(/\b\d{6}\b/)![0];
    vi.unstubAllGlobals();

    // No fetch is needed to confirm — verification is local.
    const confirm = await request(app.server)
      .post('/api/v1/auth/account/delete/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ code });
    expect(confirm.status).toBe(204);

    const after = await app.prisma.user.findUnique({ where: { id: user.id } });
    expect(after).toBeTruthy();
    expect(after?.display_name).toBe('Deleted user');
    expect(after?.is_active).toBe(false);
    expect(await app.prisma.authIdentity.count({ where: { user_id: user.id } })).toBe(0);
    expect(await app.prisma.refreshToken.count({ where: { user_id: user.id } })).toBe(0);
  });

  it('rejects deletion for an account with neither email nor Telegram', async () => {
    // e.g. a GitHub account whose email stayed private and nothing else linked.
    const user = await app.prisma.user.create({
      data: { display_name: 'No Channel', email_verified: false },
    });
    createdUserIds.push(user.id);
    await app.prisma.authIdentity.create({
      data: { user_id: user.id, provider: 'github', provider_user_id: `gh-${TS + 2}` },
    });
    const token = signAccessToken(user.id);

    const res = await request(app.server)
      .post('/api/v1/auth/account/delete/request')
      .set('Authorization', `Bearer ${token}`)
      .send();
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/link an email or telegram/i);
  });

  it('auto-transfers a solely-owned workspace to another member on deletion', async () => {
    const owner = await registerUser(`del-owner-${TS}@example.com`);
    const heir = await registerUser(`del-heir-${TS}@example.com`);

    const ws = await app.prisma.workspace.create({
      data: { name: 'Owned WS', slug: `del-owned-ws-${TS}`, owner_id: owner.userId },
    });
    await app.prisma.workspaceMember.create({
      data: { workspace_id: ws.id, user_id: owner.userId, role: 'owner' },
    });
    await app.prisma.workspaceMember.create({
      data: { workspace_id: ws.id, user_id: heir.userId, role: 'admin' },
    });

    const reqRes = await request(app.server)
      .post('/api/v1/auth/account/delete/request')
      .set('Authorization', `Bearer ${owner.token}`)
      .send();
    expect(reqRes.status).toBe(200);
    const code = lastOtp();

    const confirm = await request(app.server)
      .post('/api/v1/auth/account/delete/confirm')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ code });
    expect(confirm.status).toBe(204);

    // Ownership handed to the remaining member, who is promoted to owner...
    const wsAfter = await app.prisma.workspace.findUnique({ where: { id: ws.id } });
    expect(wsAfter?.owner_id).toBe(heir.userId);
    const heirMembership = await app.prisma.workspaceMember.findUnique({
      where: { workspace_id_user_id: { workspace_id: ws.id, user_id: heir.userId } },
    });
    expect(heirMembership?.role).toBe('owner');

    // ...and the departing owner has left the workspace (single-owner invariant kept).
    const ownerMembership = await app.prisma.workspaceMember.findUnique({
      where: { workspace_id_user_id: { workspace_id: ws.id, user_id: owner.userId } },
    });
    expect(ownerMembership).toBeNull();
  });

  it('deletes a solely-owned workspace with no other members on deletion', async () => {
    const { token, userId } = await registerUser(`del-solo-${TS}@example.com`);

    const ws = await app.prisma.workspace.create({
      data: { name: 'Solo WS', slug: `del-solo-ws-${TS}`, owner_id: userId },
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

    // Nobody left to own it — the workspace (and its membership) is gone.
    const wsAfter = await app.prisma.workspace.findUnique({ where: { id: ws.id } });
    expect(wsAfter).toBeNull();
    // The user row itself survives, anonymized.
    const user = await app.prisma.user.findUnique({ where: { id: userId } });
    expect(user?.display_name).toBe('Deleted user');
  });
});
