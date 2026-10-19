// Accounts (design §5.1, §5.8.4, §5.8.10, §5.8.17): the users rows, their DTO, sign-in lookups,
// preferences, the email address, createAccount (shared by setup, sign-up and invitation acceptance) and
// account deletion.

import type { AuthMethod } from '@shared/constants';
import { DEFAULT_PREFERENCES, userPreferencesSchema, type UserPreferences } from '@shared/schemas';
import type { UserDTO, UserRef } from '@shared/types';
import { randomToken } from '../core/crypto';
import type { Db } from '../core/db';
import { normalizeEmail } from '../core/email';
import type { TrustedMeta } from '../core/ports';
import { conflict, lastAdmin, lastOwner, notFound } from '../http/errors';
import { insertPasskey } from '../passkeys/credentials';
import type { RegisteredCredential } from '../passkeys/webauthn';
import type { DirectoryContext } from './context';
import { issueDevice } from './devices';
import { recordEvent } from './security';
import { createSession, type SessionRow } from './sessions';
import { bumpPeopleSpaces, defaultSpaceName, insertSpace, provisionSpace, softDeleteSpace } from './spaces';

export interface UserRow {
  id: number;
  email: string | null;
  email_key: string | null;
  email_verified_at: string | null;
  username: string | null;
  display_name: string;
  password_hash: string | null;
  password_changed_at: string | null;
  webauthn_user_id: string;
  is_instance_admin: number;
  status: 'active' | 'disabled';
  auth_epoch: number;
  preferences: string;
  notices_seen_at: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function toUserDTO(db: Db, row: UserRow): UserDTO {
  const passkeys = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = :id', { id: row.id })!.n;
  return {
    id: row.id,
    email: row.email,
    emailVerified: row.email_verified_at !== null,
    username: row.username,
    displayName: row.display_name,
    createdAt: row.created_at,
    isInstanceAdmin: row.is_instance_admin === 1,
    hasPassword: row.password_hash !== null,
    passkeyCount: passkeys,
  };
}

export const toUserRef = (row: Pick<UserRow, 'id' | 'display_name'>): UserRef => ({ id: row.id, displayName: row.display_name });

export function findUser(db: Db, id: number): UserRow | null {
  return db.get<UserRow>('SELECT * FROM users WHERE id = :id', { id }) ?? null;
}

export function userCount(db: Db): number {
  return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
}

/**
 * The account a sign-in identifier names (§5.8.2): by email_key when it contains @ and normalizes,
 * else by the legacy username (COLLATE NOCASE). `key` is what the per-account limit counts on: a:<id>
 * for an account (so its email and its username share one budget), else i:<normalized identifier>.
 */
export function resolveIdentifier(db: Db, identifier: string): { user: UserRow | null; key: string } {
  const email = identifier.includes('@') ? normalizeEmail(identifier) : null;
  const user = email?.ok
    ? db.get<UserRow>('SELECT * FROM users WHERE email_key = :key', { key: email.key })
    : db.get<UserRow>('SELECT * FROM users WHERE username = :username', { username: identifier });
  if (user) return { user, key: `a:${user.id}` };
  return { user: null, key: `i:${email?.ok ? email.key : identifier.toLowerCase()}` };
}

/** users.preferences, each value checked (invalid or missing ones read as the default). */
export function readPreferences(row: Pick<UserRow, 'preferences'>): UserPreferences {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.preferences);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>;
  } catch {
    // damaged: defaults
  }
  const shape = userPreferencesSchema.shape;
  const weekStartsOn = shape.weekStartsOn.safeParse(stored.weekStartsOn);
  const homePage = shape.homePage.safeParse(stored.homePage);
  return {
    weekStartsOn: weekStartsOn.success ? weekStartsOn.data : DEFAULT_PREFERENCES.weekStartsOn,
    homePage: homePage.success ? homePage.data : DEFAULT_PREFERENCES.homePage,
  };
}

