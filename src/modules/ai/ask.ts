// The AI panel (Ф11 11.B5): a question in plain words, answered from the data
// the asker may see, with links to the issues it is about.
//
// The model does not get the database. It calls tools, and every tool runs here
// with the asker's rights through the same building blocks as the site:
//   - issue lists and search — `visibleIssuesWhere` (private projects only for
//     their members and admins) + the filters of the workspace list (7.B1);
//   - analytics — `analyticsData`, cut to the asker's scope (10.B3);
//   - people — the org directory of this workspace only.
// An answer links only to issues a tool returned in this turn. Dialogues are kept
// in AiConversation and read by their author only; stored links are checked
// against the reader's current rights on every read (ADR-028).

import { z } from 'zod';
import type { Prisma, PrismaClient, WorkspaceMember } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { localDate, daysBetween } from '../../lib/tz.js';
import type { AiTool } from '../../lib/ai/provider.js';
import { OPEN_GROUPS } from '../control/rules.js';
import { analyticsData } from '../analytics/data.js';
import * as analytics from '../analytics/service.js';
import { expandDepartments, inDepartmentsWhere, visibleIssuesWhere } from '../issues/scope.js';
import { buildWhere, INCLUDE_RELATIONS } from '../issues/service.js';
import { departmentLines, loadDirectory, personLines, type Directory } from './directory.js';
import { DATA_RULES, clip, dataBlock, ruDate, todayLine } from './prompts.js';
import { runAi, type AiContext } from './service.js';
import { searchIssues } from '../search/service.js';

const HISTORY_MESSAGES = 12;
const MAX_ROWS = 30;
const KEY_IN_TEXT = /\b([A-Z0-9]{1,10})-(\d{1,9})\b/g;
const KEY_EXACT = /^([A-Za-z0-9]{1,10})-(\d{1,9})$/;

export interface IssueRef {
  id: string;
  key: string;
  title: string;
  project_id: string;
}

type ListedIssue = Prisma.IssueGetPayload<{
  include: typeof INCLUDE_RELATIONS & {
    project: { select: { id: true; name: true; identifier: true } };
  };
}>;

const ISSUE_INCLUDE = {
  ...INCLUDE_RELATIONS,
  project: { select: { id: true, name: true, identifier: true } },
} satisfies Prisma.IssueInclude;

/** What the model reads about an issue; also remembers it as a linkable issue. */
function rowOf(issue: ListedIssue, tz: string, seen: Map<string, IssueRef>) {
  const key = `${issue.project.identifier}-${issue.sequence_id}`;
  seen.set(key, { id: issue.id, key, title: issue.title, project_id: issue.project_id });
  const today = localDate(new Date(), tz);
  const open = (OPEN_GROUPS as string[]).includes(issue.state.group);
  const due = issue.due_date ? localDate(issue.due_date, tz) : null;
  const primary = issue.assignees.find((a) => a.is_primary) ?? issue.assignees[0];
  return {
    key,
    title: clip(issue.title, 200),
    kind: issue.kind === 'assignment' ? 'поручение' : 'задача',
    project: issue.project.name,
    state: issue.state.name,
    state_group: issue.state.group,
    priority: issue.priority,
    due_date: issue.due_date ? ruDate(issue.due_date, tz) : null,
    overdue_days: open && due && due < today ? daysBetween(due, today) : 0,
    assignee: primary?.user.display_name ?? null,
    acknowledged: primary ? Boolean(primary.acknowledged_at) : null,
    department: issue.department?.short_name ?? issue.department?.name ?? null,
    controller: issue.controller?.display_name ?? null,
  };
}

interface Asker {
  prisma: PrismaClient;
  workspace: AiContext['workspace'];
  member: WorkspaceMember;
  dir: Directory;
  seen: Map<string, IssueRef>;
}

/** Visible issue by its key, or null (private projects of others look absent). */
async function findByKey(a: Asker, key: string): Promise<ListedIssue | null> {
  const m = KEY_EXACT.exec(key.trim());
  if (!m) return null;
  return a.prisma.issue.findFirst({
    where: {
      AND: [
        visibleIssuesWhere(a.workspace.id, a.member),
        { project: { identifier: m[1]!.toUpperCase() }, sequence_id: Number(m[2]) },
      ],
    },
    include: ISSUE_INCLUDE,
  });
}

const json = (value: unknown) => JSON.stringify(value);

const SearchInput = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(MAX_ROWS).optional(),
});

