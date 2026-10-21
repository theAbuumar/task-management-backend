-- Журнал доставки уведомлений (Ф8 8.B3, ADR-033): копия события для одного
-- человека в одном канале — очередь диспетчера и история доставки.

-- CreateEnum
CREATE TYPE "DeliveryChannel" AS ENUM ('telegram', 'email');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('queued', 'sending', 'sent', 'failed', 'skipped');

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "notification_id" TEXT,
    "user_id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "channel" "DeliveryChannel" NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'queued',
    "issue_id" TEXT,
    "actor_id" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "dedupe_key" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "error" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_dedupe_key_key" ON "NotificationDelivery"("dedupe_key");

-- CreateIndex
CREATE INDEX "NotificationDelivery_status_next_attempt_at_idx" ON "NotificationDelivery"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "NotificationDelivery_user_id_created_at_idx" ON "NotificationDelivery"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "NotificationDelivery_issue_id_idx" ON "NotificationDelivery"("issue_id");

-- CreateIndex
CREATE INDEX "NotificationDelivery_workspace_id_created_at_idx" ON "NotificationDelivery"("workspace_id", "created_at");

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "Notification"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

