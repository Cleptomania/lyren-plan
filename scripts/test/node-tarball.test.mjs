// The Node.js release archive of scripts/pack-node.mjs (scripts/lib/node-tarball.mjs), and what the
// release workflow does with it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { extractFromTarGz, sha256 } from '../lib/node-dist.mjs';
import {
  archiveTime,
  buildTar,
  collectNodeFiles,
  gzipDeterministic,
  nodeTarballName,
  packNodeTarball,
  readTarEntries,
  RECORD_SIZE,
  sha256Line,
  splitUstarName,
  topFolder,
  ustarHeader,
} from '../lib/node-tarball.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const dirs = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-nodetar-'));
  dirs.push(d);
  return d;
}

/** A dist/ folder as npm run build leaves it, plus what the single-file apps add. */
function distDir(extra = {}) {
  const dir = tmp();
  const files = {
    'server.mjs': 'console.log("server")\n//# sourceMappingURL=server.mjs.map\n',
    'server.mjs.map': '{"version":3}',
    'web/index.html': '<!doctype html><title>Lyren Plan</title>',
    'web/sw.js': 'self.addEventListener("fetch", () => {})',
    'web/assets/index-abc.js': 'x'.repeat(1000),
    'web/assets/index-abc.js.map': '{}',
    'web/assets/Zed-1.css': 'body{}',
    'web/icons/icon-192.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    'lyren-plan-1.2.3-win-x64.exe': 'MZ',
    'lyren-plan-1.2.3-win-x64.exe.sha256': 'abc',
    'sea/win-x64/lyren-plan.cjs': 'cjs',
    ...extra,
  };
  for (const [p, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), body);
  }
  return dir;
}

describe('names', () => {
  it('archive and top folder from the version', () => {
    expect(nodeTarballName('1.2.3')).toBe('lyren-plan-1.2.3-node.tar.gz');
    expect(nodeTarballName('0.2.0-beta.1')).toBe('lyren-plan-0.2.0-beta.1-node.tar.gz');
    expect(topFolder('1.2.3')).toBe('lyren-plan-1.2.3');
    for (const bad of ['1.2', 'v1.2.3', '1.2.3/../x', '1.2.3 ', '']) expect(() => nodeTarballName(bad)).toThrow(/Not a release version/);
  });

  it('a .sha256 line like the other release files', () => {
    const buf = Buffer.from('abc');
    expect(sha256Line(buf, 'x.tar.gz')).toBe(`${sha256(buf)}  x.tar.gz\n`);
  });

  it('SOURCE_DATE_EPOCH, else the time of server.mjs', () => {
    const dir = distDir();
    const file = path.join(dir, 'server.mjs');
    fs.utimesSync(file, 1_700_000_000.7, 1_700_000_000.7);
    expect(archiveTime({}, file)).toBe(1_700_000_000);
    expect(archiveTime({ SOURCE_DATE_EPOCH: '' }, file)).toBe(1_700_000_000);
    expect(archiveTime({ SOURCE_DATE_EPOCH: '1760000000' }, file)).toBe(1_760_000_000);
    expect(() => archiveTime({ SOURCE_DATE_EPOCH: '17.5' }, file)).toThrow(/whole number/);
  });
});

describe('collectNodeFiles', () => {
  it('server.mjs and web/ only, without source maps, each folder before its contents in byte order', () => {
    const { entries, skipped } = collectNodeFiles(distDir());
    expect(entries.map((e) => `${e.type} ${e.rel}`)).toEqual([
      'file server.mjs',
      'dir web',
      'dir web/assets',
      // Byte order: upper case before lower case, whatever the locale.
      'file web/assets/Zed-1.css',
      'file web/assets/index-abc.js',
      'dir web/icons',
      'file web/icons/icon-192.png',
      'file web/index.html',
      'file web/sw.js',
    ]);
    expect(skipped.map((s) => s.rel).sort()).toEqual(['server.mjs.map', 'web/assets/index-abc.js.map']);
    expect(entries.find((e) => e.rel === 'web/assets/index-abc.js')).toMatchObject({ size: 1000 });
  });

  it('refuses a dist/ without server.mjs or without the web client', () => {
    const noServer = distDir();
    fs.rmSync(path.join(noServer, 'server.mjs'));
    expect(() => collectNodeFiles(noServer)).toThrow(/No server.mjs/);
    const noWeb = distDir();
    fs.rmSync(path.join(noWeb, 'web', 'index.html'));
    expect(() => collectNodeFiles(noWeb)).toThrow(/No web\/index.html/);
  });

  it.skipIf(process.platform === 'win32')('refuses a symbolic link', () => {
    const dir = distDir();
    fs.symlinkSync('/etc/passwd', path.join(dir, 'web', 'passwd'));
    expect(() => collectNodeFiles(dir)).toThrow(/symbolic link/);
  });
});

