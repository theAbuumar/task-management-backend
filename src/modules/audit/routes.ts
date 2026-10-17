// `GET /api/v1/workspaces/:workspaceSlug/audit` — the audit log (Ф12 12.B1),
// admins and the owner only. There is deliberately no way to change or delete
// an entry: the table itself rejects UPDATE and DELETE.

import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import { AUDIT_GROUPS, AuditQuerySchema, listAudit } from './service.js';

const groupList = Object.entries(AUDIT_GROUPS)
  .map(([group, actions]) => `\`${group}\` (${actions.join(', ')})`)
  .join('; ');

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/',
    {
      schema: {
        tags: ['Audit'],
        summary: 'Audit log of the workspace (admin+)',
        description: [
          'Who did what and when, newest first: sign-ins and sign-outs of the members, role and department changes,',
          'invitations, deletions, report exports, settings changes. Entries are immutable.',
          `Filter by \`group\`: ${groupList}; or by exact \`action\`, \`actor_id\`, \`from\`/\`to\` (ISO).`,
          'Cursor pagination: pass `next_cursor` as `cursor`.',
        ].join(' '),
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { workspaceSlug: { type: 'string' } } },
        querystring: {
          type: 'object',
          properties: {
            group: { type: 'string', enum: Object.keys(AUDIT_GROUPS) },
            action: { type: 'string' },
            actor_id: { type: 'string', format: 'uuid' },
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
            cursor: { type: 'string', format: 'uuid' },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
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
                    created_at: { type: 'string', format: 'date-time' },
                    action: { type: 'string' },
                    actor: {
                      type: ['object', 'null'],
                      properties: { id: { type: 'string' }, display_name: { type: 'string' } },
                    },
                    target: {
                      type: ['object', 'null'],
                      properties: {
                        type: { type: 'string' },
                        id: { type: ['string', 'null'] },
                        name: { type: ['string', 'null'] },
                      },
                    },
                    meta: { type: ['object', 'null'], additionalProperties: true },
                    ip: { type: ['string', 'null'] },
                    user_agent: { type: ['string', 'null'] },
                  },
                },
              },
              next_cursor: { type: ['string', 'null'] },
            },
          },
        },
      },
      preHandler: [authenticate, requireWorkspaceMember('admin')],
    },
    async (request) =>
      listAudit(
        app.prisma,
        request.workspace.id,
        request.workspaceMember,
        AuditQuerySchema.parse(request.query),
      ),
  );
}
