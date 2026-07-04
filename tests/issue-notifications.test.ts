// Integration tests: out-of-band notifications when a task is created / assigned.
//
// Covers the per-recipient fan-out added to the issues service:
//   - creating a task WITH assignees notifies each assignee ("assigned"),
//   - creating a task with NO assignees notifies every PROJECT member (the "task for
//     everyone" case, "created a task"),
//   - each recipient gets exactly one channel: Telegram if linked, else email fallback,
//   - the actor is never notified about their own action.
// The Bot API is mocked at the `fetch` boundary; the mailer is mocked at the module
// boundary. The fan-out runs inside the request, so both are complete once the response
// returns.
//
// Runs against the same Postgres as the other integration tests; created rows are cleaned
// up in afterAll. Requires TELEGRAM_* test env (tests/setup.ts).

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { sendMail } from '../src/lib/mailer.js';
import type { FastifyInstance } from 'fastify';

// Mock the email transport so the fallback channel is observable without sending mail.
vi.mock('../src/lib/mailer.js', () => ({ sendMail: vi.fn(async () => {}) }));
const sendMailMock = vi.mocked(sendMail);

const TS = Date.now();
const OWNER_EMAIL = `itg-owner-${TS}@example.com`;
const PW = 'Password123!';
const TG_ID = TS + 991; // Telegram numeric user id for the linked account

let app: FastifyInstance;
let ownerToken: string;
let ownerUserId: string;
let tgUserId: string;
let tgToken: string;
let workspaceSlug: string;
let projectId: string;
let stateId: string;

const auth = (token: string): [string, string] => ['Authorization', `Bearer ${token}`];
const webhook = '/api/v1/auth/telegram/webhook';
const issuesUrl = (): string => `/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues`;

/** A fetch mock that accepts any Telegram Bot API call and reports success. */
function telegramFetchMock(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    if (url.startsWith('https://api.telegram.org/bot')) {
      return { ok: true, json: async () => ({ ok: true }) };
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
}

/** Parse the sendMessage payloads a fetch mock captured. */
function sentMessages(mock: ReturnType<typeof vi.fn>): Array<{ chat_id: number; text: string }> {
  return mock.mock.calls
    .filter((c) => String(c[0]).includes('/sendMessage'))
    .map((c) => JSON.parse(String((c[1] as { body: string }).body)));
}

/** Recipients the mocked mailer was asked to email. */
function emailedTo(): string[] {
  return sendMailMock.mock.calls.map((c) => (c[0] as { to: string }).to);
}

function cookieValue(setCookie: string[] | undefined, name: string): string | undefined {
  const raw = (setCookie ?? []).find((c) => c.startsWith(`${name}=`));
  return raw?.split(';')[0]!.split('=').slice(1).join('=');
}

/** Create a Telegram-linked account via the deep-link login handshake. */
async function createTelegramUser(): Promise<{ userId: string; accessToken: string }> {
  const init = await request(app.server).post('/api/v1/auth/telegram/init');
  const session = cookieValue(init.headers['set-cookie'] as unknown as string[], 'tg_session')!;
  const token = init.body.token as string;

  vi.stubGlobal('fetch', telegramFetchMock());
  await request(app.server)
    .post(webhook)
    .send({ message: { chat: { id: TG_ID }, from: { id: TG_ID }, text: `/start ${token}` } });
  await request(app.server)
    .post(webhook)
    .send({ callback_query: { id: 'cbq-login', from: { id: TG_ID }, data: `confirm:${token}` } });
  vi.unstubAllGlobals();

  const status = await request(app.server)
    .get(`/api/v1/auth/telegram/status?token=${token}`)
    .set('Cookie', `tg_session=${session}`);
  expect(status.body.status).toBe('authenticated');
  return {
    userId: status.body.user.id as string,
    accessToken: status.body.access_token as string,
  };
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  // Owner: an email account — the creator/actor, no Telegram linked.
  const reg = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email: OWNER_EMAIL, password: PW, display_name: 'Owner' });
  expect(reg.status).toBe(201);
  ownerToken = reg.body.access_token as string;
  const me = await request(app.server)
    .get('/api/v1/auth/me')
    .set(...auth(ownerToken));
  ownerUserId = me.body.id as string;

  // The Telegram-linked member.
  const tg = await createTelegramUser();
  tgUserId = tg.userId;
  tgToken = tg.accessToken;

  workspaceSlug = `itg-ws-${TS}`;
  await request(app.server)
    .post('/api/v1/workspaces')
    .set(...auth(ownerToken))
    .send({ name: 'Issue TG WS', slug: workspaceSlug })
    .expect(201);

  // Add the Telegram user to the workspace and the project.
  await request(app.server)
    .post(`/api/v1/workspaces/${workspaceSlug}/members`)
    .set(...auth(ownerToken))
    .send({ user_id: tgUserId, role: 'member' })
    .expect(201);

  const project = await request(app.server)
    .post(`/api/v1/workspaces/${workspaceSlug}/projects`)
    .set(...auth(ownerToken))
    .send({ name: 'Notifications', identifier: 'TGN' })
    .expect(201);
  projectId = project.body.id as string;

  await request(app.server)
    .post(`/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/members`)
    .set(...auth(ownerToken))
    .send({ user_id: tgUserId, role: 'member' })
    .expect(201);

  const state = await app.prisma.state.findFirst({
    where: { project_id: projectId, is_default: true },
  });
  stateId = state!.id;
});

