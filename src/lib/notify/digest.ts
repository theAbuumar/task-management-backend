// Digests (Ф8 8.B5, ADR-033): summaries that arrive on their own.
//
// - Daily — to a person about their own work: due today, overdue, assignments
//   without «Ознакомлен», and what waits for their decision as a controller (hand-ins
//   and deadline change requests). An empty one is not sent. Off by default.
// - Weekly — to a department head on Mondays: the department with its sub-departments
//   for the previous week (Mon–Sun), counted by the same functions as «Аналитика»
//   with the head's rights (10.B3). On by default; reaches department heads only.
//
// The scheduler pass (`runDigests`) runs every few minutes and queues a digest when
// the person's chosen hour comes (their profile time zone, else the workspace one).
// The copy goes through the dispatcher (retries, journal, quiet hours) and is
// queued once per day / week: its `dedupe_key` is unique.

import type { Prisma, PrismaClient, WorkspaceMember } from '@prisma/client';
import { channelFor, notificationPrefs } from '../notification-prefs.js';
import { addDays, daysBetween, localDate, localHour } from '../tz.js';
import { telegramConfigured } from '../../modules/auth/telegram.service.js';
import { shortName } from '../../modules/telegram/views.js';
import { analyticsData } from '../../modules/analytics/data.js';
import { overdueItems, summary } from '../../modules/analytics/service.js';
import {
  isEmptyDaily,
  type DailySection,
  type DepartmentSummary,
  type DigestContent,
  type DigestItem,
} from './digest-render.js';

const OPEN = ['backlog', 'unstarted', 'started', 'review'] as const;
const SHOWN = 5;

export type DigestKind = 'daily' | 'weekly';

interface Membership {
  workspace: {
    id: string;
    name: string;
    short_name: string | null;
    slug: string;
    timezone: string;
  };
  member: WorkspaceMember;
}

/** The person's active memberships (not a guest for the weekly summary). */
async function memberships(prisma: PrismaClient, userId: string): Promise<Membership[]> {
  const rows = await prisma.workspaceMember.findMany({
    where: { user_id: userId, deactivated_at: null },
    include: {
      workspace: {
        select: { id: true, name: true, short_name: true, slug: true, timezone: true },
      },
    },
    orderBy: { created_at: 'asc' },
  });
  return rows.map(({ workspace, ...member }) => ({ workspace, member }));
}

const keyOf = (i: { sequence_id: number; project: { identifier: string } }) =>
  `${i.project.identifier}-${i.sequence_id}`;

const open = {
  deleted_at: null,
  project: { deleted_at: null },
  state: { group: { in: [...OPEN] } },
} satisfies Prisma.IssueWhereInput;

/** One workspace's part of the daily digest. */
async function dailySection(
  prisma: PrismaClient,
  userId: string,
  ws: Membership['workspace'],
  now: Date,
): Promise<DailySection> {
  const today = localDate(now, ws.timezone);
  const select = {
    id: true,
    title: true,
    sequence_id: true,
    due_date: true,
    project: { select: { identifier: true } },
  } as const;

  const dated = await prisma.issue.findMany({
    where: {
      ...open,
      workspace_id: ws.id,
      assignees: { some: { user_id: userId } },
      due_date: { not: null },
    },
    select,
    orderBy: { due_date: 'asc' },
  });
  const item = (i: (typeof dated)[number], extra: Partial<DigestItem> = {}): DigestItem => ({
    key: keyOf(i),
    title: i.title,
    slug: ws.slug,
    due: i.due_date?.toISOString() ?? null,
    ...extra,
  });
  const todayItems: DigestItem[] = [];
  const overdue: DigestItem[] = [];
  for (const i of dated) {
    const due = localDate(i.due_date!, ws.timezone);
    if (due === today) todayItems.push(item(i));
    else if (due < today) overdue.push(item(i, { days: daysBetween(due, today) }));
  }
  overdue.sort((a, b) => (b.days ?? 0) - (a.days ?? 0));

  const unacknowledged = await prisma.issue.findMany({
    where: {
      ...open,
      workspace_id: ws.id,
      kind: 'assignment',
      assignees: { some: { user_id: userId, acknowledged_at: null } },
    },
    select,
    orderBy: { created_at: 'asc' },
  });

  // What waits for this person as the controller (the author when there is none).
  const mine = {
    ...open,
    workspace_id: ws.id,
    OR: [{ controller_id: userId }, { controller_id: null, created_by_id: userId }],
  } satisfies Prisma.IssueWhereInput;
  const [reviews, requests] = await Promise.all([
    prisma.issueReview.findMany({
      where: { decision: 'pending', issue: mine },
      select: {
        submitted_by: { select: { display_name: true } },
        issue: { select },
      },
      orderBy: { submitted_at: 'asc' },
    }),
    prisma.deadlineChangeRequest.findMany({
      where: { status: 'pending', issue: mine },
      select: {
        requested_by: { select: { display_name: true } },
        issue: { select },
      },
      orderBy: { created_at: 'asc' },
    }),
  ]);
  const toDecide: DigestItem[] = [
    ...reviews.map((r) => item(r.issue, { what: 'review', who: shortName(r.submitted_by) })),
    ...requests.map((r) => item(r.issue, { what: 'deadline', who: shortName(r.requested_by) })),
  ];

  return {
    workspace: ws.name,
    slug: ws.slug,
    today: todayItems.slice(0, SHOWN),
    overdue: overdue.slice(0, SHOWN),
    unacknowledged: unacknowledged.slice(0, SHOWN).map((i) => item(i)),
    to_decide: toDecide.slice(0, SHOWN),
    totals: {
      today: todayItems.length,
      overdue: overdue.length,
      unacknowledged: unacknowledged.length,
      to_decide: toDecide.length,
    },
  };
}

