import type { Prisma, PrismaClient, ProjectMember, WorkspaceMember } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { seesAllProjects } from '../../plugins/workspace-hook.js';
import type {
  CreateProjectBody,
  UpdateProjectBody,
  AddProjectMemberBody,
  ListProjectsQuery,
} from './schema.js';

/** Default workflow states seeded for every new project (Russian — the primary locale). */
export const DEFAULT_STATES = [
  { name: 'Бэклог', color: '#6B7280', group: 'backlog' as const, order: 0 },
  { name: 'К выполнению', color: '#374151', group: 'unstarted' as const, order: 1, is_default: true },
  { name: 'В работе', color: '#3B82F6', group: 'started' as const, order: 2 },
  { name: 'На проверке', color: '#8B5CF6', group: 'review' as const, order: 3 },
  { name: 'Готово', color: '#10B981', group: 'completed' as const, order: 4 },
  { name: 'Отменено', color: '#EF4444', group: 'cancelled' as const, order: 5 },
];

const USER_BRIEF = { id: true, email: true, display_name: true, avatar_url: true } as const;

const PROJECT_INCLUDE = {
  lead: { select: USER_BRIEF },
  department: { select: { id: true, name: true, short_name: true } },
  _count: {
    select: {
      members: true,
      issues: { where: { deleted_at: null } },
    },
  },
} satisfies Prisma.ProjectInclude;

type ProjectWithRelations = Prisma.ProjectGetPayload<{ include: typeof PROJECT_INCLUDE }>;

export type ProjectView = Omit<ProjectWithRelations, '_count'> & {
  stats: { members: number; issues: number; open_issues: number };
};

/** Open (not completed/cancelled) issue counts per project, in one query. */
async function openIssueCounts(
  prisma: PrismaClient,
  projectIds: string[],
): Promise<Map<string, number>> {
  if (projectIds.length === 0) return new Map();
  const rows = await prisma.issue.groupBy({
    by: ['project_id'],
    where: {
      project_id: { in: projectIds },
      deleted_at: null,
      state: { group: { notIn: ['completed', 'cancelled'] } },
    },
    _count: { id: true },
  });
  return new Map(rows.map((r) => [r.project_id, r._count.id]));
}

function toView(project: ProjectWithRelations, openIssues: number): ProjectView {
  const { _count, ...rest } = project;
  return {
    ...rest,
    stats: { members: _count.members, issues: _count.issues, open_issues: openIssues },
  };
}

/** A department referenced by a project must belong to the same workspace. */
async function assertDepartment(
  prisma: PrismaClient,
  workspaceId: string,
  departmentId: string,
): Promise<void> {
  const department = await prisma.department.findFirst({
    where: { id: departmentId, workspace_id: workspaceId },
  });
  if (!department) throw AppError.badRequest('department_id does not belong to this workspace');
}

export async function listProjects(
  prisma: PrismaClient,
  workspaceId: string,
  viewer: WorkspaceMember,
  query: ListProjectsQuery = {},
): Promise<ProjectView[]> {
  const projects = await prisma.project.findMany({
    where: {
      workspace_id: workspaceId,
      deleted_at: null,
      ...(query.status && { status: query.status }),
      ...(query.department && { department_id: query.department }),
      // Private projects: only for their members, unless the viewer is admin+.
      ...(!seesAllProjects(viewer) && {
        OR: [
          { visibility: 'public' as const },
          { members: { some: { user_id: viewer.user_id } } },
        ],
      }),
    },
    include: PROJECT_INCLUDE,
    orderBy: { created_at: 'asc' },
  });
  const open = await openIssueCounts(
    prisma,
    projects.map((p) => p.id),
  );
  return projects.map((p) => toView(p, open.get(p.id) ?? 0));
}

export async function createProject(
  prisma: PrismaClient,
  workspaceId: string,
  creatorId: string,
  body: CreateProjectBody,
): Promise<ProjectView> {
  const conflict = await prisma.project.findUnique({
    where: { workspace_id_identifier: { workspace_id: workspaceId, identifier: body.identifier } },
  });
  if (conflict) {
    throw AppError.conflict(
      `Project identifier "${body.identifier}" is already used in this workspace`,
    );
  }

  if (body.lead_id) {
    const leadMember = await prisma.workspaceMember.findUnique({
      where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: body.lead_id } },
    });
    if (!leadMember) throw AppError.badRequest('Project lead must be a workspace member');
  }
  if (body.department_id) await assertDepartment(prisma, workspaceId, body.department_id);

  // Extra members must already be in the workspace; the creator is added as admin.
  const memberIds = [...new Set(body.member_ids ?? [])].filter((id) => id !== creatorId);
  if (memberIds.length > 0) {
    const found = await prisma.workspaceMember.count({
      where: { workspace_id: workspaceId, user_id: { in: memberIds } },
    });
    if (found !== memberIds.length) {
      throw AppError.badRequest('All member_ids must be members of this workspace');
    }
  }

  const created = await prisma.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        workspace_id: workspaceId,
        name: body.name,
        identifier: body.identifier,
        description: body.description,
        lead_id: body.lead_id ?? null,
        visibility: body.visibility ?? 'public',
        status: body.status ?? 'active',
        start_date: body.start_date ? new Date(body.start_date) : null,
        target_date: body.target_date ? new Date(body.target_date) : null,
        department_id: body.department_id ?? null,
        icon: body.icon ?? null,
        color: body.color ?? null,
      },
    });

    // Seed default states.
    await tx.state.createMany({
      data: DEFAULT_STATES.map((s) => ({ ...s, project_id: project.id })),
    });

    // Add the creator as project admin, plus any requested members.
    await tx.projectMember.createMany({
      data: [
        { project_id: project.id, user_id: creatorId, role: 'admin' as const },
        ...memberIds.map((uid) => ({ project_id: project.id, user_id: uid })),
      ],
    });

    return project;
  });

  return getProjectView(prisma, workspaceId, created.id);
}