export function writePreferences(db: Db, userId: number, preferences: UserPreferences, nowMs: number): void {
  db.run('UPDATE users SET preferences = :preferences, updated_at = :now WHERE id = :id', {
    id: userId,
    preferences: JSON.stringify(preferences),
    now: iso(nowMs),
  });
}

/** PATCH /api/account: a new display name reaches every space that shows it. Returns those spaces. */
export function renameUser(db: Db, userId: number, displayName: string, nowMs: number): string[] {
  return db.tx(() => {
    db.run('UPDATE users SET display_name = :displayName, updated_at = :now WHERE id = :id', {
      id: userId,
      displayName,
      now: iso(nowMs),
    });
    return bumpPeopleSpaces(db, userId);
  });
}

/** The account that has this address (by email_key), or null. */
export function findUserByEmailKey(db: Db, key: string): UserRow | null {
  return db.get<UserRow>('SELECT * FROM users WHERE email_key = :key', { key }) ?? null;
}

/** The account whose WebAuthn user handle (users.webauthn_user_id, base64url) this is, or null. */
export function findUserByWebauthnId(db: Db, handle: string): UserRow | null {
  return db.get<UserRow>('SELECT * FROM users WHERE webauthn_user_id = :handle', { handle }) ?? null;
}

/**
 * Give the account a new address (§5.8.10): verified when its owner just followed a link to it, else not;
 * auth_epoch + 1, so the account's outstanding links (reset, verification) stop working. Every space whose
 * mirror holds the account is bumped (members see each other's addresses); returns those to push to.
 * Inside the caller's transaction or alone.
 */
export function changeEmail(db: Db, o: { userId: number; email: { address: string; key: string }; verified: boolean; nowMs: number }): string[] {
  const now = iso(o.nowMs);
  return db.tx(() => {
    db.run(
      `UPDATE users SET email = :email, email_key = :key, email_verified_at = :verifiedAt, auth_epoch = auth_epoch + 1,
         updated_at = :now
       WHERE id = :id`,
      { id: o.userId, email: o.email.address, key: o.email.key, verifiedAt: o.verified ? now : null, now },
    );
    return bumpPeopleSpaces(db, o.userId);
  });
}

/** Active instance admins other than `exceptId`. */
export function otherActiveAdmins(db: Db, exceptId: number): number {
  return db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM users WHERE is_instance_admin = 1 AND status = 'active' AND id <> :id",
    { id: exceptId },
  )!.n;
}

// ---------------------------------------------------------------------------
// createAccount (§5.8.4)
// ---------------------------------------------------------------------------

export interface NewAccount {
  email: { address: string; key: string };
  emailVerified: boolean;
  displayName: string;
  /** A hash from PasswordHasher.hash, or null for an account that signs in with its passkey alone. */
  passwordHash: string | null;
  /**
   * A verified registration (sign-up or invitation acceptance with a passkey, §5.8.5 step 6, §5.8.8),
   * stored with the account, for the RP ID it was registered for.
   */
  passkey?: { credential: RegisteredCredential; rpId: string; name: string } | null;
  /** The WebAuthn user handle the passkey was registered with (its ceremony's pending handle); default a new one. */
  userHandle?: string;
  isInstanceAdmin: boolean;
  authMethod: Exclude<AuthMethod, 'legacy'>;
  /** Setup: the account must be the first one (checked again inside the transaction). */
  firstAccount?: boolean;
  /** Sample data in the default space (setup's createSampleData). */
  sampleData: { today?: string } | null;
  meta: TrustedMeta;
  /** The request's device token, to refresh rather than issue another one. */
  deviceToken: string | null;
  /** The 409 when the address has an account (the caller's wording; it checks first, this catches a race). */
  takenMessage?: string;
  /**
   * Runs inside the account's first transaction, after its rows exist: accepting an invitation consumes it
   * and adds its membership there (§5.8.8 step 6), so a refusal leaves no account behind.
   */
  within?: (user: UserRow, nowMs: number) => void;
}

