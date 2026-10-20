import type { FastifyRequest, FastifyReply } from 'fastify';
import * as cycleService from './service.js';
import {
  CreateCycleBodySchema,
  UpdateCycleBodySchema,
  AddIssuesToCycleBodySchema,
} from './schema.js';

export async function listCyclesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId } = request.params as { projectId: string };
  const cycles = await cycleService.listCycles(
    request.server.prisma,
    request.workspace.id,
    projectId,
  );
  reply.send(cycles);
}

export async function createCycleHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId } = request.params as { projectId: string };
  const body = CreateCycleBodySchema.parse(request.body);
  const cycle = await cycleService.createCycle(
    request.server.prisma,
    request.workspace.id,
    projectId,
    body,
  );
  reply.code(201).send(cycle);
}

export async function getCycleHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { projectId, cycleId } = request.params as { projectId: string; cycleId: string };
  const cycle = await cycleService.getCycle(
    request.server.prisma,
    request.workspace.id,
    projectId,
    cycleId,
  );
  reply.send(cycle);
}

export async function updateCycleHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId, cycleId } = request.params as { projectId: string; cycleId: string };
  const body = UpdateCycleBodySchema.parse(request.body);
  const cycle = await cycleService.updateCycle(
    request.server.prisma,
    request.workspace.id,
    projectId,
    cycleId,
    body,
  );
  reply.send(cycle);
}

export async function deleteCycleHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId, cycleId } = request.params as { projectId: string; cycleId: string };
  await cycleService.deleteCycle(
    request.server.prisma,
    request.workspace.id,
    projectId,
    cycleId,
    request.userId,
  );
  reply.code(204).send();
}

export async function addIssuesToCycleHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId, cycleId } = request.params as { projectId: string; cycleId: string };
  const body = AddIssuesToCycleBodySchema.parse(request.body);
  const result = await cycleService.addIssuesToCycle(
    request.server.prisma,
    request.workspace.id,
    projectId,
    cycleId,
    body.issue_ids,
    request.userId,
  );
  reply.send(result);
}

export async function removeIssueFromCycleHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId, cycleId, issueId } = request.params as {
    projectId: string;
    cycleId: string;
    issueId: string;
  };
  await cycleService.removeIssueFromCycle(
    request.server.prisma,
    request.workspace.id,
    projectId,
    cycleId,
    issueId,
    request.userId,
  );
  reply.code(204).send();
}
