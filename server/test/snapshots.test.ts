// Retention of the automatic safety snapshots (server/src/db/snapshots.ts): pre-import snapshots
// written by a replace import (POST /api/data/import/commit?mode=replace) and pre-upgrade snapshots written before a schema migration.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { applyMigrations, SCHEMA_VERSION } from '../src/db/schema';
import { DEFAULT_SNAPSHOT_KEEP, isSnapshotName, pruneSnapshots, snapshotStamp } from '../src/db/snapshots';
import { openDb } from '../src/runtime/node/nodeDb';
import { createTestContext } from './helpers';
import { downloadArchive, replaceImport, v1Of } from './support/archive';

const posix = process.platform !== 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-snap-'));
  dirs.push(dir);
  return dir;
}

/** Stamp for 2026-01-<day> 12:00:00.<ms>Z. */
const stamp = (day: number, ms = 0) => snapshotStamp(new Date(Date.UTC(2026, 0, day, 12, 0, 0, ms)));
const preImport = (day: number, suffix = '') => `pre-import-${stamp(day)}${suffix}.db`;
const preUpgrade = (version: number, day: number) => `lyren-v${version}-before-upgrade-${stamp(day)}.db`;

function touch(dir: string, ...names: string[]): void {
  for (const name of names) fs.writeFileSync(path.join(dir, name), name);
}

const ls = (dir: string) => fs.readdirSync(dir).sort();

describe('snapshot names', () => {
  it('matches exactly the names the server writes', () => {
    expect(isSnapshotName('pre-import', `pre-import-${snapshotStamp()}.db`)).toBe(true);
    expect(isSnapshotName('pre-import', preImport(3, '-2'))).toBe(true);
    expect(isSnapshotName('before-upgrade', preUpgrade(1, 3))).toBe(true);
    expect(isSnapshotName('before-upgrade', preUpgrade(12, 3))).toBe(true);
    for (const name of [
      'lyren.db',
      'lyren-2026-10-14.db', // a backup the user made with the `backup` command
      'pre-import-.db',
      'pre-import-notes.db',
      `pre-import-${stamp(3)}.db.bak`,
      `pre-import-${stamp(3)}.db-wal`,
      `pre-import-${stamp(3)}.DB`,
      `PRE-IMPORT-${stamp(3)}.db`,
      `pre-import-${stamp(3)}-0.db`,
      `pre-import-${stamp(3)}-x.db`,
      `my-pre-import-${stamp(3)}.db`,
      `pre-import-${stamp(3)}.db/`,
      preUpgrade(1, 3),
    ]) {
      expect(isSnapshotName('pre-import', name), name).toBe(false);
    }
    for (const name of ['lyren-v-before-upgrade.db', `lyren-v0-before-upgrade-${stamp(3)}.db`, preImport(3)]) {
      expect(isSnapshotName('before-upgrade', name), name).toBe(false);
    }
  });

  it('stamps sort chronologically as strings', () => {
    const a = snapshotStamp(new Date('2026-01-09T23:59:59.999Z'));
    const b = snapshotStamp(new Date('2026-01-10T00:00:00.000Z'));
    expect(a).toBe('2026-01-09T23-59-59-999Z');
    expect(a < b).toBe(true);
  });
});

