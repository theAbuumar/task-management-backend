// Execution control (Ф5): the hand-in/review cycle of an assignment,
// acknowledgement ("Ознакомлен"), deadline-change requests and watchers.
//
// Every mutation records activity + in-app notifications inside its transaction,
// then fans out Telegram/email best-effort after commit (lib/deliver).

import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { recordActivity, ACTIVITY_ACTIONS } from '../../lib/activity.js';
import { notify } from '../../lib/notifications.js';
import { deliverNow } from '../../lib/notify/send.js';
import { controlSettings } from '../../lib/control-settings.js';
import * as issueService from '../issues/service.js';
import {
  addWatchers,
  closePendingReview,
  firstStateOfGroup,
  isReviewer,
  memberRole,
  openReview,
  reviewersOf,
} from './rules.js';
import type { DecideBody, DeadlineRequestBody, SubmitReviewBody } from './schema.js';

const USER_BRIEF = { id: true, email: true, display_name: true, avatar_url: true } as const;

interface Ctx {
  workspaceId: string;
  projectId: string;
  issueId: string;
  actorId: string;
}

async function loadIssue(prisma: PrismaClient, ctx: Ctx) {
  const issue = await prisma.issue.findFirst({
    where: {
      id: ctx.issueId,
      project_id: ctx.projectId,
      workspace_id: ctx.workspaceId,
      deleted_at: null,
    },
    include: {
      assignees: { select: { user_id: true, acknowledged_at: true } },
      state: { select: { group: true } },
      workspace: { select: { settings: true } },
    },
  });
  if (!issue) throw AppError.notFound('Issue not found');
  return issue;
}

function assertAssignee(issue: { assignees: { user_id: string }[] }, userId: string) {
  if (!issue.assignees.some((a) => a.user_id === userId)) {
    throw new AppError(403, 'NOT_ASSIGNEE', 'Only an assignee of this issue can do this');
  }
}

const full = (prisma: PrismaClient, ctx: Ctx) =>
  issueService.getIssue(prisma, ctx.workspaceId, ctx.projectId, ctx.issueId);

// ─── Review cycle ─────────────────────────────────────────────────────────────

/** Assignee hands the work in: report (+ files) → state "На проверке" → controller notified. */
export async function submitReview(prisma: PrismaClient, ctx: Ctx, body: SubmitReviewBody) {
  const issue = await loadIssue(prisma, ctx);
  const role = await memberRole(prisma, ctx.workspaceId, ctx.actorId);
  if (role !== 'owner' && role !== 'admin') assertAssignee(issue, ctx.actorId);

  const report = body.report?.trim() || null;
  if (controlSettings(issue.workspace.settings).require_report && !report) {
    throw new AppError(400, 'REPORT_REQUIRED', 'A written report is required to hand the work in');
  }
  const pending = await prisma.issueReview.findFirst({
    where: { issue_id: issue.id, decision: 'pending' },
    select: { id: true },
  });
  if (pending) throw new AppError(409, 'REVIEW_PENDING', 'The work is already waiting for review');

  const reviewState = await firstStateOfGroup(prisma, ctx.projectId, 'review');
  if (!reviewState) {
    throw new AppError(400, 'NO_REVIEW_STATE', 'The project has no "review" state');
  }

  await prisma.$transaction(async (tx) => {
    const reviewId = await openReview(tx, issue, ctx.actorId, report);
    if (body.attachment_ids?.length) {
      await tx.attachment.updateMany({
        where: { id: { in: body.attachment_ids }, issue_id: issue.id },
        data: { review_id: reviewId },
      });
    }
    await tx.issue.update({
      where: { id: issue.id },
      data: { state_id: reviewState.id, completed_at: null },
    });
    await recordActivity(tx, {
      workspace_id: ctx.workspaceId,
      issue_id: issue.id,
      actor_id: ctx.actorId,
      action: ACTIVITY_ACTIONS.REVIEW_SUBMITTED,
      new_value: reviewId,
    });
  });

  await deliverNow(prisma, [issue.id]);
  return full(prisma, ctx);
}

