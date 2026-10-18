// Linking Google/GitHub from the profile (Ф4 4.F9, ADR-025): `link/start` mints a
// state that names the signed-in user; the provider's usual callback then links the
// account to that user instead of signing in and returns to the profile.
//
// Covers the happy path for both providers, an account owned by someone else, and
// the attacks the design closes: a link URL replayed in another browser (no state
// cookie), a state tampered to point at another user, and a Google link state used
// at the GitHub callback. Token exchanges are mocked at the `fetch` boundary. Runs
// against a live Postgres; created rows are removed in afterAll.

import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const emails = {
  me: `olink-me-${TS}@example.com`,
  other: `olink-other-${TS}@example.com`,
};
const GOOGLE_SUB = `olink-google-${TS}`;
const OTHER_GOOGLE_SUB = `olink-google-other-${TS}`;
const GH_ID = TS + 11;

type Actor = { id: string; token: string };
let app: FastifyInstance;
let me: Actor;
let other: Actor;

const profileUrl = new URL('profile', config.FRONTEND_URL.replace(/\/*$/, '/')).toString();

async function register(email: string): Promise<Actor> {
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, display_name: email.split('@')[0] });
  expect(res.status).toBe(201);
  return { id: res.body.user.id, token: res.body.access_token };
}

/** `link/start` as `actor`: the consent URL's `state` and the cookie set with it. */
async function start(actor: Actor, provider: 'google' | 'github') {
  const res = await request(app.server)
    .post(`/api/v1/auth/identities/${provider}/link/start`)
    .set('Authorization', `Bearer ${actor.token}`);
  expect(res.status).toBe(200);
  const state = new URL(res.body.url).searchParams.get('state')!;
  const raw = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
    c.startsWith('oauth_state='),
  )!;
  return { url: res.body.url as string, state, cookie: raw.split(';')[0]! };
}

function callback(provider: 'google' | 'github', query: Record<string, string>, cookie?: string) {
  const req = request(app.server).get(`/api/v1/auth/${provider}/callback`).query(query);
  return cookie ? req.set('Cookie', cookie) : req;
}

function makeIdToken(claims: Record<string, unknown>): string {
  const b64 = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.sig`;
}

function stubGoogle(sub: string, email: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ id_token: makeIdToken({ sub, email, email_verified: true }) }),
    })),
  );
}

function stubGithub(id: number, email: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.startsWith('https://github.com/login/oauth/access_token'))
        return { ok: true, json: async () => ({ access_token: 'gho_test' }) };
      if (url === 'https://api.github.com/user')
        return { ok: true, json: async () => ({ id, name: 'GH' }) };
      if (url === 'https://api.github.com/user/emails')
        return { ok: true, json: async () => [{ email, primary: true, verified: true }] };
      throw new Error(`unexpected fetch to ${url}`);
    }),
  );
}

const ownerOf = async (provider: 'google' | 'github', id: string) =>
  (
    await app.prisma.authIdentity.findUnique({
      where: { provider_provider_user_id: { provider, provider_user_id: id } },
    })
  )?.user_id ?? null;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  me = await register(emails.me);
  other = await register(emails.other);
  await app.prisma.authIdentity.create({
    data: { user_id: other.id, provider: 'google', provider_user_id: OTHER_GOOGLE_SUB },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  const list = Object.values(emails);
  await app.prisma.authIdentity.deleteMany({ where: { user: { email: { in: list } } } });
  await app.prisma.refreshToken.deleteMany({ where: { user: { email: { in: list } } } });
  await app.prisma.user.deleteMany({ where: { email: { in: list } } });
  await app.close();
});

describe('POST /auth/identities/:provider/link/start', () => {
  it('requires a session and only takes google or github', async () => {
    const anon = await request(app.server).post('/api/v1/auth/identities/google/link/start');
    expect(anon.status).toBe(401);
    const tg = await request(app.server)
      .post('/api/v1/auth/identities/telegram/link/start')
      .set('Authorization', `Bearer ${me.token}`);
    expect(tg.status).toBe(400);
  });

  it('returns the consent URL with a link state, mirrored in the cookie', async () => {
    const { url, state, cookie } = await start(me, 'google');
    expect(url).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(cookie).toBe(`oauth_state=${state}`);
    // A sign-in state has three parts; a link state carries the intent as a fourth.
    expect(state.split('.')).toHaveLength(4);
  });
});

describe('provider callback with a link state', () => {
  it('links Google to the user who started, without signing in', async () => {
    const { state, cookie } = await start(me, 'google');
    stubGoogle(GOOGLE_SUB, emails.me);
    const res = await callback('google', { code: 'c', state }, cookie);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${profileUrl}#linked=google`);
    // Not a sign-in: no session cookie and no access token in the redirect.
    const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(cookies.some((c) => c.startsWith(`${config.SESSION_COOKIE_NAME}=`))).toBe(false);
    expect(res.headers.location).not.toContain('access_token');
    expect(await ownerOf('google', GOOGLE_SUB)).toBe(me.id);

    const audit = await app.prisma.auditLog.findFirst({
      where: { actor_id: me.id, action: 'auth.identity_linked' },
    });
    expect(audit?.meta).toMatchObject({ provider: 'google' });
  });

  it('links GitHub the same way', async () => {
    const { state, cookie } = await start(me, 'github');
    stubGithub(GH_ID, emails.me);
    const res = await callback('github', { code: 'c', state }, cookie);
    expect(res.headers.location).toBe(`${profileUrl}#linked=github`);
    expect(await ownerOf('github', String(GH_ID))).toBe(me.id);
  });

  it('refuses an account already linked to someone else, and leaves it there', async () => {
    const { state, cookie } = await start(me, 'google');
    stubGoogle(OTHER_GOOGLE_SUB, emails.other);
    const res = await callback('google', { code: 'c', state }, cookie);
    expect(res.headers.location).toBe(`${profileUrl}#link_error=linked_to_other_account`);
    expect(await ownerOf('google', OTHER_GOOGLE_SUB)).toBe(other.id);
  });

  it('a declined consent goes back to the profile with the provider error', async () => {
    const { state, cookie } = await start(me, 'google');
    const res = await callback('google', { error: 'access_denied', state }, cookie);
    expect(res.headers.location).toBe(`${profileUrl}#link_error=access_denied`);
  });
});

