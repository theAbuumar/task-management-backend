// AI assistant routes (Ф11). Workspace part at /api/v1/workspaces/:workspaceSlug/ai,
// the issue summary under the issue path (the workspace hook checks the project's
// visibility there). AI is off by default (AI_ENABLED, ADR-028): the routes stay
// registered and answer 404 AI_DISABLED, `status` says `enabled: false`.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import { ask, deleteConversation, getConversation, listConversations } from './ask.js';
import { draftIssues } from './drafts.js';
import { exportMemo, generateMemo } from './report.js';
import { summarizeIssue } from './summary.js';
import { assertAiAvailable, status, type AiContext } from './service.js';
import {
  AskBodySchema,
  DraftIssuesBodySchema,
  MemoBodySchema,
  MemoExportBodySchema,
  askSchema,
  deleteConversationSchema,
  draftIssuesSchema,
  getConversationSchema,
  listConversationsSchema,
  memoExportSchema,
  memoSchema,
  statusSchema,
  summarySchema,
} from './schema.js';

/** Calls that reach the model, per IP, on top of the per-user daily limit. */
const aiRateLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } };
/** A 10 MB file in base64 plus JSON. */
const DRAFT_BODY_LIMIT = 15 * 1024 * 1024;

function contextOf(request: FastifyRequest): AiContext {
  return {
    prisma: request.server.prisma,
    workspace: request.workspace,
    member: request.workspaceMember,
    log: request.log,
  };
}

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  const member = [authenticate, requireWorkspaceMember()];

  app.get('/status', { schema: statusSchema, preHandler: member }, async (request) =>
    status(contextOf(request)),
  );

  app.post(
    '/draft-issues',
    {
      schema: draftIssuesSchema,
      preHandler: member,
      bodyLimit: DRAFT_BODY_LIMIT,
      config: aiRateLimit,
    },
    async (request) => draftIssues(contextOf(request), DraftIssuesBodySchema.parse(request.body)),
  );

  app.post(
    '/report',
    { schema: memoSchema, preHandler: member, config: aiRateLimit },
    async (request) =>
      generateMemo(contextOf(request), { ...MemoBodySchema.parse(request.body ?? {}), limit: 10 }),
  );

  app.post(
    '/report/export',
    { schema: memoExportSchema, preHandler: member },
    async (request, reply) => {
      const ctx = contextOf(request);
      assertAiAvailable(ctx.member);
      const file = await exportMemo(ctx, request, MemoExportBodySchema.parse(request.body));
      return reply
        .header('Content-Type', file.type)
        .header(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        )
        .header('Cache-Control', 'no-store')
        .send(file.bytes);
    },
  );

  app.post(
    '/ask',
    { schema: askSchema, preHandler: member, config: aiRateLimit },
    async (request) => ask(contextOf(request), AskBodySchema.parse(request.body)),
  );

  app.get(
    '/conversations',
    { schema: listConversationsSchema, preHandler: member },
    async (request) => {
      const ctx = contextOf(request);
      assertAiAvailable(ctx.member);
      return listConversations(ctx);
    },
  );

  app.get(
    '/conversations/:id',
    { schema: getConversationSchema, preHandler: member },
    async (request) => {
      const ctx = contextOf(request);
      assertAiAvailable(ctx.member);
      return getConversation(ctx, (request.params as { id: string }).id);
    },
  );

  app.delete(
    '/conversations/:id',
    { schema: deleteConversationSchema, preHandler: member },
    async (request, reply) => {
      const ctx = contextOf(request);
      assertAiAvailable(ctx.member);
      await deleteConversation(ctx, (request.params as { id: string }).id);
      return reply.status(204).send();
    },
  );
}

/** `POST …/projects/:projectId/issues/:issueId/ai/summary` (11.B3). */
export async function aiIssueRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/summary',
    {
      schema: summarySchema,
      preHandler: [authenticate, requireWorkspaceMember()],
      config: aiRateLimit,
    },
    async (request) => {
      const { projectId, issueId } = request.params as { projectId: string; issueId: string };
      return summarizeIssue(contextOf(request), projectId, issueId);
    },
  );
}
