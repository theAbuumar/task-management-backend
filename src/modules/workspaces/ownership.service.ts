// Handing a workspace over to another member (Ф12 12.B3, ADR-034).
//
// Only the owner can do it, confirmed by a code sent to the owner (email, or the
// Telegram bot for an account without one). The new owner must be an active member
// who is not a guest; the former owner stays in the workspace as an admin and may
// leave it afterwards (1.B6). Exactly one owner at any moment: `Workspace.owner_id`
// and both member roles change in one transaction.

import type { PrismaClient, Workspace, WorkspaceMember } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { sendAccountCode, verifyAccountCode, type CodeChallenge } from '../auth/account-code.js';
import type { TransferOwnershipBody } from './schema.js';

/** The caller must be the workspace's owner (the route checks the role too). */
async function assertOwner(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
): Promise<Workspace> {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  if (workspace.owner_id !== userId) {
    throw new AppError(403, 'NOT_OWNER', 'Only the workspace owner can transfer ownership');
  }
  return workspace;
}

/** Step 1: send the owner a code that confirms the transfer. */
export async function requestOwnershipTransfer(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
): Promise<CodeChallenge> {
  await assertOwner(prisma, workspaceId, userId);
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return sendAccountCode(prisma, owner, 'transfer_ownership');
}

export interface OwnershipTransferResult {
  workspace: Workspace;
  previous_owner: WorkspaceMember;
  new_owner: WorkspaceMember;
}

/**
 * Step 2: check the new owner, then the code, then swap the roles. A wrong choice of
 * person is refused before the code is checked, so it does not burn the code.
 */
export async function transferOwnership(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  body: TransferOwnershipBody,
): Promise<OwnershipTransferResult> {
  await assertOwner(prisma, workspaceId, userId);
  const invalid = (reason: string, message: string) =>
    new AppError(400, 'NEW_OWNER_INVALID', message, { reason });

  if (body.user_id === userId) {
    throw invalid('already_owner', 'You already own this workspace');
  }
  const target = await prisma.workspaceMember.findUnique({
    where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: body.user_id } },
    include: { user: { select: { is_active: true } } },
  });
  if (!target || !target.user.is_active) {
    throw invalid('not_member', 'The new owner must be a member of this workspace');
  }
  if (target.deactivated_at) {
    throw invalid('deactivated', 'The access of this member is turned off');
  }
  if (target.role === 'guest') {
    throw invalid('guest', 'A guest cannot own the workspace — change their role first');
  }

  const owner = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  await verifyAccountCode(prisma, owner, 'transfer_ownership', body.code);

  return prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.update({
      where: { id: workspaceId },
      data: { owner_id: body.user_id },
    });
    const new_owner = await tx.workspaceMember.update({
      where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: body.user_id } },
      data: { role: 'owner' },
    });
    const previous_owner = await tx.workspaceMember.update({
      where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: userId } },
      data: { role: 'admin' },
    });
    return { workspace, previous_owner, new_owner };
  });
}
