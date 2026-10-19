// The WebAuthn wrapper (design §5.6): the relying party from the configuration, the fixed options, the
// verifications for the three algorithms (with the software authenticator), the public key's size and type,
// and the small rules: the counter, the transports, the user handle.

import { describe, expect, it } from 'vitest';
import { parseAppConfig } from '../../src/core/config';
import { fromBase64Url, randomToken } from '../../src/core/crypto';
import {
  authenticationOptions,
  cleanTransports,
  counterRegressed,
  PUBLIC_KEY_MAX,
  registrationOptions,
  relyingParty,
  userHandleOf,
  verifyAssertion,
  verifyRegistration,
} from '../../src/passkeys/webauthn';
import { SoftAuthenticator, tamper } from '../support/authenticator';

const ORIGIN = 'https://plan.example.com';
const rp = relyingParty(parseAppConfig({ PUBLIC_URL: ORIGIN, INSTANCE_NAME: 'Acme Plan' }, 'node').directory.passkeys)!;

describe('the relying party', () => {
  it('comes from PUBLIC_URL, WEBAUTHN_RP_ID and INSTANCE_NAME, and is null while passkeys are off', () => {
    expect(rp).toEqual({ rpId: 'plan.example.com', origin: ORIGIN, rpName: 'Acme Plan' });
    expect(relyingParty(parseAppConfig({ PUBLIC_URL: ORIGIN, WEBAUTHN_RP_ID: 'example.com' }, 'node').directory.passkeys)?.rpId).toBe('example.com');
    expect(relyingParty(parseAppConfig({}, 'node').directory.passkeys)).toBeNull();
    expect(relyingParty(parseAppConfig({ PUBLIC_URL: 'https://192.0.2.10' }, 'cloudflare').directory.passkeys)).toBeNull();
  });
});

