// Integration tests for the Google OAuth flow (auth_tz.md §3).
//
// The redirect endpoint and the CSRF checks run for real. The token exchange with
// Google is mocked at the `fetch` boundary — we hand back a crafted `id_token` so
// the find-or-create path (and the persisted `google` identity) can be asserted
// against a live Postgres without talking to Google. Created rows are removed in
// afterAll. Requires GOOGLE_* test env (set in tests/setup.ts).

import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const SUB = `google-sub-${TS}`;
const EMAIL = `google-${TS}@example.com`;

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.prisma.authIdentity.deleteMany({
    where: { provider: 'google', provider_user_id: SUB },
  });
  await app.prisma.refreshToken.deleteMany({ where: { user: { email: EMAIL } } });
  await app.prisma.user.deleteMany({ where: { email: EMAIL } });
  await app.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Build a JWT-shaped id_token whose payload carries the given claims. */
function makeIdToken(claims: Record<string, unknown>): string {
  const b64 = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.sig`;
}

/** Pull the `oauth_state` cookie value out of a Set-Cookie header list. */
function stateCookieValue(setCookie: string[] | undefined): string {
  const raw = (setCookie ?? []).find((c) => c.startsWith('oauth_state='));
  if (!raw) throw new Error('oauth_state cookie was not set');
  return raw.split(';')[0]!.split('=')[1]!;
}

describe('GET /auth/google (redirect)', () => {
  it('302-redirects to Google with the expected params and sets a state cookie', async () => {
    const res = await request(app.server).get('/api/v1/auth/google');

    expect(res.status).toBe(302);
    const location = res.headers.location!;
    expect(location).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);

    const url = new URL(location);
    expect(url.searchParams.get('client_id')).toBe('test-google-client-id');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('state')).toBeTruthy();

    const setCookie = res.headers['set-cookie'] as unknown as string[];
    const cookieState = stateCookieValue(setCookie);
    // The cookie mirrors the outgoing state (double-submit) and is httpOnly.
    expect(cookieState).toBe(url.searchParams.get('state'));
    expect(setCookie.join(';')).toMatch(/HttpOnly/i);
  });
});

describe('GET /auth/google/callback (CSRF)', () => {
  it('redirects to the frontend with an error when state is missing', async () => {
    const res = await request(app.server).get('/api/v1/auth/google/callback?code=abc');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=invalid_state');
  });

  it('redirects with an error when the provider reports one (access_denied)', async () => {
    const res = await request(app.server).get('/api/v1/auth/google/callback?error=access_denied');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=access_denied');
  });
});

describe('GET /auth/google/callback (happy path, mocked exchange)', () => {
  it('find-or-creates the account, persists the identity, and issues a session', async () => {
    // 1. Start the flow to obtain a valid, browser-bound state.
    const start = await request(app.server).get('/api/v1/auth/google');
    const setCookie = start.headers['set-cookie'] as unknown as string[];
    const state = stateCookieValue(setCookie);

    // 2. Mock Google's token endpoint to return our crafted id_token.
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        id_token: makeIdToken({
          sub: SUB,
          email: EMAIL,
          email_verified: true,
          name: 'Google Tester',
          picture: 'https://example.com/pic.png',
        }),
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    // 3. Callback with the matching state cookie + a code.
    const res = await request(app.server)
      .get(`/api/v1/auth/google/callback?code=fake-code&state=${state}`)
      .set('Cookie', `oauth_state=${state}`);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^http:\/\/localhost:5173\/#access_token=/);

    // A refresh cookie was issued.
    const cbCookies = res.headers['set-cookie'] as unknown as string[];
    expect(cbCookies.join(';')).toMatch(/refresh_token=/);

    // The account + `google` identity (with provider_email) were persisted.
    const user = await app.prisma.user.findUnique({ where: { email: EMAIL } });
    expect(user).toBeTruthy();
    expect(user?.display_name).toBe('Google Tester');

    const identity = await app.prisma.authIdentity.findUnique({
      where: { provider_provider_user_id: { provider: 'google', provider_user_id: SUB } },
    });
    expect(identity).toBeTruthy();
    expect(identity?.user_id).toBe(user?.id);
    expect(identity?.provider_email).toBe(EMAIL);
  });
});
