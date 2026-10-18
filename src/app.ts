// Fastify application factory.
//
// `buildApp` constructs and configures the Fastify instance but does NOT call
// `listen` — that is the bootstrap's job (`server.ts`). Keeping construction
// separate from listening lets tests build an app and drive it via injection
// without binding a port.
//
// Plugins, hooks and feature modules register here: base plugins (error handler,
// CORS, helmet, swagger, cookies, rate limit, Prisma, storage, auth/workspace hooks)
// first, then the `/api/v1` module tree.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { LoggerOptions } from 'pino';
import { config, isDev } from './config/index.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import swaggerPlugin from './plugins/swagger.js';
import prismaPlugin from './plugins/prisma.js';
import storagePlugin from './plugins/storage.js';
import authPlugin from './plugins/auth-hook.js';
import workspacePlugin from './plugins/workspace-hook.js';
import schedulerPlugin from './plugins/scheduler.js';
import realtimePlugin from './plugins/realtime.js';
import auditPlugin from './plugins/audit.js';
import { authRoutes } from './modules/auth/routes.js';
import { demoRoutes } from './modules/auth/demo-routes.js';
import { providerRoutes } from './modules/auth/providers.js';
import { workspaceRoutes } from './modules/workspaces/routes.js';
import { projectRoutes } from './modules/projects/routes.js';
import { stateRoutes } from './modules/states/routes.js';
import { labelRoutes } from './modules/labels/routes.js';
import { issueRoutes } from './modules/issues/routes.js';
import { commentRoutes } from './modules/comments/routes.js';
import { cycleRoutes } from './modules/cycles/routes.js';
import { moduleRoutes } from './modules/modules/routes.js';
import { issueRelationRoutes } from './modules/issues/relations/routes.js';
import { activityRoutes } from './modules/activity/routes.js';
import { attachmentRoutes, attachmentDeleteRoutes } from './modules/attachments/routes.js';
import { notificationRoutes } from './modules/notifications/routes.js';
import { inviteRoutes } from './modules/invites/routes.js';
import { memberInviteRoutes } from './modules/member-invites/routes.js';
import { departmentRoutes } from './modules/departments/routes.js';
import { mediaRoutes } from './modules/media/routes.js';
import { workspaceIssueRoutes } from './modules/issues/workspace-routes.js';
import { controlRoutes } from './modules/control/routes.js';
import { controlAdminRoutes } from './modules/control/admin-routes.js';
import { meRoutes } from './modules/control/summary-routes.js';
import { analyticsRoutes } from './modules/analytics/routes.js';
import { invalidateAnalytics } from './modules/analytics/data.js';
import { eventRoutes } from './modules/events/routes.js';
import { auditRoutes } from './modules/audit/routes.js';

export interface BuildAppOptions {
  /** Pino logger options, or `false`/`true` to disable/enable the default logger. */
  logger?: LoggerOptions | boolean;
}

/**
 * Sensible default logger config derived from validated config. Pretty-prints in
 * development (via pino-pretty, a dev dependency) and emits structured JSON
 * everywhere else. Request IDs are enabled by Fastify out of the box (`reqId` on
 * every log line).
 */
function defaultLogger(): LoggerOptions | boolean {
  const level = config.LOG_LEVEL ?? (isDev ? 'debug' : 'info');

  if (isDev) {
    return {
      level,
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' },
      },
    };
  }

  return { level };
}

/**
 * Build a fully-wired (but not-yet-listening) Fastify instance.
 */
