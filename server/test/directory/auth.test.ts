// /api/auth on the directory app (design §5.8.1, §5.8.2, §5.8.15, §5.4.1): status, first-run setup
// with the lazy setup code and the instance's password minimum, login by email and by legacy
// username, failure padding, the hash queue, a password change during a sign-in's check, logout, and
// the session cookie's names.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthStatusDTO } from '@shared/types';
import { sha256Hex } from '../../src/core/crypto';
import { PasswordHasher } from '../../src/directory/passwords';
import { createDirectoryHarness, OWNER_EMAIL, PASSWORD } from '../support/directoryHarness';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Hold the answer of the next password check until `release()`: the check itself runs against the hash
 * read before it, and `checking` resolves once it has begun. Later checks run as usual.
 */
function holdNextVerify() {
  const verify = PasswordHasher.prototype.verify;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let begun!: () => void;
  const checking = new Promise<void>((resolve) => {
    begun = resolve;
  });
  let held = false;
  vi.spyOn(PasswordHasher.prototype, 'verify').mockImplementation(function (this: PasswordHasher, password, stored) {
    const result = verify.call(this, password, stored);
    if (held) return result;
    held = true;
    begun();
    return released.then(() => result);
  });
  return { checking, release };
}

describe('GET /api/auth/status', () => {
  it('reports setup, the instance and no user before the first account', async () => {
    const h = createDirectoryHarness();
    const res = await h.client().get<AuthStatusDTO>('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body).toMatchObject({
      setupRequired: true,
      setupCodeRequired: true,
      user: null,
      spaces: [],
      preferences: null,
      reauthUntil: null,
      notices: [],
      legacySpaceId: null,
      instance: {
        name: 'Lyren Plan',
        runtime: 'node',
        signupPolicy: 'invite_only',
        mail: true,
        mailLinks: true,
        passkeys: { enabled: false, origin: null, rpId: null },
        passwordMinLength: 8,
        features: { backupDownload: false, recovery: false },
        shareOrigins: [],
        limits: { importMaxBytes: 50 * 1024 * 1024, importMaxRowWrites: null, maxSpacesPerUser: null },
      },
    });
    expect(res.body).not.toHaveProperty('desktop');
  });

  it('signed in: the user, spaces, preferences and the re-auth window', async () => {
    const h = createDirectoryHarness();
    const { client, spaceId } = await h.setup();
    const res = await client.get<AuthStatusDTO>('/api/auth/status');
    expect(res.body.setupRequired).toBe(false);
    expect(res.body.user).toMatchObject({ email: OWNER_EMAIL, username: null, emailVerified: false, isInstanceAdmin: true, hasPassword: true, passkeyCount: 0 });
    expect(res.body.spaces).toEqual([
      { id: spaceId, name: "Owner's space", role: 'owner', status: 'active', memberCount: 1, createdAt: expect.any(String) },
    ]);
    expect(res.body.preferences).toEqual({ weekStartsOn: 1, homePage: 'dashboard' });
    expect(res.body.reauthUntil).toBe(new Date(h.clock.now() + 10 * 60_000).toISOString());
    h.clock.advance(11 * 60_000);
    expect((await client.get<AuthStatusDTO>('/api/auth/status')).body.reauthUntil).toBeNull();
  });

  it('desktop app: the app DTO for everyone, the data folder for instance admins only', async () => {
    const app = { exe: 'lyren-plan.exe', windows: true };
    const data = { ...app, dataDir: 'C:\\data', dbPath: null, customDataDir: false, exeFolder: null };
    const h = createDirectoryHarness({ desktop: { app, data: () => data } });
    expect((await h.client().get('/api/auth/status')).body).toMatchObject({ desktop: app });
    expect((await h.client().get('/api/auth/status')).body).not.toHaveProperty('desktopData');
    const { client, spaceId } = await h.setup();
    expect((await client.get('/api/auth/status')).body).toMatchObject({ desktop: app, desktopData: data });
    const member = await h.addUser({ email: 'member@example.com', spaceId });
    expect((await member.client.get('/api/auth/status')).body).not.toHaveProperty('desktopData');
  });
});

