// «🤖 Новое поручение» in the Telegram bot (Ф11 11.T1): a phrase becomes a draft
// card; «Изменить» applies a correction; «Создать» asks for the project and
// creates the assignment in the user's rights, marked ai_assisted; «Отмена» and
// /cancel drop the draft; AI errors keep the question open. A fake AI provider and
// a mocked Bot API (fetch) — no network.

import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.hoisted(() => {
  process.env.AI_ENABLED = 'true';
  process.env.AI_API_KEY = 'test-ai-key';
});

import { buildApp } from '../src/app.js';
import {
  AiProviderError,
  setAiProvider,
  type AiJsonRequest,
  type AiProvider,
} from '../src/lib/ai/provider.js';

const TS = Date.now();
const SLUG = `tga-${TS}`;
const emails = {
  rector: `tga-rector-${TS}@example.com`,
  dean: `tga-dean-${TS}@example.com`,
  guest: `tga-guest-${TS}@example.com`,
};
const TG = { rector: TS + 11, dean: TS + 12, guest: TS + 13 };

type Actor = { id: string; token: string; name: string };
type BotCall = { method: string; body: Record<string, unknown> };

let app: FastifyInstance;
const actors = {} as Record<keyof typeof emails, Actor>;
let projectA: string;
let projectB: string;
let calls: BotCall[] = [];
const requests: AiJsonRequest[] = [];
let answer: (r: AiJsonRequest) => unknown = () => ({ basis: null, items: [] });
let failWith: AiProviderError | null = null;

const provider: AiProvider = {
  name: 'fake',
  model: 'fake-model',
  async json(r) {
    requests.push(r);
    if (failWith) throw failWith;
    return { value: answer(r), usage: { input_tokens: 1, output_tokens: 1 }, model: 'fake-model' };
  },
  text: async () => {
    throw new Error('unused');
  },
  agent: async () => {
    throw new Error('unused');
  },
};

const api = (path: string) => `/api/v1/workspaces/${SLUG}${path}`;
const webhook = '/api/v1/auth/telegram/webhook';
const say = (from: number, text: string) =>
  request(app.server)
    .post(webhook)
    .send({ message: { chat: { id: from }, from: { id: from }, text } });
const tap = (from: number, data: string) =>
  request(app.server)
    .post(webhook)
    .send({
      callback_query: {
        id: `cq-${Math.random()}`,
        from: { id: from },
        data,
        message: { chat: { id: from }, message_id: 900 },
      },
    });
const sentTo = (chat: number) =>
  calls.filter(
    (c) =>
      (c.method === 'sendMessage' || c.method === 'editMessageText') && c.body.chat_id === chat,
  );
const lastText = (chat: number) => String(sentTo(chat).at(-1)?.body.text ?? '');
const buttons = (chat: number) =>
  (
    (sentTo(chat).at(-1)?.body.reply_markup as { inline_keyboard?: { callback_data?: string }[][] })
      ?.inline_keyboard ?? []
  )
    .flat()
    .map((b) => b.callback_data);
const alerts = () =>
  calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => String(c.body.text ?? ''));

function refOf(r: AiJsonRequest, name: string): string {
  const m = new RegExp(`^([PD]\\d+) \\| ${name}`, 'm').exec(r.system);
  if (!m) throw new Error(`no label for ${name}`);
  return m[1]!;
}

function item(over: Record<string, unknown>) {
  return {
    title: 'Подготовить отчёт о практике',
    description: '',
    assignee_ref: null,
    department_refs: [],
    controller_ref: null,
    due_date: '2099-11-01',
    priority: 'high',
    basis: null,
    assignee_text: null,
    source_quote: null,
    ...over,
  };
}

async function register(email: string): Promise<Actor> {
  const name = email.split('@')[0]!;
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: 'Password123!', display_name: name });
  return { id: res.body.user.id, token: res.body.access_token, name };
}

const as = (actor: Actor) => ({
  post: (url: string, body?: object) =>
    request(app.server)
      .post(url)
      .set('Authorization', `Bearer ${actor.token}`)
      .send(body ?? {}),
});

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  setAiProvider(provider);
  for (const k of Object.keys(emails) as (keyof typeof emails)[]) {
    actors[k] = await register(emails[k]);
    await app.prisma.authIdentity.create({
      data: { user_id: actors[k].id, provider: 'telegram', provider_user_id: String(TG[k]) },
    });
  }
  await as(actors.rector).post('/api/v1/workspaces', { name: 'Университет', slug: SLUG });
  await as(actors.rector).post(api('/members'), { user_id: actors.dean.id, role: 'member' });
  await as(actors.rector).post(api('/members'), { user_id: actors.guest.id, role: 'guest' });
  projectA = (
    await as(actors.rector).post(api('/projects'), { name: 'Ректорат', identifier: 'TGA' })
  ).body.id;
  projectB = (await as(actors.rector).post(api('/projects'), { name: 'Наука', identifier: 'TGN' }))
    .body.id;
});

beforeEach(() => {
  calls = [];
  requests.length = 0;
  failWith = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (!url.startsWith('https://api.telegram.org/bot')) throw new Error(`unexpected ${url}`);
      calls.push({ method: url.split('/').pop()!, body: JSON.parse(init?.body ?? '{}') });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  setAiProvider(null);
  delete process.env.AI_ENABLED;
  delete process.env.AI_API_KEY;
  const list = Object.values(emails);
  await app.prisma.workspace.deleteMany({ where: { slug: SLUG } });
  await app.prisma.telegramAiDraft.deleteMany({
    where: { chat_id: { in: Object.values(TG).map(String) } },
  });
  await app.prisma.refreshToken.deleteMany({ where: { user: { email: { in: list } } } });
  await app.prisma.user.deleteMany({ where: { email: { in: list } } });
  await app.close();
});

