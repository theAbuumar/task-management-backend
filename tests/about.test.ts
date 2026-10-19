// `GET /api/v1/about` (13.D4, 13.F4): the API version from package.json, the
// build commit and the support contact from the stand's settings; signed-in only.

import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const email = `about-${TS}@example.com`;
let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  process.env.APP_COMMIT = 'abc1234';
  process.env.SUPPORT_CONTACT = 'IT-центр: it@university.example, вн. 123';
  const { buildApp } = await import('../src/app.js');
  app = await buildApp({ logger: false });
  await app.ready();
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: 'Password123!', display_name: 'О Системе' });
  token = res.body.access_token;
});

afterAll(async () => {
  await app.prisma.refreshToken.deleteMany({ where: { user: { email } } });
  await app.prisma.user.deleteMany({ where: { email } });
  await app.close();
  delete process.env.APP_COMMIT;
  delete process.env.SUPPORT_CONTACT;
});

describe('about', () => {
  it('tells the version, the build and whom to contact', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const res = await request(app.server)
      .get('/api/v1/about')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: pkg.version,
      commit: 'abc1234',
      support: 'IT-центр: it@university.example, вн. 123',
    });
    expect(Date.parse(res.body.started_at)).toBeLessThanOrEqual(Date.now());
  });

  it('is not shown to anonymous visitors', async () => {
    expect((await request(app.server).get('/api/v1/about')).status).toBe(401);
  });
});
