// Passkeys (design §5.6, §5.8.3, §5.8.13, §5.8.14): the relying party from the configuration only; adding a
// passkey (the re-auth window, at most 20, its stored fields, passkey_added and the notice), signing in with
// one (round trips for ES256, Ed25519 and RS256; the signed ceremony that writes nothing until it is used,
// once; every way an answer can be wrong; the counter; the limits co and pk and none of a password's),
// re-authentication with one, renaming and removing (the last usable credential stays), and the ceremonies'
// upkeep. A software authenticator (support/authenticator.ts) plays the browser. Removing the password, the
// sign-up, invitation and reset variants and domain moves are passkeyAccounts.test.ts's.

import { describe, expect, it } from 'vitest';
import type { AuthStatusDTO, CeremonyDTO, PasskeyDTO, PasskeyRemovedDTO, SecurityEventDTO, SessionDTO } from '@shared/types';
import type { SqlParams } from '../../src/core/db';
import { fromBase64Url, randomToken, sha256Hex } from '../../src/core/crypto';
import { migrate } from '../../src/core/migrate';
import { APP_VERSION } from '../../src/core/version';
import { DIRECTORY_MIGRATIONS } from '../../src/directory/schema';
import { POLICIES } from '../../src/directory/throttle';
import { NodeDb } from '../../src/runtime/node/nodeDb';
import { SoftAuthenticator, tamper, type PasskeyAlgorithm } from '../support/authenticator';
import { createDirectoryHarness, OWNER_EMAIL, PASSWORD, type DirectoryTestClient } from '../support/directoryHarness';

const ORIGIN = 'https://plan.example.com';
const PUBLIC = { PUBLIC_URL: ORIGIN };
const MINUTE = 60_000;

type Harness = ReturnType<typeof createDirectoryHarness>;

/** An instance with passkeys on (PUBLIC_URL https://plan.example.com) and its signed-in owner, whose address is verified. */
async function instance(o: Parameters<typeof createDirectoryHarness>[0] = {}) {
  const h = createDirectoryHarness({ vars: PUBLIC, ...o });
  const owner = await h.setup();
  h.db.run('UPDATE users SET email_verified_at = :now', { now: new Date(h.clock.now()).toISOString() });
  await h.settle();
  h.outbox.length = 0;
  return { h, owner };
}

