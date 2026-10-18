// Integration tests for sign-in sessions (Ф12 12.B2): «Мои сессии» in the profile.
//   - a sign-in opens a session with its method, IP and device; refresh keeps it;
//   - GET /auth/sessions lists the account's live sessions, the current one first;
//   - ending a session (one, or every other) cuts its access tokens off at once,
//     revokes its refresh tokens and closes its live-update stream;
//   - sign-out and refresh-token theft end only their own session;
//   - another account's session cannot be ended; actions land in the audit log.
//
// Runs against a live Postgres; created rows are removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { signAccessToken } from '../src/lib/jwt.js';
import { describeUserAgent } from '../src/lib/user-agent.js';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `sess-${TS}`;
const emails = {
  main: `sess-main-${TS}@example.com`,
  other: `sess-other-${TS}@example.com`,
};
const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

type Login = { userId: string; token: string; refresh: string };

let app: FastifyInstance;
let base: string;

async function login(email: string, userAgent = CHROME_WIN): Promise<Login> {
  const res = await request(app.server)
    .post('/api/v1/auth/login')
    .set('User-Agent', userAgent)
    .send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return {
    userId: res.body.user.id,
    token: res.body.access_token,
    refresh: res.body.refresh_token,
  };
}

const sessions = (token: string) =>
  request(app.server).get('/api/v1/auth/sessions').set('Authorization', `Bearer ${token}`);
const me = (token: string) =>
  request(app.server).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
const refresh = (refreshToken: string, userAgent = CHROME_WIN) =>
  request(app.server)
    .post('/api/v1/auth/refresh')
    .set('User-Agent', userAgent)
    .send({ refresh_token: refreshToken });

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  for (const email of Object.values(emails)) {
    const res = await request(app.server)
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, display_name: email.split('@')[0] });
    expect(res.status).toBe(201);
  }
});

afterAll(async () => {
  const list = Object.values(emails);
  await app.prisma.workspace.deleteMany({ where: { slug: SLUG } });
  await app.prisma.user.deleteMany({ where: { email: { in: list } } });
  await app.close();
});

describe('sessions are opened at sign-in and kept by refresh', () => {
  it('lists the session with its method and device, marked current', async () => {
    const a = await login(emails.main);
    const res = await sessions(a.token);
    expect(res.status).toBe(200);
    const current = res.body.data.find((s: { current: boolean }) => s.current);
    expect(current).toMatchObject({
      method: 'password',
      browser: 'Chrome 128',
      os: 'Windows',
      mobile: false,
      user_agent: CHROME_WIN,
    });
    expect(current.ip).toBeTruthy();
    expect(res.body.data[0].id).toBe(current.id);
  });

  it('refresh keeps the session id and moves last activity forward', async () => {
    const a = await login(emails.main, SAFARI_IPHONE);
    const before = (await sessions(a.token)).body.data.find((s: { current: boolean }) => s.current);

    await new Promise((r) => setTimeout(r, 20));
    const rotated = await refresh(a.refresh, SAFARI_IPHONE);
    expect(rotated.status).toBe(200);
    const after = (await sessions(rotated.body.access_token)).body.data.find(
      (s: { current: boolean }) => s.current,
    );
    expect(after.id).toBe(before.id);
    expect(after).toMatchObject({ browser: 'Safari 17', os: 'iOS', mobile: true });
    expect(new Date(after.last_used_at).getTime()).toBeGreaterThan(
      new Date(before.last_used_at).getTime(),
    );
    // The access token from before the refresh is still valid: same live session.
    expect((await me(a.token)).status).toBe(200);
  });

  it('a session that has signed out is not listed', async () => {
    const a = await login(emails.main);
    const b = await login(emails.main);
    const out = await request(app.server)
      .post('/api/v1/auth/logout')
      .send({ refresh_token: b.refresh });
    expect(out.status).toBe(204);

    const listed = (await sessions(a.token)).body.data.map((s: { id: string }) => s.id);
    const bSession = await app.prisma.refreshToken.findFirst({
      where: { user_id: b.userId },
      orderBy: { created_at: 'desc' },
      select: { session_id: true },
    });
    expect(listed).not.toContain(bSession?.session_id);
    // Sign-out ends the session: its access token stops working at once.
    const after = await me(b.token);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('SESSION_REVOKED');
  });
});

