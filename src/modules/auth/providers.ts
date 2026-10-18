// Sign-in methods this deployment actually offers (Ф13 13.P5). The login page
// shows only these, so a stand without OAuth credentials or SMTP has no buttons
// that lead to an error ("no empty buttons" rule). Public, no secrets: only
// which methods are configured.

import type { FastifyInstance } from 'fastify';
import { config } from '../../config/index.js';
import type { Env } from '../../config/env.js';

export interface AuthProviders {
  /** One-time code by email: outside production the code is printed to the console. */
  email: boolean;
  google: boolean;
  github: boolean;
  telegram: boolean;
  /** DEMO_MODE: quick login as the seeded demo accounts. */
  demo: boolean;
}

export function authProviders(env: Env): AuthProviders {
  return {
    email: env.NODE_ENV !== 'production' || Boolean(env.RESEND_API_KEY || env.SMTP_HOST),
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_CALLBACK_URL),
    github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.GITHUB_CALLBACK_URL),
    telegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_USERNAME),
    demo: env.DEMO_MODE,
  };
}

export async function providerRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/providers',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Sign-in methods configured on this deployment',
        description:
          'The login page shows only these. `email` — one-time code by email (SMTP or Resend configured; always on outside production, where codes go to the console). `demo` — DEMO_MODE quick login.',
        response: {
          200: {
            type: 'object',
            required: ['email', 'google', 'github', 'telegram', 'demo'],
            properties: {
              email: { type: 'boolean' },
              google: { type: 'boolean' },
              github: { type: 'boolean' },
              telegram: { type: 'boolean' },
              demo: { type: 'boolean' },
            },
          },
        },
      },
    },
    async () => authProviders(config),
  );
}
