// Plain-language start-up failure messages (server/src/startupErrors.ts).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sqlitePath } from '../src/runtime/node/nodeDb';
import {
  dbOpenFailureMessage,
  dbOpenProblem,
  fileInTheWay,
  inContainer,
  isDbAccessError,
  listenFailureMessage,
  missingWebClientMessage,
  nearestFolder,
} from '../src/startupErrors';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const read = (file: string) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
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
  const unwritable = sqliteError(14, 'unable to open database file');

  it('explains how to fix the permissions, with the Docker advice only in a container', () => {
    expect(dbOpenFailureMessage('/data/lyren.db', unwritable, 1000, 'server', 'linux', true)).toEqual([
      'Could not open the database /data/lyren.db: unable to open database file',
      'The directory /data and the files in it must be writable by the user running the server (uid 1000).',
      'Docker: the container runs as uid 1000, so give a bind-mounted data directory to it, e.g.',
      '  sudo chown -R 1000:1000 ./data',
    ]);
    // systemd, the release tarball, a shell: the fix for this user and folder.
    expect(dbOpenFailureMessage('/srv/lyren/data/lyren.db', unwritable, 998, 'server', 'linux', false)).toEqual([
      'Could not open the database /srv/lyren/data/lyren.db: unable to open database file',
      'The directory /srv/lyren/data and the files in it must be writable by the user running the server (uid 998).',
      'Give them to that user (e.g. sudo chown -R 998 /srv/lyren/data), or set DATA_DIR to a directory it owns.',
    ]);
    expect(dbOpenFailureMessage("/srv/it's mine/lyren.db", unwritable, 998, 'server', 'linux', false)[2]).toBe(
      "Give them to that user (e.g. sudo chown -R 998 '/srv/it'\\''s mine'), or set DATA_DIR to a directory it owns.",
    );
    expect(dbOpenFailureMessage('D:\\Lyren\\lyren.db', unwritable, undefined, 'server', 'win32', false).at(-1)).toBe(
      'Set DATA_DIR to a directory this user can write to.',
    );
  });

  it('knows a container by the image\'s variable, /.dockerenv or /run/.containerenv', () => {
    const none = () => false;
    expect(inContainer({ LYREN_CONTAINER: '1' }, none)).toBe(true);
    expect(inContainer({}, (file) => file === '/.dockerenv')).toBe(true);
    expect(inContainer({}, (file) => file === '/run/.containerenv')).toBe(true);
    expect(inContainer({ LYREN_CONTAINER: '' }, none)).toBe(false);
    expect(read('Dockerfile')).toMatch(/^\s+LYREN_CONTAINER=1/m);
  });

  it('the env_file that docker-compose.yml suggests for secrets is neither committed nor built into the image', () => {
    expect(read('docker-compose.yml')).toMatch(/^\s+#\s+- lyren-secrets\.env$/m);
    // The build stage copies the checkout (COPY . .): only .dockerignore keeps the file out of its layers.
    expect(read('Dockerfile')).toMatch(/^COPY \. \.$/m);
    for (const file of ['.gitignore', '.dockerignore']) expect(read(file).split('\n'), file).toContain('*.env');
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

  it('a folder this user may not create: the folder above it, and how to create it (no chown of a missing folder)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-mkdir-'));
    dirs.push(dir);
    // The mode does not matter here: the error says mkdir failed, and the folder above is the nearest that exists.
    const dataDir = path.join(dir, 'ro', 'data');
    fs.mkdirSync(path.join(dir, 'ro'));
    expect(nearestFolder(dataDir)).toBe(path.join(dir, 'ro'));
    expect(nearestFolder(path.join(dir, 'ro', 'a', 'b'))).toBe(path.join(dir, 'ro'));
    expect(nearestFolder(dir)).toBe(dir);
    const err = mkdirError('EACCES', dataDir);
    expect(dbOpenProblem(path.join(dataDir, 'lyren.db'), err, 'linux')).toBe('access');
    expect(dbOpenFailureMessage(path.join(dataDir, 'lyren.db'), err, 1000, 'server', 'linux', false)).toEqual([
      `Could not open the database ${path.join(dataDir, 'lyren.db')}: EACCES: mkdir '${dataDir}'`,
      `The directory ${dataDir} and the files in it must be writable by the user running the server (uid 1000).`,
      `It does not exist yet, and this user cannot create it in ${path.join(dir, 'ro')}.`,
      `Create it for that user (e.g. sudo install -d -o 1000 -m 700 ${dataDir}), or set DATA_DIR to a directory it owns.`,
    ]);
    // In a container, and for a folder that exists, as before.
    expect(dbOpenFailureMessage(path.join(dataDir, 'lyren.db'), err, 1000, 'server', 'linux', true)[2]).toMatch(/^Docker:/);
    expect(dbOpenFailureMessage(path.join(dataDir, 'lyren.db'), fsError('EACCES'), 1000, 'server', 'linux', false)[2]).toMatch(/^Give them to that user/);
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
