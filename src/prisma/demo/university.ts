// Demo stand data (Ф5 5.D1 → Ф13 13.B1): a fictional university with a real-looking
// org structure, people with full names and positions, projects, and ~70 tasks /
// assignments with 2.5 months of history (on time, late, returned for rework,
// moved deadlines, overdue, waiting for review) so dashboards and analytics look
// alive. Dates are relative to "now", so re-running keeps the picture fresh.
//
// On top of the work itself the stand gets what a demo touches next:
//   - real report files (PDF, Excel) handed in with the reports, meeting minutes
//     attached to comments — every attachment opens;
//   - the notification feed the system itself would have produced for that history,
//     by the same rules (who hears about an assignment, a hand-in, a decision, a
//     comment, a reminder), read or unread by age; today's reminders are marked in
//     ReminderLog so the scheduler does not send them twice;
//   - pending deadline requests and @mentions, so there is something to decide;
//   - three months of the audit log (sign-ins, structure, roles, exports, settings);
//   - optionally the presenter's Telegram linked to one demo account
//     (DEMO_TELEGRAM_ID, DEMO_TELEGRAM_ROLE).
//
// The command line entry is ../seed-demo.ts (`npm run demo:reset`, local:
// `bash dev/seed-demo.sh`); tests call `seedDemo` directly.
//
// Idempotent: the demo workspace (slug `demo-university`), its stored files and every
// `@demo.local` account are deleted and recreated. Nothing else in the database is
// touched. Audit entries are append-only (12.B1), so those of a previous run stay
// in the table, tied to ids that no longer exist — no workspace shows them.
// Demo accounts sign in through the DEMO_MODE quick login (auth/demo-routes.ts).

import { randomUUID } from 'node:crypto';
import type {
  IssuePriority,
  NotificationType,
  Prisma,
  PrismaClient,
  StateGroup,
} from '@prisma/client';
import { DEFAULT_STATES } from '../../modules/projects/service.js';
import { buildStorageKey, type StorageDriver } from '../../lib/storage.js';
import { addDays, localDate, localHour, zonedTime } from '../../lib/tz.js';
import {
  nextRunAfter,
  occurrenceOnOrAfter,
  type Schedule,
} from '../../modules/recurring/schedule.js';
import { PDF_MIME, XLSX_MIME, minutesPdf, reportPdf, summaryXlsx } from './files.js';
import {
  buildReport,
  nextRun,
  quarterStart,
  reportPeriod,
  reportStorageKey,
  type Delivery,
} from '../../modules/report-schedules/run.js';

const SLUG = 'demo-university';
const DOMAIN = '@demo.local';
const WS_NAME = 'Государственный университет (демо)';
const TZ = 'Asia/Dushanbe'; // UTC+5, no DST
const DAY = 86_400_000;
const REMINDER_DAYS = [3, 1, 0];
const REMINDER_HOUR = 9;
const ESCALATION_DAYS = 3;
/** Notifications older than this are read; newer ones wait in the bell. */
const UNREAD_WINDOW = 2 * DAY;

let prisma: PrismaClient;
let storage: StorageDriver;
let NOW = Date.now();

/** Local (UTC+5) wall-clock time `days` from now at `hour`. */
function at(days: number, hour = 10): Date {
  const d = new Date(NOW + days * DAY);
  d.setUTCHours(hour - 5, Math.floor(rand() * 50), 0, 0);
  return d;
}
const plusDays = (d: Date, days: number) => new Date(d.getTime() + days * DAY);
const minDate = (a: Date, b: Date) => (a < b ? a : b);
const maxDate = (a: Date, b: Date) => (a > b ? a : b);
/** Something that already happened: never later than a minute ago. */
const cap = (d: Date) => minDate(d, new Date(NOW - 60_000));
/** Local date (YYYY-MM-DD) in the university's time zone. */
const day = (d: Date) => localDate(d, TZ);
/** `hour:minute` on local date `d` (UTC+5, no DST). */
const onDay = (d: string, hour: number, minute = 0) =>
  new Date(`${d}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+05:00`);
const fmt = (d: Date) => d.toLocaleDateString('ru-RU', { timeZone: TZ });
const maxDay = (a: string, b: string) => (a > b ? a : b);

// Deterministic RNG (mulberry32) so every seed produces the same university.
const SEED = 20261023;
let seedState = SEED;
function rand(): number {
  seedState |= 0;
  seedState = (seedState + 0x6d2b79f5) | 0;
  let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
/** `n` distinct items in random order. */
function pickSome<T>(xs: T[], n: number): T[] {
  const copy = [...xs];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, n);
}

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
  {
    key: 'umu',
    name: 'Учебно-методическое управление',
    short: 'УМУ',
    parent: 'edu',
    reliability: 0.85,
  },
  {
    key: 'econ',
    name: 'Факультет экономики и управления',
    short: 'ФЭУ',
    parent: 'edu',
    reliability: 0.72,
  },
  { key: 'fin', name: 'Кафедра финансов и кредита', parent: 'econ', reliability: 0.7 },
  { key: 'mgmt', name: 'Кафедра менеджмента', parent: 'econ', reliability: 0.74 },
  {
    key: 'itf',
    name: 'Факультет информационных технологий',
    short: 'ФИТ',
    parent: 'edu',
    reliability: 0.82,
  },
  { key: 'se', name: 'Кафедра программной инженерии', parent: 'itf', reliability: 0.85 },
  { key: 'math', name: 'Кафедра прикладной математики', parent: 'itf', reliability: 0.8 },
  { key: 'phil', name: 'Филологический факультет', short: 'ФФ', parent: 'edu', reliability: 0.55 },
  { key: 'sci', name: 'Проректорат по научной работе', parent: 'rector', reliability: 0.75 },
  { key: 'grad', name: 'Отдел аспирантуры и докторантуры', parent: 'sci', reliability: 0.65 },
  {
    key: 'vosp',
    name: 'Проректорат по воспитательной работе',
    parent: 'rector',
    reliability: 0.78,
  },
  {
    key: 'ahch',
    name: 'Административно-хозяйственная часть',
    short: 'АХЧ',
    parent: 'rector',
    reliability: 0.6,
  },
  { key: 'hr', name: 'Отдел кадров', parent: 'rector', reliability: 0.8 },
  { key: 'acc', name: 'Бухгалтерия', parent: 'rector', reliability: 0.7 },
  { key: 'it', name: 'IT-центр', parent: 'rector', reliability: 0.92 },
];

export interface Person {
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
  /** Joined by invitation `n` days ago (the rest were added when the stand was set up). */
  invited?: number;
}

const PEOPLE: Person[] = [
  {
    key: 'rector',
    last: 'Рахимов',
    first: 'Фарход',
    middle: 'Саидович',
    position: 'Ректор',
    dept: 'rector',
    role: 'owner',
    demo: 'Ректор',
    heads: true,
  },
  {
    key: 'pr_edu',
    last: 'Каримова',
    first: 'Нилуфар',
    middle: 'Ахмедовна',
    position: 'Проректор по учебной работе',
    dept: 'edu',
    role: 'admin',
    demo: 'Проректор',
    heads: true,
  },
  {
    key: 'pr_sci',
    last: 'Назаров',
    first: 'Бахтиёр',
    middle: 'Умарович',
    position: 'Проректор по научной работе',
    dept: 'sci',
    role: 'admin',
    heads: true,
  },
  {
    key: 'pr_vosp',
    last: 'Юсупова',
    first: 'Мадина',
    middle: 'Рустамовна',
    position: 'Проректор по воспитательной работе',
    dept: 'vosp',
    role: 'admin',
    heads: true,
  },
  {
    key: 'umu',
    last: 'Кодиров',
    first: 'Азиз',
    middle: 'Бахромович',
    position: 'Начальник УМУ',
    dept: 'umu',
    role: 'member',
    heads: true,
  },
  {
    key: 'dean_econ',
    last: 'Абдуллоев',
    first: 'Шерзод',
    middle: 'Камолович',
    position: 'Декан ФЭУ',
    dept: 'econ',
    role: 'member',
    demo: 'Декан',
    heads: true,
  },
  {
    key: 'dean_it',
    last: 'Сафарова',
    first: 'Гулнора',
    middle: 'Исмоиловна',
    position: 'Декан ФИТ',
    dept: 'itf',
    role: 'member',
    heads: true,
  },
  {
    key: 'dean_phil',
    last: 'Олимов',
    first: 'Даврон',
    middle: 'Рашидович',
    position: 'Декан филологического факультета',
    dept: 'phil',
    role: 'member',
    heads: true,
  },
  {
    key: 'fin',
    last: 'Хасанов',
    first: 'Илхом',
    middle: 'Шарифович',
    position: 'Заведующий кафедрой финансов и кредита',
    dept: 'fin',
    role: 'member',
    heads: true,
  },
  {
    key: 'mgmt',
    last: 'Мирзоева',
    first: 'Зарина',
    middle: 'Алиевна',
    position: 'Заведующая кафедрой менеджмента',
    dept: 'mgmt',
    role: 'member',
    heads: true,
  },
  {
    key: 'se',
    last: 'Петров',
    first: 'Алексей',
    middle: 'Викторович',
    position: 'Заведующий кафедрой программной инженерии',
    dept: 'se',
    role: 'member',
    heads: true,
  },
  {
    key: 'math',
    last: 'Иванова',
    first: 'Елена',
    middle: 'Сергеевна',
    position: 'Заведующая кафедрой прикладной математики',
    dept: 'math',
    role: 'member',
    heads: true,
  },
  {
    key: 'grad',
    last: 'Захарова',
    first: 'Анна',
    middle: 'Павловна',
    position: 'Начальник отдела аспирантуры',
    dept: 'grad',
    role: 'member',
    heads: true,
  },
  {
    key: 'ahch',
    last: 'Бобоев',
    first: 'Джамшед',
    middle: 'Насруллоевич',
    position: 'Проректор по АХЧ',
    dept: 'ahch',
    role: 'member',
    heads: true,
  },
  {
    key: 'hr',
    last: 'Турсунова',
    first: 'Малика',
    middle: 'Фарруховна',
    position: 'Начальник отдела кадров',
    dept: 'hr',
    role: 'member',
    heads: true,
  },
  {
    key: 'acc',
    last: 'Сидорова',
    first: 'Ольга',
    middle: 'Николаевна',
    position: 'Главный бухгалтер',
    dept: 'acc',
    role: 'member',
    heads: true,
  },
  {
    key: 'it',
    last: 'Ли',
    first: 'Дмитрий',
    middle: 'Владимирович',
    position: 'Директор IT-центра',
    dept: 'it',
    role: 'admin',
    heads: true,
  },
  {
    key: 'umu_spec',
    last: 'Носирова',
    first: 'Дилноза',
    middle: 'Хайдаровна',
    position: 'Методист УМУ',
    dept: 'umu',
    role: 'member',
    demo: 'Сотрудник',
  },
  {
    key: 'it_spec',
    last: 'Гафуров',
    first: 'Сухроб',
    middle: 'Давлатович',
    position: 'Системный администратор',
    dept: 'it',
    role: 'member',
  },
  {
    key: 'econ_spec',
    last: 'Шарипова',
    first: 'Мехрона',
    middle: 'Шодиевна',
    position: 'Старший преподаватель',
    dept: 'fin',
    role: 'member',
    invited: 86,
  },
  {
    key: 'phil_spec',
    last: 'Раджабов',
    first: 'Фирдавс',
    middle: 'Олимович',
    position: 'Доцент',
    dept: 'phil',
    role: 'member',
    invited: 84,
  },
];