describe('ustar', () => {
  it('splits long names into prefix and name, and refuses what does not fit', () => {
    expect(splitUstarName('a/b')).toEqual(['', 'a/b']);
    const long = `lyren-plan-1.2.3/web/assets/${'x'.repeat(90)}.js`;
    const [prefix, name] = splitUstarName(long);
    expect(`${prefix}/${name}`).toBe(long);
    expect(prefix.length).toBeLessThanOrEqual(155);
    expect(name.length).toBeLessThanOrEqual(100);
    // Read back as the whole path (GNU tar too: see the GNU tar test below).
    const entry = readTarEntries(Buffer.concat([ustarHeader({ name: long, type: 'file', mode: 0o644, mtime: 0 }), Buffer.alloc(1024)]))[0];
    expect(entry.name).toBe(long);
    expect(() => splitUstarName(`a/${'x'.repeat(101)}`)).toThrow(/too long/);
  });

  it('refuses absolute and parent paths', () => {
    for (const name of ['/etc/x', 'a/../b', './a', 'a/./b']) {
      expect(() => ustarHeader({ name, type: 'file', mode: 0o644, mtime: 0 })).toThrow(/Unsafe/);
    }
  });

  it('round-trips: root-owned entries under the top folder, fixed modes and time, padded records', () => {
    const { entries } = collectNodeFiles(distDir());
    const tar = buildTar(entries, { top: 'lyren-plan-1.2.3', mtime: 1_760_000_000 });
    expect(tar.length % RECORD_SIZE).toBe(0);
    const back = readTarEntries(tar);
    expect(back[0]).toMatchObject({ name: 'lyren-plan-1.2.3/', type: 'dir', mode: 0o755 });
    expect(back.map((e) => e.name)).toContain('lyren-plan-1.2.3/web/assets/');
    for (const e of back) {
      expect(e.name.startsWith('lyren-plan-1.2.3/')).toBe(true);
      expect(e).toMatchObject({ uid: 0, gid: 0, uname: 'root', gname: 'root', mtime: 1_760_000_000, magic: 'ustar' });
      expect(e.mode).toBe(e.type === 'dir' ? 0o755 : 0o644);
    }
    const index = back.find((e) => e.name === 'lyren-plan-1.2.3/web/index.html');
    expect(index.body.toString()).toBe('<!doctype html><title>Lyren Plan</title>');
  });

  it('refuses a file that changed size after it was collected', () => {
    const dir = distDir();
    const { entries } = collectNodeFiles(dir);
    fs.appendFileSync(path.join(dir, 'web', 'sw.js'), '// more');
    expect(() => buildTar(entries, { top: 't', mtime: 0 })).toThrow(/changed/);
  });
});

