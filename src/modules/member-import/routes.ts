// `/workspaces/:workspaceSlug/members/import` — the staff import (4.B1, ADR-031),
// for admins and the owner: the XLSX template and the import itself (a check with
// `dry_run`, then the run).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import { AppError } from '../../lib/errors.js';
import { MAX_FILE_BYTES, MAX_ROWS, parseFile, type RawRow } from './parse.js';
import { importMembers } from './service.js';
import { importTemplate } from './template.js';

const cell = z.string().trim().max(500).default('');

const ImportBodySchema = z
  .object({
    /** An .xlsx or .csv file, base64. */
    file_name: z.string().trim().min(1).max(255).optional(),
    content_base64: z
      .string()
      .max(Math.ceil((MAX_FILE_BYTES * 4) / 3) + 4)
      .optional(),
    /** Or the rows as they are (API clients). */
    rows: z
      .array(
        z.object({
          full_name: cell,
          email: cell,
          department: cell,
          position: cell,
          role: cell,
        }),
      )
      .min(1)
      .max(MAX_ROWS)
      .optional(),
    dry_run: z.boolean().default(true),
  })
  .refine((b) => Boolean(b.rows) !== Boolean(b.content_base64 && b.file_name), {
    message: 'Provide either rows, or file_name with content_base64',
  });

const rowShape = {
  type: 'object',
  properties: {
    row: { type: 'integer' },
    full_name: { type: 'string' },
    email: { type: 'string' },
    department: { type: 'string', nullable: true },
    position: { type: 'string', nullable: true },
    role: { type: 'string', enum: ['admin', 'member', 'guest'] },
    status: {
      type: 'string',
      enum: ['invite_existing', 'invite_new', 'update', 'unchanged', 'error'],
    },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: { field: { type: 'string' }, code: { type: 'string' } },
      },
    },
    new_departments: { type: 'array', items: { type: 'string' } },
    result: { type: 'string', enum: ['invited', 'updated', 'unchanged', 'skipped', 'failed'] },
    delivered_to: { type: 'array', items: { type: 'string', enum: ['email', 'telegram'] } },
    failure: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' } },
    },
  },
} as const;

const count = { type: 'integer' } as const;

export async function memberImportRoutes(app: FastifyInstance): Promise<void> {
  const admin = [authenticate, requireWorkspaceMember('admin')];
  const params = { type: 'object', properties: { workspaceSlug: { type: 'string' } } };

  app.get(
    '/template',
    {
      schema: {
        tags: ['Workspaces'],
        summary: 'XLSX template of the staff import (admin+)',
        description:
          'Sheets: «Сотрудники» (ФИО, Email, Подразделение, Должность, Роль — to fill), «Как ' +
          'заполнить» with an example, and «Подразделения» with the paths of the workspace departments.',
        security: [{ bearerAuth: [] }],
        params,
      },
      preHandler: admin,
    },
    async (request, reply) => {
      const file = await importTemplate(app.prisma, request.workspace.id);
      const name = 'Шаблон импорта сотрудников.xlsx';
      return reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
        .send(file);
    },
  );

  app.post(
    '/',
    {
      // A 5 MB file is ~6.7 MB in base64.
      bodyLimit: 8 * 1024 * 1024,
      schema: {
        tags: ['Workspaces'],
        summary: 'Import staff from XLSX/CSV: check (dry_run) or run (admin+)',
        description: [
          'Body: `file_name` + `content_base64` (an .xlsx from the template, or a .csv in UTF-8 or',
          'Windows-1251 with «;» or «,»), or `rows` as JSON. Columns: ФИО, Email, Подразделение',
          '(a path «Факультет / Кафедра»), Должность, Роль (Участник | Администратор | Гость, default',
          `Участник). At most ${MAX_ROWS} rows — otherwise \`400 IMPORT_TOO_MANY_ROWS\`; an unreadable`,
          'file or one without the «ФИО» and «Email» headers — `400 IMPORT_FILE_INVALID`',
          '(`details.reason`: FORMAT, UNREADABLE, NO_HEADER, EMPTY, TOO_LARGE).',
          '',
          '`dry_run: true` (default) changes nothing and says per row what will happen (`status`):',
          'invite_existing — a registered person gets an invitation (inbox, email, Telegram);',
          'invite_new — an email with a sign-up link; update — already a member, department and',
          'position are set (the role stays); unchanged; error — `errors[]` with codes NAME_REQUIRED,',
          'NAME_INCOMPLETE, NAME_TOO_LONG, EMAIL_REQUIRED, EMAIL_INVALID, EMAIL_DUPLICATE, ROLE_INVALID,',
          'DEPARTMENT_TOO_LONG, POSITION_TOO_LONG, ACCOUNT_INACTIVE. Missing departments of a path are',
          'listed in `new_departments` and `summary.departments_to_create`.',
          '',
          '`dry_run: false` runs it: rows with errors are skipped, the rest are done one by one;',
          '`result` per row (invited, updated, unchanged, skipped, failed + `failure`), counters in',
          '`summary`. The invitations carry the department and position (and the full name for a new',
          'account) and apply them on accepting. One audit entry `member.imported` with the counts.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        params,
        body: {
          type: 'object',
          properties: {
            file_name: { type: 'string', maxLength: 255 },
            content_base64: { type: 'string' },
            rows: {
              type: 'array',
              maxItems: MAX_ROWS,
              items: {
                type: 'object',
                properties: {
                  full_name: { type: 'string' },
                  email: { type: 'string' },
                  department: { type: 'string' },
                  position: { type: 'string' },
                  role: { type: 'string' },
                },
              },
            },
            dry_run: { type: 'boolean', default: true },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              dry_run: { type: 'boolean' },
              summary: {
                type: 'object',
                properties: {
                  total: count,
                  errors: count,
                  invite_existing: count,
                  invite_new: count,
                  update: count,
                  unchanged: count,
                  departments_to_create: { type: 'array', items: { type: 'string' } },
                  invited: count,
                  updated: count,
                  failed: count,
                },
              },
              rows: { type: 'array', items: rowShape },
            },
          },
        },
      },
      preHandler: admin,
    },
    async (request) => {
      const body = ImportBodySchema.parse(request.body);
      let rows: RawRow[];
      if (body.rows) {
        rows = body.rows.map((r, i) => ({ row: i + 2, ...r }));
      } else {
        const content = Buffer.from(body.content_base64!, 'base64');
        if (content.length === 0) {
          throw new AppError(400, 'IMPORT_FILE_INVALID', 'The file is empty', { reason: 'EMPTY' });
        }
        rows = await parseFile(body.file_name!, content);
      }
      return importMembers(app.prisma, request.workspace.id, request.userId, rows, body.dry_run);
    },
  );
}
