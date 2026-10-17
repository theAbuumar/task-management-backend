// Integration tests for the work bot inside the backend (ADR-011, режим 6 дней):
// buttons under notifications, the main-menu lists, the issue card, actions with
// text answers (report, return remark) and the permission checks behind them.
//
// Telegram is simulated: updates are POSTed to the webhook, the Bot API is mocked
// at the `fetch` boundary and its calls are inspected. Accounts are linked to
// Telegram ids directly in the DB. Runs against a live Postgres; created rows are
// removed in afterAll.

import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `tgb-${TS}`;
const DAY = 24 * 60 * 60 * 1000;
const emails = {
  rector: `tgb-rector-${TS}@example.com`,
  dean: `tgb-dean-${TS}@example.com`,
  clerk: `tgb-clerk-${TS}@example.com`,
  outsider: `tgb-outsider-${TS}@example.com`,
};
const TG = { rector: TS + 1, dean: TS + 2, clerk: TS + 3, outsider: TS + 4, stranger: TS + 5 };

type Actor = { id: string; token: string };
type BotCall = { method: string; body: Record<string, unknown> };

let app: FastifyInstance;
let rector: Actor;
let dean: Actor;
let clerk: Actor;
let outsider: Actor;
let project: string;
let privateProject: string;
const states: Record<string, Record<string, string>> = {};
let calls: BotCall[] = [];

const api = (path: string) => `/api/v1/workspaces/${SLUG}${path}`;
const webhook = '/api/v1/auth/telegram/webhook';

async function register(email: string): Promise<Actor> {
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, display_name: `Тестов ${email.split('-')[1]} Иванович` });
  expect(res.status).toBe(201);
  return { id: res.body.user.id, token: res.body.access_token };
}

