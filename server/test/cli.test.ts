// The maintenance CLI (server/src/index.ts), run as a child process from source.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/constants';
import { hashPassword, verifyPassword } from '../src/auth/passwords';
import { BACKUP_TEMP_RE, NotUtf8Error, notUtf8Message, parsePipedPassword, removeStaleBackupTemps } from '../src/cli';
import { openDb } from '../src/db';
import { ROOT, tsxCommand, tsxEnv } from './tsxNode';

const posix = process.platform !== 'win32';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

async function dataDirWithOwner(password = 'original-password') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-cli-'));
  dirs.push(dir);
  const db = openDb(path.join(dir, 'data', 'lyren.db'));
  const t = new Date().toISOString();
  db.run(
    `INSERT INTO users (username, display_name, password_hash, created_at, updated_at)
     VALUES ('owner', 'Owner', :hash, :t, :t)`,
    { hash: await hashPassword(password), t },
  );
  db.close();
  return { dir, dataDir: path.join(dir, 'data') };
}

function cli(dataDir: string, args: string[], input?: string | Buffer, env: Record<string, string> = {}) {
  const res = spawnSync(...tsxCommand('server/src/index.ts', args), {
    cwd: ROOT,
    input: input ?? '',
    env: tsxEnv({ ...process.env, DATA_DIR: dataDir, DB_PATH: '', ...env }),
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function passwordHash(dataDir: string): string {
  const db = openDb(path.join(dataDir, 'lyren.db'));
  try {
    return db.get<{ password_hash: string }>("SELECT password_hash FROM users WHERE username = 'owner'")!.password_hash;
  } finally {
    db.close();
  }
}

describe('reset-password', () => {
  it('refuses passwords the login form would reject, and changes nothing', async () => {
    const { dataDir } = await dataDirWithOwner();
    const before = passwordHash(dataDir);
    for (const pw of ['p'.repeat(LIMITS.passwordMax + 1), 'short']) {
      const res = cli(dataDir, ['reset-password', 'owner'], `${pw}\n`);
      expect(res.status, res.stderr).toBe(2);
      expect(res.stderr).toMatch(new RegExp(`Password must be ${LIMITS.passwordMin} to ${LIMITS.passwordMax} characters`));
      expect(res.stdout).not.toMatch(/Password updated/);
    }
    expect(passwordHash(dataDir)).toBe(before);
    expect(await verifyPassword('original-password', passwordHash(dataDir))).toBe(true);
  });

  it('accepts a password of the maximum length (one trailing newline stripped)', async () => {
    const { dataDir } = await dataDirWithOwner();
    const pw = 'p'.repeat(LIMITS.passwordMax);
    const res = cli(dataDir, ['reset-password', 'owner'], `${pw}\n`);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/Password updated for owner/);
    expect(await verifyPassword(pw, passwordHash(dataDir))).toBe(true);
  });
});

describe('piped passwords and Windows line endings', () => {
  it('strips one trailing LF or CRLF and a byte-order mark, nothing else', () => {
    expect(parsePipedPassword('secret pass\n')).toBe('secret pass');
    expect(parsePipedPassword('secret pass\r\n')).toBe('secret pass');
    expect(parsePipedPassword(Buffer.from('\uFEFFsecret pass\r\n', 'utf8'))).toBe('secret pass');
    expect(parsePipedPassword('secret pass')).toBe('secret pass');
    expect(parsePipedPassword('  spaced  \n\n')).toBe('  spaced  \n');
    expect(parsePipedPassword(Buffer.from('\uFEFFPässwort-1é\r\n', 'utf8'))).toBe('Pässwort-1é');
  });

  it('refuses bytes that are not UTF-8 (Command Prompt pipes in the console code page)', () => {
    // "Päs\r\n" as cmd.exe's echo writes it in code page 437 (ä = 0x84).
    expect(() => parsePipedPassword(Buffer.from([0x50, 0x84, 0x73, 0x0d, 0x0a]))).toThrow(NotUtf8Error);
    expect(() => parsePipedPassword(Buffer.from('P\xe4ss\n', 'latin1'))).toThrow(NotUtf8Error);
    expect(notUtf8Message('win32').join('\n')).toContain('chcp 65001');
    expect(notUtf8Message('linux').join('\n')).not.toContain('chcp');
  });

  it('reset-password with a non-UTF-8 password changes nothing (exit 2)', async () => {
    const { dataDir } = await dataDirWithOwner();
    const before = passwordHash(dataDir);
    const res = cli(dataDir, ['reset-password', 'owner'], Buffer.from([0x50, 0x84, 0x73, 0x73, 0x77, 0x6f, 0x72, 0x74, 0x2d, 0x31, 0x82, 0x0d, 0x0a]));
    expect(res.status, res.stderr).toBe(2);
    expect(res.stderr).toContain('The piped password is not UTF-8 text');
    expect(res.stdout).not.toMatch(/Password updated/);
    expect(passwordHash(dataDir)).toBe(before);
  });

  it('reset-password accepts a CRLF-terminated password (cmd / PowerShell)', async () => {
    const { dataDir } = await dataDirWithOwner();
    const res = cli(dataDir, ['reset-password', 'owner'], 'windows pass 1\r\n');
    expect(res.status, res.stderr).toBe(0);
    expect(await verifyPassword('windows pass 1', passwordHash(dataDir))).toBe(true);
  });
});

describe('stale backup-download copies', () => {
  it('only the server\'s own temporary files are removed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-stale-'));
    dirs.push(dir);
    const ours = ['.backup-0123456789abcdef.db', '.backup-0123456789abcdef.db-journal'];
    const theirs = ['.backup-mine.db', 'backup-0123456789abcdef.db', 'lyren.db'];
    for (const n of [...ours, ...theirs]) fs.writeFileSync(path.join(dir, n), 'x');
    for (const n of ours) expect(BACKUP_TEMP_RE.test(n), n).toBe(true);
    // An upper-case look-alike is not ours either. Checked on the pattern only: on a case-insensitive
    // file system (Windows, macOS) it would be the same file as ours[0].
    expect(BACKUP_TEMP_RE.test('.backup-0123456789ABCDEF.db')).toBe(false);
    removeStaleBackupTemps(dir);
    expect(fs.readdirSync(dir).sort()).toEqual([...theirs].sort());
    removeStaleBackupTemps(path.join(dir, 'missing')); // no throw
  });
});

