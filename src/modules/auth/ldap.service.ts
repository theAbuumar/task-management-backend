// Sign-in with a university account: LDAP / Active Directory (Ф12 12.B10, ADR-034).
//
// Off unless LDAP_URL is set. The directory checks the password — we never store it:
//   1. bind as the read-only service account (or anonymously) and find exactly one
//      entry for the login with LDAP_SEARCH_FILTER (the login is escaped, RFC 4515);
//   2. bind as that entry with the password — the directory says yes or no (its own
//      lockout and disabled-account rules apply);
//   3. hand the entry's stable id, mail and name to the shared find-or-create
//      (identity.service): an existing `ldap` identity, else the account with that
//      email, else a new account with the full name from the directory.
// An unreachable or misconfigured directory is 503 LDAP_UNAVAILABLE, never a 500;
// a wrong login or password is the usual 401 INVALID_CREDENTIALS.

import { Client, InvalidCredentialsError, type Entry } from 'ldapts';
import { config } from '../../config/index.js';
import type { Env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import type { ProviderProfile } from './identity.service.js';

type LdapEnv = Pick<
  Env,
  | 'LDAP_URL'
  | 'LDAP_BIND_DN'
  | 'LDAP_BIND_PASSWORD'
  | 'LDAP_SEARCH_BASE'
  | 'LDAP_SEARCH_FILTER'
  | 'LDAP_ID_ATTRIBUTE'
  | 'LDAP_TLS_REJECT_UNAUTHORIZED'
  | 'LDAP_TIMEOUT_MS'
>;

export function ldapEnabled(env: Pick<Env, 'LDAP_URL' | 'LDAP_SEARCH_BASE'> = config): boolean {
  return Boolean(env.LDAP_URL && env.LDAP_SEARCH_BASE);
}

/** Escape a value for an LDAP filter (RFC 4515): `*`, `(`, `)`, `\` and NUL. */
export function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** The first value of an attribute as text (a Buffer — objectGUID — as hex). */
function attr(entry: Entry, name: string): string | null {
  const key = Object.keys(entry).find((k) => k.toLowerCase() === name.toLowerCase());
  const raw = key ? entry[key] : undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null) return null;
  const text = Buffer.isBuffer(value) ? value.toString('hex') : String(value);
  return text.trim() || null;
}

const unavailable = (reason: string) =>
  new AppError(
    503,
    'LDAP_UNAVAILABLE',
    'The university directory is not answering. Sign in another way or try later.',
    { reason },
  );
const invalid = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid login or password');

/**
 * Check a login and password against the directory and describe the person as a
 * provider profile. Throws 404 LDAP_DISABLED, 401 INVALID_CREDENTIALS or 503
 * LDAP_UNAVAILABLE.
 */
export async function authenticateWithDirectory(
  login: string,
  password: string,
  env: LdapEnv = config,
): Promise<ProviderProfile & { provider: 'ldap' }> {
  if (!env.LDAP_URL || !env.LDAP_SEARCH_BASE) {
    throw new AppError(404, 'LDAP_DISABLED', 'Sign-in with a university account is not set up');
  }
  // An empty password is an "unauthenticated bind" that many servers accept.
  if (!login.trim() || !password) throw invalid();

  const client = new Client({
    url: env.LDAP_URL,
    timeout: env.LDAP_TIMEOUT_MS,
    connectTimeout: env.LDAP_TIMEOUT_MS,
    // ldapts switches to TLS whenever tlsOptions are given, even for ldap://.
    ...(env.LDAP_URL.startsWith('ldaps://') && {
      tlsOptions: { rejectUnauthorized: env.LDAP_TLS_REJECT_UNAUTHORIZED },
    }),
  });
  try {
    let entries: Entry[];
    try {
      if (env.LDAP_BIND_DN && env.LDAP_BIND_PASSWORD) {
        await client.bind(env.LDAP_BIND_DN, env.LDAP_BIND_PASSWORD);
      }
      const filter = env.LDAP_SEARCH_FILTER.replaceAll(
        '{{login}}',
        escapeFilterValue(login.trim()),
      );
      ({ searchEntries: entries } = await client.search(env.LDAP_SEARCH_BASE, {
        scope: 'sub',
        filter,
        sizeLimit: 2,
        attributes: [
          env.LDAP_ID_ATTRIBUTE,
          'mail',
          'sn',
          'givenName',
          'middleName',
          'displayName',
          'cn',
        ],
        explicitBufferAttributes: ['objectGUID'],
      }));
    } catch (err) {
      // The service account or the search failing is the stand's problem, not the person's.
      if (err instanceof InvalidCredentialsError) throw unavailable('service_bind');
      throw unavailable((err as NodeJS.ErrnoException).code ? 'connect' : 'search');
    }
    // No entry, or an ambiguous login: the same answer as a wrong password.
    if (entries.length !== 1) throw invalid();
    const entry = entries[0]!;

    try {
      await client.bind(entry.dn, password);
    } catch (err) {
      if (err instanceof InvalidCredentialsError) throw invalid();
      throw unavailable('user_bind');
    }

    const email = attr(entry, 'mail')?.toLowerCase() ?? null;
    const last = attr(entry, 'sn');
    const first = attr(entry, 'givenName');
    const middle = attr(entry, 'middleName');
    const fio = [last, first, middle].filter(Boolean).join(' ');
    return {
      provider: 'ldap',
      provider_user_id: attr(entry, env.LDAP_ID_ATTRIBUTE) ?? entry.dn.toLowerCase(),
      email,
      // The university's own directory vouches for the address.
      email_verified: Boolean(email),
      display_name: fio || attr(entry, 'displayName') || attr(entry, 'cn'),
      last_name: last,
      first_name: first,
      middle_name: middle,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw unavailable('connect');
  } finally {
    await client.unbind().catch(() => undefined);
  }
}
