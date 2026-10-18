// Integration tests for the work bot inside the backend (ADR-011, режим 6 дней):
// buttons under notifications, the main-menu lists, the issue card, actions with
// text answers (report, return remark, new deadline), files handed in with a
// report, and the permission checks behind them.
//
// Telegram is simulated: updates are POSTed to the webhook, the Bot API is mocked
// at the `fetch` boundary (including getFile and the file download) and its calls
// are inspected. Accounts are linked to Telegram ids directly in the DB. Runs
// against a live Postgres; created rows and stored files are removed in afterAll.

import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseDeadlineInput } from '../src/modules/telegram/views.js';
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
/** Bytes Telegram hands back for a file_id; an unknown id fails to download. */
const telegramFiles: Record<string, Buffer> = {};

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
/** A document or photo message (`extra` — document/photo/caption/media_group_id). */
const sendFile = (from: number, extra: object) =>
  request(app.server)
    .post(webhook)
    .send({ message: { chat: { id: from }, from: { id: from }, ...extra } });
const doc = (fileId: string, fileName: string, extra: object = {}) => ({
  document: {
    file_id: fileId,
    file_name: fileName,
    mime_type: 'application/pdf',
    file_size: telegramFiles[fileId]?.length ?? 100,
  },
  ...extra,
});

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
      if (url.startsWith('https://api.telegram.org/file/bot')) {
        const data = telegramFiles[url.split('/').pop()!];
        return {
          ok: Boolean(data),
          arrayBuffer: async () => new Uint8Array(data ?? []).buffer,
        };
      }
      if (!url.startsWith('https://api.telegram.org/bot'))
        throw new Error(`unexpected fetch to ${url}`);
      const call = { method: url.split('/').pop()!, body: JSON.parse(init?.body ?? '{}') };
      calls.push(call);
      const result =
        call.method === 'getFile'
          ? { file_id: call.body.file_id, file_path: `documents/${call.body.file_id}` }
          : { message_id: 1 };
      return { ok: true, json: async () => ({ ok: true, result }) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  const list = Object.values(emails);
  const stored = await app.prisma.attachment.findMany({
    where: { workspace: { slug: SLUG } },
    select: { storage_key: true },
  });
  for (const a of stored) await app.storage.delete(a.storage_key);
  await app.prisma.workspace.deleteMany({ where: { slug: SLUG } });
  const chats = { chat_id: { in: Object.values(TG).map(String) } };
  await app.prisma.telegramPendingInput.deleteMany({ where: chats });
  await app.prisma.telegramPendingFile.deleteMany({ where: chats });
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

describe('Telegram bot: a guest only reads (12.B4)', () => {
  it('the card has no action buttons and a tap on an old button is refused', async () => {
    const issue = await createIssue(project, { title: 'Для гостя', assignee_ids: [dean.id] });
    const setRole = (role: 'guest' | 'member') =>
      app.prisma.workspaceMember.updateMany({
        where: { user_id: clerk.id, workspace: { slug: SLUG } },
        data: { role },
      });
    await setRole('guest');
    try {
      calls = [];
      await tap(TG.clerk, `c:${issue.id}`).expect(200);
      const card = [...edits(), ...sent(TG.clerk)].at(-1)!;
      expect(String(card.body.text)).toContain('Для гостя');
      expect(callbackData(card).filter((d) => d?.startsWith('a:'))).toEqual([]);

      calls = [];
      await tap(TG.clerk, `a:cmt:${issue.id}`).expect(200);
      expect(answers()[0]!.body.text).toContain('Гость');
      expect(sent(TG.clerk)).toHaveLength(0); // no «write your comment» question
    } finally {
      await setRole('member');
    }
  });
});

// Real leading bytes: stored files must match their extension (12.B6, ADR-027).
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

describe('Telegram bot: a report with files (9.T5)', () => {
  const staged = (chat: number) =>
    app.prisma.telegramPendingFile.count({ where: { chat_id: String(chat) } });
  const pendingReview = (issueId: string) =>
    app.prisma.issueReview.findFirst({
      where: { issue_id: issueId, decision: 'pending' },
      include: { attachments: { orderBy: { created_at: 'asc' } } },
    });

  it('«Сдать на проверку» → document and photo → report: handed in like on the site', async () => {
    const issue = await createIssue(project, {
      title: 'План устранения замечаний',
      kind: 'assignment',
      controller_id: rector.id,
      assignee_ids: [dean.id],
      due_date: new Date(Date.now() + 5 * DAY).toISOString(),
    });
    telegramFiles['doc-plan'] = Buffer.from('%PDF-1.4 план');
    telegramFiles['photo-big'] = Buffer.concat([JPEG, Buffer.from('большой')]);

    calls = [];
    await tap(TG.dean, `a:sub:${issue.id}`).expect(200);
    expect(sent(TG.dean)[0]!.body.text).toContain('Файл');

    calls = [];
    await sendFile(TG.dean, doc('doc-plan', 'План устранения замечаний.pdf')).expect(200);
    let reply = sent(TG.dean).at(-1)!;
    expect(reply.body.text).toContain('План устранения замечаний.pdf');
    expect(callbackData(reply)).toEqual([`a:snd:${issue.id}`, 'x']);

    calls = [];
    await sendFile(TG.dean, {
      photo: [
        { file_id: 'photo-small', file_size: 5 },
        { file_id: 'photo-big', file_size: 20 },
      ],
    }).expect(200);
    reply = sent(TG.dean).at(-1)!;
    expect(reply.body.text).toContain('2 файла');
    expect(reply.body.text).toMatch(/Фото \d{2}\.\d{2}\.\d{4} \d{2}-\d{2}\.jpg/);
    // Nothing is fetched or stored until the hand-in.
    expect(calls.some((c) => c.method === 'getFile')).toBe(false);
    expect(await app.prisma.attachment.count({ where: { issue_id: issue.id } })).toBe(0);

    calls = [];
    await say(TG.dean, 'План согласован с кафедрами').expect(200);
    const review = await pendingReview(issue.id);
    expect(review?.report).toBe('План согласован с кафедрами');
    expect(review?.attachments.map((a) => [a.file_name, a.mime_type, a.uploaded_by_id])).toEqual([
      ['План устранения замечаний.pdf', 'application/pdf', dean.id],
      [expect.stringMatching(/^Фото .+\.jpg$/), 'image/jpeg', dean.id],
    ]);
    // Only the largest size of the photo is fetched; the bytes land in storage.
    expect(calls.filter((c) => c.method === 'getFile').map((c) => c.body.file_id)).toEqual([
      'doc-plan',
      'photo-big',
    ]);
    const pdf = await app.storage.inspect(review!.attachments[0]!.storage_key, 64);
    expect(pdf?.head.toString()).toBe('%PDF-1.4 план');
    expect(String(sent(TG.dean).at(-1)!.body.text)).toContain('Сдано на проверку · 📎 2 файла');
    expect(await staged(TG.dean)).toBe(0);
    // The file shows up in the issue history, as an upload from the site does.
    expect(
      await app.prisma.activityLog.count({
        where: { issue_id: issue.id, action: 'issue.attachment_added' },
      }),
    ).toBe(2);

    // The controller's card lists the report files.
    calls = [];
    await tap(TG.rector, `c:${issue.id}`).expect(200);
    expect(String(edits()[0]!.body.text)).toContain('📎 План устранения замечаний.pdf, Фото');
  });

  it('a file sent first: «по какой задаче?» → the caption is the report', async () => {
    const issue = await createIssue(project, {
      title: 'Справка о практике',
      kind: 'assignment',
      controller_id: rector.id,
      assignee_ids: [clerk.id],
    });
    telegramFiles['doc-ref'] = Buffer.concat([ZIP, Buffer.from('справка')]);

    calls = [];
    await sendFile(TG.clerk, doc('doc-ref', 'Справка.docx', { caption: 'Справка готова' })).expect(
      200,
    );
    const pick = sent(TG.clerk)[0]!;
    expect(pick.body.text).toContain('По какой задаче');
    expect(callbackData(pick)).toEqual([`a:fil:${issue.id}`, 'x']);

    calls = [];
    await tap(TG.clerk, `a:fil:${issue.id}`).expect(200);
    const review = await pendingReview(issue.id);
    expect(review?.report).toBe('Справка готова');
    expect(review?.attachments.map((a) => a.file_name)).toEqual(['Справка.docx']);
    expect(String(edits()[0]!.body.text)).toContain('Сдано на проверку · 📎 1 файл');

    // Nothing to hand in → the file is not kept.
    calls = [];
    await sendFile(TG.outsider, doc('doc-ref', 'Справка.docx')).expect(200);
    expect(sent(TG.outsider)[0]!.body.text).toContain('нет задач');
    expect(await staged(TG.outsider)).toBe(0);
  });

  it('an album is one hand-in: one question, every file attached', async () => {
    const issue = await createIssue(project, {
      title: 'Ведомости за семестр',
      kind: 'assignment',
      controller_id: rector.id,
      assignee_ids: [clerk.id],
    });
    telegramFiles['alb-1'] = Buffer.from('%PDF-1.4 ведомость 1');
    telegramFiles['alb-2'] = Buffer.from('%PDF-1.4 ведомость 2');

    calls = [];
    await sendFile(
      TG.clerk,
      doc('alb-1', 'Ведомость 1.pdf', { media_group_id: 'g1', caption: 'Обе ведомости' }),
    ).expect(200);
    await sendFile(TG.clerk, doc('alb-2', 'Ведомость 2.pdf', { media_group_id: 'g1' })).expect(200);
    expect(sent(TG.clerk)).toHaveLength(1);

    await tap(TG.clerk, `a:fil:${issue.id}`).expect(200);
    const review = await pendingReview(issue.id);
    expect(review?.report).toBe('Обе ведомости');
    expect(review?.attachments.map((a) => a.file_name)).toEqual([
      'Ведомость 1.pdf',
      'Ведомость 2.pdf',
    ]);
  });

  it('«Сдать» without a report, /cancel, size limit, a failed download, files only with a hand-in', async () => {
    const issue = await createIssue(project, {
      title: 'Протокол заседания',
      kind: 'assignment',
      controller_id: rector.id,
      assignee_ids: [clerk.id],
    });

    // Over Telegram's 20 MB download limit: refused before anything is kept.
    calls = [];
    await sendFile(
      TG.clerk,
      doc('huge', 'Запись.mp4', { document: { file_id: 'huge', file_size: 25 * 1024 * 1024 } }),
    ).expect(200);
    expect(sent(TG.clerk)[0]!.body.text).toContain('больше 20 МБ');
    expect(await staged(TG.clerk)).toBe(0);

    // /cancel drops the question together with its files.
    await tap(TG.clerk, `a:sub:${issue.id}`).expect(200);
    await sendFile(TG.clerk, doc('doc-a', 'Черновик.pdf')).expect(200);
    expect(await staged(TG.clerk)).toBe(1);
    await say(TG.clerk, '/cancel').expect(200);
    expect(await staged(TG.clerk)).toBe(0);

    // Telegram cannot give the file back: nothing is stored or handed in.
    await tap(TG.clerk, `a:sub:${issue.id}`).expect(200);
    await sendFile(TG.clerk, doc('broken', 'Протокол.pdf')).expect(200);
    calls = [];
    await say(TG.clerk, 'Протокол готов').expect(200);
    expect(sent(TG.clerk).at(-1)!.body.text).toContain('Не удалось получить файл');
    expect(await app.prisma.issueReview.count({ where: { issue_id: issue.id } })).toBe(0);
    expect(await app.prisma.attachment.count({ where: { issue_id: issue.id } })).toBe(0);

    // «Сдать на проверку» under the files: no report needed in this workspace.
    telegramFiles['doc-p'] = Buffer.from('%PDF-1.4 протокол');
    await tap(TG.clerk, `a:sub:${issue.id}`).expect(200);
    await sendFile(TG.clerk, doc('doc-p', 'Протокол.pdf')).expect(200);
    calls = [];
    await tap(TG.clerk, `a:snd:${issue.id}`).expect(200);
    const review = await pendingReview(issue.id);
    expect(review?.report).toBeNull();
    expect(review?.attachments.map((a) => a.file_name)).toEqual(['Протокол.pdf']);
    expect(String(edits()[0]!.body.text)).toContain('Сдано на проверку');
    // A second tap on the same button does not hand in twice.
    await tap(TG.clerk, `a:snd:${issue.id}`).expect(200);
    expect(await app.prisma.issueReview.count({ where: { issue_id: issue.id } })).toBe(1);

    // While the bot waits for a return remark, a file is not taken.
    await tap(TG.rector, `a:ret:${issue.id}`).expect(200);
    calls = [];
    await sendFile(TG.rector, doc('doc-p', 'Замечания.pdf')).expect(200);
    expect(sent(TG.rector)[0]!.body.text).toContain('жду текст — замечание');
    expect(await staged(TG.rector)).toBe(0);
    await say(TG.rector, '/cancel').expect(200);
  });

  it('programs are refused: by name at once, a renamed one at the hand-in (12.B6)', async () => {
    const issue = await createIssue(project, {
      title: 'Отчёт о практике студентов',
      kind: 'assignment',
      controller_id: rector.id,
      assignee_ids: [clerk.id],
    });
    await tap(TG.clerk, `a:sub:${issue.id}`).expect(200);

    calls = [];
    await sendFile(TG.clerk, doc('doc-exe', 'setup.exe')).expect(200);
    expect(sent(TG.clerk).at(-1)!.body.text).toContain('Программы и скрипты прикладывать нельзя');
    expect(await staged(TG.clerk)).toBe(0);

    // Named like a report, but a Windows program inside: refused when it is stored.
    telegramFiles['doc-fake'] = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(16, 0x90)]);
    await sendFile(TG.clerk, doc('doc-fake', 'Отчёт.pdf')).expect(200);
    calls = [];
    await say(TG.clerk, 'Отчёт во вложении').expect(200);
    expect(sent(TG.clerk).at(-1)!.body.text).toContain('Программы и скрипты прикладывать нельзя');
    expect(await app.prisma.issueReview.count({ where: { issue_id: issue.id } })).toBe(0);
    expect(await app.prisma.attachment.count({ where: { issue_id: issue.id } })).toBe(0);
  });
});

