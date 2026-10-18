// Observability (Ф12 12.B9):
//   - every response carries X-Request-Id; a well-formed incoming id is kept, a
//     malformed one replaced; a 500 repeats the id in its details;
//   - /health is liveness only: it answers even when the database does not;
//   - /ready reports database, storage, scheduler and live-update listener, and
//     answers 503 when the database or the storage is down — without leaking why;
//   - the scheduler health rules and the local storage probe.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { schedulerHealth, type SchedulerState } from '../src/plugins/scheduler.js';
import { LocalStorageDriver } from '../src/lib/storage.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  app.get('/test-boom', async () => {
    throw new Error('kaboom: secret internal detail');
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('request id', () => {
  it('every response carries a fresh UUID, different per request', async () => {
    const a = await request(app.server).get('/api/v1/auth/providers');
    const b = await request(app.server).get('/api/v1/auth/providers');
    expect(a.headers['x-request-id']).toMatch(UUID);
    expect(b.headers['x-request-id']).toMatch(UUID);
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });

  it('keeps a well-formed id from the proxy, replaces a malformed one', async () => {
    const kept = await request(app.server)
      .get('/api/v1/auth/providers')
      .set('X-Request-Id', 'caddy-7f3a.92:01');
    expect(kept.headers['x-request-id']).toBe('caddy-7f3a.92:01');

    for (const bad of ['short', 'has spaces in it', 'x'.repeat(129), 'id<script>alert(1)']) {
      const res = await request(app.server).get('/api/v1/auth/providers').set('X-Request-Id', bad);
      expect(res.headers['x-request-id']).toMatch(UUID);
    }
  });

  it('is on errors and 404s too; a 500 repeats it in the details and hides the cause', async () => {
    const missing = await request(app.server).get('/api/v1/no-such-route');
    expect(missing.status).toBe(404);
    expect(missing.headers['x-request-id']).toMatch(UUID);

    const boom = await request(app.server).get('/test-boom');
    expect(boom.status).toBe(500);
    expect(boom.body.error.details.requestId).toBe(boom.headers['x-request-id']);
    expect(JSON.stringify(boom.body)).not.toContain('secret internal detail');
  });

  it('is readable by a browser on another origin (exposed by CORS)', async () => {
    const res = await request(app.server)
      .get('/api/v1/auth/providers')
      .set('Origin', 'http://localhost:5173');
    expect(String(res.headers['access-control-expose-headers'])).toContain('X-Request-Id');
  });
});

describe('/health — liveness', () => {
  it('answers ok without touching the database', async () => {
    const db = vi.spyOn(app.prisma, '$queryRaw').mockRejectedValue(new Error('db is down'));
    const res = await request(app.server).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', uptime: expect.any(Number) });
    expect(db).not.toHaveBeenCalled();
  });
});

describe('/ready — readiness', () => {
  it('ready: database and storage up, scheduler and live updates reported', async () => {
    const res = await request(app.server).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ready',
      checks: {
        database: { status: 'up', latency_ms: expect.any(Number) },
        storage: { status: 'up', latency_ms: expect.any(Number) },
        // Tests run with JOBS_ENABLED=false.
        scheduler: { status: 'off', last_run_at: null },
        realtime: { status: expect.stringMatching(/idle|connecting|listening/), streams: 0 },
      },
    });
  });

  it('503 when the database is down — the reason is logged, not returned', async () => {
    vi.spyOn(app.prisma, '$queryRaw').mockRejectedValue(
      new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'),
    );
    const res = await request(app.server).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.checks.database.status).toBe('down');
    expect(res.body.checks.storage.status).toBe('up');
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|hunter2/);
  });

  it('503 when the file storage cannot take writes', async () => {
    vi.spyOn(app.storage, 'ping').mockRejectedValue(new Error('EACCES: permission denied'));
    const res = await request(app.server).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.checks).toMatchObject({
      database: { status: 'up' },
      storage: { status: 'down' },
    });
    expect(JSON.stringify(res.body)).not.toContain('EACCES');
  });
});

describe('scheduler health', () => {
  const MIN = 60_000;
  const t0 = new Date('2026-10-20T09:00:00Z');
  const at = (ms: number) => new Date(t0.getTime() + ms);
  const state = (s: Partial<SchedulerState>): SchedulerState => ({
    enabled: true,
    startedAt: t0,
    lastRunAt: null,
    lastErrorAt: null,
    ...s,
  });

  it('off when disabled', () => {
    expect(schedulerHealth(state({ enabled: false }), at(60 * MIN))).toBe('off');
  });

  it('starting until the first pass, stale if it never comes', () => {
    expect(schedulerHealth(state({}), at(1 * MIN))).toBe('starting');
    expect(schedulerHealth(state({}), at(10 * MIN))).toBe('starting');
    expect(schedulerHealth(state({}), at(11 * MIN))).toBe('stale');
  });

  it('ok after a pass, stale after two missed intervals', () => {
    const ran = state({ lastRunAt: at(1 * MIN) });
    expect(schedulerHealth(ran, at(6 * MIN))).toBe('ok');
    expect(schedulerHealth(ran, at(12 * MIN))).toBe('stale');
  });

  it('failing after a failed pass, ok again once a pass succeeds', () => {
    expect(schedulerHealth(state({ lastErrorAt: at(1 * MIN) }), at(2 * MIN))).toBe('failing');
    expect(
      schedulerHealth(state({ lastRunAt: at(1 * MIN), lastErrorAt: at(6 * MIN) }), at(7 * MIN)),
    ).toBe('failing');
    expect(
      schedulerHealth(state({ lastErrorAt: at(1 * MIN), lastRunAt: at(6 * MIN) }), at(7 * MIN)),
    ).toBe('ok');
  });
});

describe('local storage probe', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ready-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a missing upload directory and passes', async () => {
    const driver = new LocalStorageDriver({
      baseDir: path.join(dir, 'uploads'),
      baseUrl: 'http://x',
      ttl: 60,
      downloadTtl: 60,
      secret: 'x',
    });
    await expect(driver.ping()).resolves.toBeUndefined();
  });

  it('fails when the upload path is not a writable directory', async () => {
    const file = path.join(dir, 'not-a-dir');
    await writeFile(file, 'x');
    const driver = new LocalStorageDriver({
      baseDir: file,
      baseUrl: 'http://x',
      ttl: 60,
      downloadTtl: 60,
      secret: 'x',
    });
    await expect(driver.ping()).rejects.toThrow();
  });
});
