import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../../plugins/workspace-hook.js';
import {
  listRelationsSchema,
  createRelationSchema,
  deleteRelationSchema,
  listProjectRelationsSchema,
  ProjectRelationsQuerySchema,
} from './schema.js';
import { listProjectRelations } from './service.js';
import {
  listRelationsHandler,
  createRelationHandler,
  deleteRelationHandler,
} from './controller.js';

export async function issueRelationRoutes(app: FastifyInstance): Promise<void> {
  const member = [authenticate, requireWorkspaceMember()];

  app.get('/', { schema: listRelationsSchema, preHandler: member }, listRelationsHandler);
  app.post('/', { schema: createRelationSchema, preHandler: member }, createRelationHandler);
  app.delete(
    '/:linkId',
    { schema: deleteRelationSchema, preHandler: member },
    deleteRelationHandler,
  );
}

/** `/projects/:projectId/relations` — every link inside the project at once (7.F4). */
export async function projectRelationRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/',
    { schema: listProjectRelationsSchema, preHandler: [authenticate, requireWorkspaceMember()] },
    async (request) => {
      const { projectId } = request.params as { projectId: string };
      const { type } = ProjectRelationsQuerySchema.parse(request.query);
      return listProjectRelations(app.prisma, request.workspace.id, projectId, type);
    },
  );
}
