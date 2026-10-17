import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import {
  listIssuesSchema,
  createIssueSchema,
  getIssueSchema,
  updateIssueSchema,
  deleteIssueSchema,
  addAssigneeSchema,
  removeAssigneeSchema,
  addLabelSchema,
  removeLabelSchema,
  distributeIssueSchema,
  DistributeBodySchema,
} from './schema.js';
import { distributeIssue } from './distribution.js';
import {
  listIssuesHandler,
  createIssueHandler,
  getIssueHandler,
  updateIssueHandler,
  deleteIssueHandler,
  addAssigneeHandler,
  removeAssigneeHandler,
  addLabelHandler,
  removeLabelHandler,
} from './controller.js';

export async function issueRoutes(app: FastifyInstance): Promise<void> {
  const member = [authenticate, requireWorkspaceMember()];

  app.get('/', { schema: listIssuesSchema, preHandler: member }, listIssuesHandler);
  app.post('/', { schema: createIssueSchema, preHandler: member }, createIssueHandler);
  // Рассылка подразделениям (6.B1).
  app.post(
    '/distribute',
    { schema: distributeIssueSchema, preHandler: member },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const parent = await distributeIssue(
        app.prisma,
        request.workspace.id,
        projectId,
        request.userId,
        DistributeBodySchema.parse(request.body),
      );
      reply.code(201).send(parent);
    },
  );

  app.get('/:issueId', { schema: getIssueSchema, preHandler: member }, getIssueHandler);
  app.patch('/:issueId', { schema: updateIssueSchema, preHandler: member }, updateIssueHandler);
  app.delete('/:issueId', { schema: deleteIssueSchema, preHandler: member }, deleteIssueHandler);

  // Assignees
  app.post(
    '/:issueId/assignees',
    { schema: addAssigneeSchema, preHandler: member },
    addAssigneeHandler,
  );
  app.delete(
    '/:issueId/assignees/:userId',
    { schema: removeAssigneeSchema, preHandler: member },
    removeAssigneeHandler,
  );

  // Labels
  app.post('/:issueId/labels', { schema: addLabelSchema, preHandler: member }, addLabelHandler);
  app.delete(
    '/:issueId/labels/:labelId',
    { schema: removeLabelSchema, preHandler: member },
    removeLabelHandler,
  );
}