/** Add a passkey through the API for a signed-in client (its re-auth window open); the authenticator and the answer. */
async function addPasskey(
  client: DirectoryTestClient,
  o: { alg?: PasskeyAlgorithm; counter?: number; backup?: { eligible: boolean; state: boolean }; name?: string; origin?: string } = {},
) {
  const options = await client.post<CeremonyDTO<any>>('/api/account/passkeys/options');
  expect(options.status, JSON.stringify(options.body)).toBe(200);
  const auth = await SoftAuthenticator.create({ alg: o.alg ?? -7, origin: o.origin ?? ORIGIN, counter: o.counter, backup: o.backup });
  const res = await client.post<PasskeyDTO>('/api/account/passkeys', {
    ceremonyId: options.body.ceremonyId,
    response: await auth.register(options.body.options),
    ...(o.name ? { name: o.name } : {}),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { auth, passkey: res.body };
}

/** Login options for `client` (a new anonymous one by default). */
async function loginOptions(h: Harness, client: DirectoryTestClient = h.client(), conditional?: boolean) {
  const res = await client.post<CeremonyDTO<any>>('/api/auth/passkey/login/options', conditional === undefined ? {} : { conditional });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

/** Sign in with `auth`'s passkey; `overrides` make its answer wrong. */
async function signInWith(
  h: Harness,
  auth: SoftAuthenticator,
  o: { client?: DirectoryTestClient; overrides?: Parameters<SoftAuthenticator['assert']>[1] } = {},
) {
  const client = o.client ?? h.client();
  const { ceremonyId, options } = await loginOptions(h, client);
  const response = await auth.assert(options, o.overrides);
  return { client, ceremonyId, response, res: await client.post('/api/auth/passkey/login', { ceremonyId, response }) };
}

const FAILED = { error: { code: 'passkey_error', message: 'This passkey could not be used to sign in.' } };

/** POST `path` with the ceremony of an options call and the browser's answer (and more fields). */
const send = (client: DirectoryTestClient, path: string, ceremony: CeremonyDTO, response: unknown, extra: Record<string, unknown> = {}) =>
  client.post(path, { ceremonyId: ceremony.ceremonyId, response, ...extra });
const REGISTER = '/api/account/passkeys';
const REAUTH = '/api/account/reauth/passkey';
const LOGIN = '/api/auth/passkey/login';

const events = (h: Harness, type: string) =>
  h.db.all<{ user_id: number | null; data: string }>('SELECT user_id, data FROM security_events WHERE type = :type ORDER BY id', { type }).map((e) => ({
    userId: e.user_id,
    data: JSON.parse(e.data) as Record<string, unknown>,
  }));

const count = (h: Harness, table: string) => h.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;

/** The payload of a signed sign-in ceremony. */
const payloadOf = (ceremonyId: string) =>
  JSON.parse(new TextDecoder().decode(fromBase64Url(ceremonyId.split('.')[0]!))) as { v: number; purpose: string; challenge: string; exp: number };

describe('the relying party comes from the configuration (§5.6)', () => {
  it('PUBLIC_URL gives the RP ID, the origin and the name, whatever the request says; the status names them', async () => {
    const { h, owner } = await instance({ vars: { ...PUBLIC, INSTANCE_NAME: 'Acme Plan' } });
    const status = await h.client().get<AuthStatusDTO>('/api/auth/status');
    expect(status.body.instance.passkeys).toEqual({ enabled: true, origin: ORIGIN, rpId: 'plan.example.com' });
    // A request for another host (the harness sends http://127.0.0.1:19610), with forwarded headers too.
    const forwarded = { 'X-Forwarded-Host': 'evil.example', Host: 'evil.example' };
    const res = await owner.client.request<CeremonyDTO<any>>('POST', '/api/account/passkeys/options', {}, forwarded);
    expect(res.body.options.rp).toEqual({ id: 'plan.example.com', name: 'Acme Plan' });
    const login = await h.client().request<CeremonyDTO<any>>('POST', '/api/auth/passkey/login/options', {}, { 'X-Forwarded-Host': 'evil.example' });
    expect(login.body.options.rpId).toBe('plan.example.com');
    // An answer made for the request's own address is refused.
    const auth = await SoftAuthenticator.create({ origin: 'http://127.0.0.1:19610' });
    const answer = await auth.register(res.body.options, { rpId: '127.0.0.1' });
    expect((await owner.client.post('/api/account/passkeys', { ceremonyId: res.body.ceremonyId, response: answer })).body.error.code).toBe('passkey_error');
  });

  it('WEBAUTHN_RP_ID may name a parent domain: the passkeys then work for every host under it', async () => {
    const { h, owner } = await instance({ vars: { ...PUBLIC, WEBAUTHN_RP_ID: 'example.com' } });
    expect((await h.client().get<AuthStatusDTO>('/api/auth/status')).body.instance.passkeys).toEqual({ enabled: true, origin: ORIGIN, rpId: 'example.com' });
    const { auth, passkey } = await addPasskey(owner.client);
    expect(passkey.rpIdMatches).toBe(true);
    expect(h.db.get('SELECT rp_id FROM passkeys')).toEqual({ rp_id: 'example.com' });
    expect((await signInWith(h, auth)).res.status).toBe(200);
  });

  it('without a PUBLIC_URL that allows them, passkeys are off: 409 with the reason, but the list still answers', async () => {
    const h = createDirectoryHarness();
    const owner = await h.setup();
    expect((await h.client().get<AuthStatusDTO>('/api/auth/status')).body.instance.passkeys).toEqual({ enabled: false, origin: null, rpId: null });
    const off = { status: 409, body: { error: { code: 'conflict', message: 'Passkeys are not available on this instance (PUBLIC_URL is not set).' } } };
    expect(await h.client().post('/api/auth/passkey/login/options', {})).toMatchObject(off);
    expect(await owner.client.post('/api/account/passkeys/options')).toMatchObject(off);
    expect(await owner.client.post('/api/account/reauth/passkey/options')).toMatchObject(off);
    expect(await h.client().post('/api/auth/password/reset/passkey/options', { token: randomToken() })).toMatchObject(off);
    expect((await owner.client.get('/api/account/passkeys')).body).toEqual([]);
    // An IP address cannot be an RP ID, nor can plain http other than localhost (core.config.test.ts has the rest).
    for (const url of ['https://192.0.2.10', 'http://plan.example.com']) {
      const other = createDirectoryHarness({ vars: { PUBLIC_URL: url } });
      expect((await other.client().post('/api/auth/passkey/login/options', {})).status).toBe(409);
    }
  });
});

describe('adding a passkey (§5.6, §5.8.13)', () => {
  it('the options: discoverable, user verification required, the three algorithms, the account handle, 5 minutes', async () => {
    const { h, owner } = await instance();
    const res = await owner.client.post<CeremonyDTO<any>>('/api/account/passkeys/options');
    const handle = h.db.get<{ webauthn_user_id: string }>('SELECT webauthn_user_id FROM users')!.webauthn_user_id;
    expect(res.body.ceremonyId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body.options).toMatchObject({
      rp: { id: 'plan.example.com', name: 'Lyren Plan' },
      user: { id: handle, name: OWNER_EMAIL, displayName: 'Owner' },
      pubKeyCredParams: [
        { alg: -8, type: 'public-key' },
        { alg: -7, type: 'public-key' },
        { alg: -257, type: 'public-key' },
      ],
      timeout: 60_000,
      attestation: 'none',
      excludeCredentials: [],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    });
    expect(fromBase64Url(handle)).toHaveLength(32);
    const session = h.db.get<{ id: number }>('SELECT id FROM sessions')!;
    expect(h.db.get('SELECT ceremony_hash, challenge, purpose, user_id, session_id, created_at, expires_at FROM webauthn_challenges')).toEqual({
      ceremony_hash: sha256Hex(res.body.ceremonyId),
      challenge: res.body.options.challenge,
      purpose: 'register',
      user_id: owner.user.id,
      session_id: session.id,
      created_at: new Date(h.clock.now()).toISOString(),
      expires_at: new Date(h.clock.now() + 5 * MINUTE).toISOString(),
    });
    // The passkeys the account has here are excluded, with their transports.
    const { auth } = await addPasskey(owner.client);
    const next = await owner.client.post<CeremonyDTO<any>>('/api/account/passkeys/options');
    expect(next.body.options.excludeCredentials).toEqual([{ id: auth.credentialId, type: 'public-key', transports: ['internal', 'hybrid'] }]);
  });

  for (const alg of [-7, -8, -257] as const) {
    it(`round trip with algorithm ${alg}: stored, listed, recorded and announced; then it signs in`, async () => {
      const { h, owner } = await instance();
      const { auth, passkey } = await addPasskey(owner.client, {
        alg,
        counter: alg === -257 ? 5 : undefined,
        backup: alg === -8 ? { eligible: false, state: false } : undefined,
      });
      expect(passkey).toEqual({
        id: passkey.id,
        name: 'Passkey 1',
        createdAt: new Date(h.clock.now()).toISOString(),
        lastUsedAt: null,
        deviceType: alg === -8 ? 'singleDevice' : 'multiDevice',
        backedUp: alg !== -8,
        rpIdMatches: true,
      });
      const row = h.db.get<Record<string, unknown>>('SELECT * FROM passkeys')!;
      expect(row).toMatchObject({
        user_id: owner.user.id,
        credential_id: auth.credentialId,
        algorithm: alg,
        sign_count: alg === -257 ? 5 : 0,
        transports: '["internal","hybrid"]',
        device_type: alg === -8 ? 'singleDevice' : 'multiDevice',
        backed_up: alg === -8 ? 0 : 1,
        aaguid: '00000000-0000-0000-0000-000000000000',
        rp_id: 'plan.example.com',
      });
      expect(fromBase64Url(row.public_key as string).length).toBeGreaterThan(30);
      expect(events(h, 'passkey_added')).toEqual([{ userId: owner.user.id, data: { passkeyId: passkey.id, name: 'Passkey 1', via: 'settings' } }]);
      await h.settle();
      expect(h.outbox.map((m) => [m.template, m.to])).toEqual([['passkey_added', OWNER_EMAIL]]);
      expect((await owner.client.get<PasskeyDTO[]>('/api/account/passkeys')).body).toEqual([passkey]);
      expect((await owner.client.get('/api/account')).body.passkeyCount).toBe(1);

      // Signing in: a new session (passkey), the device cookie, the counter, the event.
      h.clock.advance(MINUTE);
      const { client, res } = await signInWith(h, auth);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.user).toMatchObject({ id: owner.user.id, email: OWNER_EMAIL, hasPassword: true, passkeyCount: 1 });
      expect(res.setCookies.some((cookie) => cookie.startsWith('lyren_session='))).toBe(true);
      expect(res.setCookies.some((cookie) => cookie.startsWith('lyren_device='))).toBe(true);
      const sessions = await client.get<SessionDTO[]>('/api/account/sessions');
      expect(sessions.body.find((s) => s.current)?.authMethod).toBe('passkey');
      expect(h.db.get('SELECT sign_count, last_used_at FROM passkeys')).toEqual({
        sign_count: alg === -257 ? 6 : 0,
        last_used_at: new Date(h.clock.now()).toISOString(),
      });
      expect(h.db.get<{ last_login_at: string }>('SELECT last_login_at FROM users')!.last_login_at).toBe(new Date(h.clock.now()).toISOString());
      expect(events(h, 'passkey_login')).toEqual([{ userId: owner.user.id, data: { passkeyId: passkey.id, name: 'Passkey 1' } }]);
      // The new session's re-auth window is open (a passkey with user verification was just proven).
      expect((await client.get<AuthStatusDTO>('/api/auth/status')).body.reauthUntil).toBe(new Date(h.clock.now() + 10 * MINUTE).toISOString());
    });
  }

  it('needs the re-auth window for the options (not for the answer), and names passkeys "Passkey <n>" unless named', async () => {
    const { h, owner } = await instance();
    const options = await owner.client.post<CeremonyDTO<any>>('/api/account/passkeys/options');
    h.clock.advance(11 * MINUTE);
    expect((await owner.client.post('/api/account/passkeys/options')).body.error.code).toBe('reauth_required');
    // The ceremony made while the window was open has expired by now (5 minutes).
    const auth = await SoftAuthenticator.create({ origin: ORIGIN });
    const late = await owner.client.post('/api/account/passkeys', { ceremonyId: options.body.ceremonyId, response: await auth.register(options.body.options) });
    expect(late.body.error.code).toBe('passkey_error');
    expect((await owner.client.post('/api/account/reauth/password', { password: PASSWORD })).status).toBe(200);
    const first = await addPasskey(owner.client);
    const named = await addPasskey(owner.client, { name: '  Work laptop ' });
    const third = await addPasskey(owner.client);
    expect([first.passkey.name, named.passkey.name, third.passkey.name]).toEqual(['Passkey 1', 'Work laptop', 'Passkey 3']);
  });

  it('refuses a wrong origin, a wrong RP ID, missing user verification or presence, a tampered answer and the wrong ceremony', async () => {
    const { h, owner } = await instance();
    const other = await h.addUser({ email: 'other@example.com', spaceId: owner.spaceId });
    const cases: Array<[string, (auth: SoftAuthenticator, options: any) => Promise<unknown>]> = [
      ['origin', (auth, options) => auth.register(options, { origin: 'https://evil.example' })],
      ['RP ID', (auth, options) => auth.register(options, { rpId: 'evil.example' })],
      ['parent RP ID that is not configured', (auth, options) => auth.register(options, { rpId: 'example.com' })],
      ['user verification', (auth, options) => auth.register(options, { userVerified: false })],
      ['user presence', (auth, options) => auth.register(options, { userPresent: false })],
      ['type', (auth, options) => auth.register(options, { type: 'webauthn.get' })],
      ['challenge', (auth, options) => auth.register(options, { challenge: randomToken() })],
      ['attestation', async (auth, options) => tamper(await auth.register(options), 'attestationObject', 40)],
    ];
    for (const [what, answer] of cases) {
      const options = await owner.client.post<CeremonyDTO<any>>('/api/account/passkeys/options');
      const auth = await SoftAuthenticator.create({ origin: ORIGIN });
      const res = await owner.client.post('/api/account/passkeys', { ceremonyId: options.body.ceremonyId, response: await answer(auth, options.body.options) });
      expect(res, what).toMatchObject({ status: 400, body: { error: { code: 'passkey_error', message: 'This passkey could not be set up. Try again.' } } });
      // The ceremony is gone whatever the answer was.
      expect(count(h, 'webauthn_challenges'), what).toBe(0);
    }
    // Another session's ceremony (of the same account, or of another one) fails, and is used up by the attempt.
    const second = h.client();
    expect((await second.post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD })).status).toBe(200);
    const auth = await SoftAuthenticator.create({ origin: ORIGIN });
    for (const thief of [second, other.client]) {
      const options = await owner.client.post<CeremonyDTO<any>>('/api/account/passkeys/options');
      const answer = await auth.register(options.body.options);
      expect((await thief.post('/api/account/passkeys', { ceremonyId: options.body.ceremonyId, response: answer })).body.error.code).toBe('passkey_error');
      expect((await send(owner.client, REGISTER, options.body, answer)).body.error.code).toBe('passkey_error');
    }
    const again = await owner.client.post<CeremonyDTO<any>>('/api/account/passkeys/options');
    const fresh = await auth.register(again.body.options);
    expect((await owner.client.post('/api/account/passkeys', { ceremonyId: again.body.ceremonyId, response: fresh })).status).toBe(201);
    // Replayed: the same ceremony and answer once more; the same credential with a new ceremony.
    expect((await owner.client.post('/api/account/passkeys', { ceremonyId: again.body.ceremonyId, response: fresh })).body.error.code).toBe('passkey_error');
    const third = await owner.client.post<CeremonyDTO<any>>('/api/account/passkeys/options');
    expect(await send(owner.client, REGISTER, third.body, await auth.register(third.body.options))).toMatchObject({
      status: 400,
      body: { error: { code: 'passkey_error', message: 'This passkey is registered already.' } },
    });
    const expired = await owner.client.post<CeremonyDTO<any>>('/api/account/passkeys/options');
    h.clock.advance(5 * MINUTE);
    const late = await SoftAuthenticator.create({ origin: ORIGIN });
    expect((await send(owner.client, REGISTER, expired.body, await late.register(expired.body.options))).body.error.code).toBe('passkey_error');
    expect(count(h, 'passkeys')).toBe(1);
  });

  it('at most 20 passkeys: the options and the answer refuse the 21st (409 quota_exceeded)', async () => {
    const { h, owner } = await instance();
    const now = new Date(h.clock.now()).toISOString();
    for (let i = 0; i < 19; i++) {
      h.db.run(
        `INSERT INTO passkeys (user_id, credential_id, public_key, algorithm, device_type, rp_id, name, created_at)
         VALUES (:userId, :id, 'x', -7, 'multiDevice', 'plan.example.com', :name, :now)`,
        { userId: owner.user.id, id: randomToken(16), name: `Key ${i}`, now },
      );
    }
    const last = await owner.client.post<CeremonyDTO<any>>('/api/account/passkeys/options');
    const spare = await owner.client.post<CeremonyDTO<any>>('/api/account/passkeys/options');
    const auth = await SoftAuthenticator.create({ origin: ORIGIN });
    expect((await send(owner.client, REGISTER, last.body, await auth.register(last.body.options))).status).toBe(201);
    const quota = { status: 409, body: { error: { code: 'quota_exceeded', message: 'An account can have at most 20 passkeys. Remove one first.' } } };
    expect(await owner.client.post('/api/account/passkeys/options')).toMatchObject(quota);
    const extra = await SoftAuthenticator.create({ origin: ORIGIN });
    expect(await send(owner.client, REGISTER, spare.body, await extra.register(spare.body.options))).toMatchObject(quota);
  });
});

