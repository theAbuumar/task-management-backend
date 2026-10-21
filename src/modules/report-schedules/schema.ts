// Input and response schemas of planned reports (Ф10 10.B5, ADR-032).

import { z } from 'zod';

export const REPORTS = ['discipline', 'assignments', 'project'] as const;
export const PERIODS = [
  'previous_week',
  'previous_month',
  'previous_quarter',
  'last_30_days',
] as const;
export const FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly'] as const;
export const CHANNELS = ['telegram', 'email'] as const;

const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected a time like 08:00');
const ids = z.array(z.string().uuid()).max(20);

export const ReportFiltersSchema = z
  .object({
    department: ids.optional(),
    project: ids.optional(),
    kind: z.enum(['task', 'assignment']).optional(),
  })
  .strict();
export type ReportFilters = z.infer<typeof ReportFiltersSchema>;

const fields = {
  name: z.string().trim().max(120).nullable(),
  report: z.enum(REPORTS),
  filters: ReportFiltersSchema,
  period: z.enum(PERIODS),
  frequency: z.enum(FREQUENCIES),
  by_weekday: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  by_monthday: z.number().int().min(1).max(31),
  time: TimeSchema,
  recipient_ids: z.array(z.string().uuid()).min(1).max(50),
  channels: z.array(z.enum(CHANNELS)).min(1).max(2),
};

export const CreateScheduleBodySchema = z
  .object({
    ...fields,
    name: fields.name.optional(),
    filters: fields.filters.default({}),
    period: fields.period.optional(),
    by_weekday: fields.by_weekday.optional(),
    by_monthday: fields.by_monthday.optional(),
    time: fields.time.default('08:00'),
    recipient_ids: fields.recipient_ids.optional(),
    channels: fields.channels.default(['telegram', 'email']),
  })
  .strict();
export type CreateScheduleBody = z.infer<typeof CreateScheduleBodySchema>;

export const UpdateScheduleBodySchema = z
  .object({ ...fields, is_active: z.boolean() })
  .partial()
  .strict();
export type UpdateScheduleBody = z.infer<typeof UpdateScheduleBodySchema>;

// ─── Fastify schemas (Swagger) ────────────────────────────────────────────────

const security = [{ bearerAuth: [] }];
const tags = ['Report schedules'];

const person = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    display_name: { type: 'string' },
    last_name: { type: 'string', nullable: true },
    first_name: { type: 'string', nullable: true },
    middle_name: { type: 'string', nullable: true },
    avatar_url: { type: 'string', nullable: true },
  },
} as const;

const filtersShape = {
  type: 'object',
  properties: {
    department: { type: 'array', items: { type: 'string' } },
    project: { type: 'array', items: { type: 'string' } },
    kind: { type: 'string', enum: ['task', 'assignment'] },
  },
  description:
    'Analytics filters (10.B1): departments (with sub-departments), projects, kind. ' +
    'The `project` report takes exactly one project.',
} as const;

const runShape = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    schedule_id: { type: 'string' },
    triggered_by_id: {
      type: 'string',
      nullable: true,
      description: '«Отправить сейчас»; null — the schedule',
    },
    period_from: { type: 'string' },
    period_to: { type: 'string' },
    status: { type: 'string', enum: ['sent', 'partial', 'failed'] },
    error: {
      type: 'string',
      nullable: true,
      description: 'Why the document was not made (failed)',
    },
    file_name: { type: 'string', nullable: true },
    file_size: { type: 'integer', nullable: true },
    summary: {
      type: 'object',
      additionalProperties: true,
      description: 'created, completed, on_time, late, overdue, open, discipline',
    },
    deliveries: {
      type: 'array',
      description:
        'Per recipient and channel: sent | failed | skipped (NO_TELEGRAM, NO_EMAIL, NOT_MEMBER). ' +
        'A recipient who cannot edit the report sees only their own rows.',
      items: {
        type: 'object',
        properties: {
          user_id: { type: 'string' },
          channel: { type: 'string', enum: ['telegram', 'email'] },
          status: { type: 'string', enum: ['sent', 'failed', 'skipped'] },
          error: { type: 'string', nullable: true },
        },
      },
    },
    can_download: { type: 'boolean' },
    created_at: { type: 'string', format: 'date-time' },
  },
} as const;

const scheduleShape = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string', nullable: true },
    report: { type: 'string', enum: REPORTS },
    filters: filtersShape,
    period: { type: 'string', enum: PERIODS },
    frequency: { type: 'string', enum: FREQUENCIES },
    by_weekday: { type: 'array', items: { type: 'integer' } },
    by_monthday: { type: 'integer', nullable: true },
    time: { type: 'string' },
    recipient_ids: { type: 'array', items: { type: 'string' } },
    recipients: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ...person.properties,
          has_telegram: { type: 'boolean', nullable: true },
          has_email: { type: 'boolean', nullable: true },
          active: { type: 'boolean', description: 'Still an active member' },
        },
      },
      description: '`has_telegram` / `has_email` are shown to those who can edit the report',
    },
    channels: { type: 'array', items: { type: 'string', enum: CHANNELS } },
    next_run_at: { type: 'string', format: 'date-time', nullable: true },
    last_run_at: { type: 'string', format: 'date-time', nullable: true },
    last_error: {
      type: 'string',
      nullable: true,
      description:
        'Why the latest run sent nothing, or why the report is paused: AUTHOR_NOT_MEMBER, ' +
        'MEMBER_DEACTIVATED, GUEST_READ_ONLY, AUTHOR_NOT_ADMIN (paused); FORBIDDEN, ' +
        'PROJECT_NOT_FOUND… (waits for the next run)',
    },
    is_active: { type: 'boolean' },
    created_by: person,
    can_edit: { type: 'boolean', description: 'The caller is the author or an admin' },
    last_run: { ...runShape, nullable: true },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
} as const;

