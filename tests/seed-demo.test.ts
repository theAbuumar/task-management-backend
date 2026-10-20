// Integration tests for the demo seed (Ф13 13.B1): the stand a commission clicks
// through must hold together — every attachment opens, the notification feed is
// what the services themselves would have produced, the reminder scheduler does
// not re-send what the seed already shows, the audit log has something in every
// filter, and the presenter's Telegram is linked without taking it from anyone.
//
// Runs against a live Postgres (taskmgmt_test). The demo workspace, its files and
// the @demo.local accounts are removed in afterAll; audit rows are append-only.

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { PrismaClient, type NotificationType } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalStorageDriver } from '../src/lib/storage.js';
import { seedDemo, DOMAIN, SLUG, type SeedDemoResult } from '../src/prisma/demo/university.js';
import { runReminders } from '../src/modules/control/reminders.js';
import { runRecurring } from '../src/modules/recurring/service.js';
import {
  AUDIT_GROUPS,
  AuditQuerySchema,
  listAudit,
  type AuditGroup,
} from '../src/modules/audit/service.js';

const prisma = new PrismaClient();
const TS = Date.now();
// The latest 12:00 in the university's time zone (UTC+5): today's reminders are due.
const NOW = (() => {
  const d = new Date();
  d.setUTCHours(7, 0, 0, 0);
  if (d.getTime() > Date.now()) d.setUTCDate(d.getUTCDate() - 1);
  return d.getTime();
})();
const TELEGRAM_ID = String(7_000_000_000 + (TS % 1_000_000_000));
const TAKEN_TELEGRAM_ID = String(8_000_000_000 + (TS % 1_000_000_000));

// Every type a service creates today (invite_received, report_ready and digest are
// reserved by ADR-020 and not produced yet, so the demo must not invent them).
const PRODUCED: NotificationType[] = [
  'issue_assigned',
  'acknowledged',
  'state_changed',
  'comment_added',
  'mentioned',
  'review_requested',
  'review_approved',
  'review_returned',
  'deadline_change_requested',
  'deadline_change_decided',
  'due_soon',
  'overdue',
  'escalated',
];
const SYSTEM: NotificationType[] = ['due_soon', 'overdue', 'escalated'];

let dir: string;
let storage: LocalStorageDriver;
let seeded: SeedDemoResult;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), `tm-demo-${TS}-`));
  storage = new LocalStorageDriver({
    baseDir: dir,
    baseUrl: 'http://localhost:3000',
    ttl: 900,
    downloadTtl: 86_400,
    secret: 'test-storage-secret',
  });
  seeded = await seedDemo(prisma, {
    storage,
    now: NOW,
    telegramId: TELEGRAM_ID,
    telegramRole: 'prorector',
  });
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { slug: SLUG } });
  await prisma.user.deleteMany({
    where: { OR: [{ email: { endsWith: DOMAIN } }, { email: `demo-tg-${TS}@example.com` }] },
  });
  await prisma.$disconnect();
  await rm(dir, { recursive: true, force: true });
});

