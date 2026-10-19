// Integration tests for the trash (Ф7 7.B6, ADR-017): who sees what, restoring
// (own deletions for members, anything for admins), «Удалить навсегда» (admins
// only) with files and sub-issues, a project with its issues, the 30-day
// clean-up of the scheduler, and the audit entries that keep the names.
//
// Runs against a live Postgres; everything is removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { purgeExpiredTrash } from '../src/modules/trash/service.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `trash-${TS}`;
const emails = {
  rector: `trash-rector-${TS}@example.com`,
  dean: `trash-dean-${TS}@example.com`,
  clerk: `trash-clerk-${TS}@example.com`,
  guest: `trash-guest-${TS}@example.com`,
};

type Actor = { id: string; token: string };
type Item = {
  type: 'issue' | 'project';
  id: string;
  name: string;
  key: string;
  kind: string | null;
  project: { id: string; identifier: string } | null;
  deleted_at: string;
  deleted_by: { id: string; display_name: string } | null;
  purge_at: string;
  can_restore: boolean;
  can_purge: boolean;
};

let app: FastifyInstance;
let rector: Actor;
let dean: Actor;
let clerk: Actor;
let guest: Actor;
let projectId: string;
let todo: string;

const api = (path: string) => `/api/v1/workspaces/${SLUG}${path}`;

async function register(email: string): Promise<Actor> {
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, display_name: `Корзинов ${email.split('-')[1]}` });
  expect(res.status).toBe(201);
  return { id: res.body.user.id, token: res.body.access_token };
}

