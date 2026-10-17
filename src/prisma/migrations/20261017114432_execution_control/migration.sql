-- CreateEnum
CREATE TYPE "ReviewDecision" AS ENUM ('pending', 'approved', 'returned');

-- CreateEnum
CREATE TYPE "DeadlineRequestStatus" AS ENUM ('pending', 'approved', 'rejected');

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "review_id" TEXT;

-- CreateTable
CREATE TABLE "IssueReview" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "issue_id" TEXT NOT NULL,
    "submitted_by_id" TEXT NOT NULL,
    "report" TEXT,
    "decision" "ReviewDecision" NOT NULL DEFAULT 'pending',
    "decided_by_id" TEXT,
    "decision_comment" TEXT,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "IssueReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeadlineChangeRequest" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "issue_id" TEXT NOT NULL,
    "requested_by_id" TEXT NOT NULL,
    "old_due_date" TIMESTAMP(3),
    "new_due_date" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "DeadlineRequestStatus" NOT NULL DEFAULT 'pending',
    "decided_by_id" TEXT,
    "decision_comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "DeadlineChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssueWatcher" (
    "issue_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssueWatcher_pkey" PRIMARY KEY ("issue_id","user_id")
);

-- CreateTable
CREATE TABLE "ReminderLog" (
    "id" TEXT NOT NULL,
    "issue_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "for_date" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReminderLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IssueReview_issue_id_idx" ON "IssueReview"("issue_id");

-- CreateIndex
CREATE INDEX "IssueReview_workspace_id_decision_idx" ON "IssueReview"("workspace_id", "decision");

-- CreateIndex
CREATE INDEX "DeadlineChangeRequest_issue_id_idx" ON "DeadlineChangeRequest"("issue_id");

-- CreateIndex
CREATE INDEX "DeadlineChangeRequest_workspace_id_status_idx" ON "DeadlineChangeRequest"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "IssueWatcher_user_id_idx" ON "IssueWatcher"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ReminderLog_issue_id_user_id_kind_for_date_key" ON "ReminderLog"("issue_id", "user_id", "kind", "for_date");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "IssueReview"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueReview" ADD CONSTRAINT "IssueReview_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueReview" ADD CONSTRAINT "IssueReview_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueReview" ADD CONSTRAINT "IssueReview_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeadlineChangeRequest" ADD CONSTRAINT "DeadlineChangeRequest_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeadlineChangeRequest" ADD CONSTRAINT "DeadlineChangeRequest_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeadlineChangeRequest" ADD CONSTRAINT "DeadlineChangeRequest_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueWatcher" ADD CONSTRAINT "IssueWatcher_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueWatcher" ADD CONSTRAINT "IssueWatcher_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderLog" ADD CONSTRAINT "ReminderLog_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
