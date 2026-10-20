// Recurring issues of a project (6.B4, ADR-030) —
// `/api/v1/workspaces/:workspaceSlug/projects/:projectId/recurring`.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import {
  CreateRuleBodySchema,
  UpdateRuleBodySchema,
  createRule,
  deleteRule,
  getRule,
  listRules,
  runRuleNow,
  updateRule,
} from './service.js';

const security = [{ bearerAuth: [] }];
const tags = ['Recurring'];

const FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'];

/** The issue fields a template or a rule keeps (ADR-030). */
export const issueFieldsShape = {
  type: 'object',
  description:
    'The issue as the create form holds it: title (required), description, kind, priority, ' +
    'assignee_ids, primary_assignee_id, controller_id, requires_review, basis, label_ids, checklist',
  additionalProperties: true,
} as const;

const scheduleProperties = {
  frequency: { type: 'string', enum: FREQUENCIES },
  interval: { type: 'integer', minimum: 1, maximum: 52, description: 'Every N days/weeks/months…' },
  by_weekday: {
    type: 'array',
    items: { type: 'integer', minimum: 1, maximum: 7 },
    description: 'weekly: ISO weekdays, 1 = Monday … 7 = Sunday (default: the start weekday)',
  },
  by_monthday: {
    type: 'integer',
    minimum: 1,
    maximum: 31,
    nullable: true,
    description: 'monthly/quarterly/yearly: day of the month; past its end — the last day',
  },
  by_month: { type: 'integer', minimum: 1, maximum: 12, nullable: true, description: 'yearly' },
  time: { type: 'string', description: 'Local time of the run, HH:MM (default 09:00)' },
  start_date: { type: 'string', description: 'Local date YYYY-MM-DD (default: today)' },
  until: { type: 'string', nullable: true, description: 'Last possible run, inclusive' },
} as const;

const ruleShape = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    project_id: { type: 'string' },
    created_by_id: { type: 'string' },
    created_by: { type: 'object', additionalProperties: true },
    data: issueFieldsShape,
    due_in_days: { type: 'integer', nullable: true },
    ...scheduleProperties,
    next_run_at: { type: 'string', format: 'date-time', nullable: true },
    last_run_at: { type: 'string', format: 'date-time', nullable: true },
    last_error: {
      type: 'string',
      nullable: true,
      description:
        'Why the latest run created nothing: an error code (MEMBER_DEACTIVATED, GUEST_NOT_ASSIGNABLE…), ' +
        'or AUTHOR_NOT_MEMBER — the rule is paused',
    },
    is_active: { type: 'boolean' },
    issues_count: { type: 'integer' },
    last_issue: { type: 'object', nullable: true, additionalProperties: true },
    can_edit: { type: 'boolean', description: 'The caller is the author or an admin' },
    created_issue: {
      type: 'object',
      nullable: true,
      additionalProperties: true,
      description: 'POST with create_now: the issue created now',
    },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
} as const;

const idParams = {
  type: 'object',
  properties: {
    workspaceSlug: { type: 'string' },
    projectId: { type: 'string' },
    ruleId: { type: 'string' },
  },
} as const;

const projectId = (r: FastifyRequest) => (r.params as { projectId: string }).projectId;
const ruleId = (r: FastifyRequest) => (r.params as { ruleId: string }).ruleId;

export async function recurringRoutes(app: FastifyInstance): Promise<void> {
  const member = [authenticate, requireWorkspaceMember()];

  app.get(
    '/',
    {
      schema: {
        tags,
        summary: 'Recurring rules of the project',
        description: 'Everyone who sees the project sees them. Active first, by the next run.',
        security,
        response: {
          200: { type: 'object', properties: { data: { type: 'array', items: ruleShape } } },
        },
      },
      preHandler: member,
    },
    async (request) =>
      listRules(app.prisma, request.workspace.id, projectId(request), request.workspaceMember),
  );

  app.get(
    '/:ruleId',
    {
      schema: {
        tags,
        summary: 'One recurring rule',
        security,
        params: idParams,
        response: { 200: ruleShape },
      },
      preHandler: member,
    },
    async (request) =>
      getRule(
        app.prisma,
        request.workspace.id,
        projectId(request),
        ruleId(request),
        request.workspaceMember,
      ),
  );

  app.post(
    '/',
    {
      schema: {
        tags,
        summary: 'Create a recurring rule',
        description:
          'The scheduler creates one issue per run in the workspace zone, on behalf of the author, ' +
          'through the same rules as POST …/issues (default state; deadline `due_in_days` after the run). ' +
          'Missed runs while the server was off make one issue, not many. `create_now: true` also creates ' +
          'the first issue now (returned as `created_issue`) — it stands for today’s run.',
        security,
        body: {
          type: 'object',
          required: ['frequency', 'data'],
          properties: {
            ...scheduleProperties,
            data: issueFieldsShape,
            due_in_days: { type: 'integer', minimum: 0, maximum: 365, nullable: true },
            create_now: { type: 'boolean' },
          },
        },
        response: { 201: ruleShape },
      },
      preHandler: member,
    },
    async (request, reply) => {
      const rule = await createRule(
        app.prisma,
        request.workspace,
        projectId(request),
        request.workspaceMember,
        CreateRuleBodySchema.parse(request.body),
      );
      reply.code(201).send(rule);
    },
  );

  app.patch(
    '/:ruleId',
    {
      schema: {
        tags,
        summary: 'Change, pause or resume a rule (its author or an admin)',
        description:
          'A changed schedule or a resumed rule counts its next run from now: missed runs are not made up.',
        security,
        params: idParams,
        body: {
          type: 'object',
          properties: {
            ...scheduleProperties,
            data: issueFieldsShape,
            due_in_days: { type: 'integer', minimum: 0, maximum: 365, nullable: true },
            is_active: { type: 'boolean' },
          },
        },
        response: { 200: ruleShape },
      },
      preHandler: member,
    },
    async (request) =>
      updateRule(
        app.prisma,
        request.workspace,
        projectId(request),
        ruleId(request),
        request.workspaceMember,
        UpdateRuleBodySchema.parse(request.body ?? {}),
      ),
  );

  app.delete(
    '/:ruleId',
    {
      schema: {
        tags,
        summary: 'Delete a rule (its author or an admin); its issues stay',
        security,
        params: idParams,
        response: { 204: { type: 'null' } },
      },
      preHandler: member,
    },
    async (request, reply) => {
      await deleteRule(
        app.prisma,
        request.workspace.id,
        projectId(request),
        ruleId(request),
        request.workspaceMember,
      );
      reply.code(204).send();
    },
  );

  app.post(
    '/:ruleId/run',
    {
      schema: {
        tags,
        summary: '«Создать сейчас»: one issue of the rule outside its schedule',
        description: 'The schedule is kept. Returns the issue, as POST …/issues.',
        security,
        params: idParams,
      },
      preHandler: member,
    },
    async (request, reply) => {
      const issue = await runRuleNow(
        app.prisma,
        request.workspace,
        projectId(request),
        ruleId(request),
        request.workspaceMember,
      );
      reply.code(201).send(issue);
    },
  );
}
