// Activity logging helper.
//
// Services call `recordActivity`/`recordActivities` as a side effect after a
// successful mutation to append rows to the `ActivityLog` audit trail (TZ §5.17).
// The trail powers the issue history feed and is the basis for Phase 3
// notifications. Entries are append-only and never updated after creation.
//
// Accepts either a `PrismaClient` or a transaction client so callers can record
// inside the same transaction as the mutation when atomicity matters.
//
// Every recorded row is also announced as a real-time event (lib/realtime): the
// activity trail already covers every issue mutation — from the API, the Telegram
// bot and the reminder scheduler alike — so live boards need no extra call sites.

import type { PrismaClient, Prisma } from '@prisma/client';
import { publishActivity } from './realtime.js';

type DbClient = PrismaClient | Prisma.TransactionClient;

/** Canonical action strings. `entity.event` form keeps the feed greppable. */
export const ACTIVITY_ACTIONS = {
  ISSUE_CREATED: 'issue.created',
  ISSUE_UPDATED: 'issue.updated',
  ISSUE_DELETED: 'issue.deleted',
  // Back from the trash (7.B6).
  ISSUE_RESTORED: 'issue.restored',
  ISSUE_ASSIGNEE_ADDED: 'issue.assignee_added',
  ISSUE_ASSIGNEE_REMOVED: 'issue.assignee_removed',
  ISSUE_LABEL_ADDED: 'issue.label_added',
  ISSUE_LABEL_REMOVED: 'issue.label_removed',
  COMMENT_CREATED: 'comment.created',
  COMMENT_UPDATED: 'comment.updated',
  COMMENT_DELETED: 'comment.deleted',
  ATTACHMENT_ADDED: 'issue.attachment_added',
  ATTACHMENT_REMOVED: 'issue.attachment_removed',
  // Execution control (Ф5).
  REVIEW_SUBMITTED: 'issue.review_submitted',
  REVIEW_APPROVED: 'issue.review_approved',
  REVIEW_RETURNED: 'issue.review_returned',
  ACKNOWLEDGED: 'issue.acknowledged',
  DEADLINE_REQUESTED: 'issue.deadline_requested',
  DEADLINE_APPROVED: 'issue.deadline_approved',
  DEADLINE_REJECTED: 'issue.deadline_rejected',
  // Checklist (6.B5): the item's text is in new_value (old_value when removed or renamed).
  CHECKLIST_ADDED: 'issue.checklist_added',
  CHECKLIST_CHECKED: 'issue.checklist_checked',
  CHECKLIST_UNCHECKED: 'issue.checklist_unchecked',
  CHECKLIST_UPDATED: 'issue.checklist_updated',
  CHECKLIST_REMOVED: 'issue.checklist_removed',
  // Modules (4.F4): the module id is in new_value (old_value when removed).
  MODULE_ADDED: 'issue.module_added',
  MODULE_REMOVED: 'issue.module_removed',
  // Relations (4.F6): `field` is the relation type as seen from this issue
  // (blocks / blocked_by / relates_to / duplicates), the other issue's id is in
  // new_value (old_value when removed). Both issues get an entry.
  RELATION_ADDED: 'issue.relation_added',
  RELATION_REMOVED: 'issue.relation_removed',
} as const;

export interface ActivityEntry {
  workspace_id: string;
  actor_id: string;
  action: string;
  issue_id?: string | null;
  field?: string | null;
  old_value?: string | null;
  new_value?: string | null;
}

/** Append a single activity row. */
export async function recordActivity(db: DbClient, entry: ActivityEntry): Promise<void> {
  await db.activityLog.create({
    data: {
      workspace_id: entry.workspace_id,
      actor_id: entry.actor_id,
      action: entry.action,
      issue_id: entry.issue_id ?? null,
      field: entry.field ?? null,
      old_value: entry.old_value ?? null,
      new_value: entry.new_value ?? null,
    },
  });
  await publishActivity(db, [entry]);
}

/** Append several activity rows in one batch. No-op when the list is empty. */
export async function recordActivities(db: DbClient, entries: ActivityEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await db.activityLog.createMany({
    data: entries.map((e) => ({
      workspace_id: e.workspace_id,
      actor_id: e.actor_id,
      action: e.action,
      issue_id: e.issue_id ?? null,
      field: e.field ?? null,
      old_value: e.old_value ?? null,
      new_value: e.new_value ?? null,
    })),
  });
  await publishActivity(db, entries);
}
