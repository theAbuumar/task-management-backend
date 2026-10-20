import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import {
  listModulesSchema,
  createModuleSchema,
  getModuleSchema,
  updateModuleSchema,
  deleteModuleSchema,
  addIssuesToModuleSchema,
  removeIssueFromModuleSchema,
} from './schema.js';
import {
  listModulesHandler,
  createModuleHandler,
  getModuleHandler,
  updateModuleHandler,
  deleteModuleHandler,
  addIssuesToModuleHandler,
  removeIssueFromModuleHandler,
} from './controller.js';

export async function moduleRoutes(app: FastifyInstance): Promise<void> {
  const member = [authenticate, requireWorkspaceMember()];
  // Members run modules; deleting one is an admin's call (ADR-031).
  const admin = [authenticate, requireWorkspaceMember('admin')];

  app.get('/', { schema: listModulesSchema, preHandler: member }, listModulesHandler);
  app.post('/', { schema: createModuleSchema, preHandler: member }, createModuleHandler);

  app.get('/:moduleId', { schema: getModuleSchema, preHandler: member }, getModuleHandler);
  app.patch('/:moduleId', { schema: updateModuleSchema, preHandler: member }, updateModuleHandler);
  app.delete('/:moduleId', { schema: deleteModuleSchema, preHandler: admin }, deleteModuleHandler);

  // Issue membership
  app.post(
    '/:moduleId/issues',
    { schema: addIssuesToModuleSchema, preHandler: member },
    addIssuesToModuleHandler,
  );
  app.delete(
    '/:moduleId/issues/:issueId',
    { schema: removeIssueFromModuleSchema, preHandler: member },
    removeIssueFromModuleHandler,
  );
}
