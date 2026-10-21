// Burndown and burnup of cycles and modules (Ф10 10.B7, ADR-032).
// - computeBurndown (no database): the scope and done of every day are rebuilt
//   from joining/leaving and state changes — an issue that joined midway, was
//   closed, reopened and left; the ideal line; days after today; no dates; the
//   one-year cap;
// - the endpoints: a cycle's and a module's chart from real history (events
//   moved back in time), trash left out, another project's cycle is 404, a guest
//   reads, an outsider does not.
//
// The endpoints run against a live Postgres; everything is removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { StateGroup } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { computeBurndown, type IssueHistory } from '../src/lib/burndown.js';
import { addDays, localDate, startOfLocalDay } from '../src/lib/tz.js';

const TZ = 'Asia/Tashkent'; // UTC+5, no DST

/** Noon of a local date in Tashkent. */
const noon = (date: string) => new Date(`${date}T07:00:00Z`);
const midnight = (date: string) => startOfLocalDay(date, TZ);

const groups = new Map<string, StateGroup>([
  ['todo', 'unstarted'],
  ['doing', 'started'],
  ['done', 'completed'],
  ['dropped', 'cancelled'],
]);

function history(over: Partial<IssueHistory> = {}): IssueHistory {
  return {
    created_at: noon('2026-10-01'),
    member: true,
    state_id: 'todo',
    membership: [],
    states: [],
    ...over,
  };
}

function chart(issues: IssueHistory[], over: Partial<Parameters<typeof computeBurndown>[0]> = {}) {
  return computeBurndown({
    kind: 'cycle',
    id: 'c1',
    name: 'Самообследование',
    start: midnight('2026-10-05'),
    end: midnight('2026-10-14'),
    createdAt: noon('2026-10-01'),
    issues,
    groupOf: groups,
    timeZone: TZ,
    now: noon('2026-10-10'),
    ...over,
  });
}

const day = (c: ReturnType<typeof chart>, date: string) => c.days.find((d) => d.date === date)!;

