// «Скачать мои данные» (Ф12 12.B13, docs/PRIVACY.md): everything the system keeps
// about the signed-in person, as one JSON file — the profile, sign-in methods and
// sessions, workspaces and positions, the work they authored or were assigned,
// notifications, AI dialogues and usage, and their own audit-log entries.
//
// Only the caller's own data: no other person's texts (comments of colleagues,
// reports of others) — issues are named by key and title so the file stays
// readable. Secrets are never included: no password hash, codes or tokens.
// File bytes are not inlined; attachments are listed by name and size.

import type { PrismaClient } from '@prisma/client';

/** Caps keep the file reasonable for a long-time user; the newest rows are kept. */
const MAX_ROWS = 5000;
const MAX_NOTIFICATIONS = 1000;

type IssueRef = { title: string; sequence_id: number; project: { identifier: string } };
const keyOf = (i: IssueRef) => `${i.project.identifier}-${i.sequence_id}`;
const issueSelect = {
  title: true,
  sequence_id: true,
  project: { select: { identifier: true } },
} as const;

export const DATA_EXPORT_FORMAT = 'fulltask-personal-data/1';

export async function exportMyData(prisma: PrismaClient, userId: string) {
  const newest = { created_at: 'desc' as const };
  const [
    user,
    identities,
    sessions,
    memberships,
    created,
    assigned,
    controlled,
    watched,
    comments,
    attachments,
    reviews,
    deadlineRequests,
    notifications,
    conversations,
    aiUsage,
    audit,
  ] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        email_verified: true,
        display_name: true,
        last_name: true,
        first_name: true,
        middle_name: true,
        phone: true,
        locale: true,
        timezone: true,
        avatar_url: true,
        notification_settings: true,
        created_at: true,
        updated_at: true,
      },
    }),
    prisma.authIdentity.findMany({
      where: { user_id: userId },
      select: { provider: true, provider_user_id: true, provider_email: true, created_at: true },
      orderBy: { created_at: 'asc' },
    }),
    prisma.authSession.findMany({
      where: { user_id: userId },
      select: {
        method: true,
        ip: true,
        user_agent: true,
        created_at: true,
        last_used_at: true,
        expires_at: true,
        revoked_at: true,
      },
      orderBy: newest,
      take: MAX_ROWS,
    }),
    prisma.workspaceMember.findMany({
      where: { user_id: userId },
      select: {
        role: true,
        position: true,
        created_at: true,
        deactivated_at: true,
        workspace: { select: { name: true, slug: true } },
        department: { select: { name: true } },
      },
    }),
    prisma.issue.findMany({
      where: { created_by_id: userId, deleted_at: null },
      select: { ...issueSelect, kind: true, created_at: true },
      orderBy: newest,
      take: MAX_ROWS,
    }),
    prisma.issueAssignee.findMany({
      where: { user_id: userId, issue: { deleted_at: null } },
      select: {
        is_primary: true,
        acknowledged_at: true,
        created_at: true,
        issue: { select: issueSelect },
      },
      orderBy: newest,
      take: MAX_ROWS,
    }),
    prisma.issue.findMany({
      where: { controller_id: userId, deleted_at: null },
      select: { ...issueSelect, created_at: true },
      orderBy: newest,
      take: MAX_ROWS,
    }),
    prisma.issueWatcher.findMany({
      where: { user_id: userId, issue: { deleted_at: null } },
      select: { created_at: true, issue: { select: issueSelect } },
      orderBy: newest,
      take: MAX_ROWS,
    }),
    prisma.comment.findMany({
      where: { author_id: userId, deleted_at: null, issue: { deleted_at: null } },
      select: { body: true, created_at: true, updated_at: true, issue: { select: issueSelect } },
      orderBy: newest,
      take: MAX_ROWS,
    }),
    prisma.attachment.findMany({
      where: { uploaded_by_id: userId, issue: { deleted_at: null } },
      select: {
        file_name: true,
        file_size: true,
        mime_type: true,
        created_at: true,
        issue: { select: issueSelect },
      },
      orderBy: newest,
      take: MAX_ROWS,
    }),
    prisma.issueReview.findMany({
      where: { submitted_by_id: userId, issue: { deleted_at: null } },
      select: {
        report: true,
        decision: true,
        submitted_at: true,
        decided_at: true,
        issue: { select: issueSelect },
      },
      orderBy: { submitted_at: 'desc' },
      take: MAX_ROWS,
    }),
    prisma.deadlineChangeRequest.findMany({
      where: { requested_by_id: userId, issue: { deleted_at: null } },
      select: {
        old_due_date: true,
        new_due_date: true,
        reason: true,
        status: true,
        created_at: true,
        decided_at: true,
        issue: { select: issueSelect },
      },
      orderBy: newest,
      take: MAX_ROWS,
    }),
    prisma.notification.findMany({
      where: { recipient_id: userId },
      select: {
        type: true,
        is_read: true,
        created_at: true,
        read_at: true,
        issue: { select: issueSelect },
      },
      orderBy: newest,
      take: MAX_NOTIFICATIONS,
    }),
    prisma.aiConversation.findMany({
      where: { user_id: userId },
      select: {
        title: true,
        created_at: true,
        messages: {
          select: { role: true, content: true, created_at: true },
          orderBy: { created_at: 'asc' },
        },
      },
      orderBy: newest,
    }),
    prisma.aiUsage.findMany({
      where: { user_id: userId },
      select: {
        feature: true,
        model: true,
        status: true,
        input_tokens: true,
        output_tokens: true,
        created_at: true,
      },
      orderBy: newest,
      take: MAX_ROWS,
    }),
    prisma.auditLog.findMany({
      where: { actor_id: userId },
      select: {
        action: true,
        target_type: true,
        ip: true,
        user_agent: true,
        created_at: true,
      },
      orderBy: newest,
      take: MAX_ROWS,
    }),
  ]);

  return {
    format: DATA_EXPORT_FORMAT,
    exported_at: new Date(),
    about:
      'Ваши данные в системе поручений: профиль, способы входа и сеансы, пространства, ваша работа, уведомления, диалоги с AI и ваши записи в журнале аудита. Задачи названы ключом и заголовком; тексты других людей сюда не входят; файлы перечислены без содержимого. Что и зачем хранится — docs/PRIVACY.md.',
    profile: user,
    sign_in_methods: identities,
    sessions,
    workspaces: memberships.map((m) => ({
      name: m.workspace.name,
      slug: m.workspace.slug,
      role: m.role,
      department: m.department?.name ?? null,
      position: m.position,
      joined_at: m.created_at,
      deactivated_at: m.deactivated_at,
    })),
    work: {
      created_issues: created.map((i) => ({
        key: keyOf(i),
        title: i.title,
        kind: i.kind,
        created_at: i.created_at,
      })),
      assigned_issues: assigned.map((a) => ({
        key: keyOf(a.issue),
        title: a.issue.title,
        responsible: a.is_primary,
        assigned_at: a.created_at,
        acknowledged_at: a.acknowledged_at,
      })),
      controlled_issues: controlled.map((i) => ({
        key: keyOf(i),
        title: i.title,
        created_at: i.created_at,
      })),
      watched_issues: watched.map((w) => ({
        key: keyOf(w.issue),
        title: w.issue.title,
        since: w.created_at,
      })),
      comments: comments.map((c) => ({
        issue: keyOf(c.issue),
        body: c.body,
        created_at: c.created_at,
        updated_at: c.updated_at,
      })),
      attachments: attachments.map((a) => ({
        issue: keyOf(a.issue),
        file_name: a.file_name,
        file_size: a.file_size,
        mime_type: a.mime_type,
        uploaded_at: a.created_at,
      })),
      review_reports: reviews.map((r) => ({
        issue: keyOf(r.issue),
        report: r.report,
        decision: r.decision,
        submitted_at: r.submitted_at,
        decided_at: r.decided_at,
      })),
      deadline_requests: deadlineRequests.map((d) => ({
        issue: keyOf(d.issue),
        old_due_date: d.old_due_date,
        new_due_date: d.new_due_date,
        reason: d.reason,
        status: d.status,
        created_at: d.created_at,
        decided_at: d.decided_at,
      })),
    },
    notifications: notifications.map((n) => ({
      type: n.type,
      issue: n.issue ? keyOf(n.issue) : null,
      is_read: n.is_read,
      created_at: n.created_at,
      read_at: n.read_at,
    })),
    ai: { conversations, usage: aiUsage },
    audit_log: audit,
  };
}