describe('demo seed (13.B1)', () => {
  it('builds the university with history in the past only', async () => {
    expect(seeded.issues).toBeGreaterThanOrEqual(60);
    expect(seeded.attachments).toBeGreaterThan(20);
    const ws = seeded.workspaceId;
    const [lastNote, lastActivity, lastComment, lastFile] = await Promise.all([
      prisma.notification.aggregate({ where: { workspace_id: ws }, _max: { created_at: true } }),
      prisma.activityLog.aggregate({ where: { workspace_id: ws }, _max: { created_at: true } }),
      prisma.comment.aggregate({
        where: { issue: { workspace_id: ws } },
        _max: { created_at: true },
      }),
      prisma.attachment.aggregate({ where: { workspace_id: ws }, _max: { created_at: true } }),
    ]);
    for (const latest of [lastNote, lastActivity, lastComment, lastFile]) {
      expect(latest._max.created_at!.getTime()).toBeLessThanOrEqual(NOW);
    }
  });

  it('the accreditation timeline has «блокирует» links, each with its mirror (7.F4)', async () => {
    const links = await prisma.issueLink.findMany({
      where: { issue: { workspace_id: seeded.workspaceId, project: { identifier: 'ACCR' } } },
      include: {
        issue: { select: { project_id: true } },
        related_issue: { select: { project_id: true } },
      },
    });
    const blocks = links.filter((l) => l.relation_type === 'blocks');
    expect(blocks.length).toBeGreaterThanOrEqual(5);
    for (const link of blocks) {
      expect(link.related_issue.project_id).toBe(link.issue.project_id);
      expect(
        links.some(
          (m) =>
            m.relation_type === 'blocked_by' &&
            m.issue_id === link.related_issue_id &&
            m.related_issue_id === link.issue_id,
        ),
      ).toBe(true);
    }
  });

  it('has the Ф6 tools: a 3-of-7 checklist, two templates, two rules with their issues', async () => {
    const readiness = await prisma.issue.findFirstOrThrow({
      where: {
        workspace_id: seeded.workspaceId,
        title: 'Чек-лист готовности к аккредитационной экспертизе',
      },
      include: { checklist: true },
    });
    expect(readiness).toMatchObject({ checklist_total: 7, checklist_done: 3 });
    expect(readiness.checklist.filter((i) => i.is_done)).toHaveLength(3);
    // The counters always match the items.
    const withItems = await prisma.issue.findMany({
      where: { workspace_id: seeded.workspaceId, checklist_total: { gt: 0 } },
      include: { checklist: true },
    });
    expect(withItems.length).toBeGreaterThanOrEqual(3);
    for (const issue of withItems) {
      expect(issue.checklist_total).toBe(issue.checklist.length);
      expect(issue.checklist_done).toBe(issue.checklist.filter((i) => i.is_done).length);
    }

    const templates = await prisma.issueTemplate.findMany({
      where: { workspace_id: seeded.workspaceId },
    });
    expect(templates.map((t) => t.project_id === null)).toEqual(
      expect.arrayContaining([true, false]),
    );

    const rules = await prisma.recurringRule.findMany({
      where: { workspace_id: seeded.workspaceId },
      include: { issues: true },
    });
    expect(rules).toHaveLength(2);
    for (const rule of rules) {
      expect(rule.issues.length).toBeGreaterThanOrEqual(2);
      expect(rule.next_run_at!.getTime()).toBeGreaterThan(NOW);
    }
    // The scheduler has nothing to make up: every past run has its issue.
    const run = await runRecurring(prisma, {
      now: new Date(NOW),
      workspaceId: seeded.workspaceId,
    });
    expect(run).toEqual({ created: 0, failed: 0, paused: 0 });
  });

  it('has the Ф4 structure: three stages, modules with leads, sub-issues, a thread (ADR-031)', async () => {
    const accr = await prisma.project.findFirstOrThrow({
      where: { workspace_id: seeded.workspaceId, identifier: 'ACCR' },
    });
    const cycles = await prisma.cycle.findMany({
      where: { project_id: accr.id },
      include: { issues: { select: { id: true } } },
      orderBy: { start_date: 'asc' },
    });
    expect(cycles.map((c) => c.name)).toEqual([
      'Сбор документов',
      'Самообследование',
      'Визит экспертной комиссии',
    ]);
    // Done, now and ahead.
    expect(cycles[0]!.end_date!.getTime()).toBeLessThan(NOW);
    expect(cycles[1]!.start_date!.getTime()).toBeLessThan(NOW);
    expect(cycles[1]!.end_date!.getTime()).toBeGreaterThan(NOW);
    expect(cycles[2]!.start_date!.getTime()).toBeGreaterThan(NOW);
    expect(cycles.every((c) => c.issues.length >= 2)).toBe(true);

    const modules = await prisma.module.findMany({
      where: { project_id: accr.id },
      include: { issues: true },
    });
    expect(modules).toHaveLength(3);
    expect(modules.every((m) => m.lead_id && m.issues.length >= 2)).toBe(true);

    // Joining a stage or a module is in the issue's history, as the services write it.
    const joined = await prisma.activityLog.count({
      where: {
        workspace_id: seeded.workspaceId,
        OR: [{ field: 'cycle_id' }, { action: 'issue.module_added' }],
      },
    });
    expect(joined).toBe(
      cycles.reduce((n, c) => n + c.issues.length, 0) +
        modules.reduce((n, m) => n + m.issues.length, 0),
    );

    const presentation = await prisma.issue.findFirstOrThrow({
      where: { project_id: accr.id, title: 'Подготовить презентацию для экспертной комиссии' },
      include: { children: { include: { state: true } } },
    });
    expect(presentation.children).toHaveLength(3);
    expect(presentation.children.filter((c) => c.state.group === 'completed')).toHaveLength(1);

    // A thread: the question, two replies, one of them edited.
    const thread = await prisma.comment.findMany({
      where: { issue: { title: 'Чек-лист готовности к аккредитационной экспертизе' } },
      orderBy: { created_at: 'asc' },
    });
    const head = thread.find((c) => c.body.startsWith('@'))!;
    const replies = thread.filter((c) => c.parent_comment_id === head.id);
    expect(replies).toHaveLength(2);
    expect(replies.some((c) => c.edited_at)).toBe(true);

    // Every relation is in the history of both its issues.
    const relations = await prisma.issueLink.count({
      where: { issue: { workspace_id: seeded.workspaceId } },
    });
    const recorded = await prisma.activityLog.count({
      where: { workspace_id: seeded.workspaceId, action: 'issue.relation_added' },
    });
    expect(recorded).toBe(relations);
  });

  it('has ready-made views: shared ones for everyone and a personal one for the prorector (7.B4)', async () => {
    const views = await prisma.savedView.findMany({
      where: { workspace_id: seeded.workspaceId },
      include: { project: { select: { workspace_id: true } }, owner: { select: { email: true } } },
    });
    expect(views.filter((v) => v.is_shared).length).toBeGreaterThanOrEqual(3);
    expect(views.some((v) => !v.is_shared && v.owner.email === 'pr.edu@demo.local')).toBe(true);
    for (const v of views) {
      if (v.project) expect(v.project.workspace_id).toBe(seeded.workspaceId);
    }
  });

  it('a deadline request in the history says which date was asked for, as the service records it', async () => {
    const rows = await prisma.activityLog.findMany({
      where: { workspace_id: seeded.workspaceId, action: 'issue.deadline_requested' },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.field).toBe('due_date');
      expect(row.new_value).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('every attachment opens: real PDF and Excel files, report files tied to their hand-in', async () => {
    const files = await prisma.attachment.findMany({
      where: { workspace_id: seeded.workspaceId },
      include: { review: { select: { issue_id: true } } },
    });
    expect(files.length).toBe(seeded.attachments);
    for (const f of files) {
      const bytes = await readFile(storage.resolvePath(f.storage_key));
      expect(bytes.length).toBe(f.file_size);
      const magic = bytes.subarray(0, 4).toString('latin1');
      expect(magic).toBe(f.mime_type === 'application/pdf' ? '%PDF' : 'PK\u0003\u0004');
      if (f.review) expect(f.review.issue_id).toBe(f.issue_id);
    }
    expect(files.some((f) => f.review_id && f.file_name.endsWith('(первая редакция).pdf'))).toBe(
      true,
    );
    expect(files.some((f) => !f.review_id && f.file_name.startsWith('Протокол совещания'))).toBe(
      true,
    );

    const table = files.find((f) => f.file_name.endsWith('.xlsx'))!;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await readFile(storage.resolvePath(table.storage_key)));
    const sheet = wb.getWorksheet('Сводка')!;
    expect(sheet.getRow(sheet.rowCount).getCell(2).value).toBe('Итого');
  });

  it('the feed is what the services would have sent: all produced types, right recipients', async () => {
    const notes = await prisma.notification.findMany({
      where: { workspace_id: seeded.workspaceId },
    });
    expect(new Set(notes.map((n) => n.type))).toEqual(new Set(PRODUCED));
    for (const n of notes) {
      if (!SYSTEM.includes(n.type)) expect(n.recipient_id).not.toBe(n.actor_id);
      expect(n.is_read).toBe(n.read_at !== null);
    }

    // Decisions on deadline requests point at the request; hand-in events at the review.
    const decided = notes.filter((n) => n.type === 'deadline_change_decided');
    const requests = await prisma.deadlineChangeRequest.findMany({
      where: { id: { in: decided.map((n) => n.entity_id!) } },
    });
    expect(requests).toHaveLength(new Set(decided.map((n) => n.entity_id)).size);
    expect(requests.every((r) => r.status !== 'pending')).toBe(true);
    const reviewNotes = notes.filter((n) => n.type.startsWith('review_'));
    const reviews = await prisma.issueReview.findMany({
      where: { id: { in: reviewNotes.map((n) => n.entity_id!) } },
    });
    for (const n of reviewNotes) {
      const review = reviews.find((r) => r.id === n.entity_id);
      expect(review?.issue_id).toBe(n.issue_id);
      // The controller who already decided has read the hand-in by then.
      if (n.type === 'review_requested' && review?.decided_at) {
        expect(n.read_at?.getTime()).toBeLessThanOrEqual(review.decided_at.getTime());
      }
    }

    // A mention notifies the person whose @handle is in the comment.
    const mentions = notes.filter((n) => n.type === 'mentioned');
    const comments = await prisma.comment.findMany({
      where: { id: { in: mentions.map((n) => n.entity_id!) } },
    });
    const users = await prisma.user.findMany({
      where: { id: { in: mentions.map((n) => n.recipient_id) } },
    });
    for (const n of mentions) {
      const handle = users.find((u) => u.id === n.recipient_id)!.email!.split('@')[0];
      expect(comments.find((c) => c.id === n.entity_id)!.body).toContain(`@${handle}`);
    }

    // Demo accounts open a bell with something new, not a wall of it.
    const demo = await prisma.user.findMany({
      where: {
        email: { in: ['rector', 'pr.edu', 'dean.econ', 'umu.spec'].map((h) => `${h}${DOMAIN}`) },
      },
    });
    for (const u of demo) {
      const unread = notes.filter((n) => n.recipient_id === u.id && !n.is_read).length;
      expect(unread, u.email!).toBeGreaterThan(0);
      expect(unread, u.email!).toBeLessThanOrEqual(30);
    }

    // Something to decide on stage: the late faculty asks to move the deadline.
    const pending = await prisma.deadlineChangeRequest.findMany({
      where: { workspace_id: seeded.workspaceId, status: 'pending' },
      include: { issue: { select: { title: true } } },
    });
    expect(pending.some((r) => r.issue.title.endsWith('— ФФ'))).toBe(true);
    expect(pending.every((r) => r.new_due_date.getTime() > NOW)).toBe(true);
  });

  it('the scheduler finds today’s reminders already sent and adds nothing', async () => {
    const today = await prisma.notification.count({
      where: {
        workspace_id: seeded.workspaceId,
        type: 'overdue',
        created_at: { gte: new Date(NOW - 3 * 3_600_000) },
      },
    });
    expect(today).toBeGreaterThan(0);
    const run = await runReminders(prisma, { now: new Date(NOW), workspaceId: seeded.workspaceId });
    expect(run.workspaces).toBe(1);
    expect(run.sent).toEqual({ due_soon: 0, overdue: 0, escalated: 0 });
  });

  it('the audit log has entries in every filter, with names resolved', async () => {
    const owner = { role: 'owner' as const };
    for (const group of Object.keys(AUDIT_GROUPS) as AuditGroup[]) {
      const page = await listAudit(
        prisma,
        seeded.workspaceId,
        owner,
        AuditQuerySchema.parse({ group, limit: 200 }),
      );
      expect(page.data.length, group).toBeGreaterThan(0);
    }
    const deletions = await listAudit(
      prisma,
      seeded.workspaceId,
      owner,
      AuditQuerySchema.parse({ group: 'deletions' }),
    );
    expect(deletions.data[0]!.target?.name).toMatch(/^ADM-\d+ .*\(дубль\)$/);
    const logins = await listAudit(
      prisma,
      seeded.workspaceId,
      owner,
      AuditQuerySchema.parse({ group: 'auth', limit: 200 }),
    );
    expect(logins.data.every((e) => e.actor?.display_name && e.ip && e.user_agent)).toBe(true);
    // The deleted duplicate stays out of the work lists and analytics (soft delete).
    const duplicate = await prisma.issue.findFirst({
      where: { workspace_id: seeded.workspaceId, title: { endsWith: '(дубль)' } },
    });
    expect(duplicate?.deleted_at).not.toBeNull();
  });

  it('people have live sessions on a computer and a phone for «Мои сессии»', async () => {
    const live = await prisma.authSession.findMany({
      where: { user: { email: { endsWith: '@demo.local' } }, revoked_at: null },
    });
    expect(live.length).toBe(seeded.sessions);
    expect(live.length).toBeGreaterThan(10);
    for (const s of live) {
      expect(s.method && s.ip && s.user_agent).toBeTruthy();
      expect(s.created_at.getTime()).toBeLessThanOrEqual(s.last_used_at.getTime());
      expect(s.last_used_at.getTime()).toBeLessThan(NOW);
      expect(s.expires_at.getTime()).toBeGreaterThan(NOW);
    }
    // At most one per device kind and person.
    const perUser = new Map<string, number>();
    for (const s of live) perUser.set(s.user_id, (perUser.get(s.user_id) ?? 0) + 1);
    expect(Math.max(...perUser.values())).toBeLessThanOrEqual(2);
  });

  it('links the presenter’s Telegram to the chosen demo account', async () => {
    expect(seeded.telegram).toBe('linked');
    const identity = await prisma.authIdentity.findUnique({
      where: { provider_provider_user_id: { provider: 'telegram', provider_user_id: TELEGRAM_ID } },
      include: { user: { select: { email: true } } },
    });
    expect(identity?.user.email).toBe(`pr.edu${DOMAIN}`);
  });

  it('re-seeding replaces the stand and its files, and never takes a Telegram linked elsewhere', async () => {
    const oldFiles = await prisma.attachment.findMany({
      where: { workspace_id: seeded.workspaceId },
    });
    const owner = await prisma.user.create({
      data: {
        email: `demo-tg-${TS}@example.com`,
        display_name: 'Настоящий Аккаунт',
        identities: { create: { provider: 'telegram', provider_user_id: TAKEN_TELEGRAM_ID } },
      },
    });
    const warnings: string[] = [];
    const again = await seedDemo(prisma, {
      storage,
      now: NOW,
      telegramId: TAKEN_TELEGRAM_ID,
      warn: (line) => warnings.push(line),
    });

    expect(again.telegram).toBe('taken');
    expect(warnings.join('\n')).toContain('Настоящий Аккаунт');
    const identity = await prisma.authIdentity.findUnique({
      where: {
        provider_provider_user_id: { provider: 'telegram', provider_user_id: TAKEN_TELEGRAM_ID },
      },
    });
    expect(identity?.user_id).toBe(owner.id);
    expect(await prisma.workspace.count({ where: { slug: SLUG } })).toBe(1);
    for (const f of oldFiles) {
      await expect(stat(storage.resolvePath(f.storage_key))).rejects.toThrow();
    }
  }, 60_000);
});
