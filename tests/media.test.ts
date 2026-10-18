// Unit checks for avatar/logo validation helpers (3.B5): file signatures and which
// saved links count as "our upload for this owner".

import { describe, expect, it } from 'vitest';
import { ownedMediaKey, publicFileUrl, sniffImageType } from '../src/lib/media.js';

const UUID = '0b6a3c1e-5d2f-4e8a-9c7b-1a2b3c4d5e6f';

describe('sniffImageType', () => {
  it('recognises png, jpeg and webp by their leading bytes', () => {
    expect(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(
      'image/png',
    );
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe1]))).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8L', 'latin1'))).toBe(
      'image/webp',
    );
  });

  it('rejects everything else, including look-alikes and short files', () => {
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
    expect(sniffImageType(Buffer.from('GIF89a'))).toBeNull();
    expect(sniffImageType(Buffer.from('RIFF\x10\x00\x00\x00WAVEfmt ', 'latin1'))).toBeNull();
    expect(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('ownedMediaKey', () => {
  it('maps our stable link of this owner back to its storage key', () => {
    expect(ownedMediaKey(publicFileUrl(`avatars/u1/${UUID}`), 'avatars', 'u1')).toBe(
      `avatars/u1/${UUID}`,
    );
  });

  it('ignores other owners, other kinds, other hosts and crafted paths', () => {
    expect(ownedMediaKey(publicFileUrl(`avatars/u2/${UUID}`), 'avatars', 'u1')).toBeNull();
    expect(ownedMediaKey(publicFileUrl(`logos/u1/${UUID}`), 'avatars', 'u1')).toBeNull();
    expect(
      ownedMediaKey(`https://evil.example/api/v1/files/avatars/u1/${UUID}`, 'avatars', 'u1'),
    ).toBeNull();
    expect(ownedMediaKey(publicFileUrl(`avatars/u1/../u2/${UUID}`), 'avatars', 'u1')).toBeNull();
    expect(ownedMediaKey(publicFileUrl(`avatars/u1/${UUID}/x`), 'avatars', 'u1')).toBeNull();
    expect(ownedMediaKey(null, 'avatars', 'u1')).toBeNull();
  });
});
