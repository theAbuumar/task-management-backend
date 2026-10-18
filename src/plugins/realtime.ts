// Real-time events, delivery side (Ф8 8.B1, ADR-010).
//
// One dedicated PostgreSQL connection LISTENs on the events channel (lib/realtime
// NOTIFYs it from inside the mutating transactions, so only committed changes
// arrive). The hub keeps the open SSE streams per workspace and pushes each event
// to the subscribers allowed to see it:
//   - notification.created — only to its recipients;
//   - issue / comment / review events — to members who see the issue's project
//     (public project, or a private one they belong to, or admin/owner) — the same
//     rule as visibleIssuesWhere / the workspace hook.
// With several API instances each one listens, so a change made through any
// instance reaches subscribers on all of them.
//
// Reconnects: every event gets an id `<boot>-<seq>`; the last ~1000 are kept in
// memory and replayed after `Last-Event-ID`. When the id is from another process
// (restart, other instance) or too old, the stream starts with `resync` and the
// client reloads what it shows.
//
// The listener starts with the first subscriber, so processes that never serve a
// stream (tests, scripts) open no extra connection.

import fp from 'fastify-plugin';
import crypto from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { WorkspaceRole } from '@prisma/client';
import { config } from '../config/index.js';
import { REALTIME_CHANNEL, type RealtimePayload } from '../lib/realtime.js';

const HEARTBEAT_MS = 25_000;
const BUFFER_SIZE = 1000;
const RECONNECT_MAX_MS = 30_000;

/** What a subscriber receives as the `data:` of one SSE message. */
export interface RealtimeEvent {
  id: string;
  type: RealtimePayload['t'];
  workspace_id: string;
  issue_id: string | null;
  project_id: string | null;
  actor: { id: string; display_name: string } | null;
  fields?: string[];
  notification_type?: string;
  at: string;
}

interface BufferedEvent {
  seq: number;
  payload: RealtimePayload;
  at: Date;
  /** Resolved lazily: the issue's project (undefined = not looked up yet). */
  project?: { id: string; visibility: string } | null;
}

interface Subscriber {
  userId: string;
  /** Sign-in session of the stream's access token (Ф12 12.B2), null for older tokens. */
  sessionId: string | null;
  role: WorkspaceRole;
  workspaceId: string;
  raw: ServerResponse;
  /** Private projects this subscriber was checked against (true = member). */
  privateAccess: Map<string, boolean>;
}

const BOOT = crypto.randomBytes(4).toString('hex');

/** Prisma URLs carry Prisma-only params (`schema`, `connection_limit`…) that pg rejects. */
function pgConnectionString(url: string): string {
  const u = new URL(url);
  for (const key of [
    'schema',
    'connection_limit',
    'pool_timeout',
    'pgbouncer',
    'statement_cache_size',
  ]) {
    u.searchParams.delete(key);
  }
  return u.toString();
}

