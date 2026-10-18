// Reading the audit log of a workspace (Ф12 12.B1). Writing lives in lib/audit
// and plugins/audit. Only admins and the owner read it (checked in the route by
// requireWorkspaceMember('admin') and again here — services own authorization).
//
// A workspace's log = its own entries + sign-ins/sign-outs, ended sessions and
// linked/unlinked login methods of its current members (those have no workspace). Names of actors and targets are resolved at
// read time; a deleted user keeps the name captured when the entry was written.

import type { Prisma, PrismaClient, WorkspaceMember } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';

export const AUDIT_GROUPS = {
  auth: [
    'auth.login',
    'auth.logout',
    'auth.session_revoked',
    'auth.sessions_revoked',
    'auth.identity_linked',
    'auth.identity_unlinked',
  ],
  members: [
    'member.added',
    'member.updated',
    'member.removed',
    'member.left',
    'invite.sent',
    'project.member_added',
    'project.member_removed',
  ],
  structure: [
    'department.created',
    'department.updated',
    'department.deleted',
    'project.created',
    'project.updated',
    'project.deleted',
  ],
  deletions: [
    'issue.deleted',
    'attachment.deleted',
    'project.deleted',
    'department.deleted',
    'member.removed',
    'workspace.deleted',
  ],
  exports: ['report.exported'],
  settings: ['workspace.updated', 'settings.control_updated'],
} as const;

export type AuditGroup = keyof typeof AUDIT_GROUPS;

export const AuditQuerySchema = z.object({
  group: z.enum(Object.keys(AUDIT_GROUPS) as [AuditGroup, ...AuditGroup[]]).optional(),
  action: z.string().max(64).optional(),
  actor_id: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

export interface AuditRow {
  id: string;
  created_at: Date;
  action: string;
  actor: { id: string; display_name: string } | null;
  target: { type: string; id: string | null; name: string | null } | null;
  meta: Prisma.JsonValue | null;
  ip: string | null;
  user_agent: string | null;
}

export async function listAudit(
  prisma: PrismaClient,
  workspaceId: string,
  viewer: Pick<WorkspaceMember, 'role'>,
  query: AuditQuery,
): Promise<{ data: AuditRow[]; next_cursor: string | null }> {
  if (viewer.role !== 'owner' && viewer.role !== 'admin') {
    throw AppError.forbidden('Only workspace admins can read the audit log');
  }
  const members = await prisma.workspaceMember.findMany({
    where: { workspace_id: workspaceId },
    select: { user_id: true },
  });
  const actions = query.action
    ? [query.action]
    : query.group
      ? [...AUDIT_GROUPS[query.group]]
      : null;
  const where: Prisma.AuditLogWhereInput = {
    OR: [
      { workspace_id: workspaceId },
      { workspace_id: null, actor_id: { in: members.map((m) => m.user_id) } },
    ],
    ...(actions && { action: { in: actions } }),
    ...(query.actor_id && { actor_id: query.actor_id }),
    ...((query.from || query.to) && {
      created_at: {
        ...(query.from && { gte: new Date(query.from) }),
        ...(query.to && { lt: new Date(query.to) }),
      },
    }),
  };

  const entries = await prisma.auditLog.findMany({
    where,
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
  });
  const hasMore = entries.length > query.limit;
  const page = hasMore ? entries.slice(0, query.limit) : entries;

  const names = await resolveNames(prisma, workspaceId, page);
  const data = page.map((e) => ({
    id: e.id,
    created_at: e.created_at,
    action: e.action,
    actor: e.actor_id
      ? { id: e.actor_id, display_name: names.user.get(e.actor_id) ?? e.actor_name ?? '—' }
      : null,
    target: e.target_type
      ? {
          type: e.target_type,
          id: e.target_id,
          name: e.target_id
            ? (names[e.target_type as keyof typeof names]?.get(e.target_id) ?? null)
            : null,
        }
      : null,
    meta: e.meta,
    ip: e.ip,
    user_agent: e.user_agent,
  }));
  return { data, next_cursor: hasMore ? (page[page.length - 1]?.id ?? null) : null };
}

/** Current names of the people, projects, departments and issues on a page. */
async function resolveNames(
  prisma: PrismaClient,
  workspaceId: string,
  entries: { actor_id: string | null; target_type: string | null; target_id: string | null }[],
) {
  const ids = (type: string) => [
    ...new Set(
      entries.filter((e) => e.target_type === type && e.target_id).map((e) => e.target_id!),
    ),
  ];
  const userIds = [
    ...new Set([
      ...entries.map((e) => e.actor_id).filter((x): x is string => Boolean(x)),
      ...ids('user'),
    ]),
  ];
  const [users, projects, departments, issues] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, display_name: true },
    }),
    prisma.project.findMany({
      where: { id: { in: ids('project') }, workspace_id: workspaceId },
      select: { id: true, name: true, identifier: true },
    }),
    prisma.department.findMany({
      where: { id: { in: ids('department') }, workspace_id: workspaceId },
      select: { id: true, name: true },
    }),
    prisma.issue.findMany({
      where: { id: { in: ids('issue') }, workspace_id: workspaceId },
      select: {
        id: true,
        title: true,
        sequence_id: true,
        project: { select: { identifier: true } },
      },
    }),
  ]);
  return {
    user: new Map(users.map((u) => [u.id, u.display_name])),
    project: new Map(projects.map((p) => [p.id, `${p.name} (${p.identifier})`])),
    department: new Map(departments.map((d) => [d.id, d.name])),
    issue: new Map(
      issues.map((i) => [i.id, `${i.project.identifier}-${i.sequence_id} ${i.title}`]),
    ),
  };
}