/** Controller accepts (→ "Готово") or returns (→ "В работе", comment required). */
export async function decideReview(
  prisma: PrismaClient,
  ctx: Ctx,
  decision: 'approved' | 'returned',
  body: DecideBody,
) {
  const issue = await loadIssue(prisma, ctx);
  const role = await memberRole(prisma, ctx.workspaceId, ctx.actorId);
  if (!isReviewer(issue, ctx.actorId, role)) {
    throw new AppError(403, 'NOT_REVIEWER', 'Only the controller (or the author) can decide');
  }
  const comment = body.comment?.trim() || null;
  if (decision === 'returned' && !comment) {
    throw AppError.badRequest('Explain what needs to be fixed (comment is required)');
  }
  const pending = await prisma.issueReview.findFirst({
    where: { issue_id: issue.id, decision: 'pending' },
    select: { id: true },
  });
  if (!pending) {
    throw new AppError(409, 'NO_PENDING_REVIEW', 'There is no hand-in waiting for review');
  }

  const target = await firstStateOfGroup(
    prisma,
    ctx.projectId,
    decision === 'approved' ? 'completed' : 'started',
  );
  if (!target) throw AppError.badRequest('The project has no state to move the work into');
  const assigneeIds = issue.assignees.map((a) => a.user_id);

  await prisma.$transaction(async (tx) => {
    await closePendingReview(tx, issue, decision, ctx.actorId, comment, assigneeIds);
    await tx.issue.update({
      where: { id: issue.id },
      data: {
        state_id: target.id,
        completed_at: decision === 'approved' ? new Date() : null,
      },
    });
    // The controller's remark also lands in the discussion so it stays visible.
    if (comment) {
      await tx.comment.create({
        data: {
          issue_id: issue.id,
          author_id: ctx.actorId,
          body:
            decision === 'returned'
              ? `↩️ **Возвращено на доработку.** ${comment}`
              : `✅ **Принято.** ${comment}`,
        },
      });
    }
    await recordActivity(tx, {
      workspace_id: ctx.workspaceId,
      issue_id: issue.id,
      actor_id: ctx.actorId,
      action:
        decision === 'approved'
          ? ACTIVITY_ACTIONS.REVIEW_APPROVED
          : ACTIVITY_ACTIONS.REVIEW_RETURNED,
      new_value: comment,
    });
  });

  await deliverNow(prisma, [issue.id]);
  return full(prisma, ctx);
}

export async function listReviews(prisma: PrismaClient, ctx: Ctx) {
  await loadIssue(prisma, ctx);
  return prisma.issueReview.findMany({
    where: { issue_id: ctx.issueId },
    include: {
      submitted_by: { select: USER_BRIEF },
      decided_by: { select: USER_BRIEF },
      attachments: { select: { id: true, file_name: true, file_size: true, mime_type: true } },
    },
    orderBy: { submitted_at: 'desc' },
  });
}

// ─── Acknowledgement ──────────────────────────────────────────────────────────

/** "Ознакомлен": the assignee confirms they saw the assignment (reaction time). */
export async function acknowledge(prisma: PrismaClient, ctx: Ctx) {
  const issue = await loadIssue(prisma, ctx);
  assertAssignee(issue, ctx.actorId);
  const mine = issue.assignees.find((a) => a.user_id === ctx.actorId)!;
  if (!mine.acknowledged_at) {
    await prisma.$transaction(async (tx) => {
      await tx.issueAssignee.update({
        where: { issue_id_user_id: { issue_id: issue.id, user_id: ctx.actorId } },
        data: { acknowledged_at: new Date() },
      });
      await recordActivity(tx, {
        workspace_id: ctx.workspaceId,
        issue_id: issue.id,
        actor_id: ctx.actorId,
        action: ACTIVITY_ACTIONS.ACKNOWLEDGED,
      });
      await notify(tx, {
        workspace_id: ctx.workspaceId,
        actor_id: ctx.actorId,
        type: 'acknowledged',
        recipient_ids: reviewersOf(issue),
        issue_id: issue.id,
      });
    });
    await deliverNow(prisma, [issue.id]);
  }
  return full(prisma, ctx);
}

// ─── Deadline-change requests ─────────────────────────────────────────────────

export async function requestDeadlineChange(
  prisma: PrismaClient,
  ctx: Ctx,
  body: DeadlineRequestBody,
) {
  const issue = await loadIssue(prisma, ctx);
  assertAssignee(issue, ctx.actorId);
  const pending = await prisma.deadlineChangeRequest.findFirst({
    where: { issue_id: issue.id, status: 'pending' },
    select: { id: true },
  });
  if (pending) {
    throw new AppError(
      409,
      'DEADLINE_REQUEST_PENDING',
      'A deadline change request is already pending',
    );
  }
  const newDue = new Date(body.new_due_date);

  const request = await prisma.$transaction(async (tx) => {
    const created = await tx.deadlineChangeRequest.create({
      data: {
        workspace_id: ctx.workspaceId,
        issue_id: issue.id,
        requested_by_id: ctx.actorId,
        old_due_date: issue.due_date,
        new_due_date: newDue,
        reason: body.reason.trim(),
      },
    });
    await recordActivity(tx, {
      workspace_id: ctx.workspaceId,
      issue_id: issue.id,
      actor_id: ctx.actorId,
      action: ACTIVITY_ACTIONS.DEADLINE_REQUESTED,
      field: 'due_date',
      old_value: issue.due_date?.toISOString() ?? null,
      new_value: newDue.toISOString(),
    });
    await notify(tx, {
      workspace_id: ctx.workspaceId,
      actor_id: ctx.actorId,
      type: 'deadline_change_requested',
      recipient_ids: reviewersOf(issue),
      issue_id: issue.id,
      entity_id: created.id,
      payload: {
        old_due: issue.due_date?.toISOString() ?? null,
        new_due: newDue.toISOString(),
        reason: created.reason,
      },
    });
    return created;
  });

  await deliverNow(prisma, [issue.id]);
  return request;
}

