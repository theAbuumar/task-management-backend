// Integration tests for the GitHub OAuth flow (auth_tz.md §4).
//
// The redirect endpoint and the CSRF checks run for real. The token exchange and
// the two GitHub API calls (`GET /user`, `GET /user/emails`) are mocked at the
// `fetch` boundary — we route by URL so the find-or-create path (and the persisted
// `github` identity) can be asserted against a live Postgres without talking to
// GitHub. Created rows are removed in afterAll. Requires GITHUB_* test env
// (set in tests/setup.ts).

import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const GH_ID = TS; // GitHub numeric id
const EMAIL = `github-${TS}@example.com`;

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.prisma.authIdentity.deleteMany({
    where: { provider: 'github', provider_user_id: String(GH_ID) },
  });
  await app.prisma.refreshToken.deleteMany({ where: { user: { email: EMAIL } } });
  await app.prisma.user.deleteMany({ where: { email: EMAIL } });
  await app.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Pull the `oauth_state` cookie value out of a Set-Cookie header list. */
function stateCookieValue(setCookie: string[] | undefined): string {
  const raw = (setCookie ?? []).find((c) => c.startsWith('oauth_state='));
  if (!raw) throw new Error('oauth_state cookie was not set');
  return raw.split(';')[0]!.split('=')[1]!;
}

/** A fetch mock that routes GitHub's token + user + emails calls by URL. */
function githubFetchMock(overrides?: {
  user?: Record<string, unknown>;
  emails?: unknown;
}): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    if (url.startsWith('https://github.com/login/oauth/access_token')) {
      return { ok: true, json: async () => ({ access_token: 'gho_testtoken' }) };
    }
    if (url === 'https://api.github.com/user') {
      return {
        ok: true,
        json: async () =>
          overrides?.user ?? { id: GH_ID, name: 'GitHub Tester', avatar_url: 'https://ex/a.png' },
      };
    }
    if (url === 'https://api.github.com/user/emails') {
      return {
        ok: true,
        json: async () => overrides?.emails ?? [{ email: EMAIL, primary: true, verified: true }],
      };
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
}

describe('GET /auth/github (redirect)', () => {
  it('302-redirects to GitHub with the expected params and sets a state cookie', async () => {
    const res = await request(app.server).get('/api/v1/auth/github');

    expect(res.status).toBe(302);
    const location = res.headers.location!;
    expect(location).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);

    const url = new URL(location);
    expect(url.searchParams.get('client_id')).toBe('test-github-client-id');
    expect(url.searchParams.get('scope')).toBe('read:user user:email');
    expect(url.searchParams.get('state')).toBeTruthy();

    const setCookie = res.headers['set-cookie'] as unknown as string[];
    const cookieState = stateCookieValue(setCookie);
    // The cookie mirrors the outgoing state (double-submit) and is httpOnly.
    expect(cookieState).toBe(url.searchParams.get('state'));
    expect(setCookie.join(';')).toMatch(/HttpOnly/i);
  });
});

describe('GET /auth/github/callback (CSRF)', () => {
  it('redirects to the frontend with an error when state is missing', async () => {
    const res = await request(app.server).get('/api/v1/auth/github/callback?code=abc');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=invalid_state');
  });

  it('redirects with an error when the provider reports one (access_denied)', async () => {
    const res = await request(app.server).get('/api/v1/auth/github/callback?error=access_denied');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=access_denied');
  });
});

describe('GET /auth/github/callback (happy path, mocked exchange)', () => {
  it('find-or-creates the account, persists the identity, and issues a session', async () => {
    // 1. Start the flow to obtain a valid, browser-bound state.
    const start = await request(app.server).get('/api/v1/auth/github');
    const setCookie = start.headers['set-cookie'] as unknown as string[];
    const state = stateCookieValue(setCookie);

    // 2. Mock GitHub's token + API endpoints.
    const fetchMock = githubFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    // 3. Callback with the matching state cookie + a code.
    const res = await request(app.server)
      .get(`/api/v1/auth/github/callback?code=fake-code&state=${state}`)
      .set('Cookie', `oauth_state=${state}`);

    // token + /user + /user/emails = 3 calls.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^http:\/\/localhost:5173\/#access_token=/);

    // A refresh cookie was issued.
    const cbCookies = res.headers['set-cookie'] as unknown as string[];
    expect(cbCookies.join(';')).toMatch(/refresh_token=/);

    // The account + `github` identity (with provider_email) were persisted.
    const user = await app.prisma.user.findUnique({ where: { email: EMAIL } });
    expect(user).toBeTruthy();
    expect(user?.display_name).toBe('GitHub Tester');
    expect(user?.email_verified).toBe(true);

    const identity = await app.prisma.authIdentity.findUnique({
      where: {
        provider_provider_user_id: { provider: 'github', provider_user_id: String(GH_ID) },
      },
    });
    expect(identity).toBeTruthy();
    expect(identity?.user_id).toBe(user?.id);
    expect(identity?.provider_email).toBe(EMAIL);
  });
});
