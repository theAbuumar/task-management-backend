import { z } from 'zod';
import type { FastifySchema } from 'fastify';

const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
const SORT_FIELDS = ['created_at', 'updated_at', 'priority', 'due_date', 'sort_order'] as const;
const SORT_ORDERS = ['asc', 'desc'] as const;
const GROUP_FIELDS = ['state', 'priority', 'assignee'] as const;
const KINDS = ['task', 'assignment'] as const;
const userRef = z.union([z.string().uuid(), z.literal('me')]);
// Query strings carry booleans as text.
const boolFlag = z.enum(['true', 'false']).transform((v) => v === 'true');

export const CreateIssueBodySchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(50_000).optional(),
  state_id: z.string().uuid(),
  priority: z.enum(PRIORITIES).default('none'),
  parent_id: z.string().uuid().optional().nullable(),
  assignee_ids: z.array(z.string().uuid()).optional(),
  label_ids: z.array(z.string().uuid()).optional(),
  start_date: z.string().datetime().optional().nullable(),
  due_date: z.string().datetime().optional().nullable(),
  estimate_points: z.number().min(0).optional().nullable(),
  // Поручение fields (ADR-008).
  kind: z.enum(KINDS).default('task'),
  controller_id: z.string().uuid().optional().nullable(),
  requires_review: z.boolean().optional(),
  basis: z.string().max(500).optional().nullable(),
  // Ответственный исполнитель — one of assignee_ids (defaults to the first).
  primary_assignee_id: z.string().uuid().optional(),
});

export const UpdateIssueBodySchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(50_000).optional().nullable(),
  state_id: z.string().uuid().optional(),
  priority: z.enum(PRIORITIES).optional(),
  parent_id: z.string().uuid().optional().nullable(),
  start_date: z.string().datetime().optional().nullable(),
  due_date: z.string().datetime().optional().nullable(),
  estimate_points: z.number().min(0).optional().nullable(),
  sort_order: z.number().optional(),
  kind: z.enum(KINDS).optional(),
  controller_id: z.string().uuid().optional().nullable(),
  requires_review: z.boolean().optional(),
  basis: z.string().max(500).optional().nullable(),
  // Must already be an assignee; becomes the only primary one.
  primary_assignee_id: z.string().uuid().optional(),
});

export const IssueFilterQuerySchema = z.object({
  state: z.union([z.string(), z.array(z.string())]).optional(),
  priority: z.union([z.string(), z.array(z.string())]).optional(),
  assignee: z.union([z.string(), z.array(z.string())]).optional(),
  label: z.union([z.string(), z.array(z.string())]).optional(),
  cycle: z.string().uuid().optional(),
  module: z.string().uuid().optional(),
  // `me` is accepted wherever a user id is expected (assignee/created_by/controller/watcher).
  created_by: userRef.optional(),
  parent_id: z.string().uuid().optional(),
  kind: z.enum(KINDS).optional(),
  controller: userRef.optional(),
  watcher: userRef.optional(),
  // Execution-control filters (Ф5), computed in the workspace time zone.
  overdue: boolFlag.optional(),
  due_within: z.coerce.number().int().min(0).max(365).optional(),
  open: boolFlag.optional(),
  review_pending: boolFlag.optional(),
  acknowledged: boolFlag.optional(),
  search: z.string().optional(),
  due_before: z.string().datetime().optional(),
  due_after: z.string().datetime().optional(),
  created_before: z.string().datetime().optional(),
  created_after: z.string().datetime().optional(),
  sort_by: z.enum(SORT_FIELDS).default('created_at'),
  order: z.enum(SORT_ORDERS).default('asc'),
  group_by: z.enum(GROUP_FIELDS).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const AssigneeBodySchema = z.object({
  user_id: z.string().uuid(),
});

export const LabelAttachBodySchema = z.object({
  label_id: z.string().uuid(),
});

export type CreateIssueBody = z.infer<typeof CreateIssueBodySchema>;
export type UpdateIssueBody = z.infer<typeof UpdateIssueBodySchema>;
export type IssueFilterQuery = z.infer<typeof IssueFilterQuerySchema>;
export type AssigneeBody = z.infer<typeof AssigneeBodySchema>;
export type LabelAttachBody = z.infer<typeof LabelAttachBodySchema>;

// ─── Fastify route schemas ────────────────────────────────────────────────────

const issueShape = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    workspace_id: { type: 'string' },
    project_id: { type: 'string' },
    sequence_id: { type: 'integer' },
    title: { type: 'string' },
    description: { type: 'string', nullable: true },
    state_id: { type: 'string' },
    priority: { type: 'string', enum: PRIORITIES },
    parent_id: { type: 'string', nullable: true },
    estimate_points: { type: 'number', nullable: true },
    start_date: { type: 'string', nullable: true },
    due_date: { type: 'string', nullable: true },
    completed_at: { type: 'string', nullable: true },
    created_by_id: { type: 'string' },
    kind: { type: 'string', enum: KINDS },
    controller_id: { type: 'string', nullable: true },
    requires_review: { type: 'boolean' },
    basis: { type: 'string', nullable: true },
    controller: { type: 'object', nullable: true, additionalProperties: true },
    state: { type: 'object', additionalProperties: true },
    // { watchers, deadline_changes } — approved deadline moves count as "переносы".
    _count: { type: 'object', additionalProperties: true },
    sort_order: { type: 'number' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
    // Items: { user_id, is_primary, acknowledged_at, user }.
    assignees: { type: 'array', items: { type: 'object', additionalProperties: true } },
    labels: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
} as const;

const security = [{ bearerAuth: [] }];

export const listIssuesSchema: FastifySchema = {
  tags: ['Issues'],
  summary: 'List issues in a project with optional filtering and cursor pagination',
  security,
  querystring: {
    type: 'object',
    properties: {
      state: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      priority: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      assignee: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      label: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      cycle: { type: 'string', format: 'uuid' },
      module: { type: 'string', format: 'uuid' },
      created_by: { type: 'string' },
      parent_id: { type: 'string' },
      kind: { type: 'string', enum: KINDS },
      controller: { type: 'string', description: 'user id or `me`' },
      watcher: { type: 'string', description: 'user id or `me`' },
      overdue: { type: 'string', enum: ['true', 'false'] },
      due_within: { type: 'integer', minimum: 0, maximum: 365 },
      open: { type: 'string', enum: ['true', 'false'] },
      review_pending: { type: 'string', enum: ['true', 'false'] },
      acknowledged: {
        type: 'string',
        enum: ['true', 'false'],
        description: '`false` = assignments where I am an assignee and have not acknowledged',
      },
      search: { type: 'string' },
      due_before: { type: 'string' },
      due_after: { type: 'string' },
      created_before: { type: 'string' },
      created_after: { type: 'string' },
      sort_by: { type: 'string', enum: SORT_FIELDS },
      order: { type: 'string', enum: SORT_ORDERS },
      group_by: { type: 'string', enum: GROUP_FIELDS },
      cursor: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    },
  },
  response: {
    // Two shapes: paginated (`data`/`next_cursor`) by default, or grouped
    // (`group_by`/`groups`) when `group_by` is supplied. Only the properties
    // present on the returned object are serialized.
    200: {
      type: 'object',
      properties: {
        data: { type: 'array', items: issueShape },
        next_cursor: { type: 'string', nullable: true },
        group_by: { type: 'string', enum: GROUP_FIELDS },
        groups: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', nullable: true },
              issues: { type: 'array', items: issueShape },
            },
          },
        },
      },
    },
  },
};

