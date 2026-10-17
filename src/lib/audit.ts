// Audit log (Ф12 12.B1): who did what and when, for the questions a commission
// asks — «кто поменял роль», «кто удалил», «кто выгрузил отчёт», «кто входил».
//
// Two ways in:
//   - workspace routes declare `config: { audit: { action, target } }` and the
//     audit plugin (plugins/audit.ts) writes the entry once the route succeeded;
//   - sign-in and sign-out, which have no workspace, call `auditLogin` /
//     `writeAudit` directly.
// Rows are append-only (a DB trigger rejects UPDATE/DELETE) and have no foreign
// keys, so they outlive deleted workspaces and users; the actor's name is stored
// as a snapshot. A failed audit write is logged and never fails the action.

import type { FastifyRequest } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';

export type AuditTarget =
  | 'workspace'
  | 'user'
  | 'department'
  | 'project'
  | 'issue'
  | 'attachment'
  | 'invite'
  | 'report'
  | 'settings';

export interface AuditInput {
  workspace_id?: string | null;
  actor_id?: string | null;
  action: string;
  target_type?: AuditTarget | null;
  target_id?: string | null;
  meta?: Record<string, unknown> | null;
}

/** Route option: what a successful call of this route means for the audit log. */
export interface AuditRouteConfig {
  action: string;
  target: AuditTarget;
  /** Route param with the target id (default: `id` of the JSON response). */
  param?: string;
  /** Body field with the target id, e.g. `user_id` when adding a member. */
  bodyField?: string;
  /** The target is the caller (leaving a workspace). */
  self?: boolean;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    audit?: AuditRouteConfig;
  }
}

/** Request fields that are safe and useful to keep (never tokens, codes, passwords). */
const META_FIELDS = [
  'role',
  'department_id',
  'position',
  'name',
  'short_name',
  'identifier',
  'visibility',
  'email',
  'user_id',
  'slug',
  'timezone',
  'parent_id',
  'head_id',
  'channel',
  'channels',
] as const;

/** Whitelisted request fields (+ the list of changed fields for an update). */
export function auditMeta(body: unknown, method: string): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const source = body as Record<string, unknown>;
  const meta: Record<string, unknown> = {};
  for (const key of META_FIELDS) {
    const value = source[key];
    if (value === undefined) continue;
    meta[key] = typeof value === 'string' && value.length > 200 ? `${value.slice(0, 200)}…` : value;
  }
  if (method === 'PATCH' || method === 'PUT') meta.fields = Object.keys(source);
  return Object.keys(meta).length > 0 ? meta : null;
}

export async function writeAudit(
  prisma: PrismaClient,
  input: AuditInput,
  request?: FastifyRequest,
  ip: string | undefined = request?.ip,
): Promise<void> {
  try {
    const actor = input.actor_id
      ? await prisma.user.findUnique({
          where: { id: input.actor_id },
          select: { display_name: true },
        })
      : null;
    await prisma.auditLog.create({
      data: {
        workspace_id: input.workspace_id ?? null,
        actor_id: input.actor_id ?? null,
        actor_name: actor?.display_name ?? null,
        action: input.action,
        target_type: input.target_type ?? null,
        target_id: input.target_id ?? null,
        meta: (input.meta ?? undefined) as Prisma.InputJsonValue | undefined,
        ip: ip ?? null,
        user_agent: request?.headers['user-agent']?.slice(0, 300) ?? null,
      },
    });
  } catch (err) {
    request?.log.error({ err, action: input.action }, 'audit: write failed');
  }
}

/** A completed sign-in (`method`: password, email_code, google, github, telegram, demo…). */
export function auditLogin(
  request: FastifyRequest,
  userId: string,
  method: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  return writeAudit(
    request.server.prisma,
    {
      actor_id: userId,
      action: 'auth.login',
      target_type: 'user',
      target_id: userId,
      meta: { method, ...extra },
    },
    request,
  );
}
