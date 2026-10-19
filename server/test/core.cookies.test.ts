// Session cookie naming, attributes and reading (core/cookies.ts, design §5.4.1).

import { describe, expect, it } from 'vitest';
import {
  expiredSessionCookies,
  readSessionToken,
  sessionCookieName,
  sessionCookies,
  sessionMaxAge,
} from '../src/core/cookies';

const TOKEN = 'a'.repeat(43);
const OTHER = 'b'.repeat(43);

describe('session cookie', () => {
  it('is __Host-lyren_session on HTTPS and lyren_session otherwise', () => {
    expect(sessionCookieName(true)).toBe('__Host-lyren_session');
    expect(sessionCookieName(false)).toBe('lyren_session');
  });

  it('over plain HTTP sets lyren_session only, and never a __Host- cookie', () => {
    expect(sessionCookies(TOKEN, { secure: false, maxAge: 2_592_000 })).toEqual([
      `lyren_session=${TOKEN}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax`,
    ]);
    expect(expiredSessionCookies(false)).toEqual(['lyren_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax']);
  });

  it('over HTTPS sets __Host-lyren_session and expires lyren_session', () => {
    expect(sessionCookies(TOKEN, { secure: true, maxAge: 60 })).toEqual([
      `__Host-lyren_session=${TOKEN}; Max-Age=60; Path=/; HttpOnly; Secure; SameSite=Lax`,
      'lyren_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
    ]);
    expect(expiredSessionCookies(true)).toEqual([
      'lyren_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
      '__Host-lyren_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
    ]);
  });

  it('lives SESSION_TTL_DAYS, capped by the absolute expiry', () => {
    const now = Date.parse('2026-10-17T12:00:00.000Z');
    expect(sessionMaxAge(30, now, null)).toBe(2_592_000);
    expect(sessionMaxAge(30, now, '2026-10-18T12:00:00.000Z')).toBe(86_400);
    expect(sessionMaxAge(1, now, '2026-12-31T00:00:00.000Z')).toBe(86_400);
    expect(sessionMaxAge(30, now, '2026-10-01T00:00:00.000Z')).toBe(0);
  });
});

describe('readSessionToken', () => {
  it('reads lyren_session only on insecure requests', () => {
    expect(readSessionToken(`lyren_session=${TOKEN}`, false)).toEqual({ token: TOKEN, source: 'plain' });
    expect(readSessionToken(`__Host-lyren_session=${TOKEN}`, false)).toBeNull();
  });

  it('on secure requests prefers __Host-lyren_session; Node falls back to lyren_session as "plain"', () => {
    const both = `lyren_session=${OTHER}; __Host-lyren_session=${TOKEN}`;
    expect(readSessionToken(both, true)).toEqual({ token: TOKEN, source: 'host' });
    expect(readSessionToken(`theme=dark; lyren_session=${OTHER}`, true)).toEqual({ token: OTHER, source: 'plain' });
  });

  it('on secure Cloudflare requests reads __Host-lyren_session only', () => {
    expect(readSessionToken(`__Host-lyren_session=${TOKEN}`, true, 'cloudflare')).toEqual({ token: TOKEN, source: 'host' });
    expect(readSessionToken(`lyren_session=${OTHER}`, true, 'cloudflare')).toBeNull();
    expect(readSessionToken(`lyren_session=${OTHER}`, false, 'cloudflare')).toEqual({ token: OTHER, source: 'plain' });
  });

  it('ignores empty values and values over 200 characters; the first value of a name wins', () => {
    expect(readSessionToken(null, false)).toBeNull();
    expect(readSessionToken('', true)).toBeNull();
    expect(readSessionToken('lyren_session=', false)).toBeNull();
    expect(readSessionToken(`lyren_session=${'x'.repeat(201)}`, false)).toBeNull();
    expect(readSessionToken(`__Host-lyren_session=${'x'.repeat(201)}; lyren_session=${OTHER}`, true)).toEqual({ token: OTHER, source: 'plain' });
    expect(readSessionToken(`lyren_session=${TOKEN}; lyren_session=${OTHER}`, false)).toEqual({ token: TOKEN, source: 'plain' });
    expect(readSessionToken(`lyren_session="${TOKEN}"`, false)).toEqual({ token: TOKEN, source: 'plain' });
  });
});