describe('computeBurndown', () => {
  it('rebuilds every day from joining, leaving and state changes', () => {
    const c = chart([
      // In the cycle from the start, done on the 7th.
      history({
        state_id: 'done',
        states: [{ at: noon('2026-10-07'), from: 'todo', to: 'done' }],
      }),
      // Joined on the 6th, done on the 8th, reopened on the 9th.
      history({
        state_id: 'doing',
        membership: [{ at: noon('2026-10-06'), joined: true }],
        states: [
          { at: noon('2026-10-08'), from: 'todo', to: 'done' },
          { at: noon('2026-10-09'), from: 'done', to: 'doing' },
        ],
      }),
      // In the cycle until it left on the 8th.
      history({ member: false, membership: [{ at: noon('2026-10-08'), joined: false }] }),
      // Created on the 9th (made inside the cycle).
      history({ created_at: noon('2026-10-09') }),
      // Cancelled on the 6th: done as well.
      history({
        state_id: 'dropped',
        states: [{ at: noon('2026-10-06'), from: 'todo', to: 'dropped' }],
      }),
    ]);
    expect(c.from).toBe('2026-10-05');
    expect(c.to).toBe('2026-10-14');
    expect(c.days).toHaveLength(10);

    expect(day(c, '2026-10-05')).toMatchObject({ scope: 3, done: 0, remaining: 3 });
    expect(day(c, '2026-10-06')).toMatchObject({ scope: 4, done: 1, remaining: 3 });
    expect(day(c, '2026-10-07')).toMatchObject({ scope: 4, done: 2, remaining: 2 });
    // The third issue left, the second was done.
    expect(day(c, '2026-10-08')).toMatchObject({ scope: 3, done: 3, remaining: 0 });
    // Reopened, and a new issue in the cycle.
    expect(day(c, '2026-10-09')).toMatchObject({ scope: 4, done: 2, remaining: 2 });
    expect(day(c, '2026-10-10')).toMatchObject({ scope: 4, done: 2, remaining: 2 });
    expect(c.current).toEqual({ scope: 4, done: 2, remaining: 2, completion_percentage: 50 });
  });

  it('draws the ideal line from the first day to zero and leaves the future empty', () => {
    const c = chart([history(), history(), history()]);
    expect(c.has_ideal).toBe(true);
    expect(c.days[0]!.ideal).toBe(3);
    expect(c.days.at(-1)!.ideal).toBe(0);
    // 3 → 0 over 9 steps.
    expect(day(c, '2026-10-08')!.ideal).toBe(2);
    expect(day(c, '2026-10-11')).toEqual({
      date: '2026-10-11',
      scope: null,
      done: null,
      remaining: null,
      ideal: 1,
    });
  });

  it('counts a day to its local midnight, not to UTC', () => {
    // Done at 23:30 on the 6th in Tashkent (18:30 UTC): the 6th already counts it.
    const c = chart([
      history({
        state_id: 'done',
        states: [{ at: new Date('2026-10-06T18:30:00Z'), from: 'todo', to: 'done' }],
      }),
    ]);
    expect(day(c, '2026-10-05')!.done).toBe(0);
    expect(day(c, '2026-10-06')!.done).toBe(1);
  });

  it('without dates spans the creation to today, without an ideal line', () => {
    const c = chart([history()], { start: null, end: null, createdAt: noon('2026-10-08') });
    expect(c.from).toBe('2026-10-08');
    expect(c.to).toBe('2026-10-10');
    expect(c.has_ideal).toBe(false);
    expect(c.days.every((d) => d.ideal === null)).toBe(true);
  });

  it('an upcoming cycle has only future days and starts the ideal line from today’s scope', () => {
    const c = chart([history(), history()], {
      start: midnight('2026-10-20'),
      end: midnight('2026-10-24'),
    });
    expect(c.days.every((d) => d.scope === null)).toBe(true);
    expect(c.days[0]!.ideal).toBe(2);
    expect(c.current.scope).toBe(2);
  });

  it('a long cycle is cut to its last year', () => {
    const c = chart([history()], { start: midnight('2024-01-01'), end: midnight('2026-12-31') });
    expect(c.days).toHaveLength(366);
    expect(c.to).toBe('2026-12-31');
    expect(c.from).toBe(addDays('2026-12-31', -365));
  });
});

// ─── Endpoints ────────────────────────────────────────────────────────────────

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `burn-${TS}`;
const emails = {
  admin: `bd-admin-${TS}@example.com`,
  guest: `bd-guest-${TS}@example.com`,
  outsider: `bd-outsider-${TS}@example.com`,
};

type Actor = { id: string; token: string };

let app: FastifyInstance;
let admin: Actor;
let guest: Actor;
let outsider: Actor;
let projectId: string;
let otherProjectId: string;
let stateIds: Record<string, string>;

const api = (path: string) => `/api/v1/workspaces/${SLUG}${path}`;
const P = (path: string, project = projectId) => api(`/projects/${project}${path}`);

async function register(email: string): Promise<Actor> {
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, display_name: `Тестов ${email.split('-')[1]}` });
  expect(res.status).toBe(201);
  return { id: res.body.user.id, token: res.body.access_token };
}

const as = (actor: Actor) => ({
  get: (url: string) => request(app.server).get(url).set('Authorization', `Bearer ${actor.token}`),
  post: (url: string, body?: object) =>
    request(app.server)
      .post(url)
      .set('Authorization', `Bearer ${actor.token}`)
      .send(body ?? {}),
  patch: (url: string, body?: object) =>
    request(app.server)
      .patch(url)
      .set('Authorization', `Bearer ${actor.token}`)
      .send(body ?? {}),
  delete: (url: string) =>
    request(app.server).delete(url).set('Authorization', `Bearer ${actor.token}`),
});

