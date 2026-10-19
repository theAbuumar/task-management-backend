// «Кратко» for an issue (Ф11 11.B3): the gist, where it stands, what is in the
// way and what comes next — from the description, comments, hand-ins, deadline
// requests and history.
//
// Only what the caller already sees in the issue card goes to the model: the
// route sits under `/projects/:projectId/issues/:issueId`, so the workspace hook
// has checked membership and the project's visibility (a private project of
// someone else is a 404 before this runs). Nothing is stored: the summary is
// made on request and shown next to the card.

import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import * as issueService from '../issues/service.js';
import { DATA_RULES, clip, dataBlock, fullName, ruDate, todayLine } from './prompts.js';
import { runAi, type AiContext } from './service.js';

const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['essence', 'status', 'blockers', 'next_steps'],
  properties: {
    essence: { type: 'string' },
    status: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
    next_steps: { type: 'array', items: { type: 'string' } },
  },
} as const;

const SummarySchema = z.object({
  essence: z.string(),
  status: z.string(),
  blockers: z.array(z.string()),
  next_steps: z.array(z.string()),
});

const SYSTEM = `Ты — помощник аппарата ректора университета в системе контроля исполнения поручений. По данным задачи составь короткую справку для руководителя, который открыл карточку и хочет за 10 секунд понять, что происходит.

Поля ответа:
- essence — суть поручения в 1–2 предложениях: что нужно сделать и зачем;
- status — текущее положение дел в 1–3 предложениях: стадия, кто исполняет, срок (просрочено ли, на сколько дней), была ли сдача и чем закончилась проверка, переносился ли срок;
- blockers — что мешает или вызывает вопросы: замечания контролёра, просрочка, нет ознакомления, ожидание решения по переносу, вопросы в комментариях. Пустой список, если ничего;
- next_steps — 1–3 следующих шага с указанием, кто их делает.
Пиши конкретно и только по данным, без общих слов. Даты — в формате ДД.ММ.ГГГГ.

${DATA_RULES}`;