describe('options and verification', () => {
  it('offer EdDSA, ES256 and RS256 only (never ML-DSA, whatever the runtime supports), with the challenge given', async () => {
    const challenge = randomToken();
    const options = await registrationOptions(rp, { challenge, userHandle: randomToken(32), userName: 'ada@example.com', displayName: 'Ada', exclude: [] });
    expect(options.challenge).toBe(challenge);
    expect(options.pubKeyCredParams.map((p) => p.alg)).toEqual([-8, -7, -257]);
    const login = await authenticationOptions(rp, { challenge, allow: [{ credentialId: 'abc', transports: ['usb'] }], conditional: true });
    expect(login).toMatchObject({
      challenge,
      rpId: 'plan.example.com',
      allowCredentials: [{ id: 'abc', type: 'public-key', transports: ['usb'] }],
      timeout: 300_000,
    });
  });

  for (const alg of [-7, -8, -257] as const) {
    it(`registration and assertion round trip with ${alg}; a tampered or misdirected answer is null`, async () => {
      const auth = await SoftAuthenticator.create({ alg, origin: ORIGIN, backup: { eligible: false, state: false } });
      const challenge = randomToken();
      const options = await registrationOptions(rp, { challenge, userHandle: randomToken(32), userName: 'ada@example.com', displayName: 'Ada', exclude: [] });
      const registration = await auth.register(options);
      const credential = await verifyRegistration(rp, registration, challenge);
      expect(credential).toMatchObject({ credentialId: auth.credentialId, algorithm: alg, counter: 0, deviceType: 'singleDevice', backedUp: false });
      expect(credential?.transports).toEqual(['internal', 'hybrid']);
      expect(await verifyRegistration(rp, registration, randomToken())).toBeNull();
      expect(await verifyRegistration(rp, tamper(registration, 'clientDataJSON'), challenge)).toBeNull();

      const stored = { credentialId: credential!.credentialId, publicKey: credential!.publicKey, transports: credential!.transports };
      const loginChallenge = randomToken();
      const login = await authenticationOptions(rp, { challenge: loginChallenge, allow: [] });
      const assertion = await auth.assert(login);
      expect(await verifyAssertion(rp, assertion, loginChallenge, stored)).toEqual({ counter: 0, backedUp: false });
      expect(await verifyAssertion(rp, tamper(assertion, 'signature'), loginChallenge, stored)).toBeNull();
      expect(await verifyAssertion(rp, await auth.assert(login, { origin: 'https://evil.example' }), loginChallenge, stored)).toBeNull();
      expect(await verifyAssertion(rp, await auth.assert(login, { rpId: 'example.com' }), loginChallenge, stored)).toBeNull();
      expect(await verifyAssertion(rp, await auth.assert(login, { userVerified: false }), loginChallenge, stored)).toBeNull();
      expect(await verifyAssertion(rp, { not: 'an answer' }, loginChallenge, stored)).toBeNull();
    });
  }

  it('refuse a public key padded past PUBLIC_KEY_MAX, and one whose type is not its algorithm’s', async () => {
    const register = async (alg: -7 | -8 | -257, o: Parameters<SoftAuthenticator['register']>[1]) => {
      const auth = await SoftAuthenticator.create({ alg, origin: ORIGIN });
      const challenge = randomToken();
      const options = await registrationOptions(rp, { challenge, userHandle: randomToken(32), userName: 'ada@example.com', displayName: 'Ada', exclude: [] });
      return verifyRegistration(rp, await auth.register(options, o), challenge);
    };
    // Nothing signs the key with attestation 'none': an extra member the verification never reads would be stored.
    const padded = await register(-7, { coseExtra: [[100, new Uint8Array(PUBLIC_KEY_MAX)]] });
    expect(padded).toBeNull();
    const roomy = await register(-7, { coseExtra: [[100, new Uint8Array(PUBLIC_KEY_MAX - 200)]] });
    expect(fromBase64Url(roomy!.publicKey).byteLength).toBeLessThanOrEqual(PUBLIC_KEY_MAX);
    // An EC2 key labelled EdDSA or RS256, an OKP key labelled ES256, an RSA key labelled ES256.
    expect(await register(-7, { coseAlg: -8 })).toBeNull();
    expect(await register(-7, { coseAlg: -257 })).toBeNull();
    expect(await register(-8, { coseAlg: -7 })).toBeNull();
    expect(await register(-257, { coseAlg: -7 })).toBeNull();
    // Another curve under ES256's label.
    expect(await register(-7, { coseExtra: [[-1, 2]] })).toBeNull();
  });

  it('leave the counter to the caller: an answer with a lower counter verifies, and counterRegressed says so', async () => {
    const auth = await SoftAuthenticator.create({ origin: ORIGIN, counter: 7 });
    const challenge = randomToken();
    const options = await registrationOptions(rp, { challenge, userHandle: randomToken(32), userName: 'a', displayName: 'A', exclude: [] });
    const credential = (await verifyRegistration(rp, await auth.register(options), challenge))!;
    expect(credential.counter).toBe(7);
    const loginChallenge = randomToken();
    const answer = await auth.assert(await authenticationOptions(rp, { challenge: loginChallenge, allow: [] }), { counter: 3 });
    const stored = { credentialId: credential.credentialId, publicKey: credential.publicKey, transports: [] };
    const result = await verifyAssertion(rp, answer, loginChallenge, stored);
    expect(result?.counter).toBe(3);
    expect(counterRegressed(7, 3)).toBe(true);
    expect(counterRegressed(7, 7)).toBe(true);
    expect(counterRegressed(7, 8)).toBe(false);
    expect(counterRegressed(0, 0)).toBe(false);
    expect(counterRegressed(0, 1)).toBe(false);
    expect(counterRegressed(5, 0)).toBe(true);
  });
});

describe('small rules', () => {
  it('transports: the known ones, once each; the user handle of an answer', () => {
    expect(cleanTransports(['usb', 'nfc', 'usb', 'carrier-pigeon', 7, 'hybrid'])).toEqual(['usb', 'nfc', 'hybrid']);
    expect(cleanTransports('usb')).toEqual([]);
    expect(userHandleOf({ response: { userHandle: 'abc' } })).toBe('abc');
    expect(userHandleOf({ response: { userHandle: '' } })).toBeNull();
    expect(userHandleOf({ response: {} })).toBeNull();
    expect(userHandleOf(null)).toBeNull();
  });
});
