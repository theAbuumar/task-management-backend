// Profile avatars and workspace logos kept in storage (Ф3 3.B5, ADR-015).
//
// The upload slot (`modules/media/routes.ts`) only trusts what the client declares.
// The real check happens when the stable URL is saved on the profile or workspace:
// the object must sit under the owner's own prefix, be at most 2 MB and start with
// a png/jpeg/webp signature. A replaced or removed image is deleted from storage,
// so old photos do not pile up behind still-working public links.

import { AppError } from './errors.js';
import { config } from '../config/index.js';
import type { StorageDriver } from './storage.js';

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Storage prefix of each kind of public image; the owner id follows it. */
export type MediaKind = 'avatars' | 'logos';

/** Stable public link to a stored image (served by `GET /api/v1/files/*`). */
export function publicFileUrl(key: string): string {
  return `${config.PUBLIC_BASE_URL.replace(/\/+$/, '')}/api/v1/files/${key}`;
}

/**
 * The storage key behind a stable URL, if it is one of ours for this owner:
 * `<PUBLIC_BASE_URL>/api/v1/files/<kind>/<ownerId>/<uuid>`. Anything else — another
 * host, another owner, a nested path — is null.
 */
export function ownedMediaKey(
  url: string | null | undefined,
  kind: MediaKind,
  ownerId: string,
): string | null {
  if (!url) return null;
  const prefix = publicFileUrl(`${kind}/${ownerId}/`);
  if (!url.startsWith(prefix)) return null;
  const name = url.slice(prefix.length);
  return /^[0-9a-f-]{36}$/i.test(name) ? `${kind}/${ownerId}/${name}` : null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The image type the leading bytes prove, or null if they are not png/jpeg/webp. */
export function sniffImageType(head: Buffer): ImageType | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Validate a new avatar/logo URL before it is saved. `null` (remove) and the value
 * already stored pass as is; anything else must be an uploaded image of this owner.
 * A file that fails the check is deleted, so a rejected upload leaves nothing behind.
 */
export async function assertUploadedImage(
  storage: StorageDriver,
  url: string | null,
  current: string | null,
  kind: MediaKind,
  ownerId: string,
): Promise<void> {
  if (url === null || url === current) return;
  const key = ownedMediaKey(url, kind, ownerId);
  if (!key) {
    throw new AppError(
      400,
      'INVALID_IMAGE',
      `Upload the image first (POST ${kind === 'avatars' ? '/auth/me/avatar' : '/workspaces/:slug/logo'}) and save the url it returns`,
    );
  }
  const object = await storage.inspect(key, 12);
  if (!object) {
    throw new AppError(400, 'INVALID_IMAGE', 'The uploaded image was not found — upload it again');
  }
  if (object.size > MAX_IMAGE_BYTES || !sniffImageType(object.head)) {
    await storage.delete(key).catch(() => undefined);
    throw new AppError(
      400,
      'INVALID_IMAGE',
      'The file is not a png, jpeg or webp image up to 2 MB',
    );
  }
}

/**
 * Best-effort removal of the image a profile/workspace no longer points to. Only
 * files under the owner's own prefix are touched (never an OAuth picture URL).
 */
export async function dropReplacedImage(
  storage: StorageDriver,
  previous: string | null,
  next: string | null,
  kind: MediaKind,
  ownerId: string,
): Promise<void> {
  if (!previous || previous === next) return;
  const key = ownedMediaKey(previous, kind, ownerId);
  if (key) await storage.delete(key).catch(() => undefined);
}
