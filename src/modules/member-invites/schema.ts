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
    // The place in the org structure the member gets on accepting (4.F10, 4.B1).
    department_id: z.string().uuid().optional().nullable(),
    position: z.string().trim().max(150).optional().nullable(),
  })
  .refine((v) => Boolean(v.user_id) !== Boolean(v.email), {
    message: 'Provide exactly one of user_id or email',
    path: ['user_id'],
  });

export type InviteExistingUserBody = z.infer<typeof InviteExistingUserBodySchema>;

// ─── Fastify route schemas ────────────────────────────────────────────────────

const security = [{ bearerAuth: [] }];

// Standard error envelope (TZ §8), mirroring the auth module. Attached as the `default`
// response on every route via `responses()` so each endpoint documents its failure shape
// in OpenAPI and Fastify serializes any error status through it.
const errorResponse = {
  type: 'object',
  description: 'Error envelope: `{ error: { code, message, details? } }`',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['code', 'message'],
      additionalProperties: true,
    },
  },
} as const;

/** Merge a route's success responses with the shared `default` error envelope. */
function responses(map: Record<string, unknown>): Record<string, unknown> {
  return { ...map, default: errorResponse };
}

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
  description: [
    'Creates a pending invite for an **existing** account and fans it out to every channel',
    'the target owns — email if they have one, Telegram (inline Accept/Decline buttons) if a',
    'Telegram identity is linked. The invite is always visible in the target’s in-app',
    'invitations inbox (`GET /invitations`) and can be accepted from any channel.',
    '',
    'Identify the target by **exactly one** of `user_id` (works for everyone, including',
    'Telegram-only accounts with no email) or `email`. Requires the `admin` or `owner` role.',
    '',
    'Errors: `400` neither/both identifiers, or inviting yourself; `403` caller is not an',
    'admin/owner; `404` target user not found or inactive; `409` target is already a member.',
    'The response `delivered_to` lists the channels the invite was successfully pushed to; the',
    'invite `token` is never exposed (it addresses Telegram callbacks only).',
  ].join('\n'),
  security,
  params: {
    type: 'object',
    required: ['workspaceSlug'],
    properties: { workspaceSlug: { type: 'string', description: 'Workspace slug' } },
  },
  body: {
    type: 'object',
    description: 'Provide exactly one of `user_id` or `email`.',
    properties: {
      user_id: { type: 'string', format: 'uuid', description: 'Target user id' },
      email: { type: 'string', format: 'email', description: 'Target account email' },
      role: {
        type: 'string',
        enum: ['admin', 'member', 'guest'],
        default: 'member',
        description: 'Role granted on accept (owner is not assignable here)',
      },
      department_id: {
        type: 'string',
        format: 'uuid',
        nullable: true,
        description: 'Department the member is placed in on accepting',
      },
      position: {
        type: 'string',
        maxLength: 150,
        nullable: true,
        description: 'Position set on accepting',
      },
    },
  },
  response: responses({
    201: {
      type: 'object',
      description: 'The created invite plus the channels it was delivered to.',
      properties: {
        invite: memberInviteShape,
        delivered_to: {
          type: 'array',
          description: 'Channels the invite was successfully pushed to.',
          items: { type: 'string', enum: ['email', 'telegram'] },
        },
      },
    },
  }),
};

export const listMyInvitesSchema: FastifySchema = {
  tags: ['Invitations'],
  summary: 'List the current user’s pending workspace invitations (across workspaces)',
  description:
    'Returns the authenticated user’s **pending, non-expired** invitations across all workspaces, newest first, each with its workspace and inviter. Accepted/declined/expired invites are omitted. This is the in-app inbox surface — it is not workspace-scoped, since the recipient is not yet a member of the inviting workspace.',
  security,
  response: responses({ 200: { type: 'array', items: inboxItemShape } }),
};

export const acceptInviteSchema: FastifySchema = {
  tags: ['Invitations'],
  summary: 'Accept a workspace invitation (joins the workspace)',
  description: [
    'Accepts a pending invitation addressed to the authenticated user and creates their',
    'workspace membership with the invited role. Idempotent: re-accepting an invite that was',
    'already accepted (and whose membership exists) returns `200` with the existing member.',
    '',
    'Errors: `404` invite does not exist or is not addressed to the caller (chosen over `403`',
    'so other users’ invites are never revealed); `409` already declined/accepted with no',
    'membership; `410` the invite has expired.',
  ].join('\n'),
  security,
  params: {
    type: 'object',
    required: ['inviteId'],
    properties: { inviteId: { type: 'string', description: 'Invitation id' } },
  },
  response: responses({ 200: responseShape }),
};

export const declineInviteSchema: FastifySchema = {
  tags: ['Invitations'],
  summary: 'Decline a workspace invitation',
  description:
    'Declines a pending invitation addressed to the authenticated user; no membership is created and `member` is `null`. Errors mirror accept: `404` unknown/not-yours, `409` already responded, `410` expired.',
  security,
  params: {
    type: 'object',
    required: ['inviteId'],
    properties: { inviteId: { type: 'string', description: 'Invitation id' } },
  },
  response: responses({ 200: responseShape }),
};
