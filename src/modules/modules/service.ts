import type { PrismaClient, Module } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { recordActivities, ACTIVITY_ACTIONS } from '../../lib/activity.js';
import { moduleProgress, emptyProgress, type GroupProgress } from '../../lib/progress.js';
import { loadBurndown, type Burndown } from '../../lib/burndown.js';
import { assertAssignable } from '../issues/service.js';
import type { CreateModuleBody, UpdateModuleBody } from './schema.js';

// Модули (ADR-021, ADR-031): a lasting part of a project's work («Приёмная
// кампания», «Аккредитация») with a lead and a status. An issue may be in any
// number of modules; joining and leaving are recorded in the issue's history.

export type ModuleProgress = GroupProgress;

export type ModuleView = Module & { progress: ModuleProgress };

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

/** The module of this project — one of another project answers 404 (it may be private). */
async function resolveModule(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  moduleId: string,
): Promise<Module> {
  const mod = await prisma.module.findFirst({
    where: { id: moduleId, workspace_id: workspaceId, project_id: projectId },
  });
  if (!mod) throw AppError.notFound('Module not found');
  return mod;
}

function assertDates(start: Date | null, target: Date | null): void {
  if (start && target && target < start) {
    throw AppError.badRequest('target_date must not be before start_date');
  }
}

const toDate = (v: string | null | undefined) => (v ? new Date(v) : null);

async function views(prisma: PrismaClient, modules: Module[]): Promise<ModuleView[]> {
  const progress = await moduleProgress(
    prisma,
    modules.map((m) => m.id),
  );
  return modules.map((m) => ({ ...m, progress: progress.get(m.id) ?? emptyProgress() }));
}

export async function listModules(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
): Promise<ModuleView[]> {
  await resolveProject(prisma, workspaceId, projectId);
  const modules = await prisma.module.findMany({
    where: { project_id: projectId },
    orderBy: { created_at: 'asc' },
  });
  return views(prisma, modules);
}

export async function createModule(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  body: CreateModuleBody,
): Promise<ModuleView> {
  await resolveProject(prisma, workspaceId, projectId);
  // The lead is any member who can be assigned work (not a guest, not turned off).
  if (body.lead_id) await assertAssignable(prisma, workspaceId, [body.lead_id], 'lead_id');
  const start = toDate(body.start_date);
  const target = toDate(body.target_date);
  assertDates(start, target);

  const mod = await prisma.module.create({
    data: {
      workspace_id: workspaceId,
      project_id: projectId,
      name: body.name,
      description: body.description ?? null,
      status: body.status ?? 'backlog',
      lead_id: body.lead_id ?? null,
      start_date: start,
      target_date: target,
    },
  });
  return (await views(prisma, [mod]))[0]!;
}

export async function getModule(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  moduleId: string,
): Promise<ModuleView> {
  const mod = await resolveModule(prisma, workspaceId, projectId, moduleId);
  return (await views(prisma, [mod]))[0]!;
}

export async function updateModule(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  moduleId: string,
  body: UpdateModuleBody,
): Promise<ModuleView> {
  const mod = await resolveModule(prisma, workspaceId, projectId, moduleId);
  if (body.lead_id) await assertAssignable(prisma, workspaceId, [body.lead_id], 'lead_id');
  const start = body.start_date !== undefined ? toDate(body.start_date) : mod.start_date;
  const target = body.target_date !== undefined ? toDate(body.target_date) : mod.target_date;
  assertDates(start, target);

  const updated = await prisma.module.update({
    where: { id: moduleId },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.status !== undefined && { status: body.status }),
      ...(body.lead_id !== undefined && { lead_id: body.lead_id }),
      ...(body.start_date !== undefined && { start_date: start }),
      ...(body.target_date !== undefined && { target_date: target }),
    },
  });
  return (await views(prisma, [updated]))[0]!;
}

/** Burndown and burnup of the module, from its start to its target date (10.B7, ADR-032). */
export async function moduleBurndown(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  moduleId: string,
  now = new Date(),
): Promise<Burndown> {
  const mod = await resolveModule(prisma, workspaceId, projectId, moduleId);
  return loadBurndown(
    prisma,
    {
      kind: 'module',
      id: mod.id,
      name: mod.name,
      project_id: projectId,
      workspace_id: workspaceId,
      start: mod.start_date,
      end: mod.target_date,
      created_at: mod.created_at,
    },
    now,
  );
}

/** Delete a module (admin+, by route); its issues stay where they are. */
export async function deleteModule(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  moduleId: string,
  actorId: string,
): Promise<void> {
  await resolveModule(prisma, workspaceId, projectId, moduleId);
  const links = await prisma.moduleIssue.findMany({
    where: { module_id: moduleId, issue: { deleted_at: null } },
    select: { issue_id: true },
  });
  await prisma.$transaction(async (tx) => {
    // ModuleIssue rows cascade-delete via onDelete: Cascade on the FK.
    await tx.module.delete({ where: { id: moduleId } });
    await recordActivities(
      tx,
      links.map((l) => ({
        workspace_id: workspaceId,
        issue_id: l.issue_id,
        actor_id: actorId,
        action: ACTIVITY_ACTIONS.MODULE_REMOVED,
        old_value: moduleId,
      })),
    );
  });
}

export async function addIssuesToModule(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  moduleId: string,
  issueIds: string[],
  actorId: string,
): Promise<{ added: number }> {
  await resolveModule(prisma, workspaceId, projectId, moduleId);
  const ids = [...new Set(issueIds)];

  const issues = await prisma.issue.findMany({
    where: { id: { in: ids }, project_id: projectId, deleted_at: null },
    select: { id: true, modules: { where: { module_id: moduleId }, select: { module_id: true } } },
  });
  if (issues.length !== ids.length) {
    throw AppError.badRequest('One or more issues not found in this project');
  }

  // Re-adding an issue that is already in the module is a no-op.
  const joining = issues.filter((i) => i.modules.length === 0).map((i) => i.id);
  if (joining.length === 0) return { added: 0 };

  await prisma.$transaction(async (tx) => {
    await tx.moduleIssue.createMany({
      data: joining.map((issue_id) => ({ module_id: moduleId, issue_id })),
      skipDuplicates: true,
    });
    await recordActivities(
      tx,
      joining.map((issueId) => ({
        workspace_id: workspaceId,
        issue_id: issueId,
        actor_id: actorId,
        action: ACTIVITY_ACTIONS.MODULE_ADDED,
        new_value: moduleId,
      })),
    );
  });
  return { added: joining.length };
}

export async function removeIssueFromModule(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  moduleId: string,
  issueId: string,
  actorId: string,
): Promise<void> {
  await resolveModule(prisma, workspaceId, projectId, moduleId);

  const moduleIssue = await prisma.moduleIssue.findUnique({
    where: { module_id_issue_id: { module_id: moduleId, issue_id: issueId } },
  });
  if (!moduleIssue) throw AppError.notFound('Issue not found in this module');

  await prisma.$transaction(async (tx) => {
    await tx.moduleIssue.delete({
      where: { module_id_issue_id: { module_id: moduleId, issue_id: issueId } },
    });
    await recordActivities(tx, [
      {
        workspace_id: workspaceId,
        issue_id: issueId,
        actor_id: actorId,
        action: ACTIVITY_ACTIONS.MODULE_REMOVED,
        old_value: moduleId,
      },
    ]);
  });
}
