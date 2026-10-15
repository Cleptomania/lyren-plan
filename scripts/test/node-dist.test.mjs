// Node.js download helpers of scripts/package.mjs (no network beyond a local test server).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import {
  extractFromTarGz,
  fetchNodeBinary,
  mirrorBase,
  nodeArtifact,
  parseShasums,
  pinnedSha256,
  requirePinned,
  sha256,
  verifyAgainstShasums,
} from '../lib/node-dist.mjs';
import { PINNED_SHA256 } from '../lib/node-hashes.mjs';

const dirs = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-nodedist-'));
  dirs.push(d);
  return d;
}

function header(name, size, type = '0') {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0' + '00', 257);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const pad = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
function tar(entries) {
  const parts = [];
  for (const { name, data, type = '0' } of entries) parts.push(header(name, data.length, type), pad(data));
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

describe('nodeArtifact', () => {
  it('names the SHASUMS256 entry per target', () => {
    expect(nodeArtifact('win-x64', 'v24.19.0')).toEqual({ name: 'win-x64/node.exe', member: null });
    expect(nodeArtifact('win-arm64', 'v24.19.0')).toEqual({ name: 'win-arm64/node.exe', member: null });
    expect(nodeArtifact('linux-x64', 'v24.19.0')).toEqual({
      name: 'node-v24.19.0-linux-x64.tar.gz',
      member: 'node-v24.19.0-linux-x64/bin/node',
    });
    expect(() => nodeArtifact('mac-x64', 'v24.19.0')).toThrow(/Unknown target/);
    expect(() => nodeArtifact('win-x64', '24.19')).toThrow(/Bad Node.js version/);
  });
});

describe('SHASUMS256.txt', () => {
  const text = [
    'aaaa' + '0'.repeat(60) + '  node-v24.19.0-linux-x64.tar.gz',
    'BBBB' + '1'.repeat(60) + ' *win-x64/node.exe\r',
    '-----BEGIN PGP SIGNATURE-----',
    '',
  ].join('\n');

  it('parses entries (CRLF, binary marker, case)', () => {
    const sums = parseShasums(text);
    expect(sums.get('node-v24.19.0-linux-x64.tar.gz')).toBe('aaaa' + '0'.repeat(60));
    expect(sums.get('win-x64/node.exe')).toBe('bbbb' + '1'.repeat(60));
    expect(sums.size).toBe(2);
  });

  it('verifies a download', () => {
    const data = Buffer.from('node binary');
    const sums = new Map([['win-x64/node.exe', sha256(data)]]);
    expect(verifyAgainstShasums(data, 'win-x64/node.exe', sums)).toBe(sha256(data));
    expect(() => verifyAgainstShasums(Buffer.from('tampered'), 'win-x64/node.exe', sums)).toThrow(/SHA-256 mismatch/);
    expect(() => verifyAgainstShasums(data, 'win-arm64/node.exe', sums)).toThrow(/no entry/);
  });
});

describe('extractFromTarGz', () => {
  it('finds a member, also behind GNU long names and pax paths', () => {
    const node = Buffer.from('\x7fELF fake node binary'.repeat(40));
    const long = 'node-v24.19.0-linux-x64/' + 'deep/'.repeat(30) + 'node';
    const archive = tar([
      { name: 'node-v24.19.0-linux-x64/', data: Buffer.alloc(0), type: '5' },
      { name: 'node-v24.19.0-linux-x64/README.md', data: Buffer.from('readme') },
      { name: './node-v24.19.0-linux-x64/bin/node', data: node },
      { name: '././@LongLink', data: Buffer.from(long + '\0'), type: 'L' },
      { name: long.slice(0, 99), data: Buffer.from('long one') },
      { name: 'PaxHeaders/x', data: Buffer.from('30 path=pax/dir/very-long-name\n'), type: 'x' },
      { name: 'truncated', data: Buffer.from('pax one') },
    ]);
    expect(extractFromTarGz(archive, 'node-v24.19.0-linux-x64/bin/node').equals(node)).toBe(true);
    expect(extractFromTarGz(archive, long).toString()).toBe('long one');
    expect(extractFromTarGz(archive, 'pax/dir/very-long-name').toString()).toBe('pax one');
    expect(extractFromTarGz(archive, 'node-v24.19.0-linux-x64/bin/npm')).toBeNull();
  });
});

describe('where the expected SHA-256 comes from', () => {
  /** A local "mirror" serving `files` (path -> Buffer) and recording what was asked for. */
  async function mirror(files) {
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url);
      const body = files[req.url];
      res.writeHead(body ? 200 : 404).end(body);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)) };
  }
  const quiet = () => undefined;

  it('mirrors must use https (http only when explicitly allowed)', () => {
    expect(mirrorBase('https://example.org/node/dist/')).toBe('https://example.org/node/dist');
    expect(() => mirrorBase('http://example.org/dist', {})).toThrow(/must be an https:\/\/ URL/);
    expect(mirrorBase('http://127.0.0.1:1/dist', { LYREN_NODE_ALLOW_HTTP: '1' })).toBe('http://127.0.0.1:1/dist');
    expect(() => mirrorBase('file:///srv/dist', { LYREN_NODE_ALLOW_HTTP: '1' })).toThrow(/https/);
    expect(() => mirrorBase('not a url')).toThrow(/not a URL/);
  });

  it('pinned versions cover every target', () => {
    expect(Object.keys(PINNED_SHA256)).toContain('v24.19.0');
    for (const version of Object.keys(PINNED_SHA256)) {
      for (const target of ['win-x64', 'win-arm64', 'linux-x64', 'linux-arm64']) {
        expect(pinnedSha256(version, nodeArtifact(target, version).name), `${version} ${target}`).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it('a pinned version: a mirror (or a tampered cache) with matching sums of its own is not trusted', async () => {
    const fake = Buffer.from('MZ not really node.exe');
    const m = await mirror({
      '/v24.19.0/win-x64/node.exe': fake,
      '/v24.19.0/SHASUMS256.txt': Buffer.from(`${sha256(fake)}  win-x64/node.exe\n`),
    });
    const cacheDir = tmp();
    try {
      const env = { LYREN_NODE_ALLOW_HTTP: '1' };
      await expect(fetchNodeBinary({ target: 'win-x64', version: 'v24.19.0', cacheDir, mirror: m.url, env, log: quiet })).rejects.toThrow(
        /SHA-256 mismatch for win-x64\/node\.exe: expected 3602f2bb.*pinned/,
      );
      expect(m.requests).toEqual(['/v24.19.0/win-x64/node.exe']); // never the mirror's SHASUMS256.txt
      expect(fs.existsSync(path.join(cacheDir, 'v24.19.0', 'win-x64-node.exe'))).toBe(false);
      // A cache poisoned by an earlier build (binary + sums) is downloaded again, and still refused.
      fs.writeFileSync(path.join(cacheDir, 'v24.19.0', 'win-x64-node.exe'), fake);
      fs.writeFileSync(path.join(cacheDir, 'v24.19.0', 'SHASUMS256.txt'), `${sha256(fake)}  win-x64/node.exe\n`);
      await expect(fetchNodeBinary({ target: 'win-x64', version: 'v24.19.0', cacheDir, mirror: m.url, env, log: quiet })).rejects.toThrow(/mismatch/);
      // The same file given as LYREN_NODE_BINARY is refused too.
      const file = path.join(cacheDir, 'node.exe');
      fs.writeFileSync(file, fake);
      await expect(fetchNodeBinary({ target: 'win-x64', version: 'v24.19.0', cacheDir, env: { LYREN_NODE_BINARY: file }, log: quiet })).rejects.toThrow(/mismatch/);
      await expect(fetchNodeBinary({ target: 'win-x64', version: 'v24.19.0', cacheDir, mirror: m.url, env: {}, log: quiet })).rejects.toThrow(/https/);
    } finally {
      await m.close();
    }
  });

  it('another version: sums from LYREN_NODE_SHASUMS (or nodejs.org), never from the mirror', async () => {
    const real = Buffer.from('MZ the real node.exe of v99');
    const m = await mirror({
      '/v99.0.0/win-x64/node.exe': real,
      '/v99.0.0/SHASUMS256.txt': Buffer.from(`${'0'.repeat(64)}  win-x64/node.exe\n`),
    });
    const cacheDir = tmp();
    const sumsFile = path.join(cacheDir, 'SHASUMS256.txt');
    fs.writeFileSync(sumsFile, `${sha256(real)}  win-x64/node.exe\n`);
    try {
      const env = { LYREN_NODE_ALLOW_HTTP: '1', LYREN_NODE_SHASUMS: sumsFile };
      const logs = [];
      const res = await fetchNodeBinary({ target: 'win-x64', version: 'v99.0.0', cacheDir, mirror: m.url, env, log: (l) => logs.push(l) });
      expect(res.binary.equals(real)).toBe(true);
      expect(res.verified).toBe(true);
      expect(logs.at(-1)).toContain('verified, from');
      expect(m.requests).toEqual(['/v99.0.0/win-x64/node.exe']);
      // Offline LYREN_NODE_BINARY without any known hash: used with a warning.
      const file = path.join(cacheDir, 'node.exe');
      fs.writeFileSync(file, real);
      const off = await fetchNodeBinary({ target: 'win-x64', version: 'v98.0.0', cacheDir, env: { LYREN_NODE_BINARY: file }, log: (l) => logs.push(l) });
      expect(off.verified).toBe(false);
      expect(logs.at(-1)).toMatch(/^Warning: .* without checking its SHA-256/);
    } finally {
      await m.close();
    }
  });

  it('LYREN_NODE_PINNED_ONLY=1 (release builds): pinned versions only, nothing unchecked', async () => {
    const strict = { LYREN_NODE_PINNED_ONLY: '1', LYREN_NODE_ALLOW_HTTP: '1' };
    for (const target of ['win-x64', 'win-arm64', 'linux-x64', 'linux-arm64']) {
      expect(() => requirePinned(target, 'v24.19.0', strict)).not.toThrow();
    }
    expect(() => requirePinned('win-x64', 'v99.0.0', strict)).toThrow(/Node\.js v99\.0\.0 is not pinned .*LYREN_NODE_PINNED_ONLY=1/);
    expect(() => requirePinned('linux-x64', 'v24.19.0', strict, { 'v24.19.0': {} })).toThrow(/not pinned/);
    expect(() => requirePinned('win-x64', 'v99.0.0', {})).not.toThrow();
    expect(() => requirePinned('win-x64', 'v99.0.0', { LYREN_NODE_PINNED_ONLY: '' })).not.toThrow();
    expect(() => requirePinned('win-x64', 'v24.19.0', { LYREN_NODE_PINNED_ONLY: 'true' })).toThrow(/must be 1 or unset/);

    // An unpinned version is refused before anything is downloaded, also with sums of its own.
    const real = Buffer.from('MZ the real node.exe of v99');
    const m = await mirror({ '/v99.0.0/win-x64/node.exe': real });
    const cacheDir = tmp();
    const sumsFile = path.join(cacheDir, 'SHASUMS256.txt');
    fs.writeFileSync(sumsFile, `${sha256(real)}  win-x64/node.exe\n`);
    try {
      const env = { ...strict, LYREN_NODE_SHASUMS: sumsFile };
      await expect(fetchNodeBinary({ target: 'win-x64', version: 'v99.0.0', cacheDir, mirror: m.url, env, log: quiet })).rejects.toThrow(/not pinned/);
      expect(m.requests).toEqual([]);
    } finally {
      await m.close();
    }
    // LYREN_NODE_BINARY: a Linux binary can't be checked against the pinned hash of its archive.
    const file = path.join(cacheDir, 'node');
    fs.writeFileSync(file, '\x7fELF fake node');
    await expect(fetchNodeBinary({ target: 'linux-x64', version: 'v24.19.0', cacheDir, env: { ...strict, LYREN_NODE_BINARY: file }, log: quiet })).rejects.toThrow(
      /can't be checked .*LYREN_NODE_PINNED_ONLY=1/,
    );
  });

  it('.nvmrc names an exact, pinned version (the release workflow builds with it)', () => {
    const nvmrc = fs.readFileSync(new URL('../../.nvmrc', import.meta.url), 'utf8').trim();
    expect(nvmrc).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(PINNED_SHA256)).toContain(`v${nvmrc}`);
  });
});
