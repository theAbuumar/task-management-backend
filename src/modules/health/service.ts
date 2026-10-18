// Liveness and readiness (Ф12 12.B9).
//
//   - liveness  (`/health`) — the process answers; it touches nothing else, so a
//     database outage does not make an orchestrator restart a healthy process;
//   - readiness (`/ready`)  — the instance can serve requests: the database answers
//     and the file storage accepts writes. The reminder scheduler and the live-update
//     listener are reported too, for diagnostics, but do not decide readiness:
//     without them the API still works, only reminders or live updates lag.
//
// Failure details go to the log, never to the response: the endpoint is public.

import type { FastifyInstance } from 'fastify';
import { schedulerHealth, type SchedulerHealth } from '../../plugins/scheduler.js';

/** A dependency that does not answer within this time counts as down. */
export const CHECK_TIMEOUT_MS = 3_000;

export interface DependencyCheck {
  status: 'up' | 'down';
  latency_ms: number;
}

export interface Readiness {
  status: 'ready' | 'not_ready';
  uptime: number;
  checks: {
    database: DependencyCheck;
    storage: DependencyCheck;
    scheduler: { status: SchedulerHealth; last_run_at: string | null };
    realtime: { status: 'idle' | 'connecting' | 'listening' | 'reconnecting'; streams: number };
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function check(
  app: FastifyInstance,
  name: string,
  probe: () => Promise<unknown>,
): Promise<DependencyCheck> {
  const started = performance.now();
  const latency = () => Math.round(performance.now() - started);
  try {
    await withTimeout(probe(), CHECK_TIMEOUT_MS);
    return { status: 'up', latency_ms: latency() };
  } catch (err) {
    app.log.error({ err, dependency: name }, 'readiness check failed');
    return { status: 'down', latency_ms: latency() };
  }
}

export async function readiness(app: FastifyInstance): Promise<Readiness> {
  const [database, storage] = await Promise.all([
    check(app, 'database', () => app.prisma.$queryRaw`SELECT 1`),
    check(app, 'storage', () => app.storage.ping()),
  ]);
  const ready = database.status === 'up' && storage.status === 'up';
  const { listener, streams } = app.realtime.status;
  return {
    status: ready ? 'ready' : 'not_ready',
    uptime: process.uptime(),
    checks: {
      database,
      storage,
      scheduler: {
        status: schedulerHealth(app.scheduler),
        last_run_at: app.scheduler.lastRunAt?.toISOString() ?? null,
      },
      realtime: { status: listener, streams },
    },
  };
}