/** The daily digest of a person: one section per workspace with something in it. */
export async function collectDaily(
  prisma: PrismaClient,
  userId: string,
  now: Date,
  timeZone: string,
): Promise<DigestContent & { kind: 'daily' }> {
  const sections: DailySection[] = [];
  for (const m of await memberships(prisma, userId)) {
    sections.push(await dailySection(prisma, userId, m.workspace, now));
  }
  const filled = sections.filter((s) => !isEmptyDaily([s]));
  return {
    kind: 'daily',
    date: localDate(now, timeZone),
    sections: filled.length ? filled : sections.slice(0, 1),
  };
}

/** The previous Monday–Sunday before local `today`. */
export function previousWeek(today: string): { from: string; to: string } {
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  const monday = addDays(today, -((weekday + 6) % 7));
  return { from: addDays(monday, -7), to: addDays(monday, -1) };
}

/** Departments a person heads, without those already inside another one they head. */
async function headedRoots(prisma: PrismaClient, userId: string, workspaceId: string) {
  const all = await prisma.department.findMany({
    where: { workspace_id: workspaceId },
    select: { id: true, name: true, parent_id: true, head_id: true },
  });
  const byId = new Map(all.map((d) => [d.id, d]));
  const headed = all.filter((d) => d.head_id === userId);
  const ids = new Set(headed.map((d) => d.id));
  return headed.filter((d) => {
    for (
      let p = d.parent_id ? byId.get(d.parent_id) : undefined;
      p;
      p = p.parent_id ? byId.get(p.parent_id) : undefined
    ) {
      if (ids.has(p.id)) return false;
    }
    return true;
  });
}

/** Whether the person heads any department where they are an active member. */
export async function isDepartmentHead(prisma: PrismaClient, userId: string): Promise<boolean> {
  const found = await prisma.department.findFirst({
    where: {
      head_id: userId,
      workspace: { members: { some: { user_id: userId, deactivated_at: null } } },
    },
    select: { id: true },
  });
  return Boolean(found);
}

/** The weekly summary of a department head; no departments — nothing to send. */
export async function collectWeekly(
  prisma: PrismaClient,
  userId: string,
  now: Date,
  timeZone: string,
): Promise<DigestContent & { kind: 'weekly' }> {
  const week = previousWeek(localDate(now, timeZone));
  const departments: DepartmentSummary[] = [];
  for (const { workspace, member } of await memberships(prisma, userId)) {
    if (member.role === 'guest') continue;
    for (const dep of await headedRoots(prisma, userId, workspace.id)) {
      const data = await analyticsData(
        prisma,
        workspace,
        member,
        { from: week.from, to: week.to, department: [dep.id], limit: SHOWN },
        now,
      );
      const c = summary(data).current;
      // What is overdue and in progress right now, not at the end of last week.
      const today = localDate(now, workspace.timezone);
      const current = await analyticsData(
        prisma,
        workspace,
        member,
        { from: today, to: today, department: [dep.id], limit: SHOWN },
        now,
      );
      const overdue = overdueItems(current);
      departments.push({
        workspace: workspace.name,
        slug: workspace.slug,
        department_id: dep.id,
        department: dep.name,
        figures: {
          created: c.created,
          completed: c.completed,
          on_time: c.on_time,
          late: c.late,
          overdue: overdue.length,
          open: summary(current).current.open,
          discipline: c.discipline,
        },
        overdue_items: overdue.slice(0, SHOWN).map((o) => ({
          key: o.key,
          title: o.title,
          slug: workspace.slug,
          days: o.days_overdue,
          who: o.assignee ? shortName(o.assignee) : null,
        })),
      });
    }
  }
  return { kind: 'weekly', ...week, departments };
}

interface Person {
  id: string;
  email: string | null;
  timezone: string | null;
  notification_settings: Prisma.JsonValue;
  chatId: string | null;
  workspaceId: string;
  workspaceTz: string;
}

