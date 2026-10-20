// Drafts of new issues (Ф7 7.B5): the create form saves itself as you type, so
// a closed tab, a lost connection or a phone call never throws an assignment
// away. A draft is personal — only its author sees it — and becomes an issue
// with «Опубликовать», through the same createIssue as the form, so every rule
// of creating an issue (states, assignees, controller, rights) applies.

import { z } from 'zod';
import type { Prisma, PrismaClient, WorkspaceMember } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { seesAllProjects } from '../../plugins/workspace-hook.js';
import { CreateIssueBodySchema } from '../issues/schema.js';
import { createIssue } from '../issues/service.js';

/** Kept per person and workspace; the oldest goes when a new one would pass it. */
export const MAX_DRAFTS = 50;

/**
 * What the form holds — every field optional while typing. The same shapes as
 * creating an issue, so publishing checks nothing twice.
 */
export const DraftDataSchema = CreateIssueBodySchema.pick({
  description: true,
  priority: true,
  assignee_ids: true,
  label_ids: true,
  start_date: true,
  due_date: true,
  kind: true,
  controller_id: true,
  requires_review: true,
  basis: true,
  primary_assignee_id: true,
})
  .extend({
    // A draft may be saved before the title is typed.
    title: z.string().max(500).optional(),
    state_id: z.string().uuid().optional(),
    // Lists in a draft are short: they are a form, not an import.
    assignee_ids: z.array(z.string().uuid()).max(50).optional(),
    label_ids: z.array(z.string().uuid()).max(50).optional(),
  })
  .partial()
  .strict();
export type DraftData = z.infer<typeof DraftDataSchema>;

export const CreateDraftBodySchema = z.object({
  project_id: z.string().uuid().nullable().optional(),
  data: DraftDataSchema.default({}),
});

export const UpdateDraftBodySchema = z
  .object({
    project_id: z.string().uuid().nullable(),
    data: DraftDataSchema,
  })
  .partial();

const INCLUDE = {
  project: { select: { id: true, name: true, identifier: true, icon: true, color: true } },
} as const;

type Row = Prisma.IssueDraftGetPayload<{ include: typeof INCLUDE }>;

/** Projects a member may see: not deleted; private ones only for their members and admins. */
function visibleProject(member: WorkspaceMember): Prisma.ProjectWhereInput {
  return {
    deleted_at: null,
    ...(!seesAllProjects(member) && {
      OR: [{ visibility: 'public' }, { members: { some: { user_id: member.user_id } } }],
    }),
  };
}

/** My drafts in this workspace, without those of projects I no longer see. */
function mine(workspaceId: string, member: WorkspaceMember): Prisma.IssueDraftWhereInput {
  return {
    workspace_id: workspaceId,
    user_id: member.user_id,
    OR: [{ project_id: null }, { project: visibleProject(member) }],
  };
}

async function assertProject(
  prisma: PrismaClient,
  workspaceId: string,
  member: WorkspaceMember,
  projectId: string | null | undefined,
): Promise<void> {
  if (!projectId) return;
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspace_id: workspaceId, ...visibleProject(member) },
    select: { id: true },
  });
  if (!project) throw AppError.notFound('Project not found');
}

async function findMine(
  prisma: PrismaClient,
  workspaceId: string,
  member: WorkspaceMember,
  draftId: string,
): Promise<Row> {
  const draft = await prisma.issueDraft.findFirst({
    where: { id: draftId, ...mine(workspaceId, member) },
    include: INCLUDE,
  });
  // Someone else's draft does not exist for you.
  if (!draft) throw AppError.notFound('Draft not found');
  return draft;
}

export async function listDrafts(
  prisma: PrismaClient,
  workspaceId: string,
  member: WorkspaceMember,
): Promise<{ data: Row[] }> {
  const data = await prisma.issueDraft.findMany({
    where: mine(workspaceId, member),
    include: INCLUDE,
    orderBy: { updated_at: 'desc' },
  });
  return { data };
}

export async function getDraft(
  prisma: PrismaClient,
  workspaceId: string,
  member: WorkspaceMember,
  draftId: string,
): Promise<Row> {
  return findMine(prisma, workspaceId, member, draftId);
}

export async function createDraft(
  prisma: PrismaClient,
  workspaceId: string,
  member: WorkspaceMember,
  body: z.infer<typeof CreateDraftBodySchema>,
): Promise<Row> {
  await assertProject(prisma, workspaceId, member, body.project_id);
  return prisma.$transaction(async (tx) => {
    // Forgotten drafts do not pile up: past the limit the oldest one goes.
    const old = await tx.issueDraft.findMany({
      where: { workspace_id: workspaceId, user_id: member.user_id },
      orderBy: { updated_at: 'desc' },
      skip: MAX_DRAFTS - 1,
      select: { id: true },
    });
    if (old.length > 0) {
      await tx.issueDraft.deleteMany({ where: { id: { in: old.map((d) => d.id) } } });
    }
    return tx.issueDraft.create({
      data: {
        workspace_id: workspaceId,
        user_id: member.user_id,
        project_id: body.project_id ?? null,
        data: body.data,
      },
      include: INCLUDE,
    });
  });
}

export async function updateDraft(
  prisma: PrismaClient,
  workspaceId: string,
  member: WorkspaceMember,
  draftId: string,
  body: z.infer<typeof UpdateDraftBodySchema>,
): Promise<Row> {
  await findMine(prisma, workspaceId, member, draftId);
  if (body.project_id !== undefined) {
    await assertProject(prisma, workspaceId, member, body.project_id);
  }
  return prisma.issueDraft.update({
    where: { id: draftId },
    data: {
      ...(body.project_id !== undefined && { project_id: body.project_id }),
      ...(body.data !== undefined && { data: body.data }),
    },
    include: INCLUDE,
  });
}

export async function deleteDraft(
  prisma: PrismaClient,
  workspaceId: string,
  member: WorkspaceMember,
  draftId: string,
): Promise<void> {
  await findMine(prisma, workspaceId, member, draftId);
  await prisma.issueDraft.delete({ where: { id: draftId } });
}

/**
 * «Опубликовать»: the draft becomes an issue in its project — through the same
 * createIssue as the form (state defaults to the project's default) — and is
 * removed. Missing project or title → 400 DRAFT_INCOMPLETE.
 */
export async function publishDraft(
  prisma: PrismaClient,
  workspaceId: string,
  member: WorkspaceMember,
  draftId: string,
) {
  const draft = await findMine(prisma, workspaceId, member, draftId);
  const data = DraftDataSchema.parse(draft.data ?? {});
  if (!draft.project_id || !data.title?.trim()) {
    throw new AppError(
      400,
      'DRAFT_INCOMPLETE',
      'A draft needs a project and a title to be published',
    );
  }
  const stateId =
    data.state_id ??
    (
      await prisma.state.findFirst({
        where: { project_id: draft.project_id },
        orderBy: [{ is_default: 'desc' }, { order: 'asc' }],
        select: { id: true },
      })
    )?.id;
  const body = CreateIssueBodySchema.parse({
    ...data,
    title: data.title.trim(),
    state_id: stateId,
  });
  const issue = await createIssue(prisma, workspaceId, draft.project_id, member.user_id, body);
  await prisma.issueDraft.delete({ where: { id: draft.id } });
  return issue;
}
