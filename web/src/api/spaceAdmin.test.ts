// The settings split of §12.5: a patch of the merged settings goes to the space's settings and to the
// account's preferences, both caches change at once, and a failure rolls both back.

import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthStatusDTO, BootstrapDTO } from '@shared/types';
import { buildLookups } from './bootstrap';
import { qk } from './keys';
import { splitSettingsPatch, updateSettingsOptions } from './spaceAdmin';

const A = '7k2m9q4w8x1c3v5b';
const B = '0123456789abcdef';

const boot = (estimateUnit: 'points' | 'hours' = 'points') =>
  ({
    user: { id: 1, displayName: 'Owner' },
    space: { id: A, name: 'Space', role: 'owner' },
    people: [{ id: 1, displayName: 'Owner', kind: 'account', isMember: true, deleted: false }],
    settings: { estimateUnit, defaultBoardId: null },
    version: 'test',
    statuses: [],
    tags: [],
    projects: [],
    milestones: [],
    epics: [],
    boards: [],
  }) as BootstrapDTO;
const status = { user: { id: 1 }, preferences: { weekStartsOn: 1, homePage: 'dashboard' } } as unknown as AuthStatusDTO;

describe('splitSettingsPatch', () => {
  it('splits the space’s keys from the account’s, leaving out what the patch does not name', () => {
    expect(splitSettingsPatch({ estimateUnit: 'hours', weekStartsOn: 0 })).toEqual({ space: { estimateUnit: 'hours' }, preferences: { weekStartsOn: 0 } });
    expect(splitSettingsPatch({ defaultBoardId: null, homePage: 'default_board' })).toEqual({
      space: { defaultBoardId: null },
      preferences: { homePage: 'default_board' },
    });
    expect(splitSettingsPatch({ homePage: 'dashboard', estimateUnit: undefined })).toEqual({ space: null, preferences: { homePage: 'dashboard' } });
    expect(splitSettingsPatch({})).toEqual({ space: null, preferences: null });
  });
});

describe('buildLookups merges the account’s preferences into the space’s settings', () => {
  it('with the preferences’ defaults while there are none', () => {
    expect(buildLookups(boot('hours'), { weekStartsOn: 0, homePage: 'default_board' }).settings).toEqual({
      estimateUnit: 'hours',
      defaultBoardId: null,
      weekStartsOn: 0,
      homePage: 'default_board',
    });
    expect(buildLookups(boot(), null).settings).toMatchObject({ weekStartsOn: 1, homePage: 'dashboard' });
  });

  it('adds the space, its people and the role’s permissions', () => {
    const l = buildLookups({ ...boot(), space: { id: A, name: 'Space', role: 'viewer' } }, null);
    expect(l.space).toEqual({ id: A, name: 'Space', role: 'viewer' });
    expect(l.permissions.write).toBe(false);
    expect(l.personById.get(1)?.displayName).toBe('Owner');
  });
});

describe('updateSettingsOptions', () => {
  afterEach(() => vi.unstubAllGlobals());

  function harness(answer: (url: string) => Response) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    qc.setQueryData(qk.bootstrap(A), boot());
    qc.setQueryData(qk.bootstrap(B), boot());
    qc.setQueryData(qk.authStatus, status);
    const sent: Array<{ url: string; method: string; body: unknown }> = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      sent.push({ url, method: init.method ?? 'GET', body: JSON.parse(String(init.body)) });
      await gate;
      return answer(url);
    });
    const observer = new MutationObserver(qc, updateSettingsOptions(qc, A));
    return { qc, sent, release, save: (patch: Parameters<typeof observer.mutate>[0]) => observer.mutate(patch).then(() => 'ok', () => 'error') };
  }

  it('sends each part to its endpoint and applies both at once', async () => {
    const { qc, sent, release, save } = harness(() => Response.json({}));
    const done = save({ estimateUnit: 'hours', weekStartsOn: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(qc.getQueryData<BootstrapDTO>(qk.bootstrap(A))?.settings.estimateUnit).toBe('hours');
    expect(qc.getQueryData<AuthStatusDTO>(qk.authStatus)?.preferences?.weekStartsOn).toBe(0);
    // The other space's settings are its own.
    expect(qc.getQueryData<BootstrapDTO>(qk.bootstrap(B))?.settings.estimateUnit).toBe('points');
    expect(sent.map((s) => [s.method, s.url, s.body]).sort()).toEqual([
      ['PATCH', '/api/account/preferences', { weekStartsOn: 0 }],
      ['PATCH', `/api/s/${A}/settings`, { estimateUnit: 'hours' }],
    ]);
    release();
    expect(await done).toBe('ok');
  });

  it('sends only the part a patch names', async () => {
    const { sent, release, save } = harness(() => Response.json({}));
    const done = save({ homePage: 'default_board' });
    release();
    expect(await done).toBe('ok');
    expect(sent.map((s) => s.url)).toEqual(['/api/account/preferences']);
  });

  it('rolls both caches back when a request fails', async () => {
    const { qc, release, save } = harness((url) =>
      url.endsWith('/settings') ? Response.json({ error: { code: 'forbidden', message: 'Only admins and owners can do this.' } }, { status: 403 }) : Response.json({}),
    );
    const done = save({ estimateUnit: 'hours', weekStartsOn: 0 });
    await new Promise((r) => setTimeout(r, 0));
    release();
    expect(await done).toBe('error');
    expect(qc.getQueryData<BootstrapDTO>(qk.bootstrap(A))?.settings.estimateUnit).toBe('points');
    expect(qc.getQueryData<AuthStatusDTO>(qk.authStatus)?.preferences?.weekStartsOn).toBe(1);
  });
});
