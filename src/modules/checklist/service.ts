// Checklists of issues (Ф6 6.B5, ADR-030): the steps of a multi-step job —
// «подготовка к аккредитации» in seven ticks. Whoever may change the issue may
// change its checklist (a guest is read-only, 12.B4 — refused by the workspace
// hook). Every change but a reorder goes to the issue history, and the issue keeps
// the «3/7» counters, recounted in the same transaction as the change.

import { z } from 'zod';
import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { ACTIVITY_ACTIONS, recordActivity } from '../../lib/activity.js';
import { publish } from '../../lib/realtime.js';

type Db = PrismaClient | Prisma.TransactionClient;

export const MAX_CHECKLIST_ITEMS = 100;

/** One item's text: what is typed, without surrounding spaces. */
export const ChecklistTextSchema = z.string().trim().min(1).max(500);

/** Items given with a new issue (create form, template, recurring rule). */
export const ChecklistInputSchema = z.array(ChecklistTextSchema).max(MAX_CHECKLIST_ITEMS);

export const CreateItemBodySchema = z.object({ text: ChecklistTextSchema });

export const UpdateItemBodySchema = z
  .object({ text: ChecklistTextSchema, is_done: z.boolean() })
  .partial()
  .refine((b) => b.text !== undefined || b.is_done !== undefined, {
    message: 'Nothing to change: give text or is_done',
  });

export const ReorderBodySchema = z.object({
  item_ids: z.array(z.string().uuid()).max(MAX_CHECKLIST_ITEMS),
});

const INCLUDE = {
  done_by: { select: { id: true, display_name: true, avatar_url: true } },
} as const;

type Item = Prisma.IssueChecklistItemGetPayload<{ include: typeof INCLUDE }>;

export interface Checklist {
  data: Item[];
  total: number;
  done: number;
}

interface Target {
  workspaceId: string;
  projectId: string;
  issueId: string;
}

async function resolveIssue(prisma: PrismaClient, target: Target): Promise<void> {
  const issue = await prisma.issue.findFirst({
    where: {
      id: target.issueId,
      project_id: target.projectId,
      workspace_id: target.workspaceId,
      deleted_at: null,
    },
    select: { id: true },
  });
  if (!issue) throw AppError.notFound('Issue not found');
}

async function findItem(prisma: PrismaClient, issueId: string, itemId: string) {
  const item = await prisma.issueChecklistItem.findFirst({
    where: { id: itemId, issue_id: issueId },
  });
  if (!item) throw AppError.notFound('Checklist item not found');
  return item;
}

/** Recount the issue's «done/total» from its items (never drifts). */
export async function recountChecklist(db: Db, issueId: string): Promise<void> {
  const total = await db.issueChecklistItem.count({ where: { issue_id: issueId } });
  const done = await db.issueChecklistItem.count({ where: { issue_id: issueId, is_done: true } });
  await db.issue.update({
    where: { id: issueId },
    data: { checklist_total: total, checklist_done: done },
  });
}

/** Create the items of a brand-new issue in their order (inside its transaction). */
export async function createChecklistItems(
  db: Db,
  issueId: string,
  texts: string[],
): Promise<void> {
  if (texts.length === 0) return;
  await db.issueChecklistItem.createMany({
    data: texts.map((text, order) => ({ issue_id: issueId, text, order })),
  });
}

async function read(db: Db, issueId: string): Promise<Checklist> {
  const data = await db.issueChecklistItem.findMany({
    where: { issue_id: issueId },
    include: INCLUDE,
    orderBy: [{ order: 'asc' }, { created_at: 'asc' }],
  });
  return { data, total: data.length, done: data.filter((i) => i.is_done).length };
}

export async function getChecklist(prisma: PrismaClient, target: Target): Promise<Checklist> {
  await resolveIssue(prisma, target);
  return read(prisma, target.issueId);
}

