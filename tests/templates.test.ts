// Integration tests for issue templates (Ф6 6.B3, ADR-030): workspace templates are
// managed by admins and have no labels; project templates by any member who may
// create issues, changed by the author or an admin; templates of a private project
// are seen by its members only; «apply» creates the issue through the regular rules
// with the deadline today + due_in_days and the checklist; a guest only reads.
//
// Runs against a live Postgres; everything is removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `templates-${TS}`;
const TZ = 'Asia/Tashkent';
const emails = {
  rector: `templates-rector-${TS}@example.com`,
  dean: `templates-dean-${TS}@example.com`,
  clerk: `templates-clerk-${TS}@example.com`,
  guest: `templates-guest-${TS}@example.com`,
};

type Actor = { id: string; token: string };
type Template = { id: string; name: string; project_id: string | null; can_edit: boolean };

let app: FastifyInstance;
let rector: Actor;
let dean: Actor;
let clerk: Actor;
let guest: Actor;
let projectId: string;
let otherProjectId: string;
let privateId: string;
let labelId: string;
let wsTemplate: Template;
let projectTemplate: Template;

const api = (path: string) => `/api/v1/workspaces/${SLUG}${path}`;

async function register(email: string): Promise<Actor> {
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, display_name: `Шаблон ${email.split('-')[1]}` });
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

const names = (rows: Template[]) => rows.map((t) => t.name);

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  rector = await register(emails.rector);
  dean = await register(emails.dean);
  clerk = await register(emails.clerk);
  guest = await register(emails.guest);
  await as(rector).post('/api/v1/workspaces', { name: 'Университет', slug: SLUG, timezone: TZ });
  await as(rector).post(api('/members'), { user_id: dean.id, role: 'member' });
  await as(rector).post(api('/members'), { user_id: clerk.id, role: 'member' });
  await as(rector).post(api('/members'), { user_id: guest.id, role: 'guest' });
  projectId = (await as(rector).post(api('/projects'), { name: 'Аккредитация', identifier: 'TPL' }))
    .body.id;
  otherProjectId = (await as(rector).post(api('/projects'), { name: 'Наука', identifier: 'TPO' }))
    .body.id;
  privateId = (
    await as(rector).post(api('/projects'), {
      name: 'Совет',
      identifier: 'TPP',
      visibility: 'private',
    })
  ).body.id;
  labelId = (
    await as(rector).post(api(`/projects/${projectId}/labels`), {
      name: 'Аккредитация',
      color: '#3F76FF',
    })
  ).body.id;
});

afterAll(async () => {
  const ws = await app.prisma.workspace.findUnique({ where: { slug: SLUG } });
  if (ws) await app.prisma.workspace.delete({ where: { id: ws.id } });
  await app.prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
  await app.close();
});

describe('who creates templates', () => {
  it('a workspace template — admins only, and without labels', async () => {
    const data = {
      title: 'Отчёт кафедры к аккредитации',
      kind: 'assignment',
      controller_id: rector.id,
      checklist: ['Самообследование', 'Рабочие программы', 'Кадровая справка'],
    };
    const denied = await as(dean).post(api('/templates'), { name: 'Отчёт кафедры', data });
    expect(denied.status).toBe(403);
    const labelled = await as(rector).post(api('/templates'), {
      name: 'С меткой',
      data: { ...data, label_ids: [labelId] },
    });
    expect(labelled.status).toBe(400);
    const res = await as(rector).post(api('/templates'), {
      name: '  Отчёт кафедры  ',
      data,
      due_in_days: 14,
    });
    expect(res.status).toBe(201);
    wsTemplate = res.body;
    expect(wsTemplate).toMatchObject({ name: 'Отчёт кафедры', project_id: null, can_edit: true });
  });

  it('a project template — any member; labels must be the project’s', async () => {
    const foreign = await as(dean).post(api('/templates'), {
      name: 'Чужая метка',
      project_id: otherProjectId,
      data: { title: 'x', label_ids: [labelId] },
    });
    expect(foreign.status).toBe(400);
    const res = await as(dean).post(api('/templates'), {
      name: 'Проверка сайта',
      project_id: projectId,
      data: { title: 'Проверить раздел «Сведения»', label_ids: [labelId], priority: 'high' },
      due_in_days: 3,
    });
    expect(res.status).toBe(201);
    projectTemplate = res.body;
    expect(projectTemplate).toMatchObject({ project_id: projectId, can_edit: true });
  });

  it('checks the input; a guest creates nothing', async () => {
    const bad = [
      { name: '', data: { title: 'x' } },
      { name: 'x'.repeat(81), data: { title: 'x' } },
      { name: 'Без названия задачи', project_id: projectId, data: {} },
      { name: 'Лишнее', project_id: projectId, data: { title: 'x', state_id: projectId } },
      { name: 'Срок', project_id: projectId, data: { title: 'x' }, due_in_days: -1 },
    ];
    for (const body of bad) {
      expect((await as(dean).post(api('/templates'), body)).status, JSON.stringify(body)).toBe(400);
    }
    const guestRes = await as(guest).post(api('/templates'), {
      name: 'Гость',
      project_id: projectId,
      data: { title: 'x' },
    });
    expect(guestRes.status).toBe(403);
  });
});

