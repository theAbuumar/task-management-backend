// Integration tests for the global search (Ф7 7.B2): Russian morphology and
// prefixes, «ё» = «е», description snippets, ranking, an exact key first,
// projects / people / departments, the `types` filter, and visibility (deleted
// issues, private projects).
//
// Runs against a live Postgres; everything is removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { MARK_END, MARK_START, markWords } from '../src/modules/search/service.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `srch-${TS}`;
const emails = {
  rector: `srch-rector-${TS}@example.com`,
  dean: `srch-dean-${TS}@example.com`,
  guest: `srch-guest-${TS}@example.com`,
};

type Actor = { id: string; token: string };
type Issue = { id: string; key: string; title: string; title_hl: string; snippet: string | null };

let app: FastifyInstance;
let rector: Actor;
let dean: Actor;
let guest: Actor;
const ids: Record<string, string> = {};

const api = (path: string) => `/api/v1/workspaces/${SLUG}${path}`;
const plain = (s: string | null) => (s ?? '').replaceAll(MARK_START, '[').replaceAll(MARK_END, ']');

async function register(email: string, name: string): Promise<Actor> {
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, display_name: name });
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

async function find(actor: Actor, q: string, extra = '') {
  const res = await as(actor).get(api(`/search?q=${encodeURIComponent(q)}${extra}`));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as {
    issues: Issue[];
    projects: { id: string; identifier: string; name_hl: string }[];
    people: { user_id: string; position: string | null; name_hl: string }[];
    departments: { id: string; name_hl: string }[];
  };
}

