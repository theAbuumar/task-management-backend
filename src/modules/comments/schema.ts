import { z } from 'zod';
import type { FastifySchema } from 'fastify';

export const CreateCommentBodySchema = z.object({
  body: z.string().min(1).max(50_000),
  parent_comment_id: z.string().uuid().optional().nullable(),
});

export const UpdateCommentBodySchema = z.object({
  body: z.string().min(1).max(50_000),
});

export type CreateCommentBody = z.infer<typeof CreateCommentBodySchema>;
export type UpdateCommentBody = z.infer<typeof UpdateCommentBodySchema>;

const commentShape = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    issue_id: { type: 'string' },
    author_id: { type: 'string' },
    body: { type: 'string' },
    parent_comment_id: { type: 'string', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
    // Set when the text was edited («изменено», 4.F8).
    edited_at: { type: 'string', format: 'date-time', nullable: true },
    // A deleted comment comes back only as the head of a thread with replies, with an empty body.
    deleted_at: { type: 'string', nullable: true },
    author: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        display_name: { type: 'string' },
        last_name: { type: 'string', nullable: true },
        first_name: { type: 'string', nullable: true },
        middle_name: { type: 'string', nullable: true },
        avatar_url: { type: 'string', nullable: true },
      },
    },
  },
} as const;

const security = [{ bearerAuth: [] }];

export const listCommentsSchema: FastifySchema = {
  tags: ['Comments'],
  summary: 'List comments on an issue',
  description:
    'Oldest first. Replies carry `parent_comment_id` of their thread head (one level). A deleted ' +
    'comment is listed only when it heads a thread with live replies, and its body is empty (ADR-031).',
  security,
  response: { 200: { type: 'array', items: commentShape } },
};

export const createCommentSchema: FastifySchema = {
  tags: ['Comments'],
  summary: 'Add a comment to an issue',
  description:
    '`@handle` (the part of a member’s email before «@») notifies that member. A reply to a reply ' +
    'joins the same thread: `parent_comment_id` of the response is the thread head.',
  security,
  body: {
    type: 'object',
    required: ['body'],
    properties: {
      body: { type: 'string', minLength: 1, maxLength: 50000 },
      parent_comment_id: { type: 'string', format: 'uuid', nullable: true },
    },
  },
  response: { 201: commentShape },
};

export const updateCommentSchema: FastifySchema = {
  tags: ['Comments'],
  summary: 'Edit a comment (author or admin)',
  description: 'Sets `edited_at`. Members mentioned for the first time by the edit are notified.',
  security,
  body: {
    type: 'object',
    required: ['body'],
    properties: { body: { type: 'string', minLength: 1, maxLength: 50000 } },
  },
  response: { 200: commentShape },
};

export const deleteCommentSchema: FastifySchema = {
  tags: ['Comments'],
  summary: 'Soft-delete a comment (author or admin)',
  security,
  response: { 204: { type: 'null' } },
};
