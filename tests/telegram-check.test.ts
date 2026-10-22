// Pre-show Telegram check (13.D3, `bash dev/stand.sh telegram`): what has to be true
// for the bot on the real stand — token of the named bot, webhook on this stand with
// button presses, the presenter's id linked to a demo account, a message reaching
// them. Each failure names the fix. The Bot API is a fake here; no database needed.

import { describe, expect, it } from 'vitest';
import {
  checkTelegram,
  WEBHOOK_PATH,
  type BotApiCall,
  type TelegramCheckInput,
} from '../src/lib/telegram-check.js';

const BASE = 'https://tasks.example.edu';
const NOW = new Date('2026-10-22T09:00:00Z');

/** A healthy bot; `overrides` replace whole method replies. */
function fakeBot(overrides: Record<string, Awaited<ReturnType<BotApiCall>>> = {}) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const replies: Record<string, Awaited<ReturnType<BotApiCall>>> = {
    getMe: { ok: true, result: { username: 'UniTasksBot', first_name: 'Поручения' } },
    getWebhookInfo: {
      ok: true,
      result: {
        url: `${BASE}${WEBHOOK_PATH}`,
        pending_update_count: 0,
        allowed_updates: ['message', 'callback_query'],
      },
    },
    sendMessage: { ok: true, result: { message_id: 1 } },
    ...overrides,
  };
  const call: BotApiCall = async (method, body) => {
    calls.push({ method, body });
    return replies[method] ?? { ok: false, description: 'unexpected method' };
  };
  return { call, calls };
}

function input(over: Partial<TelegramCheckInput> = {}): TelegramCheckInput {
  return {
    token: '123:abc',
    username: 'UniTasksBot',
    baseUrl: BASE,
    demoTelegramId: '555000111',
    call: fakeBot().call,
    findLinkedAccount: async () => 'Абдуллоев Шерзод Камолович',
    now: NOW,
    ...over,
  };
}

const failures = (r: Awaited<ReturnType<typeof checkTelegram>>) =>
  r.lines.filter((l) => l.status === 'fail').map((l) => l.text);

describe('Telegram check before the show', () => {
  it('all good: token, webhook, linked presenter, message sent to them', async () => {
    const bot = fakeBot();
    const r = await checkTelegram(input({ call: bot.call }));
    expect(r.ok).toBe(true);
    expect(failures(r)).toEqual([]);
    expect(r.lines.map((l) => l.text).join('\n')).toContain('@UniTasksBot');
    const sent = bot.calls.find((c) => c.method === 'sendMessage');
    expect(sent?.body.chat_id).toBe('555000111');
    expect(String(sent?.body.text)).toContain('Абдуллоев Шерзод Камолович');
  });

  it('no token or bot name: stops at once and says where to put them', async () => {
    const bot = fakeBot();
    const r = await checkTelegram(input({ token: undefined, call: bot.call }));
    expect(r.ok).toBe(false);
    expect(failures(r)[0]).toContain('TELEGRAM_BOT_TOKEN');
    expect(bot.calls).toHaveLength(0);
  });

  it('a revoked token: says so and makes no other calls', async () => {
    const bot = fakeBot({ getMe: { ok: false, description: 'Unauthorized' } });
    const r = await checkTelegram(input({ call: bot.call }));
    expect(r.ok).toBe(false);
    expect(failures(r)[0]).toContain('Unauthorized');
    expect(bot.calls.map((c) => c.method)).toEqual(['getMe']);
  });

  it('the token of another bot than TELEGRAM_BOT_USERNAME fails', async () => {
    const r = await checkTelegram(input({ username: '@OtherBot' }));
    expect(r.ok).toBe(false);
    expect(failures(r)[0]).toContain('@UniTasksBot');
    expect(failures(r)[0]).toContain('OtherBot');
  });

  it('webhook missing, elsewhere or without button presses fails with «stand.sh webhook»', async () => {
    for (const result of [
      { url: '' },
      { url: 'https://old.example.org/api/v1/auth/telegram/webhook' },
      { url: `${BASE}${WEBHOOK_PATH}`, allowed_updates: ['message'] },
    ]) {
      const r = await checkTelegram(
        input({ call: fakeBot({ getWebhookInfo: { ok: true, result } }).call }),
      );
      expect(r.ok).toBe(false);
      expect(failures(r).join(' ')).toContain('stand.sh webhook');
    }
  });

  it('a past delivery error and a queue are warnings, not failures', async () => {
    const r = await checkTelegram(
      input({
        call: fakeBot({
          getWebhookInfo: {
            ok: true,
            result: {
              url: `${BASE}${WEBHOOK_PATH}`,
              pending_update_count: 3,
              last_error_date: NOW.getTime() / 1000 - 600,
              last_error_message: 'Connection timed out',
            },
          },
        }).call,
      }),
    );
    expect(r.ok).toBe(true);
    const warns = r.lines.filter((l) => l.status === 'warn').map((l) => l.text);
    expect(warns.join('\n')).toContain('10 мин назад');
    expect(warns.join('\n')).toContain('Connection timed out');
    expect(warns.join('\n')).toContain('3');
  });

  it('an http stand (laptop) skips the webhook with a warning and still messages the presenter', async () => {
    const bot = fakeBot();
    const r = await checkTelegram(input({ baseUrl: 'http://localhost', call: bot.call }));
    expect(r.ok).toBe(true);
    expect(r.lines.some((l) => l.status === 'warn' && l.text.includes('https'))).toBe(true);
    expect(bot.calls.map((c) => c.method)).toEqual(['getMe', 'sendMessage']);
  });

  it('no DEMO_TELEGRAM_ID fails: the bot would not write to the presenter', async () => {
    const r = await checkTelegram(input({ demoTelegramId: undefined }));
    expect(r.ok).toBe(false);
    expect(failures(r)[0]).toContain('DEMO_TELEGRAM_ID');
  });

  it('an id not linked to any account asks for demo-reset', async () => {
    const r = await checkTelegram(input({ findLinkedAccount: async () => null }));
    expect(r.ok).toBe(false);
    expect(failures(r)[0]).toContain('demo-reset');
  });

  it('the presenter never pressed «Старт»: the message fails and says what to press', async () => {
    const r = await checkTelegram(
      input({
        call: fakeBot({
          sendMessage: {
            ok: false,
            description: "Forbidden: bot can't initiate conversation with a user",
          },
        }).call,
      }),
    );
    expect(r.ok).toBe(false);
    expect(failures(r)[0]).toContain('«Старт»');
    expect(failures(r)[0]).toContain('@UniTasksBot');
  });
});
