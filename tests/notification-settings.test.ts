// Personal notification settings (Ф8 8.B2): the API (defaults, partial update,
// validation, test message), the channel rule (Telegram, email as the fallback,
// per event group), quiet hours, and that delivery routes recipients by them.
//
// The Bot API is mocked at the `fetch` boundary. Runs against a live Postgres;
// created rows are removed in afterAll.

import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { routeRecipients } from '../src/lib/deliver.js';
import {
  DEFAULT_NOTIFICATION_PREFS,
  channelFor,
  inQuietHours,
  notificationPrefs,
} from '../src/lib/notification-prefs.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const PASSWORD = 'Password123!';
const emails = {
  web: `nset-web-${TS}@example.com`,
  tg: `nset-tg-${TS}@example.com`,
};
const TG_ID = TS + 7;
const SLUG = `nset-${TS}`;

type Actor = { id: string; token: string };
let app: FastifyInstance;
let web: Actor; // email only
let tg: Actor; // Telegram linked
let botCalls: { method: string; body: Record<string, unknown> }[] = [];
// Delivery goes only to members with access to the task's workspace (12.B7).
let workspace: { id: string; timezone: string };

const settings = '/api/v1/auth/me/notification-settings';

async function register(email: string): Promise<Actor> {
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, display_name: email.split('@')[0] });
  expect(res.status).toBe(201);
  return { id: res.body.user.id, token: res.body.access_token };
}

const as = (a: Actor) => ({
  get: (url: string) => request(app.server).get(url).set('Authorization', `Bearer ${a.token}`),
  put: (url: string, body: object) =>
    request(app.server).put(url).set('Authorization', `Bearer ${a.token}`).send(body),
  post: (url: string) =>
    request(app.server).post(url).set('Authorization', `Bearer ${a.token}`).send({}),
});

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  web = await register(emails.web);
  tg = await register(emails.tg);
  await app.prisma.authIdentity.create({
    data: { user_id: tg.id, provider: 'telegram', provider_user_id: String(TG_ID) },
  });
  const ws = await request(app.server)
    .post('/api/v1/workspaces')
    .set('Authorization', `Bearer ${web.token}`)
    .send({ name: 'Уведомления', slug: SLUG });
  workspace = { id: ws.body.id, timezone: 'UTC' };
  await app.prisma.workspaceMember.create({
    data: { workspace_id: workspace.id, user_id: tg.id, role: 'member' },
  });
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.startsWith('https://api.telegram.org/')) return realFetch(input, init);
    botCalls.push({
      method: url.split('/').pop()!,
      body: JSON.parse((init?.body as string) ?? '{}'),
    });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      headers: { 'content-type': 'application/json' },
    });
  });
});

afterEach(() => {
  botCalls = [];
});

afterAll(async () => {
  vi.restoreAllMocks();
  const list = Object.values(emails);
  await app.prisma.workspace.deleteMany({ where: { slug: SLUG } });
  await app.prisma.refreshToken.deleteMany({ where: { user: { email: { in: list } } } });
  await app.prisma.user.deleteMany({ where: { email: { in: list } } });
  await app.close();
});

describe('GET/PUT /auth/me/notification-settings', () => {
  it('returns the defaults and the reachable channels', async () => {
    const res = await as(web).get(settings);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ...DEFAULT_NOTIFICATION_PREFS,
      channels: { telegram: false, email: true },
      groups: ['assigned', 'review', 'deadlines', 'escalation'],
    });
    expect((await as(tg).get(settings)).body.channels.telegram).toBe(true);
  });

  it('saves a partial update and keeps the rest', async () => {
    const res = await as(web).put(settings, {
      email: { deadlines: false },
      quiet_hours: { enabled: true, from: 21 },
    });
    expect(res.status).toBe(200);
    expect(res.body.email).toEqual({
      assigned: true,
      review: true,
      deadlines: false,
      escalation: true,
    });
    expect(res.body.quiet_hours).toEqual({ enabled: true, from: 21, to: 8 });
    expect((await as(web).get(settings)).body.email.deadlines).toBe(false);
  });

  it('rejects an hour outside 0–23 and requires a session', async () => {
    expect((await as(web).put(settings, { quiet_hours: { to: 24 } })).status).toBe(400);
    expect((await request(app.server).get(settings)).status).toBe(401);
  });

  it('a test message goes to Telegram when linked, else by email', async () => {
    const viaTg = await as(tg).post(`${settings}/test`);
    expect(viaTg.body.delivered_to).toBe('telegram');
    expect(botCalls.find((c) => c.method === 'sendMessage')?.body.chat_id).toBe(TG_ID);

    const viaEmail = await as(web).post(`${settings}/test`);
    expect(viaEmail.body.delivered_to).toBe('email');
  });
});

