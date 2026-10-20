// Performance check on 10 000 issues (Ф7 7.B7): builds a separate workspace
// `perf-10k` (5 projects, one private; 3 departments; 40 people; 10 000 issues
// with assignees, labels and ~3 history rows each), then times the main reads
// in-process — no network — as an admin, a department head and a member.
//
//   NODE_ENV=test JOBS_ENABLED=false npm run perf:10k             # build (once) + measure
//   NODE_ENV=test JOBS_ENABLED=false npm run perf:10k -- --drop   # remove the workspace
//
// NODE_ENV=test keeps Prisma from printing every query (it would skew the times).
//
// Local databases only: never point it at production. The demo university is
// not touched.

import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { buildApp } from '../app.js';
import { hashSecret } from '../lib/password.js';

const SLUG = 'perf-10k';
const ISSUES = 10_000;
const PEOPLE = 40;
const RUNS = 10;
const DAY = 86_400_000;

/** A line of the report (a script: stdout is its output). */
const say = (line: string) => process.stdout.write(`${line}\n`);

const TITLES = [
  'Подготовить отчёт о самообследовании',
  'Актуализировать рабочие программы',
  'Собрать сведения о кадровом обеспечении',
  'Провести внутренний аудит программы',
  'Согласовать расписание экзаменов',
  'Обновить положение о практике',
  'Представить план повышения квалификации',
  'Проверить электронную среду',
];

