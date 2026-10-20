// Issue templates (Ф6 6.B3, ADR-030): typical assignments filled in one click —
// «Подготовить отчёт кафедры к аккредитации» with its controller, deadline and
// checklist. A template is workspace-wide (project_id null, no labels: they are
// per project) or of one project, and keeps the create form's fields.
//
// Rights: everyone sees the templates of the projects they see and the workspace
// ones. Workspace templates are part of everyone's workplace, so only admins and
// the owner create and change them (like shared views, ADR-029). A project
// template is created by any member who may create issues (a guest is refused by
// the workspace hook) and changed by its author or an admin.

import { z } from 'zod';
import type { IssueTemplate, Prisma, PrismaClient, WorkspaceMember } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { localDate } from '../../lib/tz.js';
import { seesAllProjects } from '../../plugins/workspace-hook.js';
import { createIssue } from '../issues/service.js';
import {
  DueInDaysSchema,
  IssueFieldsSchema,
  assertIssueFields,
  createBodyFrom,
} from '../issues/fields.js';

const NameSchema = z.string().trim().min(1).max(80);

export const CreateTemplateBodySchema = z
  .object({
    name: NameSchema,
    project_id: z.string().uuid().nullable().optional(),
    data: IssueFieldsSchema,
    due_in_days: DueInDaysSchema.optional(),
  })
  .strict();

export const UpdateTemplateBodySchema = z
  .object({ name: NameSchema, data: IssueFieldsSchema, due_in_days: DueInDaysSchema })
  .partial()
  .strict();

export const ApplyTemplateBodySchema = z
  .object({
    // Where the issue goes: required for a workspace template, the template's own
    // project otherwise.
    project_id: z.string().uuid().optional(),
    // A different title for this issue (the rest comes from the template).
    title: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const TemplateQuerySchema = z.object({
  // Templates usable in this project: the workspace ones and the project's own.
  project_id: z.string().uuid().optional(),
});

const INCLUDE = {
  project: { select: { id: true, name: true, identifier: true, icon: true, color: true } },
  created_by: { select: { id: true, display_name: true, avatar_url: true } },
} as const;

type Row = Prisma.IssueTemplateGetPayload<{ include: typeof INCLUDE }>;

/** Projects a member may see: not deleted; private ones only for their members and admins. */
function visibleProject(member: WorkspaceMember): Prisma.ProjectWhereInput {
  return {
    deleted_at: null,
    ...(!seesAllProjects(member) && {
      OR: [{ visibility: 'public' }, { members: { some: { user_id: member.user_id } } }],
    }),
  };
}

function canEdit(t: Pick<IssueTemplate, 'project_id' | 'created_by_id'>, member: WorkspaceMember) {
  if (seesAllProjects(member)) return true;
  return t.project_id !== null && t.created_by_id === member.user_id;
}

const shape = (row: Row, member: WorkspaceMember) => ({ ...row, can_edit: canEdit(row, member) });

async function assertProject(
  prisma: PrismaClient,
  workspaceId: string,
  member: WorkspaceMember,
  projectId: string,
): Promise<void> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspace_id: workspaceId, ...visibleProject(member) },
    select: { id: true },
  });
  if (!project) throw AppError.notFound('Project not found');
}

/** A template the member sees (someone else's private project — 404). */
async function findVisible(
  prisma: PrismaClient,
  workspaceId: string,
  member: WorkspaceMember,
  templateId: string,
): Promise<Row> {
  const row = await prisma.issueTemplate.findFirst({
    where: {
      id: templateId,
      workspace_id: workspaceId,
      OR: [{ project_id: null }, { project: visibleProject(member) }],
    },
    include: INCLUDE,
  });
  if (!row) throw AppError.notFound('Template not found');
  return row;
}

async function findEditable(
  prisma: PrismaClient,
  workspaceId: string,
  member: WorkspaceMember,
  templateId: string,
): Promise<Row> {
  const row = await findVisible(prisma, workspaceId, member, templateId);
  if (!canEdit(row, member)) {
    throw AppError.forbidden(
      row.project_id
        ? 'Only the author of the template or an admin can change it'
        : 'Only admins and the owner manage workspace templates',
    );
  }
  return row;
}

