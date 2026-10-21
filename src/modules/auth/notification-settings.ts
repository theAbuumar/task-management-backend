// Personal notification settings (Ф8 8.B2, 8.B5):
//   GET  /api/v1/auth/me/notification-settings         — effective settings + reachable channels
//   PUT  /api/v1/auth/me/notification-settings         — partial update
//   POST /api/v1/auth/me/notification-settings/test    — a test message to the user's channel
//   POST /api/v1/auth/me/notification-settings/digest  — the daily / weekly digest right now
// The rules themselves live in src/lib/notification-prefs.ts, digests in src/lib/notify.

import type { FastifyInstance, FastifySchema } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { authenticate } from '../../plugins/auth-hook.js';
import { AppError } from '../../lib/errors.js';
import { sendMail } from '../../lib/mailer.js';
import { renderEmail } from '../../lib/notify/email-layout.js';
import { settingsUrl } from '../../lib/notify/render.js';
import { localeOf } from '../../lib/notify/texts.js';
import { isDepartmentHead, queueDigest } from '../../lib/notify/digest.js';
import { sendDeliveries } from '../../lib/notify/send.js';
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
  /** The weekly digest reaches department heads only. */
  is_department_head: boolean;
}

async function loadUser(prisma: PrismaClient, userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      locale: true,
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

function view(
  stored: unknown,
  chatId: number | null,
  email: string | null,
  head: boolean,
): SettingsView {
  return {
    ...notificationPrefs(stored),
    channels: { telegram: chatId !== null, email: Boolean(email) },
    groups: NOTIFICATION_GROUPS,
    is_department_head: head,
  };
}

export async function getNotificationSettings(
  prisma: PrismaClient,
  userId: string,
): Promise<SettingsView> {
  const { user, chatId } = await loadUser(prisma, userId);
  return view(
    user.notification_settings,
    chatId,
    user.email,
    await isDepartmentHead(prisma, userId),
  );
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
  return view(merged, chatId, user.email, await isDepartmentHead(prisma, userId));
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
    const en = localeOf(user.locale) === 'en';
    const letter = renderEmail({
      locale: en ? 'en' : 'ru',
      heading: en ? 'Test notification' : 'Тестовое уведомление',
      paragraphs: [
        en
          ? 'This is how new assignments, hand-ins for review and deadline reminders will arrive.'
          : 'Так будут приходить новые поручения, сдача работ на проверку и напоминания о сроках.',
      ],
      settingsUrl: settingsUrl(),
    });
    await sendMail({
      to: user.email,
      subject: en ? 'Test notification' : 'Тестовое уведомление',
      ...letter,
    });
    return { delivered_to: 'email' };
  }
  return { delivered_to: null };
}

/**
 * «Прислать сейчас»: the digest outside its schedule, through the dispatcher. An
 * empty daily digest still comes («сроков на сегодня нет»); the weekly one needs a
 * department to summarise.
 */
export async function sendDigestNow(
  prisma: PrismaClient,
  userId: string,
  kind: 'daily' | 'weekly',
): Promise<{ delivered_to: 'telegram' | 'email' | null; status: string | null }> {
  if (kind === 'weekly' && !(await isDepartmentHead(prisma, userId))) {
    throw new AppError(
      400,
      'NOT_DEPARTMENT_HEAD',
      'The weekly digest summarises a department you head — you head none',
    );
  }
  const queued = await queueDigest(prisma, userId, kind, new Date(), { manual: true });
  if (!queued.id) return { delivered_to: null, status: null };
  await sendDeliveries(prisma, { ids: [queued.id] });
  const row = await prisma.notificationDelivery.findUnique({
    where: { id: queued.id },
    select: { status: true },
  });
  return {
    delivered_to: row?.status === 'sent' ? queued.channel : null,
    status: row?.status ?? null,
  };
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
const digest = {
  type: 'object',
  properties: {
    daily: { type: 'boolean' },
    weekly: { type: 'boolean' },
    hour: { type: 'integer', minimum: 0, maximum: 23 },
  },
} as const;
const settingsResponse = {
  type: 'object',
  properties: {
    telegram: matrix,
    email: matrix,
    quiet_hours: quietHours,
    digest,
    channels: {
      type: 'object',
      properties: { telegram: { type: 'boolean' }, email: { type: 'boolean' } },
    },
    groups: { type: 'array', items: { type: 'string' } },
    is_department_head: { type: 'boolean' },
  },
} as const;
const description =
  'Groups: assigned (new tasks and assignments), review (hand-in, accept, return, acknowledged), ' +
  'deadlines (due soon, overdue, deadline changes), escalation, digest. Per group: Telegram on/off and email on/off — ' +
  'email is the fallback when the message does not go to Telegram, never a duplicate. Quiet hours are local ' +
  'hours (profile time zone, else the workspace one); copies wait and go out when they end (ADR-033). ' +
  'Digests (8.B5): daily — due today, overdue, not acknowledged, waiting for your decision; weekly — a department ' +
  'summary for heads on Mondays; sent at `digest.hour` local time. In-app notifications are always on.';
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
          properties: { telegram: matrix, email: matrix, quiet_hours: quietHours, digest },
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

  app.post(
    `${base}/digest`,
    {
      schema: {
        tags,
        summary: 'Send me the daily or weekly digest now (8.B5)',
        description:
          'Collected now and sent through the dispatcher to the digest channel (Telegram, else email). ' +
          'An empty daily digest is still sent; the weekly one needs a department you head (`400 NOT_DEPARTMENT_HEAD`). ' +
          '`delivered_to` is null when no channel is on for digests or sending failed (it is retried).',
        security,
        body: {
          type: 'object',
          required: ['kind'],
          properties: { kind: { type: 'string', enum: ['daily', 'weekly'] } },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              delivered_to: { type: 'string', enum: ['telegram', 'email'], nullable: true },
              status: { type: 'string', nullable: true },
            },
          },
        },
      } satisfies FastifySchema,
      preHandler: [authenticate],
      config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
    },
    async (request) =>
      sendDigestNow(
        app.prisma,
        request.userId,
        (request.body as { kind: 'daily' | 'weekly' }).kind,
      ),
  );
}
