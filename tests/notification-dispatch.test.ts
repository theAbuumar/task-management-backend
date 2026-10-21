// Notification dispatcher, HTML letters and digests (Ф8 8.B3, 8.B4, 8.B5, ADR-033).
//
// - A copy for Telegram / email is written with the bell row in the action's
//   transaction and sent right after the commit; a rolled-back action leaves none.
// - A channel failure never breaks the action: the copy is retried (1, 5, 15, 60 min)
//   and marked `failed` after five attempts.
// - In quiet hours the copy waits and goes out when they end.
// - Copies for a member whose access was turned off, or of a deleted task, are skipped.
// - Letters are HTML with a plain-text version, in the reader's language.
// - Daily digest: due today, overdue, not acknowledged, waiting for a decision; once
//   a day at the chosen hour, an empty one is not sent. Weekly digest: department
//   heads on Mondays. «Прислать сейчас».
// The Bot API is mocked at `fetch`, the mailer at the module boundary.

import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { sendMail } from '../src/lib/mailer.js';
import { notify } from '../src/lib/notifications.js';
import { purgeDeliveries, sendDeliveries } from '../src/lib/notify/send.js';
import { runDigests } from '../src/lib/notify/digest.js';

vi.mock('../src/lib/mailer.js', () => ({ sendMail: vi.fn(async () => {}) }));
const sendMailMock = vi.mocked(sendMail);

const TS = Date.now();
const PASSWORD = 'Password123!';
const SLUG = `ndsp-${TS}`;
const TG = { member: TS + 11, digest: TS + 12, idle: TS + 13, head: TS + 14 };

type Actor = { id: string; token: string; email: string };
let app: FastifyInstance;
let owner: Actor; // the actor: creates and controls
let tg: Actor; // Telegram linked
let mail: Actor; // email only
let dg: Actor; // digest reader, Telegram
let idle: Actor; // digest reader with nothing to do, Telegram
let head: Actor; // department head, Telegram
let workspaceId: string;
let projectId: string;
let states: { id: string; group: string; is_default: boolean }[] = [];
let botCalls: { method: string; body: Record<string, unknown> }[] = [];
let telegramDown = false;

const api = (path: string) => `/api/v1/workspaces/${SLUG}${path}`;
const settings = '/api/v1/auth/me/notification-settings';

async function register(tag: string): Promise<Actor> {
  const email = `ndsp-${tag}-${TS}@example.com`;
  const res = await request(app.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, display_name: `Сотрудник ${tag}` });
  expect(res.status).toBe(201);
  return { id: res.body.user.id, token: res.body.access_token, email };
}

const as = (a: Actor) => ({
  post: (url: string, body: object = {}) =>
    request(app.server).post(url).set('Authorization', `Bearer ${a.token}`).send(body),
  put: (url: string, body: object) =>
    request(app.server).put(url).set('Authorization', `Bearer ${a.token}`).send(body),
});

async function link(user: Actor, chatId: number) {
  await app.prisma.authIdentity.create({
    data: { user_id: user.id, provider: 'telegram', provider_user_id: String(chatId) },
  });
}

async function join(user: Actor) {
  await app.prisma.workspaceMember.create({
    data: { workspace_id: workspaceId, user_id: user.id, role: 'member' },
  });
}

const stateOf = (group: string) =>
  (states.find((s) => s.group === group && s.is_default) ?? states.find((s) => s.group === group))!
    .id;

async function createIssue(body: Record<string, unknown>): Promise<{ id: string; key: string }> {
  const res = await as(owner).post(api(`/projects/${projectId}/issues`), {
    state_id: stateOf('unstarted'),
    ...body,
  });
  expect(res.status).toBe(201);
  return { id: res.body.id, key: `NDS-${res.body.sequence_id}` };
}

const copiesOf = (issueId: string) =>
  app.prisma.notificationDelivery.findMany({ where: { issue_id: issueId } });

