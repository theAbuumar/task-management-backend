// A password as an additional sign-in method (Ф12 12.B12, ADR-034):
//   - an account without a password is told so on /auth/login (NO_PASSWORD) and
//     shows `has_password: false`;
//   - setting one takes a code sent to the email; the policy (letters, digits, not
//     common, not the email or name) is checked before the code, so a weak password
//     does not use it up; an account without email cannot set one;
//   - after setting or changing, other sessions are ended, the current one keeps
//     working, a «Пароль изменён» letter goes out and the audit log has the event;
//   - change needs the current password; a wrong one counts toward the lock;
//   - 10 wrong passwords in a row lock password sign-in for 15 minutes (429 with
//     retry time, written to the audit log); sign-in by code still works; the right
//     password after the lock resets the count;
//   - sign-up refuses a weak password too.
//
// Runs against a live Postgres; created rows are removed in afterAll. Each scenario
// uses its own client IP: the per-IP limit of the auth routes is 30 a minute.

import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { signAccessToken } from '../src/lib/jwt.js';

const TS = Date.now();
const STRONG = 'Ректорат2026!';
const NEWER = 'Kafedra-77-otchet';
const emails = {
  setter: `pwd-set-${TS}@example.com`,
  sessions: `pwd-sess-${TS}@example.com`,
  locked: `pwd-lock-${TS}@example.com`,
  weak: `pwd-weak-${TS}@example.com`,
};

let app: FastifyInstance;
let consoleSpy: ReturnType<typeof vi.spyOn>;
let ipSeq = 0;
const userIds: string[] = [];

