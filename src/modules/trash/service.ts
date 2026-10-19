// Корзина (Ф7 7.B6, ADR-017). Deleting an issue or a project only sets
// `deleted_at` (and `deleted_by_id`); here they are listed, restored, or removed
// for good. After TRASH_RETENTION_DAYS the scheduler removes them itself.
//
// Who sees and does what (docs/PERMISSIONS.md):
//   - admins and the owner: everything in the trash, restore anything, remove
//     anything for good;
//   - members: the issues they deleted themselves (in projects they still see),
//     and restore them; projects are deleted by admins only, so not theirs;
//   - guests delete nothing, so their trash is empty.
// An issue of a project that is itself in the trash comes back with the project:
// it is not listed separately and cannot be restored on its own (409).

import type { Prisma, PrismaClient, WorkspaceMember } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { ACTIVITY_ACTIONS, recordActivity } from '../../lib/activity.js';
import type { StorageDriver } from '../../lib/storage.js';
import { seesAllProjects } from '../../plugins/workspace-hook.js';

export const TRASH_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const TrashTypeSchema = z.enum(['issue', 'project']);
export type TrashType = z.infer<typeof TrashTypeSchema>;

/** `<deleted_at ISO>_<id>` of the last item of the previous page. */
const CURSOR = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)_([0-9a-f-]{36})$/;

