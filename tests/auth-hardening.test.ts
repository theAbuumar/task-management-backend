// Phase A6 hardening integration tests (auth_tz.md §5, §6, §8, §9).
//
// Consolidates the security-critical behaviours that weren't already asserted by
// the per-provider suites:
//   - find-or-create → auto-merge onto an existing account by *verified* email (§5),
//     and "find" (a repeat provider login returns the same account, no duplicate).
//   - OTP lifecycle edges: expiry and the ≤5-attempt cap invalidate the code (§6/§9).
//   - refresh-token rotation over the httpOnly cookie: the rotated cookie is new and
//     the old one is revoked (§8).
//   - OAuth CSRF: the callback `state` must match the browser cookie (double-submit),
//     not merely be a token we minted (§9).
//   - Per-IP rate limiting returns the standard 429 envelope once the limit is hit.
//
// (Create + identity persistence are covered in google-oauth/github-oauth; the
// unlink-last guard and single-use OTP replay in connected-accounts/email-auth;
// the Telegram token lifecycle in telegram-auth.)
//
// Runs against a live Postgres. Provider token exchange is mocked at the `fetch`
// boundary; the OTP is read from the console stub the mailer logs in dev/test.
// All created rows are removed in afterAll.

import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const MERGE_EMAIL = `harden-merge-${TS}@example.com`;
const MERGE_SUB = `harden-google-${TS}`;
const OTP_EXPIRE_EMAIL = `harden-otpexp-${TS}@example.com`;
const OTP_ATTEMPTS_EMAIL = `harden-otpatt-${TS}@example.com`;
const ROTATE_EMAIL = `harden-rotate-${TS}@example.com`;

const ALL_EMAILS = [MERGE_EMAIL, OTP_EXPIRE_EMAIL, OTP_ATTEMPTS_EMAIL, ROTATE_EMAIL];

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.prisma.authIdentity.deleteMany({
    where: { provider: 'google', provider_user_id: MERGE_SUB },
  });
  await app.prisma.refreshToken.deleteMany({ where: { user: { email: { in: ALL_EMAILS } } } });
  await app.prisma.emailOtp.deleteMany({ where: { email: { in: ALL_EMAILS } } });
  await app.prisma.user.deleteMany({ where: { email: { in: ALL_EMAILS } } });
  await app.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── helpers ────────────────────────────────────────────────────────────────