/** A directory database that records the statements it runs while `trace` is set. */
class TracingDb extends NodeDb {
  trace: string[] | null = null;

  override all<T = Record<string, unknown>>(sql: string, params?: SqlParams): T[] {
    this.trace?.push(sql);
    return super.all<T>(sql, params);
  }

  override get<T = Record<string, unknown>>(sql: string, params?: SqlParams): T | undefined {
    this.trace?.push(sql);
    return super.get<T>(sql, params);
  }

  override run(sql: string, params?: SqlParams) {
    this.trace?.push(sql);
    return super.run(sql, params);
  }
}

describe('signing in with a passkey (§5.8.3)', () => {
  it('the options: no credentials, user verification required; a signed ceremony of 5 minutes (10 for autofill)', async () => {
    const { h } = await instance();
    const modal = await loginOptions(h);
    expect(modal.options).toMatchObject({ rpId: 'plan.example.com', allowCredentials: [], userVerification: 'required', timeout: 60_000 });
    expect(modal.ceremonyId).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(modal.ceremonyId.length).toBeLessThanOrEqual(200);
    expect(payloadOf(modal.ceremonyId)).toEqual({ v: 1, purpose: 'login', challenge: modal.options.challenge, exp: h.clock.now() + 5 * MINUTE });
    const conditional = await loginOptions(h, h.client(), true);
    expect(conditional.options.timeout).toBe(5 * MINUTE);
    expect(payloadOf(conditional.ceremonyId).exp).toBe(h.clock.now() + 10 * MINUTE);
  });

  it('an options call writes no row: nothing is stored, and its limit is counted in memory', async () => {
    const db = new TracingDb(':memory:');
    migrate(db, DIRECTORY_MIGRATIONS, { appVersion: APP_VERSION });
    const { h } = await instance({ db });
    const before = ['webauthn_challenges', 'auth_throttle', 'security_events', 'instance_settings'].map((t) => count(h, t));
    db.trace = [];
    await loginOptions(h);
    await loginOptions(h, h.client(), true);
    const trace = db.trace;
    db.trace = null;
    expect(trace.filter((sql) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql))).toEqual([]);
    expect(['webauthn_challenges', 'auth_throttle', 'security_events', 'instance_settings'].map((t) => count(h, t))).toEqual(before);
  });

  it('a ceremony works once: a second sign-in with it fails, even with a new answer to its challenge', async () => {
    const { h, owner } = await instance();
    const { auth } = await addPasskey(owner.client);
    const { ceremonyId, response, res } = await signInWith(h, auth);
    expect(res.status).toBe(200);
    expect(h.db.get('SELECT purpose, ceremony_hash FROM webauthn_challenges')).toEqual({ purpose: 'login', ceremony_hash: sha256Hex(ceremonyId) });
    expect(await h.client().post('/api/auth/passkey/login', { ceremonyId, response })).toMatchObject({ status: 400, body: FAILED });
    const answer = await auth.assert({ challenge: payloadOf(ceremonyId).challenge, rpId: 'plan.example.com' });
    expect(await h.client().post('/api/auth/passkey/login', { ceremonyId, response: answer })).toMatchObject({ status: 400, body: FAILED });
  });

  it('a tampered, expired or foreign ceremony fails before anything is written', async () => {
    const { h, owner } = await instance();
    const { auth } = await addPasskey(owner.client);
    const { ceremonyId, options } = await loginOptions(h);
    const response = await auth.assert(options);
    const [payload = '', signature = ''] = ceremonyId.split('.');
    const longer = Buffer.from(JSON.stringify({ ...payloadOf(ceremonyId), exp: h.clock.now() + 60 * MINUTE })).toString('base64url');
    const elsewhere = createDirectoryHarness({ vars: PUBLIC });
    const foreign = (await elsewhere.client().post<CeremonyDTO<any>>('/api/auth/passkey/login/options', {})).body.ceremonyId;
    for (const id of [`${longer}.${signature}`, `${payload}.${signature.slice(1)}A`, foreign, randomToken()]) {
      expect(await h.client().post('/api/auth/passkey/login', { ceremonyId: id, response }), id).toMatchObject({ status: 400, body: FAILED });
    }
    expect(count(h, 'webauthn_challenges')).toBe(0);
    h.clock.advance(5 * MINUTE);
    expect(await h.client().post('/api/auth/passkey/login', { ceremonyId, response })).toMatchObject({ status: 400, body: FAILED });
    expect(count(h, 'webauthn_challenges')).toBe(0);
    // The autofill's ceremony lasts 10 minutes.
    const conditional = await loginOptions(h, h.client(), true);
    h.clock.advance(9 * MINUTE);
    expect((await send(h.client(), LOGIN, conditional, await auth.assert(conditional.options))).status).toBe(200);
  });

  it('refuses a wrong origin, a wrong RP ID, missing user verification or presence, a bad signature, another challenge', async () => {
    const { h, owner } = await instance();
    const { auth } = await addPasskey(owner.client);
    const wrong: Array<[string, Parameters<SoftAuthenticator['assert']>[1]]> = [
      ['origin', { origin: 'https://evil.example' }],
      ['origin of a sibling', { origin: 'https://other.example.com' }],
      ['RP ID', { rpId: 'evil.example' }],
      ['user verification', { userVerified: false }],
      ['user presence', { userPresent: false }],
      ['type', { type: 'webauthn.create' }],
      ['challenge', { challenge: randomToken() }],
    ];
    for (const [what, overrides] of wrong) {
      const { res } = await signInWith(h, auth, { overrides });
      expect(res, what).toMatchObject({ status: 400, body: FAILED });
    }
    for (const part of ['signature', 'authenticatorData', 'clientDataJSON'] as const) {
      const { ceremonyId, options } = await loginOptions(h);
      const response = tamper(await auth.assert(options), part, part === 'authenticatorData' ? 5 : -1);
      expect(await h.client().post('/api/auth/passkey/login', { ceremonyId, response }), part).toMatchObject({ status: 400, body: FAILED });
    }
    expect(events(h, 'passkey_login')).toEqual([]);
    expect((await signInWith(h, auth)).res.status).toBe(200);
  });

  it('the user handle must be the account’s; an unknown credential is named only when it was this instance’s, and leaves the ceremony unused', async () => {
    const { h, owner } = await instance();
    const { auth } = await addPasskey(owner.client);
    expect((await signInWith(h, auth, { overrides: { userHandle: randomToken(32) } })).res).toMatchObject({ status: 400, body: FAILED });
    expect((await signInWith(h, auth, { overrides: { userHandle: null } })).res).toMatchObject({ status: 400, body: FAILED });
    // Another account's handle with this passkey.
    const other = await h.addUser({ email: 'other@example.com' });
    const otherHandle = h.db.get<{ webauthn_user_id: string }>('SELECT webauthn_user_id FROM users WHERE id = :id', { id: other.user.id })!.webauthn_user_id;
    expect((await signInWith(h, auth, { overrides: { userHandle: otherHandle } })).res).toMatchObject({ status: 400, body: FAILED });

    // A passkey of another relying party of the same RP ID (another instance, another service of the domain):
    // refused, but not named, so the browser keeps it for where it works.
    const stranger = await SoftAuthenticator.create({ origin: ORIGIN });
    stranger.userHandle = randomToken(32);
    const client = h.client();
    const { ceremonyId, options } = await loginOptions(h, client);
    const res = await client.post('/api/auth/passkey/login', { ceremonyId, response: await stranger.assert(options) });
    expect(res).toMatchObject({ status: 400, body: FAILED });
    expect(res.body.error.details).toBeUndefined();
    expect((await client.post('/api/auth/passkey/login', { ceremonyId, response: await stranger.assert(options, { userHandle: null }) })).body).toEqual(FAILED);
    // One whose user handle is an account's here (registered here, removed since): named.
    stranger.userHandle = otherHandle;
    const removed = await client.post('/api/auth/passkey/login', { ceremonyId, response: await stranger.assert(options) });
    expect(removed).toMatchObject({ status: 400, body: { error: { ...FAILED.error, details: [{ path: 'credential', message: 'unknown' }] } } });
    expect(count(h, 'webauthn_challenges')).toBe(0);
    // The same ceremony still signs in with a passkey the instance knows.
    expect((await client.post('/api/auth/passkey/login', { ceremonyId, response: await auth.assert(options) })).status).toBe(200);
  });

  it('a counter that did not move forward is recorded and refused; one that stays 0 is fine; a forged one records nothing', async () => {
    const { h, owner } = await instance();
    const counting = await addPasskey(owner.client, { counter: 5 });
    expect((await signInWith(h, counting.auth)).res.status).toBe(200);
    expect(h.db.get('SELECT sign_count FROM passkeys WHERE id = :id', { id: counting.passkey.id })).toEqual({ sign_count: 6 });
    for (const counter of [6, 3, 0]) {
      expect((await signInWith(h, counting.auth, { overrides: { counter } })).res, String(counter)).toMatchObject({ status: 400, body: FAILED });
    }
    expect(events(h, 'passkey_counter_regression')).toEqual([
      { userId: owner.user.id, data: { passkeyId: counting.passkey.id, name: 'Passkey 1', stored: 6, received: 6, purpose: 'login' } },
      { userId: owner.user.id, data: { passkeyId: counting.passkey.id, name: 'Passkey 1', stored: 6, received: 3, purpose: 'login' } },
      { userId: owner.user.id, data: { passkeyId: counting.passkey.id, name: 'Passkey 1', stored: 6, received: 0, purpose: 'login' } },
    ]);
    expect((await signInWith(h, counting.auth)).res.status).toBe(200);
    expect(h.db.get('SELECT sign_count FROM passkeys WHERE id = :id', { id: counting.passkey.id })).toEqual({ sign_count: 7 });
    // An answer whose signature is bad is no evidence of a clone: no event.
    const { ceremonyId, options } = await loginOptions(h);
    const forged = tamper(await counting.auth.assert(options, { counter: 1 }), 'signature');
    expect(await h.client().post('/api/auth/passkey/login', { ceremonyId, response: forged })).toMatchObject({ status: 400, body: FAILED });
    expect(events(h, 'passkey_counter_regression')).toHaveLength(3);
    // A synced passkey keeps reporting 0.
    const synced = await addPasskey(owner.client);
    for (let i = 0; i < 3; i++) expect((await signInWith(h, synced.auth)).res.status).toBe(200);
  });

  it('a disabled account: 403 account_disabled, only after a good passkey; a deleted passkey no longer signs in', async () => {
    const { h, owner } = await instance();
    const { auth, passkey } = await addPasskey(owner.client);
    const other = await h.addUser({ email: 'other@example.com', isInstanceAdmin: true });
    const theirs = await addPasskey(other.client);
    h.db.run("UPDATE users SET status = 'disabled' WHERE id = :id", { id: other.user.id });
    expect((await signInWith(h, theirs.auth)).res).toMatchObject({ status: 403, body: { error: { code: 'account_disabled' } } });
    expect((await signInWith(h, theirs.auth, { overrides: { origin: 'https://evil.example' } })).res).toMatchObject({ status: 400, body: FAILED });
    h.db.run('DELETE FROM passkeys WHERE id = :id', { id: passkey.id });
    expect((await signInWith(h, auth)).res.body.error.details).toEqual([{ path: 'credential', message: 'unknown' }]);
  });

  it('replaces the browser’s previous session, and keeps its device token', async () => {
    const { h, owner } = await instance();
    const { auth } = await addPasskey(owner.client);
    const sessionsBefore = count(h, 'sessions');
    const devicesBefore = count(h, 'device_tokens');
    const { res } = await signInWith(h, auth, { client: owner.client });
    expect(res.status).toBe(200);
    expect(count(h, 'sessions')).toBe(sessionsBefore);
    expect(count(h, 'device_tokens')).toBe(devicesBefore);
    expect(res.setCookies.some((c) => c.startsWith('lyren_device='))).toBe(false);
  });

  it('is not held back by a password’s limits (lg, lid, lda), only by co (options) and pk (failures)', async () => {
    const { h, owner } = await instance();
    const { auth } = await addPasskey(owner.client);
    const { throttle } = h.ctx;
    for (let i = 0; i < 100; i++) throttle.hit('lg', POLICIES.lg);
    for (let i = 0; i < 25; i++) throttle.hit(`lid:a:${owner.user.id}`, POLICIES.lid);
    for (let i = 0; i < 100; i++) throttle.hit(`lda:${owner.user.id}`, POLICIES.lda);
    expect((await h.client({ ip: '198.51.100.7' }).post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD })).status).toBe(429);
    expect((await signInWith(h, auth, { client: h.client({ ip: '198.51.100.7' }) })).res.status).toBe(200);

    // 30 failed assertions from one address, then even a good one waits (429 with Retry-After).
    const ip = '203.0.113.5';
    for (let i = 0; i < 30; i++) {
      expect((await signInWith(h, auth, { client: h.client({ ip }), overrides: { origin: 'https://evil.example' } })).res.status).toBe(400);
    }
    const blocked = (await signInWith(h, auth, { client: h.client({ ip }) })).res;
    expect(blocked).toMatchObject({ status: 429, body: { error: { code: 'rate_limited' } } });
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect((await signInWith(h, auth, { client: h.client({ ip: '198.51.100.8' }) })).res.status).toBe(200);

    // 60 options calls from one address in 15 minutes; the 61st waits.
    const busy = h.client({ ip: '192.0.2.200' });
    for (let i = 0; i < 60; i++) expect((await busy.post('/api/auth/passkey/login/options', {})).status).toBe(200);
    expect((await busy.post('/api/auth/passkey/login/options', {})).status).toBe(429);
    h.clock.advance(15 * MINUTE);
    expect((await busy.post('/api/auth/passkey/login/options', {})).status).toBe(200);
  });
});