export const TrashQuerySchema = z.object({
  type: TrashTypeSchema.optional(),
  cursor: z.string().regex(CURSOR, 'Invalid cursor').optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type TrashQuery = z.infer<typeof TrashQuerySchema>;

export interface TrashItem {
  type: TrashType;
  id: string;
  /** Issue title or project name. */
  name: string;
  /** `ACCR-12` for an issue, `ACCR` for a project. */
  key: string;
  /** Issue kind (`task` | `assignment`); null for a project. */
  kind: string | null;
  /** The issue's project; null for a project. */
  project: { id: string; name: string; identifier: string } | null;
  deleted_at: Date;
  deleted_by: { id: string; display_name: string } | null;
  /** When the scheduler removes it for good. */
  purge_at: Date;
  can_restore: boolean;
  can_purge: boolean;
}

type Viewer = Pick<WorkspaceMember, 'user_id' | 'role'>;

const isAdmin = (viewer: Viewer) => seesAllProjects(viewer as WorkspaceMember);

const purgeAt = (deletedAt: Date) => new Date(deletedAt.getTime() + TRASH_RETENTION_DAYS * DAY_MS);

/** Deleted issues the viewer may see in the trash (projects not deleted). */
function trashIssuesWhere(workspaceId: string, viewer: Viewer): Prisma.IssueWhereInput {
  if (isAdmin(viewer)) {
    return { workspace_id: workspaceId, deleted_at: { not: null }, project: { deleted_at: null } };
  }
  return {
    workspace_id: workspaceId,
    deleted_at: { not: null },
    deleted_by_id: viewer.user_id,
    project: {
      deleted_at: null,
      OR: [{ visibility: 'public' }, { members: { some: { user_id: viewer.user_id } } }],
    },
  };
}

/** Keyset condition: strictly after the cursor in (deleted_at desc, id desc) order. */
function afterCursor(cursor: string | undefined) {
  if (!cursor) return {};
  const [, at, id] = CURSOR.exec(cursor)!;
  const when = new Date(at!);
  return { OR: [{ deleted_at: { lt: when } }, { deleted_at: when, id: { lt: id! } }] };
}

export async function listTrash(
  prisma: PrismaClient,
  workspaceId: string,
  viewer: Viewer,
  query: TrashQuery,
): Promise<{ data: TrashItem[]; next_cursor: string | null; retention_days: number }> {
  const admin = isAdmin(viewer);
  const order = [{ deleted_at: 'desc' as const }, { id: 'desc' as const }];
  const take = query.limit + 1;

  const [issues, projects] = await Promise.all([
    query.type === 'project'
      ? []
      : prisma.issue.findMany({
          where: { AND: [trashIssuesWhere(workspaceId, viewer), afterCursor(query.cursor)] },
          orderBy: order,
          take,
          select: {
            id: true,
            title: true,
            sequence_id: true,
            kind: true,
            deleted_at: true,
            deleted_by_id: true,
            project: { select: { id: true, name: true, identifier: true } },
          },
        }),
    query.type === 'issue' || !admin
      ? []
      : prisma.project.findMany({
          where: {
            AND: [
              { workspace_id: workspaceId, deleted_at: { not: null } },
              afterCursor(query.cursor),
            ],
          },
          orderBy: order,
          take,
          select: { id: true, name: true, identifier: true, deleted_at: true, deleted_by_id: true },
        }),
  ]);

  const merged = [
    ...issues.map((i) => ({ type: 'issue' as const, row: i, at: i.deleted_at! })),
    ...projects.map((p) => ({ type: 'project' as const, row: p, at: p.deleted_at! })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime() || (a.row.id < b.row.id ? 1 : -1));
  const hasMore = merged.length > query.limit;
  const page = merged.slice(0, query.limit);

  const deleterIds = [
    ...new Set(page.map((e) => e.row.deleted_by_id).filter((x): x is string => Boolean(x))),
  ];
  const deleters = new Map(
    (
      await prisma.user.findMany({
        where: { id: { in: deleterIds } },
        select: { id: true, display_name: true },
      })
    ).map((u) => [u.id, u]),
  );

  const data: TrashItem[] = page.map((e) => {
    const deleted_by = e.row.deleted_by_id ? (deleters.get(e.row.deleted_by_id) ?? null) : null;
    const common = {
      id: e.row.id,
      deleted_at: e.at,
      deleted_by,
      purge_at: purgeAt(e.at),
      // A member's trash holds only what they deleted, so they may restore all of it.
      can_restore: true,
      can_purge: admin,
    };
    if (e.type === 'issue') {
      const i = e.row as (typeof issues)[number];
      return {
        ...common,
        type: 'issue',
        name: i.title,
        key: `${i.project.identifier}-${i.sequence_id}`,
        kind: i.kind,
        project: i.project,
      };
    }
    const p = e.row as (typeof projects)[number];
    return {
      ...common,
      type: 'project',
      name: p.name,
      key: p.identifier,
      kind: null,
      project: null,
    };
  });

  const last = page[page.length - 1];
  return {
    data,
    next_cursor: hasMore && last ? `${last.at.toISOString()}_${last.row.id}` : null,
    retention_days: TRASH_RETENTION_DAYS,
  };
}

export interface TrashResult {
  type: TrashType;
  id: string;
  name: string;
  key: string;
  /** The issue's project (to open it after a restore); the project itself for a project. */
  project_id: string;
}

/** A trashed issue the viewer may act on; 404 when it is not in their trash. */
async function trashedIssue(prisma: PrismaClient, workspaceId: string, viewer: Viewer, id: string) {
  const issue = await prisma.issue.findFirst({
    where: { id, workspace_id: workspaceId, deleted_at: { not: null } },
    select: {
      id: true,
      title: true,
      sequence_id: true,
      deleted_by_id: true,
      project: {
        select: {
          id: true,
          identifier: true,
          deleted_at: true,
          visibility: true,
          members: { where: { user_id: viewer.user_id }, select: { user_id: true } },
        },
      },
    },
  });
  if (!issue) throw AppError.notFound('Not in the trash');
  if (!isAdmin(viewer)) {
    const visible = issue.project.visibility === 'public' || issue.project.members.length > 0;
    if (!visible) throw AppError.notFound('Not in the trash');
    if (issue.deleted_by_id !== viewer.user_id) {
      throw AppError.forbidden('Only admins restore what other people deleted');
    }
  }
  return issue;
}

async function trashedProject(
  prisma: PrismaClient,
  workspaceId: string,
  viewer: Viewer,
  id: string,
) {
  if (!isAdmin(viewer)) throw AppError.forbidden('Only admins manage deleted projects');
  const project = await prisma.project.findFirst({
    where: { id, workspace_id: workspaceId, deleted_at: { not: null } },
    select: { id: true, name: true, identifier: true },
  });
  if (!project) throw AppError.notFound('Not in the trash');
  return project;
}

export async function restoreFromTrash(
  prisma: PrismaClient,
  workspaceId: string,
  viewer: Viewer,
  type: TrashType,
  id: string,
): Promise<TrashResult> {
  if (type === 'project') {
    const project = await trashedProject(prisma, workspaceId, viewer, id);
    await prisma.project.update({
      where: { id },
      data: { deleted_at: null, deleted_by_id: null },
    });
    return {
      type,
      id,
      name: project.name,
      key: project.identifier,
      project_id: project.id,
    };
  }

  const issue = await trashedIssue(prisma, workspaceId, viewer, id);
  if (issue.project.deleted_at) {
    throw new AppError(
      409,
      'PROJECT_IN_TRASH',
      'The project of this issue is in the trash — restore the project first',
    );
  }
  await prisma.$transaction(async (tx) => {
    await tx.issue.update({ where: { id }, data: { deleted_at: null, deleted_by_id: null } });
    await recordActivity(tx, {
      workspace_id: workspaceId,
      issue_id: id,
      actor_id: viewer.user_id,
      action: ACTIVITY_ACTIONS.ISSUE_RESTORED,
    });
  });
  return {
    type,
    id,
    name: issue.title,
    key: `${issue.project.identifier}-${issue.sequence_id}`,
    project_id: issue.project.id,
  };
}

/** Removes the rows (files after the commit). Sub-issues stay, without a parent. */
async function purgeIssues(prisma: PrismaClient, storage: StorageDriver, ids: string[]) {
  const files = await prisma.attachment.findMany({
    where: { issue_id: { in: ids } },
    select: { storage_key: true },
  });
  await prisma.$transaction([
    prisma.issue.updateMany({ where: { parent_id: { in: ids } }, data: { parent_id: null } }),
    prisma.issue.deleteMany({ where: { id: { in: ids } } }),
  ]);
  for (const f of files) await storage.delete(f.storage_key).catch(() => undefined);
}

async function purgeProject(prisma: PrismaClient, storage: StorageDriver, projectId: string) {
  const files = await prisma.attachment.findMany({
    where: { issue: { project_id: projectId } },
    select: { storage_key: true },
  });
  // Issues first (states are referenced by them), then the project with the rest.
  await prisma.$transaction([
    prisma.issue.updateMany({
      where: { parent: { project_id: projectId } },
      data: { parent_id: null },
    }),
    prisma.issue.deleteMany({ where: { project_id: projectId } }),
    prisma.project.delete({ where: { id: projectId } }),
  ]);
  for (const f of files) await storage.delete(f.storage_key).catch(() => undefined);
}

/** «Удалить навсегда» (admins): the issue or the project with all its issues and files. */
export async function purgeFromTrash(
  prisma: PrismaClient,
  storage: StorageDriver,
  workspaceId: string,
  viewer: Viewer,
  type: TrashType,
  id: string,
): Promise<TrashResult> {
  if (!isAdmin(viewer)) throw AppError.forbidden('Only admins delete for good');
  if (type === 'project') {
    const project = await trashedProject(prisma, workspaceId, viewer, id);
    await purgeProject(prisma, storage, id);
    return { type, id, name: project.name, key: project.identifier, project_id: id };
  }
  const issue = await trashedIssue(prisma, workspaceId, viewer, id);
  await purgeIssues(prisma, storage, [id]);
  return {
    type,
    id,
    name: issue.title,
    key: `${issue.project.identifier}-${issue.sequence_id}`,
    project_id: issue.project.id,
  };
}

export interface ExpiredPurge {
  workspace_id: string;
  type: TrashType;
  id: string;
  /** `ACCR-12 Title` / `Name (ACCR)` — the audit entry keeps it after the row is gone. */
  title: string;
}

/**
 * The scheduler's pass: everything deleted more than TRASH_RETENTION_DAYS ago is
 * removed for good. Returns what was removed (for the audit log).
 */
export async function purgeExpiredTrash(
  prisma: PrismaClient,
  storage: StorageDriver,
  now = new Date(),
): Promise<ExpiredPurge[]> {
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY_MS);
  const removed: ExpiredPurge[] = [];

  const projects = await prisma.project.findMany({
    where: { deleted_at: { lt: cutoff } },
    select: { id: true, workspace_id: true, name: true, identifier: true },
  });
  for (const p of projects) {
    await purgeProject(prisma, storage, p.id);
    removed.push({
      workspace_id: p.workspace_id,
      type: 'project',
      id: p.id,
      title: `${p.name} (${p.identifier})`,
    });
  }

  const issues = await prisma.issue.findMany({
    where: { deleted_at: { lt: cutoff } },
    select: {
      id: true,
      workspace_id: true,
      title: true,
      sequence_id: true,
      project: { select: { identifier: true } },
    },
  });
  if (issues.length > 0) {
    await purgeIssues(
      prisma,
      storage,
      issues.map((i) => i.id),
    );
  }
  for (const i of issues) {
    removed.push({
      workspace_id: i.workspace_id,
      type: 'issue',
      id: i.id,
      title: `${i.project.identifier}-${i.sequence_id} ${i.title}`,
    });
  }
  return removed;
}
