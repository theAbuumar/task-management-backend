// Integration tests for recurring issues (Ф6 6.B4, ADR-030): a rule creates one
// issue per run in the workspace zone, through createIssue on behalf of its author;
// «31-го» runs on the last day of February; a pass never creates a run twice, and
// missed runs while the server was off make one issue; «Повторять» in the form
// creates the first issue now; the author or an admin manages a rule; a rule whose
// author lost access pauses, one that failed waits for its next run.
//
// Runs against a live Postgres; everything is removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { runRecurring } from '../src/modules/recurring/service.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `recurring-${TS}`;
const TZ = 'Asia/Tashkent';
const emails = {
  rector: `recurring-rector-${TS}@example.com`,
  dean: `recurring-dean-${TS}@example.com`,
  clerk: `recurring-clerk-${TS}@example.com`,
  guest: `recurring-guest-${TS}@example.com`,
};

type Actor = { id: string; token: string };
type Rule = {
  id: string;
  next_run_at: string | null;
  last_error: string | null;
  is_active: boolean;
  issues_count: number;
  can_edit: boolean;
  created_issue: Record<string, unknown> | null;
};

let app: FastifyInstance;
let workspaceId: string;
let rector: Actor;
let dean: Actor;
let clerk: Actor;
let guest: Actor;
let projectId: string;
let otherProjectId: string;
let labelId: string;
let otherLabelId: string;

const api = (path: string) => `/api/v1/workspaces/${SLUG}${path}`;
const rules = (path = '') => api(`/projects/${projectId}/recurring${path}`);

async function register(email: string): Promise<Actor> {
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, display_name: `Повтор ${email.split('-')[1]}` });
  expect(res.status).toBe(201);
  return { id: res.body.user.id, token: res.body.access_token };
}

