// Personal, workspace-scoped endpoints for the signed-in member (Ф5 5.F6).
// Mounted at /api/v1/workspaces/:workspaceSlug/me.

import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import { mySummary } from './summary.js';

const counter = { type: 'integer', minimum: 0 } as const;

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/summary',
    {
      schema: {
        tags: ['Execution control'],
        summary: 'My work counters: assigned, overdue, on control, waiting for my review…',
        description:
          'COUNT-only summary for the sidebar and «Мои задачи». Open = state group backlog/unstarted/started/review. ' +
          'Deadline days are computed in the workspace time zone. `control` — open assignments where I am the controller ' +
          '(or the author when there is none); `review_pending` — issues in a review state that I decide on. ' +
          'Private projects the caller cannot see are not counted.',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { workspaceSlug: { type: 'string' } } },
        response: {
          200: {
            type: 'object',
            properties: {
              assigned: counter,
              overdue: counter,
              due_today: counter,
              unacknowledged: counter,
              control: counter,
              control_overdue: counter,
              review_pending: counter,
              watching: counter,
              unread_notifications: counter,
            },
          },
        },
      },
      preHandler: [authenticate, requireWorkspaceMember()],
    },
    async (request) => mySummary(app.prisma, request.workspace, request.workspaceMember),
  );
}
