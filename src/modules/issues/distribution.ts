// Рассылка подразделениям (Ф6 6.B1): one assignment for several departments at
// once. Creates a parent assignment (`is_distribution`) and one child per
// department, addressed to it (`department_id`) with the department head as the
// primary assignee; the controller, deadline, priority, basis and review rule
// are inherited from the parent. Everything happens in one transaction: a
// department without a head fails the whole request before anything is written.

import type { IssueKind, PrismaClient } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { recordActivity, ACTIVITY_ACTIONS } from '../../lib/activity.js';
import { notify } from '../../lib/notifications.js';
import { addWatchers } from '../control/rules.js';
import { getIssue, nextSequenceId, notifyIssueRecipients } from './service.js';
import type { DistributeBody } from './schema.js';

export async function distributeIssue(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  creatorId: string,
  body: DistributeBody,
) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspace_id: workspaceId, deleted_at: null },
    select: { id: true, visibility: true },
  });
  if (!project) throw AppError.notFound('Project not found');

  const state = body.state_id
    ? await prisma.state.findFirst({ where: { id: body.state_id, project_id: projectId } })
    : ((await prisma.state.findFirst({ where: { project_id: projectId, is_default: true } })) ??
      (await prisma.state.findFirst({
        where: { project_id: projectId, group: 'unstarted' },
        orderBy: { order: 'asc' },
      })));
  if (!state) throw AppError.badRequest('state_id does not belong to this project');

  if (body.controller_id) {
    const member = await prisma.workspaceMember.findUnique({
      where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: body.controller_id } },
    });
    if (!member) throw AppError.badRequest('controller_id must be a member of this workspace');
    if (member.deactivated_at) {
      throw new AppError(
        400,
        'MEMBER_DEACTIVATED',
        "controller_id: this member's access to the workspace is turned off",
      );
    }
    if (member.role === 'guest') {
      throw new AppError(400, 'GUEST_NOT_ASSIGNABLE', 'controller_id: a guest cannot be assigned');
    }
  }
  if (body.label_ids?.length) {
    const labels = await prisma.label.count({
      where: { id: { in: body.label_ids }, project_id: projectId },
    });
    if (labels !== new Set(body.label_ids).size) {
      throw AppError.badRequest('label_ids must belong to this project');
    }
  }

  const departmentIds = [...new Set(body.department_ids)];
  const departments = await prisma.department.findMany({
    where: { id: { in: departmentIds }, workspace_id: workspaceId },
    select: { id: true, name: true, short_name: true, head_id: true, order: true },
    orderBy: [{ order: 'asc' }, { name: 'asc' }],
  });
  if (departments.length !== departmentIds.length) {
    throw AppError.badRequest('department_ids must belong to this workspace');
  }
  // The head must still be in the workspace with access (a removed or deactivated
  // member keeps head_id only until reassigned — 12.B7).
  const heads = await prisma.workspaceMember.findMany({
    where: {
      workspace_id: workspaceId,
      user_id: { in: departments.flatMap((d) => (d.head_id ? [d.head_id] : [])) },
      deactivated_at: null,
    },
    select: { user_id: true, role: true },
  });
  const headIds = new Set(heads.map((h) => h.user_id));
  const headless = departments.filter((d) => !d.head_id || !headIds.has(d.head_id));
  if (headless.length > 0) {
    throw new AppError(
      400,
      'DEPARTMENT_HAS_NO_HEAD',
      `No head to assign the distribution to: ${headless.map((d) => d.name).join(', ')}`,
      { departments: headless.map((d) => ({ id: d.id, name: d.name })) },
    );
  }
  // A guest head is read-only (12.B4) and cannot receive the assignment.
  const guestHeads = new Set(heads.filter((h) => h.role === 'guest').map((h) => h.user_id));
  const guestLed = departments.filter((d) => guestHeads.has(d.head_id!));
  if (guestLed.length > 0) {
    throw new AppError(
      400,
      'GUEST_NOT_ASSIGNABLE',
      `The head is a guest and cannot be assigned: ${guestLed.map((d) => d.name).join(', ')}`,
      { departments: guestLed.map((d) => ({ id: d.id, name: d.name })) },
    );
  }

  const controllerId = body.controller_id ?? null;
  // A distribution is always checked by someone: the controller, else its author.
  const requiresReview = body.requires_review ?? true;
  const dueDate = body.due_date ? new Date(body.due_date) : null;
  const startDate = body.start_date ? new Date(body.start_date) : null;
  const labels = body.label_ids?.length
    ? { createMany: { data: [...new Set(body.label_ids)].map((label_id) => ({ label_id })) } }
    : undefined;
  const common = {
    workspace_id: workspaceId,
    project_id: projectId,
    state_id: state.id,
    priority: body.priority,
    start_date: startDate,
    due_date: dueDate,
    created_by_id: creatorId,
    kind: 'assignment' as const,
    controller_id: controllerId,
    requires_review: requiresReview,
    basis: body.basis ?? null,
  };

  const created = await prisma.$transaction(async (tx) => {
    let sequenceId = await nextSequenceId(tx, projectId);
    const parent = await tx.issue.create({
      data: {
        ...common,
        sequence_id: sequenceId++,
        title: body.title,
        description: body.description ?? null,
        is_distribution: true,
        labels,
      },
    });
    await recordActivity(tx, {
      workspace_id: workspaceId,
      issue_id: parent.id,
      actor_id: creatorId,
      action: ACTIVITY_ACTIONS.ISSUE_CREATED,
    });
    await addWatchers(tx, parent.id, [creatorId, controllerId]);

    // A private project must let the heads see their own task.
    if (project.visibility === 'private') {
      await tx.projectMember.createMany({
        data: departments.map((d) => ({ project_id: projectId, user_id: d.head_id! })),
        skipDuplicates: true,
      });
    }

    const children: {
      id: string;
      sequence_id: number;
      title: string;
      kind: IssueKind;
      due_date: Date | null;
      head: string;
    }[] = [];
    for (const d of departments) {
      const child = await tx.issue.create({
        data: {
          ...common,
          sequence_id: sequenceId++,
          title: `${body.title} — ${d.short_name ?? d.name}`,
          description: body.description ?? null,
          parent_id: parent.id,
          department_id: d.id,
          assignees: { create: { user_id: d.head_id!, is_primary: true } },
          labels,
        },
        select: { id: true, sequence_id: true, title: true, kind: true, due_date: true },
      });
      await recordActivity(tx, {
        workspace_id: workspaceId,
        issue_id: child.id,
        actor_id: creatorId,
        action: ACTIVITY_ACTIONS.ISSUE_CREATED,
      });
      await addWatchers(tx, child.id, [creatorId, d.head_id, controllerId]);
      await notify(tx, {
        workspace_id: workspaceId,
        actor_id: creatorId,
        type: 'issue_assigned',
        recipient_ids: [d.head_id!],
        issue_id: child.id,
      });
      children.push({ ...child, head: d.head_id! });
    }
    return { parent, children };
  });

  // Telegram / email to each head after commit; delivery problems never fail the request.
  for (const child of created.children) {
    try {
      await notifyIssueRecipients(prisma, {
        projectId,
        actorId: creatorId,
        recipientIds: [child.head],
        issue: child,
        assigned: true,
      });
    } catch {
      // Best-effort.
    }
  }

  return getIssue(prisma, workspaceId, projectId, created.parent.id);
}
