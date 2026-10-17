import type { PrismaClient, Workspace, WorkspaceMember, WorkspaceInvite } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { sendInviteEmail } from '../../lib/email.js';
import { frontendUrl } from '../../lib/urls.js';
import type {
  CreateWorkspaceBody,
  UpdateWorkspaceBody,
  AddMemberBody,
  ChangeMemberRoleBody,
  InviteMemberBody,
} from './schema.js';

export async function listWorkspaces(prisma: PrismaClient, userId: string): Promise<Workspace[]> {
  const memberships = await prisma.workspaceMember.findMany({
    where: { user_id: userId },
    include: { workspace: true },
  });
  return memberships.map((m) => m.workspace);
}

export async function createWorkspace(
  prisma: PrismaClient,
  userId: string,
  body: CreateWorkspaceBody,
): Promise<Workspace> {
  const existing = await prisma.workspace.findUnique({ where: { slug: body.slug } });
  if (existing) throw AppError.conflict(`Workspace slug "${body.slug}" is already taken`);

  return prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({
      data: { name: body.name, slug: body.slug, owner_id: userId },
    });
    // Creator gets the owner role automatically.
    await tx.workspaceMember.create({
      data: { workspace_id: workspace.id, user_id: userId, role: 'owner' },
    });
    return workspace;
  });
}

export async function updateWorkspace(
  prisma: PrismaClient,
  workspaceId: string,
  body: UpdateWorkspaceBody,
): Promise<Workspace> {
  if (body.slug) {
    const conflict = await prisma.workspace.findUnique({ where: { slug: body.slug } });
    if (conflict && conflict.id !== workspaceId) {
      throw AppError.conflict(`Workspace slug "${body.slug}" is already taken`);
    }
  }

  return prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.slug !== undefined && { slug: body.slug }),
    },
  });
}

export async function deleteWorkspace(prisma: PrismaClient, workspaceId: string): Promise<void> {
  await prisma.workspace.delete({ where: { id: workspaceId } });
}

// ─── Members ──────────────────────────────────────────────────────────────────

export async function listMembers(
  prisma: PrismaClient,
  workspaceId: string,
): Promise<WorkspaceMember[]> {
  return prisma.workspaceMember.findMany({
    where: { workspace_id: workspaceId },
    include: { user: { select: { id: true, email: true, display_name: true, avatar_url: true } } },
    orderBy: { created_at: 'asc' },
  });
}

export async function addMember(
  prisma: PrismaClient,
  workspaceId: string,
  body: AddMemberBody,
): Promise<WorkspaceMember> {
  const user = await prisma.user.findUnique({ where: { id: body.user_id } });
  if (!user) throw AppError.notFound('User not found');

  const existing = await prisma.workspaceMember.findUnique({
    where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: body.user_id } },
  });
  if (existing) {
    throw new AppError(409, 'ALREADY_MEMBER', 'User is already a member of this workspace');
  }

  return prisma.workspaceMember.create({
    data: { workspace_id: workspaceId, user_id: body.user_id, role: body.role },
    include: { user: { select: { id: true, email: true, display_name: true, avatar_url: true } } },
  });
}

export async function changeMemberRole(
  prisma: PrismaClient,
  workspaceId: string,
  targetUserId: string,
  requesterId: string,
  body: ChangeMemberRoleBody,
): Promise<WorkspaceMember> {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: targetUserId } },
  });
  if (!member) throw AppError.notFound('Member not found');

  // Cannot change the role of the workspace owner.
  if (member.role === 'owner') throw AppError.forbidden('Cannot change the workspace owner role');

  // Cannot demote yourself via this endpoint.
  if (targetUserId === requesterId) {
    throw AppError.forbidden('Cannot change your own role');
  }

  return prisma.workspaceMember.update({
    where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: targetUserId } },
    data: { role: body.role },
    include: { user: { select: { id: true, email: true, display_name: true, avatar_url: true } } },
  });
}

export async function removeMember(
  prisma: PrismaClient,
  workspaceId: string,
  targetUserId: string,
  requesterId: string,
): Promise<void> {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: targetUserId } },
  });
  if (!member) throw AppError.notFound('Member not found');
  if (member.role === 'owner') throw AppError.forbidden('Cannot remove the workspace owner');
  if (targetUserId === requesterId) {
    throw AppError.forbidden('Use the leave-workspace endpoint to remove yourself');
  }

  await prisma.workspaceMember.delete({
    where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: targetUserId } },
  });
}

/**
 * The requester leaves the workspace. The owner cannot leave (the workspace would be
 * left without one) until ownership is transferred. Project memberships inside the
 * workspace go with the workspace membership; authored issues/comments stay.
 */
export async function leaveWorkspace(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: userId } },
  });
  if (!member) throw AppError.notFound('Member not found');
  if (member.role === 'owner') {
    throw new AppError(
      403,
      'OWNER_CANNOT_LEAVE',
      'The workspace owner cannot leave. Transfer ownership first.',
    );
  }

  await prisma.$transaction([
    prisma.projectMember.deleteMany({
      where: { user_id: userId, project: { workspace_id: workspaceId } },
    }),
    prisma.workspaceMember.delete({
      where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: userId } },
    }),
  ]);
}

// ─── Invites ──────────────────────────────────────────────────────────────────

const INVITE_TTL_DAYS = 7;

export async function inviteMember(
  prisma: PrismaClient,
  workspaceId: string,
  inviterId: string,
  body: InviteMemberBody,
): Promise<WorkspaceInvite> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw AppError.notFound('Workspace not found');

  const inviter = await prisma.user.findUnique({ where: { id: inviterId } });
  if (!inviter) throw AppError.notFound('Inviter not found');

  // If user already exists and is already a member, short-circuit.
  const existingUser = await prisma.user.findUnique({ where: { email: body.email } });
  if (existingUser) {
    const existingMember = await prisma.workspaceMember.findUnique({
      where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: existingUser.id } },
    });
    if (existingMember) {
      throw new AppError(409, 'ALREADY_MEMBER', 'This user is already a member of the workspace');
    }
  }

  // Invalidate any pending (unaccepted, non-expired) invite for the same email+workspace.
  await prisma.workspaceInvite.deleteMany({
    where: {
      workspace_id: workspaceId,
      email: body.email,
      accepted_at: null,
      expires_at: { gt: new Date() },
    },
  });

  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  const invite = await prisma.workspaceInvite.create({
    data: {
      workspace_id: workspaceId,
      invited_by_id: inviterId,
      email: body.email,
      role: body.role,
      expires_at: expiresAt,
    },
  });

  const inviteUrl = frontendUrl(`/invites/${invite.token}`);
  await sendInviteEmail({
    to: body.email,
    workspaceName: workspace.name,
    inviterName: inviter.display_name,
    inviteUrl,
    expiresAt,
  });

  return invite;
}
