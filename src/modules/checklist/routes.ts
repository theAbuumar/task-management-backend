// Checklist of an issue (6.B5) —
// `/api/v1/workspaces/:workspaceSlug/projects/:projectId/issues/:issueId/checklist`.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import {
  CreateItemBodySchema,
  MAX_CHECKLIST_ITEMS,
  ReorderBodySchema,
  UpdateItemBodySchema,
  addChecklistItem,
  deleteChecklistItem,
  getChecklist,
  reorderChecklist,
  updateChecklistItem,
} from './service.js';

const security = [{ bearerAuth: [] }];
const tags = ['Checklist'];

const checklistShape = {
  type: 'object',
  properties: {
    data: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          issue_id: { type: 'string' },
          text: { type: 'string' },
          is_done: { type: 'boolean' },
          done_by_id: { type: 'string', nullable: true },
          done_by: {
            type: 'object',
            nullable: true,
            properties: {
              id: { type: 'string' },
              display_name: { type: 'string' },
              avatar_url: { type: 'string', nullable: true },
            },
          },
          done_at: { type: 'string', format: 'date-time', nullable: true },
          order: { type: 'integer' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
    },
    total: { type: 'integer' },
    done: { type: 'integer' },
  },
} as const;

const itemParams = {
  type: 'object',
  properties: {
    workspaceSlug: { type: 'string' },
    projectId: { type: 'string' },
    issueId: { type: 'string' },
    itemId: { type: 'string' },
  },
} as const;

function target(request: FastifyRequest) {
  const { projectId, issueId } = request.params as { projectId: string; issueId: string };
  return { workspaceId: request.workspace.id, projectId, issueId };
}

const itemId = (request: FastifyRequest) => (request.params as { itemId: string }).itemId;

export async function checklistRoutes(app: FastifyInstance): Promise<void> {
  const member = [authenticate, requireWorkspaceMember()];

  app.get(
    '/',
    {
      schema: {
        tags,
        summary: 'The checklist of an issue, in order',
        security,
        response: { 200: checklistShape },
      },
      preHandler: member,
    },
    async (request) => getChecklist(app.prisma, target(request)),
  );

  app.post(
    '/',
    {
      schema: {
        tags,
        summary: 'Add an item to the end of the checklist',
        description:
          `At most ${MAX_CHECKLIST_ITEMS} items (400 CHECKLIST_FULL). Written to the issue history. ` +
          'Returns the whole checklist; the issue’s `checklist_total`/`checklist_done` follow.',
        security,
        body: {
          type: 'object',
          required: ['text'],
          properties: { text: { type: 'string', minLength: 1, maxLength: 500 } },
        },
        response: { 201: checklistShape },
      },
      preHandler: member,
    },
    async (request, reply) => {
      const list = await addChecklistItem(
        app.prisma,
        target(request),
        request.userId,
        CreateItemBodySchema.parse(request.body),
      );
      reply.code(201).send(list);
    },
  );

  // Registered before `/:itemId` so "reorder" is never read as an item id.
  app.patch(
    '/reorder',
    {
      schema: {
        tags,
        summary: 'Reorder the checklist',
        description:
          '`item_ids` lists every item of the checklist exactly once, in the new order. ' +
          'Not written to the history.',
        security,
        body: {
          type: 'object',
          required: ['item_ids'],
          properties: {
            item_ids: {
              type: 'array',
              maxItems: MAX_CHECKLIST_ITEMS,
              items: { type: 'string', format: 'uuid' },
            },
          },
        },
        response: { 200: checklistShape },
      },
      preHandler: member,
    },
    async (request) =>
      reorderChecklist(
        app.prisma,
        target(request),
        request.userId,
        ReorderBodySchema.parse(request.body),
      ),
  );

  app.patch(
    '/:itemId',
    {
      schema: {
        tags,
        summary: 'Tick, untick or rename an item',
        description: 'Who ticked it and when are kept. Written to the history.',
        security,
        params: itemParams,
        body: {
          type: 'object',
          properties: {
            text: { type: 'string', minLength: 1, maxLength: 500 },
            is_done: { type: 'boolean' },
          },
        },
        response: { 200: checklistShape },
      },
      preHandler: member,
    },
    async (request) =>
      updateChecklistItem(
        app.prisma,
        target(request),
        request.userId,
        itemId(request),
        UpdateItemBodySchema.parse(request.body ?? {}),
      ),
  );

  app.delete(
    '/:itemId',
    {
      schema: {
        tags,
        summary: 'Remove an item',
        security,
        params: itemParams,
        response: { 200: checklistShape },
      },
      preHandler: member,
    },
    async (request) =>
      deleteChecklistItem(app.prisma, target(request), request.userId, itemId(request)),
  );
}
