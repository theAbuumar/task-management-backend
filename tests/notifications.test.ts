// Integration tests: in-app notifications.
//
// Covers the three generators (issue assignment, comment on an involved issue,
// @mention in a comment), the never-notify-self rule, mention precedence over
// the generic comment notification, list filtering by read state with unread
// counts, single + bulk mark-read, and that notifications are private to their
// recipient (no cross-user / cross-workspace leakage).

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const OWNER_EMAIL = `notif-owner-${TS}@example.com`;
const ALICE_EMAIL = `notif-alice-${TS}@example.com`;
const BOB_EMAIL = `notif-bob-${TS}@example.com`;
const OUTSIDER_EMAIL = `notif-outsider-${TS}@example.com`;
const PW = 'Password123!';

let app: FastifyInstance;
let ownerToken: string;
let aliceToken: string;
let aliceId: string;
let bobToken: string;
let bobId: string;
let outsiderToken: string;
let workspaceSlug: string;
let projectId: string;
let defaultStateId: string;

const auth = (token: string): [string, string] => ['Authorization', `Bearer ${token}`];
const base = () => `/api/v1/workspaces/${workspaceSlug}/projects/${projectId}`;
const notifs = () => `/api/v1/workspaces/${workspaceSlug}/notifications`;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  const reg = async (email: string): Promise<string> => {
    const res = await request(app.server)
      .post('/api/v1/auth/register')
      .send({ email, password: PW, display_name: email });
    return res.body.access_token as string;
  };
  const meId = async (token: string): Promise<string> => {
    const res = await request(app.server)
      .get('/api/v1/auth/me')
      .set(...auth(token));
    return res.body.id as string;
  };

  ownerToken = await reg(OWNER_EMAIL);
  aliceToken = await reg(ALICE_EMAIL);
  bobToken = await reg(BOB_EMAIL);
  outsiderToken = await reg(OUTSIDER_EMAIL);
  aliceId = await meId(aliceToken);
  bobId = await meId(bobToken);

  workspaceSlug = `notif-ws-${TS}`;
  await request(app.server)
    .post('/api/v1/workspaces')
    .set(...auth(ownerToken))
    .send({ name: 'Notif Workspace', slug: workspaceSlug });

  for (const id of [aliceId, bobId]) {
    await request(app.server)
      .post(`/api/v1/workspaces/${workspaceSlug}/members`)
      .set(...auth(ownerToken))
      .send({ user_id: id, role: 'member' });
  }

  const project = await request(app.server)
    .post(`/api/v1/workspaces/${workspaceSlug}/projects`)
    .set(...auth(ownerToken))
    .send({ name: 'Notif Project', identifier: 'NOT' });
  projectId = project.body.id;

  const states = await request(app.server)
    .get(`${base()}/states`)
    .set(...auth(ownerToken));
  defaultStateId = states.body[0].id;
});

afterAll(async () => {
  await app.prisma.workspace.deleteMany({ where: { slug: workspaceSlug } });
  await app.prisma.user.deleteMany({
    where: { email: { in: [OWNER_EMAIL, ALICE_EMAIL, BOB_EMAIL, OUTSIDER_EMAIL] } },
  });
  await app.close();
});

const listFor = async (token: string, qs = ''): Promise<request.Response> =>
  request(app.server)
    .get(`${notifs()}${qs}`)
    .set(...auth(token));

describe('notification generation', () => {
  it('notifies a user assigned to an issue at creation, but not the actor', async () => {
    await request(app.server)
      .post(`${base()}/issues`)
      .set(...auth(ownerToken))
      .send({ title: 'Assign on create', state_id: defaultStateId, assignee_ids: [aliceId] });

    const aliceList = await listFor(aliceToken);
    expect(aliceList.status).toBe(200);
    const assigned = aliceList.body.data.filter(
      (n: { type: string }) => n.type === 'issue_assigned',
    );
    expect(assigned.length).toBe(1);
    expect(assigned[0].actor.id).not.toBe(aliceId);

    // Owner (the actor) gets nothing.
    const ownerList = await listFor(ownerToken);
    expect(ownerList.body.data.length).toBe(0);
  });

  it('notifies a user added as assignee after creation', async () => {
    const issue = await request(app.server)
      .post(`${base()}/issues`)
      .set(...auth(ownerToken))
      .send({ title: 'Assign later', state_id: defaultStateId });

    await request(app.server)
      .post(`${base()}/issues/${issue.body.id}/assignees`)
      .set(...auth(ownerToken))
      .send({ user_id: bobId });

    const bobList = await listFor(bobToken);
    const assigned = bobList.body.data.filter((n: { type: string }) => n.type === 'issue_assigned');
    expect(assigned.length).toBe(1);
    expect(assigned[0].issue_id).toBe(issue.body.id);
  });

  it('notifies issue participants on a new comment (not the commenter)', async () => {
    // Owner creates an issue assigned to Alice; Bob comments on it.
    const issue = await request(app.server)
      .post(`${base()}/issues`)
      .set(...auth(ownerToken))
      .send({ title: 'Commentable', state_id: defaultStateId, assignee_ids: [aliceId] });

    await request(app.server)
      .post(`${base()}/issues/${issue.body.id}/comments`)
      .set(...auth(bobToken))
      .send({ body: 'Looks good to me' });

    // Alice (assignee) and Owner (creator) are notified; Bob (commenter) is not.
    const aliceComment = (await listFor(aliceToken)).body.data.filter(
      (n: { type: string; issue_id: string }) =>
        n.type === 'comment_added' && n.issue_id === issue.body.id,
    );
    expect(aliceComment.length).toBe(1);

    const ownerComment = (await listFor(ownerToken)).body.data.filter(
      (n: { type: string; issue_id: string }) =>
        n.type === 'comment_added' && n.issue_id === issue.body.id,
    );
    expect(ownerComment.length).toBe(1);

    const bobComment = (await listFor(bobToken)).body.data.filter(
      (n: { type: string; issue_id: string }) =>
        n.type === 'comment_added' && n.issue_id === issue.body.id,
    );
    expect(bobComment.length).toBe(0);
  });

  it('sends a mention notification and suppresses the generic comment one for the mentioned user', async () => {
    // Owner creates an issue assigned to Alice, then mentions Alice in a comment.
    const issue = await request(app.server)
      .post(`${base()}/issues`)
      .set(...auth(ownerToken))
      .send({ title: 'Mention test', state_id: defaultStateId, assignee_ids: [aliceId] });

    const aliceHandle = ALICE_EMAIL.split('@')[0];
    await request(app.server)
      .post(`${base()}/issues/${issue.body.id}/comments`)
      .set(...auth(ownerToken))
      .send({ body: `Hey @${aliceHandle} please review` });

    const aliceComment = (await listFor(aliceToken)).body.data.filter(
      (n: { issue_id: string; type: string }) =>
        n.issue_id === issue.body.id && (n.type === 'mentioned' || n.type === 'comment_added'),
    );
    // Exactly one comment-related notification, and it is the mention (the
    // generic comment_added is suppressed for the mentioned user).
    expect(aliceComment.length).toBe(1);
    expect(aliceComment[0].type).toBe('mentioned');
  });
});

