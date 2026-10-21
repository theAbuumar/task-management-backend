// Personal notification settings (Ф8 8.B2, 8.B5): which events go out of the app —
// to Telegram and by email — quiet hours and digests. In-app notifications are
// always written; these settings only filter the out-of-band copies.
//
// Stored in User.notification_settings (null = defaults). Missing keys fall back to
// the defaults, so an old or partial value always reads sensibly.
//
// Channel rule, per event group:
//   - Telegram, when the account is linked and the group is on for Telegram;
//   - otherwise email, when the user has an address and the group is on for email —
//     email is the fallback channel, never a duplicate of a Telegram message.
// During quiet hours (in the user's time zone, else the workspace's) copies wait and
// go out when the quiet hours end (ADR-033); the in-app notification still appears.

import { z } from 'zod';
import type { NotificationType } from '@prisma/client';
import { addDays, localDate, localHour, zonedTime } from './tz.js';

export const NOTIFICATION_GROUPS = [
  'assigned',
  'review',
  'deadlines',
  'escalation',
  'digest',
] as const;
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
  digest: 'digest',
};

const channelMatrix = z.object({
  assigned: z.boolean(),
  review: z.boolean(),
  deadlines: z.boolean(),
  escalation: z.boolean(),
  digest: z.boolean(),
});

const hour = z.number().int().min(0).max(23);

/** Digests (8.B5): daily — about one's own work; weekly — a department head's summary. */
const digestSettings = z.object({
  daily: z.boolean(),
  weekly: z.boolean(),
  /** Local hour the digest is sent at, e.g. 8. */
  hour,
});

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
  digest: digestSettings,
});
export type NotificationPrefs = z.infer<typeof NotificationPrefsSchema>;

/** Partial update accepted by `PUT /auth/me/notification-settings`. */
export const NotificationPrefsPatchSchema = z.object({
  telegram: channelMatrix.partial().optional(),
  email: channelMatrix.partial().optional(),
  quiet_hours: NotificationPrefsSchema.shape.quiet_hours.partial().optional(),
  digest: digestSettings.partial().optional(),
});
export type NotificationPrefsPatch = z.infer<typeof NotificationPrefsPatchSchema>;

const ALL_ON = { assigned: true, review: true, deadlines: true, escalation: true, digest: true };

/**
 * Everything to Telegram, email when Telegram is not linked. The daily digest is off
 * (deadline reminders already come per task); the weekly one reaches department
 * heads only.
 */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  telegram: { ...ALL_ON },
  email: { ...ALL_ON },
  quiet_hours: { enabled: false, from: 22, to: 8 },
  digest: { daily: false, weekly: true, hour: 8 },
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
    digest: { ...d.digest, ...p.digest },
  };
}

/** Merge a patch into the stored value (for saving). */
export function mergeNotificationPrefs(stored: unknown, patch: NotificationPrefsPatch) {
  const current = notificationPrefs(stored);
  return {
    telegram: { ...current.telegram, ...patch.telegram },
    email: { ...current.email, ...patch.email },
    quiet_hours: { ...current.quiet_hours, ...patch.quiet_hours },
    digest: { ...current.digest, ...patch.digest },
  } satisfies NotificationPrefs;
}

/** True when `now` falls into the quiet hours in `timeZone`. */
export function inQuietHours(prefs: NotificationPrefs, now: Date, timeZone: string): boolean {
  const q = prefs.quiet_hours;
  if (!q.enabled || q.from === q.to) return false;
  const h = localHour(now, timeZone);
  return q.from < q.to ? h >= q.from && h < q.to : h >= q.from || h < q.to;
}

/**
 * When the current quiet period ends (the next local `to:00`), or null when `now`
 * is not in quiet hours. Copies wait until then (ADR-033).
 */
export function quietUntil(prefs: NotificationPrefs, now: Date, timeZone: string): Date | null {
  if (!inQuietHours(prefs, now, timeZone)) return null;
  const time = `${String(prefs.quiet_hours.to).padStart(2, '0')}:00`;
  const today = localDate(now, timeZone);
  const end = zonedTime(today, time, timeZone);
  return end > now ? end : zonedTime(addDays(today, 1), time, timeZone);
}

export type OutChannel = 'telegram' | 'email' | null;

/**
 * Where one event goes for one user: Telegram, email or nowhere (in-app only).
 * `hasTelegram` / `hasEmail` say whether the channel is reachable at all. Quiet
 * hours do not change the channel — they only delay the copy.
 */
export function channelFor(
  stored: unknown,
  type: NotificationType,
  ctx: { hasTelegram: boolean; hasEmail: boolean },
): OutChannel {
  const group = GROUP_OF[type];
  if (!group) return null;
  const prefs = notificationPrefs(stored);
  if (ctx.hasTelegram && prefs.telegram[group]) return 'telegram';
  if (ctx.hasEmail && prefs.email[group]) return 'email';
  return null;
}
