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
// Note: like S3 presigned URLs, these local URLs are unauthenticated — the
// unguessable UUID in the storage key is the capability. This is a dev/test
// convenience; production uses real object storage.

import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { config } from '../config/index.js';
import { createStorage, LocalStorageDriver, type StorageDriver } from '../lib/storage.js';
import { AppError } from '../lib/errors.js';

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

    scope.put('/internal/storage/*', async (request, reply) => {
      const key = (request.params as Record<string, string>)['*'] ?? '';
      const body = request.body;
      if (!Buffer.isBuffer(body)) throw AppError.badRequest('Request body must be raw bytes');
      if (body.length > config.ATTACHMENT_MAX_BYTES) {
        throw new AppError(413, 'BAD_REQUEST', 'Uploaded file exceeds the maximum allowed size');
      }
      try {
        await local.write(key, body);
      } catch {
        throw AppError.badRequest('Invalid storage key');
      }
      return reply.code(204).send();
    });

    scope.get('/internal/storage/*', async (request, reply) => {
      const key = (request.params as Record<string, string>)['*'] ?? '';
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
      return reply.header('content-type', 'application/octet-stream').send(stream);
    });
  });
}

export default fp(storagePlugin, { name: 'storage' });
