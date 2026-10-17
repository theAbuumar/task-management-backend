-- CreateEnum
CREATE TYPE "ProjectVisibility" AS ENUM ('public', 'private');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('planned', 'active', 'paused', 'completed');

-- CreateEnum
CREATE TYPE "IssueKind" AS ENUM ('task', 'assignment');

-- AlterTable
ALTER TABLE "Issue" ADD COLUMN     "basis" TEXT,
ADD COLUMN     "controller_id" TEXT,
ADD COLUMN     "kind" "IssueKind" NOT NULL DEFAULT 'task',
ADD COLUMN     "requires_review" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "IssueAssignee" ADD COLUMN     "acknowledged_at" TIMESTAMP(3),
ADD COLUMN     "is_primary" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "color" TEXT,
ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "department_id" TEXT,
ADD COLUMN     "icon" TEXT,
ADD COLUMN     "start_date" TIMESTAMP(3),
ADD COLUMN     "status" "ProjectStatus" NOT NULL DEFAULT 'active',
ADD COLUMN     "target_date" TIMESTAMP(3),
ADD COLUMN     "visibility" "ProjectVisibility" NOT NULL DEFAULT 'public';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "first_name" TEXT,
ADD COLUMN     "last_name" TEXT,
ADD COLUMN     "locale" TEXT NOT NULL DEFAULT 'ru',
ADD COLUMN     "middle_name" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "timezone" TEXT;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "description" TEXT,
ADD COLUMN     "locale" TEXT NOT NULL DEFAULT 'ru',
ADD COLUMN     "logo_url" TEXT,
ADD COLUMN     "settings" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "short_name" TEXT,
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'UTC';

-- AlterTable
ALTER TABLE "WorkspaceMember" ADD COLUMN     "department_id" TEXT,
ADD COLUMN     "position" TEXT;

-- CreateTable
CREATE TABLE "Department" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "name" TEXT NOT NULL,
    "short_name" TEXT,
    "head_id" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Department_workspace_id_idx" ON "Department"("workspace_id");

-- CreateIndex
CREATE INDEX "Department_parent_id_idx" ON "Department"("parent_id");

-- CreateIndex
CREATE INDEX "Issue_controller_id_idx" ON "Issue"("controller_id");

-- CreateIndex
CREATE INDEX "Issue_kind_idx" ON "Issue"("kind");

-- CreateIndex
CREATE INDEX "Project_department_id_idx" ON "Project"("department_id");

-- CreateIndex
CREATE INDEX "Project_deleted_at_idx" ON "Project"("deleted_at");

-- CreateIndex
CREATE INDEX "WorkspaceMember_department_id_idx" ON "WorkspaceMember"("department_id");

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_head_id_fkey" FOREIGN KEY ("head_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_controller_id_fkey" FOREIGN KEY ("controller_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Data migration ──────────────────────────────────────────────────────────

-- Every existing project gets the "На проверке" (review) state right after its
-- in-progress states; completed/cancelled shift one step down the board.
UPDATE "State" SET "order" = "order" + 1 WHERE "group" IN ('completed', 'cancelled');

INSERT INTO "State" ("id", "project_id", "name", "color", "group", "order", "is_default", "created_at", "updated_at")
SELECT gen_random_uuid()::text, p."id", 'На проверке', '#8B5CF6', 'review',
       COALESCE((SELECT MAX(s."order") FROM "State" s
                 WHERE s."project_id" = p."id" AND s."group" IN ('backlog', 'unstarted', 'started')), 2) + 1,
       false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Project" p
WHERE NOT EXISTS (SELECT 1 FROM "State" s WHERE s."project_id" = p."id" AND s."group" = 'review');

-- Default workflow states get their Russian names (the product's primary locale).
UPDATE "State" SET "name" = 'Бэклог'       WHERE "name" = 'Backlog'     AND "group" = 'backlog';
UPDATE "State" SET "name" = 'К выполнению' WHERE "name" = 'Todo'        AND "group" = 'unstarted';
UPDATE "State" SET "name" = 'В работе'     WHERE "name" = 'In Progress' AND "group" = 'started';
UPDATE "State" SET "name" = 'Готово'       WHERE "name" = 'Done'        AND "group" = 'completed';
UPDATE "State" SET "name" = 'Отменено'     WHERE "name" = 'Cancelled'   AND "group" = 'cancelled';

-- The earliest assignee of each issue becomes its primary (ответственный) assignee.
UPDATE "IssueAssignee" ia SET "is_primary" = true
FROM (
  SELECT DISTINCT ON ("issue_id") "issue_id", "user_id"
  FROM "IssueAssignee"
  ORDER BY "issue_id", "created_at"
) first_assignee
WHERE ia."issue_id" = first_assignee."issue_id" AND ia."user_id" = first_assignee."user_id";
