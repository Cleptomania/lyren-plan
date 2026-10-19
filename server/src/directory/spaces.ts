// Spaces in the directory (design §5.8.16, §3.5): the spaces rows, their owner memberships and
// space_people, the sync_version bumps a space's mirror and cached identities follow, and the pushes
// that tell a space to drop its auth cache. A space's data lives in its own database, reached through
// SpaceAdminClient (init, invalidate, destroy).
//
// Lifecycle: provisioning (the row exists, the space database is being created) → active, or
// importing (created for an archive import, §8.4) → active. Deleting is soft: deleted_at and
// purge_after = now + SPACE_DELETE_GRACE_DAYS; memberships stay until the purge, but authorizeSpace
// answers not_found. Maintenance purges what is due (destroy, then the row), and provisioning rows
// older than an hour and importing rows older than a day. A space can be restored only while
// purge_after is ahead: a purge that has started deletes the row whatever happens during its destroy.

import { LIMITS } from '@shared/constants';
import type { SpaceRole } from '@shared/roles';
import type { DeletedSpaceDTO, SpaceSummaryDTO } from '@shared/types';
import { generateSpaceId, isSpaceId } from '../core/ids';
import type { Db } from '../core/db';
import type { MirrorProfile } from '../core/ports';
import { notFound, quotaExceeded, rateLimited, unavailable } from '../http/errors';
import type { DirectoryContext } from './context';
import { spacesCreatedPolicy } from './throttle';

export type SpaceStatus = 'provisioning' | 'importing' | 'active';

export interface SpaceRow {
  id: number;
  public_id: string;
  name: string;
  status: SpaceStatus;
  sync_version: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: number | null;
  purge_after: string | null;
}

/** A space the user is a member of, with the role. */
export interface MemberSpace extends SpaceRow {
  role: SpaceRole;
}

/** Spaces a change touches that get the invalidate push; the rest catch up through sync_version (§3.5). */
const MAX_PUSH = 20;
/** How long a security revocation waits for its pushes (all of them together). */
const PUSH_WAIT_MS = 2000;
const PROVISIONING_MAX_AGE_MS = 60 * 60 * 1000;
const IMPORTING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Purges (destroy calls) per maintenance run; the rest wait for the next one. */
export const MAX_PURGES_PER_RUN = 20;
const DAY_MS = 86_400_000;

const iso = (ms: number) => new Date(ms).toISOString();

/** `name` cut to the space name limit (by characters, not UTF-16 units). */
export function spaceName(name: string): string {
  return Array.from(name.trim()).slice(0, LIMITS.spaceNameMax).join('').trim();
}

