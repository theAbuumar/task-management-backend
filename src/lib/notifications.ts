// Notification helper.
//
// Services call these as a side effect after a successful mutation to create
// in-app `Notification` rows (TZ §5.18). They run at the same service points that
// already write the activity trail (assign / comment / mention events).
//
// Events that leave the app (8.B2 groups) also get their Telegram / email copies
// queued here, in the same transaction (the dispatcher, Ф8 8.B3, ADR-033); the
// service sends them right after the commit with `deliverNow`.
//
// Invariants enforced here so callers stay simple:
//   - the actor is never notified about their own action (self-notify is dropped),
//   - recipient ids are de-duplicated within a single call,
//   - an empty recipient set is a no-op.
//
// Accepts either a `PrismaClient` or a transaction client so callers can create
// notifications inside the same transaction as the mutation.

import type { PrismaClient, Prisma, NotificationType } from '@prisma/client';
import { publish } from './realtime.js';
import { enqueueDeliveries, goesOut } from './notify/enqueue.js';
import type { DeliveryPayload } from './notify/texts.js';

type DbClient = PrismaClient | Prisma.TransactionClient;

export interface NotificationInput {
  workspace_id: string;
  /** Who caused the event. Never notified about their own action. */
  actor_id: string;
  type: NotificationType;
  /** Users to notify. De-duplicated; the actor is removed automatically. */
  recipient_ids: string[];
  issue_id?: string | null;
  /** Optional id of the triggering entity (e.g. the comment), for deep-linking. */
  entity_id?: string | null;
  /**
   * System events (deadline reminders) have no human actor; the row still needs
   * one, so callers pass a stand-in and set this to keep them as a recipient.
   */
  include_actor?: boolean;
  /** What the Telegram / email copy needs that may change later (days, remark, dates). */
  payload?: DeliveryPayload;
}

/**
 * Create notification rows for every distinct recipient other than the actor.
 * No-op when no recipients remain after filtering.
 */
export async function notify(db: DbClient, input: NotificationInput): Promise<void> {
  const recipients = [...new Set(input.recipient_ids)].filter(
    (id) => input.include_actor || id !== input.actor_id,
  );
  if (recipients.length === 0) return;

  const created = await db.notification.createManyAndReturn({
    data: recipients.map((recipient_id) => ({
      workspace_id: input.workspace_id,
      recipient_id,
      actor_id: input.actor_id,
      type: input.type,
      issue_id: input.issue_id ?? null,
      entity_id: input.entity_id ?? null,
    })),
    select: { id: true, recipient_id: true },
  });
  if (goesOut(input.type)) {
    await enqueueDeliveries(db, {
      workspace_id: input.workspace_id,
      type: input.type,
      actor_id: input.include_actor ? null : input.actor_id,
      issue_id: input.issue_id ?? null,
      payload: input.payload,
      recipients: created.map((n) => ({ user_id: n.recipient_id, notification_id: n.id })),
    });
  }
  // Live bell (8.B1): only the recipients receive this event.
  await publish(db, {
    t: 'notification.created',
    w: input.workspace_id,
    a: input.include_actor ? null : input.actor_id,
    i: input.issue_id ?? null,
    r: recipients,
    n: input.type,
  });
}

/**
 * Extract `@mention` handles from a markdown body. A handle is the run of
 * non-whitespace word characters after an `@` that is at a string start or
 * preceded by whitespace/punctuation (so `email@example.com` is not a mention).
 * Returns lowercased handles, de-duplicated.
 */
export function parseMentions(body: string): string[] {
  const matches = body.matchAll(/(?:^|[\s([{<])@([a-zA-Z0-9._-]+)/g);
  const handles = new Set<string>();
  for (const m of matches) {
    // «@ivanov.» at the end of a sentence: the dot is punctuation, not the handle.
    const handle = m[1]?.replace(/[._-]+$/, '').toLowerCase();
    if (handle) handles.add(handle);
  }
  return [...handles];
}