describe('notification reads', () => {
  it('filters by read state and reports an unread count', async () => {
    const unread = await listFor(aliceToken, '?read=false');
    expect(unread.status).toBe(200);
    expect(unread.body.unread_count).toBeGreaterThan(0);
    expect(unread.body.data.every((n: { is_read: boolean }) => n.is_read === false)).toBe(true);
  });

  it('marks a single notification read', async () => {
    const list = await listFor(aliceToken, '?read=false');
    const target = list.body.data[0];
    const before = list.body.unread_count;

    const res = await request(app.server)
      .post(`${notifs()}/${target.id}/read`)
      .set(...auth(aliceToken));
    expect(res.status).toBe(200);
    expect(res.body.is_read).toBe(true);
    expect(res.body.read_at).toBeTruthy();

    const after = await listFor(aliceToken, '?read=false');
    expect(after.body.unread_count).toBe(before - 1);
  });

  it('marks all notifications read', async () => {
    const res = await request(app.server)
      .post(`${notifs()}/read-all`)
      .set(...auth(aliceToken));
    expect(res.status).toBe(200);
    expect(res.body.updated).toBeGreaterThan(0);

    const after = await listFor(aliceToken, '?read=false');
    expect(after.body.unread_count).toBe(0);
    expect(after.body.data.length).toBe(0);
  });
});

describe('notification isolation', () => {
  it('blocks a non-member from listing workspace notifications', async () => {
    const res = await listFor(outsiderToken);
    expect(res.status).toBe(403);
  });

  it("404s when marking another user's notification read", async () => {
    // Bob has notifications; Alice cannot mark them read.
    const bobList = await listFor(bobToken);
    const bobNotif = bobList.body.data[0];
    expect(bobNotif).toBeDefined();

    const res = await request(app.server)
      .post(`${notifs()}/${bobNotif.id}/read`)
      .set(...auth(aliceToken));
    expect(res.status).toBe(404);
  });
});

describe('notification rows carry the issue and can be filtered (8.B6)', () => {
  it('includes the issue brief and the actor ФИО fields', async () => {
    const res = await listFor(aliceToken);
    expect(res.status).toBe(200);
    const assigned = res.body.data.find((n: { type: string }) => n.type === 'issue_assigned');
    expect(assigned.issue).toMatchObject({
      project_id: projectId,
      project: { identifier: 'NOT' },
    });
    expect(typeof assigned.issue.title).toBe('string');
    expect(typeof assigned.issue.sequence_id).toBe('number');
    expect(assigned.actor).toHaveProperty('last_name');
  });

  it('filters by type (repeated or comma-separated) and rejects unknown types', async () => {
    const one = await listFor(aliceToken, '?type=mentioned');
    expect(one.status).toBe(200);
    expect(one.body.data.length).toBeGreaterThan(0);
    expect(one.body.data.every((n: { type: string }) => n.type === 'mentioned')).toBe(true);

    const both = await listFor(aliceToken, '?type=mentioned,issue_assigned');
    const types = new Set(both.body.data.map((n: { type: string }) => n.type));
    expect([...types].every((t) => t === 'mentioned' || t === 'issue_assigned')).toBe(true);
    expect(types.size).toBe(2);

    const repeated = await listFor(aliceToken, '?type=mentioned&type=issue_assigned');
    expect(repeated.body.data.length).toBe(both.body.data.length);

    const bad = await listFor(aliceToken, '?type=nope');
    expect(bad.status).toBe(400);
  });

  it('marks a notification unread again (own only)', async () => {
    const list = await listFor(aliceToken);
    const target = list.body.data[0];
    expect(target.is_read).toBe(true); // everything was marked read above

    const res = await request(app.server)
      .post(`${notifs()}/${target.id}/unread`)
      .set(...auth(aliceToken));
    expect(res.status).toBe(200);
    expect(res.body.is_read).toBe(false);
    expect(res.body.read_at).toBeNull();
    expect((await listFor(aliceToken, '?read=false')).body.unread_count).toBe(1);

    const foreign = await request(app.server)
      .post(`${notifs()}/${target.id}/unread`)
      .set(...auth(bobToken));
    expect(foreign.status).toBe(404);
  });
});
