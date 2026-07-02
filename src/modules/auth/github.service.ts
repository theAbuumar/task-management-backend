// GitHub OAuth 2.0 (auth_tz.md §4).
//
// Two seams the controller uses: build the authorize redirect URL, and exchange
// the callback `code` for the user's profile. Unlike Google there is no id_token —
// we exchange the code for an `access_token`, then call the GitHub API twice:
// `GET /user` for the profile, and `GET /user/emails` for the email (the profile's
// own `email` is null when the user keeps it private). We take the primary,
// verified address so auto-merge-by-verified-email (§5) is safe. All credentials
// come from validated env (config/env.ts); the flow fails loudly if unconfigured.

import { config } from '../../config/index.js';
import { AppError } from '../../lib/errors.js';

const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const GITHUB_EMAILS_URL = 'https://api.github.com/user/emails';
const GITHUB_SCOPE = 'read:user user:email';

// GitHub rejects API requests without a User-Agent (403).
const USER_AGENT = 'task-management-backend';

/** The subset of the GitHub profile the auth layer consumes. */
export interface GithubProfile {
  id: string;
  email: string | null;
  email_verified: boolean;
  name: string | null;
  avatar_url: string | null;
}

interface GithubConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

/** Resolve the GitHub OAuth config, or fail if the flow is used unconfigured. */
function requireGithubConfig(): GithubConfig {
  const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_CALLBACK_URL } = config;
  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET || !GITHUB_CALLBACK_URL) {
    throw AppError.badRequest('GitHub sign-in is not configured');
  }
  return {
    clientId: GITHUB_CLIENT_ID,
    clientSecret: GITHUB_CLIENT_SECRET,
    callbackUrl: GITHUB_CALLBACK_URL,
  };
}

/** Build the GitHub authorize URL to redirect the browser to. */
export function buildGithubAuthUrl(state: string): string {
  const { clientId, callbackUrl } = requireGithubConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    scope: GITHUB_SCOPE,
    state,
    // We mint our own session, so no long-lived GitHub access is needed.
    allow_signup: 'true',
  });
  return `${GITHUB_AUTH_URL}?${params.toString()}`;
}

interface GithubTokenResponse {
  access_token?: string;
  error?: string;
}

interface GithubUserResponse {
  id?: number;
  name?: string | null;
  login?: string | null;
  avatar_url?: string | null;
}

interface GithubEmailEntry {
  email: string;
  primary: boolean;
  verified: boolean;
}

/** Exchange the callback authorization `code` for a GitHub access token. */
async function exchangeCodeForToken(code: string): Promise<string> {
  const { clientId, clientSecret, callbackUrl } = requireGithubConfig();

  const res = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: callbackUrl,
    }),
  });

  if (!res.ok) throw AppError.badRequest('GitHub token exchange failed');

  const token = (await res.json()) as GithubTokenResponse;
  if (!token.access_token) throw AppError.badRequest('GitHub did not return an access_token');
  return token.access_token;
}

/** Fetch a GitHub API resource with the user's access token. */
async function githubApiGet(url: string, accessToken: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/vnd.github+json',
      'user-agent': USER_AGENT,
    },
  });
  if (!res.ok) throw AppError.badRequest('GitHub profile request failed');
  return res.json();
}

/**
 * Choose the address to trust: the primary verified email (§4 "primary + verified").
 * Falls back to any verified address, else the primary (marked unverified so it
 * won't auto-merge). Returns null email only when GitHub returns none.
 */
function selectEmail(emails: GithubEmailEntry[]): { email: string | null; verified: boolean } {
  const primaryVerified = emails.find((e) => e.primary && e.verified);
  if (primaryVerified) return { email: primaryVerified.email, verified: true };

  const anyVerified = emails.find((e) => e.verified);
  if (anyVerified) return { email: anyVerified.email, verified: true };

  const primary = emails.find((e) => e.primary);
  if (primary) return { email: primary.email, verified: false };

  return { email: null, verified: false };
}

/** Exchange the callback `code` for the GitHub user's profile (auth_tz.md §4). */
export async function exchangeGithubCode(code: string): Promise<GithubProfile> {
  const accessToken = await exchangeCodeForToken(code);

  const user = (await githubApiGet(GITHUB_USER_URL, accessToken)) as GithubUserResponse;
  if (user.id === undefined || user.id === null) {
    throw AppError.badRequest('GitHub profile is missing an id');
  }

  const emails = (await githubApiGet(GITHUB_EMAILS_URL, accessToken)) as GithubEmailEntry[];
  const { email, verified } = selectEmail(Array.isArray(emails) ? emails : []);

  return {
    id: String(user.id),
    email,
    email_verified: verified,
    name: user.name ?? user.login ?? null,
    avatar_url: user.avatar_url ?? null,
  };
}
