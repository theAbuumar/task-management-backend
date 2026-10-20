// Drafts of new issues (7.B5) — `/api/v1/workspaces/:workspaceSlug/drafts`.

import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import {
  CreateDraftBodySchema,
  MAX_DRAFTS,
  UpdateDraftBodySchema,
  createDraft,
  deleteDraft,
  getDraft,
  listDrafts,
  publishDraft,
  updateDraft,
} from './service.js';

const security = [{ bearerAuth: [] }];
const tags = ['Drafts'];

const data = {
  type: 'object',
  description:
    'The create form as typed: title, description, kind, state_id, priority, assignee_ids, ' +
    'primary_assignee_id, controller_id, requires_review, basis, label_ids, start_date, due_date, checklist — all optional',
  additionalProperties: true,
} as const;

const draftShape = {
  type: 'object',
  properties: {
    id: { type: 'string' },
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
    data,
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
} as const;

const idParams = {
  type: 'object',
  properties: { workspaceSlug: { type: 'string' }, draftId: { type: 'string' } },
} as const;

export async function draftRoutes(app: FastifyInstance): Promise<void> {
  const member = [authenticate, requireWorkspaceMember()];
  const id = (request: { params: unknown }) => (request.params as { draftId: string }).draftId;

  app.get(
    '/',
    {
      schema: {
        tags,
        summary: 'My drafts in this workspace, newest first',
        description:
          'Personal: only the author sees them. Drafts of projects the caller no longer sees are left out.',
        security,
        response: {
          200: { type: 'object', properties: { data: { type: 'array', items: draftShape } } },
        },
      },
      preHandler: member,
    },
    async (request) => listDrafts(app.prisma, request.workspace.id, request.workspaceMember),
  );

  app.get(
    '/:draftId',
    {
      schema: {
        tags,
        summary: 'One of my drafts (someone else’s — 404)',
        security,
        params: idParams,
        response: { 200: draftShape },
      },
      preHandler: member,
    },
    async (request) =>
      getDraft(app.prisma, request.workspace.id, request.workspaceMember, id(request)),
  );

  app.post(
    '/',
    {
      schema: {
        tags,
        summary: 'Save a draft of a new issue',
        description: `At most ${MAX_DRAFTS} drafts per person and workspace: past that the oldest one is removed.`,
        security,
        body: {
          type: 'object',
          properties: { project_id: { type: 'string', nullable: true }, data },
        },
        response: { 201: draftShape },
      },
      preHandler: member,
    },
    async (request, reply) => {
      const draft = await createDraft(
        app.prisma,
        request.workspace.id,
        request.workspaceMember,
        CreateDraftBodySchema.parse(request.body ?? {}),
      );
      reply.code(201).send(draft);
    },
  );

  app.patch(
    '/:draftId',
    {
      schema: {
        tags,
        summary: 'Update my draft (the form as typed replaces `data`)',
        security,
        params: idParams,
        body: {
          type: 'object',
          properties: { project_id: { type: 'string', nullable: true }, data },
        },
        response: { 200: draftShape },
      },
      preHandler: member,
    },
    async (request) =>
      updateDraft(
        app.prisma,
        request.workspace.id,
        request.workspaceMember,
        id(request),
        UpdateDraftBodySchema.parse(request.body ?? {}),
      ),
  );

  app.delete(
    '/:draftId',
    {
      schema: {
        tags,
        summary: 'Delete my draft',
        security,
        params: idParams,
        response: { 204: { type: 'null' } },
      },
      preHandler: member,
    },
    async (request, reply) => {
      await deleteDraft(app.prisma, request.workspace.id, request.workspaceMember, id(request));
      reply.code(204).send();
    },
  );

  app.post(
    '/:draftId/publish',
    {
      schema: {
        tags,
        summary: 'Publish a draft: it becomes an issue and is removed',
        description:
          'Created through the same rules as POST …/issues (state defaults to the project default). ' +
          'No project or title — 400 DRAFT_INCOMPLETE; invalid fields — 400 as on create.',
        security,
        params: idParams,
      },
      preHandler: member,
    },
    async (request, reply) => {
      const issue = await publishDraft(
        app.prisma,
        request.workspace.id,
        request.workspaceMember,
        id(request),
      );
      reply.code(201).send(issue);
    },
  );
}