describe('pruneSnapshots', () => {
  it('keeps the newest N (the one just written included) and deletes the rest', () => {
    const dir = tempDir();
    const old = [1, 2, 3, 4, 5, 6].map((d) => preImport(d));
    touch(dir, ...old, preImport(7));
    const res = pruneSnapshots(dir, 'pre-import', 3, path.join(dir, preImport(7)));
    expect(ls(dir)).toEqual([preImport(5), preImport(6), preImport(7)]);
    expect(res.removed).toEqual([preImport(4), preImport(3), preImport(2), preImport(1)]);
    expect(res.failed).toEqual([]);
  });

  it('never deletes the snapshot just written, even when its time sorts oldest (clock went back)', () => {
    const dir = tempDir();
    touch(dir, preImport(10), preImport(11), preImport(12), preImport(1));
    pruneSnapshots(dir, 'pre-import', 2, preImport(1));
    expect(ls(dir)).toEqual([preImport(1), preImport(12)]);
    // keep = 1: only the new one survives.
    pruneSnapshots(dir, 'pre-import', 1, preImport(1));
    expect(ls(dir)).toEqual([preImport(1)]);
  });

  it('orders same-millisecond imports by their -<n> suffix', () => {
    const dir = tempDir();
    touch(dir, preImport(3), preImport(3, '-2'), preImport(3, '-3'), preImport(3, '-10'), preImport(2));
    pruneSnapshots(dir, 'pre-import', 2, preImport(3, '-10'));
    expect(ls(dir)).toEqual([preImport(3, '-10'), preImport(3, '-3')]);
  });

  it('keeps everything when keep is 0', () => {
    const dir = tempDir();
    const names = [1, 2, 3, 4].map((d) => preImport(d));
    touch(dir, ...names);
    expect(pruneSnapshots(dir, 'pre-import', 0, names[3]!)).toEqual({ removed: [], failed: [] });
    expect(ls(dir)).toEqual(names);
  });

  it('only counts the protected snapshot towards keep when it is actually there', () => {
    const dir = tempDir();
    touch(dir, preImport(1), preImport(2), preImport(3));
    pruneSnapshots(dir, 'pre-import', 2, preImport(9));
    expect(ls(dir)).toEqual([preImport(2), preImport(3)]);
  });

  it('never touches files of the other kind, user backups, look-alikes, directories or symlinks', () => {
    const dir = tempDir();
    const outside = tempDir();
    const unrelated = [
      'lyren-2026-01-01.db',
      'lyren.db',
      'README.txt',
      `pre-import-${stamp(1)}.db.bak`,
      `pre-import-${stamp(1)}.db-wal`,
      // Upper case with a stamp no real snapshot here has: on a case-insensitive file system
      // (Windows, macOS) PRE-IMPORT-<stamp 1>.db would be the same file as preImport(1).
      `PRE-IMPORT-${stamp(7)}.db`,
      `copy-of-pre-import-${stamp(1)}.db`,
      preUpgrade(1, 1),
      preUpgrade(1, 2),
    ];
    touch(dir, ...unrelated, preImport(1), preImport(2), preImport(3));
    // A directory and a symlink (to a file elsewhere) with snapshot names.
    fs.mkdirSync(path.join(dir, preImport(4)));
    fs.writeFileSync(path.join(dir, preImport(4), 'inside.txt'), 'keep me');
    fs.writeFileSync(path.join(outside, 'target.db'), 'target');
    let symlinked = false;
    try {
      fs.symlinkSync(path.join(outside, 'target.db'), path.join(dir, preImport(5)));
      symlinked = true;
    } catch {
      /* symlinks may be unavailable (Windows without privileges) */
    }

    const res = pruneSnapshots(dir, 'pre-import', 1, preImport(3));
    expect(res.removed).toEqual([preImport(2), preImport(1)]);
    expect(ls(dir)).toEqual(
      [...unrelated, preImport(3), preImport(4), ...(symlinked ? [preImport(5)] : [])].sort(),
    );
    expect(fs.readFileSync(path.join(dir, preImport(4), 'inside.txt'), 'utf8')).toBe('keep me');
    expect(fs.readFileSync(path.join(outside, 'target.db'), 'utf8')).toBe('target');
    expect(fs.readFileSync(path.join(dir, 'lyren-2026-01-01.db'), 'utf8')).toBe('lyren-2026-01-01.db');
  });

  it('prunes upgrade snapshots across versions by time', () => {
    const dir = tempDir();
    touch(dir, preUpgrade(1, 1), preUpgrade(2, 5), preUpgrade(3, 9), preImport(2), preImport(3));
    const res = pruneSnapshots(dir, 'before-upgrade', 2, preUpgrade(3, 9));
    expect(res.removed).toEqual([preUpgrade(1, 1)]);
    expect(ls(dir)).toEqual([preUpgrade(2, 5), preUpgrade(3, 9), preImport(2), preImport(3)].sort());
  });

  it('does not throw when the directory is missing or not a directory', () => {
    const dir = tempDir();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(pruneSnapshots(path.join(dir, 'nope'), 'pre-import', 1, preImport(1))).toEqual({ removed: [], failed: [] });
    touch(dir, 'file');
    expect(pruneSnapshots(path.join(dir, 'file'), 'pre-import', 1, preImport(1))).toEqual({ removed: [], failed: [] });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it.runIf(posix && !isRoot)('logs and skips snapshots it cannot delete', () => {
    const dir = tempDir();
    touch(dir, preImport(1), preImport(2), preImport(3));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fs.chmodSync(dir, 0o500); // no unlinking inside
    try {
      const res = pruneSnapshots(dir, 'pre-import', 1, preImport(3));
      expect(res).toEqual({ removed: [], failed: [preImport(2), preImport(1)] });
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    expect(warn).toHaveBeenCalledTimes(2);
    expect(ls(dir)).toEqual([preImport(1), preImport(2), preImport(3)]);
  });
});

describe('SNAPSHOT_KEEP', () => {
  it('defaults to 10, accepts 0 (keep all) and rejects anything else', () => {
    vi.stubEnv('SNAPSHOT_KEEP', '');
    expect(loadConfig().snapshotKeep).toBe(DEFAULT_SNAPSHOT_KEEP);
    expect(DEFAULT_SNAPSHOT_KEEP).toBe(10);
    vi.stubEnv('SNAPSHOT_KEEP', '0');
    expect(loadConfig().snapshotKeep).toBe(0);
    vi.stubEnv('SNAPSHOT_KEEP', '25');
    expect(loadConfig().snapshotKeep).toBe(25);
    for (const bad of ['-1', '2.5', 'ten', '1e9']) {
      vi.stubEnv('SNAPSHOT_KEEP', bad);
      expect(() => loadConfig(), bad).toThrow(/Invalid value for SNAPSHOT_KEEP/);
    }
  });
});

describe('import snapshots', () => {
  async function importer(snapshotKeep: number) {
    const ctx = createTestContext({ snapshotKeep });
    const { client } = await ctx.signedIn();
    const exported = v1Of((await downloadArchive(client)).archive!);
    // §8.8, §9.5: each space's pre-import snapshots go to backups/spaces/<id>/.
    const backups = path.join(ctx.config.dataDir, 'backups', 'spaces', ctx.spaceId);
    const importOnce = async () => {
      const res = await replaceImport(client, exported);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return path.basename(res.body.safety.path as string);
    };
    return { ctx, backups, importOnce };
  }

  it('keeps the newest SNAPSHOT_KEEP pre-import snapshots and nothing else is touched', async () => {
    const { backups, importOnce } = await importer(3);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    fs.mkdirSync(backups, { recursive: true });
    // Older snapshots from earlier imports, a user backup, an upgrade snapshot and a look-alike.
    const foreign = ['lyren-2025-12-31.db', preUpgrade(1, 1), `pre-import-${stamp(1)}.db.bak`];
    touch(backups, preImport(1), preImport(2), preImport(3), preImport(4), ...foreign);

    const written: string[] = [];
    for (let i = 0; i < 5; i++) written.push(await importOnce());
    expect(new Set(written).size).toBe(5);
    expect(ls(backups)).toEqual([...foreign, ...written.slice(-3)].sort());
    // The first import found 4 older snapshots: it keeps 2 of them next to its own.
    expect(log).toHaveBeenNthCalledWith(1, expect.stringMatching(/^\[lyren\] Deleted 2 old pre-import snapshots from .*keeping the newest 3/));
    expect(log).toHaveBeenCalledTimes(5);
  });

  it('SNAPSHOT_KEEP=0 keeps every pre-import snapshot', async () => {
    const { backups, importOnce } = await importer(0);
    fs.mkdirSync(backups, { recursive: true });
    touch(backups, preImport(1), preImport(2));
    const written = [await importOnce(), await importOnce()];
    expect(ls(backups)).toEqual([preImport(1), preImport(2), ...written].sort());
  });

  it('an unwritable backups folder never fails the import once the snapshot exists', async () => {
    const { backups, importOnce } = await importer(1);
    fs.mkdirSync(backups, { recursive: true });
    touch(backups, preImport(1));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    });
    const name = await importOnce();
    expect(ls(backups)).toEqual([preImport(1), name].sort());
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Could not delete old snapshot/));
  });
});

