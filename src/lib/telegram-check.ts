// Pre-show Telegram check (13.D3, docs/STANDS.md): `bash dev/stand.sh telegram`.
//
// The bot is the part of the demo that tests can't cover — the Bot API is mocked
// there. This walks what has to be true on the real stand, in order: the token is
// valid and belongs to TELEGRAM_BOT_USERNAME, the webhook points at this stand and
// takes button presses, DEMO_TELEGRAM_ID is linked to a demo account, and a test
// message actually reaches the presenter (it fails if they never pressed «Старт»
// in the bot). Every line says what to do when it fails.
//
// The Bot API call and the account lookup are injected, so tests run it offline.

export const WEBHOOK_PATH = '/api/v1/auth/telegram/webhook';

/** One Bot API call: Telegram's own envelope, whatever the HTTP status. */
export type BotApiCall = (
  method: string,
  body: Record<string, unknown>,
) => Promise<{ ok: boolean; result?: unknown; description?: string }>;

export interface TelegramCheckInput {
  token?: string;
  username?: string;
  /** The stand's public address (SITE_URL / PUBLIC_BASE_URL). */
  baseUrl?: string;
  demoTelegramId?: string;
  call: BotApiCall;
  /** Name of the account the Telegram id is linked to, or null. */
  findLinkedAccount: (telegramId: string) => Promise<string | null>;
  now?: Date;
}

export interface TelegramCheckLine {
  status: 'ok' | 'warn' | 'fail';
  text: string;
}

export interface TelegramCheckResult {
  ok: boolean;
  lines: TelegramCheckLine[];
}

interface BotInfo {
  username?: string;
  first_name?: string;
}

interface WebhookInfo {
  url?: string;
  pending_update_count?: number;
  last_error_date?: number;
  last_error_message?: string;
  allowed_updates?: string[];
}

function ago(seconds: number): string {
  if (seconds < 90) return 'только что';
  const min = Math.round(seconds / 60);
  if (min < 90) return `${min} мин назад`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
}

export async function checkTelegram(input: TelegramCheckInput): Promise<TelegramCheckResult> {
  const lines: TelegramCheckLine[] = [];
  const ok = (text: string) => lines.push({ status: 'ok', text });
  const warn = (text: string) => lines.push({ status: 'warn', text });
  const fail = (text: string) => lines.push({ status: 'fail', text });
  const done = () => ({ ok: !lines.some((l) => l.status === 'fail'), lines });

  const { token, call } = input;
  const username = input.username?.replace(/^@/, '');
  if (!token || !username) {
    fail(
      'В .env не заданы TELEGRAM_BOT_TOKEN и TELEGRAM_BOT_USERNAME — токен и имя бота из @BotFather. ' +
        'Впишите их и выполните bash dev/stand.sh up.',
    );
    return done();
  }

  // 1. Token.
  const me = await call('getMe', {}).catch((err: unknown) => ({
    ok: false,
    description: err instanceof Error ? err.message : String(err),
  }));
  if (!me.ok) {
    fail(
      `Telegram не принял токен бота (${me.description ?? 'нет ответа'}). ` +
        'Проверьте TELEGRAM_BOT_TOKEN в .env и связь сервера с api.telegram.org.',
    );
    return done();
  }
  const bot = (me as { result?: BotInfo }).result ?? {};
  if (bot.username && bot.username.toLowerCase() !== username.toLowerCase()) {
    fail(
      `Токен от бота @${bot.username}, а TELEGRAM_BOT_USERNAME=${username}. ` +
        'Ссылки «Открыть в Telegram» будут вести не туда: исправьте .env и выполните up.',
    );
  } else {
    ok(
      `Токен действителен: @${bot.username ?? username}${bot.first_name ? ` («${bot.first_name}»)` : ''}.`,
    );
  }

  // 2. Webhook — only a public https stand can take updates.
  const base = input.baseUrl?.replace(/\/+$/, '') ?? '';
  if (!base.startsWith('https://')) {
    warn(
      `Стенд работает по ${base || 'неизвестному адресу'}: Telegram доставляет нажатия кнопок и ответы ` +
        'только на https. Сообщения от бота уйдут, но «Ознакомлен» в Telegram не сработает — ' +
        'на этом стенде показывайте шаг 4 через сайт.',
    );
  } else {
    const expected = `${base}${WEBHOOK_PATH}`;
    const res = await call('getWebhookInfo', {});
    const info = (res.ok ? (res as { result?: WebhookInfo }).result : undefined) ?? {};
    if (!res.ok) {
      fail(`Не удалось прочитать вебхук (${res.description ?? 'нет ответа'}).`);
    } else if (!info.url) {
      fail('Вебхук не задан — бот не получает нажатия. Выполните bash dev/stand.sh webhook.');
    } else if (info.url !== expected) {
      fail(
        `Вебхук ведёт на ${info.url}, а не на этот стенд (${expected}). ` +
          'Выполните bash dev/stand.sh webhook.',
      );
    } else {
      ok(`Вебхук: ${info.url}.`);
      const allowed = info.allowed_updates;
      if (allowed && allowed.length > 0 && !allowed.includes('callback_query')) {
        fail(
          'Вебхук не принимает нажатия кнопок (callback_query). Выполните bash dev/stand.sh webhook.',
        );
      }
      if (info.last_error_date) {
        const seconds = Math.max(
          0,
          (input.now ?? new Date()).getTime() / 1000 - info.last_error_date,
        );
        warn(
          `Telegram сообщал об ошибке доставки ${ago(seconds)}: «${info.last_error_message ?? '—'}». ` +
            'Если ошибка свежая, смотрите bash dev/stand.sh logs api.',
        );
      }
      if ((info.pending_update_count ?? 0) > 0) {
        warn(`В очереди Telegram ${info.pending_update_count} необработанных апдейтов.`);
      }
    }
  }

  // 3. The presenter's phone.
  const tgId = input.demoTelegramId?.trim();
  if (!tgId) {
    fail(
      'DEMO_TELEGRAM_ID не задан — бот не будет писать ведущему. Узнайте свой id у @userinfobot, ' +
        'впишите в .env, затем bash dev/stand.sh up и bash dev/stand.sh demo-reset.',
    );
    return done();
  }
  const account = await input.findLinkedAccount(tgId);
  if (!account) {
    fail(
      `Telegram ${tgId} не привязан ни к одному аккаунту: выполните bash dev/stand.sh demo-reset ` +
        '(после смены DEMO_TELEGRAM_ID — сначала up).',
    );
  } else {
    ok(`Telegram ведущего ${tgId} привязан к аккаунту «${account}».`);
  }
  const sent = await call('sendMessage', {
    chat_id: tgId,
    text:
      '✅ Проверка стенда: бот может вам писать.' +
      (account ? `\nДемо-аккаунт: ${account} — сюда придут его поручения.` : ''),
  });
  if (sent.ok) {
    ok('Тестовое сообщение отправлено ведущему — проверьте телефон.');
  } else {
    fail(
      `Сообщение ведущему не доставлено (${sent.description ?? 'нет ответа'}). ` +
        `Откройте @${bot.username ?? username} в Telegram ведущего и нажмите «Старт», затем повторите проверку.`,
    );
  }
  return done();
}
