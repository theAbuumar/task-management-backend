# ТЗ: система аутентификации (Google / GitHub / Telegram / Email+пароль)

## 1. Основной принцип

Аккаунт (`users`) и способы входа (`auth_identities`) — разные сущности. Один пользователь может иметь несколько привязанных способов входа. Идентификация аккаунта — по `email`, если email есть; для Telegram-аккаунтов без email — по `telegram_id`.

Логика при любом входе через OAuth/Telegram: **найти-или-создать** (find-or-create) — не плодить дубли, не выдавать ошибку «уже существует» / «не существует». Исключение — вход по email+паролю (см. п. 6).

UI раздельный (отдельные экраны login и signup), но бэкенд-логика для OAuth/Telegram всё равно find-or-create: пришёл существующий юзер на signup — логиним в существующий аккаунт, а не создаём дубль; пришёл новый юзер на login через OAuth/Telegram — создаём.

## 2. Модель данных

### `users`
- `id`
- `email` — nullable, unique (для Telegram-only аккаунтов пустой)
- `email_verified` — bool
- `password_hash` — nullable (argon2id/bcrypt; есть только у тех, кто задал пароль)
- `display_name`, `avatar_url`
- `created_at`, `updated_at`

### `auth_identities` (способы входа)
- `id`, `user_id` (FK)
- `provider` — enum: `email` | `google` | `github` | `telegram`
- `provider_user_id` — стабильный id у провайдера: Google `sub`, GitHub numeric `id`, Telegram `telegram_id`. Для `email` — null
- `provider_email` — что отдал провайдер (для аудита)
- `created_at`
- UNIQUE(`provider`, `provider_user_id`)

### `email_otp` (коды подтверждения почты)
- `id`, `email`, `code_hash`, `purpose` (signup/login), `expires_at`, `attempts`, `consumed_at`

### `telegram_login_tokens`
- `id`, `token` (случайная строка), `session_id` (привязка к браузеру инициатора), `telegram_id` (заполняется ботом), `status` (`pending` / `confirmed` / `expired` / `used`), `expires_at`

## 3. Google (OAuth 2.0)

Кнопка → редирект на Google → `code` на callback → обмен на токен → берём `sub`, `email`, `name`, `picture`. Находим identity по (`google`, `sub`); если нет — ищем user по `email`, привязываем к нему (email от Google считается подтверждённым — безопасно сливать, см. п. 5); если и его нет — создаём. Пароль не запрашиваем.

## 4. GitHub (OAuth 2.0)

Кнопка → редирект на github.com → `code` → обмен на `access_token` → `GET /user` (профиль) + **`GET /user/emails`** (email отдельным запросом, берём primary + verified). Дальше логика идентична Google. Scope: `read:user user:email`.

## 5. Слияние по email (автоматическое)

Если email от провайдера совпал с существующим аккаунтом — привязываем новый способ входа к нему автоматически, **при условии что провайдер подтвердил email** (Google/GitHub verified email — да). Email от неподтверждённого источника автослиянию не подлежит.

## 6. Email + пароль

**Signup:** ввод email+пароль → создаём user неактивным → шлём OTP на почту → после верификации `email_verified=true`, аккаунт активен. Если email уже существует — не создаём дубль, логиним в существующий (после подтверждения владения кодом).

**Login:** email+пароль → проверка хеша. Если аккаунта нет — честная ошибка «неверный логин или пароль» (НЕ создаём). Если у аккаунта нет пароля (заведён через OAuth) — сообщение «войдите через Google/GitHub» + предложение задать пароль.

## 7. Telegram (deep-link + подтверждение по ссылке)

1. Юзер жмёт «Telegram» → бэкенд создаёт `telegram_login_token` (`pending`), привязывает к текущей сессии браузера.
2. Сайт даёт ссылку `https://t.me/<bot>?start=<token>`.
3. Юзер открывает бота, жмёт Start — бот получает `token` и `telegram_id`.
4. Бот в ответ присылает финальную ссылку / inline-кнопку подтверждения. Клик по ней → токен переходит в `confirmed`, привязывается `telegram_id`.
5. Find-or-create по `telegram_id`. Email не требуется (аккаунт живёт без него).
6. Сайт узнаёт о подтверждении **поллингом** (`GET /auth/telegram/status?token=`) каждые ~2 сек → при `confirmed` логинит и редиректит.

- Номер телефона на сайте **не спрашиваем** (нельзя проверить). Если нужен — запрашивает бот кнопкой «Поделиться контактом».
- Токен одноразовый, привязан к сессии инициатора, сгорает после использования.

## 8. Сессии

JWT: access-токен **3 часа** + refresh-токен ~30 дней (httpOnly cookie). Обновление по refresh. Logout инвалидирует refresh.

## 9. Дефолты безопасности (меняются по желанию)

- Email-OTP: 6 цифр, живёт 10 мин, макс. 5 попыток ввода, затем инвалидация.
- Rate limit на отправку OTP: не чаще 1 раза в 60 сек на email, не более 5/час.
- Telegram-токен: живёт 10 мин.
- Пароли: argon2id (или bcrypt cost ≥ 12), минимум 8 символов.
- Все OAuth-флоу с `state`-параметром (защита от CSRF).

## 10. Управление привязками

- Экран «Connected accounts»: список привязанных способов, привязать / отвязать.
- **Нельзя отвязать последний способ входа** (иначе юзер запрёт себя).
- Привязка нового OAuth к залогиненному аккаунту — тоже find, с проверкой что чужому юзеру эта identity не принадлежит.

## 11. Сводка эндпоинтов (ориентир)

- `GET  /auth/google` → редирект на Google
- `GET  /auth/google/callback`
- `GET  /auth/github` → редирект на GitHub
- `GET  /auth/github/callback`
- `POST /auth/email/signup` — email + пароль, шлёт OTP
- `POST /auth/email/verify` — подтверждение OTP
- `POST /auth/email/login` — email + пароль
- `POST /auth/telegram/init` — создаёт login-токен, отдаёт deep-link
- `GET  /auth/telegram/status?token=` — поллинг статуса
- `POST /auth/refresh` — обновление access-токена
- `POST /auth/logout` — инвалидация refresh
- `GET  /auth/identities` — список привязок
- `POST /auth/identities/:provider/link`
- `DELETE /auth/identities/:provider` — с запретом на удаление последнего
