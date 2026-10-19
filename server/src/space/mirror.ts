// The users mirror of a space (design §3.5): one row per directory account that is or was a member, or
// that an import attributed rows to, plus placeholders (negative ids) for former members an import kept by
// name. Content rows keep pointing at it (created_by, user_id, imported_by), so rows are never deleted
// while referenced; an account that no longer exists keeps its display name for attribution and loses its
// email (deleted = 1).
//
// The space host pulls the directory's state (spaceSync) when an identity carries a newer syncVersion or
// after an invalidate, and applies it here in one transaction, writing only rows whose values change (a
// Durable Object bills rows written). Before every request it also self-heals the actor's own row, so that
// row is correct even when a sync failed.

import type { Db } from '../core/db';
import type { SpaceIdentity, SpaceSyncPayload } from '../core/ports';
import type { MirrorUserRow } from '../services/rows';

/** Set a _meta key (space_name, sync_version, §3.3); writes nothing when the value is unchanged. */
const META_UPSERT = `INSERT INTO _meta (key, value) VALUES (:key, :value)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE _meta.value IS NOT excluded.value`;

/** The last directory sync_version this space applied (_meta.sync_version; 0 before the first). */
export function appliedSyncVersion(db: Db): number {
  const row = db.get<{ value: string }>("SELECT value FROM _meta WHERE key = 'sync_version'");
  const n = row ? Number(row.value) : 0;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** The ids spaceSync is asked about: every account row that is not marked deleted (members included). */
export function mirrorUserIds(db: Db): number[] {
  return db.all<{ id: number }>("SELECT id FROM users WHERE kind = 'account' AND deleted = 0 ORDER BY id").map((r) => r.id);
}

export function mirrorRow(db: Db, id: number): MirrorUserRow | undefined {
  return db.get<MirrorUserRow>('SELECT * FROM users WHERE id = :id', { id });
}

/**
 * Apply a spaceSync payload (§3.5 steps 1-4) in one transaction. Returns the number of rows that changed
 * (users rows and the space name); the caller bumps the write generation when it is not 0.
 */
export function applySync(db: Db, payload: SpaceSyncPayload, now: string): number {
  const members = JSON.stringify(payload.members.map((m) => ({ id: m.userId, name: m.displayName, email: m.email })));
  const renamed = JSON.stringify(
    payload.others.flatMap((o) => ('deleted' in o ? [] : [{ id: o.userId, name: o.displayName }])),
  );
  const deleted = JSON.stringify(payload.others.flatMap((o) => ('deleted' in o ? [o.userId] : [])));
  return db.tx(() => {
    let changed = 0;
    // 1. Every current member: an account row with their profile, is_member = 1, deleted = 0.
    changed += db.run(
      `INSERT INTO users (id, kind, display_name, email, is_member, deleted, updated_at)
       SELECT json_extract(value, '$.id'), 'account', json_extract(value, '$.name'), json_extract(value, '$.email'), 1, 0, :now
         FROM json_each(:members) WHERE 1
       ON CONFLICT (id) DO UPDATE SET
         display_name = excluded.display_name, email = excluded.email, is_member = 1, deleted = 0, updated_at = excluded.updated_at
       WHERE users.display_name IS NOT excluded.display_name OR users.email IS NOT excluded.email
          OR users.is_member <> 1 OR users.deleted <> 0`,
      { members, now },
    ).changes;
    // 2. Every other account row is not a member (former members keep their row, §6.3).
    changed += db.run(
      `UPDATE users SET is_member = 0, updated_at = :now
        WHERE kind = 'account' AND is_member = 1
          AND id NOT IN (SELECT json_extract(value, '$.id') FROM json_each(:members))`,
      { members, now },
    ).changes;
    // 3. The others the directory answered for: a new display name, or the account no longer exists.
    changed += db.run(
      `UPDATE users SET display_name = (SELECT json_extract(r.value, '$.name') FROM json_each(:renamed) r
                                         WHERE json_extract(r.value, '$.id') = users.id),
                        updated_at = :now
        WHERE kind = 'account' AND id IN (SELECT json_extract(value, '$.id') FROM json_each(:renamed))
          AND display_name IS NOT (SELECT json_extract(r.value, '$.name') FROM json_each(:renamed) r
                                    WHERE json_extract(r.value, '$.id') = users.id)`,
      { renamed, now },
    ).changes;
    changed += db.run(
      `UPDATE users SET deleted = 1, email = NULL, is_member = 0, updated_at = :now
        WHERE kind = 'account' AND id IN (SELECT value FROM json_each(:deleted))
          AND (deleted <> 1 OR email IS NOT NULL OR is_member <> 0)`,
      { deleted, now },
    ).changes;
    // 4. The space's name and the version applied.
    changed += db.run(META_UPSERT, { key: 'space_name', value: payload.name }).changes;
    db.run(META_UPSERT, { key: 'sync_version', value: String(payload.syncVersion) });
    return changed;
  });
}

/**
 * Self-heal the actor's row (§3.5): upsert it as a member with the identity's profile when it is missing
 * or differs. Returns whether a row was written.
 */
export function healActor(db: Db, identity: Pick<SpaceIdentity, 'userId' | 'displayName' | 'email'>, now: string): boolean {
  return (
    db.run(
      `INSERT INTO users (id, kind, display_name, email, is_member, deleted, updated_at)
       VALUES (:id, 'account', :name, :email, 1, 0, :now)
       ON CONFLICT (id) DO UPDATE SET
         display_name = excluded.display_name, email = excluded.email, is_member = 1, deleted = 0, updated_at = excluded.updated_at
       WHERE users.display_name IS NOT excluded.display_name OR users.email IS NOT excluded.email
          OR users.is_member <> 1 OR users.deleted <> 0`,
      { id: identity.userId, name: identity.displayName, email: identity.email, now },
    ).changes > 0
  );
}
