// Integration tests for the per-user rate limits (Ф12 12.B5): changes inside a
// workspace share one budget per person, exports have their own, reads are not
// limited, and one person's budget does not affect another's on the same IP.
//
// The limits are set low here, before the app (and its config) is loaded; every
// other test file runs with high limits (tests/setup.ts). Runs against a live
// Postgres; everything is removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `rl-${TS}`;
const emails = {
  rector: `rl-rector-${TS}@example.com`,
  dean: `rl-dean-${TS}@example.com`,
  clerk: `rl-clerk-${TS}@example.com`,
};

type Actor = { id: string; token: string };
let app: FastifyInstance;
let rector: Actor;
let dean: Actor;
let clerk: Actor;
let projectId: string;
let limitKind: (method: string, url: string) => string | null;

const api = (path: string) => `/api/v1/workspaces/${SLUG}${path}`;

async function register(email: string): Promise<Actor> {
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, display_name: email.split('@')[0] });
  expect(res.status).toBe(201);
  return { id: res.body.user.id, token: res.body.access_token };
}

function as(actor: Actor) {
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${actor.token}`);
  return {
    get: (url: string) => auth(request(app.server).get(url)),
    post: (url: string, body?: object) => auth(request(app.server).post(url)).send(body ?? {}),
  };
}

beforeAll(async () => {
  process.env.RATE_LIMIT_WRITES = '5';
  process.env.RATE_LIMIT_EXPORTS = '2';
  const { buildApp } = await import('../src/app.js');
  ({ limitKind } = await import('../src/plugins/write-limits.js'));
  app = await buildApp({ logger: false });
  await app.ready();
  rector = await register(emails.rector);
  dean = await register(emails.dean);
  clerk = await register(emails.clerk);
  await as(rector).post('/api/v1/workspaces', { name: 'Лимиты', slug: SLUG });
  await as(rector).post(api('/members'), { user_id: dean.id, role: 'member' });
  await as(rector).post(api('/members'), { user_id: clerk.id, role: 'member' });
  const project = await as(rector).post(api('/projects'), { name: 'Проект', identifier: 'RL' });
  projectId = project.body.id;
});

afterAll(async () => {
  const list = Object.values(emails);
  await app.prisma.workspace.deleteMany({ where: { slug: SLUG } });
  await app.prisma.refreshToken.deleteMany({ where: { user: { email: { in: list } } } });
  await app.prisma.user.deleteMany({ where: { email: { in: list } } });
  await app.close();
});

describe('rate limits (12.B5)', () => {
  it('changes share one budget per person; over it — 429 RATE_LIMITED with Retry-After', async () => {
    const states = await as(dean).get(api(`/projects/${projectId}/states`));
    const stateId = states.body[0].id as string;
    for (let n = 0; n < 5; n++) {
      expect((await as(dean).post(api('/notifications/read-all'))).status).toBe(200);
    }
    // The 6th change in the minute, through another route, is refused (a valid
    // request: the check runs after authentication and validation).
    const res = await as(dean).post(api(`/projects/${projectId}/issues`), {
      title: 'Шестая',
      state_id: stateId,
    });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.body.error.details.retry_after).toBeGreaterThan(0);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);

    // Reading is not limited.
    for (let n = 0; n < 8; n++) {
      expect((await as(dean).get(api('/projects'))).status).toBe(200);
    }
    // Another person on the same IP still works.
    expect((await as(clerk).post(api('/notifications/read-all'))).status).toBe(200);
  });

  it('report exports have their own budget', async () => {
    for (let n = 0; n < 2; n++) {
      expect((await as(clerk).get(api('/reports/discipline.pdf'))).status).toBe(200);
    }
    const res = await as(clerk).get(api('/reports/assignments.xlsx'));
    expect(res.status).toBe(429);
    expect(res.body.error.message).toContain('report exports');
  });

  it('classifies routes', () => {
    const ws = '/api/v1/workspaces/:workspaceSlug';
    expect(limitKind('POST', `${ws}/projects/:projectId/issues`)).toBe('write');
    expect(limitKind('DELETE', `${ws}/trash/:type/:id`)).toBe('write');
    expect(limitKind('POST', '/api/v1/workspaces')).toBe('write');
    expect(limitKind('GET', `${ws}/projects`)).toBeNull();
    expect(limitKind('GET', `${ws}/reports/discipline.pdf`)).toBe('export');
    expect(limitKind('GET', `${ws}/projects/:projectId/report.pdf`)).toBe('export');
    expect(limitKind('POST', `${ws}/ai/report/export`)).toBe('export');
    expect(limitKind('GET', `${ws}/search`)).toBe('search');
    expect(limitKind('POST', '/api/v1/auth/login')).toBeNull();
  });
});