async function person(prisma: PrismaClient, userId: string): Promise<Person | null> {
  const user = await prisma.user.findFirst({
    where: { id: userId, is_active: true },
    select: {
      id: true,
      email: true,
      timezone: true,
      notification_settings: true,
      identities: {
        where: { provider: 'telegram', provider_user_id: { not: null } },
        select: { provider_user_id: true },
        take: 1,
      },
      workspace_memberships: {
        where: { deactivated_at: null },
        select: { workspace_id: true, workspace: { select: { timezone: true } } },
        orderBy: { created_at: 'asc' },
        take: 1,
      },
    },
  });
  const first = user?.workspace_memberships[0];
  if (!user || !first) return null;
  return {
    id: user.id,
    email: user.email,
    timezone: user.timezone,
    notification_settings: user.notification_settings,
    chatId: telegramConfigured() ? (user.identities[0]?.provider_user_id ?? null) : null,
    workspaceId: first.workspace_id,
    workspaceTz: first.workspace.timezone,
  };
}

export interface QueuedDigest {
  /** The copy to send; null when the digest was empty or already queued. */
  id: string | null;
  channel: 'telegram' | 'email' | null;
  empty: boolean;
}

/**
 * Collect and queue one digest for one person. `manual` («Прислать сейчас»): no
 * once-a-day key, an empty daily digest is still sent, quiet hours do not hold it.
 */
export async function queueDigest(
  prisma: PrismaClient,
  userId: string,
  kind: DigestKind,
  now: Date,
  options: { manual?: boolean } = {},
): Promise<QueuedDigest> {
  const p = await person(prisma, userId);
  if (!p) return { id: null, channel: null, empty: true };
  const channel = channelFor(p.notification_settings, 'digest', {
    hasTelegram: p.chatId !== null,
    hasEmail: Boolean(p.email),
  });
  if (!channel) return { id: null, channel: null, empty: false };

  const tz = p.timezone ?? p.workspaceTz;
  const date = localDate(now, tz);
  const dedupe = options.manual ? null : `digest:${kind}:${p.id}:${date}`;
  if (dedupe) {
    const done = await prisma.notificationDelivery.findUnique({
      where: { dedupe_key: dedupe },
      select: { id: true },
    });
    if (done) return { id: null, channel, empty: false };
  }

  const content =
    kind === 'daily'
      ? await collectDaily(prisma, p.id, now, tz)
      : await collectWeekly(prisma, p.id, now, tz);
  const empty =
    content.kind === 'daily' ? isEmptyDaily(content.sections) : content.departments.length === 0;
  if (options.manual && content.kind === 'daily') content.manual = true;

  const base = {
    workspace_id: p.workspaceId,
    user_id: p.id,
    type: 'digest' as const,
    channel,
    payload: { digest: content } as unknown as Prisma.InputJsonValue,
    dedupe_key: dedupe,
  };
  if (empty && !(options.manual && kind === 'daily')) {
    // Remember that today's digest had nothing in it, so the pass does not collect it again.
    if (dedupe) {
      await prisma.notificationDelivery.createMany({
        data: [{ ...base, status: 'skipped', reason: 'empty' }],
        skipDuplicates: true,
      });
    }
    return { id: null, channel, empty: true };
  }
  const created = await prisma.notificationDelivery.createManyAndReturn({
    data: [base],
    skipDuplicates: true,
    select: { id: true },
  });
  return { id: created[0]?.id ?? null, channel, empty };
}

export interface DigestPassResult {
  daily: number;
  weekly: number;
}

/**
 * The scheduler pass: queue the digests whose hour has come. Every person is looked
 * at in their own time zone; the unique key makes a second pass in the same hour a
 * no-op.
 */
export async function runDigests(
  prisma: PrismaClient,
  now = new Date(),
): Promise<DigestPassResult> {
  const result: DigestPassResult = { daily: 0, weekly: 0 };
  const users = await prisma.user.findMany({
    where: {
      is_active: true,
      workspace_memberships: { some: { deactivated_at: null } },
    },
    select: {
      id: true,
      timezone: true,
      notification_settings: true,
      headed_departments: { select: { id: true }, take: 1 },
      workspace_memberships: {
        where: { deactivated_at: null },
        select: { workspace: { select: { timezone: true } } },
        orderBy: { created_at: 'asc' },
        take: 1,
      },
    },
  });
  for (const u of users) {
    const prefs = notificationPrefs(u.notification_settings);
    const tz = u.timezone ?? u.workspace_memberships[0]?.workspace.timezone ?? 'UTC';
    if (localHour(now, tz) !== prefs.digest.hour) continue;
    if (prefs.digest.daily) {
      const q = await queueDigest(prisma, u.id, 'daily', now);
      if (q.id) result.daily += 1;
    }
    const monday = new Date(`${localDate(now, tz)}T12:00:00Z`).getUTCDay() === 1;
    if (prefs.digest.weekly && monday && u.headed_departments.length > 0) {
      const q = await queueDigest(prisma, u.id, 'weekly', now);
      if (q.id) result.weekly += 1;
    }
  }
  return result;
}
