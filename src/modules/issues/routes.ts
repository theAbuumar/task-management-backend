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
import { BulkBodySchema, MAX_BULK, bulkUpdateIssues } from './bulk.js';
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

  // Массовые операции (6.B6).
  app.post(
    '/bulk',
    {
      schema: {
        tags: ['Issues'],
        summary: 'Change many issues at once',
        description:
          `Up to ${MAX_BULK} issues of the project: a state, a priority, a deadline (null clears it), ` +
          'an assignee (the issue’s assignees become exactly this person) or a label to add or remove. ' +
          'Each issue is changed through the regular rules, its rights and history included (a closed ' +
          'assignment needs its controller, 5.B3; an assignment’s deadline is the controller’s, 5.B5). ' +
          'Partial success: `{ updated: [ids], failed: [{ issue_id, code, message }] }`. A state or ' +
          'label not of this project, or an assignee who cannot be assigned, fails the whole request (400).',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['issue_ids'],
          properties: {
            issue_ids: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_BULK,
              items: { type: 'string', format: 'uuid' },
            },
            state_id: { type: 'string', format: 'uuid' },
            priority: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'urgent'] },
            due_date: { type: 'string', nullable: true },
            assignee_id: { type: 'string', format: 'uuid' },
            add_label_id: { type: 'string', format: 'uuid' },
            remove_label_id: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              updated: { type: 'array', items: { type: 'string' } },
              failed: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    issue_id: { type: 'string' },
                    code: { type: 'string' },
                    message: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      preHandler: member,
    },
    async (request) => {
      const { projectId } = request.params as { projectId: string };
      return bulkUpdateIssues(
        app.prisma,
        request.workspace.id,
        projectId,
        request.userId,
        BulkBodySchema.parse(request.body),
      );
    },
  );

  app.get('/:issueId', { schema: getIssueSchema, preHandler: member }, getIssueHandler);
  app.patch('/:issueId', { schema: updateIssueSchema, preHandler: member }, updateIssueHandler);
  app.delete(
    '/:issueId',
    {
      schema: deleteIssueSchema,
      preHandler: member,
      config: { audit: { action: 'issue.deleted', target: 'issue', param: 'issueId' } },
    },
    deleteIssueHandler,
  );

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
