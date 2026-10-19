// The session cookie's names through the whole Node stack (design §5.4.1, §14.3) with COOKIE_SECURE=auto:
// whether a request was HTTPS is the gateway's decision (runtime/node/clientIp.ts: the request's own scheme,
// or X-Forwarded-Proto behind a trusted proxy), and the directory then picks the names. The directory app's
// own rules, with the request's security given, are in server/test/directory/auth.test.ts ("session cookies
// (§5.4.1)": plain HTTP, HTTPS, a legacy session re-issued, the sliding expiry and SESSION_MAX_DAYS).

import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE, SESSION_COOKIE_SECURE } from '@shared/constants';
import type { AuthStatusDTO } from '@shared/types';
import { createTestContext } from './helpers';
import { OWNER_EMAIL, PASSWORD } from './support/directoryHarness';

const HTTPS = 'https://plan.example.com';
const hostCookies = (headers: Headers) => headers.getSetCookie().filter((c) => c.startsWith('__Host-'));

describe('COOKIE_SECURE=auto', () => {
  it('over plain HTTP, setup, login and logout never emit a __Host- cookie', async () => {
    const ctx = createTestContext({ cookieSecure: 'auto' });
    const client = ctx.client();
    const setup = await client.post('/api/auth/setup', { email: OWNER_EMAIL, password: PASSWORD, displayName: 'Owner', setupCode: ctx.setupCode() });
    expect(setup.status).toBe(201);
    expect(hostCookies(setup.headers)).toEqual([]);
    const login = await client.post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(hostCookies(login.headers)).toEqual([]);
    expect(login.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`) && !/; Secure/.test(c))).toBe(true);
    const logout = await client.post('/api/auth/logout');
    expect(logout.status).toBe(200);
    expect(hostCookies(logout.headers)).toEqual([]);
  });

  it('over HTTPS only the __Host- name is accepted; a legacy session under the old name is re-issued', async () => {
    const ctx = createTestContext({ cookieSecure: 'auto' });
    const browser = ctx.client();
    const setup = await browser.request('POST', `${HTTPS}/api/auth/setup`, {
      email: OWNER_EMAIL,
      password: PASSWORD,
      displayName: 'Owner',
      setupCode: ctx.setupCode(),
    });
    expect(setup.status).toBe(201);
    expect(browser.jar.has(SESSION_COOKIE_SECURE)).toBe(true);
    const token = browser.jar.get(SESSION_COOKIE_SECURE)!;
    expect((await browser.request('GET', `${HTTPS}/api/account`)).status).toBe(200);
    // The same token under the unprefixed name: refused over HTTPS, as it is not a legacy session.
    const planted = ctx.client(`${SESSION_COOKIE}=${token}`);
    expect((await planted.request('GET', `${HTTPS}/api/account`)).status).toBe(401);
    // A session the 1.x upgrade carried over (auth_method 'legacy') is accepted once and re-issued.
    ctx.directoryDb.run("UPDATE sessions SET auth_method = 'legacy'");
    const old = ctx.client(`${SESSION_COOKIE}=${token}`);
    const status = await old.request<AuthStatusDTO>('GET', `${HTTPS}/api/auth/status`);
    expect(status.body.user?.email).toBe(OWNER_EMAIL);
    expect(old.jar.get(SESSION_COOKIE_SECURE)).toBe(token);
    expect(old.jar.has(SESSION_COOKIE)).toBe(false);
  });

  it('behind a trusted proxy, X-Forwarded-Proto decides', async () => {
    const ctx = createTestContext({ cookieSecure: 'auto', trustProxy: true });
    const client = ctx.client();
    const setup = await client.request(
      'POST',
      '/api/auth/setup',
      { email: OWNER_EMAIL, password: PASSWORD, displayName: 'Owner', setupCode: ctx.setupCode() },
      { 'X-Forwarded-Proto': 'https' },
    );
    expect(setup.status).toBe(201);
    expect(hostCookies(setup.headers).map((c) => c.split('=')[0])).toContain(SESSION_COOKIE_SECURE);
    const plain = await ctx.client().request('POST', '/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD }, { 'X-Forwarded-Proto': 'http' });
    expect(plain.status).toBe(200);
    expect(hostCookies(plain.headers)).toEqual([]);
  });
});