const sentTo = (chatId: number) =>
  botCalls
    .filter((c) => c.method === 'sendMessage' && c.body.chat_id === chatId)
    .map((c) => String(c.body.text));

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  owner = await register('owner');
  tg = await register('tg');
  mail = await register('mail');
  dg = await register('digest');
  idle = await register('idle');
  head = await register('head');
  await link(tg, TG.member);
  await link(dg, TG.digest);
  await link(idle, TG.idle);
  await link(head, TG.head);

  const ws = await request(app.server)
    .post('/api/v1/workspaces')
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ name: 'Диспетчер уведомлений', slug: SLUG });
  expect(ws.status).toBe(201);
  workspaceId = ws.body.id;
  await app.prisma.workspace.update({ where: { id: workspaceId }, data: { timezone: 'UTC' } });
  for (const u of [tg, mail, dg, idle, head]) await join(u);
  await app.prisma.user.updateMany({
    where: { id: { in: [tg.id, mail.id, dg.id, idle.id, head.id] } },
    data: { timezone: 'UTC' },
  });

  const project = await as(owner).post(api('/projects'), { name: 'Диспетчер', identifier: 'NDS' });
  expect(project.status).toBe(201);
  projectId = project.body.id;
  states = (
    await request(app.server)
      .get(api(`/projects/${projectId}/states`))
      .set('Authorization', `Bearer ${owner.token}`)
  ).body;

  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.startsWith('https://api.telegram.org/')) return realFetch(input, init);
    botCalls.push({
      method: url.split('/').pop()!,
      body: JSON.parse((init?.body as string) ?? '{}'),
    });
    if (telegramDown) return new Response('Bad Gateway', { status: 502 });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      headers: { 'content-type': 'application/json' },
    });
  });
});

afterEach(() => {
  botCalls = [];
  telegramDown = false;
  sendMailMock.mockClear();
});

afterAll(async () => {
  vi.restoreAllMocks();
  const users = [owner, tg, mail, dg, idle, head].map((u) => u.id);
  await app.prisma.workspace.deleteMany({ where: { slug: SLUG } });
  await app.prisma.refreshToken.deleteMany({ where: { user_id: { in: users } } });
  await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  await app.close();
});

