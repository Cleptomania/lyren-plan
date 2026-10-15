import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@shared/schemas';
import type { BootstrapDTO } from '@shared/types';
import { createTestContext } from './helpers';

async function setup() {
  const ctx = createTestContext();
  const { client } = await ctx.signedIn();
  const defaultBoard = ctx.db.get<{ id: number }>("SELECT id FROM boards WHERE name = 'All tasks'")!.id;
  return { ...ctx, client, defaultBoard };
}

describe('settings API', () => {
  it('returns the defaults merged with stored values (never internal keys)', async () => {
    const { client, defaultBoard } = await setup();
    const res = await client.get<Settings>('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...DEFAULT_SETTINGS, defaultBoardId: defaultBoard });
    expect(Object.keys(res.body).some((k) => k.startsWith('_'))).toBe(false);
  });

  it('patches individual keys and persists them', async () => {
    const { client, defaultBoard } = await setup();
    const res = await client.patch<Settings>('/api/settings', { weekStartsOn: 0, estimateUnit: 'hours' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ weekStartsOn: 0, estimateUnit: 'hours', defaultBoardId: defaultBoard, homePage: 'dashboard' });

    await client.patch('/api/settings', { homePage: 'default_board' });
    const boot = (await client.get<BootstrapDTO>('/api/bootstrap')).body;
    expect(boot.settings).toEqual({ weekStartsOn: 0, estimateUnit: 'hours', defaultBoardId: defaultBoard, homePage: 'default_board' });

    const cleared = await client.patch<Settings>('/api/settings', { defaultBoardId: null });
    expect(cleared.body.defaultBoardId).toBeNull();
    expect((await client.get<Settings>('/api/settings')).body.defaultBoardId).toBeNull();

    // An empty patch is a no-op.
    expect((await client.patch<Settings>('/api/settings', {})).body).toEqual(cleared.body);
  });

  it('validates values and that the default board exists', async () => {
    const { client, defaultBoard } = await setup();
    const missing = await client.patch('/api/settings', { defaultBoardId: 999 });
    expect(missing.status).toBe(400);
    expect(missing.body.error.details[0].path).toBe('defaultBoardId');
    expect((await client.patch('/api/settings', { weekStartsOn: 3 })).status).toBe(400);
    expect((await client.patch('/api/settings', { estimateUnit: 'days' })).status).toBe(400);
    expect((await client.patch('/api/settings', { homePage: 'boards' })).status).toBe(400);
    expect((await client.patch('/api/settings', { defaultBoardId: 'x' })).status).toBe(400);
    // Nothing changed.
    expect((await client.get<Settings>('/api/settings')).body).toEqual({ ...DEFAULT_SETTINGS, defaultBoardId: defaultBoard });
  });

  it('requires a session', async () => {
    const { app } = await setup();
    expect((await app.request('/api/settings')).status).toBe(401);
  });
});
