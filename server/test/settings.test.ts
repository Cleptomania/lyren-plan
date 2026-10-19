// §3.6: a space's settings (estimateUnit, defaultBoardId) are served by /api/s/<id>/settings; the
// per-user keys (weekStartsOn, homePage) moved to the account's preferences (/api/account/preferences,
// AuthStatusDTO.preferences).

import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, DEFAULT_SPACE_SETTINGS, type SpaceSettings, type UserPreferences } from '@shared/schemas';
import type { AuthStatusDTO, BootstrapDTO } from '@shared/types';
import { createTestContext } from './helpers';

async function setup() {
  const ctx = createTestContext();
  const { client } = await ctx.signedIn();
  const defaultBoard = ctx.db.get<{ id: number }>("SELECT id FROM boards WHERE name = 'All tasks'")!.id;
  const preferences = async () => (await client.get<AuthStatusDTO>('/api/auth/status')).body.preferences;
  return { ...ctx, client, defaultBoard, preferences };
}

describe('settings API', () => {
  it('returns the defaults merged with stored values (never internal keys)', async () => {
    const { client, defaultBoard, preferences } = await setup();
    const res = await client.get<SpaceSettings>('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...DEFAULT_SPACE_SETTINGS, defaultBoardId: defaultBoard });
    expect(Object.keys(res.body).some((k) => k.startsWith('_'))).toBe(false);
    expect(await preferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('patches individual keys and persists them', async () => {
    const { client, defaultBoard, preferences } = await setup();
    const res = await client.patch<SpaceSettings>('/api/settings', { estimateUnit: 'hours' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ estimateUnit: 'hours', defaultBoardId: defaultBoard });
    const week = await client.patch<UserPreferences>('/api/account/preferences', { weekStartsOn: 0 });
    expect(week.status).toBe(200);
    expect(week.body).toEqual({ weekStartsOn: 0, homePage: 'dashboard' });

    await client.patch('/api/account/preferences', { homePage: 'default_board' });
    const boot = (await client.get<BootstrapDTO>('/api/bootstrap')).body;
    expect(boot.settings).toEqual({ estimateUnit: 'hours', defaultBoardId: defaultBoard });
    expect(await preferences()).toEqual({ weekStartsOn: 0, homePage: 'default_board' });

    const cleared = await client.patch<SpaceSettings>('/api/settings', { defaultBoardId: null });
    expect(cleared.body.defaultBoardId).toBeNull();
    expect((await client.get<SpaceSettings>('/api/settings')).body.defaultBoardId).toBeNull();

    // An empty patch is a no-op.
    expect((await client.patch<SpaceSettings>('/api/settings', {})).body).toEqual(cleared.body);
    expect((await client.patch<UserPreferences>('/api/account/preferences', {})).body).toEqual({ weekStartsOn: 0, homePage: 'default_board' });
    // The space's settings ignore the per-user keys (unknown keys are stripped).
    expect((await client.patch<SpaceSettings>('/api/settings', { weekStartsOn: 1 })).body).toEqual(cleared.body);
    expect(await preferences()).toEqual({ weekStartsOn: 0, homePage: 'default_board' });
  });

  it('validates values and that the default board exists', async () => {
    const { client, defaultBoard, preferences } = await setup();
    const missing = await client.patch('/api/settings', { defaultBoardId: 999 });
    expect(missing.status).toBe(400);
    expect(missing.body.error.details[0].path).toBe('defaultBoardId');
    expect((await client.patch('/api/account/preferences', { weekStartsOn: 3 })).status).toBe(400);
    expect((await client.patch('/api/settings', { estimateUnit: 'days' })).status).toBe(400);
    expect((await client.patch('/api/account/preferences', { homePage: 'boards' })).status).toBe(400);
    expect((await client.patch('/api/settings', { defaultBoardId: 'x' })).status).toBe(400);
    // Nothing changed.
    expect((await client.get<SpaceSettings>('/api/settings')).body).toEqual({ ...DEFAULT_SPACE_SETTINGS, defaultBoardId: defaultBoard });
    expect(await preferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('requires a session', async () => {
    const { app, path } = await setup();
    expect((await app.request(path('/api/settings'))).status).toBe(401);
    expect((await app.request('/api/account/preferences', { method: 'PATCH', headers: { 'X-Lyren-Request': '1' } })).status).toBe(401);
  });
});
