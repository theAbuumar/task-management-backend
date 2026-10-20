// Issue templates (6.B3, ADR-030) — `/api/v1/workspaces/:workspaceSlug/templates`.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import { issueFieldsShape } from '../recurring/routes.js';
import {
  ApplyTemplateBodySchema,
  CreateTemplateBodySchema,
  TemplateQuerySchema,
  UpdateTemplateBodySchema,
  applyTemplate,
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  updateTemplate,
} from './service.js';

const security = [{ bearerAuth: [] }];
const tags = ['Templates'];

const templateShape = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    project_id: { type: 'string', nullable: true },
    project: { type: 'object', nullable: true, additionalProperties: true },
    name: { type: 'string' },
    data: issueFieldsShape,
    due_in_days: { type: 'integer', nullable: true },
    created_by_id: { type: 'string', nullable: true },
    created_by: { type: 'object', nullable: true, additionalProperties: true },
    can_edit: { type: 'boolean', description: 'The caller may change and delete it' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
} as const;

const idParams = {
  type: 'object',
  properties: { workspaceSlug: { type: 'string' }, templateId: { type: 'string' } },
} as const;

const fields = {
  name: { type: 'string', minLength: 1, maxLength: 80 },
  data: issueFieldsShape,
  due_in_days: {
    type: 'integer',
    minimum: 0,
    maximum: 365,
    nullable: true,
    description: 'The issue is due this many days after it is created; null — no deadline',
  },
} as const;

const id = (r: FastifyRequest) => (r.params as { templateId: string }).templateId;

export async function templateRoutes(app: FastifyInstance): Promise<void> {
  const member = [authenticate, requireWorkspaceMember()];

  app.get(
    '/',
    {
      schema: {
        tags,
        summary: 'Templates: the workspace ones and those of the projects I see',
        description:
          'With `project_id` — the templates usable in that project: the workspace ones and its own. ' +
          'Workspace templates first, then by name.',
        security,
        querystring: { type: 'object', properties: { project_id: { type: 'string' } } },
        response: {
          200: { type: 'object', properties: { data: { type: 'array', items: templateShape } } },
        },
      },
      preHandler: member,
    },
    async (request) =>
      listTemplates(
        app.prisma,
        request.workspace.id,
        request.workspaceMember,
        TemplateQuerySchema.parse(request.query),
      ),
  );

  app.get(
    '/:templateId',
    {
      schema: {
        tags,
        summary: 'One template',
        security,
        params: idParams,
        response: { 200: templateShape },
      },
      preHandler: member,
    },
    async (request) =>
      getTemplate(app.prisma, request.workspace.id, request.workspaceMember, id(request)),
  );

  app.post(
    '/',
    {
      schema: {
        tags,
        summary: 'Create a template',
        description:
          'Without `project_id` — a workspace template: admins and the owner only (403), no labels. ' +
          'With it — a template of that project: any member who may create issues.',
        security,
        body: {
          type: 'object',
          required: ['name', 'data'],
          properties: { ...fields, project_id: { type: 'string', nullable: true } },
        },
        response: { 201: templateShape },
      },
      preHandler: member,
    },
    async (request, reply) => {
      const template = await createTemplate(
        app.prisma,
        request.workspace.id,
        request.workspaceMember,
        CreateTemplateBodySchema.parse(request.body),
      );
      reply.code(201).send(template);
    },
  );

  app.patch(
    '/:templateId',
    {
      schema: {
        tags,
        summary: 'Change a template (its author or an admin; a workspace one — admins)',
        security,
        params: idParams,
        body: { type: 'object', properties: fields },
        response: { 200: templateShape },
      },
      preHandler: member,
    },
    async (request) =>
      updateTemplate(
        app.prisma,
        request.workspace.id,
        request.workspaceMember,
        id(request),
        UpdateTemplateBodySchema.parse(request.body ?? {}),
      ),
  );

  app.delete(
    '/:templateId',
    {
      schema: {
        tags,
        summary: 'Delete a template',
        security,
        params: idParams,
        response: { 204: { type: 'null' } },
      },
      preHandler: member,
    },
    async (request, reply) => {
      await deleteTemplate(app.prisma, request.workspace.id, request.workspaceMember, id(request));
      reply.code(204).send();
    },
  );

  app.post(
    '/:templateId/apply',
    {
      schema: {
        tags,
        summary: 'Create an issue from the template now',
        description:
          'Through the same rules as POST …/issues, by the caller: the project’s default state, the deadline ' +
          'today (workspace zone) + `due_in_days`, the checklist. `project_id` is required for a workspace ' +
          'template; `title` replaces the template’s title for this issue. Returns the issue (201).',
        security,
        params: idParams,
        body: {
          type: 'object',
          properties: {
            project_id: { type: 'string', format: 'uuid' },
            title: { type: 'string', minLength: 1, maxLength: 500 },
          },
        },
      },
      preHandler: member,
    },
    async (request, reply) => {
      const issue = await applyTemplate(
        app.prisma,
        request.workspace,
        request.workspaceMember,
        id(request),
        ApplyTemplateBodySchema.parse(request.body ?? {}),
      );
      reply.code(201).send(issue);
    },
  );
}
