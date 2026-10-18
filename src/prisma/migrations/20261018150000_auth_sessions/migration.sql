-- Ф12 12.B2: сессии входа. Одна строка — один вход на одном устройстве, от входа
-- через все обновления refresh-токена до выхода, отзыва или истечения. Refresh-токены
-- одного входа ссылаются на свою сессию.

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "method" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN "session_id" TEXT;

-- CreateIndex
CREATE INDEX "AuthSession_user_id_revoked_at_idx" ON "AuthSession"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "RefreshToken_session_id_idx" ON "RefreshToken"("session_id");

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "AuthSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Действующие входы до этой миграции становятся сессиями: id сессии = id живого
-- токена. Способ входа и устройство для них неизвестны.
INSERT INTO "AuthSession" ("id", "user_id", "created_at", "last_used_at", "expires_at")
SELECT "id", "user_id", "created_at", "created_at", "expires_at"
FROM "RefreshToken"
WHERE "revoked_at" IS NULL AND "expires_at" > CURRENT_TIMESTAMP;

UPDATE "RefreshToken" SET "session_id" = "id"
WHERE "revoked_at" IS NULL AND "expires_at" > CURRENT_TIMESTAMP;
