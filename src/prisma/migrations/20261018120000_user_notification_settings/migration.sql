-- Ф8 8.B2 (режим 6 дней): личные настройки уведомлений — какие события уходят в
-- Telegram и на почту, тихие часы. NULL — значения по умолчанию
-- (src/lib/notification-prefs.ts). Уведомления в приложении не отключаются.
-- AlterTable
ALTER TABLE "User" ADD COLUMN "notification_settings" JSONB;
