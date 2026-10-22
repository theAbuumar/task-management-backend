// Pre-show Telegram check — `bash dev/stand.sh telegram` (docs/STANDS.md).
//
//   node dist/scripts/telegram-check.js     # in the stand's api container
//   npx tsx src/scripts/telegram-check.ts   # locally, reads .env.local
//
// Checks the token, the webhook, the presenter's DEMO_TELEGRAM_ID and sends them a
// test message (lib/telegram-check.ts). Exits with 1 when something is wrong.

import { config } from '../config/index.js';
import { prisma } from '../lib/prisma.js';
import { checkTelegram, type BotApiCall } from '../lib/telegram-check.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

const call: BotApiCall = async (method, body) => {
  const res = await fetch(`${TELEGRAM_API_BASE}/bot${config.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as {
    ok: boolean;
    result?: unknown;
    description?: string;
  };
};

async function main(): Promise<number> {
  const result = await checkTelegram({
    token: config.TELEGRAM_BOT_TOKEN,
    username: config.TELEGRAM_BOT_USERNAME,
    baseUrl: config.PUBLIC_BASE_URL,
    demoTelegramId: config.DEMO_TELEGRAM_ID,
    call,
    findLinkedAccount: async (telegramId) => {
      const identity = await prisma.authIdentity.findUnique({
        where: {
          provider_provider_user_id: { provider: 'telegram', provider_user_id: telegramId },
        },
        select: { user: { select: { display_name: true } } },
      });
      return identity?.user.display_name ?? null;
    },
  });
  const mark = { ok: '✓', warn: '⚠', fail: '✗' } as const;
  // eslint-disable-next-line no-console
  for (const line of result.lines) console.log(`${mark[line.status]} ${line.text}`);
  // eslint-disable-next-line no-console
  console.log(
    result.ok
      ? '\nTelegram готов к показу. Вход через Telegram на сайте проверьте вручную: docs/checklists/smoke.md, п. 2.3.'
      : '\nTelegram не готов — исправьте строки с ✗ и повторите проверку.',
  );
  return result.ok ? 0 : 1;
}

main()
  .then((code) => prisma.$disconnect().then(() => process.exit(code)))
  .catch(async (err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
