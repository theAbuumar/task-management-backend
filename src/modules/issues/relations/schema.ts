import { z } from 'zod';
import type { FastifySchema } from 'fastify';

export const RELATION_TYPES = ['blocks', 'blocked_by', 'relates_to', 'duplicates'] as const;

export const CreateRelationBodySchema = z.object({
  related_issue_id: z.string().uuid(),
  relation_type: z.enum(RELATION_TYPES),
});

export type CreateRelationBody = z.infer<typeof CreateRelationBodySchema>;

export const ProjectRelationsQuerySchema = z.object({
  type: z.enum(['blocks', 'relates_to', 'duplicates']).optional(),
});

// ─── Fastify route schemas ────────────────────────────────────────────────────

const security = [{ bearerAuth: [] }];

const relatedIssueShape = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    sequence_id: { type: 'integer' },
    title: { type: 'string' },
    priority: { type: 'string' },
    state_id: { type: 'string' },
    project_id: { type: 'string' },
  },
} as const;

const linkShape = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    issue_id: { type: 'string' },
    related_issue_id: { type: 'string' },
    relation_type: { type: 'string', enum: RELATION_TYPES },
    created_at: { type: 'string', format: 'date-time' },
    related_issue: relatedIssueShape,
  },
} as const;

export const listRelationsSchema: FastifySchema = {
  tags: ['Issue Relations'],
  summary: 'List all relations for an issue',
  security,
  response: {
    200: {
      type: 'object',
      properties: {
        blocks: { type: 'array', items: linkShape },
        blocked_by: { type: 'array', items: linkShape },
        relates_to: { type: 'array', items: linkShape },
        duplicates: { type: 'array', items: linkShape },
      },
    },
  },
};

export const createRelationSchema: FastifySchema = {
  tags: ['Issue Relations'],
  summary: 'Create a relation between two issues',
  security,
  body: {
    type: 'object',
    required: ['related_issue_id', 'relation_type'],
    properties: {
      related_issue_id: { type: 'string', format: 'uuid' },
      relation_type: { type: 'string', enum: RELATION_TYPES },
    },
  },
  response: { 201: linkShape },
};

export const deleteRelationSchema: FastifySchema = {
  tags: ['Issue Relations'],
  summary: 'Delete a relation (removes mirror relation too)',
  security,
  response: { 204: { type: 'null' } },
};

export const listProjectRelationsSchema: FastifySchema = {
  tags: ['Issue Relations'],
  summary: 'Relations between the issues of a project, each pair once (timeline)',
  description:
    'For the timeline (7.F4): one request instead of one per issue. `blocked_by` mirrors are ' +
    'left out (read `blocks`), a symmetric pair is returned once, deleted issues and links to ' +
    'other projects are skipped. `type` narrows to one kind.',
  security,
  querystring: {
    type: 'object',
    properties: { type: { type: 'string', enum: ['blocks', 'relates_to', 'duplicates'] } },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              issue_id: { type: 'string' },
              related_issue_id: { type: 'string' },
              relation_type: { type: 'string', enum: RELATION_TYPES },
              created_at: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
  },
};
