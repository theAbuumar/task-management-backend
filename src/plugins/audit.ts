// Audit plugin (Ф12 12.B1): a route that declares `config.audit` gets its
// successful calls written to the audit log — by whom, in which workspace, on
// what target, with the whitelisted request fields (lib/audit).
//
// The id of a created target (and the client IP) is taken in onSend — a
// synchronous hook, so it never delays the reply of handlers that call
// `reply.send()`; the entry is written in onResponse, once the reply is out.

import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { auditMeta, writeAudit } from '../lib/audit.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** `id` from the JSON response of an audited route (the created target). */
    auditResponseId?: string;
    /** Client IP, captured while the connection is still open. */
    auditIp?: string;
  }
}

async function auditPlugin(app: FastifyInstance): Promise<void> {
  app.addHook('onSend', (request, reply, payload, done) => {
    const cfg = request.routeOptions.config?.audit;
    if (cfg) request.auditIp = request.ip;
    if (cfg && reply.statusCode < 400 && typeof payload === 'string' && payload.startsWith('{')) {
      try {
        const id = (JSON.parse(payload) as { id?: unknown }).id;
        if (typeof id === 'string') request.auditResponseId = id;
      } catch {
        // not JSON — no id to take
      }
    }
    done(null, payload);
  });

  app.addHook('onResponse', async (request, reply) => {
    const cfg = request.routeOptions.config?.audit;
    if (!cfg || reply.statusCode >= 400) return;

    const params = (request.params ?? {}) as Record<string, string | undefined>;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const fromBody = cfg.bodyField ? body[cfg.bodyField] : undefined;
    const targetId =
      (cfg.param && params[cfg.param]) ||
      (typeof fromBody === 'string' ? fromBody : undefined) ||
      request.auditResponseId ||
      (cfg.self ? request.userId : undefined) ||
      (cfg.target === 'workspace' ? request.workspace?.id : undefined);

    await writeAudit(
      app.prisma,
      {
        workspace_id: request.workspace?.id ?? null,
        actor_id: request.userId || null,
        action: cfg.action,
        target_type: cfg.target,
        target_id: targetId ?? null,
        meta: auditMeta(request.body, request.method),
      },
      request,
      request.auditIp,
    );
  });
}

export default fp(auditPlugin, { name: 'audit', dependencies: ['prisma'] });
