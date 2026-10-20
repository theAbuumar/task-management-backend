// Bulk changes of issues (Ф6 6.B6, ADR-030): one state, priority, deadline,
// assignee or label for up to 100 issues of a project. Each issue goes through the
// regular service calls, so rights, the review rule (5.B3) and the controller's
// deadline (5.B5) are checked per issue and its history is written. One issue that
// may not be changed does not undo the others: the answer lists what was changed
// and what was not, with the reason.

import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import {
  addAssignee,
  assertAssignable,
  attachLabel,
  detachLabel,
  removeAssignee,
  updateIssue,
} from './service.js';

export const MAX_BULK = 100;

const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;

export const BulkBodySchema = z
  .object({
    issue_ids: z.array(z.string().uuid()).min(1).max(MAX_BULK),
    state_id: z.string().uuid().optional(),
    priority: z.enum(PRIORITIES).optional(),
    due_date: z.string().datetime().nullable().optional(),
    // The issue's assignees become exactly this person (the primary one).
    assignee_id: z.string().uuid().optional(),
    add_label_id: z.string().uuid().optional(),
    remove_label_id: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (b) =>
      b.state_id !== undefined ||
      b.priority !== undefined ||
      b.due_date !== undefined ||
      b.assignee_id !== undefined ||
      b.add_label_id !== undefined ||
      b.remove_label_id !== undefined,
    { message: 'Nothing to change' },
  );
export type BulkBody = z.infer<typeof BulkBodySchema>;

export interface BulkResult {
  updated: string[];
  failed: { issue_id: string; code: string; message: string }[];
}

/** What applies to every issue is checked once: a wrong state fails the request, not 100 issues. */
async function assertTargets(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  body: BulkBody,
): Promise<void> {
  if (body.state_id) {
    const state = await prisma.state.findFirst({
      where: { id: body.state_id, project_id: projectId },
    });
    if (!state) throw AppError.badRequest('state_id does not belong to this project');
  }
  for (const labelId of [body.add_label_id, body.remove_label_id]) {
    if (!labelId) continue;
    const label = await prisma.label.findFirst({ where: { id: labelId, project_id: projectId } });
    if (!label) throw AppError.notFound('Label not found in this project');
  }
  if (body.assignee_id) {
    await assertAssignable(prisma, workspaceId, [body.assignee_id], 'assignee_id');
  }
}

export async function bulkUpdateIssues(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  actorId: string,
  body: BulkBody,
): Promise<BulkResult> {
  await assertTargets(prisma, workspaceId, projectId, body);
  const ids = [...new Set(body.issue_ids)];
  const found = await prisma.issue.findMany({
    where: { id: { in: ids }, project_id: projectId, deleted_at: null },
    select: {
      id: true,
      assignees: { select: { user_id: true } },
      labels: { select: { label_id: true } },
    },
  });
  const byId = new Map(found.map((i) => [i.id, i]));
  const result: BulkResult = { updated: [], failed: [] };

  for (const issueId of ids) {
    const issue = byId.get(issueId);
    if (!issue) {
      result.failed.push({ issue_id: issueId, code: 'NOT_FOUND', message: 'Issue not found' });
      continue;
    }
    try {
      const fields = {
        ...(body.state_id !== undefined && { state_id: body.state_id }),
        ...(body.priority !== undefined && { priority: body.priority }),
        ...(body.due_date !== undefined && { due_date: body.due_date }),
      };
      if (Object.keys(fields).length > 0) {
        await updateIssue(prisma, workspaceId, projectId, issueId, actorId, fields);
      }
      if (body.assignee_id) {
        const current = issue.assignees.map((a) => a.user_id);
        // Add first: removing the primary one then hands the role to the newcomer.
        if (!current.includes(body.assignee_id)) {
          await addAssignee(prisma, workspaceId, projectId, issueId, actorId, body.assignee_id);
        }
        for (const userId of current.filter((u) => u !== body.assignee_id)) {
          await removeAssignee(prisma, workspaceId, projectId, issueId, actorId, userId);
        }
      }
      const labels = issue.labels.map((l) => l.label_id);
      if (body.add_label_id && !labels.includes(body.add_label_id)) {
        await attachLabel(prisma, workspaceId, projectId, issueId, actorId, body.add_label_id);
      }
      if (body.remove_label_id && labels.includes(body.remove_label_id)) {
        await detachLabel(prisma, workspaceId, projectId, issueId, actorId, body.remove_label_id);
      }
      result.updated.push(issueId);
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      result.failed.push({ issue_id: issueId, code: err.code, message: err.message });
    }
  }
  return result;
}
