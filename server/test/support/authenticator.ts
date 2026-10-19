// A software authenticator for the passkey tests (design §14.8, P6), ported from the research's
// cf-auth/work/roundtrip.mjs: it answers the options the server's WebAuthn calls make as a browser and a
// platform authenticator would, with WebCrypto only, so the same fixture runs on Node and in workerd.
//
// - One credential per authenticator: ES256 (-7, P-256), Ed25519 (-8) or RS256 (-257, 2048 bits), a random
//   credential id, the user handle of the options it registered with, and a signature counter that stays 0
//   (synced passkeys) or counts up from a start.
// - register() answers registration options (attestation 'none'), assert() authentication options; both take
//   overrides of what a test wants wrong: the origin or type in clientDataJSON, the RP ID whose hash goes into
//   the authenticator data, the challenge, the flags (user present, user verified, backup), the counter, the
//   user handle, and for register() the COSE key's algorithm label and extra members.
// - tamper() flips a bit of one part of an answer, which invalidates its signature (or its attestation).
//
// Authenticator data: rpIdHash (32) | flags (1) | counter (4, big-endian) | for registration the attested
// credential (AAGUID 16 zero bytes, credential id length 2, id, COSE key). Flags: UP 0x01, UV 0x04, BE 0x08,
// BS 0x10, AT 0x40.

import { fromBase64Url, toBase64Url } from '../../src/core/crypto';

export type PasskeyAlgorithm = -7 | -8 | -257;

const te = new TextEncoder();

const UP = 0x01;
const UV = 0x04;
const BE = 0x08;
const BS = 0x10;
const AT = 0x40;

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const sha256 = async (data: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', data));
const be32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

// --- A minimal CBOR encoder: unsigned and negative integers, byte and text strings, maps ---

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;

function head(major: number, n: number): Uint8Array {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n < 256) return new Uint8Array([(major << 5) | 24, n]);
  if (n < 65536) return new Uint8Array([(major << 5) | 25, n >> 8, n & 255]);
  return concat(new Uint8Array([(major << 5) | 26]), be32(n));
}

function cbor(v: Cbor): Uint8Array {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const b = te.encode(v);
    return concat(head(3, b.length), b);
  }
  if (v instanceof Uint8Array) return concat(head(2, v.length), v);
  const parts = [head(5, v.size)];
  for (const [key, value] of v) parts.push(cbor(key), cbor(value));
  return concat(...parts);
}

// --- ECDSA signatures: WebCrypto gives r || s, WebAuthn wants DER ---

function derInt(b: Uint8Array): Uint8Array<ArrayBuffer> {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  let x = b.slice(i);
  if (x[0]! & 0x80) x = concat(new Uint8Array([0]), x);
  return concat(new Uint8Array([0x02, x.length]), x);
}

function rawToDer(sig: Uint8Array): Uint8Array<ArrayBuffer> {
  const r = derInt(sig.slice(0, 32));
  const s = derInt(sig.slice(32));
  return concat(new Uint8Array([0x30, r.length + s.length]), r, s);
}

// WebCrypto's own types differ between the Node and the Workers typings, so the fixture names them loosely.
type Params = { name: string } & Record<string, unknown>;
type Key = Parameters<typeof crypto.subtle.exportKey>[1];
type KeyPair = { publicKey: Key; privateKey: Key };

const ALGORITHMS: Record<PasskeyAlgorithm, { generate: Params; sign: Params }> = {
  [-7]: { generate: { name: 'ECDSA', namedCurve: 'P-256' }, sign: { name: 'ECDSA', hash: 'SHA-256' } },
  [-8]: { generate: { name: 'Ed25519' }, sign: { name: 'Ed25519' } },
  [-257]: {
    generate: { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    sign: { name: 'RSASSA-PKCS1-v1_5' },
  },
};

async function coseKey(alg: PasskeyAlgorithm, publicKey: Key): Promise<Map<Cbor, Cbor>> {
  const jwk = (await crypto.subtle.exportKey('jwk', publicKey)) as { x?: string; y?: string; n?: string; e?: string };
  const d = (s: string | undefined) => fromBase64Url(s ?? '');
  if (alg === -7) return new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, d(jwk.x)], [-3, d(jwk.y)]]);
  if (alg === -8) return new Map<Cbor, Cbor>([[1, 1], [3, -8], [-1, 6], [-2, d(jwk.x)]]);
  return new Map<Cbor, Cbor>([[1, 3], [3, -257], [-1, d(jwk.n)], [-2, d(jwk.e)]]);
}

