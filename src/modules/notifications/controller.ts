import type { FastifyRequest, FastifyReply } from 'fastify';
import * as notificationService from './service.js';
import { NotificationListQuerySchema } from './schema.js';

export async function listNotificationsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const query = NotificationListQuerySchema.parse(request.query);
  const result = await notificationService.listNotifications(
    request.server.prisma,
    request.workspace.id,
    request.userId,
    query,
  );
  reply.send(result);
}

export async function markReadHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { notificationId } = request.params as { notificationId: string };
  const notification = await notificationService.markRead(
    request.server.prisma,
    request.workspace.id,
    request.userId,
    notificationId,
  );
  reply.send(notification);
}

export async function markUnreadHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { notificationId } = request.params as { notificationId: string };
  const notification = await notificationService.markUnread(
    request.server.prisma,
    request.workspace.id,
    request.userId,
    notificationId,
  );
  reply.send(notification);
}

export async function markAllReadHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const result = await notificationService.markAllRead(
    request.server.prisma,
    request.workspace.id,
    request.userId,
  );
  reply.send(result);
}
