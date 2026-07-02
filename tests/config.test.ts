// Unit tests for env parsing/validation — covers the fail-fast contract.

import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';

const valid = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
} satisfies NodeJS.ProcessEnv;

describe('parseEnv', () => {
  it('applies defaults and coerces types', () => {
    const env = parseEnv({ ...valid });
    expect(env.PORT).toBe(3000);
    expect(env.JWT_ACCESS_TTL).toBe('3h');
    expect(env.JWT_REFRESH_TTL).toBe('30d');
    expect(env.CORS_ORIGIN).toBe('*');
  });

  it('coerces PORT from string to number', () => {
    const env = parseEnv({ ...valid, PORT: '8080' });
    expect(env.PORT).toBe(8080);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => parseEnv({ ...valid, DATABASE_URL: 'mysql://x' })).toThrow(/PostgreSQL/);
  });

  it('rejects short JWT secrets and reports every offender', () => {
    expect(() =>
      parseEnv({ ...valid, JWT_ACCESS_SECRET: 'short', JWT_REFRESH_SECRET: 'short' }),
    ).toThrow(/JWT_ACCESS_SECRET[\s\S]*JWT_REFRESH_SECRET/);
  });
});
