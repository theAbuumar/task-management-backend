import { z } from 'zod';
import type { FastifySchema } from 'fastify';

export const SubmitReviewBodySchema = z.object({
  report: z.string().max(10_000).optional().nullable(),
  // Already-uploaded attachments of this issue that make up the report.
  attachment_ids: z.array(z.string().uuid()).max(20).optional(),
});

export const DecideBodySchema = z.object({
  comment: z.string().max(5_000).optional().nullable(),
});

export const DeadlineRequestBodySchema = z.object({
  new_due_date: z.string().datetime(),
  reason: z.string().trim().min(3).max(2_000),
});

export type SubmitReviewBody = z.infer<typeof SubmitReviewBodySchema>;
export type DecideBody = z.infer<typeof DecideBodySchema>;
export type DeadlineRequestBody = z.infer<typeof DeadlineRequestBodySchema>;

const security = [{ bearerAuth: [] }];
const tags = ['Execution control'];
const anyObject = { type: 'object', additionalProperties: true } as const;
const issueParams = {
  type: 'object',
  properties: {
    workspaceSlug: { type: 'string' },
    projectId: { type: 'string' },
    issueId: { type: 'string' },
  },
} as const;

export const submitReviewSchema: FastifySchema = {
  tags,
  summary: 'Hand the work in for review (assignee)',
  description:
    'Opens a pending review with an optional report and attachments, moves the issue to the "На проверке" state and notifies the controller. Errors: NOT_ASSIGNEE, REVIEW_PENDING, REPORT_REQUIRED, NO_REVIEW_STATE.',
  security,
  params: issueParams,
  body: {
    type: 'object',
    properties: {
      report: { type: 'string', maxLength: 10000, nullable: true },
      attachment_ids: { type: 'array', items: { type: 'string', format: 'uuid' }, maxItems: 20 },
    },
  },
  response: { 200: anyObject },
};

export const approveReviewSchema: FastifySchema = {
  tags,
  summary: 'Accept the handed-in work (controller) → "Готово"',
  security,
  params: issueParams,
  body: { type: 'object', properties: { comment: { type: 'string', nullable: true } } },
  response: { 200: anyObject },
};

export const returnReviewSchema: FastifySchema = {
  tags,
  summary: 'Return the work for rework (controller, comment required) → "В работе"',
  security,
  params: issueParams,
  body: {
    type: 'object',
    required: ['comment'],
    properties: { comment: { type: 'string', minLength: 1, maxLength: 5000 } },
  },
  response: { 200: anyObject },
};

export const listReviewsSchema: FastifySchema = {
  tags,
  summary: 'History of hand-ins and decisions',
  security,
  params: issueParams,
  response: { 200: { type: 'array', items: anyObject } },
};

export const acknowledgeSchema: FastifySchema = {
  tags,
  summary: '"Ознакомлен" — the assignee confirms they saw the assignment',
  security,
  params: issueParams,
  response: { 200: anyObject },
};

export const createDeadlineRequestSchema: FastifySchema = {
  tags,
  summary: 'Ask the controller to move the deadline (assignee)',
  security,
  params: issueParams,
  body: {
    type: 'object',
    required: ['new_due_date', 'reason'],
    properties: {
      new_due_date: { type: 'string', format: 'date-time' },
      reason: { type: 'string', minLength: 3, maxLength: 2000 },
    },
  },
  response: { 201: anyObject },
};

export const decideDeadlineRequestSchema: FastifySchema = {
  tags,
  summary: 'Approve or reject a deadline change (controller)',
  security,
  params: {
    type: 'object',
    properties: { ...issueParams.properties, requestId: { type: 'string' } },
  },
  body: { type: 'object', properties: { comment: { type: 'string', nullable: true } } },
  response: { 200: anyObject },
};

export const listDeadlineRequestsSchema: FastifySchema = {
  tags,
  summary: 'Deadline change requests of the issue',
  security,
  params: issueParams,
  response: { 200: { type: 'array', items: anyObject } },
};

export const watchersSchema: FastifySchema = {
  tags,
  summary: 'Watchers of the issue',
  security,
  params: issueParams,
  response: { 200: { type: 'array', items: anyObject } },
};
