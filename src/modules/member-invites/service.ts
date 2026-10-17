// Workspace member-invite service (invite an ALREADY-REGISTERED user).
//
// Distinct from the email-token flow for strangers (modules/invites). An admin picks an
// existing account; a pending WorkspaceMemberInvite is created and fanned out to every
// channel the target owns (email + Telegram). It can be accepted/declined from the
// in-app inbox, an email link (both via the authenticated `respondToInvite`), or the
// Telegram inline buttons (`respondToInviteViaTelegram`). All paths converge on the same
// record, and accepting creates the WorkspaceMember. Authorization for creation lives in
// the route (requireWorkspaceMember('admin')); this module owns everything after that.

import type { PrismaClient, Prisma, WorkspaceMemberInvite, WorkspaceMember } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { frontendUrl } from '../../lib/urls.js';
import { sendMemberInviteEmail } from '../../lib/email.js';
import { sendWorkspaceInvitePrompt, telegramConfigured } from '../auth/telegram.service.js';
import type { InviteExistingUserBody } from './schema.js';

const INVITE_TTL_DAYS = 7;

export type InviteChannel = 'email' | 'telegram';

export interface InviteDeliveryResult {
  invite: WorkspaceMemberInvite;
  /** Channels the invite was successfully pushed to (the inbox copy always exists). */
  delivered_to: InviteChannel[];
}

/**
 * Create a pending invite for an existing user and fan it out to their channels.
 * Rejects self-invites, non-existent/inactive targets, and users who are already members.
 * Any prior live pending invite for the same (workspace, target) is replaced.
 */
export async function inviteExistingUser(
  prisma: PrismaClient,
  workspaceId: string,
  inviterId: string,
  body: InviteExistingUserBody,
): Promise<InviteDeliveryResult> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw AppError.notFound('Workspace not found');

  const inviter = await prisma.user.findUnique({ where: { id: inviterId } });
  if (!inviter) throw AppError.notFound('Inviter not found');

  // Resolve the target existing account by id or email (validation guarantees one).
  const target = body.user_id
    ? await prisma.user.findUnique({ where: { id: body.user_id } })
    : body.email
      ? await prisma.user.findUnique({ where: { email: body.email } })
      : null;
  if (!target || !target.is_active) throw AppError.notFound('User not found');

  if (target.id === inviterId) throw AppError.badRequest('You cannot invite yourself');

  const existingMember = await prisma.workspaceMember.findUnique({
    where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: target.id } },
  });
  if (existingMember) {
    throw new AppError(409, 'ALREADY_MEMBER', 'This user is already a member of the workspace');
  }

  // One live pending invite per (workspace, target): drop any prior pending one so a
  // re-invite refreshes the token/expiry rather than piling up.
  await prisma.workspaceMemberInvite.deleteMany({
    where: { workspace_id: workspaceId, target_user_id: target.id, status: 'pending' },
  });

  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  const invite = await prisma.workspaceMemberInvite.create({
    data: {
      workspace_id: workspaceId,
      inviter_id: inviterId,
      target_user_id: target.id,
      role: body.role,
      expires_at: expiresAt,
    },
  });

  // Fan out to every channel the target owns. Best-effort per channel: a delivery
  // failure must not roll back the invite — it stays visible in the in-app inbox.
  const delivered_to: InviteChannel[] = [];

  if (target.email) {
    try {
      await sendMemberInviteEmail({
        to: target.email,
        workspaceName: workspace.name,
        inviterName: inviter.display_name,
        inboxUrl: frontendUrl('/invitations'),
        expiresAt,
      });
      delivered_to.push('email');
    } catch {
      // Swallowed: the transport logs the failure; the inbox copy still lets them accept.
    }
  }

  if (telegramConfigured()) {
    const telegram = await prisma.authIdentity.findFirst({
      where: { user_id: target.id, provider: 'telegram' },
    });
    if (telegram?.provider_user_id) {
      try {
        await sendWorkspaceInvitePrompt(Number(telegram.provider_user_id), {
          token: invite.token,
          workspaceName: workspace.name,
          inviterName: inviter.display_name,
          role: invite.role,
        });
        delivered_to.push('telegram');
      } catch {
        // Swallowed: same rationale as email — the inbox copy remains actionable.
      }
    }
  }

  return { invite, delivered_to };
}

// ─── Inbox + responses ──────────────────────────────────────────────────────────

export type MemberInviteInboxItem = Prisma.WorkspaceMemberInviteGetPayload<{
  include: {
    workspace: { select: { id: true; name: true; slug: true } };
    inviter: { select: { id: true; display_name: true; avatar_url: true } };
  };
}>;

/**
 * The requesting user's pending, non-expired invitations across all workspaces, newest
 * first. Always scoped to `target_user_id` — a user only ever sees invites addressed to
 * them (they are not yet a member, so this can't be a workspace-scoped route).
 */
