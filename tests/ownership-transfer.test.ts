// Handing a workspace over (Ф12 12.B3, ADR-034):
//   - only the owner may ask for a code and transfer (admin → 403);
//   - the new owner must be an active member and not a guest — refused before the
//     code is checked, so a wrong choice does not use the code up;
//   - a wrong code is refused; the right one swaps the roles in one go: the new owner
//     gets `owner` and `Workspace.owner_id`, the former owner becomes an admin;
//   - the former owner can then leave (1.B6), the new one cannot;
//   - an owner without email gets the code through the Telegram bot;
//   - the transfer is in the audit log, without the code.
//
// Runs against a live Postgres; created rows are removed in afterAll.

import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { signAccessToken } from '../src/lib/jwt.js';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `own-${TS}`;
const TG_SLUG = `own-tg-${TS}`;
const TG_ID = String(TS + 7);
const emails = {
  owner: `own-owner-${TS}@example.com`,
  admin: `own-admin-${TS}@example.com`,
  member: `own-member-${TS}@example.com`,
  guest: `own-guest-${TS}@example.com`,
  off: `own-off-${TS}@example.com`,
  outsider: `own-out-${TS}@example.com`,
};

type Actor = { id: string; token: string };
let app: FastifyInstance;
const a = {} as Record<keyof typeof emails, Actor>;
let tgOwner: Actor;
let consoleSpy: ReturnType<typeof vi.spyOn>;

const api = (path: string, slug = SLUG) => `/api/v1/workspaces/${slug}${path}`;

