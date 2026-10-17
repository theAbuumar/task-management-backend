-- Telegram-бот в бэке (ADR-011, режим 6 дней): текст, который бот ждёт от чата
-- после кнопки «Сдать на проверку», «Вернуть» или «Комментарий».
-- CreateTable
CREATE TABLE "TelegramPendingInput" (
    "chat_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "issue_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramPendingInput_pkey" PRIMARY KEY ("chat_id")
);
