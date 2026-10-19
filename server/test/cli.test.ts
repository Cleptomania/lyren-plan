// The maintenance CLI (server/src/index.ts), run as a child process from source; the owner check (§9.2)
// in process, with an injected uid.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER, LIMITS } from '@shared/constants';
import {
  BACKUP_TEMP_RE,
  backup,
  CliExit,
  formatSize,
  NotUtf8Error,
  notUtf8Message,
  parsePipedPassword,
  policy,
  promoteAdmin,
  removeStaleBackupTemps,
  resetPassword,
  restore,
  spaces,
  type MaintenanceContext,
} from '../src/cli';
import { loadConfig } from '../src/config';
import { sha256Hex } from '../src/core/crypto';
import { openDb } from '../src/runtime/node/nodeDb';
import { ownerRefusal } from '../src/runtime/node/owner';
import { DataRefusal, openNodeStack } from '../src/runtime/node/stack';
import { inContainer } from '../src/startupErrors';
import { directoryWithOwner, hashPassword, ownerPasswordHash, verifyPassword } from './support/directoryFile';
import { ROOT, tsxCommand, tsxEnv } from './tsxNode';

const posix = process.platform !== 'win32';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** A data folder whose directory holds one account from before the upgrade, `owner` (§14.3). */
async function dataDirWithOwner(password = 'original-password') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-cli-'));
  dirs.push(dir);
  await directoryWithOwner(path.join(dir, 'data', 'lyren.db'), password);
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

