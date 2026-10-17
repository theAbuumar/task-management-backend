# Журнал изменений — бэкенд (task-management-backend)

> План работ: [корневой ROADMAP.md](../ROADMAP.md). Решения: [docs/DECISIONS.md](../docs/DECISIONS.md).
> Файл `ROADMAP.md` в этой папке — история первых фаз. Новые задачи ведутся в корневом роадмапе.

## Правила
- Запись добавляется **после каждой выполненной задачи** роадмапа. В заголовке ID задачи, например `1.B1`.
- Новые записи сверху.
- Поле **API** обязательно, если менялся контракт: новый, изменённый или удалённый эндпоинт, поле, код ошибки. Такая запись — сигнал обновить типы фронта (`front-task-managment/src/api`) и при необходимости клиент бота. В их CHANGELOG ставится ссылка на эту запись.
- Поле **БД** обязательно для каждой миграции (имя миграции и что делает, есть ли перенос данных).
- Поле **Конфигурация** — новые или изменённые переменные окружения. Они же добавляются в `.env.example`.
- Если чего-то нет, пишется «—».

## Шаблон
```markdown
## ГГГГ-ММ-ДД — <ID> <Кратко>
**Фаза:** ФN · **Тип:** новая функция | исправление | рефакторинг | безопасность | производительность | тесты | инфраструктура
**Что изменено:**
- …
**Файлы:** `src/…`
**API:**
- `POST /api/v1/…` — новый: …
- `PATCH /api/v1/…` — новое поле `…`
**БД:** миграция `ГГГГММДДЧЧММСС_имя` — …
**Конфигурация:** `NEW_VAR` — назначение, значение по умолчанию
**Тесты:** какие добавлены и изменены
**Как проверить:** шаги
**Совместимость:** что нужно обновить во фронте и боте
```

---

## 2026-10-17 — 13.B1 (продолжение) Демо-сид: рассылки подразделениям
**Фаза:** Ф13 · **Тип:** демо-данные · **Ветка:** `claude/affectionate-wright-igm2y5` (от `develop`)
**Что изменено:**
- `seed-demo.ts`: две рассылки (6.B1) с правдоподобной историей.
  - «Подготовить раздел отчёта о самообследовании» (Аккредитация 2027, контролёр — проректор по учебной работе). Шесть подразделений: ФЭУ, ФИТ и УМУ исполнили в срок, аспирантура — с опозданием, IT-центр на проверке, филологический факультет просрочил. На экране «исполнено 4 из 6».
  - «Предоставить сведения о трудоустройстве выпускников 2026 года» (ректор, срок через 9 дней) — три факультета, деканы ещё не ознакомились, у них уведомления «поручил(а) вам».
- Итого в демо-университете 67 задач (было 56).
**Файлы:** `src/prisma/seed-demo.ts`.
**API:** —
**БД:** —
**Конфигурация:** —
**Тесты:** `bash dev/seed-demo.sh` проходит; на демо-данных аналитика, дашборд и блок прогресса рассылки проверены в браузере.
**Как проверить:** `bash dev/seed-demo.sh` → демо-вход «Проректор» → «Аккредитация 2027» → ACCR-14.
**Совместимость:** —

## 2026-10-17 — 10.B1, 10.B2, 10.B3, 10.B4, 10.B6 Аналитика и отчёты для руководства
**Фаза:** Ф10 · **Тип:** новая функция, производительность · **Ветка:** `claude/affectionate-wright-igm2y5` (от `develop`)
**Что изменено:**
- **10.B1** Модуль `analytics` (`/workspaces/:slug/analytics/*`):
  - `summary` — KPI и прошлый период той же длины;
  - `by-department` — дерево: показатели самого подразделения (`own`) и вместе с подчинёнными (`total`);
  - `by-assignee` — нагрузка (ответственный и соисполнитель отдельно), просрочки, дисциплина;
  - `by-project` — прогресс, просрочки, дисциплина;
  - `trends?bucket=week|month` — по неделям или месяцам, по умолчанию недели для периода до 92 дней;
  - `overdue` — топ просрочек: ключ, подразделение, ответственный, контролёр, дни просрочки, переносы;
  - `deadline-changes` — одобренные, отклонённые, ожидающие переносы, возвраты и последние переносы с причиной;
  - `reaction-time` — медиана «назначено → ознакомлен», в целом и по подразделениям.
  - `dashboard` — компактный дашборд главной (10.F3) одним запросом: KPI с прошлым периодом, рейтинг подразделений на уровень ниже вершины области зрителя, топ просрочек, тренд по неделям.
  - Общие фильтры: `from`, `to` (локальные даты, по умолчанию последние 30 дней), `department` (с поддеревом), `project`, `kind`, `controller` (`me`).
