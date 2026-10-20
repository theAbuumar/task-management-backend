// Integration tests for Ф4 (ADR-031): the rules the UI for states, cycles,
// modules, relations, sub-issues and comments relies on.
// - states: every group keeps a state, one default per project, deleting moves
//   issues (trashed ones too) with history, one-request reorder, admin only;
// - cycles and modules: progress in the list, another project's cycle is 404,
//   joining and leaving are recorded, deleting is an admin's call;
// - relations: only to issues the viewer sees, trash and private projects left
//   out of the list, history on both issues, the open-blocker count;
// - sub-issues: single level, a distribution keeps its department parts;
// - comments: one-level threads, «изменено», a deleted head keeps no text,
//   mentions added by an edit are notified;
// - the workspace feed names cycles, modules and related issues.
//
// Runs against a live Postgres; everything is removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `ptools-${TS}`;
const emails = {
  admin: `pt-admin-${TS}@example.com`,
  member: `pt-member-${TS}@example.com`,
  outsider: `pt-outsider-${TS}@example.com`,
  guest: `pt-guest-${TS}@example.com`,
  head: `pt-head-${TS}@example.com`,
};

type Actor = { id: string; token: string };
type State = { id: string; name: string; group: string; order: number; is_default: boolean };

let app: FastifyInstance;
let admin: Actor;
let member: Actor;
let outsider: Actor;
let guest: Actor;
let head: Actor;
let projectId: string;
let privateId: string;

const api = (path: string) => `/api/v1/workspaces/${SLUG}${path}`;
const P = (path: string, project = projectId) => api(`/projects/${project}${path}`);

async function register(email: string): Promise<Actor> {
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, display_name: `Тестов ${email.split('-')[1]}` });
  expect(res.status).toBe(201);
  return { id: res.body.user.id, token: res.body.access_token };
}

