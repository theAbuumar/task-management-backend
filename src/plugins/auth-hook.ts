import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyAccessToken, type AccessTokenPayload } from '../lib/jwt.js';
import { AppError } from '../lib/errors.js';
import { isSessionLive } from '../modules/auth/sessions.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by the `authenticate` preHandler on protected routes. */
    userId: string;
    /** The sign-in session of the access token (Ф12 12.B2); null for pre-session tokens. */
    sessionId: string | null;
  }
}

/**
 * preHandler: verify the Bearer access token and set `request.userId`.
 * Add to any route that requires authentication:
 *   `{ preHandler: [authenticate] }`
 *
 * A token whose session was ended («Мои сессии», sign-out, deactivation by an
 * admin) is refused with `SESSION_REVOKED` right away, not when it expires.
 */
export async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    throw AppError.unauthorized('Missing or malformed Bearer token');
  }
  let payload: AccessTokenPayload;
  try {
    payload = verifyAccessToken(auth.slice(7));
  } catch {
    throw AppError.unauthorized('Invalid or expired access token');
  }
  if (payload.sid && !(await isSessionLive(request.server.prisma, payload.sid))) {
    throw new AppError(401, 'SESSION_REVOKED', 'This session has been ended');
  }
  request.userId = payload.sub;
  request.sessionId = payload.sid ?? null;
}

async function authPlugin(app: FastifyInstance): Promise<void> {
  // Initialize the decorators so Fastify knows the shape before any preHandler sets them.
  app.decorateRequest('userId', '');
  app.decorateRequest('sessionId', null);
}

export default fp(authPlugin, { name: 'auth' });
