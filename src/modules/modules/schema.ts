import { z } from 'zod';
import type { FastifySchema } from 'fastify';

const MODULE_STATUSES = ['backlog', 'in_progress', 'paused', 'completed', 'cancelled'] as const;

export const CreateModuleBodySchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(10_000).optional(),
  status: z.enum(MODULE_STATUSES).optional(),
  lead_id: z.string().uuid().optional().nullable(),
  start_date: z.string().datetime().optional().nullable(),
  target_date: z.string().datetime().optional().nullable(),
});

export const UpdateModuleBodySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(10_000).optional().nullable(),
  status: z.enum(MODULE_STATUSES).optional(),
  lead_id: z.string().uuid().optional().nullable(),
  start_date: z.string().datetime().optional().nullable(),
  target_date: z.string().datetime().optional().nullable(),
});

export const AddIssuesToModuleBodySchema = z.object({
  issue_ids: z.array(z.string().uuid()).min(1).max(100),
});

export type CreateModuleBody = z.infer<typeof CreateModuleBodySchema>;
export type UpdateModuleBody = z.infer<typeof UpdateModuleBodySchema>;
export type AddIssuesToModuleBody = z.infer<typeof AddIssuesToModuleBodySchema>;

// ─── Fastify route schemas ────────────────────────────────────────────────────

const moduleShape = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    workspace_id: { type: 'string' },
    project_id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string', nullable: true },
    status: { type: 'string', enum: MODULE_STATUSES },
    lead_id: { type: 'string', nullable: true },
    start_date: { type: 'string', format: 'date-time', nullable: true },
    target_date: { type: 'string', format: 'date-time', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
} as const;

const progressShape = {
  type: 'object',
  properties: {
    total: { type: 'integer' },
    backlog: { type: 'integer' },
    unstarted: { type: 'integer' },
    started: { type: 'integer' },
    review: { type: 'integer' },
    completed: { type: 'integer' },
    cancelled: { type: 'integer' },
    completion_percentage: { type: 'number' },
  },
} as const;

const projectParams = {
  type: 'object',
  required: ['workspaceSlug', 'projectId'],
  properties: {
    workspaceSlug: { type: 'string' },
    projectId: { type: 'string' },
  },
} as const;

const moduleParams = {
  type: 'object',
  required: ['workspaceSlug', 'projectId', 'moduleId'],
  properties: {
    workspaceSlug: { type: 'string' },
    projectId: { type: 'string' },
    moduleId: { type: 'string' },
  },
} as const;

const moduleViewShape = {
  type: 'object',
  properties: { ...moduleShape.properties, progress: progressShape },
} as const;

const tags = ['Modules'];
const security = [{ bearerAuth: [] }];

const moduleBody = {
  name: { type: 'string', minLength: 1, maxLength: 255 },
  description: { type: 'string', nullable: true },
  status: { type: 'string', enum: MODULE_STATUSES },
  lead_id: { type: 'string', format: 'uuid', nullable: true },
  start_date: { type: 'string', format: 'date-time', nullable: true },
  target_date: { type: 'string', format: 'date-time', nullable: true },
} as const;

export const listModulesSchema: FastifySchema = {
  tags,
  summary: 'List the modules of a project with their progress',
  description:
    '`progress` counts the issues of each module by state group (trash left out), done = completed + cancelled.',
  security,
  params: projectParams,
  response: { 200: { type: 'array', items: moduleViewShape } },
};

export const createModuleSchema: FastifySchema = {
  tags,
  summary: 'Create a module (member+)',
  description:
    'The lead is any workspace member who can be assigned work (not a guest — `400 GUEST_NOT_ASSIGNABLE`, ' +
    'not turned off — `400 MEMBER_DEACTIVATED`); target_date must not be before start_date.',
  security,
  params: projectParams,
  body: { type: 'object', required: ['name'], properties: moduleBody },
  response: { 201: moduleViewShape },
};

export const getModuleSchema: FastifySchema = {
  tags,
  summary: 'A module with its progress',
  security,
  params: moduleParams,
  response: { 200: moduleViewShape },
};

export const updateModuleSchema: FastifySchema = {
  tags,
  summary: 'Update a module (member+)',
  security,
  params: moduleParams,
  body: { type: 'object', properties: moduleBody },
  response: { 200: moduleViewShape },
};

export const deleteModuleSchema: FastifySchema = {
  tags,
  summary: 'Delete a module (admin+); its issues stay where they are',
  security,
  params: moduleParams,
  response: { 204: { type: 'null' } },
};

export const addIssuesToModuleSchema: FastifySchema = {
  tags,
  summary: 'Add issues to a module (member+)',
  description:
    'Each issue that joins gets a history entry (`issue.module_added`); `added` counts them, issues ' +
    'already in the module are left as they are.',
  security,
  params: moduleParams,
  body: {
    type: 'object',
    required: ['issue_ids'],
    properties: {
      issue_ids: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        minItems: 1,
        maxItems: 100,
      },
    },
  },
  response: { 200: { type: 'object', properties: { added: { type: 'integer' } } } },
};

export const removeIssueFromModuleSchema: FastifySchema = {
  tags,
  summary: 'Take an issue out of a module (member+)',
  security,
  params: {
    type: 'object',
    required: ['workspaceSlug', 'projectId', 'moduleId', 'issueId'],
    properties: {
      workspaceSlug: { type: 'string' },
      projectId: { type: 'string' },
      moduleId: { type: 'string' },
      issueId: { type: 'string' },
    },
  },
  response: { 204: { type: 'null' } },
};
