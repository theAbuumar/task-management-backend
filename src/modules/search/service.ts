// Глобальный поиск (Ф7 7.B2): one query — issues, projects, people and
// departments of the workspace, a few of each, best first.
//
// Issues are found by their key (`ACCR-12` — exact, shown first) and by words
// of the title and description with Russian morphology: PostgreSQL full-text
// search with the `russian` configuration, every word as a prefix, so «приказ»
// finds «приказы» and a word being typed («аккред») already matches. A plain
// substring of the title matches too (numbers, abbreviations the stemmer
// skips). Title hits rank above description hits.
//
// Visibility is the same as everywhere: deleted issues and projects are not
// found, private projects only by their members and admins. Matches come back
// marked with MARK_START / MARK_END for highlighting; clients render them as
// text, never as HTML.

import { Prisma, type PrismaClient, type WorkspaceMember } from '@prisma/client';
import { z } from 'zod';
import { seesAllProjects } from '../../plugins/workspace-hook.js';

export const MARK_START = '\u0001';
export const MARK_END = '\u0002';

export const SEARCH_TYPES = ['issues', 'projects', 'people', 'departments'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export const SearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  /** Comma-separated subset of SEARCH_TYPES; all by default. */
  types: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v) return [...SEARCH_TYPES];
      const list = [...new Set(v.split(',').map((s) => s.trim()))].filter(Boolean);
      const bad = list.filter((s) => !SEARCH_TYPES.includes(s as SearchType));
      if (bad.length > 0) {
        ctx.addIssue({ code: 'custom', message: `Unknown types: ${bad.join(', ')}` });
        return z.NEVER;
      }
      return list as SearchType[];
    }),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

export interface SearchIssue {
  id: string;
  key: string;
  title: string;
  /** Title with the matches marked. */
  title_hl: string;
  /** A fragment of the description around the matches (marked), when they are there. */
  snippet: string | null;
  kind: string;
  project: { id: string; name: string; identifier: string };
  state: { name: string; group: string; color: string };
  due_date: Date | null;
  completed_at: Date | null;
}

export interface SearchResult {
  query: string;
  issues: SearchIssue[];
  projects: {
    id: string;
    name: string;
    name_hl: string;
    identifier: string;
    color: string | null;
  }[];
  people: {
    user_id: string;
    display_name: string;
    name_hl: string;
    avatar_url: string | null;
    position: string | null;
    department: { id: string; name: string } | null;
  }[];
  departments: {
    id: string;
    name: string;
    name_hl: string;
    short_name: string | null;
    head: { id: string; display_name: string } | null;
  }[];
}

type Viewer = Pick<WorkspaceMember, 'user_id' | 'role'>;

const KEY = /^([A-Za-z0-9]{1,10})-(\d{1,9})$/;

/** Words of the query: letters and digits only (safe inside a tsquery), at most 8. */
export function queryWords(q: string): string[] {
  return [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 8);
}

/**
 * `приказ:* & ректор:*` — every word as a prefix, all of them required. The
 * `russian` stemmer itself reads «ё» as «е», so «отчет» finds «отчёт».
 */
function prefixTsQuery(words: string[]): string {
  return words.map((w) => `${w}:*`).join(' & ');
}

/** «ё» → «е», for the plain-substring match (done on both sides). */
const yoInsensitive = (s: string) => s.replace(/[ёЁ]/g, (c) => (c === 'ё' ? 'е' : 'Е'));

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Marks every case-insensitive occurrence of the words (for plain-substring matches). */
export function markWords(text: string, words: string[]): string {
  const parts = words
    .filter((w) => w.length > 0)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[её]/giu, '[её]'));
  if (parts.length === 0) return text;
  const re = new RegExp(`(${parts.sort((a, b) => b.length - a.length).join('|')})`, 'giu');
  return text.replace(re, `${MARK_START}$1${MARK_END}`);
}

interface IssueRow {
  id: string;
  sequence_id: number;
  title: string;
  title_hl: string;
  snippet: string | null;
  kind: string;
  due_date: Date | null;
  completed_at: Date | null;
  project_id: string;
  project_name: string;
  identifier: string;
  state_name: string;
  state_group: string;
  state_color: string;
}

