// Integration tests for Ф5 execution control (docs/roadmap/phase-05):
// acknowledgement, review cycle (explicit + drag-and-drop), the guards against
// closing / re-dating without the controller, deadline-change requests, watchers,
// control filters, deadline reminders + escalation, and control settings.
//
// Runs against a live Postgres. All created rows are removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { runReminders } from '../src/modules/control/reminders.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `ctl-${TS}`;
const DAY = 24 * 60 * 60 * 1000;
const emails = {
  rector: `ctl-rector-${TS}@example.com`,
  dean: `ctl-dean-${TS}@example.com`,
  head: `ctl-head-${TS}@example.com`,
};

type Actor = { id: string; token: string };
let app: FastifyInstance;
let rector: Actor; // owner, controller
let dean: Actor; // assignee
let head: Actor; // head of the dean's department, otherwise uninvolved
let projectId: string;
let states: Record<string, string> = {};

const api = (path: string) => `/api/v1/workspaces/${SLUG}${path}`;
const issueApi = (id: string, path = '') => api(`/projects/${projectId}/issues/${id}${path}`);
const dueIn = (days: number) => new Date(Date.now() + days * DAY).toISOString();

async function register(email: string): Promise<Actor> {
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, display_name: email.split('@')[0] });
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

async function notificationsOf(userId: string, type: string): Promise<number> {
  return app.prisma.notification.count({ where: { recipient_id: userId, type: type as never } });
}

