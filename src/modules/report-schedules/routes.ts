// Planned reports (Ф10 10.B5, ADR-032) — mounted at /api/v1/workspaces/:workspaceSlug:
//   /report-schedules            list, create
//   /report-schedules/:id        read, change, delete
//   /report-schedules/:id/run    «Отправить сейчас»
//   /report-schedules/:id/runs   history
//   /report-runs/:runId/download the file of one sending

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import { writeAudit } from '../../lib/audit.js';
import {
  CreateScheduleBodySchema,
  UpdateScheduleBodySchema,
  createScheduleSchema,
  deleteScheduleSchema,
  downloadRunSchema,
  getScheduleSchema,
  listRunsSchema,
  listSchedulesSchema,
  runScheduleSchema,
  updateScheduleSchema,
} from './schema.js';
import {
  createSchedule,
  deleteSchedule,
  downloadRun,
  getSchedule,
  listRuns,
  listSchedules,
  sendNow,
  updateSchedule,
} from './service.js';

const scheduleId = (r: FastifyRequest) => (r.params as { scheduleId: string }).scheduleId;

export async function reportScheduleRoutes(app: FastifyInstance): Promise<void> {
  const member = [authenticate, requireWorkspaceMember()];

  app.get(
    '/report-schedules',
    { schema: listSchedulesSchema, preHandler: member },
    async (request) => listSchedules(app.prisma, request.workspace.id, request.workspaceMember),
  );

  app.get(
    '/report-schedules/:scheduleId',
    { schema: getScheduleSchema, preHandler: member },
    async (request) =>
      getSchedule(app.prisma, request.workspace.id, scheduleId(request), request.workspaceMember),
  );

  app.post(
    '/report-schedules',
    {
      schema: createScheduleSchema,
      preHandler: member,
      config: { audit: { action: 'report_schedule.created', target: 'report' } },
    },
    async (request, reply) => {
      const schedule = await createSchedule(
        app.prisma,
        request.workspace,
        request.workspaceMember,
        CreateScheduleBodySchema.parse(request.body),
      );
      reply.code(201).send(schedule);
    },
  );

  app.patch(
    '/report-schedules/:scheduleId',
    {
      schema: updateScheduleSchema,
      preHandler: member,
      config: {
        audit: { action: 'report_schedule.updated', target: 'report', param: 'scheduleId' },
      },
    },
    async (request) =>
      updateSchedule(
        app.prisma,
        request.workspace,
        scheduleId(request),
        request.workspaceMember,
        UpdateScheduleBodySchema.parse(request.body ?? {}),
      ),
  );

  app.delete(
    '/report-schedules/:scheduleId',
    {
      schema: deleteScheduleSchema,
      preHandler: member,
      config: {
        audit: { action: 'report_schedule.deleted', target: 'report', param: 'scheduleId' },
      },
    },
    async (request, reply) => {
      await deleteSchedule(
        app.prisma,
        app.storage,
        request.workspace.id,
        scheduleId(request),
        request.workspaceMember,
      );
      reply.code(204).send();
    },
  );

  // The sending itself is written to the audit log as `report.sent` (run.ts).
  app.post(
    '/report-schedules/:scheduleId/run',
    { schema: runScheduleSchema, preHandler: member },
    async (request, reply) => {
      const run = await sendNow(
        app.prisma,
        app.storage,
        request.workspace,
        scheduleId(request),
        request.workspaceMember,
      );
      reply.code(201).send(run);
    },
  );

  app.get(
    '/report-schedules/:scheduleId/runs',
    { schema: listRunsSchema, preHandler: member },
    async (request) =>
      listRuns(app.prisma, request.workspace.id, scheduleId(request), request.workspaceMember),
  );

  app.get(
    '/report-runs/:runId/download',
    { schema: downloadRunSchema, preHandler: member },
    async (request) => {
      const { runId } = request.params as { runId: string };
      const { run, url, file_name } = await downloadRun(
        app.prisma,
        app.storage,
        request.workspace.id,
        runId,
        request.workspaceMember,
      );
      await writeAudit(
        app.prisma,
        {
          workspace_id: request.workspace.id,
          actor_id: request.userId,
          action: 'report.exported',
          target_type: 'report',
          target_id: run.schedule_id,
          meta: {
            report: run.schedule.report,
            from: run.period_from,
            to: run.period_to,
            run_id: run.id,
            planned: true,
          },
        },
        request,
      );
      return { url, file_name };
    },
  );
}
