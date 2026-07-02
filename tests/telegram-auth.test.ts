// Integration tests for the Telegram deep-link login flow (auth_tz.md §7).
//
// init / status and the token lifecycle (pending → confirmed → used, TTL, session
// binding) run for real against Postgres. The Telegram Bot API calls the webhook
// handler makes (sendMessage / answerCallbackQuery) are mocked at the `fetch`
// boundary. There is no real bot — we simulate the two updates Telegram would post
// (`/start <token>`, then the confirm `callback_query`). Created rows are removed in
// afterAll. Requires TELEGRAM_* test env (set in tests/setup.ts).

import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const TG_ID = TS; // Telegram numeric user id

let app: FastifyInstance;
const createdTokens: string[] = [];

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  // Deleting the user cascades to its telegram identity + refresh tokens.
  const identity = await app.prisma.authIdentity.findUnique({
    where: { provider_provider_user_id: { provider: 'telegram', provider_user_id: String(TG_ID) } },
  });
  if (identity) await app.prisma.user.deleteMany({ where: { id: identity.user_id } });
  await app.prisma.telegramLoginToken.deleteMany({ where: { token: { in: createdTokens } } });
  await app.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fetch mock that accepts any Telegram Bot API call and reports success. */
function telegramFetchMock(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    if (url.startsWith('https://api.telegram.org/bot')) {
      return { ok: true, json: async () => ({ ok: true }) };
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
}

/** Pull a named cookie's value out of a Set-Cookie header list. */
function cookieValue(setCookie: string[] | undefined, name: string): string | undefined {
  const raw = (setCookie ?? []).find((c) => c.startsWith(`${name}=`));
  return raw?.split(';')[0]!.split('=').slice(1).join('=');
}

/** Run the full init → /start → confirm handshake; returns the token + tg_session cookie. */
async function startAndConfirm(): Promise<{ token: string; session: string }> {
  const init = await request(app.server).post('/api/v1/auth/telegram/init');
  const setCookie = init.headers['set-cookie'] as unknown as string[];
  const session = cookieValue(setCookie, 'tg_session')!;
  const token = init.body.token as string;
  createdTokens.push(token);

  vi.stubGlobal('fetch', telegramFetchMock());
  // Telegram posts the `/start <token>` message…
  await request(app.server)
    .post('/api/v1/auth/telegram/webhook')
    .send({ message: { chat: { id: TG_ID }, from: { id: TG_ID }, text: `/start ${token}` } });
  // …then the tapped-confirm callback_query.
  await request(app.server)
    .post('/api/v1/auth/telegram/webhook')
    .send({ callback_query: { id: 'cbq1', from: { id: TG_ID }, data: `confirm:${token}` } });
  vi.unstubAllGlobals();

  return { token, session };
}

describe('POST /auth/telegram/init', () => {
  it('creates a pending token, returns a deep-link, and sets an httpOnly tg_session cookie', async () => {
    const res = await request(app.server).post('/api/v1/auth/telegram/init');
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    createdTokens.push(res.body.token);

    // Deep-link points at the configured bot and carries the token as `start`.
    expect(res.body.deep_link).toBe(`https://t.me/test_task_bot?start=${res.body.token}`);
    expect(new Date(res.body.expires_at).getTime()).toBeGreaterThan(Date.now());

    const setCookie = res.headers['set-cookie'] as unknown as string[];
    expect(cookieValue(setCookie, 'tg_session')).toBeTruthy();
    expect(setCookie.join(';')).toMatch(/HttpOnly/i);

    const row = await app.prisma.telegramLoginToken.findUnique({
      where: { token: res.body.token },
    });
    expect(row?.status).toBe('pending');
  });
});

describe('Telegram webhook (auth_tz.md §7 steps 3–4)', () => {
  it('replies to /start <token> and confirms the token on the callback tap', async () => {
    const init = await request(app.server).post('/api/v1/auth/telegram/init');
    const token = init.body.token as string;
    createdTokens.push(token);

    const fetchMock = telegramFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    // /start → a sendMessage with the confirm button.
    await request(app.server)
      .post('/api/v1/auth/telegram/webhook')
      .send({ message: { chat: { id: TG_ID }, from: { id: TG_ID }, text: `/start ${token}` } })
      .expect(200);
    const sendCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/sendMessage'));
    expect(sendCall).toBeTruthy();
    expect(JSON.stringify(sendCall![1])).toContain(`confirm:${token}`);

    // callback tap → token becomes confirmed with the tapper's telegram_id.
    await request(app.server)
      .post('/api/v1/auth/telegram/webhook')
      .send({ callback_query: { id: 'cbq', from: { id: TG_ID }, data: `confirm:${token}` } })
      .expect(200);

    const row = await app.prisma.telegramLoginToken.findUnique({ where: { token } });
    expect(row?.status).toBe('confirmed');
    expect(row?.telegram_id).toBe(String(TG_ID));
  });
});

describe('GET /auth/telegram/status', () => {
  it('reports pending before confirmation', async () => {
    const init = await request(app.server).post('/api/v1/auth/telegram/init');
    const setCookie = init.headers['set-cookie'] as unknown as string[];
    const session = cookieValue(setCookie, 'tg_session')!;
    const token = init.body.token as string;
    createdTokens.push(token);

    const res = await request(app.server)
      .get(`/api/v1/auth/telegram/status?token=${token}`)
      .set('Cookie', `tg_session=${session}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
  });

  it('find-or-creates by telegram_id, consumes the token (one-time), and issues a session', async () => {
    const { token, session } = await startAndConfirm();

    const res = await request(app.server)
      .get(`/api/v1/auth/telegram/status?token=${token}`)
      .set('Cookie', `tg_session=${session}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('authenticated');
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.user.id).toBeTruthy();
    expect(res.body.user.email).toBeNull(); // Telegram accounts have no email (§7)

    // A refresh cookie was issued.
    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.join(';')).toMatch(/refresh_token=/);

    // The telegram identity was persisted against the new account.
    const identity = await app.prisma.authIdentity.findUnique({
      where: {
        provider_provider_user_id: { provider: 'telegram', provider_user_id: String(TG_ID) },
      },
    });
    expect(identity?.user_id).toBe(res.body.user.id);

    // Token is now `used`; a second poll no longer authenticates.
    const again = await request(app.server)
      .get(`/api/v1/auth/telegram/status?token=${token}`)
      .set('Cookie', `tg_session=${session}`);
    expect(again.body.status).toBe('used');
  });

  it('rejects a poll from a different browser session (session binding)', async () => {
    const init = await request(app.server).post('/api/v1/auth/telegram/init');
    const token = init.body.token as string;
    createdTokens.push(token);

    // No tg_session cookie at all.
    const noCookie = await request(app.server).get(`/api/v1/auth/telegram/status?token=${token}`);
    expect(noCookie.status).toBe(403);

    // A cookie that doesn't match the token's session.
    const wrong = await request(app.server)
      .get(`/api/v1/auth/telegram/status?token=${token}`)
      .set('Cookie', 'tg_session=not-the-right-session');
    expect(wrong.status).toBe(403);
  });

  it('reports expired once the TTL has lapsed', async () => {
    const init = await request(app.server).post('/api/v1/auth/telegram/init');
    const setCookie = init.headers['set-cookie'] as unknown as string[];
    const session = cookieValue(setCookie, 'tg_session')!;
    const token = init.body.token as string;
    createdTokens.push(token);

    // Force the token past its TTL.
    await app.prisma.telegramLoginToken.update({
      where: { token },
      data: { expires_at: new Date(Date.now() - 1000) },
    });

    const res = await request(app.server)
      .get(`/api/v1/auth/telegram/status?token=${token}`)
      .set('Cookie', `tg_session=${session}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('expired');

    const row = await app.prisma.telegramLoginToken.findUnique({ where: { token } });
    expect(row?.status).toBe('expired');
  });
});
