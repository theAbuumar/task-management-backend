// Progress of a group of issues by state group — a cycle's or a module's (4.F3,
// 4.F4, ADR-031). Lists count every cycle or module of a project in one query.
// Done = completed + cancelled: a cancelled issue is no longer work to do.

import { Prisma, type PrismaClient, type StateGroup } from '@prisma/client';

export interface GroupProgress {
  total: number;
  backlog: number;
  unstarted: number;
  started: number;
  review: number;
  completed: number;
  cancelled: number;
  completion_percentage: number;
}

export function emptyProgress(): GroupProgress {
  return {
    total: 0,
    backlog: 0,
    unstarted: 0,
    started: 0,
    review: 0,
    completed: 0,
    cancelled: 0,
    completion_percentage: 0,
  };
}

interface Row {
  owner_id: string;
  group: StateGroup;
  count: number;
}

function collect(ids: string[], rows: Row[]): Map<string, GroupProgress> {
  const out = new Map(ids.map((id) => [id, emptyProgress()]));
  for (const row of rows) {
    const p = out.get(row.owner_id);
    if (!p) continue;
    p[row.group] += row.count;
    p.total += row.count;
  }
  for (const p of out.values()) {
    if (p.total > 0) {
      p.completion_percentage = Math.round(((p.completed + p.cancelled) / p.total) * 100);
    }
  }
  return out;
}

/** Progress of each cycle; issues in the trash are left out. */
export async function cycleProgress(
  prisma: PrismaClient,
  cycleIds: string[],
): Promise<Map<string, GroupProgress>> {
  if (cycleIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT i.cycle_id AS owner_id, s."group" AS "group", count(*)::int AS count
    FROM "Issue" i
    JOIN "State" s ON s.id = i.state_id
    WHERE i.cycle_id IN (${Prisma.join(cycleIds)}) AND i.deleted_at IS NULL
    GROUP BY i.cycle_id, s."group"`;
  return collect(cycleIds, rows);
}

/** Progress of each module; issues in the trash are left out. */
export async function moduleProgress(
  prisma: PrismaClient,
  moduleIds: string[],
): Promise<Map<string, GroupProgress>> {
  if (moduleIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT mi.module_id AS owner_id, s."group" AS "group", count(*)::int AS count
    FROM "ModuleIssue" mi
    JOIN "Issue" i ON i.id = mi.issue_id
    JOIN "State" s ON s.id = i.state_id
    WHERE mi.module_id IN (${Prisma.join(moduleIds)}) AND i.deleted_at IS NULL
    GROUP BY mi.module_id, s."group"`;
  return collect(moduleIds, rows);
}
