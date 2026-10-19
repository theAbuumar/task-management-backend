// Ограничение частоты (Ф12 12.B5): besides the sign-in endpoints (per IP, in
// modules/auth/routes.ts) every signed-in person gets three budgets per minute:
//   - changes inside workspaces (POST/PATCH/PUT/DELETE) — RATE_LIMIT_WRITES;
//   - report and memo exports (PDF, Excel, DOCX) — RATE_LIMIT_EXPORTS;
//   - searches of the command palette — SEARCHES_PER_MINUTE.
// Far above what a person clicks (the demo, the E2E suite and the rehearsal stay
// well below), low enough that a script cannot flood the database or the PDF
// renderer. Keyed by the user, not the IP: a whole university may sit behind one
// address. Each budget is shared by all routes of its kind.
//
// Over the budget: 429 RATE_LIMITED with `Retry-After` and `details.retry_after`
// (seconds). The check runs after authentication and input validation (appended
// to the route's preHandlers), so it never counts anonymous or malformed
// requests — those never reach the database writes it protects.

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import { config } from '../config/index.js';
import { AppError } from '../lib/errors.js';

export const SEARCHES_PER_MINUTE = 240;
const WINDOW_MS = 60_000;
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

type Kind = 'write' | 'export' | 'search';

/** Which budget a route spends, if any. */
export function limitKind(method: string, url: string): Kind | null {
  if (!url.startsWith('/api/v1/workspaces')) return null;
  if (/\/reports\/|\/report\.pdf$|\/ai\/report\/export$/.test(url)) return 'export';
  if (method === 'GET' && /\/search\/?$/.test(url)) return 'search';
  return WRITE_METHODS.has(method) ? 'write' : null;
}

const MESSAGES: Record<Kind, string> = {
  write: 'Too many changes in a minute — wait a little and try again',
  export: 'Too many report exports in a minute — wait a little and try again',
  search: 'Too many searches in a minute — wait a little and try again',
};

const perUser = (request: FastifyRequest) =>
  request.userId ? `user:${request.userId}` : `ip:${request.ip}`;

async function writeLimitsPlugin(app: FastifyInstance): Promise<void> {
  const limiters: Record<Kind, ReturnType<FastifyInstance['createRateLimit']>> = {
    write: app.createRateLimit({
      max: config.RATE_LIMIT_WRITES,
      timeWindow: WINDOW_MS,
      keyGenerator: perUser,
    }),
    export: app.createRateLimit({
      max: config.RATE_LIMIT_EXPORTS,
      timeWindow: WINDOW_MS,
      keyGenerator: perUser,
    }),
    search: app.createRateLimit({
      max: SEARCHES_PER_MINUTE,
      timeWindow: WINDOW_MS,
      keyGenerator: perUser,
    }),
  };

  app.addHook('onRoute', (route: RouteOptions) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const kind = methods.map((m) => limitKind(m, route.url)).find(Boolean);
    if (!kind) return;
    const limit = limiters[kind];
    const check = async (request: FastifyRequest, reply: FastifyReply) => {
      const result = await limit(request);
      if (result.isAllowed || !result.isExceeded) return;
      reply.header('retry-after', String(result.ttlInSeconds));
      throw new AppError(429, 'RATE_LIMITED', MESSAGES[kind], {
        retry_after: result.ttlInSeconds,
      });
    };
    const existing = route.preHandler;
    route.preHandler = [
      ...(Array.isArray(existing) ? existing : existing ? [existing] : []),
      check,
    ];
  });
}

export default fp(writeLimitsPlugin, { name: 'write-limits' });
