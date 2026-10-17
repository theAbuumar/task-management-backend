// Integration tests for the Ф3 university domain (docs/roadmap/phase-03):
// departments (org tree), member department/position, profile ФИО, project fields +
// private visibility + soft delete, assignment fields on issues, avatar/logo uploads.
//
// Runs against a live Postgres. All created rows are removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `uni-${TS}`;
const emails = {
  rector: `uni-rector-${TS}@example.com`,
  dean: `uni-dean-${TS}@example.com`,
  staff: `uni-staff-${TS}@example.com`,
  outsider: `uni-outsider-${TS}@example.com`,
};

type Actor = { id: string; token: string };

let app: FastifyInstance;
let rector: Actor; // workspace owner
let dean: Actor; // member
let staff: Actor; // member
let outsider: Actor; // not in the workspace

const api = (path: string) => `/api/v1/workspaces/${SLUG}${path}`;

async function register(email: string): Promise<Actor> {
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, display_name: email.split('@')[0] });
  expect(res.status).toBe(201);
  return { id: res.body.user.id, token: res.body.access_token };
}

function as(actor: Actor) {
  return {
    get: (url: string) => request(app.server).get(url).set('Authorization', `Bearer ${actor.token}`),
    post: (url: string, body?: object) =>
      request(app.server).post(url).set('Authorization', `Bearer ${actor.token}`).send(body ?? {}),
    patch: (url: string, body: object) =>
      request(app.server).patch(url).set('Authorization', `Bearer ${actor.token}`).send(body),
    delete: (url: string) =>
      request(app.server).delete(url).set('Authorization', `Bearer ${actor.token}`),
  };
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  rector = await register(emails.rector);
  dean = await register(emails.dean);
  staff = await register(emails.staff);
  outsider = await register(emails.outsider);

  const ws = await as(rector).post('/api/v1/workspaces', {
    name: 'Университет',
    slug: SLUG,
    timezone: 'Asia/Dushanbe',
  });
  expect(ws.status).toBe(201);
  expect(ws.body.timezone).toBe('Asia/Dushanbe');
  expect(ws.body.locale).toBe('ru');

  for (const m of [dean, staff]) {
    const res = await as(rector).post(api('/members'), { user_id: m.id, role: 'member' });
    expect(res.status).toBe(201);
  }
});

afterAll(async () => {
  const list = Object.values(emails);
  await app.prisma.workspace.deleteMany({ where: { slug: SLUG } });
  await app.prisma.refreshToken.deleteMany({ where: { user: { email: { in: list } } } });
  await app.prisma.user.deleteMany({ where: { email: { in: list } } });
  await app.close();
});

describe('departments (org structure)', () => {
  let rectorate: string;
  let faculty: string;
  let chair: string;

  it('admin builds a tree; heads must be workspace members', async () => {
    const root = await as(rector).post(api('/departments'), { name: 'Ректорат' });
    expect(root.status).toBe(201);
    rectorate = root.body.id;

    const fac = await as(rector).post(api('/departments'), {
      name: 'Экономический факультет',
      short_name: 'ЭФ',
      parent_id: rectorate,
      head_id: dean.id,
    });
    expect(fac.status).toBe(201);
    expect(fac.body.head.id).toBe(dean.id);
    faculty = fac.body.id;

    const ch = await as(rector).post(api('/departments'), {
      name: 'Кафедра финансов',
      parent_id: faculty,
    });
    chair = ch.body.id;

    const bad = await as(rector).post(api('/departments'), {
      name: 'Чужой руководитель',
      head_id: outsider.id,
    });
    expect(bad.status).toBe(400);
  });

  it('members cannot edit the structure but can read the tree', async () => {
    const denied = await as(staff).post(api('/departments'), { name: 'Х' });
    expect(denied.status).toBe(403);

    const tree = await as(staff).get(api('/departments?tree=true'));
    expect(tree.status).toBe(200);
    expect(tree.body).toHaveLength(1);
    expect(tree.body[0].name).toBe('Ректорат');
    expect(tree.body[0].children[0].name).toBe('Экономический факультет');
    expect(tree.body[0].children[0].children[0].name).toBe('Кафедра финансов');
  });

  it('rejects moving a department under its own descendant', async () => {
    const res = await as(rector).patch(api(`/departments/${rectorate}`), { parent_id: chair });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DEPARTMENT_CYCLE');
  });

  it('member department + position; filter by department subtree', async () => {
    const set = await as(rector).patch(api(`/members/${staff.id}`), {
      department_id: chair,
      position: 'Доцент',
    });
    expect(set.status).toBe(200);
    expect(set.body.position).toBe('Доцент');
    expect(set.body.department.name).toBe('Кафедра финансов');

    // The owner can set their own department/position (but not their role).
    const self = await as(rector).patch(api(`/members/${rector.id}`), {
      department_id: rectorate,
      position: 'Ректор',
    });
    expect(self.status).toBe(200);
    const selfRole = await as(rector).patch(api(`/members/${rector.id}`), { role: 'member' });
    expect(selfRole.status).toBe(403);

    const inFaculty = await as(rector).get(api(`/members?department=${faculty}`));
    expect(inFaculty.body.map((m: { user_id: string }) => m.user_id)).toEqual([staff.id]);
  });

  it('deleting a department moves its people and children one level up', async () => {
    const del = await as(rector).delete(api(`/departments/${faculty}`));
    expect(del.status).toBe(204);

    const chairRow = await app.prisma.department.findUnique({ where: { id: chair } });
    expect(chairRow?.parent_id).toBe(rectorate);
  });
});