- **10.B2** Все формулы собраны в `analytics/metrics.ts`. Определения записаны в корневом `docs/METRICS.md`: срок — весь локальный день по поясу пространства, срез «на конец периода», повторное открытие, перенос срока. Родитель рассылки не считается, считаются дочерние задачи.
- **10.B3** Права проверяются в `analytics/data.ts`:
  - admin и owner видят всё;
  - руководитель подразделения (`Department.head_id`) видит своё поддерево, чужое подразделение — `403`;
  - остальные видят только свои задачи (где они ответственные).
  - Приватные проекты скрыты как обычно.
- **10.B4** Экспорт (ADR-013):
  - `GET /workspaces/:slug/reports/assignments.xlsx` — реестр поручений: закреплённая шапка, автофильтр, цвет статуса срока, лист «Сводка»;
  - `GET /workspaces/:slug/reports/discipline.pdf` — «Справка об исполнении поручений»: шапка, период и фильтры, KPI с прошлым периодом, таблица по подразделениям, просроченные, место для подписи, нумерация страниц;
  - `GET /workspaces/:slug/projects/:projectId/report.pdf` — отчёт по проекту.
  - Кириллица в PDF — шрифт Roboto из `pdfmake`. Имя файла отдаётся в `filename*=UTF-8''…`.
  - Каждый экспорт пишется в `ActivityLog` с действием `report.exported` (в поле `field` — отчёт, в `new_value` — фильтры). Это временно, до журнала аудита 12.B1.
  - Логотип пространства в PDF не выводится: он хранится в WebP, а pdfkit WebP не поддерживает. В шапке стоят название и краткое название.
- **10.B6** Факты пространства загружаются одним SQL-запросом и ещё четырьмя лёгкими. Кэш живёт `ANALYTICS_CACHE_TTL` секунд и сбрасывается любой успешной записью в пространство (хук `onResponse` в `app.ts`). Локальные даты мемоизируются. Замер на 10 000 задач: загрузка ~290 мс один раз, каждый эндпоинт 12–110 мс.
- Не сделано в этой записи: 10.B5 (плановые отчёты, отложены в режиме 6 дней) и 10.B7 (burndown этапов и модулей — этапы и модули скрыты до конца Ф4).
**Файлы:** новые `src/modules/analytics/{metrics,data,service,reports,schema,routes}.ts`, `tests/analytics.test.ts`, `tests/analytics-metrics.test.ts`; `src/app.ts`, `src/config/env.ts`, `src/lib/activity.ts`, `.env.example`, `package.json` (`exceljs`, `pdfmake`, `@types/pdfmake`).
**API:**
- `GET /api/v1/workspaces/:slug/analytics/{summary,dashboard,by-department,by-assignee,by-project,trends,overdue,deadline-changes,reaction-time}` — новые (любой участник, данные по его области). Каждый ответ содержит `period` и `scope { kind: all|departments|self, department_ids }`;
- `GET /api/v1/workspaces/:slug/reports/assignments.xlsx`, `GET /api/v1/workspaces/:slug/reports/discipline.pdf`, `GET /api/v1/workspaces/:slug/projects/:projectId/report.pdf` — новые (те же фильтры и права).
- Swagger: теги «Analytics» и «Reports».
**БД:** индекс `Issue(workspace_id, completed_at)` в миграции `20261017150000_issue_distribution` (запись «6.B1, 6.B2»).
**Конфигурация:** `ANALYTICS_CACHE_TTL` — сколько секунд держать загруженные факты (по умолчанию 300, `0` — без кэша).
**Тесты:**
- `tests/analytics-metrics.test.ts` (17, без БД): полночь по поясу, UTC и пояс пространства, перенос срока, повторное открытие, срез прошлого периода, недели и месяцы, медиана, реакция, переносы и возвраты по дате решения.
- `tests/analytics.test.ts` (14): цифры сходятся с ручным подсчётом; дерево подразделений; дашборд (рейтинг на уровень ниже корня, у декана — его кафедры); топ просрочек; переносы и возвраты; тренды; фильтры; 400 на неверный период. Права: декан видит свой факультет с кафедрами, чужой — 403, заведующий — только кафедру, сотрудник — только своё. Запись сбрасывает кэш. XLSX читается (`exceljs`), есть шапка, автофильтр и строки; PDF начинается с `%PDF-`; экспорт записан в журнал; отчёт по скрытому приватному проекту — 404.
- Весь набор: 25 файлов, 218 тестов зелёные.
**Как проверить:** `bash dev/test-backend.sh tests/analytics.test.ts tests/analytics-metrics.test.ts`; на демо-данных (`bash dev/seed-demo.sh`) под ректором открыть `GET /workspaces/demo-university/reports/discipline.pdf`.
**Совместимость:** фронт — страница «Аналитика» и дашборд на главной (запись фронта «Ф10»).

