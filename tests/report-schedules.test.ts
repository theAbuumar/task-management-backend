// Planned reports (Ф10 10.B5, ADR-032).
// - periods: always whole days before the day of sending (week, month, quarter,
//   30 days); the next run in the workspace zone;
// - rights: guests cannot create, a member sends only to themselves, an admin
//   to anyone active, filters are checked against the author's area, someone
//   else's report is 404, only the author or an admin changes it;
// - «Отправить сейчас»: the document goes as a Telegram document and an email
//   attachment to each recipient by their channels, «Отчёт готов» rings in the
//   app, the file is stored and downloadable by its recipients, the sending and
//   the download are in the audit log; a failing channel is recorded;
// - the scheduler pass sends a due report once, pauses one whose author lost
//   the right, keeps the latest 12 sendings; deleting removes the history.
// The Bot API is mocked at `fetch`, the mailer at the module boundary.
//
// Runs against a live Postgres; everything is removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { sendMail } from '../src/lib/mailer.js';
import { limitKind } from '../src/plugins/write-limits.js';
import { addDays, localDate } from '../src/lib/tz.js';
import {
  KEEP_RUNS,
  quarterStart,
  reportPeriod,
  runReportSchedules,
  runSchedule,
} from '../src/modules/report-schedules/run.js';

vi.mock('../src/lib/mailer.js', () => ({ sendMail: vi.fn(async () => {}) }));
const sendMailMock = vi.mocked(sendMail);

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `rsched-${TS}`;
const TZ = 'Asia/Tashkent';
const TG_RECTOR = TS + 7101;
const DAY = 86_400_000;
const emails = {
  rector: `rs-rector-${TS}@example.com`,
  dean: `rs-dean-${TS}@example.com`,
  worker: `rs-worker-${TS}@example.com`,
  guest: `rs-guest-${TS}@example.com`,
  off: `rs-off-${TS}@example.com`,
};

type Actor = { id: string; token: string };

let app: FastifyInstance;
let rector: Actor;
let dean: Actor;
let worker: Actor;
let guest: Actor;
let off: Actor;
let projectId: string;
const dept: Record<string, string> = {};

const api = (path: string) => `/api/v1/workspaces/${SLUG}${path}`;

async function register(email: string, name: string): Promise<Actor> {
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, display_name: name });
  expect(res.status).toBe(201);
  return { id: res.body.user.id, token: res.body.access_token };
}