/** Issues the viewer can see, matching the words or the substring, best first. */
export async function searchIssues(
  prisma: PrismaClient,
  workspaceId: string,
  viewer: Viewer,
  q: string,
  limit: number,
): Promise<SearchIssue[]> {
  const words = queryWords(q);
  const like = `%${escapeLike(yoInsensitive(q))}%`;
  const tsq = prefixTsQuery(words);
  const visible = seesAllProjects(viewer as WorkspaceMember)
    ? Prisma.empty
    : Prisma.sql`AND (p.visibility = 'public' OR EXISTS (
        SELECT 1 FROM "ProjectMember" pm WHERE pm.project_id = p.id AND pm.user_id = ${viewer.user_id}))`;
  const opts = `HighlightAll=true, StartSel=${MARK_START}, StopSel=${MARK_END}`;
  const snippetOpts = `MaxFragments=1, MaxWords=18, MinWords=8, StartSel=${MARK_START}, StopSel=${MARK_END}`;

  // The inner query picks and ranks the rows (the WHERE expression matches the
  // GIN index of migration `search`); headlines are built for the page only.
  const rows = await prisma.$queryRaw<IssueRow[]>`
    SELECT s.id, s.sequence_id, s.title, s.kind, s.due_date, s.completed_at,
           s.project_id, s.project_name, s.identifier, s.state_name, s.state_group, s.state_color,
           ts_headline('russian', s.title, s.tsq, ${opts}) AS title_hl,
           CASE WHEN s.description IS NOT NULL AND to_tsvector('russian', s.description) @@ s.tsq
                THEN ts_headline('russian', s.description, s.tsq, ${snippetOpts})
           END AS snippet
    FROM (
      SELECT i.id, i.sequence_id, i.title, i.description, i.kind::text AS kind, i.due_date,
             i.completed_at, i.updated_at,
             p.id AS project_id, p.name AS project_name, p.identifier,
             st.name AS state_name, st."group"::text AS state_group, st.color AS state_color,
             q.tsq,
             (CASE WHEN lower(i.title) = lower(${q}) THEN 3 ELSE 0 END
              + CASE WHEN translate(i.title, 'Ёё', 'Ее') ILIKE ${like} THEN 1 ELSE 0 END
              + ts_rank(setweight(to_tsvector('russian', i.title), 'A')
                        || setweight(to_tsvector('russian', coalesce(i.description, '')), 'D'),
                        q.tsq)) AS rank
      FROM "Issue" i
      JOIN "Project" p ON p.id = i.project_id
      JOIN "State" st ON st.id = i.state_id
      CROSS JOIN (SELECT to_tsquery('russian', ${tsq}) AS tsq) q
      WHERE i.workspace_id = ${workspaceId}
        AND i.deleted_at IS NULL
        AND p.deleted_at IS NULL
        ${visible}
        AND (to_tsvector('russian', i.title || ' ' || coalesce(i.description, '')) @@ q.tsq
             OR translate(i.title, 'Ёё', 'Ее') ILIKE ${like})
      ORDER BY rank DESC, i.updated_at DESC
      LIMIT ${limit}
    ) s
    ORDER BY s.rank DESC, s.updated_at DESC`;

  const found = rows.map((r) => toIssue(r, words));

  // An exact key (`ACCR-12`) goes first, even when the words found nothing.
  const key = KEY.exec(q.trim());
  if (key) {
    const exact = await issueByKey(prisma, workspaceId, viewer, key[1]!, Number(key[2]));
    if (exact) {
      return [exact, ...found.filter((i) => i.id !== exact.id)].slice(0, limit);
    }
  }
  return found;
}

function toIssue(r: IssueRow, words: string[]): SearchIssue {
  const titleHl = r.title_hl.includes(MARK_START) ? r.title_hl : markWords(r.title, words);
  return {
    id: r.id,
    key: `${r.identifier}-${r.sequence_id}`,
    title: r.title,
    title_hl: titleHl,
    snippet: r.snippet ? r.snippet.replace(/\s+/g, ' ').trim() : null,
    kind: r.kind,
    project: { id: r.project_id, name: r.project_name, identifier: r.identifier },
    state: { name: r.state_name, group: r.state_group, color: r.state_color },
    due_date: r.due_date,
    completed_at: r.completed_at,
  };
}

