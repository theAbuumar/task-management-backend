import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import {
  listWorkspacesSchema,
  createWorkspaceSchema,
  getWorkspaceSchema,
  updateWorkspaceSchema,
  deleteWorkspaceSchema,
  listMembersSchema,
  addMemberSchema,
  changeMemberRoleSchema,
  removeMemberSchema,
  inviteMemberSchema,
  leaveWorkspaceSchema,
} from './schema.js';
import { inviteExistingUserSchema } from '../member-invites/schema.js';
import {
  listWorkspacesHandler,
  createWorkspaceHandler,
  getWorkspaceHandler,
  updateWorkspaceHandler,
  deleteWorkspaceHandler,
  listMembersHandler,
  addMemberHandler,
  changeMemberRoleHandler,
  removeMemberHandler,
  inviteMemberHandler,
  inviteExistingUserHandler,
  leaveWorkspaceHandler,
} from './controller.js';

export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  // Collection routes (no workspace scope yet — just need auth)
  app.get('/', { schema: listWorkspacesSchema, preHandler: [authenticate] }, listWorkspacesHandler);
  app.post(
    '/',
    { schema: createWorkspaceSchema, preHandler: [authenticate] },
    createWorkspaceHandler,
  );

  // Workspace-scoped routes — resolves workspace + verifies membership
  app.get(
    '/:workspaceSlug',
    {
      schema: getWorkspaceSchema,
      preHandler: [authenticate, requireWorkspaceMember()],
    },
    getWorkspaceHandler,
  );
  app.patch(
    '/:workspaceSlug',
    {
      schema: updateWorkspaceSchema,
      preHandler: [authenticate, requireWorkspaceMember('admin')],
    },
    updateWorkspaceHandler,
  );
  app.delete(
    '/:workspaceSlug',
    {
      schema: deleteWorkspaceSchema,
      preHandler: [authenticate, requireWorkspaceMember('owner')],
    },
    deleteWorkspaceHandler,
  );

  // Any member (except the owner) may leave on their own.
  app.post(
    '/:workspaceSlug/leave',
    {
      schema: leaveWorkspaceSchema,
      preHandler: [authenticate, requireWorkspaceMember()],
    },
    leaveWorkspaceHandler,
  );

  // Member sub-routes
  app.get(
    '/:workspaceSlug/members',
    {
      schema: listMembersSchema,
      preHandler: [authenticate, requireWorkspaceMember()],
    },
    listMembersHandler,
  );
  app.post(
    '/:workspaceSlug/members',
    {
      schema: addMemberSchema,
      preHandler: [authenticate, requireWorkspaceMember('admin')],
    },
    addMemberHandler,
  );
  app.patch(
    '/:workspaceSlug/members/:userId',
    {
      schema: changeMemberRoleSchema,
      preHandler: [authenticate, requireWorkspaceMember('admin')],
    },
    changeMemberRoleHandler,
  );
  app.delete(
    '/:workspaceSlug/members/:userId',
    {
      schema: removeMemberSchema,
      preHandler: [authenticate, requireWorkspaceMember('admin')],
    },
    removeMemberHandler,
  );
  app.post(
    '/:workspaceSlug/members/invite',
    {
      schema: inviteMemberSchema,
      preHandler: [authenticate, requireWorkspaceMember('admin')],
    },
    inviteMemberHandler,
  );
  // Invite an already-registered user (in-app inbox + email + Telegram fan-out).
  app.post(
    '/:workspaceSlug/members/invite-user',
    {
      schema: inviteExistingUserSchema,
      preHandler: [authenticate, requireWorkspaceMember('admin')],
    },
    inviteExistingUserHandler,
  );
}
