// WebAuthn ceremonies (design §4.1, §5.6, §14.2): the signed sign-in ceremony (tampering, expiry, purpose,
// the key, single use through its row) and the stored ones (single use, expiry, bindings, at most 5 per
// binding), on a directory database (NodeDb's portability checks are on under vitest).

import { describe, expect, it } from 'vitest';
import { fromBase64Url, randomToken, sha256Hex, toBase64Url } from '../../src/core/crypto';
import { migrate } from '../../src/core/migrate';
import { APP_VERSION } from '../../src/core/version';
import { DIRECTORY_MIGRATIONS } from '../../src/directory/schema';
import {
  CEREMONY_TTL_MS,
  ceremonyMatches,
  CONDITIONAL_CEREMONY_TTL_MS,
  consumeCeremony,
  consumeLoginCeremony,
  openLoginCeremony,
  signLoginCeremony,
  storeCeremony,
} from '../../src/passkeys/ceremonies';
import { NodeDb } from '../../src/runtime/node/nodeDb';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const KEY = randomToken(32);

function directoryDb(): NodeDb {
  const db = new NodeDb(':memory:');
  migrate(db, DIRECTORY_MIGRATIONS, { appVersion: APP_VERSION });
  return db;
}

/** A user with a session and an email token, for the bindings. */
function bound(db: NodeDb) {
  const now = new Date(NOW).toISOString();
  const userId = db.get<{ id: number }>(
    `INSERT INTO users (email, email_key, display_name, webauthn_user_id, created_at, updated_at)
     VALUES ('ada@example.com', 'ada@example.com', 'Ada', :handle, :now, :now) RETURNING id`,
    { handle: randomToken(32), now },
  )!.id;
  const session = (hash: string) =>
    db.get<{ id: number }>(
      `INSERT INTO sessions (token_hash, user_id, auth_method, reauth_at, created_at, last_seen_at, expires_at)
       VALUES (:hash, :userId, 'password', :now, :now, :now, :now) RETURNING id`,
      { hash, userId, now },
    )!.id;
  const tokenId = db.get<{ id: number }>(
    `INSERT INTO email_tokens (token_hash, purpose, user_id, email, email_key, auth_epoch, created_at, expires_at)
     VALUES ('t', 'reset_password', :userId, 'ada@example.com', 'ada@example.com', 0, :now, :now) RETURNING id`,
    { userId, now },
  )!.id;
  return { userId, sessionId: session('a'.repeat(64)), otherSessionId: session('b'.repeat(64)), tokenId };
}

describe('signed sign-in ceremonies', () => {
  it('carry their challenge and expiry, at most 200 characters, and open only with their key until they expire', () => {
    const challenge = randomToken();
    const id = signLoginCeremony(KEY, { challenge, exp: NOW + CEREMONY_TTL_MS });
    expect(id).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(id.length).toBeLessThanOrEqual(200);
    const conditional = signLoginCeremony(KEY, { challenge, exp: NOW + CONDITIONAL_CEREMONY_TTL_MS });
    expect(conditional.length).toBeLessThanOrEqual(200);
    expect(openLoginCeremony(KEY, id, NOW)).toEqual({ challenge, exp: NOW + CEREMONY_TTL_MS });
    expect(openLoginCeremony(KEY, id, NOW + CEREMONY_TTL_MS - 1)).not.toBeNull();
    expect(openLoginCeremony(KEY, id, NOW + CEREMONY_TTL_MS)).toBeNull();
    expect(openLoginCeremony(KEY, conditional, NOW + CONDITIONAL_CEREMONY_TTL_MS - 1)).not.toBeNull();
    // Another instance's key.
    expect(openLoginCeremony(randomToken(32), id, NOW)).toBeNull();
  });

  it('refuse any change: of the payload, of the signature (also a non-canonical encoding of it), of the purpose', () => {
    const challenge = randomToken();
    const id = signLoginCeremony(KEY, { challenge, exp: NOW + CEREMONY_TTL_MS });
    const [payload = '', signature = ''] = id.split('.');
    const decoded = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as Record<string, unknown>;
    expect(decoded).toEqual({ v: 1, purpose: 'login', challenge, exp: NOW + CEREMONY_TTL_MS });
    const reencode = (o: Record<string, unknown>) => toBase64Url(new TextEncoder().encode(JSON.stringify(o)));
    // A later expiry, another challenge, another purpose, all with the old signature.
    for (const changed of [{ ...decoded, exp: NOW + 60 * CEREMONY_TTL_MS }, { ...decoded, challenge: randomToken() }, { ...decoded, purpose: 'register' }]) {
      expect(openLoginCeremony(KEY, `${reencode(changed)}.${signature}`, NOW)).toBeNull();
    }
    // A flipped character in either part; the last character of a 32-byte base64url text carries 2 unused
    // bits, so 'A' and 'B' can decode to the same bytes: the text itself is compared.
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
    expect(openLoginCeremony(KEY, `${flip(payload, 5)}.${signature}`, NOW)).toBeNull();
    expect(openLoginCeremony(KEY, `${payload}.${flip(signature, 0)}`, NOW)).toBeNull();
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const twin = signature.slice(0, -1) + ALPHABET[ALPHABET.indexOf(signature.at(-1)!) ^ 1]!;
    expect(toBase64Url(fromBase64Url(twin))).toBe(signature);
    expect(openLoginCeremony(KEY, `${payload}.${twin}`, NOW)).toBeNull();
    // Not signed ceremonies at all.
    for (const other of [randomToken(), '', '.', `${payload}.`, `.${signature}`, `${id}.${signature}`, 'x'.repeat(201)]) {
      expect(openLoginCeremony(KEY, other, NOW)).toBeNull();
    }
    // A payload the key signed that is not a sign-in ceremony (only this module signs, but it checks anyway).
    const signedOther = signLoginCeremony(KEY, { challenge, exp: NOW + 1 }).split('.')[0]!;
    expect(signedOther).not.toBe(payload);
  });

  it('work once: the first use inserts the row, the second finds it there; the options call writes nothing', () => {
    const db = directoryDb();
    const challenge = randomToken();
    const exp = NOW + CEREMONY_TTL_MS;
    const id = signLoginCeremony(KEY, { challenge, exp });
    expect(db.all('SELECT id FROM webauthn_challenges')).toEqual([]);
    expect(consumeLoginCeremony(db, id, { challenge, exp }, NOW)).toBe(true);
    expect(consumeLoginCeremony(db, id, { challenge, exp }, NOW + 1)).toBe(false);
    expect(db.all('SELECT ceremony_hash, challenge, purpose, user_id, expires_at FROM webauthn_challenges')).toEqual([
      { ceremony_hash: sha256Hex(id), challenge, purpose: 'login', user_id: null, expires_at: new Date(exp).toISOString() },
    ]);
  });
});