const emailOf = (p: Person) => `${p.key.replace('_', '.')}${DOMAIN}`;
/** The `@handle` comments use to mention someone (local part of the email). */
const handleOf = (p: Person) => emailOf(p).slice(0, -DOMAIN.length);
const fullName = (p: Person) => `${p.last} ${p.first} ${p.middle}`;
export const shortName = (p: Person) => `${p.last} ${p.first[0]}. ${p.middle[0]}.`;
/** «Декан ФЭУ» → «декан ФЭУ» after a comma; abbreviations stay as they are. */
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** DEMO_TELEGRAM_ROLE → the demo account that gets the presenter's Telegram. */
export const DEMO_TELEGRAM_ACCOUNTS = {
  rector: 'rector',
  prorector: 'pr_edu',
  dean: 'dean_econ',
  employee: 'umu_spec',
} as const;
export type DemoTelegramRole = keyof typeof DEMO_TELEGRAM_ACCOUNTS;
/** The same four roles are the quick-login buttons: role → account email. */
export const DEMO_ROLE_EMAILS = Object.fromEntries(
  Object.entries(DEMO_TELEGRAM_ACCOUNTS).map(([role, key]) => [
    role,
    emailOf(PEOPLE.find((p) => p.key === key)!),
  ]),
) as Record<DemoTelegramRole, string>;

// ─── Projects and their work ──────────────────────────────────────────────────

interface ProjectDef {
  key: string;
  name: string;
  identifier: string;
  description: string;
  dept: string;
  lead: string;
  /** Admin who created the project (audit log). */
  createdBy: string;
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
    key: 'accr',
    name: 'Аккредитация 2027',
    identifier: 'ACCR',
    icon: '🎓',
    color: '#3B82F6',
    description: 'Подготовка к государственной аккредитации образовательных программ.',
    dept: 'edu',
    lead: 'pr_edu',
    createdBy: 'pr_edu',
    start: -80,
    target: 120,
    team: [
      'umu',
      'dean_econ',
      'dean_it',
      'dean_phil',
      'fin',
      'mgmt',
      'se',
      'math',
      'umu_spec',
      'econ_spec',
    ],
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
    key: 'adm',
    name: 'Приёмная кампания 2027',
    identifier: 'ADM',
    icon: '📝',
    color: '#10B981',
    description: 'Организация приёма абитуриентов: правила, контрольные цифры, профориентация.',
    dept: 'edu',
    lead: 'pr_edu',
    createdBy: 'pr_edu',
    start: -40,
    target: 200,
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
    key: 'dig',
    name: 'Цифровизация университета',
    identifier: 'DIG',
    icon: '💻',
    color: '#8B5CF6',
    description: 'Электронный документооборот, личные кабинеты, единая система поручений.',
    dept: 'it',
    lead: 'it',
    createdBy: 'it',
    start: -70,
    target: 150,
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
    key: 'year',
    name: 'Подготовка к учебному году',
    identifier: 'YEAR',
    icon: '🏫',
    color: '#F59E0B',
    description: 'Ремонт аудиторий, общежития, закупки и готовность корпусов.',
    dept: 'ahch',
    lead: 'ahch',
    createdBy: 'rector',
    start: -75,
    target: -5,
    status: 'completed',
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
    key: 'sci',
    name: 'Научная деятельность и гранты',
    identifier: 'SCI',
    icon: '🔬',
    color: '#EF4444',
    description: 'Гранты, публикации, конференции и подготовка научных кадров.',
    dept: 'sci',
    lead: 'pr_sci',
    createdBy: 'pr_sci',
    start: -60,
    target: 180,
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
    key: 'hr',
    name: 'Кадровые вопросы',
    identifier: 'HR',
    icon: '👥',
    color: '#6B7280',
    description: 'Конкурсный отбор, аттестация и повышение квалификации ППС.',
    dept: 'hr',
    lead: 'hr',
    createdBy: 'rector',
    start: -50,
    target: 90,
    visibility: 'private',
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

// «блокирует» links between a project's issues (7.F4): the timeline draws them
// as arrows. By title, with no random draws, so the rest of the demo stays the
// same. The dates follow the links except one — the self-assessment report was
// started before the staffing data came in — which the timeline shows in red.
const DEPENDENCIES: Record<string, [blocker: string, blocked: string][]> = {
  accr: [
    ['Актуализировать рабочие программы дисциплин', 'Обновить фонды оценочных средств'],
    [
      'Подготовить справку о материально-техническом обеспечении',
      'Подготовить отчёт о самообследовании факультета',
    ],
    [
      'Заполнить мониторинг эффективности программы',
      'Подготовить отчёт о самообследовании факультета',
    ],
    [
      'Провести внутренний аудит образовательной программы',
      'Подготовить отчёт о самообследовании факультета',
    ],
    [
      'Провести внутренний аудит образовательной программы',
      'Проверить электронную информационно-образовательную среду',
    ],
    [
      'Собрать сведения о кадровом обеспечении программ',
      'Подготовить отчёт о самообследовании факультета',
    ],
  ],
};

const MINUTES_COMMENT = 'Провели совещание, протокол во вложении.';
const COMMENTS = [
  'Взял(а) в работу, по срокам успеваем.',
  'Нужны данные от бухгалтерии, запросил(а).',
  'Черновик готов, отправлю на согласование завтра.',
  'Прошу уточнить формат отчёта — по шаблону Минобрнауки?',
  'Согласовано с деканатом.',
  'Добавила таблицу по кафедрам, проверьте, пожалуйста.',
  'Есть риск задержки из-за отпусков сотрудников.',
  'Документы переданы в общий отдел.',
  MINUTES_COMMENT,
  'Осталось получить подпись проректора.',
];
/** After `@controller`. */
const MENTIONS_TO_CONTROLLER = [
  'черновик готов, посмотрите, пожалуйста, до отправки на проверку.',
  'нужна ваша виза на сводной таблице.',
  'уточните, пожалуйста, нужны ли данные по заочной форме.',
];
/** After `@assignee`. */
const MENTIONS_TO_ASSIGNEE = [
  'прошу ускорить, срок близко.',
  'добавьте, пожалуйста, данные за прошлый год для сравнения.',
  'посмотрите замечания экспертов в протоколе совещания.',
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
const REPORT_STEPS = [
  'собраны и проверены исходные данные подразделений',
  'подготовлен проект документа и согласован с руководителями кафедр',
  'учтены замечания учебно-методического управления',
  'сводные показатели внесены в таблицу',
  'документ рассмотрен на заседании учёного совета факультета',
  'материалы размещены в электронной информационно-образовательной среде',
  'проведена сверка с данными отдела кадров и бухгалтерии',
  'подготовлены копии подтверждающих документов',
];
const MINUTES_DECISIONS = [
  'Ответственным подготовить материалы в срок, установленный поручением.',
  'Сводные данные представить в учебно-методическое управление.',
  'Проект документа согласовать с проректором по учебной работе.',
  'Замечания внести в рабочую версию до конца недели.',
  'Следующее совещание провести после получения данных от кафедр.',
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
  if (r < 0.46)
    return rand() < reliability
      ? rand() < 0.3
        ? 'returned_then_done'
        : 'done_on_time'
      : 'done_late';
  if (r < 0.55) return 'in_review';
  if (r < 0.66) return 'in_progress';
  if (r < 0.66 + (1 - reliability) * 0.7) return 'overdue';
  if (r < 0.88) return 'due_soon';
  if (r < 0.95) return 'new_unacknowledged';
  return 'backlog';
}

const PRIORITIES: IssuePriority[] = ['none', 'low', 'medium', 'medium', 'high', 'high', 'urgent'];

/** Refresh-token lifetime (JWT_REFRESH_TTL default): a session lives this long after its last use. */
const SESSION_DAYS = 30;

const DESKTOP_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
];
const MOBILE_AGENTS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
];

// ─── Main ─────────────────────────────────────────────────────────────────────

export interface SeedDemoOptions {
  storage: StorageDriver;
  /** Pin "now" (tests); default — the current time. */
  now?: number;
  /** The presenter's Telegram user id to link to a demo account. */
  telegramId?: string;
  telegramRole?: DemoTelegramRole;
  /** Warnings for the operator (default: none). */
  warn?: (line: string) => void;
}

export interface SeedDemoResult {
  workspaceId: string;
  departments: number;
  people: number;
  projects: number;
  issues: number;
  attachments: number;
  notifications: number;
  audit: number;
  sessions: number;
  /** linked — Telegram linked; taken — that Telegram belongs to another account; off — not asked. */
  telegram: 'linked' | 'taken' | 'off';
}

async function reset(): Promise<void> {
  // Stored files first: deleting the workspace drops their rows (cascade).
  const files = await prisma.attachment.findMany({
    where: { workspace: { slug: SLUG } },
    select: { storage_key: true },
  });
  for (const f of files) await storage.delete(f.storage_key).catch(() => undefined);
  const reports = await prisma.reportRun.findMany({
    where: { workspace: { slug: SLUG }, storage_key: { not: null } },
    select: { storage_key: true },
  });
  for (const r of reports) await storage.delete(r.storage_key!).catch(() => undefined);

  const users = await prisma.user.findMany({
    where: { email: { endsWith: DOMAIN } },
    select: { id: true },
  });
  // A half-answered bot question (no foreign key) must not outlive its user.
  await prisma.telegramPendingInput.deleteMany({
    where: { user_id: { in: users.map((u) => u.id) } },
  });
  await prisma.workspace.deleteMany({ where: { slug: SLUG } });
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
}

interface Activity {
  action: string;
  actor: string;
  when: Date;
  field?: string;
  old_value?: string | null;
  new_value?: string | null;
}

