// Analytics and reports (Ф10). Mounted at /api/v1/workspaces/:workspaceSlug;
// the project report lives under /projects/:projectId. Every member may call
// them: what they see is cut down to their scope in data.ts (10.B3).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import { writeAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { analyticsData } from './data.js';
import * as analytics from './service.js';
import { assignmentsXlsx, disciplinePdf, projectPdf } from './reports.js';
import {
  AnalyticsQuerySchema,
  assignmentsXlsxSchema,
  byAssigneeSchema,
  byDepartmentSchema,
  dashboardSchema,
  byProjectSchema,
  deadlineChangesSchema,
  disciplinePdfSchema,
  overdueSchema,
  projectPdfSchema,
  reactionTimeSchema,
  summarySchema,
  trendsSchema,
  type AnalyticsQuery,
} from './schema.js';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function load(app: FastifyInstance, request: FastifyRequest, query: AnalyticsQuery) {
  return analyticsData(app.prisma, request.workspace, request.workspaceMember, query);
}

/** `attachment; filename*=UTF-8''…` so Cyrillic names survive every browser. */
function sendFile(reply: FastifyReply, body: Buffer, type: string, name: string) {
  return reply
    .header('Content-Type', type)
    .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
    .header('Cache-Control', 'no-store')
    .send(body);
}

/** Every download goes to the audit log (12.B1): which report, with which filters. */
async function logExport(
  app: FastifyInstance,
  request: FastifyRequest,
  report: string,
  query: AnalyticsQuery,
) {
  await writeAudit(
    app.prisma,
    {
      workspace_id: request.workspace.id,
      actor_id: request.userId,
      action: 'report.exported',
      target_type: 'report',
      target_id: report,
      meta: { report, ...query },
    },
    request,
  );
}

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  const member = [authenticate, requireWorkspaceMember()];
  const parse = (request: FastifyRequest) => AnalyticsQuerySchema.parse(request.query);

  app.get('/analytics/summary', { schema: summarySchema, preHandler: member }, async (request) =>
    analytics.summary(await load(app, request, parse(request))),
  );
  app.get(
    '/analytics/dashboard',
    { schema: dashboardSchema, preHandler: member },
    async (request) => {
      const query = parse(request);
      return analytics.dashboard(await load(app, request, query), query.limit);
    },
  );
  app.get(
    '/analytics/by-department',
    { schema: byDepartmentSchema, preHandler: member },
    async (request) => analytics.byDepartment(await load(app, request, parse(request))),
  );
  app.get(
    '/analytics/by-assignee',
    { schema: byAssigneeSchema, preHandler: member },
    async (request) => analytics.byAssignee(await load(app, request, parse(request))),
  );
  app.get(
    '/analytics/by-project',
    { schema: byProjectSchema, preHandler: member },
    async (request) => analytics.byProject(await load(app, request, parse(request))),
  );
  app.get('/analytics/trends', { schema: trendsSchema, preHandler: member }, async (request) => {
    const query = parse(request);
    return analytics.trends(await load(app, request, query), query.bucket);
  });
  app.get('/analytics/overdue', { schema: overdueSchema, preHandler: member }, async (request) => {
    const query = parse(request);
    return analytics.overdue(await load(app, request, query), query.limit);
  });
  app.get(
    '/analytics/deadline-changes',
    { schema: deadlineChangesSchema, preHandler: member },
    async (request) => {
      const query = parse(request);
      return analytics.deadlineChanges(await load(app, request, query), query.limit);
    },
  );
  app.get(
    '/analytics/reaction-time',
    { schema: reactionTimeSchema, preHandler: member },
    async (request) => analytics.reactionTime(await load(app, request, parse(request))),
  );

  // ─── Exports (10.B4) ───
  app.get(
    '/reports/assignments.xlsx',
    { schema: assignmentsXlsxSchema, preHandler: member },
    async (request, reply) => {
      const query = parse(request);
      const data = await load(app, request, query);
      const file = await assignmentsXlsx(data, query);
      await logExport(app, request, 'assignments.xlsx', query);
      return sendFile(
        reply,
        file,
        XLSX,
        `Реестр поручений ${data.period.from}—${data.period.to}.xlsx`,
      );
    },
  );
  app.get(
    '/reports/discipline.pdf',
    { schema: disciplinePdfSchema, preHandler: member },
    async (request, reply) => {
      const query = parse(request);
      const data = await load(app, request, query);
      const file = await disciplinePdf(data, query);
      await logExport(app, request, 'discipline.pdf', query);
      return sendFile(
        reply,
        file,
        'application/pdf',
        `Справка об исполнении поручений ${data.period.from}—${data.period.to}.pdf`,
      );
    },
  );
  app.get(
    '/projects/:projectId/report.pdf',
    { schema: projectPdfSchema, preHandler: member },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const project = await app.prisma.project.findFirst({
        where: { id: projectId, workspace_id: request.workspace.id, deleted_at: null },
        select: { name: true, identifier: true },
      });
      if (!project) throw AppError.notFound('Project not found');
      const query = { ...parse(request), project: projectId };
      const data = await load(app, request, query);
      const file = await projectPdf(data, project);
      await logExport(app, request, 'project.pdf', query);
      return sendFile(
        reply,
        file,
        'application/pdf',
        `Отчёт по проекту ${project.identifier} ${data.period.to}.pdf`,
      );
    },
  );
}
