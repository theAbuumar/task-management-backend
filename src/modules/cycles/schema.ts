import { z } from 'zod';
import type { FastifySchema } from 'fastify';
import { BURNDOWN_DESCRIPTION, BURNDOWN_SHAPE } from '../../lib/burndown.js';

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
  issue_ids: z.array(z.string().uuid()).min(1).max(100),
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
    start_date: { type: 'string', format: 'date-time', nullable: true },
    end_date: { type: 'string', format: 'date-time', nullable: true },
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

const cycleViewShape = {
  type: 'object',
  properties: { ...cycleShape.properties, progress: progressShape },
} as const;

const tags = ['Cycles'];
const security = [{ bearerAuth: [] }];

export const listCyclesSchema: FastifySchema = {
  tags,
  summary: 'List the cycles (этапы) of a project with their progress',
  description:
    'Ordered by start date (no date last). `status` follows the dates as days of the workspace time ' +
    'zone; `progress` counts issues by state group (trash left out), done = completed + cancelled.',
  security,
  params: {
    type: 'object',
    required: ['workspaceSlug', 'projectId'],
    properties: {
      workspaceSlug: { type: 'string' },
      projectId: { type: 'string' },
    },
  },
  response: { 200: { type: 'array', items: cycleViewShape } },
};

export const createCycleSchema: FastifySchema = {
  tags,
  summary: 'Create a cycle (member+); end_date must not be before start_date',
  security,
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
  response: { 201: cycleViewShape },
};

export const getCycleSchema: FastifySchema = {
  tags,
  summary: 'A cycle with its progress',
  security,
  params: {
    type: 'object',
    required: ['workspaceSlug', 'projectId', 'cycleId'],
    properties: {
      workspaceSlug: { type: 'string' },
      projectId: { type: 'string' },
      cycleId: { type: 'string' },
    },
  },
  response: { 200: cycleViewShape },
};

export const updateCycleSchema: FastifySchema = {
  tags,
  summary: 'Update a cycle (member+)',
  security,
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
  response: { 200: cycleViewShape },
};

export const deleteCycleSchema: FastifySchema = {
  tags,
  summary: 'Delete a cycle (admin+); its issues stay, out of any cycle',
  security,
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
  tags,
  summary: 'Add issues to a cycle (member+); an issue in another cycle moves here',
  description:
    'Each issue that changes cycle gets a history entry (`issue.updated`, field `cycle_id`). ' +
    '`added` counts the issues that moved; ones already in the cycle are left as they are.',
  security,
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

export const removeIssueFromCycleSchema: FastifySchema = {
  tags,
  summary: 'Take an issue out of a cycle (member+)',
  security,
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

export const cycleBurndownSchema: FastifySchema = {
  tags,
  summary: 'Burndown and burnup of a cycle (график сгорания этапа)',
  description: BURNDOWN_DESCRIPTION,
  security,
  params: {
    type: 'object',
    required: ['workspaceSlug', 'projectId', 'cycleId'],
    properties: {
      workspaceSlug: { type: 'string' },
      projectId: { type: 'string' },
      cycleId: { type: 'string' },
    },
  },
  response: { 200: BURNDOWN_SHAPE },
};