describe('channel rule', () => {
  const ctx = (over: object = {}) => ({
    hasTelegram: true,
    hasEmail: true,
    now: new Date('2026-10-18T10:00:00Z'),
    timeZone: 'UTC',
    ...over,
  });

  it('Telegram first, email as the fallback, never both', () => {
    expect(channelFor(null, 'review_requested', ctx())).toBe('telegram');
    expect(channelFor(null, 'review_requested', ctx({ hasTelegram: false }))).toBe('email');
    const noTgReview = { telegram: { review: false } };
    expect(channelFor(noTgReview, 'review_requested', ctx())).toBe('email');
    expect(channelFor({ ...noTgReview, email: { review: false } }, 'review_requested', ctx())).toBe(
      null,
    );
    // Other groups are untouched.
    expect(channelFor(noTgReview, 'overdue', ctx())).toBe('telegram');
  });

  it('events outside the groups stay in the app', () => {
    expect(channelFor(null, 'comment_added', ctx())).toBe(null);
  });

  it('quiet hours, also over midnight, in the given zone', () => {
    const quiet = notificationPrefs({ quiet_hours: { enabled: true, from: 22, to: 8 } });
    // 23:30 in Tashkent (UTC+5) = 18:30 UTC.
    expect(inQuietHours(quiet, new Date('2026-10-18T18:30:00Z'), 'Asia/Tashkent')).toBe(true);
    expect(inQuietHours(quiet, new Date('2026-10-18T18:30:00Z'), 'UTC')).toBe(false);
    // 07:00 local is still quiet, 08:00 is not.
    expect(inQuietHours(quiet, new Date('2026-10-18T07:00:00Z'), 'UTC')).toBe(true);
    expect(inQuietHours(quiet, new Date('2026-10-18T08:00:00Z'), 'UTC')).toBe(false);
    const day = notificationPrefs({ quiet_hours: { enabled: true, from: 13, to: 14 } });
    expect(inQuietHours(day, new Date('2026-10-18T13:15:00Z'), 'UTC')).toBe(true);
    expect(channelFor({ quiet_hours: { enabled: true, from: 0, to: 23 } }, 'overdue', ctx())).toBe(
      null,
    );
  });

  it('broken stored values fall back to the defaults', () => {
    expect(notificationPrefs({ telegram: 'yes', quiet_hours: { from: 99 } })).toEqual(
      DEFAULT_NOTIFICATION_PREFS,
    );
  });
});

describe('delivery follows the settings', () => {
  it('routes each recipient to Telegram, email or the app only', async () => {
    await as(web).put(settings, {
      email: { deadlines: true },
      quiet_hours: { enabled: false },
    });
    await as(tg).put(settings, { telegram: { deadlines: false } });
    const now = new Date('2026-10-18T10:00:00Z');

    const due = await routeRecipients(app.prisma, [web.id, tg.id], 'due_soon', workspace, now);
    expect(due.telegram).toEqual([]);
    expect(due.email.map((e) => e.userId).sort()).toEqual([web.id, tg.id].sort());

    const review = await routeRecipients(
      app.prisma,
      [web.id, tg.id],
      'review_requested',
      workspace,
      now,
    );
    expect(review.telegram).toEqual([{ userId: tg.id, chatId: TG_ID }]);
    expect(review.email.map((e) => e.userId)).toEqual([web.id]);

    await as(web).put(settings, { quiet_hours: { enabled: true, from: 9, to: 18 } });
    const quiet = await routeRecipients(app.prisma, [web.id], 'review_requested', workspace, now);
    expect(quiet).toEqual({ telegram: [], email: [] });
  });
});