const ACTION_RU: Record<string, string> = {
  'issue.created': 'создал задачу',
  'issue.updated': 'изменил',
  'issue.assignee_added': 'добавил исполнителя',
  'issue.assignee_removed': 'убрал исполнителя',
  'issue.acknowledged': 'отметил «Ознакомлен»',
  'issue.review_submitted': 'сдал на проверку',
  'issue.review_approved': 'принял работу',
  'issue.review_returned': 'вернул на доработку',
  'issue.deadline_requested': 'запросил перенос срока',
  'issue.deadline_approved': 'одобрил перенос срока',
  'issue.deadline_rejected': 'отклонил перенос срока',
  'issue.attachment_added': 'приложил файл',
  'comment.created': 'оставил комментарий',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The issue card as text: fields, people, hand-ins, deadline requests, comments, history. */
async function issueData(ctx: AiContext, projectId: string, issueId: string): Promise<string> {
  const tz = ctx.workspace.timezone;
  const issue = await issueService.getIssue(ctx.prisma, ctx.workspace.id, projectId, issueId);
  const [project, people, reviews, requests, comments, activity, children, states] =
    await Promise.all([
      ctx.prisma.project.findUnique({
        where: { id: projectId },
        select: { name: true, identifier: true },
      }),
      ctx.prisma.user.findMany({
        where: {
          id: {
            in: [
              issue.created_by_id,
              ...(issue.controller_id ? [issue.controller_id] : []),
              ...issue.assignees.map((a) => a.user_id),
            ],
          },
        },
        select: {
          id: true,
          display_name: true,
          last_name: true,
          first_name: true,
          middle_name: true,
          workspace_memberships: {
            where: { workspace_id: ctx.workspace.id },
            select: { position: true },
          },
        },
      }),
      ctx.prisma.issueReview.findMany({
        where: { issue_id: issueId },
        orderBy: { submitted_at: 'asc' },
        take: 20,
        include: {
          submitted_by: { select: { display_name: true } },
          decided_by: { select: { display_name: true } },
        },
      }),
      ctx.prisma.deadlineChangeRequest.findMany({
        where: { issue_id: issueId },
        orderBy: { created_at: 'asc' },
        take: 20,
        include: { requested_by: { select: { display_name: true } } },
      }),
      ctx.prisma.comment.findMany({
        where: { issue_id: issueId, deleted_at: null },
        orderBy: { created_at: 'desc' },
        take: 40,
        include: { author: { select: { display_name: true } } },
      }),
      ctx.prisma.activityLog.findMany({
        where: { issue_id: issueId },
        orderBy: { created_at: 'desc' },
        take: 40,
        include: { actor: { select: { display_name: true } } },
      }),
      ctx.prisma.issue.findMany({
        where: { parent_id: issueId, deleted_at: null },
        orderBy: { sequence_id: 'asc' },
        take: 50,
        select: { sequence_id: true, title: true, state: { select: { name: true } } },
      }),
      ctx.prisma.state.findMany({
        where: { project_id: projectId },
        select: { id: true, name: true },
      }),
    ]);

  const who = new Map(
    people.map((p) => {
      const position = p.workspace_memberships[0]?.position;
      return [p.id, position ? `${fullName(p)} (${position})` : fullName(p)];
    }),
  );
  const stateName = new Map(states.map((s) => [s.id, s.name]));
  const value = (field: string | null, v: string | null) => {
    if (!v) return '—';
    if (field === 'state_id') return stateName.get(v) ?? '—';
    if (field?.endsWith('_date')) return ruDate(new Date(v), tz) || v;
    return UUID.test(v) ? '…' : clip(v, 120);
  };
  const key = `${project?.identifier ?? ''}-${issue.sequence_id}`;
  const primary = issue.assignees.find((a) => a.is_primary) ?? issue.assignees[0];

  const card = [
    `Ключ: ${key}`,
    `Проект: ${project?.name ?? ''}`,
    `Тип: ${issue.kind === 'assignment' ? 'поручение' : 'задача'}`,
    `Название: ${issue.title}`,
    `Состояние: ${issue.state.name} (${issue.state.group})`,
    `Приоритет: ${issue.priority}`,
    `Срок: ${ruDate(issue.due_date, tz) || 'не указан'}`,
    issue.completed_at ? `Выполнено: ${ruDate(issue.completed_at, tz)}` : '',
    `Создано: ${ruDate(issue.created_at, tz)}, автор: ${who.get(issue.created_by_id) ?? ''}`,
    `Контролёр: ${issue.controller_id ? who.get(issue.controller_id) : 'автор'}${issue.requires_review ? ', работа сдаётся на проверку' : ''}`,
    `Ответственный: ${primary ? `${who.get(primary.user_id)}${primary.acknowledged_at ? `, ознакомлен ${ruDate(primary.acknowledged_at, tz)}` : ', не ознакомлен'}` : 'не назначен'}`,
    issue.assignees.length > 1
      ? `Соисполнители: ${issue.assignees
          .filter((a) => a !== primary)
          .map((a) => who.get(a.user_id))
          .join('; ')}`
      : '',
    issue.department ? `Адресовано подразделению: ${issue.department.name}` : '',
    issue.basis ? `Основание: ${issue.basis}` : '',
    issue.distribution
      ? `Рассылка подразделениям: всего ${issue.distribution.total}, исполнено ${issue.distribution.completed}, на проверке ${issue.distribution.review}, в работе ${issue.distribution.open}, просрочено ${issue.distribution.overdue}`
      : '',
    children.length
      ? `Подзадачи:\n${children.map((c) => `- ${c.title} — ${c.state.name}`).join('\n')}`
      : '',
    `Описание:\n${clip(issue.description, 6000) || '—'}`,
  ]
    .filter(Boolean)
    .join('\n');

  const handIns = reviews.length
    ? reviews
        .map(
          (r) =>
            `- ${ruDate(r.submitted_at, tz)} сдал ${r.submitted_by.display_name}: ${clip(r.report, 800) || 'без отчёта'}; решение: ${
              r.decision === 'pending'
                ? 'ожидает проверки'
                : `${r.decision === 'approved' ? 'принято' : 'возвращено'} ${ruDate(r.decided_at, tz)}${r.decided_by ? ` (${r.decided_by.display_name})` : ''}${r.decision_comment ? `, замечание: ${clip(r.decision_comment, 500)}` : ''}`
            }`,
        )
        .join('\n')
    : 'нет';
  const moves = requests.length
    ? requests
        .map(
          (r) =>
            `- ${ruDate(r.created_at, tz)} ${r.requested_by.display_name} просит перенести срок на ${ruDate(r.new_due_date, tz)}: ${clip(r.reason, 400)}; ${
              r.status === 'pending'
                ? 'ждёт решения'
                : r.status === 'approved'
                  ? 'одобрено'
                  : 'отклонено'
            }${r.decision_comment ? ` (${clip(r.decision_comment, 300)})` : ''}`,
        )
        .join('\n')
    : 'нет';
  const talk = comments.length
    ? comments
        .reverse()
        .map((c) => `- ${ruDate(c.created_at, tz)} ${c.author.display_name}: ${clip(c.body, 800)}`)
        .join('\n')
    : 'нет';
  const history = activity
    .reverse()
    .map((a) => {
      const verb = ACTION_RU[a.action] ?? a.action;
      const change =
        a.action === 'issue.updated' && a.field
          ? ` ${a.field}: ${value(a.field, a.old_value)} → ${value(a.field, a.new_value)}`
          : '';
      return `- ${ruDate(a.created_at, tz)} ${a.actor.display_name} ${verb}${change}`;
    })
    .join('\n');

  return [
    dataBlock('issue', card),
    dataBlock('history', `Сдачи на проверку:\n${handIns}\n\nЗапросы переноса срока:\n${moves}`),
    dataBlock('comments', talk),
    dataBlock('history', `Последние события:\n${history || 'нет'}`),
  ].join('\n\n');
}

/** `POST I/ai/summary`. */
export async function summarizeIssue(ctx: AiContext, projectId: string, issueId: string) {
  const data = await issueData(ctx, projectId, issueId);
  const result = await runAi(ctx, 'summary', (provider, signal) =>
    provider.json({
      system: `${SYSTEM}\n\n${todayLine(ctx.workspace.timezone)}`,
      content: [
        { type: 'text', text: data },
        { type: 'text', text: 'Составь справку по этой задаче.' },
      ],
      schema: SUMMARY_SCHEMA,
      maxTokens: 4000,
      effort: 'low',
      signal,
    }),
  );
  const parsed = SummarySchema.safeParse(result.value);
  if (!parsed.success) throw new AppError(502, 'AI_BAD_OUTPUT', 'The AI answer could not be used');
  return {
    issue_id: issueId,
    ...parsed.data,
    model: result.model,
    generated_at: new Date(),
  };
}
