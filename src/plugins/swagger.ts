// OpenAPI docs.
//
// Registers @fastify/swagger to build the OpenAPI document from each route's
// JSON schema, and @fastify/swagger-ui to serve interactive docs at `/docs`.
// Must be registered BEFORE the routes it should document. A bearer-auth scheme
// is declared up front so Phase 1 auth-protected routes can reference it.

import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

async function swaggerPlugin(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Task Management API',
        description: 'Plane/Jira-inspired multi-tenant task management REST API.',
        version: '0.1.0',
      },
      servers: [{ url: '/api/v1', description: 'API v1 base path' }],
      tags: [
        {
          name: 'Health',
          description:
            'Probes outside `/api/v1`: `GET /health` (liveness) and `GET /ready` (readiness). Every response of the API carries `X-Request-Id`; a 500 repeats it in `error.details.requestId`, and every log line of the request has it as `reqId`.',
        },
        {
          name: 'AI',
          description:
            "AI assistant (Ф11, ADR-028). Off unless `AI_ENABLED=true` — then every route but `GET …/ai/status` answers `404 AI_DISABLED`, and so it does for guests. AI only proposes: drafts, summaries and memos are shown to a person, who creates or downloads them. Data goes to the model within the caller's rights only; texts written by people are passed as data, never as instructions. Each user has a daily limit (`AI_DAILY_LIMIT`, `429 AI_LIMIT_REACHED`); every call is logged without its texts.",
        },
        {
          name: 'Invitations',
          description:
            'Personal inbox for workspace invitations that target already-registered users. Not workspace-scoped: the recipient is not yet a member. Admins create these via `POST /workspaces/{slug}/members/invite-user` (tagged Workspaces); delivery fans out to email and Telegram.',
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });
}

export default fp(swaggerPlugin, { name: 'swagger' });