describe('re-authentication with a passkey (§5.8.14)', () => {
  it('opens the window again with one of the account’s passkeys that work here', async () => {
    const { h, owner } = await instance();
    const first = await addPasskey(owner.client);
    const second = await addPasskey(owner.client, { alg: -8 });
    h.db.run("UPDATE passkeys SET rp_id = 'old.example.com' WHERE id = :id", { id: second.passkey.id });
    h.clock.advance(11 * MINUTE);
    expect((await owner.client.post('/api/account/passkeys/options')).body.error.code).toBe('reauth_required');
    const options = await owner.client.post<CeremonyDTO<any>>('/api/account/reauth/passkey/options');
    expect(options.body.options).toMatchObject({
      rpId: 'plan.example.com',
      allowCredentials: [{ id: first.auth.credentialId, type: 'public-key', transports: ['internal', 'hybrid'] }],
      userVerification: 'required',
      timeout: 60_000,
    });
    const res = await send(owner.client, REAUTH, options.body, await first.auth.assert(options.body.options));
    expect(res).toMatchObject({ status: 200, body: { ok: true, reauthUntil: new Date(h.clock.now() + 10 * MINUTE).toISOString() } });
    const used = h.db.get('SELECT last_used_at FROM passkeys WHERE id = :id', { id: first.passkey.id });
    expect(used).toEqual({ last_used_at: new Date(h.clock.now()).toISOString() });
    expect((await owner.client.post('/api/account/passkeys/options')).status).toBe(200);
  });

  it('refuses another session’s ceremony, another account’s passkey, a handle that is not the account’s, a replay', async () => {
    const { h, owner } = await instance();
    const { auth } = await addPasskey(owner.client);
    const other = await h.addUser({ email: 'other@example.com' });
    const theirs = await addPasskey(other.client);
    const failed = { status: 400, body: { error: { code: 'passkey_error', message: 'This passkey could not be used to confirm it is you.' } } };
    const options = await owner.client.post<CeremonyDTO<any>>('/api/account/reauth/passkey/options');
    expect(await send(other.client, REAUTH, options.body, await theirs.auth.assert(options.body.options))).toMatchObject(failed);
    const mine = await owner.client.post<CeremonyDTO<any>>('/api/account/reauth/passkey/options');
    expect(await send(owner.client, REAUTH, mine.body, await theirs.auth.assert(mine.body.options))).toMatchObject(failed);
    const handle = await owner.client.post<CeremonyDTO<any>>('/api/account/reauth/passkey/options');
    const foreign = await auth.assert(handle.body.options, { userHandle: randomToken(32) });
    expect(await send(owner.client, REAUTH, handle.body, foreign)).toMatchObject(failed);
    // Without a handle (allowCredentials named the passkey), and then the same ceremony again.
    const good = await owner.client.post<CeremonyDTO<any>>('/api/account/reauth/passkey/options');
    const withoutHandle = await auth.assert(good.body.options, { userHandle: null });
    expect((await send(owner.client, REAUTH, good.body, withoutHandle)).status).toBe(200);
    expect(await send(owner.client, REAUTH, good.body, withoutHandle)).toMatchObject(failed);
    const uv = await owner.client.post<CeremonyDTO<any>>('/api/account/reauth/passkey/options');
    expect(await send(owner.client, REAUTH, uv.body, await auth.assert(uv.body.options, { userVerified: false }))).toMatchObject(failed);
  });

  it('a counter that went back is recorded as a re-authentication’s', async () => {
    const { h, owner } = await instance();
    const { auth, passkey } = await addPasskey(owner.client, { counter: 5 });
    const options = await owner.client.post<CeremonyDTO<any>>('/api/account/reauth/passkey/options');
    expect((await send(owner.client, REAUTH, options.body, await auth.assert(options.body.options, { counter: 2 }))).status).toBe(400);
    expect(events(h, 'passkey_counter_regression')).toEqual([
      { userId: owner.user.id, data: { passkeyId: passkey.id, name: 'Passkey 1', stored: 5, received: 2, purpose: 'reauth' } },
    ]);
  });

  it('an account without a passkey that works here gets 400 passkey_error for the options', async () => {
    const { owner } = await instance();
    expect(await owner.client.post('/api/account/reauth/passkey/options')).toMatchObject({
      status: 400,
      body: { error: { code: 'passkey_error', message: 'This account has no passkey that works on this address.' } },
    });
  });
});