## 2026-10-17 — 6.B1, 6.B2 Рассылка поручения подразделениям и сводный прогресс
**Фаза:** Ф6 · **Тип:** новая функция · **Ветка:** `claude/affectionate-wright-igm2y5` (от `develop`)
**Что изменено:**
- **6.B1** `POST /projects/:projectId/issues/distribute` принимает поля поручения и `department_ids[]`. Создаёт:
  - родительское поручение (`is_distribution: true`);
  - по дочернему поручению на каждое подразделение с адресатом `department_id` и названием «<название> — <краткое название подразделения>».
  - Ответственный в дочернем поручении — руководитель подразделения. Контролёр, срок, приоритет, основание и метки наследуются от родителя. Проверка по умолчанию обязательна: принимает контролёр, а без него — автор.
  - Всё выполняется в одной транзакции. Если у подразделения нет руководителя (или он вышел из пространства), ответ `400 DEPARTMENT_HAS_NO_HEAD` со списком в `details.departments`, и ничего не создаётся.
  - В приватном проекте руководители добавляются в участники проекта, иначе они не увидят свою задачу.
  - Руководители получают `issue_assigned` в приложении, а также в Telegram или на почту.
- **6.B2** `GET` родителя рассылки (и любые ответы, построенные на нём) содержит `distribution`: `total`, `completed`, `cancelled`, `review`, `open`, `overdue`, `ready_to_close` и строки по подразделениям (подразделение, ответственный, состояние, срок, дата исполнения, `overdue`, `completed_late`). `ready_to_close: true`, когда все дочерние закрыты, а родитель ещё открыт: клиент предлагает закрыть поручение.
- В ответе задачи появились `is_distribution`, `department_id`, `department { id, name, short_name }`.
**Файлы:** новые `src/modules/issues/{distribution,distribution-progress}.ts`, `tests/distribution.test.ts`; `src/modules/issues/{routes,schema,service}.ts`, `src/lib/errors.ts`, `src/prisma/schema.prisma`.
**API:**
- `POST /api/v1/workspaces/:slug/projects/:projectId/issues/distribute` — новый, ответ `201` — родитель с `distribution`;
- `GET .../issues/:issueId` — новое поле `distribution` у родителя рассылки; у всех задач — `is_distribution`, `department_id`, `department`;
- новый код ошибки `DEPARTMENT_HAS_NO_HEAD`.
**БД:** миграция `20261017150000_issue_distribution` — `Issue.is_distribution` (bool, по умолчанию false), `Issue.department_id` (FK на `Department`, `SET NULL`), индексы `Issue(department_id)` и `Issue(workspace_id, completed_at)`. Переноса данных нет.
**Конфигурация:** —
**Тесты:** `tests/distribution.test.ts` (6): родитель и дочерние поручения, наследование полей, ответственный — руководитель, уведомления; подразделение без руководителя — 400 и ничего не создано; чужие подразделения и пустой список — 400; прогресс (на проверке, просрочено, исполнено с опозданием) и `ready_to_close`; дочерние находятся фильтром по подразделению; в приватном проекте руководитель видит свою задачу.
**Как проверить:** `bash dev/test-backend.sh tests/distribution.test.ts`
**Совместимость:** фронт — диалог «Разослать подразделениям» и блок прогресса (запись фронта «6.F1, 6.F2»).

## 2026-10-17 — 7.B1 Задачи по всему пространству: `GET /workspaces/:slug/issues`
**Фаза:** Ф7 · **Тип:** новая функция, производительность · **Ветка:** `claude/affectionate-wright-igm2y5` (от `develop`)
**Что изменено:**
- Новый список задач по всем видимым проектам пространства. Главная и «Мои задачи» больше не делают по запросу на каждый проект (N+1 из аудита).
- Фильтры те же, что у списка проекта, плюс:
  - `project` и `department`, одно или несколько значений. Подразделение включает подчинённые; задача относится к подразделению-адресату, иначе к подразделению ответственного;
  - для обоих списков: `reviewer` (кто принимает работу — контролёр, а без него автор; `me`), `state_group` (одна или несколько групп), `completed_after` и `completed_before`.
- В строке есть `project { id, name, identifier, icon, color }`. Пагинация курсором, группировки нет (у проектов разные состояния). Приватные проекты скрыты от тех, кто в них не входит.
- Общие правила видимости и «подразделение задачи» вынесены в `src/modules/issues/scope.ts`: на них опирается аналитика (Ф10).
**Файлы:** новый `src/modules/issues/scope.ts`, `tests/workspace-issues.test.ts`; `src/modules/issues/{service,schema,workspace-routes}.ts`.
**API:**
- `GET /api/v1/workspaces/:slug/issues` — новый (любой участник);
- `GET /api/v1/workspaces/:slug/projects/:projectId/issues` — новые фильтры `reviewer`, `state_group`, `completed_after`, `completed_before`.
**БД:** —
**Конфигурация:** —
**Тесты:** `tests/workspace-issues.test.ts` (9): только для участников; строки всех проектов с данными проекта; приватный проект скрыт от не-участника; фильтры по проекту и по подразделению с поддеревом и адресатом; `assignee=me`, `overdue`, `reviewer`, `state_group`, `completed_after`; курсор; 400 на неизвестную группу.
**Как проверить:** `bash dev/test-backend.sh tests/workspace-issues.test.ts`
**Совместимость:** фронт — главная и «Мои задачи» (запись фронта «7.F1, 7.F2»). Бот может брать отсюда «Мои задачи» одним запросом.