describe('profile (ФИО)', () => {
  it('setting the name parts rebuilds display_name', async () => {
    const res = await as(dean).patch('/api/v1/auth/me', {
      last_name: 'Каримов',
      first_name: 'Рустам',
      middle_name: 'Алиевич',
      phone: '+992 90 123 45 67',
      timezone: 'Asia/Dushanbe',
    });
    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe('Каримов Рустам Алиевич');
    expect(res.body.phone).toBe('+992 90 123 45 67');
    expect(res.body.locale).toBe('ru');
  });

  it('rejects an unknown time zone', async () => {
    const res = await as(dean).patch('/api/v1/auth/me', { timezone: 'Mars/Olympus' });
    expect(res.status).toBe(400);
  });
});

describe('projects: fields, private visibility, soft delete', () => {
  let publicId: string;
  let privateId: string;
  let stateReview: string;
  let stateTodo: string;

  it('creates projects with the new fields and Russian default states', async () => {
    const pub = await as(rector).post(api('/projects'), {
      name: 'Аккредитация 2027',
      identifier: 'ACCR',
      status: 'active',
      start_date: '2026-09-01T00:00:00.000Z',
      target_date: '2027-03-01T00:00:00.000Z',
      color: '#3B82F6',
      member_ids: [dean.id],
    });
    expect(pub.status).toBe(201);
    expect(pub.body.visibility).toBe('public');
    expect(pub.body.stats.members).toBe(2);
    publicId = pub.body.id;

    const priv = await as(rector).post(api('/projects'), {
      name: 'Кадровые вопросы',
      identifier: 'HR',
      visibility: 'private',
    });
    expect(priv.status).toBe(201);
    privateId = priv.body.id;

    const states = await as(rector).get(api(`/projects/${publicId}/states`));
    const names = states.body.map((s: { name: string }) => s.name);
    expect(names).toEqual(['Бэклог', 'К выполнению', 'В работе', 'На проверке', 'Готово', 'Отменено']);
    stateReview = states.body.find((s: { group: string }) => s.group === 'review').id;
    stateTodo = states.body.find((s: { group: string }) => s.group === 'unstarted').id;
    expect(stateReview).toBeTruthy();
  });

  it('a private project is invisible to non-members (list, get, nested routes)', async () => {
    const list = await as(staff).get(api('/projects'));
    expect(list.body.map((p: { id: string }) => p.id)).not.toContain(privateId);

    expect((await as(staff).get(api(`/projects/${privateId}`))).status).toBe(404);
    expect((await as(staff).get(api(`/projects/${privateId}/issues`))).status).toBe(404);

    // The owner (admin+) sees everything.
    const adminList = await as(rector).get(api('/projects'));
    expect(adminList.body.map((p: { id: string }) => p.id)).toContain(privateId);
  });

  it('issues: assignment with a controller, primary assignee, filters', async () => {
    const created = await as(rector).post(api(`/projects/${publicId}/issues`), {
      title: 'Подготовить отчёт о самообследовании',
      state_id: stateTodo,
      kind: 'assignment',
      controller_id: rector.id,
      basis: 'Протокол ректората №5 от 12.10.2026',
      assignee_ids: [staff.id, dean.id],
      primary_assignee_id: dean.id,
    });
    expect(created.status).toBe(201);
    expect(created.body.kind).toBe('assignment');
    expect(created.body.requires_review).toBe(true);
    expect(created.body.controller.id).toBe(rector.id);
    expect(created.body.basis).toBe('Протокол ректората №5 от 12.10.2026');
    expect(created.body.assignees[0].user_id).toBe(dean.id);
    expect(created.body.assignees[0].is_primary).toBe(true);

    const switched = await as(rector).patch(api(`/projects/${publicId}/issues/${created.body.id}`), {
      primary_assignee_id: staff.id,
    });
    expect(switched.status).toBe(200);
    expect(switched.body.assignees[0].user_id).toBe(staff.id);
    expect(switched.body.assignees.filter((a: { is_primary: boolean }) => a.is_primary)).toHaveLength(1);

    // Deep-link lookup by key (ACCR-1); the private project's keys stay hidden.
    const byKey = await as(staff).get(api(`/issues/by-key/ACCR-${created.body.sequence_id}`));
    expect(byKey.status).toBe(200);
    expect(byKey.body.id).toBe(created.body.id);
    expect((await as(staff).get(api('/issues/by-key/HR-1'))).status).toBe(404);
    expect((await as(staff).get(api('/issues/by-key/not-a-key'))).status).toBe(400);

    const badController = await as(rector).post(api(`/projects/${publicId}/issues`), {
      title: 'x',
      state_id: stateTodo,
      kind: 'assignment',
      controller_id: outsider.id,
    });
    expect(badController.status).toBe(400);

    await as(rector).post(api(`/projects/${publicId}/issues`), { title: 'Обычная задача', state_id: stateTodo });
    const onlyAssignments = await as(rector).get(api(`/projects/${publicId}/issues?kind=assignment`));
    expect(onlyAssignments.body.data).toHaveLength(1);
    const controlled = await as(rector).get(api(`/projects/${publicId}/issues?controller=${rector.id}`));
    expect(controlled.body.data).toHaveLength(1);
  });

  it('project list carries stats; delete is a soft delete', async () => {
    const list = await as(rector).get(api('/projects'));
    const accr = list.body.find((p: { id: string }) => p.id === publicId);
    expect(accr.stats.issues).toBe(2);
    expect(accr.stats.open_issues).toBe(2);

    const del = await as(rector).delete(api(`/projects/${publicId}`));
    expect(del.status).toBe(204);
    const row = await app.prisma.project.findUnique({ where: { id: publicId } });
    expect(row?.deleted_at).not.toBeNull();
    expect((await as(rector).get(api(`/projects/${publicId}`))).status).toBe(404);
    const after = await as(rector).get(api('/projects'));
    expect(after.body.map((p: { id: string }) => p.id)).not.toContain(publicId);
  });
});

