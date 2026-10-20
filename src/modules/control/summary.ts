// "My work" counters for the sidebar and the «Мои задачи» header (Ф5 5.F6):
// one request of COUNT queries instead of loading every project's issues.
//
// The numbers follow the same rules as the issue filters and the review flow:
//   - assigned / overdue / due_today — open issues where I am an assignee
//     (deadline days in the workspace time zone, ADR-012);
//   - unacknowledged — open assignments I have not acknowledged yet (5.B4);
//   - control — open assignments I control: I am the controller, or the author
//     of an assignment without one (ADR-008);
//   - review_pending — issues in a `review` state that I decide on (reviewersOf);
//   - watching — open issues I follow (5.B7);
//   - unread_notifications — my unread inbox in this workspace;
//   - role — my access role, so the client can hide what a guest cannot do;
//   - heads_department — I head a department, so the workspace feed (7.B3) is mine too.
// Private projects I cannot see and deleted projects/issues are never counted.

import type { Prisma, PrismaClient, WorkspaceMember, WorkspaceRole } from '@prisma/client';
import { seesAllProjects } from '../../plugins/workspace-hook.js';
import { addDays, localDate, startOfLocalDay } from '../../lib/tz.js';
import { OPEN_GROUPS } from './rules.js';

export interface MySummary {
  /** My access role here — the client hides what it does not allow (docs/PERMISSIONS.md). */
  role: WorkspaceRole;
  assigned: number;
  overdue: number;
  due_today: number;
  unacknowledged: number;
  control: number;
  control_overdue: number;
  review_pending: number;
  watching: number;
  unread_notifications: number;
  heads_department: boolean;
}

export async function mySummary(
  prisma: PrismaClient,
  workspace: { id: string; timezone: string },
  member: WorkspaceMember,
  now: Date = new Date(),
): Promise<MySummary> {
  const me = member.user_id;
  const today = localDate(now, workspace.timezone);
  const startToday = startOfLocalDay(today, workspace.timezone);
  const startTomorrow = startOfLocalDay(addDays(today, 1), workspace.timezone);

  const visible: Prisma.IssueWhereInput = {
    workspace_id: workspace.id,
    deleted_at: null,
    project: {
      deleted_at: null,
      ...(!seesAllProjects(member) && {
        OR: [{ visibility: 'public' }, { members: { some: { user_id: me } } }],
      }),
    },
  };
  const open: Prisma.IssueWhereInput = { ...visible, state: { group: { in: OPEN_GROUPS } } };
  const decidedByMe: Prisma.IssueWhereInput[] = [
    { controller_id: me },
    { controller_id: null, created_by_id: me },
  ];
  const assigned: Prisma.IssueWhereInput = { ...open, assignees: { some: { user_id: me } } };
  const controlled: Prisma.IssueWhereInput = { ...open, kind: 'assignment', OR: decidedByMe };
  const overdue = { due_date: { lt: startToday } };

  const count = (where: Prisma.IssueWhereInput) => prisma.issue.count({ where });
  const [
    assignedN,
    overdueN,
    dueTodayN,
    unacknowledged,
    control,
    controlOverdue,
    reviewPending,
    watching,
    unread,
    headed,
  ] = await Promise.all([
    count(assigned),
    count({ ...assigned, ...overdue }),
    count({ ...assigned, due_date: { gte: startToday, lt: startTomorrow } }),
    count({
      ...open,
      kind: 'assignment',
      assignees: { some: { user_id: me, acknowledged_at: null } },
    }),
    count(controlled),
    count({ ...controlled, ...overdue }),
    count({ ...visible, state: { group: 'review' }, OR: decidedByMe }),
    count({ ...open, watchers: { some: { user_id: me } } }),
    prisma.notification.count({
      where: { workspace_id: workspace.id, recipient_id: me, is_read: false },
    }),
    prisma.department.count({ where: { workspace_id: workspace.id, head_id: me } }),
  ]);

  return {
    role: member.role,
    assigned: assignedN,
    overdue: overdueN,
    due_today: dueTodayN,
    unacknowledged,
    control,
    control_overdue: controlOverdue,
    review_pending: reviewPending,
    watching,
    unread_notifications: unread,
    heads_department: headed > 0,
  };
}
