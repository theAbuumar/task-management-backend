import type { PrismaClient, State, StateGroup } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { recordActivities, ACTIVITY_ACTIONS } from '../../lib/activity.js';
import type {
  CreateStateBody,
  UpdateStateBody,
  DeleteStateBody,
  ReorderStatesBody,
} from './schema.js';

// Rules of a project's workflow (ADR-031): every group keeps at least one state
// (handing in needs «review», acceptance «completed», distribution «unstarted»,
// analytics all of them) and exactly one state is the default — where new issues land.

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

function lastInGroup(group: StateGroup): AppError {
  return new AppError(
    409,
    'LAST_STATE_IN_GROUP',
    'This is the last state of its group; every group keeps at least one state',
    { group },
  );
}

async function assertGroupKeepsAState(prisma: PrismaClient, state: State): Promise<void> {
  const others = await prisma.state.count({
    where: { project_id: state.project_id, group: state.group, id: { not: state.id } },
  });
  if (others === 0) throw lastInGroup(state.group);
}

export async function listStates(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
): Promise<State[]> {
  await resolveProject(prisma, workspaceId, projectId);
  return prisma.state.findMany({
    where: { project_id: projectId },
    orderBy: [{ order: 'asc' }, { created_at: 'asc' }],
  });
}

export async function createState(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  body: CreateStateBody,
): Promise<State> {
  await resolveProject(prisma, workspaceId, projectId);

  return prisma.$transaction(async (tx) => {
    // One default per project: a new default replaces the old one.
    if (body.is_default) {
      await tx.state.updateMany({
        where: { project_id: projectId, is_default: true },
        data: { is_default: false },
      });
    }
    return tx.state.create({ data: { ...body, project_id: projectId } });
  });
}

export async function updateState(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  stateId: string,
  body: UpdateStateBody,
): Promise<State> {
  await resolveProject(prisma, workspaceId, projectId);

  const state = await prisma.state.findFirst({
    where: { id: stateId, project_id: projectId },
  });
  if (!state) throw AppError.notFound('State not found');

  if (body.is_default === false && state.is_default) {
    throw new AppError(
      409,
      'DEFAULT_STATE',
      'Make another state the default instead of unsetting this one',
    );
  }
  if (body.group !== undefined && body.group !== state.group) {
    await assertGroupKeepsAState(prisma, state);
  }

  return prisma.$transaction(async (tx) => {
    if (body.is_default && !state.is_default) {
      await tx.state.updateMany({
        where: { project_id: projectId, is_default: true, id: { not: stateId } },
        data: { is_default: false },
      });
    }
    return tx.state.update({
      where: { id: stateId },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.color !== undefined && { color: body.color }),
        ...(body.group !== undefined && { group: body.group }),
        ...(body.order !== undefined && { order: body.order }),
        ...(body.is_default !== undefined && { is_default: body.is_default }),
      },
    });
  });
}

/** Columns in a new order: `state_ids` is every state of the project once. */
export async function reorderStates(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  body: ReorderStatesBody,
): Promise<State[]> {
  await resolveProject(prisma, workspaceId, projectId);
  const states = await prisma.state.findMany({
    where: { project_id: projectId },
    select: { id: true },
  });
  const ids = new Set(states.map((s) => s.id));
  const given = new Set(body.state_ids);
  if (given.size !== body.state_ids.length || given.size !== ids.size) {
    throw AppError.badRequest('state_ids must list every state of the project once');
  }
  for (const id of given) {
    if (!ids.has(id))
      throw AppError.badRequest('state_ids must list every state of the project once');
  }

  await prisma.$transaction(
    body.state_ids.map((id, order) => prisma.state.update({ where: { id }, data: { order } })),
  );
  return listStates(prisma, workspaceId, projectId);
}

export async function deleteState(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  stateId: string,
  actorId: string,
  body: DeleteStateBody,
): Promise<void> {
  await resolveProject(prisma, workspaceId, projectId);

  const state = await prisma.state.findFirst({
    where: { id: stateId, project_id: projectId },
  });
  if (!state) throw AppError.notFound('State not found');
  if (state.is_default) {
    throw new AppError(
      409,
      'DEFAULT_STATE',
      'The default state cannot be deleted — make another state the default first',
    );
  }
  await assertGroupKeepsAState(prisma, state);

  let targetStateId = body.transfer_to_state_id;
  if (targetStateId) {
    if (targetStateId === stateId) {
      throw AppError.badRequest('transfer_to_state_id must be another state');
    }
    const target = await prisma.state.findFirst({
      where: { id: targetStateId, project_id: projectId },
    });
    if (!target) throw AppError.badRequest('transfer_to_state_id does not belong to this project');
  } else {
    const fallback = await prisma.state.findFirst({
      where: { project_id: projectId, is_default: true },
      select: { id: true },
    });
    if (!fallback) {
      throw AppError.conflict(
        'The project has no default state to move the issues into. Provide transfer_to_state_id.',
      );
    }
    targetStateId = fallback.id;
  }
  const target = await prisma.state.findUniqueOrThrow({ where: { id: targetStateId } });

  // Every issue of the state — trashed ones too, or the foreign key would block
  // the delete — moves to the target, and its history says so.
  const issues = await prisma.issue.findMany({
    where: { state_id: stateId },
    select: { id: true },
  });

  await prisma.$transaction(async (tx) => {
    if (issues.length > 0) {
      // `completed_at` follows the new state, as when an issue is moved by hand.
      if (target.group === 'completed') {
        await tx.issue.updateMany({
          where: { state_id: stateId, completed_at: null },
          data: { completed_at: new Date() },
        });
        await tx.issue.updateMany({ where: { state_id: stateId }, data: { state_id: target.id } });
      } else {
        await tx.issue.updateMany({
          where: { state_id: stateId },
          data: { state_id: target.id, completed_at: null },
        });
      }
      await recordActivities(
        tx,
        issues.map((i) => ({
          workspace_id: workspaceId,
          issue_id: i.id,
          actor_id: actorId,
          action: ACTIVITY_ACTIONS.ISSUE_UPDATED,
          field: 'state_id',
          old_value: stateId,
          new_value: target.id,
        })),
      );
    }

    await tx.state.delete({ where: { id: stateId } });
  });
}
