// Application config — the single, typed, validated view of the environment.
//
// Import `config` anywhere that needs settings; it is parsed and frozen once at
// process start. Invalid/missing env fails fast here (before the server binds),
// with a readable list of every offending variable.

import { existsSync } from 'node:fs';
import { parseEnv, type Env } from './env.js';

/**
 * Best-effort load of a local env file into `process.env` for development.
 * `.env.local` (local DB, created by `dev/setup-env.sh`) wins and is loaded
 * ALONE, so a local run can never pick up production settings from `.env`.
 * In containers/CI the environment is injected directly, so a missing file is
 * not an error. Uses Node's built-in loader (no extra dependency); guarded for
 * older runtimes where it may be unavailable.
 */
function loadDotEnv(): void {
  if (process.env.NODE_ENV === 'production') return;
  if (process.env.NODE_ENV === 'test') return; // tests set their own vars via setupFiles
  if (typeof process.loadEnvFile !== 'function') return;
  const file = existsSync('.env.local') ? '.env.local' : '.env';
  try {
    process.loadEnvFile(file);
  } catch {
    // No env file present — rely on the real environment.
  }
}

loadDotEnv();

export const config: Env = parseEnv(process.env);

export type Config = Env;

/** True when running the local dev server (not production, not under test). */
export const isDev = config.NODE_ENV === 'development';
/** True under the test runner. */
export const isTest = config.NODE_ENV === 'test';
/** True in production. */
export const isProd = config.NODE_ENV === 'production';
