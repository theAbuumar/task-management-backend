// Assignment drafts from a document (Ф11 11.B2) and from a phrase in Telegram
// (11.T1). AI proposes, a person creates (ADR-016): nothing is written here.
//
// The model answers by a JSON schema with labels from the org directory
// (directory.ts). Each label is mapped back and checked:
//   - a named person → the assignee;
//   - one department → its head is the assignee (as a distribution would do);
//   - several departments → a distribution draft (6.B1), one copy per department;
//   - nothing usable → no assignee and a warning for the person to pick one.
// Doubts the person must look at (no head, deadline in the past, unknown name)
// come back as `warnings` next to the draft.

import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { localDate } from '../../lib/tz.js';
import type { AiPart } from '../../lib/ai/provider.js';
import {
  departmentBrief,
  departmentLines,
  headOf,
  loadDirectory,
  personBrief,
  personLines,
  type Directory,
  type DirectoryDepartment,
  type DirectoryPerson,
} from './directory.js';
import { readSource, type SourceInput } from './documents.js';
import { DATA_RULES, dataBlock, todayLine } from './prompts.js';
import { runAi, type AiContext } from './service.js';

const MAX_DRAFTS = 50;
const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };

/** Structured output schema: every object closed, every field present. */
export const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['basis', 'items'],
  properties: {
    basis: nullableString,
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'title',
          'description',
          'assignee_ref',
          'department_refs',
          'controller_ref',
          'due_date',
          'priority',
          'basis',
          'assignee_text',
          'source_quote',
        ],
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          assignee_ref: nullableString,
          department_refs: { type: 'array', items: { type: 'string' } },
          controller_ref: nullableString,
          due_date: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
          priority: { type: 'string', enum: [...PRIORITIES] },
          basis: nullableString,
          assignee_text: nullableString,
          source_quote: nullableString,
        },
      },
    },
  },
} as const;

const RawItemSchema = z.object({
  title: z.string(),
  description: z.string().nullish(),
  assignee_ref: z.string().nullish(),
  department_refs: z.array(z.string()).nullish(),
  controller_ref: z.string().nullish(),
  due_date: z.string().nullish(),
  priority: z.enum(PRIORITIES).catch('medium'),
  basis: z.string().nullish(),
  assignee_text: z.string().nullish(),
  source_quote: z.string().nullish(),
});
const RawDraftsSchema = z.object({
  basis: z.string().nullish(),
  items: z.array(RawItemSchema),
});
export type RawDraft = z.infer<typeof RawItemSchema>;

const FIELD_RULES = `Как заполнять поля каждого поручения:
- title — коротко, с глагола в неопределённой форме («Подготовить отчёт о …»), до 150 символов.
- description — что именно сделать и в каком виде сдать результат, только по тексту. Пустая строка, если добавить нечего.
- assignee_ref — метка сотрудника (P…) из справочника <org>, если исполнитель назван по имени или по должности, которую занимает один человек («проректору по учебной работе», «декану ФЭУ»). Если не уверен — null.
- department_refs — метки подразделений (D…), если поручение адресовано подразделениям («деканам факультетов», «кафедре …», «отделу кадров»). «Всем факультетам» — перечисли все подходящие подразделения. Если исполнитель — конкретный человек, пустой массив.
- controller_ref — метка того, на кого возложен контроль исполнения («контроль возложить на …»), иначе null.
- due_date — срок в формате ГГГГ-ММ-ДД. Относительные сроки («в недельный срок», «до конца месяца», «к 1 ноября») считай от даты документа, а если её нет — от сегодняшней даты. Срока нет — null.
- priority — urgent: «срочно», «незамедлительно»; high: важное поручение или срок короче недели; иначе medium.
- basis — реквизиты документа и пункт («Протокол заседания ректората № 5 от 12.10.2026, п. 3»), если они есть в тексте, иначе null.
- assignee_text — как исполнитель назван в тексте, дословно, или null.
- source_quote — дословный фрагмент текста (до 300 символов), из которого взято поручение.`;

