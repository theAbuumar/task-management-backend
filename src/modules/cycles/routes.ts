import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import {
  listCyclesSchema,
  createCycleSchema,
  getCycleSchema,
  updateCycleSchema,
  deleteCycleSchema,
  addIssuesToCycleSchema,
  removeIssueFromCycleSchema,
  cycleBurndownSchema,
} from './schema.js';
import {
  listCyclesHandler,
  createCycleHandler,
  getCycleHandler,
  updateCycleHandler,
  deleteCycleHandler,
  addIssuesToCycleHandler,
  removeIssueFromCycleHandler,
  cycleBurndownHandler,
} from './controller.js';

export async function cycleRoutes(app: FastifyInstance): Promise<void> {
  const member = [authenticate, requireWorkspaceMember()];
  // Members plan cycles; deleting one is an admin's call (ADR-031).
  const admin = [authenticate, requireWorkspaceMember('admin')];

  app.get('/', { schema: listCyclesSchema, preHandler: member }, listCyclesHandler);
  app.post('/', { schema: createCycleSchema, preHandler: member }, createCycleHandler);

  app.get('/:cycleId', { schema: getCycleSchema, preHandler: member }, getCycleHandler);
  app.get(
    '/:cycleId/burndown',
    { schema: cycleBurndownSchema, preHandler: member },
    cycleBurndownHandler,
  );
  app.patch('/:cycleId', { schema: updateCycleSchema, preHandler: member }, updateCycleHandler);
  app.delete('/:cycleId', { schema: deleteCycleSchema, preHandler: admin }, deleteCycleHandler);

  // Issue membership
  app.post(
    '/:cycleId/issues',
    { schema: addIssuesToCycleSchema, preHandler: member },
    addIssuesToCycleHandler,
  );
  app.delete(
    '/:cycleId/issues/:issueId',
    { schema: removeIssueFromCycleSchema, preHandler: member },
    removeIssueFromCycleHandler,
  );
}