/** Build a JWT-shaped id_token whose payload carries the given claims. */
function makeIdToken(claims: Record<string, unknown>): string {
  const b64 = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.sig`;
}

/** Pull a named cookie's value out of a Set-Cookie header list. */
function cookieValue(setCookie: string[] | undefined, name: string): string | undefined {
  const raw = (setCookie ?? []).find((c) => c.startsWith(`${name}=`));
  return raw?.split(';')[0]!.split('=').slice(1).join('=');
}

/** Sign up + verify via the real OTP flow; returns the created user's id. */
async function signupVerify(email: string): Promise<string> {
  const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    await request(app.server)
      .post('/api/v1/auth/email/signup')
      .send({ email, password: PASSWORD, display_name: 'Harden Tester' });
    const text = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    const code = text.match(/\b\d{6}\b/g)!.pop()!;
    const verify = await request(app.server)
      .post('/api/v1/auth/email/verify')
      .send({ email, code });
    return verify.body.user.id as string;
  } finally {
    spy.mockRestore();
  }
}

/** Drive a full Google OAuth callback (browser-bound state + mocked exchange). */
async function googleLogin(
  sub: string,
  email: string,
  emailVerified: boolean,
): Promise<request.Response> {
  const start = await request(app.server).get('/api/v1/auth/google');
  const state = cookieValue(start.headers['set-cookie'] as unknown as string[], 'oauth_state')!;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        id_token: makeIdToken({ sub, email, email_verified: emailVerified, name: 'Harden Google' }),
      }),
    })),
  );
  const res = await request(app.server)
    .get(`/api/v1/auth/google/callback?code=fake-code&state=${state}`)
    .set('Cookie', `oauth_state=${state}`);
  vi.unstubAllGlobals();
  return res;
}

// ─── find-or-create: auto-merge by verified email (§5) ──────────────────────

describe('find-or-create — auto-merge by verified email', () => {
  it('merges a Google login onto an existing account with the same verified email', async () => {
    const emailUserId = await signupVerify(MERGE_EMAIL); // verified email+password account

    const res = await googleLogin(MERGE_SUB, MERGE_EMAIL, true);
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/#access_token=/);

    // No second account was created — the google identity attached to the existing user.
    const identity = await app.prisma.authIdentity.findUnique({
      where: { provider_provider_user_id: { provider: 'google', provider_user_id: MERGE_SUB } },
    });
    expect(identity?.user_id).toBe(emailUserId);

    const users = await app.prisma.user.findMany({ where: { email: MERGE_EMAIL } });
    expect(users).toHaveLength(1);
  });

  it('"find": a repeat Google login returns the same account (no duplicate identity)', async () => {
    const res = await googleLogin(MERGE_SUB, MERGE_EMAIL, true);
    expect(res.status).toBe(302);

    const identities = await app.prisma.authIdentity.findMany({
      where: { provider: 'google', provider_user_id: MERGE_SUB },
    });
    expect(identities).toHaveLength(1);
  });
});

// ─── OTP lifecycle edges (§6, §9) ────────────────────────────────────────────

describe('OTP lifecycle', () => {
  it('rejects a code once it has expired (and consumes it)', async () => {
    await request(app.server)
      .post('/api/v1/auth/email/signup')
      .send({ email: OTP_EXPIRE_EMAIL, password: PASSWORD, display_name: 'OTP Expiry' });

    // Force the outstanding code past its TTL. Expiry is checked before the code is
    // compared, so any 6-digit guess exercises the expiry branch.
    const otp = await app.prisma.emailOtp.findFirst({
      where: { email: OTP_EXPIRE_EMAIL, consumed_at: null },
      orderBy: { created_at: 'desc' },
    });
    await app.prisma.emailOtp.update({
      where: { id: otp!.id },
      data: { expires_at: new Date(Date.now() - 1000) },
    });

    const res = await request(app.server)
      .post('/api/v1/auth/email/verify')
      .send({ email: OTP_EXPIRE_EMAIL, code: '000000' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/expired/i);

    const after = await app.prisma.emailOtp.findUnique({ where: { id: otp!.id } });
    expect(after?.consumed_at).not.toBeNull();
  });

  it('invalidates the code after 5 failed attempts', async () => {
    await request(app.server)
      .post('/api/v1/auth/email/signup')
      .send({ email: OTP_ATTEMPTS_EMAIL, password: PASSWORD, display_name: 'OTP Attempts' });
    const otp = await app.prisma.emailOtp.findFirst({
      where: { email: OTP_ATTEMPTS_EMAIL, consumed_at: null },
      orderBy: { created_at: 'desc' },
    });

    // 5 wrong guesses — each rejected; the 5th trips the cap and consumes the code.
    for (let i = 0; i < 5; i++) {
      const wrong = await request(app.server)
        .post('/api/v1/auth/email/verify')
        .send({ email: OTP_ATTEMPTS_EMAIL, code: '111111' });
      expect(wrong.status).toBe(400);
    }
    const consumed = await app.prisma.emailOtp.findUnique({ where: { id: otp!.id } });
    expect(consumed?.consumed_at).not.toBeNull();

    // With the code invalidated, a further attempt finds no active code.
    const after = await request(app.server)
      .post('/api/v1/auth/email/verify')
      .send({ email: OTP_ATTEMPTS_EMAIL, code: '111111' });
    expect(after.status).toBe(400);
    expect(after.body.error.message).toMatch(/no active|request a new/i);
  });
});

// ─── refresh-token rotation over the cookie (§8) ─────────────────────────────

describe('refresh-cookie rotation', () => {
  it('rotates the refresh cookie and revokes the previous one', async () => {
    const reg = await request(app.server)
      .post('/api/v1/auth/register')
      .send({ email: ROTATE_EMAIL, password: PASSWORD, display_name: 'Rotate Tester' });
    expect(reg.status).toBe(201);
    const firstCookie = cookieValue(
      reg.headers['set-cookie'] as unknown as string[],
      'refresh_token',
    )!;
    expect(firstCookie).toBeTruthy();

    // Refresh driven by the cookie (empty body) — the browser path.
    const rotated = await request(app.server)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refresh_token=${firstCookie}`)
      .send({});
    expect(rotated.status).toBe(200);
    const secondCookie = cookieValue(
      rotated.headers['set-cookie'] as unknown as string[],
      'refresh_token',
    )!;
    expect(secondCookie).toBeTruthy();
    expect(secondCookie).not.toBe(firstCookie);

    // The original cookie is now revoked — replaying it fails.
    const replay = await request(app.server)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refresh_token=${firstCookie}`)
      .send({});
    expect(replay.status).toBe(401);
  });
});

// ─── OAuth CSRF: double-submit state binding (§9) ────────────────────────────

describe('OAuth state / CSRF', () => {
  it('rejects a callback whose state cookie does not match the state param', async () => {
    // Two independently-minted, individually-valid states.
    const start1 = await request(app.server).get('/api/v1/auth/google');
    const state1 = cookieValue(start1.headers['set-cookie'] as unknown as string[], 'oauth_state')!;
    const start2 = await request(app.server).get('/api/v1/auth/google');
    const state2 = cookieValue(start2.headers['set-cookie'] as unknown as string[], 'oauth_state')!;
    expect(state1).not.toBe(state2);

    // Valid param (state1) but the cookie carries a *different* valid token (state2).
    const mismatch = await request(app.server)
      .get(`/api/v1/auth/google/callback?code=fake-code&state=${state1}`)
      .set('Cookie', `oauth_state=${state2}`);
    expect(mismatch.status).toBe(302);
    expect(mismatch.headers.location).toContain('error=invalid_state');
  });

  it('rejects a callback with a valid state param but no cookie', async () => {
    const start = await request(app.server).get('/api/v1/auth/google');
    const state = cookieValue(start.headers['set-cookie'] as unknown as string[], 'oauth_state')!;

    const noCookie = await request(app.server).get(
      `/api/v1/auth/google/callback?code=fake-code&state=${state}`,
    );
    expect(noCookie.status).toBe(302);
    expect(noCookie.headers.location).toContain('error=invalid_state');
  });
});

// ─── per-IP rate limiting ────────────────────────────────────────────────────

describe('rate limiting', () => {
  it('returns a 429 RATE_LIMITED envelope once the auth limit is exceeded', async () => {
    // /login is limited to 30/min per IP; only this test hits it in this file.
    // An empty body 400s at schema validation (cheap), but still counts against the
    // per-IP limit, which is enforced before validation.
    const statuses: number[] = [];
    let limited: request.Response | undefined;
    for (let i = 0; i < 40; i++) {
      const res = await request(app.server).post('/api/v1/auth/login').send({});
      statuses.push(res.status);
      if (res.status === 429) limited = res;
    }

    expect(statuses[0]).not.toBe(429); // first requests are allowed through
    expect(statuses.at(-1)).toBe(429); // the limit is enforced by the end
    expect(limited!.body.error.code).toBe('RATE_LIMITED');
  });
});