## 2026-10-17 — 4.F5 (бэк): вложения — `review_id` и ФИО загрузившего в ответе, имя файла при скачивании из локального хранилища
**Фаза:** Ф4 · **Тип:** доработка · **Ветка:** `claude/affectionate-wright-igm2y5` (от `develop`)
**Что изменено:**
- В ответе вложений появилось поле `review_id` (файл сдан с отчётом на проверку, Ф5). Раньше оно было в БД, но срезалось схемой ответа. У `uploaded_by` добавлены поля ФИО.
- Локальное хранилище (dev и локальный стенд) отдаёт файл с `Content-Disposition: attachment; filename*=UTF-8''…`, как S3. Скачанный файл называется «Отчёт кафедры.pdf», а не «<uuid>__…».
**Файлы:** `src/modules/attachments/{schema,service}.ts`, `src/lib/storage.ts`, `src/plugins/storage.ts`, `tests/attachments.test.ts`.
**API:** `GET .../issues/:issueId/attachments`, `POST .../attachments` — новые поля `review_id`, `uploaded_by.{last_name,first_name,middle_name}`.
**БД:** —
**Конфигурация:** —
**Тесты:** `tests/attachments.test.ts` +1 (кириллическое имя при скачивании, `review_id`, ФИО), в round-trip проверяется имя файла. Весь набор: 172 теста зелёные.
**Как проверить:** `bash dev/test-backend.sh tests/attachments.test.ts`
**Совместимость:** фронт — раздел «Вложения» (запись фронта «4.F5»).

## 2026-10-17 — 8.B6 Уведомления: задача в строке, фильтр по типу, «непрочитанное»; исправлены фильтры списка задач
**Фаза:** Ф8 (+ исправление Ф1) · **Тип:** новая функция, исправление · **Ветка:** `claude/affectionate-wright-igm2y5` (от `develop`)
**Что изменено:**
- **Строка уведомления** теперь содержит краткие данные задачи (`issue`: id, название, номер, проект с ключом, вид, срок) и ФИО автора события. Клиенту не нужны лишние запросы, чтобы показать «ACCR-12 · Подготовить отчёт» и открыть задачу.
- У `deadline_change_decided` добавлено поле `details { approved, new_due_date }`: можно написать «одобрил перенос срока на 25 окт.» или «отклонил».
- **Фильтр по типу:** `GET .../notifications?type=review_requested,review_returned` (или повтор параметра). Неизвестный тип — 400.
- **`POST .../notifications/:id/unread`** — вернуть уведомление в непрочитанные (только своё, иначе 404).
- Swagger: полный список типов ADR-020 вместо трёх старых, схемы `issue`, `details`, ФИО автора.
- **Исправление:** фильтры списка задач `state`, `priority`, `assignee`, `label` с одним значением (`?priority=high`, `?assignee=me`) отвечали 400 «must match exactly one schema in oneOf» — при приведении типов строка подходила под обе ветки `oneOf`. Заменено на `anyOf`. Повторённые параметры работали и раньше.
**Файлы:** `src/modules/notifications/{schema,service,controller,routes}.ts`, `src/modules/issues/schema.ts`, `tests/notifications.test.ts`, `tests/execution-control.test.ts`.
**API:**
- `GET /api/v1/workspaces/:slug/notifications` — новые поля строки `issue`, `details`, `actor.{last_name,first_name,middle_name}`; новый параметр `type`;
- `POST /api/v1/workspaces/:slug/notifications/:id/read` — те же новые поля в ответе;
- `POST /api/v1/workspaces/:slug/notifications/:id/unread` — новый;
- `GET /api/v1/workspaces/:slug/projects/:projectId/issues` — `state`, `priority`, `assignee`, `label` принимают одно значение (раньше 400).
**БД:** —
**Конфигурация:** —
**Тесты:** `tests/notifications.test.ts` +3 (данные задачи и ФИО в строке; фильтр по типу через запятую, повтором и 400 на неизвестный тип; «непрочитанное» только для своих), `tests/execution-control.test.ts` +1 (одиночные и повторённые значения фильтров `priority`, `assignee`, `state`). Весь набор: 171 тест зелёный.
**Как проверить:** `bash dev/test-backend.sh tests/notifications.test.ts tests/execution-control.test.ts`
**Совместимость:** фронт — новая страница уведомлений (запись фронта «8.F4, 2.F2»). Старые клиенты не ломаются: поля только добавлены.

