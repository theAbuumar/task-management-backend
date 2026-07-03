import type { FastifyRequest, FastifyReply } from 'fastify';
import * as service from './service.js';

export async function listMyInvitesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const invites = await service.listMyInvites(request.server.prisma, request.userId);
  reply.send(invites);
}

export async function acceptInviteHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { inviteId } = request.params as { inviteId: string };
  const result = await service.respondToInvite(
    request.server.prisma,
    request.userId,
    inviteId,
    'accept',
  );
  reply.send(result);
}

export async function declineInviteHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { inviteId } = request.params as { inviteId: string };
  const result = await service.respondToInvite(
    request.server.prisma,
    request.userId,
    inviteId,
    'decline',
  );
  reply.send(result);
}
