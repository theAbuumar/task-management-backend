import type { FastifyRequest, FastifyReply } from 'fastify';
import * as workspaceService from './service.js';
import * as memberInviteService from '../member-invites/service.js';
import { InviteExistingUserBodySchema } from '../member-invites/schema.js';
import {
  CreateWorkspaceBodySchema,
  UpdateWorkspaceBodySchema,
  AddMemberBodySchema,
  ChangeMemberRoleBodySchema,
  ListMembersQuerySchema,
  InviteMemberBodySchema,
} from './schema.js';

export async function listWorkspacesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const workspaces = await workspaceService.listWorkspaces(request.server.prisma, request.userId);
  reply.send(workspaces);
}

export async function createWorkspaceHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = CreateWorkspaceBodySchema.parse(request.body);
  const workspace = await workspaceService.createWorkspace(
    request.server.prisma,
    request.userId,
    body,
  );
  reply.code(201).send(workspace);
}

export async function getWorkspaceHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Workspace and membership already resolved by requireWorkspaceMember preHandler.
  reply.send(request.workspace);
}

export async function updateWorkspaceHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = UpdateWorkspaceBodySchema.parse(request.body);
  const workspace = await workspaceService.updateWorkspace(
    request.server.prisma,
    request.server.storage,
    request.workspace.id,
    body,
  );
  reply.send(workspace);
}

export async function deleteWorkspaceHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await workspaceService.deleteWorkspace(request.server.prisma, request.workspace.id);
  reply.code(204).send();
}

export async function listMembersHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const query = ListMembersQuerySchema.parse(request.query ?? {});
  const members = await workspaceService.listMembers(
    request.server.prisma,
    request.workspace.id,
    query,
  );
  reply.send(members);
}

export async function addMemberHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = AddMemberBodySchema.parse(request.body);
  const member = await workspaceService.addMember(
    request.server.prisma,
    request.workspace.id,
    body,
  );
  reply.code(201).send(member);
}

export async function changeMemberRoleHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { userId } = request.params as { userId: string };
  const body = ChangeMemberRoleBodySchema.parse(request.body);
  const member = await workspaceService.changeMemberRole(
    request.server.prisma,
    request.workspace.id,
    userId,
    request.userId,
    body,
  );
  reply.send(member);
}

export async function removeMemberHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { userId } = request.params as { userId: string };
  await workspaceService.removeMember(
    request.server.prisma,
    request.workspace.id,
    userId,
    request.userId,
  );
  reply.code(204).send();
}

export async function leaveWorkspaceHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await workspaceService.leaveWorkspace(
    request.server.prisma,
    request.workspace.id,
    request.userId,
  );
  reply.code(204).send();
}

export async function inviteMemberHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = InviteMemberBodySchema.parse(request.body);
  const invite = await workspaceService.inviteMember(
    request.server.prisma,
    request.workspace.id,
    request.userId,
    body,
  );
  reply.code(201).send(invite);
}

// Invite an already-registered user (delivered to email + Telegram, accepted from any
// channel). Distinct from inviteMemberHandler, which emails a token link to strangers.
export async function inviteExistingUserHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = InviteExistingUserBodySchema.parse(request.body);
  const result = await memberInviteService.inviteExistingUser(
    request.server.prisma,
    request.workspace.id,
    request.userId,
    body,
  );
  reply.code(201).send(result);
}