describe('ending a session', () => {
  it('cuts off its access token and refresh token, other sessions keep working', async () => {
    const laptop = await login(emails.main);
    const phone = await login(emails.main, SAFARI_IPHONE);
    const list = (await sessions(laptop.token)).body.data;
    const phoneSession = list.find(
      (s: { current: boolean; os: string }) => !s.current && s.os === 'iOS',
    );
    expect(phoneSession).toBeTruthy();

    const res = await request(app.server)
      .delete(`/api/v1/auth/sessions/${phoneSession.id}`)
      .set('Authorization', `Bearer ${laptop.token}`);
    expect(res.status).toBe(204);
    // The laptop is not signed out by ending another session.
    expect(res.headers['set-cookie']).toBeUndefined();

    const phoneMe = await me(phone.token);
    expect(phoneMe.status).toBe(401);
    expect(phoneMe.body.error.code).toBe('SESSION_REVOKED');
    // Its refresh says why too, so the device can tell the user.
    const phoneRefresh = await refresh(phone.refresh);
    expect(phoneRefresh.status).toBe(401);
    expect(phoneRefresh.body.error.code).toBe('SESSION_REVOKED');
    expect((await me(laptop.token)).status).toBe(200);

    const audit = await app.prisma.auditLog.findFirst({
      where: { actor_id: laptop.userId, action: 'auth.session_revoked' },
      orderBy: { created_at: 'desc' },
    });
    expect(audit?.meta).toMatchObject({ session_id: phoneSession.id, current: false });
  });

  it('ending the current session signs this device out and clears the cookie', async () => {
    const a = await login(emails.main);
    const current = (await sessions(a.token)).body.data.find(
      (s: { current: boolean }) => s.current,
    );
    const res = await request(app.server)
      .delete(`/api/v1/auth/sessions/${current.id}`)
      .set('Authorization', `Bearer ${a.token}`);
    expect(res.status).toBe(204);
    expect(String(res.headers['set-cookie'])).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect((await me(a.token)).status).toBe(401);
  });

  it("another account's session cannot be ended (404) and stays live", async () => {
    const mine = await login(emails.main);
    const theirs = await login(emails.other);
    const theirSession = (await sessions(theirs.token)).body.data.find(
      (s: { current: boolean }) => s.current,
    );
    const res = await request(app.server)
      .delete(`/api/v1/auth/sessions/${theirSession.id}`)
      .set('Authorization', `Bearer ${mine.token}`);
    expect(res.status).toBe(404);
    expect((await me(theirs.token)).status).toBe(200);
    // Nor are they listed to someone else.
    const listed = (await sessions(mine.token)).body.data.map((s: { id: string }) => s.id);
    expect(listed).not.toContain(theirSession.id);
  });

  it('requires a session (401 without a token)', async () => {
    expect((await request(app.server).get('/api/v1/auth/sessions')).status).toBe(401);
    expect((await request(app.server).post('/api/v1/auth/sessions/revoke-all')).status).toBe(401);
  });
});

