import { z } from 'zod';
import type { FastifySchema } from 'fastify';

// ─── Zod validators ───────────────────────────────────────────────────────────

export const CreateWorkspaceBodySchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9-]+$/, 'Slug may only contain lowercase letters, digits, and hyphens'),
});

export const UpdateWorkspaceBodySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9-]+$/, 'Slug may only contain lowercase letters, digits, and hyphens')
    .optional(),
});

export const AddMemberBodySchema = z.object({
  user_id: z.string().uuid(),
  role: z.enum(['admin', 'member', 'guest']).default('member'),
});

export const ChangeMemberRoleBodySchema = z.object({
  role: z.enum(['admin', 'member', 'guest']),
});

export const InviteMemberBodySchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member', 'guest']).default('member'),
});

export type CreateWorkspaceBody = z.infer<typeof CreateWorkspaceBodySchema>;
export type UpdateWorkspaceBody = z.infer<typeof UpdateWorkspaceBodySchema>;
export type AddMemberBody = z.infer<typeof AddMemberBodySchema>;
export type ChangeMemberRoleBody = z.infer<typeof ChangeMemberRoleBodySchema>;
export type InviteMemberBody = z.infer<typeof InviteMemberBodySchema>;

// ─── Fastify route schemas ────────────────────────────────────────────────────

const workspaceShape = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    slug: { type: 'string' },
    owner_id: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
} as const;

const memberShape = {
  type: 'object',
  properties: {
    workspace_id: { type: 'string' },
    user_id: { type: 'string' },
    role: { type: 'string', enum: ['owner', 'admin', 'member', 'guest'] },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
    user: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        email: { type: 'string' },
        display_name: { type: 'string' },
        avatar_url: { type: 'string', nullable: true },
      },
    },
  },
} as const;

const security = [{ bearerAuth: [] }];

export const listWorkspacesSchema: FastifySchema = {
  tags: ['Workspaces'],
  summary: 'List workspaces the authenticated user belongs to',
  security,
  response: { 200: { type: 'array', items: workspaceShape } },
};

export const createWorkspaceSchema: FastifySchema = {
  tags: ['Workspaces'],
  summary: 'Create a new workspace',
  security,
  body: {
    type: 'object',
    required: ['name', 'slug'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 },
      slug: { type: 'string', minLength: 2, maxLength: 50, pattern: '^[a-z0-9-]+$' },
    },
  },
  response: { 201: workspaceShape },
};

export const getWorkspaceSchema: FastifySchema = {
  tags: ['Workspaces'],
  summary: 'Get workspace details',
  security,
  params: { type: 'object', properties: { workspaceSlug: { type: 'string' } } },
  response: { 200: workspaceShape },
};

export const updateWorkspaceSchema: FastifySchema = {
  tags: ['Workspaces'],
  summary: 'Update workspace (admin+)',
  security,
  params: { type: 'object', properties: { workspaceSlug: { type: 'string' } } },
  body: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 },
      slug: { type: 'string', minLength: 2, maxLength: 50, pattern: '^[a-z0-9-]+$' },
    },
  },
  response: { 200: workspaceShape },
};

export const deleteWorkspaceSchema: FastifySchema = {
  tags: ['Workspaces'],
  summary: 'Delete workspace (owner only)',
  security,
  params: { type: 'object', properties: { workspaceSlug: { type: 'string' } } },
  response: { 204: { type: 'null' } },
};

export const listMembersSchema: FastifySchema = {
  tags: ['Workspaces'],
  summary: 'List workspace members',
  security,
  params: { type: 'object', properties: { workspaceSlug: { type: 'string' } } },
  response: { 200: { type: 'array', items: memberShape } },
};

export const addMemberSchema: FastifySchema = {
  tags: ['Workspaces'],
  summary: 'Add an existing user to the workspace (admin+)',
  security,
  params: { type: 'object', properties: { workspaceSlug: { type: 'string' } } },
  body: {
    type: 'object',
    required: ['user_id'],
    properties: {
      user_id: { type: 'string', format: 'uuid' },
      role: { type: 'string', enum: ['admin', 'member', 'guest'] },
    },
  },
  response: { 201: memberShape },
};

export const changeMemberRoleSchema: FastifySchema = {
  tags: ['Workspaces'],
  summary: 'Change a member role (admin+)',
  security,
  params: {
    type: 'object',
    properties: { workspaceSlug: { type: 'string' }, userId: { type: 'string' } },
  },
  body: {
    type: 'object',
    required: ['role'],
    properties: { role: { type: 'string', enum: ['admin', 'member', 'guest'] } },
  },
  response: { 200: memberShape },
};

export const removeMemberSchema: FastifySchema = {
  tags: ['Workspaces'],
  summary: 'Remove a member from the workspace (admin+)',
  security,
  params: {
    type: 'object',
    properties: { workspaceSlug: { type: 'string' }, userId: { type: 'string' } },
  },
  response: { 204: { type: 'null' } },
};

export const leaveWorkspaceSchema: FastifySchema = {
  tags: ['Workspaces'],
  summary: 'Leave the workspace (any member except the owner)',
  description:
    'Removes the caller from the workspace and its projects. The owner gets 403 `OWNER_CANNOT_LEAVE` until ownership is transferred.',
  security,
  params: {
    type: 'object',
    properties: { workspaceSlug: { type: 'string' } },
  },
  response: { 204: { type: 'null' } },
};

const inviteShape = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    workspace_id: { type: 'string' },
    invited_by_id: { type: 'string' },
    email: { type: 'string' },
    role: { type: 'string', enum: ['admin', 'member', 'guest'] },
    token: { type: 'string' },
    expires_at: { type: 'string', format: 'date-time' },
    accepted_at: { type: 'string', format: 'date-time', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
  },
} as const;

export const inviteMemberSchema: FastifySchema = {
  tags: ['Workspaces'],
  summary: 'Invite a user to the workspace by email (admin+)',
  security,
  params: { type: 'object', properties: { workspaceSlug: { type: 'string' } } },
  body: {
    type: 'object',
    required: ['email'],
    properties: {
      email: { type: 'string', format: 'email' },
      role: { type: 'string', enum: ['admin', 'member', 'guest'] },
    },
  },
  response: { 201: inviteShape },
};