async function issue(title: string): Promise<string> {
  const res = await as(admin).post(P('/issues'), { title, state_id: stateIds.unstarted });
  expect(res.status).toBe(201);
  return res.body.id;
}

/**
 * Move the issue's history rows `days` back — all of them together with the
 * issue's creation, or only the changes of one field.
 */
async function backdate(issueId: string, days: number, field?: string) {
  const ms = days * 86_400_000;
  const rows = await app.prisma.activityLog.findMany({
    where: { issue_id: issueId, ...(field && { field }) },
  });
  for (const r of rows) {
    await app.prisma.activityLog.update({
      where: { id: r.id },
      data: { created_at: new Date(r.created_at.getTime() - ms) },
    });
  }
  if (!field) {
    const issue = await app.prisma.issue.findUniqueOrThrow({ where: { id: issueId } });
    await app.prisma.issue.update({
      where: { id: issueId },
      data: { created_at: new Date(issue.created_at.getTime() - ms) },
    });
  }
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  admin = await register(emails.admin);
  guest = await register(emails.guest);
  outsider = await register(emails.outsider);
  await as(admin).post('/api/v1/workspaces', { name: 'Университет', slug: SLUG });
  expect((await as(admin).post(api('/members'), { user_id: guest.id, role: 'guest' })).status).toBe(
    201,
  );
  projectId = (await as(admin).post(api('/projects'), { name: 'Аккредитация', identifier: 'BDA' }))
    .body.id;
  otherProjectId = (await as(admin).post(api('/projects'), { name: 'Сайт', identifier: 'BDS' }))
    .body.id;
  const states = (await as(admin).get(P('/states'))).body as { id: string; group: string }[];
  stateIds = Object.fromEntries(states.map((s) => [s.group, s.id]));
});

afterAll(async () => {
  const ws = await app.prisma.workspace.findUnique({ where: { slug: SLUG } });
  if (ws) await app.prisma.workspace.delete({ where: { id: ws.id } });
  await app.prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
  await app.close();
});