/** The name of an account's default space (§5.1). */
export function defaultSpaceName(displayName: string): string {
  return spaceName(`${displayName}'s space`);
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** The space with this public id, deleted or not; null for a malformed id. */
export function findSpace(db: Db, publicId: string): SpaceRow | null {
  if (!isSpaceId(publicId)) return null;
  return db.get<SpaceRow>('SELECT * FROM spaces WHERE public_id = :publicId', { publicId }) ?? null;
}

/**
 * The space and the user's role in it, when the user is a member. Deleted and provisioning spaces are
 * included only when asked; the routes answer 404 for everything else (existence is not revealed).
 */
export function findMemberSpace(db: Db, publicId: string, userId: number, o: { deleted?: boolean } = {}): MemberSpace | null {
  if (!isSpaceId(publicId)) return null;
  const row = db.get<MemberSpace>(
    `SELECT s.*, m.role FROM spaces s JOIN memberships m ON m.space_id = s.id AND m.user_id = :userId
     WHERE s.public_id = :publicId AND s.status <> 'provisioning'`,
    { publicId, userId },
  );
  if (!row || (row.deleted_at !== null && !o.deleted)) return null;
  return row;
}

/** findMemberSpace, or 404. */
export function requireMemberSpace(db: Db, publicId: string, userId: number, o: { deleted?: boolean } = {}): MemberSpace {
  const space = findMemberSpace(db, publicId, userId, o);
  if (!space) throw notFound('Space');
  return space;
}

const SUMMARY_SELECT = `SELECT s.public_id, s.name, s.status, s.created_at, m.role,
    (SELECT COUNT(*) FROM memberships x WHERE x.space_id = s.id) AS member_count
  FROM memberships m JOIN spaces s ON s.id = m.space_id`;

interface SummaryRow {
  public_id: string;
  name: string;
  status: 'importing' | 'active';
  created_at: string;
  role: SpaceRole;
  member_count: number;
}

const toSummary = (r: SummaryRow): SpaceSummaryDTO => ({
  id: r.public_id,
  name: r.name,
  role: r.role,
  status: r.status,
  memberCount: r.member_count,
  createdAt: r.created_at,
});

/** The user's spaces (GET /api/spaces, AuthStatusDTO.spaces): not deleted, not provisioning, oldest first. */
export function listSpaces(db: Db, userId: number): SpaceSummaryDTO[] {
  return db
    .all<SummaryRow>(
      `${SUMMARY_SELECT}
       WHERE m.user_id = :userId AND s.deleted_at IS NULL AND s.status <> 'provisioning'
       ORDER BY s.created_at, s.id`,
      { userId },
    )
    .map(toSummary);
}

/** One space of the user's, as SpaceSummaryDTO. */
export function spaceSummary(db: Db, spaceId: number, userId: number): SpaceSummaryDTO {
  const row = db.get<SummaryRow>(`${SUMMARY_SELECT} WHERE m.user_id = :userId AND s.id = :spaceId`, { userId, spaceId });
  if (!row) throw notFound('Space');
  return toSummary(row);
}

/** GET /api/spaces/deleted: spaces the user owns that are deleted and can still be restored. */
export function listDeletedSpaces(db: Db, userId: number, nowMs: number): DeletedSpaceDTO[] {
  return db
    .all<{ public_id: string; name: string; deleted_at: string; purge_after: string }>(
      `SELECT s.public_id, s.name, s.deleted_at, s.purge_after FROM memberships m JOIN spaces s ON s.id = m.space_id
       WHERE m.user_id = :userId AND m.role = 'owner' AND s.deleted_at IS NOT NULL AND s.purge_after > :now
       ORDER BY s.deleted_at DESC, s.id DESC`,
      { userId, now: iso(nowMs) },
    )
    .map((r) => ({ id: r.public_id, name: r.name, deletedAt: r.deleted_at, purgeAfter: r.purge_after }));
}

/** The public ids of the spaces the user is a member of (those that have a database), for pushes. */
export function memberSpaceIds(db: Db, userId: number): string[] {
  return db
    .all<{ public_id: string }>(
      `SELECT s.public_id FROM memberships m JOIN spaces s ON s.id = m.space_id
       WHERE m.user_id = :userId AND s.status <> 'provisioning' ORDER BY s.id`,
      { userId },
    )
    .map((s) => s.public_id);
}

/** Spaces the user owns that are not purged, soft-deleted ones included (they still use storage). */
export function ownedSpaceCount(db: Db, userId: number): number {
  return db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memberships WHERE user_id = :userId AND role = 'owner'", { userId })!.n;
}

// ---------------------------------------------------------------------------
// Sync versions and pushes (§3.5)
// ---------------------------------------------------------------------------

/** Bump the sync_version of these spaces (inside the transaction that changed them). */
export function bumpSpaces(db: Db, spaceIds: readonly number[]): void {
  if (spaceIds.length === 0) return;
  db.run('UPDATE spaces SET sync_version = sync_version + 1 WHERE id IN (SELECT value FROM json_each(:ids))', {
    ids: JSON.stringify([...new Set(spaceIds)]),
  });
}

/**
 * Bump every space whose mirror may hold the user (space_people: members, former members, authors
 * mapped by imports). Returns the public ids of those that have a database, for the push. Run before
 * the account row is deleted.
 */
export function bumpPeopleSpaces(db: Db, userId: number): string[] {
  const rows = db.all<{ public_id: string; status: SpaceStatus }>(
    `UPDATE spaces SET sync_version = sync_version + 1
     WHERE id IN (SELECT space_id FROM space_people WHERE user_id = :userId)
     RETURNING public_id, status`,
    { userId },
  );
  return rows.filter((r) => r.status !== 'provisioning').map((r) => r.public_id);
}

/**
 * Tell spaces to drop their auth cache and sync (SpaceAdminClient.invalidate), at most 20 of them. A
 * security revocation ('await': password change, revoke-others, deletion, a membership removal or
 * demotion) waits for the calls, 2 s at most in total, so the spaces forget cached identities before
 * the user sees the result; anything else is pushed best-effort ('defer'). A push that fails leaves the
 * space on its cache TTL and the sync_version check.
 */
export async function pushInvalidate(ctx: DirectoryContext, publicIds: readonly string[], mode: 'await' | 'defer'): Promise<void> {
  const ids = [...new Set(publicIds)].slice(0, MAX_PUSH);
  if (ids.length === 0) return;
  const pushes = Promise.allSettled(ids.map((id) => ctx.deps.spaces.invalidate(id))).then((results) => {
    results.forEach((r, i) => {
      if (r.status === 'rejected') console.error(`[lyren] Could not invalidate space ${ids[i]}:`, r.reason);
    });
  });
  if (mode === 'defer') {
    ctx.deps.defer(pushes);
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, PUSH_WAIT_MS);
  });
  await Promise.race([pushes, timeout]);
  clearTimeout(timer);
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

