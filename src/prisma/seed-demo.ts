// Demo stand data (Ф5 5.D1 → Ф13 13.B1): a fictional university with a real-looking
// org structure, people with full names and positions, projects, and ~70 tasks /
// assignments with 2.5 months of history (on time, late, returned for rework,
// moved deadlines, overdue, waiting for review) so dashboards and analytics look
// alive. Dates are relative to "now", so re-running keeps the picture fresh.
//
//   npm run demo:seed          (uses DATABASE_URL — local: bash dev/seed-demo.sh)
//
// Idempotent: the demo workspace (slug `demo-university`) and every `@demo.local`
// account are deleted and recreated. Nothing else in the database is touched.
// Demo accounts sign in through the DEMO_MODE quick login (auth/demo-routes.ts).

import { PrismaClient, type IssuePriority, type NotificationType, type StateGroup } from '@prisma/client';
import { DEFAULT_STATES } from '../modules/projects/service.js';
import { pluralize } from '../lib/plural.js';

const prisma = new PrismaClient();

const SLUG = 'demo-university';
const DOMAIN = '@demo.local';
const TZ = 'Asia/Dushanbe'; // UTC+5, no DST
const DAY = 86_400_000;
const NOW = Date.now();

/** Local (UTC+5) wall-clock time `days` from now at `hour`. */
function at(days: number, hour = 10): Date {
  const d = new Date(NOW + days * DAY);
  d.setUTCHours(hour - 5, Math.floor(rand() * 50), 0, 0);
  return d;
}
const plusDays = (d: Date, days: number) => new Date(d.getTime() + days * DAY);
const minDate = (a: Date, b: Date) => (a < b ? a : b);

