// Backup sets (runtime/node/backupSet.ts, tar.ts, design §9.5, §14.2, §14.3): the tar writer and its
// strict reader, a set's contents and manifest, what the directory snapshot leaves out (open invitations
// among them), a missing space file, foreign and malicious archives, a backup taken while another thread
// writes, file permissions, the admin download and the CLI's `backup`, and the database checks restore
// uses (inspectDatabase, the versions of §9.6 step 2).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { afterAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '@shared/constants';
import type { AuthStatusDTO } from '@shared/types';
import { loadConfig, type Config } from '../../src/config';
import { sha256Hex } from '../../src/core/crypto';
import { APP_VERSION } from '../../src/core/version';
import {
  BACKUP_SET_NAME_NOTE,
  BackupError,
  extractBackupSet,
  inspectDatabase,
  NEWER_BACKUP,
  openBackupSet,
  refuseNewer,
  removeStaleBackupTemps,
  writeBackupSet,
  type BackupManifest,
} from '../../src/runtime/node/backupSet';
import { openNodeStack, type NodeStack } from '../../src/runtime/node/stack';
import { extractTarItem, listTar, readTarItem, TarError, writeTar } from '../../src/runtime/node/tar';
import { SPACE_MIGRATIONS } from '../../src/space/schema';
import { createLegacyDb } from '../fixtures/legacyV1';
import { rawTar, type RawEntry } from '../support/rawTar';
import { ROOT, tsxCommand, tsxEnv } from '../tsxNode';

const posix = process.platform !== 'win32';
const SETUP_CODE = 'backup-test-code';
const PASSWORD = 'correct horse battery';
const DAY = 86_400_000;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-backupset-'));
  dirs.push(dir);
  return dir;
}

function config(dataDir: string, o: Partial<Config> = {}): Config {
  return loadConfig({ dbPath: path.join(dataDir, 'lyren.db'), webDir: null, setupToken: SETUP_CODE, logRequests: false, ...o });
}

const json = (cookie: string | null, body?: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { [CSRF_HEADER]: '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

/**
 * A stack on disk with an owner and three spaces besides the owner's: one deleted within its grace
 * period (in the set), one past it (not in the set), and one with a task.
 */
async function populated(dataDir = tempDir()) {
  const cfg = config(dataDir);
  const stack = openNodeStack(cfg, { mode: 'maintenance' });
  const res = await stack.app.request(
    '/api/auth/setup',
    json(null, { email: 'owner@example.com', displayName: 'Owner', password: PASSWORD, setupCode: SETUP_CODE }),
  );
  expect(res.status).toBe(201);
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]!).join('; ');
  const status = (await (await stack.app.request('/api/auth/status', { headers: { Cookie: cookie } })).json()) as AuthStatusDTO;
  const create = async (name: string) => ((await (await stack.app.request('/api/spaces', json(cookie, { name }))).json()) as { id: string }).id;
  const own = status.spaces[0]!.id;
  const team = await create('Team space');
  const deleted = await create('Deleted lately');
  const purged = await create('Deleted long ago');
  expect((await stack.app.request(`/api/s/${team}/projects`, json(cookie, { name: 'Team', key: 'TEAM' }))).status).toBe(201);
  const now = Date.now();
  const at = (ms: number) => new Date(ms).toISOString();
  const dir = stack.directoryDb;
  dir.run('UPDATE spaces SET deleted_at = :d, purge_after = :p WHERE public_id = :id', { id: deleted, d: at(now - DAY), p: at(now + 6 * DAY) });
  dir.run('UPDATE spaces SET deleted_at = :d, purge_after = :p WHERE public_id = :id', { id: purged, d: at(now - 8 * DAY), p: at(now - DAY) });
  return { cfg, stack, cookie, dataDir, spaces: { own, team, deleted, purged } };
}