export async function listMyInvites(
  prisma: PrismaClient,
  userId: string,
): Promise<MemberInviteInboxItem[]> {
  return prisma.workspaceMemberInvite.findMany({
    where: { target_user_id: userId, status: 'pending', expires_at: { gt: new Date() } },
    include: {
      workspace: { select: { id: true, name: true, slug: true } },
      inviter: { select: { id: true, display_name: true, avatar_url: true } },
    },
    orderBy: { created_at: 'desc' },
  });
}

export type InviteAction = 'accept' | 'decline';

export interface InviteResponseResult {
  invite: WorkspaceMemberInvite;
  /** The membership created/kept on accept; null on decline. */
  member: WorkspaceMember | null;
}

/**
 * Respond to an invitation from an authenticated session (in-app inbox or email link).
 * Scoped to the target: an invite that isn't addressed to `userId` is a 404 (not 403)
 * so we never reveal the existence of other users' invitations.
 */
export async function respondToInvite(
  prisma: PrismaClient,
  userId: string,
  inviteId: string,
  action: InviteAction,
): Promise<InviteResponseResult> {
  const invite = await prisma.workspaceMemberInvite.findUnique({ where: { id: inviteId } });
  if (!invite || invite.target_user_id !== userId) {
    throw AppError.notFound('Invitation not found');
  }
  return applyResponse(prisma, invite, action);
}

/**
 * Respond to an invitation via a Telegram inline-button tap (the webhook path). There is
 * no session here, so authenticate the tapper by matching their telegram id against the
 * target's linked Telegram identity. Returns a short message for the bot to display;
 * never throws (Telegram just needs an acknowledgement).
 */
export async function respondToInviteViaTelegram(
  prisma: PrismaClient,
  token: string,
  telegramId: string,
  action: InviteAction,
): Promise<string> {
  const invite = await prisma.workspaceMemberInvite.findUnique({
    where: { token },
    include: { workspace: { select: { name: true } } },
  });
  if (!invite) return 'Приглашение больше не действует.';

  // Only the invited account — proven by its linked telegram id — may respond.
  const telegram = await prisma.authIdentity.findFirst({
    where: { user_id: invite.target_user_id, provider: 'telegram' },
  });
  if (!telegram || telegram.provider_user_id !== telegramId) {
    return 'Это приглашение адресовано другому аккаунту.';
  }

  try {
    const { member } = await applyResponse(prisma, invite, action);
    if (action === 'decline') return `Приглашение в «${invite.workspace.name}» отклонено.`;
    return member
      ? `Вы вступили в «${invite.workspace.name}»! Откройте сайт, чтобы начать работу.`
      : `Вы вступили в «${invite.workspace.name}».`;
  } catch (err) {
    if (err instanceof AppError && err.code === 'GONE') return 'Срок приглашения истёк.';
    if (err instanceof AppError && err.code === 'CONFLICT') return 'На это приглашение уже ответили.';
    return 'Не удалось обработать приглашение.';
  }
}

/**
 * Shared accept/decline transition. Enforces the lifecycle (pending + unexpired),
 * treats a re-accept of an already-joined invite as idempotent success, and on accept
 * creates the WorkspaceMember atomically with the status flip.
 */
async function applyResponse(
  prisma: PrismaClient,
  invite: WorkspaceMemberInvite,
  action: InviteAction,
): Promise<InviteResponseResult> {
  if (invite.status !== 'pending') {
    // Idempotency: accepting an already-accepted invite whose membership exists is a
    // no-op success rather than a conflict.
    if (action === 'accept' && invite.status === 'accepted') {
      const member = await prisma.workspaceMember.findUnique({
        where: {
          workspace_id_user_id: {
            workspace_id: invite.workspace_id,
            user_id: invite.target_user_id,
          },
        },
      });
      if (member) return { invite, member };
    }
    throw AppError.conflict(`Invitation has already been ${invite.status}`);
  }

  if (invite.expires_at < new Date()) {
    await prisma.workspaceMemberInvite.update({
      where: { id: invite.id },
      data: { status: 'expired' },
    });
    throw AppError.gone('Invitation has expired');
  }

  if (action === 'decline') {
    const updated = await prisma.workspaceMemberInvite.update({
      where: { id: invite.id },
      data: { status: 'declined', responded_at: new Date() },
    });
    return { invite: updated, member: null };
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.workspaceMemberInvite.update({
      where: { id: invite.id },
      data: { status: 'accepted', responded_at: new Date() },
    });
    const existing = await tx.workspaceMember.findUnique({
      where: {
        workspace_id_user_id: {
          workspace_id: invite.workspace_id,
          user_id: invite.target_user_id,
        },
      },
    });
    const member =
      existing ??
      (await tx.workspaceMember.create({
        data: {
          workspace_id: invite.workspace_id,
          user_id: invite.target_user_id,
          role: invite.role,
        },
      }));
    return { invite: updated, member };
  });
}