describe('dispatcher (8.B3)', () => {
  it('a new assignment queues a copy with the bell row and sends it right after the commit', async () => {
    const issue = await createIssue({
      title: 'Подготовить справку о кадровом составе',
      kind: 'assignment',
      assignee_ids: [tg.id],
      controller_id: owner.id,
      requires_review: true,
      due_date: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    });
    const [copy] = await copiesOf(issue.id);
    expect(copy).toMatchObject({
      user_id: tg.id,
      channel: 'telegram',
      status: 'sent',
      attempts: 1,
      actor_id: owner.id,
      type: 'issue_assigned',
    });
    const bell = await app.prisma.notification.findFirstOrThrow({
      where: { issue_id: issue.id, recipient_id: tg.id },
    });
    expect(copy!.notification_id).toBe(bell.id);
    const [text] = sentTo(TG.member);
    expect(text).toContain('поручил(а) вам');
    expect(text).toContain(issue.key);
  });

  it('a rolled-back action leaves no copies', async () => {
    const issue = await createIssue({ title: 'Черновик приказа' });
    await expect(
      app.prisma.$transaction(async (tx) => {
        await notify(tx, {
          workspace_id: workspaceId,
          actor_id: owner.id,
          type: 'issue_assigned',
          recipient_ids: [tg.id],
          issue_id: issue.id,
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await copiesOf(issue.id)).toHaveLength(0);
  });

  it('a Telegram failure does not break the action; the copy is retried, then sent', async () => {
    telegramDown = true;
    const issue = await createIssue({ title: 'Обновить план мероприятий', assignee_ids: [tg.id] });
    const [copy] = await copiesOf(issue.id);
    expect(copy).toMatchObject({ status: 'queued', attempts: 1 });
    expect(copy!.error).toContain('Telegram');
    const wait = copy!.next_attempt_at.getTime() - Date.now();
    expect(wait).toBeGreaterThan(40_000);
    expect(wait).toBeLessThan(70_000);

    // Not due yet: nothing happens.
    telegramDown = false;
    await sendDeliveries(app.prisma, { ids: [copy!.id], now: new Date(Date.now() + 20_000) });
    expect((await copiesOf(issue.id))[0]!.status).toBe('queued');

    botCalls = [];
    await sendDeliveries(app.prisma, { ids: [copy!.id], now: new Date(Date.now() + 120_000) });
    expect((await copiesOf(issue.id))[0]).toMatchObject({ status: 'sent', attempts: 2 });
    expect(sentTo(TG.member)).toHaveLength(1);
  });

  it('after five failed attempts the copy is marked failed with the error', async () => {
    telegramDown = true;
    const issue = await createIssue({ title: 'Сверить штатное расписание', assignee_ids: [tg.id] });
    const id = (await copiesOf(issue.id))[0]!.id;
    let at = Date.now();
    for (let i = 0; i < 4; i += 1) {
      at += 2 * 60 * 60_000;
      await sendDeliveries(app.prisma, { ids: [id], now: new Date(at) });
    }
    const copy = (await copiesOf(issue.id))[0]!;
    expect(copy).toMatchObject({ status: 'failed', attempts: 5 });
    expect(copy.error).toContain('Telegram');
  });

  it('in quiet hours the copy waits and goes out when they end', async () => {
    const hour = new Date().getUTCHours();
    await as(mail).put(settings, {
      quiet_hours: { enabled: true, from: hour, to: (hour + 2) % 24 },
    });
    const issue = await createIssue({
      title: 'Проверить журнал практики',
      assignee_ids: [mail.id],
    });
    const [copy] = await copiesOf(issue.id);
    expect(copy).toMatchObject({
      channel: 'email',
      status: 'queued',
      reason: 'quiet_hours',
      attempts: 0,
    });
    expect(copy!.next_attempt_at.getUTCHours()).toBe((hour + 2) % 24);
    expect(copy!.next_attempt_at.getUTCMinutes()).toBe(0);
    expect(sendMailMock).not.toHaveBeenCalled();

    const end = copy!.next_attempt_at.getTime();
    await sendDeliveries(app.prisma, { ids: [copy!.id], now: new Date(end - 60_000) });
    expect(sendMailMock).not.toHaveBeenCalled();
    await sendDeliveries(app.prisma, { ids: [copy!.id], now: new Date(end + 60_000) });
    expect((await copiesOf(issue.id))[0]).toMatchObject({ status: 'sent', reason: null });
    expect(sendMailMock.mock.calls.map((c) => c[0].to)).toEqual([mail.email]);
    await as(mail).put(settings, { quiet_hours: { enabled: false } });
  });

  it('a member whose access was turned off and a deleted task get nothing', async () => {
    telegramDown = true;
    const first = await createIssue({ title: 'Подготовить отчёт кафедры', assignee_ids: [tg.id] });
    const second = await createIssue({ title: 'Собрать заявки', assignee_ids: [tg.id] });
    telegramDown = false;
    botCalls = [];
    const later = new Date(Date.now() + 5 * 60_000);

    await app.prisma.workspaceMember.update({
      where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: tg.id } },
      data: { deactivated_at: new Date() },
    });
    await sendDeliveries(app.prisma, { issueIds: [first.id], now: later });
    expect((await copiesOf(first.id))[0]).toMatchObject({
      status: 'skipped',
      reason: 'member_deactivated',
    });
    await app.prisma.workspaceMember.update({
      where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: tg.id } },
      data: { deactivated_at: null },
    });

    await app.prisma.issue.update({ where: { id: second.id }, data: { deleted_at: new Date() } });
    await sendDeliveries(app.prisma, { issueIds: [second.id], now: later });
    expect((await copiesOf(second.id))[0]).toMatchObject({
      status: 'skipped',
      reason: 'issue_deleted',
    });
    expect(sentTo(TG.member)).toHaveLength(0);
  });

  it('nobody gets a copy of their own action, and settings decide the channel', async () => {
    await as(mail).put(settings, { email: { assigned: false } });
    const issue = await createIssue({
      title: 'Без писем',
      assignee_ids: [mail.id, owner.id],
    });
    expect(await copiesOf(issue.id)).toHaveLength(0);
    await as(mail).put(settings, { email: { assigned: true } });
  });

  it('finished copies older than 90 days are purged, waiting ones stay', async () => {
    const old = new Date(Date.now() - 100 * 86_400_000);
    const base = {
      workspace_id: workspaceId,
      user_id: tg.id,
      type: 'overdue' as const,
      channel: 'telegram' as const,
      created_at: old,
    };
    const sent = await app.prisma.notificationDelivery.create({
      data: { ...base, status: 'sent' },
    });
    const queued = await app.prisma.notificationDelivery.create({
      data: { ...base, status: 'queued', next_attempt_at: new Date(Date.now() + 86_400_000) },
    });
    await purgeDeliveries(app.prisma);
    const left = await app.prisma.notificationDelivery.findMany({
      where: { id: { in: [sent.id, queued.id] } },
    });
    expect(left.map((d) => d.id)).toEqual([queued.id]);
    await app.prisma.notificationDelivery.delete({ where: { id: queued.id } });
  });
});

