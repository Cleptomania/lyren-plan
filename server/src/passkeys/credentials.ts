// The passkeys table (design §3.2, §5.6): an account's registered credentials, at most 20 each. Each row
// keeps the RP ID it was registered for, so a domain move (a new PUBLIC_URL or WEBAUTHN_RP_ID) shows: such
// a passkey cannot sign in here any more (PasskeyDTO.rpIdMatches false), and only usable passkeys (passkeys
// on, and the row's rp_id the current RP ID) count as a way to sign in.

import { LIMITS } from '@shared/constants';
import type { PasskeyDTO } from '@shared/types';
import type { Db } from '../core/db';
import { cleanTransports, type RegisteredCredential, type StoredCredential } from './webauthn';

export interface PasskeyRow {
  id: number;
  user_id: number;
  credential_id: string;
  public_key: string;
  algorithm: number;
  sign_count: number;
  /** JSON array of AuthenticatorTransport. */
  transports: string;
  device_type: 'singleDevice' | 'multiDevice';
  backed_up: number;
  aaguid: string | null;
  rp_id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

/** Passkeys one account may have (§5.6). */
export const PASSKEYS_PER_USER = LIMITS.passkeysPerUser;

const iso = (ms: number) => new Date(ms).toISOString();

function transportsOf(row: Pick<PasskeyRow, 'transports'>): string[] {
  try {
    return cleanTransports(JSON.parse(row.transports));
  } catch {
    return [];
  }
}

/** The row as the verification of an assertion needs it. */
export function storedCredential(row: PasskeyRow): StoredCredential {
  return { credentialId: row.credential_id, publicKey: row.public_key, transports: transportsOf(row) };
}

/** `rpId`: the current RP ID, or null while passkeys are off (then no passkey matches). */
export function toPasskeyDTO(row: PasskeyRow, rpId: string | null): PasskeyDTO {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    deviceType: row.device_type,
    backedUp: row.backed_up === 1,
    rpIdMatches: rpId !== null && row.rp_id === rpId,
  };
}

/** The account's passkeys, oldest first. */
export function listPasskeys(db: Db, userId: number): PasskeyRow[] {
  return db.all<PasskeyRow>('SELECT * FROM passkeys WHERE user_id = :userId ORDER BY created_at, id', { userId });
}

/** The account's passkeys that can sign in here (rpId null: passkeys are off, none can). */
export function usablePasskeys(db: Db, userId: number, rpId: string | null): PasskeyRow[] {
  if (rpId === null) return [];
  return db.all<PasskeyRow>('SELECT * FROM passkeys WHERE user_id = :userId AND rp_id = :rpId ORDER BY created_at, id', { userId, rpId });
}

export function passkeyCount(db: Db, userId: number): number {
  return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = :userId', { userId })!.n;
}

/** The account's passkey `id` (always looked up with its owner, §13.2), or null. */
export function findPasskey(db: Db, userId: number, id: number): PasskeyRow | null {
  return db.get<PasskeyRow>('SELECT * FROM passkeys WHERE id = :id AND user_id = :userId', { id, userId }) ?? null;
}

/** The passkey with this credential id (the `id` of a WebAuthn answer), whoever's it is. */
export function findByCredentialId(db: Db, credentialId: string): PasskeyRow | null {
  return db.get<PasskeyRow>('SELECT * FROM passkeys WHERE credential_id = :credentialId', { credentialId }) ?? null;
}

/** "Passkey <n>": the next number after the account's passkey count that no passkey of its is named. */
export function defaultPasskeyName(db: Db, userId: number): string {
  const names = new Set(listPasskeys(db, userId).map((p) => p.name));
  let n = names.size + 1;
  while (names.has(`Passkey ${n}`)) n++;
  return `Passkey ${n}`;
}

/** Store a verified registration for `userId`, registered for `rpId`. */
export function insertPasskey(db: Db, o: { userId: number; credential: RegisteredCredential; rpId: string; name: string; nowMs: number }): PasskeyRow {
  const c = o.credential;
  return db.get<PasskeyRow>(
    `INSERT INTO passkeys (user_id, credential_id, public_key, algorithm, sign_count, transports, device_type, backed_up, aaguid,
       rp_id, name, created_at)
     VALUES (:userId, :credentialId, :publicKey, :algorithm, :counter, :transports, :deviceType, :backedUp, :aaguid, :rpId, :name, :now)
     RETURNING *`,
    {
      userId: o.userId,
      credentialId: c.credentialId,
      publicKey: c.publicKey,
      algorithm: c.algorithm,
      counter: c.counter,
      transports: JSON.stringify(c.transports),
      deviceType: c.deviceType,
      backedUp: c.backedUp,
      aaguid: c.aaguid,
      rpId: o.rpId,
      name: o.name,
      now: iso(o.nowMs),
    },
  )!;
}

/** After a verified assertion: the new counter, the backup state the authenticator reported, the time. */
export function recordPasskeyUse(db: Db, id: number, o: { counter: number; backedUp: boolean; nowMs: number }): void {
  db.run('UPDATE passkeys SET sign_count = :counter, backed_up = :backedUp, last_used_at = :now WHERE id = :id', {
    id,
    counter: o.counter,
    backedUp: o.backedUp,
    now: iso(o.nowMs),
  });
}

export function renamePasskey(db: Db, userId: number, id: number, name: string): boolean {
  return db.run('UPDATE passkeys SET name = :name WHERE id = :id AND user_id = :userId', { id, userId, name }).changes > 0;
}

export function deletePasskey(db: Db, userId: number, id: number): boolean {
  return db.run('DELETE FROM passkeys WHERE id = :id AND user_id = :userId', { id, userId }).changes > 0;
}

/**
 * The condition on `users u` of an active account that can only sign in with passkeys that do not work here
 * (§5.6): no password, at least one passkey, and none registered for `:rpId` (null: passkeys are off, so none
 * works). The admin list's filter (directory/admin.ts); orphanedAccounts counts the same accounts.
 */
export const ORPHANED_ACCOUNT_SQL = `u.password_hash IS NULL AND u.status = 'active'
  AND EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = u.id)
  AND NOT EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = u.id AND p.rp_id IS :rpId)`;

/**
 * How many accounts ORPHANED_ACCOUNT_SQL holds for. Counted from the passkeys of another RP ID (such an account
 * has one, since it has passkeys and none of this RP ID), so it reads every passkey, not every account: next to
 * nothing where few accounts have passkeys (Cloudflare counts it every hour, Appendix D 59).
 */
export function orphanedAccounts(db: Db, rpId: string | null): number {
  return db.get<{ n: number }>(
    `SELECT COUNT(DISTINCT p.user_id) AS n FROM passkeys p JOIN users u ON u.id = p.user_id
     WHERE p.rp_id IS NOT :rpId AND u.password_hash IS NULL AND u.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM passkeys q WHERE q.user_id = p.user_id AND q.rp_id IS :rpId)`,
    { rpId },
  )!.n;
}
