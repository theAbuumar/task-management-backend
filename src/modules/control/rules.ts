// Execution-control rules shared by the issues service and the control module
// (Ф5). Kept free of imports from either service so both can use it without a
// circular dependency.

import type { Prisma, PrismaClient, StateGroup, WorkspaceRole } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { notify } from '../../lib/notifications.js';

type Db = PrismaClient | Prisma.TransactionClient;

export interface ReviewSubject {
  id: string;
  workspace_id: string;
  created_by_id: string;
  controller_id: string | null;
  requires_review: boolean;
}

/**
 * Who accepts or returns the work: the controller, or the author when the
 * assignment has no controller. Workspace admins/owners may always decide.
 */
export function isReviewer(issue: ReviewSubject, userId: string, role: WorkspaceRole): boolean {
  if (role === 'owner' || role === 'admin') return true;
  return (issue.controller_id ?? issue.created_by_id) === userId;
}

/** The user(s) notified when work is handed in. */
export function reviewersOf(issue: ReviewSubject): string[] {
  return [issue.controller_id ?? issue.created_by_id];
}

export async function memberRole(
  db: Db,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole> {
  const member = await db.workspaceMember.findUnique({
    where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: userId } },
    select: { role: true },
  });
  if (!member) throw AppError.forbidden('You are not a member of this workspace');
  return member.role;
}

/** First state (by board order) of a group in a project, or null. */
export async function firstStateOfGroup(
  db: Db,
  projectId: string,
  group: StateGroup,
): Promise<{ id: string; name: string } | null> {
  return db.state.findFirst({
    where: { project_id: projectId, group },
    orderBy: { order: 'asc' },
    select: { id: true, name: true },
  });
}

/** Add watchers (idempotent). */
export async function addWatchers(db: Db, issueId: string, userIds: (string | null)[]) {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return;
  await db.issueWatcher.createMany({
    data: ids.map((user_id) => ({ issue_id: issueId, user_id })),
    skipDuplicates: true,
  });
}

export async function watcherIds(db: Db, issueId: string): Promise<string[]> {
  const rows = await db.issueWatcher.findMany({
    where: { issue_id: issueId },
    select: { user_id: true },
  });
  return rows.map((r) => r.user_id);
}

/** Open a pending review unless one is already pending. Returns its id. */
export async function openReview(
  db: Db,
  issue: ReviewSubject,
  submittedById: string,
  report: string | null,
): Promise<string> {
  const pending = await db.issueReview.findFirst({
    where: { issue_id: issue.id, decision: 'pending' },
    select: { id: true },
  });
  if (pending) return pending.id;
  const review = await db.issueReview.create({
    data: {
      workspace_id: issue.workspace_id,
      issue_id: issue.id,
      submitted_by_id: submittedById,
      report,
    },
  });
  await notify(db, {
    workspace_id: issue.workspace_id,
    actor_id: submittedById,
    type: 'review_requested',
    recipient_ids: reviewersOf(issue),
    issue_id: issue.id,
    entity_id: review.id,
  });
  return review.id;
}

/**
 * Close the pending review (if any) with a decision and notify the assignees.
 * Returns the review id, or null when nothing was pending.
 */
export async function closePendingReview(
  db: Db,
  issue: ReviewSubject,
  decision: 'approved' | 'returned',
  decidedById: string,
  comment: string | null,
  assigneeIds: string[],
): Promise<string | null> {
  const pending = await db.issueReview.findFirst({
    where: { issue_id: issue.id, decision: 'pending' },
    select: { id: true, submitted_by_id: true },
  });
  if (!pending) return null;
  await db.issueReview.update({
    where: { id: pending.id },
    data: {
      decision,
      decided_by_id: decidedById,
      decision_comment: comment,
      decided_at: new Date(),
    },
  });
  await notify(db, {
    workspace_id: issue.workspace_id,
    actor_id: decidedById,
    type: decision === 'approved' ? 'review_approved' : 'review_returned',
    recipient_ids: [pending.submitted_by_id, ...assigneeIds],
    issue_id: issue.id,
    entity_id: pending.id,
    payload: { comment },
  });
  return pending.id;
}

export const OPEN_GROUPS: StateGroup[] = ['backlog', 'unstarted', 'started', 'review'];
