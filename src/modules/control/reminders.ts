// Deadline reminders and escalations (Ф5 5.B6, 5.B8).
//
// One pass looks at every open, dated issue and, in the workspace's own time zone:
//   - due_soon:<n>  — n days before the deadline (n from settings.reminder_days,
//                     0 = "сегодня срок"), to the assignees (or the author);
//   - overdue       — once per day while the issue stays open past its deadline,
//                     to the assignees and the controller;
//   - escalated     — once per deadline when it is `escalation_days` overdue, to the
//                     head of the primary assignee's department and the controller.
// ReminderLog's unique key makes every reminder fire exactly once, so the pass is
// safe to run as often as we like (the scheduler runs it every few minutes).

import type { Prisma, PrismaClient } from '@prisma/client';
import { notify } from '../../lib/notifications.js';
import { deliverIssueEvent, type IssueEventKind } from '../../lib/deliver.js';
import { controlSettings } from '../../lib/control-settings.js';
import { addDays, daysBetween, localDate, localHour, startOfLocalDay } from '../../lib/tz.js';
import { OPEN_GROUPS } from './rules.js';

export interface ReminderRunResult {
  workspaces: number;
  sent: { due_soon: number; overdue: number; escalated: number };
}

interface RunOptions {
  now?: Date;
  /** Limit to one workspace (manual trigger). */
  workspaceId?: string;
  /** Ignore the reminder hour (manual trigger / demo). */
  force?: boolean;
}

/** Insert a ReminderLog row; false when this reminder was already sent. */
async function claim(
  prisma: PrismaClient,
  row: { issue_id: string; user_id: string; kind: string; for_date: string },
): Promise<boolean> {
  try {
    await prisma.reminderLog.create({ data: row });
    return true;
  } catch (err) {
    if ((err as Prisma.PrismaClientKnownRequestError).code === 'P2002') return false;
    throw err;
  }
}

export async function runReminders(
  prisma: PrismaClient,
  options: RunOptions = {},
): Promise<ReminderRunResult> {
  const now = options.now ?? new Date();
  const result: ReminderRunResult = {
    workspaces: 0,
    sent: { due_soon: 0, overdue: 0, escalated: 0 },
  };

  const workspaces = await prisma.workspace.findMany({
    where: options.workspaceId ? { id: options.workspaceId } : {},
    select: { id: true, timezone: true, settings: true },
  });

  for (const ws of workspaces) {
    const settings = controlSettings(ws.settings);
    if (!options.force && localHour(now, ws.timezone) < settings.reminder_hour) continue;
    result.workspaces += 1;

    const today = localDate(now, ws.timezone);
    const horizon = Math.max(0, ...settings.reminder_days);
    const issues = await prisma.issue.findMany({
      where: {
        workspace_id: ws.id,
        deleted_at: null,
        project: { deleted_at: null },
        due_date: { not: null, lt: startOfLocalDay(addDays(today, horizon + 1), ws.timezone) },
        state: { group: { in: OPEN_GROUPS } },
      },
      select: {
        id: true,
        due_date: true,
        created_by_id: true,
        controller_id: true,
        assignees: { select: { user_id: true, is_primary: true } },
      },
    });

    for (const issue of issues) {
      const due = localDate(issue.due_date!, ws.timezone);
      const left = daysBetween(today, due);
      const assignees = issue.assignees.map((a) => a.user_id);
      const owners = assignees.length > 0 ? assignees : [issue.created_by_id];

      const send = async (
        kind: IssueEventKind,
        logKind: string,
        forDate: string,
        recipients: string[],
        days: number,
        extra: { responsible?: string | null } = {},
      ) => {
        const fresh: string[] = [];
        for (const userId of [...new Set(recipients)]) {
          if (
            await claim(prisma, {
              issue_id: issue.id,
              user_id: userId,
              kind: logKind,
              for_date: forDate,
            })
          ) {
            fresh.push(userId);
          }
        }
        if (fresh.length === 0) return 0;
        await notify(prisma, {
          workspace_id: ws.id,
          actor_id: issue.controller_id ?? issue.created_by_id,
          type: kind as 'due_soon' | 'overdue' | 'escalated',
          recipient_ids: fresh,
          issue_id: issue.id,
          include_actor: true,
        });
        await deliverIssueEvent(prisma, {
          issueId: issue.id,
          kind,
          recipientIds: fresh,
          actorId: null,
          details: { days, newDue: issue.due_date, ...extra },
        });
        return fresh.length;
      };

      if (left >= 0) {
        if (settings.reminder_days.includes(left)) {
          result.sent.due_soon += await send('due_soon', `due_soon:${left}`, due, owners, left);
        }
        continue;
      }

      const overdueDays = -left;
      const controller = issue.controller_id ?? issue.created_by_id;
      result.sent.overdue += await send(
        'overdue',
        'overdue',
        today,
        [...owners, controller],
        overdueDays,
      );

      if (settings.escalation_days > 0 && overdueDays >= settings.escalation_days) {
        const primary = issue.assignees.find((a) => a.is_primary)?.user_id ?? assignees[0];
        const member = primary
          ? await prisma.workspaceMember.findUnique({
              where: { workspace_id_user_id: { workspace_id: ws.id, user_id: primary } },
              select: {
                user: { select: { display_name: true } },
                department: { select: { head_id: true } },
              },
            })
          : null;
        const head = member?.department?.head_id;
        const recipients = [controller, ...(head && head !== primary ? [head] : [])];
        result.sent.escalated += await send(
          'escalated',
          'escalated',
          due,
          recipients,
          overdueDays,
          {
            responsible: member?.user.display_name ?? null,
          },
        );
      }
    }
  }
  return result;
}
