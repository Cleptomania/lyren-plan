// What a replace import can fall back to (design §8.8). Node writes a VACUUM INTO snapshot of the space
// before replacing it (runtime/node/spaceStore.ts) and names the command that puts it back; Cloudflare has
// none, and the owner downloads an archive of the current data first instead (§12.10).

import type { SafetyPointDTO } from '@shared/types';

/**
 * A snapshot file; `path` is relative to the directory file's folder (backups/spaces/<id>/pre-import-….db),
 * `restoreCommand` the command that undoes the import, then a restart (§9.6: restore takes one space's database).
 */
export type SafetyPoint = SafetyPointDTO;

export interface SpaceSafety {
  /** Called after validation and before anything is replaced; throws (and the import aborts) when it fails. */
  beforeReplace(): Promise<SafetyPoint | null>;
}

/** No safety point (Cloudflare, and in-memory spaces). */
export const NO_SAFETY: SpaceSafety = { beforeReplace: async () => null };

/** The restore command of a snapshot at `path` (relative to the data folder, where `restore` also looks). */
export const restoreCommand = (path: string) => `restore "${path}"`;
