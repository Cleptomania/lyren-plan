// Hashes, tokens and byte encodings (core/crypto.ts), space ids (core/ids.ts) and APP_VERSION
// (core/version.ts).

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import pkg from '../../package.json';
import { fromBase64Url, randomToken, safeEqual, sha256Hex, toBase64, toBase64Url, toHex } from '../src/core/crypto';
import * as sharedIds from '@shared/ids';
import * as ids from '../src/core/ids';
import { APP_VERSION } from '../src/core/version';

describe('crypto', () => {
  it('hashes text with sha256 as hex', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('makes random base64url tokens: 32 bytes give 43 characters', () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
    expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('compares strings in constant time, whatever their lengths', () => {
    expect(safeEqual('setup-code', 'setup-code')).toBe(true);
    expect(safeEqual('setup-code', 'setup-codf')).toBe(false);
    expect(safeEqual('a', 'aa')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  it('encodes bytes exactly as Buffer does', () => {
    for (const length of [0, 1, 2, 3, 31, 32, 33, 64, 70_000]) {
      const bytes = randomBytes(length);
      const buffer = Buffer.from(bytes);
      expect(toHex(bytes)).toBe(buffer.toString('hex'));
      expect(toBase64(bytes)).toBe(buffer.toString('base64'));
      expect(toBase64Url(bytes)).toBe(buffer.toString('base64url'));
      expect(Buffer.from(fromBase64Url(toBase64Url(bytes))).equals(buffer)).toBe(true);
    }
    expect(() => fromBase64Url('not base64!')).toThrow();
  });
});

describe('space ids', () => {
  it('are the shared definitions (one alphabet; shared/src/ids.test.ts tests them)', () => {
    expect(ids.SPACE_ID_ALPHABET).toBe(sharedIds.SPACE_ID_ALPHABET);
    expect(ids.SPACE_ID_RE).toBe(sharedIds.SPACE_ID_RE);
    expect(ids.generateSpaceId).toBe(sharedIds.generateSpaceId);
    expect(ids.isSpaceId(ids.generateSpaceId())).toBe(true);
  });
});

describe('APP_VERSION', () => {
  it("is package.json's version when the build defines none", () => {
    expect(APP_VERSION).toBe(pkg.version);
  });
});