describe('pre-upgrade snapshots', () => {
  /** A database at schema v1 on disk, plus a backups/ folder holding `files`. */
  function v1Database(files: string[]) {
    const dir = tempDir();
    const file = path.join(dir, 'lyren.db');
    openDb(file).close();
    const backups = path.join(dir, 'backups');
    fs.mkdirSync(backups);
    touch(backups, ...files);
    return { file, backups };
  }

  // v1 is the real schema (already applied); v2 is a test-only migration.
  const migrations = ['-- v1 (already applied)', 'CREATE TABLE upgrade_probe (id INTEGER PRIMARY KEY)'];

  it('writes a snapshot before migrating and keeps the newest SNAPSHOT_KEEP of them', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
    const foreign = ['lyren-2026-01-01.db', preImport(1), preImport(2)];
    const { file, backups } = v1Database([preUpgrade(1, 1), preUpgrade(1, 2), preUpgrade(1, 3), ...foreign]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const db = openDb(file, { snapshotKeep: 99 }); // already current: no snapshot
    applyMigrations(db, migrations, { snapshotKeep: 2 });
    // user_version is Node-only: read it through raw, outside NodeDb's portability checks.
    expect((db.raw.prepare('SELECT user_version AS v FROM pragma_user_version').get() as { v: number }).v).toBe(2);
    db.close();

    const upgrades = ls(backups).filter((n) => isSnapshotName('before-upgrade', n));
    expect(upgrades).toHaveLength(2);
    expect(upgrades).toContain(preUpgrade(1, 3));
    const fresh = upgrades.find((n) => n !== preUpgrade(1, 3))!;
    expect(fresh).toMatch(/^lyren-v1-before-upgrade-\d{4}-.*Z\.db$/);
    // The new snapshot is the database as it was before the migration.
    const snap = openDb(path.join(backups, fresh), { snapshotKeep: 0 });
    expect(snap.get("SELECT name FROM sqlite_master WHERE name = 'upgrade_probe'")).toBeUndefined();
    snap.close();
    expect(ls(backups)).toEqual([...foreign, ...upgrades].sort());
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Deleted 2 old pre-upgrade snapshots/));
  });

  it('defaults to keeping 10 and keeps all with 0', () => {
    const olds = Array.from({ length: 12 }, (_, i) => preUpgrade(1, i + 1));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const a = v1Database(olds);
    const dbA = openDb(a.file);
    applyMigrations(dbA, migrations);
    dbA.close();
    expect(ls(a.backups)).toHaveLength(DEFAULT_SNAPSHOT_KEEP);
    expect(ls(a.backups)).toContain(preUpgrade(1, 12));
    expect(ls(a.backups)).not.toContain(preUpgrade(1, 3));

    const b = v1Database(olds);
    const dbB = openDb(b.file);
    applyMigrations(dbB, migrations, { snapshotKeep: 0 });
    dbB.close();
    expect(ls(b.backups)).toHaveLength(13);
  });
});
