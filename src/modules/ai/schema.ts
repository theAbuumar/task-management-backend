// Request validation (Zod) and OpenAPI schemas of the AI module (Ф11).

import { z } from 'zod';
import { analyticsQuerystring } from '../analytics/schema.js';

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date like 2026-10-31');
const oneOrMany = z.union([z.string().uuid(), z.array(z.string().uuid())]);

export const DraftIssuesBodySchema = z
  .object({
    text: z.string().max(200_000).optional().nullable(),
    file: z
      .object({
        name: z.string().min(1).max(255),
        /** Base64 of the bytes, up to 10 MB decoded. */
        data: z.string().min(1),
      })
      .optional()
      .nullable(),
  })
  .refine((b) => Boolean(b.text?.trim()) || Boolean(b.file), {
    message: 'Give the text of the document or a file',
  });

export const MemoBodySchema = z.object({
  from: localDate.optional(),
  to: localDate.optional(),
  department: oneOrMany.optional(),
  project: oneOrMany.optional(),
  kind: z.enum(['task', 'assignment']).optional(),
  /** What the author wants the memo to stress («обратить внимание на просрочки»). */
  focus: z.string().max(1000).optional(),
});

export const MemoExportBodySchema = z.object({
  format: z.enum(['pdf', 'docx']),
  title: z.string().min(1).max(300),
  text: z.string().min(1).max(60_000),
});

export const AskBodySchema = z.object({
  question: z.string().min(1).max(2000),
  conversation_id: z.string().uuid().optional(),
});

// ─── OpenAPI ──────────────────────────────────────────────────────────────────

const tags = ['AI'];
const security = [{ bearerAuth: [] }];
const anyObject = { type: 'object', additionalProperties: true } as const;
const nullableString = { type: 'string', nullable: true } as const;

const personBrief = {
  type: 'object',
  nullable: true,
  properties: {
    id: { type: 'string' },
    display_name: { type: 'string' },
    full_name: { type: 'string' },
    position: nullableString,
    avatar_url: nullableString,
    department: { ...anyObject, nullable: true },
  },
} as const;

const failures = `Errors: \`404 AI_DISABLED\` (AI is off on this server, or the caller is a guest), \`429 AI_LIMIT_REACHED\` (daily limit, details: limit, used, resets_at), \`504 AI_TIMEOUT\`, \`503 AI_UNAVAILABLE\`, \`422 AI_REFUSED\`, \`502 AI_BAD_OUTPUT\`, \`413 AI_INPUT_TOO_LARGE\`. Each call that reaches the model is written to the usage log (feature, model, tokens, duration — never the texts).`;

export const statusSchema = {
  tags,
  summary: 'Is the AI assistant available to me, and how much of the daily limit is left',
  description:
    'Always 200. `enabled: false` when AI_ENABLED is off on the server or the caller is a guest — the UI then shows no AI elements at all (ADR-028).',
  security,
  response: {
    200: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        provider: { type: 'string' },
        model: { type: 'string' },
        daily_limit: { type: 'integer' },
        used_today: { type: 'integer' },
        remaining_today: { type: 'integer' },
        resets_at: { type: 'string', format: 'date-time' },
      },
    },
  },
} as const;

const draft = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    priority: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'urgent'] },
    mode: {
      type: 'string',
      enum: ['person', 'distribution'],
      description:
        '`person` — create with `POST …/issues` (assignee as primary); `distribution` — `POST …/issues/distribute` to `departments`',
    },
    assignee: personBrief,
    departments: { type: 'array', items: anyObject },
    controller: personBrief,
    due_date: { ...nullableString, description: 'Local date YYYY-MM-DD in the workspace zone' },
    basis: nullableString,
    assignee_text: { ...nullableString, description: 'How the text names the assignee' },
    source_quote: { ...nullableString, description: 'The fragment the assignment comes from' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const draftIssuesSchema = {
  tags,
  summary: 'Draft assignments from a text or a file (.txt, .docx, .pdf up to 10 MB)',
  description: `Nothing is created: the drafts come back for a person to check, edit and create with the regular endpoints (create issue / distribute, with \`ai_assisted: true\`). Assignees, departments and controllers are matched to the org structure of this workspace only; doubts come back in \`warnings\`. The file goes as \`{ name, data }\` with base64 data; programs and disguised files are refused (\`FILE_TYPE_NOT_ALLOWED\`, \`FILE_CONTENT_MISMATCH\`), other formats — \`400 AI_FILE_UNSUPPORTED\`. ${failures}`,
  security,
  body: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        nullable: true,
        description: 'Text of the document (or added to the file)',
      },
      file: {
        type: 'object',
        nullable: true,
        properties: { name: { type: 'string' }, data: { type: 'string', description: 'base64' } },
        required: ['name', 'data'],
      },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        basis: nullableString,
        drafts: { type: 'array', items: draft },
        source: anyObject,
        model: { type: 'string' },
        generated_at: { type: 'string', format: 'date-time' },
      },
    },
  },
} as const;