export interface CreatedAccount {
  user: UserRow;
  /** The default space; null when its database could not be created (the UI offers "Create a space"). */
  spaceId: string | null;
  session: { token: string; row: SessionRow };
  /** A new device token for the cookie, or null when the browser keeps its own. */
  deviceToken: string | null;
}

/**
 * An account with its default space (owned, named "<display name>'s space"), a session (with
 * last_login_at, as a sign-in) and a device token, and its password or its passkey. The address must be free (409 otherwise; callers with their own
 * wording check first). If the space database cannot be created, the account stays without a default space.
 */
export async function createAccount(ctx: DirectoryContext, input: NewAccount): Promise<CreatedAccount> {
  const { db } = ctx;
  const nowMs = ctx.now();
  const now = iso(nowMs);
  const { user, space, passkey } = db.tx(() => {
    if (input.firstAccount && userCount(db) > 0) throw conflict('Setup has already been completed');
    if (db.get('SELECT 1 AS taken FROM users WHERE email_key = :key', { key: input.email.key })) {
      throw conflict(input.takenMessage ?? 'An account with this email already exists');
    }
    const user = db.get<UserRow>(
      `INSERT INTO users (email, email_key, email_verified_at, display_name, password_hash, password_changed_at,
         webauthn_user_id, is_instance_admin, created_at, updated_at)
       VALUES (:email, :key, :verifiedAt, :displayName, :hash, :changedAt, :handle, :admin, :now, :now)
       RETURNING *`,
      {
        email: input.email.address,
        key: input.email.key,
        verifiedAt: input.emailVerified ? now : null,
        displayName: input.displayName,
        hash: input.passwordHash,
        changedAt: input.passwordHash === null ? null : now,
        handle: input.userHandle ?? randomToken(32),
        admin: input.isInstanceAdmin,
        now,
      },
    )!;
    const passkey = input.passkey ? insertPasskey(db, { userId: user.id, ...input.passkey, nowMs }) : null;
    const space = insertSpace(db, { name: defaultSpaceName(input.displayName), ownerId: user.id, nowMs });
    input.within?.(user, nowMs);
    if (input.firstAccount) ctx.setupCode.clear();
    return { user, space, passkey };
  });
  const owner = { userId: user.id, displayName: user.display_name, email: user.email };
  const ok = await provisionSpace(ctx, space, { owner, status: 'active', sampleData: input.sampleData });
  const done = ctx.now();
  const { token, session } = db.tx(() => {
    // Signed in from now on, as a sign-in records it (Administration → Users' "Last sign-in").
    db.run('UPDATE users SET last_login_at = :now WHERE id = :id', { id: user.id, now: iso(done) });
    const created = createSession(db, { userId: user.id, authMethod: input.authMethod, meta: input.meta, config: ctx.config, nowMs: done });
    const data = { authMethod: input.authMethod };
    recordEvent(db, { type: 'account_created', userId: user.id, meta: input.meta, data, nowMs: done });
    if (passkey) {
      const added = { passkeyId: passkey.id, name: passkey.name, via: input.authMethod };
      recordEvent(db, { type: 'passkey_added', userId: user.id, meta: input.meta, data: added, nowMs: done });
    }
    return created;
  });
  return {
    user: findUser(db, user.id) ?? user,
    spaceId: ok ? space.public_id : null,
    session: { token, row: session },
    deviceToken: issueDevice(db, user.id, input.deviceToken, done),
  };
}

// ---------------------------------------------------------------------------
// Account deletion (§5.8.17)
// ---------------------------------------------------------------------------

/** The account's email, or its username when it has none (what DELETE /api/account's `confirm` names). */
export function confirmationName(row: Pick<UserRow, 'email' | 'username'>): string {
  return row.email ?? row.username ?? '';
}

/** `confirm` names the account: its email (compared as keys) or its username (without case). */
export function confirmsAccount(row: Pick<UserRow, 'email_key' | 'username'>, confirm: string): boolean {
  const given = confirm.trim();
  if (row.email_key !== null) {
    const email = normalizeEmail(given);
    return email.ok && email.key === row.email_key;
  }
  return row.username !== null && row.username.toLowerCase() === given.toLowerCase();
}

