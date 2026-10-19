// With AI_ENABLED off (the default, ADR-028) the assistant does not exist for
// clients: `status` says `enabled: false`, every other AI route answers
// 404 AI_DISABLED, and nothing reaches a provider.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Whatever another test file set: here the server runs with the default.
vi.hoisted(() => {
  delete process.env.AI_ENABLED;
});

import { buildApp } from '../src/app.js';
import { setAiProvider, type AiProvider } from '../src/lib/ai/provider.js';

const TS = Date.now();
const SLUG = `ai-off-${TS}`;
const EMAIL = `ai-off-${TS}@example.com`;

let app: FastifyInstance;
let token: string;
let calls = 0;

const never = async () => {
  calls++;
  throw new Error('must not be called');
};
const provider: AiProvider = {
  name: 'never',
  model: 'never',
  json: never,
  text: never,
  agent: never,
};

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  setAiProvider(provider);
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email: EMAIL, password: 'Password123!', display_name: 'Off' });
  token = res.body.access_token;
  await request(app.server)
    .post('/api/v1/workspaces')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Без AI', slug: SLUG });
});

afterAll(async () => {
  setAiProvider(null);
  await app.prisma.workspace.deleteMany({ where: { slug: SLUG } });
  await app.prisma.refreshToken.deleteMany({ where: { user: { email: EMAIL } } });
  await app.prisma.user.deleteMany({ where: { email: EMAIL } });
  await app.close();
});

describe('AI turned off', () => {
  it('status is off and every AI route answers AI_DISABLED', async () => {
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
    const base = `/api/v1/workspaces/${SLUG}/ai`;
    const status = await auth(request(app.server).get(`${base}/status`));
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ enabled: false });

    const routes = [
      auth(request(app.server).post(`${base}/ask`)).send({ question: 'Что просрочено?' }),
      auth(request(app.server).post(`${base}/draft-issues`)).send({ text: 'Протокол' }),
      auth(request(app.server).post(`${base}/report`)).send({}),
      auth(request(app.server).post(`${base}/report/export`)).send({
        format: 'pdf',
        title: 'Записка',
        text: 'Текст',
      }),
      auth(request(app.server).get(`${base}/conversations`)),
    ];
    for (const res of await Promise.all(routes)) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('AI_DISABLED');
    }
    expect(calls).toBe(0);
  });
});