function as(actor: Actor) {
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${actor.token}`);
  return {
    get: (url: string) => auth(request(app.server).get(url)),
    post: (url: string, body?: object) => auth(request(app.server).post(url)).send(body ?? {}),
    patch: (url: string, body: object) => auth(request(app.server).patch(url)).send(body),
    delete: (url: string) => auth(request(app.server).delete(url)),
  };
}

interface TelegramCall {
  method: string;
  chat_id: string | null;
  caption: string | null;
  file_name: string | null;
  size: number;
}

let telegramCalls: TelegramCall[] = [];
let telegramFails = false;

/** Bot API at the fetch boundary: records sendDocument uploads, fails on demand. */
function stubTelegram() {
  telegramCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: unknown }) => {
      if (!String(url).startsWith('https://api.telegram.org/bot')) {
        throw new Error(`unexpected fetch to ${url}`);
      }
      const method = String(url).split('/').pop()!;
      const form = init?.body instanceof FormData ? init.body : null;
      const file = form?.get('document') as File | null;
      telegramCalls.push({
        method,
        chat_id: (form?.get('chat_id') as string) ?? null,
        caption: (form?.get('caption') as string) ?? null,
        file_name: file?.name ?? null,
        size: file?.size ?? 0,
      });
      if (telegramFails) return { ok: false, json: async () => ({ ok: false }) };
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }),
  );
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  rector = await register(emails.rector, 'Ректоров Р. Р.');
  dean = await register(emails.dean, 'Деканов Д. Д.');
  worker = await register(emails.worker, 'Работников Р. Р.');
  guest = await register(emails.guest, 'Гостев Г. Г.');
  off = await register(emails.off, 'Отключённый О. О.');
  await as(rector).post('/api/v1/workspaces', {
    name: 'Тестовый университет',
    slug: SLUG,
    timezone: TZ,
  });
  for (const [u, role] of [
    [dean, 'member'],
    [worker, 'member'],
    [guest, 'guest'],
    [off, 'member'],
  ] as const) {
    expect((await as(rector).post(api('/members'), { user_id: u.id, role })).status).toBe(201);
  }
  const mk = async (name: string, parent?: string, head?: Actor) =>
    (await as(rector).post(api('/departments'), { name, parent_id: parent, head_id: head?.id }))
      .body.id as string;
  dept.root = await mk('Ректорат', undefined, rector);
  dept.feu = await mk('Экономический факультет', dept.root, dean);
  dept.law = await mk('Юридический факультет', dept.root);
  await as(rector).patch(api(`/members/${dean.id}`), { department_id: dept.feu });
  await as(rector).patch(api(`/members/${worker.id}`), { department_id: dept.feu });

  projectId = (
    await as(rector).post(api('/projects'), {
      name: 'Аккредитация',
      identifier: 'RSA',
      member_ids: [dean.id, worker.id],
    })
  ).body.id;
  const states = (await as(rector).get(api(`/projects/${projectId}/states`))).body as {
    id: string;
    group: string;
  }[];
  const unstarted = states.find((s) => s.group === 'unstarted')!.id;
  for (const [title, days] of [
    ['Отчёт факультета', -3],
    ['Программы кафедр', 4],
  ] as const) {
    const res = await as(rector).post(api(`/projects/${projectId}/issues`), {
      title,
      state_id: unstarted,
      assignee_ids: [worker.id],
      due_date: new Date(Date.now() + days * DAY).toISOString(),
    });
    expect(res.status).toBe(201);
  }

  // The rector's Telegram is linked; the dean has only email.
  await app.prisma.authIdentity.create({
    data: { user_id: rector.id, provider: 'telegram', provider_user_id: String(TG_RECTOR) },
  });
  const ws = await app.prisma.workspace.findUniqueOrThrow({ where: { slug: SLUG } });
  await app.prisma.workspaceMember.update({
    where: { workspace_id_user_id: { workspace_id: ws.id, user_id: off.id } },
    data: { deactivated_at: new Date() },
  });
});

beforeEach(() => {
  sendMailMock.mockClear();
  telegramFails = false;
  stubTelegram();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  const ws = await app.prisma.workspace.findUnique({ where: { slug: SLUG } });
  if (ws) {
    const runs = await app.prisma.reportRun.findMany({ where: { workspace_id: ws.id } });
    for (const r of runs) if (r.storage_key) await app.storage.delete(r.storage_key);
    await app.prisma.workspace.delete({ where: { id: ws.id } });
  }
  await app.prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
  await app.close();
});

// ─── Periods ──────────────────────────────────────────────────────────────────

describe('report periods', () => {
  it('cover whole days before the day of sending', () => {
    // Wednesday 21 October 2026.
    expect(reportPeriod('previous_week', '2026-10-21')).toEqual({
      from: '2026-10-12',
      to: '2026-10-18',
    });
    // On a Monday the previous week is the one that just ended.
    expect(reportPeriod('previous_week', '2026-10-19')).toEqual({
      from: '2026-10-12',
      to: '2026-10-18',
    });
    expect(reportPeriod('previous_month', '2026-01-15')).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
    expect(reportPeriod('previous_month', '2026-03-01')).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
    expect(reportPeriod('previous_quarter', '2026-11-17')).toEqual({
      from: '2026-07-01',
      to: '2026-09-30',
    });
    expect(reportPeriod('previous_quarter', '2026-02-02')).toEqual({
      from: '2025-10-01',
      to: '2025-12-31',
    });
    expect(reportPeriod('last_30_days', '2026-10-21')).toEqual({
      from: '2026-09-21',
      to: '2026-10-20',
    });
    expect(quarterStart('2026-12-31')).toBe('2026-10-01');
  });

  it('making and downloading a planned report spend the export budget', () => {
    expect(
      limitKind('POST', '/api/v1/workspaces/:workspaceSlug/report-schedules/:scheduleId/run'),
    ).toBe('export');
    expect(limitKind('GET', '/api/v1/workspaces/:workspaceSlug/report-runs/:runId/download')).toBe(
      'export',
    );
    expect(limitKind('POST', '/api/v1/workspaces/:workspaceSlug/report-schedules')).toBe('write');
  });
});

// ─── Creating and rights ──────────────────────────────────────────────────────

describe('creating a planned report', () => {
  it('defaults: weekly on Monday at 08:00 for the previous week, to the author, both channels', async () => {
    const res = await as(dean).post(api('/report-schedules'), {
      report: 'discipline',
      frequency: 'weekly',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      report: 'discipline',
      period: 'previous_week',
      frequency: 'weekly',
      by_weekday: [1],
      by_monthday: null,
      time: '08:00',
      recipient_ids: [dean.id],
      channels: ['telegram', 'email'],
      is_active: true,
      can_edit: true,
      last_run: null,
    });
    // The next Monday 08:00 in Tashkent (03:00 UTC), after now.
    const next = new Date(res.body.next_run_at);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.getTime() - Date.now()).toBeLessThanOrEqual(7 * DAY);
    expect(next.getUTCHours()).toBe(3);
    expect(next.getUTCDay()).toBe(1);
  });

  it('quarterly reports go in the quarter’s first month', async () => {
    const res = await as(rector).post(api('/report-schedules'), {
      report: 'discipline',
      frequency: 'quarterly',
      by_monthday: 5,
    });
    expect(res.status).toBe(201);
    expect(res.body.period).toBe('previous_quarter');
    const month = Number(localDate(new Date(res.body.next_run_at), TZ).slice(5, 7));
    expect([1, 4, 7, 10]).toContain(month);
    expect(localDate(new Date(res.body.next_run_at), TZ).slice(8)).toBe('05');
  });

  it('a member sends only to themselves; an admin to any active member', async () => {
    const mine = await as(dean).post(api('/report-schedules'), {
      report: 'discipline',
      frequency: 'monthly',
      recipient_ids: [dean.id, rector.id],
    });
    expect(mine.status).toBe(403);
    expect(mine.body.error.code).toBe('REPORT_RECIPIENTS_FORBIDDEN');

    const offRecipient = await as(rector).post(api('/report-schedules'), {
      report: 'discipline',
      frequency: 'monthly',
      recipient_ids: [rector.id, off.id],
    });
    expect(offRecipient.status).toBe(400);
    expect(offRecipient.body.error.code).toBe('RECIPIENT_NOT_MEMBER');

    const shared = await as(rector).post(api('/report-schedules'), {
      report: 'assignments',
      frequency: 'monthly',
      recipient_ids: [rector.id, dean.id],
    });
    expect(shared.status).toBe(201);
  });

  it('a guest cannot create one; filters must be inside the author’s area', async () => {
    const byGuest = await as(guest).post(api('/report-schedules'), {
      report: 'discipline',
      frequency: 'weekly',
    });
    expect(byGuest.status).toBe(403);
    expect(byGuest.body.error.code).toBe('GUEST_READ_ONLY');

    const outside = await as(dean).post(api('/report-schedules'), {
      report: 'discipline',
      frequency: 'weekly',
      filters: { department: [dept.law] },
    });
    expect(outside.status).toBe(403);

    const inside = await as(dean).post(api('/report-schedules'), {
      report: 'discipline',
      frequency: 'weekly',
      filters: { department: [dept.feu] },
    });
    expect(inside.status).toBe(201);

    const noProject = await as(rector).post(api('/report-schedules'), {
      report: 'project',
      frequency: 'weekly',
    });
    expect(noProject.status).toBe(400);
    const yearly = await as(rector).post(api('/report-schedules'), {
      report: 'discipline',
      frequency: 'yearly',
    });
    expect(yearly.status).toBe(400);
  });

  it('lists: an admin sees all, a member their own and received ones; others get 404', async () => {
    const all = (await as(rector).get(api('/report-schedules'))).body.data as {
      id: string;
      created_by: { id: string };
      recipient_ids: string[];
    }[];
    expect(all.some((s) => s.created_by.id === dean.id)).toBe(true);

    const deans = (await as(dean).get(api('/report-schedules'))).body.data as typeof all;
    expect(deans.length).toBeGreaterThan(0);
    expect(
      deans.every((s) => s.created_by.id === dean.id || s.recipient_ids.includes(dean.id)),
    ).toBe(true);
    // The rector's shared report is there, read-only for the dean.
    const received = deans.find((s) => s.created_by.id === rector.id)!;
    expect(received).toMatchObject({ can_edit: false });
    expect(
      (received as unknown as { recipients: { has_telegram: unknown }[] }).recipients[0]!
        .has_telegram,
    ).toBeNull();

    expect((await as(worker).get(api('/report-schedules'))).body.data).toEqual([]);
    expect((await as(worker).get(api(`/report-schedules/${received.id}`))).status).toBe(404);
    expect(
      (await as(dean).patch(api(`/report-schedules/${received.id}`), { time: '09:00' })).status,
    ).toBe(403);
  });
});

// ─── Sending ──────────────────────────────────────────────────────────────────

describe('«Отправить сейчас»', () => {
  let scheduleId: string;
  let runId: string;

  it('sends the document to Telegram and by email, rings in the app, stores the file', async () => {
    const created = await as(rector).post(api('/report-schedules'), {
      name: 'Справка ректору',
      report: 'discipline',
      frequency: 'weekly',
      recipient_ids: [rector.id, dean.id],
    });
    expect(created.status).toBe(201);
    scheduleId = created.body.id;

    const res = await as(rector).post(api(`/report-schedules/${scheduleId}/run`));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    runId = res.body.id;
    const today = localDate(new Date(), TZ);
    expect(res.body).toMatchObject({
      status: 'sent',
      triggered_by_id: rector.id,
      error: null,
      can_download: true,
    });
    expect(res.body.period_to < today).toBe(true);
    expect(res.body.file_name).toBe(
      `Справка об исполнении поручений ${res.body.period_from}—${res.body.period_to}.pdf`,
    );
    expect(res.body.summary).toHaveProperty('discipline');

    // Telegram: the rector's linked chat got the PDF with the figures in the caption.
    const docs = telegramCalls.filter((c) => c.method === 'sendDocument');
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ chat_id: String(TG_RECTOR), file_name: res.body.file_name });
    expect(docs[0]!.size).toBeGreaterThan(1000);
    expect(docs[0]!.caption).toContain('Справка об исполнении поручений');
    expect(docs[0]!.caption).toContain('Просрочено: ');

    // Email: both have addresses, both got the attachment.
    const mails = sendMailMock.mock.calls.map((c) => c[0]);
    expect(mails.map((m) => m.to).sort()).toEqual([emails.rector, emails.dean].sort());
    for (const m of mails) {
      expect(m.attachments?.[0]?.filename).toBe(res.body.file_name);
      expect(String(m.attachments?.[0]?.content.subarray(0, 5))).toBe('%PDF-');
      expect(m.text).toContain('/settings/reports');
    }

    // Deliveries: the dean has no Telegram.
    const byKey = Object.fromEntries(
      (
        res.body.deliveries as {
          user_id: string;
          channel: string;
          status: string;
          error?: string;
        }[]
      ).map((d) => [`${d.user_id === rector.id ? 'rector' : 'dean'}:${d.channel}`, d]),
    );
    expect(byKey['rector:telegram']!.status).toBe('sent');
    expect(byKey['rector:email']!.status).toBe('sent');
    expect(byKey['dean:telegram']).toMatchObject({ status: 'skipped', error: 'NO_TELEGRAM' });
    expect(byKey['dean:email']!.status).toBe('sent');

    // In the app: «Отчёт готов» for both, with what to download.
    for (const who of [rector, dean]) {
      const list = (await as(who).get(api('/notifications?type=report_ready'))).body.data as {
        entity_id: string;
        details: { run_id: string; report: string; name: string; period_to: string } | null;
      }[];
      const n = list.find((x) => x.entity_id === runId)!;
      expect(n.details).toMatchObject({
        run_id: runId,
        report: 'discipline',
        name: 'Справка ректору',
        period_to: res.body.period_to,
      });
    }
  });

  it('the file downloads for a recipient, not for anyone else; both are audited', async () => {
    const link = await as(dean).get(api(`/report-runs/${runId}/download`));
    expect(link.status).toBe(200);
    expect(link.body.file_name).toMatch(/^Справка об исполнении поручений/);
    const file = await request(app.server).get(
      new URL(link.body.url).pathname + new URL(link.body.url).search,
    );
    expect(file.status).toBe(200);
    expect(String((file.body as Buffer).subarray(0, 5))).toBe('%PDF-');

    expect((await as(worker).get(api(`/report-runs/${runId}/download`))).status).toBe(404);

    const audit = (await as(rector).get(api('/audit?limit=100'))).body.data as {
      action: string;
      actor: { id: string } | null;
      target: { type: string; id: string } | null;
      meta: Record<string, unknown>;
    }[];
    expect(
      audit.some(
        (a) => a.action === 'report.sent' && a.target?.id === scheduleId && a.meta.manual === true,
      ),
    ).toBe(true);
    expect(
      audit.some(
        (a) => a.action === 'report.exported' && a.actor?.id === dean.id && a.meta.run_id === runId,
      ),
    ).toBe(true);
    expect(audit.some((a) => a.action === 'report_schedule.created')).toBe(true);
  });

  it('a recipient sees the history with only their own deliveries', async () => {
    const mine = (await as(dean).get(api(`/report-schedules/${scheduleId}/runs`))).body.data as {
      deliveries: { user_id: string }[];
    }[];
    expect(mine).toHaveLength(1);
    expect(mine[0]!.deliveries.every((d) => d.user_id === dean.id)).toBe(true);
    const all = (await as(rector).get(api(`/report-schedules/${scheduleId}/runs`))).body.data;
    expect(all[0].deliveries).toHaveLength(4);
    // Only the author or an admin sends it.
    expect((await as(dean).post(api(`/report-schedules/${scheduleId}/run`))).status).toBe(403);
  });

  it('a failing Telegram is recorded and the sending is partial', async () => {
    telegramFails = true;
    const res = await as(rector).post(api(`/report-schedules/${scheduleId}/run`));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('partial');
    const tg = (res.body.deliveries as { user_id: string; channel: string; status: string }[]).find(
      (d) => d.user_id === rector.id && d.channel === 'telegram',
    )!;
    expect(tg.status).toBe('failed');
    // Email still went out.
    expect(sendMailMock).toHaveBeenCalledTimes(2);
  });

  it('a project report and an Excel реестр', async () => {
    const project = await as(rector).post(api('/report-schedules'), {
      report: 'project',
      frequency: 'monthly',
      filters: { project: [projectId] },
      channels: ['email'],
    });
    expect(project.status).toBe(201);
    const p = await as(rector).post(api(`/report-schedules/${project.body.id}/run`));
    expect(p.body.file_name).toMatch(/^Отчёт по проекту RSA /);
    expect(telegramCalls.filter((c) => c.method === 'sendDocument')).toHaveLength(0);

    const xlsx = await as(dean).post(api('/report-schedules'), {
      report: 'assignments',
      frequency: 'daily',
      channels: ['email'],
    });
    expect(xlsx.status).toBe(201);
    expect(xlsx.body.period).toBe('last_30_days');
    const x = await as(dean).post(api(`/report-schedules/${xlsx.body.id}/run`));
    expect(x.status).toBe(201);
    expect(x.body.file_name).toMatch(/\.xlsx$/);
    const mail = sendMailMock.mock.calls.at(-1)![0];
    expect(mail.to).toBe(emails.dean);
    // XLSX is a ZIP: "PK".
    expect(String(mail.attachments![0]!.content.subarray(0, 2))).toBe('PK');
  });
});

// ─── The scheduler pass ───────────────────────────────────────────────────────

describe('the scheduler pass', () => {
  it('sends a due report once and moves it to its next run', async () => {
    const ws = await app.prisma.workspace.findUniqueOrThrow({ where: { slug: SLUG } });
    const created = await as(dean).post(api('/report-schedules'), {
      report: 'discipline',
      frequency: 'daily',
      time: '07:30',
      channels: ['email'],
    });
    await app.prisma.reportSchedule.update({
      where: { id: created.body.id },
      data: { next_run_at: new Date(Date.now() - 60_000) },
    });
    const first = await runReportSchedules(app.prisma, app.storage, { workspaceId: ws.id });
    expect(first.sent).toBe(1);
    const second = await runReportSchedules(app.prisma, app.storage, { workspaceId: ws.id });
    expect(second.sent).toBe(0);

    const after = await app.prisma.reportSchedule.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(after.next_run_at!.getTime()).toBeGreaterThan(Date.now());
    expect(localDate(after.next_run_at!, TZ) <= addDays(localDate(new Date(), TZ), 1)).toBe(true);
    expect(after.last_run_at).not.toBeNull();
    const runs = await app.prisma.reportRun.findMany({ where: { schedule_id: created.body.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.triggered_by_id).toBeNull();
  });

  it('pauses a shared report whose author is no longer an admin', async () => {
    const ws = await app.prisma.workspace.findUniqueOrThrow({ where: { slug: SLUG } });
    // A second admin shares a report, then is made a member.
    await as(rector).patch(api(`/members/${worker.id}`), { role: 'admin' });
    const shared = await as(worker).post(api('/report-schedules'), {
      report: 'discipline',
      frequency: 'weekly',
      recipient_ids: [worker.id, dean.id],
    });
    expect(shared.status).toBe(201);
    await as(rector).patch(api(`/members/${worker.id}`), { role: 'member' });

    expect(
      (await as(worker).post(api(`/report-schedules/${shared.body.id}/run`))).body.error.code,
    ).toBe('AUTHOR_NOT_ADMIN');
    await app.prisma.reportSchedule.update({
      where: { id: shared.body.id },
      data: { next_run_at: new Date(Date.now() - 60_000) },
    });
    const pass = await runReportSchedules(app.prisma, app.storage, { workspaceId: ws.id });
    expect(pass.paused).toBe(1);
    const paused = (await as(rector).get(api(`/report-schedules/${shared.body.id}`))).body;
    expect(paused).toMatchObject({ is_active: false, last_error: 'AUTHOR_NOT_ADMIN' });
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it(`keeps the latest ${KEEP_RUNS} sendings and deletes the files of older ones`, async () => {
    const created = await as(rector).post(api('/report-schedules'), {
      report: 'discipline',
      frequency: 'weekly',
      channels: ['email'],
    });
    const schedule = await app.prisma.reportSchedule.findUniqueOrThrow({
      where: { id: created.body.id },
      include: { workspace: true },
    });
    for (let i = 0; i <= KEEP_RUNS; i += 1) {
      await runSchedule(app.prisma, app.storage, schedule, {
        now: new Date(Date.now() - (KEEP_RUNS - i) * DAY),
      });
    }
    const runs = await app.prisma.reportRun.findMany({
      where: { schedule_id: schedule.id },
      orderBy: { created_at: 'asc' },
    });
    expect(runs).toHaveLength(KEEP_RUNS);
    // The oldest sending (the first loop turn) is gone.
    expect(runs[0]!.created_at.getTime()).toBeGreaterThan(Date.now() - KEEP_RUNS * DAY);

    // Deleting removes the history.
    expect((await as(rector).delete(api(`/report-schedules/${schedule.id}`))).status).toBe(204);
    expect(await app.prisma.reportRun.count({ where: { schedule_id: schedule.id } })).toBe(0);
  });
});