describe('letters (8.B4)', () => {
  it('HTML with a plain-text version, the deep link and «Настроить уведомления», in the reader’s language', async () => {
    await app.prisma.user.update({ where: { id: mail.id }, data: { locale: 'en' } });
    const issue = await createIssue({
      title: 'Prepare the self-assessment report',
      assignee_ids: [mail.id],
      due_date: '2030-03-14T12:00:00.000Z',
    });
    const letter = sendMailMock.mock.calls.find((c) => c[0].to === mail.email)![0];
    expect(letter.subject).toContain('assigned you a task');
    expect(letter.subject).toContain(issue.key);
    expect(letter.html).toContain('<!doctype html>');
    expect(letter.html).toContain('Open task');
    expect(letter.html).toContain(`/w/${SLUG}/browse/${issue.key}`);
    expect(letter.html).toContain('/profile#notifications');
    expect(letter.html).toContain('14 March 2030');
    // No logo: a square with the workspace initials.
    expect(letter.html).toContain('>ДУ<');
    expect(letter.text).toContain(`Open task: `);
    expect(letter.text).toContain('Notification settings: ');
    expect(letter.text).not.toContain('<');

    sendMailMock.mockClear();
    await app.prisma.user.update({ where: { id: mail.id }, data: { locale: 'ru' } });
    await createIssue({ title: 'Подготовить отчёт о самообследовании', assignee_ids: [mail.id] });
    const ru = sendMailMock.mock.calls.find((c) => c[0].to === mail.email)![0];
    expect(ru.subject).toContain('назначил(а) вам задачу');
    expect(ru.html).toContain('Открыть задачу');
    expect(ru.html).toContain('Настроить уведомления');
  });

  it('a returned hand-in carries the remark as a quote', async () => {
    const issue = await createIssue({
      title: 'Отчёт о практике',
      kind: 'assignment',
      assignee_ids: [mail.id],
      controller_id: owner.id,
      requires_review: true,
    });
    const assignee = await request(app.server)
      .post('/api/v1/auth/login')
      .send({ email: mail.email, password: PASSWORD });
    const base = api(`/projects/${projectId}/issues/${issue.id}`);
    const submit = await request(app.server)
      .post(`${base}/review/submit`)
      .set('Authorization', `Bearer ${assignee.body.access_token}`)
      .send({ report: 'Готово' });
    expect(submit.status).toBe(200);
    sendMailMock.mockClear();
    const back = await as(owner).post(`${base}/review/return`, { comment: 'Добавьте таблицу' });
    expect(back.status).toBe(200);
    const letter = sendMailMock.mock.calls.find((c) => c[0].to === mail.email)![0];
    expect(letter.subject).toContain('вернул(а) на доработку');
    expect(letter.html).toContain('Замечание');
    expect(letter.html).toContain('Добавьте таблицу');
  });
});

