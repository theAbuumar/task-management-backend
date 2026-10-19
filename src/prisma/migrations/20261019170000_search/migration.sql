-- Ф7 7.B2: полнотекстовый поиск задач с русской морфологией («приказ» находит «приказы»).
-- Индекс по выражению: Prisma такие не описывает, поэтому в schema.prisma его нет.
-- Если `prisma migrate dev` предложит DROP INDEX "Issue_search_idx", эту строку
-- из новой миграции нужно убрать (выражение совпадает с src/modules/search/service.ts).
CREATE INDEX "Issue_search_idx" ON "Issue"
  USING GIN (to_tsvector('russian', "title" || ' ' || coalesce("description", '')));