function as(actor: Actor) {
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${actor.token}`);
  return {
    get: (url: string) => auth(request(app.server).get(url)),
    post: (url: string, body?: object) => auth(request(app.server).post(url)).send(body ?? {}),
  };
}

async function createIssue(projectId: string, extra: object): Promise<{ id: string; key: string }> {
  const res = await as(rector).post(api(`/projects/${projectId}/issues`), {
    state_id: states[projectId]!.unstarted,
    ...extra,
  });
  expect(res.status).toBe(201);
  const identifier = projectId === project ? 'TGB' : 'TGP';
  return { id: res.body.id, key: `${identifier}-${res.body.sequence_id}` };
}

/** Telegram → webhook. */
const tap = (from: number, data: string, messageId = 777) =>
  request(app.server)
    .post(webhook)
    .send({
      callback_query: {
        id: `cq-${Math.random()}`,
        from: { id: from },
        data,
        message: { chat: { id: from }, message_id: messageId },
      },
    });
const say = (from: number, text: string) =>
  request(app.server)
    .post(webhook)
    .send({ message: { chat: { id: from }, from: { id: from }, text } });

const sent = (chatId: number) =>
  calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === chatId);
const answers = () => calls.filter((c) => c.method === 'answerCallbackQuery');
const edits = () => calls.filter((c) => c.method === 'editMessageText');
const callbackData = (c: BotCall) =>
  (
    (c.body.reply_markup as { inline_keyboard?: { callback_data?: string }[][] })
      ?.inline_keyboard ?? []
  )
    .flat()
    .map((b) => b.callback_data);

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  rector = await register(emails.rector);
  dean = await register(emails.dean);
  clerk = await register(emails.clerk);
  outsider = await register(emails.outsider);
  for (const [who, actor] of [
    ['rector', rector],
    ['dean', dean],
    ['clerk', clerk],
    ['outsider', outsider],
  ] as const) {
    await app.prisma.authIdentity.create({
      data: { user_id: actor.id, provider: 'telegram', provider_user_id: String(TG[who]) },
    });
  }

  await as(rector).post('/api/v1/workspaces', {
    name: 'Университет',
    slug: SLUG,
    timezone: 'Asia/Tashkent',
  });
  await as(rector).post(api('/members'), { user_id: dean.id, role: 'member' });
  await as(rector).post(api('/members'), { user_id: clerk.id, role: 'member' });
  const pub = await as(rector).post(api('/projects'), {
    name: 'Аккредитация',
    identifier: 'TGB',
    member_ids: [dean.id, clerk.id],
  });
  project = pub.body.id;
  const priv = await as(rector).post(api('/projects'), {
    name: 'Бюджет',
    identifier: 'TGP',
    visibility: 'private',
    member_ids: [dean.id],
  });
  privateProject = priv.body.id;
  for (const p of [project, privateProject]) {
    const st = await as(rector).get(api(`/projects/${p}/states`));
    states[p] = Object.fromEntries(
      st.body.map((s: { group: string; id: string }) => [s.group, s.id]),
    );
  }
});

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (!url.startsWith('https://api.telegram.org/bot'))
        throw new Error(`unexpected fetch to ${url}`);
      calls.push({ method: url.split('/').pop()!, body: JSON.parse(init?.body ?? '{}') });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  const list = Object.values(emails);
  await app.prisma.workspace.deleteMany({ where: { slug: SLUG } });
  await app.prisma.telegramPendingInput.deleteMany({
    where: { chat_id: { in: Object.values(TG).map(String) } },
  });
  await app.prisma.refreshToken.deleteMany({ where: { user: { email: { in: list } } } });
  await app.prisma.user.deleteMany({ where: { email: { in: list } } });
  await app.close();
});

describe('Telegram bot: assignment → acknowledge → hand-in → return → hand-in → accept', () => {
  it('runs the whole review cycle from the chat, with permission checks', async () => {
    const issue = await createIssue(project, {
      title: 'Отчёт к аккредитации',
      kind: 'assignment',
      controller_id: rector.id,
      assignee_ids: [dean.id],
      due_date: new Date(Date.now() + 3 * DAY).toISOString(),
    });

    // The new assignment arrives with «Ознакомлен» and «Подробнее».
    const note = sent(TG.dean).at(-1)!;
    expect(note.body.text).toContain('Отчёт к аккредитации');
    expect(callbackData(note)).toEqual(
      expect.arrayContaining([`a:ack:${issue.id}`, `c:${issue.id}`]),
    );

    // «Ознакомлен» → recorded, the message turns into the card with a status line.
    calls = [];
    await tap(TG.dean, `a:ack:${issue.id}`).expect(200);
    const assignee = await app.prisma.issueAssignee.findFirst({
      where: { issue_id: issue.id, user_id: dean.id },
    });
    expect(assignee?.acknowledged_at).toBeTruthy();
    expect(answers()[0]!.body.text).toContain('ознакомились');
    expect(edits()[0]!.body.message_id).toBe(777);
    expect(String(edits()[0]!.body.text)).toContain('Вы ознакомились');
    expect(callbackData(edits()[0]!)).toContain(`a:sub:${issue.id}`);
    expect(callbackData(edits()[0]!)).not.toContain(`a:ack:${issue.id}`);

    // «Сдать на проверку» asks for a report; the next message is the report.
    calls = [];
    await tap(TG.dean, `a:sub:${issue.id}`).expect(200);
    expect(sent(TG.dean)[0]!.body.text).toContain('отчёт');
    expect(sent(TG.dean)[0]!.body.reply_markup).toMatchObject({ force_reply: true });
    calls = [];
    await say(TG.dean, 'Раздел подготовлен, таблицы приложены').expect(200);
    const review = await app.prisma.issueReview.findFirst({
      where: { issue_id: issue.id, decision: 'pending' },
    });
    expect(review?.report).toBe('Раздел подготовлен, таблицы приложены');
    expect(String(sent(TG.dean).at(-1)!.body.text)).toContain('Сдано на проверку');

    // The controller gets «Принять» / «Вернуть».
    const toRector = sent(TG.rector).at(-1)!;
    expect(toRector.body.text).toContain('сдал(а) на проверку');
    expect(callbackData(toRector)).toEqual(
      expect.arrayContaining([`a:ok:${issue.id}`, `a:ret:${issue.id}`]),
    );

    // The assignee cannot accept their own work.
    calls = [];
    await tap(TG.dean, `a:ok:${issue.id}`).expect(200);
    expect(answers()[0]!.body).toMatchObject({ show_alert: true });
    expect(answers()[0]!.body.text).toContain('контролёр');
    expect(
      await app.prisma.issueReview.count({ where: { issue_id: issue.id, decision: 'pending' } }),
    ).toBe(1);

    // «Вернуть» needs a remark: it lands in the review and in the discussion.
    await tap(TG.rector, `a:ret:${issue.id}`).expect(200);
    await say(TG.rector, 'Добавьте сравнение с прошлым годом').expect(200);
    const returned = await app.prisma.issueReview.findFirst({
      where: { issue_id: issue.id, decision: 'returned' },
    });
    expect(returned?.decision_comment).toBe('Добавьте сравнение с прошлым годом');
    const toDean = sent(TG.dean).at(-1)!;
    expect(toDean.body.text).toContain('вернул(а) на доработку');
    expect(callbackData(toDean)).toContain(`a:sub:${issue.id}`);

    // Hand in again, then accept.
    await tap(TG.dean, `a:sub:${issue.id}`).expect(200);
    await say(TG.dean, 'Сравнение добавлено').expect(200);
    calls = [];
    await tap(TG.rector, `a:ok:${issue.id}`).expect(200);
    expect(String(edits()[0]!.body.text)).toContain('Вы приняли работу');
    const done = await app.prisma.issue.findUnique({
      where: { id: issue.id },
      select: { state: true },
    });
    expect(done?.state.group).toBe('completed');
  });
});

describe('Telegram bot: menu and lists', () => {
  it('shows my open tasks, today and overdue by the workspace calendar', async () => {
    const late = await createIssue(project, {
      title: 'Просроченная справка',
      assignee_ids: [clerk.id],
      due_date: new Date(Date.now() - 2 * DAY).toISOString(),
    });
    const later = await createIssue(project, {
      title: 'Справка на следующей неделе',
      assignee_ids: [clerk.id],
      due_date: new Date(Date.now() + 7 * DAY).toISOString(),
    });

    calls = [];
    await say(TG.clerk, '📋 Мои задачи').expect(200);
    const my = sent(TG.clerk)[0]!;
    expect(my.body.text).toContain(late.key);
    expect(my.body.text).toContain(later.key);
    expect(my.body.text).toContain('просрочено на 2 дня');
    expect(callbackData(my)).toEqual(expect.arrayContaining([`c:${late.id}`, `c:${later.id}`]));

    calls = [];
    await say(TG.clerk, '🔥 Просрочено').expect(200);
    expect(sent(TG.clerk)[0]!.body.text).toContain(late.key);
    expect(sent(TG.clerk)[0]!.body.text).not.toContain(later.key);

    calls = [];
    await say(TG.clerk, '⏰ Сегодня').expect(200);
    expect(sent(TG.clerk)[0]!.body.text).toContain('сроков нет');
  });

  it('pages long lists with ‹ › buttons', async () => {
    for (let i = 0; i < 9; i++) {
      await createIssue(project, {
        title: `Поручение на контроле ${i}`,
        kind: 'assignment',
        assignee_ids: [dean.id],
      });
    }
    calls = [];
    await say(TG.rector, '🎯 На контроле').expect(200);
    const first = sent(TG.rector)[0]!;
    expect(first.body.text).toContain('стр. 1 из');
    expect(callbackData(first)).toContain('l:control:1');

    calls = [];
    await tap(TG.rector, 'l:control:1').expect(200);
    expect(String(edits()[0]!.body.text)).toContain('стр. 2 из');
  });

  it('greets with the menu keyboard and tells unlinked accounts what to do', async () => {
    await say(TG.dean, '/start').expect(200);
    const hello = sent(TG.dean).at(-1)!;
    expect(hello.body.reply_markup).toMatchObject({ keyboard: expect.any(Array) });

    await say(TG.stranger, '📋 Мои задачи').expect(200);
    expect(sent(TG.stranger)[0]!.body.text).toContain('не привязан');
  });
});

describe('Telegram bot: who may see a card', () => {
  it('hides other workspaces and private projects, like the web app', async () => {
    const pub = await createIssue(project, { title: 'Открытая задача' });
    const hidden = await createIssue(privateProject, { title: 'Смета', assignee_ids: [dean.id] });

    await tap(TG.outsider, `c:${pub.id}`).expect(200);
    expect(answers()[0]!.body.text).toContain('не найдена');

    calls = [];
    await tap(TG.clerk, `c:${hidden.id}`).expect(200);
    expect(answers()[0]!.body.text).toContain('не найдена');

    calls = [];
    await tap(TG.dean, `c:${hidden.id}`).expect(200);
    expect(String(edits()[0]!.body.text)).toContain('Смета');

    // Actions go through the same check.
    calls = [];
    await tap(TG.clerk, `a:cmt:${hidden.id}`).expect(200);
    expect(answers()[0]!.body.text).toContain('не найдена');
    expect(
      await app.prisma.telegramPendingInput.count({ where: { chat_id: String(TG.clerk) } }),
    ).toBe(0);
  });

  it('a comment from the chat is posted as the linked user; /cancel drops a pending question', async () => {
    const issue = await createIssue(project, { title: 'Обсуждение' });
    await tap(TG.clerk, `a:cmt:${issue.id}`).expect(200);
    await say(TG.clerk, '/cancel').expect(200);
    await say(TG.clerk, 'Этот текст не должен стать комментарием').expect(200);
    expect(await app.prisma.comment.count({ where: { issue_id: issue.id } })).toBe(0);

    await tap(TG.clerk, `a:cmt:${issue.id}`).expect(200);
    await say(TG.clerk, 'Беру в работу').expect(200);
    const comment = await app.prisma.comment.findFirst({ where: { issue_id: issue.id } });
    expect(comment).toMatchObject({ body: 'Беру в работу', author_id: clerk.id });
  });
});
