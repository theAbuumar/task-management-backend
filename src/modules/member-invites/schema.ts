import { z } from 'zod';
import type { FastifySchema } from 'fastify';

// ─── Zod validators ───────────────────────────────────────────────────────────

/**
 * Invite an already-registered user. The admin identifies the target by `user_id`
 * (works for everyone, including Telegram-only accounts that have no email) or by
 * `email` (convenience for accounts that have one). Exactly one must be provided.
 */
export const InviteExistingUserBodySchema = z
  .object({
    user_id: z.string().uuid().optional(),
    email: z.string().email().optional(),
    role: z.enum(['admin', 'member', 'guest']).default('member'),
  })
  .refine((v) => Boolean(v.user_id) !== Boolean(v.email), {
    message: 'Provide exactly one of user_id or email',
    path: ['user_id'],
  });

export type InviteExistingUserBody = z.infer<typeof InviteExistingUserBodySchema>;

// ─── Fastify route schemas ────────────────────────────────────────────────────

const security = [{ bearerAuth: [] }];

const memberInviteShape = {
  type: 'object',
  // `token` is intentionally omitted — it addresses Telegram callbacks only and is
  // never exposed in API responses (Fastify strips props absent from the schema).
  properties: {
    id: { type: 'string' },
    workspace_id: { type: 'string' },
    inviter_id: { type: 'string' },
    target_user_id: { type: 'string' },
    role: { type: 'string', enum: ['owner', 'admin', 'member', 'guest'] },
    status: { type: 'string', enum: ['pending', 'accepted', 'declined', 'expired'] },
    expires_at: { type: 'string', format: 'date-time' },
    responded_at: { type: 'string', format: 'date-time', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const memberShape = {
  type: 'object',
  nullable: true,
  properties: {
    workspace_id: { type: 'string' },
    user_id: { type: 'string' },
    role: { type: 'string', enum: ['owner', 'admin', 'member', 'guest'] },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

const inboxItemShape = {
  type: 'object',
  properties: {
    ...memberInviteShape.properties,
    workspace: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        slug: { type: 'string' },
      },
    },
    inviter: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        display_name: { type: 'string' },
        avatar_url: { type: 'string', nullable: true },
      },
    },
  },
};

const responseShape = {
  type: 'object',
  properties: {
    invite: memberInviteShape,
    member: memberShape,
  },
};

// POST /workspaces/:workspaceSlug/members/invite-user (admin+) — declared here so all
// member-invite schemas live together, imported by the workspaces route module.
export const inviteExistingUserSchema: FastifySchema = {
  tags: ['Workspaces'],
  summary: 'Invite an already-registered user to the workspace (admin+)',
  description:
    'Creates a pending invite for an existing account and delivers it to every channel the target owns — email if they have one, Telegram if a Telegram identity is linked. The invite is always visible in the target’s in-app invitations inbox and can be accepted from any channel. Identify the target by `user_id` or by `email` (exactly one).',
  security,
  params: { type: 'object', properties: { workspaceSlug: { type: 'string' } } },
  body: {
    type: 'object',
    properties: {
      user_id: { type: 'string', format: 'uuid' },
      email: { type: 'string', format: 'email' },
      role: { type: 'string', enum: ['admin', 'member', 'guest'] },
    },
  },
  response: {
    201: {
      type: 'object',
      properties: {
        invite: memberInviteShape,
        delivered_to: {
          type: 'array',
          items: { type: 'string', enum: ['email', 'telegram'] },
        },
      },
    },
  },
};

export const listMyInvitesSchema: FastifySchema = {
  tags: ['Invitations'],
  summary: 'List the current user’s pending workspace invitations (across workspaces)',
  security,
  response: { 200: { type: 'array', items: inboxItemShape } },
};

export const acceptInviteSchema: FastifySchema = {
  tags: ['Invitations'],
  summary: 'Accept a workspace invitation (joins the workspace)',
  security,
  params: { type: 'object', properties: { inviteId: { type: 'string' } } },
  response: { 200: responseShape },
};

export const declineInviteSchema: FastifySchema = {
  tags: ['Invitations'],
  summary: 'Decline a workspace invitation',
  security,
  params: { type: 'object', properties: { inviteId: { type: 'string' } } },
  response: { 200: responseShape },
};