export class RealtimeHub {
  private seq = 0;
  private buffer: BufferedEvent[] = [];
  private subscribers = new Map<string, Set<Subscriber>>();
  private client: pg.Client | null = null;
  private listening: Promise<void> | null = null;
  private reconnectDelay = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private actorNames = new Map<string, string>();
  /** Events are handled one after another so every stream sees them in commit order. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly app: FastifyInstance) {}

  /** Start LISTEN once (idempotent); resolves when events are flowing. */
  ensureListening(): Promise<void> {
    this.listening ??= this.connect().catch((err) => {
      this.listening = null;
      throw err;
    });
    return this.listening;
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: pgConnectionString(config.DATABASE_URL) });
    client.on('notification', (msg) => {
      if (msg.channel !== REALTIME_CHANNEL || !msg.payload) return;
      let payload: RealtimePayload;
      try {
        payload = JSON.parse(msg.payload) as RealtimePayload;
      } catch (err) {
        this.app.log.warn({ err }, 'realtime: malformed event payload');
        return;
      }
      void this.enqueue(() => this.handle(payload));
    });
    client.on('error', (err) => {
      this.app.log.error({ err }, 'realtime: listener connection lost');
      this.scheduleReconnect(client);
    });
    client.on('end', () => this.scheduleReconnect(client));
    await client.connect();
    await client.query(`LISTEN ${REALTIME_CHANNEL}`);
    this.client = client;
    this.reconnectDelay = 1000;
  }

  private scheduleReconnect(dead: pg.Client) {
    if (this.closed || this.client !== dead || this.reconnectTimer) return;
    this.client = null;
    this.listening = null;
    void dead.end().catch(() => {});
    // Events published while disconnected are lost: tell every stream to reload.
    for (const set of this.subscribers.values()) {
      for (const s of set) this.write(s.raw, 'resync', { reason: 'reconnect' });
    }
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureListening().catch((err) => {
        this.app.log.error({ err }, 'realtime: reconnect failed');
        this.scheduleReconnect(this.client ?? dead);
      });
    }, delay);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task, task);
    this.queue = run.catch((err) => this.app.log.error({ err }, 'realtime: delivery failed'));
    return this.queue;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const set of this.subscribers.values()) for (const s of set) s.raw.end();
    this.subscribers.clear();
    await this.client?.end().catch(() => {});
    this.client = null;
  }

  /** Register an open stream; replays missed events. Returns the unsubscribe. */
  async subscribe(sub: Subscriber, lastEventId: string | undefined): Promise<() => void> {
    const set = this.subscribers.get(sub.workspaceId) ?? new Set<Subscriber>();
    set.add(sub);
    this.subscribers.set(sub.workspaceId, set);

    this.write(sub.raw, 'ready', { boot: BOOT });
    if (lastEventId) await this.enqueue(() => this.replay(sub, lastEventId));

    return () => {
      set.delete(sub);
      if (set.size === 0) this.subscribers.delete(sub.workspaceId);
    };
  }

  /**
   * Close the user's streams opened with the given sessions — or all of them — when
   * those sessions end (Ф12 12.B2) or the account is deactivated (12.B7). The client
   * reconnects, and the auth hook turns it away.
   */
  disconnect(userId: string, sessionIds?: string[]): void {
    for (const set of this.subscribers.values()) {
      for (const s of set) {
        if (s.userId !== userId) continue;
        if (sessionIds && (!s.sessionId || !sessionIds.includes(s.sessionId))) continue;
        s.raw.end();
      }
    }
  }

  /** Number of open streams (tests, diagnostics). */
  get size(): number {
    let n = 0;
    for (const set of this.subscribers.values()) n += set.size;
    return n;
  }

  private async replay(sub: Subscriber, lastEventId: string) {
    const [boot, seqText] = lastEventId.split('-');
    const last = Number(seqText);
    const oldest = this.buffer[0]?.seq ?? this.seq + 1;
    if (boot !== BOOT || !Number.isInteger(last) || last < oldest - 1) {
      this.write(sub.raw, 'resync', { reason: 'gap' });
      return;
    }
    const missed = this.buffer.filter((e) => e.seq > last && e.payload.w === sub.workspaceId);
    await this.resolveProjects(missed);
    for (const e of missed) await this.deliver(sub, e);
  }

  /** One event from LISTEN: buffer it and push it to the workspace's streams. */
  private async handle(payload: RealtimePayload) {
    const entry: BufferedEvent = { seq: ++this.seq, payload, at: new Date() };
    this.buffer.push(entry);
    if (this.buffer.length > BUFFER_SIZE) this.buffer.shift();

    const set = this.subscribers.get(payload.w);
    if (!set || set.size === 0) return;
    await this.resolveProjects([entry]);
    for (const sub of set) await this.deliver(sub, entry);
  }

  private async resolveProjects(entries: BufferedEvent[]) {
    const pending = entries.filter((e) => e.project === undefined && e.payload.i);
    if (pending.length === 0) return;
    const issues = await this.app.prisma.issue.findMany({
      where: { id: { in: [...new Set(pending.map((e) => e.payload.i!))] } },
      select: { id: true, project: { select: { id: true, visibility: true } } },
    });
    const byId = new Map(issues.map((i) => [i.id, i.project]));
    for (const e of pending) e.project = byId.get(e.payload.i!) ?? null;
  }

  private async canSee(sub: Subscriber, e: BufferedEvent): Promise<boolean> {
    const p = e.payload;
    if (p.t === 'notification.created') return Boolean(p.r?.includes(sub.userId));
    if (!e.project) return false;
    if (e.project.visibility !== 'private' || sub.role === 'owner' || sub.role === 'admin')
      return true;
    let member = sub.privateAccess.get(e.project.id);
    if (member === undefined) {
      member = Boolean(
        await this.app.prisma.projectMember.findUnique({
          where: { project_id_user_id: { project_id: e.project.id, user_id: sub.userId } },
          select: { project_id: true },
        }),
      );
      sub.privateAccess.set(e.project.id, member);
    }
    return member;
  }

  private async actor(id: string | null): Promise<RealtimeEvent['actor']> {
    if (!id) return null;
    let name = this.actorNames.get(id);
    if (name === undefined) {
      const user = await this.app.prisma.user.findUnique({
        where: { id },
        select: { display_name: true },
      });
      name = user?.display_name ?? '';
      if (this.actorNames.size > 1000) this.actorNames.clear();
      this.actorNames.set(id, name);
    }
    return { id, display_name: name };
  }

  private async deliver(sub: Subscriber, e: BufferedEvent) {
    if (!(await this.canSee(sub, e))) return;
    const p = e.payload;
    const event: RealtimeEvent = {
      id: `${BOOT}-${e.seq}`,
      type: p.t,
      workspace_id: p.w,
      issue_id: p.i ?? null,
      project_id: e.project?.id ?? null,
      actor: await this.actor(p.a),
      ...(p.f && { fields: p.f }),
      ...(p.n && { notification_type: p.n }),
      at: e.at.toISOString(),
    };
    this.write(sub.raw, event.type, event, event.id);
  }

  private write(raw: ServerResponse, event: string, data: unknown, id?: string) {
    if (raw.writableEnded) return;
    raw.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** Comment line keeping proxies and the browser from timing the stream out. */
  static heartbeat(raw: ServerResponse) {
    if (!raw.writableEnded) raw.write(': ping\n\n');
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    realtime: RealtimeHub;
  }
}

async function realtimePlugin(app: FastifyInstance): Promise<void> {
  const hub = new RealtimeHub(app);
  app.decorate('realtime', hub);
  // Streams never end on their own: close them before the server waits for them.
  app.addHook('preClose', async () => hub.close());
}

export { HEARTBEAT_MS };
export default fp(realtimePlugin, { name: 'realtime', dependencies: ['prisma'] });