const idParams = {
  type: 'object',
  properties: { workspaceSlug: { type: 'string' }, scheduleId: { type: 'string' } },
} as const;

const scheduleBody = {
  name: { type: 'string', nullable: true, maxLength: 120 },
  report: {
    type: 'string',
    enum: REPORTS,
    description:
      'discipline — «Справка об исполнении поручений» (PDF), assignments — «Реестр поручений» ' +
      '(XLSX), project — «Отчёт по проекту» (PDF)',
  },
  filters: filtersShape,
  period: {
    type: 'string',
    enum: PERIODS,
    description:
      'Whole days before the day of sending: the previous week (Mon–Sun), month or quarter, ' +
      'or the 30 days up to yesterday. Default: by the frequency (daily → last_30_days).',
  },
  frequency: { type: 'string', enum: FREQUENCIES },
  by_weekday: {
    type: 'array',
    items: { type: 'integer', minimum: 1, maximum: 7 },
    description: 'weekly: ISO weekdays, 1 = Monday (default Monday)',
  },
  by_monthday: {
    type: 'integer',
    minimum: 1,
    maximum: 31,
    description: 'monthly / quarterly: day of the month (default 1); past its end — the last day',
  },
  time: { type: 'string', description: 'HH:MM in the workspace zone (default 08:00)' },
  recipient_ids: {
    type: 'array',
    items: { type: 'string' },
    description:
      'Default: the author. Anyone but the author only in a report of an admin or the owner — ' +
      '`403 REPORT_RECIPIENTS_FORBIDDEN`; each must be an active member — `400 RECIPIENT_NOT_MEMBER`.',
  },
  channels: {
    type: 'array',
    items: { type: 'string', enum: CHANNELS },
    description: 'Telegram and/or email (default both); the in-app notification is always made',
  },
} as const;

export const listSchedulesSchema = {
  tags,
  summary: 'Planned reports',
  description:
    'Admins and the owner see every planned report of the workspace, anyone else — their own ' +
    'and those they receive.',
  security,
  response: {
    200: { type: 'object', properties: { data: { type: 'array', items: scheduleShape } } },
  },
};

export const getScheduleSchema = {
  tags,
  summary: 'One planned report',
  security,
  params: idParams,
  response: { 200: scheduleShape },
};

export const createScheduleSchema = {
  tags,
  summary: 'Create a planned report',
  description:
    'Any member but a guest. The document is built with the author’s rights at the time of ' +
    'sending (10.B3): an admin — the whole workspace, a department head — their subtree, anyone ' +
    'else — their own work. The filters are checked against them now (`403 FORBIDDEN` for a ' +
    'department outside the author’s area). Runs in the scheduler pass in the workspace zone.',
  security,
  body: {
    type: 'object',
    required: ['report', 'frequency'],
    properties: scheduleBody,
  },
  response: { 201: scheduleShape },
};

export const updateScheduleSchema = {
  tags,
  summary: 'Change, pause or resume a planned report (its author or an admin)',
  description:
    'A changed schedule or a resumed report counts its next run from now: missed runs are not made up.',
  security,
  params: idParams,
  body: { type: 'object', properties: { ...scheduleBody, is_active: { type: 'boolean' } } },
  response: { 200: scheduleShape },
};

export const deleteScheduleSchema = {
  tags,
  summary: 'Delete a planned report with its history and files (its author or an admin)',
  security,
  params: idParams,
  response: { 204: { type: 'null' } },
};

export const runScheduleSchema = {
  tags,
  summary: '«Отправить сейчас»: make and send the report outside its schedule',
  description:
    'The author or an admin. The schedule is kept. Counts against the export budget (12.B5). ' +
    '`409` with the pause reason when the author can no longer send it (AUTHOR_NOT_MEMBER…).',
  security,
  params: idParams,
  response: { 201: runShape },
};

export const listRunsSchema = {
  tags,
  summary: 'History of a planned report: the latest 12 sendings',
  description: 'A recipient who cannot edit the report sees the sendings that came to them.',
  security,
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'array', items: runShape } } },
  },
};

export const downloadRunSchema = {
  tags,
  summary: 'A link to the file of one sending',
  description:
    'The author, admins and the recipients of that sending. Written to the audit log as ' +
    '`report.exported`. The link is short-lived and downloads as an attachment.',
  security,
  params: {
    type: 'object',
    properties: { workspaceSlug: { type: 'string' }, runId: { type: 'string' } },
  },
  response: {
    200: {
      type: 'object',
      properties: { url: { type: 'string' }, file_name: { type: 'string' } },
    },
  },
};
