import type { FastifyRequest, FastifyReply } from 'fastify';
import * as departmentService from './service.js';
import {
  CreateDepartmentBodySchema,
  UpdateDepartmentBodySchema,
  ListDepartmentsQuerySchema,
} from './schema.js';

export async function listDepartmentsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { tree } = ListDepartmentsQuerySchema.parse(request.query ?? {});
  const departments = await departmentService.listDepartments(
    request.server.prisma,
    request.workspace.id,
  );
  reply.send(tree ? departmentService.buildTree(departments) : departments);
}

export async function createDepartmentHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = CreateDepartmentBodySchema.parse(request.body);
  const department = await departmentService.createDepartment(
    request.server.prisma,
    request.workspace.id,
    body,
  );
  reply.code(201).send(department);
}

export async function updateDepartmentHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { departmentId } = request.params as { departmentId: string };
  const body = UpdateDepartmentBodySchema.parse(request.body);
  const department = await departmentService.updateDepartment(
    request.server.prisma,
    request.workspace.id,
    departmentId,
    body,
  );
  reply.send(department);
}

export async function deleteDepartmentHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { departmentId } = request.params as { departmentId: string };
  await departmentService.deleteDepartment(
    request.server.prisma,
    request.workspace.id,
    departmentId,
  );
  reply.code(204).send();
}
