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
          name: 'Trash',
          description:
            'Корзина (ADR-017): deleting an issue or a project moves it here for 30 days (`deleted_at`, `deleted_by_id`); then the scheduler removes it for good. Restores and removals are written to the audit log.',
        },
        {
          name: 'Search',
          description:
            "Глобальный поиск (7.B2) for the command palette: issues by key or by words with Russian morphology (PostgreSQL full-text search), projects, people and departments of the workspace, within the caller's visibility.",
        },
        {
          name: 'Saved views',
          description:
            "Сохранённые виды (7.B4, ADR-029): a named set of page filters and a display mode. With `project_id` a view opens that project's board, without — the workspace list. Personal views are seen and changed by their author only; shared ones are seen by everyone who sees the project and managed by admins and the owner.",
        },
        {
          name: 'Drafts',
          description:
            'Черновики (7.B5): the create form saves itself as a personal draft while it is typed; «Опубликовать» turns it into an issue through the same rules as creating one.',
        },
        {
          name: 'Checklist',
          description:
            'Чек-лист задачи (6.B5, ADR-030): its steps, ticked with who and when. The issue keeps `checklist_total`/`checklist_done` for lists and boards. Every change but a reorder is written to the history; a guest only reads.',
        },
        {
          name: 'Recurring',
          description:
            'Повторяющиеся задачи (6.B4, ADR-030): a rule keeps the fields of an issue and a schedule in the workspace zone; the scheduler creates one issue per run on behalf of its author, never twice, and one for all runs missed while the server was off. «31-го» runs on the last day of a shorter month.',
        },
        {
          name: 'Templates',
          description:
            'Шаблоны задач (6.B3, ADR-030): typical issues with their controller, deadline offset and checklist — workspace-wide (admins manage them) or of one project. The create form fills itself from a template; `…/apply` creates the issue at once.',
        },
        {
          name: 'Activity',
          description:
            'History of an issue (`…/issues/:id/activity`) and the workspace feed (`GET /workspaces/:slug/activity`, 7.B3) for admins and department heads.',
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
