// WebAuthn (design §5.6) through @simplewebauthn/server 14.0.3: the relying party and the fixed options of
// every ceremony. Runtime-neutral: the library takes its crypto from globalThis.crypto (WebCrypto), which
// Node and workerd both have, and it imports nothing of Node's.
//
// - The RP ID, the expected origin and the RP name come from the configuration (PUBLIC_URL, WEBAUTHN_RP_ID,
//   INSTANCE_NAME; core/config.ts#PasskeyConfig), never from a request's Host, X-Forwarded-Host or URL. Off
//   without a PUBLIC_URL that allows them (the desktop app at 127.0.0.1, LAN installs reached by address).
// - The algorithms are fixed, EdDSA (-8), ES256 (-7) and RS256 (-257), on both the options and the
//   verification: the library's default adds ML-DSA-44 on Node 24, which workerd cannot verify, so a passkey
//   registered on Node would stop working on Cloudflare.
// - User verification is required (a passkey replaces a password), credentials are discoverable (signing in
//   needs no identifier), and attestation is 'none'.
// - The verify functions answer null for every failure (the library throws for most of them), so the routes
//   give one passkey_error whatever went wrong. The signature counter is compared by the caller, after the
//   signature is verified (verifyAssertion). A registration's public key must be of its algorithm's type and
//   at most PUBLIC_KEY_MAX bytes (nothing signs it with attestation 'none').

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { cose, decodeCredentialPublicKey } from '@simplewebauthn/server/helpers';
import type { PasskeyConfig } from '../core/config';
import { fromBase64Url, toBase64Url } from '../core/crypto';

/** COSE algorithm ids offered and accepted: EdDSA, ES256, RS256 (never ML-DSA, see above). */
export const PASSKEY_ALGORITHMS: readonly number[] = [-8, -7, -257];

/** How long the browser shows its prompt: a minute, or 5 for the sign-in field's autofill (conditional UI). */
export const PROMPT_TIMEOUT_MS = 60_000;
export const CONDITIONAL_PROMPT_TIMEOUT_MS = 5 * 60_000;

/** The transports a credential may report (AuthenticatorTransportFuture); anything else is dropped. */
const TRANSPORTS: ReadonlySet<string> = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);

/** The longest credential id kept (base64url): what sign-in accepts in `response.id` (ceremonyResponseInput). */
const CREDENTIAL_ID_MAX = 1024;

/**
 * The largest COSE public key kept, in bytes. Real ones are small (ES256 about 77, Ed25519 44, RS256 272 with
 * 2048 bits, 530 with 4096), but with attestation 'none' nothing signs the key at registration, so one padded
 * with a member the verification never reads would otherwise be stored as sent, up to the body limit, on every
 * read of the account's passkeys (Appendix D 59).
 */
export const PUBLIC_KEY_MAX = 2048;

/** The COSE key type (and curve) each algorithm's key must have: EC2 on P-256, OKP Ed25519, RSA. */
const KEY_TYPES: Readonly<Record<number, { kty: number; crv?: number }>> = {
  [-7]: { kty: cose.COSEKTY.EC2, crv: cose.COSECRV.P256 },
  [-8]: { kty: cose.COSEKTY.OKP, crv: cose.COSECRV.ED25519 },
  [-257]: { kty: cose.COSEKTY.RSA },
};

/** The algorithm of a COSE public key that is one of PASSKEY_ALGORITHMS with its own key type, else null. */
function keyAlgorithm(publicKey: Parameters<typeof decodeCredentialPublicKey>[0]): number | null {
  if (publicKey.byteLength > PUBLIC_KEY_MAX) return null;
  const key = decodeCredentialPublicKey(publicKey) as unknown as ReadonlyMap<number, unknown>;
  const algorithm = key.get(cose.COSEKEYS.alg);
  if (typeof algorithm !== 'number' || !PASSKEY_ALGORITHMS.includes(algorithm)) return null;
  const type = KEY_TYPES[algorithm]!;
  if (key.get(cose.COSEKEYS.kty) !== type.kty || (type.crv !== undefined && key.get(cose.COSEKEYS.crv) !== type.crv)) return null;
  return algorithm;
}

/** Who the passkeys are for: the configuration's RP ID, origin and name. */
export interface RelyingParty {
  rpId: string;
  origin: string;
  rpName: string;
}

/** The relying party, or null while passkeys are off. */
export function relyingParty(config: PasskeyConfig): RelyingParty | null {
  if (!config.enabled || config.rpId === null || config.origin === null) return null;
  return { rpId: config.rpId, origin: config.origin, rpName: config.rpName };
}

/** A credential as the options name it: its id and the transports it reported. */
export interface CredentialRef {
  credentialId: string;
  transports: readonly string[];
}

/** The bytes of a base64url text, in an ArrayBuffer of their own (the library's Uint8Array type). */
const bytes = (text: string) => new Uint8Array(fromBase64Url(text));

