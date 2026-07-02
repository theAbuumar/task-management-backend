// Google OAuth 2.0 (auth_tz.md §3).
//
// Two seams the controller uses: build the consent-screen redirect URL, and
// exchange the callback `code` for the user's profile. We request the OpenID
// `id_token` in the token response and read the claims straight from it — the
// token is delivered directly by Google's token endpoint over TLS, so signature
// verification is not required (per Google's OpenID Connect guidance). All
// credentials come from validated env (config/env.ts); the flow fails loudly if
// used while unconfigured.

import { config } from '../../config/index.js';
import { AppError } from '../../lib/errors.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SCOPE = 'openid email profile';

/** The subset of the Google profile the auth layer consumes. */
export interface GoogleProfile {
  sub: string;
  email: string | null;
  email_verified: boolean;
  name: string | null;
  picture: string | null;
}

interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

/** Resolve the Google OAuth config, or fail if the flow is used unconfigured. */
function requireGoogleConfig(): GoogleConfig {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL } = config;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_CALLBACK_URL) {
    throw AppError.badRequest('Google sign-in is not configured');
  }
  return {
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    callbackUrl: GOOGLE_CALLBACK_URL,
  };
}

/** Build the Google consent-screen URL to redirect the browser to. */
export function buildGoogleAuthUrl(state: string): string {
  const { clientId, callbackUrl } = requireGoogleConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    response_type: 'code',
    scope: GOOGLE_SCOPE,
    state,
    // Force the account chooser so switching Google accounts is possible; we mint
    // our own session, so no Google refresh token / offline access is needed.
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

interface GoogleTokenResponse {
  id_token?: string;
  access_token?: string;
}

interface GoogleIdTokenClaims {
  sub?: string;
  email?: string;
  // Google may serialize this as a boolean or the string "true".
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
}

/**
 * Decode a JWT payload (base64url JSON). No signature check: the token came
 * straight from Google's token endpoint over TLS, so it is already trusted.
 */
function decodeIdToken(idToken: string): GoogleIdTokenClaims {
  const payload = idToken.split('.')[1];
  if (!payload) throw AppError.badRequest('Malformed Google id_token');
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as GoogleIdTokenClaims;
  } catch {
    throw AppError.badRequest('Could not read the Google profile');
  }
}

/** Exchange the callback authorization `code` for the Google user's profile. */
export async function exchangeGoogleCode(code: string): Promise<GoogleProfile> {
  const { clientId, clientSecret, callbackUrl } = requireGoogleConfig();

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: callbackUrl,
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) throw AppError.badRequest('Google token exchange failed');

  const token = (await res.json()) as GoogleTokenResponse;
  if (!token.id_token) throw AppError.badRequest('Google did not return an id_token');

  const claims = decodeIdToken(token.id_token);
  if (!claims.sub) throw AppError.badRequest('Google profile is missing a subject id');

  return {
    sub: claims.sub,
    email: claims.email ?? null,
    email_verified: claims.email_verified === true || claims.email_verified === 'true',
    name: claims.name ?? null,
    picture: claims.picture ?? null,
  };
}
