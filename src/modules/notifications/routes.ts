import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import {
  listNotificationsSchema,
  markReadSchema,
  markUnreadSchema,
  markAllReadSchema,
} from './schema.js';
import {
  listNotificationsHandler,
  markReadHandler,
  markUnreadHandler,
  markAllReadHandler,
} from './controller.js';

// Notifications are workspace-scoped and private to the requesting member
// (`.../workspaces/:workspaceSlug/notifications`).
export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  const member = [authenticate, requireWorkspaceMember()];

  app.get('/', { schema: listNotificationsSchema, preHandler: member }, listNotificationsHandler);
  app.post('/read-all', { schema: markAllReadSchema, preHandler: member }, markAllReadHandler);
  app.post(
    '/:notificationId/read',
    { schema: markReadSchema, preHandler: member },
    markReadHandler,
  );
  app.post(
    '/:notificationId/unread',
    { schema: markUnreadSchema, preHandler: member },
    markUnreadHandler,
  );
}
