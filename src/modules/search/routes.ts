// `GET /api/v1/workspaces/:workspaceSlug/search` — глобальный поиск (Ф7 7.B2)
// for the command palette (Ctrl+K): issues, projects, people, departments.

import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import { SEARCH_TYPES, SearchQuerySchema, search } from './service.js';

const marked = { type: 'string', description: 'Matches wrapped in U+0001 … U+0002' } as const;

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/',
    {
      schema: {
        tags: ['Search'],
        summary: 'Search the workspace: issues, projects, people, departments',
        description: [
          'Issues: an exact key (`ACCR-12`) comes first; then words of the title and description with Russian',
          'morphology (PostgreSQL full-text search, `russian`; every word is a prefix, all words required) or a',
          'substring of the title; title matches rank higher. Projects by name or key, people by name or position,',
          'departments by name or short name — every word must match, in any order.',
          'Visibility as everywhere: no deleted items, private projects only for their members and admins.',
          'Matches are wrapped in U+0001 … U+0002 (`title_hl`, `snippet`, `name_hl`) — render them as text.',
          `\`types\` — comma-separated subset of ${SEARCH_TYPES.join(', ')}; \`limit\` — per type.`,
        ].join(' '),
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { workspaceSlug: { type: 'string' } } },
        querystring: {
          type: 'object',
          required: ['q'],
          properties: {
            q: { type: 'string', minLength: 1, maxLength: 200 },
            types: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              issues: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    key: { type: 'string' },
                    title: { type: 'string' },
                    title_hl: marked,
                    snippet: { ...marked, type: ['string', 'null'] },
                    kind: { type: 'string' },
                    project: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        name: { type: 'string' },
                        identifier: { type: 'string' },
                      },
                    },
                    state: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        group: { type: 'string' },
                        color: { type: 'string' },
                      },
                    },
                    due_date: { type: ['string', 'null'], format: 'date-time' },
                    completed_at: { type: ['string', 'null'], format: 'date-time' },
                  },
                },
              },
              projects: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    name_hl: marked,
                    identifier: { type: 'string' },
                    color: { type: ['string', 'null'] },
                  },
                },
              },
              people: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    user_id: { type: 'string' },
                    display_name: { type: 'string' },
                    name_hl: marked,
                    avatar_url: { type: ['string', 'null'] },
                    position: { type: ['string', 'null'] },
                    department: {
                      type: ['object', 'null'],
                      properties: { id: { type: 'string' }, name: { type: 'string' } },
                    },
                  },
                },
              },
              departments: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    name_hl: marked,
                    short_name: { type: ['string', 'null'] },
                    head: {
                      type: ['object', 'null'],
                      properties: { id: { type: 'string' }, display_name: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      preHandler: [authenticate, requireWorkspaceMember()],
    },
    async (request) =>
      search(
        app.prisma,
        request.workspace.id,
        request.workspaceMember,
        SearchQuerySchema.parse(request.query),
      ),
  );
}
