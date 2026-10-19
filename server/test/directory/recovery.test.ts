// Operator recovery (design §5.8.19): POST /api/auth/recover with RECOVERY_TOKEN. Unset, the endpoint
// answers 404 as an unknown one does. A wrong token counts on li:<ip> and ln:<net> (403); the right token
// with an unknown identifier is 404; otherwise a reset link that works for 24 hours, and the account
// becomes an (active) instance admin when no active admin is left. The event recovery_used is the
// account's notice; with mail a notice follows. The configuration's checks of the token are in
// core.config.test.ts.

import { describe, expect, it } from 'vitest';
import type { AuthStatusDTO, RecoveryLinkDTO } from '@shared/types';
import { createDirectoryHarness, OWNER_EMAIL, PASSWORD } from '../support/directoryHarness';
import { tokenOfLink } from '../support/mail';

const RECOVERY_TOKEN = 'recovery-token-for-the-tests-0123456789';
const PUBLIC = { PUBLIC_URL: 'https://plan.example.com' };

/** An instance with RECOVERY_TOKEN set to `token` (null: not set). */
async function instance(token: string | null = RECOVERY_TOKEN) {
  const h = createDirectoryHarness({ vars: { ...PUBLIC, ...(token === null ? {} : { RECOVERY_TOKEN: token }) } });
  const owner = await h.setup();
  h.db.run('UPDATE users SET email_verified_at = :now', { now: new Date(h.clock.now()).toISOString() });
  await h.settle();
  h.outbox.length = 0;
  return { h, owner };
}

