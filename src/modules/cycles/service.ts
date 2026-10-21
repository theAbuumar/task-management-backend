import type { PrismaClient, Cycle } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { recordActivities, ACTIVITY_ACTIONS } from '../../lib/activity.js';
import { cycleProgress, emptyProgress, type GroupProgress } from '../../lib/progress.js';
import { loadBurndown, type Burndown } from '../../lib/burndown.js';
import { localDate } from '../../lib/tz.js';
import type { CreateCycleBody, UpdateCycleBody } from './schema.js';

// Этапы (Cycles, ADR-021, ADR-031): a period of a project with its issues. An
// issue is in at most one cycle; adding it to another moves it. Every move is
// recorded in the issue's history (field `cycle_id`).

type CycleStatus = 'upcoming' | 'active' | 'completed';

export type CycleProgress = GroupProgress;

export type CycleView = Cycle & { status: CycleStatus; progress: CycleProgress };

/** Status by the dates as days of the workspace time zone (ADR-012): the end day counts. */
function computeStatus(cycle: Cycle, timeZone: string, now = new Date()): CycleStatus {
  const today = localDate(now, timeZone);
  if (cycle.end_date && localDate(cycle.end_date, timeZone) < today) return 'completed';
  if (cycle.start_date && localDate(cycle.start_date, timeZone) > today) return 'upcoming';
  return 'active';
}

async function workspaceZone(prisma: PrismaClient, workspaceId: string): Promise<string> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { timezone: true },
  });
  return ws?.timezone ?? 'UTC';
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

/** The cycle of this project — a cycle of another project answers 404 (its project may be private). */
async function resolveCycle(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  cycleId: string,
): Promise<Cycle> {
  const cycle = await prisma.cycle.findFirst({
    where: { id: cycleId, workspace_id: workspaceId, project_id: projectId },
  });
  if (!cycle) throw AppError.notFound('Cycle not found');
  return cycle;
}

function assertDates(start: Date | null, end: Date | null): void {
  if (start && end && end < start) {
    throw AppError.badRequest('end_date must not be before start_date');
  }
}

const toDate = (v: string | null | undefined) => (v ? new Date(v) : null);

async function views(
  prisma: PrismaClient,
  workspaceId: string,
  cycles: Cycle[],
): Promise<CycleView[]> {
  const [zone, progress] = await Promise.all([
    workspaceZone(prisma, workspaceId),
    cycleProgress(
      prisma,
      cycles.map((c) => c.id),
    ),
  ]);
  return cycles.map((c) => ({
    ...c,
    status: computeStatus(c, zone),
    progress: progress.get(c.id) ?? emptyProgress(),
  }));
}

export async function listCycles(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
): Promise<CycleView[]> {
  await resolveProject(prisma, workspaceId, projectId);
  const cycles = await prisma.cycle.findMany({
    where: { project_id: projectId },
    orderBy: [{ start_date: { sort: 'asc', nulls: 'last' } }, { created_at: 'asc' }],
  });
  return views(prisma, workspaceId, cycles);
}

export async function createCycle(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  body: CreateCycleBody,
): Promise<CycleView> {
  await resolveProject(prisma, workspaceId, projectId);
  const start = toDate(body.start_date);
  const end = toDate(body.end_date);
  assertDates(start, end);
  const cycle = await prisma.cycle.create({
    data: {
      workspace_id: workspaceId,
      project_id: projectId,
      name: body.name,
      description: body.description ?? null,
      start_date: start,
      end_date: end,
    },
  });
  return (await views(prisma, workspaceId, [cycle]))[0]!;
}

export async function getCycle(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  cycleId: string,
): Promise<CycleView> {
  const cycle = await resolveCycle(prisma, workspaceId, projectId, cycleId);
  return (await views(prisma, workspaceId, [cycle]))[0]!;
}

