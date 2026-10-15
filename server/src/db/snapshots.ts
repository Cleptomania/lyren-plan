// Automatic safety snapshots and their retention.
//
// Two kinds are written automatically (both with Db.backupTo, i.e. VACUUM INTO):
//   pre-import-<stamp>[-<n>].db           before every JSON import (routes/data.ts), in DATA_DIR/backups
//   lyren-v<N>-before-upgrade-<stamp>.db  before a schema migration (db/schema.ts), in backups/ next
//                                         to the database file
// <stamp> is the UTC write time from snapshotStamp(), e.g. 2026-10-14T06-56-26-123Z.
//
// After writing one, the caller runs pruneSnapshots() to keep the newest `keep` of that kind
// (Config.snapshotKeep, env SNAPSHOT_KEEP; 0 = keep all). It is deliberately conservative:
// - only regular files whose WHOLE name matches the kind's pattern are candidates, so the
//   user's own backups (e.g. backups/lyren-2026-10-14.db from the `backup` command), files of
//   the other kind, renamed copies, directories and symlinks are never touched;
// - the snapshot just written is never deleted and counts as one of the `keep`;
// - "newest" is the time in the file name (not mtime, which copying or restoring changes);
// - it never throws: an unreadable directory or a file that can't be removed is logged and
//   skipped, so retention can never fail the import or the startup that wrote the snapshot.

import fs from 'node:fs';
import path from 'node:path';

/** Snapshots of each kind kept by default (SNAPSHOT_KEEP). */
export const DEFAULT_SNAPSHOT_KEEP = 10;

export type SnapshotKind = 'pre-import' | 'before-upgrade';

/** snapshotStamp() output: an ISO-8601 UTC timestamp with ':' and '.' replaced by '-'. */
const STAMP = String.raw`(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)`;

const PATTERNS: Record<SnapshotKind, RegExp> = {
  // The optional -<n> suffix keeps names unique when two imports land in the same millisecond.
  'pre-import': new RegExp(String.raw`^pre-import-${STAMP}(?:-([1-9]\d{0,5}))?\.db$`),
  'before-upgrade': new RegExp(String.raw`^lyren-v([1-9]\d{0,5})-before-upgrade-${STAMP}\.db$`),
};

/** File-name-safe UTC timestamp; sorts chronologically as a string. */
export function snapshotStamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

interface Candidate {
  name: string;
  stamp: string;
  /** Tie-breaker for equal stamps: the -<n> suffix of a pre-import snapshot, the version of an upgrade one. */
  order: number;
}

function parseSnapshotName(kind: SnapshotKind, name: string): Candidate | null {
  const m = PATTERNS[kind].exec(name);
  if (!m) return null;
  return kind === 'pre-import'
    ? { name, stamp: m[1]!, order: m[2] === undefined ? 1 : Number(m[2]) }
    : { name, stamp: m[2]!, order: Number(m[1]) };
}

/** Whether `name` is an automatic snapshot file name of `kind`. */
export function isSnapshotName(kind: SnapshotKind, name: string): boolean {
  return parseSnapshotName(kind, name) !== null;
}

const newestFirst = (a: Candidate, b: Candidate) =>
  a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : b.order - a.order || (a.name < b.name ? 1 : -1);

export interface PruneResult {
  /** File names (in `dir`) that were deleted, oldest last. */
  removed: string[];
  /** File names that should have been deleted but could not be (the error was logged). */
  failed: string[];
}

/**
 * Keep the newest `keep` snapshots of `kind` in `dir` and delete older ones. `justWritten` (a
 * path or file name in `dir`) is never deleted and counts towards `keep`. `keep` <= 0 keeps all.
 */
export function pruneSnapshots(dir: string, kind: SnapshotKind, keep: number, justWritten: string): PruneResult {
  const result: PruneResult = { removed: [], failed: [] };
  if (!Number.isInteger(keep) || keep <= 0) return result;

  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    console.warn(`[lyren] Could not list ${dir} to prune old snapshots: ${(err as Error).message}`);
    return result;
  }

  const protectedName = path.basename(justWritten);
  const candidates: Candidate[] = [];
  let protectedPresent = false;
  for (const name of names) {
    const candidate = parseSnapshotName(kind, name);
    if (!candidate) continue;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(path.join(dir, name));
    } catch {
      continue; // vanished meanwhile
    }
    if (!stat.isFile()) continue; // directories, symlinks, sockets...: never ours
    if (name === protectedName) protectedPresent = true;
    else candidates.push(candidate);
  }

  candidates.sort(newestFirst);
  const keepOthers = Math.max(0, protectedPresent ? keep - 1 : keep);
  for (const { name } of candidates.slice(keepOthers)) {
    try {
      fs.unlinkSync(path.join(dir, name));
      result.removed.push(name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      result.failed.push(name);
      console.warn(`[lyren] Could not delete old snapshot ${path.join(dir, name)}: ${(err as Error).message}`);
    }
  }
  return result;
}

/** One log line about a prune (nothing when nothing was deleted). */
export function logPrune(kind: SnapshotKind, dir: string, keep: number, { removed }: PruneResult): void {
  if (removed.length === 0) return;
  const what = kind === 'pre-import' ? 'pre-import' : 'pre-upgrade';
  console.log(
    `[lyren] Deleted ${removed.length} old ${what} snapshot${removed.length === 1 ? '' : 's'} from ${dir} ` +
      `(keeping the newest ${keep}; set SNAPSHOT_KEEP to change, 0 keeps all)`,
  );
}
