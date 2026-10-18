// `GET /health` (liveness) and `GET /ready` (readiness) — Ф12 12.B9. Both are
// public and unauthenticated: probes of Docker, the stand scripts and an external
// uptime monitor call them. See service.ts for what each one checks.

import type { FastifyInstance } from 'fastify';
import { readiness } from './service.js';

const dependency = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['up', 'down'] },
    latency_ms: { type: 'integer' },
  },
} as const;

const readinessShape = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ready', 'not_ready'] },
    uptime: { type: 'number' },
    checks: {
      type: 'object',
      properties: {
        database: dependency,
        storage: dependency,
        scheduler: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['off', 'starting', 'ok', 'stale', 'failing'] },
            last_run_at: { type: 'string', format: 'date-time', nullable: true },
          },
        },
        realtime: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['idle', 'connecting', 'listening', 'reconnecting'] },
            streams: { type: 'integer' },
          },
        },
      },
    },
  },
} as const;

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/health',
    {
      schema: {
        tags: ['Health'],
        summary: 'Liveness: the process answers',
        description:
          'Always 200 while the process runs; checks no dependency, so a database outage does not get a healthy process restarted. Use `/ready` to know whether the instance can serve requests.',
        response: {
          200: {
            type: 'object',
            properties: { status: { type: 'string', enum: ['ok'] }, uptime: { type: 'number' } },
          },
        },
      },
    },
    async () => ({ status: 'ok', uptime: process.uptime() }),
  );

  app.get(
    '/ready',
    {
      schema: {
        tags: ['Health'],
        summary: 'Readiness: database and file storage answer',
        description:
          '200 `ready` when the database answers and the file storage accepts writes (each within 3 s), else 503 `not_ready`. ' +
          'The reminder scheduler (`off` | `starting` | `ok` | `stale` | `failing`) and the live-update listener ' +
          '(`idle` until the first stream opens | `connecting` | `listening` | `reconnecting`) are reported for diagnostics ' +
          'and do not affect the status. Failure reasons are logged, not returned.',
        response: { 200: readinessShape, 503: readinessShape },
      },
    },
    async (_request, reply) => {
      const result = await readiness(app);
      return reply.status(result.status === 'ready' ? 200 : 503).send(result);
    },
  );
}
