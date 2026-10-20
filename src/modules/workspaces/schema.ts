import { z } from 'zod';
import type { FastifySchema } from 'fastify';

// ─── Zod validators ───────────────────────────────────────────────────────────

/** IANA time zone the runtime knows (e.g. "Asia/Dushanbe"). */
const timeZone = z
  .string()
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown time zone');

const LOCALES = ['ru', 'en'] as const;

export const CreateWorkspaceBodySchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9-]+$/, 'Slug may only contain lowercase letters, digits, and hyphens'),
  short_name: z.string().max(30).optional().nullable(),
  description: z.string().max(1000).optional().nullable(),
  timezone: timeZone.optional(),
  locale: z.enum(LOCALES).optional(),
});

export const UpdateWorkspaceBodySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9-]+$/, 'Slug may only contain lowercase letters, digits, and hyphens')
    .optional(),
  short_name: z.string().max(30).optional().nullable(),
  description: z.string().max(1000).optional().nullable(),
  logo_url: z.string().url().max(2000).optional().nullable(),
  timezone: timeZone.optional(),
  locale: z.enum(LOCALES).optional(),
});

// Add a registered person right away, no invitation (4.F10): by id or by email,
// optionally with their place in the org structure.
export const AddMemberBodySchema = z
  .object({
    user_id: z.string().uuid().optional(),
    email: z.string().trim().toLowerCase().email().optional(),
    role: z.enum(['admin', 'member', 'guest']).default('member'),
    department_id: z.string().uuid().optional().nullable(),
    position: z.string().trim().max(150).optional().nullable(),
  })
  .refine((v) => Boolean(v.user_id) !== Boolean(v.email), {
    message: 'Provide exactly one of user_id or email',
    path: ['user_id'],
  });

// Update a member: access role and/or place in the org structure (ADR-007).
export const ChangeMemberRoleBodySchema = z
  .object({
    role: z.enum(['admin', 'member', 'guest']).optional(),
    department_id: z.string().uuid().optional().nullable(),
    position: z.string().trim().max(150).optional().nullable(),
  })
  .refine(
    (b) => b.role !== undefined || b.department_id !== undefined || b.position !== undefined,
    'Nothing to update',
  );

export const ListMembersQuerySchema = z.object({
  department: z.string().uuid().optional(),
  // Include sub-departments of `department` (default true).
  subtree: z.coerce.boolean().optional(),
  search: z.string().max(100).optional(),
});

const nameField = z.string().trim().max(60).optional().nullable();

export const InviteMemberBodySchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member', 'guest']).default('member'),
  // Given on accepting (staff import 4.B1): the place in the org structure, and the
  // full name for an account that has none yet.
  department_id: z.string().uuid().optional().nullable(),
  position: z.string().trim().max(150).optional().nullable(),
  last_name: nameField,
  first_name: nameField,
  middle_name: nameField,
});

export type ListMembersQuery = z.infer<typeof ListMembersQuerySchema>;
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
    short_name: { type: 'string', nullable: true },
    description: { type: 'string', nullable: true },
    logo_url: { type: 'string', nullable: true },
    timezone: { type: 'string' },
    locale: { type: 'string' },
    settings: { type: 'object', additionalProperties: true },
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
    department_id: { type: 'string', nullable: true },
    position: { type: 'string', nullable: true },
    // Access turned off by an admin (12.B7); null = active.
    deactivated_at: { type: 'string', format: 'date-time', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
    user: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        email: { type: 'string', nullable: true },
        display_name: { type: 'string' },
        last_name: { type: 'string', nullable: true },
        first_name: { type: 'string', nullable: true },
        middle_name: { type: 'string', nullable: true },
        avatar_url: { type: 'string', nullable: true },
      },
    },
    department: {
      type: 'object',
      nullable: true,
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        short_name: { type: 'string', nullable: true },
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
      short_name: { type: 'string', maxLength: 30, nullable: true },
      description: { type: 'string', maxLength: 1000, nullable: true },
      timezone: { type: 'string', maxLength: 64 },
      locale: { type: 'string', enum: ['ru', 'en'] },
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
      short_name: { type: 'string', maxLength: 30, nullable: true },
      description: { type: 'string', maxLength: 1000, nullable: true },
      logo_url: {
        type: 'string',
        nullable: true,
        description:
          'The `url` from `POST /workspaces/{slug}/logo` after uploading, or null to remove. The stored file must be this workspace’s png/jpeg/webp up to 2 MB (`INVALID_IMAGE`); the replaced logo is deleted.',
      },
      timezone: { type: 'string', maxLength: 64 },
      locale: { type: 'string', enum: ['ru', 'en'] },
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
  querystring: {
    type: 'object',
    properties: {
      department: { type: 'string', format: 'uuid' },
      subtree: { type: 'boolean' },
      search: { type: 'string', maxLength: 100 },
    },
  },
  response: { 200: { type: 'array', items: memberShape } },
};