function systemPrompt(dir: Directory, ctx: AiContext, mode: 'document' | 'phrase'): string {
  const author = dir.personById.get(ctx.member.user_id);
  const task =
    mode === 'document'
      ? `Пользователь загрузил документ: протокол заседания, приказ, служебную записку или просто текст. Найди в нём все поручения — действия, которые кому-то поручено выполнить, — и подготовь по каждому черновик карточки поручения. Порядок — как в документе. Не объединяй разные поручения в одно и не дроби одно на части. Информационные пункты («заслушали», «принять к сведению») — не поручения. Если поручений нет, верни пустой список items. Поле basis верхнего уровня — реквизиты документа целиком (вид, номер, дата) или null.`
      : `Пользователь своими словами описал одно поручение (или поправку к черновику). Верни ровно один элемент в items. Поле basis верхнего уровня — null.`;
  return [
    `Ты — помощник аппарата ректора университета «${ctx.workspace.name}» в системе контроля исполнения поручений. Ты только готовишь черновики: проверит и создаст поручения человек.`,
    task,
    FIELD_RULES,
    DATA_RULES,
    todayLine(ctx.workspace.timezone),
    author
      ? `Автор запроса — ${author.ref} (${author.name}${author.position ? `, ${author.position}` : ''}). «Мне», «я» в тексте — это он.`
      : '',
    dataBlock(
      'org',
      `Подразделения (метка | название | место в структуре | руководитель):\n${departmentLines(dir)}\n\nСотрудники (метка | ФИО | должность | подразделение):\n${personLines(dir)}`,
    ),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export interface Draft {
  title: string;
  description: string;
  priority: (typeof PRIORITIES)[number];
  /** `person` — one assignee; `distribution` — a copy for each department (6.B1). */
  mode: 'person' | 'distribution';
  assignee: ReturnType<typeof personBrief>;
  departments: NonNullable<ReturnType<typeof departmentBrief>>[];
  controller: ReturnType<typeof personBrief>;
  /** Local date YYYY-MM-DD in the workspace zone, or null. */
  due_date: string | null;
  basis: string | null;
  assignee_text: string | null;
  source_quote: string | null;
  warnings: string[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string | null | undefined): string | null {
  if (!value || !DATE.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : value;
}

const deptName = (d: DirectoryDepartment) => d.short_name ?? d.name;

/** Map one model item onto the directory, with the doubts a person should check. */
export function mapDraft(
  dir: Directory,
  raw: RawDraft,
  documentBasis: string | null,
  timeZone: string,
): Draft {
  const warnings: string[] = [];
  let assignee: DirectoryPerson | undefined = raw.assignee_ref
    ? dir.personByRef.get(raw.assignee_ref.trim())
    : undefined;
  const departments = [
    ...new Map(
      (raw.department_refs ?? [])
        .map((ref) => dir.departmentByRef.get(ref.trim()))
        .filter((d): d is DirectoryDepartment => Boolean(d))
        .map((d) => [d.id, d]),
    ).values(),
  ];
  let mode: Draft['mode'] = 'person';

  if (!assignee && departments.length === 1) {
    const dept = departments[0]!;
    assignee = headOf(dir, dept);
    if (assignee) warnings.push(`Исполнитель — руководитель подразделения «${deptName(dept)}».`);
    else
      warnings.push(`У подразделения «${deptName(dept)}» нет руководителя — выберите исполнителя.`);
  } else if (!assignee && departments.length > 1) {
    mode = 'distribution';
    const headless = departments.filter((d) => !headOf(dir, d));
    if (headless.length > 0) {
      warnings.push(
        `Нет руководителя: ${headless.map(deptName).join(', ')} — назначьте его или уберите подразделение из рассылки.`,
      );
    }
  }
  if (mode === 'person' && !assignee) {
    if (departments.length === 0) {
      warnings.push(
        raw.assignee_text
          ? `Исполнитель «${raw.assignee_text}» не найден в оргструктуре — выберите его.`
          : 'Исполнитель не указан — выберите его.',
      );
    }
  }

  const controller = raw.controller_ref
    ? dir.personByRef.get(raw.controller_ref.trim())
    : undefined;
  if (raw.controller_ref && !controller) warnings.push('Контролёр не найден в оргструктуре.');

  const due = validDate(raw.due_date);
  if (raw.due_date && !due) warnings.push('Срок в тексте не распознан — укажите дату.');
  if (due && due < localDate(new Date(), timeZone))
    warnings.push('Срок уже прошёл — проверьте дату.');
  if (!due && !raw.due_date) warnings.push('Срок не указан.');

  return {
    title: raw.title.trim().slice(0, 500) || 'Поручение',
    description: (raw.description ?? '').trim().slice(0, 50_000),
    priority: raw.priority,
    mode,
    assignee: mode === 'person' ? personBrief(dir, assignee) : null,
    departments:
      mode === 'distribution'
        ? departments.map((d) => departmentBrief(d)!)
        : departments.length === 1 && !assignee
          ? [departmentBrief(departments[0])!]
          : [],
    controller: personBrief(dir, controller),
    due_date: due,
    basis: (raw.basis ?? documentBasis)?.trim().slice(0, 500) || null,
    assignee_text: raw.assignee_text?.trim().slice(0, 300) || null,
    source_quote: raw.source_quote?.trim().slice(0, 500) || null,
    warnings,
  };
}

function parseDrafts(value: unknown) {
  const parsed = RawDraftsSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(502, 'AI_BAD_OUTPUT', 'The AI answer could not be used');
  }
  return parsed.data;
}

/** `POST WS/ai/draft-issues`: drafts of every assignment in a text or file. */
export async function draftIssues(ctx: AiContext, input: SourceInput) {
  const source = await readSource(input);
  const dir = await loadDirectory(ctx.prisma, ctx.workspace.id);
  const result = await runAi(ctx, 'draft_issues', (provider, signal) =>
    provider.json({
      system: systemPrompt(dir, ctx, 'document'),
      content: [
        ...source.parts,
        {
          type: 'text',
          text: 'Подготовь черновики всех поручений из документа выше по справочнику <org>.',
        },
      ],
      schema: DRAFT_SCHEMA,
      maxTokens: 16_000,
      effort: 'medium',
      signal,
    }),
  );
  const raw = parseDrafts(result.value);
  const basis = raw.basis?.trim() || null;
  return {
    basis,
    drafts: raw.items
      .slice(0, MAX_DRAFTS)
      .map((item) => mapDraft(dir, item, basis, ctx.workspace.timezone)),
    source: { kind: source.kind, name: source.name, chars: source.chars },
    model: result.model,
    generated_at: new Date(),
  };
}

/** A draft in the labels of the directory, for a correction round. */
function draftAsText(dir: Directory, d: Draft): string {
  const ref = (id: string | undefined) => (id ? (dir.personById.get(id)?.ref ?? 'нет') : 'нет');
  const depts = d.departments
    .map((x) => dir.departmentById.get(x.id)?.ref)
    .filter(Boolean)
    .join(', ');
  return [
    `Название: ${d.title}`,
    `Описание: ${d.description || '—'}`,
    `Исполнитель: ${ref(d.assignee?.id)}${d.assignee ? ` (${d.assignee.full_name})` : ''}`,
    `Подразделения: ${depts || 'нет'}`,
    `Контролёр: ${ref(d.controller?.id)}`,
    `Срок: ${d.due_date ?? 'нет'}`,
    `Приоритет: ${d.priority}`,
    `Основание: ${d.basis ?? 'нет'}`,
  ].join('\n');
}

/**
 * One draft from a phrase (Telegram «Новое поручение», 11.T1). With `previous`,
 * the phrase is a correction of that draft («срок — 25 октября»).
 */
export async function draftOne(
  ctx: AiContext,
  phrase: string,
  previous?: Draft | null,
): Promise<Draft> {
  const dir = await loadDirectory(ctx.prisma, ctx.workspace.id);
  const content: AiPart[] = previous
    ? [
        {
          type: 'text',
          text: dataBlock('data', draftAsText(dir, previous), { name: 'текущий черновик' }),
        },
        {
          type: 'text',
          text: `${dataBlock('data', phrase, { name: 'поправка автора' })}\nПримени поправку автора к черновику и верни исправленный черновик целиком.`,
        },
      ]
    : [
        { type: 'text', text: dataBlock('document', phrase, { source: 'сообщение в Telegram' }) },
        { type: 'text', text: 'Подготовь черновик этого поручения по справочнику <org>.' },
      ];
  const result = await runAi(ctx, 'bot_draft', (provider, signal) =>
    provider.json({
      system: systemPrompt(dir, ctx, 'phrase'),
      content,
      schema: DRAFT_SCHEMA,
      maxTokens: 4000,
      effort: 'low',
      signal,
    }),
  );
  const item = parseDrafts(result.value).items[0];
  if (!item) throw new AppError(502, 'AI_BAD_OUTPUT', 'The AI answer could not be used');
  return mapDraft(dir, item, null, ctx.workspace.timezone);
}
