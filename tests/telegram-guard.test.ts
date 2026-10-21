// The guard around every Telegram update (Ф12 12.T1):
//   - one person may send TELEGRAM_RATE_LIMIT updates a minute: above it a message
//     gets one warning and the rest is dropped, a tap is answered «подождите»;
//     another person is not affected;
//   - a failure while handling an update is told to the person with the code for the
//     administrator, and Telegram still gets 200 (otherwise it resends the update);
//   - the log line of an update has the kind, the action, a pseudonym and the outcome
//     — never the text, the Telegram id or ids from button data.
//
// Runs against a live Postgres; created rows are removed in afterAll.

import { Writable } from 'node:stream';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.hoisted(() => {
  process.env.TELEGRAM_RATE_LIMIT = '5';
});

import { buildApp } from '../src/app.js';
import {
  BotRateLimiter,
  describeUpdate,
  telegramPseudonym,
} from '../src/modules/telegram/guard.js';

const TS = Date.now();
const EMAIL = `tgg-${TS}@example.com`;
// Far from epoch milliseconds, so a log timestamp never looks like one of them.
const BASE_ID = 7_100_000_000 + (TS % 100_000);
const TG = { busy: BASE_ID + 1, calm: BASE_ID + 2, broken: BASE_ID + 3 };
const SECRET_TEXT = `Секретный отчёт ${TS}`;
const webhook = '/api/v1/auth/telegram/webhook';

type BotCall = { method: string; body: Record<string, unknown> };
let app: FastifyInstance;
let userId: string;
let calls: BotCall[] = [];
let failSendMessage = false;
const logLines: string[] = [];

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
        message: { chat: { id: from }, message_id: 1 },
      },
    });
const sentTo = (chatId: number) =>
  calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === chatId);
const updateLogs = () =>
  logLines
    .map((l) => JSON.parse(l) as { msg: string; telegram?: Record<string, unknown> })
    .filter((l) => l.msg === 'telegram update');

beforeAll(async () => {
  const stream = new Writable({
    write(chunk, _enc, done) {
      logLines.push(...String(chunk).split('\n').filter(Boolean));
      done();
    },
  });
  app = await buildApp({ logger: { level: 'info', stream } as never });
  await app.ready();
  const user = await app.prisma.user.create({
    data: { email: EMAIL, display_name: 'Тестов Бот Охранович', email_verified: true },
  });
  userId = user.id;
  await app.prisma.authIdentity.createMany({
    data: [
      { user_id: user.id, provider: 'telegram', provider_user_id: String(TG.busy) },
      { user_id: user.id, provider: 'email', provider_email: EMAIL },
    ],
  });
});

afterAll(async () => {
  await app.prisma.user.deleteMany({ where: { id: userId } });
  await app.close();
});

beforeEach(() => {
  calls = [];
  failSendMessage = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = String(url).split('/').pop()!;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ method, body });
      if (method === 'sendMessage' && failSendMessage && !String(body.text).startsWith('⚠️')) {
        return { ok: false, status: 500, json: async () => ({ ok: false }) };
      }
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the limit per person', () => {
  it('above 5 updates a minute: one warning, then silence; others are not affected', async () => {
    for (let n = 0; n < 5; n += 1) {
      expect((await say(TG.busy, '/help')).status).toBe(200);
    }
    expect(sentTo(TG.busy)).toHaveLength(5);

    for (let n = 0; n < 3; n += 1) {
      expect((await say(TG.busy, '/help')).status).toBe(200);
    }
    const extra = sentTo(TG.busy).slice(5);
    expect(extra).toHaveLength(1);
    expect(String(extra[0]!.body.text)).toMatch(/Слишком много запросов подряд\. Подождите \d+ с/);

    // A tap above the limit is still answered, so the button stops spinning.
    await tap(TG.busy, 'l:my:1');
    const answer = calls.find((c) => c.method === 'answerCallbackQuery');
    expect(String(answer?.body.text)).toContain('Подождите');

    // Someone else is not limited by that.
    await say(TG.calm, '/help');
    expect(sentTo(TG.calm)).toHaveLength(1);
    expect(updateLogs().filter((l) => l.telegram?.outcome === 'rate_limited').length).toBe(4);
  });

  it('the window starts over after a minute', () => {
    let now = 0;
    const limiter = new BotRateLimiter(2, () => now);
    expect(limiter.hit(1)).toMatchObject({ allowed: true });
    expect(limiter.hit(1)).toMatchObject({ allowed: true });
    expect(limiter.hit(1)).toMatchObject({ allowed: false, warn: true, retryAfter: 60 });
    now = 30_000;
    expect(limiter.hit(1)).toMatchObject({ allowed: false, warn: false, retryAfter: 30 });
    now = 60_000;
    expect(limiter.hit(1)).toMatchObject({ allowed: true });
  });
});

describe('a failure', () => {
  it('is told to the person with a code, and Telegram still gets 200', async () => {
    failSendMessage = true;
    const res = await say(TG.broken, '/help');
    expect(res.status).toBe(200);
    const notice = sentTo(TG.broken).find((c) => String(c.body.text).startsWith('⚠️'));
    expect(String(notice?.body.text)).toMatch(/сообщите администратору код [0-9A-F]{8}/);
    const line = updateLogs().find((l) => l.telegram?.outcome === 'error');
    expect(line?.telegram).toMatchObject({
      kind: 'command',
      action: '/help',
      error: 'BAD_REQUEST',
    });
  });
});

describe('the log of updates', () => {
  it('has no text, no Telegram id and no ids from buttons', async () => {
    await say(TG.calm, SECRET_TEXT);
    await tap(TG.calm, 'a:approve:7b0c2a9e-1111-4222-8333-944455556666');
    const all = logLines.join('\n');
    expect(all).not.toContain(SECRET_TEXT);
    expect(all).not.toContain(String(TG.calm));
    expect(all).not.toContain('7b0c2a9e');
    const lines = updateLogs().filter((l) => l.telegram?.user === telegramPseudonym(TG.calm));
    expect(lines.map((l) => l.telegram?.action)).toEqual(
      expect.arrayContaining(['/help', 'text', 'a:approve']),
    );
    expect(lines.every((l) => typeof l.telegram?.ms === 'number')).toBe(true);
  });

  it('describes updates without what is personal', () => {
    expect(
      describeUpdate({ callback_query: { id: '1', from: { id: 1 }, data: 'winv:a:abc123' } }),
    ).toEqual({
      kind: 'callback',
      action: 'winv:a',
    });
    expect(describeUpdate({ message: { chat: { id: 1 }, text: '/start 9f8e7d6c' } })).toEqual({
      kind: 'command',
      action: '/start',
    });
    expect(
      describeUpdate({
        message: { chat: { id: 1 }, document: { file_id: 'x' }, caption: 'Отчёт' },
      }),
    ).toEqual({ kind: 'file', action: 'file' });
  });
});
