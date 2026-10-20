// Integration tests for saved views (Ф7 7.B4, ADR-029): a personal view is its
// author's alone; a shared one is seen by everyone who sees its project and is
// managed by admins and the owner only; views of hidden or trashed projects are
// left out; input is checked; a guest reads but does not save.
//
// Runs against a live Postgres; everything is removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `views-${TS}`;
const emails = {
  rector: `views-rector-${TS}@example.com`,
  dean: `views-dean-${TS}@example.com`,
  clerk: `views-clerk-${TS}@example.com`,
  guest: `views-guest-${TS}@example.com`,
};

type Actor = { id: string; token: string };
type View = {
  id: string;
  name: string;
  project_id: string | null;
  project: { id: string; identifier: string } | null;
  filters: Record<string, string | string[]>;
  display: { view?: string };
  is_shared: boolean;
  owner: { id: string };
  can_edit: boolean;
};

let app: FastifyInstance;
let rector: Actor;
let dean: Actor;
let clerk: Actor;
let guest: Actor;
let publicId: string;
let privateId: string;
let personal: View;
let sharedWs: View;
let sharedPrivate: View;

const api = (path: string) => `/api/v1/workspaces/${SLUG}${path}`;

async function register(email: string): Promise<Actor> {
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, display_name: `Видов ${email.split('-')[1]}` });
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

async function views(actor: Actor, query = ''): Promise<View[]> {
  const res = await as(actor).get(api(`/views${query}`));
  expect(res.status).toBe(200);
  return res.body.data;
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  rector = await register(emails.rector);
  dean = await register(emails.dean);
  clerk = await register(emails.clerk);
  guest = await register(emails.guest);
  await as(rector).post('/api/v1/workspaces', { name: 'Университет', slug: SLUG });
  await as(rector).post(api('/members'), { user_id: dean.id, role: 'member' });
  await as(rector).post(api('/members'), { user_id: clerk.id, role: 'member' });
  await as(rector).post(api('/members'), { user_id: guest.id, role: 'guest' });
  publicId = (await as(rector).post(api('/projects'), { name: 'Аккредитация', identifier: 'VWA' }))
    .body.id;
  privateId = (
    await as(rector).post(api('/projects'), {
      name: 'Совет факультета',
      identifier: 'VWP',
      visibility: 'private',
      member_ids: [dean.id],
    })
  ).body.id;
});

afterAll(async () => {
  const ws = await app.prisma.workspace.findUnique({ where: { slug: SLUG } });
  if (ws) await app.prisma.workspace.delete({ where: { id: ws.id } });
  await app.prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
  await app.close();
});

describe('saving views', () => {
  it('a member saves a personal view of a project', async () => {
    const res = await as(dean).post(api('/views'), {
      name: 'Мои просроченные — календарь',
      project_id: publicId,
      filters: { quick: 'overdue', priority: ['high', 'urgent'] },
      display: { view: 'calendar' },
    });
    expect(res.status).toBe(201);
    personal = res.body;
    expect(personal).toMatchObject({
      is_shared: false,
      can_edit: true,
      project_id: publicId,
      project: { identifier: 'VWA' },
      filters: { quick: 'overdue', priority: ['high', 'urgent'] },
      display: { view: 'calendar' },
      owner: { id: dean.id },
    });
  });

  it('only an admin or the owner shares a view', async () => {
    const denied = await as(dean).post(api('/views'), {
      name: 'Для всех',
      is_shared: true,
    });
    expect(denied.status).toBe(403);

    const ws = await as(rector).post(api('/views'), {
      name: 'Просроченные поручения',
      filters: { kind: 'assignment', overdue: 'true' },
      is_shared: true,
    });
    expect(ws.status).toBe(201);
    sharedWs = ws.body;
    expect(sharedWs.project).toBeNull();

    const priv = await as(rector).post(api('/views'), {
      name: 'Совет: на проверке',
      project_id: privateId,
      filters: { quick: 'review' },
      display: { view: 'list' },
      is_shared: true,
    });
    expect(priv.status).toBe(201);
    sharedPrivate = priv.body;
  });

  it('checks the input: keys, sizes, display and the project', async () => {
    const bad = [
      { name: 'x', filters: { 'Bad-Key': 'v' } },
      {
        name: 'x',
        filters: Object.fromEntries(
          Array.from({ length: 21 }, (_, i) => [`k${'a'.repeat(i)}`, 'v']),
        ),
      },
      { name: 'x', filters: { quick: 'x'.repeat(201) } },
      { name: 'x', display: { view: 'gantt' } },
      { name: 'x', display: { view: 'list', extra: 1 } },
      { name: 'x'.repeat(81) },
      { name: '   ' },
    ];
    for (const body of bad) {
      expect((await as(dean).post(api('/views'), body)).status).toBe(400);
    }
    // A private project the member does not belong to: as if it did not exist.
    const hidden = await as(clerk).post(api('/views'), { name: 'Чужой', project_id: privateId });
    expect(hidden.status).toBe(404);
  });

  it('a guest reads views but does not save them', async () => {
    expect((await as(guest).post(api('/views'), { name: 'Гостевой' })).status).toBe(403);
    expect((await views(guest)).map((v) => v.id)).toEqual([sharedWs.id]);
  });
});

