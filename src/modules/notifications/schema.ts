import { z } from 'zod';
import type { FastifySchema } from 'fastify';

/** Every notification type (ADR-020) — mirrors the Prisma `NotificationType` enum. */
export const NOTIFICATION_TYPES = [
  'issue_assigned',
  'comment_added',
  'mentioned',
  'state_changed',
  'review_requested',
  'review_approved',
  'review_returned',
  'acknowledged',
  'due_soon',
  'overdue',
  'escalated',
  'deadline_change_requested',
  'deadline_change_decided',
  'invite_received',
  'report_ready',
  'digest',
] as const;

export const NotificationListQuerySchema = z.object({
  /** Filter by read state. Omit for all. */
  read: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  /** Only these types: `?type=a&type=b` or `?type=a,b`. */
  type: z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : [v]).flatMap((x) => x.split(',')).filter(Boolean))
    .pipe(z.array(z.enum(NOTIFICATION_TYPES)))
    .optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type NotificationListQuery = z.infer<typeof NotificationListQuerySchema>;

// ─── Fastify route schemas ────────────────────────────────────────────────────

const security = [{ bearerAuth: [] }];

const actorShape = {
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

// Enough of the issue to render the row and open it (ACCR-12 · title).
const issueBriefShape = {
  type: 'object',
  nullable: true,
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    sequence_id: { type: 'integer' },
    project_id: { type: 'string' },
    kind: { type: 'string', enum: ['task', 'assignment'] },
    due_date: { type: 'string', format: 'date-time', nullable: true },
    project: {
      type: 'object',
      properties: { identifier: { type: 'string' }, name: { type: 'string' } },
    },
  },
} as const;

const notificationShape = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    workspace_id: { type: 'string' },
    recipient_id: { type: 'string' },
    actor_id: { type: 'string' },
    type: { type: 'string', enum: NOTIFICATION_TYPES },
    issue_id: { type: 'string', nullable: true },
    entity_id: { type: 'string', nullable: true },
    is_read: { type: 'boolean' },
    read_at: { type: 'string', format: 'date-time', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
    actor: actorShape,
    issue: issueBriefShape,
    // Only on deadline_change_decided: the decision and the requested date.
    details: {
      type: 'object',
      nullable: true,
      properties: {
        approved: { type: 'boolean' },
        new_due_date: { type: 'string', format: 'date-time' },
      },
    },
  },
} as const;

export const listNotificationsSchema: FastifySchema = {
  tags: ['Notifications'],
  summary: "List the current user's notifications in a workspace (newest first)",
  security,
  querystring: {
    type: 'object',
    properties: {
      read: { type: 'string', enum: ['true', 'false'] },
      type: {
        description: 'Only these types (repeat the param or separate with commas)',
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
      },
      cursor: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        data: { type: 'array', items: notificationShape },
        unread_count: { type: 'integer' },
        next_cursor: { type: 'string', nullable: true },
      },
    },
  },
};

export const markReadSchema: FastifySchema = {
  tags: ['Notifications'],
  summary: 'Mark a single notification as read',
  security,
  response: { 200: notificationShape },
};

export const markUnreadSchema: FastifySchema = {
  tags: ['Notifications'],
  summary: 'Mark a single notification as unread again',
  security,
  response: { 200: notificationShape },
};

export const markAllReadSchema: FastifySchema = {
  tags: ['Notifications'],
  summary: 'Mark all of the current user notifications in this workspace as read',
  security,
  response: {
    200: {
      type: 'object',
      properties: { updated: { type: 'integer' } },
    },
  },
};
