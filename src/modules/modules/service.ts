import type { PrismaClient, Module } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import type { CreateModuleBody, UpdateModuleBody } from './schema.js';

export interface ModuleProgress {
  total: number;
  backlog: number;
  unstarted: number;
  started: number;
  review: number;
  completed: number;
  cancelled: number;
  completion_percentage: number;
}

export type ModuleDetail = Module & { progress: ModuleProgress };

async function resolveProject(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
): Promise<void> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspace_id: workspaceId },
  });
  if (!project) throw AppError.notFound('Project not found');
}

async function resolveModule(
  prisma: PrismaClient,
  workspaceId: string,
  moduleId: string,
): Promise<Module> {
  const mod = await prisma.module.findFirst({
    where: { id: moduleId, workspace_id: workspaceId },
  });
  if (!mod) throw AppError.notFound('Module not found');
  return mod;
}

export async function listModules(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
): Promise<Module[]> {
  await resolveProject(prisma, workspaceId, projectId);
  return prisma.module.findMany({
    where: { project_id: projectId },
    orderBy: { created_at: 'asc' },
  });
}

export async function createModule(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  body: CreateModuleBody,
): Promise<Module> {
  await resolveProject(prisma, workspaceId, projectId);

  if (body.lead_id) {
    const member = await prisma.projectMember.findUnique({
      where: { project_id_user_id: { project_id: projectId, user_id: body.lead_id } },
    });
    if (!member) throw AppError.badRequest('Lead must be a member of this project');
  }

  return prisma.module.create({
    data: {
      workspace_id: workspaceId,
      project_id: projectId,
      name: body.name,
      description: body.description ?? null,
      status: body.status ?? 'backlog',
      lead_id: body.lead_id ?? null,
      start_date: body.start_date ? new Date(body.start_date) : null,
      target_date: body.target_date ? new Date(body.target_date) : null,
    },
  });
}

export async function getModule(
  prisma: PrismaClient,
  workspaceId: string,
  moduleId: string,
): Promise<ModuleDetail> {
  const mod = await resolveModule(prisma, workspaceId, moduleId);

  const groupCounts = await prisma.issue.groupBy({
    by: ['state_id'],
    where: {
      modules: { some: { module_id: moduleId } },
      deleted_at: null,
    },
    _count: { id: true },
  });

  const stateIds = groupCounts.map((g) => g.state_id);
  const states = await prisma.state.findMany({
    where: { id: { in: stateIds } },
    select: { id: true, group: true },
  });
  const stateGroupMap = new Map(states.map((s) => [s.id, s.group]));

  const progress: ModuleProgress = {
    total: 0,
    backlog: 0,
    unstarted: 0,
    started: 0,
    review: 0,
    completed: 0,
    cancelled: 0,
    completion_percentage: 0,
  };

  for (const gc of groupCounts) {
    const count = gc._count.id;
    const group = stateGroupMap.get(gc.state_id);
    progress.total += count;
    if (group) progress[group] += count;
  }

  if (progress.total > 0) {
    progress.completion_percentage = Math.round(
      ((progress.completed + progress.cancelled) / progress.total) * 100,
    );
  }

  return { ...mod, progress };
}

export async function updateModule(
  prisma: PrismaClient,
  workspaceId: string,
  moduleId: string,
  body: UpdateModuleBody,
): Promise<Module> {
  const mod = await resolveModule(prisma, workspaceId, moduleId);

  if (body.lead_id) {
    const member = await prisma.projectMember.findUnique({
      where: { project_id_user_id: { project_id: mod.project_id, user_id: body.lead_id } },
    });
    if (!member) throw AppError.badRequest('Lead must be a member of this project');
  }

  return prisma.module.update({
    where: { id: moduleId },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.status !== undefined && { status: body.status }),
      ...(body.lead_id !== undefined && { lead_id: body.lead_id }),
      ...(body.start_date !== undefined && {
        start_date: body.start_date ? new Date(body.start_date) : null,
      }),
      ...(body.target_date !== undefined && {
        target_date: body.target_date ? new Date(body.target_date) : null,
      }),
    },
  });
}

export async function deleteModule(
  prisma: PrismaClient,
  workspaceId: string,
  moduleId: string,
): Promise<void> {
  await resolveModule(prisma, workspaceId, moduleId);
  // ModuleIssue rows cascade-delete via onDelete: Cascade on the FK.
  await prisma.module.delete({ where: { id: moduleId } });
}

export async function addIssuesToModule(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  moduleId: string,
  issueIds: string[],
): Promise<{ added: number }> {
  const mod = await resolveModule(prisma, workspaceId, moduleId);
  if (mod.project_id !== projectId) throw AppError.notFound('Module not found');

  const issues = await prisma.issue.findMany({
    where: { id: { in: issueIds }, project_id: projectId, deleted_at: null },
    select: { id: true },
  });

  if (issues.length !== issueIds.length) {
    throw AppError.badRequest('One or more issues not found in this project');
  }

  // createMany with skipDuplicates is idempotent — re-adding an existing issue is a no-op.
  const result = await prisma.moduleIssue.createMany({
    data: issueIds.map((issue_id) => ({ module_id: moduleId, issue_id })),
    skipDuplicates: true,
  });

  return { added: result.count };
}

export async function removeIssueFromModule(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  moduleId: string,
  issueId: string,
): Promise<void> {
  const mod = await resolveModule(prisma, workspaceId, moduleId);
  if (mod.project_id !== projectId) throw AppError.notFound('Module not found');

  const moduleIssue = await prisma.moduleIssue.findUnique({
    where: { module_id_issue_id: { module_id: moduleId, issue_id: issueId } },
  });
  if (!moduleIssue) throw AppError.notFound('Issue not found in this module');

  await prisma.moduleIssue.delete({
    where: { module_id_issue_id: { module_id: moduleId, issue_id: issueId } },
  });
}
