import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import {
  listStatesSchema,
  createStateSchema,
  updateStateSchema,
  deleteStateSchema,
  reorderStatesSchema,
} from './schema.js';
import {
  listStatesHandler,
  createStateHandler,
  updateStateHandler,
  deleteStateHandler,
  reorderStatesHandler,
} from './controller.js';

export async function stateRoutes(app: FastifyInstance): Promise<void> {
  const member = [authenticate, requireWorkspaceMember()];
  const admin = [authenticate, requireWorkspaceMember('admin')];

  app.get('/', { schema: listStatesSchema, preHandler: member }, listStatesHandler);
  app.post('/', { schema: createStateSchema, preHandler: admin }, createStateHandler);
  // Before '/:stateId' so «order» is not taken for a state id.
  app.put('/order', { schema: reorderStatesSchema, preHandler: admin }, reorderStatesHandler);
  app.patch('/:stateId', { schema: updateStateSchema, preHandler: admin }, updateStateHandler);
  app.delete('/:stateId', { schema: deleteStateSchema, preHandler: admin }, deleteStateHandler);
}