describe('who sees and changes them', () => {
  it('lists the workspace ones first; by project — its own and the workspace ones', async () => {
    await as(rector).post(api('/templates'), {
      name: 'Протокол совета',
      project_id: privateId,
      data: { title: 'Протокол' },
    });
    await as(dean).post(api('/templates'), {
      name: 'Научный отчёт',
      project_id: otherProjectId,
      data: { title: 'Отчёт НИР' },
    });
    const all = (await as(dean).get(api('/templates'))).body.data as Template[];
    // The private project's template is not seen by a non-member.
    expect(names(all)).toEqual(['Отчёт кафедры', 'Научный отчёт', 'Проверка сайта']);
    const here = (await as(dean).get(api(`/templates?project_id=${projectId}`))).body
      .data as Template[];
    expect(names(here)).toEqual(['Отчёт кафедры', 'Проверка сайта']);
    expect(names((await as(rector).get(api('/templates'))).body.data)).toContain('Протокол совета');
    expect((await as(dean).get(api(`/templates?project_id=${privateId}`))).status).toBe(404);
    expect((await as(guest).get(api('/templates'))).status).toBe(200);
  });

  it('the author or an admin changes a project template; workspace ones — admins', async () => {
    const seen = (await as(clerk).get(api('/templates'))).body.data as Template[];
    expect(seen.every((t) => !t.can_edit)).toBe(true);
    expect(
      (await as(clerk).patch(api(`/templates/${projectTemplate.id}`), { name: 'Моё' })).status,
    ).toBe(403);
    expect((await as(dean).patch(api(`/templates/${wsTemplate.id}`), { name: 'Моё' })).status).toBe(
      403,
    );
    expect((await as(clerk).delete(api(`/templates/${projectTemplate.id}`))).status).toBe(403);
    const renamed = await as(dean).patch(api(`/templates/${projectTemplate.id}`), {
      name: 'Проверка сайта факультета',
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Проверка сайта факультета');
    const byAdmin = await as(rector).patch(api(`/templates/${projectTemplate.id}`), {
      due_in_days: 5,
    });
    expect(byAdmin.body.due_in_days).toBe(5);
  });
});

describe('creating an issue from a template', () => {
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  const plus = (days: number) => {
    const d = new Date(`${today()}T12:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString();
  };

  it('a workspace template needs the project', async () => {
    const res = await as(dean).post(api(`/templates/${wsTemplate.id}/apply`));
    expect(res.status).toBe(400);
  });

  it('makes the issue with the controller, the checklist and the deadline', async () => {
    const res = await as(dean).post(api(`/templates/${wsTemplate.id}/apply`), {
      project_id: projectId,
      title: 'Отчёт кафедры истории к аккредитации',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      title: 'Отчёт кафедры истории к аккредитации',
      kind: 'assignment',
      controller_id: rector.id,
      requires_review: true,
      created_by_id: dean.id,
      checklist_total: 3,
      due_date: plus(14),
    });
    const items = await as(dean).get(api(`/projects/${projectId}/issues/${res.body.id}/checklist`));
    expect(items.body.data.map((i: { text: string }) => i.text)).toEqual([
      'Самообследование',
      'Рабочие программы',
      'Кадровая справка',
    ]);
  });

  it('a project template goes to its project only, with its labels', async () => {
    const wrong = await as(dean).post(api(`/templates/${projectTemplate.id}/apply`), {
      project_id: otherProjectId,
    });
    expect(wrong.status).toBe(400);
    const res = await as(clerk).post(api(`/templates/${projectTemplate.id}/apply`));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      priority: 'high',
      due_date: plus(5),
      created_by_id: clerk.id,
    });
    expect(res.body.labels.map((l: { label_id: string }) => l.label_id)).toEqual([labelId]);
  });

  it('a guest cannot apply; a deleted template is gone', async () => {
    expect(
      (await as(guest).post(api(`/templates/${wsTemplate.id}/apply`), { project_id: projectId }))
        .status,
    ).toBe(403);
    expect((await as(dean).delete(api(`/templates/${projectTemplate.id}`))).status).toBe(204);
    expect((await as(dean).get(api(`/templates/${projectTemplate.id}`))).status).toBe(404);
  });
});