describe('renaming and removing passkeys (§5.8.13)', () => {
  it('renames the account’s own passkeys only (404 for anyone else’s)', async () => {
    const { h, owner } = await instance();
    const { passkey } = await addPasskey(owner.client);
    const res = await owner.client.patch<PasskeyDTO>(`/api/account/passkeys/${passkey.id}`, { name: ' Phone ' });
    expect(res.body).toEqual({ ...passkey, name: 'Phone' });
    expect((await owner.client.patch(`/api/account/passkeys/${passkey.id}`, { name: '' })).status).toBe(400);
    expect((await owner.client.patch(`/api/account/passkeys/${passkey.id}`, { name: 'x'.repeat(65) })).status).toBe(400);
    const other = await h.addUser({ email: 'other@example.com' });
    const missing = { status: 404, body: { error: { message: 'Passkey not found' } } };
    expect(await other.client.patch(`/api/account/passkeys/${passkey.id}`, { name: 'Mine' })).toMatchObject(missing);
    expect(await other.client.delete(`/api/account/passkeys/${passkey.id}`)).toMatchObject({ status: 404 });
    expect(count(h, 'passkeys')).toBe(1);
  });

  it('removes one with the re-auth window, and answers what the signal API needs', async () => {
    const { h, owner } = await instance();
    const first = await addPasskey(owner.client);
    const second = await addPasskey(owner.client);
    h.clock.advance(11 * MINUTE);
    expect((await owner.client.delete(`/api/account/passkeys/${first.passkey.id}`)).body.error.code).toBe('reauth_required');
    expect((await owner.client.post('/api/account/reauth/password', { password: PASSWORD })).status).toBe(200);
    const res = await owner.client.delete<PasskeyRemovedDTO>(`/api/account/passkeys/${first.passkey.id}`);
    const handle = h.db.get<{ webauthn_user_id: string }>('SELECT webauthn_user_id FROM users WHERE id = :id', { id: owner.user.id })!.webauthn_user_id;
    expect(res.body).toEqual({ ok: true, acceptedCredentialIds: [second.auth.credentialId], userHandle: handle });
    expect(events(h, 'passkey_removed')).toEqual([{ userId: owner.user.id, data: { passkeyId: first.passkey.id, name: 'Passkey 1' } }]);
    expect((await signInWith(h, first.auth)).res.body.error.details).toEqual([{ path: 'credential', message: 'unknown' }]);
  });

  it('the last usable credential stays: only passkeys that work here count, so an orphaned one never protects the last', async () => {
    const { h, owner } = await instance();
    const usable = await addPasskey(owner.client);
    const orphan = await addPasskey(owner.client);
    h.db.run("UPDATE passkeys SET rp_id = 'old.example.com' WHERE id = :id", { id: orphan.passkey.id });
    // With a password, any passkey can go.
    expect((await owner.client.get<PasskeyDTO[]>('/api/account/passkeys')).body.map((p) => p.rpIdMatches)).toEqual([true, false]);
    h.db.run('UPDATE users SET password_hash = NULL WHERE id = :id', { id: owner.user.id });
    const message = 'This passkey is the only way left to sign in to your account. Set a password or add another passkey first.';
    const last = { status: 409, body: { error: { code: 'last_credential', message } } };
    expect(await owner.client.delete(`/api/account/passkeys/${usable.passkey.id}`)).toMatchObject(last);
    // Refused before the re-auth window is asked for.
    h.clock.advance(11 * MINUTE);
    expect(await owner.client.delete(`/api/account/passkeys/${usable.passkey.id}`)).toMatchObject(last);
    h.clock.advance(-11 * MINUTE);
    // The orphaned one is no credential here and can go.
    expect((await owner.client.delete(`/api/account/passkeys/${orphan.passkey.id}`)).status).toBe(200);
    // A second usable passkey lets the first go, and then the second is the last.
    const other = await addPasskey(owner.client);
    expect((await owner.client.delete(`/api/account/passkeys/${usable.passkey.id}`)).status).toBe(200);
    expect(await owner.client.delete(`/api/account/passkeys/${other.passkey.id}`)).toMatchObject(last);
    // An account left with orphaned passkeys alone can remove them: none of them is a way in here.
    const member = await h.addUser({ email: 'member@example.com' });
    const stale = await addPasskey(member.client);
    h.db.run("UPDATE passkeys SET rp_id = 'old.example.com' WHERE id = :id", { id: stale.passkey.id });
    h.db.run('UPDATE users SET password_hash = NULL WHERE id = :id', { id: member.user.id });
    expect((await member.client.delete(`/api/account/passkeys/${stale.passkey.id}`)).status).toBe(200);
  });
});

