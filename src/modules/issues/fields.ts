// The fields of an issue as the create form holds them, stored by templates (6.B3)
// and recurring rules (6.B4) — ADR-030. The same shapes as creating an issue, so
// an issue made from them goes through createIssue with nothing checked twice.

import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { CreateIssueBodySchema, type CreateIssueBody } from './schema.js';
import { assertAssignable } from './service.js';

export const IssueFieldsSchema = CreateIssueBodySchema.pick({
  description: true,
  priority: true,
  kind: true,
  controller_id: true,
  requires_review: true,
  basis: true,
  primary_assignee_id: true,
  checklist: true,
})
  .extend({
    title: z.string().trim().min(1).max(500),
    assignee_ids: z.array(z.string().uuid()).max(50).optional(),
    label_ids: z.array(z.string().uuid()).max(50).optional(),
  })
  .strict();
export type IssueFields = z.infer<typeof IssueFieldsSchema>;

/** Deadline offset of an issue made from a template or a rule: 0 = the same day. */
export const DueInDaysSchema = z.number().int().min(0).max(365).nullable();

/**
 * Check the stored fields against the workspace now: assignees and the controller
 * can be assigned, the primary assignee is one of them, labels are the project's
 * (a workspace template has none — labels are per project).
 */
export async function assertIssueFields(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string | null,
  fields: IssueFields,
): Promise<void> {
  const assignees = fields.assignee_ids ?? [];
  await assertAssignable(prisma, workspaceId, assignees, 'assignee_ids');
  if (fields.controller_id) {
    await assertAssignable(prisma, workspaceId, [fields.controller_id], 'controller_id');
  }
  if (fields.primary_assignee_id && !assignees.includes(fields.primary_assignee_id)) {
    throw AppError.badRequest('primary_assignee_id must be one of assignee_ids');
  }
  const labels = [...new Set(fields.label_ids ?? [])];
  if (labels.length === 0) return;
  if (!projectId) throw AppError.badRequest('A workspace template has no labels');
  const found = await prisma.label.count({ where: { id: { in: labels }, project_id: projectId } });
  if (found !== labels.length)
    throw AppError.badRequest('label_ids must be labels of this project');
}

/** The default state of a project: where new issues land. */
export async function defaultStateId(prisma: PrismaClient, projectId: string): Promise<string> {
  const state = await prisma.state.findFirst({
    where: { project_id: projectId },
    orderBy: [{ is_default: 'desc' }, { order: 'asc' }],
    select: { id: true },
  });
  if (!state) throw AppError.badRequest('The project has no states');
  return state.id;
}

/**
 * The create body for an issue made from stored fields today: the project's
 * default state, the deadline `due_in_days` after local `today` (noon UTC, as the
 * form stores a date), labels that still exist in the project.
 */
export async function createBodyFrom(
  prisma: PrismaClient,
  projectId: string,
  fields: IssueFields,
  dueInDays: number | null,
  today: string,
): Promise<CreateIssueBody> {
  const labels = fields.label_ids?.length
    ? (
        await prisma.label.findMany({
          where: { id: { in: fields.label_ids }, project_id: projectId },
          select: { id: true },
        })
      ).map((l) => l.id)
    : [];
  const due = dueInDays === null ? null : new Date(`${today}T12:00:00.000Z`);
  due?.setUTCDate(due.getUTCDate() + (dueInDays ?? 0));
  return CreateIssueBodySchema.parse({
    ...fields,
    label_ids: labels,
    state_id: await defaultStateId(prisma, projectId),
    due_date: due ? due.toISOString() : null,
  });
}
