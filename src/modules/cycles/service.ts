import type { PrismaClient, Cycle } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import type { CreateCycleBody, UpdateCycleBody } from './schema.js';

type CycleStatus = 'upcoming' | 'active' | 'completed';

export type CycleWithStatus = Cycle & { status: CycleStatus };

export interface CycleProgress {
  total: number;
  backlog: number;
  unstarted: number;
  started: number;
  review: number;
  completed: number;
  cancelled: number;
  completion_percentage: number;
}

export type CycleDetail = CycleWithStatus & { progress: CycleProgress };

function computeStatus(startDate: Date | null, endDate: Date | null): CycleStatus {
  const now = new Date();
  if (endDate && endDate < now) return 'completed';
  if (startDate && startDate > now) return 'upcoming';
  return 'active';
}

function withStatus(cycle: Cycle): CycleWithStatus {
  return { ...cycle, status: computeStatus(cycle.start_date, cycle.end_date) };
}

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

async function resolveCycle(
  prisma: PrismaClient,
  workspaceId: string,
  cycleId: string,
): Promise<Cycle> {
  const cycle = await prisma.cycle.findFirst({
    where: { id: cycleId, workspace_id: workspaceId },
  });
  if (!cycle) throw AppError.notFound('Cycle not found');
  return cycle;
}

export async function listCycles(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
): Promise<CycleWithStatus[]> {
  await resolveProject(prisma, workspaceId, projectId);
  const cycles = await prisma.cycle.findMany({
    where: { project_id: projectId },
    orderBy: { created_at: 'asc' },
  });
  return cycles.map(withStatus);
}

export async function createCycle(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  body: CreateCycleBody,
): Promise<CycleWithStatus> {
  await resolveProject(prisma, workspaceId, projectId);
  const cycle = await prisma.cycle.create({
    data: {
      workspace_id: workspaceId,
      project_id: projectId,
      name: body.name,
      description: body.description ?? null,
      start_date: body.start_date ? new Date(body.start_date) : null,
      end_date: body.end_date ? new Date(body.end_date) : null,
    },
  });
  return withStatus(cycle);
}

export async function getCycle(
  prisma: PrismaClient,
  workspaceId: string,
  cycleId: string,
): Promise<CycleDetail> {
  const cycle = await resolveCycle(prisma, workspaceId, cycleId);

  // Aggregate issue counts by state group in a single query.
  const groupCounts = await prisma.issue.groupBy({
    by: ['state_id'],
    where: { cycle_id: cycleId, deleted_at: null },
    _count: { id: true },
  });

  // Fetch state groups for the counted state IDs.
  const stateIds = groupCounts.map((g) => g.state_id);
  const states = await prisma.state.findMany({
    where: { id: { in: stateIds } },
    select: { id: true, group: true },
  });
  const stateGroupMap = new Map(states.map((s) => [s.id, s.group]));

  const progress: CycleProgress = {
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

  return { ...withStatus(cycle), progress };
}

export async function updateCycle(
  prisma: PrismaClient,
  workspaceId: string,
  cycleId: string,
  body: UpdateCycleBody,
): Promise<CycleWithStatus> {
  await resolveCycle(prisma, workspaceId, cycleId);
  const updated = await prisma.cycle.update({
    where: { id: cycleId },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.start_date !== undefined && {
        start_date: body.start_date ? new Date(body.start_date) : null,
      }),
      ...(body.end_date !== undefined && {
        end_date: body.end_date ? new Date(body.end_date) : null,
      }),
    },
  });
  return withStatus(updated);
}

export async function deleteCycle(
  prisma: PrismaClient,
  workspaceId: string,
  cycleId: string,
): Promise<void> {
  await resolveCycle(prisma, workspaceId, cycleId);
  // Issues' cycle_id will be set to null via onDelete: SetNull in the schema.
  await prisma.cycle.delete({ where: { id: cycleId } });
}

export async function addIssuesToCycle(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  cycleId: string,
  issueIds: string[],
): Promise<{ added: number }> {
  const cycle = await resolveCycle(prisma, workspaceId, cycleId);
  if (cycle.project_id !== projectId) throw AppError.notFound('Cycle not found');

  // Validate all issues belong to this project and are not deleted.
  const issues = await prisma.issue.findMany({
    where: { id: { in: issueIds }, project_id: projectId, deleted_at: null },
    select: { id: true },
  });

  if (issues.length !== issueIds.length) {
    throw AppError.badRequest('One or more issues not found in this project');
  }

  const result = await prisma.issue.updateMany({
    where: { id: { in: issueIds }, project_id: projectId },
    data: { cycle_id: cycleId },
  });

  return { added: result.count };
}

export async function removeIssueFromCycle(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  cycleId: string,
  issueId: string,
): Promise<void> {
  const cycle = await resolveCycle(prisma, workspaceId, cycleId);
  if (cycle.project_id !== projectId) throw AppError.notFound('Cycle not found');

  const issue = await prisma.issue.findFirst({
    where: { id: issueId, project_id: projectId, cycle_id: cycleId, deleted_at: null },
  });
  if (!issue) throw AppError.notFound('Issue not found in this cycle');

  await prisma.issue.update({ where: { id: issueId }, data: { cycle_id: null } });
}