afterAll(async () => {
  // Deleting the workspace cascades its projects, issues, members and notifications.
  // Then remove the Telegram-linked account (cascades its identity).
  await app.prisma.workspace.deleteMany({ where: { slug: workspaceSlug } });
  if (tgUserId) await app.prisma.user.deleteMany({ where: { id: tgUserId } });
  await app.close();
});

describe('Notifications on task create/assign', () => {
  it('creating a task assigned to a Telegram-linked user messages that user (no email)', async () => {
    sendMailMock.mockClear();
    const fetchMock = telegramFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(app.server)
      .post(issuesUrl())
      .set(...auth(ownerToken))
      .send({ title: 'Fix login bug', state_id: stateId, assignee_ids: [tgUserId] });
    vi.unstubAllGlobals();

    expect(res.status).toBe(201);
    const toTg = sentMessages(fetchMock).filter((m) => m.chat_id === TG_ID);
    expect(toTg).toHaveLength(1);
    expect(toTg[0]!.text).toContain('Fix login bug');
    expect(toTg[0]!.text).toContain('assigned you a task');
    // The recipient has Telegram, so no email fallback fires.
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('creating a task with NO assignees messages every Telegram-linked project member', async () => {
    const fetchMock = telegramFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(app.server)
      .post(issuesUrl())
      .set(...auth(ownerToken))
      .send({ title: 'Team standup notes', state_id: stateId });
    vi.unstubAllGlobals();

    expect(res.status).toBe(201);
    const toTg = sentMessages(fetchMock).filter((m) => m.chat_id === TG_ID);
    expect(toTg).toHaveLength(1);
    expect(toTg[0]!.text).toContain('Team standup notes');
    expect(toTg[0]!.text).toContain('created a task');
  });

  it('assigning a Telegram-linked user later messages them', async () => {
    // Keep the whole test under the fetch stub: creating an unassigned issue itself fans
    // out to the tg project member, so leaving it unstubbed would hit the real Bot API.
    const fetchMock = telegramFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const created = await request(app.server)
      .post(issuesUrl())
      .set(...auth(ownerToken))
      .send({ title: 'Ship release', state_id: stateId, assignee_ids: [] });
    const issueId = created.body.id as string;

    // Reset so assertions only see the assignee endpoint's sends, not the create's.
    fetchMock.mockClear();

    const res = await request(app.server)
      .post(`${issuesUrl()}/${issueId}/assignees`)
      .set(...auth(ownerToken))
      .send({ user_id: tgUserId });
    vi.unstubAllGlobals();

    expect(res.status).toBe(201);
    const toTg = sentMessages(fetchMock).filter((m) => m.chat_id === TG_ID);
    expect(toTg).toHaveLength(1);
    expect(toTg[0]!.text).toContain('Ship release');
    expect(toTg[0]!.text).toContain('assigned you a task');
  });

  it('a task assigned to an email-only user (no Telegram) emails them instead', async () => {
    sendMailMock.mockClear();
    const fetchMock = telegramFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    // The Telegram user is the actor; the assignee (owner) has only email.
    const res = await request(app.server)
      .post(issuesUrl())
      .set(...auth(tgToken))
      .send({ title: 'Email fallback task', state_id: stateId, assignee_ids: [ownerUserId] });
    vi.unstubAllGlobals();

    expect(res.status).toBe(201);
    // No bot message (owner has no Telegram) — an email instead.
    expect(sentMessages(fetchMock).filter((m) => m.chat_id === TG_ID)).toHaveLength(0);
    const mail = sendMailMock.mock.calls.map((c) => c[0] as { to: string; subject: string });
    const toOwner = mail.find((m) => m.to === OWNER_EMAIL);
    expect(toOwner).toBeDefined();
    expect(toOwner!.subject).toContain('Email fallback task');
  });

  it('never notifies the actor about their own task', async () => {
    sendMailMock.mockClear();
    // The Telegram user creates an unassigned task. Recipients are the project members
    // (owner + this user); the actor is filtered out. The owner has no Telegram, so they
    // get the email fallback and the actor gets nothing.
    const fetchMock = telegramFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(app.server)
      .post(issuesUrl())
      .set(...auth(tgToken))
      .send({ title: 'My own task', state_id: stateId });
    vi.unstubAllGlobals();

    expect(res.status).toBe(201);
    // The actor (the tg user) is never messaged on their own telegram.
    expect(sentMessages(fetchMock).filter((m) => m.chat_id === TG_ID)).toHaveLength(0);
    // Only the owner (the other project member) is emailed — the actor is not.
    expect(emailedTo()).toEqual([OWNER_EMAIL]);
  });
});
