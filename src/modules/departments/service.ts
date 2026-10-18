// Org structure: a tree of departments per workspace (ADR-007). Access rights stay
// on WorkspaceMember.role; a department only says where a person sits and who heads
// it (used for escalations, analytics roll-ups and "распределить по подразделениям").

import type { Department, PrismaClient } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import type { CreateDepartmentBody, UpdateDepartmentBody } from './schema.js';

const HEAD_SELECT = {
  id: true,
  email: true,
  display_name: true,
  last_name: true,
  first_name: true,
  middle_name: true,
  avatar_url: true,
} as const;

export type DepartmentView = Department & {
  head: {
    id: string;
    email: string | null;
    display_name: string;
    last_name: string | null;
    first_name: string | null;
    middle_name: string | null;
    avatar_url: string | null;
  } | null;
  members_count: number;
};

export type DepartmentNode = DepartmentView & { children: DepartmentNode[] };

async function findDepartment(
  prisma: PrismaClient,
  workspaceId: string,
  departmentId: string,
): Promise<Department> {
  const department = await prisma.department.findFirst({
    where: { id: departmentId, workspace_id: workspaceId },
  });
  if (!department) throw AppError.notFound('Department not found');
  return department;
}

/** The head of a department must be a member of the workspace with access (12.B7). */
async function assertMember(prisma: PrismaClient, workspaceId: string, userId: string) {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: userId } },
  });
  if (!member) throw AppError.badRequest('head_id must be a member of this workspace');
  if (member.deactivated_at) {
    throw new AppError(
      400,
      'MEMBER_DEACTIVATED',
      "head_id: this member's access to the workspace is turned off",
    );
  }
}

/** All departments of the workspace with head + member count, ordered for display. */
export async function listDepartments(
  prisma: PrismaClient,
  workspaceId: string,
): Promise<DepartmentView[]> {
  const rows = await prisma.department.findMany({
    where: { workspace_id: workspaceId },
    include: { head: { select: HEAD_SELECT }, _count: { select: { members: true } } },
    orderBy: [{ order: 'asc' }, { name: 'asc' }],
  });
  return rows.map(({ _count, ...d }) => ({ ...d, members_count: _count.members }));
}

/** Nest a flat, ordered list into roots with `children`. */
export function buildTree(departments: DepartmentView[]): DepartmentNode[] {
  const nodes = new Map<string, DepartmentNode>(
    departments.map((d) => [d.id, { ...d, children: [] }]),
  );
  const roots: DepartmentNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parent_id ? nodes.get(node.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** `departmentId` plus every descendant id (for "this department and below" filters). */
export async function departmentSubtreeIds(
  prisma: PrismaClient,
  workspaceId: string,
  departmentId: string,
): Promise<string[]> {
  const all = await prisma.department.findMany({
    where: { workspace_id: workspaceId },
    select: { id: true, parent_id: true },
  });
  const childrenOf = new Map<string, string[]>();
  for (const d of all) {
    if (!d.parent_id) continue;
    childrenOf.set(d.parent_id, [...(childrenOf.get(d.parent_id) ?? []), d.id]);
  }
  const result: string[] = [];
  const stack = [departmentId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    result.push(id);
    stack.push(...(childrenOf.get(id) ?? []));
  }
  return result;
}

async function getView(
  prisma: PrismaClient,
  workspaceId: string,
  departmentId: string,
): Promise<DepartmentView> {
  const d = await prisma.department.findFirst({
    where: { id: departmentId, workspace_id: workspaceId },
    include: { head: { select: HEAD_SELECT }, _count: { select: { members: true } } },
  });
  if (!d) throw AppError.notFound('Department not found');
  const { _count, ...rest } = d;
  return { ...rest, members_count: _count.members };
}

export async function createDepartment(
  prisma: PrismaClient,
  workspaceId: string,
  body: CreateDepartmentBody,
): Promise<DepartmentView> {
  if (body.parent_id) await findDepartment(prisma, workspaceId, body.parent_id);
  if (body.head_id) await assertMember(prisma, workspaceId, body.head_id);

  // Without an explicit order the new department goes last among its siblings.
  const order =
    body.order ??
    (await prisma.department.count({
      where: { workspace_id: workspaceId, parent_id: body.parent_id ?? null },
    }));

  const created = await prisma.department.create({
    data: {
      workspace_id: workspaceId,
      name: body.name,
      short_name: body.short_name ?? null,
      parent_id: body.parent_id ?? null,
      head_id: body.head_id ?? null,
      order,
    },
  });
  return getView(prisma, workspaceId, created.id);
}

export async function updateDepartment(
  prisma: PrismaClient,
  workspaceId: string,
  departmentId: string,
  body: UpdateDepartmentBody,
): Promise<DepartmentView> {
  await findDepartment(prisma, workspaceId, departmentId);
  if (body.head_id) await assertMember(prisma, workspaceId, body.head_id);

  if (body.parent_id) {
    await findDepartment(prisma, workspaceId, body.parent_id);
    // Reject moving a department under itself or one of its descendants.
    const subtree = await departmentSubtreeIds(prisma, workspaceId, departmentId);
    if (subtree.includes(body.parent_id)) {
      throw new AppError(
        400,
        'DEPARTMENT_CYCLE',
        'A department cannot be moved under itself or its own sub-department',
      );
    }
  }

  await prisma.department.update({
    where: { id: departmentId },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.short_name !== undefined && { short_name: body.short_name }),
      ...(body.parent_id !== undefined && { parent_id: body.parent_id }),
      ...(body.head_id !== undefined && { head_id: body.head_id }),
      ...(body.order !== undefined && { order: body.order }),
    },
  });
  return getView(prisma, workspaceId, departmentId);
}

/**
 * Delete a department. Nothing is lost: its people, projects and sub-departments
 * move one level up (to the parent, or to the root/unassigned).
 */
export async function deleteDepartment(
  prisma: PrismaClient,
  workspaceId: string,
  departmentId: string,
): Promise<void> {
  const department = await findDepartment(prisma, workspaceId, departmentId);
  const parentId = department.parent_id;

  await prisma.$transaction([
    prisma.department.updateMany({
      where: { parent_id: departmentId },
      data: { parent_id: parentId },
    }),
    prisma.workspaceMember.updateMany({
      where: { department_id: departmentId },
      data: { department_id: parentId },
    }),
    prisma.project.updateMany({
      where: { department_id: departmentId },
      data: { department_id: parentId },
    }),
    prisma.department.delete({ where: { id: departmentId } }),
  ]);
}
