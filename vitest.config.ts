import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Integration tests share a database; avoid cross-file races for now.
    fileParallelism: false,
    // Building the app (Prisma + plugins) can take a while on a cold start.
    hookTimeout: 60_000,
  },
});
