// Storage Fastify plugin.
//
// Decorates the instance with `app.storage` (the configured `StorageDriver`).
// For the local-disk driver it also mounts the internal `/internal/storage/*`
// routes the driver's presigned URLs point at — these accept raw uploaded bytes
// (PUT) and stream stored objects back (GET). The S3 driver needs no such
// routes: clients talk to the object store directly.
//
// The internal routes live in an encapsulated child context so their raw-bytes
// content-type parser does not affect the JSON parsing used everywhere else.
//
// Like S3 presigned URLs, these local URLs carry an expiry and a signature
// (ADR-027): no account is needed, but a link cannot be forged, changed or reused
// after it expires. An upload link writes one new object of at most `max` bytes,
// and the bytes must pass the file policy (no executables, a known format matches
// its extension) before they reach the disk.

import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { config } from '../config/index.js';
import type { FastifyRequest } from 'fastify';
import { createStorage, LocalStorageDriver, type StorageDriver } from '../lib/storage.js';
import { AppError } from '../lib/errors.js';
import { assertFileContent, SNIFF_BYTES } from '../lib/file-policy.js';

declare module 'fastify' {
  interface FastifyInstance {
    storage: StorageDriver;
  }
}

async function storagePlugin(app: FastifyInstance): Promise<void> {
  const storage = createStorage(config);
  app.decorate('storage', storage);

  if (!(storage instanceof LocalStorageDriver)) return;
  const local = storage;

  await app.register(async (scope) => {
    // Buffer raw bytes for every content type. Clearing the inherited JSON /
    // text parsers first ensures uploads like text/plain arrive as a Buffer
    // rather than a parsed string.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

    const keyOf = (request: FastifyRequest) =>
      (request.params as Record<string, string>)['*'] ?? '';
    /** The signed claims of the link, or 403 before anything else happens. */
    const verified = (request: FastifyRequest, method: 'PUT' | 'GET') => {
      const claims = local.verifyLink(
        method,
        keyOf(request),
        request.query as Record<string, string | undefined>,
      );
      if (typeof claims === 'string') {
        throw AppError.forbidden(
          claims === 'expired' ? 'The link has expired' : 'The link is not valid',
        );
      }
      return claims;
    };
    const tooLarge = () =>
      new AppError(413, 'BAD_REQUEST', 'Uploaded file exceeds the maximum allowed size');
    const limitOf = (max: number | undefined) =>
      Math.min(max ?? config.ATTACHMENT_MAX_BYTES, config.ATTACHMENT_MAX_BYTES);

    scope.put(
      '/internal/storage/*',
      {
        // Signature and declared size are checked before the body is read.
        onRequest: async (request) => {
          const { max } = verified(request, 'PUT');
          const length = Number(request.headers['content-length'] ?? 0);
          if (length > limitOf(max)) throw tooLarge();
        },
      },
      async (request, reply) => {
        const key = keyOf(request);
        const { max } = verified(request, 'PUT');
        const body = request.body;
        if (!Buffer.isBuffer(body)) throw AppError.badRequest('Request body must be raw bytes');
        if (body.length > limitOf(max)) throw tooLarge();
        // The file name follows `__` in an attachment key; avatars and logos have
        // none, so only the executable check applies to them (images are checked on save).
        const last = key.split('/').pop() ?? '';
        assertFileContent(
          last.split('__').slice(1).join('__') || last,
          body.subarray(0, SNIFF_BYTES),
        );
        try {
          await local.write(key, body, { exclusive: true });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
            throw AppError.conflict('This upload link has already been used');
          }
          throw AppError.badRequest('Invalid storage key');
        }
        return reply.code(204).send();
      },
    );

    scope.get('/internal/storage/*', async (request, reply) => {
      const key = keyOf(request);
      verified(request, 'GET');
      let stream;
      try {
        stream = await local.read(key);
      } catch {
        throw AppError.badRequest('Invalid storage key');
      }
      if (!stream) throw AppError.notFound('Stored object not found');
      const name = (request.query as Record<string, string | undefined>).name;
      if (name) {
        // Same shape as the S3 driver's ResponseContentDisposition; RFC 5987 keeps
        // Cyrillic names intact. Path separators and quotes are already stripped.
        const safe = name.replace(/["\\/\r\n]/g, '_').slice(0, 200);
        reply.header(
          'content-disposition',
          `attachment; filename="${safe.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(safe)}`,
        );
      }
      return reply
        .header('content-type', 'application/octet-stream')
        .header('x-content-type-options', 'nosniff')
        .send(stream);
    });
  });
}

export default fp(storagePlugin, { name: 'storage' });