describe('GET P/cycles/:id/burndown', () => {
  it('builds the chart from the history of the cycle’s issues', async () => {
    const ws = await app.prisma.workspace.findUniqueOrThrow({ where: { slug: SLUG } });
    const today = localDate(new Date(), ws.timezone);
    const start = startOfLocalDay(addDays(today, -3), ws.timezone).toISOString();
    const end = startOfLocalDay(addDays(today, 4), ws.timezone).toISOString();
    const cycle = (
      await as(admin).post(P('/cycles'), {
        name: 'Самообследование',
        start_date: start,
        end_date: end,
      })
    ).body;

    const [a, b, c, trashed] = await Promise.all([
      issue('Отчёт кафедры'),
      issue('Анкеты студентов'),
      issue('Перечень программ'),
      issue('Черновик'),
    ]);
    expect(
      (await as(admin).post(P(`/cycles/${cycle.id}/issues`), { issue_ids: [a, b, c, trashed] }))
        .status,
    ).toBe(200);
    // Everything joined 3 days ago; «Отчёт кафедры» was done 2 days ago.
    for (const id of [a, b, c, trashed]) await backdate(id, 3);
    expect(
      (await as(admin).patch(P(`/issues/${a}`), { state_id: stateIds.completed })).status,
    ).toBe(200);
    await backdate(a, 2, 'state_id');
    // «Перечень программ» left the cycle yesterday.
    expect((await as(admin).delete(P(`/cycles/${cycle.id}/issues/${c}`))).status).toBe(204);
    const leave = await app.prisma.activityLog.findFirstOrThrow({
      where: { issue_id: c, field: 'cycle_id', new_value: null },
    });
    await app.prisma.activityLog.update({
      where: { id: leave.id },
      data: { created_at: new Date(leave.created_at.getTime() - 86_400_000) },
    });
    // The trashed one is left out of every day.
    expect((await as(admin).delete(P(`/issues/${trashed}`))).status).toBe(204);

    const res = await as(admin).get(P(`/cycles/${cycle.id}/burndown`));
    expect(res.status).toBe(200);
    const body = res.body as ReturnType<typeof chart>;
    expect(body.kind).toBe('cycle');
    expect(body.from).toBe(addDays(today, -3));
    expect(body.to).toBe(addDays(today, 4));
    expect(body.has_ideal).toBe(true);
    expect(body.days).toHaveLength(8);

    const at = (offset: number) => body.days.find((d) => d.date === addDays(today, offset))!;
    expect(at(-3)).toMatchObject({ scope: 3, remaining: 3, ideal: 3 });
    expect(at(-2)).toMatchObject({ scope: 3, done: 1, remaining: 2 });
    expect(at(-1)).toMatchObject({ scope: 2, done: 1, remaining: 1 });
    expect(at(0)).toMatchObject({ scope: 2, done: 1, remaining: 1 });
    expect(at(1)).toMatchObject({ scope: null, done: null, remaining: null });
    expect(at(4).ideal).toBe(0);
    expect(body.current).toEqual({ scope: 2, done: 1, remaining: 1, completion_percentage: 50 });
  });

  it('a cycle of another project is 404; a guest reads, an outsider does not', async () => {
    const cycle = (await as(admin).post(P('/cycles'), { name: 'Весна' })).body;
    expect((await as(admin).get(P(`/cycles/${cycle.id}/burndown`, otherProjectId))).status).toBe(
      404,
    );
    const read = await as(guest).get(P(`/cycles/${cycle.id}/burndown`));
    expect(read.status).toBe(200);
    // No dates: from its creation to today, no ideal line.
    expect(read.body.has_ideal).toBe(false);
    expect(read.body.from).toBe(read.body.today);
    expect((await as(outsider).get(P(`/cycles/${cycle.id}/burndown`))).status).toBe(403);
  });
});

describe('GET P/modules/:id/burndown', () => {
  it('counts the module’s issues from joining to leaving', async () => {
    const ws = await app.prisma.workspace.findUniqueOrThrow({ where: { slug: SLUG } });
    const today = localDate(new Date(), ws.timezone);
    const mod = (
      await as(admin).post(P('/modules'), {
        name: 'Визит комиссии',
        start_date: startOfLocalDay(addDays(today, -2), ws.timezone).toISOString(),
        target_date: startOfLocalDay(addDays(today, 2), ws.timezone).toISOString(),
      })
    ).body;
    const [a, b] = await Promise.all([issue('Презентация'), issue('Экскурсия')]);
    expect(
      (await as(admin).post(P(`/modules/${mod.id}/issues`), { issue_ids: [a, b] })).status,
    ).toBe(200);
    for (const id of [a, b]) await backdate(id, 2);
    await app.prisma.moduleIssue.updateMany({
      where: { module_id: mod.id },
      data: { created_at: new Date(Date.now() - 2 * 86_400_000) },
    });
    expect((await as(admin).delete(P(`/modules/${mod.id}/issues/${b}`))).status).toBe(204);
    expect(
      (await as(admin).patch(P(`/issues/${a}`), { state_id: stateIds.cancelled })).status,
    ).toBe(200);

    const res = await as(admin).get(P(`/modules/${mod.id}/burndown`));
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('module');
    const at = (offset: number) =>
      (res.body.days as { date: string }[]).find((d) => d.date === addDays(today, offset));
    expect(at(-2)).toMatchObject({ scope: 2, done: 0, ideal: 2 });
    expect(at(-1)).toMatchObject({ scope: 2, done: 0 });
    // Today: one left, the other was cancelled — done as well.
    expect(at(0)).toMatchObject({ scope: 1, done: 1, remaining: 0 });
    expect(res.body.current.completion_percentage).toBe(100);
  });
});
