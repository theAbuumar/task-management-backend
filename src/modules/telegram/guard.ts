// What wraps every Telegram update (Ф12 12.T1; the bot lives in the backend in the
// 6-day mode of ADR-011):
//   - a per-person limit: at most TELEGRAM_RATE_LIMIT updates a minute from one
//     Telegram user; above it a tap gets «подождите N с», a message gets one warning
//     per minute and the rest is dropped;
//   - a failure never goes silent and never makes Telegram resend the update: the
//     person gets «не получилось…» with the code for the administrator (the start of
//     the request id, as on the site — 12.B9), Telegram gets 200;
//   - one structured log line per update with no personal data: the kind of update,
//     the action without ids or text, a pseudonym of the Telegram user, the outcome
//     and the time it took.

import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { config } from '../../config/index.js';
import { AppError } from '../../lib/errors.js';
import {
  answerCallbackQuery,
  sendBotMessage,
  type TelegramUpdate,
} from '../auth/telegram.service.js';

const WINDOW_MS = 60_000;

interface Window {
  start: number;
  count: number;
  warned: boolean;
}

/** Fixed one-minute windows per Telegram user, in this process. */
export class BotRateLimiter {
  private readonly windows = new Map<number, Window>();

  constructor(
    private readonly max: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count an update. `warn` — the first refused one in this window. */
  hit(userId: number): { allowed: boolean; warn: boolean; retryAfter: number } {
    const now = this.now();
    let w = this.windows.get(userId);
    if (!w || now - w.start >= WINDOW_MS) {
      if (this.windows.size > 10_000) this.prune(now);
      w = { start: now, count: 0, warned: false };
      this.windows.set(userId, w);
    }
    w.count += 1;
    const retryAfter = Math.max(1, Math.ceil((w.start + WINDOW_MS - now) / 1000));
    if (w.count <= this.max) return { allowed: true, warn: false, retryAfter };
    const warn = !w.warned;
    w.warned = true;
    return { allowed: false, warn, retryAfter };
  }

  private prune(now: number): void {
    for (const [id, w] of this.windows) {
      if (now - w.start >= WINDOW_MS) this.windows.delete(id);
    }
  }
}

let limiter: BotRateLimiter | null = null;
function botLimiter(): BotRateLimiter {
  limiter ??= new BotRateLimiter(config.TELEGRAM_RATE_LIMIT);
  return limiter;
}

/** A stable pseudonym of a Telegram user for logs (keyed hash: ids are guessable). */
export function telegramPseudonym(telegramId: number): string {
  const digest = crypto
    .createHmac('sha256', config.JWT_ACCESS_SECRET)
    .update(`telegram-log:${telegramId}`)
    .digest('hex');
  return `tg_${digest.slice(0, 12)}`;
}

/**
 * What the update asks for, without anything personal: a button's data up to its
 * first id (`a:approve`, `l:overdue`), a command name, or just «text» / «file».
 */
export function describeUpdate(update: TelegramUpdate): { kind: string; action: string } {
  if (update.callback_query) {
    const parts = (update.callback_query.data ?? '').split(':');
    const words: string[] = [];
    for (const part of parts) {
      if (!/^[a-z_]{1,12}$/i.test(part)) break;
      words.push(part);
    }
    return { kind: 'callback', action: words.join(':') || 'unknown' };
  }
  const message = update.message;
  if (!message) return { kind: 'other', action: 'unknown' };
  if (message.document || message.photo) return { kind: 'file', action: 'file' };
  const text = (message.text ?? '').trim();
  if (text.startsWith('/')) {
    const command = text.split(/[\s@]/)[0]!.toLowerCase();
    return { kind: 'command', action: /^\/[a-z_]{1,32}$/.test(command) ? command : '/other' };
  }
  return { kind: 'message', action: text ? 'text' : 'empty' };
}

function senderOf(update: TelegramUpdate): { userId: number | null; chatId: number | null } {
  if (update.callback_query) {
    const cq = update.callback_query;
    return { userId: cq.from.id, chatId: cq.message?.chat.id ?? cq.from.id };
  }
  const message = update.message;
  return { userId: message?.from?.id ?? null, chatId: message?.chat.id ?? null };
}

/** The code people tell the administrator: the start of the request id (12.B9). */
function adminCode(request: FastifyRequest): string {
  return String(request.id).replace(/-/g, '').slice(0, 8).toUpperCase();
}

/**
 * Run `handle` for one update under the limit, report a failure to the person and log
 * the outcome. Never throws: Telegram must get 200, or it sends the update again.
 */
export async function guardBotUpdate(
  request: FastifyRequest,
  update: TelegramUpdate,
  handle: () => Promise<void>,
): Promise<void> {
  const started = Date.now();
  const { kind, action } = describeUpdate(update);
  const { userId, chatId } = senderOf(update);
  const log = (outcome: string, extra: Record<string, unknown> = {}) =>
    request.log.info(
      {
        telegram: {
          kind,
          action,
          user: userId === null ? null : telegramPseudonym(userId),
          outcome,
          ms: Date.now() - started,
          ...extra,
        },
      },
      'telegram update',
    );

  if (userId !== null) {
    const verdict = botLimiter().hit(userId);
    if (!verdict.allowed) {
      const wait = `⏳ Слишком много запросов подряд. Подождите ${verdict.retryAfter} с и повторите.`;
      if (update.callback_query) {
        await answerCallbackQuery(update.callback_query.id, wait).catch(() => undefined);
      } else if (verdict.warn && chatId !== null) {
        await sendBotMessage(chatId, wait).catch(() => undefined);
      }
      log('rate_limited');
      return;
    }
  }

  try {
    await handle();
    log('ok');
  } catch (err) {
    const code = adminCode(request);
    const text =
      `⚠️ Не получилось выполнить действие — сервер ответил ошибкой. ` +
      `Попробуйте ещё раз через минуту. Если повторится, сообщите администратору код ${code}.`;
    if (update.callback_query) {
      await answerCallbackQuery(update.callback_query.id, text, true).catch(() => undefined);
    } else if (chatId !== null) {
      await sendBotMessage(chatId, text).catch(() => undefined);
    }
    // The error object goes to the log as usual (stack, code) — the update itself does not.
    request.log.error(
      { err, telegram: { kind, action, code: err instanceof AppError ? err.code : 'INTERNAL' } },
      'telegram update failed',
    );
    log('error', { error: err instanceof AppError ? err.code : 'INTERNAL' });
  }
}