export const addMemberSchema: FastifySchema = {
  tags: ['Workspaces'],
  summary: 'Add an existing user to the workspace right away, without an invitation (admin+)',
  description:
    'Identify the person by exactly one of `user_id` or `email` (4.F10). `department_id` and ' +
    '`position` place them in the org structure at once. No account with this email → ' +
    '`404 USER_NOT_FOUND` (send an invitation instead); already a member → `409 ALREADY_MEMBER`.',
  security,
  params: { type: 'object', properties: { workspaceSlug: { type: 'string' } } },
  body: {
    type: 'object',
    properties: {
      user_id: { type: 'string', format: 'uuid' },
      email: { type: 'string', format: 'email' },
      role: { type: 'string', enum: ['admin', 'member', 'guest'] },
      department_id: { type: 'string', format: 'uuid', nullable: true },
      position: { type: 'string', maxLength: 150, nullable: true },
    },
  },
  response: { 201: memberShape },
};

export const changeMemberRoleSchema: FastifySchema = {
  tags: ['Workspaces'],
  summary: 'Update a member: role, department, position (admin+)',
  description:
    'The owner role cannot be changed and you cannot change your own role; department and position can be set for anyone, including the owner and yourself.',
  security,
  params: {
    type: 'object',
    properties: { workspaceSlug: { type: 'string' }, userId: { type: 'string' } },
  },
  body: {
    type: 'object',
    properties: {
      role: { type: 'string', enum: ['admin', 'member', 'guest'] },
      department_id: { type: 'string', format: 'uuid', nullable: true },
      position: { type: 'string', maxLength: 150, nullable: true },
    },
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
  description:
    'An email with a link to sign up and join. `department_id` and `position` are applied on ' +
    'accepting; the name parts fill an account that has no full name yet (staff import, 4.B1).',
  security,
  params: { type: 'object', properties: { workspaceSlug: { type: 'string' } } },
  body: {
    type: 'object',
    required: ['email'],
    properties: {
      email: { type: 'string', format: 'email' },
      role: { type: 'string', enum: ['admin', 'member', 'guest'] },
      department_id: { type: 'string', format: 'uuid', nullable: true },
      position: { type: 'string', maxLength: 150, nullable: true },
      last_name: { type: 'string', maxLength: 60, nullable: true },
      first_name: { type: 'string', maxLength: 60, nullable: true },
      middle_name: { type: 'string', maxLength: 60, nullable: true },
    },
  },
  response: { 201: inviteShape },
};

// ─── Members' access (Ф12 12.B7, ADR-026) ─────────────────────────────────────

export const MemberIdentityParamsSchema = z.object({
  userId: z.string().uuid(),
  provider: z.enum(['google', 'github', 'telegram']),
});

const memberParams = {
  type: 'object',
  required: ['workspaceSlug', 'userId'],
  properties: { workspaceSlug: { type: 'string' }, userId: { type: 'string', format: 'uuid' } },
} as const;

const accessDescription =
  'Admin and owner only. Turning access off is per workspace: the account, the member’s tasks and history stay; ' +
  'their requests to this workspace answer 403 MEMBER_DEACTIVATED, nothing about its tasks reaches them by email or ' +
  'Telegram, and they cannot be assigned (400 MEMBER_DEACTIVATED). If no workspace with access is left, all their ' +
  'sessions end and sign-in is refused. The owner and yourself cannot be changed (403).';

export const listMemberAccessSchema: FastifySchema = {
  tags: ['Workspaces'],
  summary: 'Members’ access: deactivation, last sign-in, devices, login methods (admin+)',
  description: accessDescription,
  security,
  params: { type: 'object', properties: { workspaceSlug: { type: 'string' } } },
  response: {
    200: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          user_id: { type: 'string' },
          deactivated_at: { type: 'string', format: 'date-time', nullable: true },
          deactivated_by: {
            type: 'object',
            nullable: true,
            properties: { id: { type: 'string' }, display_name: { type: 'string' } },
          },
          last_login_at: { type: 'string', format: 'date-time', nullable: true },
          last_seen_at: { type: 'string', format: 'date-time', nullable: true },
          active_sessions: { type: 'integer' },
          providers: {
            type: 'array',
            items: { type: 'string', enum: ['email', 'google', 'github', 'telegram'] },
          },
          open_issues: { type: 'integer' },
        },
      },
    },
  },
};

export const deactivateMemberSchema: FastifySchema = {
  tags: ['Workspaces'],
  summary: 'Turn a member’s access to the workspace off (admin+)',
  description: `${accessDescription} \`signed_out\` — whether their sessions were ended (no workspace with access left).`,
  security,
  params: memberParams,
  response: {
    200: {
      type: 'object',
      properties: { member: memberShape, signed_out: { type: 'boolean' } },
    },
  },
};

export const activateMemberSchema: FastifySchema = {
  tags: ['Workspaces'],
  summary: 'Give a deactivated member their access back (admin+)',
  description: accessDescription,
  security,
  params: memberParams,
  response: { 200: memberShape },
};

export const resetMemberIdentitySchema: FastifySchema = {
  tags: ['Workspaces'],
  summary: 'Unlink a member’s Telegram, Google or GitHub (admin+)',
  description:
    'For a member who lost a phone or an account. The email cannot be unlinked, nor the last login method (403); ' +
    '404 when that method is not linked. Written to the audit log.',
  security,
  params: {
    type: 'object',
    required: ['workspaceSlug', 'userId', 'provider'],
    properties: {
      workspaceSlug: { type: 'string' },
      userId: { type: 'string', format: 'uuid' },
      provider: { type: 'string', enum: ['google', 'github', 'telegram'] },
    },
  },
  response: { 204: { type: 'null' } },
};
