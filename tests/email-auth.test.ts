// Integration tests for the email + password OTP flow (auth_tz.md §6).
//
// Runs against a live Postgres. The plaintext OTP is never returned by the API —
// in dev/test the mailer logs it to the console, so we spy on console.info and
// pull the 6-digit code out of the stub. Unique emails per run avoid collisions;
// all created rows are removed in afterAll.

import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const emails = {
  happy: `otp-happy-${TS}@example.com`,
  rate: `otp-rate-${TS}@example.com`,
};

let app: FastifyInstance;
let consoleSpy: ReturnType<typeof vi.spyOn>;

/** Pull the most recent 6-digit code out of the captured console output. */
function lastOtp(): string {
  const text = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
  const matches = text.match(/\b\d{6}\b/g);
  if (!matches || matches.length === 0) throw new Error('No OTP found in console output');
  return matches[matches.length - 1]!;
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  const list = Object.values(emails);
  await app.prisma.emailOtp.deleteMany({ where: { email: { in: list } } });
  await app.prisma.user.deleteMany({ where: { email: { in: list } } });
  await app.close();
});

beforeEach(() => {
  consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
});

describe('email OTP signup + verify', () => {
  it('signup creates an inactive account and emails a 6-digit code', async () => {
    const res = await request(app.server)
      .post('/api/v1/auth/email/signup')
      .send({ email: emails.happy, password: PASSWORD, display_name: 'OTP Tester' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'otp_sent', email: emails.happy });
    expect(lastOtp()).toMatch(/^\d{6}$/);

    const user = await app.prisma.user.findUnique({ where: { email: emails.happy } });
    expect(user?.is_active).toBe(false);
    expect(user?.email_verified).toBe(false);
  });

  it('login before verifying is rejected with a verification hint', async () => {
    const res = await request(app.server)
      .post('/api/v1/auth/email/login')
      .send({ email: emails.happy, password: PASSWORD });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/verify/i);
  });

  it('verify with a wrong code is rejected (400)', async () => {
    const res = await request(app.server)
      .post('/api/v1/auth/email/verify')
      .send({ email: emails.happy, code: '000000' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('full happy path on a fresh email: signup → verify → login', async () => {
    const email = `otp-full-${TS}@example.com`;
    try {
      const signup = await request(app.server)
        .post('/api/v1/auth/email/signup')
        .send({ email, password: PASSWORD, display_name: 'Full Path' });
      expect(signup.status).toBe(200);
      const code = lastOtp();

      const verify = await request(app.server)
        .post('/api/v1/auth/email/verify')
        .send({ email, code });
      expect(verify.status).toBe(200);
      expect(verify.body.access_token).toBeTruthy();
      expect(verify.body.refresh_token).toBeTruthy();
      expect(verify.body.user.email).toBe(email);
      expect(verify.body.user.email_verified).toBe(true);

      // The `email` identity row was ensured.
      const identity = await app.prisma.authIdentity.findFirst({
        where: { user: { email }, provider: 'email' },
      });
      expect(identity).toBeTruthy();

      const login = await request(app.server)
        .post('/api/v1/auth/email/login')
        .send({ email, password: PASSWORD });
      expect(login.status).toBe(200);
      expect(login.body.access_token).toBeTruthy();

      // Reusing the same (now consumed) code fails.
      const replay = await request(app.server)
        .post('/api/v1/auth/email/verify')
        .send({ email, code });
      expect(replay.status).toBe(400);
    } finally {
      await app.prisma.emailOtp.deleteMany({ where: { email } });
      await app.prisma.user.deleteMany({ where: { email } });
    }
  });

  it('enforces the 1-per-60s send rate limit', async () => {
    const first = await request(app.server)
      .post('/api/v1/auth/email/signup')
      .send({ email: emails.rate, password: PASSWORD, display_name: 'Rate Limited' });
    expect(first.status).toBe(200);

    const second = await request(app.server)
      .post('/api/v1/auth/email/signup')
      .send({ email: emails.rate, password: PASSWORD, display_name: 'Rate Limited' });
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('RATE_LIMITED');
  });
});
