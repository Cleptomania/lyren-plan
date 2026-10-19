// Passkeys in workerd (design §5.6, §5.8.3, §5.8.5, §5.8.8, §5.8.9, §5.8.12-§5.8.14, §11.1, §14.8): the same
// ceremonies as on Node (server/test/directory/passkeys.test.ts and passkeyAccounts.test.ts cover them in
// depth), here through the real Worker and DirectoryDO with the WebCrypto workerd has. Requests go to
// https://plan.example.com (wrangler.test.jsonc's PUBLIC_URL), so the RP ID is plan.example.com.
// - round trips for ES256, Ed25519 and RS256, registration and sign-in;
// - the negative cases: origin, RP ID, a replayed registration ceremony, a replayed, tampered or expired
//   sign-in ceremony, a counter regression, a user handle that is not the owner's, user verification
//   missing, an unknown credential (named only when its user handle is an account's here), a padded or
//   mislabelled public key;
// - a sign-in options call writes no row (the object's meter);
// - the last-credential rules with orphaned passkeys, and removing the password on Cloudflare;
// - the sign-up, invitation and reset variants end to end (sign-up on a DirectoryDO of its own whose EMAIL
//   binding records, as e2e.test.ts does, since the test Worker's log transport delivers nothing);
// - the domain-move warning: a start of the directory object reads no more rows with many accounts, and the
//   hourly alarm logs it;
// - the configuration errors of WEBAUTHN_RP_ID (the directory answers 503 with the reason);
// - the CPU time of the verifications, printed as `[cpu] …` lines (--reporter=verbose shows them), against
//   the Free plan's 10 ms (§11.1). Local workerd enforces no CPU limit and its clock moves while code runs.

import { scryptSync } from 'node:crypto';
import { runInDurableObject, SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthStatusDTO, CeremonyDTO, InvitationCreatedDTO, PasskeyDTO, PasskeyRemovedDTO, ResetLinkDTO, UserDTO } from '@shared/types';
import { randomToken } from '../src/core/crypto';
import { encodeMeta, META_HEADER } from '../src/core/meta';
import { getCeremonyKey } from '../src/directory/settings';
import { signLoginCeremony } from '../src/passkeys/ceremonies';
import {
  authenticationOptions,
  registrationOptions,
  relyingParty,
  verifyAssertion,
  verifyRegistration,
  type RegisteredCredential,
} from '../src/passkeys/webauthn';
import { DirectoryDO as WorkerDirectoryDO } from '../src/runtime/cloudflare/directoryDo';
import { DoDb } from '../src/runtime/cloudflare/doDb';
import type { Env } from '../src/runtime/cloudflare/env';
import { SoftAuthenticator, tamper, type PasskeyAlgorithm } from '../test/support/authenticator';
import { settle } from '../test/support/heldBody';
import { parseAppConfig } from '../src/core/config';
import { objectDbs } from './entry';
import { inDirectory, ORIGIN, OWNER_EMAIL, PASSWORD, setupOwner, WorkerClient, within } from './support';

const FAILED = { error: { code: 'passkey_error', message: 'This passkey could not be used to sign in.' } };

/** POST `path` with the ceremony of an options call and the browser's answer (and more fields). */
const send = <T = any>(client: WorkerClient, path: string, ceremony: CeremonyDTO, response: unknown, extra: Record<string, unknown> = {}) =>
  client.post<T>(path, { ceremonyId: ceremony.ceremonyId, response, ...extra });

let owner: WorkerClient;
let ownerUser: UserDTO;
let spaceId: string;
let ips = 0;

/** A browser of its own address (the pk and co limits count per address). */
const browser = () => new WorkerClient(`198.51.100.${++ips}`);

beforeAll(async () => {
  ({ client: owner, user: ownerUser, spaceId } = await setupOwner());
});