describe('digests (8.B5)', () => {
  // A Wednesday and a Monday far from the other test data.
  const WED = '2030-01-09';
  const MON = '2030-01-07';
  const at = (date: string, hour: number) =>
    new Date(`${date}T${String(hour).padStart(2, '0')}:10:00Z`);

  it('daily: due today, overdue, not acknowledged and waiting for a decision — once a day at the chosen hour', async () => {
    await as(dg).put(settings, { digest: { daily: true, weekly: false, hour: 7 } });
    const today = await createIssue({
      title: 'Сдать расписание консультаций',
      assignee_ids: [dg.id],
      due_date: `${WED}T15:00:00.000Z`,
    });
    const overdue = await createIssue({
      title: 'Обновить рабочие программы',
      assignee_ids: [dg.id],
      due_date: '2030-01-06T15:00:00.000Z',
    });
    await createIssue({
      title: 'Поручение без отметки',
      kind: 'assignment',
      assignee_ids: [dg.id],
      controller_id: owner.id,
    });
    const controlled = await createIssue({
      title: 'Отчёт на проверке',
      kind: 'assignment',
      assignee_ids: [owner.id],
      controller_id: dg.id,
      requires_review: true,
    });
    await app.prisma.issueReview.create({
      data: { workspace_id: workspaceId, issue_id: controlled.id, submitted_by_id: owner.id },
    });

    await runDigests(app.prisma, at(WED, 6));
    expect(
      await app.prisma.notificationDelivery.count({ where: { user_id: dg.id, type: 'digest' } }),
    ).toBe(0);

    await runDigests(app.prisma, at(WED, 7));
    await runDigests(app.prisma, at(WED, 7));
    const copies = await app.prisma.notificationDelivery.findMany({
      where: { user_id: dg.id, type: 'digest' },
    });
    expect(copies).toHaveLength(1);
    const copy = copies[0]!;
    expect(copy).toMatchObject({
      channel: 'telegram',
      status: 'queued',
      dedupe_key: `digest:daily:${dg.id}:${WED}`,
    });
    const digest = (copy.payload as { digest: { sections: { totals: object }[] } }).digest;
    expect(digest.sections[0]!.totals).toEqual({
      today: 1,
      overdue: 1,
      unacknowledged: 1,
      to_decide: 1,
    });

    botCalls = [];
    await sendDeliveries(app.prisma, { ids: [copy.id], now: at(WED, 7) });
    const [text] = sentTo(TG.digest);
    expect(text).toContain('Сводка на 9 января');
    expect(text).toContain('Срок сегодня — 1');
    expect(text).toContain(today.key);
    expect(text).toContain(overdue.key);
    expect(text).toContain('сдано на проверку');
  });

  it('an empty daily digest is not sent, but «Прислать сейчас» still sends it', async () => {
    await as(idle).put(settings, { digest: { daily: true, hour: 7 } });
    await runDigests(app.prisma, at(WED, 7));
    const copy = await app.prisma.notificationDelivery.findFirstOrThrow({
      where: { user_id: idle.id, type: 'digest' },
    });
    expect(copy).toMatchObject({ status: 'skipped', reason: 'empty' });
    expect(sentTo(TG.idle)).toHaveLength(0);

    const now = await as(idle).post(`${settings}/digest`, { kind: 'daily' });
    expect(now.status).toBe(200);
    expect(now.body).toEqual({ delivered_to: 'telegram', status: 'sent' });
    expect(sentTo(TG.idle)[0]).toContain('Сроков на сегодня нет');
  });

  it('weekly: a department head gets a summary of the previous week on Mondays', async () => {
    await as(head).put(settings, { digest: { weekly: true, hour: 6 } });
    const dep = await app.prisma.department.create({
      data: { workspace_id: workspaceId, name: 'Кафедра цифровой экономики', head_id: head.id },
    });
    const issue = await createIssue({ title: 'Отчёт кафедры за семестр', assignee_ids: [head.id] });
    await app.prisma.issue.update({
      where: { id: issue.id },
      data: {
        department_id: dep.id,
        created_at: new Date('2030-01-02T09:00:00Z'),
        due_date: new Date('2030-01-03T18:00:00Z'),
        state_id: stateOf('completed'),
        completed_at: new Date('2030-01-03T10:00:00Z'),
      },
    });

    await runDigests(app.prisma, at('2030-01-08', 6)); // Tuesday
    expect(
      await app.prisma.notificationDelivery.count({ where: { user_id: head.id, type: 'digest' } }),
    ).toBe(0);

    await runDigests(app.prisma, at(MON, 6));
    const copy = await app.prisma.notificationDelivery.findFirstOrThrow({
      where: { user_id: head.id, type: 'digest' },
    });
    expect(copy.dedupe_key).toBe(`digest:weekly:${head.id}:${MON}`);
    const digest = (
      copy.payload as {
        digest: {
          from: string;
          to: string;
          departments: {
            department: string;
            figures: { created: number; completed: number; on_time: number };
          }[];
        };
      }
    ).digest;
    expect(digest).toMatchObject({ from: '2029-12-31', to: '2030-01-06' });
    expect(digest.departments[0]).toMatchObject({
      department: 'Кафедра цифровой экономики',
      figures: { created: 1, completed: 1, on_time: 1 },
    });

    botCalls = [];
    await sendDeliveries(app.prisma, { ids: [copy.id], now: at(MON, 6) });
    expect(sentTo(TG.head)[0]).toContain('Сводка по подразделению');
  });

  it('the weekly digest is only for heads; the settings say who is one', async () => {
    const res = await as(idle).post(`${settings}/digest`, { kind: 'weekly' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NOT_DEPARTMENT_HEAD');
    const view = await request(app.server)
      .get(settings)
      .set('Authorization', `Bearer ${head.token}`);
    expect(view.body.is_department_head).toBe(true);
    expect(view.body.digest).toEqual({ daily: false, weekly: true, hour: 6 });
  });
});

describe('personal data (12.B13)', () => {
  it('the delivery log is in «Мои данные» without texts and goes with the account', async () => {
    const exported = await request(app.server)
      .get('/api/v1/auth/me/export')
      .set('Authorization', `Bearer ${mail.token}`);
    expect(exported.status).toBe(200);
    const log = JSON.parse(exported.text).notification_deliveries as { channel: string }[];
    expect(log.length).toBeGreaterThan(0);
    expect(log[0]).toMatchObject({ channel: 'email' });
    // The remark of the controller is someone else's text: not in the file.
    expect(exported.text).not.toContain('Добавьте таблицу');

    sendMailMock.mockClear();
    const ask = await as(mail).post('/api/v1/auth/account/delete/request');
    expect(ask.status).toBe(200);
    const code = /(\d{6})/.exec(sendMailMock.mock.calls[0]![0].subject)![1];
    const done = await as(mail).post('/api/v1/auth/account/delete/confirm', { code });
    expect(done.status).toBe(204);
    expect(await app.prisma.notificationDelivery.count({ where: { user_id: mail.id } })).toBe(0);
  });
});