## 2026-10-17 — 5.F6 (бэк): сводные счётчики «Мои задачи» — `GET /workspaces/:slug/me/summary`
**Фаза:** Ф5 · **Тип:** новая функция, производительность · **Ветка:** `claude/affectionate-wright-igm2y5` (от `develop`)
**Что изменено:**
- Новый эндпоинт сводки для сайдбара и «Мои задачи»: один запрос из COUNT-ов вместо загрузки задач по всем проектам.
- Правила подсчёта совпадают с фильтрами задач и циклом проверки:
  - `assigned`, `overdue`, `due_today` — открытые задачи, где я исполнитель; дни срока — по поясу пространства (ADR-012);
  - `unacknowledged` — открытые поручения, с которыми я не ознакомился (5.B4);
  - `control`, `control_overdue` — открытые поручения на моём контроле: я контролёр или автор поручения без контролёра (ADR-008);
  - `review_pending` — задачи в состоянии группы `review`, по которым решение за мной (как `reviewersOf`);
  - `watching` — открытые задачи, за которыми я наблюдаю (5.B7);
  - `unread_notifications` — непрочитанные уведомления в этом пространстве.
- Приватные проекты, которые участнику не видны, и удалённые проекты и задачи не учитываются (3.B9).
**Файлы:** новые `src/modules/control/summary.ts` (сервис), `src/modules/control/summary-routes.ts`, `tests/my-summary.test.ts`; `src/app.ts` (префикс `/api/v1/workspaces/:workspaceSlug/me`).
**API:**
- `GET /api/v1/workspaces/:slug/me/summary` — новый (любой участник пространства): `{ assigned, overdue, due_today, unacknowledged, control, control_overdue, review_pending, watching, unread_notifications }`. Описан в Swagger (тег «Execution control»).
**БД:** —
**Конфигурация:** —
**Тесты:** `tests/my-summary.test.ts` (6 сценариев): только для участников (403 постороннему); нули у нового участника; исполнитель — назначено, просрочено, срок сегодня, не ознакомлен, наблюдаю; контролёр — на контроле и просрочка; ознакомление, сдача на проверку и приёмка двигают счётчики; задачи приватного проекта не видны участнику, но видны владельцу; непрочитанные уведомления. Весь набор: 21 файл, 167 тестов зелёные.
**Как проверить:** `bash dev/test-backend.sh tests/my-summary.test.ts`; в Swagger (`/docs`) под демо-ректором — `GET /workspaces/demo-university/me/summary`.
**Совместимость:** фронт — счётчики в сайдбаре (запись фронта «5.F6, 5.F7»). Бот может брать отсюда цифры для меню «Мои задачи».

## 2026-10-17 — Ф5 (бэк): контроль исполнения — проверка, ознакомление, переносы сроков, наблюдатели, напоминания и эскалация
**Фаза:** Ф5 · **Тип:** новая функция · **Ветка:** `develop`
**Что изменено:**
- **Миграция** `execution_control`:
  - модели `IssueReview` (сдача на проверку и решение), `DeadlineChangeRequest`, `IssueWatcher`, `ReminderLog` (уникальный ключ — защита от повторных напоминаний);
  - enum `ReviewDecision` и `DeadlineRequestStatus`;
  - `Attachment.review_id` (файлы отчёта).
- **5.B2** Цикл проверки (`.../issues/:issueId/review/*`):
  - `submit`: отчёт и вложения → состояние «На проверке», контролёр получает уведомление;
  - `approve` → «Готово»;
  - `return` (комментарий обязателен) → «В работе», замечание попадает в комментарии;
  - `GET .../reviews` — история.
  - Решает контролёр, а если его нет — автор. Admin может всегда. Перетаскивание карточки на доске запускает тот же цикл: переход в «На проверке» открывает сдачу, выход из неё принимает или возвращает работу.
- **5.B3** Исполнитель не может закрыть поручение с `requires_review` (`409 REVIEW_REQUIRED`).
- **5.B4** «Ознакомлен»: `POST .../acknowledge` ставит `acknowledged_at`, контролёр получает уведомление.
- **5.B5** Перенос срока: `POST .../deadline-requests` (дата и причина; одна заявка в ожидании), `POST .../deadline-requests/:id/approve|reject` (контролёр), `GET .../deadline-requests`. Исполнитель не может напрямую менять срок поручения (`403 DEADLINE_CHANGE_FORBIDDEN`). Число одобренных переносов отдаётся в `issue._count.deadline_requests`.
- **5.B7** Наблюдатели:
  - автор, исполнители и контролёр подписываются автоматически, комментатор — тоже;
  - `GET/POST .../watchers`, `DELETE .../watchers/me`;
  - наблюдатели получают `state_changed` и `comment_added`;
  - фильтр `watcher=me`.
- **5.B6 / 5.B8** Напоминания и эскалация (`modules/control/reminders.ts`), всё в часовом поясе пространства:
  - `due_soon` за N дней (по умолчанию 3, 1 и в день срока);
  - `overdue` раз в день;
  - `escalated` один раз при пороге просрочки — руководителю подразделения ответственного и контролёру.
  - Каждое напоминание уходит ровно один раз (`ReminderLog`), в приложение и в Telegram или на почту (`lib/deliver.ts`).
  - Планировщик `plugins/scheduler.ts` срабатывает раз в 5 минут, держит транзакционный advisory-lock, отключается через `JOBS_ENABLED`.
  - Ручной запуск: `POST /workspaces/:slug/control/run-reminders` (admin).
