import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import { listAttachmentsSchema, createAttachmentSchema, deleteAttachmentSchema } from './schema.js';
import {
  listAttachmentsHandler,
  createAttachmentHandler,
  deleteAttachmentHandler,
} from './controller.js';

// List + create live under the issue path
// (`.../issues/:issueId/attachments`).
export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  const member = [authenticate, requireWorkspaceMember()];

  app.get('/', { schema: listAttachmentsSchema, preHandler: member }, listAttachmentsHandler);
  app.post('/', { schema: createAttachmentSchema, preHandler: member }, createAttachmentHandler);
}

// Delete is addressed by attachment id at the project level
// (`.../projects/:projectId/attachments/:attachmentId`).
export async function attachmentDeleteRoutes(app: FastifyInstance): Promise<void> {
  const member = [authenticate, requireWorkspaceMember()];

  app.delete(
    '/:attachmentId',
    {
      schema: deleteAttachmentSchema,
      preHandler: member,
      config: { audit: { action: 'attachment.deleted', target: 'attachment', param: 'attachmentId' } },
    },
    deleteAttachmentHandler,
  );
}
