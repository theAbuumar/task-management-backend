// The notification dispatcher, step two (Ф8 8.B3, ADR-033): send queued copies.
//
// - Right after an action commits, the service sends the copies of that task
//   (`deliverNow`), so Telegram rings together with the bell.
// - The scheduler (`runDeliveries`, every 30 s) sends everything else that is due:
//   retries, copies that waited for the end of quiet hours, digests, copies left
//   behind by a crashed process.
// A copy is claimed with `FOR UPDATE SKIP LOCKED`, so two processes never send it
// twice. A channel failure never reaches the action: the copy is retried 5 times
// (after 1, 5, 15 and 60 minutes) and then marked `failed` with the error.

import { Prisma, type NotificationDelivery, type PrismaClient } from '@prisma/client';
import { sendMail } from '../mailer.js';
import { notificationPrefs, quietUntil } from '../notification-prefs.js';
import { sendBotMessage, telegramConfigured } from '../../modules/auth/telegram.service.js';
import { emailMessage, telegramMessage, type RenderInput } from './render.js';
import { localeOf, type DeliveryPayload } from './texts.js';

export const MAX_ATTEMPTS = 5;
/** Minutes to wait before attempt 2, 3, 4 and 5. */
export const BACKOFF_MINUTES = [1, 5, 15, 60];
/** A copy stuck in `sending` this long (the process died mid-send) is queued again. */
const STALE_SENDING_MS = 10 * 60_000;
/** Sent, failed and skipped copies are kept this long. */
export const DELIVERY_RETENTION_DAYS = 90;
const BATCH = 50;

export interface SendResult {
  sent: number;
  failed: number;
  retried: number;
  deferred: number;
  skipped: number;
}

const empty = (): SendResult => ({ sent: 0, failed: 0, retried: 0, deferred: 0, skipped: 0 });