export async function seedDemo(
  client: PrismaClient,
  options: SeedDemoOptions,
): Promise<SeedDemoResult> {
  prisma = client;
  storage = options.storage;
  NOW = options.now ?? Date.now();
  seedState = SEED;
  const warn = options.warn ?? (() => undefined);

  await reset();

  const personByKey = new Map(PEOPLE.map((p) => [p.key, p]));
  const person = (key: string) => personByKey.get(key)!;
  const deptByKey = new Map(DEPARTMENTS.map((d) => [d.key, d]));
  const headOf = (deptKey: string) => PEOPLE.find((p) => p.heads && p.dept === deptKey);
  const joinedDaysAgo = (p: Person) => p.invited ?? 90;

  // People
  const userId = new Map<string, string>();
  for (const p of PEOPLE) {
    const user = await prisma.user.create({
      data: {
        email: emailOf(p),
        email_verified: true,
        is_active: true,
        display_name: fullName(p),
        last_name: p.last,
        first_name: p.first,
        middle_name: p.middle,
        locale: 'ru',
        timezone: TZ,
        created_at: at(-joinedDaysAgo(p)),
      },
    });
    userId.set(p.key, user.id);
  }
  const uid = (key: string) => userId.get(key)!;

  // The presenter's phone: bot messages and buttons for one demo account.
  let telegram: SeedDemoResult['telegram'] = 'off';
  const telegramKey = DEMO_TELEGRAM_ACCOUNTS[options.telegramRole ?? 'dean'];
  if (options.telegramId) {
    const taken = await prisma.authIdentity.findUnique({
      where: {
        provider_provider_user_id: { provider: 'telegram', provider_user_id: options.telegramId },
      },
      select: { user: { select: { display_name: true, email: true } } },
    });
    if (taken) {
      telegram = 'taken';
      warn(
        `Telegram ${options.telegramId} уже привязан к аккаунту «${taken.user.display_name}»` +
          `${taken.user.email ? ` (${taken.user.email})` : ''}, демо-аккаунт не привязан. ` +
          'Отвяжите Telegram в профиле того аккаунта и запустите сид снова.',
      );
    } else {
      await prisma.authIdentity.create({
        data: {
          user_id: uid(telegramKey),
          provider: 'telegram',
          provider_user_id: options.telegramId,
          created_at: at(-80),
        },
      });
      telegram = 'linked';
    }
  }

  // Workspace
  const workspace = await prisma.workspace.create({
    data: {
      name: WS_NAME,
      short_name: 'ГУ',
      slug: SLUG,
      description: 'Демонстрационное пространство: оргструктура, поручения и отчёты.',
      timezone: TZ,
      locale: 'ru',
      owner_id: uid('rector'),
      settings: {
        control: {
          reminder_days: REMINDER_DAYS,
          reminder_hour: REMINDER_HOUR,
          escalation_days: ESCALATION_DAYS,
          require_report: false,
        },
      },
      created_at: at(-90),
    },
  });
  const wsId = workspace.id;

  // Departments (parents first — the array is ordered that way)
  const deptId = new Map<string, string>();
  for (const [i, d] of DEPARTMENTS.entries()) {
    const head = headOf(d.key);
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
  const reliabilityOf = (personKey: string) => deptByKey.get(person(personKey).dept)!.reliability;

  // Members
  await prisma.workspaceMember.createMany({
    data: PEOPLE.map((p) => ({
      workspace_id: wsId,
      user_id: uid(p.key),
      role: p.role,
      department_id: deptId.get(p.dept)!,
      position: p.position,
      created_at: at(-joinedDaysAgo(p) + (p.invited ? 1 : 0)),
    })),
  });

  // ─── Notifications: the same recipients the services would pick ───
  const notifications: Prisma.NotificationCreateManyInput[] = [];
  /**
   * One event → rows for its recipients. The actor never hears about their own
   * action, except reminders (`system`), whose actor is a stand-in (lib/notifications).
   * A recipient who already acted on it (`readAt`: accepted the work, decided on the
   * deadline, acknowledged the assignment) has read it by then; the rest by age.
   */
  function notify(
    type: NotificationType,
    actor: string,
    recipients: string[],
    issueId: string,
    when: Date,
    opts: {
      entity?: string;
      system?: boolean;
      readAt?: Date | ((recipient: string) => Date | undefined);
    } = {},
  ): void {
    const created = cap(when);
    for (const r of new Set(recipients)) {
      if (!opts.system && r === actor) continue;
      const acted = typeof opts.readAt === 'function' ? opts.readAt(r) : opts.readAt;
      const readAt =
        acted && acted.getTime() < NOW
          ? maxDate(acted, created)
          : created.getTime() < NOW - UNREAD_WINDOW
            ? cap(plusDays(created, 0.05 + rand() * 0.9))
            : null;
      notifications.push({
        workspace_id: wsId,
        recipient_id: uid(r),
        actor_id: uid(actor),
        type,
        issue_id: issueId,
        entity_id: opts.entity ?? null,
        is_read: readAt !== null,
        read_at: readAt,
        created_at: created,
      });
    }
  }

  // ─── Files: stored for real, so every attachment opens ───
  let attachmentCount = 0;
  async function upload(
    issueId: string,
    uploader: string,
    fileName: string,
    mime: string,
    data: Buffer,
    when: Date,
    reviewId: string | null,
  ): Promise<Activity> {
    const storageKey = buildStorageKey(wsId, issueId, fileName);
    await storage.put(storageKey, data, mime);
    await prisma.attachment.create({
      data: {
        workspace_id: wsId,
        issue_id: issueId,
        uploaded_by_id: uid(uploader),
        file_name: fileName,
        file_size: data.length,
        mime_type: mime,
        storage_key: storageKey,
        review_id: reviewId,
        created_at: when,
      },
    });
    attachmentCount += 1;
    return { action: 'issue.attachment_added', actor: uploader, when, new_value: fileName };
  }

  const UNITS = DEPARTMENTS.filter((d) => d.parent && d.parent !== 'rector').map((d) => d.name);
  /** The report PDF (and sometimes a summary table) handed in with a review. */
  async function attachReport(r: {
    issueId: string;
    issueKey: string;
    title: string;
    basis: string | null;
    assignee: string;
    controller: string | null;
    due: Date | null;
    reviewId: string;
    submittedAt: Date;
    summary: string;
    draft?: boolean;
    withTable: boolean;
  }): Promise<Activity[]> {
    const p = person(r.assignee);
    const c = r.controller ? person(r.controller) : null;
    const when = new Date(r.submittedAt.getTime() - between(5, 40) * 60_000);
    const pdf = await reportPdf({
      university: WS_NAME,
      issueKey: r.issueKey,
      title: r.title,
      basis: r.basis,
      executor: {
        name: fullName(p),
        short: shortName(p),
        position: lowerFirst(p.position),
        department: deptByKey.get(p.dept)!.name,
      },
      controller: c ? `${fullName(c)}, ${lowerFirst(c.position)}` : null,
      due: r.due ? fmt(r.due) : null,
      date: fmt(r.submittedAt),
      summary: r.summary,
      steps: pickSome(REPORT_STEPS, 3),
      withTable: r.withTable,
      draft: r.draft ?? false,
    });
    const entries = [
      await upload(
        r.issueId,
        r.assignee,
        `Отчёт ${r.issueKey}${r.draft ? ' (первая редакция)' : ''}.pdf`,
        PDF_MIME,
        pdf,
        when,
        r.reviewId,
      ),
    ];
    if (r.withTable) {
      const xlsx = await summaryXlsx({
        title: `Сводная таблица к отчёту ${r.issueKey}`,
        author: fullName(p),
        created: when,
        rows: pickSome(UNITS, between(4, 6)).map((unit) => {
          const plan = between(8, 40);
          return { unit, plan, fact: Math.max(1, Math.round(plan * (0.65 + rand() * 0.35))) };
        }),
      });
      entries.push(
        await upload(
          r.issueId,
          r.assignee,
          `Сводная таблица ${r.issueKey}.xlsx`,
          XLSX_MIME,
          xlsx,
          when,
          r.reviewId,
        ),
      );
    }
    return entries;
  }

  /** Comments (some with @mentions, some with meeting minutes) and their notifications. */
  async function discuss(opts: {
    issueId: string;
    title: string;
    count: number;
    from: Date;
    authors: string[];
    assignee: string;
    reviewer: string;
    watchers: string[];
  }): Promise<Activity[]> {
    const entries: Activity[] = [];
    for (let c = 0; c < opts.count; c++) {
      const author = pick(opts.authors);
      const when = cap(plusDays(opts.from, 0.5 + c * 0.9));
      const target = author === opts.reviewer ? opts.assignee : opts.reviewer;
      const mention = target !== author && rand() < 0.3 ? target : null;
      const body = mention
        ? `@${handleOf(person(mention))} ${pick(author === opts.reviewer ? MENTIONS_TO_ASSIGNEE : MENTIONS_TO_CONTROLLER)}`
        : pick(COMMENTS);
      const comment = await prisma.comment.create({
        data: {
          issue_id: opts.issueId,
          author_id: uid(author),
          body,
          created_at: when,
          updated_at: when,
        },
      });
      entries.push({ action: 'comment.created', actor: author, when, new_value: comment.id });
      if (mention)
        notify('mentioned', author, [mention], opts.issueId, when, { entity: comment.id });
      notify(
        'comment_added',
        author,
        opts.watchers.filter((w) => w !== mention),
        opts.issueId,
        when,
        { entity: comment.id },
      );

      if (body === MINUTES_COMMENT) {
        const chair = person(author);
        const pdf = await minutesPdf({
          university: WS_NAME,
          department: deptByKey.get(chair.dept)!.name,
          number: between(3, 18),
          date: fmt(when),
          chair: fullName(chair),
          chairShort: shortName(chair),
          attendees: opts.watchers.map((w) => shortName(person(w))),
          topic: opts.title,
          decisions: pickSome(MINUTES_DECISIONS, 3),
        });
        const uploaded = new Date(when.getTime() - between(2, 10) * 60_000);
        entries.push(
          await upload(
            opts.issueId,
            author,
            `Протокол совещания от ${fmt(when)}.pdf`,
            PDF_MIME,
            pdf,
            uploaded,
            null,
          ),
        );
      }
    }
    return entries;
  }

  async function writeActivity(issueId: string, activity: Activity[]): Promise<void> {
    await prisma.activityLog.createMany({
      data: activity.map((a) => ({
        workspace_id: wsId,
        issue_id: issueId,
        actor_id: uid(a.actor),
        action: a.action,
        field: a.field ?? null,
        old_value: a.old_value ?? null,
        new_value: a.new_value ?? null,
        created_at: a.when,
      })),
    });
  }

  /** Open, dated work: the reminder scheduler's view, for the reminder history below. */
  const openWork: {
    id: string;
    created: Date;
    due: Date;
    owners: string[];
    controller: string;
    primary: string | null;
  }[] = [];

  let issueCount = 0;
  // Project id and state ids per project key, for the distributions below.
  const projectInfo = new Map<
    string,
    { id: string; identifier: string; stateOf: (g: StateGroup) => string; next: number }
  >();

  const projectIdByKey = new Map<string, string>();
  // Every project issue by its title, with its creation time (Ф4 links below).
  const issueByTitle = new Map<string, { id: string; created: Date }>();
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
    await prisma.state.createMany({
      data: DEFAULT_STATES.map((s) => ({ ...s, project_id: project.id })),
    });
    const states = await prisma.state.findMany({ where: { project_id: project.id } });
    const stateOf = (g: StateGroup) => states.find((s) => s.group === g)!.id;
    projectInfo.set(def.key, {
      id: project.id,
      identifier: def.identifier,
      stateOf,
      next: def.titles.length + 1,
    });

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
      ].map((l) =>
        prisma.label.create({ data: { ...l, workspace_id: wsId, project_id: project.id } }),
      ),
    );

    // Build the issues first so sequence ids follow creation dates.
    const planned = def.titles.map((title, i) => {
      const assignee = def.team[i % def.team.length]!;
      const scenario = scenarioFor(reliabilityOf(assignee), def.status === 'completed');
      const open = !['done_on_time', 'done_late', 'returned_then_done'].includes(scenario);
      const created =
        scenario === 'new_unacknowledged'
          ? at(-between(0, 1), between(9, 17))
          : scenario === 'overdue'
            ? at(-between(10, 28), between(9, 17)) // before its deadline (1–9 days ago)
            : open
              ? at(-between(3, 28), between(9, 17))
              : at(-between(18, 75), between(9, 17));
      return { title, assignee, scenario, created: cap(created) };
    });
    planned.sort((a, b) => a.created.getTime() - b.created.getTime());
    projectIdByKey.set(def.key, project.id);
    const idByTitle = new Map<string, string>();

    for (const [index, plan] of planned.entries()) {
      const { title, assignee, scenario, created } = plan;
      const issueKey = `${def.identifier}-${index + 1}`;
      const isAssignment = rand() < 0.8;
      const controller = isAssignment
        ? (pick(def.controllers.filter((c) => c !== assignee)) ?? def.lead)
        : null;
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
          scenario === 'done_late' ? plusDays(due, between(1, 6)) : plusDays(due, -between(0, 4));
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

      const basis =
        isAssignment && rand() < 0.6
          ? `Протокол заседания ректората №${between(3, 14)} от ${fmt(plusDays(created, -between(1, 5)))}`
          : null;
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
          basis,
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
      idByTitle.set(title, issue.id);
      issueByTitle.set(title, { id: issue.id, created });

      const assignees = [assignee, ...(coAssignee ? [coAssignee] : [])];
      const reviewer = controller ?? creator;
      const watchers = [...new Set([creator, ...assignees, ...(controller ? [controller] : [])])];

      // Assignments are acknowledged within hours (5.B4); plain tasks need no ack.
      const ackAt = new Map<string, Date>();
      if (isAssignment && scenario !== 'new_unacknowledged') {
        for (const a of assignees) ackAt.set(a, cap(plusDays(created, 0.05 + rand() * 0.6)));
      }
      await prisma.issueAssignee.createMany({
        data: assignees.map((a, i) => ({
          issue_id: issue.id,
          user_id: uid(a),
          is_primary: i === 0,
          acknowledged_at: ackAt.get(a) ?? null,
          created_at: created,
        })),
      });
      await prisma.issueWatcher.createMany({
        data: watchers.map((k) => ({ issue_id: issue.id, user_id: uid(k) })),
        skipDuplicates: true,
      });
      if (rand() < 0.55) {
        await prisma.issueLabel.create({ data: { issue_id: issue.id, label_id: pick(labels).id } });
      }

      // History: created → acknowledged → (deadline moved) → hand-ins / decisions → done.
      const activity: Activity[] = [{ action: 'issue.created', actor: creator, when: created }];
      notify('issue_assigned', creator, assignees, issue.id, created, {
        readAt: (a) => ackAt.get(a),
      });
      for (const [a, when] of ackAt) {
        activity.push({ action: 'issue.acknowledged', actor: a, when });
        notify('acknowledged', a, [reviewer], issue.id, when);
      }
      if (group === 'started') {
        const when = cap(plusDays(ackAt.get(assignee) ?? created, 0.2 + rand() * 0.8));
        activity.push({
          action: 'issue.updated',
          actor: assignee,
          when,
          field: 'state_id',
          old_value: stateOf('unstarted'),
          new_value: stateOf('started'),
        });
        notify('state_changed', assignee, watchers, issue.id, when);
      }

      // Decided deadline change requests (≈15%).
      let deadlineAsked = false;
      if (due && isAssignment && rand() < 0.15) {
        const approved = rand() < 0.65;
        const oldDue = plusDays(due, -between(3, 7));
        let requestedAt = plusDays(created, between(2, 5));
        if (completed)
          requestedAt = maxDate(
            minDate(requestedAt, plusDays(completed, -0.6)),
            plusDays(created, 0.1),
          );
        requestedAt = cap(requestedAt);
        const decidedAt = cap(plusDays(requestedAt, 0.5));
        const request = await prisma.deadlineChangeRequest.create({
          data: {
            workspace_id: wsId,
            issue_id: issue.id,
            requested_by_id: uid(assignee),
            old_due_date: approved ? oldDue : due,
            new_due_date: approved ? due : plusDays(due, between(5, 10)),
            reason: pick(DEADLINE_REASONS),
            status: approved ? 'approved' : 'rejected',
            decided_by_id: uid(reviewer),
            decision_comment: approved ? 'Согласовано.' : 'Срок оставляем прежним, это приоритет.',
            created_at: requestedAt,
            decided_at: decidedAt,
          },
        });
        deadlineAsked = true;
        activity.push({
          action: 'issue.deadline_requested',
          actor: assignee,
          when: requestedAt,
          // As the service records it: the deadline asked for, from which date.
          field: 'due_date',
          old_value: request.old_due_date?.toISOString() ?? null,
          new_value: request.new_due_date.toISOString(),
        });
        activity.push({
          action: approved ? 'issue.deadline_approved' : 'issue.deadline_rejected',
          actor: reviewer,
          when: decidedAt,
        });
        notify('deadline_change_requested', assignee, [reviewer], issue.id, requestedAt, {
          entity: request.id,
          readAt: decidedAt,
        });
        notify('deadline_change_decided', reviewer, [assignee], issue.id, decidedAt, {
          entity: request.id,
        });
      }

      const reportCtx = { issueId: issue.id, issueKey, title, basis, assignee, controller, due };
      if (isAssignment && scenario === 'returned_then_done' && completed) {
        const firstSubmit = cap(
          maxDate(plusDays(completed, -between(2, 4)), plusDays(created, 0.2)),
        );
        const returnedAt = cap(plusDays(firstSubmit, 0.4));
        const review = await prisma.issueReview.create({
          data: {
            workspace_id: wsId,
            issue_id: issue.id,
            submitted_by_id: uid(assignee),
            report: 'Направляю первую редакцию отчёта.',
            decision: 'returned',
            decided_by_id: uid(reviewer),
            decision_comment: pick(RETURN_REASONS),
            submitted_at: firstSubmit,
            decided_at: returnedAt,
          },
        });
        if (rand() < 0.8) {
          activity.push(
            ...(await attachReport({
              ...reportCtx,
              reviewId: review.id,
              submittedAt: firstSubmit,
              summary: `Направляю первую редакцию отчёта по поручению «${title}».`,
              draft: true,
              withTable: false,
            })),
          );
        }
        activity.push({ action: 'issue.review_submitted', actor: assignee, when: firstSubmit });
        activity.push({ action: 'issue.review_returned', actor: reviewer, when: returnedAt });
        notify('review_requested', assignee, [reviewer], issue.id, firstSubmit, {
          entity: review.id,
          readAt: returnedAt,
        });
        notify('review_returned', reviewer, assignees, issue.id, returnedAt, { entity: review.id });
      }
      if (isAssignment && completed) {
        const submit = plusDays(completed, -0.3);
        const review = await prisma.issueReview.create({
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
        if (rand() < 0.75) {
          activity.push(
            ...(await attachReport({
              ...reportCtx,
              reviewId: review.id,
              submittedAt: submit,
              summary: `Поручение «${title}» исполнено в полном объёме, подтверждающие документы приложены.`,
              withTable: rand() < 0.4,
            })),
          );
        }
        activity.push({ action: 'issue.review_submitted', actor: assignee, when: submit });
        activity.push({ action: 'issue.review_approved', actor: reviewer, when: completed });
        notify('review_requested', assignee, [reviewer], issue.id, submit, {
          entity: review.id,
          readAt: completed,
        });
        notify('review_approved', reviewer, assignees, issue.id, completed, { entity: review.id });
      }
      if (isAssignment && scenario === 'in_review') {
        const submit = cap(maxDate(at(-between(0, 2), between(9, 17)), plusDays(created, 0.3)));
        const review = await prisma.issueReview.create({
          data: {
            workspace_id: wsId,
            issue_id: issue.id,
            submitted_by_id: uid(assignee),
            report: 'Отчёт подготовлен, прошу проверить.',
            submitted_at: submit,
          },
        });
        if (rand() < 0.85) {
          activity.push(
            ...(await attachReport({
              ...reportCtx,
              reviewId: review.id,
              submittedAt: submit,
              summary: `Отчёт по поручению «${title}» подготовлен и направляется на проверку.`,
              withTable: rand() < 0.4,
            })),
          );
        }
        activity.push({ action: 'issue.review_submitted', actor: assignee, when: submit });
        notify('review_requested', assignee, [reviewer], issue.id, submit, { entity: review.id });
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

      // Pending deadline requests: something for the controller to decide on stage.
      if (
        isAssignment &&
        due &&
        !deadlineAsked &&
        ['in_progress', 'due_soon', 'overdue'].includes(scenario) &&
        rand() < 0.22
      ) {
        const requestedAt = cap(
          maxDate(new Date(NOW - between(2, 30) * 3_600_000), plusDays(created, 0.3)),
        );
        const request = await prisma.deadlineChangeRequest.create({
          data: {
            workspace_id: wsId,
            issue_id: issue.id,
            requested_by_id: uid(assignee),
            old_due_date: due,
            // Asking for a date that is still ahead, even when already late.
            new_due_date: maxDate(plusDays(due, between(5, 10)), at(between(3, 7), 18)),
            reason: pick(DEADLINE_REASONS),
            created_at: requestedAt,
          },
        });
        activity.push({
          action: 'issue.deadline_requested',
          actor: assignee,
          when: requestedAt,
          // As the service records it: the deadline asked for, from which date.
          field: 'due_date',
          old_value: request.old_due_date?.toISOString() ?? null,
          new_value: request.new_due_date.toISOString(),
        });
        notify('deadline_change_requested', assignee, [reviewer], issue.id, requestedAt, {
          entity: request.id,
        });
      }

      activity.push(
        ...(await discuss({
          issueId: issue.id,
          title,
          count: done ? between(0, 2) : between(0, 3),
          from: created,
          authors: [...assignees, reviewer],
          assignee,
          reviewer,
          watchers,
        })),
      );
      await writeActivity(issue.id, activity);

      if (!done && due) {
        openWork.push({
          id: issue.id,
          created,
          due,
          owners: assignees,
          controller: reviewer,
          primary: assignee,
        });
      }
    }

    // Each link with its mirror, as POST I/relations stores them.
    const links = (DEPENDENCIES[def.key] ?? []).flatMap(([blocker, blocked]) => {
      const a = idByTitle.get(blocker);
      const b = idByTitle.get(blocked);
      if (!a || !b) throw new Error(`Demo dependency not found: ${blocker} → ${blocked}`);
      return [
        { issue_id: a, related_issue_id: b, relation_type: 'blocks' as const },
        { issue_id: b, related_issue_id: a, relation_type: 'blocked_by' as const },
      ];
    });
    if (links.length > 0) await prisma.issueLink.createMany({ data: links });
    // Recorded on both issues, as POST I/relations does (4.F6): the project lead
    // linked them once the later of the two existed.
    for (const [blocker, blocked] of DEPENDENCIES[def.key] ?? []) {
      const a = issueByTitle.get(blocker)!;
      const b = issueByTitle.get(blocked)!;
      const when = cap(
        new Date(Math.max(a.created.getTime(), b.created.getTime()) + 2 * 3_600_000),
      );
      const entry = { action: 'issue.relation_added', actor: def.lead, when };
      await writeActivity(a.id, [{ ...entry, field: 'blocks', new_value: b.id }]);
      await writeActivity(b.id, [{ ...entry, field: 'blocked_by', new_value: a.id }]);
    }
  }

  // ─── Рассылки подразделениям (6.B1) ───
  // One accreditation report sent to six units: four done (one late), one under
  // review, one overdue and asking to move the deadline — «4 из 6 исполнено»; and a
  // fresh one the deans have not acknowledged yet.
  type ChildPlan = { dept: string; outcome: 'on_time' | 'late' | 'review' | 'overdue' | 'new' };
  async function distribution(opts: {
    project: string;
    title: string;
    basis: string;
    creator: string;
    controller: string;
    created: Date;
    due: Date;
    children: ChildPlan[];
  }): Promise<void> {
    const info = projectInfo.get(opts.project)!;
    const created = cap(opts.created);
    const parent = await prisma.issue.create({
      data: {
        workspace_id: wsId,
        project_id: info.id,
        sequence_id: info.next++,
        title: opts.title,
        description: 'Рассылка подразделениям: каждое готовит свой раздел и сдаёт его на проверку.',
        state_id: info.stateOf('started'),
        priority: 'high',
        kind: 'assignment',
        controller_id: uid(opts.controller),
        requires_review: true,
        basis: opts.basis,
        is_distribution: true,
        start_date: created,
        due_date: opts.due,
        created_by_id: uid(opts.creator),
        created_at: created,
        updated_at: created,
      },
    });
    issueCount += 1;
    await prisma.issueWatcher.createMany({
      data: [opts.creator, opts.controller].map((k) => ({ issue_id: parent.id, user_id: uid(k) })),
      skipDuplicates: true,
    });
    await writeActivity(parent.id, [
      { action: 'issue.created', actor: opts.creator, when: created },
    ]);
    openWork.push({
      id: parent.id,
      created,
      due: opts.due,
      owners: [opts.creator],
      controller: opts.controller,
      primary: null,
    });

    for (const plan of opts.children) {
      const dept = deptByKey.get(plan.dept)!;
      const head = headOf(plan.dept)!;
      const done = plan.outcome === 'on_time' || plan.outcome === 'late';
      const completed =
        plan.outcome === 'on_time'
          ? plusDays(opts.due, -between(1, 3))
          : plan.outcome === 'late'
            ? plusDays(opts.due, 1)
            : null;
      const group: StateGroup = done
        ? 'completed'
        : plan.outcome === 'review'
          ? 'review'
          : plan.outcome === 'new'
            ? 'unstarted'
            : 'started';
      const sequence = info.next++;
      const child = await prisma.issue.create({
        data: {
          workspace_id: wsId,
          project_id: info.id,
          sequence_id: sequence,
          title: `${opts.title} — ${dept.short ?? dept.name}`,
          description: parent.description,
          state_id: info.stateOf(group),
          priority: 'high',
          kind: 'assignment',
          controller_id: uid(opts.controller),
          requires_review: true,
          basis: opts.basis,
          parent_id: parent.id,
          department_id: deptId.get(plan.dept)!,
          start_date: created,
          due_date: opts.due,
          completed_at: completed,
          created_by_id: uid(opts.creator),
          created_at: created,
          updated_at: completed ?? created,
        },
      });
      issueCount += 1;
      const ackAt = plan.outcome === 'new' ? null : cap(plusDays(created, 0.2 + rand() * 0.5));
      await prisma.issueAssignee.create({
        data: {
          issue_id: child.id,
          user_id: uid(head.key),
          is_primary: true,
          acknowledged_at: ackAt,
          created_at: created,
        },
      });
      const watchers = [...new Set([opts.creator, opts.controller, head.key])];
      await prisma.issueWatcher.createMany({
        data: watchers.map((k) => ({ issue_id: child.id, user_id: uid(k) })),
        skipDuplicates: true,
      });
      const activity: Activity[] = [
        { action: 'issue.created', actor: opts.creator, when: created },
      ];
      notify('issue_assigned', opts.creator, [head.key], child.id, created, {
        readAt: ackAt ?? undefined,
      });
      if (ackAt) {
        activity.push({ action: 'issue.acknowledged', actor: head.key, when: ackAt });
        notify('acknowledged', head.key, [opts.controller], child.id, ackAt);
      }
      const reportCtx = {
        issueId: child.id,
        issueKey: `${info.identifier}-${sequence}`,
        title: child.title,
        basis: opts.basis,
        assignee: head.key,
        controller: opts.controller,
        due: opts.due,
      };
      if (done && completed) {
        const submit = plusDays(completed, -0.3);
        const review = await prisma.issueReview.create({
          data: {
            workspace_id: wsId,
            issue_id: child.id,
            submitted_by_id: uid(head.key),
            report: 'Раздел отчёта подготовлен, документы приложены.',
            decision: 'approved',
            decided_by_id: uid(opts.controller),
            submitted_at: submit,
            decided_at: completed,
          },
        });
        activity.push(
          ...(await attachReport({
            ...reportCtx,
            reviewId: review.id,
            submittedAt: submit,
            summary: `Раздел «${dept.name}» подготовлен, подтверждающие документы приложены.`,
            withTable: rand() < 0.6,
          })),
        );
        activity.push({ action: 'issue.review_submitted', actor: head.key, when: submit });
        activity.push({ action: 'issue.review_approved', actor: opts.controller, when: completed });
        activity.push({
          action: 'issue.updated',
          actor: opts.controller,
          when: completed,
          field: 'state_id',
          new_value: info.stateOf('completed'),
        });
        notify('review_requested', head.key, [opts.controller], child.id, submit, {
          entity: review.id,
          readAt: completed,
        });
        notify('review_approved', opts.controller, [head.key], child.id, completed, {
          entity: review.id,
        });
      }
      if (plan.outcome === 'review') {
        const submit = cap(maxDate(at(0, 9), plusDays(created, 1)));
        const review = await prisma.issueReview.create({
          data: {
            workspace_id: wsId,
            issue_id: child.id,
            submitted_by_id: uid(head.key),
            report: 'Направляю раздел о кадровом и материально-техническом обеспечении.',
            submitted_at: submit,
          },
        });
        activity.push(
          ...(await attachReport({
            ...reportCtx,
            reviewId: review.id,
            submittedAt: submit,
            summary: 'Направляю раздел о кадровом и материально-техническом обеспечении.',
            withTable: true,
          })),
        );
        activity.push({ action: 'issue.review_submitted', actor: head.key, when: submit });
        notify('review_requested', head.key, [opts.controller], child.id, submit, {
          entity: review.id,
        });
      }
      if (plan.outcome === 'overdue') {
        // Late, and asking for a week more — the controller decides during the demo.
        const requestedAt = cap(at(-1, 15));
        const request = await prisma.deadlineChangeRequest.create({
          data: {
            workspace_id: wsId,
            issue_id: child.id,
            requested_by_id: uid(head.key),
            old_due_date: opts.due,
            new_due_date: at(5, 18),
            reason: 'На факультете идёт сессия, данные кафедр будут собраны к концу недели.',
            created_at: requestedAt,
          },
        });
        activity.push({
          action: 'issue.deadline_requested',
          actor: head.key,
          when: requestedAt,
          // As the service records it: the deadline asked for, from which date.
          field: 'due_date',
          old_value: request.old_due_date?.toISOString() ?? null,
          new_value: request.new_due_date.toISOString(),
        });
        notify('deadline_change_requested', head.key, [opts.controller], child.id, requestedAt, {
          entity: request.id,
        });
      }
      await writeActivity(child.id, activity);
      if (!done) {
        openWork.push({
          id: child.id,
          created,
          due: opts.due,
          owners: [head.key],
          controller: opts.controller,
          primary: head.key,
        });
      }
    }
  }

  await distribution({
    project: 'accr',
    title: 'Подготовить раздел отчёта о самообследовании',
    basis: 'Приказ ректора №214 о подготовке к аккредитации',
    creator: 'pr_edu',
    controller: 'pr_edu',
    created: at(-16, 10),
    due: at(-2, 18),
    children: [
      { dept: 'econ', outcome: 'on_time' },
      { dept: 'itf', outcome: 'on_time' },
      { dept: 'umu', outcome: 'on_time' },
      { dept: 'grad', outcome: 'late' },
      { dept: 'it', outcome: 'review' },
      { dept: 'phil', outcome: 'overdue' },
    ],
  });
  await distribution({
    project: 'adm',
    title: 'Предоставить сведения о трудоустройстве выпускников 2026 года',
    basis: 'Протокол заседания ректората №15',
    creator: 'rector',
    controller: 'rector',
    created: at(-1, 11),
    due: at(9, 18),
    children: [
      { dept: 'econ', outcome: 'new' },
      { dept: 'itf', outcome: 'new' },
      { dept: 'phil', outcome: 'new' },
    ],
  });

  // A duplicate created by mistake and deleted (soft delete, as the API does) —
  // the «Удаления» filter of the audit log has something to show.
  const adm = projectInfo.get('adm')!;
  const duplicateDeleted = cap(at(-20, 12));
  const duplicate = await prisma.issue.create({
    data: {
      workspace_id: wsId,
      project_id: adm.id,
      sequence_id: adm.next++,
      title: 'Подготовить буклеты по направлениям подготовки (дубль)',
      state_id: adm.stateOf('unstarted'),
      priority: 'medium',
      kind: 'task',
      created_by_id: uid('umu'),
      created_at: plusDays(duplicateDeleted, -0.2),
      updated_at: duplicateDeleted,
      deleted_at: duplicateDeleted,
      deleted_by_id: uid('pr_edu'),
    },
  });

  // ─── Чек-листы, шаблоны, повторяющиеся задачи (Ф6, ADR-030) ───
  // The accreditation readiness checklist (3 of 7 ticked), checklists on two more
  // accreditation tasks, two templates, and two recurring rules with the issues they
  // have already created — the monthly attendance report and the weekly admissions
  // summary — so the settings show «создано задач: 3» and the next run.
  const accrInfo = projectInfo.get('accr')!;
  async function checklist(
    issueId: string,
    items: { text: string; doneBy?: string; doneAt?: Date }[],
  ): Promise<void> {
    await prisma.issueChecklistItem.createMany({
      data: items.map((item, order) => ({
        issue_id: issueId,
        text: item.text,
        order,
        is_done: Boolean(item.doneBy),
        done_by_id: item.doneBy ? uid(item.doneBy) : null,
        done_at: item.doneAt ? cap(item.doneAt) : null,
      })),
    });
    await prisma.issue.update({
      where: { id: issueId },
      data: {
        checklist_total: items.length,
        checklist_done: items.filter((i) => i.doneBy).length,
      },
    });
    await writeActivity(
      issueId,
      items
        .filter((i) => i.doneBy)
        .map((i) => ({
          action: 'issue.checklist_checked',
          actor: i.doneBy!,
          when: cap(i.doneAt!),
          field: 'checklist',
          new_value: i.text,
        })),
    );
  }

  const readinessCreated = cap(at(-12, 9));
  const readiness = await prisma.issue.create({
    data: {
      workspace_id: wsId,
      project_id: accrInfo.id,
      sequence_id: accrInfo.next++,
      title: 'Чек-лист готовности к аккредитационной экспертизе',
      description:
        'Пункты, без которых экспертиза не начнётся. Отмечайте по мере готовности — прогресс виден на доске.',
      state_id: accrInfo.stateOf('started'),
      priority: 'urgent',
      kind: 'assignment',
      controller_id: uid('pr_edu'),
      requires_review: true,
      basis: 'Приказ ректора №214 о подготовке к аккредитации',
      start_date: readinessCreated,
      due_date: at(18, 18),
      created_by_id: uid('pr_edu'),
      created_at: readinessCreated,
      updated_at: cap(at(-1, 15)),
    },
  });
  issueCount += 1;
  await prisma.issueAssignee.createMany({
    data: [
      {
        issue_id: readiness.id,
        user_id: uid('umu'),
        is_primary: true,
        acknowledged_at: cap(at(-12, 11)),
        created_at: readinessCreated,
      },
      {
        issue_id: readiness.id,
        user_id: uid('umu_spec'),
        is_primary: false,
        acknowledged_at: cap(at(-11, 10)),
        created_at: readinessCreated,
      },
    ],
  });
  await prisma.issueWatcher.createMany({
    data: ['pr_edu', 'umu', 'umu_spec'].map((k) => ({ issue_id: readiness.id, user_id: uid(k) })),
    skipDuplicates: true,
  });
  await writeActivity(readiness.id, [
    { action: 'issue.created', actor: 'pr_edu', when: readinessCreated },
  ]);
  notify('issue_assigned', 'pr_edu', ['umu', 'umu_spec'], readiness.id, readinessCreated);
  await checklist(readiness.id, [
    {
      text: 'Отчёт о самообследовании утверждён учёным советом',
      doneBy: 'umu',
      doneAt: at(-9, 16),
    },
    {
      text: 'Рабочие программы всех дисциплин размещены на сайте',
      doneBy: 'umu_spec',
      doneAt: at(-6, 12),
    },
    { text: 'Кадровая справка по программам подписана', doneBy: 'umu', doneAt: at(-2, 11) },
    { text: 'Фонды оценочных средств обновлены' },
    { text: 'Справка о материально-техническом обеспечении' },
    { text: 'Отзывы работодателей собраны по всем программам' },
    { text: 'Раздел «Сведения об образовательной организации» проверен' },
  ]);
  openWork.push({
    id: readiness.id,
    created: readinessCreated,
    due: at(18, 18),
    owners: ['umu', 'umu_spec'],
    controller: 'pr_edu',
    primary: 'umu',
  });

  // Two open accreditation tasks get their steps too: «2/4» and «1/3» on the board.
  const accrOpen = await prisma.issue.findMany({
    where: {
      project_id: accrInfo.id,
      parent_id: null,
      is_distribution: false,
      id: { not: readiness.id },
      state: { group: { in: ['unstarted', 'started'] } },
      deleted_at: null,
    },
    orderBy: { sequence_id: 'asc' },
    take: 2,
    include: { assignees: { where: { is_primary: true } } },
  });
  const steps = [
    [
      'Собрать исходные данные кафедр',
      'Свести таблицу показателей',
      'Согласовать с УМУ',
      'Подписать у декана',
    ],
    ['Проверить перечень документов', 'Загрузить файлы в систему', 'Передать на проверку'],
  ];
  for (const [n, issue] of accrOpen.entries()) {
    const owner = PEOPLE.find((p) => uid(p.key) === issue.assignees[0]?.user_id)?.key ?? 'umu';
    await checklist(
      issue.id,
      steps[n]!.map((text, i) =>
        i < 2 - n ? { text, doneBy: owner, doneAt: at(-5 + i, 14) } : { text },
      ),
    );
  }

  // Templates: one for the whole university, one of the accreditation project.
  await prisma.issueTemplate.createMany({
    data: [
      {
        workspace_id: wsId,
        created_by_id: uid('rector'),
        name: 'Отчёт подразделения к заседанию ректората',
        data: {
          title: 'Подготовить отчёт подразделения к заседанию ректората',
          description:
            'Кратко: что сделано за период, что не выполнено и почему, что нужно от ректората.',
          kind: 'assignment',
          priority: 'high',
          controller_id: uid('rector'),
          requires_review: true,
          basis: 'План заседаний ректората',
          checklist: [
            'Собрать показатели подразделения за период',
            'Подготовить справку на 1–2 страницы',
            'Согласовать с курирующим проректором',
          ],
        },
        due_in_days: 7,
        created_at: at(-30),
      },
      {
        workspace_id: wsId,
        project_id: accrInfo.id,
        created_by_id: uid('pr_edu'),
        name: 'Раздел отчёта о самообследовании',
        data: {
          title: 'Подготовить раздел отчёта о самообследовании',
          kind: 'assignment',
          priority: 'high',
          controller_id: uid('pr_edu'),
          requires_review: true,
          basis: 'Приказ ректора №214 о подготовке к аккредитации',
          checklist: [
            'Описание образовательной деятельности',
            'Кадровое обеспечение',
            'Учебно-методическое обеспечение',
            'Материально-техническая база',
          ],
        },
        due_in_days: 14,
        created_at: at(-25),
      },
    ],
  });

  // Recurring rules, with the issues their past runs created.
  async function recurring(opts: {
    project: string;
    author: string;
    title: string;
    description: string;
    assignee: string;
    controller: string;
    checklist: string[];
    dueInDays: number;
    schedule: Omit<Schedule, 'start_date' | 'until'>;
    startDaysAgo: number;
  }): Promise<void> {
    const info = projectInfo.get(opts.project)!;
    const schedule: Schedule = {
      ...opts.schedule,
      start_date: day(at(-opts.startDaysAgo)),
      until: null,
    };
    const rule = await prisma.recurringRule.create({
      data: {
        workspace_id: wsId,
        project_id: info.id,
        created_by_id: uid(opts.author),
        data: {
          title: opts.title,
          description: opts.description,
          kind: 'assignment',
          priority: 'medium',
          assignee_ids: [uid(opts.assignee)],
          controller_id: uid(opts.controller),
          requires_review: true,
          checklist: opts.checklist,
        },
        due_in_days: opts.dueInDays,
        ...schedule,
        next_run_at: nextRunAfter(schedule, TZ, new Date(NOW)),
        // Not before the workspace itself (90 days ago).
        created_at: cap(at(-Math.min(opts.startDaysAgo + 2, 88), 15)),
      },
    });
    // Every run so far, as the scheduler made it.
    const runs: Date[] = [];
    for (let d = occurrenceOnOrAfter(schedule, schedule.start_date); d; ) {
      const run = zonedTime(d, schedule.time, TZ);
      if (run.getTime() > NOW) break;
      runs.push(run);
      d = occurrenceOnOrAfter(schedule, addDays(d, 1));
    }
    for (const run of runs) {
      const created = new Date(run.getTime() + between(1, 4) * 60_000);
      const due = new Date(`${addDays(day(run), opts.dueInDays)}T12:00:00.000Z`);
      const open = due.getTime() > NOW;
      const completed = open
        ? null
        : cap(plusDays(created, Math.max(0.5, opts.dueInDays - 1 - rand())));
      const issue = await prisma.issue.create({
        data: {
          workspace_id: wsId,
          project_id: info.id,
          sequence_id: info.next++,
          title: opts.title,
          description: opts.description,
          state_id: info.stateOf(open ? 'started' : 'completed'),
          priority: 'medium',
          kind: 'assignment',
          controller_id: uid(opts.controller),
          requires_review: true,
          recurring_rule_id: rule.id,
          due_date: due,
          completed_at: completed,
          created_by_id: uid(opts.author),
          created_at: created,
          updated_at: completed ?? created,
        },
      });
      issueCount += 1;
      await prisma.issueAssignee.create({
        data: {
          issue_id: issue.id,
          user_id: uid(opts.assignee),
          is_primary: true,
          acknowledged_at: cap(plusDays(created, 0.1)),
          created_at: created,
        },
      });
      await prisma.issueWatcher.createMany({
        data: [...new Set([opts.author, opts.assignee, opts.controller])].map((k) => ({
          issue_id: issue.id,
          user_id: uid(k),
        })),
        skipDuplicates: true,
      });
      notify('issue_assigned', opts.author, [opts.assignee], issue.id, created);
      const activity: Activity[] = [{ action: 'issue.created', actor: opts.author, when: created }];
      if (completed) {
        activity.push({
          action: 'issue.updated',
          actor: opts.controller,
          when: completed,
          field: 'state_id',
          old_value: info.stateOf('started'),
          new_value: info.stateOf('completed'),
        });
      }
      await writeActivity(issue.id, activity);
      await checklist(
        issue.id,
        opts.checklist.map((text, i) =>
          completed || i === 0
            ? {
                text,
                doneBy: opts.assignee,
                doneAt: new Date(created.getTime() + (i + 1) * 3_600_000),
              }
            : { text },
        ),
      );
      if (open) {
        openWork.push({
          id: issue.id,
          created,
          due,
          owners: [opts.assignee],
          controller: opts.controller,
          primary: opts.assignee,
        });
      }
    }
  }

  await recurring({
    project: 'year',
    author: 'umu',
    title: 'Ежемесячный отчёт о посещаемости занятий',
    description: 'Посещаемость по группам за прошедший месяц: пропуски, причины, меры.',
    assignee: 'umu_spec',
    controller: 'umu',
    checklist: [
      'Собрать данные из журналов групп',
      'Свести таблицу по факультетам',
      'Отметить группы с пропусками больше 20%',
    ],
    dueInDays: 5,
    schedule: {
      frequency: 'monthly',
      interval: 1,
      by_weekday: [],
      by_monthday: 1,
      by_month: null,
      time: '09:00',
    },
    startDaysAgo: 100,
  });
  await recurring({
    project: 'adm',
    author: 'pr_edu',
    title: 'Сводка по приёмной кампании за неделю',
    description: 'Заявления, зачисленные, звонки и обращения за неделю — к планёрке проректора.',
    assignee: 'umu',
    controller: 'pr_edu',
    checklist: [
      'Выгрузить статистику заявлений',
      'Сравнить с прошлым годом',
      'Отправить проректору',
    ],
    dueInDays: 4,
    schedule: {
      frequency: 'weekly',
      interval: 1,
      by_weekday: [1],
      by_monthday: null,
      by_month: null,
      time: '08:30',
    },
    startDaysAgo: 20,
  });

  // ─── Этапы, модули, подзадачи, связи, ветки обсуждения (Ф4, ADR-031) ───
  // Accreditation in three stages (August documents — done, the self-evaluation —
  // now, the experts' visit — ahead), three modules with their leads, the
  // presentation for the experts split into sub-issues (1 of 3 done), a link to
  // the digitalization project and a discussion with replies, a mention and an
  // edit — so the card shows «Этап», «Модули», «Подзадачи», «Связи», «изменено».
  const accrIssue = (title: string) => {
    const found = issueByTitle.get(title);
    if (!found) throw new Error(`Demo issue not found: ${title}`);
    return found;
  };
  const READINESS = 'Чек-лист готовности к аккредитационной экспертизе';
  issueByTitle.set(READINESS, { id: readiness.id, created: readinessCreated });

  const CYCLES: {
    name: string;
    description: string;
    start: number;
    end: number;
    titles: string[];
  }[] = [
    {
      name: 'Сбор документов',
      description: 'Рабочие программы и учебные планы в актуальной редакции.',
      start: -80,
      end: -50,
      titles: [
        'Актуализировать рабочие программы дисциплин',
        'Проверить соответствие учебных планов стандарту',
      ],
    },
    {
      name: 'Самообследование',
      description: 'Отчёт о самообследовании и всё, что в него входит.',
      start: -49,
      end: 12,
      titles: [
        'Подготовить отчёт о самообследовании факультета',
        'Собрать сведения о кадровом обеспечении программ',
        'Заполнить мониторинг эффективности программы',
        'Провести внутренний аудит образовательной программы',
        'Подготовить справку о материально-техническом обеспечении',
        'Обновить фонды оценочных средств',
        READINESS,
      ],
    },
    {
      name: 'Визит экспертной комиссии',
      description: 'Встреча экспертов: расписание, презентация, проверка ЭИОС.',
      start: 13,
      end: 45,
      titles: [
        'Подготовить презентацию для экспертной комиссии',
        'Согласовать расписание визита экспертов',
        'Проверить электронную информационно-образовательную среду',
        'Сформировать портфолио достижений студентов',
        'Подготовить отзывы работодателей по программам',
      ],
    },
  ];
  for (const c of CYCLES) {
    const createdAt = cap(at(Math.min(c.start, -1) - 2, 10));
    const cycle = await prisma.cycle.create({
      data: {
        workspace_id: wsId,
        project_id: accrInfo.id,
        name: c.name,
        description: c.description,
        start_date: at(c.start, 9),
        end_date: at(c.end, 18),
        created_at: createdAt,
        updated_at: createdAt,
      },
    });
    for (const title of c.titles) {
      const issue = accrIssue(title);
      await prisma.issue.update({ where: { id: issue.id }, data: { cycle_id: cycle.id } });
      const when = cap(
        new Date(Math.max(issue.created.getTime(), createdAt.getTime()) + 3_600_000),
      );
      await writeActivity(issue.id, [
        { action: 'issue.updated', actor: 'pr_edu', when, field: 'cycle_id', new_value: cycle.id },
      ]);
    }
  }

  const MODULES: {
    name: string;
    description: string;
    status: 'backlog' | 'in_progress' | 'paused' | 'completed' | 'cancelled';
    lead: string;
    start: number;
    target: number;
    titles: string[];
  }[] = [
    {
      name: 'Отчёт о самообследовании',
      description: 'Разделы отчёта, справки и мониторинг — всё, что войдёт в отчёт.',
      status: 'in_progress',
      lead: 'umu',
      start: -49,
      target: 12,
      titles: [
        'Подготовить отчёт о самообследовании факультета',
        'Заполнить мониторинг эффективности программы',
        'Подготовить справку о материально-техническом обеспечении',
        READINESS,
      ],
    },
    {
      name: 'Кадровое обеспечение',
      description: 'Сведения о преподавателях, повышение квалификации, отзывы работодателей.',
      status: 'in_progress',
      lead: 'dean_econ',
      start: -40,
      target: 20,
      titles: [
        'Собрать сведения о кадровом обеспечении программ',
        'Подготовить отзывы работодателей по программам',
      ],
    },
    {
      name: 'Встреча экспертов',
      description: 'Всё к приезду комиссии: программа визита, презентация, сайт и ЭИОС.',
      status: 'backlog',
      lead: 'pr_edu',
      start: 13,
      target: 45,
      titles: [
        'Подготовить презентацию для экспертной комиссии',
        'Согласовать расписание визита экспертов',
        'Проверить электронную информационно-образовательную среду',
      ],
    },
  ];
  for (const m of MODULES) {
    const createdAt = cap(at(Math.min(m.start, -1) - 1, 11));
    const mod = await prisma.module.create({
      data: {
        workspace_id: wsId,
        project_id: accrInfo.id,
        name: m.name,
        description: m.description,
        status: m.status,
        lead_id: uid(m.lead),
        start_date: at(m.start, 9),
        target_date: at(m.target, 18),
        created_at: createdAt,
        updated_at: createdAt,
      },
    });
    for (const title of m.titles) {
      const issue = accrIssue(title);
      const when = cap(
        new Date(Math.max(issue.created.getTime(), createdAt.getTime()) + 2 * 3_600_000),
      );
      await prisma.moduleIssue.create({
        data: { module_id: mod.id, issue_id: issue.id, created_at: when },
      });
      await writeActivity(issue.id, [
        { action: 'issue.module_added', actor: m.lead, when, new_value: mod.id },
      ]);
    }
  }

  // The presentation for the experts, split into sub-issues (4.F7).
  const presentation = accrIssue('Подготовить презентацию для экспертной комиссии');
  const SUBTASKS: { title: string; assignee: string; group: StateGroup; due: number }[] = [
    {
      title: 'Слайды о кадровом составе программ',
      assignee: 'dean_econ',
      group: 'completed',
      due: 6,
    },
    {
      title: 'Слайды о материально-технической базе',
      assignee: 'umu_spec',
      group: 'started',
      due: 9,
    },
    {
      title: 'Репетиция выступления перед ректоратом',
      assignee: 'umu',
      group: 'unstarted',
      due: 12,
    },
  ];
  for (const [i, sub] of SUBTASKS.entries()) {
    const created = cap(new Date(presentation.created.getTime() + (i + 1) * 3_600_000));
    const completed = sub.group === 'completed' ? cap(at(-1, 16)) : null;
    const child = await prisma.issue.create({
      data: {
        workspace_id: wsId,
        project_id: accrInfo.id,
        sequence_id: accrInfo.next++,
        title: sub.title,
        state_id: accrInfo.stateOf(sub.group),
        priority: 'medium',
        parent_id: presentation.id,
        due_date: at(sub.due, 18),
        completed_at: completed,
        created_by_id: uid('pr_edu'),
        created_at: created,
        updated_at: completed ?? created,
      },
    });
    issueCount += 1;
    await prisma.issueAssignee.create({
      data: {
        issue_id: child.id,
        user_id: uid(sub.assignee),
        is_primary: true,
        created_at: created,
      },
    });
    await writeActivity(child.id, [
      { action: 'issue.created', actor: 'pr_edu', when: created },
      {
        action: 'issue.assignee_added',
        actor: 'pr_edu',
        when: created,
        new_value: uid(sub.assignee),
      },
      ...(completed
        ? [
            {
              action: 'issue.updated',
              actor: sub.assignee,
              when: completed,
              field: 'state_id',
              new_value: accrInfo.stateOf('completed'),
            },
          ]
        : []),
    ]);
    notify('issue_assigned', 'pr_edu', [sub.assignee], child.id, created);
  }

  // Across projects: the e-learning check relates to the schedule integration.
  const eios = accrIssue('Проверить электронную информационно-образовательную среду');
  const schedule = issueByTitle.get('Интегрировать расписание с личным кабинетом студента')!;
  await prisma.issueLink.createMany({
    data: [
      { issue_id: eios.id, related_issue_id: schedule.id, relation_type: 'relates_to' },
      { issue_id: schedule.id, related_issue_id: eios.id, relation_type: 'relates_to' },
    ],
  });
  const linkedAt = cap(
    new Date(Math.max(eios.created.getTime(), schedule.created.getTime()) + 3_600_000),
  );
  await writeActivity(eios.id, [
    {
      action: 'issue.relation_added',
      actor: 'pr_edu',
      when: linkedAt,
      field: 'relates_to',
      new_value: schedule.id,
    },
  ]);
  await writeActivity(schedule.id, [
    {
      action: 'issue.relation_added',
      actor: 'pr_edu',
      when: linkedAt,
      field: 'relates_to',
      new_value: eios.id,
    },
  ]);

  // A discussion on the readiness checklist: a mention, two replies, an edit.
  const askedAt = cap(at(-2, 11));
  const ask = await prisma.comment.create({
    data: {
      issue_id: readiness.id,
      author_id: uid('pr_edu'),
      body: `@${handleOf(person('umu'))} эксперты начнут с ЭИОС и раздела «Сведения об образовательной организации». Что осталось сделать?`,
      created_at: askedAt,
      updated_at: askedAt,
    },
  });
  const answeredAt = cap(at(-2, 15));
  const answer = await prisma.comment.create({
    data: {
      issue_id: readiness.id,
      author_id: uid('umu'),
      parent_comment_id: ask.id,
      body: 'Осталось обновить раздел на сайте. **Срок — пятница**, сделает Носирова Д. Х.',
      created_at: answeredAt,
      updated_at: answeredAt,
    },
  });
  const doneAt = cap(at(-1, 10));
  const editedAt = cap(at(-1, 11));
  const done = await prisma.comment.create({
    data: {
      issue_id: readiness.id,
      author_id: uid('umu_spec'),
      parent_comment_id: ask.id,
      body: 'Раздел обновлён, ссылки проверены:\n- структура и органы управления\n- документы и образовательные стандарты\n- материально-техническое обеспечение',
      created_at: doneAt,
      updated_at: editedAt,
      edited_at: editedAt,
    },
  });
  await writeActivity(readiness.id, [
    { action: 'comment.created', actor: 'pr_edu', when: askedAt, new_value: ask.id },
    { action: 'comment.created', actor: 'umu', when: answeredAt, new_value: answer.id },
    { action: 'comment.created', actor: 'umu_spec', when: doneAt, new_value: done.id },
    { action: 'comment.updated', actor: 'umu_spec', when: editedAt, new_value: done.id },
  ]);
  notify('mentioned', 'pr_edu', ['umu'], readiness.id, askedAt, { entity: ask.id });
  notify('comment_added', 'umu', ['pr_edu'], readiness.id, answeredAt, { entity: answer.id });
  notify('comment_added', 'umu_spec', ['pr_edu', 'umu'], readiness.id, doneAt, { entity: done.id });

  // ─── Reminders the scheduler would have sent (control/reminders.ts) ───
  // Same recipients and ReminderLog keys, so a running scheduler finds them claimed.
  // Today's batch exists only once the reminder hour has passed; before that the
  // scheduler sends it live.
  const today = day(new Date(NOW));
  const lastDay = localHour(new Date(NOW), TZ) >= REMINDER_HOUR ? today : addDays(today, -1);
  const reminderLog: Prisma.ReminderLogCreateManyInput[] = [];
  const remind = (
    type: 'due_soon' | 'overdue' | 'escalated',
    logKind: string,
    forDate: string,
    sentOn: string,
    work: (typeof openWork)[number],
    recipients: string[],
  ) => {
    const when = maxDate(
      onDay(sentOn, REMINDER_HOUR, between(0, 10)),
      new Date(work.created.getTime() + 5 * 60_000),
    );
    notify(type, work.controller, recipients, work.id, when, { system: true });
    for (const r of new Set(recipients)) {
      reminderLog.push({
        issue_id: work.id,
        user_id: uid(r),
        kind: logKind,
        for_date: forDate,
        created_at: cap(when),
      });
    }
  };
  for (const work of openWork) {
    const due = day(work.due);
    const createdOn = day(work.created);
    for (const left of REMINDER_DAYS) {
      const sentOn = addDays(due, -left);
      if (sentOn >= createdOn && sentOn <= lastDay)
        remind('due_soon', `due_soon:${left}`, due, sentOn, work, work.owners);
    }
    for (let d = addDays(due, 1); d <= lastDay; d = addDays(d, 1)) {
      if (d < createdOn) continue;
      remind('overdue', 'overdue', d, d, work, [...work.owners, work.controller]);
    }
    // Once per deadline, on the first pass at least `escalation_days` overdue.
    const escalateOn = maxDay(addDays(due, ESCALATION_DAYS), createdOn);
    if (escalateOn <= lastDay) {
      const head = work.primary ? headOf(person(work.primary).dept)?.key : undefined;
      remind('escalated', 'escalated', due, escalateOn, work, [
        work.controller,
        ...(head && head !== work.primary ? [head] : []),
      ]);
    }
  }

  await prisma.notification.createMany({ data: notifications });
  await prisma.reminderLog.createMany({ data: reminderLog, skipDuplicates: true });

  // ─── Audit log (12.B1): three months of who did what ───
  const audit: Prisma.AuditLogCreateManyInput[] = [];
  const personIndex = new Map(PEOPLE.map((p, i) => [p.key, i]));
  function audited(
    actor: string,
    action: string,
    when: Date,
    target: { type: string; id: string } | null,
    meta: Record<string, unknown> | null = null,
    opts: { mobile?: boolean; workspace?: boolean } = {},
  ): void {
    const p = person(actor);
    const i = personIndex.get(actor)!;
    audit.push({
      workspace_id: opts.workspace === false ? null : wsId,
      actor_id: uid(actor),
      actor_name: fullName(p),
      action,
      target_type: target?.type ?? null,
      target_id: target?.id ?? null,
      meta: (meta ?? undefined) as Prisma.InputJsonValue | undefined,
      ip: opts.mobile
        ? `${pick(['95.142', '178.91', '188.130'])}.${between(1, 254)}.${between(2, 254)}`
        : `10.20.${DEPARTMENTS.findIndex((d) => d.key === p.dept) + 1}.${i + 11}`,
      user_agent: opts.mobile
        ? MOBILE_AGENTS[i % MOBILE_AGENTS.length]!
        : DESKTOP_AGENTS[i % DESKTOP_AGENTS.length]!,
      created_at: cap(when),
    });
  }

  // Setting up the stand: workspace, structure, people.
  audited(
    'rector',
    'workspace.updated',
    at(-90, 11),
    { type: 'workspace', id: wsId },
    {
      name: WS_NAME,
      short_name: 'ГУ',
      timezone: TZ,
      fields: ['name', 'short_name', 'timezone'],
    },
  );
  for (const d of DEPARTMENTS) {
    audited(
      'it',
      'department.created',
      at(-90, 14),
      { type: 'department', id: deptId.get(d.key)! },
      {
        name: d.name,
        ...(d.short && { short_name: d.short }),
      },
    );
  }
  for (const p of PEOPLE) {
    if (p.role === 'owner') continue;
    if (p.invited) {
      audited(
        'it',
        'invite.sent',
        at(-p.invited, 10),
        { type: 'user', id: uid(p.key) },
        { user_id: uid(p.key), role: p.role },
      );
    } else {
      audited(
        'it',
        'member.added',
        at(-89, 10),
        { type: 'user', id: uid(p.key) },
        {
          user_id: uid(p.key),
          role: p.role,
          position: p.position,
        },
      );
    }
  }
  audited(
    'it',
    'department.updated',
    at(-88, 11),
    { type: 'department', id: deptId.get('itf')! },
    {
      head_id: uid('dean_it'),
      fields: ['head_id'],
    },
  );
  audited(
    'rector',
    'member.updated',
    at(-75, 16),
    { type: 'user', id: uid('it') },
    { role: 'admin', fields: ['role'] },
  );
  for (const def of PROJECTS) {
    audited(
      def.createdBy,
      'project.created',
      at(def.start, 12),
      { type: 'project', id: projectInfo.get(def.key)!.id },
      {
        name: def.name,
        identifier: def.identifier,
        visibility: def.visibility ?? 'public',
      },
    );
  }
  audited(
    'rector',
    'project.member_added',
    at(-49, 10),
    { type: 'user', id: uid('acc') },
    { user_id: uid('acc'), role: 'member' },
  );
  audited(
    'rector',
    'project.member_added',
    at(-49, 10),
    { type: 'user', id: uid('umu') },
    { user_id: uid('umu'), role: 'member' },
  );
  audited(
    'pr_edu',
    'settings.control_updated',
    at(-30, 15),
    { type: 'settings', id: wsId },
    {
      fields: ['reminder_days', 'reminder_hour', 'escalation_days'],
    },
  );
  audited(
    'pr_edu',
    'member.updated',
    at(-21, 11),
    { type: 'user', id: uid('umu_spec') },
    {
      position: 'Методист УМУ',
      fields: ['position'],
    },
  );
  audited('pr_edu', 'issue.deleted', duplicateDeleted, { type: 'issue', id: duplicate.id });
  audited(
    'rector',
    'project.updated',
    at(-5, 17),
    { type: 'project', id: projectInfo.get('year')!.id },
    { fields: ['status'] },
  );

  // Reports for the rector's Monday meetings, the registry for the vice-rector.
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const monday = addDays(today, -((weekday + 6) % 7));
  // The rector downloaded the справка by hand until the planned report took over
  // (the last PLANNED_WEEKS Mondays, below).
  const PLANNED_WEEKS = 4;
  for (let w = 0; w < 8; w++) {
    const date = addDays(monday, -7 * w);
    const range = { from: addDays(date, -7), to: addDays(date, -1) };
    if (w >= PLANNED_WEEKS) {
      audited(
        'rector',
        'report.exported',
        onDay(date, 8, between(30, 55)),
        { type: 'report', id: 'discipline.pdf' },
        {
          report: 'discipline.pdf',
          ...range,
        },
      );
    }
    if (w % 2 === 0) {
      audited(
        'pr_edu',
        'report.exported',
        onDay(date, 11, between(0, 50)),
        { type: 'report', id: 'assignments.xlsx' },
        {
          report: 'assignments.xlsx',
          ...range,
          kind: 'assignment',
        },
      );
    }
  }

  // ─── Planned reports (10.B5, ADR-032) ───
  // The справка now comes by itself: every Monday at 08:00 to the rector and the
  // vice-rector for studies (Telegram and email); the vice-rector gets the реестр
  // of his area on the 1st by email, the dean of ФЭУ the faculty's справка on
  // Mondays in Telegram. Each sending is the real document, built with its
  // author's rights as of that morning and stored with the history — the same
  // path as the scheduler (modules/report-schedules/run.ts), without messaging
  // anyone now.
  const wsRef = { id: wsId, name: WS_NAME, short_name: 'ГУ', timezone: TZ };
  const reportNotes: Prisma.NotificationCreateManyInput[] = [];
  const mondays = (n: number, hour: number, minute: number) =>
    Array.from({ length: n }, (_, w) => onDay(addDays(monday, -7 * w), hour, minute)).reverse();
  const firstOfMonth = (back: number) => {
    const d = new Date(`${today.slice(0, 7)}-01T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - back);
    return d.toISOString().slice(0, 10);
  };
  const plans: {
    author: string;
    name: string | null;
    report: 'discipline' | 'assignments';
    period: 'previous_week' | 'previous_month';
    frequency: 'weekly' | 'monthly';
    by_weekday: number[];
    by_monthday: number | null;
    time: string;
    filters: { department?: string[]; kind?: 'assignment' };
    recipients: string[];
    channels: ('telegram' | 'email')[];
    created: Date;
    sends: Date[];
  }[] = [
    {
      author: 'rector',
      name: 'Справка ректору к планёрке',
      report: 'discipline',
      period: 'previous_week',
      frequency: 'weekly',
      by_weekday: [1],
      by_monthday: null,
      time: '08:00',
      filters: {},
      recipients: ['rector', 'pr_edu'],
      channels: ['telegram', 'email'],
      created: onDay(addDays(monday, -7 * PLANNED_WEEKS + 4), 16, 40),
      sends: mondays(PLANNED_WEEKS, 8, 0),
    },
    {
      author: 'pr_edu',
      name: null,
      report: 'assignments',
      period: 'previous_month',
      frequency: 'monthly',
      by_weekday: [],
      by_monthday: 1,
      time: '09:00',
      filters: { department: [deptId.get('edu')!], kind: 'assignment' },
      recipients: ['pr_edu'],
      channels: ['email'],
      created: onDay(addDays(firstOfMonth(1), -3), 11, 20),
      sends: [onDay(firstOfMonth(1), 9, 0), onDay(firstOfMonth(0), 9, 0)],
    },
    {
      author: 'dean_econ',
      name: 'Справка по факультету',
      report: 'discipline',
      period: 'previous_week',
      frequency: 'weekly',
      by_weekday: [1],
      by_monthday: null,
      time: '08:30',
      filters: { department: [deptId.get('econ')!] },
      recipients: ['dean_econ'],
      channels: ['telegram'],
      created: onDay(addDays(monday, -10), 15, 10),
      sends: mondays(2, 8, 30),
    },
  ];
  for (const plan of plans) {
    const sends = plan.sends.filter((t) => t.getTime() < NOW && t > plan.created);
    const timing = {
      frequency: plan.frequency,
      by_weekday: plan.by_weekday,
      by_monthday: plan.by_monthday,
      time: plan.time,
      start_date: quarterStart(today),
    };
    const schedule = await prisma.reportSchedule.create({
      data: {
        workspace_id: wsId,
        created_by_id: uid(plan.author),
        name: plan.name,
        report: plan.report,
        filters: plan.filters,
        period: plan.period,
        ...timing,
        recipient_ids: plan.recipients.map(uid),
        channels: plan.channels,
        next_run_at: nextRun(timing, TZ, new Date(NOW)),
        last_run_at: sends.at(-1) ?? null,
        created_at: plan.created,
        updated_at: plan.created,
      },
    });
    audited(
      plan.author,
      'report_schedule.created',
      plan.created,
      { type: 'report', id: schedule.id },
      plan.name ? { name: plan.name } : null,
    );
    const author = await prisma.workspaceMember.findUniqueOrThrow({
      where: { workspace_id_user_id: { workspace_id: wsId, user_id: uid(plan.author) } },
    });
    for (const sentAt of sends) {
      const period = reportPeriod(plan.period, day(sentAt));
      const built = await buildReport(prisma, wsRef, author, schedule, period, sentAt);
      const runId = randomUUID();
      const key = reportStorageKey(wsId, runId, built.mimeType);
      await storage.put(key, built.data, built.mimeType);
      const deliveries: Delivery[] = plan.recipients.flatMap((r) =>
        plan.channels.map((channel): Delivery => {
          const reachable = channel === 'email' || (telegram === 'linked' && telegramKey === r);
          return reachable
            ? { user_id: uid(r), channel, status: 'sent' }
            : { user_id: uid(r), channel, status: 'skipped', error: 'NO_TELEGRAM' };
        }),
      );
      await prisma.reportRun.create({
        data: {
          id: runId,
          workspace_id: wsId,
          schedule_id: schedule.id,
          period_from: period.from,
          period_to: period.to,
          status: 'sent',
          file_name: built.fileName,
          mime_type: built.mimeType,
          file_size: built.data.length,
          storage_key: key,
          summary: built.summary as unknown as Prisma.InputJsonValue,
          recipient_ids: plan.recipients.map(uid),
          deliveries: deliveries as unknown as Prisma.InputJsonValue,
          created_at: sentAt,
        },
      });
      const unread = NOW - sentAt.getTime() < UNREAD_WINDOW;
      for (const r of plan.recipients) {
        reportNotes.push({
          workspace_id: wsId,
          recipient_id: uid(r),
          actor_id: uid(plan.author),
          type: 'report_ready',
          entity_id: runId,
          is_read: !unread,
          read_at: unread ? null : new Date(sentAt.getTime() + 40 * 60_000),
          created_at: sentAt,
        });
      }
      // The scheduler's own entry: no person sent it.
      audit.push({
        workspace_id: wsId,
        actor_id: null,
        actor_name: null,
        action: 'report.sent',
        target_type: 'report',
        target_id: schedule.id,
        meta: {
          report: plan.report,
          name: plan.name,
          from: period.from,
          to: period.to,
          recipients: plan.recipients.length,
          status: 'sent',
          manual: false,
        },
        created_at: sentAt,
      });
      // The rector opens the file before the meeting.
      if (plan.author === 'rector') {
        audited(
          'rector',
          'report.exported',
          new Date(sentAt.getTime() + 52 * 60_000),
          { type: 'report', id: schedule.id },
          { report: plan.report, from: period.from, to: period.to, run_id: runId, planned: true },
        );
      }
    }
  }
  await prisma.notification.createMany({ data: reportNotes });

  // Sign-ins over the last month: sessions last 30 days, so a few a week per person.
  for (let d = -30; d <= 0; d++) {
    const date = addDays(today, d);
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (dow === 0) continue;
    for (const p of PEOPLE) {
      const chance = dow === 6 ? 0.06 : p.heads ? 0.22 : 0.32;
      if (rand() >= chance) continue;
      const mobile = rand() < 0.3;
      const loginAt = onDay(date, between(8, 10), between(0, 59));
      if (loginAt.getTime() >= NOW) continue;
      const method =
        mobile && telegram === 'linked' && p.key === telegramKey ? 'telegram' : 'email_code';
      audited(
        p.key,
        'auth.login',
        loginAt,
        { type: 'user', id: uid(p.key) },
        { method },
        { mobile, workspace: false },
      );
      const logoutAt = onDay(date, between(17, 19), between(0, 59));
      if (rand() < 0.25 && logoutAt.getTime() < NOW) {
        audited(p.key, 'auth.logout', logoutAt, { type: 'user', id: uid(p.key) }, null, {
          mobile,
          workspace: false,
        });
      }
    }
  }
  await prisma.auditLog.createMany({ data: audit });

  // «Мои сессии» (12.B2): each person's latest sign-in on a computer and on a phone
  // that was not followed by a sign-out is still live — same device, IP and method
  // as its audit entry, last used on a recent working day.
  const sessions: Prisma.AuthSessionCreateManyInput[] = [];
  const signIns = [...audit].sort((a, b) => +new Date(b.created_at!) - +new Date(a.created_at!));
  for (const p of PEOPLE) {
    const own = signIns.filter((e) => e.actor_id === uid(p.key));
    for (const mobile of [false, true]) {
      const agents = mobile ? MOBILE_AGENTS : DESKTOP_AGENTS;
      const last = own.find(
        (e) =>
          (e.action === 'auth.login' || e.action === 'auth.logout') &&
          agents.includes(e.user_agent!),
      );
      if (!last || last.action !== 'auth.login') continue;
      const createdAt = new Date(last.created_at!);
      const lastUsed = cap(
        new Date(Math.max(createdAt.getTime(), NOW - between(1, mobile ? 30 : 6) * 3_600_000)),
      );
      sessions.push({
        user_id: uid(p.key),
        method: (last.meta as { method?: string } | undefined)?.method ?? null,
        ip: last.ip,
        user_agent: last.user_agent,
        created_at: createdAt,
        last_used_at: lastUsed,
        expires_at: plusDays(lastUsed, SESSION_DAYS),
      });
    }
  }
  await prisma.authSession.createMany({ data: sessions });

  // ─── Saved views (7.B4, ADR-029): ready-made selections for the rector's office ───
  const accr = projectIdByKey.get('accr')!;
  await prisma.savedView.createMany({
    data: [
      {
        workspace_id: wsId,
        owner_id: uid('rector'),
        name: 'Просроченные поручения',
        filters: { kind: 'assignment', overdue: 'true' },
        is_shared: true,
        created_at: at(-20),
      },
      {
        workspace_id: wsId,
        owner_id: uid('rector'),
        name: 'Поручения ФЭУ в работе',
        filters: { department: deptId.get('econ')!, kind: 'assignment', open: 'true' },
        is_shared: true,
        created_at: at(-18),
      },
      {
        workspace_id: wsId,
        project_id: accr,
        owner_id: uid('rector'),
        name: 'На проверке',
        filters: { quick: 'review' },
        display: { view: 'list' },
        is_shared: true,
        created_at: at(-15),
      },
      {
        workspace_id: wsId,
        project_id: accr,
        owner_id: uid('pr_edu'),
        name: 'Мой контроль — календарь',
        filters: { quick: 'control' },
        display: { view: 'calendar' },
        created_at: at(-12),
      },
      {
        workspace_id: wsId,
        project_id: accr,
        owner_id: uid('rector'),
        name: 'План аккредитации — таймлайн',
        display: { view: 'timeline' },
        created_at: at(-10),
      },
    ],
  });

  return {
    workspaceId: wsId,
    departments: DEPARTMENTS.length,
    people: PEOPLE.length,
    projects: PROJECTS.length,
    issues: issueCount,
    attachments: attachmentCount,
    notifications: notifications.length + reportNotes.length,
    audit: audit.length,
    sessions: sessions.length,
    telegram,
  };
}

export { PEOPLE, SLUG, DOMAIN };
