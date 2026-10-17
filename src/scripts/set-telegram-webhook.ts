// Register (or delete) the Telegram bot webhook — run once per deployment.
//
//   npm run telegram:set-webhook -- https://your-domain.com
//   npm run telegram:set-webhook -- --delete
//
// Telegram does not run your bot; it forwards bot updates to an HTTPS URL you
// register via `setWebhook`. This standalone helper reads the bot token and the
// shared webhook secret from the environment (a local `.env` in dev, or the
// host's env vars) and points Telegram at `<base>/api/v1/auth/telegram/webhook`.
// It also registers the bot's command menu (/my, /today, /overdue…), then prints
// `getWebhookInfo` so you can confirm the URL took and see any delivery error. Deliberately does NOT import the app `config` — it needs only
// the two Telegram vars, not a full DATABASE_URL / JWT setup.

const WEBHOOK_PATH = '/api/v1/auth/telegram/webhook';
const TELEGRAM_API_BASE = 'https://api.telegram.org';

/** Best-effort load of a local `.env` in dev, mirroring src/config/index.ts. */
function loadDotEnv(): void {
  if (process.env.NODE_ENV === 'production') return;
  if (typeof process.loadEnvFile !== 'function') return;
  try {
    process.loadEnvFile();
  } catch {
    // No .env file — rely on the real environment (host-injected vars).
  }
}

function fail(message: string): never {
  // eslint-disable-next-line no-console
  console.error(`✖ ${message}`);
  process.exit(1);
}

async function callBotApi(token: string, method: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; description?: string };
  if (!json.ok) fail(`Telegram ${method} failed: ${json.description ?? 'unknown error'}`);
  return json;
}

async function main(): Promise<void> {
  loadDotEnv();

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) fail('TELEGRAM_BOT_TOKEN is not set (add it to your .env or host env).');

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const args = process.argv.slice(2);

  // ─── --delete: unregister the webhook and exit ──────────────────────────────
  if (args.includes('--delete')) {
    await callBotApi(token, 'deleteWebhook', {});
    // eslint-disable-next-line no-console
    console.log('✓ Webhook deleted.');
    return;
  }

  // ─── setWebhook: base URL from the first CLI arg, else PUBLIC_BASE_URL ───────
  const baseArg = args.find((a) => !a.startsWith('-'));
  const base = (baseArg ?? process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  if (!base) {
    fail(
      'No base URL. Pass it as an argument:\n' +
        '  npm run telegram:set-webhook -- https://your-domain.com\n' +
        '(or set PUBLIC_BASE_URL). It must be the public HTTPS URL of the deployed backend.',
    );
  }
  if (!base.startsWith('https://')) {
    fail(`Base URL must be HTTPS (Telegram rejects non-HTTPS webhooks). Got: ${base}`);
  }
  if (base.includes('localhost') || base.includes('127.0.0.1')) {
    fail(
      `Base URL points at localhost (${base}). Telegram can't reach it — ` +
        'deploy first, or use a public tunnel (ngrok/cloudflared).',
    );
  }

  const url = `${base}${WEBHOOK_PATH}`;
  if (!secret) {
    // eslint-disable-next-line no-console
    console.warn('⚠ TELEGRAM_WEBHOOK_SECRET is not set — registering without a secret_token.');
  }

  await callBotApi(token, 'setWebhook', {
    url,
    ...(secret ? { secret_token: secret } : {}),
    allowed_updates: ['message', 'callback_query'],
  });
  // The «/» menu of the work bot (modules/telegram/bot.ts).
  await callBotApi(token, 'setMyCommands', {
    commands: [
      { command: 'my', description: 'Мои задачи' },
      { command: 'today', description: 'Срок сегодня' },
      { command: 'overdue', description: 'Просрочено' },
      { command: 'review', description: 'Ждут моей проверки' },
      { command: 'control', description: 'Поручения на контроле' },
      { command: 'menu', description: 'Главное меню' },
      { command: 'cancel', description: 'Отменить ввод' },
    ],
  });

  const info = (await callBotApi(token, 'getWebhookInfo', {})) as {
    result?: { url?: string; pending_update_count?: number; last_error_message?: string };
  };

  // eslint-disable-next-line no-console
  console.log(`✓ Webhook set to: ${url}`);
  const r = info.result;
  if (r?.last_error_message) {
    // eslint-disable-next-line no-console
    console.warn(
      `⚠ Telegram reports a recent delivery error: "${r.last_error_message}". ` +
        'Check the service is Live and the env vars are set.',
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(`  Pending updates: ${r?.pending_update_count ?? 0}. No delivery errors reported.`);
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