describe('stored ceremonies', () => {
  it('are used up once, before their expiry, for their purpose; the caller checks the bindings', () => {
    const db = directoryDb();
    const { userId, sessionId, otherSessionId } = bound(db);
    const binding = { purpose: 'register' as const, userId, sessionId };
    const id = storeCeremony(db, { binding, challenge: 'c1', nowMs: NOW });
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(db.get('SELECT ceremony_hash, purpose, user_id, session_id, expires_at FROM webauthn_challenges')).toEqual({
      ceremony_hash: sha256Hex(id),
      purpose: 'register',
      user_id: userId,
      session_id: sessionId,
      expires_at: new Date(NOW + CEREMONY_TTL_MS).toISOString(),
    });
    // Another purpose does not take it.
    expect(consumeCeremony(db, id, 'reauth', NOW)).toBeNull();
    const row = consumeCeremony(db, id, 'register', NOW)!;
    expect(row.challenge).toBe('c1');
    expect(ceremonyMatches(row, binding)).toBe(true);
    expect(ceremonyMatches(row, { ...binding, sessionId: otherSessionId })).toBe(false);
    expect(ceremonyMatches(row, { purpose: 'reauth', userId, sessionId })).toBe(false);
    expect(consumeCeremony(db, id, 'register', NOW)).toBeNull();

    const late = storeCeremony(db, { binding, challenge: 'c2', nowMs: NOW });
    expect(consumeCeremony(db, late, 'register', NOW + CEREMONY_TTL_MS)).toBeNull();
    // A signed ceremony is no stored one.
    expect(consumeCeremony(db, signLoginCeremony(KEY, { challenge: 'c', exp: NOW + 1 }), 'register', NOW)).toBeNull();
  });

  it('keep at most 5 unexpired rows per binding: the oldest go, other bindings and purposes keep theirs', () => {
    const db = directoryDb();
    const { userId, sessionId, otherSessionId, tokenId } = bound(db);
    const binding = { purpose: 'register' as const, userId, sessionId };
    const ids = Array.from({ length: 7 }, (_, i) => storeCeremony(db, { binding, challenge: `c${i}`, nowMs: NOW + i }));
    const other = storeCeremony(db, { binding: { purpose: 'register', userId, sessionId: otherSessionId }, challenge: 'o', nowMs: NOW });
    const reauth = storeCeremony(db, { binding: { purpose: 'reauth', userId, sessionId }, challenge: 'r', nowMs: NOW });
    const reset = storeCeremony(db, { binding: { purpose: 'reset', emailTokenId: tokenId, userId }, challenge: 'x', nowMs: NOW });
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM webauthn_challenges WHERE purpose = 'register' AND session_id = :s", { s: sessionId })!.n).toBe(5);
    expect(consumeCeremony(db, ids[0]!, 'register', NOW + 10)).toBeNull();
    expect(consumeCeremony(db, ids[1]!, 'register', NOW + 10)).toBeNull();
    for (const id of ids.slice(2)) expect(consumeCeremony(db, id, 'register', NOW + 10)).not.toBeNull();
    expect(consumeCeremony(db, other, 'register', NOW + 10)).not.toBeNull();
    expect(consumeCeremony(db, reauth, 'reauth', NOW + 10)).not.toBeNull();
    expect(ceremonyMatches(consumeCeremony(db, reset, 'reset', NOW + 10)!, { purpose: 'reset', emailTokenId: tokenId, userId })).toBe(true);
  });

  it('a sign-up or invitation ceremony keeps the user handle of the account to be', () => {
    const db = directoryDb();
    const { tokenId } = bound(db);
    const handle = randomToken(32);
    const id = storeCeremony(db, { binding: { purpose: 'signup', emailTokenId: tokenId }, challenge: 'c', pendingUserHandle: handle, nowMs: NOW });
    const row = consumeCeremony(db, id, 'signup', NOW)!;
    expect(row.pending_user_handle).toBe(handle);
    expect(ceremonyMatches(row, { purpose: 'signup', emailTokenId: tokenId })).toBe(true);
    expect(ceremonyMatches(row, { purpose: 'signup', emailTokenId: tokenId + 1 })).toBe(false);
  });
});
