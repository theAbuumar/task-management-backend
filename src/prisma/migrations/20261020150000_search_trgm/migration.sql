-- Global search (7.B2) on 10 000 issues (7.B7): the title substring match
-- (ILIKE, «ё» = «е») gets a trigram index, so the planner combines it with the
-- full-text GIN index "Issue_search_idx" (BitmapOr) instead of reading every
-- issue of the workspace: 124 → 20 ms. pg_trgm ships with PostgreSQL (contrib)
-- and is a trusted extension. Prisma cannot describe an expression index.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Issue_title_trgm_idx"
  ON "Issue" USING gin (translate(title, 'Ёё', 'Ее') gin_trgm_ops);
