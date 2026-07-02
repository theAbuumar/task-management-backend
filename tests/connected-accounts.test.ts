// Integration tests for connected-accounts management (auth_tz.md §10).
//
// Runs against a live Postgres. The base account is created through the real
// email signup + OTP verify flow (which also seeds its `email` identity); the OTP
// is read from the console stub the mailer logs in dev/test. OAuth linking mocks
// the provider token exchange at the `fetch` boundary; Telegram linking drives the
// real init → /start → confirm handshake (bot API mocked) and then links the
// confirmed token. All created rows are removed in afterAll.

import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const EMAIL_A = `ca-a-${TS}@example.com`; // base account (email identity)
const EMAIL_B = `ca-b-${TS}@example.com`; // owns a google identity someone else can't steal
const GOOGLE_SUB = `ca-google-${TS}`; // google account linked to A
const OTHER_GOOGLE_SUB = `ca-other-google-${TS}`; // google account owned by B
const TG_ID = TS; // telegram id linked to A

let app: FastifyInstance;
let tokenA: string;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  tokenA = await signupVerify(EMAIL_A);

  // A second account that already owns a google identity — used for the
  // "linked to a different account" conflict.
  await app.prisma.user.create({
    data: {
      email: EMAIL_B,
      email_verified: true,
      display_name: 'User B',
      identities: {
        create: { provider: 'google', provider_user_id: OTHER_GOOGLE_SUB, provider_email: EMAIL_B },
      },
    },
  });
});

