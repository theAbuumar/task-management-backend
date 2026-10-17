import { z } from 'zod';
import type { FastifySchema } from 'fastify';

export const CreateCycleBodySchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(10_000).optional(),
  start_date: z.string().datetime().optional().nullable(),
  end_date: z.string().datetime().optional().nullable(),
});

export const UpdateCycleBodySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(10_000).optional().nullable(),
  start_date: z.string().datetime().optional().nullable(),
  end_date: z.string().datetime().optional().nullable(),
});

export const AddIssuesToCycleBodySchema = z.object({
  issue_ids: z.array(z.string().uuid()).min(1),
});

export type CreateCycleBody = z.infer<typeof CreateCycleBodySchema>;
export type UpdateCycleBody = z.infer<typeof UpdateCycleBodySchema>;
export type AddIssuesToCycleBody = z.infer<typeof AddIssuesToCycleBodySchema>;

// ─── Fastify route schemas ────────────────────────────────────────────────────

const cycleShape = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    workspace_id: { type: 'string' },
    project_id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string', nullable: true },
    start_date: { type: 'string', nullable: true },
    end_date: { type: 'string', nullable: true },
    status: { type: 'string', enum: ['upcoming', 'active', 'completed'] },
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

export const listCyclesSchema: FastifySchema = {
  params: {
    type: 'object',
    required: ['workspaceSlug', 'projectId'],
    properties: {
      workspaceSlug: { type: 'string' },
      projectId: { type: 'string' },
    },
  },
  response: { 200: { type: 'array', items: cycleShape } },
};

export const createCycleSchema: FastifySchema = {
  params: {
    type: 'object',
    required: ['workspaceSlug', 'projectId'],
    properties: {
      workspaceSlug: { type: 'string' },
      projectId: { type: 'string' },
    },
  },
  body: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string' },
      description: { type: 'string', nullable: true },
      start_date: { type: 'string', nullable: true },
      end_date: { type: 'string', nullable: true },
    },
  },
  response: { 201: cycleShape },
};

export const getCycleSchema: FastifySchema = {
  params: {
    type: 'object',
    required: ['workspaceSlug', 'projectId', 'cycleId'],
    properties: {
      workspaceSlug: { type: 'string' },
      projectId: { type: 'string' },
      cycleId: { type: 'string' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        ...cycleShape.properties,
        progress: progressShape,
      },
    },
  },
};

export const updateCycleSchema: FastifySchema = {
  params: {
    type: 'object',
    required: ['workspaceSlug', 'projectId', 'cycleId'],
    properties: {
      workspaceSlug: { type: 'string' },
      projectId: { type: 'string' },
      cycleId: { type: 'string' },
    },
  },
  body: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string', nullable: true },
      start_date: { type: 'string', nullable: true },
      end_date: { type: 'string', nullable: true },
    },
  },
  response: { 200: cycleShape },
};

export const deleteCycleSchema: FastifySchema = {
  params: {
    type: 'object',
    required: ['workspaceSlug', 'projectId', 'cycleId'],
    properties: {
      workspaceSlug: { type: 'string' },
      projectId: { type: 'string' },
      cycleId: { type: 'string' },
    },
  },
  response: { 204: { type: 'null' } },
};

export const addIssuesToCycleSchema: FastifySchema = {
  params: {
    type: 'object',
    required: ['workspaceSlug', 'projectId', 'cycleId'],
    properties: {
      workspaceSlug: { type: 'string' },
      projectId: { type: 'string' },
      cycleId: { type: 'string' },
    },
  },
  body: {
    type: 'object',
    required: ['issue_ids'],
    properties: {
      issue_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
    },
  },
  response: { 200: { type: 'object', properties: { added: { type: 'integer' } } } },
};

export const removeIssueFromCycleSchema: FastifySchema = {
  params: {
    type: 'object',
    required: ['workspaceSlug', 'projectId', 'cycleId', 'issueId'],
    properties: {
      workspaceSlug: { type: 'string' },
      projectId: { type: 'string' },
      cycleId: { type: 'string' },
      issueId: { type: 'string' },
    },
  },
  response: { 204: { type: 'null' } },
};