/** Bearer tokens and counters of every kind the directory snapshot must leave out, and invitations of every state. */
function addSecrets(stack: NodeStack): { tokens: string[] } {
  const db = stack.directoryDb;
  const t = new Date().toISOString();
  const later = new Date(Date.now() + DAY).toISOString();
  const user = db.get<{ id: number }>('SELECT id FROM users ORDER BY id LIMIT 1')!.id;
  const space = db.get<{ id: number }>('SELECT id FROM spaces ORDER BY id LIMIT 1')!.id;
  const tokens = ['email-token', 'open-invitation', 'challenge'].map((s) => sha256Hex(s));
  db.run(
    `INSERT INTO email_tokens (token_hash, purpose, user_id, email, email_key, auth_epoch, created_at, expires_at)
     VALUES (:h, 'verify_email', :user, 'owner@example.com', 'owner@example.com', 0, :t, :later)`,
    { h: tokens[0]!, user, t, later },
  );
  const invite = (hash: string, email: string, extra: string) =>
    db.run(
      `INSERT INTO invitations (token_hash, space_id, email, email_key, role, invited_by, delivery, created_at, expires_at, last_sent_at,
         accepted_at, revoked_at)
       VALUES (:hash, :space, :email, :email, 'member', :user, 'link', :t, :later, :t, ${extra})`,
      { hash, space, email, user, t, later },
    );
  invite(tokens[1]!, 'open@example.com', 'NULL, NULL');
  invite(sha256Hex('accepted'), 'accepted@example.com', ':t, NULL');
  invite(sha256Hex('revoked'), 'revoked@example.com', 'NULL, :t');
  db.run(
    `INSERT INTO webauthn_challenges (ceremony_hash, challenge, purpose, user_id, created_at, expires_at)
     VALUES (:h, 'challenge', 'register', :user, :t, :later)`,
    { h: tokens[2]!, user, t, later },
  );
  db.run("INSERT INTO auth_throttle (key, window_start, count) VALUES ('li:192.0.2.1', :t, 5)", { t });
  tokens.push(db.get<{ h: string }>('SELECT token_hash AS h FROM sessions LIMIT 1')!.h);
  tokens.push(db.get<{ h: string }>('SELECT token_hash AS h FROM device_tokens LIMIT 1')!.h);
  return { tokens };
}

function writeSet(stack: NodeStack, cfg: Config, target: string, nowMs = Date.now()): BackupManifest {
  return writeBackupSet({ directoryDb: stack.directoryDb, store: stack.spaces, dataDir: path.dirname(cfg.dbPath), target, nowMs });
}

const count = (file: string, sql: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Number((db.prepare(sql).get() as { n: number }).n);
  } finally {
    db.close();
  }
};

describe('the tar writer and reader', () => {
  it('round-trips files, data and folders, with ustar headers the backup format fixes', () => {
    const dir = tempDir();
    const big = path.join(dir, 'big.bin');
    const content = new Uint8Array(1_500_000).map((_, i) => i % 251);
    fs.writeFileSync(big, content);
    const tar = path.join(dir, 'out.tar');
    const mtime = new Date('2026-10-17T12:00:00.000Z');
    const entries = [{ name: 'a.json', data: new TextEncoder().encode('{"x":1}') }, { name: 'sub' }, { name: 'sub/big.bin', file: big }];
    const size = writeTar(tar, entries, { mtime });
    expect(fs.statSync(tar).size).toBe(size);
    const items = listTar(tar, { maxEntries: 10 });
    expect(items.map((i) => [i.name, i.type, i.size])).toEqual([
      ['a.json', 'file', 7],
      ['sub', 'dir', 0],
      ['sub/big.bin', 'file', 1_500_000],
    ]);
    expect(new TextDecoder().decode(readTarItem(tar, items[0]!))).toBe('{"x":1}');
    extractTarItem(tar, items[2]!, path.join(dir, 'copy.bin'));
    expect(fs.readFileSync(path.join(dir, 'copy.bin')).equals(Buffer.from(content))).toBe(true);
    const bytes = fs.readFileSync(tar);
    const headerOf = (offset: number) => ({
      mode: bytes.subarray(offset + 100, offset + 107).toString(),
      uid: bytes.subarray(offset + 108, offset + 115).toString(),
      gid: bytes.subarray(offset + 116, offset + 123).toString(),
      mtime: parseInt(bytes.subarray(offset + 136, offset + 147).toString(), 8),
      type: String.fromCharCode(bytes[offset + 156]!),
      magic: bytes.subarray(offset + 257, offset + 265).toString('latin1'),
    });
    const common = { uid: '0000000', gid: '0000000', mtime: mtime.getTime() / 1000, magic: 'ustar\u000000' };
    expect(headerOf(0)).toEqual({ ...common, mode: '0000600', type: '0' });
    expect(headerOf(1024)).toEqual({ ...common, mode: '0000700', type: '5' });
    // An existing target is refused, and a name the format cannot hold.
    expect(() => writeTar(tar, [], { mtime })).toThrow(/EEXIST/);
    expect(() => writeTar(path.join(dir, 'x.tar'), [{ name: '../x', data: new Uint8Array() }], { mtime })).toThrow(/Not a name/);
    expect(fs.existsSync(path.join(dir, 'x.tar'))).toBe(false);
  });

  it.runIf(posix)('extracts owner-only files', () => {
    const dir = tempDir();
    const tar = path.join(dir, 'out.tar');
    writeTar(tar, [{ name: 'f', data: new Uint8Array([1]) }], { mtime: new Date() });
    expect(fs.statSync(tar).mode & 0o777).toBe(0o600);
    extractTarItem(tar, listTar(tar, { maxEntries: 1 })[0]!, path.join(dir, 'f'));
    expect(fs.statSync(path.join(dir, 'f')).mode & 0o777).toBe(0o600);
  });
});