export async function decideDeadlineChange(
  prisma: PrismaClient,
  ctx: Ctx,
  requestId: string,
  approve: boolean,
  body: DecideBody,
) {
  const issue = await loadIssue(prisma, ctx);
  const role = await memberRole(prisma, ctx.workspaceId, ctx.actorId);
  if (!isReviewer(issue, ctx.actorId, role)) {
    throw new AppError(403, 'NOT_REVIEWER', 'Only the controller (or the author) can decide');
  }
  const request = await prisma.deadlineChangeRequest.findFirst({
    where: { id: requestId, issue_id: issue.id },
  });
  if (!request) throw AppError.notFound('Deadline change request not found');
  if (request.status !== 'pending')
    throw AppError.conflict('This request has already been decided');
  const comment = body.comment?.trim() || null;

  const decided = await prisma.$transaction(async (tx) => {
    const updated = await tx.deadlineChangeRequest.update({
      where: { id: request.id },
      data: {
        status: approve ? 'approved' : 'rejected',
        decided_by_id: ctx.actorId,
        decision_comment: comment,
        decided_at: new Date(),
      },
    });
    if (approve) {
      await tx.issue.update({ where: { id: issue.id }, data: { due_date: request.new_due_date } });
      await recordActivity(tx, {
        workspace_id: ctx.workspaceId,
        issue_id: issue.id,
        actor_id: ctx.actorId,
        action: ACTIVITY_ACTIONS.ISSUE_UPDATED,
        field: 'due_date',
        old_value: issue.due_date?.toISOString() ?? null,
        new_value: request.new_due_date.toISOString(),
      });
    }
    await recordActivity(tx, {
      workspace_id: ctx.workspaceId,
      issue_id: issue.id,
      actor_id: ctx.actorId,
      action: approve ? ACTIVITY_ACTIONS.DEADLINE_APPROVED : ACTIVITY_ACTIONS.DEADLINE_REJECTED,
      new_value: comment,
    });
    await notify(tx, {
      workspace_id: ctx.workspaceId,
      actor_id: ctx.actorId,
      type: 'deadline_change_decided',
      recipient_ids: [request.requested_by_id],
      issue_id: issue.id,
      entity_id: request.id,
      payload: { approved: approve, new_due: request.new_due_date.toISOString(), comment },
    });
    return updated;
  });

  await deliverNow(prisma, [issue.id]);
  return decided;
}

export async function listDeadlineRequests(prisma: PrismaClient, ctx: Ctx) {
  await loadIssue(prisma, ctx);
  return prisma.deadlineChangeRequest.findMany({
    where: { issue_id: ctx.issueId },
    include: {
      requested_by: { select: USER_BRIEF },
      decided_by: { select: USER_BRIEF },
    },
    orderBy: { created_at: 'desc' },
  });
}

// ─── Watchers ─────────────────────────────────────────────────────────────────

export async function listWatchers(prisma: PrismaClient, ctx: Ctx) {
  await loadIssue(prisma, ctx);
  return prisma.issueWatcher.findMany({
    where: { issue_id: ctx.issueId },
    include: { user: { select: USER_BRIEF } },
    orderBy: { created_at: 'asc' },
  });
}

export async function watch(prisma: PrismaClient, ctx: Ctx) {
  await loadIssue(prisma, ctx);
  await addWatchers(prisma, ctx.issueId, [ctx.actorId]);
  return listWatchers(prisma, ctx);
}

export async function unwatch(prisma: PrismaClient, ctx: Ctx) {
  await loadIssue(prisma, ctx);
  await prisma.issueWatcher.deleteMany({ where: { issue_id: ctx.issueId, user_id: ctx.actorId } });
  return listWatchers(prisma, ctx);
}
