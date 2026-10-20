// Saved views (7.B4, ADR-029) — `/api/v1/workspaces/:workspaceSlug/views`.

import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import {
  CreateViewBodySchema,
  ListViewsQuerySchema,
  UpdateViewBodySchema,
  VIEW_MODES,
  createView,
  deleteView,
  listViews,
  updateView,
} from './service.js';

const security = [{ bearerAuth: [] }];
const tags = ['Saved views'];

const filters = {
  type: 'object',
  description: 'Page filters: { key: string | string[] } — at most 20 latin keys',
  additionalProperties: {
    anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
  },
} as const;
const display = {
  type: 'object',
  properties: { view: { type: 'string', enum: VIEW_MODES } },
} as const;

const viewShape = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    project_id: { type: 'string', nullable: true },
    project: {
      type: 'object',
      nullable: true,
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        identifier: { type: 'string' },
        icon: { type: 'string', nullable: true },
        color: { type: 'string', nullable: true },
      },
    },
    filters,
    display,
    is_shared: { type: 'boolean' },
    owner: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        display_name: { type: 'string' },
        avatar_url: { type: 'string', nullable: true },
      },
    },
    can_edit: { type: 'boolean' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
} as const;

const idParams = {
  type: 'object',
  properties: { workspaceSlug: { type: 'string' }, viewId: { type: 'string' } },
} as const;

export async function viewRoutes(app: FastifyInstance): Promise<void> {
  const member = [authenticate, requireWorkspaceMember()];

  app.get(
    '/',
    {
      schema: {
        tags,
        summary: 'Saved views I can open: my personal ones and the shared ones',
        description:
          'ADR-029. `project=<id>` — the views of a project; `project=workspace` — the views of the ' +
          'workspace list. Views of projects the caller cannot see are left out. Shared views come first.',
        security,
        querystring: { type: 'object', properties: { project: { type: 'string' } } },
        response: {
          200: { type: 'object', properties: { data: { type: 'array', items: viewShape } } },
        },
      },
      preHandler: member,
    },
    async (request) =>
      listViews(
        app.prisma,
        request.workspace.id,
        request.workspaceMember,
        ListViewsQuerySchema.parse(request.query),
      ),
  );

  app.post(
    '/',
    {
      schema: {
        tags,
        summary: 'Save a view (shared — admins and the owner only)',
        security,
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', maxLength: 80 },
            project_id: { type: 'string', nullable: true },
            filters,
            display,
            is_shared: { type: 'boolean', default: false },
          },
        },
        response: { 201: viewShape },
      },
      preHandler: member,
    },
    async (request, reply) => {
      const view = await createView(
        app.prisma,
        request.workspace.id,
        request.workspaceMember,
        CreateViewBodySchema.parse(request.body),
      );
      reply.code(201).send(view);
    },
  );

  app.patch(
    '/:viewId',
    {
      schema: {
        tags,
        summary: 'Rename a view or change its filters, display or sharing',
        description:
          'A personal view — its author; a shared view — admins and the owner. Sharing a view or ' +
          'making a shared one personal is for admins and the owner only.',
        security,
        params: idParams,
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', maxLength: 80 },
            filters,
            display,
            is_shared: { type: 'boolean' },
          },
        },
        response: { 200: viewShape },
      },
      preHandler: member,
    },
    async (request) => {
      const { viewId } = request.params as { viewId: string };
      return updateView(
        app.prisma,
        request.workspace.id,
        request.workspaceMember,
        viewId,
        UpdateViewBodySchema.parse(request.body),
      );
    },
  );

  app.delete(
    '/:viewId',
    {
      schema: {
        tags,
        summary: 'Delete a view (personal — its author; shared — admins and the owner)',
        security,
        params: idParams,
        response: { 204: { type: 'null' } },
      },
      preHandler: member,
    },
    async (request, reply) => {
      const { viewId } = request.params as { viewId: string };
      await deleteView(app.prisma, request.workspace.id, request.workspaceMember, viewId);
      reply.code(204).send();
    },
  );
}
