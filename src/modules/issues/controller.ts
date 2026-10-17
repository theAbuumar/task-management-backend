import type { FastifyRequest, FastifyReply } from 'fastify';
import * as issueService from './service.js';
import {
  CreateIssueBodySchema,
  UpdateIssueBodySchema,
  IssueFilterQuerySchema,
  AssigneeBodySchema,
  LabelAttachBodySchema,
} from './schema.js';

export async function listIssuesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId } = request.params as { projectId: string };
  const query = IssueFilterQuerySchema.parse(request.query);
  const result = await issueService.listIssues(
    request.server.prisma,
    request.workspace.id,
    projectId,
    query,
    { userId: request.userId, timeZone: request.workspace.timezone },
  );
  reply.send(result);
}

export async function createIssueHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId } = request.params as { projectId: string };
  const body = CreateIssueBodySchema.parse(request.body);
  const issue = await issueService.createIssue(
    request.server.prisma,
    request.workspace.id,
    projectId,
    request.userId,
    body,
  );
  reply.code(201).send(issue);
}

export async function getIssueHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { projectId, issueId } = request.params as { projectId: string; issueId: string };
  const issue = await issueService.getIssue(
    request.server.prisma,
    request.workspace.id,
    projectId,
    issueId,
  );
  reply.send(issue);
}

export async function updateIssueHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId, issueId } = request.params as { projectId: string; issueId: string };
  const body = UpdateIssueBodySchema.parse(request.body);
  const issue = await issueService.updateIssue(
    request.server.prisma,
    request.workspace.id,
    projectId,
    issueId,
    request.userId,
    body,
  );
  reply.send(issue);
}

export async function deleteIssueHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId, issueId } = request.params as { projectId: string; issueId: string };
  await issueService.deleteIssue(
    request.server.prisma,
    request.workspace.id,
    projectId,
    issueId,
    request.userId,
  );
  reply.code(204).send();
}

export async function addAssigneeHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId, issueId } = request.params as { projectId: string; issueId: string };
  const { user_id } = AssigneeBodySchema.parse(request.body);
  const issue = await issueService.addAssignee(
    request.server.prisma,
    request.workspace.id,
    projectId,
    issueId,
    request.userId,
    user_id,
  );
  reply.code(201).send(issue);
}

export async function removeAssigneeHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId, issueId, userId } = request.params as {
    projectId: string;
    issueId: string;
    userId: string;
  };
  const issue = await issueService.removeAssignee(
    request.server.prisma,
    request.workspace.id,
    projectId,
    issueId,
    request.userId,
    userId,
  );
  reply.send(issue);
}

export async function addLabelHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { projectId, issueId } = request.params as { projectId: string; issueId: string };
  const { label_id } = LabelAttachBodySchema.parse(request.body);
  const issue = await issueService.attachLabel(
    request.server.prisma,
    request.workspace.id,
    projectId,
    issueId,
    request.userId,
    label_id,
  );
  reply.code(201).send(issue);
}

export async function removeLabelHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { projectId, issueId, labelId } = request.params as {
    projectId: string;
    issueId: string;
    labelId: string;
  };
  const issue = await issueService.detachLabel(
    request.server.prisma,
    request.workspace.id,
    projectId,
    issueId,
    request.userId,
    labelId,
  );
  reply.send(issue);
}
