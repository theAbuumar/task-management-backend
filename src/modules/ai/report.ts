// «Сформировать записку» (Ф11 11.B4): an analytical memo for the management
// over a period, written from the ready-made metrics of Ф10 (10.B1).
//
// What the model gets is what the analytics page shows the caller: the same
// loader (analyticsData) cuts the facts to their scope — the whole workspace for
// admins, the subtree of a department head, the own work of anyone else
// (10.B3). Only aggregated numbers and the top overdue items (key, title,
// department, days) go in — no descriptions, comments or reports.
//
// The memo comes back as text; the person edits it and downloads it as PDF or
// DOCX (`exportMemo`). The download takes the edited text, not the model's.

import type { FastifyRequest } from 'fastify';
import { writeAudit } from '../../lib/audit.js';
import { daysBetween } from '../../lib/tz.js';
import { analyticsData, type AnalyticsData } from '../analytics/data.js';
import * as analytics from '../analytics/service.js';
import type { Counters } from '../analytics/metrics.js';
import type { AnalyticsQuery } from '../analytics/schema.js';
import { memoDocx, memoPdf } from './memo.js';
import { DATA_RULES, clip, dataBlock, todayLine } from './prompts.js';
import { runAi, type AiContext } from './service.js';

const ru = (iso: string) => iso.split('-').reverse().join('.');

const COUNTER_GLOSSARY = `Показатели (поля counters):
created — создано за период; completed — исполнено за период; on_time / late — из исполненных со сроком: в срок / с опозданием; no_deadline — исполнено без срока;
discipline — исполнительская дисциплина, % исполненных в срок от исполненных со сроком (null — не было исполненных со сроком);
open — открыто на конец периода; overdue — просрочено на конец периода; unacknowledged — открытые поручения без отметки «Ознакомлен»;
median_execution_days — медиана дней от создания до исполнения; median_reaction_hours — медиана часов до отметки «Ознакомлен»;
deadline_changes — одобренных переносов срока; returns — возвратов на доработку.`;

function brief(c: Counters) {
  return {
    created: c.created,
    completed: c.completed,
    on_time: c.on_time,
    late: c.late,
    discipline: c.discipline,
    open: c.open,
    overdue: c.overdue,
    unacknowledged: c.unacknowledged,
    median_execution_days: c.median_execution_days,
    median_reaction_hours: c.median_reaction_hours,
    deadline_changes: c.deadline_changes,
    returns: c.returns,
  };
}

/** Departments two levels deep with their totals; empty ones dropped. */
function departmentRows(d: AnalyticsData) {
  const rows: { department: string; level: number; counters: ReturnType<typeof brief> }[] = [];
  const walk = (nodes: analytics.DepartmentNode[], level: number) => {
    for (const n of nodes) {
      if (n.total.created + n.total.completed + n.total.open > 0) {
        rows.push({
          department: n.short_name ? `${n.name} (${n.short_name})` : n.name,
          level,
          counters: brief(n.total),
        });
      }
      if (level < 2) walk(n.children, level + 1);
    }
  };
  walk(analytics.byDepartment(d).tree, 1);
  return rows;
}

/** The metrics block: the numbers of the analytics page, nothing raw. */
export function memoMetrics(d: AnalyticsData) {
  const summary = analytics.summary(d);
  const bucket = daysBetween(d.period.from, d.period.to) > 62 ? 'month' : 'week';
  const overdue = analytics.overdue(d, 10);
  const changes = analytics.deadlineChanges(d, 0);
  const reaction = analytics.reactionTime(d);
  const departments = new Map(d.departments.map((x) => [x.id, x]));
  return {
    organization: d.workspace.name,
    period: d.period,
    previous_period: summary.previous_period,
    scope:
      d.scope.kind === 'all'
        ? 'всё пространство'
        : d.scope.kind === 'departments'
          ? `подразделения: ${d.scope.department_ids
              .map((id) => departments.get(id)?.name)
              .filter(Boolean)
              .join(', ')}`
          : 'только собственные поручения пользователя',
    current: brief(summary.current),
    previous: brief(summary.previous),
    by_department: departmentRows(d),
    trend: analytics.trends(d, bucket).items.map((t) => ({
      from: t.from,
      to: t.to,
      created: t.created,
      completed: t.completed,
      discipline: t.discipline,
      overdue: t.overdue,
    })),
    overdue_top: {
      total: overdue.total,
      items: overdue.items.map((x) => ({
        key: x.key,
        title: clip(x.title, 140),
        department: x.department?.short_name ?? x.department?.name ?? null,
        days_overdue: x.days_overdue,
        deadline_changes: x.deadline_changes,
      })),
    },
    deadline_requests: {
      approved: changes.approved,
      rejected: changes.rejected,
      pending: changes.pending,
    },
    reaction: {
      median_hours: reaction.median_hours,
      acknowledged: reaction.acknowledged,
      unacknowledged: reaction.unacknowledged,
    },
  };
}