// Deterministic RNG (mulberry32) so every seed produces the same university.
let seedState = 20261023;
function rand(): number {
  seedState |= 0;
  seedState = (seedState + 0x6d2b79f5) | 0;
  let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

// ─── Org structure ────────────────────────────────────────────────────────────

interface Dept {
  key: string;
  name: string;
  short?: string;
  parent?: string;
  /** Share of work this unit finishes on time — makes the analytics differ. */
  reliability: number;
}

const DEPARTMENTS: Dept[] = [
  { key: 'rector', name: 'Ректорат', reliability: 0.9 },
  { key: 'edu', name: 'Проректорат по учебной работе', parent: 'rector', reliability: 0.85 },
  { key: 'umu', name: 'Учебно-методическое управление', short: 'УМУ', parent: 'edu', reliability: 0.85 },
  { key: 'econ', name: 'Факультет экономики и управления', short: 'ФЭУ', parent: 'edu', reliability: 0.72 },
  { key: 'fin', name: 'Кафедра финансов и кредита', parent: 'econ', reliability: 0.7 },
  { key: 'mgmt', name: 'Кафедра менеджмента', parent: 'econ', reliability: 0.74 },
  { key: 'itf', name: 'Факультет информационных технологий', short: 'ФИТ', parent: 'edu', reliability: 0.82 },
  { key: 'se', name: 'Кафедра программной инженерии', parent: 'itf', reliability: 0.85 },
  { key: 'math', name: 'Кафедра прикладной математики', parent: 'itf', reliability: 0.8 },
  { key: 'phil', name: 'Филологический факультет', short: 'ФФ', parent: 'edu', reliability: 0.55 },
  { key: 'sci', name: 'Проректорат по научной работе', parent: 'rector', reliability: 0.75 },
  { key: 'grad', name: 'Отдел аспирантуры и докторантуры', parent: 'sci', reliability: 0.65 },
  { key: 'vosp', name: 'Проректорат по воспитательной работе', parent: 'rector', reliability: 0.78 },
  { key: 'ahch', name: 'Административно-хозяйственная часть', short: 'АХЧ', parent: 'rector', reliability: 0.6 },
  { key: 'hr', name: 'Отдел кадров', parent: 'rector', reliability: 0.8 },
  { key: 'acc', name: 'Бухгалтерия', parent: 'rector', reliability: 0.7 },
  { key: 'it', name: 'IT-центр', parent: 'rector', reliability: 0.92 },
];

interface Person {
  key: string;
  last: string;
  first: string;
  middle: string;
  position: string;
  dept: string;
  role: 'owner' | 'admin' | 'member';
  /** Shown as a demo quick-login button. */
  demo?: string;
  heads?: boolean;
}

const PEOPLE: Person[] = [
  { key: 'rector', last: 'Рахимов', first: 'Фарход', middle: 'Саидович', position: 'Ректор', dept: 'rector', role: 'owner', demo: 'Ректор', heads: true },
  { key: 'pr_edu', last: 'Каримова', first: 'Нилуфар', middle: 'Ахмедовна', position: 'Проректор по учебной работе', dept: 'edu', role: 'admin', demo: 'Проректор', heads: true },
  { key: 'pr_sci', last: 'Назаров', first: 'Бахтиёр', middle: 'Умарович', position: 'Проректор по научной работе', dept: 'sci', role: 'admin', heads: true },
  { key: 'pr_vosp', last: 'Юсупова', first: 'Мадина', middle: 'Рустамовна', position: 'Проректор по воспитательной работе', dept: 'vosp', role: 'admin', heads: true },
  { key: 'umu', last: 'Кодиров', first: 'Азиз', middle: 'Бахромович', position: 'Начальник УМУ', dept: 'umu', role: 'member', heads: true },
  { key: 'dean_econ', last: 'Абдуллоев', first: 'Шерзод', middle: 'Камолович', position: 'Декан ФЭУ', dept: 'econ', role: 'member', demo: 'Декан', heads: true },
  { key: 'dean_it', last: 'Сафарова', first: 'Гулнора', middle: 'Исмоиловна', position: 'Декан ФИТ', dept: 'itf', role: 'member', heads: true },
  { key: 'dean_phil', last: 'Олимов', first: 'Даврон', middle: 'Рашидович', position: 'Декан филологического факультета', dept: 'phil', role: 'member', heads: true },
  { key: 'fin', last: 'Хасанов', first: 'Илхом', middle: 'Шарифович', position: 'Заведующий кафедрой финансов и кредита', dept: 'fin', role: 'member', heads: true },
  { key: 'mgmt', last: 'Мирзоева', first: 'Зарина', middle: 'Алиевна', position: 'Заведующая кафедрой менеджмента', dept: 'mgmt', role: 'member', heads: true },
  { key: 'se', last: 'Петров', first: 'Алексей', middle: 'Викторович', position: 'Заведующий кафедрой программной инженерии', dept: 'se', role: 'member', heads: true },
  { key: 'math', last: 'Иванова', first: 'Елена', middle: 'Сергеевна', position: 'Заведующая кафедрой прикладной математики', dept: 'math', role: 'member', heads: true },
  { key: 'grad', last: 'Захарова', first: 'Анна', middle: 'Павловна', position: 'Начальник отдела аспирантуры', dept: 'grad', role: 'member', heads: true },
  { key: 'ahch', last: 'Бобоев', first: 'Джамшед', middle: 'Насруллоевич', position: 'Проректор по АХЧ', dept: 'ahch', role: 'member', heads: true },
  { key: 'hr', last: 'Турсунова', first: 'Малика', middle: 'Фарруховна', position: 'Начальник отдела кадров', dept: 'hr', role: 'member', heads: true },
  { key: 'acc', last: 'Сидорова', first: 'Ольга', middle: 'Николаевна', position: 'Главный бухгалтер', dept: 'acc', role: 'member', heads: true },
  { key: 'it', last: 'Ли', first: 'Дмитрий', middle: 'Владимирович', position: 'Директор IT-центра', dept: 'it', role: 'admin', heads: true },
  { key: 'umu_spec', last: 'Носирова', first: 'Дилноза', middle: 'Хайдаровна', position: 'Методист УМУ', dept: 'umu', role: 'member', demo: 'Сотрудник' },
  { key: 'it_spec', last: 'Гафуров', first: 'Сухроб', middle: 'Давлатович', position: 'Системный администратор', dept: 'it', role: 'member' },
  { key: 'econ_spec', last: 'Шарипова', first: 'Мехрона', middle: 'Шодиевна', position: 'Старший преподаватель', dept: 'fin', role: 'member' },
  { key: 'phil_spec', last: 'Раджабов', first: 'Фирдавс', middle: 'Олимович', position: 'Доцент', dept: 'phil', role: 'member' },
];

const emailOf = (p: Person) => `${p.key.replace('_', '.')}${DOMAIN}`;

// ─── Projects and their work ──────────────────────────────────────────────────

interface ProjectDef {
  key: string;
  name: string;
  identifier: string;
  description: string;
  dept: string;
  lead: string;
  color: string;
  icon: string;
  visibility?: 'public' | 'private';
  status?: 'planned' | 'active' | 'paused' | 'completed';
  start: number;
  target: number;
  /** Assignee pool (person keys). */
  team: string[];
  /** Controller pool. */
  controllers: string[];
  titles: string[];
}

const PROJECTS: ProjectDef[] = [
  {
    key: 'accr', name: 'Аккредитация 2027', identifier: 'ACCR', icon: '🎓', color: '#3B82F6',
    description: 'Подготовка к государственной аккредитации образовательных программ.',
    dept: 'edu', lead: 'pr_edu', start: -80, target: 120,
    team: ['umu', 'dean_econ', 'dean_it', 'dean_phil', 'fin', 'mgmt', 'se', 'math', 'umu_spec', 'econ_spec'],
    controllers: ['pr_edu', 'rector', 'umu'],
    titles: [
      'Подготовить отчёт о самообследовании факультета',
      'Актуализировать рабочие программы дисциплин',
      'Собрать сведения о кадровом обеспечении программ',
      'Обновить фонды оценочных средств',
      'Проверить соответствие учебных планов стандарту',
      'Подготовить справку о материально-техническом обеспечении',
      'Провести внутренний аудит образовательной программы',
      'Сформировать портфолио достижений студентов',
      'Подготовить отзывы работодателей по программам',
      'Заполнить мониторинг эффективности программы',
      'Подготовить презентацию для экспертной комиссии',
      'Согласовать расписание визита экспертов',
      'Проверить электронную информационно-образовательную среду',
    ],
  },
  {
    key: 'adm', name: 'Приёмная кампания 2027', identifier: 'ADM', icon: '📝', color: '#10B981',
    description: 'Организация приёма абитуриентов: правила, контрольные цифры, профориентация.',
    dept: 'edu', lead: 'pr_edu', start: -40, target: 200,
    team: ['umu', 'umu_spec', 'dean_econ', 'dean_it', 'dean_phil', 'it', 'it_spec', 'phil_spec'],
    controllers: ['pr_edu', 'umu'],
    titles: [
      'Утвердить правила приёма на 2027 год',
      'Подготовить план профориентационных мероприятий',
      'Обновить раздел «Абитуриенту» на сайте',
      'Провести день открытых дверей факультета',
      'Подготовить буклеты по направлениям подготовки',
      'Настроить личный кабинет абитуриента',
      'Согласовать контрольные цифры приёма',
      'Организовать выездные встречи в школах региона',
      'Подготовить график вступительных испытаний',
      'Обучить сотрудников приёмной комиссии',
    ],
  },
  {
    key: 'dig', name: 'Цифровизация университета', identifier: 'DIG', icon: '💻', color: '#8B5CF6',
    description: 'Электронный документооборот, личные кабинеты, единая система поручений.',
    dept: 'it', lead: 'it', start: -70, target: 150,
    team: ['it', 'it_spec', 'se', 'math', 'acc', 'hr'],
    controllers: ['it', 'rector'],
    titles: [
      'Внедрить систему контроля поручений во всех подразделениях',
      'Перевести приказы по личному составу в электронный вид',
      'Настроить единую учётную запись для сотрудников',
      'Подключить электронную подпись для проректоров',
      'Обновить серверное оборудование в главном корпусе',
      'Провести обучение сотрудников работе в системе',
      'Интегрировать расписание с личным кабинетом студента',
      'Подготовить регламент резервного копирования',
      'Перенести бухгалтерскую базу на новый сервер',
      'Настроить Wi-Fi в учебных корпусах №2 и №3',
      'Подготовить отчёт о киберзащищённости',
    ],
  },
  {
    key: 'year', name: 'Подготовка к учебному году', identifier: 'YEAR', icon: '🏫', color: '#F59E0B',
    description: 'Ремонт аудиторий, общежития, закупки и готовность корпусов.',
    dept: 'ahch', lead: 'ahch', start: -75, target: -5, status: 'completed',
    team: ['ahch', 'acc', 'it_spec', 'hr', 'pr_vosp'],
    controllers: ['ahch', 'rector'],
    titles: [
      'Завершить ремонт аудиторий 3-го этажа',
      'Подготовить общежитие №1 к заселению',
      'Закупить учебную мебель для лекционных залов',
      'Проверить пожарную сигнализацию во всех корпусах',
      'Укомплектовать библиотеку новыми учебниками',
      'Согласовать график дежурств на период заселения',
      'Провести инвентаризацию компьютерных классов',
      'Подготовить акт готовности корпусов',
    ],
  },
  {
    key: 'sci', name: 'Научная деятельность и гранты', identifier: 'SCI', icon: '🔬', color: '#EF4444',
    description: 'Гранты, публикации, конференции и подготовка научных кадров.',
    dept: 'sci', lead: 'pr_sci', start: -60, target: 180,
    team: ['grad', 'se', 'math', 'fin', 'mgmt', 'econ_spec', 'phil_spec'],
    controllers: ['pr_sci'],
    titles: [
      'Подать заявку на грант молодых учёных',
      'Подготовить отчёт о публикационной активности',
      'Организовать международную научную конференцию',
      'Утвердить темы диссертаций аспирантов 1-го года',
      'Сформировать план научно-исследовательских работ на год',
      'Подготовить сборник трудов конференции',
      'Провести аттестацию аспирантов',
      'Заключить договор с индустриальным партнёром',
      'Обновить состав диссертационного совета',
    ],
  },
  {
    key: 'hr', name: 'Кадровые вопросы', identifier: 'HR', icon: '👥', color: '#6B7280',
    description: 'Конкурсный отбор, аттестация и повышение квалификации ППС.',
    dept: 'hr', lead: 'hr', start: -50, target: 90, visibility: 'private',
    team: ['hr', 'acc', 'umu'],
    controllers: ['rector', 'hr'],
    titles: [
      'Подготовить приказ о конкурсном отборе ППС',
      'Сформировать график повышения квалификации',
      'Обновить должностные инструкции заведующих кафедрами',
      'Провести аттестацию административного персонала',
      'Подготовить штатное расписание на новый учебный год',
    ],
  },
];

const COMMENTS = [
  'Взял(а) в работу, по срокам успеваем.',
  'Нужны данные от бухгалтерии, запросил(а).',
  'Черновик готов, отправлю на согласование завтра.',
  'Прошу уточнить формат отчёта — по шаблону Минобрнауки?',
  'Согласовано с деканатом.',
  'Добавила таблицу по кафедрам, проверьте, пожалуйста.',
  'Есть риск задержки из-за отпусков сотрудников.',
  'Документы переданы в общий отдел.',
  'Провели совещание, протокол во вложении.',
  'Осталось получить подпись проректора.',
];
const RETURN_REASONS = [
  'Не хватает данных по заочной форме обучения, дополните.',
  'Оформите по утверждённому шаблону и добавьте подписи.',
  'Цифры расходятся с отчётом прошлого года — сверьте, пожалуйста.',
  'Добавьте сводную таблицу по кафедрам.',
];
const DEADLINE_REASONS = [
  'Ждём данные от бухгалтерии до конца месяца.',
  'Совпадает с сессией, просим перенести на неделю.',
  'Требуется согласование с министерством.',
];

type Scenario =
  | 'done_on_time'
  | 'done_late'
  | 'returned_then_done'
  | 'in_review'
  | 'in_progress'
  | 'overdue'
  | 'due_soon'
  | 'new_unacknowledged'
  | 'backlog';

function scenarioFor(reliability: number, projectCompleted: boolean): Scenario {
  if (projectCompleted) return rand() < reliability ? 'done_on_time' : 'done_late';
  const r = rand();
  if (r < 0.46) return rand() < reliability ? (rand() < 0.3 ? 'returned_then_done' : 'done_on_time') : 'done_late';
  if (r < 0.55) return 'in_review';
  if (r < 0.66) return 'in_progress';
  if (r < 0.66 + (1 - reliability) * 0.7) return 'overdue';
  if (r < 0.88) return 'due_soon';
  if (r < 0.95) return 'new_unacknowledged';
  return 'backlog';
}

const PRIORITIES: IssuePriority[] = ['none', 'low', 'medium', 'medium', 'high', 'high', 'urgent'];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function reset(): Promise<void> {
  await prisma.workspace.deleteMany({ where: { slug: SLUG } });
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
}

async function main(): Promise<void> {
  await reset();

  // People
  const userId = new Map<string, string>();
  for (const p of PEOPLE) {
    const user = await prisma.user.create({
      data: {
        email: emailOf(p),
        email_verified: true,
        is_active: true,
        display_name: `${p.last} ${p.first} ${p.middle}`,
        last_name: p.last,
        first_name: p.first,
        middle_name: p.middle,
        locale: 'ru',
        timezone: TZ,
        created_at: at(-90),
      },
    });
    userId.set(p.key, user.id);
  }
  const uid = (key: string) => userId.get(key)!;
  const personByKey = new Map(PEOPLE.map((p) => [p.key, p]));

  // Workspace
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Государственный университет (демо)',
      short_name: 'ГУ',
      slug: SLUG,
      description: 'Демонстрационное пространство: оргструктура, поручения и отчёты.',
      timezone: TZ,
      locale: 'ru',
      owner_id: uid('rector'),
      settings: { control: { reminder_days: [3, 1, 0], reminder_hour: 9, escalation_days: 3, require_report: false } },
      created_at: at(-90),
    },
  });
  const wsId = workspace.id;

  // Departments (parents first — the array is ordered that way)
  const deptId = new Map<string, string>();
  for (const [i, d] of DEPARTMENTS.entries()) {
    const head = PEOPLE.find((p) => p.heads && p.dept === d.key);
    const row = await prisma.department.create({
      data: {
        workspace_id: wsId,
        name: d.name,
        short_name: d.short ?? null,
        parent_id: d.parent ? deptId.get(d.parent)! : null,
        head_id: head ? uid(head.key) : null,
        order: i,
      },
    });
    deptId.set(d.key, row.id);
  }
  const reliabilityOf = (personKey: string) =>
    DEPARTMENTS.find((d) => d.key === personByKey.get(personKey)!.dept)!.reliability;

  // Members
  await prisma.workspaceMember.createMany({
    data: PEOPLE.map((p) => ({
      workspace_id: wsId,
      user_id: uid(p.key),
      role: p.role,
      department_id: deptId.get(p.dept)!,
      position: p.position,
      created_at: at(-90),
    })),
  });

  let issueCount = 0;
  const notifications: {
    recipient_id: string;
    actor_id: string;
    type: NotificationType;
    issue_id: string;
    created_at: Date;
    is_read: boolean;
  }[] = [];

  for (const def of PROJECTS) {
    const project = await prisma.project.create({
      data: {
        workspace_id: wsId,
        name: def.name,
        identifier: def.identifier,
        description: def.description,
        lead_id: uid(def.lead),
        visibility: def.visibility ?? 'public',
        status: def.status ?? 'active',
        start_date: at(def.start),
        target_date: at(def.target),
        department_id: deptId.get(def.dept)!,
        icon: def.icon,
        color: def.color,
        created_at: at(def.start),
      },
    });
    await prisma.state.createMany({ data: DEFAULT_STATES.map((s) => ({ ...s, project_id: project.id })) });
    const states = await prisma.state.findMany({ where: { project_id: project.id } });
    const stateOf = (g: StateGroup) => states.find((s) => s.group === g)!.id;

    const memberKeys = [...new Set([def.lead, ...def.team, ...def.controllers])];
    await prisma.projectMember.createMany({
      data: memberKeys.map((k) => ({
        project_id: project.id,
        user_id: uid(k),
        role: k === def.lead ? ('admin' as const) : ('member' as const),
      })),
    });

    const labels = await Promise.all(
      [
        { name: 'Срочно', color: '#EF4444' },
        { name: 'Отчётность', color: '#3B82F6' },
        { name: 'Документы', color: '#10B981' },
        { name: 'Министерство', color: '#8B5CF6' },
      ].map((l) => prisma.label.create({ data: { ...l, workspace_id: wsId, project_id: project.id } })),
    );

    // Build the issues first so sequence ids follow creation dates.
    const planned = def.titles.map((title, i) => {
      const assignee = def.team[i % def.team.length]!;
      const scenario = scenarioFor(reliabilityOf(assignee), def.status === 'completed');
      const open = !['done_on_time', 'done_late', 'returned_then_done'].includes(scenario);
      const created =
        scenario === 'new_unacknowledged'
          ? at(-between(0, 1), between(9, 17))
          : open
            ? at(-between(3, 28), between(9, 17))
            : at(-between(18, 75), between(9, 17));
      return { title, assignee, scenario, created };
    });
    planned.sort((a, b) => a.created.getTime() - b.created.getTime());

    for (const [index, plan] of planned.entries()) {
      const { title, assignee, scenario, created } = plan;
      const isAssignment = rand() < 0.8;
      const controller = isAssignment ? pick(def.controllers.filter((c) => c !== assignee)) ?? def.lead : null;
      const creator = controller ?? def.lead;
      const coAssignee = rand() < 0.25 ? pick(def.team.filter((t) => t !== assignee)) : null;

      // Deadline relative to the scenario.
      let due: Date | null = plusDays(created, between(7, 21));
      if (scenario === 'overdue') due = at(-between(1, 9), 18);
      if (scenario === 'due_soon') due = at(between(0, 3), 18);
      if (scenario === 'in_progress' || scenario === 'in_review') due = at(between(2, 25), 18);
      if (scenario === 'new_unacknowledged') due = at(between(5, 14), 18);
      if (scenario === 'backlog') due = rand() < 0.5 ? null : at(between(20, 60), 18);

      const done = ['done_on_time', 'done_late', 'returned_then_done'].includes(scenario);
      let completed: Date | null = null;
      if (done && due) {
        completed =
          scenario === 'done_late'
            ? plusDays(due, between(1, 6))
            : plusDays(due, -between(0, 4));
        if (completed <= created) completed = plusDays(created, 1);
        completed = minDate(completed, at(-1));
      }

      const group: StateGroup = done
        ? 'completed'
        : scenario === 'in_review'
          ? 'review'
          : scenario === 'backlog'
            ? 'backlog'
            : scenario === 'new_unacknowledged' || rand() < 0.3
              ? 'unstarted'
              : 'started';

      const issue = await prisma.issue.create({
        data: {
          workspace_id: wsId,
          project_id: project.id,
          sequence_id: index + 1,
          title,
          description: isAssignment
            ? `Поручение по проекту «${def.name}». Результат оформить отчётом и приложить подтверждающие документы.`
            : null,
          state_id: stateOf(group),
          priority: pick(PRIORITIES),
          kind: isAssignment ? 'assignment' : 'task',
          controller_id: controller ? uid(controller) : null,
          requires_review: isAssignment,
          basis: isAssignment && rand() < 0.6 ? `Протокол заседания ректората №${between(3, 14)} от ${plusDays(created, -between(1, 5)).toLocaleDateString('ru-RU', { timeZone: TZ })}` : null,
          start_date: created,
          due_date: due,
          completed_at: completed,
          created_by_id: uid(creator),
          sort_order: index,
          created_at: created,
          updated_at: completed ?? created,
        },
      });
      issueCount += 1;

      const assignees = [assignee, ...(coAssignee ? [coAssignee] : [])];
      await prisma.issueAssignee.createMany({
        data: assignees.map((a, i) => ({
          issue_id: issue.id,
          user_id: uid(a),
          is_primary: i === 0,
          acknowledged_at:
            scenario === 'new_unacknowledged' || !isAssignment
              ? null
              : plusDays(created, rand() * 1.5 + 0.05),
          created_at: created,
        })),
      });
      await prisma.issueWatcher.createMany({
        data: [...new Set([creator, ...assignees, ...(controller ? [controller] : [])])].map((k) => ({
          issue_id: issue.id,
          user_id: uid(k),
        })),
        skipDuplicates: true,
      });
      if (rand() < 0.55) {
        await prisma.issueLabel.create({ data: { issue_id: issue.id, label_id: pick(labels).id } });
      }

      // History: created → (deadline moved) → hand-ins / decisions → done.
      const activity: { action: string; actor: string; when: Date; field?: string; old_value?: string | null; new_value?: string | null }[] = [
        { action: 'issue.created', actor: creator, when: created },
      ];
      if (isAssignment && scenario !== 'new_unacknowledged') {
        activity.push({ action: 'issue.acknowledged', actor: assignee, when: plusDays(created, 0.3) });
      }

      // Deadline change requests (≈15%).
      if (due && isAssignment && rand() < 0.15) {
        const approved = rand() < 0.65;
        const oldDue = plusDays(due, -between(3, 7));
        const requestedAt = plusDays(created, between(2, 5));
        await prisma.deadlineChangeRequest.create({
          data: {
            workspace_id: wsId,
            issue_id: issue.id,
            requested_by_id: uid(assignee),
            old_due_date: approved ? oldDue : due,
            new_due_date: approved ? due : plusDays(due, between(5, 10)),
            reason: pick(DEADLINE_REASONS),
            status: approved ? 'approved' : 'rejected',
            decided_by_id: controller ? uid(controller) : uid(creator),
            decision_comment: approved ? 'Согласовано.' : 'Срок оставляем прежним, это приоритет.',
            created_at: requestedAt,
            decided_at: plusDays(requestedAt, 0.5),
          },
        });
        activity.push({ action: 'issue.deadline_requested', actor: assignee, when: requestedAt });
        activity.push({
          action: approved ? 'issue.deadline_approved' : 'issue.deadline_rejected',
          actor: controller ?? creator,
          when: plusDays(requestedAt, 0.5),
        });
      }

      const reviewer = controller ?? creator;
      if (isAssignment && scenario === 'returned_then_done' && completed) {
        const firstSubmit = plusDays(completed, -between(2, 4));
        await prisma.issueReview.create({
          data: {
            workspace_id: wsId,
            issue_id: issue.id,
            submitted_by_id: uid(assignee),
            report: 'Направляю первую редакцию отчёта.',
            decision: 'returned',
            decided_by_id: uid(reviewer),
            decision_comment: pick(RETURN_REASONS),
            submitted_at: firstSubmit,
            decided_at: plusDays(firstSubmit, 0.4),
          },
        });
        activity.push({ action: 'issue.review_submitted', actor: assignee, when: firstSubmit });
        activity.push({ action: 'issue.review_returned', actor: reviewer, when: plusDays(firstSubmit, 0.4) });
      }
      if (isAssignment && completed) {
        const submit = plusDays(completed, -0.3);
        await prisma.issueReview.create({
          data: {
            workspace_id: wsId,
            issue_id: issue.id,
            submitted_by_id: uid(assignee),
            report: 'Работа выполнена, отчёт и подтверждающие документы приложены.',
            decision: 'approved',
            decided_by_id: uid(reviewer),
            submitted_at: submit,
            decided_at: completed,
          },
        });
        activity.push({ action: 'issue.review_submitted', actor: assignee, when: submit });
        activity.push({ action: 'issue.review_approved', actor: reviewer, when: completed });
      }
      if (isAssignment && scenario === 'in_review') {
        const submit = at(-between(0, 2), between(9, 17));
        await prisma.issueReview.create({
          data: {
            workspace_id: wsId,
            issue_id: issue.id,
            submitted_by_id: uid(assignee),
            report: 'Отчёт подготовлен, прошу проверить.',
            submitted_at: submit,
          },
        });
        activity.push({ action: 'issue.review_submitted', actor: assignee, when: submit });
        notifications.push({ recipient_id: uid(reviewer), actor_id: uid(assignee), type: 'review_requested', issue_id: issue.id, created_at: submit, is_read: false });
      }
      if (completed) {
        activity.push({
          action: 'issue.updated',
          actor: isAssignment ? reviewer : assignee,
          when: completed,
          field: 'state_id',
          new_value: stateOf('completed'),
        });
      }

      await prisma.activityLog.createMany({
        data: activity.map((a) => ({
          workspace_id: wsId,
          issue_id: issue.id,
          actor_id: uid(a.actor),
          action: a.action,
          field: a.field ?? null,
          old_value: a.old_value ?? null,
          new_value: a.new_value ?? null,
          created_at: a.when,
        })),
      });

      // Discussion.
      const commentCount = done ? between(0, 2) : between(0, 3);
      for (let c = 0; c < commentCount; c++) {
        const author = pick([...assignees, reviewer]);
        await prisma.comment.create({
          data: {
            issue_id: issue.id,
            author_id: uid(author),
            body: pick(COMMENTS),
            created_at: plusDays(created, 0.5 + c),
          },
        });
      }

      // Notification feed (the bell): new assignments, overdue work.
      if (scenario === 'new_unacknowledged') {
        for (const a of assignees) {
          notifications.push({ recipient_id: uid(a), actor_id: uid(creator), type: 'issue_assigned', issue_id: issue.id, created_at: created, is_read: false });
        }
      }
      if (scenario === 'overdue') {
        notifications.push({ recipient_id: uid(assignee), actor_id: uid(reviewer), type: 'overdue', issue_id: issue.id, created_at: at(0, 9), is_read: false });
        // Pre-mark today's reminders so the scheduler doesn't re-send them on start.
        await prisma.reminderLog.createMany({
          data: [assignee, reviewer].map((k) => ({
            issue_id: issue.id,
            user_id: uid(k),
            kind: 'overdue',
            for_date: new Date(NOW + 5 * 3600_000).toISOString().slice(0, 10),
          })),
          skipDuplicates: true,
        });
      }
    }
  }

  await prisma.notification.createMany({
    data: notifications.map((n) => ({ ...n, workspace_id: wsId })),
  });

  // eslint-disable-next-line no-console
  console.info(
    `✓ Демо-университет готов: ${pluralize(DEPARTMENTS.length, ['подразделение', 'подразделения', 'подразделений'])}, ` +
      `${pluralize(PEOPLE.length, ['сотрудник', 'сотрудника', 'сотрудников'])}, ` +
      `${pluralize(PROJECTS.length, ['проект', 'проекта', 'проектов'])}, ${pluralize(issueCount, ['задача', 'задачи', 'задач'])}.\n` +
      `  Вход: DEMO_MODE=true → кнопки быстрого входа (${PEOPLE.filter((p) => p.demo).map((p) => p.demo).join(', ')}).`,
  );
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