export async function addChecklistItem(
  prisma: PrismaClient,
  target: Target,
  actorId: string,
  body: z.infer<typeof CreateItemBodySchema>,
): Promise<Checklist> {
  await resolveIssue(prisma, target);
  return prisma.$transaction(async (tx) => {
    const count = await tx.issueChecklistItem.count({ where: { issue_id: target.issueId } });
    if (count >= MAX_CHECKLIST_ITEMS) {
      throw new AppError(
        400,
        'CHECKLIST_FULL',
        `A checklist holds at most ${MAX_CHECKLIST_ITEMS} items`,
      );
    }
    const last = await tx.issueChecklistItem.findFirst({
      where: { issue_id: target.issueId },
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    await tx.issueChecklistItem.create({
      data: { issue_id: target.issueId, text: body.text, order: (last?.order ?? -1) + 1 },
    });
    await recountChecklist(tx, target.issueId);
    await recordActivity(tx, {
      workspace_id: target.workspaceId,
      issue_id: target.issueId,
      actor_id: actorId,
      action: ACTIVITY_ACTIONS.CHECKLIST_ADDED,
      field: 'checklist',
      new_value: body.text,
    });
    return read(tx, target.issueId);
  });
}

export async function updateChecklistItem(
  prisma: PrismaClient,
  target: Target,
  actorId: string,
  itemId: string,
  body: z.infer<typeof UpdateItemBodySchema>,
): Promise<Checklist> {
  await resolveIssue(prisma, target);
  const before = await findItem(prisma, target.issueId, itemId);
  const textChanged = body.text !== undefined && body.text !== before.text;
  const doneChanged = body.is_done !== undefined && body.is_done !== before.is_done;
  return prisma.$transaction(async (tx) => {
    if (textChanged || doneChanged) {
      await tx.issueChecklistItem.update({
        where: { id: itemId },
        data: {
          ...(textChanged && { text: body.text }),
          ...(doneChanged && {
            is_done: body.is_done,
            done_by_id: body.is_done ? actorId : null,
            done_at: body.is_done ? new Date() : null,
          }),
        },
      });
    }
    if (doneChanged) {
      await recountChecklist(tx, target.issueId);
      await recordActivity(tx, {
        workspace_id: target.workspaceId,
        issue_id: target.issueId,
        actor_id: actorId,
        action: body.is_done
          ? ACTIVITY_ACTIONS.CHECKLIST_CHECKED
          : ACTIVITY_ACTIONS.CHECKLIST_UNCHECKED,
        field: 'checklist',
        new_value: body.text ?? before.text,
      });
    }
    if (textChanged) {
      await recordActivity(tx, {
        workspace_id: target.workspaceId,
        issue_id: target.issueId,
        actor_id: actorId,
        action: ACTIVITY_ACTIONS.CHECKLIST_UPDATED,
        field: 'checklist',
        old_value: before.text,
        new_value: body.text,
      });
    }
    return read(tx, target.issueId);
  });
}

export async function deleteChecklistItem(
  prisma: PrismaClient,
  target: Target,
  actorId: string,
  itemId: string,
): Promise<Checklist> {
  await resolveIssue(prisma, target);
  const item = await findItem(prisma, target.issueId, itemId);
  return prisma.$transaction(async (tx) => {
    await tx.issueChecklistItem.delete({ where: { id: itemId } });
    await recountChecklist(tx, target.issueId);
    await recordActivity(tx, {
      workspace_id: target.workspaceId,
      issue_id: target.issueId,
      actor_id: actorId,
      action: ACTIVITY_ACTIONS.CHECKLIST_REMOVED,
      field: 'checklist',
      old_value: item.text,
    });
    return read(tx, target.issueId);
  });
}

/**
 * New order of the whole checklist: `item_ids` must be exactly the issue's items.
 * Not written to the history (like dragging a card), but other open panels follow.
 */
export async function reorderChecklist(
  prisma: PrismaClient,
  target: Target,
  actorId: string,
  body: z.infer<typeof ReorderBodySchema>,
): Promise<Checklist> {
  await resolveIssue(prisma, target);
  const items = await prisma.issueChecklistItem.findMany({
    where: { issue_id: target.issueId },
    select: { id: true },
  });
  const given = new Set(body.item_ids);
  if (
    given.size !== body.item_ids.length ||
    given.size !== items.length ||
    items.some((i) => !given.has(i.id))
  ) {
    throw AppError.badRequest('item_ids must list every item of this checklist exactly once');
  }
  return prisma.$transaction(async (tx) => {
    for (const [order, id] of body.item_ids.entries()) {
      await tx.issueChecklistItem.update({ where: { id }, data: { order } });
    }
    await publish(tx, {
      t: 'issue.updated',
      w: target.workspaceId,
      a: actorId,
      i: target.issueId,
      f: ['checklist'],
    });
    return read(tx, target.issueId);
  });
}