- **5.B9** Настройки: `GET/PATCH /workspaces/:slug/control/settings` — `reminder_days`, `reminder_hour`, `escalation_days`, `require_report` (при `REPORT_REQUIRED` без отчёта сдать нельзя).
- **5.B10** Фильтры списка задач: `overdue`, `due_within`, `open`, `review_pending`, `acknowledged`, `watcher`, `me` вместо id в `assignee`, `controller`, `created_by` и `watcher`.
- В ответе задачи появились `state { id, name, group, color }` и `_count { watchers, deadline_requests }`.
- Новые действия в истории: `issue.review_submitted`, `issue.review_approved`, `issue.review_returned`, `issue.acknowledged`, `issue.deadline_requested`, `issue.deadline_approved`, `issue.deadline_rejected`.
**Файлы:**
- новые: `src/modules/control/{rules,service,schema,routes,admin-routes,reminders}.ts`, `src/plugins/scheduler.ts`, `src/lib/{tz,deliver,plural,control-settings}.ts`, `tests/execution-control.test.ts`, миграция `20261017114432_execution_control`;
- изменены: `src/modules/issues/{service,schema,controller}.ts`, `src/modules/comments/service.ts`, `src/lib/{notifications,activity,errors}.ts`, `src/config/env.ts`, `src/app.ts`, `src/prisma/schema.prisma`.
**API:**
- новые:
  - `POST .../issues/:id/review/submit|approve|return`;
  - `GET .../issues/:id/reviews`;
  - `POST .../issues/:id/acknowledge`;
  - `GET/POST .../issues/:id/deadline-requests`;
  - `POST .../deadline-requests/:rid/approve|reject`;
  - `GET/POST .../issues/:id/watchers`;
  - `DELETE .../watchers/me`;
  - `GET/PATCH /workspaces/:slug/control/settings`;
  - `POST /workspaces/:slug/control/run-reminders`.
- новые фильтры в `GET .../issues`; новые поля `state` и `_count` в ответе задачи.
- новые коды ошибок: `REVIEW_REQUIRED`, `REVIEW_PENDING`, `NO_PENDING_REVIEW`, `NO_REVIEW_STATE`, `REPORT_REQUIRED`, `NOT_REVIEWER`, `NOT_ASSIGNEE`, `DEADLINE_CHANGE_FORBIDDEN`, `DEADLINE_REQUEST_PENDING`.
**БД:** `20261017114432_execution_control`
**Конфигурация:** `JOBS_ENABLED` (по умолчанию включено, под тестами выключено).
**Тесты:** `tests/execution-control.test.ts` (11 сценариев): ознакомление, запреты, переносы, полный цикл проверки, в том числе перетаскиванием, наблюдатели, фильтры, напоминания и эскалация (однократность, руководитель подразделения), ручной запуск, настройки.
**Как проверить:** `bash dev/test-backend.sh tests/execution-control.test.ts`
**Совместимость:** фронт — UI Ф5 (блок «Контроль» в задаче, кнопки, индикаторы сроков, наблюдение) делается следующим шагом.

## 2026-10-17 — Ф3 (бэк): доменная модель университета — оргструктура, ФИО, поручения с контролёром, видимость проектов, аватары и логотипы
**Фаза:** Ф3 (+ 2.B1) · **Тип:** новая функция · **Ветка:** `phase-3/domain`. В `main` не влита, пока не подтверждён порядок миграций на проде.
**Что изменено:**
- **3.B1** Две миграции:
  - `enum_review_and_notification_types`: в `StateGroup` добавлен `review` (перед `completed`), `NotificationType` расширен до полного списка ADR-020;
  - `university_domain`: модель `Department`; поля ФИО, `phone`, `locale`, `timezone` у `User`; `short_name`, `description`, `logo_url`, `timezone`, `locale`, `settings` у `Workspace`; `department_id` и `position` у `WorkspaceMember`; `visibility`, `status`, `start_date`, `target_date`, `department_id`, `icon`, `color`, `deleted_at` у `Project`; `kind`, `controller_id`, `requires_review`, `basis` у `Issue`; `is_primary` и `acknowledged_at` у `IssueAssignee`.
  - Перенос данных: каждому проекту добавлено состояние «На проверке», стандартные состояния переименованы на русский, первый исполнитель задачи стал ответственным. Проверено на временной базе с тестовыми данными.
  - Новые проекты получают состояния «Бэклог, К выполнению, В работе, На проверке, Готово, Отменено». Прогресс этапов и модулей считает `review` отдельно.
