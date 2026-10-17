import type { FastifyRequest, FastifyReply } from 'fastify';
import * as projectService from './service.js';
import {
  CreateProjectBodySchema,
  UpdateProjectBodySchema,
  AddProjectMemberBodySchema,
  ListProjectsQuerySchema,
} from './schema.js';

export async function listProjectsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const query = ListProjectsQuerySchema.parse(request.query ?? {});
  const projects = await projectService.listProjects(
    request.server.prisma,
    request.workspace.id,
    request.workspaceMember,
    query,
  );
  reply.send(projects);
}

export async function createProjectHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = CreateProjectBodySchema.parse(request.body);
  const project = await projectService.createProject(
    request.server.prisma,
    request.workspace.id,
    request.userId,
    body,
  );
  reply.code(201).send(project);
}

export async function getProjectHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId } = request.params as { projectId: string };
  const project = await projectService.getProject(
    request.server.prisma,
    request.workspace.id,
    projectId,
  );
  reply.send(project);
}

export async function updateProjectHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId } = request.params as { projectId: string };
  const body = UpdateProjectBodySchema.parse(request.body);
  const project = await projectService.updateProject(
    request.server.prisma,
    request.workspace.id,
    projectId,
    body,
  );
  reply.send(project);
}

export async function deleteProjectHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId } = request.params as { projectId: string };
  await projectService.deleteProject(request.server.prisma, request.workspace.id, projectId);
  reply.code(204).send();
}

export async function listProjectMembersHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId } = request.params as { projectId: string };
  const members = await projectService.listProjectMembers(
    request.server.prisma,
    request.workspace.id,
    projectId,
  );
  reply.send(members);
}

export async function addProjectMemberHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId } = request.params as { projectId: string };
  const body = AddProjectMemberBodySchema.parse(request.body);
  const member = await projectService.addProjectMember(
    request.server.prisma,
    request.workspace.id,
    projectId,
    body,
  );
  reply.code(201).send(member);
}

export async function removeProjectMemberHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId, userId } = request.params as { projectId: string; userId: string };
  await projectService.removeProjectMember(
    request.server.prisma,
    request.workspace.id,
    projectId,
    userId,
  );
  reply.code(204).send();
}