describe('the strict tar reader', () => {
  const list = (bytes: Buffer) => {
    const file = path.join(tempDir(), 'x.tar');
    fs.writeFileSync(file, bytes);
    return listTar(file, { maxEntries: 5, maxBytes: (name) => (name === 'small' ? 10 : 1_000_000) });
  };
  const one = new Uint8Array([1, 2, 3]);

  it('accepts what it should', () => {
    expect(list(rawTar([{ name: 'a', data: one }, { name: 'dir/', type: '5' }, { name: 'dir/b', data: one }])).map((i) => i.name)).toEqual([
      'a',
      'dir',
      'dir/b',
    ]);
  });

  it.each<[string, Buffer, RegExp]>([
    ['an absolute path', rawTar([{ name: '/etc/passwd', data: one }]), /name that is not allowed/],
    ['a .. segment', rawTar([{ name: 'spaces/../../x', data: one }]), /name that is not allowed/],
    ['a . segment', rawTar([{ name: './a', data: one }]), /name that is not allowed/],
    ['a backslash', rawTar([{ name: 'a\\..\\b', data: one }]), /name that is not allowed/],
    ['a .. segment through the prefix field', rawTar([{ name: 'x', prefix: '..', data: one }]), /name that is not allowed/],
    ['a hard link', rawTar([{ name: 'a', type: '1' }]), /other than files and folders/],
    ['a symlink', rawTar([{ name: 'a', type: '2' }]), /other than files and folders/],
    ['a character device', rawTar([{ name: 'a', type: '3' }]), /other than files and folders/],
    ['a FIFO', rawTar([{ name: 'a', type: '6' }]), /other than files and folders/],
    ['a pax header', rawTar([{ name: 'a', type: 'x', data: one }]), /other than files and folders/],
    ['a GNU long name', rawTar([{ name: '././@LongLink', type: 'L', data: one }]), /other than files and folders/],
    ['the same name twice', rawTar([{ name: 'a', data: one }, { name: 'a', data: one }]), /holds a twice/],
    ['a wrong checksum', rawTar([{ name: 'a', data: one, corrupt: (b) => (b[0] = 'b'.charCodeAt(0)) }]), /wrong checksum/],
    ['another format', rawTar([{ name: 'a', data: one, magic: 'ustar  \0' }]), /not in the ustar format/],
    ['a size that is not octal', rawTar([{ name: 'a', data: one, sizeText: '0000000008\0' }]), /not a plain octal number/],
    ['a size in base-256', rawTar([{ name: 'a', data: one, sizeText: '\x80\0\0\0\0\0\0\0\0\0\0\x03' }]), /not a plain octal number/],
    ['a size over the bound', rawTar([{ name: 'small', data: new Uint8Array(11) }]), /too large/],
    ['an entry cut short', rawTar([{ name: 'a', data: one, size: 4096 }]), /truncated/],
    ['no end', rawTar([{ name: 'a', data: one }], { end: false }), /truncated/],
    ['data after the end', rawTar([{ name: 'a', data: one }], { trailing: new Uint8Array(512).fill(7) }), /data after its end/],
    ['too many entries', rawTar(['a', 'b', 'c', 'd', 'e', 'f'].map((name) => ({ name, data: one }))), /too many entries/],
  ])('refuses %s', (_, bytes, message) => {
    expect(() => list(bytes)).toThrow(TarError);
    expect(() => list(bytes)).toThrow(message);
  });

  it('refuses a file whose length is not whole blocks', () => {
    expect(() => list(rawTar([{ name: 'a', data: one }]).subarray(0, 1000))).toThrow(/truncated/);
  });
});