/** What register() reads of registration options (PublicKeyCredentialCreationOptionsJSON). */
export interface RegistrationOptionsLike {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams?: Array<{ alg: number; type: string }>;
}

/** What assert() reads of authentication options (PublicKeyCredentialRequestOptionsJSON). */
export interface AuthenticationOptionsLike {
  challenge: string;
  rpId?: string;
  allowCredentials?: Array<{ id: string; type: string }>;
}

/** What a test may make wrong in an answer. */
export interface AnswerOverrides {
  /** clientDataJSON.origin (default: the authenticator's origin). */
  origin?: string;
  /** clientDataJSON.type (default webauthn.create / webauthn.get). */
  type?: string;
  /** clientDataJSON.challenge (default: the options'). */
  challenge?: string;
  /** The RP ID whose hash the authenticator data carries (default: the options'). */
  rpId?: string;
  /** The UP flag (default true). */
  userPresent?: boolean;
  /** The UV flag (default true). */
  userVerified?: boolean;
  /** The counter to report (default: the authenticator's next one). */
  counter?: number;
}

/** What a test may make wrong in a registration's answer, besides AnswerOverrides: the COSE public key. */
export interface RegistrationOverrides extends AnswerOverrides {
  /** The COSE key's algorithm label (3) instead of the authenticator's own. */
  coseAlg?: number;
  /** More members of the COSE key map (for example a padding byte string the verification never reads). */
  coseExtra?: Array<[number, number | string | Uint8Array]>;
}

export interface RegistrationAnswer {
  id: string;
  rawId: string;
  type: 'public-key';
  clientExtensionResults: Record<string, unknown>;
  authenticatorAttachment: 'platform';
  response: { clientDataJSON: string; attestationObject: string; transports: string[] };
}

export interface AuthenticationAnswer {
  id: string;
  rawId: string;
  type: 'public-key';
  clientExtensionResults: Record<string, unknown>;
  authenticatorAttachment: 'platform';
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
}

export class SoftAuthenticator {
  /** base64url; the same for registration and every assertion. */
  readonly credentialId: string;
  /** The user handle of the options it registered with (base64url); null before register(). */
  userHandle: string | null = null;
  /** The counter last reported; it stays 0 unless the authenticator counts. */
  counter: number;

  private constructor(
    readonly alg: PasskeyAlgorithm,
    readonly origin: string,
    private readonly keys: KeyPair,
    /** A counting authenticator reports counter + 1 at each use; otherwise 0 forever. */
    private readonly counts: boolean,
    /** BE: the credential may be synced ('multiDevice'); BS: it is backed up. */
    readonly backup: { eligible: boolean; state: boolean },
    credentialId: Uint8Array,
  ) {
    this.credentialId = toBase64Url(credentialId);
    this.counter = 0;
  }

  /**
   * A new authenticator for `origin`: `counter` given, it counts up from there (5: the registration reports
   * 5, the first assertion 6); otherwise it keeps reporting 0, as synced passkeys do. `backup` default: a
   * synced passkey (BE and BS set); { eligible: false, state: false } is a single-device one.
   */
  static async create(o: {
    alg?: PasskeyAlgorithm;
    origin: string;
    counter?: number;
    backup?: { eligible: boolean; state: boolean };
  }): Promise<SoftAuthenticator> {
    const alg = o.alg ?? -7;
    const generate = ALGORITHMS[alg].generate as Parameters<typeof crypto.subtle.importKey>[2];
    const keys = (await crypto.subtle.generateKey(generate as never, false, ['sign', 'verify'])) as unknown as KeyPair;
    const authenticator = new SoftAuthenticator(
      alg,
      o.origin,
      keys,
      o.counter !== undefined,
      o.backup ?? { eligible: true, state: true },
      crypto.getRandomValues(new Uint8Array(16)),
    );
    authenticator.counter = o.counter ?? 0;
    return authenticator;
  }

