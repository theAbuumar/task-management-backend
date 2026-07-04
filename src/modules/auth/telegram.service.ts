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

/**
 * callback_data prefixes on the workspace-invite inline-buttons; the invite token
 * follows. Kept short so `prefix + uuid` stays within Telegram's 64-byte callback_data
 * limit (9 + 36 = 45 bytes).
 */
export const WS_INVITE_ACCEPT_PREFIX = 'winv:a:';
export const WS_INVITE_DECLINE_PREFIX = 'winv:d:';

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
 * Whether the Telegram bot is configured. Lets best-effort senders (e.g. the workspace
 * member-invite fan-out) skip the Telegram channel silently rather than throwing when
 * the bot is not set up.
 */
export function telegramConfigured(): boolean {
  return Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_BOT_USERNAME);
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

export interface WorkspaceInvitePromptOptions {
  /** The invite token; rides in the accept/decline callback_data. */
  token: string;
  workspaceName: string;
  inviterName: string;
  role: string;
}

/**
 * Deliver a workspace invite to a Telegram-linked user: a message with Accept/Decline
 * inline buttons whose `callback_data` carries `winv:a:<token>` / `winv:d:<token>`. The
 * webhook routes the tap to the member-invite service. `chatId` for a private chat
 * equals the user's telegram id, so we message them directly.
 */
export async function sendWorkspaceInvitePrompt(
  chatId: number,
  opts: WorkspaceInvitePromptOptions,
): Promise<void> {
  await callBotApi('sendMessage', {
    chat_id: chatId,
    text: [
      `${opts.inviterName} invited you to join the "${opts.workspaceName}" workspace as ${opts.role}.`,
      '',
      'Do you want to accept?',
    ].join('\n'),
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Accept', callback_data: `${WS_INVITE_ACCEPT_PREFIX}${opts.token}` },
          { text: '❌ Decline', callback_data: `${WS_INVITE_DECLINE_PREFIX}${opts.token}` },
        ],
      ],
    },
  });
}

export interface IssueNotificationOptions {
  /** Human-readable issue key, e.g. "MOB-123". */
  issueKey: string;
  issueTitle: string;
  projectName: string;
  /** Who created/assigned the task — shown so the recipient knows the source. */
  actorName: string;
  /**
   * true when the recipient is a named assignee (created-with-assignee, or added later);
   * false for the "task with no assignee" broadcast to every project member.
   */
  assigned: boolean;
}

/**
 * Notify a Telegram-linked user about a task: either that they were assigned one
 * (`assigned`), or that a new unassigned task appeared in a project they belong to.
 * `chatId` for a private chat equals the user's telegram id, so we message them directly.
 */
export async function sendIssueNotification(
  chatId: number,
  opts: IssueNotificationOptions,
): Promise<void> {
  const headline = opts.assigned
    ? `📋 ${opts.actorName} assigned you a task`
    : `🆕 ${opts.actorName} created a task in ${opts.projectName}`;
  await callBotApi('sendMessage', {
    chat_id: chatId,
    text: [headline, '', `${opts.issueKey}  ${opts.issueTitle}`].join('\n'),
  });
}

/**
 * Deliver a 6-digit account-deletion code to a Telegram-only account through the bot
 * (the analogue of {@link sendOtpEmail} for accounts with no email). The chat id for a
 * private chat equals the user's telegram id, so we message them directly.
 */
export async function sendDeletionCode(chatId: number, code: string): Promise<void> {
  await callBotApi('sendMessage', {
    chat_id: chatId,
    text: [
      'Use this code to permanently delete your Task Management account:',
      '',
      `    ${code}`,
      '',
      'The code expires in 10 minutes. If you did not request account deletion, ignore this message.',
    ].join('\n'),
  });
}

/** Acknowledge a tapped inline button so Telegram stops the loading spinner. */
export async function answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
  await callBotApi('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
}
