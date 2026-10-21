-- Плановые отчёты (Ф10 10.B5, ADR-032): the schedule of a report and the history
-- of its sendings with the stored file.

-- CreateEnum
CREATE TYPE "ReportKind" AS ENUM ('discipline', 'assignments', 'project');

-- CreateEnum
CREATE TYPE "ReportPeriod" AS ENUM ('previous_week', 'previous_month', 'previous_quarter', 'last_30_days');

-- CreateEnum
CREATE TYPE "ReportRunStatus" AS ENUM ('sent', 'partial', 'failed');

-- CreateTable
CREATE TABLE "ReportSchedule" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "name" TEXT,
    "report" "ReportKind" NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "period" "ReportPeriod" NOT NULL,
    "frequency" "RecurrenceFrequency" NOT NULL,
    "by_weekday" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "by_monthday" INTEGER,
    "time" TEXT NOT NULL DEFAULT '08:00',
    "start_date" TEXT NOT NULL,
    "recipient_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "next_run_at" TIMESTAMP(3),
    "last_run_at" TIMESTAMP(3),
    "last_error" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportRun" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "schedule_id" TEXT NOT NULL,
    "triggered_by_id" TEXT,
    "period_from" TEXT NOT NULL,
    "period_to" TEXT NOT NULL,
    "status" "ReportRunStatus" NOT NULL,
    "error" TEXT,
    "file_name" TEXT,
    "mime_type" TEXT,
    "file_size" INTEGER,
    "storage_key" TEXT,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "recipient_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deliveries" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReportSchedule_is_active_next_run_at_idx" ON "ReportSchedule"("is_active", "next_run_at");

-- CreateIndex
CREATE INDEX "ReportSchedule_workspace_id_idx" ON "ReportSchedule"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "ReportRun_storage_key_key" ON "ReportRun"("storage_key");

-- CreateIndex
CREATE INDEX "ReportRun_schedule_id_created_at_idx" ON "ReportRun"("schedule_id", "created_at");

-- CreateIndex
CREATE INDEX "ReportRun_workspace_id_idx" ON "ReportRun"("workspace_id");

-- AddForeignKey
ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportRun" ADD CONSTRAINT "ReportRun_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportRun" ADD CONSTRAINT "ReportRun_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "ReportSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

