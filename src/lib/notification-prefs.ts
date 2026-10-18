// Personal notification settings (Ф8 8.B2, режим 6 дней): which events go out of
// the app — to Telegram and by email — and quiet hours. In-app notifications are
// always written; these settings only filter the out-of-band copies.
//
// Stored in User.notification_settings (null = defaults). Missing keys fall back to
// the defaults, so an old or partial value always reads sensibly.
//
// Channel rule, per event group:
//   - Telegram, when the account is linked and the group is on for Telegram;
//   - otherwise email, when the user has an address and the group is on for email —
//     email is the fallback channel, never a duplicate of a Telegram message.
// During quiet hours (in the user's time zone, else the workspace's) nothing is sent
// out of the app; the in-app notification still appears.

import { z } from 'zod';
import type { NotificationType } from '@prisma/client';
import { localHour } from './tz.js';

export const NOTIFICATION_GROUPS = ['assigned', 'review', 'deadlines', 'escalation'] as const;
export type NotificationGroup = (typeof NOTIFICATION_GROUPS)[number];

/** Which group an event belongs to; events outside these groups stay in-app only. */
export const GROUP_OF: Partial<Record<NotificationType, NotificationGroup>> = {
  issue_assigned: 'assigned',
  review_requested: 'review',
  review_approved: 'review',
  review_returned: 'review',
  acknowledged: 'review',
  due_soon: 'deadlines',
  overdue: 'deadlines',
  deadline_change_requested: 'deadlines',
  deadline_change_decided: 'deadlines',
  escalated: 'escalation',
};

const channelMatrix = z.object({
  assigned: z.boolean(),
  review: z.boolean(),
  deadlines: z.boolean(),
  escalation: z.boolean(),
});

const hour = z.number().int().min(0).max(23);

export const NotificationPrefsSchema = z.object({
  telegram: channelMatrix,
  email: channelMatrix,
  quiet_hours: z.object({
    enabled: z.boolean(),
    /** Local hour the quiet period starts (inclusive), e.g. 22. */
    from: hour,
    /** Local hour it ends (exclusive), e.g. 8; may be smaller than `from` (over midnight). */
    to: hour,
  }),
});
export type NotificationPrefs = z.infer<typeof NotificationPrefsSchema>;

/** Partial update accepted by `PUT /auth/me/notification-settings`. */
export const NotificationPrefsPatchSchema = z.object({
  telegram: channelMatrix.partial().optional(),
  email: channelMatrix.partial().optional(),
  quiet_hours: NotificationPrefsSchema.shape.quiet_hours.partial().optional(),
});
export type NotificationPrefsPatch = z.infer<typeof NotificationPrefsPatchSchema>;

const ALL_ON = { assigned: true, review: true, deadlines: true, escalation: true };

/** Today's behaviour: everything to Telegram, email when Telegram is not linked. */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  telegram: { ...ALL_ON },
  email: { ...ALL_ON },
  quiet_hours: { enabled: false, from: 22, to: 8 },
};

/** Effective settings: stored values over the defaults (invalid parts are ignored). */
export function notificationPrefs(stored: unknown): NotificationPrefs {
  const parsed = NotificationPrefsPatchSchema.safeParse(stored ?? {});
  const p = parsed.success ? parsed.data : {};
  const d = DEFAULT_NOTIFICATION_PREFS;
  return {
    telegram: { ...d.telegram, ...p.telegram },
    email: { ...d.email, ...p.email },
    quiet_hours: { ...d.quiet_hours, ...p.quiet_hours },
  };
}

/** Merge a patch into the stored value (for saving). */
export function mergeNotificationPrefs(stored: unknown, patch: NotificationPrefsPatch) {
  const current = notificationPrefs(stored);
  return {
    telegram: { ...current.telegram, ...patch.telegram },
    email: { ...current.email, ...patch.email },
    quiet_hours: { ...current.quiet_hours, ...patch.quiet_hours },
  } satisfies NotificationPrefs;
}

/** True when `now` falls into the quiet hours in `timeZone`. */
export function inQuietHours(prefs: NotificationPrefs, now: Date, timeZone: string): boolean {
  const q = prefs.quiet_hours;
  if (!q.enabled || q.from === q.to) return false;
  const h = localHour(now, timeZone);
  return q.from < q.to ? h >= q.from && h < q.to : h >= q.from || h < q.to;
}

export type OutChannel = 'telegram' | 'email' | null;

/**
 * Where one event goes for one user: Telegram, email or nowhere (in-app only).
 * `hasTelegram` / `hasEmail` say whether the channel is reachable at all.
 */
export function channelFor(
  stored: unknown,
  type: NotificationType,
  ctx: { hasTelegram: boolean; hasEmail: boolean; now: Date; timeZone: string },
): OutChannel {
  const group = GROUP_OF[type];
  if (!group) return null;
  const prefs = notificationPrefs(stored);
  if (inQuietHours(prefs, ctx.now, ctx.timeZone)) return null;
  if (ctx.hasTelegram && prefs.telegram[group]) return 'telegram';
  if (ctx.hasEmail && prefs.email[group]) return 'email';
  return null;
}