/** A fresh client IP for a scenario (trustProxy reads X-Forwarded-For). */
function nextIp(): string {
  ipSeq += 1;
  return `10.12.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

function client(ip: string, token?: string) {
  const prep = (r: request.Test) => {
    r.set('X-Forwarded-For', ip);
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };
  return {
    get: (url: string) => prep(request(app.server).get(url)),
    post: (url: string, body?: object) => prep(request(app.server).post(url)).send(body ?? {}),
  };
}

function mailText(): string {
  return consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

/** The most recent 6-digit code the dev mailer printed. */
function lastCode(): string {
  const codes = mailText().match(/\b\d{6}\b/g);
  if (!codes) throw new Error('No code in the mailer output');
  return codes[codes.length - 1]!;
}

/** Sign in by an email code (the main way): returns the session's tokens. */
async function signInByCode(email: string, ip: string) {
  await app.prisma.emailOtp.updateMany({
    where: { email },
    data: { created_at: new Date(Date.now() - 2 * 60_000) },
  });
  const sent = await client(ip).post('/api/v1/auth/email/otp/request', { email });
  expect(sent.status).toBe(200);
  const res = await client(ip).post('/api/v1/auth/email/otp/verify', { email, code: lastCode() });
  expect(res.status).toBe(200);
  if (!userIds.includes(res.body.user.id)) userIds.push(res.body.user.id);
  return {
    id: res.body.user.id as string,
    token: res.body.access_token as string,
    refresh: res.body.refresh_token as string,
  };
}

/** Allow the next code for this address right away (one per minute otherwise). */
async function allowNextCode(email: string): Promise<void> {
  await app.prisma.emailOtp.updateMany({
    where: { email },
    data: { created_at: new Date(Date.now() - 2 * 60_000) },
  });
}

async function setPasswordFor(email: string, token: string, ip: string, password = STRONG) {
  await allowNextCode(email);
  const sent = await client(ip, token).post('/api/v1/auth/password/code');
  expect(sent.status).toBe(200);
  return client(ip, token).post('/api/v1/auth/password/set', { code: lastCode(), password });
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.prisma.emailOtp.deleteMany({ where: { email: { in: Object.values(emails) } } });
  await app.prisma.emailOtp.deleteMany({ where: { user_id: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

beforeEach(() => {
  consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
});

describe('setting a password with a code', () => {
  it('an account without a password: NO_PASSWORD on login, has_password false', async () => {
    const ip = nextIp();
    const me = await signInByCode(emails.setter, ip);
    const login = await client(ip).post('/api/v1/auth/login', {
      email: emails.setter,
      password: STRONG,
    });
    expect(login.status).toBe(400);
    expect(login.body.error.code).toBe('NO_PASSWORD');

    const profile = await client(ip, me.token).get('/api/v1/auth/me');
    expect(profile.body.has_password).toBe(false);
    expect(profile.body).not.toHaveProperty('password_hash');
    expect(profile.body).not.toHaveProperty('password_failures');
  });

  it('a weak password is refused before the code is checked, with the reasons', async () => {
    const ip = nextIp();
    const me = await signInByCode(emails.setter, ip);
    await allowNextCode(emails.setter);
    const sent = await client(ip, me.token).post('/api/v1/auth/password/code');
    expect(sent.body).toEqual({ status: 'otp_sent', channel: 'email', email: emails.setter });
    const code = lastCode();

    const cases: [string, string][] = [
      ['short1', 'too_short'],
      ['толькобуквы', 'needs_digit'],
      ['1234567890', 'needs_letter'],
      ['Qwerty123', 'common'],
      [`${emails.setter.split('@')[0]}7`, 'personal'],
    ];
    for (const [password, reason] of cases) {
      const res = await client(ip, me.token).post('/api/v1/auth/password/set', { code, password });
      expect(res.status, password).toBe(400);
      expect(res.body.error.code).toBe('WEAK_PASSWORD');
      expect(res.body.error.details.reasons).toContain(reason);
    }

    // The same code still works for a good password.
    const ok = await client(ip, me.token).post('/api/v1/auth/password/set', {
      code,
      password: STRONG,
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ has_password: true });
    expect(mailText()).toContain('Пароль для входа изменён');

    const profile = await client(ip, me.token).get('/api/v1/auth/me');
    expect(profile.body.has_password).toBe(true);
    expect(profile.body.password_changed_at).toBeTruthy();

    const login = await client(ip).post('/api/v1/auth/login', {
      email: emails.setter,
      password: STRONG,
    });
    expect(login.status).toBe(200);
    const session = await app.prisma.authSession.findFirst({
      where: { user_id: me.id },
      orderBy: { created_at: 'desc' },
    });
    expect(session?.method).toBe('password');
  });

  it('with the password, the code request checks the policy first and sends nothing', async () => {
    const ip = nextIp();
    const me = await signInByCode(emails.setter, ip);
    await allowNextCode(emails.setter);
    const before = await app.prisma.emailOtp.count({
      where: { email: emails.setter, purpose: 'set_password' },
    });
    const weak = await client(ip, me.token).post('/api/v1/auth/password/code', {
      password: 'Qwerty123',
    });
    expect(weak.status).toBe(400);
    expect(weak.body.error.details.reasons).toEqual(['common']);
    const after = await app.prisma.emailOtp.count({
      where: { email: emails.setter, purpose: 'set_password' },
    });
    expect(after).toBe(before);

    // Without a body (a browser's bare POST) it still sends the code.
    await allowNextCode(emails.setter);
    const bare = await request(app.server)
      .post('/api/v1/auth/password/code')
      .set('X-Forwarded-For', ip)
      .set('Authorization', `Bearer ${me.token}`);
    expect(bare.status).toBe(200);
  });

  it('a wrong code is refused and the password stays as it was', async () => {
    const ip = nextIp();
    const me = await signInByCode(emails.setter, ip);
    await allowNextCode(emails.setter);
    await client(ip, me.token).post('/api/v1/auth/password/code');
    const wrong = String((Number(lastCode()) + 1) % 1_000_000).padStart(6, '0');
    const res = await client(ip, me.token).post('/api/v1/auth/password/set', {
      code: wrong,
      password: NEWER,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OTP_INVALID');
    const login = await client(ip).post('/api/v1/auth/login', {
      email: emails.setter,
      password: STRONG,
    });
    expect(login.status).toBe(200);
  });

  it('an account without email cannot set a password', async () => {
    const ip = nextIp();
    const user = await app.prisma.user.create({ data: { display_name: 'Только Telegram' } });
    userIds.push(user.id);
    const session = await app.prisma.authSession.create({
      data: { user_id: user.id, expires_at: new Date(Date.now() + 3_600_000) },
    });
    const token = signAccessToken(user.id, session.id);
    const res = await client(ip, token).post('/api/v1/auth/password/code');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EMAIL_REQUIRED');
  });

  it('is written to the audit log, never with the password', async () => {
    const entry = await app.prisma.auditLog.findFirst({
      where: { action: 'auth.password_set', target_id: { in: userIds } },
    });
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry)).not.toContain(STRONG);
  });
});

describe('sessions after a password change', () => {
  it('ends the other sessions and keeps the current one', async () => {
    const ipA = nextIp();
    const ipB = nextIp();
    const current = await signInByCode(emails.sessions, ipA);
    const other = await signInByCode(emails.sessions, ipB);

    const set = await setPasswordFor(emails.sessions, current.token, ipA);
    expect(set.status).toBe(200);
    expect(set.body.signed_out_sessions).toBeGreaterThanOrEqual(1);

    const otherMe = await client(ipB, other.token).get('/api/v1/auth/me');
    expect(otherMe.status).toBe(401);
    const otherRefresh = await client(ipB).post('/api/v1/auth/refresh', {
      refresh_token: other.refresh,
    });
    expect(otherRefresh.status).toBe(401);

    const currentMe = await client(ipA, current.token).get('/api/v1/auth/me');
    expect(currentMe.status).toBe(200);
  });

  it('change needs the right current password and a different new one', async () => {
    const ip = nextIp();
    const me = await signInByCode(emails.sessions, ip);
    const wrong = await client(ip, me.token).post('/api/v1/auth/password/change', {
      current_password: 'Не-тот-пароль-1',
      password: NEWER,
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('WRONG_PASSWORD');

    const same = await client(ip, me.token).post('/api/v1/auth/password/change', {
      current_password: STRONG,
      password: STRONG,
    });
    expect(same.status).toBe(400);
    expect(same.body.error.details.reasons).toEqual(['same_as_current']);

    const ok = await client(ip, me.token).post('/api/v1/auth/password/change', {
      current_password: STRONG,
      password: NEWER,
    });
    expect(ok.status).toBe(200);

    const old = await client(ip).post('/api/v1/auth/login', {
      email: emails.sessions,
      password: STRONG,
    });
    expect(old.status).toBe(401);
    const fresh = await client(ip).post('/api/v1/auth/login', {
      email: emails.sessions,
      password: NEWER,
    });
    expect(fresh.status).toBe(200);
    const audit = await app.prisma.auditLog.findFirst({
      where: { action: 'auth.password_changed', target_id: me.id },
    });
    expect(audit).toBeTruthy();
  });

  it('change before any password is set: NO_PASSWORD', async () => {
    const ip = nextIp();
    const me = await signInByCode(emails.weak, ip);
    const res = await client(ip, me.token).post('/api/v1/auth/password/change', {
      current_password: 'whatever1',
      password: NEWER,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_PASSWORD');
  });
});

describe('the lock after wrong passwords', () => {
  it('locks password sign-in on the 10th wrong one, keeps codes working', async () => {
    const ip = nextIp();
    const me = await signInByCode(emails.locked, ip);
    expect((await setPasswordFor(emails.locked, me.token, ip)).status).toBe(200);

    for (let n = 1; n <= 9; n += 1) {
      const res = await client(nextIp()).post('/api/v1/auth/login', {
        email: emails.locked,
        password: `Wrong-pass-${n}`,
      });
      expect(res.status).toBe(401);
    }
    const tenth = await client(nextIp()).post('/api/v1/auth/login', {
      email: emails.locked,
      password: 'Wrong-pass-10',
    });
    expect(tenth.status).toBe(429);
    expect(tenth.body.error.code).toBe('PASSWORD_LOCKED');
    expect(tenth.body.error.details.retry_after_seconds).toBeGreaterThan(800);

    // Even the right password waits now.
    const right = await client(nextIp()).post('/api/v1/auth/login', {
      email: emails.locked,
      password: STRONG,
    });
    expect(right.status).toBe(429);

    const audit = await app.prisma.auditLog.findMany({
      where: { action: 'auth.password_locked', target_id: me.id },
    });
    expect(audit).toHaveLength(1);

    // A code still signs in.
    const byCode = await signInByCode(emails.locked, nextIp());
    expect(byCode.id).toBe(me.id);
  });

  it('after the lock the right password works and the count starts over', async () => {
    const user = await app.prisma.user.findUniqueOrThrow({ where: { email: emails.locked } });
    await app.prisma.user.update({
      where: { id: user.id },
      data: { password_locked_until: new Date(Date.now() - 1000), password_failures: 3 },
    });
    const ok = await client(nextIp()).post('/api/v1/auth/login', {
      email: emails.locked,
      password: STRONG,
    });
    expect(ok.status).toBe(200);
    const after = await app.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.password_failures).toBe(0);
    expect(after.password_locked_until).toBeNull();
  });

  it('an unknown email gets the same 401 every time and locks nothing', async () => {
    for (let n = 0; n < 3; n += 1) {
      const res = await client(nextIp()).post('/api/v1/auth/login', {
        email: `pwd-nobody-${TS}@example.com`,
        password: 'Wrong-pass-1',
      });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    }
  });
});

describe('the policy on sign-up', () => {
  it('register refuses a common or letters-only password', async () => {
    const ip = nextIp();
    for (const password of ['password123', 'onlyletters']) {
      const res = await client(ip).post('/api/v1/auth/register', {
        email: `pwd-reg-${TS}@example.com`,
        password,
        display_name: 'Слабый пароль',
      });
      expect(res.status, password).toBe(400);
    }
  });
});
