-- Ф12 12.B7 (ADR-026): администратор отключает доступ сотрудника к пространству.
-- NULL — доступ есть. Учётная запись не меняется.

-- AlterTable
ALTER TABLE "WorkspaceMember" ADD COLUMN "deactivated_at" TIMESTAMP(3),
ADD COLUMN "deactivated_by" TEXT;
