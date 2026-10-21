// Sign-in with a university account — LDAP / Active Directory (Ф12 12.B10, ADR-034),
// against a small in-memory directory (ldapjs server) instead of the university's:
//   - the login page learns the method and its label from /auth/providers;
//   - the right login + password signs in (session `ldap`, audit), a new account gets
//     the full name and the verified email from the directory; the next sign-in finds
//     the same account by the directory id; an account with that email gets the
//     identity attached instead of a duplicate;
//   - a wrong password, an unknown or ambiguous login are the same 401; the login is
//     escaped in the filter, so `*` or `)(` do not match anyone;
//   - a directory that is down or refuses the service account is 503, not 500;
//     without LDAP_URL the method does not exist (404).
//
// Runs against a live Postgres; created rows are removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import ldap from 'ldapjs';

const env = vi.hoisted(() => {
  const port = 30000 + Math.floor(Math.random() * 20000);
  process.env.LDAP_URL = `ldap://127.0.0.1:${port}`;
  process.env.LDAP_BIND_DN = 'cn=svc,dc=university,dc=local';
  process.env.LDAP_BIND_PASSWORD = 'svc-secret';
  process.env.LDAP_SEARCH_BASE = 'ou=staff,dc=university,dc=local';
  process.env.LDAP_SEARCH_FILTER = '(|(uid={{login}})(mail={{login}}))';
  process.env.LDAP_ID_ATTRIBUTE = 'entryUUID';
  process.env.LDAP_LOGIN_HINT = 'Логин как в компьютерных классах';
  process.env.LDAP_TIMEOUT_MS = '2000';
  return { port };
});

import { buildApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { authenticateWithDirectory, escapeFilterValue } from '../src/modules/auth/ldap.service.js';

const TS = Date.now();
const BASE = 'ou=staff,dc=university,dc=local';
const people = {
  ivanov: {
    dn: `uid=ivanov${TS},${BASE}`,
    password: 'Dir-pass-1',
    attributes: {
      uid: `ivanov${TS}`,
      mail: `Ivanov-${TS}@University.local`,
      sn: 'Иванов',
      givenName: 'Пётр',
      middleName: 'Сергеевич',
      entryUUID: `uuid-ivanov-${TS}`,
      objectClass: 'inetOrgPerson',
    },
  },
  petrova: {
    dn: `uid=petrova${TS},${BASE}`,
    password: 'Dir-pass-2',
    attributes: {
      uid: `petrova${TS}`,
      mail: `petrova-${TS}@university.local`,
      sn: 'Петрова',
      givenName: 'Анна',
      entryUUID: `uuid-petrova-${TS}`,
      objectClass: 'inetOrgPerson',
    },
  },
  twinA: {
    dn: `cn=twin-a${TS},${BASE}`,
    password: 'Dir-pass-3',
    attributes: {
      uid: `twin${TS}`,
      sn: 'Близнец',
      entryUUID: `uuid-ta-${TS}`,
      objectClass: 'person',
    },
  },
  twinB: {
    dn: `cn=twin-b${TS},${BASE}`,
    password: 'Dir-pass-3',
    attributes: {
      uid: `twin${TS}`,
      sn: 'Близнец',
      entryUUID: `uuid-tb-${TS}`,
      objectClass: 'person',
    },
  },
};
const SERVICE = { dn: 'cn=svc,dc=university,dc=local', password: 'svc-secret' };

let app: FastifyInstance;
let server: ldap.Server;
const filters: string[] = [];
const userIds: string[] = [];
let ipSeq = 0;

function login(body: { login: string; password: string }) {
  ipSeq += 1;
  return request(app.server)
    .post('/api/v1/auth/ldap/login')
    .set('X-Forwarded-For', `10.44.0.${ipSeq}`)
    .send(body);
}

beforeAll(async () => {
  server = ldap.createServer();
  server.bind(
    'dc=university,dc=local',
    (req: ldap.BindRequest, res: ldap.BindResponse, next: ldap.NextFunction) => {
      const dn = req.dn.toString().replace(/\s+/g, '');
      const password = String(req.credentials);
      const known =
        dn === SERVICE.dn
          ? SERVICE.password
          : Object.values(people).find((p) => p.dn === dn)?.password;
      if (!known || known !== password) return next(new ldap.InvalidCredentialsError());
      res.end();
      return next();
    },
  );
  server.search(
    BASE,
    (req: ldap.SearchRequest, res: ldap.SearchResponse, next: ldap.NextFunction) => {
      filters.push(req.filter.toString());
      // ldapjs compares the requested names with lower-cased entry names; a real
      // directory does not care about case (neither does the service).
      res.attributes = res.attributes.map((name: string) => name.toLowerCase());
      for (const person of Object.values(people)) {
        const lower = Object.fromEntries(
          Object.entries(person.attributes).map(([k, v]) => [k.toLowerCase(), v]),
        );
        if (req.filter.matches(lower)) res.send({ dn: person.dn, attributes: person.attributes });
      }
      res.end();
      return next();
    },
  );
  await new Promise<void>((resolve) => server.listen(env.port, '127.0.0.1', () => resolve()));

  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  const ids = await app.prisma.authIdentity.findMany({
    where: { provider: 'ldap', provider_user_id: { contains: String(TS) } },
    select: { user_id: true },
  });
  userIds.push(...ids.map((i) => i.user_id));
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
  server.close();
});

describe('the login page', () => {
  it('learns about the university account and its label', async () => {
    const res = await request(app.server).get('/api/v1/auth/providers');
    expect(res.body).toMatchObject({
      ldap: true,
      ldap_label: 'Учётная запись университета',
      ldap_hint: 'Логин как в компьютерных классах',
    });
  });
});

describe('signing in', () => {
  it('a new person gets an account with the full name and the verified email', async () => {
    const res = await login({ login: people.ivanov.attributes.uid, password: 'Dir-pass-1' });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();
    expect(res.headers['set-cookie']?.join(';')).toContain('refresh_token');
    const user = await app.prisma.user.findUniqueOrThrow({ where: { id: res.body.user.id } });
    userIds.push(user.id);
    expect(user).toMatchObject({
      email: `ivanov-${TS}@university.local`,
      email_verified: true,
      last_name: 'Иванов',
      first_name: 'Пётр',
      middle_name: 'Сергеевич',
      display_name: 'Иванов Пётр Сергеевич',
      password_hash: null,
    });
    const session = await app.prisma.authSession.findFirst({ where: { user_id: user.id } });
    expect(session?.method).toBe('ldap');
    const audit = await app.prisma.auditLog.findFirst({
      where: { action: 'auth.login', actor_id: user.id },
    });
    expect(audit?.meta).toMatchObject({ method: 'ldap' });
  });

  it('the next sign-in (by mail this time) finds the same account', async () => {
    const first = await app.prisma.authIdentity.findFirstOrThrow({
      where: { provider: 'ldap', provider_user_id: `uuid-ivanov-${TS}` },
    });
    const res = await login({ login: people.ivanov.attributes.mail, password: 'Dir-pass-1' });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(first.user_id);
  });

  it('an account with the same email gets the directory attached, not a twin', async () => {
    const reg = await request(app.server)
      .post('/api/v1/auth/register')
      .set('X-Forwarded-For', '10.44.1.1')
      .send({
        email: people.petrova.attributes.mail,
        password: 'Password123!',
        display_name: 'Анна Петрова',
      });
    expect(reg.status).toBe(201);
    userIds.push(reg.body.user.id);
    // A verified address (sign-up by code) is what the merge relies on.
    await app.prisma.user.update({
      where: { id: reg.body.user.id },
      data: { email_verified: true },
    });

    const res = await login({ login: people.petrova.attributes.uid, password: 'Dir-pass-2' });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(reg.body.user.id);
  });
});

describe('refusals', () => {
  it('a wrong password, an unknown or an ambiguous login are the same 401', async () => {
    for (const body of [
      { login: people.ivanov.attributes.uid, password: 'wrong' },
      { login: `nobody${TS}`, password: 'Dir-pass-1' },
      { login: `twin${TS}`, password: 'Dir-pass-3' },
    ]) {
      const res = await login(body);
      expect(res.status, body.login).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    }
  });

  it('the login is escaped: wildcards and filter pieces match no one', async () => {
    for (const evil of ['*', `ivanov${TS})(uid=*`, `*)(objectClass=*`]) {
      const res = await login({ login: evil, password: 'Dir-pass-1' });
      expect(res.status, evil).toBe(401);
    }
    expect(filters.some((f) => f.includes('\\2a'))).toBe(true);
    expect(escapeFilterValue('a*b(c)d\\e')).toBe('a\\2ab\\28c\\29d\\5ce');
  });

  it('an unreachable directory or a refused service account is 503, not 500', async () => {
    const closed = { ...config, LDAP_URL: 'ldap://127.0.0.1:1', LDAP_TIMEOUT_MS: 1000 };
    await expect(
      authenticateWithDirectory(people.ivanov.attributes.uid, 'Dir-pass-1', closed),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'LDAP_UNAVAILABLE',
      details: { reason: 'connect' },
    });

    const badService = { ...config, LDAP_BIND_PASSWORD: 'not-the-secret' };
    await expect(
      authenticateWithDirectory(people.ivanov.attributes.uid, 'Dir-pass-1', badService),
    ).rejects.toMatchObject({ statusCode: 503, details: { reason: 'service_bind' } });
  });

  it('without LDAP_URL the method does not exist', async () => {
    await expect(
      authenticateWithDirectory('ivanov', 'x', { ...config, LDAP_URL: undefined }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'LDAP_DISABLED' });
  });
});