describe('POST /api/auth/setup', () => {
  const body = (extra: Record<string, unknown> = {}) => ({ email: OWNER_EMAIL, password: PASSWORD, displayName: 'Owner', ...extra });

  it('needs the setup code, generated lazily and announced once', async () => {
    const h = createDirectoryHarness();
    expect(h.setupCodes).toEqual([]);
    await h.client().get('/api/auth/status');
    expect(h.setupCodes).toHaveLength(1);
    await h.client().get('/api/auth/status');
    expect(h.setupCodes).toHaveLength(1);
    const code = h.setupCodes[0]!;
    expect(code).toMatch(/^[0-9a-f]{12}$/);
    expect((await h.client().post('/api/auth/setup', body())).status).toBe(403);
    expect((await h.client().post('/api/auth/setup', body({ setupCode: 'nope' }))).body.error.message).toBe('Invalid setup code');
    const ok = await h.client().post('/api/auth/setup', body({ setupCode: ` ${code} ` }));
    expect(ok.status).toBe(201);
    expect(ok.body.user).toMatchObject({ email: OWNER_EMAIL, displayName: 'Owner', isInstanceAdmin: true });
    expect(h.service.ensureSetupCode()).toBeNull();
  });

  it('uses SETUP_TOKEN when set, and never generates a code then', async () => {
    const h = createDirectoryHarness({ vars: { SETUP_TOKEN: 'my-setup-code' } });
    await h.client().get('/api/auth/status');
    expect(h.setupCodes).toEqual([]);
    expect(h.service.ensureSetupCode()).toEqual({ code: 'my-setup-code', generated: false });
    expect((await h.client().post('/api/auth/setup', body({ setupCode: 'other' }))).status).toBe(403);
    expect((await h.client().post('/api/auth/setup', body({ setupCode: 'my-setup-code' }))).status).toBe(201);
  });

  it('with the users row removed under a running app, setup without a code answers 403 and a new code is printed', async () => {
    const h = createDirectoryHarness();
    await h.setup();
    expect(h.setupCodes).toEqual([]); // the stack showed the code at start; none is in memory now
    h.db.exec('DELETE FROM users');
    const res = await h.client().post('/api/auth/setup', body());
    expect(res.status).toBe(403);
    expect(h.setupCodes).toHaveLength(1);
  });

  it('creates the admin, the default space through SpaceAdminClient.init, the session and device cookies', async () => {
    const h = createDirectoryHarness();
    const { client, user, spaceId } = await h.setup({ createSampleData: true });
    expect(client.jar.has('lyren_session')).toBe(true);
    expect(client.jar.has('lyren_device')).toBe(true);
    expect(h.spaces.calls).toEqual([
      {
        op: 'init',
        spaceId,
        init: { spaceId, name: "Owner's space", owner: { userId: user.id, displayName: 'Owner', email: OWNER_EMAIL }, syncVersion: 1, sampleData: {} },
      },
    ]);
    const session = h.db.get<{ auth_method: string; reauth_at: string; created_at: string }>('SELECT * FROM sessions')!;
    expect(session.auth_method).toBe('setup');
    expect(session.reauth_at).toBe(session.created_at);
    expect(h.db.get('SELECT type, data FROM security_events')).toEqual({ type: 'account_created', data: '{"authMethod":"setup"}' });
    expect(h.db.all('SELECT role FROM memberships')).toEqual([{ role: 'owner' }]);
    expect(h.db.all('SELECT user_id FROM space_people')).toEqual([{ user_id: user.id }]);
  });

  it('refuses a second setup with 409 before checking the code', async () => {
    const h = createDirectoryHarness();
    await h.setup();
    const again = await h.client().post('/api/auth/setup', body({ email: 'other@example.com', setupCode: 'whatever' }));
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe('Setup has already been completed');
  });

  it('checks the password against the seeded minimum, and the address', async () => {
    const h = createDirectoryHarness({ config: { setupCodeDisabled: true }, vars: { PASSWORD_MIN_LENGTH: '12' } });
    const short = await h.client().post('/api/auth/setup', body({ password: 'elevenchars' }));
    expect(short.status).toBe(400);
    expect(short.body.error.details).toEqual([{ path: 'password', message: 'At least 12 characters' }]);
    const bad = await h.client().post('/api/auth/setup', body({ email: 'not-an-address' }));
    expect(bad.body.error.details).toEqual([{ path: 'email', message: 'Enter a valid email address' }]);
    expect((await h.client().get('/api/auth/status')).body.instance.passwordMinLength).toBe(12);
  });

  it('follows the stored policy; the seed only matters when the directory is created', async () => {
    const h = createDirectoryHarness({ vars: { SIGNUP_POLICY: 'closed' } });
    expect((await h.client().get('/api/auth/status')).body.instance.signupPolicy).toBe('closed');
    // Setup works under every policy (§5.3).
    await h.setup();
    const later = h.restart({ vars: { SIGNUP_POLICY: 'invite_only' } });
    expect((await later.client().get('/api/auth/status')).body.instance.signupPolicy).toBe('closed');
  });

  it('SIGNUP_POLICY=open without mail is seeded invite_only, and warned about only when seeded', async () => {
    const h = createDirectoryHarness({ vars: { SIGNUP_POLICY: 'open' } });
    expect(h.service.startupWarnings).toEqual(['SIGNUP_POLICY=open needs a mail transport (MAIL_TRANSPORT); using invite_only']);
    expect((await h.client().get('/api/auth/status')).body.instance.signupPolicy).toBe('invite_only');
    expect(h.restart().service.startupWarnings).toEqual([]);
  });

  it('counts wrong setup codes on li:<ip>: the 11th attempt answers 429', async () => {
    const h = createDirectoryHarness();
    for (let i = 0; i < 10; i++) expect((await h.client().post('/api/auth/setup', body({ setupCode: 'x' }))).status).toBe(403);
    const blocked = await h.client().post('/api/auth/setup', body({ setupCode: h.service.ensureSetupCode()!.code }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await h.client({ ip: '198.51.100.7' }).post('/api/auth/setup', body({ setupCode: h.service.ensureSetupCode()!.code }))).status).toBe(201);
  });

  it('keeps the account without a default space when the space cannot be created', async () => {
    const h = createDirectoryHarness();
    h.spaces.failInit = true;
    const c = h.client();
    const res = await c.post('/api/auth/setup', body({ setupCode: h.service.ensureSetupCode()!.code }));
    expect(res.status).toBe(201);
    expect(h.db.all('SELECT id FROM spaces')).toEqual([]);
    await h.settle();
    expect(h.spaces.ids('destroy')).toEqual(h.spaces.ids('init'));
    expect((await c.get<AuthStatusDTO>('/api/auth/status')).body.spaces).toEqual([]);
  });
});

