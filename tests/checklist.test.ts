// Integration tests for checklists of issues (Ф6 6.B5, ADR-030): items are added,
// ticked, renamed, reordered and removed; the issue keeps «done/total» for lists;
// every change but a reorder is in the history; a new issue may come with its
// checklist; a guest only reads; at most MAX_CHECKLIST_ITEMS per issue.
//
// Runs against a live Postgres; everything is removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { MAX_CHECKLIST_ITEMS } from '../src/modules/checklist/service.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `checklist-${TS}`;
const emails = {
  rector: `checklist-rector-${TS}@example.com`,
  dean: `checklist-dean-${TS}@example.com`,
  guest: `checklist-guest-${TS}@example.com`,
  outsider: `checklist-outsider-${TS}@example.com`,
};

type Actor = { id: string; token: string };
type Item = { id: string; text: string; is_done: boolean; done_by: { id: string } | null };
type Checklist = { data: Item[]; total: number; done: number };

let app: FastifyInstance;
let rector: Actor;
let dean: Actor;
let guest: Actor;
let outsider: Actor;
let projectId: string;
let stateId: string;
let issueId: string;

const api = (path: string) => `/api/v1/workspaces/${SLUG}${path}`;
const list = () => api(`/projects/${projectId}/issues/${issueId}/checklist`);

async function register(email: string): Promise<Actor> {
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, display_name: `Чек-лист ${email.split('-')[1]}` });
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

async function issueCounters(id = issueId): Promise<{ total: number; done: number }> {
  const res = await as(dean).get(api(`/projects/${projectId}/issues/${id}`));
  expect(res.status).toBe(200);
  return { total: res.body.checklist_total, done: res.body.checklist_done };
}

async function history(): Promise<{ action: string; old_value: string; new_value: string }[]> {
  const res = await as(dean).get(api(`/projects/${projectId}/issues/${issueId}/activity`));
  expect(res.status).toBe(200);
  return res.body.data ?? res.body;
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  rector = await register(emails.rector);
  dean = await register(emails.dean);
  guest = await register(emails.guest);
  outsider = await register(emails.outsider);
  await as(rector).post('/api/v1/workspaces', { name: 'Университет', slug: SLUG });
  await as(rector).post(api('/members'), { user_id: dean.id, role: 'member' });
  await as(rector).post(api('/members'), { user_id: guest.id, role: 'guest' });
  projectId = (await as(rector).post(api('/projects'), { name: 'Аккредитация', identifier: 'CHK' }))
    .body.id;
  const states = await as(rector).get(api(`/projects/${projectId}/states`));
  stateId = states.body.find((s: { is_default: boolean }) => s.is_default).id;
  issueId = (
    await as(rector).post(api(`/projects/${projectId}/issues`), {
      title: 'Подготовка к аккредитации',
      state_id: stateId,
    })
  ).body.id;
});

afterAll(async () => {
  const ws = await app.prisma.workspace.findUnique({ where: { slug: SLUG } });
  if (ws) await app.prisma.workspace.delete({ where: { id: ws.id } });
  await app.prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
  await app.close();
});

