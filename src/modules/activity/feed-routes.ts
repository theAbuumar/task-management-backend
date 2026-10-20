// `GET /api/v1/workspaces/:workspaceSlug/activity` — the workspace feed (7.B3).

import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import { FEED_TYPES, FeedQuerySchema, listWorkspaceActivity } from './feed.js';

const person = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    display_name: { type: 'string' },
    avatar_url: { type: 'string', nullable: true },
  },
} as const;

const ids = { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } as const;

export async function workspaceActivityRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/',
    {
      schema: {
        tags: ['Activity'],
        summary: 'Workspace activity feed (admins and department heads)',
        description:
          'Who did what across all projects, newest first (7.B3). An admin sees every project they can ' +
          'open; a department head — the work of the departments they head with sub-departments (an ' +
          'issue belongs to a department as in analytics: addressed to it, or its primary assignee ' +
          'works there). Others get 403 ACTIVITY_FORBIDDEN. Filters combine with AND: `project`, ' +
          '`department` (with subtree), `actor`, `from`/`to` (local dates in the workspace time zone, ' +
          'inclusive) and `type` (several = any of them): created, state, review (hand-ins, decisions, ' +
          'acknowledgements), deadline, people (assignees, controller), comments, files, trash. Rows ' +
          'about a trashed task stay, with `issue.deleted_at`. `old_label`/`new_label` carry the name ' +
          'of a state, person or label the value refers to.',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { workspaceSlug: { type: 'string' } } },
        querystring: {
          type: 'object',
          properties: {
            type: {
              anyOf: [
                { type: 'string', enum: FEED_TYPES },
                { type: 'array', items: { type: 'string', enum: FEED_TYPES } },
              ],
            },
            project: ids,
            department: ids,
            actor: { type: 'string' },
            from: { type: 'string', description: 'YYYY-MM-DD' },
            to: { type: 'string', description: 'YYYY-MM-DD' },
            cursor: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          },
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
                    action: { type: 'string' },
                    field: { type: 'string', nullable: true },
                    old_value: { type: 'string', nullable: true },
                    new_value: { type: 'string', nullable: true },
                    old_label: { type: 'string', nullable: true },
                    new_label: { type: 'string', nullable: true },
                    created_at: { type: 'string', format: 'date-time' },
                    actor: person,
                    issue: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        sequence_id: { type: 'integer' },
                        title: { type: 'string' },
                        kind: { type: 'string' },
                        deleted_at: { type: 'string', format: 'date-time', nullable: true },
                        project: {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            name: { type: 'string' },
                            identifier: { type: 'string' },
                            icon: { type: 'string', nullable: true },
                            color: { type: 'string', nullable: true },
                          },
                        },
                      },
                    },
                  },
                },
              },
              next_cursor: { type: 'string', nullable: true },
            },
          },
        },
      },
      preHandler: [authenticate, requireWorkspaceMember()],
    },
    async (request) =>
      listWorkspaceActivity(
        app.prisma,
        request.workspace,
        request.workspaceMember,
        FeedQuerySchema.parse(request.query),
      ),
  );
}