describe('packNodeTarball', () => {
  it('is the same archive every time, readable by another tar reader', () => {
    const dir = distDir();
    const a = packNodeTarball(dir, { version: '1.2.3', mtime: 1_760_000_000 });
    const b = packNodeTarball(dir, { version: '1.2.3', mtime: 1_760_000_000 });
    expect(a.gz.equals(b.gz)).toBe(true);
    expect(a).toMatchObject({ name: 'lyren-plan-1.2.3-node.tar.gz', top: 'lyren-plan-1.2.3', sha256: sha256(a.gz) });
    // gzip header: no time stamp, OS "Unix" on every platform.
    expect(a.gz.readUInt32LE(4)).toBe(0);
    expect(a.gz[9]).toBe(3);
    // The reader that package.mjs uses for Node.js downloads.
    expect(extractFromTarGz(a.gz, 'lyren-plan-1.2.3/server.mjs').toString()).toContain('console.log("server")');
    expect(extractFromTarGz(a.gz, 'lyren-plan-1.2.3/server.mjs.map')).toBeNull();
    const other = packNodeTarball(dir, { version: '1.2.3', mtime: 1_760_000_001 });
    expect(other.gz.equals(a.gz)).toBe(false);
  });

  it('gzipDeterministic sets the OS byte even where zlib writes another', () => {
    const gz = gzipDeterministic(Buffer.from('hello'));
    expect(gz[9]).toBe(3);
    expect(gunzipSync(gz).toString()).toBe('hello');
  });

  // GNU tar is what the guide (docs/ubuntu-server.md) and the release smoke test extract with.
  const gnuTar = process.platform === 'linux' && /GNU tar/.test(spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout ?? '');
  it.skipIf(!gnuTar)('GNU tar lists it as root-owned and extracts it unchanged', () => {
    // A name over 100 bytes goes into the ustar prefix field.
    const longName = `web/assets/${'y'.repeat(95)}.js`;
    const dir = distDir({ [longName]: 'long' });
    const pack = packNodeTarball(dir, { version: '1.2.3', mtime: 1_760_000_000 });
    const out = tmp();
    const file = path.join(out, pack.name);
    fs.writeFileSync(file, pack.gz);
    const list = spawnSync('tar', ['-tvzf', file, '--numeric-owner'], { encoding: 'utf8' });
    expect(list.status).toBe(0);
    const lines = list.stdout.trim().split('\n');
    expect(lines).toHaveLength(pack.entries.length + 1);
    for (const line of lines) expect(line).toMatch(/^[d-]rw[x-]r-[x-]r-[x-] 0\/0 /);
    const x = spawnSync('tar', ['-xzf', file, '-C', out, '--no-same-owner'], { encoding: 'utf8' });
    expect(x.status, x.stderr).toBe(0);
    expect(x.stderr).toBe('');
    expect(fs.readFileSync(path.join(out, 'lyren-plan-1.2.3', 'web', 'assets', 'index-abc.js'), 'utf8')).toBe('x'.repeat(1000));
    expect(fs.existsSync(path.join(out, 'lyren-plan-1.2.3', 'web', 'assets', 'index-abc.js.map'))).toBe(false);
    expect(fs.readdirSync(path.join(out, 'lyren-plan-1.2.3')).sort()).toEqual(['server.mjs', 'web']);
    expect(fs.readFileSync(path.join(out, 'lyren-plan-1.2.3', longName), 'utf8')).toBe('long');
    expect(fs.statSync(path.join(out, 'lyren-plan-1.2.3', 'web', 'sw.js')).mtimeMs).toBe(1_760_000_000_000);
  });
});

describe('release workflow', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const publish = fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'publish-release.sh'), 'utf8');

  it('smoke-tests the archive, and runs the server\'s tests, on the oldest Node.js that package.json allows', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const min = /^>=(\d+\.\d+\.\d+)$/.exec(pkg.engines.node)?.[1];
    expect(min, `engines.node is ${pkg.engines.node}`).toBeTruthy();
    expect(workflow).toContain(`node: '${min}'`);
    expect(workflow).toContain(`name: Test on Node.js ${min}\n`);
    expect(workflow).toContain(`node-version: '${min}'`);
  });

  it('packs, keeps and publishes the archive', () => {
    expect(workflow).toContain('node scripts/pack-node.mjs --no-build');
    expect(workflow).toContain('dist/lyren-plan-${{ steps.version.outputs.version }}-node.tar.gz');
    expect(workflow).toContain('dist/lyren-plan-${{ steps.version.outputs.version }}-node.tar.gz.sha256');
    expect(publish).toContain('node=lyren-plan-$version-node.tar.gz');
  });
});
