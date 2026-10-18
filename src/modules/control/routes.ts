import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import * as control from './service.js';
import {
  SubmitReviewBodySchema,
  DecideBodySchema,
  DeadlineRequestBodySchema,
  submitReviewSchema,
  approveReviewSchema,
  returnReviewSchema,
  listReviewsSchema,
  acknowledgeSchema,
  createDeadlineRequestSchema,
  decideDeadlineRequestSchema,
  listDeadlineRequestsSchema,
  watchersSchema,
} from './schema.js';

function ctx(request: FastifyRequest) {
  const { projectId, issueId } = request.params as { projectId: string; issueId: string };
  return { workspaceId: request.workspace.id, projectId, issueId, actorId: request.userId };
}

// Mounted at /api/v1/workspaces/:workspaceSlug/projects/:projectId/issues/:issueId.
// requireWorkspaceMember also enforces project visibility (private projects).
export async function controlRoutes(app: FastifyInstance): Promise<void> {
  const member = [authenticate, requireWorkspaceMember()];
  const prisma = app.prisma;

  app.post('/review/submit', { schema: submitReviewSchema, preHandler: member }, async (req) =>
    control.submitReview(prisma, ctx(req), SubmitReviewBodySchema.parse(req.body ?? {})),
  );
  app.post('/review/approve', { schema: approveReviewSchema, preHandler: member }, async (req) =>
    control.decideReview(prisma, ctx(req), 'approved', DecideBodySchema.parse(req.body ?? {})),
  );
  app.post('/review/return', { schema: returnReviewSchema, preHandler: member }, async (req) =>
    control.decideReview(prisma, ctx(req), 'returned', DecideBodySchema.parse(req.body ?? {})),
  );
  app.get('/reviews', { schema: listReviewsSchema, preHandler: member }, async (req) =>
    control.listReviews(prisma, ctx(req)),
  );

  app.post('/acknowledge', { schema: acknowledgeSchema, preHandler: member }, async (req) =>
    control.acknowledge(prisma, ctx(req)),
  );

  app.get(
    '/deadline-requests',
    { schema: listDeadlineRequestsSchema, preHandler: member },
    async (req) => control.listDeadlineRequests(prisma, ctx(req)),
  );
  app.post(
    '/deadline-requests',
    { schema: createDeadlineRequestSchema, preHandler: member },
    async (req, reply) => {
      const created = await control.requestDeadlineChange(
        prisma,
        ctx(req),
        DeadlineRequestBodySchema.parse(req.body),
      );
      return reply.code(201).send(created);
    },
  );
  app.post(
    '/deadline-requests/:requestId/approve',
    { schema: decideDeadlineRequestSchema, preHandler: member },
    async (req) => {
      const { requestId } = req.params as { requestId: string };
      return control.decideDeadlineChange(
        prisma,
        ctx(req),
        requestId,
        true,
        DecideBodySchema.parse(req.body ?? {}),
      );
    },
  );
  app.post(
    '/deadline-requests/:requestId/reject',
    { schema: decideDeadlineRequestSchema, preHandler: member },
    async (req) => {
      const { requestId } = req.params as { requestId: string };
      return control.decideDeadlineChange(
        prisma,
        ctx(req),
        requestId,
        false,
        DecideBodySchema.parse(req.body ?? {}),
      );
    },
  );

  app.get('/watchers', { schema: watchersSchema, preHandler: member }, async (req) =>
    control.listWatchers(prisma, ctx(req)),
  );
  app.post('/watchers', { schema: watchersSchema, preHandler: member }, async (req) =>
    control.watch(prisma, ctx(req)),
  );
  app.delete('/watchers/me', { schema: watchersSchema, preHandler: member }, async (req) =>
    control.unwatch(prisma, ctx(req)),
  );
}