const SYSTEM = `Ты — аналитик аппарата ректора университета. По готовым показателям системы контроля исполнения поручений составь аналитическую записку для ректора и проректоров.

Структура (заголовки второго уровня):
## Общие итоги — ключевые цифры периода и сравнение с предыдущим периодом (рост или снижение, на сколько).
## Исполнение по подразделениям — лучшие и отстающие, с цифрами дисциплины и просрочек.
## Проблемные зоны — просроченные поручения (с ключами, например ECON-12), переносы сроков, возвраты на доработку, поручения без ознакомления.
## Выводы и предложения — 3–5 конкретных предложений руководству.

Формат: только заголовки «## », абзацы, маркированные списки «- » и выделение **жирным**. Без таблиц и без заголовка всей записки — он будет добавлен. Объём — около одной страницы А4 (400–600 слов).
Используй только цифры из <metrics>; если показателя нет (null), не придумывай его. Дисциплину пиши в процентах. Тон — деловой, без канцелярских штампов.

${COUNTER_GLOSSARY}

${DATA_RULES}`;

export interface MemoQuery extends AnalyticsQuery {
  focus?: string;
}

export function memoTitle(d: Pick<AnalyticsData, 'period'>): string {
  return `Аналитическая записка об исполнении поручений за период с ${ru(d.period.from)} по ${ru(d.period.to)}`;
}

/** `POST WS/ai/report`. */
export async function generateMemo(ctx: AiContext, query: MemoQuery) {
  const d = await analyticsData(ctx.prisma, ctx.workspace, ctx.member, query);
  const metrics = memoMetrics(d);
  const result = await runAi(ctx, 'report', (provider, signal) =>
    provider.text({
      system: `${SYSTEM}\n\n${todayLine(ctx.workspace.timezone)}`,
      content: [
        { type: 'text', text: dataBlock('metrics', JSON.stringify(metrics, null, 1)) },
        {
          type: 'text',
          text: `Составь записку по этим показателям.${query.focus?.trim() ? `\nПожелание составителя: ${query.focus.trim()}` : ''}`,
        },
      ],
      maxTokens: 8000,
      effort: 'medium',
      signal,
    }),
  );
  return {
    title: memoTitle(d),
    text: result.value.trim(),
    period: d.period,
    scope: d.scope,
    model: result.model,
    generated_at: new Date(),
  };
}

export interface MemoExport {
  format: 'pdf' | 'docx';
  title: string;
  text: string;
}

/** `POST WS/ai/report/export`: the edited memo as a file; recorded in the audit log. */
export async function exportMemo(
  ctx: AiContext,
  request: FastifyRequest,
  body: MemoExport,
): Promise<{ bytes: Buffer; name: string; type: string }> {
  const author = await ctx.prisma.user.findUnique({
    where: { id: ctx.member.user_id },
    select: { display_name: true },
  });
  const memo = {
    organization: ctx.workspace.name,
    shortName: ctx.workspace.short_name,
    title: body.title.trim(),
    text: body.text,
    author: author?.display_name ?? '',
    position: ctx.member.position,
    timeZone: ctx.workspace.timezone,
  };
  const bytes = body.format === 'pdf' ? await memoPdf(memo) : await memoDocx(memo);
  await writeAudit(
    ctx.prisma,
    {
      workspace_id: ctx.workspace.id,
      actor_id: ctx.member.user_id,
      action: 'report.exported',
      target_type: 'report',
      target_id: 'ai-memo',
      meta: { report: 'ai-memo', format: body.format, title: memo.title },
    },
    request,
  );
  return {
    bytes,
    name: `Аналитическая записка.${body.format}`,
    type:
      body.format === 'pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
}