describe('a link state cannot be abused', () => {
  it('replayed in another browser (no state cookie) it links nothing', async () => {
    const { state } = await start(other, 'github');
    stubGithub(GH_ID + 1, emails.other);
    const res = await callback('github', { code: 'c', state });
    expect(res.headers.location).toContain('error=invalid_state');
    expect(await ownerOf('github', String(GH_ID + 1))).toBe(null);
  });

  it('tampered to name another user it fails the signature', async () => {
    const { state } = await start(other, 'google');
    const [nonce, issued, , sig] = state.split('.');
    const forgedIntent = Buffer.from(`google:${me.id}`).toString('base64url');
    const forged = [nonce, issued, forgedIntent, sig].join('.');
    stubGoogle(`${GOOGLE_SUB}-forged`, emails.other);
    const res = await callback('google', { code: 'c', state: forged }, `oauth_state=${forged}`);
    expect(res.headers.location).toContain('error=invalid_state');
    expect(await ownerOf('google', `${GOOGLE_SUB}-forged`)).toBe(null);
  });

  it('a Google link state is refused at the GitHub callback', async () => {
    const { state, cookie } = await start(me, 'google');
    stubGithub(GH_ID + 2, emails.me);
    const res = await callback('github', { code: 'c', state }, cookie);
    expect(res.headers.location).toBe(`${profileUrl}#link_error=invalid_state`);
    expect(await ownerOf('github', String(GH_ID + 2))).toBe(null);
  });
});

describe('unlinking is audited', () => {
  it('writes auth.identity_unlinked', async () => {
    const res = await request(app.server)
      .delete('/api/v1/auth/identities/github')
      .set('Authorization', `Bearer ${me.token}`);
    expect(res.status).toBe(204);
    const audit = await app.prisma.auditLog.findFirst({
      where: { actor_id: me.id, action: 'auth.identity_unlinked' },
    });
    expect(audit?.meta).toMatchObject({ provider: 'github' });
  });
});
