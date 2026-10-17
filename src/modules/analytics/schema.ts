import { z } from 'zod';

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date like 2026-10-31');
const oneOrMany = z.union([z.string().uuid(), z.array(z.string().uuid())]);

/** Common analytics filters (10.B1). Dates are local dates of the workspace time zone, inclusive. */
export const AnalyticsQuerySchema = z.object({
  from: localDate.optional(),
  to: localDate.optional(),
  department: oneOrMany.optional(),
  project: oneOrMany.optional(),
  kind: z.enum(['task', 'assignment']).optional(),
  controller: z.union([z.string().uuid(), z.literal('me')]).optional(),
  bucket: z.enum(['week', 'month']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export type AnalyticsQuery = z.infer<typeof AnalyticsQuerySchema>;

const manyIds = { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] };

export const analyticsQuerystring = {
  type: 'object',
  properties: {
    from: {
      type: 'string',
      description: 'Local date YYYY-MM-DD, inclusive (default: 29 days before `to`)',
    },
    to: { type: 'string', description: 'Local date YYYY-MM-DD, inclusive (default: today)' },
    department: {
      ...manyIds,
      description: 'Department id(s); a department includes its sub-departments',
    },
    project: { ...manyIds, description: 'Project id(s)' },
    kind: { type: 'string', enum: ['task', 'assignment'] },
    controller: { type: 'string', description: 'user id or `me` — who accepts the work' },
    bucket: { type: 'string', enum: ['week', 'month'], description: 'Trends only' },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 10,
      description: 'Top lists only',
    },
  },
} as const;

const counters = {
  type: 'object',
  properties: {
    created: { type: 'integer' },
    completed: { type: 'integer' },
    on_time: { type: 'integer' },
    late: { type: 'integer' },
    no_deadline: { type: 'integer' },
    discipline: { type: 'number', nullable: true },
    open: { type: 'integer' },
    overdue: { type: 'integer' },
    unacknowledged: { type: 'integer' },
    median_execution_days: { type: 'number', nullable: true },
    median_reaction_hours: { type: 'number', nullable: true },
    deadline_changes: { type: 'integer' },
    returns: { type: 'integer' },
  },
} as const;

const period = {
  type: 'object',
  properties: { from: { type: 'string' }, to: { type: 'string' } },
} as const;

const scope = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['all', 'departments', 'self'] },
    department_ids: { type: 'array', items: { type: 'string' } },
  },
} as const;

const anyObject = { type: 'object', additionalProperties: true } as const;
const security = [{ bearerAuth: [] }];
const tags = ['Analytics'];

const envelope = (data: object) => ({
  type: 'object',
  properties: { period, scope, ...data },
});

export const summarySchema = {
  tags,
  security,
  summary: 'KPI of execution discipline with the previous period for comparison',
  description:
    'Admins see the whole workspace, a department head — their subtree, anyone else — their own work. ' +
    'Metric definitions: docs/METRICS.md.',
  querystring: analyticsQuerystring,
  response: {
    200: envelope({ previous_period: period, current: counters, previous: counters }),
  },
};

export const byDepartmentSchema = {
  tags,
  security,
  summary: 'Department tree with aggregates (own work and rolled up with sub-departments)',
  querystring: analyticsQuerystring,
  response: {
    200: envelope({
      tree: { type: 'array', items: anyObject },
      unassigned: { ...counters, nullable: true },
    }),
  },
};

export const byAssigneeSchema = {
  tags,
  security,
  summary: 'Per person: load (primary / co-assignee), overdue, discipline',
  querystring: analyticsQuerystring,
  response: { 200: envelope({ items: { type: 'array', items: anyObject } }) },
};

export const byProjectSchema = {
  tags,
  security,
  summary: 'Per project: progress, overdue, discipline',
  querystring: analyticsQuerystring,
  response: { 200: envelope({ items: { type: 'array', items: anyObject } }) },
};

export const trendsSchema = {
  tags,
  security,
  summary: 'Discipline by week or month over the period',
  querystring: analyticsQuerystring,
  response: {
    200: envelope({ bucket: { type: 'string' }, items: { type: 'array', items: anyObject } }),
  },
};

export const overdueSchema = {
  tags,
  security,
  summary: 'Top overdue work (most days past the deadline first)',
  querystring: analyticsQuerystring,
  response: {
    200: envelope({ total: { type: 'integer' }, items: { type: 'array', items: anyObject } }),
  },
};

export const deadlineChangesSchema = {
  tags,
  security,
  summary: 'Deadline moves in the period: counts by status and the latest approved ones',
  querystring: analyticsQuerystring,
  response: {
    200: envelope({
      approved: { type: 'integer' },
      rejected: { type: 'integer' },
      pending: { type: 'integer' },
      returns: { type: 'integer' },
      items: { type: 'array', items: anyObject },
    }),
  },
};

export const reactionTimeSchema = {
  tags,
  security,
  summary: 'Reaction time (assigned → acknowledged), median overall and by department',
  querystring: analyticsQuerystring,
  response: {
    200: envelope({
      median_hours: { type: 'number', nullable: true },
      acknowledged: { type: 'integer' },
      unacknowledged: { type: 'integer' },
      by_department: { type: 'array', items: anyObject },
    }),
  },
};

const fileResponse = (summary: string, description: string) => ({
  tags: ['Reports'],
  security,
  summary,
  description: `${description} Same filters and visibility as analytics. Every export is recorded in the activity log (action \`report.exported\`).`,
  querystring: analyticsQuerystring,
});

export const assignmentsXlsxSchema = fileResponse(
  'Реестр поручений (XLSX)',
  'Work active in the period (created before its end and not closed before its start), with deadline status, frozen header and autofilter.',
);

export const disciplinePdfSchema = fileResponse(
  'Справка об исполнении поручений (PDF)',
  'A4: workspace header, period, KPI, table by department, overdue list, signature block.',
);

export const projectPdfSchema = {
  ...fileResponse(
    'Отчёт по проекту (PDF)',
    'KPI of the project, departments, people and overdue work.',
  ),
  querystring: analyticsQuerystring,
};
