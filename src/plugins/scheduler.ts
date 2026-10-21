// Background scheduler (Ф5 5.B1). Runs the deadline-reminder pass every few
// minutes inside the API process, creates the issues of recurring rules whose run
// is due (Ф6 6.B4, ADR-030), sends the planned reports whose time has come (Ф10
// 10.B5, ADR-032), and empties the trash of what was deleted more than 30 days ago
// (Ф7 7.B6, ADR-017). Every 30 seconds a lighter pass sends the queued Telegram /
// email copies of notifications that are due: retries, copies that waited for the
// end of quiet hours, digests (Ф8 8.B3, 8.B5, ADR-033).
//
// "Режим 6 дней" simplification of ADR-009 (pg-boss): a timer + a PostgreSQL
// advisory lock, so with several instances only one runs a pass at a time, and
// ReminderLog makes every reminder idempotent. Disabled under test and with
// JOBS_ENABLED=false.

import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { config } from '../config/index.js';
import { runReminders } from '../modules/control/reminders.js';
import { runRecurring } from '../modules/recurring/service.js';
import { runReportSchedules } from '../modules/report-schedules/run.js';
import { purgeExpiredTrash } from '../modules/trash/service.js';
import { writeAudit } from '../lib/audit.js';
import { purgeDeliveries, runDeliveries } from '../lib/notify/send.js';
import { runDigests } from '../lib/notify/digest.js';

const INTERVAL_MS = 5 * 60 * 1000;
const DELIVERY_INTERVAL_MS = 30 * 1000;
const FIRST_RUN_DELAY_MS = 30 * 1000;
/** Arbitrary app-wide key for pg_try_advisory_lock. */
const LOCK_KEY = 420_017;

/** What `/ready` reports about the reminder passes (12.B9). */
export interface SchedulerState {
  enabled: boolean;
  startedAt: Date;
  lastRunAt: Date | null;
  lastErrorAt: Date | null;
}

export type SchedulerHealth = 'off' | 'starting' | 'ok' | 'stale' | 'failing';

/**
 * `off` — disabled (JOBS_ENABLED=false, tests); `starting` — the first pass is not
 * due yet; `failing` — the latest pass threw; `stale` — no pass for two intervals
 * (the process is stuck or the lock is held elsewhere for too long); else `ok`.
 */
export function schedulerHealth(state: SchedulerState, now = new Date()): SchedulerHealth {
  if (!state.enabled) return 'off';
  if (state.lastErrorAt && (!state.lastRunAt || state.lastErrorAt > state.lastRunAt)) {
    return 'failing';
  }
  const since = (state.lastRunAt ?? state.startedAt).getTime();
  const allowed = 2 * INTERVAL_MS + (state.lastRunAt ? 0 : FIRST_RUN_DELAY_MS);
  if (now.getTime() - since > allowed) return 'stale';
  return state.lastRunAt ? 'ok' : 'starting';
}

declare module 'fastify' {
  interface FastifyInstance {
    scheduler: SchedulerState;
  }
}

async function schedulerPlugin(app: FastifyInstance): Promise<void> {
  const state: SchedulerState = {
    enabled: config.JOBS_ENABLED,
    startedAt: new Date(),
    lastRunAt: null,
    lastErrorAt: null,
  };
  app.decorate('scheduler', state);
  if (!config.JOBS_ENABLED) return;

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      // A transaction-scoped lock is held by the transaction's own connection and
      // released at commit — a session lock could stick to a pooled connection.
      await app.prisma.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<{ locked: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS locked`;
          if (!rows[0]?.locked) return;
          // Recurring issues first (6.B4): a report created at 09:00 gets its own
          // reminders in the same pass.
          const recurring = await runRecurring(app.prisma);
          if (recurring.created + recurring.failed + recurring.paused > 0) {
            app.log.info({ recurring }, 'recurring issues created');
          }
          const result = await runReminders(app.prisma);
          const sent = result.sent.due_soon + result.sent.overdue + result.sent.escalated;
          if (sent > 0) app.log.info({ reminders: result.sent }, 'deadline reminders sent');

          // Digests whose hour has come (8.B5); the 30-second pass sends them.
          const digests = await runDigests(app.prisma);
          if (digests.daily + digests.weekly > 0) app.log.info({ digests }, 'digests queued');

          const reports = await runReportSchedules(app.prisma, app.storage);
          if (reports.sent + reports.failed + reports.paused > 0) {
            app.log.info({ reports }, 'planned reports sent');
          }

          const purged = await purgeExpiredTrash(app.prisma, app.storage);
          for (const item of purged) {
            await writeAudit(app.prisma, {
              workspace_id: item.workspace_id,
              actor_id: null,
              action: `${item.type}.purged`,
              target_type: item.type,
              target_id: item.id,
              meta: { title: item.title, auto: true },
            });
          }
          if (purged.length > 0) app.log.info({ purged: purged.length }, 'trash emptied');
          await purgeDeliveries(app.prisma);
        },
        { maxWait: 10_000, timeout: 10 * 60 * 1000 },
      );
      // A pass skipped because another instance holds the lock still counts: this
      // process is alive and the reminders are being sent.
      state.lastRunAt = new Date();
    } catch (err) {
      state.lastErrorAt = new Date();
      app.log.error({ err }, 'reminder pass failed');
    } finally {
      running = false;
    }
  };

  // Copies are claimed row by row (FOR UPDATE SKIP LOCKED), so this pass needs no
  // advisory lock: several instances share the queue without double sends.
  let delivering = false;
  const deliver = async () => {
    if (delivering) return;
    delivering = true;
    try {
      const r = await runDeliveries(app.prisma);
      if (r.sent + r.failed + r.retried + r.deferred + r.skipped > 0) {
        app.log.info({ deliveries: r }, 'notification copies processed');
      }
    } catch (err) {
      app.log.error({ err }, 'delivery pass failed');
    } finally {
      delivering = false;
    }
  };

  const first = setTimeout(() => void tick(), FIRST_RUN_DELAY_MS);
  const interval = setInterval(() => void tick(), INTERVAL_MS);
  const deliveries = setInterval(() => void deliver(), DELIVERY_INTERVAL_MS);
  app.addHook('onClose', async () => {
    clearTimeout(first);
    clearInterval(interval);
    clearInterval(deliveries);
  });
}

export default fp(schedulerPlugin, { name: 'scheduler', dependencies: ['prisma', 'storage'] });
