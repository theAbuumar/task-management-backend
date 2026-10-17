import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import {
  listProjectsSchema,
  createProjectSchema,
  getProjectSchema,
  updateProjectSchema,
  deleteProjectSchema,
  listProjectMembersSchema,
  addProjectMemberSchema,
  removeProjectMemberSchema,
} from './schema.js';
import {
  listProjectsHandler,
  createProjectHandler,
  getProjectHandler,
  updateProjectHandler,
  deleteProjectHandler,
  listProjectMembersHandler,
  addProjectMemberHandler,
  removeProjectMemberHandler,
} from './controller.js';

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  // All project routes require workspace membership; some require admin+.
  const member = [authenticate, requireWorkspaceMember()];
  const admin = [authenticate, requireWorkspaceMember('admin')];

  app.get('/', { schema: listProjectsSchema, preHandler: member }, listProjectsHandler);
  app.post(
    '/',
    { schema: createProjectSchema, preHandler: admin, config: { audit: { action: 'project.created', target: 'project' } } },
    createProjectHandler,
  );

  app.get('/:projectId', { schema: getProjectSchema, preHandler: member }, getProjectHandler);
  app.patch(
    '/:projectId',
    {
      schema: updateProjectSchema,
      preHandler: admin,
      config: { audit: { action: 'project.updated', target: 'project', param: 'projectId' } },
    },
    updateProjectHandler,
  );
  app.delete(
    '/:projectId',
    {
      schema: deleteProjectSchema,
      preHandler: admin,
      config: { audit: { action: 'project.deleted', target: 'project', param: 'projectId' } },
    },
    deleteProjectHandler,
  );

  // Project member sub-routes
  app.get(
    '/:projectId/members',
    { schema: listProjectMembersSchema, preHandler: member },
    listProjectMembersHandler,
  );
  app.post(
    '/:projectId/members',
    {
      schema: addProjectMemberSchema,
      preHandler: admin,
      config: { audit: { action: 'project.member_added', target: 'user', bodyField: 'user_id' } },
    },
    addProjectMemberHandler,
  );
  app.delete(
    '/:projectId/members/:userId',
    {
      schema: removeProjectMemberSchema,
      preHandler: admin,
      config: { audit: { action: 'project.member_removed', target: 'user', param: 'userId' } },
    },
    removeProjectMemberHandler,
  );
}