- **3.B2** Модуль подразделений `/workspaces/:slug/departments`:
  - список плоский или деревом (`?tree=true`);
  - создание, изменение и удаление — только admin;
  - руководитель обязан быть участником пространства;
  - защита от циклов (`DEPARTMENT_CYCLE`);
  - при удалении люди, проекты и дочерние подразделения поднимаются на уровень выше.
- **3.B3** Участники:
  - `PATCH /workspaces/:slug/members/:userId` принимает `role`, `department_id` и `position`; подразделение и должность можно задать и владельцу, и себе;
  - `GET .../members?department=&subtree=&search=`;
  - в ответе ФИО, телефон и подразделение.
- **3.B4** Профиль: `PATCH /auth/me` принимает `last_name`, `first_name`, `middle_name`, `phone`, `locale` и `timezone` (проверка IANA). Если изменились части ФИО, `display_name` пересобирается как «Фамилия Имя Отчество».
- **3.B5** Аватары и логотипы:
  - `POST /auth/me/avatar` и `POST /workspaces/:slug/logo` (admin) выдают presigned-загрузку и постоянную ссылку `/api/v1/files/avatars|logos/...`;
  - публичный `GET /api/v1/files/*` перенаправляет на свежую presigned-ссылку и отдаёт только `avatars/` и `logos/`;
  - разрешены только png, jpeg и webp до 2 МБ.
- **3.B6** Проекты:
  - новые поля при создании и изменении;
  - `member_ids` при создании;
  - фильтры `status`, `department` и `include_archived`;
  - в ответе `lead`, `department` и `stats { members, issues, open_issues }`.
- **3.B7** Задачи:
  - новые поля `kind`, `controller_id`, `requires_review` и `basis`;
  - `primary_assignee_id` (ответственный исполнитель);
  - у поручения с контролёром `requires_review` включён по умолчанию;
  - контролёр обязан быть участником пространства;
  - первый назначенный становится ответственным, при удалении ответственного роль переходит следующему;
  - фильтры `kind` и `controller`;
  - изменения новых полей пишутся в историю.
- **3.B8** Удаление проекта теперь мягкое (`deleted_at`). Удалённые проекты не видны нигде.
- **3.B9** Приватные проекты проверяются в одном месте — `requireWorkspaceMember` для всех маршрутов `/projects/:projectId/...`. Такие проекты видят только их участники и admin, всем остальным отвечает 404. Список проектов тоже фильтруется.
- **2.B1** `GET /workspaces/:slug/issues/by-key/:key` (например, `ACCR-12`) для глубоких ссылок, с учётом видимости.
- **3.B10** Обновлены Swagger-схемы ответов, открыты вложенные объекты (`additionalProperties`), сид использует общие `DEFAULT_STATES`.
**Файлы:**
- новые: `src/modules/departments/*`, `src/modules/media/routes.ts`, `src/modules/issues/workspace-routes.ts`, `tests/university-domain.test.ts`, две миграции в `src/prisma/migrations/`;
- изменены: `src/prisma/schema.prisma`, `src/plugins/workspace-hook.ts`, `src/modules/{projects,issues,workspaces,auth,cycles,modules}/*`, `src/lib/errors.ts`, `src/app.ts`, `src/prisma/seed.ts`.
**API:**
- новые:
  - `GET/POST /workspaces/:slug/departments`;
  - `PATCH/DELETE /workspaces/:slug/departments/:id`;
  - `POST /auth/me/avatar`;
  - `POST /workspaces/:slug/logo`;
  - `GET /files/*`;
  - `GET /workspaces/:slug/issues/by-key/:key`.
- новые поля в запросах и ответах: `/auth/me`, `/workspaces`, `/workspaces/:slug/members`, `/projects`, `/issues`.
- изменения поведения:
  - `DELETE` проекта — мягкое удаление;
  - приватные проекты отвечают 404 тем, кому они не видны;
  - в `StateGroup` появилось значение `review`.
- новый код ошибки: `DEPARTMENT_CYCLE`.
**БД:** `20261017103704_enum_review_and_notification_types`, `20261017103854_university_domain` (с переносом данных).
**Конфигурация:** —
**Тесты:** `tests/university-domain.test.ts` (15 сценариев): дерево подразделений, права, циклы, удаление; участники; ФИО; поля проекта; приватность; мягкое удаление; поля поручения; ответственный; фильтры; поиск по ключу; аватар и логотип.
**Как проверить:** `NODE_ENV=test DATABASE_URL=<локальная БД> npx vitest run`
**Совместимость:**
- Фронт: использовать новые поля. `StateGroup` теперь может быть `review`, его нужно обрабатывать в доске, бейджах и «Мои задачи».
- Прод: перед деплоем нужно применить миграции командой `prisma migrate deploy`.