describe('POST /api/auth/login', () => {
  it('signs in by email, case-insensitively, and replaces the previous session', async () => {
    const h = createDirectoryHarness();
    await h.setup();
    const c = h.client();
    const ok = await c.post('/api/auth/login', { identifier: 'Owner@EXAMPLE.com', password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.user.email).toBe(OWNER_EMAIL);
    const first = c.jar.get('lyren_session')!;
    expect((await c.post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD })).status).toBe(200);
    expect(c.jar.get('lyren_session')).not.toBe(first);
    expect(h.db.get('SELECT 1 AS found FROM sessions WHERE token_hash = :h', { h: sha256Hex(first) })).toBeUndefined();
    const session = h.db.get<{ auth_method: string }>('SELECT auth_method FROM sessions WHERE token_hash = :h', { h: sha256Hex(c.jar.get('lyren_session')!) });
    expect(session?.auth_method).toBe('password');
    expect(h.db.get<{ last_login_at: string }>('SELECT last_login_at FROM users')!.last_login_at).toBe(new Date(h.clock.now()).toISOString());
  });

  it('signs in a legacy account by username (any case), also with the old { username } body', async () => {
    const h = createDirectoryHarness();
    await h.setup();
    const legacy = await h.addUser({ email: 'legacy@example.com' });
    h.db.run("UPDATE users SET email = NULL, email_key = NULL, username = 'alice' WHERE id = :id", { id: legacy.user.id });
    expect((await h.client().post('/api/auth/login', { identifier: 'ALICE', password: PASSWORD })).status).toBe(200);
    const old = await h.client().post('/api/auth/login', { username: 'alice', password: PASSWORD });
    expect(old.status).toBe(200);
    expect(old.body.user).toMatchObject({ username: 'alice', email: null });
  });

  it('answers one message for a wrong password and an unknown account, and records login_failed once an hour', async () => {
    const h = createDirectoryHarness();
    await h.setup();
    const c = h.client();
    const wrong = await c.post('/api/auth/login', { identifier: OWNER_EMAIL, password: 'wrong password' });
    const unknown = await c.post('/api/auth/login', { identifier: 'nobody@example.com', password: 'wrong password' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.message).toBe('Incorrect email or password');
    await c.post('/api/auth/login', { identifier: OWNER_EMAIL, password: 'wrong again' });
    expect(h.db.all("SELECT data FROM security_events WHERE type = 'login_failed'")).toEqual([{ data: '{"failures":1}' }]);
    h.clock.advance(61 * 60_000);
    await c.post('/api/auth/login', { identifier: OWNER_EMAIL, password: 'wrong again' });
    expect(h.db.all("SELECT type FROM security_events WHERE type = 'login_failed'")).toHaveLength(2);
  });

  it('pads every failure to the same floor: an unknown address and an account with an older, cheaper hash', async () => {
    // Target: scrypt p = 2; the account keeps a p = 1 hash from before (as after the PASSWORD_SCRYPT_P change).
    const old = createDirectoryHarness();
    await old.setup();
    const h = old.restart({ config: { passwordScryptP: 2 } });
    const c = h.client();
    h.clock.sleeps.length = 0;
    await c.post('/api/auth/login', { identifier: 'nobody@example.com', password: 'wrong password' });
    await c.post('/api/auth/login', { identifier: OWNER_EMAIL, password: 'wrong password' });
    expect(h.clock.sleeps).toHaveLength(2);
    expect(h.clock.sleeps[0]).toBeGreaterThan(0);
    // The fake clock stands still while hashing, so each waits the whole floor: the same for both.
    expect(h.clock.sleeps[1]).toBe(h.clock.sleeps[0]);
    // A successful sign-in is not padded, and rehashes to the target.
    expect((await c.post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD })).status).toBe(200);
    expect(h.clock.sleeps).toHaveLength(2);
    expect(h.db.get<{ password_hash: string }>('SELECT password_hash FROM users')!.password_hash).toMatch(/^scrypt\$16384\$8\$2\$/);
  });

  it('refuses a fifth concurrent password check with 503 and Retry-After: 5 (the hash queue)', async () => {
    const h = createDirectoryHarness();
    await h.setup();
    const attempts = Array.from({ length: 5 }, (_, i) =>
      h.client({ ip: `198.51.100.${i + 1}` }).post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD }),
    );
    const results = await Promise.all(attempts);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 503]);
    const refused = results.find((r) => r.status === 503)!;
    expect(refused.body.error).toEqual({ code: 'unavailable', message: 'Too many sign-ins at the moment. Try again in a few seconds.' });
    expect(refused.headers.get('retry-after')).toBe('5');
  });

  it('answers 403 account_disabled only after a correct password', async () => {
    const h = createDirectoryHarness();
    const { spaceId } = await h.setup();
    const { user } = await h.addUser({ email: 'member@example.com', spaceId });
    h.db.run("UPDATE users SET status = 'disabled' WHERE id = :id", { id: user.id });
    expect((await h.client().post('/api/auth/login', { identifier: 'member@example.com', password: 'nope nope' })).status).toBe(401);
    const res = await h.client().post('/api/auth/login', { identifier: 'member@example.com', password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('account_disabled');
  });

  it('blocks a client address after 10 failures (li), while another address still signs in', async () => {
    const h = createDirectoryHarness();
    await h.setup();
    const attacker = h.client({ ip: '203.0.113.5' });
    for (let i = 0; i < 10; i++) await attacker.post('/api/auth/login', { identifier: OWNER_EMAIL, password: 'nope nope' });
    const blocked = await attacker.post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
    expect((await h.client({ ip: '198.51.100.20' }).post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD })).status).toBe(200);
  });

  it('successful sign-ins do not count as failures', async () => {
    const h = createDirectoryHarness();
    await h.setup();
    const c = h.client();
    for (let i = 0; i < 12; i++) expect((await c.post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD })).status).toBe(200);
  });

  it('9 typos and then the right password: signed in, and the address is not left blocked by that success', async () => {
    const h = createDirectoryHarness();
    await h.setup();
    const ip = '198.51.100.77';
    const login = (password: string) => h.client({ ip }).post('/api/auth/login', { identifier: OWNER_EMAIL, password });
    for (let i = 0; i < 9; i++) expect((await login('nope nope')).status).toBe(401);
    // The 10th attempt reaches li's limit before its check and starts a block, which its success lifts.
    expect((await login(PASSWORD)).status).toBe(200);
    expect((await login(PASSWORD)).status).toBe(200);
    // Also for the rows alone (a restart): the block was lifted there too.
    const restarted = h.restart();
    expect((await restarted.client({ ip }).post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD })).status).toBe(200);
  });

  it('sign-ins the hash queue refuses (503) count as no failures', async () => {
    const h = createDirectoryHarness();
    await h.setup();
    const ip = '198.51.100.77';
    const login = (password: string) => h.client({ ip }).post('/api/auth/login', { identifier: OWNER_EMAIL, password });
    for (let burst = 0; burst < 3; burst++) {
      const statuses = (await Promise.all(Array.from({ length: 6 }, () => login(PASSWORD)))).map((r) => r.status);
      expect(statuses.sort()).toEqual([200, 200, 200, 200, 503, 503]);
    }
    // Nothing counted on li: the address still has all of its 10 attempts.
    for (let i = 0; i < 9; i++) expect((await login('nope nope')).status).toBe(401);
    expect((await login(PASSWORD)).status).toBe(200);
  });

  it('a sign-in whose check began before a password change fails like a wrong password: no session outlives the change', async () => {
    const h = createDirectoryHarness();
    const { client: owner } = await h.setup();
    const { checking, release } = holdNextVerify();
    const thief = h.client({ ip: '198.51.100.9' });
    const pending = thief.post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD });
    await checking;
    // The owner changes the password while the old one is being checked; that signs every other browser out.
    expect((await owner.post('/api/account/password', { currentPassword: PASSWORD, newPassword: 'a brand new password' })).status).toBe(200);
    release();
    const res = await pending;
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Incorrect email or password');
    expect(thief.jar.size).toBe(0);
    expect((await thief.get('/api/account')).status).toBe(401);
    expect(h.db.all('SELECT auth_method FROM sessions')).toEqual([{ auth_method: 'setup' }]);
    expect(h.db.all('SELECT id FROM device_tokens')).toHaveLength(1);
    expect(h.db.all("SELECT type FROM security_events WHERE type = 'login_failed'")).toHaveLength(1);
    // The new password signs in as usual.
    expect((await thief.post('/api/auth/login', { identifier: OWNER_EMAIL, password: 'a brand new password' })).status).toBe(200);
  });

  it("two sign-ins at once on an account with an older hash both succeed: the other's rehash changes no credential", async () => {
    const old = createDirectoryHarness();
    await old.setup();
    const h = old.restart({ config: { passwordScryptP: 2 } });
    const { checking, release } = holdNextVerify();
    const pending = h.client({ ip: '198.51.100.9' }).post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD });
    await checking;
    expect((await h.client().post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD })).status).toBe(200);
    expect(h.db.get<{ password_hash: string }>('SELECT password_hash FROM users')!.password_hash).toMatch(/^scrypt\$16384\$8\$2\$/);
    release();
    expect((await pending).status).toBe(200);
    expect(h.db.all("SELECT auth_method FROM sessions WHERE auth_method = 'password'")).toHaveLength(2);
  });
});

