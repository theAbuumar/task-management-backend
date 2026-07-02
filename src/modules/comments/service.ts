import type { PrismaClient, Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { recordActivity, ACTIVITY_ACTIONS } from '../../lib/activity.js';
import { notify, parseMentions } from '../../lib/notifications.js';
import type { CreateCommentBody, UpdateCommentBody } from './schema.js';

type CommentWithAuthor = Prisma.CommentGetPayload<{
  include: { author: { select: { id: true; display_name: true; avatar_url: true } } };
}>;

const INCLUDE_AUTHOR = {
  author: { select: { id: true, display_name: true, avatar_url: true } },
} as const;

async function resolveIssue(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  issueId: string,
): Promise<void> {
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, project_id: projectId, workspace_id: workspaceId, deleted_at: null },
  });
  if (!issue) throw AppError.notFound('Issue not found');
}

export async function listComments(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  issueId: string,
): Promise<CommentWithAuthor[]> {
  await resolveIssue(prisma, workspaceId, projectId, issueId);
  return prisma.comment.findMany({
    where: { issue_id: issueId },
    include: INCLUDE_AUTHOR,
    orderBy: { created_at: 'asc' },
  });
}

export async function createComment(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  issueId: string,
  authorId: string,
  body: CreateCommentBody,
): Promise<CommentWithAuthor> {
  await resolveIssue(prisma, workspaceId, projectId, issueId);

  if (body.parent_comment_id) {
    const parent = await prisma.comment.findFirst({
      where: { id: body.parent_comment_id, issue_id: issueId },
    });
    if (!parent) throw AppError.badRequest('parent_comment_id does not exist on this issue');
  }

  // Recipients of a comment notification: the issue's assignees and its creator
  // (TZ §5.18 — "comment on watched issue"; with no watch model in the MVP the
  // people involved with the issue stand in for watchers).
  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    select: { created_by_id: true, assignees: { select: { user_id: true } } },
  });
  const commentRecipients = issue
    ? [issue.created_by_id, ...issue.assignees.map((a) => a.user_id)]
    : [];

  // Resolve @mentions to workspace members (matched on the local part of their
  // email, which is unique per user). Only members of this workspace are notified.
  const mentionedIds = await resolveMentions(prisma, workspaceId, body.body);

  return prisma.$transaction(async (tx) => {
    const comment = await tx.comment.create({
      data: {
        issue_id: issueId,
        author_id: authorId,
        body: body.body,
        parent_comment_id: body.parent_comment_id ?? null,
      },
      include: INCLUDE_AUTHOR,
    });
    await recordActivity(tx, {
      workspace_id: workspaceId,
      issue_id: issueId,
      actor_id: authorId,
      action: ACTIVITY_ACTIONS.COMMENT_CREATED,
      new_value: comment.id,
    });

    // Mentions take precedence over the generic comment notification so a
    // mentioned recipient gets a single, more specific `mentioned` row.
    await notify(tx, {
      workspace_id: workspaceId,
      actor_id: authorId,
      type: 'mentioned',
      recipient_ids: mentionedIds,
      issue_id: issueId,
      entity_id: comment.id,
    });
    await notify(tx, {
      workspace_id: workspaceId,
      actor_id: authorId,
      type: 'comment_added',
      recipient_ids: commentRecipients.filter((id) => !mentionedIds.includes(id)),
      issue_id: issueId,
      entity_id: comment.id,
    });
    return comment;
  });
}

/**
 * Map `@mention` handles in a markdown body to workspace-member user ids. A
 * handle matches the local part (before `@`) of a member's email,
 * case-insensitively. Returns an empty array when nothing matches.
 */
async function resolveMentions(
  prisma: PrismaClient,
  workspaceId: string,
  body: string,
): Promise<string[]> {
  const handles = parseMentions(body);
  if (handles.length === 0) return [];

  const members = await prisma.workspaceMember.findMany({
    where: { workspace_id: workspaceId },
    select: { user: { select: { id: true, email: true } } },
  });

  const handleSet = new Set(handles);
  return (
    members
      // Mentions match on the email local-part; accounts without an email
      // (e.g. Telegram-only) simply can't be @-mentioned.
      .filter((m) => {
        if (!m.user.email) return false;
        return handleSet.has((m.user.email.split('@')[0] ?? '').toLowerCase());
      })
      .map((m) => m.user.id)
  );
}

export async function updateComment(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  issueId: string,
  commentId: string,
  requesterId: string,
  requesterRole: string,
  body: UpdateCommentBody,
): Promise<CommentWithAuthor> {
  await resolveIssue(prisma, workspaceId, projectId, issueId);

  const comment = await prisma.comment.findFirst({
    where: { id: commentId, issue_id: issueId },
  });
  if (!comment) throw AppError.notFound('Comment not found');
  if (comment.deleted_at) throw AppError.notFound('Comment has been deleted');

  const isAuthor = comment.author_id === requesterId;
  const isAdmin = requesterRole === 'admin' || requesterRole === 'owner';
  if (!isAuthor && !isAdmin)
    throw AppError.forbidden('Only the author or an admin can edit this comment');

  return prisma.$transaction(async (tx) => {
    const updated = await tx.comment.update({
      where: { id: commentId },
      data: { body: body.body },
      include: INCLUDE_AUTHOR,
    });
    await recordActivity(tx, {
      workspace_id: workspaceId,
      issue_id: issueId,
      actor_id: requesterId,
      action: ACTIVITY_ACTIONS.COMMENT_UPDATED,
      new_value: commentId,
    });
    return updated;
  });
}

export async function deleteComment(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  issueId: string,
  commentId: string,
  requesterId: string,
  requesterRole: string,
): Promise<void> {
  await resolveIssue(prisma, workspaceId, projectId, issueId);

  const comment = await prisma.comment.findFirst({
    where: { id: commentId, issue_id: issueId },
  });
  if (!comment) throw AppError.notFound('Comment not found');
  if (comment.deleted_at) throw AppError.notFound('Comment has already been deleted');

  const isAuthor = comment.author_id === requesterId;
  const isAdmin = requesterRole === 'admin' || requesterRole === 'owner';
  if (!isAuthor && !isAdmin)
    throw AppError.forbidden('Only the author or an admin can delete this comment');

  await prisma.$transaction(async (tx) => {
    await tx.comment.update({ where: { id: commentId }, data: { deleted_at: new Date() } });
    await recordActivity(tx, {
      workspace_id: workspaceId,
      issue_id: issueId,
      actor_id: requesterId,
      action: ACTIVITY_ACTIONS.COMMENT_DELETED,
      old_value: commentId,
    });
  });
}
