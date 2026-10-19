import { describe, expect, it } from 'vitest';
import { generateSpaceId, isSpaceId, SPACE_ID_ALPHABET, SPACE_ID_RE } from './ids';

describe('space ids', () => {
  it('encode 10 bytes as 16 characters of lower-case Crockford base32', () => {
    expect(SPACE_ID_ALPHABET).toHaveLength(32);
    expect(new Set(SPACE_ID_ALPHABET).size).toBe(32);
    expect(SPACE_ID_ALPHABET).not.toMatch(/[ilou]/);
    expect(generateSpaceId(new Uint8Array(10))).toBe('0000000000000000');
    expect(generateSpaceId(new Uint8Array(10).fill(0xff))).toBe('zzzzzzzzzzzzzzzz');
    expect(generateSpaceId(Uint8Array.from([0x80, 0, 0, 0, 0, 0, 0, 0, 0, 1]))).toBe('g000000000000001');
    expect(() => generateSpaceId(new Uint8Array(9))).toThrow('exactly 10 bytes');
  });

  it('are random and match SPACE_ID_RE', () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateSpaceId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(isSpaceId(id), id).toBe(true);
  });

  it('SPACE_ID_RE accepts exactly the alphabet', () => {
    for (let code = 0; code < 0x250; code++) {
      const c = String.fromCharCode(code);
      expect(SPACE_ID_RE.test(c.repeat(16)), JSON.stringify(c)).toBe(SPACE_ID_ALPHABET.includes(c));
    }
  });

  it('isSpaceId refuses other lengths, upper case and non-strings', () => {
    expect(isSpaceId('7k2m9q4w8x1c3v5b')).toBe(true);
    for (const value of ['7k2m9q4w8x1c3v5', '7k2m9q4w8x1c3v5bb', '7K2M9Q4W8X1C3V5B', '7k2m9q4w8x1c3v5b\n', ' 7k2m9q4w8x1c3v5b', 42, null, undefined]) {
      expect(isSpaceId(value), JSON.stringify(value)).toBe(false);
    }
  });
});