describe('media: avatars and logos', () => {
  it('issues an avatar upload slot with a stable public url', async () => {
    const res = await as(staff).post('/api/v1/auth/me/avatar', { mime_type: 'image/png', size: 1024 });
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/\/api\/v1\/files\/avatars\//);
    expect(res.body.upload.method).toBe('PUT');

    const key = res.body.url.split('/api/v1/files/')[1];
    const file = await request(app.server).get(`/api/v1/files/${key}`);
    expect(file.status).toBe(302);
  });

  it('rejects non-images and oversize files; logo upload is admin-only', async () => {
    const pdf = await as(staff).post('/api/v1/auth/me/avatar', { mime_type: 'application/pdf', size: 10 });
    expect(pdf.status).toBe(400);
    const big = await as(staff).post('/api/v1/auth/me/avatar', { mime_type: 'image/png', size: 50_000_000 });
    expect(big.status).toBe(400);

    expect((await as(staff).post(api('/logo'), { mime_type: 'image/png', size: 10 })).status).toBe(403);
    const ok = await as(rector).post(api('/logo'), { mime_type: 'image/webp', size: 10 });
    expect(ok.status).toBe(200);
    expect(ok.body.url).toMatch(/\/api\/v1\/files\/logos\//);
  });

  it('never serves attachments through the public files route', async () => {
    const res = await request(app.server).get('/api/v1/files/attachments/x/y/z');
    expect(res.status).toBe(404);
  });
});
