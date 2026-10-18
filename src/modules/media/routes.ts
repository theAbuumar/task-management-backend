// Profile avatars and workspace logos (Ф3 3.B5).
//
// Images go through the same storage driver as attachments (ADR-015): the client
// asks for a presigned upload, PUTs the bytes, then saves the returned stable `url`
// on the profile (`PATCH /auth/me { avatar_url }`) or workspace (`PATCH
// /workspaces/:slug { logo_url }`). Saving checks the stored bytes (signature and
// size) and deletes the image it replaces — see `lib/media.ts`. The stable URL hits
// `GET /api/v1/files/*`, which redirects to a fresh presigned download — so the
// saved link never expires, and the key's random UUID is what makes it unguessable
// (like attachment links).

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifySchema } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../../plugins/auth-hook.js';
import { requireWorkspaceMember } from '../../plugins/workspace-hook.js';
import { AppError } from '../../lib/errors.js';
import { IMAGE_TYPES, MAX_IMAGE_BYTES, publicFileUrl } from '../../lib/media.js';
/** Only these key prefixes are served publicly; attachments stay behind auth. */
const PUBLIC_PREFIXES = ['avatars/', 'logos/'];

const ImageUploadBodySchema = z.object({
  mime_type: z.enum(IMAGE_TYPES),
  size: z.number().int().min(1).max(MAX_IMAGE_BYTES),
});

const imageUploadSchema = (summary: string, extra: Partial<FastifySchema> = {}): FastifySchema => ({
  tags: ['Media'],
  summary,
  description:
    'png/jpeg/webp up to 2 MB. Upload the bytes with `upload` (method, url, headers), then save `url` on the profile/workspace — saving checks the file signature and size (`INVALID_IMAGE`) and deletes the image it replaces.',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['mime_type', 'size'],
    properties: {
      mime_type: { type: 'string', enum: IMAGE_TYPES },
      size: { type: 'integer', minimum: 1, maximum: MAX_IMAGE_BYTES },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        upload: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            method: { type: 'string' },
            headers: { type: 'object', additionalProperties: { type: 'string' } },
            expires_in: { type: 'integer' },
          },
        },
      },
    },
  },
  ...extra,
});

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/v1/auth/me/avatar',
    {
      schema: imageUploadSchema('Get an upload slot for the current user’s avatar'),
      preHandler: [authenticate],
    },
    async (request) => {
      const body = ImageUploadBodySchema.parse(request.body);
      const key = `avatars/${request.userId}/${randomUUID()}`;
      const upload = await app.storage.presignUpload(key, body.mime_type, MAX_IMAGE_BYTES);
      return { url: publicFileUrl(key), upload };
    },
  );

  app.post(
    '/api/v1/workspaces/:workspaceSlug/logo',
    {
      schema: imageUploadSchema('Get an upload slot for the workspace logo (admin+)', {
        params: { type: 'object', properties: { workspaceSlug: { type: 'string' } } },
      }),
      preHandler: [authenticate, requireWorkspaceMember('admin')],
    },
    async (request) => {
      const body = ImageUploadBodySchema.parse(request.body);
      const key = `logos/${request.workspace.id}/${randomUUID()}`;
      const upload = await app.storage.presignUpload(key, body.mime_type, MAX_IMAGE_BYTES);
      return { url: publicFileUrl(key), upload };
    },
  );

  app.get(
    '/api/v1/files/*',
    {
      schema: {
        tags: ['Media'],
        summary: 'Stable public link to an avatar/logo — redirects to the stored file',
        hide: false,
      },
    },
    async (request, reply) => {
      const key = (request.params as Record<string, string>)['*'] ?? '';
      if (!PUBLIC_PREFIXES.some((p) => key.startsWith(p)) || key.includes('..')) {
        throw AppError.notFound('File not found');
      }
      const target = await app.storage.presignDownload(key, key.split('/').pop() ?? 'image');
      // Short cache so a replaced avatar shows up quickly; the presigned target expires anyway.
      reply.header('cache-control', 'public, max-age=300');
      return reply.redirect(target);
    },
  );
}
