// Workspace-wide issue scoping shared by the workspace issue list (7.B1), the
// analytics module (Ф10) and the "my work" counters: which issues a member may
// see, and which issues belong to a department.
//
// An issue belongs to a department when it is addressed to it (a distribution
// child, 6.B1) or, otherwise, when its primary assignee (ответственный) sits in
// that department. Filters take a department "with its subtree": a faculty
// includes its chairs.

import type { Prisma, PrismaClient, WorkspaceMember } from '@prisma/client';
import { seesAllProjects } from '../../plugins/workspace-hook.js';

/** Issues of the workspace the member may see: not deleted, project not deleted, private projects only for their members and admins. */
export function visibleIssuesWhere(
  workspaceId: string,
  member: Pick<WorkspaceMember, 'user_id' | 'role'>,
): Prisma.IssueWhereInput {
  return {
    workspace_id: workspaceId,
    deleted_at: null,
    project: {
      deleted_at: null,
      ...(!seesAllProjects(member as WorkspaceMember) && {
        OR: [{ visibility: 'public' }, { members: { some: { user_id: member.user_id } } }],
      }),
    },
  };
}

/** Issues addressed to one of `departmentIds`, or whose primary assignee works there. */
export function inDepartmentsWhere(
  workspaceId: string,
  departmentIds: string[],
): Prisma.IssueWhereInput {
  return {
    OR: [
      { department_id: { in: departmentIds } },
      {
        department_id: null,
        assignees: {
          some: {
            is_primary: true,
            user: {
              workspace_memberships: {
                some: { workspace_id: workspaceId, department_id: { in: departmentIds } },
              },
            },
          },
        },
      },
    ],
  };
}

/** The given departments plus all their descendants (one query for the whole tree). Unknown ids are dropped. */
export async function expandDepartments(
  prisma: PrismaClient,
  workspaceId: string,
  departmentIds: string[],
): Promise<string[]> {
  const all = await prisma.department.findMany({
    where: { workspace_id: workspaceId },
    select: { id: true, parent_id: true },
  });
  const known = new Set(all.map((d) => d.id));
  const childrenOf = new Map<string, string[]>();
  for (const d of all) {
    if (d.parent_id) childrenOf.set(d.parent_id, [...(childrenOf.get(d.parent_id) ?? []), d.id]);
  }
  const result = new Set<string>();
  const stack = departmentIds.filter((id) => known.has(id));
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    stack.push(...(childrenOf.get(id) ?? []));
  }
  return [...result];
}
