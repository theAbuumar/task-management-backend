// Sign-in methods the login page may show (13.P5): only configured ones, so a
// stand without OAuth or SMTP has no buttons that end in an error.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { authProviders } from '../src/modules/auth/providers.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
};

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('GET /api/v1/auth/providers', () => {
  it('is public and reports every method configured under test', async () => {
    const res = await request(app.server).get('/api/v1/auth/providers');
    expect(res.status).toBe(200);
    // tests/setup.ts configures Google, GitHub and Telegram; email codes go to the console.
    expect(res.body).toEqual({
      email: true,
      google: true,
      github: true,
      telegram: true,
      demo: false,
      ldap: false,
      ldap_label: null,
      ldap_hint: null,
    });
  });
});

describe('authProviders', () => {
  it('production without credentials offers nothing but what is configured', () => {
    const env = parseEnv({
      ...base,
      NODE_ENV: 'production',
      TELEGRAM_BOT_TOKEN: '',
      SMTP_HOST: '',
    });
    expect(authProviders(env)).toEqual({
      email: false,
      google: false,
      github: false,
      telegram: false,
      demo: false,
      ldap: false,
      ldap_label: null,
      ldap_hint: null,
    });
  });

  it('a university account counts with LDAP_URL and a search base (12.B10)', () => {
    const env = parseEnv({
      ...base,
      LDAP_URL: 'ldaps://dc.university.local',
      LDAP_SEARCH_BASE: 'OU=Staff,DC=university,DC=local',
      LDAP_LOGIN_HINT: 'Логин как в компьютерных классах',
    });
    expect(authProviders(env)).toMatchObject({
      ldap: true,
      ldap_label: 'Учётная запись университета',
      ldap_hint: 'Логин как в компьютерных классах',
    });
    expect(() => parseEnv({ ...base, LDAP_URL: 'ldap://dc' })).toThrow(/LDAP_SEARCH_BASE/);
    expect(() =>
      parseEnv({
        ...base,
        LDAP_URL: 'ldap://dc',
        LDAP_SEARCH_BASE: 'DC=u',
        LDAP_BIND_DN: 'CN=svc',
      }),
    ).toThrow(/LDAP_BIND_PASSWORD/);
  });

  it('email needs SMTP or Resend in production, but not in development', () => {
    expect(
      authProviders(parseEnv({ ...base, NODE_ENV: 'production', SMTP_HOST: 'smtp.example.edu' }))
        .email,
    ).toBe(true);
    expect(
      authProviders(parseEnv({ ...base, NODE_ENV: 'production', RESEND_API_KEY: 're_x' })).email,
    ).toBe(true);
    expect(authProviders(parseEnv({ ...base, NODE_ENV: 'development' })).email).toBe(true);
  });

  it('an OAuth provider counts only with id, secret and callback; Telegram with token and username', () => {
    const partial = parseEnv({
      ...base,
      NODE_ENV: 'production',
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
      GITHUB_CLIENT_ID: 'id',
      GITHUB_CLIENT_SECRET: 'secret',
      GITHUB_CALLBACK_URL: 'https://tasks.example.edu/api/v1/auth/github/callback',
      TELEGRAM_BOT_TOKEN: '1:token',
      DEMO_MODE: 'true',
    });
    expect(authProviders(partial)).toMatchObject({
      google: false,
      github: true,
      telegram: false,
      demo: true,
    });
  });
});
