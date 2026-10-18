import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Workspace, WorkspaceMember, WorkspaceRole } from '@prisma/client';
import { AppError } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by `requireWorkspaceMember` on workspace-scoped routes. */
    workspace: Workspace;
    /** The authenticated user's membership record in the current workspace. */
    workspaceMember: WorkspaceMember;
  }
}

const ROLE_RANK: Record<WorkspaceRole, number> = {
  guest: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Writes a guest may still make (Ф12 12.B4): their own inbox, following a task,
 * leaving the workspace. Matched against the route pattern, not the raw URL.
 */
const GUEST_WRITES: RegExp[] = [
  /\/notifications(\/|$)/,
  /\/issues\/:issueId\/watchers(\/me)?$/,
  /^\/api\/v1\/workspaces\/:workspaceSlug\/leave$/,
];

/** The guest role is read-only (docs/PERMISSIONS.md). */
export function assertCanWrite(role: WorkspaceRole): void {
  if (role === 'guest') {
    throw new AppError(403, 'GUEST_READ_ONLY', 'Guests have read-only access to this workspace');
  }
}

/**
 * preHandler factory: resolve workspace by slug, verify the authenticated user
 * is a member, and optionally enforce a minimum role.
 *
 * Must run after `authenticate` (requires `request.userId`).
 *
 * Usage:
 *   `{ preHandler: [authenticate, requireWorkspaceMember()] }`          // any member
 *   `{ preHandler: [authenticate, requireWorkspaceMember('admin')] }`   // admin or owner
 */
export function requireWorkspaceMember(
  minRole: WorkspaceRole = 'guest',
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async function workspaceMemberHandler(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const slug = (request.params as Record<string, string>).workspaceSlug;
    if (!slug) throw AppError.badRequest('workspaceSlug param is missing');

    const workspace = await request.server.prisma.workspace.findUnique({
      where: { slug },
    });
    if (!workspace) throw AppError.notFound(`Workspace "${slug}" not found`);

    const member = await request.server.prisma.workspaceMember.findUnique({
      where: { workspace_id_user_id: { workspace_id: workspace.id, user_id: request.userId } },
    });
    if (!member) throw AppError.forbidden('You are not a member of this workspace');
    // An admin turned this member's access off (12.B7, ADR-026).
    if (member.deactivated_at) {
      throw new AppError(
        403,
        'MEMBER_DEACTIVATED',
        'Your access to this workspace has been turned off by an admin',
      );
    }

    // Guests read; every write except the personal ones above is refused here,
    // in one place for all modules (12.B4).
    const route = request.routeOptions.url ?? '';
    if (!READ_METHODS.has(request.method) && !GUEST_WRITES.some((re) => re.test(route))) {
      assertCanWrite(member.role);
    }

    if (ROLE_RANK[member.role] < ROLE_RANK[minRole]) {
      throw AppError.forbidden(
        `This action requires at least the "${minRole}" role in this workspace`,
      );
    }

    request.workspace = workspace;
    request.workspaceMember = member;

    // Every route under `/projects/:projectId/...` (issues, comments, cycles,
    // attachments…) inherits the project's visibility here, in one place: a
    // deleted project is gone, and a private one is visible only to its members
    // and to workspace admins (ADR-007 / Ф3 3.B9). Hidden = 404, not 403.
    const projectId = (request.params as Record<string, string>).projectId;
    if (projectId) {
      const project = await request.server.prisma.project.findFirst({
        where: { id: projectId, workspace_id: workspace.id, deleted_at: null },
        select: { id: true, visibility: true },
      });
      if (!project) throw AppError.notFound('Project not found');
      if (project.visibility === 'private' && ROLE_RANK[member.role] < ROLE_RANK.admin) {
        const projectMember = await request.server.prisma.projectMember.findUnique({
          where: { project_id_user_id: { project_id: project.id, user_id: request.userId } },
        });
        if (!projectMember) throw AppError.notFound('Project not found');
      }
    }
  };
}

/** True when the member may see private projects they don't belong to. */
export function seesAllProjects(member: WorkspaceMember): boolean {
  return ROLE_RANK[member.role] >= ROLE_RANK.admin;
}

async function workspacePlugin(app: FastifyInstance): Promise<void> {
  // Initial values are null at route registration time; the preHandler sets the real objects.
  app.decorateRequest('workspace', null as unknown as Workspace);
  app.decorateRequest('workspaceMember', null as unknown as WorkspaceMember);
}

export default fp(workspacePlugin, { name: 'workspace' });
