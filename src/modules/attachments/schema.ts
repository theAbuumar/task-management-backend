import { z } from 'zod';
import type { FastifySchema } from 'fastify';

// ─── Zod (service-facing) ─────────────────────────────────────────────────────

export const CreateAttachmentBodySchema = z.object({
  file_name: z.string().min(1).max(255),
  file_size: z.number().int().positive(),
  mime_type: z.string().min(1).max(255),
});

export type CreateAttachmentBody = z.infer<typeof CreateAttachmentBodySchema>;

// ─── Fastify route schemas ────────────────────────────────────────────────────

const security = [{ bearerAuth: [] }];

const uploaderShape = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    display_name: { type: 'string' },
    last_name: { type: 'string', nullable: true },
    first_name: { type: 'string', nullable: true },
    middle_name: { type: 'string', nullable: true },
    avatar_url: { type: 'string', nullable: true },
  },
} as const;

const attachmentShape = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    workspace_id: { type: 'string' },
    issue_id: { type: 'string' },
    uploaded_by_id: { type: 'string' },
    file_name: { type: 'string' },
    file_size: { type: 'integer' },
    mime_type: { type: 'string' },
    storage_key: { type: 'string' },
    // Set when the file was handed in with a report for review (Ф5).
    review_id: { type: 'string', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
    uploaded_by: uploaderShape,
    download_url: { type: 'string' },
  },
} as const;

const uploadShape = {
  type: 'object',
  properties: {
    url: { type: 'string' },
    method: { type: 'string' },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
    expires_in: { type: 'integer' },
  },
} as const;

export const listAttachmentsSchema: FastifySchema = {
  tags: ['Attachments'],
  summary: 'List attachments on an issue (each with a presigned download URL)',
  description:
    'Newest first. Each `download_url` is signed for `STORAGE_DOWNLOAD_TTL` seconds (a day by default): ' +
    'an open task keeps its files, a copied link stops working (ADR-027).',
  security,
  response: {
    200: { type: 'array', items: attachmentShape },
  },
};

export const createAttachmentSchema: FastifySchema = {
  tags: ['Attachments'],
  summary: 'Register an attachment and get a presigned upload URL',
  description:
    'Creates the attachment metadata row and returns a short-lived presigned URL the client ' +
    'uploads the file bytes to (HTTP PUT). Bytes never flow through the API. Limits (4.B2): ' +
    '`file_size` up to `ATTACHMENT_MAX_BYTES` (25 MiB by default, 400 otherwise); executables and ' +
    'scripts (.exe, .bat, .js, .sh, …) are refused by extension and by content — ' +
    '`400 FILE_TYPE_NOT_ALLOWED`; a file whose content does not match its extension — ' +
    '`400 FILE_CONTENT_MISMATCH` (ADR-027). The upload slot lives `STORAGE_PRESIGN_TTL` seconds ' +
    '(900 by default, `upload.expires_in`); download links in the list live `STORAGE_DOWNLOAD_TTL` ' +
    '(a day by default).',
  security,
  body: {
    type: 'object',
    required: ['file_name', 'file_size', 'mime_type'],
    properties: {
      file_name: { type: 'string', minLength: 1, maxLength: 255 },
      file_size: {
        type: 'integer',
        minimum: 1,
        description: 'Bytes; at most ATTACHMENT_MAX_BYTES',
      },
      mime_type: { type: 'string', minLength: 1, maxLength: 255 },
    },
  },
  response: {
    201: {
      type: 'object',
      properties: {
        attachment: attachmentShape,
        upload: uploadShape,
      },
    },
  },
};

export const deleteAttachmentSchema: FastifySchema = {
  tags: ['Attachments'],
  summary: 'Delete an attachment (uploader or workspace admin/owner)',
  security,
  response: {
    204: { type: 'null' },
  },
};
