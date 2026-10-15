// Plain-language explanations for the start-up problems a self-hoster can fix themselves
// (a data directory that can't be created or written, port in use, bad environment value, missing
// web client), printed instead of a stack trace or a silent 404. Functions that return lines (only
// fileInTheWay looks at the disk) so they can be tested; cli.ts and desktop/ print them (and exit
// for the fatal ones).

import fs from 'node:fs';
import path from 'node:path';

/**
 * Who reads the message: 'server' (the Node build, Docker: an administrator) or 'desktop' (the
 * single-file app, double-clicked: no Docker, no reverse proxy, flags instead of variables).
 */
export type Audience = 'server' | 'desktop';

interface ErrorLike {
  message?: unknown;
  code?: unknown;
  /** node:sqlite: the SQLite result code (14 = SQLITE_CANTOPEN, 8 = SQLITE_READONLY). */
  errcode?: unknown;
}

const SQLITE_READONLY = 8;
const SQLITE_CANTOPEN = 14;

function messageOf(err: unknown): string {
  const m = (err as ErrorLike | null)?.message;
  return typeof m === 'string' ? m : String(err);
}

/** Whether opening the database failed because the files or their directory can't be written. */
export function isDbAccessError(err: unknown): boolean {
  const e = (err ?? {}) as ErrorLike;
  if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') return true;
  if (e.errcode === SQLITE_CANTOPEN || e.errcode === SQLITE_READONLY) return true;
  return /unable to open database file|readonly database/i.test(messageOf(err));
}

/**
 * Windows' classic path limit (MAX_PATH, 260 characters including the terminating NUL; a folder
 * may be at most 248). The server hands SQLite \\?\ paths (db/index.ts sqlitePath), which are
 * exempt; this explains the limit should another component still run into it.
 */
const WINDOWS_MAX_DIR = 248;

/** Why the database (or its folder) could not be opened, as far as the user can fix it. */
export type DbOpenProblem = 'access' | 'missing' | 'not-a-folder' | 'too-long' | null;

export function dbOpenProblem(dbPath: string, err: unknown, platform: NodeJS.Platform = process.platform): DbOpenProblem {
  const e = (err ?? {}) as ErrorLike;
  // mkdir of the data folder: a drive that isn't there (an unplugged USB drive), or a file in the way.
  if (e.code === 'ENOENT') return 'missing';
  if (e.code === 'EEXIST' || e.code === 'ENOTDIR') return 'not-a-folder';
  if (platform === 'win32' && e.errcode === SQLITE_CANTOPEN && path.win32.dirname(dbPath).length >= WINDOWS_MAX_DIR) return 'too-long';
  if (isDbAccessError(err)) return 'access';
  return null;
}

/**
 * The file that stands where the data folder (or a folder above it) should be: the nearest
 * existing path above `dir` that is not a folder, or null.
 */
export function fileInTheWay(dir: string): string | null {
  for (let p = path.resolve(dir); ; p = path.dirname(p)) {
    try {
      return fs.statSync(p).isDirectory() ? null : p;
    } catch {
      if (path.dirname(p) === p) return null;
    }
  }
}

/** Lines explaining why the database at `dbPath` could not be opened. */
export function dbOpenFailureMessage(
  dbPath: string,
  err: unknown,
  uid: number | undefined,
  audience: Audience = 'server',
  platform: NodeJS.Platform = process.platform,
): string[] {
  const lines = [`Could not open the database ${dbPath}: ${messageOf(err)}`];
  const dir = path.dirname(dbPath);
  const desktop = audience === 'desktop';
  const chooseFolder = 'Choose another data folder with --data-dir <folder> (or the DATA_DIR environment variable).';
  switch (dbOpenProblem(dbPath, err, platform)) {
    case 'missing':
      lines.push(
        desktop
          ? `The folder ${dir} can't be created because its drive or a folder above it does not exist (for example an unplugged USB drive).`
          : `The directory ${dir} can't be created because a directory above it (or its drive) does not exist.`,
        desktop
          ? 'Connect the drive, or choose another data folder with --data-dir <folder> (or the DATA_DIR environment variable).'
          : 'Create it, mount it, or set DATA_DIR (or DB_PATH) to an existing location.',
      );
      break;
    case 'not-a-folder':
      lines.push(
        `${fileInTheWay(dir) ?? dir} is a file, not a folder.`,
        desktop ? chooseFolder : 'Set DATA_DIR (or DB_PATH) to a directory, or move the file out of the way.',
      );
      break;
    case 'too-long':
      lines.push(
        `The path is too long for Windows (${dir.length} characters; folders may have at most ${WINDOWS_MAX_DIR - 1}).`,
        desktop ? chooseFolder : 'Set DATA_DIR (or DB_PATH) to a shorter path.',
      );
      break;
    case 'access':
      if (desktop) {
        lines.push(`The folder ${dir} and the files in it must be writable by you.`, chooseFolder);
      } else {
        lines.push(
          `The directory ${dir} and the files in it must be writable by the user running the server` +
            (uid === undefined ? '.' : ` (uid ${uid}).`),
          'Docker: the container runs as uid 1000, so give a bind-mounted data directory to it, e.g.',
          '  sudo chown -R 1000:1000 ./data',
          'Without Docker: set DATA_DIR to a directory this user owns.',
        );
      }
      break;
    case null:
      break;
  }
  return lines;
}

/** Lines explaining a failure to listen on host:port, or null for an unexpected error. */
export function listenFailureMessage(err: unknown, host: string, port: number, audience: Audience = 'server'): string[] | null {
  const code = (err as ErrorLike | null)?.code;
  if (audience === 'desktop' && code === 'EADDRINUSE') {
    return [
      `Port ${port} is already in use by another program.`,
      'Start Lyren Plan with another port, e.g. --port 8090 (or set PORT), or close the program that uses it.',
    ];
  }
  if (audience === 'desktop' && code === 'EACCES') {
    return [
      `Port ${port} is reserved by the system${port < 1024 ? '' : ' (on Windows often by Hyper-V, WSL or Docker)'}.`,
      'Start Lyren Plan with another port, e.g. --port 8090 (or set PORT).',
    ];
  }
  if (code === 'EADDRINUSE') {
    return [
      `Port ${port} is already in use on ${host}: is Lyren Plan (or another server) already running?`,
      'Stop the other process, or start this one on another port, e.g. PORT=8081.',
    ];
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return [
      `Not allowed to listen on port ${port}${port < 1024 ? ' (ports below 1024 need extra privileges)' : ''}.`,
      'Use a port from 1024 up (the default is 8080) and put a reverse proxy in front for ports 80/443.',
    ];
  }
  if (code === 'EADDRNOTAVAIL') {
    return [`HOST=${host} is not an address of this machine. Use 0.0.0.0 (all interfaces) or 127.0.0.1.`];
  }
  return null;
}

/** Warning for a server whose web folder holds no built client (it keeps running: the API works). */
export function missingWebClientMessage(webDir: string): string[] {
  return [
    `Web client not found: no index.html in ${path.resolve(webDir)}.`,
    '  Build it with `npm run build` (or copy the whole dist/ folder, not just dist/server.mjs),',
    '  or set WEB_DIR to the folder that holds it. Until then the browser shows a "web client is missing" page.',
  ];
}
