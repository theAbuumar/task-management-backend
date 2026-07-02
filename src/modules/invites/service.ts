import type { PrismaClient, WorkspaceMember, WorkspaceInvite } from '@prisma/client';
import { AppError } from '../../lib/errors.js';

export interface InviteDetail {
  id: string;
  workspace_id: string;
  email: string;
  role: string;
  expires_at: Date;
  workspace: { id: string; name: string; slug: string };
  invited_by: { id: string; display_name: string; email: string };
}

export async function getInvite(prisma: PrismaClient, token: string): Promise<InviteDetail> {
  const invite = await prisma.workspaceInvite.findUnique({
    where: { token },
    include: {
      workspace: { select: { id: true, name: true, slug: true } },
      invited_by: { select: { id: true, display_name: true, email: true } },
    },
  });

  if (!invite) throw AppError.notFound('Invite not found');
  if (invite.accepted_at) throw AppError.conflict('Invite has already been accepted');
  if (invite.expires_at < new Date()) throw AppError.gone('Invite has expired');

  return {
    id: invite.id,
    workspace_id: invite.workspace_id,
    email: invite.email,
    role: invite.role,
    expires_at: invite.expires_at,
    workspace: invite.workspace,
    // The inviter is an email-based member, so email is present; coerce for the
    // now-nullable User.email type without widening the public response shape.
    invited_by: { ...invite.invited_by, email: invite.invited_by.email ?? '' },
  };
}

export async function acceptInvite(
  prisma: PrismaClient,
  token: string,
  userId: string,
): Promise<WorkspaceMember> {
  const invite = await prisma.workspaceInvite.findUnique({
    where: { token },
    include: { workspace: true },
  });

  if (!invite) throw AppError.notFound('Invite not found');
  if (invite.accepted_at) throw AppError.conflict('Invite has already been accepted');
  if (invite.expires_at < new Date()) throw AppError.gone('Invite has expired');

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw AppError.notFound('User not found');

  // Validate the accepting user's email matches the invite (prevents token sharing).
  // An account without an email (Telegram-only) can never match an email invite.
  if (!user.email || user.email.toLowerCase() !== invite.email.toLowerCase()) {
    throw AppError.forbidden('This invite was sent to a different email address');
  }

  // Idempotency: if already a member, just mark the invite accepted and return.
  const existingMember = await prisma.workspaceMember.findUnique({
    where: {
      workspace_id_user_id: { workspace_id: invite.workspace_id, user_id: userId },
    },
  });

  if (existingMember) {
    await prisma.workspaceInvite.update({
      where: { id: invite.id },
      data: { accepted_at: new Date() },
    });
    return existingMember;
  }

  return prisma.$transaction(async (tx) => {
    await tx.workspaceInvite.update({
      where: { id: invite.id },
      data: { accepted_at: new Date() },
    });
    return tx.workspaceMember.create({
      data: {
        workspace_id: invite.workspace_id,
        user_id: userId,
        role: invite.role,
      },
    });
  });
}

// Called from auth/register when an invite_token is provided.
// Does not validate email match (registration captures the email from the invite).
export async function acceptInviteAfterRegister(
  prisma: PrismaClient,
  token: string,
  userId: string,
): Promise<WorkspaceInvite | null> {
  const invite = await prisma.workspaceInvite.findUnique({ where: { token } });
  if (!invite || invite.accepted_at || invite.expires_at < new Date()) return null;

  await prisma.$transaction([
    prisma.workspaceInvite.update({
      where: { id: invite.id },
      data: { accepted_at: new Date() },
    }),
    prisma.workspaceMember.create({
      data: { workspace_id: invite.workspace_id, user_id: userId, role: invite.role },
    }),
  ]);

  return invite;
}