describe('POST /api/auth/recover', () => {
  it('answers 404 while RECOVERY_TOKEN is unset (or empty), as a path that does not exist', async () => {
    for (const token of [null, '']) {
      const { h } = await instance(token);
      expect((await h.client().get('/api/auth/status')).body.instance.features.recovery).toBe(false);
      const res = await h.client().post('/api/auth/recover', { token: RECOVERY_TOKEN, identifier: OWNER_EMAIL });
      expect(res).toMatchObject({ status: 404, body: { error: { code: 'not_found', message: 'Not found' } } });
      expect(await h.client().post('/api/auth/nowhere', {})).toMatchObject({ status: 404, body: { error: { code: 'not_found', message: 'Not found' } } });
    }
  });

  it('a wrong token is 403 and counts on li and ln: the client is then refused, the right token included', async () => {
    const { h } = await instance();
    expect((await h.client().get('/api/auth/status')).body.instance.features.recovery).toBe(true);
    const attacker = h.client({ ip: '203.0.113.50' });
    for (const token of ['wrong', RECOVERY_TOKEN.slice(0, -1), `${RECOVERY_TOKEN}x`]) {
      expect(await attacker.post('/api/auth/recover', { token, identifier: OWNER_EMAIL })).toMatchObject({
        status: 403,
        body: { error: { code: 'forbidden', message: 'Invalid recovery token' } },
      });
    }
    for (let i = 0; i < 7; i++) await attacker.post('/api/auth/recover', { token: 'wrong', identifier: OWNER_EMAIL });
    const blocked = await attacker.post('/api/auth/recover', { token: RECOVERY_TOKEN, identifier: OWNER_EMAIL });
    expect(blocked).toMatchObject({ status: 429, body: { error: { code: 'rate_limited' } } });
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
    // Another network is not affected.
    expect((await h.client({ ip: '198.51.100.150' }).post('/api/auth/recover', { token: RECOVERY_TOKEN, identifier: OWNER_EMAIL })).status).toBe(200);
    expect(h.db.all<{ key: string }>("SELECT key FROM auth_throttle WHERE key LIKE 'l%' ORDER BY key").map((r) => r.key)).toEqual([
      'li:203.0.113.50',
      'ln:203.0.113.0/24',
    ]);
  });

  it('the right token: a 24-hour reset link (an unknown account is 404); the event is the account’s notice, and mailed', async () => {
    const { h, owner } = await instance();
    expect(await h.client().post('/api/auth/recover', { token: RECOVERY_TOKEN, identifier: 'nobody@example.com' })).toMatchObject({
      status: 404,
      body: { error: { code: 'not_found' } },
    });
    const res = await h.client().post<RecoveryLinkDTO>('/api/auth/recover', { token: RECOVERY_TOKEN, identifier: ' Owner@Example.com ' });
    expect(res.status).toBe(200);
    expect(res.body.link).toMatch(/^https:\/\/plan\.example\.com\/reset#t=[A-Za-z0-9_-]{43}$/);
    expect(res.body.madeAdmin).toBe(false);
    expect(Date.parse(res.body.expiresAt) - h.clock.now()).toBe(24 * 3600_000);
    expect(h.db.get<{ issued_by: number | null }>('SELECT issued_by FROM email_tokens')!.issued_by).toBeNull();
    const event = h.db.get<{ user_id: number; actor_id: number | null; data: string }>("SELECT * FROM security_events WHERE type = 'recovery_used'")!;
    expect(event).toEqual({ ...event, user_id: owner.user.id, actor_id: null, data: '{"madeAdmin":false,"displayName":"Owner"}' });
    await h.settle();
    expect(h.outbox.map((m) => [m.template, m.to])).toEqual([['recovery_used', OWNER_EMAIL]]);
    expect(h.outbox[0]!.text).not.toContain('#t=');

    const token = tokenOfLink(res.body.link);
    h.clock.advance(23 * 3600_000);
    expect((await h.client().post('/api/auth/password/reset', { token, password: 'recovered password' })).status).toBe(200);
    const browser = h.client();
    expect((await browser.post('/api/auth/login', { identifier: OWNER_EMAIL, password: 'recovered password' })).status).toBe(200);
    expect((await browser.get<AuthStatusDTO>('/api/auth/status')).body.notices).toMatchObject([{ type: 'recovery_used', actorName: null }]);
  });

  it('when no active instance admin is left, the recovered account becomes one (and active); a username works too', async () => {
    const { h, owner } = await instance();
    const legacy = await h.addUser({ email: 'legacy@example.com' });
    h.db.run("UPDATE users SET email = NULL, email_key = NULL, username = 'oldtimer', status = 'disabled' WHERE id = :id", { id: legacy.user.id });
    h.db.run("UPDATE users SET status = 'disabled' WHERE id = :id", { id: owner.user.id });
    const res = await h.client().post<RecoveryLinkDTO>('/api/auth/recover', { token: RECOVERY_TOKEN, identifier: 'OldTimer' });
    expect(res.status).toBe(200);
    const row = h.db.get<{ is_instance_admin: number; status: string }>('SELECT * FROM users WHERE id = :id', { id: legacy.user.id })!;
    expect(row).toMatchObject({ is_instance_admin: 1, status: 'active' });
    expect(res.body.madeAdmin).toBe(true);
    expect(h.db.get<{ data: string }>("SELECT data FROM security_events WHERE type = 'recovery_used'")!.data).toBe('{"madeAdmin":true,"displayName":"legacy"}');
    expect((await h.client().post('/api/auth/password/reset', { token: tokenOfLink(res.body.link), password: 'recovered password' })).status).toBe(200);
    const browser = h.client();
    expect((await browser.post('/api/auth/login', { identifier: 'oldtimer', password: 'recovered password' })).status).toBe(200);
    expect((await browser.get<AuthStatusDTO>('/api/auth/status')).body.user?.isInstanceAdmin).toBe(true);
    // With an active admin again, a second recovery promotes nobody.
    const other = await h.addUser({ email: 'other@example.com' });
    await h.client().post('/api/auth/recover', { token: RECOVERY_TOKEN, identifier: 'other@example.com' });
    expect(h.db.get<{ is_instance_admin: number }>('SELECT is_instance_admin FROM users WHERE id = :id', { id: other.user.id })!.is_instance_admin).toBe(0);
    expect((await h.client().post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD })).status).toBe(403);
  });
});
