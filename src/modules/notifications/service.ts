import type { PrismaClient, Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import type { NotificationListQuery } from './schema.js';

// Actor (with ФИО for "Иванов И. И.") and a brief of the issue, so a row can be
// rendered and opened without extra requests.
const INCLUDE_ACTOR = {
  actor: {
    select: {
      id: true,
      display_name: true,
      last_name: true,
      first_name: true,
      middle_name: true,
      avatar_url: true,
    },
  },
  issue: {
    select: {
      id: true,
      title: true,
      sequence_id: true,
      project_id: true,
      kind: true,
      due_date: true,
      project: { select: { identifier: true, name: true } },
    },
  },
} satisfies Prisma.NotificationInclude;

type NotificationRow = Prisma.NotificationGetPayload<{ include: typeof INCLUDE_ACTOR }>;
type DeadlineDetails = { approved: boolean; new_due_date: Date };
/** A planned report's sending (10.B5): what to name and what to download. */
type ReportDetails = {
  run_id: string;
  schedule_id: string;
  report: string;
  name: string | null;
  period_from: string;
  period_to: string;
  file_name: string | null;
};
type NotificationWithActor = NotificationRow & {
  details?: DeadlineDetails | ReportDetails | null;
};

const entityIds = (rows: NotificationRow[], type: NotificationRow['type']) =>
  rows.filter((n) => n.type === type && n.entity_id).map((n) => n.entity_id as string);

/**
 * deadline_change_decided rows point at the request (entity_id); attach its
 * outcome so the client can say "одобрил" or "отклонил" and show the new date.
 * report_ready rows point at the sending of a planned report: its document and
 * period (null once the sending is gone from the history).
 */
async function withDetails(
  prisma: PrismaClient,
  rows: NotificationRow[],
): Promise<NotificationWithActor[]> {
  const deadlineIds = entityIds(rows, 'deadline_change_decided');
  const runIds = entityIds(rows, 'report_ready');
  if (deadlineIds.length === 0 && runIds.length === 0) return rows;
  const [requests, runs] = await Promise.all([
    deadlineIds.length === 0
      ? []
      : prisma.deadlineChangeRequest.findMany({
          where: { id: { in: deadlineIds } },
          select: { id: true, status: true, new_due_date: true },
        }),
    runIds.length === 0
      ? []
      : prisma.reportRun.findMany({
          where: { id: { in: runIds } },
          select: {
            id: true,
            schedule_id: true,
            period_from: true,
            period_to: true,
            file_name: true,
            schedule: { select: { report: true, name: true } },
          },
        }),
  ]);
  const requestOf = new Map(requests.map((r) => [r.id, r]));
  const runOf = new Map(runs.map((r) => [r.id, r]));
  return rows.map((n) => {
    if (n.type === 'deadline_change_decided') {
      const r = n.entity_id ? requestOf.get(n.entity_id) : undefined;
      return r
        ? { ...n, details: { approved: r.status === 'approved', new_due_date: r.new_due_date } }
        : n;
    }
    if (n.type === 'report_ready') {
      const r = n.entity_id ? runOf.get(n.entity_id) : undefined;
      return {
        ...n,
        details: r
          ? {
              run_id: r.id,
              schedule_id: r.schedule_id,
              report: r.schedule.report,
              name: r.schedule.name,
              period_from: r.period_from,
              period_to: r.period_to,
              file_name: r.file_name,
            }
          : null,
      };
    }
    return n;
  });
}

/**
 * List the requesting user's notifications in a workspace, newest first, with
 * cursor pagination. Notifications are private to their recipient — the query is
 * always scoped to `recipient_id`, so there is no cross-user leakage.
 */
export async function listNotifications(
  prisma: PrismaClient,
  workspaceId: string,
  recipientId: string,
  query: NotificationListQuery,
): Promise<{ data: NotificationWithActor[]; unread_count: number; next_cursor: string | null }> {
  const where: Prisma.NotificationWhereInput = {
    workspace_id: workspaceId,
    recipient_id: recipientId,
    ...(query.read !== undefined && { is_read: query.read }),
    ...(query.type && { type: { in: query.type } }),
  };

  const limit = query.limit;
  const [entries, unread_count] = await Promise.all([
    prisma.notification.findMany({
      where,
      include: INCLUDE_ACTOR,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1, // fetch one extra to detect a next page
      ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
    }),
    prisma.notification.count({
      where: { workspace_id: workspaceId, recipient_id: recipientId, is_read: false },
    }),
  ]);

  const hasMore = entries.length > limit;
  const data = hasMore ? entries.slice(0, limit) : entries;
  const next_cursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

  return { data: await withDetails(prisma, data), unread_count, next_cursor };
}

/**
 * Mark one notification read. Scoped to the recipient so a user can only touch
 * their own notifications; anything else is a 404 (not a 403, to avoid leaking
 * the existence of other users' notifications).
 */
export async function markRead(
  prisma: PrismaClient,
  workspaceId: string,
  recipientId: string,
  notificationId: string,
): Promise<NotificationWithActor> {
  const existing = await prisma.notification.findFirst({
    where: { id: notificationId, workspace_id: workspaceId, recipient_id: recipientId },
  });
  if (!existing) throw AppError.notFound('Notification not found');

  const row = existing.is_read
    ? await prisma.notification.findUniqueOrThrow({
        where: { id: notificationId },
        include: INCLUDE_ACTOR,
      })
    : await prisma.notification.update({
        where: { id: notificationId },
        data: { is_read: true, read_at: new Date() },
        include: INCLUDE_ACTOR,
      });
  return (await withDetails(prisma, [row]))[0]!;
}

/** Mark one of the recipient's notifications unread again (404 for anyone else's). */
export async function markUnread(
  prisma: PrismaClient,
  workspaceId: string,
  recipientId: string,
  notificationId: string,
): Promise<NotificationWithActor> {
  const existing = await prisma.notification.findFirst({
    where: { id: notificationId, workspace_id: workspaceId, recipient_id: recipientId },
    select: { id: true },
  });
  if (!existing) throw AppError.notFound('Notification not found');
  const row = await prisma.notification.update({
    where: { id: notificationId },
    data: { is_read: false, read_at: null },
    include: INCLUDE_ACTOR,
  });
  return (await withDetails(prisma, [row]))[0]!;
}

/** Mark all of the recipient's unread notifications in the workspace as read. */
export async function markAllRead(
  prisma: PrismaClient,
  workspaceId: string,
  recipientId: string,
): Promise<{ updated: number }> {
  const result = await prisma.notification.updateMany({
    where: { workspace_id: workspaceId, recipient_id: recipientId, is_read: false },
    data: { is_read: true, read_at: new Date() },
  });
  return { updated: result.count };
}