/** A project with lead, department and counters — the standard response shape. */
export async function getProjectView(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
): Promise<ProjectView> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspace_id: workspaceId, deleted_at: null },
    include: PROJECT_INCLUDE,
  });
  if (!project) throw AppError.notFound('Project not found');
  const open = await openIssueCounts(prisma, [project.id]);
  return toView(project, open.get(project.id) ?? 0);
}

// Visibility (private projects) is enforced by the workspace hook for every
// `/projects/:projectId` route before this runs.
export async function getProject(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
): Promise<ProjectView> {
  return getProjectView(prisma, workspaceId, projectId);
}

export async function updateProject(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  body: UpdateProjectBody,
): Promise<ProjectView> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspace_id: workspaceId, deleted_at: null },
  });
  if (!project) throw AppError.notFound('Project not found');

  if (body.lead_id) {
    const leadMember = await prisma.workspaceMember.findUnique({
      where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: body.lead_id } },
    });
    if (!leadMember) throw AppError.badRequest('Project lead must be a workspace member');
  }
  if (body.department_id) await assertDepartment(prisma, workspaceId, body.department_id);

  const dateField = (v: string | null | undefined) =>
    v === undefined ? undefined : v ? new Date(v) : null;

  await prisma.project.update({
    where: { id: projectId },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.lead_id !== undefined && { lead_id: body.lead_id }),
      ...(body.is_archived !== undefined && { is_archived: body.is_archived }),
      ...(body.visibility !== undefined && { visibility: body.visibility }),
      ...(body.status !== undefined && { status: body.status }),
      ...(body.start_date !== undefined && { start_date: dateField(body.start_date) }),
      ...(body.target_date !== undefined && { target_date: dateField(body.target_date) }),
      ...(body.department_id !== undefined && { department_id: body.department_id }),
      ...(body.icon !== undefined && { icon: body.icon }),
      ...(body.color !== undefined && { color: body.color }),
    },
  });
  return getProjectView(prisma, workspaceId, projectId);
}

export async function deleteProject(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
): Promise<void> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspace_id: workspaceId, deleted_at: null },
  });
  if (!project) throw AppError.notFound('Project not found');
  // Soft delete: the project goes to the trash (restorable for 30 days, ADR-017).
  await prisma.project.update({ where: { id: projectId }, data: { deleted_at: new Date() } });
}

// ─── Project members ──────────────────────────────────────────────────────────

export async function listProjectMembers(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
): Promise<ProjectMember[]> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspace_id: workspaceId },
  });
  if (!project) throw AppError.notFound('Project not found');

  return prisma.projectMember.findMany({
    where: { project_id: projectId },
    include: { user: { select: { id: true, email: true, display_name: true, avatar_url: true } } },
    orderBy: { created_at: 'asc' },
  });
}

export async function addProjectMember(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  body: AddProjectMemberBody,
): Promise<ProjectMember> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspace_id: workspaceId },
  });
  if (!project) throw AppError.notFound('Project not found');

  // The user must already be a workspace member.
  const wsMember = await prisma.workspaceMember.findUnique({
    where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: body.user_id } },
  });
  if (!wsMember)
    throw AppError.badRequest('User must be a workspace member before joining a project');

  const existing = await prisma.projectMember.findUnique({
    where: { project_id_user_id: { project_id: projectId, user_id: body.user_id } },
  });
  if (existing) throw AppError.conflict('User is already a member of this project');

  return prisma.projectMember.create({
    data: { project_id: projectId, user_id: body.user_id, role: body.role },
    include: { user: { select: { id: true, email: true, display_name: true, avatar_url: true } } },
  });
}

export async function removeProjectMember(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  targetUserId: string,
): Promise<void> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspace_id: workspaceId },
  });
  if (!project) throw AppError.notFound('Project not found');

  const member = await prisma.projectMember.findUnique({
    where: { project_id_user_id: { project_id: projectId, user_id: targetUserId } },
  });
  if (!member) throw AppError.notFound('Member not found in this project');

  await prisma.projectMember.delete({
    where: { project_id_user_id: { project_id: projectId, user_id: targetUserId } },
  });
}