const passwordHash = (dataDir: string): string => ownerPasswordHash(path.join(dataDir, 'lyren.db'));
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

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
    const ours = ['.backup-0123456789abcdef.db', '.backup-0123456789abcdef.db-journal', '.restore-0123456789abcdef.in'];
    const theirs = ['.backup-mine.db', 'backup-0123456789abcdef.db', 'lyren.db'];
    for (const n of [...ours, ...theirs]) fs.writeFileSync(path.join(dir, n), 'x');
    // A restore's unfinished staging folder goes too; a staged restore (.restore-pending) never.
    const staging = '.restore-0123456789abcdef.partial';
    fs.mkdirSync(path.join(dir, staging, 'spaces'), { recursive: true });
    fs.writeFileSync(path.join(dir, staging, 'directory.db'), 'x');
    ours.push(staging);
    for (const pending of ['.restore-pending', '.work.db.restore-pending']) {
      fs.mkdirSync(path.join(dir, pending));
      fs.writeFileSync(path.join(dir, pending, 'READY'), '{}');
      theirs.push(pending);
    }
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
  it('names an invalid environment value', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-env-'));
    dirs.push(dir);
    const res = cli(path.join(dir, 'data'), ['serve'], undefined, { PORT: 'eighty' });
    expect(res.status).toBe(2);
    expect(res.stderr.trim()).toBe('Invalid value for PORT: eighty (expected 1..65535)');
    expect(fs.existsSync(path.join(dir, 'data'))).toBe(false);
  });

  it('names a passkey RP ID that does not fit PUBLIC_URL (design §5.6)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-env-'));
    dirs.push(dir);
    const res = cli(path.join(dir, 'data'), ['serve'], undefined, { PUBLIC_URL: 'https://plan.example.com', WEBAUTHN_RP_ID: 'workers.dev' });
    expect(res.status).toBe(2);
    expect(res.stderr.trim()).toBe(
      "Invalid value for WEBAUTHN_RP_ID: workers.dev (expected PUBLIC_URL's host, plan.example.com, or a parent domain of it with at least two labels, other than workers.dev or pages.dev)",
    );
    expect(fs.existsSync(path.join(dir, 'data'))).toBe(false);
  });

  it.runIf(posix && !isRoot)('an unwritable data directory (e.g. a root-owned Docker bind mount)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-ro-'));
    dirs.push(dir);
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir, { mode: 0o555 });
    try {
      // In the Docker image (LYREN_CONTAINER=1): the bind mount's chown.
      const res = cli(dataDir, ['serve'], undefined, { PORT: '1', LYREN_CONTAINER: '1' });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(`Could not open the database ${path.join(dataDir, 'lyren.db')}: unable to open database file`);
      expect(res.stderr).toContain(`The directory ${dataDir} and the files in it must be writable`);
      expect(res.stderr).toContain('sudo chown -R 1000:1000');
      expect(res.stderr).not.toMatch(/\n\s+at /); // no stack trace
      // Elsewhere (systemd, the release tarball): this user's fix, no Docker.
      if (!inContainer()) {
        const plain = cli(dataDir, ['serve'], undefined, { PORT: '1', LYREN_CONTAINER: '' });
        expect(plain.status).toBe(1);
        expect(plain.stderr).toContain(`Give them to that user (e.g. sudo chown -R ${process.getuid!()} `);
        expect(plain.stderr).not.toContain('Docker');
      }
    } finally {
      fs.chmodSync(dataDir, 0o700);
    }
  });

  it.runIf(posix && !isRoot)('a data directory this user may not create (a missing folder in a root-owned one)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-ro-'));
    dirs.push(dir);
    const parent = path.join(dir, 'ro');
    const dataDir = path.join(parent, 'data');
    fs.mkdirSync(parent, { mode: 0o500 });
    try {
      const res = cli(dataDir, ['serve'], undefined, { PORT: '1', LYREN_CONTAINER: '' });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(`Could not open the database ${path.join(dataDir, 'lyren.db')}: EACCES`);
      if (!inContainer()) {
        expect(res.stderr).toContain(`It does not exist yet, and this user cannot create it in ${parent}.`);
        expect(res.stderr).toContain(`Create it for that user (e.g. sudo install -d -o ${process.getuid!()} -m 700 `);
        expect(res.stderr).not.toContain('chown');
      }
      expect(res.stderr).not.toMatch(/\n\s+at /);
      expect(fs.existsSync(dataDir)).toBe(false);
    } finally {
      fs.chmodSync(parent, 0o700);
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

describe.runIf(posix && !isRoot)("the owner check (§9.2): root on another user's data folder", () => {
  const saved = { DATA_DIR: process.env.DATA_DIR, DB_PATH: process.env.DB_PATH };
  afterEach(() => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** Run a command in this process with DATA_DIR = dataDir; its exit code (0 when it returned) and stderr. */
  async function inProcess(dataDir: string, fn: () => unknown): Promise<{ code: number; stderr: string }> {
    process.env.DATA_DIR = dataDir;
    delete process.env.DB_PATH;
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.join(' ')));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await fn();
      return { code: 0, stderr: errors.join('\n') };
    } catch (err) {
      if (!(err instanceof CliExit)) throw err;
      return { code: err.code, stderr: errors.join('\n') };
    } finally {
      vi.restoreAllMocks();
    }
  }

  it('every command stops before it touches a file (exit 1), naming the owner', async () => {
    const { dir, dataDir } = await dataDirWithOwner();
    const expected = `Run this as the owner of ${dataDir}, for example: sudo -u ${os.userInfo().username} …`;
    const before = sha256Hex(fs.readFileSync(path.join(dataDir, 'lyren.db')).toString('base64'));
    const root: MaintenanceContext = { noDatabaseHint: '', uid: 0 };
    const target = path.join(dir, 'b.tar');
    const source = path.join(dir, 'source.tar');
    fs.writeFileSync(source, 'x');
    for (const [name, run] of [
      ['backup', () => backup(target, root)],
      ['restore', () => restore(source, root)],
      ['reset-password', () => resetPassword('owner', 'a new password 1', root)],
      ['promote-admin', () => promoteAdmin('owner', root)],
      ['policy', () => policy('closed', root)],
      ['spaces', () => spaces(root)],
    ] as const) {
      const res = await inProcess(dataDir, run);
      expect(res, name).toEqual({ code: 1, stderr: expected });
    }
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(dataDir).sort()).toEqual(['lyren.db']);
    expect(sha256Hex(fs.readFileSync(path.join(dataDir, 'lyren.db')).toString('base64'))).toBe(before);
    // The server and the desktop app check it in openNodeStack.
    const config = loadConfig({ dataDir, dbPath: path.join(dataDir, 'lyren.db'), webDir: null });
    expect(() => openNodeStack(config, { mode: 'serve', uid: 0 })).toThrow(new DataRefusal(expected));
    // The owner itself, and Windows (no uid), pass.
    expect((await inProcess(dataDir, () => spaces({ noDatabaseHint: '', uid: process.getuid!() }))).code).toBe(0);
    expect((await inProcess(dataDir, () => spaces({ noDatabaseHint: '', uid: undefined }))).code).toBe(0);
  });

  it('a user without a name is named by number; root\'s own folders and folders not made yet need no check', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-owner-'));
    dirs.push(dir);
    const passwd = path.join(dir, 'passwd');
    fs.writeFileSync(passwd, 'root:x:0:0:root:/root:/bin/sh\nlyren:x:999:999::/nonexistent:/usr/sbin/nologin\n');
    expect(ownerRefusal(dir, { uid: 0, passwdFile: passwd })).toBe(`Run this as the owner of ${dir}, for example: sudo -u #${process.getuid!()} …`);
    fs.writeFileSync(passwd, `lyren:x:${process.getuid!()}:999::/nonexistent:/usr/sbin/nologin\n`);
    expect(ownerRefusal(dir, { uid: 0, passwdFile: passwd })).toBe(`Run this as the owner of ${dir}, for example: sudo -u lyren …`);
    expect(ownerRefusal(path.sep, { uid: 0 })).toBeNull();
    expect(ownerRefusal(path.join(dir, 'not-yet'), { uid: 0 })).toBeNull();
    expect(ownerRefusal(dir, { uid: 1000 })).toBeNull();
    expect(ownerRefusal(dir, { uid: undefined })).toBeNull();
  });
});