function as(actor: Actor) {
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${actor.token}`);
  return {
    get: (url: string) => auth(request(app.server).get(url)),
    post: (url: string, body?: object) => auth(request(app.server).post(url)).send(body ?? {}),
    patch: (url: string, body?: object) => auth(request(app.server).patch(url)).send(body ?? {}),
    delete: (url: string) => auth(request(app.server).delete(url)),
  };
}

async function instances(ruleId: string) {
  return app.prisma.issue.findMany({
    where: { recurring_rule_id: ruleId, deleted_at: null },
    orderBy: { created_at: 'asc' },
    include: { assignees: true, labels: true, state: true },
  });
}

const pass = (now: string) => runRecurring(app.prisma, { now: new Date(now), workspaceId });

/**
 * Passes travel in time, so every rule of the workspace would become due: run
 * with only the rule under test active, then put the others back.
 */
async function isolated<T>(ruleId: string, fn: () => Promise<T>): Promise<T> {
  const others = (
    await app.prisma.recurringRule.findMany({
      where: { workspace_id: workspaceId, is_active: true, id: { not: ruleId } },
      select: { id: true },
    })
  ).map((r) => r.id);
  await app.prisma.recurringRule.updateMany({
    where: { id: { in: others } },
    data: { is_active: false },
  });
  try {
    return await fn();
  } finally {
    await app.prisma.recurringRule.updateMany({
      where: { id: { in: others } },
      data: { is_active: true },
    });
  }
}

const run = (ruleId: string, now: string) => isolated(ruleId, () => pass(now));

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  rector = await register(emails.rector);
  dean = await register(emails.dean);
  clerk = await register(emails.clerk);
  guest = await register(emails.guest);
  const ws = await as(rector).post('/api/v1/workspaces', {
    name: 'Университет',
    slug: SLUG,
    timezone: TZ,
  });
  workspaceId = ws.body.id;
  await as(rector).post(api('/members'), { user_id: dean.id, role: 'member' });
  await as(rector).post(api('/members'), { user_id: clerk.id, role: 'member' });
  await as(rector).post(api('/members'), { user_id: guest.id, role: 'guest' });
  projectId = (
    await as(rector).post(api('/projects'), { name: 'Учебный отдел', identifier: 'REC' })
  ).body.id;
  otherProjectId = (await as(rector).post(api('/projects'), { name: 'Другой', identifier: 'RCO' }))
    .body.id;
  labelId = (
    await as(rector).post(api(`/projects/${projectId}/labels`), { name: 'Отчёт', color: '#3F76FF' })
  ).body.id;
  otherLabelId = (
    await as(rector).post(api(`/projects/${otherProjectId}/labels`), {
      name: 'Чужая',
      color: '#E5484D',
    })
  ).body.id;
});

afterAll(async () => {
  const ws = await app.prisma.workspace.findUnique({ where: { slug: SLUG } });
  if (ws) await app.prisma.workspace.delete({ where: { id: ws.id } });
  await app.prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
  await app.close();
});

describe('a monthly report', () => {
  let rule: Rule;

  it('is created by a member; the next run is the 1st, 09:00 in the workspace zone', async () => {
    const res = await as(dean).post(rules(), {
      frequency: 'monthly',
      by_monthday: 1,
      time: '09:00',
      start_date: '2026-10-20',
      due_in_days: 5,
      data: {
        title: 'Отчёт о посещаемости',
        kind: 'assignment',
        assignee_ids: [clerk.id],
        controller_id: dean.id,
        label_ids: [labelId],
        checklist: ['Собрать журналы', 'Свести таблицу'],
      },
    });
    expect(res.status).toBe(201);
    rule = res.body;
    // 1 November, 09:00 in Tashkent (UTC+5).
    expect(rule.next_run_at).toBe('2026-11-01T04:00:00.000Z');
    expect(rule).toMatchObject({ is_active: true, issues_count: 0, can_edit: true });
    expect(rule.created_issue).toBeNull();
  });

  it('a pass before the run creates nothing; at the run — one issue as the form would', async () => {
    expect(await run(rule.id, '2026-11-01T03:59:00Z')).toEqual({
      created: 0,
      failed: 0,
      paused: 0,
    });
    expect(await run(rule.id, '2026-11-01T04:02:00Z')).toEqual({
      created: 1,
      failed: 0,
      paused: 0,
    });
    const [issue] = await instances(rule.id);
    expect(issue).toMatchObject({
      title: 'Отчёт о посещаемости',
      kind: 'assignment',
      controller_id: dean.id,
      created_by_id: dean.id,
      requires_review: true,
      checklist_total: 2,
    });
    expect(issue!.state.group).not.toBe('completed');
    expect(issue!.assignees.map((a) => a.user_id)).toEqual([clerk.id]);
    expect(issue!.labels.map((l) => l.label_id)).toEqual([labelId]);
    // Due 5 days after the run.
    expect(issue!.due_date?.toISOString()).toBe('2026-11-06T12:00:00.000Z');
    const after = (await as(dean).get(rules(`/${rule.id}`))).body as Rule;
    expect(after.next_run_at).toBe('2026-12-01T04:00:00.000Z');
    expect(after.issues_count).toBe(1);
  });

  it('the same run is never created twice', async () => {
    expect(await run(rule.id, '2026-11-01T04:07:00Z')).toEqual({
      created: 0,
      failed: 0,
      paused: 0,
    });
    // Two passes at once (two API instances): only one claims the run.
    const both = await isolated(rule.id, () =>
      Promise.all([pass('2026-12-01T04:01:00Z'), pass('2026-12-01T04:01:00Z')]),
    );
    expect(both[0].created + both[1].created).toBe(1);
    expect(await instances(rule.id)).toHaveLength(2);
  });

  it('missed runs while the server was off make one issue, and the next run is ahead', async () => {
    // Off from December to the end of March: the January, February and March runs are missed.
    await app.prisma.recurringRule.update({
      where: { id: rule.id },
      data: { next_run_at: new Date('2027-01-01T04:00:00Z') },
    });
    expect(await run(rule.id, '2027-03-20T10:00:00Z')).toEqual({
      created: 1,
      failed: 0,
      paused: 0,
    });
    expect(await instances(rule.id)).toHaveLength(3);
    const after = (await as(dean).get(rules(`/${rule.id}`))).body as Rule;
    expect(after.next_run_at).toBe('2027-04-01T04:00:00.000Z');
  });

  it('a project in the trash makes nothing', async () => {
    await app.prisma.project.update({ where: { id: projectId }, data: { deleted_at: new Date() } });
    expect(await run(rule.id, '2027-04-01T05:00:00Z')).toEqual({
      created: 0,
      failed: 0,
      paused: 0,
    });
    await app.prisma.project.update({ where: { id: projectId }, data: { deleted_at: null } });
  });
});

describe('«31-го» and other schedules', () => {
  it('a monthly rule on the 31st runs on 28 February, then on 31 March', async () => {
    const res = await as(dean).post(rules(), {
      frequency: 'monthly',
      by_monthday: 31,
      start_date: '2027-02-01',
      data: { title: 'Сверка за месяц' },
    });
    expect(res.body.next_run_at).toBe('2027-02-28T04:00:00.000Z');
    expect(await run(res.body.id, '2027-02-28T04:00:00Z')).toMatchObject({ created: 1 });
    const after = (await as(dean).get(rules(`/${res.body.id}`))).body as Rule;
    expect(after.next_run_at).toBe('2027-03-31T04:00:00.000Z');
  });

  it('weekly on Monday and Thursday, until a date', async () => {
    const res = await as(dean).post(rules(), {
      frequency: 'weekly',
      by_weekday: [4, 1],
      time: '08:30',
      start_date: '2026-10-21',
      until: '2026-10-29',
      data: { title: 'Планёрка' },
    });
    expect(res.status).toBe(201);
    expect(res.body.by_weekday).toEqual([1, 4]);
    // Thursday 22 October, 08:30 in Tashkent.
    expect(res.body.next_run_at).toBe('2026-10-22T03:30:00.000Z');
    await run(res.body.id, '2026-10-22T03:31:00Z');
    await run(res.body.id, '2026-10-26T03:31:00Z');
    await run(res.body.id, '2026-10-29T03:31:00Z');
    const after = (await as(dean).get(rules(`/${res.body.id}`))).body as Rule;
    // Three runs, then the end date: no next run.
    expect(after.issues_count).toBe(3);
    expect(after.next_run_at).toBeNull();
  });
});

describe('«Повторять» in the create form', () => {
  it('creates the first issue now; the next run is on a later day', async () => {
    const res = await as(dean).post(rules(), {
      frequency: 'daily',
      time: '23:00',
      due_in_days: 0,
      create_now: true,
      data: { title: 'Дежурство по корпусу', assignee_ids: [clerk.id] },
    });
    expect(res.status).toBe(201);
    const rule = res.body as Rule;
    const issue = rule.created_issue as { id: string; recurring_rule_id: string; due_date: string };
    expect(issue.recurring_rule_id).toBe(rule.id);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
    expect(issue.due_date).toBe(`${today}T12:00:00.000Z`);
    // Today's run is the issue just made: the rule waits for tomorrow 23:00.
    const tomorrow = new Date(`${today}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    expect(rule.next_run_at).toBe(`${tomorrow.toISOString().slice(0, 10)}T18:00:00.000Z`);
    expect(rule.issues_count).toBe(1);
  });

  it('makes both or neither: an invalid assignee creates no rule', async () => {
    const before = (await as(dean).get(rules())).body.data.length;
    const res = await as(dean).post(rules(), {
      frequency: 'daily',
      create_now: true,
      data: { title: 'С гостем', assignee_ids: [guest.id] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('GUEST_NOT_ASSIGNABLE');
    expect((await as(dean).get(rules())).body.data).toHaveLength(before);
  });
});

describe('checks and rights', () => {
  it('checks the schedule and the fields', async () => {
    const bad = [
      { frequency: 'hourly', data: { title: 'x' } },
      { frequency: 'daily', time: '25:00', data: { title: 'x' } },
      { frequency: 'daily', start_date: '2026-02-30', data: { title: 'x' } },
      { frequency: 'daily', start_date: '2026-11-10', until: '2026-11-01', data: { title: 'x' } },
      { frequency: 'monthly', by_monthday: 32, data: { title: 'x' } },
      { frequency: 'daily', data: {} },
      { frequency: 'daily', data: { title: 'x', state_id: projectId } },
      { frequency: 'daily', data: { title: 'x', label_ids: [otherLabelId] } },
      {
        frequency: 'daily',
        data: { title: 'x', assignee_ids: [dean.id], primary_assignee_id: clerk.id },
      },
    ];
    for (const body of bad) {
      expect((await as(dean).post(rules(), body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('everyone who sees the project sees the rules; the author or an admin changes them', async () => {
    const rule = (
      await as(dean).post(rules(), { frequency: 'yearly', data: { title: 'Годовой отчёт' } })
    ).body as Rule;
    const seen = (await as(clerk).get(rules())).body.data as Rule[];
    expect(seen.find((r) => r.id === rule.id)).toMatchObject({ can_edit: false });
    expect((await as(guest).get(rules())).status).toBe(200);

    expect((await as(clerk).patch(rules(`/${rule.id}`), { time: '10:00' })).status).toBe(403);
    expect((await as(clerk).post(rules(`/${rule.id}/run`))).status).toBe(403);
    expect((await as(clerk).delete(rules(`/${rule.id}`))).status).toBe(403);
    expect(
      (await as(guest).post(rules(), { frequency: 'daily', data: { title: 'x' } })).status,
    ).toBe(403);
    // An admin may.
    const changed = await as(rector).patch(rules(`/${rule.id}`), { time: '10:00' });
    expect(changed.status).toBe(200);
    expect(changed.body.time).toBe('10:00');
  });

  it('«Создать сейчас» makes one issue and keeps the schedule', async () => {
    const rule = (
      await as(dean).post(rules(), { frequency: 'quarterly', data: { title: 'Квартальный отчёт' } })
    ).body as Rule;
    const res = await as(dean).post(rules(`/${rule.id}/run`));
    expect(res.status).toBe(201);
    expect(res.body.recurring_rule_id).toBe(rule.id);
    const after = (await as(dean).get(rules(`/${rule.id}`))).body as Rule;
    expect(after.next_run_at).toBe(rule.next_run_at);
    expect(after.issues_count).toBe(1);
  });

  it('pause and resume: a resumed rule does not make up the missed runs', async () => {
    const rule = (
      await as(dean).post(rules(), {
        frequency: 'daily',
        start_date: '2026-01-01',
        data: { title: 'Ежедневная сводка' },
      })
    ).body as Rule;
    await as(dean).patch(rules(`/${rule.id}`), { is_active: false });
    await app.prisma.recurringRule.update({
      where: { id: rule.id },
      data: { next_run_at: new Date('2026-01-01T04:00:00Z') },
    });
    expect((await run(rule.id, '2026-12-01T05:00:00Z')).created).toBe(0);
    const resumed = await as(dean).patch(rules(`/${rule.id}`), { is_active: true });
    expect(new Date(resumed.body.next_run_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('deleting a rule keeps its issues', async () => {
    const rule = (
      await as(dean).post(rules(), {
        frequency: 'daily',
        create_now: true,
        data: { title: 'Удаляемое правило' },
      })
    ).body as Rule & { created_issue: { id: string } };
    expect((await as(dean).delete(rules(`/${rule.id}`))).status).toBe(204);
    const issue = await app.prisma.issue.findUnique({ where: { id: rule.created_issue.id } });
    expect(issue).toMatchObject({ deleted_at: null, recurring_rule_id: null });
    expect((await as(dean).get(rules(`/${rule.id}`))).status).toBe(404);
  });
});

describe('when a run cannot create its issue', () => {
  it('an assignee turned off: the reason is kept, the rule waits for its next run', async () => {
    const rule = (
      await as(dean).post(rules(), {
        frequency: 'monthly',
        by_monthday: 15,
        start_date: '2027-05-01',
        data: { title: 'Отчёт с отключённым', assignee_ids: [clerk.id] },
      })
    ).body as Rule;
    await app.prisma.workspaceMember.update({
      where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: clerk.id } },
      data: { deactivated_at: new Date() },
    });
    expect(await run(rule.id, '2027-05-15T05:00:00Z')).toMatchObject({ created: 0, failed: 1 });
    const after = (await as(dean).get(rules(`/${rule.id}`))).body as Rule;
    expect(after).toMatchObject({ is_active: true, last_error: 'MEMBER_DEACTIVATED' });
    expect(after.next_run_at).toBe('2027-06-15T04:00:00.000Z');
    await app.prisma.workspaceMember.update({
      where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: clerk.id } },
      data: { deactivated_at: null },
    });
  });

  it('the author lost access: the rule is paused with the reason', async () => {
    const rule = (
      await as(clerk).post(rules(), {
        frequency: 'monthly',
        by_monthday: 20,
        start_date: '2027-07-01',
        data: { title: 'Правило сотрудника' },
      })
    ).body as Rule;
    await app.prisma.workspaceMember.update({
      where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: clerk.id } },
      data: { role: 'guest' },
    });
    expect(await run(rule.id, '2027-07-20T05:00:00Z')).toMatchObject({ created: 0, paused: 1 });
    const after = (await as(dean).get(rules(`/${rule.id}`))).body as Rule;
    expect(after).toMatchObject({ is_active: false, last_error: 'GUEST_READ_ONLY' });
    expect(await instances(rule.id)).toHaveLength(0);
  });
});
