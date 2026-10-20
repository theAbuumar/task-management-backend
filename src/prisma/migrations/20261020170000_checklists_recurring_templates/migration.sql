-- Ф6 (ADR-030): checklists of issues (6.B5), recurring rules (6.B4) and issue
-- templates (6.B3). New columns default to 0/null — no data to move.
-- CreateEnum
CREATE TYPE "RecurrenceFrequency" AS ENUM ('daily', 'weekly', 'monthly', 'quarterly', 'yearly');

-- AlterTable
ALTER TABLE "Issue" ADD COLUMN     "checklist_done" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "checklist_total" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "recurring_rule_id" TEXT;

-- CreateTable
CREATE TABLE "IssueChecklistItem" (
    "id" TEXT NOT NULL,
    "issue_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "is_done" BOOLEAN NOT NULL DEFAULT false,
    "done_by_id" TEXT,
    "done_at" TIMESTAMP(3),
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IssueChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringRule" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "due_in_days" INTEGER,
    "frequency" "RecurrenceFrequency" NOT NULL,
    "interval" INTEGER NOT NULL DEFAULT 1,
    "by_weekday" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "by_monthday" INTEGER,
    "by_month" INTEGER,
    "time" TEXT NOT NULL DEFAULT '09:00',
    "start_date" TEXT NOT NULL,
    "until" TEXT,
    "next_run_at" TIMESTAMP(3),
    "last_run_at" TIMESTAMP(3),
    "last_error" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssueTemplate" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT,
    "created_by_id" TEXT,
    "name" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "due_in_days" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IssueTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IssueChecklistItem_issue_id_order_idx" ON "IssueChecklistItem"("issue_id", "order");

-- CreateIndex
CREATE INDEX "RecurringRule_is_active_next_run_at_idx" ON "RecurringRule"("is_active", "next_run_at");

-- CreateIndex
CREATE INDEX "RecurringRule_project_id_idx" ON "RecurringRule"("project_id");

-- CreateIndex
CREATE INDEX "IssueTemplate_workspace_id_project_id_idx" ON "IssueTemplate"("workspace_id", "project_id");

-- CreateIndex
CREATE INDEX "IssueTemplate_project_id_idx" ON "IssueTemplate"("project_id");

-- CreateIndex
CREATE INDEX "Issue_recurring_rule_id_idx" ON "Issue"("recurring_rule_id");

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_recurring_rule_id_fkey" FOREIGN KEY ("recurring_rule_id") REFERENCES "RecurringRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueChecklistItem" ADD CONSTRAINT "IssueChecklistItem_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueChecklistItem" ADD CONSTRAINT "IssueChecklistItem_done_by_id_fkey" FOREIGN KEY ("done_by_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringRule" ADD CONSTRAINT "RecurringRule_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringRule" ADD CONSTRAINT "RecurringRule_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringRule" ADD CONSTRAINT "RecurringRule_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueTemplate" ADD CONSTRAINT "IssueTemplate_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueTemplate" ADD CONSTRAINT "IssueTemplate_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueTemplate" ADD CONSTRAINT "IssueTemplate_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