/**
 * The checks of §5.8.17 that keep the instance usable: no space may lose its only owner while others
 * are in it (409 last_owner, listing them), and the last active instance admin, and so the last account,
 * cannot be deleted (409 last_admin). `byAdmin`: worded for the administrator deleting it (§5.8.18).
 */
export function assertDeletable(db: Db, user: UserRow, o: { byAdmin?: boolean } = {}): void {
  const stranded = db.all<{ public_id: string; name: string }>(
    `SELECT s.public_id, s.name FROM memberships m JOIN spaces s ON s.id = m.space_id
     WHERE m.user_id = :userId AND m.role = 'owner' AND s.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM memberships o WHERE o.space_id = m.space_id AND o.role = 'owner' AND o.user_id <> :userId)
       AND EXISTS (SELECT 1 FROM memberships x WHERE x.space_id = m.space_id AND x.user_id <> :userId)
     ORDER BY s.id`,
    { userId: user.id },
  );
  if (stranded.length > 0) {
    throw lastOwner(
      o.byAdmin
        ? `${user.display_name} is the only owner of spaces that have other members. One of those members must become an owner first`
        : 'Transfer ownership or delete these spaces first',
      stranded.map((s) => ({ path: `spaces.${s.public_id}`, message: s.name })),
    );
  }
  if (user.is_instance_admin === 1 && user.status === 'active' && otherActiveAdmins(db, user.id) === 0) {
    throw lastAdmin(
      userCount(db) === 1
        ? 'This is the only account. To reset the instance, delete its data.'
        : 'Make another account an administrator first',
    );
  }
}

/**
 * Delete the account: assertDeletable on the row as it is now, then soft-delete the spaces it is the
 * only member of, revoke the invitations it sent, bump every space whose mirror holds it, delete the
 * row (sessions, device tokens, passkeys, tokens, memberships and space_people cascade) and record
 * account_deleted, or admin_user_deleted with the administrator as the actor (§5.8.18; the account's name
 * stays in the event, for the admins' list). Returns the spaces to push and the soft-deleted ones (purged
 * at once with a grace of 0).
 */
export function deleteAccount(
  db: Db,
  o: { userId: number; actorId: number | null; byAdmin?: boolean; graceDays: number; meta: TrustedMeta; nowMs: number },
): { pushed: string[]; deleted: Array<{ id: number; public_id: string }> } {
  return db.tx(() => {
    const user = findUser(db, o.userId);
    if (!user) throw notFound('Account');
    assertDeletable(db, user, { byAdmin: o.byAdmin });
    const alone = db.all<{ id: number; public_id: string }>(
      `SELECT s.id, s.public_id FROM memberships m JOIN spaces s ON s.id = m.space_id
       WHERE m.user_id = :userId AND s.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM memberships x WHERE x.space_id = m.space_id AND x.user_id <> :userId)`,
      { userId: user.id },
    );
    for (const space of alone) softDeleteSpace(db, { spaceId: space.id, byUserId: null, graceDays: o.graceDays, nowMs: o.nowMs });
    db.run(
      'UPDATE invitations SET revoked_at = :now WHERE invited_by = :userId AND accepted_at IS NULL AND revoked_at IS NULL',
      { userId: user.id, now: iso(o.nowMs) },
    );
    const pushed = bumpPeopleSpaces(db, user.id);
    db.run('DELETE FROM users WHERE id = :id', { id: user.id });
    if (o.byAdmin) {
      const data = { userId: user.id, displayName: user.display_name };
      recordEvent(db, { type: 'admin_user_deleted', userId: null, actorId: o.actorId, meta: o.meta, data, nowMs: o.nowMs });
    } else {
      recordEvent(db, { type: 'account_deleted', userId: null, actorId: o.actorId, meta: o.meta, data: { userId: user.id }, nowMs: o.nowMs });
    }
    return { pushed, deleted: alone };
  });
}
