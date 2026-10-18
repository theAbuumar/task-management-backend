// Personal notification settings (Ф8 8.B2, режим 6 дней):
//   GET  /api/v1/auth/me/notification-settings       — effective settings + reachable channels
//   PUT  /api/v1/auth/me/notification-settings       — partial update
//   POST /api/v1/auth/me/notification-settings/test  — a test message to the user's channel
// The rules themselves live in src/lib/notification-prefs.ts.

import type { FastifyInstance, FastifySchema } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { authenticate } from '../../plugins/auth-hook.js';
import { AppError } from '../../lib/errors.js';
import { sendMail } from '../../lib/mailer.js';
import {
  NOTIFICATION_GROUPS,
  NotificationPrefsPatchSchema,
  mergeNotificationPrefs,
  notificationPrefs,
  type NotificationPrefs,
  type NotificationPrefsPatch,
} from '../../lib/notification-prefs.js';
import { sendBotMessage, telegramConfigured } from './telegram.service.js';

// ─── Service ──────────────────────────────────────────────────────────────────

interface SettingsView extends NotificationPrefs {
  /** Channels that can reach this user at all. */
  channels: { telegram: boolean; email: boolean };
  groups: readonly string[];
}

async function loadUser(prisma: PrismaClient, userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      notification_settings: true,
      identities: {
        where: { provider: 'telegram', provider_user_id: { not: null } },
        select: { provider_user_id: true },
        take: 1,
      },
    },
  });
  if (!user) throw AppError.notFound('User not found');
  const chatId = telegramConfigured() ? user.identities[0]?.provider_user_id : undefined;
  return { user, chatId: chatId ? Number(chatId) : null };
}

function view(stored: unknown, chatId: number | null, email: string | null): SettingsView {
  return {
    ...notificationPrefs(stored),
    channels: { telegram: chatId !== null, email: Boolean(email) },
    groups: NOTIFICATION_GROUPS,
  };
}

export async function getNotificationSettings(
  prisma: PrismaClient,
  userId: string,
): Promise<SettingsView> {
  const { user, chatId } = await loadUser(prisma, userId);
  return view(user.notification_settings, chatId, user.email);
}

export async function updateNotificationSettings(
  prisma: PrismaClient,
  userId: string,
  patch: NotificationPrefsPatch,
): Promise<SettingsView> {
  const { user, chatId } = await loadUser(prisma, userId);
  const merged = mergeNotificationPrefs(user.notification_settings, patch);
  await prisma.user.update({
    where: { id: userId },
    data: { notification_settings: merged as Prisma.InputJsonValue },
  });
  return view(merged, chatId, user.email);
}

/** One test message to the channel the user's notifications use: Telegram, else email. */
export async function sendTestNotification(
  prisma: PrismaClient,
  userId: string,
): Promise<{ delivered_to: 'telegram' | 'email' | null }> {
  const { user, chatId } = await loadUser(prisma, userId);
  const text =
    '🔔 Тестовое уведомление «Системы поручений».\nТак будут приходить новые поручения, сдача работ на проверку и напоминания о сроках.';
  if (chatId !== null) {
    await sendBotMessage(chatId, text);
    return { delivered_to: 'telegram' };
  }
  if (user.email) {
    await sendMail({ to: user.email, subject: 'Тестовое уведомление', text });
    return { delivered_to: 'email' };
  }
  return { delivered_to: null };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

const matrix = {
  type: 'object',
  properties: Object.fromEntries(NOTIFICATION_GROUPS.map((g) => [g, { type: 'boolean' }])),
} as const;
const quietHours = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    from: { type: 'integer', minimum: 0, maximum: 23 },
    to: { type: 'integer', minimum: 0, maximum: 23 },
  },
} as const;
const settingsResponse = {
  type: 'object',
  properties: {
    telegram: matrix,
    email: matrix,
    quiet_hours: quietHours,
    channels: {
      type: 'object',
      properties: { telegram: { type: 'boolean' }, email: { type: 'boolean' } },
    },
    groups: { type: 'array', items: { type: 'string' } },
  },
} as const;
const description =
  'Groups: assigned (new tasks and assignments), review (hand-in, accept, return, acknowledged), ' +
  'deadlines (due soon, overdue, deadline changes), escalation. Per group: Telegram on/off and email on/off — ' +
  'email is the fallback when the message does not go to Telegram, never a duplicate. Quiet hours are local ' +
  'hours (profile time zone, else the workspace one); nothing goes out of the app then. In-app notifications are always on.';
const tags = ['Notifications'];
const security = [{ bearerAuth: [] }];

export async function notificationSettingsRoutes(app: FastifyInstance): Promise<void> {
  const base = '/api/v1/auth/me/notification-settings';

  app.get(
    base,
    {
      schema: {
        tags,
        summary: 'My notification settings (type × channel, quiet hours)',
        description,
        security,
        response: { 200: settingsResponse },
      } satisfies FastifySchema,
      preHandler: [authenticate],
    },
    async (request) => getNotificationSettings(app.prisma, request.userId),
  );

  app.put(
    base,
    {
      schema: {
        tags,
        summary: 'Update my notification settings (any subset of the fields)',
        description,
        security,
        body: {
          type: 'object',
          properties: { telegram: matrix, email: matrix, quiet_hours: quietHours },
        },
        response: { 200: settingsResponse },
      } satisfies FastifySchema,
      preHandler: [authenticate],
    },
    async (request) =>
      updateNotificationSettings(
        app.prisma,
        request.userId,
        NotificationPrefsPatchSchema.parse(request.body ?? {}),
      ),
  );

  app.post(
    `${base}/test`,
    {
      schema: {
        tags,
        summary: 'Send me a test notification (Telegram if linked, else email)',
        security,
        response: {
          200: {
            type: 'object',
            properties: {
              delivered_to: { type: 'string', enum: ['telegram', 'email'], nullable: true },
            },
          },
        },
      } satisfies FastifySchema,
      preHandler: [authenticate],
      // A real message goes out: keep the button from being used as a spammer.
      config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
    },
    async (request) => sendTestNotification(app.prisma, request.userId),
  );
}