async function issueByKey(
  prisma: PrismaClient,
  workspaceId: string,
  viewer: Viewer,
  identifier: string,
  sequence: number,
): Promise<SearchIssue | null> {
  const issue = await prisma.issue.findFirst({
    where: {
      workspace_id: workspaceId,
      sequence_id: sequence,
      deleted_at: null,
      project: {
        identifier: identifier.toUpperCase(),
        deleted_at: null,
        ...(!seesAllProjects(viewer as WorkspaceMember) && {
          OR: [{ visibility: 'public' }, { members: { some: { user_id: viewer.user_id } } }],
        }),
      },
    },
    select: {
      id: true,
      sequence_id: true,
      title: true,
      kind: true,
      due_date: true,
      completed_at: true,
      project: { select: { id: true, name: true, identifier: true } },
      state: { select: { name: true, group: true, color: true } },
    },
  });
  if (!issue) return null;
  const key = `${issue.project.identifier}-${issue.sequence_id}`;
  return {
    id: issue.id,
    key,
    title: issue.title,
    title_hl: issue.title,
    snippet: null,
    kind: issue.kind,
    project: issue.project,
    state: issue.state,
    due_date: issue.due_date,
    completed_at: issue.completed_at,
  };
}

const contains = (value: string) => ({ contains: value, mode: 'insensitive' as const });

export async function search(
  prisma: PrismaClient,
  workspaceId: string,
  viewer: Viewer,
  query: SearchQuery,
): Promise<SearchResult> {
  const { q, limit } = query;
  const types = new Set(query.types);
  const words = queryWords(q);
  // Names are matched word by word (any order): «Абдуллоев декан» finds the dean.
  const terms = words.length > 0 ? words : [q];

  const [issues, projects, people, departments] = await Promise.all([
    types.has('issues') ? searchIssues(prisma, workspaceId, viewer, q, limit) : [],
    types.has('projects')
      ? prisma.project.findMany({
          where: {
            workspace_id: workspaceId,
            deleted_at: null,
            ...(!seesAllProjects(viewer as WorkspaceMember) && {
              OR: [{ visibility: 'public' }, { members: { some: { user_id: viewer.user_id } } }],
            }),
            AND: terms.map((w) => ({
              OR: [{ name: contains(w) }, { identifier: { startsWith: w, mode: 'insensitive' } }],
            })),
          },
          select: { id: true, name: true, identifier: true, color: true },
          orderBy: { name: 'asc' },
          take: limit,
        })
      : [],
    types.has('people')
      ? prisma.workspaceMember.findMany({
          where: {
            workspace_id: workspaceId,
            deactivated_at: null,
            AND: terms.map((w) => ({
              OR: [{ user: { display_name: contains(w) } }, { position: contains(w) }],
            })),
          },
          select: {
            user_id: true,
            position: true,
            user: { select: { display_name: true, avatar_url: true } },
            department: { select: { id: true, name: true } },
          },
          orderBy: { user: { display_name: 'asc' } },
          take: limit,
        })
      : [],
    types.has('departments')
      ? prisma.department.findMany({
          where: {
            workspace_id: workspaceId,
            AND: terms.map((w) => ({ OR: [{ name: contains(w) }, { short_name: contains(w) }] })),
          },
          select: {
            id: true,
            name: true,
            short_name: true,
            head: { select: { id: true, display_name: true } },
          },
          orderBy: [{ order: 'asc' }, { name: 'asc' }],
          take: limit,
        })
      : [],
  ]);

  return {
    query: q,
    issues,
    projects: projects.map((p) => ({ ...p, name_hl: markWords(p.name, terms) })),
    people: people.map((m) => ({
      user_id: m.user_id,
      display_name: m.user.display_name,
      name_hl: markWords(m.user.display_name, terms),
      avatar_url: m.user.avatar_url,
      position: m.position,
      department: m.department,
    })),
    departments: departments.map((d) => ({ ...d, name_hl: markWords(d.name, terms) })),
  };
}
