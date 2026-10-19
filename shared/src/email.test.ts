import { describe, expect, it } from 'vitest';
import { emailSchema, normalizeEmail } from './email';

describe('normalizeEmail', () => {
  // The research cases (cf-auth/work/email-norm.mjs), whose results were identical on Node and
  // workerd, with the fix for a percent sign in the domain.
  it.each([
    ['  Alice.Smith+tag@Example.COM ', { ok: true, address: 'Alice.Smith+tag@example.com', key: 'alice.smith+tag@example.com' }],
    ['bob@bücher.example', { ok: true, address: 'bob@xn--bcher-kva.example', key: 'bob@xn--bcher-kva.example' }],
    ['BOB@XN--BCHER-KVA.EXAMPLE', { ok: true, address: 'BOB@xn--bcher-kva.example', key: 'bob@xn--bcher-kva.example' }],
    ['x@[127.0.0.1]', { ok: false, reason: 'ip literal' }],
    ['a@b', { ok: false, reason: 'domain syntax' }],
    ['a..b@example.com', { ok: false, reason: 'local part' }],
    ['"quoted"@example.com', { ok: false, reason: 'local part' }],
    ['a@example.com\r\nBcc: x@y.z', { ok: false, reason: 'whitespace/control' }],
    ['ü@example.com', { ok: false, reason: 'local part' }],
    ['a@exa_mple.com', { ok: false, reason: 'domain syntax' }],
    ['a@localhost', { ok: false, reason: 'domain syntax' }],
    ['a@123.123.123.123', { ok: false, reason: 'domain syntax' }],
    // The URL parser would percent-decode this to example.com.
    ['a@ex%41mple.com', { ok: false, reason: 'domain chars' }],
    ['a@Ｅｘａｍｐｌｅ.com', { ok: true, address: 'a@example.com', key: 'a@example.com' }],
  ])('%j', (input, expected) => {
    expect(normalizeEmail(input)).toEqual(expected);
  });

  it('keeps +tags and dots, splits at the last @, and NFC-normalizes the domain', () => {
    expect(normalizeEmail('first.last+news@example.com')).toEqual({
      ok: true,
      address: 'first.last+news@example.com',
      key: 'first.last+news@example.com',
    });
    expect(normalizeEmail('a@b@example.com')).toEqual({ ok: false, reason: 'local part' });
    // 'u' + combining diaeresis composes to 'ü' before IDNA.
    expect(normalizeEmail('bob@bücher.example')).toMatchObject({ ok: true, address: 'bob@xn--bcher-kva.example' });
    expect(normalizeEmail("o'brien!#$%&*=?^_`{|}~-@example.org")).toMatchObject({ ok: true });
  });

  it('refuses addresses without both parts, and whitespace or control characters inside', () => {
    for (const input of ['', '   ', 'plain', '@example.com', 'a@', 'a b@example.com', 'a@exa mple.com', 'a\u0000@example.com', 'a@example.com\u007f']) {
      expect(normalizeEmail(input).ok, JSON.stringify(input)).toBe(false);
    }
    expect(normalizeEmail('a@example.com\t')).toMatchObject({ ok: true }); // trimmed
    expect(normalizeEmail('a@ example.com')).toEqual({ ok: false, reason: 'whitespace/control' });
  });

  it('refuses the characters the URL parser treats specially in the domain', () => {
    for (const domain of ['ex/ample.com', 'ex\\ample.com', 'example.com?x', 'example.com#x', 'example.com:25', 'ex%2ecom']) {
      expect(normalizeEmail(`a@${domain}`), domain).toEqual({ ok: false, reason: 'domain chars' });
    }
    expect(normalizeEmail('a@[IPv6:::1]')).toEqual({ ok: false, reason: 'ip literal' });
    expect(normalizeEmail('a@xn--.com')).toMatchObject({ ok: false });
  });

  it('needs at least two labels and an alphabetic or punycode TLD', () => {
    expect(normalizeEmail('a@example.c')).toEqual({ ok: false, reason: 'domain syntax' });
    expect(normalizeEmail('a@example.123')).toMatchObject({ ok: false });
    expect(normalizeEmail('a@-example.com')).toEqual({ ok: false, reason: 'domain syntax' });
    expect(normalizeEmail('a@example.xn--p1ai')).toMatchObject({ ok: true, address: 'a@example.xn--p1ai' });
    expect(normalizeEmail('a@пример.рф')).toMatchObject({ ok: true, address: 'a@xn--e1afmkfd.xn--p1ai' });
  });

  it('limits the local part to 64 characters, a label to 63 and the address to 254', () => {
    expect(normalizeEmail(`${'a'.repeat(64)}@example.com`)).toMatchObject({ ok: true });
    expect(normalizeEmail(`${'a'.repeat(65)}@example.com`)).toEqual({ ok: false, reason: 'local part' });
    expect(normalizeEmail(`a@${'b'.repeat(63)}.com`)).toMatchObject({ ok: true });
    expect(normalizeEmail(`a@${'b'.repeat(64)}.com`)).toMatchObject({ ok: false });
    const label = 'c'.repeat(60);
    // 64 + 1 + 189 = 254 characters.
    const domain189 = `${label}.${label}.${label}.dd.com`;
    expect(domain189).toHaveLength(189);
    expect(normalizeEmail(`${'a'.repeat(64)}@${domain189}`)).toMatchObject({ ok: true });
    expect(normalizeEmail(`${'a'.repeat(64)}@x${domain189}`)).toEqual({ ok: false, reason: 'too long' });
  });
});

describe('emailSchema', () => {
  it('parses to { address, key }', () => {
    expect(emailSchema.parse(' Ann@Example.COM ')).toEqual({ address: 'Ann@example.com', key: 'ann@example.com' });
  });

  it('answers "Enter a valid email address" for invalid and overlong input', () => {
    for (const input of ['not an address', 'a@localhost', `${'a'.repeat(330)}@example.com`]) {
      const result = emailSchema.safeParse(input);
      expect(result.success, input).toBe(false);
      expect(result.error?.issues.map((i) => i.message)).toEqual(['Enter a valid email address']);
    }
    expect(emailSchema.safeParse(42).success).toBe(false);
  });
});
