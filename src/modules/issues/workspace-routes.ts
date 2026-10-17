// Workspace-level issue routes (`/api/v1/workspaces/:workspaceSlug/issues/...`),
// i.e. not tied to a project in the URL. Today: resolve a human key like
// `ACCR-12` for deep links from emails / Telegram (Ф2 2.B1).

import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember, seesAllProjects } from '../../plugins/workspace-hook.js';
import { AppError } from '../../lib/errors.js';
import * as issueService from './service.js';

const KEY_PATTERN = /^([A-Za-z0-9]{1,10})-(\d{1,9})$/;

export async function workspaceIssueRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/by-key/:key',
    {
      schema: {
        tags: ['Issues'],
        summary: 'Find an issue by its key, e.g. ACCR-12 (for deep links)',
        description:
          'Respects project visibility: a private project the caller cannot see answers 404.',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          properties: { workspaceSlug: { type: 'string' }, key: { type: 'string' } },
        },
      },
      preHandler: [authenticate, requireWorkspaceMember()],
    },
    async (request) => {
      const { key } = request.params as { key: string };
      const match = KEY_PATTERN.exec(key);
      if (!match) throw AppError.badRequest('Issue key must look like ABC-12');
      const [, identifier, seq] = match;

      const project = await app.prisma.project.findFirst({
        where: {
          workspace_id: request.workspace.id,
          identifier: identifier!.toUpperCase(),
          deleted_at: null,
        },
        select: { id: true, visibility: true },
      });
      if (!project) throw AppError.notFound('Issue not found');
      if (project.visibility === 'private' && !seesAllProjects(request.workspaceMember)) {
        const membership = await app.prisma.projectMember.findUnique({
          where: { project_id_user_id: { project_id: project.id, user_id: request.userId } },
        });
        if (!membership) throw AppError.notFound('Issue not found');
      }

      const issue = await app.prisma.issue.findFirst({
        where: { project_id: project.id, sequence_id: Number(seq), deleted_at: null },
        select: { id: true },
      });
      if (!issue) throw AppError.notFound('Issue not found');
      return issueService.getIssue(app.prisma, request.workspace.id, project.id, issue.id);
    },
  );
}
