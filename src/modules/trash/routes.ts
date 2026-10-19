// `/api/v1/workspaces/:workspaceSlug/trash` — корзина (Ф7 7.B6, ADR-017):
// the list, «Восстановить» and «Удалить навсегда». Rules live in the service;
// every restore and removal goes to the audit log with the item's name, so the
// entry stays readable after the row itself is gone.

import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import { writeAudit } from '../../lib/audit.js';
import {
  TRASH_RETENTION_DAYS,
  TrashQuerySchema,
  TrashTypeSchema,
  listTrash,
  purgeFromTrash,
  restoreFromTrash,
  type TrashResult,
} from './service.js';

const itemParams = {
  type: 'object',
  required: ['workspaceSlug', 'type', 'id'],
  properties: {
    workspaceSlug: { type: 'string' },
    type: { type: 'string', enum: ['issue', 'project'] },
    id: { type: 'string', format: 'uuid' },
  },
} as const;

const resultSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['issue', 'project'] },
    id: { type: 'string' },
    name: { type: 'string' },
    key: { type: 'string' },
    project_id: { type: 'string' },
  },
} as const;

export async function trashRoutes(app: FastifyInstance): Promise<void> {
  const member = [authenticate, requireWorkspaceMember()];

  app.get(
    '/',
    {
      schema: {
        tags: ['Trash'],
        summary: 'Deleted issues and projects (the trash)',
        description: [
          `Newest first. Items stay for ${TRASH_RETENTION_DAYS} days (\`purge_at\`), then the scheduler removes them for good.`,
          'Admins and the owner see everything; a member sees the issues they deleted themselves',
          '(in projects they can see). An issue of a deleted project is not listed separately: it comes back with the project.',
          'Filter by `type`. Cursor pagination: pass `next_cursor` as `cursor`.',
        ].join(' '),
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { workspaceSlug: { type: 'string' } } },
        querystring: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['issue', 'project'] },
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
                    type: { type: 'string', enum: ['issue', 'project'] },
                    id: { type: 'string' },
                    name: { type: 'string' },
                    key: { type: 'string' },
                    kind: { type: ['string', 'null'] },
                    project: {
                      type: ['object', 'null'],
                      properties: {
                        id: { type: 'string' },
                        name: { type: 'string' },
                        identifier: { type: 'string' },
                      },
                    },
                    deleted_at: { type: 'string', format: 'date-time' },
                    deleted_by: {
                      type: ['object', 'null'],
                      properties: { id: { type: 'string' }, display_name: { type: 'string' } },
                    },
                    purge_at: { type: 'string', format: 'date-time' },
                    can_restore: { type: 'boolean' },
                    can_purge: { type: 'boolean' },
                  },
                },
              },
              next_cursor: { type: ['string', 'null'] },
              retention_days: { type: 'integer' },
            },
          },
        },
      },
      preHandler: member,
    },
    async (request) =>
      listTrash(
        app.prisma,
        request.workspace.id,
        request.workspaceMember,
        TrashQuerySchema.parse(request.query),
      ),
  );

  const audit = (
    request: Parameters<typeof writeAudit>[2],
    action: 'restored' | 'purged',
    item: TrashResult,
  ) =>
    writeAudit(
      app.prisma,
      {
        workspace_id: request!.workspace.id,
        actor_id: request!.userId,
        action: `${item.type}.${action}`,
        target_type: item.type,
        target_id: item.id,
        meta: {
          title: item.type === 'issue' ? `${item.key} ${item.name}` : `${item.name} (${item.key})`,
        },
      },
      request,
    );

  app.post(
    '/:type/:id/restore',
    {
      schema: {
        tags: ['Trash'],
        summary: 'Restore an issue or a project from the trash',
        description: [
          'Admins restore anything; a member restores the issues they deleted themselves (403 otherwise).',
          'An issue whose project is in the trash answers 409 PROJECT_IN_TRASH — restore the project first.',
          'The issue history gets an `issue.restored` entry; the audit log gets `issue.restored` / `project.restored`.',
        ].join(' '),
        security: [{ bearerAuth: [] }],
        params: itemParams,
        response: { 200: resultSchema },
      },
      preHandler: member,
    },
    async (request) => {
      const { type, id } = request.params as { type: string; id: string };
      const item = await restoreFromTrash(
        app.prisma,
        request.workspace.id,
        request.workspaceMember,
        TrashTypeSchema.parse(type),
        id,
      );
      await audit(request, 'restored', item);
      return item;
    },
  );

  app.delete(
    '/:type/:id',
    {
      schema: {
        tags: ['Trash'],
        summary: 'Delete for good (admin+)',
        description: [
          'Removes the issue (its sub-issues stay, without a parent) or the project with all its issues,',
          'and their files. Only for items already in the trash. Written to the audit log as',
          '`issue.purged` / `project.purged` with the name.',
        ].join(' '),
        security: [{ bearerAuth: [] }],
        params: itemParams,
        response: { 204: { type: 'null' } },
      },
      preHandler: member,
    },
    async (request, reply) => {
      const { type, id } = request.params as { type: string; id: string };
      const item = await purgeFromTrash(
        app.prisma,
        app.storage,
        request.workspace.id,
        request.workspaceMember,
        TrashTypeSchema.parse(type),
        id,
      );
      await audit(request, 'purged', item);
      reply.code(204).send();
    },
  );
}
