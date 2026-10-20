import type { FastifyRequest, FastifyReply } from 'fastify';
import * as statesService from './service.js';
import {
  CreateStateBodySchema,
  UpdateStateBodySchema,
  DeleteStateBodySchema,
  ReorderStatesBodySchema,
} from './schema.js';

export async function listStatesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId } = request.params as { projectId: string };
  const states = await statesService.listStates(
    request.server.prisma,
    request.workspace.id,
    projectId,
  );
  reply.send(states);
}

export async function createStateHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId } = request.params as { projectId: string };
  const body = CreateStateBodySchema.parse(request.body);
  const state = await statesService.createState(
    request.server.prisma,
    request.workspace.id,
    projectId,
    body,
  );
  reply.code(201).send(state);
}

export async function updateStateHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId, stateId } = request.params as { projectId: string; stateId: string };
  const body = UpdateStateBodySchema.parse(request.body);
  const state = await statesService.updateState(
    request.server.prisma,
    request.workspace.id,
    projectId,
    stateId,
    body,
  );
  reply.send(state);
}

export async function deleteStateHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId, stateId } = request.params as { projectId: string; stateId: string };
  const body = DeleteStateBodySchema.parse({
    ...((request.body as object | undefined) ?? {}),
    ...(request.query as object),
  });
  await statesService.deleteState(
    request.server.prisma,
    request.workspace.id,
    projectId,
    stateId,
    request.userId,
    body,
  );
  reply.code(204).send();
}

export async function reorderStatesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId } = request.params as { projectId: string };
  const body = ReorderStatesBodySchema.parse(request.body);
  reply.send(
    await statesService.reorderStates(request.server.prisma, request.workspace.id, projectId, body),
  );
}
