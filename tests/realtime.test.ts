// Integration tests for the live event stream GET /workspaces/:slug/events (Ф8 8.B1):
// changes arrive over SSE after commit, filtered by what each subscriber may see —
// private projects only for their members and admins, notifications only for their
// recipients — plus auth, the token-expiry close and Last-Event-ID replay.
//
// The app listens on a random port so the stream is read over real HTTP (inject
// would buffer the never-ending response). Runs against a live Postgres; created
// rows are removed in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import jwt from 'jsonwebtoken';
import type { FastifyInstance } from 'fastify';
import { config } from '../src/config/index.js';

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `rt-${TS}`;
const emails = {
  rector: `rt-rector-${TS}@example.com`,
  dean: `rt-dean-${TS}@example.com`,
  clerk: `rt-clerk-${TS}@example.com`,
  outsider: `rt-outsider-${TS}@example.com`,
};

type Actor = { id: string; token: string };
type Sse = { event: string; id?: string; data: Record<string, unknown> };

let app: FastifyInstance;
let base: string;
let rector: Actor; // owner
let dean: Actor; // member of both projects
let clerk: Actor; // member, not in the private project
let outsider: Actor;
let publicProject: string;
let privateProject: string;
const todo: Record<string, string> = {};

const api = (path: string) => `/api/v1/workspaces/${SLUG}${path}`;

async function register(email: string): Promise<Actor> {
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, display_name: email.split('@')[0] });
  expect(res.status).toBe(201);
  return { id: res.body.user.id, token: res.body.access_token };
}