// ---------------------------------------------------------------------------
// Backup sets
// ---------------------------------------------------------------------------

describe('a backup set', () => {
  it('holds the manifest, the stripped directory and every space the directory lists, safe to restore', async () => {
    const { cfg, stack, spaces } = await populated();
    try {
      const { tokens } = addSecrets(stack);
      const target = path.join(tempDir(), 'set.tar');
      // Now: the spaces' grace periods were set relative to the clock (populated), and decide what the set holds.
      const nowMs = Date.now();
      const manifest = writeSet(stack, cfg, target, nowMs);
      const inSet = [spaces.own, spaces.team, spaces.deleted];
      expect(manifest).toEqual({
        format: 'lyren-plan-backup',
        formatVersion: 1,
        createdAt: new Date(nowMs).toISOString(),
        appVersion: APP_VERSION,
        directory: { file: 'directory.db', schemaVersion: 1 },
        spaces: inSet.map((id, i) => ({
          id,
          name: ["Owner's space", 'Team space', 'Deleted lately'][i],
          file: `spaces/${id}.db`,
          schemaVersion: SPACE_MIGRATIONS.migrations.length,
          bytes: expect.any(Number),
        })),
      });
      const set = openBackupSet(target);
      expect(set.manifest).toEqual(manifest);
      expect(listTar(target, { maxEntries: 10 }).map((i) => i.name)).toEqual([
        'lyren-backup.json',
        'directory.db',
        'spaces',
        ...inSet.map((id) => `spaces/${id}.db`),
      ]);
      for (const space of manifest.spaces) expect(set.spaces.get(space.id)!.size).toBe(space.bytes);

      const out = path.join(tempDir(), 'out');
      const extracted = extractBackupSet(set, out);
      expect(extracted.directory).toMatchObject({ kind: 'directory', version: 1, newer: false });
      expect(extracted.spaces.map((s) => [s.id, s.info.kind, s.info.spaceId])).toEqual(inSet.map((id) => [id, 'space', id]));
      const directory = path.join(out, 'directory.db');
      for (const table of ['sessions', 'device_tokens', 'webauthn_challenges', 'email_tokens', 'auth_throttle']) {
        expect(count(directory, `SELECT COUNT(*) AS n FROM ${table}`), table).toBe(0);
      }
      const invitations = new DatabaseSync(directory, { readOnly: true });
      expect(invitations.prepare('SELECT email FROM invitations ORDER BY email').all().map((r) => r.email)).toEqual([
        'accepted@example.com',
        'revoked@example.com',
      ]);
      expect((invitations.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('delete');
      invitations.close();
      // secure_delete: the removed tokens are not left in the file's free pages.
      const raw = fs.readFileSync(directory).toString('latin1');
      for (const token of tokens) expect(raw.includes(token), token).toBe(false);
      expect(count(path.join(out, 'spaces', `${spaces.team}.db`), "SELECT COUNT(*) AS n FROM projects WHERE key = 'TEAM'")).toBe(1);
      // The live directory keeps all of it.
      expect(stack.directoryDb.get<{ n: number }>('SELECT COUNT(*) AS n FROM invitations')!.n).toBe(3);
      expect(stack.directoryDb.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')!.n).toBe(1);
      // Nothing is left behind next to the data or the target.
      expect(fs.readdirSync(path.dirname(cfg.dbPath)).filter((n) => n.startsWith('.backup-'))).toEqual([]);
      expect(fs.readdirSync(path.dirname(target))).toEqual(['set.tar']);
    } finally {
      stack.close();
    }
  });

  it.runIf(posix)('is owner-only, and so is a folder it makes', async () => {
    const { cfg, stack } = await populated();
    try {
      const target = path.join(tempDir(), 'new', 'nested', 'set.tar');
      writeSet(stack, cfg, target);
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(target)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.dirname(path.dirname(target))).mode & 0o777).toBe(0o700);
      const out = path.join(tempDir(), 'out');
      extractBackupSet(openBackupSet(target), out);
      expect(fs.statSync(path.join(out, 'spaces')).mode & 0o777).toBe(0o700);
      for (const name of fs.readdirSync(path.join(out, 'spaces'))) expect(fs.statSync(path.join(out, 'spaces', name)).mode & 0o777).toBe(0o600);
    } finally {
      stack.close();
    }
  });

  it('fails, naming the space, when a space the directory lists has no file; nothing is left behind', async () => {
    const { cfg, stack, spaces } = await populated();
    try {
      stack.spaces.closeAll();
      const file = path.join(path.dirname(cfg.dbPath), 'spaces', `${spaces.team}.db`);
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
      const target = path.join(tempDir(), 'set.tar');
      expect(() => writeSet(stack, cfg, target)).toThrow(new BackupError(`The data of space ${spaces.team} (Team space) is missing: ${file}`));
      expect(fs.readdirSync(path.dirname(target))).toEqual([]);
      expect(fs.readdirSync(path.dirname(cfg.dbPath)).filter((n) => n.startsWith('.backup-'))).toEqual([]);
      // An empty file (an init that was interrupted) is no data either.
      fs.writeFileSync(file, '');
      expect(() => writeSet(stack, cfg, target)).toThrow(/is missing/);
    } finally {
      stack.close();
    }
  });

  it('refuses an existing target, and a leftover <target>.partial it did not write', async () => {
    const { cfg, stack } = await populated();
    try {
      const dir = tempDir();
      fs.writeFileSync(path.join(dir, 'taken.tar'), 'mine');
      const taken = path.join(dir, 'taken.tar');
      expect(() => writeSet(stack, cfg, taken)).toThrow(new BackupError(`${taken} already exists; choose a new file name.`));
      fs.writeFileSync(path.join(dir, 'b.tar.partial'), 'mine too');
      expect(() => writeSet(stack, cfg, path.join(dir, 'b.tar'))).toThrow(/b\.tar\.partial already exists/);
      expect(fs.readFileSync(path.join(dir, 'taken.tar'), 'utf8')).toBe('mine');
      expect(fs.readFileSync(path.join(dir, 'b.tar.partial'), 'utf8')).toBe('mine too');
    } finally {
      stack.close();
    }
  });

  it('taken while another thread writes, holds consistent snapshots of each database', async () => {
    const { cfg, stack, spaces } = await populated();
    const spaceFile = path.join(path.dirname(cfg.dbPath), 'spaces', `${spaces.team}.db`);
    const stop = new Int32Array(new SharedArrayBuffer(4));
    // Each transaction writes two rows into the space and two into the directory: a consistent snapshot holds an even number.
    const worker = new Worker(
      `const { workerData } = require('node:worker_threads');
       const { DatabaseSync } = require('node:sqlite');
       const open = (file) => { const db = new DatabaseSync(file); db.exec('PRAGMA busy_timeout = 10000'); return db; };
       const space = open(workerData.space), directory = open(workerData.directory);
       const t = new Date().toISOString();
       let n = 0;
       while (Atomics.load(workerData.stop, 0) === 0) {
         n++;
         space.exec('BEGIN IMMEDIATE');
         const tag = space.prepare('INSERT INTO tags (name, name_fold, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
         for (const s of ['a', 'b']) tag.run(s + n, s + n, '#000000', t, t);
         space.exec('COMMIT');
         directory.exec('BEGIN IMMEDIATE');
         for (let i = 0; i < 2; i++) directory.prepare("INSERT INTO security_events (type, data, created_at) VALUES ('test_pair', '{}', ?)").run(t);
         directory.exec('COMMIT');
       }
       space.close(); directory.close();`,
      { eval: true, workerData: { space: spaceFile, directory: cfg.dbPath, stop } },
    );
    try {
      // Let the writer get going, then take several sets while it runs.
      while (count(cfg.dbPath, "SELECT COUNT(*) AS n FROM security_events WHERE type = 'test_pair'") < 20) await new Promise((r) => setTimeout(r, 5));
      const seen: number[] = [];
      for (let i = 0; i < 5; i++) {
        const target = path.join(tempDir(), 'set.tar');
        writeSet(stack, cfg, target);
        const out = path.join(tempDir(), 'out');
        extractBackupSet(openBackupSet(target), out);
        const tags = count(path.join(out, 'spaces', `${spaces.team}.db`), 'SELECT COUNT(*) AS n FROM tags');
        const events = count(path.join(out, 'directory.db'), "SELECT COUNT(*) AS n FROM security_events WHERE type = 'test_pair'");
        expect(tags % 2).toBe(0);
        expect(events % 2).toBe(0);
        for (const file of [path.join(out, 'directory.db'), path.join(out, 'spaces', `${spaces.team}.db`)]) {
          const db = new DatabaseSync(file, { readOnly: true });
          expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
          db.close();
        }
        seen.push(tags);
        await new Promise((r) => setTimeout(r, 10));
      }
      // The writer really ran meanwhile.
      expect(seen.at(-1)!).toBeGreaterThan(seen[0]!);
    } finally {
      Atomics.store(stop, 0, 1);
      await new Promise((resolve) => worker.once('exit', resolve));
      stack.close();
    }
  });

  it('removeStaleBackupTemps also removes an interrupted download (.backup-<hex>.tar.partial)', () => {
    const dir = tempDir();
    const names = ['.backup-0123456789abcdef.tar.partial', '.backup-0123456789abcdef.tar', 'keep.tar.partial'];
    for (const n of names) fs.writeFileSync(path.join(dir, n), 'x');
    fs.mkdirSync(path.join(dir, '.backup-0123456789abcdef'));
    removeStaleBackupTemps(dir);
    expect(fs.readdirSync(dir)).toEqual(['keep.tar.partial']);
  });
});

describe('reading a backup set refuses foreign and malicious archives', () => {
  /** A real set to tamper with, and its parts. */
  async function realSet() {
    const { cfg, stack, spaces } = await populated();
    try {
      const target = path.join(tempDir(), 'set.tar');
      const manifest = writeSet(stack, cfg, target);
      const items = listTar(target, { maxEntries: 10 });
      const part = (name: string) => readTarItem(target, items.find((i) => i.name === name)!);
      return { manifest, spaces, target, part };
    } finally {
      stack.close();
    }
  }

  const openBytes = (bytes: Uint8Array) => {
    const file = path.join(tempDir(), 'x.tar');
    fs.writeFileSync(file, bytes);
    return openBackupSet(file);
  };
  const manifestEntry = (m: unknown): RawEntry => ({ name: 'lyren-backup.json', data: new TextEncoder().encode(JSON.stringify(m)) });

  it('a file that is not a set', async () => {
    const dir = tempDir();
    const sqlite = path.join(dir, 'lyren.db');
    await createLegacyDb(sqlite);
    for (const file of [sqlite, path.join(dir, 'empty.tar')]) {
      if (!fs.existsSync(file)) fs.writeFileSync(file, '');
      expect(() => openBackupSet(file)).toThrow(/^This is not a Lyren Plan backup set: /);
    }
    // Another program's tar.
    const other = path.join(dir, 'other.tar');
    writeTar(other, [{ name: 'README', data: new TextEncoder().encode('hi') }], { mtime: new Date() });
    expect(() => openBackupSet(other)).toThrow('This is not a Lyren Plan backup set: it does not start with lyren-backup.json');
  });

  it('manifests that are not ours, not valid, or from a newer format', async () => {
    const { manifest } = await realSet();
    expect(() => openBytes(rawTar([{ name: 'lyren-backup.json', data: new TextEncoder().encode('not json') }]))).toThrow(/is not JSON/);
    expect(() => openBytes(rawTar([manifestEntry({ ...manifest, format: 'other' })]))).toThrow(/not a Lyren Plan manifest/);
    expect(() => openBytes(rawTar([manifestEntry({ ...manifest, formatVersion: 2 })]))).toThrow(new BackupError(NEWER_BACKUP));
    expect(() => openBytes(rawTar([manifestEntry({ ...manifest, extra: 1 })]))).toThrow(/is not valid/);
    const badFile = { ...manifest, spaces: [{ ...manifest.spaces[0]!, file: '../x.db' }] };
    expect(() => openBytes(rawTar([manifestEntry(badFile)]))).toThrow(/spaces\/<id>\.db/);
  });

  it('entries the manifest does not name, missing ones, wrong sizes, and files that are not databases', async () => {
    const { manifest, part } = await realSet();
    const entries = (): RawEntry[] => [
      manifestEntry(manifest),
      { name: 'directory.db', data: part('directory.db') },
      { name: 'spaces/', type: '5' },
      ...manifest.spaces.map((s) => ({ name: s.file, data: part(s.file) })),
    ];
    expect(openBytes(rawTar(entries())).manifest).toEqual(manifest);
    const evil = { name: 'evil.sh', data: new Uint8Array([1]) };
    expect(() => openBytes(rawTar([...entries(), evil]))).toThrow(/holds evil\.sh, which its manifest does not name/);
    expect(() => openBytes(rawTar([...entries(), { name: 'spaces/zzzzzzzzzzzzzzzz.db', data: part('directory.db') }]))).toThrow(/does not name/);
    const second = manifest.spaces[1]!.file;
    expect(() => openBytes(rawTar(entries().filter((e) => e.name !== second)))).toThrow(new RegExp(`${second} is missing`));
    expect(() => openBytes(rawTar(entries().filter((e) => e.name !== 'spaces/')))).toThrow(/spaces is missing/);
    const resized = { ...manifest, spaces: manifest.spaces.map((s, i) => (i === 0 ? { ...s, bytes: s.bytes + 512 } : s)) };
    expect(() => openBytes(rawTar([manifestEntry(resized), ...entries().slice(1)]))).toThrow(/does not have the size its manifest gives/);
    const notSqlite = entries().map((e) => (e.name === 'directory.db' ? { ...e, data: new Uint8Array(4096) } : e));
    expect(() => openBytes(rawTar(notSqlite))).toThrow(/directory\.db is not an SQLite database/);
    // The manifest must come first, and a link where a database belongs is no database.
    expect(() => openBytes(rawTar([...entries().slice(1), entries()[0]!]))).toThrow(/does not start with lyren-backup\.json/);
    expect(() => openBytes(rawTar([entries()[0]!, { name: 'directory.db', type: '2' }]))).toThrow(/other than files and folders/);
  });

  it('extracting checks each database: its kind, its space, and the versions of §9.6 step 2', async () => {
    const { manifest, part } = await realSet();
    const [first, second] = manifest.spaces;
    const build = (replace: Record<string, Uint8Array>) =>
      openBytes(
        rawTar([
          manifestEntry({ ...manifest, spaces: manifest.spaces.map((s) => ({ ...s, bytes: (replace[s.file] ?? part(s.file)).length })) }),
          { name: 'directory.db', data: replace['directory.db'] ?? part('directory.db') },
          { name: 'spaces/', type: '5' },
          ...manifest.spaces.map((s) => ({ name: s.file, data: replace[s.file] ?? part(s.file) })),
        ]),
      );
    const extract = (set: ReturnType<typeof openBackupSet>) => extractBackupSet(set, path.join(tempDir(), 'out'));
    expect(() => extract(build({ 'directory.db': part(first!.file) }))).toThrow(/directory\.db is not a directory database/);
    expect(() => extract(build({ [first!.file]: part(second!.file) }))).toThrow(new RegExp(`is not the database of space ${first!.id}`));

    // A directory from a newer build that this one cannot use.
    const newer = (data: Uint8Array, version: string, compatibleFrom: string) => {
      const file = path.join(tempDir(), 'db');
      fs.writeFileSync(file, data);
      const db = new DatabaseSync(file);
      db.exec(`UPDATE _meta SET value = '${version}' WHERE key = 'version';
        UPDATE _meta SET value = '${compatibleFrom}' WHERE key = 'compatible_from'`);
      db.close();
      return new Uint8Array(fs.readFileSync(file));
    };
    expect(() => extract(build({ 'directory.db': newer(part('directory.db'), '9', '9') }))).toThrow(new BackupError(NEWER_BACKUP));
    expect(() => extract(build({ [second!.file]: newer(part(second!.file), '9', '5') }))).toThrow(new BackupError(NEWER_BACKUP));
    // Newer but additive (compatible_from within this build): usable, as migrate allows (§3.7).
    expect(extract(build({ 'directory.db': newer(part('directory.db'), '9', '1') })).directory).toMatchObject({ version: 9, newer: false });
  });
});

describe('inspectDatabase and refuseNewer (§9.6 step 2)', () => {
  it('tells directories, spaces, 1.x databases and everything else apart', async () => {
    const { cfg, stack, spaces } = await populated();
    stack.close();
    expect(inspectDatabase(cfg.dbPath)).toEqual({ kind: 'directory', version: 1, compatibleFrom: 1, spaceId: null, newer: false });
    expect(inspectDatabase(path.join(path.dirname(cfg.dbPath), 'spaces', `${spaces.team}.db`))).toEqual({
      kind: 'space',
      version: SPACE_MIGRATIONS.migrations.length,
      compatibleFrom: 1,
      spaceId: spaces.team,
      newer: false,
    });
    const dir = tempDir();
    const legacy = path.join(dir, 'legacy.db');
    await createLegacyDb(legacy);
    expect(inspectDatabase(legacy)).toEqual({ kind: 'legacy', version: 1, compatibleFrom: 1, spaceId: null, newer: false });
    const db = new DatabaseSync(legacy);
    db.exec('PRAGMA user_version = 2');
    db.close();
    const newer = inspectDatabase(legacy);
    expect(newer).toMatchObject({ kind: 'legacy', version: 2, newer: true });
    expect(() => refuseNewer(newer)).toThrow(new BackupError(NEWER_BACKUP));
    for (const [name, content] of [
      ['text', 'just text'],
      ['empty', ''],
      ['fake', 'SQLite format 3\0 but no database'],
    ] as const) {
      fs.writeFileSync(path.join(dir, name), content);
      expect(inspectDatabase(path.join(dir, name)).kind, name).toBeNull();
    }
    const other = new DatabaseSync(path.join(dir, 'other.db'));
    other.exec("CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO _meta VALUES ('schema', 'something else'), ('version', '1')");
    other.close();
    expect(inspectDatabase(path.join(dir, 'other.db')).kind).toBeNull();
  });
});

describe('the admin download and the CLI write the same sets', () => {
  it('GET /api/admin/backup streams a backup set', async () => {
    const { stack, cookie, spaces } = await populated();
    try {
      const res = await stack.app.request('/api/admin/backup', { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
      const file = path.join(tempDir(), 'download.tar');
      fs.writeFileSync(file, new Uint8Array(await res.arrayBuffer()));
      const set = openBackupSet(file);
      expect(set.manifest.spaces.map((s) => s.id)).toEqual([spaces.own, spaces.team, spaces.deleted]);
      expect(res.headers.get('content-disposition')).toBe(`attachment; filename="lyren-backup-${new Date().toISOString().slice(0, 10)}.tar"`);
    } finally {
      stack.close();
    }
  });

  it('`backup <file>` writes one while the server runs; a .db name gets a note; a missing space fails it (exit 1)', async () => {
    const { cfg, stack, spaces, dataDir, cookie } = await populated();
    const cli = (args: string[]) => {
      const res = spawnSync(...tsxCommand('server/src/index.ts', args), {
        cwd: ROOT,
        env: tsxEnv({ ...process.env, DATA_DIR: dataDir, DB_PATH: '' }),
        encoding: 'utf8',
        timeout: 60_000,
      });
      return { status: res.status, stdout: res.stdout, stderr: res.stderr };
    };
    try {
      const out = tempDir();
      const tar = path.join(out, 'nightly.tar');
      const res = cli(['backup', tar]);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout.trim()).toBe(`Backup written to ${tar} (3 spaces)`);
      expect(openBackupSet(tar).manifest.spaces.map((s) => s.id)).toEqual([spaces.own, spaces.team, spaces.deleted]);

      const db = path.join(out, 'nightly.db');
      const named = cli(['backup', db]);
      expect(named.status, named.stderr).toBe(0);
      expect(named.stdout.trim().split('\n')).toEqual([`Backup written to ${db} (3 spaces)`, BACKUP_SET_NAME_NOTE]);
      expect(openBackupSet(db).manifest.format).toBe('lyren-plan-backup');
      // The running "server" still serves, and its data was not changed by the backup.
      expect((await stack.app.request(`/api/s/${spaces.team}/projects`, { headers: { Cookie: cookie } })).status).toBe(200);

      stack.spaces.closeAll();
      fs.rmSync(path.join(path.dirname(cfg.dbPath), 'spaces', `${spaces.deleted}.db`));
      const failed = cli(['backup', path.join(out, 'broken.tar')]);
      expect(failed.status).toBe(1);
      const missing = path.join(path.dirname(cfg.dbPath), 'spaces', `${spaces.deleted}.db`);
      expect(failed.stderr.trim()).toBe(`Backup failed: The data of space ${spaces.deleted} (Deleted lately) is missing: ${missing}`);
      expect(fs.readdirSync(out).sort()).toEqual(['nightly.db', 'nightly.tar']);
    } finally {
      stack.close();
    }
  }, 120_000);
});
