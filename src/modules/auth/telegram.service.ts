// Telegram bot transport (auth_tz.md §7).
//
// The provider-transport seam for the Telegram deep-link login, mirroring
// google.service.ts / github.service.ts. Two responsibilities:
//   1. Build the `https://t.me/<bot>?start=<token>` deep-link the site hands the user.
//   2. Talk to the Telegram Bot API (sendMessage / answerCallbackQuery) so the bot
//      can reply to `/start <token>` with a confirm button and acknowledge the click.
// It also declares the minimal Update shapes the webhook consumes. All credentials
// come from validated env (config/env.ts); the flow fails loudly if unconfigured.
// The token lifecycle (DB) lives in telegram-login.service.ts — this module never
// touches Prisma.

import { config } from '../../config/index.js';
import { AppError } from '../../lib/errors.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const TELEGRAM_DEEP_LINK_BASE = 'https://t.me';

/** callback_data prefix on the confirm inline-button; the token follows it. */
export const CONFIRM_CALLBACK_PREFIX = 'confirm:';

interface TelegramConfig {
  botToken: string;
  botUsername: string;
}

/** Resolve the Telegram bot config, or fail if the flow is used unconfigured. */
function requireTelegramConfig(): TelegramConfig {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME } = config;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_BOT_USERNAME) {
    throw AppError.badRequest('Telegram sign-in is not configured');
  }
  return { botToken: TELEGRAM_BOT_TOKEN, botUsername: TELEGRAM_BOT_USERNAME };
}

/**
 * Build the deep-link that opens the bot with the login token as the `start`
 * payload. The token is base64url (only `A-Za-z0-9_-`, ≤64 chars), which is exactly
 * what Telegram's `start` parameter accepts.
 */
export function buildTelegramDeepLink(token: string): string {
  const { botUsername } = requireTelegramConfig();
  return `${TELEGRAM_DEEP_LINK_BASE}/${botUsername}?start=${token}`;
}

// ─── Telegram Update shapes (only the fields we consume) ────────────────────────

export interface TelegramUser {
  id: number;
  first_name?: string;
  username?: string;
}

export interface TelegramMessage {
  chat: { id: number };
  from?: TelegramUser;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: { chat: { id: number }; message_id: number };
}

export interface TelegramUpdate {
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

// ─── Bot API calls ──────────────────────────────────────────────────────────────

/** POST a method on the Bot API. Best-effort: logs to the error path via throw on !ok. */
async function callBotApi(method: string, body: unknown): Promise<void> {
  const { botToken } = requireTelegramConfig();
  const res = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw AppError.badRequest(`Telegram ${method} failed`);
}

/**
 * Reply to a `/start <token>` with a single inline button that, when tapped, sends
 * back a `callback_query` carrying `confirm:<token>` — the click that confirms the
 * login (auth_tz.md §7 step 4).
 */
export async function sendConfirmPrompt(chatId: number, token: string): Promise<void> {
  await callBotApi('sendMessage', {
    chat_id: chatId,
    text: 'Tap the button below to confirm you want to sign in to Task Management.',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Confirm sign-in', callback_data: `${CONFIRM_CALLBACK_PREFIX}${token}` }],
      ],
    },
  });
}

/** Send a plain informational message (e.g. an expired/invalid link notice). */
export async function sendBotMessage(chatId: number, text: string): Promise<void> {
  await callBotApi('sendMessage', { chat_id: chatId, text });
}

/** Acknowledge a tapped inline button so Telegram stops the loading spinner. */
export async function answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
  await callBotApi('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
}
