import type { FastifyRequest, FastifyReply } from 'fastify';
import * as moduleService from './service.js';
import {
  CreateModuleBodySchema,
  UpdateModuleBodySchema,
  AddIssuesToModuleBodySchema,
} from './schema.js';

export async function listModulesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId } = request.params as { projectId: string };
  const modules = await moduleService.listModules(
    request.server.prisma,
    request.workspace.id,
    projectId,
  );
  reply.send(modules);
}

export async function createModuleHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId } = request.params as { projectId: string };
  const body = CreateModuleBodySchema.parse(request.body);
  const mod = await moduleService.createModule(
    request.server.prisma,
    request.workspace.id,
    projectId,
    body,
  );
  reply.code(201).send(mod);
}

export async function getModuleHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId, moduleId } = request.params as { projectId: string; moduleId: string };
  const mod = await moduleService.getModule(
    request.server.prisma,
    request.workspace.id,
    projectId,
    moduleId,
  );
  reply.send(mod);
}

export async function updateModuleHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId, moduleId } = request.params as { projectId: string; moduleId: string };
  const body = UpdateModuleBodySchema.parse(request.body);
  const mod = await moduleService.updateModule(
    request.server.prisma,
    request.workspace.id,
    projectId,
    moduleId,
    body,
  );
  reply.send(mod);
}

export async function deleteModuleHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId, moduleId } = request.params as { projectId: string; moduleId: string };
  await moduleService.deleteModule(
    request.server.prisma,
    request.workspace.id,
    projectId,
    moduleId,
    request.userId,
  );
  reply.code(204).send();
}

export async function addIssuesToModuleHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId, moduleId } = request.params as { projectId: string; moduleId: string };
  const body = AddIssuesToModuleBodySchema.parse(request.body);
  const result = await moduleService.addIssuesToModule(
    request.server.prisma,
    request.workspace.id,
    projectId,
    moduleId,
    body.issue_ids,
    request.userId,
  );
  reply.send(result);
}

export async function removeIssueFromModuleHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId, moduleId, issueId } = request.params as {
    projectId: string;
    moduleId: string;
    issueId: string;
  };
  await moduleService.removeIssueFromModule(
    request.server.prisma,
    request.workspace.id,
    projectId,
    moduleId,
    issueId,
    request.userId,
  );
  reply.code(204).send();
}
