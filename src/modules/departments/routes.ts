import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import {
  listDepartmentsSchema,
  createDepartmentSchema,
  updateDepartmentSchema,
  deleteDepartmentSchema,
} from './schema.js';
import {
  listDepartmentsHandler,
  createDepartmentHandler,
  updateDepartmentHandler,
  deleteDepartmentHandler,
} from './controller.js';

// Mounted at /api/v1/workspaces/:workspaceSlug/departments. Everyone in the
// workspace can see the org structure; only admins edit it.
export async function departmentRoutes(app: FastifyInstance): Promise<void> {
  const member = [authenticate, requireWorkspaceMember()];
  const admin = [authenticate, requireWorkspaceMember('admin')];

  app.get('/', { schema: listDepartmentsSchema, preHandler: member }, listDepartmentsHandler);
  app.post('/', { schema: createDepartmentSchema, preHandler: admin }, createDepartmentHandler);
  app.patch(
    '/:departmentId',
    { schema: updateDepartmentSchema, preHandler: admin },
    updateDepartmentHandler,
  );
  app.delete(
    '/:departmentId',
    { schema: deleteDepartmentSchema, preHandler: admin },
    deleteDepartmentHandler,
  );
}
