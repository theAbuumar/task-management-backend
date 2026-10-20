-- Ф4 (ADR-031): «изменено» at an edited comment (4.F8) and the place in the org
-- structure an invitation gives on accepting (staff import, 4.B1).

-- AlterTable
ALTER TABLE "Comment" ADD COLUMN     "edited_at" TIMESTAMP(3);

-- Comments edited before the column existed: their last change was the edit
-- (a deleted comment shows no text, so it needs no mark).
UPDATE "Comment" SET "edited_at" = "updated_at"
WHERE "deleted_at" IS NULL AND "updated_at" > "created_at" + interval '2 seconds';

-- AlterTable
ALTER TABLE "WorkspaceInvite" ADD COLUMN     "department_id" TEXT,
ADD COLUMN     "first_name" TEXT,
ADD COLUMN     "last_name" TEXT,
ADD COLUMN     "middle_name" TEXT,
ADD COLUMN     "position" TEXT;

-- AlterTable
ALTER TABLE "WorkspaceMemberInvite" ADD COLUMN     "department_id" TEXT,
ADD COLUMN     "position" TEXT;

-- AddForeignKey
ALTER TABLE "WorkspaceInvite" ADD CONSTRAINT "WorkspaceInvite_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMemberInvite" ADD CONSTRAINT "WorkspaceMemberInvite_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