describe('Telegram bot: asking to move the deadline (9.T5)', () => {
  it('the assignee sends a date and a reason; the controller gets «Одобрить» / «Отклонить»', async () => {
    const issue = await createIssue(project, {
      title: 'Отчёт по НИР',
      kind: 'assignment',
      controller_id: rector.id,
      assignee_ids: [clerk.id],
      due_date: new Date(Date.now() + 3 * DAY).toISOString(),
    });

    // Right under the new assignment, and on the card.
    expect(callbackData(sent(TG.clerk).at(-1)!)).toEqual(
      expect.arrayContaining([`a:ack:${issue.id}`, `a:due:${issue.id}`]),
    );
    calls = [];
    await tap(TG.clerk, `c:${issue.id}`).expect(200);
    expect(callbackData(edits()[0]!)).toContain(`a:due:${issue.id}`);

    calls = [];
    await tap(TG.clerk, `a:due:${issue.id}`).expect(200);
    expect(sent(TG.clerk)[0]!.body.text).toContain('новый срок');

    // Not a date: the question stays open.
    calls = [];
    await say(TG.clerk, 'попозже').expect(200);
    expect(sent(TG.clerk)[0]!.body.text).toContain('Начните с даты');
    expect(
      await app.prisma.telegramPendingInput.count({ where: { chat_id: String(TG.clerk) } }),
    ).toBe(1);

    const target = new Date(Date.now() + 10 * DAY);
    const [d, m, y] = target
      .toLocaleDateString('ru-RU', {
        timeZone: 'Asia/Tashkent',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      })
      .split('.');
    calls = [];
    await say(TG.clerk, `${d}.${m}.${y} ждём данные от кафедр`).expect(200);
    const request = await app.prisma.deadlineChangeRequest.findFirst({
      where: { issue_id: issue.id },
    });
    expect(request).toMatchObject({ status: 'pending', reason: 'ждём данные от кафедр' });
    expect(request?.new_due_date.toISOString()).toBe(`${y}-${m}-${d}T12:00:00.000Z`);

    const answer = sent(TG.clerk).at(-1)!;
    expect(answer.body.text).toContain('Запрос на перенос срока');
    expect(callbackData(answer)).not.toContain(`a:due:${issue.id}`);
    const toRector = sent(TG.rector).at(-1)!;
    expect(toRector.body.text).toContain('просит перенести срок');
    expect(callbackData(toRector)).toEqual(
      expect.arrayContaining([`a:dok:${issue.id}`, `a:dno:${issue.id}`]),
    );

    // A second request waits for the decision on the first; the controller cannot ask.
    calls = [];
    await tap(TG.clerk, `a:due:${issue.id}`).expect(200);
    expect(answers()[0]!.body.text).toContain('ждёт решения');
    calls = [];
    await tap(TG.rector, `a:due:${issue.id}`).expect(200);
    expect(answers()[0]!.body).toMatchObject({ show_alert: true });
    expect(
      await app.prisma.telegramPendingInput.count({ where: { chat_id: String(TG.rector) } }),
    ).toBe(0);
  });
});