/** Burndown and burnup of the cycle by day (10.B7, ADR-032). */
export async function cycleBurndown(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  cycleId: string,
  now = new Date(),
): Promise<Burndown> {
  const cycle = await resolveCycle(prisma, workspaceId, projectId, cycleId);
  return loadBurndown(
    prisma,
    {
      kind: 'cycle',
      id: cycle.id,
      name: cycle.name,
      project_id: projectId,
      workspace_id: workspaceId,
      start: cycle.start_date,
      end: cycle.end_date,
      created_at: cycle.created_at,
    },
    now,
  );
}

export async function updateCycle(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  cycleId: string,
  body: UpdateCycleBody,
): Promise<CycleView> {
  const cycle = await resolveCycle(prisma, workspaceId, projectId, cycleId);
  const start = body.start_date !== undefined ? toDate(body.start_date) : cycle.start_date;
  const end = body.end_date !== undefined ? toDate(body.end_date) : cycle.end_date;
  assertDates(start, end);
  const updated = await prisma.cycle.update({
    where: { id: cycleId },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.start_date !== undefined && { start_date: start }),
      ...(body.end_date !== undefined && { end_date: end }),
    },
  });
  return (await views(prisma, workspaceId, [updated]))[0]!;
}

/** Delete a cycle (admin+, by route); its issues stay, out of any cycle. */
export async function deleteCycle(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  cycleId: string,
  actorId: string,
): Promise<void> {
  await resolveCycle(prisma, workspaceId, projectId, cycleId);
  const issues = await prisma.issue.findMany({
    where: { cycle_id: cycleId, deleted_at: null },
    select: { id: true },
  });
  await prisma.$transaction(async (tx) => {
    // Issues' cycle_id is set to null by onDelete: SetNull.
    await tx.cycle.delete({ where: { id: cycleId } });
    await recordActivities(
      tx,
      issues.map((i) => ({
        workspace_id: workspaceId,
        issue_id: i.id,
        actor_id: actorId,
        action: ACTIVITY_ACTIONS.ISSUE_UPDATED,
        field: 'cycle_id',
        old_value: cycleId,
        new_value: null,
      })),
    );
  });
}

export async function addIssuesToCycle(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  cycleId: string,
  issueIds: string[],
  actorId: string,
): Promise<{ added: number }> {
  await resolveCycle(prisma, workspaceId, projectId, cycleId);
  const ids = [...new Set(issueIds)];

  // Every issue must belong to this project and not be in the trash.
  const issues = await prisma.issue.findMany({
    where: { id: { in: ids }, project_id: projectId, deleted_at: null },
    select: { id: true, cycle_id: true },
  });
  if (issues.length !== ids.length) {
    throw AppError.badRequest('One or more issues not found in this project');
  }

  const moving = issues.filter((i) => i.cycle_id !== cycleId);
  if (moving.length === 0) return { added: 0 };

  await prisma.$transaction(async (tx) => {
    await tx.issue.updateMany({
      where: { id: { in: moving.map((i) => i.id) } },
      data: { cycle_id: cycleId },
    });
    await recordActivities(
      tx,
      moving.map((i) => ({
        workspace_id: workspaceId,
        issue_id: i.id,
        actor_id: actorId,
        action: ACTIVITY_ACTIONS.ISSUE_UPDATED,
        field: 'cycle_id',
        old_value: i.cycle_id,
        new_value: cycleId,
      })),
    );
  });
  return { added: moving.length };
}

export async function removeIssueFromCycle(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  cycleId: string,
  issueId: string,
  actorId: string,
): Promise<void> {
  await resolveCycle(prisma, workspaceId, projectId, cycleId);

  const issue = await prisma.issue.findFirst({
    where: { id: issueId, project_id: projectId, cycle_id: cycleId, deleted_at: null },
  });
  if (!issue) throw AppError.notFound('Issue not found in this cycle');

  await prisma.$transaction(async (tx) => {
    await tx.issue.update({ where: { id: issueId }, data: { cycle_id: null } });
    await recordActivities(tx, [
      {
        workspace_id: workspaceId,
        issue_id: issueId,
        actor_id: actorId,
        action: ACTIVITY_ACTIONS.ISSUE_UPDATED,
        field: 'cycle_id',
        old_value: cycleId,
        new_value: null,
      },
    ]);
  });
}
