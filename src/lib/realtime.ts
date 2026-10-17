// Real-time events, publishing side (Ф8 8.B1, ADR-010).
//
// Mutations announce themselves with Postgres NOTIFY on one channel. Called with
// a transaction client, NOTIFY is delivered only when that transaction commits
// (and never if it rolls back), so listeners never see an uncommitted change.
// Every API instance LISTENs on the channel (plugins/realtime.ts) and pushes the
// event to its SSE subscribers that are allowed to see it.
//
// The payload carries ids only — no titles or texts — so it stays far below the
// 8000-byte NOTIFY limit and leaks nothing: subscribers refetch what they need
// through the regular, permission-checked API.

import type { PrismaClient, Prisma } from '@prisma/client';

type DbClient = PrismaClient | Prisma.TransactionClient;

export const REALTIME_CHANNEL = 'app_events';

/** Event types a subscriber receives (`event:` line of the SSE stream). */
export type RealtimeEventType =
  | 'notification.created'
  | 'issue.created'
  | 'issue.updated'
  | 'issue.deleted'
  | 'comment.created'
  | 'comment.updated'
  | 'comment.deleted'
  | 'review.submitted'
  | 'review.approved'
  | 'review.returned';

/** What travels through NOTIFY (short keys keep big fan-outs under the limit). */
export interface RealtimePayload {
  /** event type */
  t: RealtimeEventType;
  /** workspace id */
  w: string;
  /** actor (user) id; null for system events (reminders) */
  a: string | null;
  /** issue id */
  i?: string | null;
  /** changed issue fields (issue.updated) */
  f?: string[];
  /** recipients (notification.created) — only they receive it */
  r?: string[];
  /** notification type (notification.created) */
  n?: string;
}

/** Recipients per NOTIFY: 36-char ids keep a chunk well under 8000 bytes. */
const RECIPIENT_CHUNK = 150;

/** Activity action (lib/activity) → event type; null = not a real-time event. */
export function eventTypeOfAction(action: string): RealtimeEventType | null {
  switch (action) {
    case 'issue.created':
      return 'issue.created';
    case 'issue.deleted':
      return 'issue.deleted';
    case 'comment.created':
    case 'comment.updated':
    case 'comment.deleted':
      return action;
    case 'issue.review_submitted':
      return 'review.submitted';
    case 'issue.review_approved':
      return 'review.approved';
    case 'issue.review_returned':
      return 'review.returned';
    default:
      return action.startsWith('issue.') ? 'issue.updated' : null;
  }
}

/** NOTIFY one event. Inside a transaction it is delivered on commit. */
export async function publish(db: DbClient, payload: RealtimePayload): Promise<void> {
  if (payload.r && payload.r.length > RECIPIENT_CHUNK) {
    for (let k = 0; k < payload.r.length; k += RECIPIENT_CHUNK) {
      await publish(db, { ...payload, r: payload.r.slice(k, k + RECIPIENT_CHUNK) });
    }
    return;
  }
  await db.$executeRaw`SELECT pg_notify(${REALTIME_CHANNEL}, ${JSON.stringify(payload)})`;
}

/**
 * Announce activity rows as events, one per (issue, type); field changes of one
 * update are merged into a single `issue.updated` with the list of fields.
 */
export async function publishActivity(
  db: DbClient,
  entries: {
    workspace_id: string;
    actor_id: string;
    action: string;
    issue_id?: string | null;
    field?: string | null;
  }[],
): Promise<void> {
  const events = new Map<string, RealtimePayload>();
  for (const e of entries) {
    const t = eventTypeOfAction(e.action);
    if (!t || !e.issue_id) continue;
    const key = `${e.issue_id}:${t}`;
    const event = events.get(key) ?? { t, w: e.workspace_id, a: e.actor_id, i: e.issue_id };
    if (t === 'issue.updated' && e.field) event.f = [...new Set([...(event.f ?? []), e.field])];
    events.set(key, event);
  }
  for (const event of events.values()) await publish(db, event);
}
