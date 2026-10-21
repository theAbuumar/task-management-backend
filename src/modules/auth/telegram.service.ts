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

/** A file sent as a document (`file_name` and `mime_type` come from the sender). */
export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** One size of a sent photo; Telegram lists them from the smallest to the largest. */
export interface TelegramPhotoSize {
  file_id: string;
  file_size?: number;
}

export interface TelegramMessage {
  chat: { id: number };
  from?: TelegramUser;
  text?: string;
  /** The text under a document or photo. */
  caption?: string;
  document?: TelegramDocument;
  photo?: TelegramPhotoSize[];
  /** Shared by the documents/photos of one album; each arrives as its own update. */
  media_group_id?: string;
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

/** Inline keyboard markup (Bot API `InlineKeyboardMarkup`). */
export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}
export type ReplyMarkup =
  | { inline_keyboard: InlineButton[][] }
  | { keyboard: { text: string }[][]; resize_keyboard?: boolean; is_persistent?: boolean }
  | { force_reply: true; input_field_placeholder?: string };

/** POST a method on the Bot API and return its `result`. Throws on failure. */
export async function callBotApi<T = unknown>(method: string, body: unknown): Promise<T> {
  const { botToken } = requireTelegramConfig();
  const res = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw AppError.badRequest(`Telegram ${method} failed`);
  const json = (await res.json().catch(() => ({}))) as { result?: T };
  return json.result as T;
}

/**
 * Reply to a `/start <token>` with a single inline button that, when tapped, sends
 * back a `callback_query` carrying `confirm:<token>` — the click that confirms the
 * login (auth_tz.md §7 step 4).
 */
export async function sendConfirmPrompt(chatId: number, token: string): Promise<void> {
  await callBotApi('sendMessage', {
    chat_id: chatId,
    text: 'Нажмите кнопку ниже, чтобы подтвердить вход в систему поручений.',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Подтвердить вход', callback_data: `${CONFIRM_CALLBACK_PREFIX}${token}` }],
      ],
    },
  });
}

export interface BotMessageOptions {
  reply_markup?: ReplyMarkup;
  /** 'HTML' — the caller escapes user text (see `escapeHtml`). */
  parse_mode?: 'HTML';
}

/** Send a message: plain text, or HTML with buttons. */
export async function sendBotMessage(
  chatId: number,
  text: string,
  opts: BotMessageOptions = {},
): Promise<void> {
  await callBotApi('sendMessage', {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
    ...opts,
  });
}

/**
 * Send a file as a document with an optional caption (HTML) and buttons — the
 * planned reports (10.B5). A multipart upload: the Bot API takes up to 50 MB.
 */
export async function sendBotDocument(
  chatId: number,
  file: { name: string; data: Buffer; mimeType: string },
  opts: BotMessageOptions & { caption?: string } = {},
): Promise<void> {
  const { botToken } = requireTelegramConfig();
  const form = new FormData();
  form.set('chat_id', String(chatId));
  form.set('document', new Blob([new Uint8Array(file.data)], { type: file.mimeType }), file.name);
  if (opts.caption) form.set('caption', opts.caption);
  if (opts.parse_mode) form.set('parse_mode', opts.parse_mode);
  if (opts.reply_markup) form.set('reply_markup', JSON.stringify(opts.reply_markup));
  const res = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/sendDocument`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw AppError.badRequest('Telegram sendDocument failed');
}

/** Replace the text (and buttons) of a message the bot sent earlier. */
export async function editBotMessage(
  chatId: number,
  messageId: number,
  text: string,
  opts: BotMessageOptions = {},
): Promise<void> {
  await callBotApi('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    link_preview_options: { is_disabled: true },
    ...opts,
  });
}

/** Bots can download files up to 20 MB with getFile (Bot API limit). */
export const BOT_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

/** Download a file a user sent to the bot (getFile, then the file URL). */
export async function downloadBotFile(fileId: string): Promise<Buffer> {
  const { botToken } = requireTelegramConfig();
  const file = await callBotApi<{ file_path?: string }>('getFile', { file_id: fileId });
  if (!file?.file_path) throw AppError.badRequest('Telegram getFile failed');
  const res = await fetch(`${TELEGRAM_API_BASE}/file/bot${botToken}/${file.file_path}`);
  if (!res.ok) throw AppError.badRequest('Telegram file download failed');
  return Buffer.from(await res.arrayBuffer());
}

/** `<`, `>` and `&` in user text would break an HTML message. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const ROLE_RU: Record<string, string> = {
  owner: 'владелец',
  admin: 'администратор',
  member: 'участник',
  guest: 'гость',
};

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
      `${opts.inviterName} приглашает вас в пространство «${opts.workspaceName}» (роль: ${ROLE_RU[opts.role] ?? opts.role}).`,
      '',
      'Принять приглашение?',
    ].join('\n'),
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Принять', callback_data: `${WS_INVITE_ACCEPT_PREFIX}${opts.token}` },
          { text: '❌ Отклонить', callback_data: `${WS_INVITE_DECLINE_PREFIX}${opts.token}` },
        ],
      ],
    },
  });
}

/** What a code sent through the bot confirms, as the first line of the message. */
const CODE_ACTION_RU: Record<'delete_account' | 'transfer_ownership', string> = {
  delete_account: 'Код для безвозвратного удаления аккаунта в системе поручений:',
  transfer_ownership: 'Код для передачи владения пространством в системе поручений:',
};

/**
 * Deliver a 6-digit confirmation code to an account with no email through the bot
 * (the analogue of {@link sendOtpEmail}). The chat id for a private chat equals the
 * user's telegram id, so we message them directly.
 */
export async function sendCodeViaTelegram(
  chatId: number,
  code: string,
  purpose: keyof typeof CODE_ACTION_RU,
): Promise<void> {
  await callBotApi('sendMessage', {
    chat_id: chatId,
    text: [
      CODE_ACTION_RU[purpose],
      '',
      `    ${code}`,
      '',
      'Код действует 10 минут. Если вы его не запрашивали, просто проигнорируйте это сообщение.',
    ].join('\n'),
  });
}

/** Acknowledge a tapped inline button so Telegram stops the loading spinner. */
export async function answerCallbackQuery(
  callbackQueryId: string,
  text: string,
  showAlert = false,
): Promise<void> {
  await callBotApi('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    ...(showAlert && { show_alert: true }),
  });
}
