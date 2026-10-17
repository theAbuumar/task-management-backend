// Background scheduler (Ф5 5.B1). Runs the deadline-reminder pass every few
// minutes inside the API process.
//
// "Режим 6 дней" simplification of ADR-009 (pg-boss): a timer + a PostgreSQL
// advisory lock, so with several instances only one runs a pass at a time, and
// ReminderLog makes every reminder idempotent. Disabled under test and with
// JOBS_ENABLED=false.

import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { config } from '../config/index.js';
import { runReminders } from '../modules/control/reminders.js';

const INTERVAL_MS = 5 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 30 * 1000;
/** Arbitrary app-wide key for pg_try_advisory_lock. */
const LOCK_KEY = 420_017;

async function schedulerPlugin(app: FastifyInstance): Promise<void> {
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
          const result = await runReminders(app.prisma);
          const sent = result.sent.due_soon + result.sent.overdue + result.sent.escalated;
          if (sent > 0) app.log.info({ reminders: result.sent }, 'deadline reminders sent');
        },
        { maxWait: 10_000, timeout: 10 * 60 * 1000 },
      );
    } catch (err) {
      app.log.error({ err }, 'reminder pass failed');
    } finally {
      running = false;
    }
  };

  const first = setTimeout(() => void tick(), FIRST_RUN_DELAY_MS);
  const interval = setInterval(() => void tick(), INTERVAL_MS);
  app.addHook('onClose', async () => {
    clearTimeout(first);
    clearInterval(interval);
  });
}

export default fp(schedulerPlugin, { name: 'scheduler', dependencies: ['prisma'] });