async function addPasskey(client: WorkerClient, o: { alg?: PasskeyAlgorithm; counter?: number } = {}) {
  const options = await client.post<CeremonyDTO<any>>('/api/account/passkeys/options');
  expect(options.status, JSON.stringify(options.body)).toBe(200);
  const auth = await SoftAuthenticator.create({ alg: o.alg ?? -7, origin: ORIGIN, counter: o.counter });
  const res = await send<PasskeyDTO>(client, '/api/account/passkeys', options.body, await auth.register(options.body.options));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { auth, passkey: res.body };
}

async function signInWith(auth: SoftAuthenticator, o: { client?: WorkerClient; overrides?: Parameters<SoftAuthenticator['assert']>[1] } = {}) {
  const client = o.client ?? browser();
  const options = await client.post<CeremonyDTO<any>>('/api/auth/passkey/login/options', {});
  expect(options.status, JSON.stringify(options.body)).toBe(200);
  const response = await auth.assert(options.body.options, o.overrides);
  return { client, ceremonyId: options.body.ceremonyId, response, res: await send(client, '/api/auth/passkey/login', options.body, response) };
}

describe('passkeys through the Worker', () => {
  it('the status names the relying party', async () => {
    const status = await browser().get<AuthStatusDTO>('/api/auth/status');
    expect(status.body.instance.passkeys).toEqual({ enabled: true, origin: ORIGIN, rpId: 'plan.example.com' });
  });

  for (const alg of [-7, -8, -257] as const) {
    it(`registration and sign-in round trip with algorithm ${alg}`, async () => {
      const before = (await owner.get<PasskeyDTO[]>('/api/account/passkeys')).body.length;
      const { auth, passkey } = await addPasskey(owner, { alg, counter: alg === -257 ? 3 : undefined });
      expect(passkey).toMatchObject({ deviceType: 'multiDevice', backedUp: true, rpIdMatches: true, name: `Passkey ${before + 1}` });
      const stored = await inDirectory((db) =>
        db.get<{ algorithm: number; sign_count: number; rp_id: string }>('SELECT algorithm, sign_count, rp_id FROM passkeys WHERE id = :id', { id: passkey.id }),
      );
      expect(stored).toEqual({ algorithm: alg, sign_count: alg === -257 ? 3 : 0, rp_id: 'plan.example.com' });
      for (let i = 0; i < 2; i++) {
        const { client, res } = await signInWith(auth);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.user).toMatchObject({ id: ownerUser.id, email: OWNER_EMAIL });
        expect((await client.get<AuthStatusDTO>('/api/auth/status')).body.user?.id).toBe(ownerUser.id);
      }
      const after = await inDirectory((db) => db.get<{ sign_count: number }>('SELECT sign_count FROM passkeys WHERE id = :id', { id: passkey.id }));
      expect(after?.sign_count).toBe(alg === -257 ? 5 : 0);
    });
  }

  it('a sign-in options call writes no row', async () => {
    const meter = objectDbs.directory!.meter;
    const client = browser();
    const written = meter.rowsWritten;
    const res = await client.post<CeremonyDTO>('/api/auth/passkey/login/options', {});
    expect(res.status).toBe(200);
    expect(meter.rowsWritten - written).toBe(0);
    const conditional = await browser().post<CeremonyDTO>('/api/auth/passkey/login/options', { conditional: true });
    expect(conditional.status).toBe(200);
    expect(meter.rowsWritten - written).toBe(0);
  });

  it('refuses a wrong origin, a wrong RP ID, missing user verification, a bad signature and a foreign user handle', async () => {
    const { auth } = await addPasskey(owner);
    for (const overrides of [{ origin: 'https://evil.example' }, { rpId: 'evil.example' }, { userVerified: false }, { userHandle: randomToken(32) }]) {
      expect((await signInWith(auth, { overrides })).res, JSON.stringify(overrides)).toMatchObject({ status: 400, body: FAILED });
    }
    const client = browser();
    const options = await client.post<CeremonyDTO<any>>('/api/auth/passkey/login/options', {});
    const response = tamper(await auth.assert(options.body.options), 'signature');
    expect(await client.post('/api/auth/passkey/login', { ceremonyId: options.body.ceremonyId, response })).toMatchObject({ status: 400, body: FAILED });
    // Registration: the same checks.
    for (const overrides of [{ origin: 'https://evil.example' }, { rpId: 'evil.example' }, { userVerified: false }]) {
      const reg = await owner.post<CeremonyDTO<any>>('/api/account/passkeys/options');
      const fresh = await SoftAuthenticator.create({ origin: ORIGIN });
      const res = await owner.post('/api/account/passkeys', { ceremonyId: reg.body.ceremonyId, response: await fresh.register(reg.body.options, overrides) });
      expect(res.body.error?.code, JSON.stringify(overrides)).toBe('passkey_error');
    }
  });

  it('refuses a public key padded past the limit, and one whose type is not its algorithm’s; nothing is stored', async () => {
    const before = await inDirectory((db) => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM passkeys')!.n);
    for (const overrides of [{ coseExtra: [[100, new Uint8Array(1_450_000)]] as Array<[number, Uint8Array]> }, { coseAlg: -8 }]) {
      const reg = await owner.post<CeremonyDTO<any>>('/api/account/passkeys/options');
      const auth = await SoftAuthenticator.create({ origin: ORIGIN });
      const res = await owner.post('/api/account/passkeys', { ceremonyId: reg.body.ceremonyId, response: await auth.register(reg.body.options, overrides) });
      expect(res.body.error?.code, Object.keys(overrides).join()).toBe('passkey_error');
    }
    expect(await inDirectory((db) => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM passkeys')!.n)).toBe(before);
  });

  it('a ceremony works once: a replayed registration and a replayed sign-in fail', async () => {
    const reg = await owner.post<CeremonyDTO<any>>('/api/account/passkeys/options');
    const auth = await SoftAuthenticator.create({ origin: ORIGIN });
    const answer = await auth.register(reg.body.options);
    expect((await owner.post('/api/account/passkeys', { ceremonyId: reg.body.ceremonyId, response: answer })).status).toBe(201);
    expect((await owner.post('/api/account/passkeys', { ceremonyId: reg.body.ceremonyId, response: answer })).body.error.code).toBe('passkey_error');
    const { ceremonyId, response, res } = await signInWith(auth);
    expect(res.status).toBe(200);
    expect(await browser().post('/api/auth/passkey/login', { ceremonyId, response })).toMatchObject({ status: 400, body: FAILED });
  });

  it('a tampered or expired sign-in ceremony fails', async () => {
    const { auth } = await addPasskey(owner);
    const client = browser();
    const options = await client.post<CeremonyDTO<any>>('/api/auth/passkey/login/options', {});
    const response = await auth.assert(options.body.options);
    const [payload = '', signature = ''] = options.body.ceremonyId.split('.');
    const flipped = signature.slice(0, -2) + (signature.at(-2) === 'A' ? 'B' : 'A') + signature.at(-1);
    expect(await client.post('/api/auth/passkey/login', { ceremonyId: `${payload}.${flipped}`, response })).toMatchObject({ status: 400, body: FAILED });
    // Signed with the directory's own key, but expired.
    const key = await inDirectory((db) => getCeremonyKey(db));
    const expired = signLoginCeremony(key, { challenge: options.body.options.challenge, exp: Date.now() - 1 });
    expect(await client.post('/api/auth/passkey/login', { ceremonyId: expired, response })).toMatchObject({ status: 400, body: FAILED });
    // The untouched ceremony still works.
    expect((await client.post('/api/auth/passkey/login', { ceremonyId: options.body.ceremonyId, response })).status).toBe(200);
  });

  it('a counter that went back is recorded and refused; an unknown credential is named', async () => {
    const { auth, passkey } = await addPasskey(owner, { counter: 10 });
    expect((await signInWith(auth)).res.status).toBe(200);
    expect((await signInWith(auth, { overrides: { counter: 4 } })).res).toMatchObject({ status: 400, body: FAILED });
    const regression = await inDirectory((db) =>
      db.get<{ user_id: number; data: string }>("SELECT user_id, data FROM security_events WHERE type = 'passkey_counter_regression' ORDER BY id DESC LIMIT 1"),
    );
    expect(regression?.user_id).toBe(ownerUser.id);
    expect(JSON.parse(regression!.data)).toMatchObject({ passkeyId: passkey.id, stored: 11, received: 4 });
    // Another relying party's passkey (a foreign user handle) is refused without a name; one whose handle is an
    // account's here (registered here, removed since) is named, so the browser may forget it.
    const stranger = await SoftAuthenticator.create({ origin: ORIGIN });
    stranger.userHandle = randomToken(32);
    expect((await signInWith(stranger)).res).toEqual(expect.objectContaining({ status: 400, body: FAILED }));
    stranger.userHandle = auth.userHandle;
    const res = (await signInWith(stranger)).res;
    expect(res).toMatchObject({ status: 400, body: { error: { ...FAILED.error, details: [{ path: 'credential', message: 'unknown' }] } } });
  });

  it('re-authentication with a passkey, and the last usable credential with orphaned passkeys', async () => {
    const member = await signUpByInvitation('lastcred@example.com');
    const { client } = member;
    // Its only passkey (registered with the account) cannot go; an orphaned one can, and protects nothing.
    const [only] = (await client.get<PasskeyDTO[]>('/api/account/passkeys')).body;
    const last = { status: 409, body: { error: { code: 'last_credential' } } };
    expect(await client.delete(`/api/account/passkeys/${only!.id}`)).toMatchObject(last);
    const second = await addPasskey(client);
    await inDirectory((db) => db.run("UPDATE passkeys SET rp_id = 'old.example.com' WHERE id = :id", { id: second.passkey.id }));
    expect((await client.get<PasskeyDTO[]>('/api/account/passkeys')).body.map((p) => p.rpIdMatches)).toEqual([true, false]);
    expect(await client.delete(`/api/account/passkeys/${only!.id}`)).toMatchObject(last);
    // Re-authentication names the usable passkey only.
    const options = await client.post<CeremonyDTO<any>>('/api/account/reauth/passkey/options');
    expect(options.body.options.allowCredentials.map((c: { id: string }) => c.id)).toEqual([member.auth.credentialId]);
    const reauth = await send(client, '/api/account/reauth/passkey', options.body, await member.auth.assert(options.body.options));
    expect(reauth).toMatchObject({ status: 200, body: { ok: true } });
    const removed = await client.delete<PasskeyRemovedDTO>(`/api/account/passkeys/${second.passkey.id}`);
    expect(removed.body).toMatchObject({ ok: true, acceptedCredentialIds: [member.auth.credentialId] });
  });

  it('removing the password on Cloudflare without mail: the only admin keeps it; a member with a passkey may', async () => {
    await addPasskey(owner);
    expect(await owner.delete('/api/account/password')).toMatchObject({
      status: 409,
      body: { error: { code: 'last_credential', message: 'You are the only administrator and this instance cannot send mail: keep your password' } },
    });
    const member = await signUpByInvitation('member@example.com');
    // An invitation's account has no password to remove; give it one, then remove it again.
    expect((await member.client.post('/api/account/password', { newPassword: 'the member’s own password' })).status).toBe(200);
    expect(await member.client.delete('/api/account/password')).toMatchObject({ status: 200, body: { ok: true } });
    expect((await member.client.get<UserDTO>('/api/account')).body.hasPassword).toBe(false);
  });

  it('a reset link from an admin sets up a passkey for a passkey-only account', async () => {
    const member = await signUpByInvitation('reset@example.com');
    const link = await owner.post<ResetLinkDTO>(`/api/admin/users/${member.user.id}/reset-link`);
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    if (link.body.sent) throw new Error('expected a link (the log transport)');
    const token = link.body.link.match(/#t=([A-Za-z0-9_-]{43})$/)![1]!;
    const anon = browser();
    expect((await anon.post('/api/auth/password/reset/inspect', { token })).body).toMatchObject({
      hasPassword: false,
      canUsePasskey: true,
      passkeyKeepsPassword: null,
    });
    const options = await anon.post<CeremonyDTO<any>>('/api/auth/password/reset/passkey/options', { token });
    expect(options.status, JSON.stringify(options.body)).toBe(200);
    const auth = await SoftAuthenticator.create({ origin: ORIGIN, alg: -257 });
    const res = await send(anon, '/api/auth/password/reset/passkey', options.body, await auth.register(options.body.options), { token });
    expect(res).toMatchObject({ status: 200, body: { ok: true, passwordRemoved: false, passwordKept: null } });
    // Signed out everywhere; the new passkey signs in, the account's first one too.
    expect((await member.client.get<AuthStatusDTO>('/api/auth/status')).body.user).toBeNull();
    expect((await signInWith(auth)).res.status).toBe(200);
    expect((await signInWith(member.auth)).res.status).toBe(200);
  });
});

/**
 * A new account through a link invitation from the owner, with a passkey (§5.8.8): its signed-in client,
 * the account and the authenticator.
 */
async function signUpByInvitation(email: string): Promise<{ client: WorkerClient; user: UserDTO; auth: SoftAuthenticator }> {
  const created = await owner.post<InvitationCreatedDTO>(`/api/spaces/${spaceId}/invitations`, { email, role: 'member' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const token = created.body.link!.match(/#t=([A-Za-z0-9_-]{43})$/)![1]!;
  const client = browser();
  const options = await client.post<CeremonyDTO<any>>('/api/invitations/accept/passkey/options', { token, displayName: email.split('@')[0] });
  expect(options.status, JSON.stringify(options.body)).toBe(200);
  const auth = await SoftAuthenticator.create({ origin: ORIGIN, alg: -8 });
  const res = await client.post<{ user: UserDTO; spaceId: string }>('/api/invitations/accept/passkey', {
    token,
    ceremonyId: options.body.ceremonyId,
    response: await auth.register(options.body.options),
    displayName: email.split('@')[0],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body).toMatchObject({ spaceId, user: { email, hasPassword: false, passkeyCount: 1 } });
  return { client, user: res.body.user, auth };
}

describe('sign-up with a passkey, with mail (a DirectoryDO of its own, its EMAIL binding recording)', () => {
  it('creates the account with the passkey and no password, which then signs in', async () => {
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    const email = { send: async (m: { to: string; subject: string; text: string }) => (sent.push(m), { messageId: `cf-${sent.length}` }) };
    const vars = {
      ...(env as unknown as Env),
      MAIL_TRANSPORT: 'cloudflare',
      MAIL_FROM: 'no-reply@plan.example.com',
      SIGNUP_POLICY: 'open',
      EMAIL: email as unknown as SendEmail,
    };
    await runInDurableObject(env.TEST_DB.getByName('passkey-signup-directory'), async (_instance, state) => {
      const directory = new WorkerDirectoryDO(state, vars);
      await settle();
      const jar = new Map<string, string>();
      const call = async (method: string, path: string, body?: unknown) => {
        const meta = { clientIp: '192.0.2.90', secure: true, requestId: crypto.randomUUID(), userAgent: 'vitest', sessionTokenHash: null, sessionCookie: null };
        const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
        const res = await directory.fetch(
          new Request(`${ORIGIN}${path}`, {
            method,
            headers: { [META_HEADER]: encodeMeta(meta), 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        );
        for (const c of res.headers.getSetCookie()) {
          const [pair = ''] = c.split(';');
          const eq = pair.indexOf('=');
          if (/Max-Age=0/i.test(c)) jar.delete(pair.slice(0, eq));
          else jar.set(pair.slice(0, eq), pair.slice(eq + 1));
        }
        return { status: res.status, body: (await res.json()) as any };
      };
      expect((await call('POST', '/api/auth/setup', { email: OWNER_EMAIL, password: PASSWORD, displayName: 'Owner', setupCode: 'test' })).status).toBe(201);
      jar.clear();
      expect((await call('POST', '/api/auth/signup', { email: 'newcomer@example.com' })).status).toBe(202);
      await within(3000, async () => sent.some((m) => m.to === 'newcomer@example.com'));
      const token = sent.find((m) => m.to === 'newcomer@example.com')!.text.match(/#t=([A-Za-z0-9_-]{43})/)![1]!;
      const options = await call('POST', '/api/auth/signup/passkey/options', { token, displayName: 'Newcomer' });
      expect(options.status, JSON.stringify(options.body)).toBe(200);
      const auth = await SoftAuthenticator.create({ origin: ORIGIN });
      const created = await call('POST', '/api/auth/signup/passkey/complete', {
        token,
        ceremonyId: options.body.ceremonyId,
        response: await auth.register(options.body.options),
        displayName: 'Newcomer',
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.user).toMatchObject({ email: 'newcomer@example.com', emailVerified: true, hasPassword: false, passkeyCount: 1 });
      jar.clear();
      const login = await call('POST', '/api/auth/passkey/login/options', {});
      const signedIn = await call('POST', '/api/auth/passkey/login', { ceremonyId: login.body.ceremonyId, response: await auth.assert(login.body.options) });
      expect(signedIn).toMatchObject({ status: 200, body: { user: { email: 'newcomer@example.com' } } });
      // The directory set its first maintenance alarm on this bare object, which has no alarm handler.
      await state.storage.deleteAlarm();
    });
  });
});

describe('the domain-move warning on Cloudflare (§5.6, Appendix D 59)', () => {
  it('a start of the directory object reads as many rows with 2,000 accounts as with one; the hourly alarm logs the warning', async () => {
    await runInDurableObject(env.TEST_DB.getByName('passkey-warning-directory'), async (_instance, state) => {
      /** A start of the object, as after an eviction: the rows its constructor read. */
      const start = async () => {
        const directory = new WorkerDirectoryDO(state, env as unknown as Env);
        await settle();
        // A start sets the first maintenance alarm, which a bare object has no handler for.
        await state.storage.deleteAlarm();
        return { directory, rowsRead: (directory as unknown as { db: DoDb }).db.meter.rowsRead };
      };
      /** `n` more accounts without a password, each with one passkey of another address. */
      const addOrphaned = (from: number, n: number) => {
        const db = new DoDb(state.storage);
        db.run(
          `INSERT INTO users (email, email_key, display_name, webauthn_user_id, created_at, updated_at)
           WITH RECURSIVE seq(i) AS (SELECT :from UNION ALL SELECT i + 1 FROM seq WHERE i < :from + :n - 1)
           SELECT 'u' || i || '@example.com', 'u' || i || '@example.com', 'User ' || i, 'handle-' || i, '2026-10-01T00:00:00.000Z',
             '2026-10-01T00:00:00.000Z' FROM seq`,
          { from, n },
        );
        db.run(
          `INSERT INTO passkeys (user_id, credential_id, public_key, algorithm, device_type, rp_id, name, created_at)
           SELECT id, 'credential-' || id, 'key', -7, 'multiDevice', 'old.example.com', 'Passkey 1', created_at FROM users
           WHERE id NOT IN (SELECT user_id FROM passkeys)`,
        );
      };
      // The first start creates the database.
      await start();
      addOrphaned(1, 1);
      const one = await start();
      addOrphaned(2, 1999);
      const many = await start();
      expect(many.rowsRead).toBe(one.rowsRead);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await many.directory.alarm();
        expect(warn).toHaveBeenCalledWith(
          '[lyren] Warning: 2000 accounts can only sign in with passkeys that do not work on this address. Create reset links for them ' +
            '(Admin → Users), or, for administrators’ accounts, use the recovery token (RECOVERY_TOKEN).',
        );
      } finally {
        warn.mockRestore();
        await state.storage.deleteAlarm();
      }
    });
  });
});

describe('configuration errors (Appendix B)', () => {
  /** What a DirectoryDO built with `vars`, on a bare object's storage, answers to the status. */
  const statusWith = (name: string, vars: Record<string, string>) =>
    runInDurableObject(env.TEST_DB.getByName(name), async (_instance, state) => {
      const directory = new WorkerDirectoryDO(state, { ...(env as unknown as Env), ...vars });
      await settle();
      const meta = { clientIp: '192.0.2.91', secure: true, requestId: crypto.randomUUID(), userAgent: 'vitest', sessionTokenHash: null, sessionCookie: null };
      const res = await directory.fetch(new Request(`${ORIGIN}/api/auth/status`, { headers: { [META_HEADER]: encodeMeta(meta) } }));
      // One that started sets its first maintenance alarm, which a bare object has no handler for.
      await state.storage.deleteAlarm();
      return { status: res.status, body: (await res.json()) as any };
    });

  it('a WEBAUTHN_RP_ID that does not fit PUBLIC_URL, a public suffix, or set while passkeys are off: 503 with the reason', async () => {
    const expected = (value: string, host: string) =>
      `Configuration error: Invalid value for WEBAUTHN_RP_ID: ${value} (expected PUBLIC_URL's host, ${host}, ` +
      'or a parent domain of it with at least two labels, other than workers.dev or pages.dev)';
    expect(await statusWith('rp-other', { WEBAUTHN_RP_ID: 'example.org' })).toEqual({
      status: 503,
      body: { error: { code: 'unavailable', message: expected('example.org', 'plan.example.com') } },
    });
    const singleLabel = await statusWith('rp-label', { WEBAUTHN_RP_ID: 'com' });
    expect(singleLabel).toMatchObject({ status: 503, body: { error: { message: expected('com', 'plan.example.com') } } });
    expect(await statusWith('rp-suffix', { PUBLIC_URL: 'https://lyren-plan.example.workers.dev', WEBAUTHN_RP_ID: 'workers.dev' })).toMatchObject({
      status: 503,
      body: { error: { message: expected('workers.dev', 'lyren-plan.example.workers.dev') } },
    });
    // (An http PUBLIC_URL is refused before passkeys on Cloudflare, gateway.test.ts.)
    expect(await statusWith('rp-off', { PUBLIC_URL: 'https://192.0.2.1', WEBAUTHN_RP_ID: '192.0.2.1' })).toEqual({
      status: 503,
      body: {
        error: {
          code: 'unavailable',
          message: 'Configuration error: WEBAUTHN_RP_ID is set, but passkeys are off: PUBLIC_URL is an IP address, not a host name',
        },
      },
    });
    // A parent with two labels is fine, and so is the workers.dev host itself.
    const parent = await statusWith('rp-parent', { WEBAUTHN_RP_ID: 'example.com' });
    expect(parent.body.instance.passkeys).toEqual({ enabled: true, origin: ORIGIN, rpId: 'example.com' });
    const workersDev = await statusWith('rp-host', { PUBLIC_URL: 'https://lyren-plan.example.workers.dev', WEBAUTHN_RP_ID: 'lyren-plan.example.workers.dev' });
    expect(workersDev.body.instance.passkeys.rpId).toBe('lyren-plan.example.workers.dev');
  });
});

describe('CPU time of the verifications (§11.1: Workers Free allows 10 ms per request)', () => {
  // The clock of workerd counts whole milliseconds, so each figure is a batch's time divided by its size.
  const BATCH = 40;

  it('measures registration and assertion verification per algorithm, inside the directory object', async () => {
    const rp = relyingParty(parseAppConfig({ PUBLIC_URL: ORIGIN }, 'cloudflare').directory.passkeys)!;
    const results = await runInDurableObject(env.DIRECTORY.getByName('directory'), async () => {
      const rows: Array<{ alg: PasskeyAlgorithm; register: number; assert: number }> = [];
      for (const alg of [-7, -8, -257] as const) {
        const auth = await SoftAuthenticator.create({ alg, origin: ORIGIN });
        // The answers are made first (signing is the authenticator's work, not the server's).
        const registrations = [];
        for (let i = 0; i < BATCH; i++) {
          const challenge = randomToken();
          const user = { userHandle: randomToken(32), userName: 'cpu@example.com', displayName: 'CPU', exclude: [] };
          const options = await registrationOptions(rp, { challenge, ...user });
          registrations.push({ challenge, answer: await auth.register(options) });
        }
        const assertions = [];
        for (let i = 0; i < BATCH; i++) {
          const challenge = randomToken();
          assertions.push({ challenge, answer: await auth.assert(await authenticationOptions(rp, { challenge, allow: [] })) });
        }
        let started = performance.now();
        let credential: RegisteredCredential | null = null;
        for (const r of registrations) credential = await verifyRegistration(rp, r.answer, r.challenge);
        const register = (performance.now() - started) / BATCH;
        expect(credential).not.toBeNull();
        const stored = { credentialId: credential!.credentialId, publicKey: credential!.publicKey, transports: [] };
        started = performance.now();
        let verified = 0;
        for (const a of assertions) if (await verifyAssertion(rp, a.answer, a.challenge, stored)) verified++;
        const assert = (performance.now() - started) / BATCH;
        expect(verified).toBe(BATCH);
        rows.push({ alg, register, assert });
      }
      return rows;
    });
    // For comparison, and as proof that the local clock moves while code runs: one password hash at
    // Cloudflare's default cost (scrypt N = 16384, r = 8, p = 1; research: 14-22 ms in workerd).
    const scrypt = await runInDurableObject(env.DIRECTORY.getByName('directory'), () => {
      const started = performance.now();
      scryptSync('a password', 'a salt of 16 b.', 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      return performance.now() - started;
    });
    console.log(`[cpu] scrypt N=16384 r=8 p=1 (a password check, for comparison): ${scrypt.toFixed(2)} ms`);
    expect(scrypt).toBeGreaterThan(1);
    for (const r of results) {
      console.log(`[cpu] alg ${r.alg}: verifyRegistration ${r.register.toFixed(2)} ms, verifyAssertion ${r.assert.toFixed(2)} ms (average of ${BATCH})`);
      expect(r.assert).toBeLessThan(10);
      expect(r.register).toBeLessThan(10);
    }
    // Whole sign-ins as the test sees their wall time: the Worker and the directory object together.
    const { auth } = await addPasskey(owner);
    const prepared = [];
    for (let i = 0; i < 10; i++) {
      const client = browser();
      const options = await client.post<CeremonyDTO<any>>('/api/auth/passkey/login/options', {});
      prepared.push({ client, body: JSON.stringify({ ceremonyId: options.body.ceremonyId, response: await auth.assert(options.body.options) }) });
    }
    const started = performance.now();
    for (const p of prepared) {
      const res = await SELF.fetch(`${ORIGIN}/api/auth/passkey/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Lyren-Request': '1', 'CF-Connecting-IP': p.client.ip },
        body: p.body,
      });
      expect(res.status).toBe(200);
      await res.text();
    }
    const average = (performance.now() - started) / prepared.length;
    console.log(`[cpu] POST /api/auth/passkey/login (ES256) through the Worker: ${average.toFixed(2)} ms wall time (average of ${prepared.length})`);
  });
});