  private flags(o: AnswerOverrides, extra: number): number {
    let flags = extra;
    if (o.userPresent ?? true) flags |= UP;
    if (o.userVerified ?? true) flags |= UV;
    if (this.backup.eligible) flags |= BE;
    if (this.backup.state) flags |= BS;
    return flags;
  }

  private clientData(type: string, challenge: string, o: AnswerOverrides): Uint8Array {
    return te.encode(JSON.stringify({ type: o.type ?? type, challenge: o.challenge ?? challenge, origin: o.origin ?? this.origin, crossOrigin: false }));
  }

  /** The COSE public key a registration carries, with the overrides' label and members. */
  private async publicKey(o: RegistrationOverrides): Promise<Map<Cbor, Cbor>> {
    const key = await coseKey(this.alg, this.keys.publicKey);
    if (o.coseAlg !== undefined) key.set(3, o.coseAlg);
    for (const [label, value] of o.coseExtra ?? []) key.set(label, value);
    return key;
  }

  /** The answer of navigator.credentials.create() to `options`, as startRegistration() returns it. */
  async register(options: RegistrationOptionsLike, o: RegistrationOverrides = {}): Promise<RegistrationAnswer> {
    this.userHandle = options.user.id;
    const rpId = o.rpId ?? options.rp.id ?? new URL(this.origin).hostname;
    const clientDataJSON = this.clientData('webauthn.create', options.challenge, o);
    const credentialId = fromBase64Url(this.credentialId);
    const authData = concat(
      await sha256(te.encode(rpId)),
      new Uint8Array([this.flags(o, AT)]),
      be32(o.counter ?? this.counter),
      new Uint8Array(16),
      new Uint8Array([credentialId.length >> 8, credentialId.length & 255]),
      credentialId,
      cbor(await this.publicKey(o)),
    );
    const attestationObject = cbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
      response: { clientDataJSON: toBase64Url(clientDataJSON), attestationObject: toBase64Url(attestationObject), transports: ['internal', 'hybrid'] },
    };
  }

  /**
   * The answer of navigator.credentials.get() to `options`, as startAuthentication() returns it. A counting
   * authenticator moves its counter on (unless `counter` overrides it). `userHandle`: the handle to send
   * (default the registered one; null sends none).
   */
  async assert(options: AuthenticationOptionsLike, o: AnswerOverrides & { userHandle?: string | null } = {}): Promise<AuthenticationAnswer> {
    const rpId = o.rpId ?? options.rpId ?? new URL(this.origin).hostname;
    const counter = o.counter ?? (this.counts ? this.counter + 1 : 0);
    if (o.counter === undefined) this.counter = counter;
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, o);
    const authData = concat(await sha256(te.encode(rpId)), new Uint8Array([this.flags(o, 0)]), be32(counter));
    const signed = concat(authData, await sha256(clientDataJSON));
    const sign = ALGORITHMS[this.alg].sign as Parameters<typeof crypto.subtle.sign>[0];
    let signature: Uint8Array = new Uint8Array(await crypto.subtle.sign(sign, this.keys.privateKey, signed));
    if (this.alg === -7) signature = rawToDer(signature);
    const userHandle = o.userHandle === undefined ? this.userHandle : o.userHandle;
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: toBase64Url(clientDataJSON),
        authenticatorData: toBase64Url(authData),
        signature: toBase64Url(signature),
        ...(userHandle === null ? {} : { userHandle }),
      },
    };
  }
}

/** A copy of `answer` with one bit of `part` (a base64url field of its response) flipped. */
export function tamper<T extends RegistrationAnswer | AuthenticationAnswer>(answer: T, part: keyof T['response'] & string, byte = -1): T {
  const response = answer.response as Record<string, unknown>;
  const value = response[part];
  if (typeof value !== 'string') throw new Error(`tamper: the answer has no ${part}`);
  const data = fromBase64Url(value);
  const index = byte < 0 ? data.length + byte : byte;
  data[index] = data[index]! ^ 0x01;
  return { ...answer, response: { ...answer.response, [part]: toBase64Url(data) } };
}

/** The challenge, origin and type an answer's clientDataJSON carries. */
export function clientDataOf(answer: RegistrationAnswer | AuthenticationAnswer): { type: string; challenge: string; origin: string } {
  return JSON.parse(new TextDecoder().decode(fromBase64Url(answer.response.clientDataJSON))) as { type: string; challenge: string; origin: string };
}