describe('sign out on every other device', () => {
  it('ends all sessions but the current one', async () => {
    const keep = await login(emails.main);
    const others = [await login(emails.main), await login(emails.main, SAFARI_IPHONE)];
    const theirs = await login(emails.other);

    const res = await request(app.server)
      .post('/api/v1/auth/sessions/revoke-all')
      .set('Authorization', `Bearer ${keep.token}`);
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBeGreaterThanOrEqual(2);

    for (const o of others) {
      expect((await me(o.token)).status).toBe(401);
      expect((await refresh(o.refresh)).status).toBe(401);
    }
    expect((await me(keep.token)).status).toBe(200);
    const left = (await sessions(keep.token)).body.data;
    expect(left).toHaveLength(1);
    expect(left[0].current).toBe(true);
    // Another account is untouched.
    expect((await me(theirs.token)).status).toBe(200);

    const audit = await app.prisma.auditLog.findFirst({
      where: { actor_id: keep.userId, action: 'auth.sessions_revoked' },
      orderBy: { created_at: 'desc' },
    });
    expect((audit?.meta as { count: number }).count).toBe(res.body.revoked);

    // Nothing left to end: 0, and no audit entry for it.
    const again = await request(app.server)
      .post('/api/v1/auth/sessions/revoke-all')
      .set('Authorization', `Bearer ${keep.token}`);
    expect(again.body.revoked).toBe(0);
  });
});

describe('refresh-token theft ends only the session it belongs to', () => {
  it('replaying a rotated token revokes that session, not the other devices', async () => {
    const victim = await login(emails.other);
    const otherDevice = await login(emails.other, SAFARI_IPHONE);
    const rotated = await refresh(victim.refresh);
    expect(rotated.status).toBe(200);
    // Move the old token's revocation outside the multi-tab grace window.
    await app.prisma.refreshToken.updateMany({
      where: { user_id: victim.userId, revoked_at: { not: null } },
      data: { revoked_at: new Date(Date.now() - 60 * 1000) },
    });

    expect((await refresh(victim.refresh)).status).toBe(401);
    expect((await refresh(rotated.body.refresh_token)).status).toBe(401);
    expect((await me(rotated.body.access_token)).status).toBe(401);
    expect((await me(otherDevice.token)).status).toBe(200);
    expect((await refresh(otherDevice.refresh)).status).toBe(200);
  });
});

describe('compatibility and live updates', () => {
  it('an access token minted before sessions (no sid) is still accepted', async () => {
    const { userId } = await login(emails.main);
    expect((await me(signAccessToken(userId))).status).toBe(200);
  });

  it("ending a session closes that session's live-update stream", async () => {
    const owner = await login(emails.main);
    const ws = await request(app.server)
      .post('/api/v1/workspaces')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Sessions', slug: SLUG });
    expect(ws.status).toBe(201);

    const watcher = await login(emails.main, SAFARI_IPHONE);
    const controller = new AbortController();
    const stream = await fetch(`${base}/api/v1/workspaces/${SLUG}/events`, {
      headers: { Authorization: `Bearer ${watcher.token}` },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    let ended = false;
    void (async () => {
      try {
        for await (const _chunk of stream.body!) {
          // drain
        }
      } catch {
        // aborted
      }
      ended = true;
    })();

    const watcherSession = (await sessions(watcher.token)).body.data.find(
      (s: { current: boolean }) => s.current,
    );
    // The owner's own stream would survive; only the ended session is closed.
    const res = await request(app.server)
      .delete(`/api/v1/auth/sessions/${watcherSession.id}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(204);

    const deadline = Date.now() + 3000;
    while (!ended && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    expect(ended).toBe(true);
  });
});

describe('device label from User-Agent', () => {
  it.each([
    [CHROME_WIN, 'Chrome 128', 'Windows', false],
    [SAFARI_IPHONE, 'Safari 17', 'iOS', true],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
      'Edge 129',
      'Windows',
      false,
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0',
      'Firefox 131',
      'macOS',
      false,
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) YaBrowser/24.7.1.89 Mobile Safari/537.36',
      'Yandex Browser 24',
      'Android',
      true,
    ],
  ])('%s', (ua, browser, os, mobile) => {
    expect(describeUserAgent(ua)).toEqual({ browser, os, mobile });
  });

  it('unknown or missing header gives nulls', () => {
    expect(describeUserAgent(undefined)).toEqual({ browser: null, os: null, mobile: false });
    expect(describeUserAgent('curl/8.5.0')).toEqual({ browser: null, os: null, mobile: false });
  });
});