describe('Telegram «Новое поручение» (11.T1)', () => {
  it('the menu offers it when AI is on', async () => {
    await say(TG.rector, '/start');
    const keyboard = (sentTo(TG.rector)[0]!.body.reply_markup as { keyboard: { text: string }[][] })
      .keyboard;
    expect(keyboard.flat().map((b) => b.text)).toContain('🤖 Новое поручение');
  });

  it('phrase → draft card → correction → project → created assignment', async () => {
    await say(TG.rector, '🤖 Новое поручение');
    expect(lastText(TG.rector)).toContain('Опишите поручение одним сообщением');

    answer = (r) => ({ basis: null, items: [item({ assignee_ref: refOf(r, actors.dean.name) })] });
    await say(TG.rector, 'Декану до 1 ноября подготовить отчёт о практике');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.content.map((p) => (p.type === 'text' ? p.text : '')).join()).toContain(
      'Декану до 1 ноября подготовить отчёт о практике',
    );
    let card = lastText(TG.rector);
    expect(card).toContain('Черновик поручения');
    expect(card).toContain('подготовлен AI, проверьте');
    expect(card).toContain(actors.dean.name);
    expect(card).toContain('01.11.2099');
    expect(buttons(TG.rector)).toEqual(['ai:ok', 'ai:ed', 'ai:x']);
    // Nothing exists until «Создать».
    expect(
      await app.prisma.issue.count({ where: { project_id: { in: [projectA, projectB] } } }),
    ).toBe(0);

    await tap(TG.rector, 'ai:ed');
    expect(lastText(TG.rector)).toContain('Что поправить?');
    answer = (r) => ({
      basis: null,
      items: [item({ assignee_ref: refOf(r, actors.dean.name), due_date: '2099-10-25' })],
    });
    await say(TG.rector, 'срок — 25 октября');
    const correction = requests[1]!.content
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('\n');
    expect(correction).toContain('текущий черновик');
    expect(correction).toContain('Срок: 2099-11-01');
    expect(correction).toContain('срок — 25 октября');
    card = lastText(TG.rector);
    expect(card).toContain('25.10.2099');

    // Two projects: the bot asks where.
    await tap(TG.rector, 'ai:ok');
    expect(lastText(TG.rector)).toContain('В каком проекте создать?');
    expect(buttons(TG.rector)).toEqual([`ai:p:${projectA}`, `ai:p:${projectB}`, 'ai:x']);
    await tap(TG.rector, `ai:p:${projectB}`);
    expect(lastText(TG.rector)).toContain('Создано поручение <b>TGN-1</b>');

    const issue = await app.prisma.issue.findFirstOrThrow({
      where: { project_id: projectB },
      include: { assignees: true },
    });
    expect(issue).toMatchObject({
      kind: 'assignment',
      ai_assisted: true,
      created_by_id: actors.rector.id,
      title: 'Подготовить отчёт о практике',
      priority: 'high',
    });
    expect(issue.due_date?.toISOString()).toBe('2099-10-25T12:00:00.000Z');
    expect(issue.assignees).toMatchObject([{ user_id: actors.dean.id, is_primary: true }]);
    // The draft is used up: a second tap does not create a copy.
    await tap(TG.rector, `ai:p:${projectB}`);
    expect(await app.prisma.issue.count({ where: { project_id: projectB } })).toBe(1);
    expect(await app.prisma.telegramAiDraft.count({ where: { chat_id: String(TG.rector) } })).toBe(
      0,
    );
  });

  it('without an assignee «Создать» asks for a correction; «Отмена» drops the draft', async () => {
    await say(TG.dean, '/new');
    answer = () => ({ basis: null, items: [item({ assignee_text: 'Сидоров' })] });
    await say(TG.dean, 'Сидорову сделать отчёт');
    expect(lastText(TG.dean)).toContain('не выбран');
    expect(lastText(TG.dean)).toContain('Сидоров');
    await tap(TG.dean, 'ai:ok');
    expect(alerts().at(-1)).toContain('Не выбран исполнитель');
    await tap(TG.dean, 'ai:x');
    expect(lastText(TG.dean)).toContain('Черновик удалён');
    expect(await app.prisma.telegramAiDraft.count({ where: { chat_id: String(TG.dean) } })).toBe(0);
  });

  it('an AI failure keeps the question open; /cancel ends it', async () => {
    await say(TG.dean, '/new');
    failWith = new AiProviderError('AI_TIMEOUT', 'slow');
    await say(TG.dean, 'Подготовить справку');
    expect(lastText(TG.dean)).toContain('AI не ответил вовремя');
    failWith = null;
    answer = (r) => ({
      basis: null,
      items: [item({ assignee_ref: refOf(r, actors.rector.name) })],
    });
    await say(TG.dean, 'Подготовить справку');
    expect(lastText(TG.dean)).toContain('Черновик поручения');
    await say(TG.dean, '/cancel');
    expect(await app.prisma.telegramAiDraft.count({ where: { chat_id: String(TG.dean) } })).toBe(0);
  });

  it('a guest cannot create assignments from the bot', async () => {
    await say(TG.guest, '/new');
    expect(lastText(TG.guest)).toContain('Нет пространства, где вы можете создавать поручения');
    expect(requests).toHaveLength(0);
  });
});