function as(actor: Actor) {
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${actor.token}`);
  return {
    get: (url: string) => auth(request(app.server).get(url)),
    post: (url: string, body?: object) => auth(request(app.server).post(url)).send(body ?? {}),
    patch: (url: string, body: object) => auth(request(app.server).patch(url)).send(body),
  };
}

/** An open SSE stream that collects parsed messages. */
class Stream {
  events: Sse[] = [];
  closed = false;
  private controller = new AbortController();
  private buffer = '';

  static async open(actor: Actor, headers: Record<string, string> = {}): Promise<Stream> {
    const s = new Stream();
    const res = await fetch(`${base}${api('/events')}`, {
      headers: { Authorization: `Bearer ${actor.token}`, ...headers },
      signal: s.controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    void s.pump(res.body!);
    await s.waitFor((e) => e.event === 'ready');
    return s;
  }

  private async pump(body: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of body) {
        this.buffer += decoder.decode(chunk, { stream: true });
        let cut: number;
        while ((cut = this.buffer.indexOf('\n\n')) >= 0) {
          const block = this.buffer.slice(0, cut);
          this.buffer = this.buffer.slice(cut + 2);
          const msg: Partial<Sse> = {};
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) msg.event = line.slice(7);
            else if (line.startsWith('id: ')) msg.id = line.slice(4);
            else if (line.startsWith('data: ')) msg.data = JSON.parse(line.slice(6));
          }
          if (msg.event) this.events.push(msg as Sse);
        }
      }
    } catch {
      // aborted
    }
    this.closed = true;
  }

  async waitFor(pred: (e: Sse) => boolean, ms = 3000): Promise<Sse> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(
      `no matching event in ${ms} ms; got ${this.events.map((e) => e.event).join(', ')}`,
    );
  }

  /** Give in-flight events time to arrive, then return those of `type` for `issueId`. */
  async settled(type: string, issueId: string, ms = 400): Promise<Sse[]> {
    await new Promise((r) => setTimeout(r, ms));
    return this.events.filter((e) => e.event === type && e.data.issue_id === issueId);
  }

  close() {
    this.controller.abort();
  }
}

async function createIssue(project: string, title: string, extra: object = {}): Promise<string> {
  const res = await as(rector).post(api(`/projects/${project}/issues`), {
    title,
    state_id: todo[project],
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  rector = await register(emails.rector);
  dean = await register(emails.dean);
  clerk = await register(emails.clerk);
  outsider = await register(emails.outsider);

  await as(rector).post('/api/v1/workspaces', { name: 'Университет', slug: SLUG });
  await as(rector).post(api('/members'), { user_id: dean.id, role: 'member' });
  await as(rector).post(api('/members'), { user_id: clerk.id, role: 'member' });

  const pub = await as(rector).post(api('/projects'), {
    name: 'Аккредитация',
    identifier: 'RTA',
    member_ids: [dean.id, clerk.id],
  });
  publicProject = pub.body.id;
  const priv = await as(rector).post(api('/projects'), {
    name: 'Бюджет',
    identifier: 'RTB',
    visibility: 'private',
    member_ids: [dean.id],
  });
  privateProject = priv.body.id;
  for (const p of [publicProject, privateProject]) {
    const st = await as(rector).get(api(`/projects/${p}/states`));
    todo[p] = st.body.find((s: { group: string }) => s.group === 'unstarted').id;
  }
});

afterAll(async () => {
  const list = Object.values(emails);
  await app.prisma.workspace.deleteMany({ where: { slug: SLUG } });
  await app.prisma.refreshToken.deleteMany({ where: { user: { email: { in: list } } } });
  await app.prisma.user.deleteMany({ where: { email: { in: list } } });
  await app.close();
});

describe('GET /workspaces/:slug/events', () => {
  it('requires a token and workspace membership', async () => {
    const anon = await fetch(`${base}${api('/events')}`);
    expect(anon.status).toBe(401);
    const stranger = await fetch(`${base}${api('/events')}`, {
      headers: { Authorization: `Bearer ${outsider.token}` },
    });
    expect(stranger.status).toBe(403);
  });

  it('pushes issue changes with the actor, to everyone who sees the project', async () => {
    const deanStream = await Stream.open(dean);
    const clerkStream = await Stream.open(clerk);
    try {
      const id = await createIssue(publicProject, 'Отчёт о самообследовании');
      const created = await deanStream.waitFor(
        (e) => e.event === 'issue.created' && e.data.issue_id === id,
      );
      expect(created.data).toMatchObject({
        type: 'issue.created',
        issue_id: id,
        project_id: publicProject,
        actor: { id: rector.id, display_name: expect.any(String) },
      });
      expect(created.id).toMatch(/^[0-9a-f]+-\d+$/);
      await clerkStream.waitFor((e) => e.event === 'issue.created' && e.data.issue_id === id);

      // Several fields in one update → one event listing them.
      await as(rector).patch(api(`/projects/${publicProject}/issues/${id}`), {
        title: 'Отчёт о самообследовании (ред.)',
        priority: 'high',
      });
      const updated = await deanStream.waitFor(
        (e) => e.event === 'issue.updated' && e.data.issue_id === id,
      );
      expect(updated.data.fields).toEqual(expect.arrayContaining(['title', 'priority']));
      expect(await deanStream.settled('issue.updated', id)).toHaveLength(1);

      // A reorder leaves no activity row but still reaches other boards.
      await as(rector).patch(api(`/projects/${publicProject}/issues/${id}`), { sort_order: 12345 });
      await deanStream.waitFor(
        (e) => e.event === 'issue.updated' && e.data.issue_id === id && !e.data.fields,
      );

      await as(dean).post(api(`/projects/${publicProject}/issues/${id}/comments`), {
        body: 'Принято в работу',
      });
      const comment = await clerkStream.waitFor(
        (e) => e.event === 'comment.created' && e.data.issue_id === id,
      );
      expect((comment.data.actor as { id: string }).id).toBe(dean.id);
    } finally {
      deanStream.close();
      clerkStream.close();
    }
  });

  it('keeps private-project events from members outside the project', async () => {
    const deanStream = await Stream.open(dean);
    const clerkStream = await Stream.open(clerk);
    try {
      const id = await createIssue(privateProject, 'Смета на 2027 год');
      await deanStream.waitFor((e) => e.event === 'issue.created' && e.data.issue_id === id);
      expect(await clerkStream.settled('issue.created', id)).toHaveLength(0);
    } finally {
      deanStream.close();
      clerkStream.close();
    }
  });

  it('sends notification.created only to its recipients, never to the actor', async () => {
    const deanStream = await Stream.open(dean);
    const clerkStream = await Stream.open(clerk);
    const rectorStream = await Stream.open(rector);
    try {
      const id = await createIssue(publicProject, 'Подготовить справку', {
        assignee_ids: [dean.id],
      });
      const note = await deanStream.waitFor(
        (e) => e.event === 'notification.created' && e.data.issue_id === id,
      );
      expect(note.data.notification_type).toBe('issue_assigned');
      expect(await clerkStream.settled('notification.created', id)).toHaveLength(0);
      expect(await rectorStream.settled('notification.created', id, 0)).toHaveLength(0);
    } finally {
      deanStream.close();
      clerkStream.close();
      rectorStream.close();
    }
  });

  it('pushes the review cycle', async () => {
    const id = await createIssue(publicProject, 'Поручение с проверкой', {
      kind: 'assignment',
      controller_id: rector.id,
      assignee_ids: [dean.id],
    });
    const rectorStream = await Stream.open(rector);
    try {
      const res = await as(dean).post(
        api(`/projects/${publicProject}/issues/${id}/review/submit`),
        {
          report: 'Готово, отчёт приложен',
        },
      );
      expect(res.status).toBe(200);
      await rectorStream.waitFor((e) => e.event === 'review.submitted' && e.data.issue_id === id);
      await rectorStream.waitFor(
        (e) =>
          e.event === 'notification.created' && e.data.notification_type === 'review_requested',
      );
    } finally {
      rectorStream.close();
    }
  });

  it('replays missed events after Last-Event-ID, and asks for a resync on an unknown id', async () => {
    const first = await Stream.open(dean);
    const a = await createIssue(publicProject, 'Событие до обрыва');
    const seen = await first.waitFor((e) => e.event === 'issue.created' && e.data.issue_id === a);
    first.close();

    const b = await createIssue(publicProject, 'Событие во время обрыва');
    const hidden = await createIssue(privateProject, 'Скрытое событие во время обрыва');

    const again = await Stream.open(clerk, { 'Last-Event-ID': seen.id! });
    try {
      await again.waitFor((e) => e.event === 'issue.created' && e.data.issue_id === b);
      expect(again.events.some((e) => e.data?.issue_id === a)).toBe(false);
      // Replay applies the same visibility rules.
      expect(again.events.some((e) => e.data?.issue_id === hidden)).toBe(false);
    } finally {
      again.close();
    }

    const stale = await Stream.open(dean, { 'Last-Event-ID': 'deadbeef-1' });
    try {
      await stale.waitFor((e) => e.event === 'resync');
    } finally {
      stale.close();
    }
  });

  it('closes the stream when the access token expires', async () => {
    const shortLived = jwt.sign({ sub: dean.id }, config.JWT_ACCESS_SECRET, { expiresIn: 2 });
    const s = await Stream.open({ id: dean.id, token: shortLived });
    const deadline = Date.now() + 4000;
    while (!s.closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(s.closed).toBe(true);
  });

  it('forgets closed streams', async () => {
    const settle = async (n: number) => {
      const deadline = Date.now() + 2000;
      while (app.realtime.size !== n && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(app.realtime.size).toBe(n);
    };
    await settle(0); // streams of the earlier tests are gone
    const s = await Stream.open(dean);
    expect(app.realtime.size).toBe(1);
    s.close();
    await settle(0);
  });
});