describe('checklist of an issue', () => {
  let items: Item[];

  it('starts empty and grows at the end', async () => {
    expect((await as(dean).get(list())).body).toMatchObject({ data: [], total: 0, done: 0 });
    for (const text of ['Самообследование', '  Отчёт кафедр  ', 'Сайт факультета']) {
      const res = await as(dean).post(list(), { text });
      expect(res.status).toBe(201);
      items = (res.body as Checklist).data;
    }
    // Spaces around the text are dropped.
    expect(items.map((i) => i.text)).toEqual([
      'Самообследование',
      'Отчёт кафедр',
      'Сайт факультета',
    ]);
    expect(await issueCounters()).toEqual({ total: 3, done: 0 });
  });

  it('a tick keeps who and when, and the issue counts it', async () => {
    const res = await as(dean).patch(`${list()}/${items[0]!.id}`, { is_done: true });
    expect(res.status).toBe(200);
    const body = res.body as Checklist;
    expect(body).toMatchObject({ total: 3, done: 1 });
    expect(body.data[0]).toMatchObject({ is_done: true, done_by: { id: dean.id } });
    expect(await issueCounters()).toEqual({ total: 3, done: 1 });

    const untick = await as(rector).patch(`${list()}/${items[0]!.id}`, { is_done: false });
    expect(untick.body.data[0]).toMatchObject({ is_done: false, done_by: null });
    await as(rector).patch(`${list()}/${items[1]!.id}`, { is_done: true });
    expect(await issueCounters()).toEqual({ total: 3, done: 1 });
  });

  it('the list of issues carries the progress «done/total»', async () => {
    const res = await as(dean).get(api(`/projects/${projectId}/issues`));
    const row = res.body.data.find((i: { id: string }) => i.id === issueId);
    expect(row).toMatchObject({ checklist_total: 3, checklist_done: 1 });
    const ws = await as(dean).get(api('/issues'));
    expect(ws.body.data.find((i: { id: string }) => i.id === issueId)).toMatchObject({
      checklist_total: 3,
      checklist_done: 1,
    });
  });

  it('renames, reorders and removes', async () => {
    const renamed = await as(dean).patch(`${list()}/${items[2]!.id}`, {
      text: 'Сайт факультета: раздел «Сведения»',
    });
    expect(renamed.body.data[2].text).toBe('Сайт факультета: раздел «Сведения»');

    const order = [items[2]!.id, items[0]!.id, items[1]!.id];
    const reordered = await as(dean).patch(`${list()}/reorder`, { item_ids: order });
    expect(reordered.status).toBe(200);
    expect(reordered.body.data.map((i: Item) => i.id)).toEqual(order);

    const removed = await as(dean).delete(`${list()}/${items[0]!.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ total: 2, done: 1 });
    expect(await issueCounters()).toEqual({ total: 2, done: 1 });
  });

  it('every change but a reorder is in the history', async () => {
    const actions = (await history()).map((a) => a.action);
    expect(actions.filter((a) => a === 'issue.checklist_added')).toHaveLength(3);
    expect(actions.filter((a) => a === 'issue.checklist_checked')).toHaveLength(2);
    expect(actions).toContain('issue.checklist_unchecked');
    expect(actions).toContain('issue.checklist_updated');
    expect(actions).toContain('issue.checklist_removed');
    const renamed = (await history()).find((a) => a.action === 'issue.checklist_updated')!;
    expect(renamed).toMatchObject({
      old_value: 'Сайт факультета',
      new_value: 'Сайт факультета: раздел «Сведения»',
    });
  });

  it('checks the input', async () => {
    const left = (await as(dean).get(list())).body.data as Item[];
    expect((await as(dean).post(list(), { text: '   ' })).status).toBe(400);
    expect((await as(dean).post(list(), { text: 'x'.repeat(501) })).status).toBe(400);
    expect((await as(dean).patch(`${list()}/${left[0]!.id}`, {})).status).toBe(400);
    // The order must name every item exactly once.
    for (const item_ids of [[left[0]!.id], [left[0]!.id, left[0]!.id], [left[0]!.id, issueId]]) {
      expect((await as(dean).patch(`${list()}/reorder`, { item_ids })).status).toBe(400);
    }
    // An item of another issue is not found here.
    const other = (
      await as(dean).post(api(`/projects/${projectId}/issues`), {
        title: 'Другая задача',
        state_id: stateId,
        checklist: ['Пункт другой задачи'],
      })
    ).body.id;
    const foreign = (await as(dean).get(api(`/projects/${projectId}/issues/${other}/checklist`)))
      .body.data[0].id;
    expect((await as(dean).patch(`${list()}/${foreign}`, { is_done: true })).status).toBe(404);
  });

  it('a guest reads but does not change it; a stranger does not see it', async () => {
    expect((await as(guest).get(list())).status).toBe(200);
    const item = (await as(guest).get(list())).body.data[0] as Item;
    expect((await as(guest).post(list(), { text: 'Гость' })).status).toBe(403);
    expect((await as(guest).patch(`${list()}/${item.id}`, { is_done: true })).status).toBe(403);
    expect((await as(guest).delete(`${list()}/${item.id}`)).status).toBe(403);
    expect((await as(outsider).get(list())).status).toBe(403);
  });

  it(`holds at most ${MAX_CHECKLIST_ITEMS} items`, async () => {
    const full = (
      await as(dean).post(api(`/projects/${projectId}/issues`), {
        title: 'Длинный список',
        state_id: stateId,
        checklist: Array.from({ length: MAX_CHECKLIST_ITEMS }, (_, n) => `Пункт ${n + 1}`),
      })
    ).body;
    expect(full).toMatchObject({ checklist_total: MAX_CHECKLIST_ITEMS, checklist_done: 0 });
    const res = await as(dean).post(api(`/projects/${projectId}/issues/${full.id}/checklist`), {
      text: 'Ещё один',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CHECKLIST_FULL');
    const tooMany = await as(dean).post(api(`/projects/${projectId}/issues`), {
      title: 'Слишком длинный',
      state_id: stateId,
      checklist: Array.from({ length: MAX_CHECKLIST_ITEMS + 1 }, (_, n) => `Пункт ${n + 1}`),
    });
    expect(tooMany.status).toBe(400);
  });
});

describe('a new issue with its checklist', () => {
  it('creates the items in order', async () => {
    const res = await as(dean).post(api(`/projects/${projectId}/issues`), {
      title: 'Отчёт о посещаемости',
      state_id: stateId,
      checklist: ['Собрать журналы', 'Свести таблицу', 'Подписать у декана'],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ checklist_total: 3, checklist_done: 0 });
    const items = await as(dean).get(api(`/projects/${projectId}/issues/${res.body.id}/checklist`));
    expect(items.body.data.map((i: Item) => i.text)).toEqual([
      'Собрать журналы',
      'Свести таблицу',
      'Подписать у декана',
    ]);
  });

  it('a draft keeps the checklist and publishing creates it', async () => {
    const draft = await as(dean).post(api('/drafts'), {
      project_id: projectId,
      data: { title: 'Из черновика', checklist: ['Первый', 'Второй'] },
    });
    expect(draft.status).toBe(201);
    const issue = await as(dean).post(api(`/drafts/${draft.body.id}/publish`));
    expect(issue.status).toBe(201);
    expect(issue.body).toMatchObject({ checklist_total: 2 });
  });
});