function as(actor: Actor) {
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${actor.token}`);
  return {
    get: (url: string) => auth(request(app.server).get(url)),
    post: (url: string, body?: object) => auth(request(app.server).post(url)).send(body ?? {}),
  };
}

/** The most recent 6-digit code the dev mailer printed. */
function lastCode(): string {
  const text = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
  const codes = text.match(/\b\d{6}\b/g);
  if (!codes) throw new Error('No code in the mailer output');
  return codes[codes.length - 1]!;
}

/** Let the next code be sent at once (one code per minute per address). */
async function allowNextCode(userEmail: string | null, userId?: string): Promise<void> {
  await app.prisma.emailOtp.updateMany({
    where: userEmail ? { email: userEmail } : { user_id: userId },
    data: { created_at: new Date(Date.now() - 2 * 60_000) },
  });
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  for (const [key, email] of Object.entries(emails)) {
    const res = await request(app.server)
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, display_name: email.split('@')[0] });
    expect(res.status).toBe(201);
    a[key as keyof typeof emails] = { id: res.body.user.id, token: res.body.access_token };
  }
  const ws = await as(a.owner).post('/api/v1/workspaces', { name: 'Владение', slug: SLUG });
  expect(ws.status).toBe(201);
  await as(a.owner).post(api('/members'), { user_id: a.admin.id, role: 'admin' });
  await as(a.owner).post(api('/members'), { user_id: a.member.id, role: 'member' });
  await as(a.owner).post(api('/members'), { user_id: a.guest.id, role: 'guest' });
  await as(a.owner).post(api('/members'), { user_id: a.off.id, role: 'member' });
  const off = await as(a.owner).post(api(`/members/${a.off.id}/deactivate`));
  expect(off.status).toBe(200);

  // A Telegram-only owner (no email): the code goes through the bot.
  const user = await app.prisma.user.create({
    data: { display_name: 'Владелец из Telegram', email: null },
  });
  await app.prisma.authIdentity.create({
    data: { user_id: user.id, provider: 'telegram', provider_user_id: TG_ID },
  });
  const session = await app.prisma.authSession.create({
    data: { user_id: user.id, expires_at: new Date(Date.now() + 3_600_000) },
  });
  tgOwner = { id: user.id, token: signAccessToken(user.id, session.id) };
  const tgWs = await as(tgOwner).post('/api/v1/workspaces', { name: 'Бот', slug: TG_SLUG });
  expect(tgWs.status).toBe(201);
  await as(tgOwner).post(api('/members', TG_SLUG), { user_id: a.member.id, role: 'member' });
});

afterAll(async () => {
  const ids = [...Object.values(a).map((x) => x.id), tgOwner.id];
  await app.prisma.workspace.deleteMany({ where: { slug: { in: [SLUG, TG_SLUG] } } });
  await app.prisma.emailOtp.deleteMany({
    where: { OR: [{ email: { in: Object.values(emails) } }, { user_id: { in: ids } }] },
  });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  await app.close();
});

beforeEach(() => {
  consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe('who may transfer', () => {
  it('an admin can neither ask for a code nor transfer', async () => {
    const code = await as(a.admin).post(api('/transfer-ownership/code'));
    expect(code.status).toBe(403);
    const transfer = await as(a.admin).post(api('/transfer-ownership'), {
      user_id: a.admin.id,
      code: '123456',
    });
    expect(transfer.status).toBe(403);
  });

  it('an outsider gets no access at all', async () => {
    const res = await as(a.outsider).post(api('/transfer-ownership/code'));
    expect(res.status).toBe(403);
  });
});

describe('the transfer', () => {
  it('refuses a wrong new owner before checking the code, then a wrong code', async () => {
    const sent = await as(a.owner).post(api('/transfer-ownership/code'));
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ status: 'otp_sent', channel: 'email', email: emails.owner });
    const code = lastCode();

    for (const [userId, reason] of [
      [a.owner.id, 'already_owner'],
      [a.outsider.id, 'not_member'],
      [a.off.id, 'deactivated'],
      [a.guest.id, 'guest'],
    ] as const) {
      const res = await as(a.owner).post(api('/transfer-ownership'), { user_id: userId, code });
      expect(res.status, reason).toBe(400);
      expect(res.body.error.code).toBe('NEW_OWNER_INVALID');
      expect(res.body.error.details.reason).toBe(reason);
    }

    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    const bad = await as(a.owner).post(api('/transfer-ownership'), {
      user_id: a.member.id,
      code: wrong,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('OTP_INVALID');

    // Nothing changed so far.
    const ws = await app.prisma.workspace.findUniqueOrThrow({ where: { slug: SLUG } });
    expect(ws.owner_id).toBe(a.owner.id);
  });

  it('a valid code hands the workspace over and keeps the former owner as an admin', async () => {
    await allowNextCode(emails.owner);
    await as(a.owner).post(api('/transfer-ownership/code'));
    const res = await as(a.owner).post(api('/transfer-ownership'), {
      user_id: a.member.id,
      code: lastCode(),
    });
    expect(res.status).toBe(200);
    expect(res.body.workspace.owner_id).toBe(a.member.id);
    expect(res.body.new_owner).toMatchObject({ user_id: a.member.id, role: 'owner' });
    expect(res.body.previous_owner).toMatchObject({ user_id: a.owner.id, role: 'admin' });

    const owners = await app.prisma.workspaceMember.findMany({
      where: { workspace: { slug: SLUG }, role: 'owner' },
    });
    expect(owners.map((m) => m.user_id)).toEqual([a.member.id]);

    // The former owner is no longer the owner: no more codes for them.
    const again = await as(a.owner).post(api('/transfer-ownership/code'));
    expect(again.status).toBe(403);
  });

  it('is written to the audit log without the code', async () => {
    const entry = await app.prisma.auditLog.findFirst({
      where: { action: 'workspace.ownership_transferred', actor_id: a.owner.id },
      orderBy: { created_at: 'desc' },
    });
    expect(entry).toMatchObject({ target_type: 'user', target_id: a.member.id });
    expect(JSON.stringify(entry?.meta)).not.toContain('code');
  });

  it('the former owner may now leave; the new owner may not', async () => {
    const newOwnerLeaves = await as(a.member).post(api('/leave'));
    expect(newOwnerLeaves.status).toBe(403);
    expect(newOwnerLeaves.body.error.code).toBe('OWNER_CANNOT_LEAVE');

    const formerLeaves = await as(a.owner).post(api('/leave'));
    expect(formerLeaves.status).toBe(204);
  });
});

describe('an owner without email', () => {
  it('gets the code through the Telegram bot and can transfer with it', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).startsWith('https://api.telegram.org/bot')) {
        return { ok: true, json: async () => ({ ok: true, result: {} }) };
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const sent = await as(tgOwner).post(api('/transfer-ownership/code', TG_SLUG));
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ status: 'otp_sent', channel: 'telegram' });
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/sendMessage'));
    const body = JSON.parse(String((call?.[1] as RequestInit).body)) as {
      chat_id: number;
      text: string;
    };
    expect(body.chat_id).toBe(Number(TG_ID));
    expect(body.text).toContain('передачи владения');
    const code = body.text.match(/\b\d{6}\b/)?.[0];
    expect(code).toBeDefined();

    const res = await as(tgOwner).post(api('/transfer-ownership', TG_SLUG), {
      user_id: a.member.id,
      code,
    });
    expect(res.status).toBe(200);
    expect(res.body.workspace.owner_id).toBe(a.member.id);
  });
});
