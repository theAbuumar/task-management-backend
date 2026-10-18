// Task numbers under concurrency (found by the 12.F4 load script): tasks created
// in the same project at the same moment used to read the same last number, and
// all but one failed with a 500 on UNIQUE(project_id, sequence_id). Creation is
// now serialized per project (row lock in nextSequenceId).
//
// Runs against a live Postgres. All created rows are removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const EMAIL = `seq-owner-${TS}@example.com`;
const SLUG = `seq-${TS}`;

let app: FastifyInstance;
let token: string;
let projectId: string;
let stateId: string;

const api = (path: string) => `/api/v1/workspaces/${SLUG}${path}`;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const reg = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email: EMAIL, password: 'Password123!', display_name: 'Seq' });
  token = reg.body.access_token;
  const auth = { Authorization: `Bearer ${token}` };
  await request(app.server)
    .post('/api/v1/workspaces')
    .set(auth)
    .send({ name: 'Номера', slug: SLUG });
  const project = await request(app.server)
    .post(api('/projects'))
    .set(auth)
    .send({ name: 'Параллельно', identifier: 'SEQ' });
  projectId = project.body.id;
  const states = await request(app.server)
    .get(api(`/projects/${projectId}/states`))
    .set(auth);
  stateId = states.body[0].id;
});

afterAll(async () => {
  await app.prisma.workspace.deleteMany({ where: { slug: SLUG } });
  await app.prisma.refreshToken.deleteMany({ where: { user: { email: EMAIL } } });
  await app.prisma.user.deleteMany({ where: { email: EMAIL } });
  await app.close();
});

describe('issue numbers', () => {
  it('tasks created at the same moment in one project all succeed with distinct numbers', async () => {
    const N = 12;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        request(app.server)
          .post(api(`/projects/${projectId}/issues`))
          .set('Authorization', `Bearer ${token}`)
          .send({ title: `Параллельная задача ${i + 1}`, state_id: stateId }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(N).fill(201));
    const numbers = results.map((r) => r.body.sequence_id as number).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });
});