describe('parseDeadlineInput', () => {
  const tz = 'Asia/Tashkent';
  const now = new Date('2026-10-18T09:00:00Z');
  const parse = (text: string) => parseDeadlineInput(text, tz, now);

  it('reads a date with or without a year, then the reason', () => {
    expect(parse('30.10 ждём данные')).toEqual({
      new_due_date: '2026-10-30T12:00:00.000Z',
      reason: 'ждём данные',
    });
    expect(parse('30.10.2026 — нет подписи')).toMatchObject({
      new_due_date: '2026-10-30T12:00:00.000Z',
      reason: 'нет подписи',
    });
    expect(parse('1/11/27 сессия')).toMatchObject({ new_due_date: '2027-11-01T12:00:00.000Z' });
    // January from October means the coming January.
    expect(parse('15.01 сессия')).toMatchObject({ new_due_date: '2027-01-15T12:00:00.000Z' });
  });

  it('explains what is wrong', () => {
    expect(parse('завтра')).toMatchObject({ error: expect.stringContaining('Начните с даты') });
    expect(parse('17.10 вчера')).toMatchObject({ error: expect.stringContaining('прошла') });
    expect(parse('31.02 причина')).toMatchObject({ error: expect.stringContaining('нет') });
    expect(parse('30.10')).toMatchObject({ error: expect.stringContaining('причину') });
  });
});
