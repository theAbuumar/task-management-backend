import { z } from 'zod';
import type { FastifySchema } from 'fastify';

// `review` is «На проверке» (Ф5, ADR-008): a project needs one to hand work in.
export const STATE_GROUPS = [
  'backlog',
  'unstarted',
  'started',
  'review',
  'completed',
  'cancelled',
] as const;

export const CreateStateBodySchema = z.object({
  name: z.string().min(1).max(50),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Color must be a hex code like #3B82F6'),
  group: z.enum(STATE_GROUPS),
  order: z.number().int().min(0).default(0),
  is_default: z.boolean().default(false),
});

export const UpdateStateBodySchema = z.object({
  name: z.string().min(1).max(50).optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Color must be a hex code like #3B82F6')
    .optional(),
  group: z.enum(STATE_GROUPS).optional(),
  order: z.number().int().min(0).optional(),
  is_default: z.boolean().optional(),
});

export const DeleteStateBodySchema = z.object({
  /** Issues in the deleted state are reassigned to this state. */
  transfer_to_state_id: z.string().uuid().optional(),
});

// The board order of every state of the project, first column first (4.F1).
export const ReorderStatesBodySchema = z.object({
  state_ids: z.array(z.string().uuid()).min(1).max(100),
});

export type CreateStateBody = z.infer<typeof CreateStateBodySchema>;
export type UpdateStateBody = z.infer<typeof UpdateStateBodySchema>;
export type DeleteStateBody = z.infer<typeof DeleteStateBodySchema>;
export type ReorderStatesBody = z.infer<typeof ReorderStatesBodySchema>;

// ─── Fastify route schemas ────────────────────────────────────────────────────

const stateShape = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    project_id: { type: 'string' },
    name: { type: 'string' },
    color: { type: 'string' },
    group: { type: 'string', enum: STATE_GROUPS },
    order: { type: 'integer' },
    is_default: { type: 'boolean' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
} as const;

const security = [{ bearerAuth: [] }];
const stateParams = {
  type: 'object',
  properties: {
    workspaceSlug: { type: 'string' },
    projectId: { type: 'string' },
    stateId: { type: 'string' },
  },
};

export const listStatesSchema: FastifySchema = {
  tags: ['States'],
  summary: 'List states for a project',
  security,
  params: stateParams,
  response: { 200: { type: 'array', items: stateShape } },
};

export const createStateSchema: FastifySchema = {
  tags: ['States'],
  summary: 'Create a custom state (admin+)',
  security,
  params: stateParams,
  body: {
    type: 'object',
    required: ['name', 'color', 'group'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 50 },
      color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
      group: { type: 'string', enum: STATE_GROUPS },
      order: { type: 'integer', minimum: 0 },
      is_default: { type: 'boolean' },
    },
  },
  response: { 201: stateShape },
};

export const updateStateSchema: FastifySchema = {
  tags: ['States'],
  summary: 'Update a state (admin+)',
  description:
    '`is_default: true` makes it the one default state of the project (the previous one stops being it); ' +
    '`is_default: false` on the default state → `409 DEFAULT_STATE`. Moving the last state of a group ' +
    'to another group → `409 LAST_STATE_IN_GROUP`.',
  security,
  params: stateParams,
  body: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 50 },
      color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
      group: { type: 'string', enum: STATE_GROUPS },
      order: { type: 'integer', minimum: 0 },
      is_default: { type: 'boolean' },
    },
  },
  response: { 200: stateShape },
};

export const deleteStateSchema: FastifySchema = {
  tags: ['States'],
  summary: 'Delete a state; issues are reassigned to the specified or default state (admin+)',
  description:
    'Issues in the state — those in the trash too — move to `transfer_to_state_id` (by default the ' +
    "project's default state); each move is recorded in the issue's history. The default state cannot " +
    'be deleted (`409 DEFAULT_STATE`), nor the last state of its group (`409 LAST_STATE_IN_GROUP`): ' +
    'review, acceptance, distribution and analytics rely on every group (ADR-031).',
  security,
  params: stateParams,
  // In the query string: a DELETE body is optional, and some clients drop it. A
  // JSON body with the same field is still read (the older form).
  querystring: {
    type: 'object',
    properties: { transfer_to_state_id: { type: 'string', format: 'uuid' } },
  },
  response: { 204: { type: 'null' } },
};

export const reorderStatesSchema: FastifySchema = {
  tags: ['States'],
  summary: 'Set the board order of the project states (admin+)',
  description:
    '`state_ids` lists every state of the project once, in the new order; the response is the ' +
    'states in that order. A missing, extra or foreign id → 400.',
  security,
  params: stateParams,
  body: {
    type: 'object',
    required: ['state_ids'],
    properties: {
      state_ids: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: { type: 'string', format: 'uuid' },
      },
    },
  },
  response: { 200: { type: 'array', items: stateShape } },
};
