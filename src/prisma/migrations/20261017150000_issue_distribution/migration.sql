-- Рассылка подразделениям (6.B1): parent flag + addressed department on children;
-- index for analytics over completed work (10.B1).
-- AlterTable
ALTER TABLE "Issue" ADD COLUMN     "department_id" TEXT,
ADD COLUMN     "is_distribution" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Issue_department_id_idx" ON "Issue"("department_id");

-- CreateIndex
CREATE INDEX "Issue_workspace_id_completed_at_idx" ON "Issue"("workspace_id", "completed_at");

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

