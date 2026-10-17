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