describe.runIf(posix)('file permissions', () => {
  it('creates database directories owner-only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-perm-'));
    dirs.push(dir);
    const db = openDb(path.join(dir, 'fresh', 'lyren.db'));
    db.backupTo(path.join(dir, 'fresh', 'backups', 'snap.db'));
    db.close();
    expect(fs.statSync(path.join(dir, 'fresh')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, 'fresh', 'backups')).mode & 0o777).toBe(0o700);
  });

  it('the CLI writes files owner-only whatever the umask', async () => {
    const { dir, dataDir } = await dataDirWithOwner();
    const target = path.join(dir, 'out', 'nested', 'backup.db');
    const res = cli(dataDir, ['backup', target]);
    expect(res.status, res.stderr).toBe(0);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(target)).mode & 0o777).toBe(0o700);
  });
});

describe('start-up failures are explained, not dumped as stack traces', () => {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it('names an invalid environment value', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-env-'));
    dirs.push(dir);
    const res = cli(path.join(dir, 'data'), ['serve'], undefined, { PORT: 'eighty' });
    expect(res.status).toBe(2);
    expect(res.stderr.trim()).toBe('Invalid value for PORT: eighty (expected 1..65535)');
    expect(fs.existsSync(path.join(dir, 'data'))).toBe(false);
  });

  it.runIf(posix && !isRoot)('an unwritable data directory (e.g. a root-owned Docker bind mount)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-ro-'));
    dirs.push(dir);
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir, { mode: 0o555 });
    try {
      const res = cli(dataDir, ['serve'], undefined, { PORT: '1' });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(`Could not open the database ${path.join(dataDir, 'lyren.db')}: unable to open database file`);
      expect(res.stderr).toContain(`The directory ${dataDir} and the files in it must be writable`);
      expect(res.stderr).toContain('sudo chown -R 1000:1000');
      expect(res.stderr).not.toMatch(/\n\s+at /); // no stack trace
    } finally {
      fs.chmodSync(dataDir, 0o700);
    }
  });

  it('a port that is already in use', async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address() as net.AddressInfo;
    try {
      const { dataDir } = await dataDirWithOwner();
      const res = cli(dataDir, ['serve'], undefined, { PORT: String(port), HOST: '127.0.0.1' });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(`Port ${port} is already in use on 127.0.0.1`);
      expect(res.stderr).not.toMatch(/\n\s+at /);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});

describe('serve without a built web client', () => {
  it('warns in the log and explains it in the browser instead of a bare 404', async () => {
    const { dir, dataDir } = await dataDirWithOwner();
    const webDir = path.join(dir, 'empty-web');
    fs.mkdirSync(webDir);
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise((resolve) => probe.close(resolve));
    const child = spawn(...tsxCommand('server/src/index.ts', ['serve']), {
      cwd: ROOT,
      env: tsxEnv({ ...process.env, DATA_DIR: dataDir, DB_PATH: '', WEB_DIR: webDir, PORT: String(port), HOST: '127.0.0.1' }),
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    try {
      const deadline = Date.now() + 30_000;
      while (!out.includes('listening on') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      expect(out).toContain('listening on');
      const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { accept: 'text/html' } });
      expect(res.status).toBe(503);
      expect(await res.text()).toContain('web client is missing');
      expect(out).toContain(`Web client not found: no index.html in ${webDir}.`);
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }, 60_000);
});
