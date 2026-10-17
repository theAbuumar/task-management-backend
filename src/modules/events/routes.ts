// Server-Sent Events stream of a workspace (Ф8 8.B1, ADR-010):
// `GET /api/v1/workspaces/:workspaceSlug/events`.
//
// Authorized like any workspace route (Bearer + membership); what each event may
// reveal is filtered per subscriber in plugins/realtime.ts. The stream ends when
// the access token expires, so a revoked session cannot keep listening: the
// client refreshes its token and reconnects with `Last-Event-ID`.

import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import { HEARTBEAT_MS, RealtimeHub } from '../../plugins/realtime.js';
import { verifyAccessToken } from '../../lib/jwt.js';
import { AppError } from '../../lib/errors.js';

const EVENT_TYPES = [
  'notification.created',
  'issue.created',
  'issue.updated',
  'issue.deleted',
  'comment.created',
  'comment.updated',
  'comment.deleted',
  'review.submitted',
  'review.approved',
  'review.returned',
];

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/',
    {
      schema: {
        tags: ['Events'],
        summary: 'Live events of the workspace (Server-Sent Events)',
        description: [
          'Opens a `text/event-stream`. Every message has `event:` = type and `data:` = JSON',
          '`{ id, type, workspace_id, issue_id, project_id, actor: { id, display_name } | null, fields?, notification_type?, at }`.',
          `Types: ${EVENT_TYPES.map((t) => `\`${t}\``).join(', ')}.`,
          'Service events: `ready` (stream is live), `resync` (events were missed — reload the data you show).',
          'A subscriber receives only what it may see: `notification.created` goes to its recipients;',
          'issue, comment and review events to members who see the issue’s project (private projects — their members and admins).',
          `A \`: ping\` comment is sent every ${HEARTBEAT_MS / 1000} s. Send \`Last-Event-ID\` on reconnect to get missed events.`,
          'The stream closes when the access token expires; reconnect with a fresh token.',
          'Behind nginx disable buffering for this path (`proxy_buffering off;` — the response also sets `X-Accel-Buffering: no`).',
        ].join(' '),
        security: [{ bearerAuth: [] }],
        produces: ['text/event-stream'],
        params: {
          type: 'object',
          properties: { workspaceSlug: { type: 'string' } },
        },
        querystring: {
          type: 'object',
          properties: {
            last_event_id: {
              type: 'string',
              description: 'Alternative to the `Last-Event-ID` header.',
            },
          },
        },
      },
      preHandler: [authenticate, requireWorkspaceMember()],
    },
    async (request, reply) => {
      try {
        await app.realtime.ensureListening();
      } catch (err) {
        request.log.error({ err }, 'realtime: cannot LISTEN');
        throw new AppError(503, 'REALTIME_UNAVAILABLE', 'Live updates are temporarily unavailable');
      }

      const token = request.headers.authorization!.slice(7);
      const { exp } = verifyAccessToken(token) as { exp?: number };
      const lastEventId =
        (request.headers['last-event-id'] as string | undefined) ??
        (request.query as { last_event_id?: string }).last_event_id;

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        // CORS and security headers set by the plugins on this reply.
        ...(reply.getHeaders() as Record<string, string>),
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      raw.write('retry: 3000\n\n');

      const unsubscribe = await app.realtime.subscribe(
        {
          userId: request.userId,
          role: request.workspaceMember.role,
          workspaceId: request.workspace.id,
          raw,
          privateAccess: new Map(),
        },
        lastEventId,
      );
      const heartbeat = setInterval(() => RealtimeHub.heartbeat(raw), HEARTBEAT_MS);
      const expiry = exp
        ? setTimeout(() => raw.end(), Math.max(exp * 1000 - Date.now(), 1000))
        : null;

      const cleanup = () => {
        clearInterval(heartbeat);
        if (expiry) clearTimeout(expiry);
        unsubscribe();
      };
      raw.on('close', cleanup);
      if (raw.destroyed) cleanup();
    },
  );
}