export async function listTemplates(
  prisma: PrismaClient,
  workspaceId: string,
  member: WorkspaceMember,
  query: z.infer<typeof TemplateQuerySchema>,
) {
  if (query.project_id) await assertProject(prisma, workspaceId, member, query.project_id);
  const rows = await prisma.issueTemplate.findMany({
    where: {
      workspace_id: workspaceId,
      OR: [
        { project_id: null },
        query.project_id
          ? { project_id: query.project_id }
          : { project_id: { not: null }, project: visibleProject(member) },
      ],
    },
    include: INCLUDE,
  });
  // Workspace templates first, then by name — whatever project a template is in
  // (ordering by project_id put them in random project order).
  const scope = (r: { project_id: string | null }) => (r.project_id === null ? 0 : 1);
  rows.sort((a, b) => scope(a) - scope(b) || a.name.localeCompare(b.name, 'ru'));
  return { data: rows.map((r) => shape(r, member)) };
}

export async function getTemplate(
  prisma: PrismaClient,
  workspaceId: string,
  member: WorkspaceMember,
  templateId: string,
) {
  return shape(await findVisible(prisma, workspaceId, member, templateId), member);
}

export async function createTemplate(
  prisma: PrismaClient,
  workspaceId: string,
  member: WorkspaceMember,
  body: z.infer<typeof CreateTemplateBodySchema>,
) {
  const projectId = body.project_id ?? null;
  if (projectId) await assertProject(prisma, workspaceId, member, projectId);
  else if (!seesAllProjects(member)) {
    throw AppError.forbidden('Only admins and the owner manage workspace templates');
  }
  await assertIssueFields(prisma, workspaceId, projectId, body.data);
  const row = await prisma.issueTemplate.create({
    data: {
      workspace_id: workspaceId,
      project_id: projectId,
      created_by_id: member.user_id,
      name: body.name,
      data: body.data,
      due_in_days: body.due_in_days ?? null,
    },
    include: INCLUDE,
  });
  return shape(row, member);
}

export async function updateTemplate(
  prisma: PrismaClient,
  workspaceId: string,
  member: WorkspaceMember,
  templateId: string,
  body: z.infer<typeof UpdateTemplateBodySchema>,
) {
  const before = await findEditable(prisma, workspaceId, member, templateId);
  if (body.data) await assertIssueFields(prisma, workspaceId, before.project_id, body.data);
  const row = await prisma.issueTemplate.update({
    where: { id: templateId },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.data !== undefined && { data: body.data }),
      ...(body.due_in_days !== undefined && { due_in_days: body.due_in_days }),
    },
    include: INCLUDE,
  });
  return shape(row, member);
}

export async function deleteTemplate(
  prisma: PrismaClient,
  workspaceId: string,
  member: WorkspaceMember,
  templateId: string,
): Promise<void> {
  await findEditable(prisma, workspaceId, member, templateId);
  await prisma.issueTemplate.delete({ where: { id: templateId } });
}

/**
 * Create an issue from a template now: the project's default state, the deadline
 * today (workspace zone) + `due_in_days`, the checklist — through createIssue, so
 * the caller's rights and every rule of creating an issue apply.
 */
export async function applyTemplate(
  prisma: PrismaClient,
  workspace: { id: string; timezone: string },
  member: WorkspaceMember,
  templateId: string,
  body: z.infer<typeof ApplyTemplateBodySchema>,
) {
  const template = await findVisible(prisma, workspace.id, member, templateId);
  const projectId = template.project_id ?? body.project_id;
  if (!projectId) throw AppError.badRequest('project_id is required for a workspace template');
  if (template.project_id && body.project_id && body.project_id !== template.project_id) {
    throw AppError.badRequest('This template belongs to another project');
  }
  await assertProject(prisma, workspace.id, member, projectId);
  const fields = IssueFieldsSchema.parse(template.data);
  const create = await createBodyFrom(
    prisma,
    projectId,
    { ...fields, ...(body.title && { title: body.title }) },
    template.due_in_days,
    localDate(new Date(), workspace.timezone),
  );
  return createIssue(prisma, workspace.id, projectId, member.user_id, create);
}