describe('who sees and manages a view', () => {
  it('everyone sees shared views of visible projects; a personal one — only its author', async () => {
    const ids = async (a: Actor, q = '') => new Set((await views(a, q)).map((v) => v.id));
    expect(await ids(dean)).toEqual(new Set([personal.id, sharedWs.id, sharedPrivate.id]));
    expect(await ids(clerk)).toEqual(new Set([sharedWs.id]));
    // Admins see private projects, not other people's personal views.
    expect(await ids(rector)).toEqual(new Set([sharedWs.id, sharedPrivate.id]));

    expect(await ids(dean, `?project=${publicId}`)).toEqual(new Set([personal.id]));
    expect(await ids(dean, '?project=workspace')).toEqual(new Set([sharedWs.id]));
    // Shared first.
    expect((await views(dean))[0]!.is_shared).toBe(true);
  });

  it('can_edit: the author for a personal view, admins for a shared one', async () => {
    const forClerk = await views(clerk);
    expect(forClerk.find((v) => v.id === sharedWs.id)!.can_edit).toBe(false);
    const forRector = await views(rector);
    expect(forRector.find((v) => v.id === sharedWs.id)!.can_edit).toBe(true);
  });

  it('a member cannot change or delete a shared view, or touch another person’s', async () => {
    expect((await as(clerk).patch(api(`/views/${sharedWs.id}`), { name: 'Моё' })).status).toBe(403);
    expect((await as(clerk).delete(api(`/views/${sharedWs.id}`))).status).toBe(403);
    expect((await as(clerk).patch(api(`/views/${personal.id}`), { name: 'Моё' })).status).toBe(404);
    expect((await as(rector).delete(api(`/views/${personal.id}`))).status).toBe(404);
  });

  it('the author renames a personal view; sharing it is an admin’s call', async () => {
    const renamed = await as(dean).patch(api(`/views/${personal.id}`), {
      name: 'Срочное — календарь',
      filters: { quick: 'overdue' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({
      name: 'Срочное — календарь',
      filters: { quick: 'overdue' },
    });
    expect((await as(dean).patch(api(`/views/${personal.id}`), { is_shared: true })).status).toBe(
      403,
    );
    const edited = await as(rector).patch(api(`/views/${sharedWs.id}`), {
      display: { view: 'list' },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.display).toEqual({ view: 'list' });
  });

  it('views of a trashed project disappear with it', async () => {
    const extra = (
      await as(rector).post(api('/projects'), { name: 'Временный', identifier: 'VWT' })
    ).body.id;
    const view = (
      await as(rector).post(api('/views'), {
        name: 'Временный вид',
        project_id: extra,
        is_shared: true,
      })
    ).body as View;
    expect((await views(clerk)).some((v) => v.id === view.id)).toBe(true);
    expect((await as(rector).delete(api(`/projects/${extra}`))).status).toBe(204);
    expect((await views(clerk)).some((v) => v.id === view.id)).toBe(false);
    expect((await as(rector).patch(api(`/views/${view.id}`), { name: 'x' })).status).toBe(404);
  });

  it('the author deletes a personal view, an admin a shared one', async () => {
    expect((await as(dean).delete(api(`/views/${personal.id}`))).status).toBe(204);
    expect((await as(rector).delete(api(`/views/${sharedPrivate.id}`))).status).toBe(204);
    expect((await views(dean)).map((v) => v.id)).toEqual([sharedWs.id]);
  });
});
