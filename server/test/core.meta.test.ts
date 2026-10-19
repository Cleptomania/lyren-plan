// TrustedMeta on the wire (core/meta.ts): the x-lyren-meta header the Worker sets for the DOs.

import { describe, expect, it } from 'vitest';
import { decodeMeta, encodeMeta, META_HEADER } from '../src/core/meta';
import type { TrustedMeta } from '../src/core/ports';

const META: TrustedMeta = {
  clientIp: '2001:db8::1',
  secure: true,
  requestId: '6f1c1e3e-4c55-4a0e-9a59-6a1d1d9e0b2a',
  userAgent: 'Mozilla/5.0 (Ärger; ΟΔΟΣ)',
  sessionTokenHash: 'ab'.repeat(32),
  sessionCookie: 'host',
};

/** base64url of any JSON value, as the Worker would encode it. */
const encodeRaw = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('TrustedMeta header', () => {
  it('round-trips as base64url JSON', () => {
    expect(META_HEADER).toBe('x-lyren-meta');
    const header = encodeMeta(META);
    expect(header).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeMeta(header)).toEqual(META);
    const directory: TrustedMeta = { ...META, clientIp: '', userAgent: null, sessionTokenHash: null, sessionCookie: null };
    expect(decodeMeta(encodeMeta(directory))).toEqual(directory);
  });

  it('refuses anything that is not exactly a valid TrustedMeta', () => {
    for (const value of [undefined, null, '', 'not base64!', 'x'.repeat(3000), Buffer.from('{').toString('base64url')]) {
      expect(decodeMeta(value)).toBeNull();
    }
    const invalid: unknown[] = [
      [],
      { ...META, extra: 1 },
      { ...META, secure: 'yes' },
      { ...META, requestId: '' },
      { ...META, clientIp: 1 },
      { ...META, userAgent: 'u'.repeat(301) },
      { ...META, sessionTokenHash: 'AB'.repeat(32) },
      { ...META, sessionCookie: 'other' },
      { ...META, sessionCookie: null },
      { ...META, sessionTokenHash: null },
    ];
    for (const value of invalid) expect(decodeMeta(encodeRaw(value)), JSON.stringify(value)).toBeNull();
    const { requestId: _, ...missing } = META;
    expect(decodeMeta(encodeRaw(missing))).toBeNull();
    expect(() => encodeMeta({ ...META, sessionCookie: null })).toThrow('Invalid TrustedMeta');
  });
});
