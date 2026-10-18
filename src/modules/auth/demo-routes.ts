// Demo stand quick login (Ф13 13.B2). Enabled ONLY with DEMO_MODE=true and only
// for the seeded demo accounts (emails on the reserved `demo.local` domain), so the
// jury can switch between "Ректор", "Декан", "Сотрудник"… without email codes.
// With DEMO_MODE off both routes answer 404, as if they did not exist.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config/index.js';
import { AppError } from '../../lib/errors.js';
import { DEMO_ROLE_EMAILS, type DemoTelegramRole } from '../../prisma/demo/university.js';
import { loginDemoUser } from './service.js';
import { beginSession } from './controller.js';

export const DEMO_EMAIL_DOMAIN = '@demo.local';

/** The order the demo story is told in (and the quick-login buttons are shown). */
const DEMO_ROLES: DemoTelegramRole[] = ['rector', 'prorector', 'dean', 'employee'];

/**
 * Tag the quick-login accounts with their role and put them first, in story
 * order. The seed creates every account in one go, so `created_at` alone cannot
 * tell the dean of ФЭУ (the one with the presenter's Telegram) from another dean.
 */
export function withDemoRoles<T extends { email: string | null }>(
  users: T[],
): (T & { demo_role: DemoTelegramRole | null })[] {
  const roleOf = new Map(DEMO_ROLES.map((role) => [DEMO_ROLE_EMAILS[role], role]));
  const rank = (role: DemoTelegramRole | null) =>
    role ? DEMO_ROLES.indexOf(role) : DEMO_ROLES.length;
  return users
    .map((u) => ({ ...u, demo_role: (u.email && roleOf.get(u.email)) || null }))
    .sort((a, b) => rank(a.demo_role) - rank(b.demo_role));
}

export async function demoRoutes(app: FastifyInstance): Promise<void> {
  const guard = async () => {
    if (!config.DEMO_MODE) throw AppError.notFound('Route not found');
  };

  app.get(
    '/demo/accounts',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Demo accounts for quick login (DEMO_MODE only)',
        description:
          '`demo_role` (rector | prorector | dean | employee) marks the four quick-login accounts; they come first, in that order.',
      },
      preHandler: guard,
    },
    async () => {
      const users = await app.prisma.user.findMany({
        where: { email: { endsWith: DEMO_EMAIL_DOMAIN }, is_active: true },
        select: {
          email: true,
          display_name: true,
          workspace_memberships: {
            select: { position: true, role: true, workspace: { select: { name: true } } },
            take: 1,
          },
        },
        orderBy: { created_at: 'asc' },
      });
      return withDemoRoles(
        users.map((u) => ({
          email: u.email,
          display_name: u.display_name,
          position: u.workspace_memberships[0]?.position ?? null,
          role: u.workspace_memberships[0]?.role ?? null,
          workspace: u.workspace_memberships[0]?.workspace.name ?? null,
        })),
      );
    },
  );

  app.post(
    '/demo/login',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Sign in as a demo account (DEMO_MODE only)',
        body: {
          type: 'object',
          required: ['email'],
          properties: { email: { type: 'string', format: 'email' } },
        },
      },
      preHandler: guard,
    },
    async (request, reply) => {
      const { email } = z.object({ email: z.string().email() }).parse(request.body);
      if (!email.toLowerCase().endsWith(DEMO_EMAIL_DOMAIN)) {
        throw AppError.forbidden('Only demo accounts can use quick login');
      }
      const result = await loginDemoUser(app.prisma, email.toLowerCase());
      await beginSession(request, reply, result, 'demo');
      return result;
    },
  );
}