const descriptors = (credentials: readonly CredentialRef[]) => credentials.map((c) => ({ id: c.credentialId, transports: [...c.transports] }));

/**
 * The options of a registration (§5.6) with `challenge` (base64url; the caller stored or signed it before,
 * so nothing it checked can change while the options are made): the account's WebAuthn user handle
 * (base64url of 32 random bytes, no personal data), its sign-in name and display name, and the passkeys it
 * has here (excluded, so an authenticator is not registered twice).
 */
export function registrationOptions(
  rp: RelyingParty,
  o: { challenge: string; userHandle: string; userName: string; displayName: string; exclude: readonly CredentialRef[] },
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpId,
    challenge: bytes(o.challenge),
    userID: bytes(o.userHandle),
    userName: o.userName,
    userDisplayName: o.displayName,
    attestationType: 'none',
    // A fresh object: the library writes requireResidentKey into it.
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    supportedAlgorithmIDs: [...PASSKEY_ALGORITHMS],
    excludeCredentials: descriptors(o.exclude),
    timeout: PROMPT_TIMEOUT_MS,
  });
}

/**
 * The options of an assertion with `challenge` (as for registrationOptions): for signing in no credentials
 * (the browser offers the discoverable ones; `conditional` for the sign-in field's autofill), for
 * re-authentication the account's passkeys.
 */
export function authenticationOptions(
  rp: RelyingParty,
  o: { challenge: string; allow: readonly CredentialRef[]; conditional?: boolean },
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: rp.rpId,
    challenge: bytes(o.challenge),
    userVerification: 'required',
    allowCredentials: descriptors(o.allow),
    timeout: o.conditional ? CONDITIONAL_PROMPT_TIMEOUT_MS : PROMPT_TIMEOUT_MS,
  });
}

/** What a verified registration stores (§5.6). */
export interface RegisteredCredential {
  credentialId: string;
  /** The COSE public key, base64url. */
  publicKey: string;
  /** COSE key label 3: one of PASSKEY_ALGORITHMS. */
  algorithm: number;
  counter: number;
  transports: string[];
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
  aaguid: string;
}

/** The transports of a response or a stored row: known ones only, once each. */
export function cleanTransports(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((t): t is string => typeof t === 'string' && TRANSPORTS.has(t)))];
}

/** Verify the browser's answer to registration options with `challenge`; null when it does not verify. */
export async function verifyRegistration(rp: RelyingParty, response: unknown, challenge: string): Promise<RegisteredCredential | null> {
  try {
    const result = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      requireUserVerification: true,
      supportedAlgorithmIDs: [...PASSKEY_ALGORITHMS],
    });
    if (!result.verified) return null;
    const info = result.registrationInfo;
    const algorithm = keyAlgorithm(info.credential.publicKey);
    if (algorithm === null || info.credential.id.length > CREDENTIAL_ID_MAX || !info.userVerified) return null;
    return {
      credentialId: info.credential.id,
      publicKey: toBase64Url(info.credential.publicKey),
      algorithm,
      counter: info.credential.counter,
      transports: cleanTransports(info.credential.transports),
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      aaguid: info.aaguid,
    };
  } catch {
    return null;
  }
}

/** A stored passkey as an assertion is verified against it. */
export interface StoredCredential extends CredentialRef {
  /** base64url COSE public key. */
  publicKey: string;
}

/**
 * Verify the browser's answer to authentication options with `challenge` against `credential`; null when
 * it does not verify. The counter is not compared here: the library compares it before the signature, so
 * a forged answer could pass for a cloned authenticator; the caller compares the returned counter with the
 * stored one once the signature is known to be good.
 */
export async function verifyAssertion(
  rp: RelyingParty,
  response: unknown,
  challenge: string,
  credential: StoredCredential,
): Promise<{ counter: number; backedUp: boolean } | null> {
  try {
    const result = await verifyAuthenticationResponse({
      response: response as AuthenticationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      // Counter 0: the library's own comparison never refuses (see above).
      credential: { id: credential.credentialId, publicKey: bytes(credential.publicKey), counter: 0, transports: [...credential.transports] },
      requireUserVerification: true,
    });
    if (!result.verified || !result.authenticationInfo.userVerified) return null;
    return { counter: result.authenticationInfo.newCounter, backedUp: result.authenticationInfo.credentialBackedUp };
  } catch {
    return null;
  }
}

/**
 * A signature counter that did not move forward (§5.6): a cloned authenticator, or a replayed answer. A
 * counter that stays 0 is no regression (synced passkeys keep it at 0).
 */
export function counterRegressed(stored: number, received: number): boolean {
  return (received > 0 || stored > 0) && received <= stored;
}

/** The user handle of an assertion (`response.response.userHandle`), or null when it carries none. */
export function userHandleOf(response: unknown): string | null {
  const handle = (response as { response?: { userHandle?: unknown } } | null)?.response?.userHandle;
  return typeof handle === 'string' && handle !== '' ? handle : null;
}