## 2026-10-17 — Ф1 (бэк): ссылки в письмах, вход по коду, сессии, helmet, выход из пространства, коды ошибок
**Фаза:** Ф1 · **Тип:** исправление, новая функция, безопасность
**Что изменено:**
- **1.B1** Ссылки в письмах-приглашениях ведут на фронт (`FRONTEND_URL`), а не на хост API. Добавлен хелпер `lib/urls.ts → frontendUrl()`. Email-приглашение открывает `/invites/:token`, приглашение зарегистрированному пользователю — `/invitations`.
- **1.B2** Беспарольный вход по коду на email: запрос кода и подтверждение. Новый адрес получает неактивный аккаунт без пароля, который активируется после ввода кода. Ответ на запрос одинаковый для нового и существующего адреса (защита от перебора).
- **1.B3** `JWT_ACCESS_TTL` по умолчанию 15m (был 3h). Повторное использование уже ротированного refresh-токена отзывает все сессии пользователя. Окно в 10 секунд защищает от ложных срабатываний при гонке вкладок. Деактивированный пользователь не может обновить сессию.
- **1.B4** Подключён `@fastify/helmet`. CSP совместима со Swagger UI, `crossOriginResourcePolicy: cross-origin` позволяет SPA показывать файлы.
- **1.B5** При `CORS_ORIGIN='*'` в production на старте пишется предупреждение. В `.env.example` описано, когда нужен `SameSite=lax` (общий origin), а когда `none` (разные origin).
- **1.B6** Выход из пространства. Владелец получает 403 `OWNER_CANNOT_LEAVE`. Вместе с членством удаляется участие в проектах пространства.
- **1.B7** Конкретные коды ошибок для пользовательских сценариев и их каталог `ERROR_CODES` в `lib/errors.ts`.
- Письма (коды, приглашения, уведомления о задачах) переведены на русский, даты в формате «23 октября 2026 г.».
- **1.B8** `uploads/` уже был в `.gitignore`. Обновлён устаревший комментарий в шапке `app.ts`.
- Тесты: `hookTimeout` увеличен до 60 с, потому что холодный старт приложения на Windows ронял `auth-hardening` по таймауту хука.
**Файлы:** `src/lib/urls.ts` (новый), `src/lib/errors.ts`, `src/lib/email.ts`, `src/app.ts`, `src/config/env.ts`, `src/modules/auth/{schema,service,controller,routes,otp.service}.ts`, `src/modules/workspaces/{schema,service,controller,routes}.ts`, `src/modules/member-invites/service.ts`, `src/modules/invites/service.ts`, `.env.example`, `vitest.config.ts`
**API:**
- `POST /api/v1/auth/email/otp/request` — новый, `{ email, display_name? }` → `{ status: 'otp_sent', email }`.
- `POST /api/v1/auth/email/otp/verify` — новый, `{ email, code }` → пара токенов и refresh-cookie.
- `POST /api/v1/workspaces/:slug/leave` — новый, 204 или 403 `OWNER_CANNOT_LEAVE`.
- Новые коды ошибок вместо общих (HTTP-статусы не менялись):
  - `INVALID_CREDENTIALS` (было `UNAUTHORIZED`);
  - `EMAIL_NOT_VERIFIED`, `ACCOUNT_DEACTIVATED` (было `FORBIDDEN`);
  - `NO_PASSWORD` (было `BAD_REQUEST`);
  - `OTP_NOT_FOUND`, `OTP_INVALID`, `OTP_EXPIRED`, `OTP_TOO_MANY_ATTEMPTS` (было `BAD_REQUEST`);
  - `ALREADY_MEMBER`, `INVITE_ALREADY_ACCEPTED` (было `CONFLICT`);
  - `INVITE_EXPIRED` (было `GONE`);
  - `INVITE_EMAIL_MISMATCH` (было `FORBIDDEN`).
- Все ответы получили заголовки безопасности (helmet).
**БД:** —
**Конфигурация:** значение по умолчанию `JWT_ACCESS_TTL` изменилось на `15m`. В проде проверить `CORS_ORIGIN` (нужен список origin фронта) и `SESSION_COOKIE_SAMESITE`.
**Тесты:** новый `tests/stabilization.test.ts`: вход по коду, повторное использование кода, ссылка в приглашении, выход из пространства, обнаружение повторного использования refresh. Обновлены ожидаемые коды в `auth`, `email-auth`, `invites` и `config`. Итог: 18 файлов, 136 тестов зелёные (локальный Postgres).
**Как проверить:** `NODE_ENV=test DATABASE_URL=<локальная БД> npx vitest run`
**Совместимость:** фронт переходит на `/auth/email/otp/*`, использует `/leave` и коды ошибок (см. CHANGELOG фронта, Ф1).

## 2026-10-17 — 0.D2 Заведён журнал изменений
**Фаза:** Ф0 · **Тип:** документация
**Что изменено:**
- Заведён этот журнал. Состояние кода на 2026-10-16 зафиксировано аудитом: 93 эндпоинта, все реализованы. Известные недочёты привязаны к задачам в корневом `ROADMAP.md` (раздел «Покрытие аудита»).
**Файлы:** `CHANGELOG.md`
**API:** —
**БД:** —
**Конфигурация:** —
