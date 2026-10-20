// Integration tests for drafts of new issues (Ф7 7.B5): a draft is personal,
// its fields are checked as on create, «Опубликовать» makes an issue through the
// same rules (default state, assignees, guests not assignable) and removes the
// draft; at most MAX_DRAFTS are kept per person; a guest has none.
//
// Runs against a live Postgres; everything is removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { MAX_DRAFTS } from '../src/modules/drafts/service.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `drafts-${TS}`;
const emails = {
  rector: `drafts-rector-${TS}@example.com`,
  dean: `drafts-dean-${TS}@example.com`,
  clerk: `drafts-clerk-${TS}@example.com`,
  guest: `drafts-guest-${TS}@example.com`,
};

type Actor = { id: string; token: string };
type Draft = {
  id: string;
  project_id: string | null;
  project: { identifier: string } | null;
  data: Record<string, unknown>;
};

let app: FastifyInstance;
let rector: Actor;
let dean: Actor;
let clerk: Actor;
let guest: Actor;
let projectId: string;
let privateId: string;
let draft: Draft;

const api = (path: string) => `/api/v1/workspaces/${SLUG}${path}`;

async function register(email: string): Promise<Actor> {
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, display_name: `Черновиков ${email.split('-')[1]}` });
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

async function mine(actor: Actor): Promise<Draft[]> {
  const res = await as(actor).get(api('/drafts'));
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
  projectId = (await as(rector).post(api('/projects'), { name: 'Аккредитация', identifier: 'DRF' }))
    .body.id;
  privateId = (
    await as(rector).post(api('/projects'), {
      name: 'Совет',
      identifier: 'DRP',
      visibility: 'private',
    })
  ).body.id;
});

afterAll(async () => {
  const ws = await app.prisma.workspace.findUnique({ where: { slug: SLUG } });
  if (ws) await app.prisma.workspace.delete({ where: { id: ws.id } });
  await app.prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
  await app.close();
});

describe('drafts are personal', () => {
  it('the form is saved as typed, even before a title', async () => {
    const empty = await as(dean).post(api('/drafts'), { project_id: projectId });
    expect(empty.status).toBe(201);
    expect(empty.body.data).toEqual({});

    const res = await as(dean).post(api('/drafts'), {
      project_id: projectId,
      data: { title: 'Подготовить отчёт кафедры', kind: 'assignment', basis: 'Протокол №5' },
    });
    expect(res.status).toBe(201);
    draft = res.body;
    expect(draft.project).toMatchObject({ identifier: 'DRF' });
    // Newest first.
    expect((await mine(dean)).map((d) => d.id)).toEqual([draft.id, empty.body.id]);
  });

  it('nobody else sees, changes or publishes it', async () => {
    expect(await mine(clerk)).toEqual([]);
    expect(await mine(rector)).toEqual([]);
    // One at a time: supertest listens on the app's server for each request.
    const calls = [
      () => as(clerk).get(api(`/drafts/${draft.id}`)),
      () => as(clerk).patch(api(`/drafts/${draft.id}`), { data: { title: 'Моё' } }),
      () => as(clerk).delete(api(`/drafts/${draft.id}`)),
      () => as(rector).post(api(`/drafts/${draft.id}/publish`)),
    ];
    for (const call of calls) {
      expect((await call()).status).toBe(404);
    }
  });

  it('checks the fields as on create, and the project', async () => {
    const bad = [
      { data: { title: 'x'.repeat(501) } },
      { data: { assignee_ids: ['not-a-uuid'] } },
      { data: { kind: 'memo' } },
      { data: { due_date: 'завтра' } },
      { data: { secret: 'unknown field' } },
    ];
    for (const body of bad) {
      expect((await as(dean).post(api('/drafts'), { project_id: projectId, ...body })).status).toBe(
        400,
      );
    }
    expect((await as(dean).post(api('/drafts'), { project_id: privateId })).status).toBe(404);
  });

  it('a guest has no drafts to write', async () => {
    expect((await as(guest).post(api('/drafts'), { project_id: projectId })).status).toBe(403);
  });
});

describe('publishing a draft', () => {
  it('needs a project and a title', async () => {
    const untitled = (await mine(dean)).find((d) => !d.data.title)!;
    const res = await as(dean).post(api(`/drafts/${untitled.id}/publish`));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DRAFT_INCOMPLETE');
    await as(dean).delete(api(`/drafts/${untitled.id}`));
  });

  it('follows the rules of creating an issue: a guest is not assignable, the draft stays', async () => {
    await as(dean).patch(api(`/drafts/${draft.id}`), {
      data: { title: 'Подготовить отчёт кафедры', kind: 'assignment', assignee_ids: [guest.id] },
    });
    const res = await as(dean).post(api(`/drafts/${draft.id}/publish`));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('GUEST_NOT_ASSIGNABLE');
    expect((await as(dean).get(api(`/drafts/${draft.id}`))).status).toBe(200);
  });

  it('becomes an issue in the default state and is removed', async () => {
    const due = '2026-11-30T12:00:00.000Z';
    const patched = await as(dean).patch(api(`/drafts/${draft.id}`), {
      data: {
        title: '  Подготовить отчёт кафедры  ',
        kind: 'assignment',
        basis: 'Протокол №5',
        assignee_ids: [clerk.id],
        controller_id: dean.id,
        due_date: due,
      },
    });
    expect(patched.status).toBe(200);

    const res = await as(dean).post(api(`/drafts/${draft.id}/publish`));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      title: 'Подготовить отчёт кафедры',
      kind: 'assignment',
      basis: 'Протокол №5',
      controller_id: dean.id,
      created_by_id: dean.id,
      due_date: due,
    });
    expect(res.body.assignees.map((a: { user_id: string }) => a.user_id)).toEqual([clerk.id]);
    const states = await as(dean).get(api(`/projects/${projectId}/states`));
    const fallback = states.body.find((s: { is_default: boolean }) => s.is_default);
    expect(res.body.state_id).toBe(fallback.id);

    expect((await as(dean).get(api(`/drafts/${draft.id}`))).status).toBe(404);
    expect(await mine(dean)).toEqual([]);
  });
});

describe('keeping drafts tidy', () => {
  it(`keeps at most ${MAX_DRAFTS}: the oldest goes`, async () => {
    const first = (await as(clerk).post(api('/drafts'), { data: { title: 'Самый старый' } })).body
      .id as string;
    for (let i = 1; i < MAX_DRAFTS; i++) {
      await as(clerk).post(api('/drafts'), { data: { title: `Черновик ${i}` } });
    }
    expect((await mine(clerk)).length).toBe(MAX_DRAFTS);
    await as(clerk).post(api('/drafts'), { data: { title: 'Самый новый' } });
    const list = await mine(clerk);
    expect(list.length).toBe(MAX_DRAFTS);
    expect(list.some((d) => d.id === first)).toBe(false);
    expect(list[0]!.data.title).toBe('Самый новый');
  });

  it('a draft of a trashed project is hidden with it', async () => {
    const extra = (
      await as(rector).post(api('/projects'), { name: 'Временный', identifier: 'DRT' })
    ).body.id;
    const created = (await as(rector).post(api('/drafts'), { project_id: extra })).body as Draft;
    expect((await mine(rector)).some((d) => d.id === created.id)).toBe(true);
    expect((await as(rector).delete(api(`/projects/${extra}`))).status).toBe(204);
    expect((await mine(rector)).some((d) => d.id === created.id)).toBe(false);
  });
});