async function main() {
  const app = await buildApp({ logger: false });
  await app.ready();
  const prisma = app.prisma;
  const email = (i: number) => `perf-${i}@perf.local`;

  if (process.argv.includes('--drop')) {
    await prisma.workspace.deleteMany({ where: { slug: SLUG } });
    await prisma.user.deleteMany({ where: { email: { endsWith: '@perf.local' } } });
    say('✓ perf-10k removed');
    await app.close();
    return;
  }

  let ws = await prisma.workspace.findUnique({ where: { slug: SLUG } });
  if (!ws) ws = await build(prisma, email);
  const count = await prisma.issue.count({ where: { workspace_id: ws.id } });
  say(`perf-10k: ${count} issues`);

  // Tokens through the real sign-in.
  const login = async (i: number) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: email(i), password: 'Password123!' },
    });
    return JSON.parse(res.body).access_token as string;
  };
  const tokens = { admin: await login(0), head: await login(1), member: await login(10) };
  const projects = await prisma.project.findMany({
    where: { workspace_id: ws.id },
    orderBy: { identifier: 'asc' },
  });
  const dept = await prisma.department.findFirst({
    where: { workspace_id: ws.id, parent_id: null, head_id: { not: null } },
  });
  const api = (p: string) => `/api/v1/workspaces/${SLUG}${p}`;

  const cases: [string, keyof typeof tokens, string][] = [
    ['WS/issues — первая страница', 'admin', api('/issues?limit=50')],
    ['WS/issues — просроченные', 'admin', api('/issues?overdue=true&limit=50')],
    [
      'WS/issues — открытые подразделения с подчинёнными',
      'admin',
      api(`/issues?department=${dept!.id}&open=true&limit=50`),
    ],
    ['WS/issues — сотрудник (видимость проектов)', 'member', api('/issues?limit=50')],
    [
      'P/issues — страница доски (100)',
      'admin',
      api(`/projects/${projects[0]!.id}/issues?limit=100&sort_by=sort_order&order=asc`),
    ],
    ['WS/search — «отчёт»', 'admin', api('/search?q=' + encodeURIComponent('отчёт'))],
    [
      'WS/issues — поиск по названию «отчёт»',
      'admin',
      api('/issues?limit=50&search=' + encodeURIComponent('отчёт')),
    ],
    ['WS/activity — лента, администратор', 'admin', api('/activity?limit=50')],
    ['WS/activity — лента, руководитель', 'head', api('/activity?limit=50')],
    ['WS/me/summary', 'member', api('/me/summary')],
    ['WS/analytics/dashboard (кэш)', 'admin', api('/analytics/dashboard')],
  ];

  say(`\n| Запрос | Медиана, мс | Худший, мс |\n|---|---|---|`);
  for (const [name, who, url] of cases) {
    const times: number[] = [];
    for (let i = 0; i <= RUNS; i++) {
      const started = performance.now();
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${tokens[who]}` },
      });
      const ms = performance.now() - started;
      if (res.statusCode !== 200) throw new Error(`${url} → ${res.statusCode} ${res.body}`);
      if (i > 0) times.push(ms); // the first run warms caches up
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)]!;
    say(`| ${name} | ${median.toFixed(0)} | ${times[times.length - 1]!.toFixed(0)} |`);
  }

  // The board loads a whole project page by page (2000 issues here, 20 pages).
  const board: number[] = [];
  for (let i = 0; i <= 3; i++) {
    const started = performance.now();
    let cursor: string | null = null;
    do {
      const res: { body: string } = await app.inject({
        method: 'GET',
        url: api(
          `/projects/${projects[0]!.id}/issues?limit=100&sort_by=sort_order&order=asc${cursor ? `&cursor=${cursor}` : ''}`,
        ),
        headers: { authorization: `Bearer ${tokens.admin}` },
      });
      cursor = (JSON.parse(res.body) as { next_cursor: string | null }).next_cursor;
    } while (cursor);
    if (i > 0) board.push(performance.now() - started);
  }
  board.sort((a, b) => a - b);
  say(
    `| P/issues — вся доска проекта, 2000 задач (20 страниц) | ${board[1]!.toFixed(0)} | ${board[2]!.toFixed(0)} |`,
  );
  await app.close();
}

async function build(prisma: PrismaClient, email: (i: number) => string) {
  say('→ building perf-10k (one time)…');
  const password = await hashSecret('Password123!');
  const users = await Promise.all(
    Array.from({ length: PEOPLE }, (_, i) =>
      prisma.user.create({
        data: {
          email: email(i),
          email_verified: true,
          password_hash: password,
          display_name: `Нагрузкин${i} Тест Тестович`,
        },
      }),
    ),
  );
  const ws = await prisma.workspace.create({
    data: { name: 'Нагрузочный университет', slug: SLUG, owner_id: users[0]!.id },
  });
  const faculty = await prisma.department.create({
    data: { workspace_id: ws.id, name: 'Факультет нагрузки', head_id: users[1]!.id },
  });
  const chair = await prisma.department.create({
    data: { workspace_id: ws.id, name: 'Кафедра запросов', parent_id: faculty.id },
  });
  const other = await prisma.department.create({
    data: { workspace_id: ws.id, name: 'Отдел индексов', head_id: users[2]!.id },
  });
  const deptOf = (i: number) => (i < 3 ? faculty.id : [faculty.id, chair.id, other.id][i % 3]!);
  await prisma.workspaceMember.createMany({
    data: users.map((u, i) => ({
      workspace_id: ws.id,
      user_id: u.id,
      role: i === 0 ? ('owner' as const) : ('member' as const),
      department_id: deptOf(i),
    })),
  });

  const GROUPS = [
    ['Бэклог', 'backlog', '#6B7280'],
    ['К выполнению', 'unstarted', '#374151'],
    ['В работе', 'started', '#3B82F6'],
    ['На проверке', 'review', '#8B5CF6'],
    ['Готово', 'completed', '#10B981'],
    ['Отменено', 'cancelled', '#EF4444'],
  ] as const;
  const projects = [];
  for (let p = 0; p < 5; p++) {
    const project = await prisma.project.create({
      data: {
        workspace_id: ws.id,
        name: `Проект нагрузки ${p + 1}`,
        identifier: `PF${p + 1}`,
        visibility: p === 4 ? 'private' : 'public',
        lead_id: users[0]!.id,
      },
    });
    const states = await Promise.all(
      GROUPS.map(([name, group, color], order) =>
        prisma.state.create({
          data: { project_id: project.id, name, group, color, order, is_default: order === 1 },
        }),
      ),
    );
    const labels = await Promise.all(
      ['Документы', 'Срочно', 'Министерство'].map((name) =>
        prisma.label.create({
          data: { workspace_id: ws.id, project_id: project.id, name, color: '#3B82F6' },
        }),
      ),
    );
    projects.push({ project, states, labels });
  }

  const now = Date.now();
  const per = ISSUES / projects.length;
  for (const [p, { project, states, labels }] of projects.entries()) {
    for (let start = 0; start < per; start += 1000) {
      const issues: Prisma.IssueCreateManyInput[] = [];
      const assignees: Prisma.IssueAssigneeCreateManyInput[] = [];
      const issueLabels: Prisma.IssueLabelCreateManyInput[] = [];
      const history: Prisma.ActivityLogCreateManyInput[] = [];
      for (let k = start; k < Math.min(per, start + 1000); k++) {
        const id = randomUUID();
        const n = p * per + k;
        const state = states[n % states.length]!;
        const created = new Date(now - ((n * 7) % 120) * DAY);
        const who = users[3 + (n % (PEOPLE - 3))]!;
        issues.push({
          id,
          workspace_id: ws.id,
          project_id: project.id,
          sequence_id: k + 1,
          title: `${TITLES[n % TITLES.length]} №${n}`,
          description: n % 3 === 0 ? 'Подробности в протоколе заседания.' : null,
          state_id: state.id,
          priority: (['none', 'low', 'medium', 'high', 'urgent'] as const)[n % 5],
          kind: n % 4 === 0 ? 'task' : 'assignment',
          controller_id: n % 4 === 0 ? null : users[1 + (n % 2)]!.id,
          requires_review: n % 4 !== 0,
          start_date: created,
          due_date: new Date(created.getTime() + (5 + (n % 40)) * DAY),
          completed_at: state.group === 'completed' ? new Date(created.getTime() + 10 * DAY) : null,
          created_by_id: users[0]!.id,
          sort_order: k,
          created_at: created,
        });
        assignees.push({ issue_id: id, user_id: who.id, is_primary: true });
        if (n % 3 === 0) issueLabels.push({ issue_id: id, label_id: labels[n % 3]!.id });
        for (let h = 0; h < 3; h++) {
          history.push({
            workspace_id: ws.id,
            issue_id: id,
            actor_id: h === 0 ? users[0]!.id : who.id,
            action: h === 0 ? 'issue.created' : h === 1 ? 'comment.created' : 'issue.updated',
            field: h === 2 ? 'state_id' : null,
            new_value: h === 2 ? state.id : null,
            created_at: new Date(created.getTime() + h * 3_600_000),
          });
        }
      }
      await prisma.issue.createMany({ data: issues });
      await prisma.issueAssignee.createMany({ data: assignees });
      await prisma.issueLabel.createMany({ data: issueLabels });
      await prisma.activityLog.createMany({ data: history });
    }
  }
  await prisma.$executeRawUnsafe('ANALYZE');
  say('✓ built');
  return ws;
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
