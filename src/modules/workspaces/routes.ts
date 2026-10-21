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
  listMemberAccessSchema,
  deactivateMemberSchema,
  activateMemberSchema,
  resetMemberIdentitySchema,
  transferOwnershipCodeSchema,
  transferOwnershipSchema,
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
  listMemberAccessHandler,
  deactivateMemberHandler,
  activateMemberHandler,
  resetMemberIdentityHandler,
  transferOwnershipCodeHandler,
  transferOwnershipHandler,
} from './controller.js';

// Confirmation codes and the transfer itself: per-IP backstop like the auth routes.
const ownershipRateLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } };

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
      config: { audit: { action: 'workspace.updated', target: 'workspace' } },
    },
    updateWorkspaceHandler,
  );
  app.delete(
    '/:workspaceSlug',
    {
      schema: deleteWorkspaceSchema,
      preHandler: [authenticate, requireWorkspaceMember('owner')],
      config: { audit: { action: 'workspace.deleted', target: 'workspace' } },
    },
    deleteWorkspaceHandler,
  );

  // Hand the workspace over to another member (12.B3, ADR-034): code, then transfer.
  app.post(
    '/:workspaceSlug/transfer-ownership/code',
    {
      schema: transferOwnershipCodeSchema,
      preHandler: [authenticate, requireWorkspaceMember('owner')],
      config: ownershipRateLimit,
    },
    transferOwnershipCodeHandler,
  );
  app.post(
    '/:workspaceSlug/transfer-ownership',
    {
      schema: transferOwnershipSchema,
      preHandler: [authenticate, requireWorkspaceMember('owner')],
      config: {
        ...ownershipRateLimit,
        audit: { action: 'workspace.ownership_transferred', target: 'user', bodyField: 'user_id' },
      },
    },
    transferOwnershipHandler,
  );

  // Any member (except the owner) may leave on their own.
  app.post(
    '/:workspaceSlug/leave',
    {
      schema: leaveWorkspaceSchema,
      preHandler: [authenticate, requireWorkspaceMember()],
      config: { audit: { action: 'member.left', target: 'user', self: true } },
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
      config: { audit: { action: 'member.added', target: 'user', bodyField: 'user_id' } },
    },
    addMemberHandler,
  );
  app.patch(
    '/:workspaceSlug/members/:userId',
    {
      schema: changeMemberRoleSchema,
      preHandler: [authenticate, requireWorkspaceMember('admin')],
      config: { audit: { action: 'member.updated', target: 'user', param: 'userId' } },
    },
    changeMemberRoleHandler,
  );
  app.delete(
    '/:workspaceSlug/members/:userId',
    {
      schema: removeMemberSchema,
      preHandler: [authenticate, requireWorkspaceMember('admin')],
      config: { audit: { action: 'member.removed', target: 'user', param: 'userId' } },
    },
    removeMemberHandler,
  );
  app.post(
    '/:workspaceSlug/members/invite',
    {
      schema: inviteMemberSchema,
      preHandler: [authenticate, requireWorkspaceMember('admin')],
      config: { audit: { action: 'invite.sent', target: 'invite' } },
    },
    inviteMemberHandler,
  );
  // Invite an already-registered user (in-app inbox + email + Telegram fan-out).
  app.post(
    '/:workspaceSlug/members/invite-user',
    {
      schema: inviteExistingUserSchema,
      preHandler: [authenticate, requireWorkspaceMember('admin')],
      config: { audit: { action: 'invite.sent', target: 'user', bodyField: 'user_id' } },
    },
    inviteExistingUserHandler,
  );

  // Members' access (12.B7, ADR-026): deactivation, last sign-ins, login methods.
  app.get(
    '/:workspaceSlug/members/access',
    {
      schema: listMemberAccessSchema,
      preHandler: [authenticate, requireWorkspaceMember('admin')],
    },
    listMemberAccessHandler,
  );
  app.post(
    '/:workspaceSlug/members/:userId/deactivate',
    {
      schema: deactivateMemberSchema,
      preHandler: [authenticate, requireWorkspaceMember('admin')],
      config: { audit: { action: 'member.deactivated', target: 'user', param: 'userId' } },
    },
    deactivateMemberHandler,
  );
  app.post(
    '/:workspaceSlug/members/:userId/activate',
    {
      schema: activateMemberSchema,
      preHandler: [authenticate, requireWorkspaceMember('admin')],
      config: { audit: { action: 'member.activated', target: 'user', param: 'userId' } },
    },
    activateMemberHandler,
  );
  // Audited in the handler (the provider goes into the entry).
  app.delete(
    '/:workspaceSlug/members/:userId/identities/:provider',
    {
      schema: resetMemberIdentitySchema,
      preHandler: [authenticate, requireWorkspaceMember('admin')],
    },
    resetMemberIdentityHandler,
  );
}