function as(actor: Actor) {
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${actor.token}`);
  return {
    get: (url: string) => auth(request(app.server).get(url)),
    post: (url: string, body?: object) => auth(request(app.server).post(url)).send(body ?? {}),
    delete: (url: string) => auth(request(app.server).delete(url)),
  };
}

async function trash(actor: Actor, query = ''): Promise<Item[]> {
  const res = await as(actor).get(api(`/trash?limit=100${query}`));
  expect(res.status).toBe(200);
  return res.body.data;
}

async function createIssue(actor: Actor, title: string, extra: object = {}, project = projectId) {
  const res = await as(actor).post(api(`/projects/${project}/issues`), {
    title,
    state_id: project === projectId ? todo : undefined,
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body as { id: string; sequence_id: number };
}

async function deleteIssue(actor: Actor, id: string, project = projectId) {
  expect((await as(actor).delete(api(`/projects/${project}/issues/${id}`))).status).toBe(204);
}

/** Audit entries are written right after the reply goes out — give the write a moment. */
async function auditEntries(action: string) {
  const deadline = Date.now() + 2000;
  for (;;) {
    const res = await as(rector).get(api(`/audit?limit=200&action=${action}`));
    const rows = res.body.data as {
      action: string;
      actor: { id: string } | null;
      target: { id: string; name: string | null } | null;
      meta: Record<string, unknown> | null;
    }[];
    if (rows.length > 0 || Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
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
  const project = await as(rector).post(api('/projects'), {
    name: 'Аккредитация',
    identifier: 'TRS',
  });
  projectId = project.body.id;
  const st = await as(rector).get(api(`/projects/${projectId}/states`));
  todo = st.body.find((s: { group: string }) => s.group === 'unstarted').id;
});

afterAll(async () => {
  const list = Object.values(emails);
  await app.prisma.workspace.deleteMany({ where: { slug: SLUG } });
  await app.prisma.refreshToken.deleteMany({ where: { user: { email: { in: list } } } });
  await app.prisma.user.deleteMany({ where: { email: { in: list } } });
  await app.close();
});

describe('trash — who sees what', () => {
  it('lists a deleted issue with who deleted it and when it goes for good', async () => {
    const issue = await createIssue(dean, 'Черновик приказа');
    await deleteIssue(dean, issue.id);

    const forRector = (await trash(rector)).find((i) => i.id === issue.id);
    expect(forRector).toMatchObject({
      type: 'issue',
      name: 'Черновик приказа',
      key: `TRS-${issue.sequence_id}`,
      kind: 'task',
      project: { id: projectId, identifier: 'TRS' },
      deleted_by: { id: dean.id, display_name: expect.stringContaining('Корзинов') },
      can_restore: true,
      can_purge: true,
    });
    const days = (Date.parse(forRector!.purge_at) - Date.parse(forRector!.deleted_at)) / 86_400_000;
    expect(days).toBe(30);

    // The member who deleted it sees it (and may restore, not purge); another member does not.
    expect((await trash(dean)).find((i) => i.id === issue.id)).toMatchObject({
      can_restore: true,
      can_purge: false,
    });
    expect((await trash(clerk)).some((i) => i.id === issue.id)).toBe(false);
    // A guest deletes nothing, so their trash is empty.
    expect(await trash(guest)).toEqual([]);

    const res = await as(rector).get(api('/trash'));
    expect(res.body.retention_days).toBe(30);
  });

  it('pages with a cursor, newest first', async () => {
    const a = await createIssue(rector, 'Страница 1');
    const b = await createIssue(rector, 'Страница 2');
    await deleteIssue(rector, a.id);
    await deleteIssue(rector, b.id);

    const first = await as(rector).get(api('/trash?type=issue&limit=1'));
    expect(first.status).toBe(200);
    expect(first.body.data.map((i: Item) => i.id)).toEqual([b.id]);
    expect(first.body.next_cursor).toBeTruthy();
    const second = await as(rector).get(
      api(`/trash?type=issue&limit=1&cursor=${encodeURIComponent(first.body.next_cursor)}`),
    );
    expect(second.body.data.map((i: Item) => i.id)).toEqual([a.id]);

    expect((await as(rector).get(api('/trash?cursor=garbage'))).status).toBe(400);
  });
});

describe('trash — restore', () => {
  it('a member restores what they deleted: the issue is back, with a history entry and an audit entry', async () => {
    const issue = await createIssue(dean, 'Вернуть меня');
    await deleteIssue(dean, issue.id);
    expect((await as(dean).get(api(`/projects/${projectId}/issues/${issue.id}`))).status).toBe(404);

    const res = await as(dean).post(api(`/trash/issue/${issue.id}/restore`));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: 'issue',
      id: issue.id,
      name: 'Вернуть меня',
      key: `TRS-${issue.sequence_id}`,
      project_id: projectId,
    });

    const back = await as(dean).get(api(`/projects/${projectId}/issues/${issue.id}`));
    expect(back.status).toBe(200);
    expect((await trash(rector)).some((i) => i.id === issue.id)).toBe(false);
    const row = await app.prisma.issue.findUnique({ where: { id: issue.id } });
    expect(row).toMatchObject({ deleted_at: null, deleted_by_id: null });

    const history = await as(dean).get(
      api(`/projects/${projectId}/issues/${issue.id}/activity?limit=50`),
    );
    const actions = (history.body.data as { action: string }[]).map((a) => a.action);
    expect(actions).toContain('issue.restored');

    const entries = await auditEntries('issue.restored');
    expect(entries.find((e) => e.target?.id === issue.id)).toMatchObject({
      actor: { id: dean.id },
      target: { name: `TRS-${issue.sequence_id} Вернуть меня` },
    });
  });

  it('a member cannot restore or purge what someone else deleted; an admin can restore it', async () => {
    const issue = await createIssue(clerk, 'Чужая задача');
    await deleteIssue(clerk, issue.id);

    const denied = await as(dean).post(api(`/trash/issue/${issue.id}/restore`));
    expect(denied.status).toBe(403);
    expect((await as(dean).delete(api(`/trash/issue/${issue.id}`))).status).toBe(403);
    expect((await as(clerk).delete(api(`/trash/issue/${issue.id}`))).status).toBe(403);
    // A guest is read-only.
    const byGuest = await as(guest).post(api(`/trash/issue/${issue.id}/restore`));
    expect(byGuest.status).toBe(403);
    expect(byGuest.body.error.code).toBe('GUEST_READ_ONLY');

    expect((await as(rector).post(api(`/trash/issue/${issue.id}/restore`))).status).toBe(200);
  });

  it('a private project hides its trash from non-members (404)', async () => {
    const secret = await as(rector).post(api('/projects'), {
      name: 'Закрытый',
      identifier: 'TRP',
      visibility: 'private',
    });
    const states = await as(rector).get(api(`/projects/${secret.body.id}/states`));
    const state = states.body.find((s: { group: string }) => s.group === 'unstarted').id;
    const issue = await as(rector).post(api(`/projects/${secret.body.id}/issues`), {
      title: 'Секрет',
      state_id: state,
    });
    await deleteIssue(rector, issue.body.id, secret.body.id);
    expect((await as(dean).post(api(`/trash/issue/${issue.body.id}/restore`))).status).toBe(404);
  });

  it('answers 404 for something that is not in the trash', async () => {
    const live = await createIssue(rector, 'Живая');
    expect((await as(rector).post(api(`/trash/issue/${live.id}/restore`))).status).toBe(404);
    expect((await as(rector).delete(api(`/trash/issue/${live.id}`))).status).toBe(404);
  });
});

describe('trash — projects', () => {
  it('a deleted project is listed (admins only) without its issues, which come back with it', async () => {
    const res = await as(rector).post(api('/projects'), {
      name: 'Приёмная кампания',
      identifier: 'TRA',
    });
    const pid = res.body.id as string;
    const states = await as(rector).get(api(`/projects/${pid}/states`));
    const state = states.body.find((s: { group: string }) => s.group === 'unstarted').id;
    const inside = await as(rector).post(api(`/projects/${pid}/issues`), {
      title: 'План приёма',
      state_id: state,
    });
    const deletedBefore = await as(rector).post(api(`/projects/${pid}/issues`), {
      title: 'Удалена раньше проекта',
      state_id: state,
    });
    await deleteIssue(rector, deletedBefore.body.id, pid);
    expect((await as(rector).delete(api(`/projects/${pid}`))).status).toBe(204);

    const items = await trash(rector);
    expect(items.find((i) => i.id === pid)).toMatchObject({
      type: 'project',
      name: 'Приёмная кампания',
      key: 'TRA',
      project: null,
      deleted_by: { id: rector.id },
    });
    expect(items.some((i) => i.id === deletedBefore.body.id)).toBe(false);
    expect((await trash(dean)).some((i) => i.id === pid)).toBe(false);
    expect((await as(dean).post(api(`/trash/project/${pid}/restore`))).status).toBe(403);

    const blocked = await as(rector).post(api(`/trash/issue/${deletedBefore.body.id}/restore`));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('PROJECT_IN_TRASH');

    expect((await as(rector).post(api(`/trash/project/${pid}/restore`))).status).toBe(200);
    expect((await as(rector).get(api(`/projects/${pid}/issues/${inside.body.id}`))).status).toBe(
      200,
    );
    // The issue deleted on its own is back in the trash list now, restorable.
    expect((await trash(rector)).some((i) => i.id === deletedBefore.body.id)).toBe(true);
    expect(
      (await as(rector).post(api(`/trash/issue/${deletedBefore.body.id}/restore`))).status,
    ).toBe(200);
  });

  it('«Удалить навсегда» for a project removes it with all its issues', async () => {
    const res = await as(rector).post(api('/projects'), { name: 'Субботник', identifier: 'TRX' });
    const pid = res.body.id as string;
    const states = await as(rector).get(api(`/projects/${pid}/states`));
    const state = states.body.find((s: { group: string }) => s.group === 'unstarted').id;
    const parent = await as(rector).post(api(`/projects/${pid}/issues`), {
      title: 'Родитель',
      state_id: state,
    });
    await as(rector).post(api(`/projects/${pid}/issues`), {
      title: 'Подзадача',
      state_id: state,
      parent_id: parent.body.id,
    });
    await as(rector).delete(api(`/projects/${pid}`));

    expect((await as(rector).delete(api(`/trash/project/${pid}`))).status).toBe(204);
    expect(await app.prisma.project.findUnique({ where: { id: pid } })).toBeNull();
    expect(await app.prisma.issue.count({ where: { project_id: pid } })).toBe(0);

    const entries = await auditEntries('project.purged');
    expect(entries.find((e) => e.target?.id === pid)).toMatchObject({
      actor: { id: rector.id },
      target: { name: 'Субботник (TRX)' },
    });
  });
});

describe('trash — delete for good', () => {
  it('removes the issue and its files; sub-issues stay without a parent; the audit keeps the name', async () => {
    const parent = await createIssue(rector, 'Отчёт с файлом');
    const child = await createIssue(rector, 'Подпункт', { parent_id: parent.id });
    const key = `attachments/${TS}/report.pdf`;
    await app.storage.put(key, Buffer.from('%PDF-1.4 test'), 'application/pdf');
    const ws = await app.prisma.workspace.findUniqueOrThrow({ where: { slug: SLUG } });
    await app.prisma.attachment.create({
      data: {
        workspace_id: ws.id,
        issue_id: parent.id,
        uploaded_by_id: rector.id,
        file_name: 'report.pdf',
        file_size: 13,
        mime_type: 'application/pdf',
        storage_key: key,
      },
    });
    await deleteIssue(rector, parent.id);

    expect((await as(rector).delete(api(`/trash/issue/${parent.id}`))).status).toBe(204);
    expect(await app.prisma.issue.findUnique({ where: { id: parent.id } })).toBeNull();
    expect(await app.storage.inspect(key, 4)).toBeNull();
    const orphan = await app.prisma.issue.findUnique({ where: { id: child.id } });
    expect(orphan).toMatchObject({ parent_id: null, deleted_at: null });

    const purged = await auditEntries('issue.purged');
    expect(purged.find((e) => e.target?.id === parent.id)).toMatchObject({
      actor: { id: rector.id },
      target: { name: `TRS-${parent.sequence_id} Отчёт с файлом` },
    });
    // The earlier «deleted» entry still shows what was deleted.
    const deleted = await auditEntries('issue.deleted');
    expect(deleted.find((e) => e.target?.id === parent.id)?.target?.name).toBe(
      `TRS-${parent.sequence_id} Отчёт с файлом`,
    );
  });

  it('the scheduler removes what has been in the trash for more than 30 days', async () => {
    const old = await createIssue(rector, 'Давно удалена');
    const fresh = await createIssue(rector, 'Недавно удалена');
    await deleteIssue(rector, old.id);
    await deleteIssue(rector, fresh.id);
    await app.prisma.issue.update({
      where: { id: old.id },
      data: { deleted_at: new Date(Date.now() - 31 * 86_400_000) },
    });

    const removed = await purgeExpiredTrash(app.prisma, app.storage);
    expect(removed.find((r) => r.id === old.id)).toMatchObject({
      type: 'issue',
      title: `TRS-${old.sequence_id} Давно удалена`,
    });
    expect(removed.some((r) => r.id === fresh.id)).toBe(false);
    expect(await app.prisma.issue.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await app.prisma.issue.findUnique({ where: { id: fresh.id } })).not.toBeNull();
  });
});