afterAll(async () => {
  await app.prisma.authIdentity.deleteMany({
    where: { provider: 'telegram', provider_user_id: String(TG_ID) },
  });
  await app.prisma.emailOtp.deleteMany({ where: { email: { in: [EMAIL_A, EMAIL_B] } } });
  await app.prisma.user.deleteMany({ where: { email: { in: [EMAIL_A, EMAIL_B] } } });
  await app.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── helpers ────────────────────────────────────────────────────────────────

/** Sign up + verify via the real OTP flow; returns the account's access token. */
async function signupVerify(email: string): Promise<string> {
  const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    await request(app.server)
      .post('/api/v1/auth/email/signup')
      .send({ email, password: PASSWORD, display_name: 'CA Tester' });
    const text = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    const code = text.match(/\b\d{6}\b/g)!.pop()!;
    const verify = await request(app.server)
      .post('/api/v1/auth/email/verify')
      .send({ email, code });
    return verify.body.access_token as string;
  } finally {
    spy.mockRestore();
  }
}

/** Build a JWT-shaped id_token whose payload carries the given claims. */
function makeIdToken(claims: Record<string, unknown>): string {
  const b64 = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.sig`;
}

/** Mock Google's token endpoint to return an id_token for the given sub/email. */
function stubGoogleExchange(sub: string, email: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        id_token: makeIdToken({ sub, email, email_verified: true, name: 'CA Google' }),
      }),
    })),
  );
}

/** Pull a named cookie's value out of a Set-Cookie header list. */
function cookieValue(setCookie: string[] | undefined, name: string): string | undefined {
  const raw = (setCookie ?? []).find((c) => c.startsWith(`${name}=`));
  return raw?.split(';')[0]!.split('=').slice(1).join('=');
}

const auth = (token: string): [string, string] => ['Authorization', `Bearer ${token}`];

// ─── tests ──────────────────────────────────────────────────────────────────

describe('GET /auth/identities', () => {
  it('requires authentication', async () => {
    const res = await request(app.server).get('/api/v1/auth/identities');
    expect(res.status).toBe(401);
  });

  it('lists the account’s linked login methods', async () => {
    const res = await request(app.server)
      .get('/api/v1/auth/identities')
      .set(...auth(tokenA));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const providers = res.body.map((i: { provider: string }) => i.provider);
    expect(providers).toContain('email');
    const email = res.body.find((i: { provider: string }) => i.provider === 'email');
    expect(email.provider_email).toBe(EMAIL_A);
    expect(email.created_at).toBeTruthy();
  });
});

describe('POST /auth/identities/:provider/link (Google, mocked exchange)', () => {
  it('links a new google identity to the current account', async () => {
    stubGoogleExchange(GOOGLE_SUB, EMAIL_A);
    const res = await request(app.server)
      .post('/api/v1/auth/identities/google/link')
      .set(...auth(tokenA))
      .send({ code: 'fake-code' });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('google');
    expect(res.body.provider_email).toBe(EMAIL_A);

    const identity = await app.prisma.authIdentity.findUnique({
      where: { provider_provider_user_id: { provider: 'google', provider_user_id: GOOGLE_SUB } },
    });
    const user = await app.prisma.user.findUnique({ where: { email: EMAIL_A } });
    expect(identity?.user_id).toBe(user?.id);
  });

  it('is idempotent when the identity is already linked to this account', async () => {
    stubGoogleExchange(GOOGLE_SUB, EMAIL_A);
    const res = await request(app.server)
      .post('/api/v1/auth/identities/google/link')
      .set(...auth(tokenA))
      .send({ code: 'fake-code' });
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('google');
  });

  it('rejects linking an identity that belongs to another account (409)', async () => {
    stubGoogleExchange(OTHER_GOOGLE_SUB, EMAIL_B);
    const res = await request(app.server)
      .post('/api/v1/auth/identities/google/link')
      .set(...auth(tokenA))
      .send({ code: 'fake-code' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('requires authentication', async () => {
    const res = await request(app.server)
      .post('/api/v1/auth/identities/google/link')
      .send({ code: 'fake-code' });
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/identities/telegram/link', () => {
  it('links a confirmed Telegram token to the current account', async () => {
    // Full handshake: init → /start <token> → confirm tap (bot API mocked).
    const init = await request(app.server).post('/api/v1/auth/telegram/init');
    const session = cookieValue(init.headers['set-cookie'] as unknown as string[], 'tg_session')!;
    const token = init.body.token as string;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('https://api.telegram.org/bot')) {
          return { ok: true, json: async () => ({ ok: true }) };
        }
        throw new Error(`unexpected fetch to ${url}`);
      }),
    );
    await request(app.server)
      .post('/api/v1/auth/telegram/webhook')
      .send({ message: { chat: { id: TG_ID }, from: { id: TG_ID }, text: `/start ${token}` } });
    await request(app.server)
      .post('/api/v1/auth/telegram/webhook')
      .send({ callback_query: { id: 'cbq', from: { id: TG_ID }, data: `confirm:${token}` } });
    vi.unstubAllGlobals();

    const res = await request(app.server)
      .post('/api/v1/auth/identities/telegram/link')
      .set(...auth(tokenA))
      .set('Cookie', `tg_session=${session}`)
      .send({ token });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('telegram');

    const identity = await app.prisma.authIdentity.findUnique({
      where: {
        provider_provider_user_id: { provider: 'telegram', provider_user_id: String(TG_ID) },
      },
    });
    const user = await app.prisma.user.findUnique({ where: { email: EMAIL_A } });
    expect(identity?.user_id).toBe(user?.id);

    // The token was consumed — it can't be linked again.
    const again = await request(app.server)
      .post('/api/v1/auth/identities/telegram/link')
      .set(...auth(tokenA))
      .set('Cookie', `tg_session=${session}`)
      .send({ token });
    expect(again.status).toBe(400);
  });
});

describe('DELETE /auth/identities/:provider', () => {
  it('unlinks a non-last method', async () => {
    const res = await request(app.server)
      .delete('/api/v1/auth/identities/google')
      .set(...auth(tokenA));
    expect(res.status).toBe(204);

    const identity = await app.prisma.authIdentity.findUnique({
      where: { provider_provider_user_id: { provider: 'google', provider_user_id: GOOGLE_SUB } },
    });
    expect(identity).toBeNull();
  });

  it('404s when the provider is not linked', async () => {
    const res = await request(app.server)
      .delete('/api/v1/auth/identities/github')
      .set(...auth(tokenA));
    expect(res.status).toBe(404);
  });

  it('refuses to remove the last remaining login method', async () => {
    // A now has only `email` + `telegram`; remove telegram first, then email is last.
    const dropTelegram = await request(app.server)
      .delete('/api/v1/auth/identities/telegram')
      .set(...auth(tokenA));
    expect(dropTelegram.status).toBe(204);

    const dropLast = await request(app.server)
      .delete('/api/v1/auth/identities/email')
      .set(...auth(tokenA));
    expect(dropLast.status).toBe(403);
    expect(dropLast.body.error.code).toBe('FORBIDDEN');

    // The email identity is still there.
    const identity = await app.prisma.authIdentity.findFirst({
      where: { user: { email: EMAIL_A }, provider: 'email' },
    });
    expect(identity).toBeTruthy();
  });
});