function as(actor: Actor) {
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${actor.token}`);
  return {
    get: (url: string) => auth(request(app.server).get(url)),
    post: (url: string, body?: object) => auth(request(app.server).post(url)).send(body ?? {}),
    put: (url: string, body?: object) => auth(request(app.server).put(url)).send(body ?? {}),
    patch: (url: string, body?: object) => auth(request(app.server).patch(url)).send(body ?? {}),
    delete: (url: string, body?: object) =>
      body
        ? auth(request(app.server).delete(url)).send(body)
        : auth(request(app.server).delete(url)),
  };
}

async function states(project = projectId): Promise<State[]> {
  const res = await as(admin).get(P('/states', project));
  expect(res.status).toBe(200);
  return res.body;
}

async function stateOf(group: string, project = projectId): Promise<string> {
  return (await states(project)).find((s) => s.group === group)!.id;
}

async function issue(title: string, extra: object = {}, project = projectId): Promise<string> {
  const res = await as(admin).post(P('/issues', project), {
    title,
    state_id: await stateOf('unstarted', project),
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function history(issueId: string, project = projectId) {
  const res = await as(admin).get(P(`/issues/${issueId}/activity`, project));
  expect(res.status).toBe(200);
  return res.body.data as {
    action: string;
    field: string | null;
    old_value: string | null;
    new_value: string | null;
  }[];
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  admin = await register(emails.admin);
  member = await register(emails.member);
  outsider = await register(emails.outsider);
  guest = await register(emails.guest);
  head = await register(emails.head);
  await as(admin).post('/api/v1/workspaces', { name: 'Университет', slug: SLUG });
  for (const [u, role] of [
    [member, 'member'],
    [outsider, 'member'],
    [guest, 'guest'],
    [head, 'member'],
  ] as const) {
    expect((await as(admin).post(api('/members'), { user_id: u.id, role })).status).toBe(201);
  }
  projectId = (
    await as(admin).post(api('/projects'), { name: 'Учебный процесс', identifier: 'PTU' })
  ).body.id;
  privateId = (
    await as(admin).post(api('/projects'), {
      name: 'Ректорат',
      identifier: 'PTR',
      visibility: 'private',
      member_ids: [member.id],
    })
  ).body.id;
});

afterAll(async () => {
  const ws = await app.prisma.workspace.findUnique({ where: { slug: SLUG } });
  if (ws) await app.prisma.workspace.delete({ where: { id: ws.id } });
  await app.prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
  await app.close();
});

// ─── States (4.F1) ────────────────────────────────────────────────────────────

describe('states', () => {
  it('a project has a review state and accepts new states of every group', async () => {
    const all = await states();
    expect(all.map((s) => s.group)).toEqual([
      'backlog',
      'unstarted',
      'started',
      'review',
      'completed',
      'cancelled',
    ]);
    const res = await as(admin).post(P('/states'), {
      name: 'У проректора',
      color: '#7C3AED',
      group: 'review',
      order: 4,
    });
    expect(res.status).toBe(201);
    expect(res.body.group).toBe('review');
  });

  it('keeps one default per project; the default cannot be unset or deleted', async () => {
    const before = await states();
    const oldDefault = before.find((s) => s.is_default)!;
    const backlog = before.find((s) => s.group === 'backlog')!;

    const unset = await as(admin).patch(P(`/states/${oldDefault.id}`), { is_default: false });
    expect(unset.status).toBe(409);
    expect(unset.body.error.code).toBe('DEFAULT_STATE');

    const del = await as(admin).delete(P(`/states/${oldDefault.id}`));
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('DEFAULT_STATE');

    // Another group's state becomes the default: the old one stops being it.
    expect((await as(admin).patch(P(`/states/${backlog.id}`), { is_default: true })).status).toBe(
      200,
    );
    const after = await states();
    expect(after.filter((s) => s.is_default).map((s) => s.id)).toEqual([backlog.id]);
    // And back, for the tests below.
    await as(admin).patch(P(`/states/${oldDefault.id}`), { is_default: true });
    expect((await states()).filter((s) => s.is_default).map((s) => s.id)).toEqual([oldDefault.id]);
  });

  it('never leaves a group empty — by deleting or by moving the last state', async () => {
    const completed = (await states()).find((s) => s.group === 'completed')!;
    const del = await as(admin).delete(P(`/states/${completed.id}`));
    expect(del.status).toBe(409);
    expect(del.body.error).toMatchObject({
      code: 'LAST_STATE_IN_GROUP',
      details: { group: 'completed' },
    });

    const move = await as(admin).patch(P(`/states/${completed.id}`), { group: 'started' });
    expect(move.status).toBe(409);
    expect(move.body.error.code).toBe('LAST_STATE_IN_GROUP');
  });

  it('deleting moves every issue (trashed ones too) and records it in their history', async () => {
    const extra = await as(admin).post(P('/states'), {
      name: 'Согласование',
      color: '#F59E0B',
      group: 'started',
    });
    const done = await stateOf('completed');
    const a = await issue('Согласовать расписание');
    const b = await issue('Старый черновик');
    for (const id of [a, b]) {
      expect((await as(admin).patch(P(`/issues/${id}`), { state_id: extra.body.id })).status).toBe(
        200,
      );
    }
    expect((await as(admin).delete(P(`/issues/${b}`))).status).toBe(204);

    const res = await as(admin).delete(P(`/states/${extra.body.id}?transfer_to_state_id=${done}`));
    expect(res.status).toBe(204);

    const moved = await app.prisma.issue.findMany({ where: { id: { in: [a, b] } } });
    expect(moved.every((i) => i.state_id === done)).toBe(true);
    // Moving into «completed» marks the work done.
    expect(moved.every((i) => i.completed_at !== null)).toBe(true);
    const entries = (await history(a)).filter((e) => e.field === 'state_id');
    expect(entries[0]).toMatchObject({ old_value: extra.body.id, new_value: done });
  });

  it('reorders the columns in one request; the list must be exact', async () => {
    const before = await states();
    const reversed = [...before].reverse().map((s) => s.id);
    const res = await as(admin).put(P('/states/order'), { state_ids: reversed });
    expect(res.status).toBe(200);
    expect(res.body.map((s: State) => s.id)).toEqual(reversed);
    expect((await states()).map((s) => s.id)).toEqual(reversed);

    const partial = await as(admin).put(P('/states/order'), { state_ids: reversed.slice(1) });
    expect(partial.status).toBe(400);
    const foreign = await as(admin).put(P('/states/order'), {
      state_ids: [...reversed.slice(1), await stateOf('backlog', privateId)],
    });
    expect(foreign.status).toBe(400);
    await as(admin).put(P('/states/order'), { state_ids: before.map((s) => s.id) });
  });

  it('only admins change states', async () => {
    const backlog = await stateOf('backlog');
    expect((await as(member).patch(P(`/states/${backlog}`), { name: 'Идеи' })).status).toBe(403);
    expect((await as(member).put(P('/states/order'), { state_ids: [backlog] })).status).toBe(403);
    expect(
      (await as(guest).post(P('/states'), { name: 'x', color: '#000000', group: 'backlog' }))
        .status,
    ).toBe(403);
  });
});

// ─── Cycles and modules (4.F3, 4.F4) ─────────────────────────────────────────

describe('cycles', () => {
  let cycleId: string;
  let issues: string[];

  it('lists cycles with progress and a status by the dates', async () => {
    const day = 86_400_000;
    const now = Date.now();
    const res = await as(member).post(P('/cycles'), {
      name: 'Осенний семестр',
      start_date: new Date(now - 10 * day).toISOString(),
      end_date: new Date(now + 10 * day).toISOString(),
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'active', progress: { total: 0 } });
    cycleId = res.body.id;
    await as(member).post(P('/cycles'), {
      name: 'Весенний семестр',
      start_date: new Date(now + 60 * day).toISOString(),
    });

    issues = [await issue('Составить расписание'), await issue('Утвердить учебные планы')];
    const added = await as(member).post(P(`/cycles/${cycleId}/issues`), { issue_ids: issues });
    expect(added.body).toEqual({ added: 2 });
    await as(admin).patch(P(`/issues/${issues[0]}`), { state_id: await stateOf('completed') });

    const list = await as(member).get(P('/cycles'));
    expect(list.status).toBe(200);
    expect(list.body.map((c: { name: string }) => c.name)).toEqual([
      'Осенний семестр',
      'Весенний семестр',
    ]);
    expect(list.body[0].progress).toMatchObject({
      total: 2,
      completed: 1,
      completion_percentage: 50,
    });
    expect(list.body[1]).toMatchObject({ status: 'upcoming', progress: { total: 0 } });
  });

  it('records joining and leaving a cycle in the issue history; re-adding is a no-op', async () => {
    expect(
      (await as(member).post(P(`/cycles/${cycleId}/issues`), { issue_ids: issues })).body,
    ).toEqual({
      added: 0,
    });
    expect((await as(member).delete(P(`/cycles/${cycleId}/issues/${issues[1]}`))).status).toBe(204);
    const entries = (await history(issues[1]!)).filter((e) => e.field === 'cycle_id');
    expect(entries.map((e) => [e.old_value, e.new_value])).toEqual([
      [cycleId, null],
      [null, cycleId],
    ]);
    const res = await as(member).get(P(`/issues/${issues[0]}`));
    expect(res.body.cycle_id).toBe(cycleId);
  });

  it('rejects an end before the start; a cycle of another project is 404', async () => {
    const bad = await as(member).post(P('/cycles'), {
      name: 'Наоборот',
      start_date: '2026-11-10T12:00:00.000Z',
      end_date: '2026-11-01T12:00:00.000Z',
    });
    expect(bad.status).toBe(400);

    const secret = await as(admin).post(P('/cycles', privateId), { name: 'Тайный этап' });
    // Addressed through a project the outsider can open, it still does not exist.
    expect((await as(outsider).get(P(`/cycles/${secret.body.id}`))).status).toBe(404);
    expect((await as(outsider).patch(P(`/cycles/${secret.body.id}`), { name: 'x' })).status).toBe(
      404,
    );
  });

  it('only an admin deletes a cycle; its issues stay, out of any cycle', async () => {
    expect((await as(member).delete(P(`/cycles/${cycleId}`))).status).toBe(403);
    expect((await as(guest).post(P('/cycles'), { name: 'x' })).status).toBe(403);
    expect((await as(admin).delete(P(`/cycles/${cycleId}`))).status).toBe(204);
    const left = await app.prisma.issue.findUnique({ where: { id: issues[0] } });
    expect(left?.cycle_id).toBeNull();
    expect((await history(issues[0]!)).find((e) => e.field === 'cycle_id')).toMatchObject({
      old_value: cycleId,
      new_value: null,
    });
  });
});

describe('modules', () => {
  it('lists modules with progress; the lead is any assignable member', async () => {
    const asGuest = await as(member).post(P('/modules'), { name: 'Сайт', lead_id: guest.id });
    expect(asGuest.status).toBe(400);
    expect(asGuest.body.error.code).toBe('GUEST_NOT_ASSIGNABLE');

    // The head is not a member of the project — a public project needs none.
    const res = await as(member).post(P('/modules'), {
      name: 'Приёмная кампания',
      lead_id: head.id,
      status: 'in_progress',
    });
    expect(res.status).toBe(201);
    const moduleId = res.body.id as string;
    const a = await issue('Правила приёма');
    const b = await issue('Реклама направлений');
    expect(
      (await as(member).post(P(`/modules/${moduleId}/issues`), { issue_ids: [a, b] })).body,
    ).toEqual({
      added: 2,
    });
    await as(admin).patch(P(`/issues/${a}`), { state_id: await stateOf('cancelled') });

    const list = await as(member).get(P('/modules'));
    expect(list.body[0]).toMatchObject({
      name: 'Приёмная кампания',
      lead_id: head.id,
      progress: { total: 2, cancelled: 1, completion_percentage: 50 },
    });
    const one = await as(member).get(P(`/issues/${b}`));
    expect(one.body.modules).toEqual([{ module_id: moduleId }]);
    expect((await history(b)).find((e) => e.action === 'issue.module_added')).toMatchObject({
      new_value: moduleId,
    });

    expect((await as(member).delete(P(`/modules/${moduleId}`))).status).toBe(403);
    expect((await as(admin).delete(P(`/modules/${moduleId}`))).status).toBe(204);
    expect((await history(b)).find((e) => e.action === 'issue.module_removed')).toMatchObject({
      old_value: moduleId,
    });
  });
});

// ─── Relations (4.F6) ────────────────────────────────────────────────────────

describe('relations', () => {
  it('links only to issues the viewer sees; lists without trash or hidden projects', async () => {
    const own = await issue('Подготовить приказ');
    const blocker = await issue('Согласовать с юристом');
    const secret = await issue('Кадровое решение', {}, privateId);
    const trashed = await issue('Старая версия');

    // The outsider is not in the private project: as if the issue did not exist.
    const hidden = await as(outsider).post(P(`/issues/${own}/relations`), {
      related_issue_id: secret,
      relation_type: 'relates_to',
    });
    expect(hidden.status).toBe(404);

    // The member is in it: the link is made, across projects.
    const toSecret = await as(member).post(P(`/issues/${own}/relations`), {
      related_issue_id: secret,
      relation_type: 'relates_to',
    });
    expect(toSecret.status).toBe(201);
    expect(toSecret.body.related_issue).toMatchObject({
      id: secret,
      project: { identifier: 'PTR' },
      state: { group: 'unstarted' },
    });

    const blocked = await as(member).post(P(`/issues/${own}/relations`), {
      related_issue_id: blocker,
      relation_type: 'blocked_by',
    });
    expect(blocked.status).toBe(201);
    await as(member).post(P(`/issues/${own}/relations`), {
      related_issue_id: trashed,
      relation_type: 'duplicates',
    });
    await as(admin).delete(P(`/issues/${trashed}`));

    const forOutsider = await as(outsider).get(P(`/issues/${own}/relations`));
    expect(forOutsider.body.relates_to).toEqual([]);
    expect(forOutsider.body.duplicates).toEqual([]);
    expect(
      forOutsider.body.blocked_by.map((l: { related_issue_id: string }) => l.related_issue_id),
    ).toEqual([blocker]);
    const forMember = await as(member).get(P(`/issues/${own}/relations`));
    expect(forMember.body.relates_to).toHaveLength(1);

    // History on both issues, each from its own side.
    expect(
      (await history(own)).find(
        (e) => e.action === 'issue.relation_added' && e.field === 'blocked_by',
      ),
    ).toMatchObject({ new_value: blocker });
    expect((await history(blocker)).find((e) => e.action === 'issue.relation_added')).toMatchObject(
      {
        field: 'blocks',
        new_value: own,
      },
    );
  });

  it('counts open blockers in the issue; a closed blocker no longer blocks', async () => {
    const task = await issue('Издать приказ');
    const first = await issue('Подпись ректора');
    const second = await issue('Виза бухгалтерии');
    for (const b of [first, second]) {
      await as(member).post(P(`/issues/${task}/relations`), {
        related_issue_id: b,
        relation_type: 'blocked_by',
      });
    }
    const count = async () =>
      (await as(member).get(P(`/issues/${task}`))).body._count.outgoing_links;
    expect(await count()).toBe(2);
    await as(admin).patch(P(`/issues/${first}`), { state_id: await stateOf('completed') });
    expect(await count()).toBe(1);
    // The board list carries the same count.
    const list = await as(member).get(P('/issues?limit=100'));
    expect(list.body.data.find((i: { id: string }) => i.id === task)._count.outgoing_links).toBe(1);

    const links = (await as(member).get(P(`/issues/${task}/relations`))).body.blocked_by;
    const toSecond = links.find((l: { related_issue_id: string }) => l.related_issue_id === second);
    expect((await as(member).delete(P(`/issues/${task}/relations/${toSecond.id}`))).status).toBe(
      204,
    );
    expect(await count()).toBe(0);
    expect(
      (await history(second)).find((e) => e.action === 'issue.relation_removed'),
    ).toMatchObject({
      field: 'blocks',
      old_value: task,
    });
  });
});

// ─── Sub-issues (4.F7) ───────────────────────────────────────────────────────

describe('sub-issues', () => {
  it('are one level deep and counted on the parent', async () => {
    const parent = await issue('Подготовка к аккредитации');
    await issue('Собрать отчёты кафедр', { parent_id: parent });
    const child = await issue('Проверить сайт', { parent_id: parent });
    const res = await as(member).get(P(`/issues/${parent}`));
    expect(res.body._count.children).toBe(2);

    // A sub-issue cannot get its own, and a parent cannot become a sub-issue.
    expect(
      (
        await as(admin).post(P('/issues'), {
          title: 'x',
          state_id: await stateOf('unstarted'),
          parent_id: child,
        })
      ).status,
    ).toBe(400);
    const other = await issue('Другая задача');
    expect((await as(admin).patch(P(`/issues/${parent}`), { parent_id: other })).status).toBe(400);
    // Moving a plain sub-issue is fine.
    expect((await as(admin).patch(P(`/issues/${child}`), { parent_id: other })).status).toBe(200);
    expect((await as(member).get(P(`/issues/${parent}`))).body._count.children).toBe(1);
  });

  it('a distribution keeps only its department parts', async () => {
    const dept = await as(admin).post(api('/departments'), {
      name: 'Учебный отдел',
      short_name: 'УО',
      head_id: head.id,
    });
    expect(dept.status).toBe(201);
    const dist = await as(admin).post(P('/issues/distribute'), {
      title: 'Отчёт о самообследовании',
      department_ids: [dept.body.id],
    });
    expect(dist.status).toBe(201);
    const parentId = dist.body.id as string;
    const partId = (await as(admin).get(P(`/issues?parent_id=${parentId}`))).body.data[0]
      .id as string;

    const under = await as(admin).post(P('/issues'), {
      title: 'Лишняя подзадача',
      state_id: await stateOf('unstarted'),
      parent_id: parentId,
    });
    expect(under.status).toBe(400);
    expect(under.body.error.code).toBe('DISTRIBUTION_CHILD');

    const plain = await issue('Обычная задача');
    const moveIn = await as(admin).patch(P(`/issues/${plain}`), { parent_id: parentId });
    expect(moveIn.body.error.code).toBe('DISTRIBUTION_CHILD');
    const moveOut = await as(admin).patch(P(`/issues/${partId}`), { parent_id: null });
    expect(moveOut.status).toBe(400);
    expect(moveOut.body.error.code).toBe('DISTRIBUTION_CHILD');
  });
});

// ─── Comments (4.F8) ─────────────────────────────────────────────────────────

describe('comments', () => {
  let issueId: string;
  const C = (path = '') => P(`/issues/${issueId}/comments${path}`);
  const handle = (email: string) => email.split('@')[0];

  beforeAll(async () => {
    issueId = await issue('Обсудить расписание');
  });

  it('a reply to a reply joins the same thread; a deleted comment cannot be answered', async () => {
    const head1 = await as(member).post(C('/'), { body: 'Предлагаю перенести пары' });
    const reply = await as(admin).post(C('/'), {
      body: 'Согласен',
      parent_comment_id: head1.body.id,
    });
    expect(reply.body.parent_comment_id).toBe(head1.body.id);
    const deeper = await as(member).post(C('/'), {
      body: 'Тогда готовлю',
      parent_comment_id: reply.body.id,
    });
    expect(deeper.status).toBe(201);
    expect(deeper.body.parent_comment_id).toBe(head1.body.id);
    expect(deeper.body.author).toHaveProperty('last_name');

    const gone = await as(member).post(C('/'), { body: 'Удалю' });
    await as(member).delete(C(`/${gone.body.id}`));
    const late = await as(admin).post(C('/'), { body: 'Ответ', parent_comment_id: gone.body.id });
    expect(late.status).toBe(400);
  });

  it('a deleted thread head stays without text; a deleted lone comment is not listed', async () => {
    const top = await as(member).post(C('/'), { body: 'Секретный текст' });
    await as(admin).post(C('/'), { body: 'Ответ на секрет', parent_comment_id: top.body.id });
    expect((await as(member).delete(C(`/${top.body.id}`))).status).toBe(204);

    const list = (await as(outsider).get(C('/'))).body as {
      id: string;
      body: string;
      deleted_at: string | null;
    }[];
    const shown = list.find((c) => c.id === top.body.id)!;
    expect(shown.deleted_at).not.toBeNull();
    expect(shown.body).toBe('');
    expect(JSON.stringify(list)).not.toContain('Секретный текст');
    expect(list.some((c) => c.body === 'Удалю')).toBe(false);
  });

  it('an edit sets edited_at and notifies only people it mentions for the first time', async () => {
    const created = await as(member).post(C('/'), {
      body: `Прошу @${handle(emails.head)} проверить`,
    });
    expect(created.body.edited_at).toBeNull();
    const mentions = (userId: string) =>
      app.prisma.notification.count({
        where: { recipient_id: userId, type: 'mentioned', entity_id: created.body.id },
      });
    expect(await mentions(head.id)).toBe(1);

    const edited = await as(member).patch(C(`/${created.body.id}`), {
      body: `Прошу @${handle(emails.head)} и @${handle(emails.outsider)}. проверить`,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.edited_at).not.toBeNull();
    expect(await mentions(head.id)).toBe(1);
    // «@handle.» at the end of a phrase still counts.
    expect(await mentions(outsider.id)).toBe(1);

    // Someone else's comment: a member cannot edit it.
    expect((await as(outsider).patch(C(`/${created.body.id}`), { body: 'x' })).status).toBe(403);
  });
});

// ─── Workspace feed (7.B3) ───────────────────────────────────────────────────

describe('workspace feed', () => {
  it('names cycles, modules and related issues; the structure filter finds them', async () => {
    const cycle = await as(member).post(P('/cycles'), { name: 'Сессия' });
    const mod = await as(member).post(P('/modules'), { name: 'Экзамены' });
    const a = await issue('Расписание экзаменов');
    const b = await issue('Аудитории');
    await as(member).post(P(`/cycles/${cycle.body.id}/issues`), { issue_ids: [a] });
    await as(member).post(P(`/modules/${mod.body.id}/issues`), { issue_ids: [a] });
    await as(member).post(P(`/issues/${a}/relations`), {
      related_issue_id: b,
      relation_type: 'relates_to',
    });

    const res = await as(admin).get(api(`/activity?type=structure&project=${projectId}&limit=100`));
    expect(res.status).toBe(200);
    const rows = res.body.data as {
      action: string;
      field: string | null;
      new_label: string | null;
      issue: { id: string };
    }[];
    const forA = rows.filter((r) => r.issue.id === a);
    expect(forA.find((r) => r.field === 'cycle_id')?.new_label).toBe('Сессия');
    expect(forA.find((r) => r.action === 'issue.module_added')?.new_label).toBe('Экзамены');
    expect(forA.find((r) => r.action === 'issue.relation_added')?.new_label).toMatch(
      /^PTU-\d+ Аудитории$/,
    );
    expect(rows.every((r) => !['issue.created', 'comment.created'].includes(r.action))).toBe(true);
  });
});
