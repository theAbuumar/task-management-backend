// Members' access, for admins (Ф12 12.B7, ADR-026): turn a member's access to the
// workspace off and back on, see when people last signed in and from how many
// devices, and reset a login method a member lost (a new phone for Telegram).
//
// Turning access off is per workspace: the account stays, the member keeps their
// tasks and history and stays in the list marked as deactivated. The hook refuses
// their requests to this workspace (403 MEMBER_DEACTIVATED); if no workspace with
// access is left, their sessions end and sign-in is refused too (auth/service).

import type { AuthProvider, PrismaClient, WorkspaceMember } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { OPEN_GROUPS } from '../control/rules.js';
import { revokeAllSessions } from '../auth/sessions.service.js';
import { unlinkIdentity } from '../auth/service.js';

export interface MemberAccess {
  user_id: string;
  deactivated_at: Date | null;
  deactivated_by: { id: string; display_name: string } | null;
  /** Latest sign-in on any device; null when we have no record of one. */
  last_login_at: Date | null;
  /** Latest activity: a sign-in or a token refresh (≈ every 15 minutes while working). */
  last_seen_at: Date | null;
  /** Devices signed in right now. */
  active_sessions: number;
  /** Linked login methods: email, google, github, telegram. */
  providers: AuthProvider[];
  /** Open tasks where they are an assignee or the controller — to hand over before leaving. */
  open_issues: number;
}

type Viewer = Pick<WorkspaceMember, 'role' | 'user_id'>;

function assertAdmin(viewer: Viewer): void {
  if (viewer.role !== 'owner' && viewer.role !== 'admin') {
    throw AppError.forbidden("Only workspace admins can manage members' access");
  }
}

/**
 * The member an admin acts on: in this workspace, not the owner, not themselves —
 * the same limits as changing a role (docs/PERMISSIONS.md).
 */
async function targetOf(
  prisma: PrismaClient,
  workspaceId: string,
  viewer: Viewer,
  userId: string,
): Promise<WorkspaceMember> {
  assertAdmin(viewer);
  const member = await prisma.workspaceMember.findUnique({
    where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: userId } },
  });
  if (!member) throw AppError.notFound('Member not found');
  if (member.role === 'owner') {
    throw AppError.forbidden("The workspace owner's access cannot be changed");
  }
  if (userId === viewer.user_id) {
    throw AppError.forbidden('You cannot change your own access — ask another admin');
  }
  return member;
}

/** Access details of every member, for the admin view of «Сотрудники». */
export async function listMemberAccess(
  prisma: PrismaClient,
  workspaceId: string,
  viewer: Viewer,
): Promise<MemberAccess[]> {
  assertAdmin(viewer);
  const members = await prisma.workspaceMember.findMany({
    where: { workspace_id: workspaceId },
    select: { user_id: true, deactivated_at: true, deactivated_by: true },
  });
  const ids = members.map((m) => m.user_id);
  const now = new Date();
  const open = {
    workspace_id: workspaceId,
    deleted_at: null,
    state: { group: { in: OPEN_GROUPS } },
  };

  const [sessions, live, identities, assigned, controlled, admins] = await Promise.all([
    prisma.authSession.groupBy({
      by: ['user_id'],
      where: { user_id: { in: ids } },
      _max: { created_at: true, last_used_at: true },
    }),
    prisma.authSession.groupBy({
      by: ['user_id'],
      where: { user_id: { in: ids }, revoked_at: null, expires_at: { gt: now } },
      _count: { _all: true },
    }),
    prisma.authIdentity.findMany({
      where: { user_id: { in: ids } },
      select: { user_id: true, provider: true },
      orderBy: { created_at: 'asc' },
    }),
    prisma.issueAssignee.findMany({
      where: { user_id: { in: ids }, issue: open },
      select: { user_id: true, issue_id: true },
    }),
    prisma.issue.findMany({
      where: { ...open, controller_id: { in: ids } },
      select: { id: true, controller_id: true },
    }),
    prisma.user.findMany({
      where: { id: { in: members.flatMap((m) => (m.deactivated_by ? [m.deactivated_by] : [])) } },
      select: { id: true, display_name: true },
    }),
  ]);

  const seen = new Map(sessions.map((s) => [s.user_id, s._max]));
  const liveCount = new Map(live.map((s) => [s.user_id, s._count._all]));
  const adminName = new Map(admins.map((a) => [a.id, a.display_name]));
  // One task counts once even when they are both its assignee and controller.
  const openIssues = new Map<string, Set<string>>();
  const addOpen = (userId: string, issueId: string) =>
    openIssues.set(userId, (openIssues.get(userId) ?? new Set()).add(issueId));
  for (const a of assigned) addOpen(a.user_id, a.issue_id);
  for (const c of controlled) addOpen(c.controller_id!, c.id);

  return members.map((m) => ({
    user_id: m.user_id,
    deactivated_at: m.deactivated_at,
    deactivated_by: m.deactivated_by
      ? { id: m.deactivated_by, display_name: adminName.get(m.deactivated_by) ?? '—' }
      : null,
    last_login_at: seen.get(m.user_id)?.created_at ?? null,
    last_seen_at: seen.get(m.user_id)?.last_used_at ?? null,
    active_sessions: liveCount.get(m.user_id) ?? 0,
    providers: [
      ...new Set(identities.filter((i) => i.user_id === m.user_id).map((i) => i.provider)),
    ],
    open_issues: openIssues.get(m.user_id)?.size ?? 0,
  }));
}

/**
 * Turn a member's access off. If no workspace with access is left to them, every
 * session of theirs ends at once (returned, so live streams can be closed too).
 */
export async function deactivateMember(
  prisma: PrismaClient,
  workspaceId: string,
  viewer: Viewer,
  userId: string,
): Promise<{ member: WorkspaceMember; signedOut: boolean }> {
  const target = await targetOf(prisma, workspaceId, viewer, userId);
  if (target.deactivated_at) return { member: target, signedOut: false };

  const member = await prisma.workspaceMember.update({
    where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: userId } },
    data: { deactivated_at: new Date(), deactivated_by: viewer.user_id },
  });
  const elsewhere = await prisma.workspaceMember.count({
    where: { user_id: userId, deactivated_at: null },
  });
  if (elsewhere > 0) return { member, signedOut: false };
  await revokeAllSessions(prisma, userId);
  return { member, signedOut: true };
}

/** Give a deactivated member their access back. */
export async function activateMember(
  prisma: PrismaClient,
  workspaceId: string,
  viewer: Viewer,
  userId: string,
): Promise<WorkspaceMember> {
  const target = await targetOf(prisma, workspaceId, viewer, userId);
  if (!target.deactivated_at) return target;
  return prisma.workspaceMember.update({
    where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: userId } },
    data: { deactivated_at: null, deactivated_by: null },
  });
}

/**
 * Unlink a member's Telegram, Google or GitHub — e.g. they changed their phone and
 * the old Telegram still gets their assignments. The email stays (it is the
 * account's own), and the last login method cannot be removed.
 */
export async function resetMemberIdentity(
  prisma: PrismaClient,
  workspaceId: string,
  viewer: Viewer,
  userId: string,
  provider: Exclude<AuthProvider, 'email'>,
): Promise<void> {
  await targetOf(prisma, workspaceId, viewer, userId);
  await unlinkIdentity(prisma, userId, provider);
}