/** Atomically take due copies (optionally only of some tasks or ids) for sending. */
async function claim(
  prisma: PrismaClient,
  now: Date,
  filter: { issueIds?: string[]; ids?: string[] },
  limit: number,
): Promise<NotificationDelivery[]> {
  const conditions = [Prisma.sql`status = 'queued'`, Prisma.sql`next_attempt_at <= ${now}`];
  if (filter.issueIds) conditions.push(Prisma.sql`issue_id = ANY(${filter.issueIds}::text[])`);
  if (filter.ids) conditions.push(Prisma.sql`id = ANY(${filter.ids}::text[])`);
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "NotificationDelivery" SET status = 'sending', updated_at = NOW()
    WHERE id IN (
      SELECT id FROM "NotificationDelivery"
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY next_attempt_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`;
  if (rows.length === 0) return [];
  return prisma.notificationDelivery.findMany({
    where: { id: { in: rows.map((r) => r.id) } },
    orderBy: { created_at: 'asc' },
  });
}

type Outcome = 'sent' | 'failed' | 'retried' | 'deferred' | 'skipped';

/** Send one claimed copy and record what happened. */
async function sendOne(
  prisma: PrismaClient,
  row: NotificationDelivery,
  now: Date,
  workspaces: Map<string, RenderInput['workspace'] | null>,
): Promise<Outcome> {
  const skip = async (reason: string): Promise<Outcome> => {
    await prisma.notificationDelivery.update({
      where: { id: row.id },
      data: { status: 'skipped', reason },
    });
    return 'skipped';
  };

  const user = await prisma.user.findUnique({
    where: { id: row.user_id },
    select: {
      is_active: true,
      email: true,
      locale: true,
      timezone: true,
      notification_settings: true,
      identities: {
        where: { provider: 'telegram', provider_user_id: { not: null } },
        select: { provider_user_id: true },
        take: 1,
      },
      workspace_memberships: {
        where: { workspace_id: row.workspace_id },
        select: { deactivated_at: true },
      },
    },
  });
  if (!user || !user.is_active) return skip('user_inactive');
  const membership = user.workspace_memberships[0];
  if (!membership || membership.deactivated_at) return skip('member_deactivated');

  if (!workspaces.has(row.workspace_id)) {
    workspaces.set(
      row.workspace_id,
      await prisma.workspace.findUnique({
        where: { id: row.workspace_id },
        select: { name: true, short_name: true, logo_url: true, slug: true, timezone: true },
      }),
    );
  }
  const workspace = workspaces.get(row.workspace_id);
  if (!workspace) return skip('workspace_deleted');

  // Quiet hours: wait for their end without spending an attempt. A digest asked for
  // with «Прислать сейчас» is not held.
  const manual = (row.payload as { digest?: { manual?: boolean } } | null)?.digest?.manual === true;
  const until = manual
    ? null
    : quietUntil(
        notificationPrefs(user.notification_settings),
        now,
        user.timezone ?? workspace.timezone,
      );
  if (until) {
    await prisma.notificationDelivery.update({
      where: { id: row.id },
      data: { status: 'queued', next_attempt_at: until, reason: 'quiet_hours' },
    });
    return 'deferred';
  }

  let issue: RenderInput['issue'] = null;
  if (row.issue_id) {
    const found = await prisma.issue.findUnique({
      where: { id: row.issue_id },
      select: {
        id: true,
        title: true,
        sequence_id: true,
        kind: true,
        due_date: true,
        deleted_at: true,
        project: { select: { name: true, identifier: true, deleted_at: true } },
      },
    });
    if (!found || found.deleted_at || found.project.deleted_at) return skip('issue_deleted');
    issue = {
      id: found.id,
      key: `${found.project.identifier}-${found.sequence_id}`,
      title: found.title,
      project: found.project.name,
      kind: found.kind,
      due_date: found.due_date,
    };
  }
  const actor = row.actor_id
    ? await prisma.user.findUnique({ where: { id: row.actor_id }, select: { display_name: true } })
    : null;

  const input: RenderInput = {
    type: row.type,
    locale: localeOf(user.locale),
    workspace,
    issue,
    actor: actor?.display_name ?? null,
    payload: (row.payload ?? {}) as DeliveryPayload,
  };

  try {
    if (row.channel === 'telegram') {
      const chat = telegramConfigured() ? user.identities[0]?.provider_user_id : undefined;
      if (!chat) return skip('no_address');
      const message = telegramMessage(input);
      await sendBotMessage(Number(chat), message.text, message.opts);
    } else {
      if (!user.email) return skip('no_address');
      const message = emailMessage(input);
      await sendMail({ to: user.email, ...message });
    }
  } catch (err) {
    const attempts = row.attempts + 1;
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    const last = attempts >= MAX_ATTEMPTS;
    await prisma.notificationDelivery.update({
      where: { id: row.id },
      data: {
        attempts,
        error,
        reason: null,
        status: last ? 'failed' : 'queued',
        ...(!last && {
          next_attempt_at: new Date(now.getTime() + BACKOFF_MINUTES[attempts - 1]! * 60_000),
        }),
      },
    });
    return last ? 'failed' : 'retried';
  }

  await prisma.notificationDelivery.update({
    where: { id: row.id },
    data: {
      status: 'sent',
      sent_at: new Date(),
      attempts: row.attempts + 1,
      reason: null,
      error: null,
    },
  });
  return 'sent';
}

/** Send the due copies (all, or only of the given tasks / ids). Never throws per copy. */
export async function sendDeliveries(
  prisma: PrismaClient,
  options: { issueIds?: string[]; ids?: string[]; now?: Date; limit?: number } = {},
): Promise<SendResult> {
  const now = options.now ?? new Date();
  const result = empty();
  if (options.issueIds?.length === 0 || options.ids?.length === 0) return result;
  const workspaces = new Map<string, RenderInput['workspace'] | null>();
  const limit = options.limit ?? BATCH;
  // A few batches at most per call: a flood is finished by the next pass.
  for (let batch = 0; batch < 10; batch += 1) {
    const rows = await claim(prisma, now, options, limit);
    for (const row of rows) {
      result[await sendOne(prisma, row, now, workspaces)] += 1;
    }
    if (rows.length < limit) break;
  }
  return result;
}

/**
 * Right after an action commits: send the copies of these tasks now. Best-effort —
 * anything left is picked up by the scheduler; the action already succeeded.
 */
export async function deliverNow(prisma: PrismaClient, issueIds: string[]): Promise<void> {
  try {
    await sendDeliveries(prisma, { issueIds });
  } catch {
    // The copies stay queued; the next scheduler pass sends them.
  }
}

/** The scheduler pass: recover copies stuck in `sending`, then send what is due. */
export async function runDeliveries(prisma: PrismaClient, now = new Date()): Promise<SendResult> {
  await prisma.notificationDelivery.updateMany({
    where: { status: 'sending', updated_at: { lt: new Date(Date.now() - STALE_SENDING_MS) } },
    data: { status: 'queued' },
  });
  return sendDeliveries(prisma, { now });
}

/** Drop finished copies older than the retention period. */
export async function purgeDeliveries(prisma: PrismaClient, now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - DELIVERY_RETENTION_DAYS * 86_400_000);
  const { count } = await prisma.notificationDelivery.deleteMany({
    where: { status: { in: ['sent', 'failed', 'skipped'] }, created_at: { lt: before } },
  });
  return count;
}
