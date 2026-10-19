// Creating a space's database (SpaceAdminClient.init, design §2.3, §9.3): the schema, today's defaults,
// the owner's mirror row and the _meta records, then optional sample data. Idempotent, so a directory
// that retries an init (or a runtime that runs it on every create attempt) never duplicates anything.
// Node's spaceStore and Cloudflare's SpaceDO both call it on the space's database.

import type { Db } from '../core/db';
import { migrate } from '../core/migrate';
import type { SpaceInit } from '../core/ports';
import { APP_VERSION } from '../core/version';
import { createSampleData, ensureDefaults } from '../db/seed';
import { nowIso } from '../services/sql';
import { healActor } from './mirror';
import { SPACE_MIGRATIONS } from './schema';

const META_ADD = 'INSERT OR IGNORE INTO _meta (key, value) VALUES (:key, :value)';

/** The space id the database was initialized for (_meta.space_id), or null before init. */
export function storedSpaceId(db: Db): string | null {
  return db.get<{ value: string }>("SELECT value FROM _meta WHERE key = 'space_id'")?.value ?? null;
}

export function initSpaceDb(db: Db, init: SpaceInit, o: { appVersion?: string } = {}): void {
  migrate(db, SPACE_MIGRATIONS, { appVersion: o.appVersion ?? APP_VERSION });
  db.tx(() => {
    const spaceId = storedSpaceId(db);
    if (spaceId !== null && spaceId !== init.spaceId) {
      throw new Error(`This database belongs to space ${spaceId}, not ${init.spaceId}`);
    }
    healActor(db, init.owner, nowIso());
    ensureDefaults(db);
    // Later syncs own space_name and sync_version; a repeated init must not set them back.
    db.run(META_ADD, { key: 'space_id', value: init.spaceId });
    db.run(META_ADD, { key: 'space_name', value: init.name });
    db.run(META_ADD, { key: 'sync_version', value: String(init.syncVersion) });
  });
  // Sample data in its own transaction: a failure leaves a working, empty space (as at setup before).
  // A space that already has projects (a repeated init) gets none.
  if (init.sampleData && !db.get('SELECT 1 FROM projects LIMIT 1')) {
    const { today } = init.sampleData;
    try {
      db.tx(() => createSampleData(db, init.owner.userId, today));
    } catch (err) {
      console.error('[lyren] Failed to create sample data:', err);
    }
  }
}
