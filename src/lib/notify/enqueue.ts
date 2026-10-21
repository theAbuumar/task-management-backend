// The notification dispatcher, step one (Ф8 8.B3, ADR-033): an event → recipients →
// one out-of-app copy per person in the channel their settings choose, written as a
// `NotificationDelivery` row in the SAME transaction as the action. A rolled-back
// action leaves no copies; a committed one cannot lose them. Sending is step two
// (`send.ts`): right after the commit, retries and waiting copies by the scheduler.

import type { NotificationType, Prisma, PrismaClient } from '@prisma/client';
import { GROUP_OF, channelFor, type NotificationGroup } from '../notification-prefs.js';
import { telegramConfigured } from '../../modules/auth/telegram.service.js';
import type { DeliveryPayload } from './texts.js';

type Db = PrismaClient | Prisma.TransactionClient;

export interface Reachable {
  id: string;
  email: string | null;
  notification_settings: Prisma.JsonValue;
  /** Telegram chat id when the account is linked and the bot is configured. */
  chatId: number | null;
}

/**
 * Active members of the workspace among `userIds`, with what can reach them.
 * Nothing leaves the app for a member whose access was turned off (12.B7).
 */
export async function reachableMembers(
  db: Db,
  workspaceId: string,
  userIds: string[],
): Promise<Reachable[]> {
  if (userIds.length === 0) return [];
  const users = await db.user.findMany({
    where: {
      id: { in: userIds },
      is_active: true,
      workspace_memberships: { some: { workspace_id: workspaceId, deactivated_at: null } },
    },
    select: {
      id: true,
      email: true,
      notification_settings: true,
      identities: telegramConfigured()
        ? {
            where: { provider: 'telegram', provider_user_id: { not: null } },
            select: { provider_user_id: true },
            take: 1,
          }
        : false,
    },
  });
  return users.map((u) => {
    const chat = u.identities?.[0]?.provider_user_id;
    return {
      id: u.id,
      email: u.email,
      notification_settings: u.notification_settings,
      chatId: chat ? Number(chat) : null,
    };
  });
}

/**
 * Split recipients by out-of-app channel according to their settings (8.B2):
 * Telegram chat ids and email addresses; the rest get the in-app copy only. Quiet
 * hours do not drop anyone here — the copy waits for their end (ADR-033).
 */
export async function routeRecipients(
  db: Db,
  userIds: string[],
  type: NotificationType,
  workspace: { id: string },
): Promise<{
  telegram: { userId: string; chatId: number }[];
  email: { userId: string; email: string }[];
}> {
  const out = {
    telegram: [] as { userId: string; chatId: number }[],
    email: [] as { userId: string; email: string }[],
  };
  for (const u of await reachableMembers(db, workspace.id, userIds)) {
    const channel = channelFor(u.notification_settings, type, {
      hasTelegram: u.chatId !== null,
      hasEmail: Boolean(u.email),
    });
    if (channel === 'telegram') out.telegram.push({ userId: u.id, chatId: u.chatId! });
    else if (channel === 'email') out.email.push({ userId: u.id, email: u.email! });
  }
  return out;
}

export interface DeliveryInput {
  workspace_id: string;
  type: NotificationType;
  /** Who caused it; null — a system event (reminder, digest). Never gets a copy. */
  actor_id: string | null;
  issue_id?: string | null;
  payload?: DeliveryPayload | Record<string, unknown>;
  recipients: { user_id: string; notification_id?: string | null }[];
  /** A digest goes once: a second copy with the same key is not created. */
  dedupe_key?: string;
}

/** Whether events of this type leave the app at all (8.B2 groups). */
export function goesOut(type: NotificationType): NotificationGroup | undefined {
  return GROUP_OF[type];
}

/**
 * Write the out-of-app copies of an event. Returns how many were queued: people
 * who want neither Telegram nor email for this kind of event get none.
 */
export async function enqueueDeliveries(db: Db, input: DeliveryInput): Promise<number> {
  if (!goesOut(input.type)) return 0;
  const byUser = new Map<string, string | null>();
  for (const r of input.recipients) {
    if (r.user_id === input.actor_id) continue;
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, r.notification_id ?? null);
  }
  if (byUser.size === 0) return 0;

  const rows: Prisma.NotificationDeliveryCreateManyInput[] = [];
  for (const u of await reachableMembers(db, input.workspace_id, [...byUser.keys()])) {
    const channel = channelFor(u.notification_settings, input.type, {
      hasTelegram: u.chatId !== null,
      hasEmail: Boolean(u.email),
    });
    if (!channel) continue;
    rows.push({
      workspace_id: input.workspace_id,
      notification_id: byUser.get(u.id) ?? null,
      user_id: u.id,
      type: input.type,
      channel,
      issue_id: input.issue_id ?? null,
      actor_id: input.actor_id,
      payload: (input.payload ?? {}) as Prisma.InputJsonValue,
      dedupe_key: input.dedupe_key ?? null,
    });
  }
  if (rows.length === 0) return 0;
  if (input.dedupe_key) {
    // One copy per key: a digest pass that runs twice in the hour sends it once.
    const inserted = await db.notificationDelivery.createMany({
      data: rows.slice(0, 1),
      skipDuplicates: true,
    });
    return inserted.count;
  }
  const inserted = await db.notificationDelivery.createMany({ data: rows });
  return inserted.count;
}