export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? defaultLogger(),
    // Trust the reverse proxy in front of us for client IPs / protocol.
    trustProxy: true,
    // Reject unknown content types early rather than silently.
    disableRequestLogging: false,
  });

  // --- Plugins ---------------------------------------------------------------
  // Order matters: the error handler is installed first so any later failure is
  // rendered as the standard envelope; swagger registers before routes so it can
  // capture their schemas; prisma decorates `app.prisma`. Remaining security
  // plugins follow (helmet right after CORS).
  await app.register(errorHandlerPlugin);
  if (config.NODE_ENV === 'production' && config.CORS_ORIGIN === '*') {
    // With credentials, `*` reflects ANY origin — a foreign site could then call
    // cookie-authenticated endpoints. Production must list the SPA origin(s).
    app.log.warn(
      'CORS_ORIGIN is "*" in production — set it to the frontend origin(s), e.g. https://tasks.example.edu',
    );
  }
  // CORS with credentials so a browser SPA on a different origin can call the API
  // and send/receive the httpOnly auth cookies (refresh token, tg_session). Allowed
  // origins come from CORS_ORIGIN (comma-separated). With credentials a literal `*`
  // is illegal, so `*` falls back to reflecting the request Origin.
  await app.register(cors, {
    origin: config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN.split(',').map((o) => o.trim()),
    credentials: true,
  });
  // Security headers. The CSP allows the inline script/style Swagger UI needs at
  // `/docs`; the API itself only returns JSON. CORP is `cross-origin` so files and
  // avatars can be embedded by the SPA when it is served from another origin.
  // No `upgrade-insecure-requests`: on a plain-http stand (laptop, ADR-024) it
  // rewrites Swagger's own scripts to https and `/docs` stays blank; HTTPS on the
  // cloud stand is enforced by Caddy's http→https redirect and helmet's HSTS.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(swaggerPlugin);
  // Parse/serialize cookies so the auth layer can deliver the refresh token as an
  // httpOnly cookie and read it back on refresh/logout (auth_tz.md §8). No signing
  // secret: the cookie value is a JWT already signed + verified against the DB.
  await app.register(cookie);
  // Per-IP rate limiting, registered globally-disabled: only routes that opt in via
  // `config.rateLimit` are limited (the sensitive auth/OTP endpoints — see
  // modules/auth/routes.ts). Keyed on the client IP (trustProxy resolves it behind
  // the proxy). On limit the plugin raises a 429 that the error handler renders as
  // the standard RATE_LIMITED envelope (see plugins/error-handler.ts).
  await app.register(rateLimit, { global: false });
  await app.register(prismaPlugin);
  await app.register(storagePlugin);
  await app.register(authPlugin);
  await app.register(workspacePlugin);
  await app.register(schedulerPlugin);
  await app.register(realtimePlugin);
  await app.register(auditPlugin);

  // Analytics keep loaded facts for a few minutes; any successful write inside a
  // workspace drops them so dashboards never lag behind a change (Ф10 10.B6).
  app.addHook('onResponse', async (request, reply) => {
    if (request.method === 'GET' || request.method === 'HEAD' || reply.statusCode >= 400) return;
    if (request.workspace) invalidateAnalytics(request.workspace.id);
  });

  // --- Routes ----------------------------------------------------------------
  // Liveness/readiness probe. Liveness always returns ok if the process is up;
  // readiness additionally pings the database so orchestrators don't route
  // traffic to an instance that can't reach its DB.
  app.get('/health', async (_request, reply) => {
    try {
      await app.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', uptime: process.uptime(), db: 'up' };
    } catch (err) {
      app.log.error({ err }, 'health check: database unreachable');
      return reply.status(503).send({ status: 'degraded', uptime: process.uptime(), db: 'down' });
    }
  });

  // Feature modules under /api/v1
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(demoRoutes, { prefix: '/api/v1/auth' });
  await app.register(providerRoutes, { prefix: '/api/v1/auth' });
  await app.register(workspaceRoutes, { prefix: '/api/v1/workspaces' });
  await app.register(projectRoutes, { prefix: '/api/v1/workspaces/:workspaceSlug/projects' });
  await app.register(workspaceIssueRoutes, {
    prefix: '/api/v1/workspaces/:workspaceSlug/issues',
  });
  await app.register(departmentRoutes, {
    prefix: '/api/v1/workspaces/:workspaceSlug/departments',
  });
  await app.register(stateRoutes, {
    prefix: '/api/v1/workspaces/:workspaceSlug/projects/:projectId/states',
  });
  await app.register(labelRoutes, {
    prefix: '/api/v1/workspaces/:workspaceSlug/projects/:projectId/labels',
  });
  await app.register(issueRoutes, {
    prefix: '/api/v1/workspaces/:workspaceSlug/projects/:projectId/issues',
  });
  await app.register(commentRoutes, {
    prefix: '/api/v1/workspaces/:workspaceSlug/projects/:projectId/issues/:issueId/comments',
  });
  await app.register(cycleRoutes, {
    prefix: '/api/v1/workspaces/:workspaceSlug/projects/:projectId/cycles',
  });
  await app.register(moduleRoutes, {
    prefix: '/api/v1/workspaces/:workspaceSlug/projects/:projectId/modules',
  });
  await app.register(issueRelationRoutes, {
    prefix: '/api/v1/workspaces/:workspaceSlug/projects/:projectId/issues/:issueId/relations',
  });
  await app.register(controlRoutes, {
    prefix: '/api/v1/workspaces/:workspaceSlug/projects/:projectId/issues/:issueId',
  });
  await app.register(controlAdminRoutes, {
    prefix: '/api/v1/workspaces/:workspaceSlug/control',
  });
  // The signed-in member's own counters (sidebar, «Мои задачи»).
  await app.register(meRoutes, { prefix: '/api/v1/workspaces/:workspaceSlug/me' });
  // Analytics and reports for the management (Ф10).
  await app.register(analyticsRoutes, { prefix: '/api/v1/workspaces/:workspaceSlug' });
  await app.register(activityRoutes, {
    prefix: '/api/v1/workspaces/:workspaceSlug/projects/:projectId/issues/:issueId/activity',
  });
  await app.register(attachmentRoutes, {
    prefix: '/api/v1/workspaces/:workspaceSlug/projects/:projectId/issues/:issueId/attachments',
  });
  await app.register(attachmentDeleteRoutes, {
    prefix: '/api/v1/workspaces/:workspaceSlug/projects/:projectId/attachments',
  });
  await app.register(notificationRoutes, {
    prefix: '/api/v1/workspaces/:workspaceSlug/notifications',
  });
  // Audit log for admins (Ф12 12.B1).
  await app.register(auditRoutes, { prefix: '/api/v1/workspaces/:workspaceSlug/audit' });
  // Live updates: bell, boards, the open issue (Ф8 8.B1).
  await app.register(eventRoutes, { prefix: '/api/v1/workspaces/:workspaceSlug/events' });
  await app.register(inviteRoutes, { prefix: '/api/v1/invites' });
  // Personal invitations inbox for invites that target existing users.
  await app.register(memberInviteRoutes, { prefix: '/api/v1/invitations' });
  // Avatars & workspace logos (presigned upload + stable public link).
  await app.register(mediaRoutes);

  return app;
}