describe('the ceremonies’ upkeep (§5.6)', () => {
  it('maintenance deletes expired ceremonies of every purpose; a binding keeps its 5 newest', async () => {
    const { h, owner } = await instance();
    const { auth } = await addPasskey(owner.client);
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push((await owner.client.post<CeremonyDTO>('/api/account/passkeys/options')).body.ceremonyId);
    expect(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM webauthn_challenges WHERE purpose = 'register'")!.n).toBe(5);
    const early = await SoftAuthenticator.create({ origin: ORIGIN });
    const stale = await early.register({ challenge: 'x', rp: { id: 'plan.example.com', name: '' }, user: { id: 'x', name: '', displayName: '' } });
    expect((await owner.client.post(REGISTER, { ceremonyId: ids[0], response: stale })).body.error.code).toBe('passkey_error');
    await owner.client.post('/api/account/reauth/passkey/options');
    expect((await signInWith(h, auth)).res.status).toBe(200);
    const purposes = h.db.all<{ purpose: string }>('SELECT DISTINCT purpose FROM webauthn_challenges ORDER BY purpose').map((r) => r.purpose);
    expect(purposes).toEqual(['login', 'reauth', 'register']);
    h.clock.advance(4 * MINUTE);
    expect((await h.service.maintenance()).challenges).toBe(0);
    h.clock.advance(MINUTE);
    expect((await h.service.maintenance()).challenges).toBe(7);
    expect(count(h, 'webauthn_challenges')).toBe(0);
  });

  it('ceremonies go with their session or account', async () => {
    const { h, owner } = await instance();
    await owner.client.post('/api/account/passkeys/options');
    await owner.client.post('/api/auth/logout');
    expect(count(h, 'webauthn_challenges')).toBe(0);
  });
});

describe('the account’s security log', () => {
  it('shows the passkey events to the account and to an admin', async () => {
    const { h, owner } = await instance();
    const other = await h.addUser({ email: 'other@example.com' });
    const { auth } = await addPasskey(other.client);
    expect((await signInWith(h, auth)).res.status).toBe(200);
    const own = await other.client.get<SecurityEventDTO[]>('/api/account/security-events');
    expect(own.body.map((e) => e.type).slice(0, 3)).toEqual(['passkey_login', 'passkey_added', 'login']);
    expect(own.body[0]!.ip).toBe('192.0.2.10');
    const detail = await owner.client.get(`/api/admin/users/${other.user.id}`);
    expect(detail.body.events.map((e: SecurityEventDTO) => e.type).slice(0, 2)).toEqual(['passkey_login', 'passkey_added']);
    expect(detail.body.passkeys).toBe(1);
  });
});
