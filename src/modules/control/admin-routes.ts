// Workspace-level execution-control endpoints (Ф5 5.B9):
// settings (reminder days/hour, escalation threshold, mandatory report) and a
// manual "send reminders now" trigger for admins (handy for the demo).
//
// Mounted at /api/v1/workspaces/:workspaceSlug/control.

import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import { ControlSettingsPatchSchema, controlSettings } from '../../lib/control-settings.js';
import { runReminders } from './reminders.js';

const settingsShape = {
  type: 'object',
  properties: {
    reminder_days: { type: 'array', items: { type: 'integer' } },
    reminder_hour: { type: 'integer' },
    escalation_days: { type: 'integer' },
    require_report: { type: 'boolean' },
  },
} as const;
const wsParams = { type: 'object', properties: { workspaceSlug: { type: 'string' } } } as const;
const security = [{ bearerAuth: [] }];
const tags = ['Execution control'];

export async function controlAdminRoutes(app: FastifyInstance): Promise<void> {
  const member = [authenticate, requireWorkspaceMember()];
  const admin = [authenticate, requireWorkspaceMember('admin')];

  app.get(
    '/settings',
    {
      schema: {
        tags,
        summary: 'Effective execution-control settings',
        security,
        params: wsParams,
        response: { 200: settingsShape },
      },
      preHandler: member,
    },
    async (request) => controlSettings(request.workspace.settings),
  );

  app.patch(
    '/settings',
    {
      schema: {
        tags,
        summary: 'Update execution-control settings (admin+)',
        security,
        params: wsParams,
        body: settingsShape,
        response: { 200: settingsShape },
      },
      preHandler: admin,
      config: { audit: { action: 'settings.control_updated', target: 'settings' } },
    },
    async (request) => {
      const patch = ControlSettingsPatchSchema.parse(request.body ?? {});
      const current = (request.workspace.settings ?? {}) as Record<string, unknown>;
      const merged = { ...controlSettings(current), ...patch };
      if (patch.reminder_days)
        merged.reminder_days = [...new Set(patch.reminder_days)].sort((a, b) => b - a);
      const updated = await app.prisma.workspace.update({
        where: { id: request.workspace.id },
        data: { settings: { ...current, control: merged } as Prisma.InputJsonValue },
        select: { settings: true },
      });
      return controlSettings(updated.settings);
    },
  );

  app.post(
    '/run-reminders',
    {
      schema: {
        tags,
        summary: 'Send due reminders / escalations for this workspace now (admin+)',
        description:
          'Runs the same idempotent pass the scheduler runs every 5 minutes. `force: true` ignores the reminder hour. Already-sent reminders are never repeated.',
        security,
        params: wsParams,
        body: { type: 'object', properties: { force: { type: 'boolean' } } },
      },
      preHandler: admin,
    },
    async (request) => {
      const { force } = z.object({ force: z.boolean().optional() }).parse(request.body ?? {});
      return runReminders(app.prisma, { workspaceId: request.workspace.id, force: force ?? true });
    },
  );
}
