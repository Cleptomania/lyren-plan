// Plain-language start-up failure messages (server/src/startupErrors.ts).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sqlitePath } from '../src/db';
import {
  dbOpenFailureMessage,
  dbOpenProblem,
  fileInTheWay,
  isDbAccessError,
  listenFailureMessage,
  missingWebClientMessage,
} from '../src/startupErrors';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const sqliteError = (errcode: number, message: string) => Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode });
const fsError = (code: string) => Object.assign(new Error(`${code}: permission denied, mkdir '/data'`), { code });

describe('isDbAccessError', () => {
  it('recognises permission and read-only failures from fs and SQLite', () => {
    expect(isDbAccessError(fsError('EACCES'))).toBe(true);
    expect(isDbAccessError(fsError('EPERM'))).toBe(true);
    expect(isDbAccessError(fsError('EROFS'))).toBe(true);
    expect(isDbAccessError(sqliteError(14, 'unable to open database file'))).toBe(true);
    expect(isDbAccessError(sqliteError(8, 'attempt to write a readonly database'))).toBe(true);
  });

  it('leaves other failures alone', () => {
    expect(isDbAccessError(sqliteError(11, 'database disk image is malformed'))).toBe(false);
    expect(isDbAccessError(new Error('Database schema version 9 is newer than this build supports (1). Upgrade the app.'))).toBe(false);
    expect(isDbAccessError(undefined)).toBe(false);
    expect(isDbAccessError('boom')).toBe(false);
  });
});

describe('dbOpenFailureMessage', () => {
  it('explains how to fix the permissions', () => {
    const lines = dbOpenFailureMessage('/data/lyren.db', sqliteError(14, 'unable to open database file'), 1000);
    expect(lines[0]).toBe('Could not open the database /data/lyren.db: unable to open database file');
    expect(lines.join('\n')).toContain('The directory /data and the files in it must be writable by the user running the server (uid 1000).');
    expect(lines.join('\n')).toContain('sudo chown -R 1000:1000');
  });

  it('just states other errors', () => {
    const err = new Error('Database schema version 9 is newer than this build supports (1). Upgrade the app.');
    expect(dbOpenFailureMessage('/data/lyren.db', err, 1000)).toEqual([
      'Could not open the database /data/lyren.db: Database schema version 9 is newer than this build supports (1). Upgrade the app.',
    ]);
  });
});

describe('a data folder that cannot be created', () => {
  const mkdirError = (code: string, p: string) => Object.assign(new Error(`${code}: mkdir '${p}'`), { code, syscall: 'mkdir', path: p });

  it('a missing drive (an unplugged USB drive) or folder above it', () => {
    const err = mkdirError('ENOENT', 'Q:\\Lyren');
    expect(dbOpenProblem('Q:\\Lyren\\lyren.db', err, 'win32')).toBe('missing');
    const desktop = dbOpenFailureMessage('Q:\\Lyren\\lyren.db', err, undefined, 'desktop', 'win32').join('\n');
    expect(desktop).toContain('does not exist (for example an unplugged USB drive)');
    expect(desktop).toContain('--data-dir');
    expect(dbOpenFailureMessage('/mnt/usb/lyren/lyren.db', err, 1000, 'server', 'linux').join('\n')).toContain('DATA_DIR');
  });

  it('a file where the folder (or a folder above it) should be', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-notdir-'));
    dirs.push(dir);
    const file = path.join(dir, 'afile.txt');
    fs.writeFileSync(file, 'x');
    expect(fileInTheWay(file)).toBe(file);
    expect(fileInTheWay(path.join(file, 'sub', 'deeper'))).toBe(file);
    expect(fileInTheWay(path.join(dir, 'new', 'folder'))).toBeNull();
    for (const code of ['EEXIST', 'ENOTDIR']) {
      const err = mkdirError(code, file);
      expect(dbOpenProblem(path.join(file, 'lyren.db'), err)).toBe('not-a-folder');
      const lines = dbOpenFailureMessage(path.join(file, 'lyren.db'), err, undefined, 'desktop');
      expect(lines[1]).toBe(`${file} is a file, not a folder.`);
      expect(lines[2]).toContain('--data-dir');
    }
  });

  it('a path too long for Windows', () => {
    const long = 'C:\\' + 'x'.repeat(260) + '\\lyren.db';
    const err = Object.assign(new Error('unable to open database file'), { code: 'ERR_SQLITE_ERROR', errcode: 14 });
    expect(dbOpenProblem(long, err, 'win32')).toBe('too-long');
    expect(dbOpenFailureMessage(long, err, undefined, 'desktop', 'win32')[1]).toMatch(/^The path is too long for Windows/);
    expect(dbOpenProblem('C:\\Lyren\\lyren.db', err, 'win32')).toBe('access');
    expect(dbOpenProblem(long, err, 'linux')).toBe('access');
    expect(dbOpenProblem('/x/lyren.db', new Error('Database schema version 9 is newer'), 'linux')).toBeNull();
  });

  it('SQLite gets \\\\?\\ paths on Windows (exempt from MAX_PATH), plain ones elsewhere', () => {
    expect(sqlitePath('C:\\Users\\ann\\AppData\\Local\\Lyren Plan\\lyren.db', 'win32')).toBe('\\\\?\\C:\\Users\\ann\\AppData\\Local\\Lyren Plan\\lyren.db');
    expect(sqlitePath('C:/Lyren/backups/x.db', 'win32')).toBe('\\\\?\\C:\\Lyren\\backups\\x.db');
    expect(sqlitePath('\\\\server\\share\\lyren.db', 'win32')).toBe('\\\\?\\UNC\\server\\share\\lyren.db');
    expect(sqlitePath(':memory:', 'win32')).toBe(':memory:');
    expect(sqlitePath('/data/lyren.db', 'linux')).toBe('/data/lyren.db');
  });
});