async function issue(project: string, title: string, description?: string) {
  const states = await as(rector).get(api(`/projects/${project}/states`));
  const state = states.body.find((s: { group: string }) => s.group === 'unstarted').id;
  const res = await as(rector).post(api(`/projects/${project}/issues`), {
    title,
    description,
    state_id: state,
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  rector = await register(emails.rector, 'Рахимов Фарход Саидович');
  dean = await register(emails.dean, 'Абдуллоев Шерзод Камолович');
  guest = await register(emails.guest, 'Гостев Пётр');
  await as(rector).post('/api/v1/workspaces', { name: 'Университет', slug: SLUG });
  await as(rector).post(api('/members'), { user_id: dean.id, role: 'member' });
  await as(rector).post(api('/members'), { user_id: guest.id, role: 'guest' });

  const dep = await as(rector).post(api('/departments'), {
    name: 'Факультет экономики и управления',
    short_name: 'ФЭУ',
  });
  ids.department = dep.body.id;
  await as(rector).patch(api(`/members/${dean.id}`), {
    department_id: ids.department,
    position: 'Декан ФЭУ',
  });

  const pub = await as(rector).post(api('/projects'), {
    name: 'Аккредитация 2027',
    identifier: 'SRC',
  });
  ids.project = pub.body.id;
  const priv = await as(rector).post(api('/projects'), {
    name: 'Закрытый проект',
    identifier: 'SPR',
    visibility: 'private',
  });
  ids.private = priv.body.id;

  ids.order = await issue(ids.project, 'Подготовить приказ о стипендии');
  ids.orders = await issue(ids.project, 'Перевести приказы в электронный вид');
  ids.report = await issue(ids.project, 'Подготовить отчёт о самообследовании');
  ids.inText = await issue(
    ids.project,
    'Собрать сведения о кадрах',
    'Нужно для аккредитации программы: таблица по всем кафедрам.',
  );
  ids.inTitle = await issue(ids.project, 'План аккредитации кафедры');
  ids.html = await issue(ids.project, 'Шаблон <b>приказа</b> для деканатов');
  ids.deleted = await issue(ids.project, 'Удалённый приказ о премии');
  await as(rector).delete(api(`/projects/${ids.project}/issues/${ids.deleted}`));
  ids.secret = await issue(ids.private, 'Секретный приказ ректора');
});

afterAll(async () => {
  const list = Object.values(emails);
  await app.prisma.workspace.deleteMany({ where: { slug: SLUG } });
  await app.prisma.refreshToken.deleteMany({ where: { user: { email: { in: list } } } });
  await app.prisma.user.deleteMany({ where: { email: { in: list } } });
  await app.close();
});

describe('search — issues', () => {
  it('Russian morphology: «приказы» finds «приказ» and «приказы», with the words marked', async () => {
    const { issues } = await find(dean, 'приказы');
    const titles = issues.map((i) => plain(i.title_hl));
    expect(titles).toContain('Подготовить [приказ] о стипендии');
    expect(titles).toContain('Перевести [приказы] в электронный вид');
  });

  it('a word being typed already matches (prefix), and «е» finds «ё»', async () => {
    expect((await find(dean, 'самообсл')).issues.map((i) => i.id)).toContain(ids.report);
    const { issues } = await find(dean, 'отчет самообследование');
    expect(issues[0]).toMatchObject({ id: ids.report });
    expect(plain(issues[0]!.title_hl)).toBe('Подготовить [отчёт] о [самообследовании]');
  });

  it('finds words in the description with a marked snippet; title hits rank higher', async () => {
    const { issues } = await find(dean, 'аккредитация');
    const order = issues.map((i) => i.id);
    expect(order.indexOf(ids.inTitle)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(ids.inText)).toBeGreaterThan(order.indexOf(ids.inTitle));
    const inText = issues.find((i) => i.id === ids.inText)!;
    expect(plain(inText.snippet)).toContain('[аккредитации] программы');
  });

  it('an exact key comes first', async () => {
    const all = await app.prisma.issue.findMany({
      where: { project_id: ids.project },
      select: { id: true, sequence_id: true },
    });
    const target = all.find((i) => i.id === ids.inText)!;
    const { issues } = await find(dean, `src-${target.sequence_id}`);
    expect(issues[0]).toMatchObject({ id: ids.inText, key: `SRC-${target.sequence_id}` });
  });

  it('never finds deleted issues; private projects only for their members and admins', async () => {
    const forDean = (await find(dean, 'приказ')).issues.map((i) => i.id);
    expect(forDean).not.toContain(ids.deleted);
    expect(forDean).not.toContain(ids.secret);
    const forRector = (await find(rector, 'приказ')).issues.map((i) => i.id);
    expect(forRector).toContain(ids.secret);
    expect(forRector).not.toContain(ids.deleted);
    // By key, too.
    const secret = await app.prisma.issue.findUniqueOrThrow({ where: { id: ids.secret } });
    expect((await find(dean, `SPR-${secret.sequence_id}`)).issues).toEqual([]);
  });

  it('returns user text as is: markup in a title is not interpreted, only marked', async () => {
    const { issues } = await find(dean, 'шаблон');
    expect(plain(issues.find((i) => i.id === ids.html)!.title_hl)).toBe(
      '[Шаблон] <b>приказа</b> для деканатов',
    );
  });
});

describe('search — projects, people, departments', () => {
  it('projects by name or key, people by name or position (any word order), departments by short name', async () => {
    const res = await find(dean, 'аккред');
    expect(res.projects.map((p) => p.identifier)).toEqual(['SRC']);
    expect(plain(res.projects[0]!.name_hl)).toBe('[Аккред]итация 2027');
    expect((await find(dean, 'spr')).projects).toEqual([]); // private, not a member
    expect((await find(rector, 'spr')).projects.map((p) => p.identifier)).toEqual(['SPR']);

    const people = (await find(rector, 'декан абдуллоев')).people;
    expect(people).toEqual([expect.objectContaining({ user_id: dean.id, position: 'Декан ФЭУ' })]);
    expect(plain(people[0]!.name_hl)).toContain('[Абдуллоев]');

    const deps = (await find(dean, 'ФЭУ')).departments;
    expect(deps.map((d) => d.id)).toEqual([ids.department]);
  });

  it('`types` narrows the result; a guest can search too; bad input is 400', async () => {
    const res = await find(guest, 'приказ', '&types=people,departments');
    expect(res.issues).toEqual([]);
    expect(res.projects).toEqual([]);
    expect((await find(guest, 'приказ', '&types=issues')).issues.length).toBeGreaterThan(0);

    expect((await as(dean).get(api('/search?q=x&types=files'))).status).toBe(400);
    expect((await as(dean).get(api('/search?q='))).status).toBe(400);
    expect((await as(dean).get(api('/search'))).status).toBe(400);
  });

  it('limit applies per type', async () => {
    const { issues } = await find(rector, 'приказ', '&limit=2');
    expect(issues).toHaveLength(2);
  });
});

describe('markWords', () => {
  it('marks every occurrence case-insensitively, treating «е» and «ё» alike', () => {
    expect(plain(markWords('Королёв и королев', ['королев']))).toBe('[Королёв] и [королев]');
    expect(plain(markWords('a.b (c)', ['.b', '(c']))).toBe('a[.b] [(c])');
  });
});