describe('POST /api/auth/logout', () => {
  it('deletes the session and expires the cookie; the device cookie stays', async () => {
    const h = createDirectoryHarness();
    const { client } = await h.setup();
    const res = await client.post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.setCookies).toEqual(['lyren_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax']);
    expect(client.jar.has('lyren_session')).toBe(false);
    expect(client.jar.has('lyren_device')).toBe(true);
    expect(h.db.all('SELECT id FROM sessions')).toEqual([]);
    expect((await client.get('/api/account')).status).toBe(401);
  });
});

describe('session cookies (§5.4.1)', () => {
  it('over plain HTTP: lyren_session only, never a __Host- cookie', async () => {
    const h = createDirectoryHarness();
    const { client } = await h.setup();
    const login = await client.post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD });
    expect(login.setCookies.some((c) => c.startsWith('__Host-'))).toBe(false);
    expect([...client.jar.keys()].sort()).toEqual(['lyren_device', 'lyren_session']);
    const logout = await client.post('/api/auth/logout');
    expect(logout.setCookies.some((c) => c.startsWith('__Host-'))).toBe(false);
  });

  it('over HTTPS: __Host-lyren_session (Secure) and the old name expired; only that name is accepted', async () => {
    const h = createDirectoryHarness();
    const { client } = await h.setup({ secure: true });
    expect([...client.jar.keys()].sort()).toEqual(['__Host-lyren_device', '__Host-lyren_session']);
    const token = client.jar.get('__Host-lyren_session')!;
    expect((await client.get('/api/account')).status).toBe(200);
    // The same token under the unprefixed name is refused on HTTPS (it is not a legacy session).
    const planted = h.client({ secure: true });
    planted.jar.set('lyren_session', token);
    expect((await planted.get('/api/account')).status).toBe(401);
    const logout = await client.post('/api/auth/logout');
    expect(logout.setCookies).toEqual([
      'lyren_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
      '__Host-lyren_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
    ]);
  });

  it('a legacy session under lyren_session on HTTPS is accepted once and re-issued as __Host-lyren_session', async () => {
    const h = createDirectoryHarness();
    const { client } = await h.setup();
    const token = client.jar.get('lyren_session')!;
    h.db.run("UPDATE sessions SET auth_method = 'legacy'");
    const browser = h.client({ secure: true });
    browser.jar.set('lyren_session', token);
    const res = await browser.get<AuthStatusDTO>('/api/auth/status');
    expect(res.body.user?.email).toBe(OWNER_EMAIL);
    expect(res.setCookies[0]).toMatch(/^__Host-lyren_session=[^;]+; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    expect(browser.jar.get('__Host-lyren_session')).toBe(token);
    expect(browser.jar.has('lyren_session')).toBe(false);
  });

  it('slides the expiry at most hourly and re-issues the cookie when it does', async () => {
    const h = createDirectoryHarness();
    const { client } = await h.setup();
    expect((await client.get('/api/auth/status')).setCookies).toEqual([]);
    h.clock.advance(61 * 60_000);
    const touched = await client.get('/api/auth/status');
    expect(touched.setCookies).toHaveLength(1);
    const { expires_at } = h.db.get<{ expires_at: string }>('SELECT expires_at FROM sessions')!;
    expect(expires_at).toBe(new Date(h.clock.now() + 30 * 86_400_000).toISOString());
  });

  it('caps the session at SESSION_MAX_DAYS', async () => {
    const h = createDirectoryHarness({ vars: { SESSION_MAX_DAYS: '2', SESSION_TTL_DAYS: '30' } });
    const { client } = await h.setup();
    const { expires_at, absolute_expires_at } = h.db.get<{ expires_at: string; absolute_expires_at: string }>('SELECT * FROM sessions')!;
    expect(absolute_expires_at).toBe(new Date(h.clock.now() + 2 * 86_400_000).toISOString());
    expect(expires_at).toBe(absolute_expires_at);
    h.clock.advance(2 * 86_400_000);
    expect((await client.get('/api/account')).status).toBe(401);
    expect(h.db.all('SELECT id FROM sessions')).toEqual([]);
  });
});
