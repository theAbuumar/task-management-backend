// Load test on the demo university (Ф12 12.B11): 50 simultaneous users against a
// running API, the screens people open most.
//
//   npm run perf:load                                   # http://127.0.0.1:4100
//   npm run perf:load -- http://localhost:8080 --duration 20
//
// The API must run with DEMO_MODE=true and the demo university loaded (demo-reset):
// the test signs in as every demo account and spreads the 50 connections over them.
// Two parts:
//   1. capacity — each screen alone, 50 connections back to back, no pauses: how many
//      requests a second the server holds and how long they take;
//   2. a working day — 50 people, each doing something every 2 seconds (open the
//      home page, a task, the board, notifications, analytics, write a comment): the
//      times people actually see. The comments land on one task of the demo —
//      demo-reset afterwards.
// Prints a Markdown report for docs/PERFORMANCE.md. Never point it at production.

import os from 'node:os';
import autocannon from 'autocannon';

const args = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const BASE = (args.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:4100').replace(/\/$/, '');
const API = `${BASE}/api/v1`;
const SLUG = 'demo-university';
const CONNECTIONS = flag('connections', 50);
const DURATION = flag('duration', 15);
const DAY_DURATION = flag('day', 60);

/** A line of the report (a script: stdout is its output). */
const say = (line: string) => process.stdout.write(`${line}\n`);

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, init);
  if (!res.ok)
    throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

interface Scenario {
  name: string;
  requests: autocannon.Request[];
}

/**
 * Every connection signs all its requests as one of the demo people, in turn: the
 * person is chosen on the connection's first request and kept in its context
 * (`setHeaders` of autocannon would cover only the first request of a sequence).
 */
function asPeople(tokens: string[], requests: autocannon.Request[]): autocannon.Request[] {
  let next = 0;
  return requests.map((request) => ({
    ...request,
    setupRequest: (req: autocannon.Request, context: object) => {
      const person = context as { token?: string };
      person.token ??= tokens[next++ % tokens.length];
      return {
        ...req,
        headers: {
          ...req.headers,
          authorization: `Bearer ${person.token}`,
          'content-type': 'application/json',
        },
      };
    },
  }));
}

const ms = (n: number) => `${Math.round(n)}`;

function row(name: string, r: autocannon.Result): string {
  const failed = r.non2xx + r.errors + r.timeouts;
  return `| ${name} | ${Math.round(r.requests.average)} | ${ms(r.latency.p50)} | ${ms(r.latency.p90)} | ${ms(r.latency.p99)} | ${ms(r.latency.max)} | ${failed} |`;
}

async function main() {
  const accounts = await json<{ email: string }[]>('/auth/demo/accounts');
  const tokens: string[] = [];
  for (const { email } of accounts) {
    const session = await json<{ access_token: string }>('/auth/demo/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    tokens.push(session.access_token);
  }
  const auth = { authorization: `Bearer ${tokens[0]}` };
  const projects = await json<{ id: string; identifier: string }[]>(
    `/workspaces/${SLUG}/projects/`,
    { headers: auth },
  );
  const project = projects.find((p) => p.identifier === 'ACCR') ?? projects[0]!;
  const issue = await json<{ id: string; sequence_id: number }>(
    `/workspaces/${SLUG}/issues/by-key/${project.identifier}-1`,
    { headers: auth },
  );
  const issuePath = `/workspaces/${SLUG}/projects/${project.id}/issues/${issue.id}`;

  const W = `/api/v1/workspaces/${SLUG}`;
  const screens: Scenario[] = [
    {
      name: 'Главная: сводка «Моя работа»',
      requests: [{ method: 'GET', path: `${W}/me/summary` }],
    },
    {
      name: 'Мои задачи: список по пространству',
      requests: [{ method: 'GET', path: `${W}/issues?limit=50` }],
    },
    {
      name: 'Доска проекта: задачи',
      requests: [{ method: 'GET', path: `${W}/projects/${project.id}/issues/?limit=100` }],
    },
    {
      name: 'Карточка задачи по ключу',
      requests: [{ method: 'GET', path: `${W}/issues/by-key/${project.identifier}-1` }],
    },
    { name: 'Уведомления', requests: [{ method: 'GET', path: `${W}/notifications/?limit=30` }] },
    {
      name: 'Аналитика: показатели',
      requests: [{ method: 'GET', path: `${W}/analytics/summary` }],
    },
  ];

  say(`# Нагрузочный тест — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  say('');
  say(
    `Сервер: ${BASE}; машина теста: ${os.cpus().length} ядер, ${Math.round(os.totalmem() / 2 ** 30)} ГБ; ` +
      `${CONNECTIONS} соединений от ${tokens.length} демо-сотрудников.`,
  );
  say('');
  say(
    `## 1. Пропускная способность: ${CONNECTIONS} соединений без пауз, по ${DURATION} с на экран`,
  );
  say('');
  say('| Экран | Запросов/с | p50, мс | p90, мс | p99, мс | макс, мс | Ошибок |');
  say('|---|---|---|---|---|---|---|');
  for (const screen of screens) {
    const result = await autocannon({
      url: BASE,
      connections: CONNECTIONS,
      duration: DURATION,
      requests: asPeople(tokens, screen.requests),
    });
    say(row(screen.name, result));
  }

  // A working day: each person does something every 2 seconds, a comment now and then.
  const day: autocannon.Request[] = [
    { method: 'GET', path: `${W}/me/summary` },
    { method: 'GET', path: `${W}/issues?limit=50` },
    { method: 'GET', path: `${W}/issues/by-key/${project.identifier}-1` },
    { method: 'GET', path: `${W}/projects/${project.id}/issues/?limit=100` },
    { method: 'GET', path: `${W}/notifications/?limit=30` },
    {
      method: 'POST',
      path: `/api/v1${issuePath}/comments/`,
      body: JSON.stringify({ body: 'Нагрузочный тест: комментарий' }),
    },
    { method: 'GET', path: `${W}/analytics/summary` },
  ];
  const working = await autocannon({
    url: BASE,
    connections: CONNECTIONS,
    // 50 people, one action every 2 s each (a rate per connection must be ≥ 1/s).
    overallRate: CONNECTIONS / 2,
    duration: DAY_DURATION,
    requests: asPeople(tokens, day),
  });
  say('');
  say(
    `## 2. Рабочий день: ${CONNECTIONS} человек, у каждого действие раз в 2 с, ${DAY_DURATION} с`,
  );
  say('');
  say('| Смесь | Запросов/с | p50, мс | p90, мс | p99, мс | макс, мс | Ошибок |');
  say('|---|---|---|---|---|---|---|');
  say(row('Главная, задачи, карточка, доска, уведомления, комментарий, аналитика', working));
  say('');
  say(`Всего запросов: ${working.requests.total}; ответов 2xx: ${working['2xx']}.`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
