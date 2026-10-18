// Demo stand (Ф13 13.B1): recreate the fictional university — people, structure,
// work with history, report files, the notification feed, the audit log.
//
//   npm run demo:reset         (uses DATABASE_URL — local: bash dev/seed-demo.sh)
//
// The data and its rules live in ./demo/university.ts. Idempotent: only the demo
// workspace (`demo-university`), its files and the `@demo.local` accounts are
// recreated. DEMO_TELEGRAM_ID links the presenter's Telegram to the demo account
// named by DEMO_TELEGRAM_ROLE (default: the dean).

import { PrismaClient } from '@prisma/client';
import { config } from '../config/index.js';
import { pluralize } from '../lib/plural.js';
import { createStorage } from '../lib/storage.js';
import { DEMO_TELEGRAM_ACCOUNTS, PEOPLE, seedDemo, shortName } from './demo/university.js';

const prisma = new PrismaClient();

seedDemo(prisma, {
  storage: createStorage(config),
  telegramId: config.DEMO_TELEGRAM_ID,
  telegramRole: config.DEMO_TELEGRAM_ROLE,
  // eslint-disable-next-line no-console
  warn: (line) => console.warn(`! ${line}`),
})
  .then((r) => {
    const tg = PEOPLE.find((p) => p.key === DEMO_TELEGRAM_ACCOUNTS[config.DEMO_TELEGRAM_ROLE])!;
    const telegram =
      r.telegram === 'linked'
        ? `  Telegram ${config.DEMO_TELEGRAM_ID} привязан к аккаунту «${tg.demo ?? ''}» (${shortName(tg)}).`
        : r.telegram === 'off'
          ? '  Telegram не привязан: задайте DEMO_TELEGRAM_ID, чтобы бот писал на телефон ведущего.'
          : '';
    const quickLogin = PEOPLE.filter((p) => p.demo).map((p) => p.demo);
    // eslint-disable-next-line no-console
    console.info(
      `✓ Демо-университет готов: ${pluralize(r.departments, ['подразделение', 'подразделения', 'подразделений'])}, ` +
        `${pluralize(r.people, ['сотрудник', 'сотрудника', 'сотрудников'])}, ` +
        `${pluralize(r.projects, ['проект', 'проекта', 'проектов'])}, ` +
        `${pluralize(r.issues, ['задача', 'задачи', 'задач'])}, ` +
        `${pluralize(r.attachments, ['файл', 'файла', 'файлов'])}, ` +
        `${pluralize(r.notifications, ['уведомление', 'уведомления', 'уведомлений'])}, ` +
        `${pluralize(r.audit, ['запись', 'записи', 'записей'])} журнала аудита.\n` +
        `  Вход: DEMO_MODE=true → кнопки быстрого входа (${quickLogin.join(', ')}).` +
        (telegram ? `\n${telegram}` : ''),
    );
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
