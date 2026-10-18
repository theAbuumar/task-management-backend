import { z } from 'zod';
import type { FastifySchema } from 'fastify';

// ─── Zod validators ───────────────────────────────────────────────────────────

export const CreateDepartmentBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  short_name: z.string().trim().max(50).optional().nullable(),
  parent_id: z.string().uuid().optional().nullable(),
  head_id: z.string().uuid().optional().nullable(),
  order: z.number().int().min(0).max(100_000).optional(),
});

export const UpdateDepartmentBodySchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  short_name: z.string().trim().max(50).optional().nullable(),
  parent_id: z.string().uuid().optional().nullable(),
  head_id: z.string().uuid().optional().nullable(),
  order: z.number().int().min(0).max(100_000).optional(),
});

export const ListDepartmentsQuerySchema = z.object({
  // `tree=true` returns nested roots with `children`; otherwise a flat list.
  tree: z.coerce.boolean().optional(),
});

export type CreateDepartmentBody = z.infer<typeof CreateDepartmentBodySchema>;
export type UpdateDepartmentBody = z.infer<typeof UpdateDepartmentBodySchema>;
export type ListDepartmentsQuery = z.infer<typeof ListDepartmentsQuerySchema>;

// ─── Fastify route schemas ────────────────────────────────────────────────────

const departmentShape = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    workspace_id: { type: 'string' },
    parent_id: { type: 'string', nullable: true },
    name: { type: 'string' },
    short_name: { type: 'string', nullable: true },
    head_id: { type: 'string', nullable: true },
    order: { type: 'integer' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
    head: { type: 'object', nullable: true, additionalProperties: true },
    members_count: { type: 'integer' },
    // Nested departments (only with ?tree=true).
    children: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
} as const;

const security = [{ bearerAuth: [] }];
const wsParams = { type: 'object', properties: { workspaceSlug: { type: 'string' } } };
const deptParams = {
  type: 'object',
  properties: { workspaceSlug: { type: 'string' }, departmentId: { type: 'string' } },
};

export const listDepartmentsSchema: FastifySchema = {
  tags: ['Departments'],
  summary: 'List the org structure (flat, or nested with ?tree=true)',
  security,
  params: wsParams,
  querystring: { type: 'object', properties: { tree: { type: 'boolean' } } },
  response: { 200: { type: 'array', items: departmentShape } },
};

export const createDepartmentSchema: FastifySchema = {
  tags: ['Departments'],
  summary: 'Create a department (admin+)',
  security,
  params: wsParams,
  body: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      short_name: { type: 'string', maxLength: 50, nullable: true },
      parent_id: { type: 'string', format: 'uuid', nullable: true },
      head_id: { type: 'string', format: 'uuid', nullable: true },
      order: { type: 'integer', minimum: 0 },
    },
  },
  response: { 201: departmentShape },
};

export const updateDepartmentSchema: FastifySchema = {
  tags: ['Departments'],
  summary: 'Update a department — rename, move in the tree, set the head (admin+)',
  description:
    'Moving a department under itself or its own descendant is rejected (DEPARTMENT_CYCLE).',
  security,
  params: deptParams,
  body: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      short_name: { type: 'string', maxLength: 50, nullable: true },
      parent_id: { type: 'string', format: 'uuid', nullable: true },
      head_id: { type: 'string', format: 'uuid', nullable: true },
      order: { type: 'integer', minimum: 0 },
    },
  },
  response: { 200: departmentShape },
};

export const deleteDepartmentSchema: FastifySchema = {
  tags: ['Departments'],
  summary: 'Delete a department (admin+)',
  description: 'Its people and sub-departments move one level up (to the parent, or to the root).',
  security,
  params: deptParams,
  response: { 204: { type: 'null' } },
};
