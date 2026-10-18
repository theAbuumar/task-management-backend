-- Telegram-бот в бэке (ADR-011, режим 6 дней), 9.T5: файлы, присланные боту для
-- сдачи отчёта. Хранится только ссылка Telegram на файл, сам файл скачивается в
-- хранилище вложений при сдаче на проверку.
-- CreateTable
CREATE TABLE "TelegramPendingFile" (
    "id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "file_name" TEXT,
    "mime_type" TEXT NOT NULL,
    "file_size" INTEGER,
    "caption" TEXT,
    "media_group_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramPendingFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TelegramPendingFile_chat_id_created_at_idx" ON "TelegramPendingFile"("chat_id", "created_at");
