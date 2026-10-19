// File operations that must survive a crash or a busy Windows file (design §3.8 step 7, §9.5, §9.6): the
// legacy upgrade's swap, the backup set's final rename and the restore's moves use them.
//
// renameRetrying: rename(2) on POSIX, which replaces the target atomically. On Windows Node's rename is
// MoveFileExW with MOVEFILE_REPLACE_EXISTING, which fails with EPERM, EBUSY or EACCES while another
// program (an antivirus scanner, the search indexer) briefly holds either file open, so it is retried
// there for up to 10 s. fsyncFolder makes a rename durable on POSIX; Windows cannot open a folder for
// that, and NTFS journals the rename itself.

import fs from 'node:fs';

/** How long a rename keeps retrying on Windows. */
export const RENAME_RETRY_MS = 10_000;
const RENAME_PAUSE_MS = 100;
const RETRIED = new Set(['EPERM', 'EBUSY', 'EACCES']);

export interface RenameOptions {
  /** The rename itself (tests inject failures); default fs.renameSync. */
  rename?: (from: string, to: string) => void;
  platform?: NodeJS.Platform;
  /** Clock and pause of the retries (tests); default real time. */
  now?: () => number;
  sleep?: (ms: number) => void;
}

/** Block the thread for `ms` (the callers are synchronous start-up code). */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Rename `from` to `to`, replacing `to`; on Windows retried for up to RENAME_RETRY_MS (see the header). */
export function renameRetrying(from: string, to: string, o: RenameOptions = {}): void {
  const rename = o.rename ?? fs.renameSync;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? sleepSync;
  const retries = (o.platform ?? process.platform) === 'win32';
  const deadline = now() + RENAME_RETRY_MS;
  for (;;) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!retries || code === undefined || !RETRIED.has(code) || now() >= deadline) throw err;
      sleep(RENAME_PAUSE_MS);
    }
  }
}

/** Flush a file's content to the disk. */
export function fsyncFile(file: string): void {
  const fd = fs.openSync(file, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Flush a folder's entries (a rename, a new file) to the disk; nothing on Windows (see the header). */
export function fsyncFolder(dir: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') return;
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** The files SQLite keeps next to a database. */
export const SQLITE_SIDE_FILES = ['-wal', '-shm', '-journal'] as const;

/** Delete a database file and its -wal, -shm and -journal, where they exist. */
export function removeDatabaseFiles(file: string): void {
  for (const suffix of ['', ...SQLITE_SIDE_FILES]) fs.rmSync(`${file}${suffix}`, { force: true });
}