const STATE_GROUPS = [
  'backlog',
  'unstarted',
  'started',
  'review',
  'completed',
  'cancelled',
] as const;
const ListInput = z.object({
  overdue: z.boolean().optional(),
  open: z.boolean().optional(),
  kind: z.enum(['task', 'assignment']).optional(),
  department_ref: z.string().optional(),
  assignee_ref: z.string().optional(),
  controlled_by_me: z.boolean().optional(),
  awaiting_my_review: z.boolean().optional(),
  created_by_me: z.boolean().optional(),
  due_within_days: z.number().int().min(0).max(365).optional(),
  review_pending: z.boolean().optional(),
  state_group: z.enum(STATE_GROUPS).optional(),
  sort: z.enum(['due_date', 'updated_at', 'created_at']).optional(),
  limit: z.number().int().min(1).max(MAX_ROWS).optional(),
});

const AnalyticsInput = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  department_ref: z.string().optional(),
  kind: z.enum(['task', 'assignment']).optional(),
});

function invalid(error: z.ZodError): never {
  throw new Error(
    `Invalid input: ${error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
  );
}

function departmentId(a: Asker, ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const dept = a.dir.departmentByRef.get(ref.trim());
  if (!dept) throw new Error(`Unknown department label ${ref}; use the labels from <org>`);
  return dept.id;
}

function personId(a: Asker, ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  if (ref === 'me') return a.member.user_id;
  const person = a.dir.personByRef.get(ref.trim());
  if (!person) throw new Error(`Unknown person label ${ref}; find people with find_people`);
  return person.id;
}

/** The tools of one question, bound to the asker. */
function toolsFor(a: Asker): AiTool[] {
  const tz = a.workspace.timezone;
  const viewer = { userId: a.member.user_id, timeZone: tz };

  return [
    {
      name: 'search_issues',
      description:
        'Поиск задач и поручений, доступных пользователю, по ключу (например ECON-12) или словам из названия и описания (с учётом падежей и окончаний). Возвращает до limit задач, самые подходящие сначала.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Ключ задачи или слова для поиска' },
          limit: { type: 'integer', description: 'Сколько задач вернуть, до 30 (по умолчанию 10)' },
        },
        required: ['query'],
      },
      run: async (input) => {
        const p = SearchInput.safeParse(input);
        if (!p.success) invalid(p.error);
        const exact = await findByKey(a, p.data.query);
        if (exact) return json({ issues: [rowOf(exact, tz, a.seen)] });
        // The workspace search (7.B2): Russian morphology, best matches first.
        const found = await searchIssues(
          a.prisma,
          a.workspace.id,
          a.member,
          p.data.query,
          p.data.limit ?? 10,
        );
        const rows = new Map(
          (
            await a.prisma.issue.findMany({
              where: { id: { in: found.map((f) => f.id) } },
              include: ISSUE_INCLUDE,
            })
          ).map((i) => [i.id, i]),
        );
        const issues = found.flatMap((f) => (rows.has(f.id) ? [rows.get(f.id)!] : []));
        return json({ issues: issues.map((i) => rowOf(i, tz, a.seen)) });
      },
    },
    {
      name: 'list_issues',
      description:
        'Список задач и поручений, доступных пользователю, по фильтрам (все фильтры вместе, через И). Возвращает total — сколько всего подходит — и первые limit задач. Метки подразделений (D…) — из <org>, людей (P…) — из find_people, «me» — сам пользователь.',
      input_schema: {
        type: 'object',
        properties: {
          overdue: {
            type: 'boolean',
            description: 'Только просроченные (срок прошёл, не исполнено)',
          },
          open: {
            type: 'boolean',
            description: 'true — только неисполненные, false — только исполненные или отменённые',
          },
          kind: {
            type: 'string',
            enum: ['task', 'assignment'],
            description: 'assignment — поручения, task — обычные задачи',
          },
          department_ref: {
            type: 'string',
            description: 'Метка подразделения D…; включает дочерние подразделения',
          },
          assignee_ref: { type: 'string', description: 'Метка исполнителя P… или me' },
          controlled_by_me: { type: 'boolean', description: 'Пользователь — контролёр' },
          awaiting_my_review: { type: 'boolean', description: 'Ждут проверки пользователем' },
          created_by_me: { type: 'boolean', description: 'Созданы пользователем' },
          due_within_days: {
            type: 'integer',
            description: 'Срок наступает в ближайшие N дней (0 — сегодня)',
          },
          review_pending: { type: 'boolean', description: 'Сданы на проверку и ждут решения' },
          state_group: { type: 'string', enum: [...STATE_GROUPS] },
          sort: { type: 'string', enum: ['due_date', 'updated_at', 'created_at'] },
          limit: { type: 'integer', description: 'До 30, по умолчанию 15' },
        },
      },
      run: async (input) => {
        const p = ListInput.safeParse(input ?? {});
        if (!p.success) invalid(p.error);
        const f = p.data;
        const assignee = personId(a, f.assignee_ref);
        const dept = departmentId(a, f.department_ref);
        const and: Prisma.IssueWhereInput[] = [
          visibleIssuesWhere(a.workspace.id, a.member),
          buildWhere(
            undefined,
            {
              overdue: f.overdue,
              open: f.open,
              kind: f.kind,
              assignee: assignee ? [assignee] : undefined,
              controller: f.controlled_by_me ? 'me' : undefined,
              reviewer: f.awaiting_my_review ? 'me' : undefined,
              review_pending: f.awaiting_my_review ? true : f.review_pending,
              created_by: f.created_by_me ? 'me' : undefined,
              due_within: f.due_within_days,
              state_group: f.state_group,
              sort_by: 'created_at',
              order: 'asc',
              limit: 15,
            },
            viewer,
          ),
        ];
        if (dept) {
          const ids = await expandDepartments(a.prisma, a.workspace.id, [dept]);
          and.push(inDepartmentsWhere(a.workspace.id, ids));
        }
        const where = { AND: and };
        const sort =
          f.sort ?? (f.overdue || f.due_within_days !== undefined ? 'due_date' : 'updated_at');
        const [total, issues] = await Promise.all([
          a.prisma.issue.count({ where }),
          a.prisma.issue.findMany({
            where,
            include: ISSUE_INCLUDE,
            orderBy: [{ [sort]: sort === 'due_date' ? 'asc' : 'desc' }, { id: 'asc' }],
            take: f.limit ?? 15,
          }),
        ]);
        return json({
          total,
          shown: issues.length,
          issues: issues.map((i) => rowOf(i, tz, a.seen)),
        });
      },
    },
    {
      name: 'get_issue',
      description:
        'Подробности одной задачи по ключу: описание, основание, исполнители, последние комментарии, сдачи на проверку и запросы переноса срока.',
      input_schema: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Ключ задачи, например ECON-12' } },
        required: ['key'],
      },
      run: async (input) => {
        const p = z.object({ key: z.string() }).safeParse(input);
        if (!p.success) invalid(p.error);
        const issue = await findByKey(a, p.data.key);
        if (!issue) return json({ error: 'Задача не найдена или недоступна пользователю' });
        const [comments, review, request] = await Promise.all([
          a.prisma.comment.findMany({
            where: { issue_id: issue.id, deleted_at: null },
            orderBy: { created_at: 'desc' },
            take: 5,
            include: { author: { select: { display_name: true } } },
          }),
          a.prisma.issueReview.findFirst({
            where: { issue_id: issue.id },
            orderBy: { submitted_at: 'desc' },
          }),
          a.prisma.deadlineChangeRequest.findFirst({
            where: { issue_id: issue.id },
            orderBy: { created_at: 'desc' },
          }),
        ]);
        return json({
          ...rowOf(issue, tz, a.seen),
          basis: issue.basis,
          description: clip(issue.description, 1500),
          co_assignees: issue.assignees
            .filter((x) => !x.is_primary)
            .map((x) => x.user.display_name),
          last_comments: comments.reverse().map((c) => ({
            date: ruDate(c.created_at, tz),
            author: c.author.display_name,
            text: clip(c.body, 300),
          })),
          last_hand_in: review
            ? {
                date: ruDate(review.submitted_at, tz),
                decision: review.decision,
                remark: clip(review.decision_comment, 300),
              }
            : null,
          last_deadline_request: request
            ? {
                date: ruDate(request.created_at, tz),
                new_due_date: ruDate(request.new_due_date, tz),
                status: request.status,
                reason: clip(request.reason, 300),
              }
            : null,
        });
      },
    },
    {
      name: 'find_people',
      description:
        'Найти сотрудников по фамилии, имени, должности или подразделению. Возвращает метки P… для list_issues.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Фамилия, должность или подразделение' },
        },
        required: ['query'],
      },
      run: async (input) => {
        const p = z.object({ query: z.string().min(1).max(200) }).safeParse(input);
        if (!p.success) invalid(p.error);
        const words = p.data.query.toLowerCase().split(/\s+/).filter(Boolean);
        const found = a.dir.people.filter((person) => {
          const dept = person.department_id
            ? a.dir.departmentById.get(person.department_id)
            : undefined;
          const hay = [person.name, person.position, dept?.name, dept?.short_name]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return words.every((w) => hay.includes(w));
        });
        return found.length
          ? personLines(a.dir, found.slice(0, 15))
          : 'Никого не найдено. Попробуйте другую формулировку.';
      },
    },
    {
      name: 'get_analytics',
      description:
        'Показатели исполнительской дисциплины за период в пределах прав пользователя: создано, исполнено, в срок и с опозданием, дисциплина (%), открыто, просрочено, без ознакомления, переносы, возвраты — с предыдущим периодом для сравнения и разбивкой по подразделениям. По умолчанию — последние 30 дней.',
      input_schema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'ГГГГ-ММ-ДД, включительно' },
          to: { type: 'string', description: 'ГГГГ-ММ-ДД, включительно' },
          department_ref: { type: 'string', description: 'Метка подразделения D…' },
          kind: { type: 'string', enum: ['task', 'assignment'] },
        },
      },
      run: async (input) => {
        const p = AnalyticsInput.safeParse(input ?? {});
        if (!p.success) invalid(p.error);
        const dept = departmentId(a, p.data.department_ref);
        const d = await analyticsData(a.prisma, a.workspace, a.member, {
          from: p.data.from,
          to: p.data.to,
          department: dept,
          kind: p.data.kind,
          limit: 10,
        });
        const s = analytics.summary(d);
        const level = (nodes: analytics.DepartmentNode[]): analytics.DepartmentNode[] =>
          nodes.length === 1 && nodes[0]!.children.length > 0 ? nodes[0]!.children : nodes;
        const top = analytics.overdue(d, 5);
        return json({
          period: d.period,
          previous_period: s.previous_period,
          scope: d.scope.kind,
          current: s.current,
          previous: s.previous,
          by_department: level(analytics.byDepartment(d).tree).map((n) => ({
            department: n.short_name ?? n.name,
            ref: a.dir.departmentById.get(n.id)?.ref,
            ...n.total,
          })),
          worst_overdue: top.items.map((x) => ({
            key: x.key,
            title: clip(x.title, 140),
            days_overdue: x.days_overdue,
          })),
        });
      },
    },
  ];
}

function systemPrompt(a: Asker, name: string): string {
  const me = a.dir.personById.get(a.member.user_id);
  const dept = me?.department_id ? a.dir.departmentById.get(me.department_id) : undefined;
  return [
    `Ты — AI-помощник в системе контроля исполнения поручений университета «${a.workspace.name}». Ты отвечаешь на вопросы сотрудника: ${name}${me?.position ? `, ${me.position}` : ''}${dept ? `, ${dept.name}` : ''}; роль в системе — ${a.member.role}${me ? `; его метка ${me.ref}` : ''}.`,
    `Отвечай по данным, которые возвращают инструменты. Инструменты работают с правами этого пользователя и показывают только то, что ему доступно. Если данных нет или доступа нет — так и скажи, не додумывай.

Как отвечать:
- Сначала прямой ответ (цифра, вывод, список), потом детали. Коротко: обычно до 150 слов.
- Задачи называй по ключу (например ECON-12) — интерфейс сделает из ключа ссылку. Называй только задачи из результатов инструментов этого ответа.
- Формат: абзацы, списки «- », **жирный**. Без таблиц и заголовков.
- «Сколько», «какая дисциплина», «как изменилось» — get_analytics; конкретные задачи по условиям — list_issues; поиск по словам или ключу — search_issues; подробности одной задачи — get_issue; люди — find_people.
- Подразделения обозначены метками из <org>.`,
    todayLine(a.workspace.timezone),
    DATA_RULES,
    dataBlock(
      'org',
      `Подразделения (метка | название | место в структуре | руководитель):\n${departmentLines(a.dir)}`,
    ),
  ].join('\n\n');
}

/** Issue links of an answer: the keys it names that a tool returned in this turn. */
function linksOf(text: string, seen: Map<string, IssueRef>): IssueRef[] {
  const out = new Map<string, IssueRef>();
  for (const m of text.matchAll(KEY_IN_TEXT)) {
    const ref = seen.get(m[0]);
    if (ref) out.set(ref.key, ref);
  }
  return [...out.values()].slice(0, MAX_ROWS);
}

async function ownConversation(ctx: AiContext, id: string) {
  const conversation = await ctx.prisma.aiConversation.findFirst({
    where: { id, user_id: ctx.member.user_id, workspace_id: ctx.workspace.id },
  });
  if (!conversation) throw AppError.notFound('Conversation not found');
  return conversation;
}

/** `POST WS/ai/ask`. */
export async function ask(ctx: AiContext, body: { question: string; conversation_id?: string }) {
  const question = body.question.trim();
  if (!question) throw AppError.badRequest('The question is empty');
  const existing = body.conversation_id ? await ownConversation(ctx, body.conversation_id) : null;
  const history = existing
    ? (
        await ctx.prisma.aiMessage.findMany({
          where: { conversation_id: existing.id },
          orderBy: { created_at: 'desc' },
          take: HISTORY_MESSAGES,
        })
      )
        .reverse()
        .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.content }))
    : [];
  const [dir, user] = await Promise.all([
    loadDirectory(ctx.prisma, ctx.workspace.id),
    ctx.prisma.user.findUnique({
      where: { id: ctx.member.user_id },
      select: { display_name: true },
    }),
  ]);
  const asker: Asker = { ...ctx, dir, seen: new Map() };

  const result = await runAi(ctx, 'ask', (provider, signal) =>
    provider.agent({
      system: systemPrompt(asker, user?.display_name ?? ''),
      // History starts with the user; a lone assistant turn would be dropped anyway.
      history: history[0]?.role === 'assistant' ? history.slice(1) : history,
      content: [{ type: 'text', text: question }],
      tools: toolsFor(asker),
      maxSteps: 6,
      maxTokens: 8000,
      effort: 'medium',
      signal,
    }),
  );

  const answer = result.value.trim();
  const issues = linksOf(answer, asker.seen);
  const saved = await ctx.prisma.$transaction(async (tx) => {
    const conversation = existing
      ? await tx.aiConversation.update({
          where: { id: existing.id },
          data: { updated_at: new Date() },
        })
      : await tx.aiConversation.create({
          data: {
            workspace_id: ctx.workspace.id,
            user_id: ctx.member.user_id,
            title: clip(question.replace(/\s+/g, ' '), 80).replace(/… \[обрезано\]$/, '…'),
          },
        });
    const asked = await tx.aiMessage.create({
      data: { conversation_id: conversation.id, role: 'user', content: question },
    });
    const answered = await tx.aiMessage.create({
      data: {
        conversation_id: conversation.id,
        role: 'assistant',
        content: answer,
        issue_refs: issues as unknown as Prisma.InputJsonValue,
        // Strictly after the question, so the order survives equal timestamps.
        created_at: new Date(asked.created_at.getTime() + 1),
      },
    });
    return { conversation, asked, answered };
  });

  return {
    conversation: saved.conversation,
    question: {
      id: saved.asked.id,
      role: 'user',
      content: question,
      issues: [],
      created_at: saved.asked.created_at,
    },
    message: {
      id: saved.answered.id,
      role: 'assistant',
      content: answer,
      issues,
      created_at: saved.answered.created_at,
    },
    model: result.model,
  };
}

/** `GET WS/ai/conversations`: the caller's own dialogues, newest first. */
export async function listConversations(ctx: AiContext) {
  const data = await ctx.prisma.aiConversation.findMany({
    where: { workspace_id: ctx.workspace.id, user_id: ctx.member.user_id },
    orderBy: { updated_at: 'desc' },
    take: 50,
    select: { id: true, title: true, created_at: true, updated_at: true },
  });
  return { data };
}

/** `GET WS/ai/conversations/:id` — links re-checked against the reader's rights. */
export async function getConversation(ctx: AiContext, id: string) {
  const conversation = await ownConversation(ctx, id);
  const messages = await ctx.prisma.aiMessage.findMany({
    where: { conversation_id: id },
    orderBy: { created_at: 'asc' },
  });
  const refs = messages.flatMap((m) =>
    Array.isArray(m.issue_refs) ? (m.issue_refs as unknown as IssueRef[]) : [],
  );
  const visible = new Set(
    refs.length
      ? (
          await ctx.prisma.issue.findMany({
            where: {
              AND: [
                visibleIssuesWhere(ctx.workspace.id, ctx.member),
                { id: { in: refs.map((r) => r.id) } },
              ],
            },
            select: { id: true },
          })
        ).map((i) => i.id)
      : [],
  );
  return {
    ...conversation,
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      issues: (Array.isArray(m.issue_refs) ? (m.issue_refs as unknown as IssueRef[]) : []).filter(
        (r) => visible.has(r.id),
      ),
      created_at: m.created_at,
    })),
  };
}

export async function deleteConversation(ctx: AiContext, id: string): Promise<void> {
  const { count } = await ctx.prisma.aiConversation.deleteMany({
    where: { id, user_id: ctx.member.user_id, workspace_id: ctx.workspace.id },
  });
  if (count === 0) throw AppError.notFound('Conversation not found');
}