async function createAssignment(extra: object = {}): Promise<{ id: string; sequence_id: number }> {
  const res = await as(rector).post(api(`/projects/${projectId}/issues`), {
    title: 'Отчёт о самообследовании',
    state_id: states.unstarted,
    kind: 'assignment',
    controller_id: rector.id,
    assignee_ids: [dean.id],
    due_date: dueIn(10),
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body;
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  rector = await register(emails.rector);
  dean = await register(emails.dean);
  head = await register(emails.head);

  await as(rector).post('/api/v1/workspaces', {
    name: 'Контроль',
    slug: SLUG,
    timezone: 'Asia/Dushanbe',
  });
  for (const m of [dean, head]) {
    await as(rector).post(api('/members'), { user_id: m.id, role: 'member' });
  }
  const dept = await as(rector).post(api('/departments'), {
    name: 'Экономический факультет',
    head_id: head.id,
  });
  await as(rector).patch(api(`/members/${dean.id}`), {
    department_id: dept.body.id,
    position: 'Декан',
  });

  const project = await as(rector).post(api('/projects'), {
    name: 'Аккредитация',
    identifier: 'ACC',
    member_ids: [dean.id, head.id],
  });
  projectId = project.body.id;
  const st = await as(rector).get(api(`/projects/${projectId}/states`));
  states = Object.fromEntries(st.body.map((s: { group: string; id: string }) => [s.group, s.id]));
});

afterAll(async () => {
  const list = Object.values(emails);
  await app.prisma.workspace.deleteMany({ where: { slug: SLUG } });
  await app.prisma.refreshToken.deleteMany({ where: { user: { email: { in: list } } } });
  await app.prisma.user.deleteMany({ where: { email: { in: list } } });
  await app.close();
});

describe('acknowledgement and guards', () => {
  let issue: { id: string };

  beforeAll(async () => {
    issue = await createAssignment();
  });

  it('only an assignee can acknowledge; the controller is notified', async () => {
    expect((await as(head).post(issueApi(issue.id, '/acknowledge'))).body.error.code).toBe(
      'NOT_ASSIGNEE',
    );
    const before = await notificationsOf(rector.id, 'acknowledged');
    const res = await as(dean).post(issueApi(issue.id, '/acknowledge'));
    expect(res.status).toBe(200);
    expect(res.body.assignees[0].acknowledged_at).toBeTruthy();
    expect(await notificationsOf(rector.id, 'acknowledged')).toBe(before + 1);
  });

  it('the assignee cannot close a reviewed assignment or move its deadline', async () => {
    const close = await as(dean).patch(issueApi(issue.id), { state_id: states.completed });
    expect(close.status).toBe(409);
    expect(close.body.error.code).toBe('REVIEW_REQUIRED');

    const redate = await as(dean).patch(issueApi(issue.id), { due_date: dueIn(30) });
    expect(redate.status).toBe(403);
    expect(redate.body.error.code).toBe('DEADLINE_CHANGE_FORBIDDEN');
  });
});

describe('deadline-change requests', () => {
  it('assignee asks, controller approves → deadline moves and counts as a change', async () => {
    const issue = await createAssignment();
    const newDue = dueIn(20);

    const req = await as(dean).post(issueApi(issue.id, '/deadline-requests'), {
      new_due_date: newDue,
      reason: 'Ждём данные от бухгалтерии',
    });
    expect(req.status).toBe(201);
    const again = await as(dean).post(issueApi(issue.id, '/deadline-requests'), {
      new_due_date: newDue,
      reason: 'Ещё раз',
    });
    expect(again.body.error.code).toBe('DEADLINE_REQUEST_PENDING');

    expect(
      (await as(head).post(issueApi(issue.id, `/deadline-requests/${req.body.id}/approve`))).status,
    ).toBe(403);
    const approved = await as(rector).post(
      issueApi(issue.id, `/deadline-requests/${req.body.id}/approve`),
      {
        comment: 'Согласовано',
      },
    );
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');

    const after = await as(rector).get(issueApi(issue.id));
    expect(new Date(after.body.due_date).toISOString()).toBe(newDue);
    expect(after.body._count.deadline_requests).toBe(1);
    expect(await notificationsOf(dean.id, 'deadline_change_decided')).toBeGreaterThan(0);
  });
});

describe('review cycle', () => {
  let issue: { id: string };

  beforeAll(async () => {
    issue = await createAssignment();
  });

  it('hand-in → "На проверке", controller notified, no double hand-in', async () => {
    const before = await notificationsOf(rector.id, 'review_requested');
    const res = await as(dean).post(issueApi(issue.id, '/review/submit'), {
      report: 'Отчёт готов, см. вложение',
    });
    expect(res.status).toBe(200);
    expect(res.body.state.group).toBe('review');
    expect(await notificationsOf(rector.id, 'review_requested')).toBe(before + 1);

    const twice = await as(dean).post(issueApi(issue.id, '/review/submit'), { report: 'ещё' });
    expect(twice.body.error.code).toBe('REVIEW_PENDING');
  });

  it('return needs a comment; it lands in the discussion and the assignee is notified', async () => {
    expect((await as(rector).post(issueApi(issue.id, '/review/return'), {})).status).toBe(400);
    expect(
      (await as(dean).post(issueApi(issue.id, '/review/return'), { comment: 'x' })).body.error.code,
    ).toBe('NOT_REVIEWER');

    const res = await as(rector).post(issueApi(issue.id, '/review/return'), {
      comment: 'Добавьте таблицу по кафедрам',
    });
    expect(res.status).toBe(200);
    expect(res.body.state.group).toBe('started');
    const comments = await as(rector).get(issueApi(issue.id, '/comments'));
    expect(comments.body.some((c: { body: string }) => c.body.includes('Добавьте таблицу'))).toBe(
      true,
    );
    expect(await notificationsOf(dean.id, 'review_returned')).toBeGreaterThan(0);
  });

  it('dragging to "На проверке" opens a hand-in; approving closes the work', async () => {
    const drag = await as(dean).patch(issueApi(issue.id), { state_id: states.review });
    expect(drag.status).toBe(200);
    const reviews = await as(rector).get(issueApi(issue.id, '/reviews'));
    expect(reviews.body).toHaveLength(2);
    expect(reviews.body[0].decision).toBe('pending');
    expect(reviews.body[1].decision).toBe('returned');

    const ok = await as(rector).post(issueApi(issue.id, '/review/approve'), {});
    expect(ok.status).toBe(200);
    expect(ok.body.state.group).toBe('completed');
    expect(ok.body.completed_at).toBeTruthy();
  });
});

describe('watchers and control filters', () => {
  it('author, assignees and controller watch automatically; anyone can follow', async () => {
    const issue = await createAssignment();
    const initial = await as(head).get(issueApi(issue.id, '/watchers'));
    const ids = initial.body.map((w: { user_id: string }) => w.user_id);
    expect(ids).toEqual(expect.arrayContaining([rector.id, dean.id]));
    expect(ids).not.toContain(head.id);

    await as(head).post(issueApi(issue.id, '/watchers'));
    const mine = await as(head).get(api(`/projects/${projectId}/issues?watcher=me`));
    expect(mine.body.data.map((i: { id: string }) => i.id)).toContain(issue.id);

    await as(head).delete(issueApi(issue.id, '/watchers/me'));
    const after = await as(head).get(api(`/projects/${projectId}/issues?watcher=me`));
    expect(after.body.data.map((i: { id: string }) => i.id)).not.toContain(issue.id);
  });

  it('overdue / due_within / acknowledged / controller=me', async () => {
    const overdue = await createAssignment({ due_date: dueIn(-2), title: 'Просроченное' });
    const soon = await createAssignment({ due_date: dueIn(1), title: 'Скоро срок' });

    const od = await as(rector).get(api(`/projects/${projectId}/issues?overdue=true`));
    const odIds = od.body.data.map((i: { id: string }) => i.id);
    expect(odIds).toContain(overdue.id);
    expect(odIds).not.toContain(soon.id);

    const within = await as(rector).get(api(`/projects/${projectId}/issues?due_within=2`));
    expect(within.body.data.map((i: { id: string }) => i.id)).toContain(soon.id);

    const unack = await as(dean).get(api(`/projects/${projectId}/issues?acknowledged=false`));
    expect(unack.body.data.map((i: { id: string }) => i.id)).toEqual(
      expect.arrayContaining([overdue.id, soon.id]),
    );

    const controlled = await as(rector).get(
      api(`/projects/${projectId}/issues?controller=me&open=true`),
    );
    expect(controlled.body.data.length).toBeGreaterThanOrEqual(2);
  });

  it('list filters accept a single value as well as repeated ones (state, priority, assignee, label)', async () => {
    const issue = await createAssignment({ priority: 'high', title: 'Высокий приоритет' });
    const single = await as(rector).get(api(`/projects/${projectId}/issues?priority=high`));
    expect(single.status).toBe(200);
    expect(single.body.data.map((i: { id: string }) => i.id)).toContain(issue.id);

    const repeated = await as(rector).get(
      api(`/projects/${projectId}/issues?priority=high&priority=urgent`),
    );
    expect(repeated.status).toBe(200);
    expect(repeated.body.data.map((i: { id: string }) => i.id)).toContain(issue.id);

    const byAssignee = await as(dean).get(api(`/projects/${projectId}/issues?assignee=me`));
    expect(byAssignee.status).toBe(200);
    expect(byAssignee.body.data.map((i: { id: string }) => i.id)).toContain(issue.id);

    const byState = await as(rector).get(
      api(`/projects/${projectId}/issues?state=${states.unstarted}`),
    );
    expect(byState.status).toBe(200);
    expect(byState.body.data.map((i: { id: string }) => i.id)).toContain(issue.id);
  });
});

describe('deadline reminders and escalation', () => {
  it('sends due-soon, overdue and escalation exactly once', async () => {
    const workspace = await app.prisma.workspace.findUniqueOrThrow({ where: { slug: SLUG } });
    const soon = await createAssignment({ due_date: dueIn(1), title: 'Срок завтра' });
    const late = await createAssignment({ due_date: dueIn(-4), title: 'Просрочено 4 дня' });

    const first = await runReminders(app.prisma, { workspaceId: workspace.id, force: true });
    expect(first.sent.due_soon).toBeGreaterThan(0);
    expect(first.sent.overdue).toBeGreaterThan(0);
    expect(first.sent.escalated).toBeGreaterThan(0);

    const logs = await app.prisma.reminderLog.findMany({
      where: { issue_id: { in: [soon.id, late.id] } },
    });
    expect(
      logs.some((l) => l.issue_id === soon.id && l.kind === 'due_soon:1' && l.user_id === dean.id),
    ).toBe(true);
    // Escalation reaches the head of the assignee's department and the controller.
    const esc = logs
      .filter((l) => l.issue_id === late.id && l.kind === 'escalated')
      .map((l) => l.user_id);
    expect(esc).toEqual(expect.arrayContaining([head.id, rector.id]));

    const second = await runReminders(app.prisma, { workspaceId: workspace.id, force: true });
    expect(second.sent).toEqual({ due_soon: 0, overdue: 0, escalated: 0 });
  });

  it('admins can trigger a pass manually', async () => {
    expect((await as(dean).post(api('/control/run-reminders'))).status).toBe(403);
    const res = await as(rector).post(api('/control/run-reminders'), { force: true });
    expect(res.status).toBe(200);
    expect(res.body.workspaces).toBe(1);
  });
});

describe('control settings', () => {
  it('defaults, update, and mandatory report', async () => {
    const defaults = await as(dean).get(api('/control/settings'));
    expect(defaults.body).toEqual({
      reminder_days: [3, 1, 0],
      reminder_hour: 9,
      escalation_days: 3,
      require_report: false,
    });

    expect((await as(dean).patch(api('/control/settings'), { require_report: true })).status).toBe(
      403,
    );
    const updated = await as(rector).patch(api('/control/settings'), {
      require_report: true,
      escalation_days: 5,
    });
    expect(updated.body.require_report).toBe(true);
    expect(updated.body.escalation_days).toBe(5);

    const issue = await createAssignment();
    const noReport = await as(dean).post(issueApi(issue.id, '/review/submit'), {});
    expect(noReport.body.error.code).toBe('REPORT_REQUIRED');
  });
});
