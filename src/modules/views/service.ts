// Saved views (Ф7 7.B4, ADR-029): a named set of page parameters. A view with a
// project opens that project's board with its filters; without one — the
// workspace list. Personal views belong to their author; shared ones are seen by
// everyone who can see the project and only admins (and the owner) manage them.
// The rules live here, not in the routes.

import { z } from 'zod';
import type { Prisma, PrismaClient, WorkspaceMember } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { seesAllProjects } from '../../plugins/workspace-hook.js';

export const VIEW_MODES = ['board', 'list', 'calendar', 'timeline'] as const;

/** Filter keys are short latin words; values are short strings or short lists. */
const filtersSchema = z
  .record(
    z.string().regex(/^[a-z_]{1,30}$/, 'Filter keys are latin words'),
    z.union([z.string().max(200), z.array(z.string().max(200)).max(50)]),
  )
  .refine((f) => Object.keys(f).length <= 20, 'At most 20 filters');

const displaySchema = z.object({ view: z.enum(VIEW_MODES).optional() }).strict();

export const CreateViewBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  project_id: z.string().uuid().nullable().optional(),
  filters: filtersSchema.default({}),
  display: displaySchema.default({}),
  is_shared: z.boolean().default(false),
});
export type CreateViewBody = z.infer<typeof CreateViewBodySchema>;

export const UpdateViewBodySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    filters: filtersSchema,
    display: displaySchema,
    is_shared: z.boolean(),
  })
  .partial();
export type UpdateViewBody = z.infer<typeof UpdateViewBodySchema>;

export const ListViewsQuerySchema = z.object({
  /** A project's views, or `workspace` for the views of the workspace list. */
  project: z.union([z.string().uuid(), z.literal('workspace')]).optional(),
});

const INCLUDE = {
  project: { select: { id: true, name: true, identifier: true, icon: true, color: true } },
  owner: { select: { id: true, display_name: true, avatar_url: true } },
} as const;

type Row = Prisma.SavedViewGetPayload<{ include: typeof INCLUDE }>;
export type SavedViewOut = Row & { can_edit: boolean };

function isAdmin(member: WorkspaceMember): boolean {
  return member.role === 'owner' || member.role === 'admin';
}

/** Projects a member may see: not deleted; private ones only for their members and admins. */
function visibleProject(member: WorkspaceMember): Prisma.ProjectWhereInput {
  return {
    deleted_at: null,
    ...(!seesAllProjects(member) && {
      OR: [{ visibility: 'public' }, { members: { some: { user_id: member.user_id } } }],
    }),
  };
}

/** Who sees a view: its author (personal), or anyone for a shared one — when its project is visible. */
function visibleViews(workspaceId: string, member: WorkspaceMember): Prisma.SavedViewWhereInput {
  return {
    workspace_id: workspaceId,
    AND: [
      { OR: [{ owner_id: member.user_id, is_shared: false }, { is_shared: true }] },
      { OR: [{ project_id: null }, { project: visibleProject(member) }] },
    ],
  };
}

/** A shared view is everyone's workspace: admins manage it. A personal one — its author. */
function canEdit(view: { owner_id: string; is_shared: boolean }, member: WorkspaceMember): boolean {
  return view.is_shared ? isAdmin(member) : view.owner_id === member.user_id;
}

const out = (view: Row, member: WorkspaceMember): SavedViewOut => ({
  ...view,
  can_edit: canEdit(view, member),
});

function assertMayShare(member: WorkspaceMember): void {
  if (!isAdmin(member)) {
    throw new AppError(
      403,
      'FORBIDDEN',
      'Only an admin or the owner can create or change a shared view',
    );
  }
}

async function findVisible(
  prisma: PrismaClient,
  workspaceId: string,
  member: WorkspaceMember,
  viewId: string,
): Promise<Row> {
  const view = await prisma.savedView.findFirst({
    where: { id: viewId, ...visibleViews(workspaceId, member) },
    include: INCLUDE,
  });
  if (!view) throw AppError.notFound('View not found');
  return view;
}

export async function listViews(
  prisma: PrismaClient,
  workspaceId: string,
  member: WorkspaceMember,
  query: z.infer<typeof ListViewsQuerySchema>,
): Promise<{ data: SavedViewOut[] }> {
  const views = await prisma.savedView.findMany({
    where: {
      ...visibleViews(workspaceId, member),
      ...(query.project === 'workspace' && { project_id: null }),
      ...(query.project && query.project !== 'workspace' && { project_id: query.project }),
    },
    include: INCLUDE,
    // Shared first, then by name.
    orderBy: [{ is_shared: 'desc' }, { name: 'asc' }],
  });
  return { data: views.map((v) => out(v, member)) };
}

export async function createView(
  prisma: PrismaClient,
  workspaceId: string,
  member: WorkspaceMember,
  body: CreateViewBody,
): Promise<SavedViewOut> {
  if (body.is_shared) assertMayShare(member);
  if (body.project_id) {
    const project = await prisma.project.findFirst({
      where: { id: body.project_id, workspace_id: workspaceId, ...visibleProject(member) },
      select: { id: true },
    });
    if (!project) throw AppError.notFound('Project not found');
  }
  const view = await prisma.savedView.create({
    data: {
      workspace_id: workspaceId,
      project_id: body.project_id ?? null,
      owner_id: member.user_id,
      name: body.name,
      filters: body.filters,
      display: body.display,
      is_shared: body.is_shared,
    },
    include: INCLUDE,
  });
  return out(view, member);
}

export async function updateView(
  prisma: PrismaClient,
  workspaceId: string,
  member: WorkspaceMember,
  viewId: string,
  body: UpdateViewBody,
): Promise<SavedViewOut> {
  const view = await findVisible(prisma, workspaceId, member, viewId);
  if (!canEdit(view, member)) {
    throw new AppError(403, 'FORBIDDEN', 'Only an admin or the owner can change a shared view');
  }
  // Sharing someone's personal view, or making a shared one personal, is an admin's call.
  if (body.is_shared !== undefined && body.is_shared !== view.is_shared) assertMayShare(member);
  const updated = await prisma.savedView.update({
    where: { id: view.id },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.filters !== undefined && { filters: body.filters }),
      ...(body.display !== undefined && { display: body.display }),
      ...(body.is_shared !== undefined && { is_shared: body.is_shared }),
    },
    include: INCLUDE,
  });
  return out(updated, member);
}

export async function deleteView(
  prisma: PrismaClient,
  workspaceId: string,
  member: WorkspaceMember,
  viewId: string,
): Promise<void> {
  const view = await findVisible(prisma, workspaceId, member, viewId);
  if (!canEdit(view, member)) {
    throw new AppError(403, 'FORBIDDEN', 'Only an admin or the owner can delete a shared view');
  }
  await prisma.savedView.delete({ where: { id: view.id } });
}