describe('listenFailureMessage', () => {
  const err = (code: string) => Object.assign(new Error(code), { code });

  it('explains a busy port, a privileged port and a foreign HOST', () => {
    expect(listenFailureMessage(err('EADDRINUSE'), '0.0.0.0', 8080)?.[0]).toBe(
      'Port 8080 is already in use on 0.0.0.0: is Lyren Plan (or another server) already running?',
    );
    expect(listenFailureMessage(err('EACCES'), '0.0.0.0', 80)?.[0]).toBe(
      'Not allowed to listen on port 80 (ports below 1024 need extra privileges).',
    );
    expect(listenFailureMessage(err('EADDRNOTAVAIL'), '10.9.9.9', 8080)?.[0]).toMatch(/^HOST=10\.9\.9\.9 is not an address of this machine/);
  });

  it('returns null for anything unexpected', () => {
    expect(listenFailureMessage(err('EMFILE'), '0.0.0.0', 8080)).toBeNull();
    expect(listenFailureMessage(null, '0.0.0.0', 8080)).toBeNull();
  });
});

describe('missingWebClientMessage', () => {
  it('names the folder and how to fix it', () => {
    const text = missingWebClientMessage('/srv/lyren/dist/web').join('\n');
    // The folder is resolved on this host (C:\srv\lyren\dist\web on Windows).
    expect(text).toContain(`Web client not found: no index.html in ${path.resolve('/srv/lyren/dist/web')}.`);
    expect(text).toContain('npm run build');
    expect(text).toContain('WEB_DIR');
  });
});

describe('desktop app wording', () => {
  const err = (code: string) => Object.assign(new Error(code), { code });

  it('no Docker or reverse-proxy advice, options instead of variables', () => {
    const db = dbOpenFailureMessage('C:\\Lyren\\lyren.db', sqliteError(14, 'unable to open database file'), undefined, 'desktop').join('\n');
    expect(db).toContain('must be writable by you');
    expect(db).toContain('--data-dir');
    expect(db).not.toMatch(/Docker|chown/);
    expect(listenFailureMessage(err('EADDRINUSE'), '127.0.0.1', 43770, 'desktop')).toEqual([
      'Port 43770 is already in use by another program.',
      'Start Lyren Plan with another port, e.g. --port 8090 (or set PORT), or close the program that uses it.',
    ]);
    expect(listenFailureMessage(err('EACCES'), '127.0.0.1', 57600, 'desktop')?.[0]).toBe(
      'Port 57600 is reserved by the system (on Windows often by Hyper-V, WSL or Docker).',
    );
    // The server wording is unchanged.
    expect(listenFailureMessage(err('EADDRINUSE'), '0.0.0.0', 8080)?.[1]).toBe('Stop the other process, or start this one on another port, e.g. PORT=8081.');
  });
});