/**
 * Insert a provisioning space owned by `ownerId`, with the owner's membership and space_people row
 * (inside the caller's transaction). The public id is regenerated in the unlikely case it is taken.
 */
export function insertSpace(db: Db, o: { name: string; ownerId: number; nowMs: number }): SpaceRow {
  let publicId = generateSpaceId();
  while (db.get('SELECT 1 AS taken FROM spaces WHERE public_id = :publicId', { publicId })) publicId = generateSpaceId();
  const now = iso(o.nowMs);
  const space = db.get<SpaceRow>(
    `INSERT INTO spaces (public_id, name, status, sync_version, created_by, created_at, updated_at)
     VALUES (:publicId, :name, 'provisioning', 1, :ownerId, :now, :now) RETURNING *`,
    { publicId, name: o.name, ownerId: o.ownerId, now },
  )!;
  db.run(
    `INSERT INTO memberships (space_id, user_id, role, added_by, created_at, updated_at)
     VALUES (:spaceId, :ownerId, 'owner', :ownerId, :now, :now)`,
    { spaceId: space.id, ownerId: o.ownerId, now },
  );
  db.run('INSERT OR IGNORE INTO space_people (space_id, user_id) VALUES (:spaceId, :ownerId)', {
    spaceId: space.id,
    ownerId: o.ownerId,
  });
  return space;
}

/**
 * Create the space database (SpaceAdminClient.init) for a provisioning row, then give the row its
 * status. Returns false when init failed: the row (and its membership) is deleted again, and whatever
 * init left behind is destroyed best-effort.
 */
export async function provisionSpace(
  ctx: DirectoryContext,
  space: SpaceRow,
  o: { owner: MirrorProfile; status: 'active' | 'importing'; sampleData: { today?: string } | null },
): Promise<boolean> {
  const { db } = ctx;
  try {
    await ctx.deps.spaces.init({
      spaceId: space.public_id,
      name: space.name,
      owner: o.owner,
      syncVersion: space.sync_version,
      sampleData: o.sampleData,
    });
  } catch (err) {
    console.error(`[lyren] Could not create the database of space ${space.public_id}:`, err);
    db.run("DELETE FROM spaces WHERE id = :id AND status = 'provisioning'", { id: space.id });
    ctx.deps.defer(
      ctx.deps.spaces.destroy(space.public_id).catch((e) => console.error(`[lyren] Could not remove space ${space.public_id}:`, e)),
    );
    return false;
  }
  // Re-read: other requests may have run during the await.
  const { changes } = db.run(
    "UPDATE spaces SET status = :status, updated_at = :now WHERE id = :id AND status = 'provisioning'",
    { id: space.id, status: o.status, now: iso(ctx.now()) },
  );
  return changes > 0;
}

/** POST /api/spaces (§5.8.16): quota, sc:<userId>, then a provisioning row, init and the status. */
export async function createSpace(
  ctx: DirectoryContext,
  o: { owner: MirrorProfile; name: string; sampleData: { today?: string } | null; forImport: boolean },
): Promise<SpaceSummaryDTO> {
  const { db, config } = ctx;
  const userId = o.owner.userId;
  const max = config.quotas.maxSpacesPerUser;
  if (max > 0 && ownedSpaceCount(db, userId) >= max) {
    throw quotaExceeded(`You can own at most ${max} spaces (deleted ones count until they are purged)`);
  }
  const perDay = config.quotas.spacesCreatedPerDay;
  if (perDay > 0) {
    const policy = spacesCreatedPolicy(perDay);
    const state = ctx.throttle.check(`sc:${userId}`, policy);
    if (state.blocked) throw rateLimited('You have created too many spaces today', state.retryAfterMs / 1000);
    ctx.throttle.hit(`sc:${userId}`, policy);
  }
  const space = db.tx(() => insertSpace(db, { name: spaceName(o.name), ownerId: userId, nowMs: ctx.now() }));
  const ok = await provisionSpace(ctx, space, {
    owner: o.owner,
    status: o.forImport ? 'importing' : 'active',
    sampleData: o.sampleData,
  });
  if (!ok) throw unavailable('The space could not be created. Try again later.');
  return spaceSummary(db, space.id, userId);
}