/** The administrative security events of a directory file (no actor and no request for the CLI's, §5.8.18). */
function adminEvents(file: string): Array<{ type: string; user_id: number | null; actor_id: number | null; ip: string | null; data: string }> {
  const r = new DatabaseSync(file, { readOnly: true });
  try {
    return r.prepare("SELECT type, user_id, actor_id, ip, data FROM security_events WHERE type LIKE 'admin%' ORDER BY id").all() as never;
  } finally {
    r.close();
  }
}

describe('promote-admin, policy, spaces and help', () => {
  it('promote-admin makes an account an instance admin, by email or username', async () => {
    const { dataDir } = await dataDirWithOwner();
    const file = path.join(dataDir, 'lyren.db');
    const direct = new DatabaseSync(file);
    const t = new Date().toISOString();
    direct
      .prepare(
        `INSERT INTO users (email, email_key, display_name, password_hash, webauthn_user_id, created_at, updated_at)
         VALUES ('Bea@Example.com', 'bea@example.com', 'Bea', ?, 'handle-bea', ?, ?)`,
      )
      .run(await hashPassword('bea password 1'), t, t);
    direct.close();
    const isAdmin = () => {
      const r = new DatabaseSync(file, { readOnly: true });
      try {
        return (r.prepare("SELECT is_instance_admin AS a FROM users WHERE email_key = 'bea@example.com'").get() as { a: number }).a;
      } finally {
        r.close();
      }
    };
    expect(isAdmin()).toBe(0);
    const res = cli(dataDir, ['promote-admin', 'bea@EXAMPLE.com']);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout.trim()).toBe('Bea@Example.com is now an instance admin.');
    expect(isAdmin()).toBe(1);
    // Every admin sees it in the overview: admin_granted, without an actor.
    const bea = new DatabaseSync(file, { readOnly: true });
    const beaId = (bea.prepare("SELECT id FROM users WHERE email_key = 'bea@example.com'").get() as { id: number }).id;
    bea.close();
    expect(adminEvents(file)).toEqual([{ type: 'admin_granted', user_id: beaId, actor_id: null, ip: null, data: '{"via":"cli","displayName":"Bea"}' }]);
    expect(cli(dataDir, ['promote-admin', 'owner']).stdout.trim()).toBe('owner is already an instance admin.');
    expect(adminEvents(file)).toHaveLength(1);
    const unknown = cli(dataDir, ['promote-admin', 'nobody@example.com']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr.trim()).toBe('No account with the email address or username "nobody@example.com". Accounts: owner, Bea@Example.com');
    expect(cli(dataDir, ['promote-admin']).status).toBe(2);
  }, 60_000);

  it('policy shows and sets who can create accounts; open needs a transport that delivers mail', async () => {
    const { dataDir } = await dataDirWithOwner();
    expect(cli(dataDir, ['policy']).stdout.trim()).toBe('Sign-up policy: invite_only (accounts are created through invitations only).');
    const closed = cli(dataDir, ['policy', 'closed']);
    expect(closed.status, closed.stderr).toBe(0);
    expect(closed.stdout.trim()).toBe("Sign-up policy set to closed (only administrators' invitations create accounts); it was invite_only.");
    const changed = { type: 'admin_settings_changed', user_id: null, actor_id: null, ip: null, data: '{"signupPolicy":{"from":"invite_only","to":"closed"},"via":"cli"}' };
    expect(adminEvents(path.join(dataDir, 'lyren.db'))).toEqual([changed]);
    const open = cli(dataDir, ['policy', 'open']);
    expect(open.status).toBe(1);
    expect(open.stderr.trim()).toBe('Open sign-up needs a mail transport (MAIL_TRANSPORT): the policy stays closed.');
    // Neither a refusal nor showing the policy is an event.
    expect(cli(dataDir, ['policy', 'closed']).status).toBe(0);
    expect(adminEvents(path.join(dataDir, 'lyren.db'))).toEqual([changed]);
    expect(cli(dataDir, ['policy']).stdout.trim()).toBe("Sign-up policy: closed (only administrators' invitations create accounts).");
    const bad = cli(dataDir, ['policy', 'everyone']);
    expect(bad.status).toBe(2);
    expect(bad.stderr.trim()).toBe('Usage: policy [open|invite_only|closed]');
  }, 60_000);

  it('policy open is accepted once the transport delivers mail (§5.3); nothing is sent to set it', async () => {
    const { dataDir } = await dataDirWithOwner();
    // A mail server that is not there: the transport is built, never used.
    const mail = { MAIL_TRANSPORT: 'smtp', MAIL_FROM: 'plan@example.com', PUBLIC_URL: 'https://plan.example.com', SMTP_HOST: 'smtp.example.com' };
    const open = cli(dataDir, ['policy', 'open'], '', mail);
    expect(open.status, open.stderr).toBe(0);
    expect(open.stdout.trim()).toBe('Sign-up policy set to open (anyone can create an account, with a verified email address); it was invite_only.');
    // Without mail the policy can still be shown and changed away from open.
    expect(cli(dataDir, ['policy']).stdout.trim()).toBe('Sign-up policy: open (anyone can create an account, with a verified email address).');
    expect(cli(dataDir, ['policy', 'invite_only']).status).toBe(0);
  }, 60_000);

  it('spaces lists every space: id, status, name, owners and size', async () => {
    const { dataDir } = await dataDirWithOwner();
    expect(cli(dataDir, ['spaces']).stdout.trim()).toBe('No spaces yet.');
    // Two spaces made through the API, one of them deleted within its grace period.
    const fresh = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-spaces-')), 'data');
    dirs.push(path.dirname(fresh));
    const config = loadConfig({ dataDir: fresh, dbPath: path.join(fresh, 'lyren.db'), webDir: null, setupToken: 'code-1234', logRequests: false });
    const stack = openNodeStack(config, { mode: 'maintenance' });
    let ids: string[];
    try {
      const json = (cookie: string | null, body: unknown, method = 'POST'): RequestInit => ({
        method,
        headers: { [CSRF_HEADER]: '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: JSON.stringify(body),
      });
      const setup = await stack.app.request(
        '/api/auth/setup',
        json(null, { email: 'owner@example.com', displayName: 'Owner', password: 'correct horse battery', setupCode: 'code-1234' }),
      );
      expect(setup.status).toBe(201);
      const cookie = setup.headers.getSetCookie().map((c) => c.split(';')[0]!).join('; ');
      const team = ((await (await stack.app.request('/api/spaces', json(cookie, { name: 'Team space' }))).json()) as { id: string }).id;
      const status = (await (await stack.app.request('/api/auth/status', { headers: { Cookie: cookie } })).json()) as { spaces: Array<{ id: string }> };
      ids = [status.spaces.find((s) => s.id !== team)!.id, team];
      const removal = await stack.app.request(`/api/spaces/${team}`, json(cookie, { confirmName: 'Team space' }, 'DELETE'));
      expect(removal.status, await removal.text()).toBe(200);
    } finally {
      stack.close();
    }
    const res = cli(fresh, ['spaces']);
    expect(res.status, res.stderr).toBe(0);
    const lines = res.stdout.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^ID {16}STATUS +NAME +OWNERS +SIZE$/);
    expect(lines[1]).toMatch(new RegExp(`^${ids[0]}  active +Owner's space +owner@example\\.com +\\d+(\\.\\d)? KB$`));
    expect(lines[2]).toMatch(new RegExp(`^${ids[1]}  deleted \\(restorable until \\d{4}-\\d\\d-\\d\\d\\) +Team space +owner@example\\.com +\\d+(\\.\\d)? KB$`));
    expect(lines).toHaveLength(3);
    // A space whose last writes are still in its -wal (a running server's): the size counts both, as the
    // admin list does (Appendix D 54).
    const file = path.join(fresh, 'spaces', `${ids[0]}.db`);
    const writer = new DatabaseSync(file);
    try {
      writer.exec('PRAGMA wal_autocheckpoint = 0; CREATE TABLE padding (x BLOB); INSERT INTO padding VALUES (zeroblob(400000))');
      const wal = fs.statSync(`${file}-wal`).size;
      expect(wal).toBeGreaterThan(400_000);
      const listed = cli(fresh, ['spaces']).stdout.trimEnd().split('\n')[1]!;
      expect(listed.endsWith(` ${formatSize(fs.statSync(file).size + wal)}`), listed).toBe(true);
    } finally {
      writer.close();
    }
    expect([formatSize(0), formatSize(1023), formatSize(1536), formatSize(10 * 1024 ** 2), formatSize(3 * 1024 ** 3)]).toEqual([
      '0 B',
      '1023 B',
      '1.5 KB',
      '10 MB',
      '3.0 GB',
    ]);
  }, 60_000);

  it('help lists every command and the settings by group, ending with the README pointer', () => {
    const res = cli(path.join(os.tmpdir(), 'never-made'), ['help']);
    expect(res.status).toBe(0);
    for (const command of ['serve', 'backup <file>', 'restore <file|->', 'reset-password <email-or-username>', 'promote-admin <email-or-username>',
      'policy [open|invite_only|closed]', 'spaces', 'help']) {
      expect(res.stdout).toContain(`node dist/server.mjs ${command}`);
    }
    for (const group of [' Server', ' Accounts and sign-in', ' Mail', ' Spaces and limits (0 = no limit)', ' Backups']) {
      expect(res.stdout.split('\n')).toContain(group);
    }
    for (const variable of ['PUBLIC_URL=', 'SIGNUP_POLICY=invite_only', 'MAIL_TRANSPORT=log', 'MAIL_LOG_BODIES=false', 'SPACES_OPEN_MAX=32', 'ALLOW_ADMIN_BACKUP_DOWNLOAD=true',
      'SMTP_HOST=', 'SMTP_SECURITY=tls', 'SMTP_PASS=', 'RESEND_API_KEY=']) {
      expect(res.stdout).toContain(variable);
    }
    expect(res.stdout.trimEnd().split('\n').at(-1)).toBe('See README → Configuration.');
    expect(fs.existsSync(path.join(os.tmpdir(), 'never-made'))).toBe(false);
  }, 60_000);
});
