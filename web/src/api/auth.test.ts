import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logoutOptions } from './auth';
import { ApiError } from './client';
import { qk } from './keys';

const USER = { id: 1, username: 'owner', displayName: 'Owner' };
const SPACE = '7k2m9q4w8x1c3v5b';
const STATUS = { setupRequired: false, setupCodeRequired: false, user: USER, version: '1', spaces: [{ id: SPACE }], preferences: {} };

function setup(logoutResponse: () => Promise<Response>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(qk.authStatus, STATUS);
  qc.setQueryData(qk.bootstrap(SPACE), { user: USER });
  qc.setQueryData(qk.task(SPACE, 1), { id: 1 });
  qc.setQueryData(qk.sessions, [{ id: 7 }]);
  const calls: string[] = [];
  vi.stubGlobal('fetch', (url: string) => {
    calls.push(url);
    if (url === '/api/auth/logout') return logoutResponse();
    if (url === '/api/auth/status') return Promise.resolve(Response.json({ ...STATUS, user: null }));
    return Promise.reject(new TypeError('unexpected ' + url));
  });
  const observer = new MutationObserver(qc, logoutOptions(qc));
  return { qc, calls, logout: () => observer.mutate() };
}

describe('logoutOptions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('signs out: status shows no user and the previous user’s data is dropped', async () => {
    const { qc, logout } = setup(() => Promise.resolve(Response.json({ ok: true })));
    await logout();
    expect(qc.getQueryData<typeof STATUS>(qk.authStatus)).toMatchObject({ user: null, spaces: [], preferences: null });
    expect(qc.getQueryData(qk.bootstrap(SPACE))).toBeUndefined();
    expect(qc.getQueryData(qk.task(SPACE, 1))).toBeUndefined();
    expect(qc.getQueryData(qk.sessions)).toBeUndefined();
  });

  it('treats a 401 (session already gone) as signed out', async () => {
    const { qc, logout } = setup(() => Promise.resolve(Response.json({ error: { code: 'unauthorized', message: 'x' } }, { status: 401 })));
    await logout();
    expect(qc.getQueryData<typeof STATUS>(qk.authStatus)?.user).toBeNull();
    expect(qc.getQueryData(qk.bootstrap(SPACE))).toBeUndefined();
  });

  it.each([
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a 502 from a proxy', () => Promise.resolve(new Response('bad gateway', { status: 502 }))],
  ])('leaves the cache alone on %s and fails at once', async (_name, response) => {
    const { qc, calls, logout } = setup(response);
    await expect(logout()).rejects.toBeInstanceOf(ApiError);
    // Still signed in with all data: the pages keep working and the caller shows the error.
    expect(qc.getQueryData(qk.authStatus)).toEqual(STATUS);
    expect(qc.getQueryData(qk.bootstrap(SPACE))).toEqual({ user: USER });
    expect(qc.getQueryData(qk.task(SPACE, 1))).toEqual({ id: 1 });
    expect(calls).toEqual(['/api/auth/logout']);
  });
});
