// Сводный прогресс рассылки (Ф6 6.B2): for the parent of a distribution, one row
// per department child (who executes it, its state and deadline) plus totals.
// `ready_to_close` tells the client to offer closing the parent once every
// child is done. Deadline days follow the workspace time zone (ADR-012).

import type { PrismaClient, StateGroup } from '@prisma/client';
import { localDate, startOfLocalDay } from '../../lib/tz.js';
import { OPEN_GROUPS } from '../control/rules.js';

const PERSON = {
  id: true,
  display_name: true,
  last_name: true,
  first_name: true,
  middle_name: true,
  avatar_url: true,
} as const;

export interface DistributionItem {
  issue_id: string;
  sequence_id: number;
  title: string;
  department: { id: string; name: string; short_name: string | null } | null;
  assignee: {
    id: string;
    display_name: string;
    last_name: string | null;
    first_name: string | null;
    middle_name: string | null;
    avatar_url: string | null;
  } | null;
  state: { id: string; name: string; group: StateGroup; color: string };
  due_date: Date | null;
  completed_at: Date | null;
  overdue: boolean;
  completed_late: boolean;
}

export interface DistributionProgress {
  total: number;
  completed: number;
  cancelled: number;
  review: number;
  open: number;
  overdue: number;
  ready_to_close: boolean;
  items: DistributionItem[];
}

export async function distributionProgress(
  prisma: PrismaClient,
  parent: { id: string; workspace_id: string; state: { group: StateGroup } },
  now: Date = new Date(),
): Promise<DistributionProgress> {
  const [workspace, children] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: parent.workspace_id }, select: { timezone: true } }),
    prisma.issue.findMany({
      where: { parent_id: parent.id, deleted_at: null },
      orderBy: [{ department: { order: 'asc' } }, { sequence_id: 'asc' }],
      select: {
        id: true,
        sequence_id: true,
        title: true,
        due_date: true,
        completed_at: true,
        department: { select: { id: true, name: true, short_name: true } },
        state: { select: { id: true, name: true, group: true, color: true } },
        assignees: {
          where: { is_primary: true },
          take: 1,
          select: { user: { select: PERSON } },
        },
      },
    }),
  ]);
  const tz = workspace?.timezone ?? 'UTC';
  const startToday = startOfLocalDay(localDate(now, tz), tz);

  const items: DistributionItem[] = children.map((c) => {
    const open = OPEN_GROUPS.includes(c.state.group);
    return {
      issue_id: c.id,
      sequence_id: c.sequence_id,
      title: c.title,
      department: c.department,
      assignee: c.assignees[0]?.user ?? null,
      state: c.state,
      due_date: c.due_date,
      completed_at: c.completed_at,
      overdue: open && c.due_date !== null && c.due_date < startToday,
      completed_late:
        c.state.group === 'completed' &&
        c.due_date !== null &&
        c.completed_at !== null &&
        localDate(c.completed_at, tz) > localDate(c.due_date, tz),
    };
  });
  const count = (fn: (i: DistributionItem) => boolean) => items.filter(fn).length;
  const completed = count((i) => i.state.group === 'completed');
  const cancelled = count((i) => i.state.group === 'cancelled');
  return {
    total: items.length,
    completed,
    cancelled,
    review: count((i) => i.state.group === 'review'),
    open: count((i) => OPEN_GROUPS.includes(i.state.group)),
    overdue: count((i) => i.overdue),
    ready_to_close:
      items.length > 0 &&
      completed + cancelled === items.length &&
      OPEN_GROUPS.includes(parent.state.group),
    items,
  };
}