export const createIssueSchema: FastifySchema = {
  tags: ['Issues'],
  summary: 'Create an issue',
  security,
  body: {
    type: 'object',
    required: ['title', 'state_id'],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 500 },
      description: { type: 'string' },
      state_id: { type: 'string', format: 'uuid' },
      priority: { type: 'string', enum: PRIORITIES },
      parent_id: { type: 'string', format: 'uuid', nullable: true },
      assignee_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
      label_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
      start_date: { type: 'string', nullable: true },
      due_date: { type: 'string', nullable: true },
      estimate_points: { type: 'number', nullable: true },
      kind: { type: 'string', enum: KINDS },
      controller_id: { type: 'string', format: 'uuid', nullable: true },
      requires_review: { type: 'boolean' },
      basis: { type: 'string', maxLength: 500, nullable: true },
      primary_assignee_id: { type: 'string', format: 'uuid' },
    },
  },
  response: { 201: issueShape },
};

export const getIssueSchema: FastifySchema = {
  tags: ['Issues'],
  summary: 'Get issue details',
  security,
  response: { 200: issueShape },
};

export const updateIssueSchema: FastifySchema = {
  tags: ['Issues'],
  summary: 'Update an issue',
  security,
  body: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 500 },
      description: { type: 'string', nullable: true },
      state_id: { type: 'string', format: 'uuid' },
      priority: { type: 'string', enum: PRIORITIES },
      parent_id: { type: 'string', format: 'uuid', nullable: true },
      start_date: { type: 'string', nullable: true },
      due_date: { type: 'string', nullable: true },
      estimate_points: { type: 'number', nullable: true },
      sort_order: { type: 'number' },
      kind: { type: 'string', enum: KINDS },
      controller_id: { type: 'string', format: 'uuid', nullable: true },
      requires_review: { type: 'boolean' },
      basis: { type: 'string', maxLength: 500, nullable: true },
      primary_assignee_id: { type: 'string', format: 'uuid' },
    },
  },
  response: { 200: issueShape },
};

export const deleteIssueSchema: FastifySchema = {
  tags: ['Issues'],
  summary: 'Soft-delete an issue',
  security,
  response: { 204: { type: 'null' } },
};

export const addAssigneeSchema: FastifySchema = {
  tags: ['Issues'],
  summary: 'Add an assignee to an issue',
  security,
  body: {
    type: 'object',
    required: ['user_id'],
    properties: { user_id: { type: 'string', format: 'uuid' } },
  },
  response: { 201: issueShape },
};

export const removeAssigneeSchema: FastifySchema = {
  tags: ['Issues'],
  summary: 'Remove an assignee from an issue',
  security,
  response: { 200: issueShape },
};

export const addLabelSchema: FastifySchema = {
  tags: ['Issues'],
  summary: 'Attach a label to an issue',
  security,
  body: {
    type: 'object',
    required: ['label_id'],
    properties: { label_id: { type: 'string', format: 'uuid' } },
  },
  response: { 201: issueShape },
};

export const removeLabelSchema: FastifySchema = {
  tags: ['Issues'],
  summary: 'Detach a label from an issue',
  security,
  response: { 200: issueShape },
};
