import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { listMyInvitesSchema, acceptInviteSchema, declineInviteSchema } from './schema.js';
import { listMyInvitesHandler, acceptInviteHandler, declineInviteHandler } from './controller.js';

// Personal invitations inbox. NOT workspace-scoped: the recipient is not yet a member of
// the inviting workspace, so these routes are keyed on the authenticated user only.
export async function memberInviteRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { schema: listMyInvitesSchema, preHandler: [authenticate] }, listMyInvitesHandler);
  app.post(
    '/:inviteId/accept',
    { schema: acceptInviteSchema, preHandler: [authenticate] },
    acceptInviteHandler,
  );
  app.post(
    '/:inviteId/decline',
    { schema: declineInviteSchema, preHandler: [authenticate] },
    declineInviteHandler,
  );
}
