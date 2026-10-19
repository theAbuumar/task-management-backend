-- Ф7 7.B6 (ADR-017): корзина. Кто переместил задачу или проект в корзину.
-- Просто id, без внешнего ключа: запись в корзине переживает удаление человека
-- (как WorkspaceMember.deactivated_by).

-- AlterTable
ALTER TABLE "Issue" ADD COLUMN "deleted_by_id" TEXT;
ALTER TABLE "Project" ADD COLUMN "deleted_by_id" TEXT;

-- Уже удалённое: автор удаления задачи — из её истории, проекта — из журнала аудита.
UPDATE "Issue" i SET "deleted_by_id" = (
  SELECT a."actor_id" FROM "ActivityLog" a
  WHERE a."issue_id" = i."id" AND a."action" = 'issue.deleted'
  ORDER BY a."created_at" DESC
  LIMIT 1
)
WHERE i."deleted_at" IS NOT NULL;

UPDATE "Project" p SET "deleted_by_id" = (
  SELECT l."actor_id" FROM "AuditLog" l
  WHERE l."target_type" = 'project' AND l."target_id" = p."id" AND l."action" = 'project.deleted'
  ORDER BY l."created_at" DESC
  LIMIT 1
)
WHERE p."deleted_at" IS NOT NULL;
