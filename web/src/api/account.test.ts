// The re-auth mutation (design §12.8) as ReauthDialog uses it: the password it sends is its variables,
// and nothing may keep them once the dialog has its answer.

import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reauthPasswordOptions } from './account';
import { qk } from './keys';

const PASSWORD = 'correct horse battery staple';
const UNTIL = '2099-01-01T00:00:00.000Z';

describe('reauthPasswordOptions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['confirmed', () => Response.json({ ok: true, reauthUntil: UNTIL })],
    [
      'refused',
      () =>
        Response.json(
          { error: { code: 'validation_error', message: 'password: Wrong password', details: [{ path: 'password', message: 'Wrong password' }] } },
          { status: 400 },
        ),
    ],
  ])('once %s and reset, the password is held nowhere', async (outcome, answer) => {
    vi.stubGlobal('fetch', async () => answer());
    const qc = new QueryClient();
    qc.setQueryData(qk.authStatus, { reauthUntil: null });
    const observer = new MutationObserver(qc, reauthPasswordOptions(qc));
    // ReauthHost stays mounted, so its observer never goes away.
    const unsubscribe = observer.subscribe(() => undefined);
    await observer.mutate({ password: PASSWORD }).catch(() => undefined);
    expect(observer.getCurrentResult().variables).toEqual({ password: PASSWORD });
    // What the dialog does with every answer.
    observer.reset();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observer.getCurrentResult().variables).toBeUndefined();
    expect(qc.getMutationCache().getAll()).toEqual([]);
    expect(qc.getQueryData(qk.authStatus)).toEqual({ reauthUntil: outcome === 'confirmed' ? UNTIL : null });
    unsubscribe();
  });
});
