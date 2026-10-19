// `GET /api/v1/about` — «О системе» (Ф13 13.D4, 13.F4): which version of the API
// runs on this stand, from which commit, since when, and whom to contact. Only
// for signed-in people: the version is not advertised to anonymous visitors.

import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../plugins/auth-hook.js';
import { config } from '../../config/index.js';

// package.json sits three levels up from both src/modules/about and dist/modules/about.
const VERSION = (
  JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
const STARTED_AT = new Date();

export async function aboutRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/',
    {
      schema: {
        tags: ['Health'],
        summary: 'Version of the API on this stand (for «О системе»)',
        description:
          '`version` — of the API (package.json); `commit` — the build (`APP_COMMIT`, set by `dev/stand.sh up`); `support` — the contact set in `SUPPORT_CONTACT`, null when not set.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              version: { type: 'string' },
              commit: { type: ['string', 'null'] },
              started_at: { type: 'string', format: 'date-time' },
              support: { type: ['string', 'null'] },
            },
          },
        },
      },
      preHandler: [authenticate],
    },
    async () => ({
      version: VERSION,
      commit: config.APP_COMMIT ?? null,
      started_at: STARTED_AT,
      support: config.SUPPORT_CONTACT ?? null,
    }),
  );
}
