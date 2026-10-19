// Instance administration through the Worker (design §5.8.18, §14.5): the overview, a settings change and a
// user disabled, on the real Worker, DirectoryDO and SpaceDOs (SELF.fetch). The rules in depth are the Node
// suites' (server/test/directory/admin*.test.ts); this proves the SQL and the pushes where a DirectoryDO runs them.

import { describe, expect, it } from 'vitest';
import type { AdminOverviewDTO, AdminSpaceDTO, AdminUserDTO, InstanceInfoDTO, Page } from '@shared/types';
import { callsOf } from './entry';
import { addAccount, inDirectory, setupOwner, WorkerClient } from './support';

describe('Administration through the Worker', () => {
  it('the overview, a settings change, a disabled account and the spaces list', async () => {
    const { client: admin, user: owner, spaceId } = await setupOwner();
    const bob = await addAccount({ email: 'bob@example.com', displayName: 'Bob', role: 'member', spaceId });

    const overview = await admin.get<AdminOverviewDTO>('/api/admin/overview');
    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({
      instance: { runtime: 'cloudflare', signupPolicy: 'invite_only', mail: false, passwordMinLength: 12 },
      counts: { users: 2, spaces: 1, sessions: 2 },
      config: { publicUrl: 'https://plan.example.com', mailTransport: 'log', sessionMaxDays: 90 },
      warnings: [],
      orphanedPasskeyAccounts: 0,
      recentAdminEvents: [],
    });
    expect(JSON.stringify(overview.body)).not.toContain('"test"');
    expect((await bob.client.get('/api/admin/overview')).status).toBe(403);

    // The policy: open needs mail, which the test Worker's log transport does not deliver.
    expect((await admin.patch('/api/admin/settings', { signupPolicy: 'open' })).body.error.code).toBe('mail_not_configured');
    const settings = await admin.patch<InstanceInfoDTO>('/api/admin/settings', { signupPolicy: 'closed', passwordMinLength: 14 });
    expect(settings).toMatchObject({ status: 200, body: { signupPolicy: 'closed', passwordMinLength: 14 } });
    expect((await new WorkerClient().get('/api/auth/status')).body.instance).toMatchObject({ signupPolicy: 'closed', passwordMinLength: 14 });

    // Disabling Bob signs him out, and his space forgets its cached session before the answer.
    expect((await bob.client.get(`/api/s/${spaceId}/bootstrap`)).status).toBe(200);
    const pushes = callsOf(spaceId).invalidate;
    const disabled = await admin.patch<AdminUserDTO>(`/api/admin/users/${bob.user.id}`, { status: 'disabled' });
    expect(disabled).toMatchObject({ status: 200, body: { id: bob.user.id, status: 'disabled' } });
    expect(callsOf(spaceId).invalidate).toBe(pushes + 1);
    expect((await bob.client.get(`/api/s/${spaceId}/bootstrap`)).status).toBe(401);
    expect((await bob.client.get('/api/account')).status).toBe(401);
    expect(await inDirectory((db) => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE user_id = :id', { id: bob.user.id })!.n)).toBe(0);
    expect((await new WorkerClient().post('/api/auth/login', { identifier: 'bob@example.com', password: 'correct horse battery' })).body.error.code).toBe(
      'account_disabled',
    );

    const users = await admin.get<Page<AdminUserDTO>>('/api/admin/users?q=BOB');
    expect(users.body.items.map((u) => [u.displayName, u.status])).toEqual([['Bob', 'disabled']]);
    const spaces = await admin.get<Page<AdminSpaceDTO>>('/api/admin/spaces');
    expect(spaces.body.items).toEqual([expect.objectContaining({ id: spaceId, memberCount: 2, owners: [{ id: owner.id, displayName: 'Owner' }], bytes: null })]);

    const events = (await admin.get<AdminOverviewDTO>('/api/admin/overview')).body.recentAdminEvents;
    expect(events.map((e) => [e.type, e.actor?.displayName, e.target])).toEqual([
      ['admin_user_disabled', 'Owner', { kind: 'user', id: bob.user.id, name: 'Bob' }],
      ['admin_settings_changed', 'Owner', null],
    ]);
  });
});