// ---------------------------------------------------------------------------
// Renaming, deleting, restoring, purging
// ---------------------------------------------------------------------------

export function renameSpace(db: Db, spaceId: number, name: string, nowMs: number): void {
  db.run('UPDATE spaces SET name = :name, updated_at = :now, sync_version = sync_version + 1 WHERE id = :id', {
    id: spaceId,
    name: spaceName(name),
    now: iso(nowMs),
  });
}

/**
 * Soft-delete (inside the caller's transaction); returns purge_after. The space's open invitations are
 * revoked (revoked_by NULL, §5.8.8 lifecycle): deleting ends every way into the space, and a restore does
 * not bring them back.
 */
export function softDeleteSpace(db: Db, o: { spaceId: number; byUserId: number | null; graceDays: number; nowMs: number }): string {
  const purgeAfter = iso(o.nowMs + o.graceDays * DAY_MS);
  const now = iso(o.nowMs);
  db.run(
    `UPDATE spaces SET deleted_at = :now, deleted_by = :by, purge_after = :purgeAfter, updated_at = :now,
       sync_version = sync_version + 1
     WHERE id = :id AND deleted_at IS NULL`,
    { id: o.spaceId, by: o.byUserId, purgeAfter, now },
  );
  db.run('UPDATE invitations SET revoked_at = :now WHERE space_id = :id AND accepted_at IS NULL AND revoked_at IS NULL', {
    id: o.spaceId,
    now,
  });
  return purgeAfter;
}

/**
 * A deleted space whose grace period is not over. From purge_after on, maintenance (or a delete with a
 * grace of 0) may be destroying it, and the purge deletes the row once destroy returns, so a restore
 * answered meanwhile would be lost along with the data.
 */
export function isRestorable(space: Pick<SpaceRow, 'deleted_at' | 'purge_after'>, nowMs: number): boolean {
  return space.deleted_at !== null && space.purge_after !== null && Date.parse(space.purge_after) > nowMs;
}

export function restoreSpace(db: Db, spaceId: number, nowMs: number): void {
  db.run(
    `UPDATE spaces SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, updated_at = :now,
       sync_version = sync_version + 1
     WHERE id = :id`,
    { id: spaceId, now: iso(nowMs) },
  );
}

/** Delete a space's data and then its row (memberships, space_people and invitations cascade). */
export async function purgeSpace(ctx: DirectoryContext, space: Pick<SpaceRow, 'id' | 'public_id'>): Promise<void> {
  await ctx.deps.spaces.destroy(space.public_id);
  ctx.db.run('DELETE FROM spaces WHERE id = :id', { id: space.id });
}

/**
 * Maintenance: purge spaces whose grace period is over, provisioning rows older than an hour and
 * importing rows older than a day, at most MAX_PURGES_PER_RUN. A failed destroy keeps the row for the
 * next run.
 */
export async function purgeDueSpaces(ctx: DirectoryContext, nowMs: number): Promise<number> {
  const due = ctx.db.all<{ id: number; public_id: string }>(
    `SELECT id, public_id FROM spaces
     WHERE purge_after <= :now
        OR (status = 'provisioning' AND created_at <= :provisioningCutoff)
        OR (status = 'importing' AND deleted_at IS NULL AND created_at <= :importingCutoff)
     ORDER BY id LIMIT ${MAX_PURGES_PER_RUN}`,
    {
      now: iso(nowMs),
      provisioningCutoff: iso(nowMs - PROVISIONING_MAX_AGE_MS),
      importingCutoff: iso(nowMs - IMPORTING_MAX_AGE_MS),
    },
  );
  let purged = 0;
  for (const space of due) {
    try {
      await purgeSpace(ctx, space);
      purged++;
    } catch (err) {
      console.error(`[lyren] Could not purge space ${space.public_id}:`, err);
    }
  }
  return purged;
}