export const summarySchema = {
  tags,
  summary: 'Short summary of an issue: gist, status, what is in the way, next steps',
  description: `Built from what the caller sees in the card (description, comments, hand-ins, deadline requests, history). Nothing is stored. ${failures}`,
  security,
  response: {
    200: {
      type: 'object',
      properties: {
        issue_id: { type: 'string' },
        essence: { type: 'string' },
        status: { type: 'string' },
        blockers: { type: 'array', items: { type: 'string' } },
        next_steps: { type: 'array', items: { type: 'string' } },
        model: { type: 'string' },
        generated_at: { type: 'string', format: 'date-time' },
      },
    },
  },
} as const;

export const memoSchema = {
  tags,
  summary: 'Analytical memo for the management over a period (ready-made metrics only)',
  description: `Same filters and scope as analytics (10.B1, 10.B3): only the aggregated numbers the caller sees go to the model. The text uses \`## \` headings, \`- \` lists and \`**bold**\`; edit it and download with \`POST WS/ai/report/export\`. ${failures}`,
  security,
  body: {
    type: 'object',
    properties: {
      ...analyticsQuerystring.properties,
      focus: { type: 'string', description: 'What the memo should stress' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        text: { type: 'string' },
        period: anyObject,
        scope: anyObject,
        model: { type: 'string' },
        generated_at: { type: 'string', format: 'date-time' },
      },
    },
  },
} as const;

export const memoExportSchema = {
  tags,
  summary: 'Download an (edited) memo as PDF or DOCX',
  description:
    'Lays out the text the person approved; no model call. Recorded in the audit log (`report.exported`, report `ai-memo`).',
  security,
  body: {
    type: 'object',
    required: ['format', 'title', 'text'],
    properties: {
      format: { type: 'string', enum: ['pdf', 'docx'] },
      title: { type: 'string' },
      text: { type: 'string' },
    },
  },
  response: {
    200: { description: 'The file (attachment)', type: 'string', format: 'binary' },
  },
} as const;

const issueRef = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    key: { type: 'string' },
    title: { type: 'string' },
    project_id: { type: 'string' },
  },
} as const;

const message = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    role: { type: 'string', enum: ['user', 'assistant'] },
    content: { type: 'string' },
    issues: { type: 'array', items: issueRef },
    created_at: { type: 'string', format: 'date-time' },
  },
} as const;

const conversation = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
} as const;

export const askSchema = {
  tags,
  summary: 'Ask a question in plain words; answered from the data the caller may see',
  description: `The model calls tools — search, issue lists, one issue, people, analytics — that run with the caller's rights (private projects and analytics scope included). \`message.issues\` are the issues the answer names by key; only issues a tool returned are linked. Without \`conversation_id\` a new dialogue starts. ${failures}`,
  security,
  body: {
    type: 'object',
    required: ['question'],
    properties: {
      question: { type: 'string', maxLength: 2000 },
      conversation_id: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        conversation,
        question: message,
        message,
        model: { type: 'string' },
      },
    },
  },
} as const;

export const listConversationsSchema = {
  tags,
  summary: 'My dialogues with the AI panel in this workspace, newest first (up to 50)',
  security,
  response: {
    200: { type: 'object', properties: { data: { type: 'array', items: conversation } } },
  },
} as const;

export const getConversationSchema = {
  tags,
  summary: 'One of my dialogues with its messages',
  description:
    'Only the author reads a dialogue (another person — 404). Links to issues the reader can no longer see are dropped.',
  security,
  params: {
    type: 'object',
    properties: { workspaceSlug: { type: 'string' }, id: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: {
      type: 'object',
      properties: { ...conversation.properties, messages: { type: 'array', items: message } },
    },
  },
} as const;

export const deleteConversationSchema = {
  tags,
  summary: 'Delete one of my dialogues',
  security,
  params: getConversationSchema.params,
  response: { 204: { type: 'null' } },
} as const;
