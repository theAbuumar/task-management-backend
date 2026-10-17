// Absolute links to frontend pages.
//
// Anything a person clicks outside the app — invite emails, Telegram messages,
// notification emails — must point at the SPA (`FRONTEND_URL`), never at the API's
// own host (`PUBLIC_BASE_URL`, which only serves `/api/v1` and storage URLs).

import { config } from '../config/index.js';

/** `frontendUrl('/invites/abc')` → `https://app.example.edu/invites/abc`. */
export function frontendUrl(path: string): string {
  const base = config.FRONTEND_URL.replace(/\/+$/, '');
  return `${base}/${path.replace(/^\/+/, '')}`;
}

/**
 * Deep link to an issue (ADR-006): `/w/:workspaceSlug/browse/ABC-12`. The frontend
 * switches to the workspace and opens the issue on its project board.
 */
export function issueUrl(workspaceSlug: string, issueKey: string): string {
  return frontendUrl(`/w/${workspaceSlug}/browse/${issueKey}`);
}
