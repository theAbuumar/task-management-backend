// Global test setup (loaded before every test file via vitest `setupFiles`).
//
// Provides safe defaults for the env vars that `src/config` validates at import,
// so unit tests can import application modules without a real `.env`. Individual
// integration tests may still point DATABASE_URL at a live test database.

process.env.NODE_ENV ??= 'test';
// Integration tests run against the same Postgres as development.
// CI adds a service with the default postgres password (see .github/workflows/ci.yml).
process.env.DATABASE_URL ??= 'postgresql://postgres:12345@localhost:5432/taskmgmt?schema=public';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-at-least-32-chars-long';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-at-least-32-chars-long';
process.env.LOG_LEVEL ??= 'silent';
// OAuth provider credentials so the redirect flows are "configured" under test.
// The token exchange itself is mocked (global fetch) — these are never sent anywhere real.
process.env.GOOGLE_CLIENT_ID ??= 'test-google-client-id';
process.env.GOOGLE_CLIENT_SECRET ??= 'test-google-client-secret';
process.env.GOOGLE_CALLBACK_URL ??= 'http://localhost:3000/api/v1/auth/google/callback';
process.env.GITHUB_CLIENT_ID ??= 'test-github-client-id';
process.env.GITHUB_CLIENT_SECRET ??= 'test-github-client-secret';
process.env.GITHUB_CALLBACK_URL ??= 'http://localhost:3000/api/v1/auth/github/callback';
// Telegram bot so the deep-link flow is "configured" under test. The Bot API calls
// are mocked (global fetch); these are never sent anywhere real.
process.env.TELEGRAM_BOT_TOKEN ??= '123456:test-telegram-bot-token';
process.env.TELEGRAM_BOT_USERNAME ??= 'test_task_bot';
