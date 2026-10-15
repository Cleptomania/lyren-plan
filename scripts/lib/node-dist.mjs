// The official Node.js binary a single-file app is built on: which file of
// https://nodejs.org/dist/<version>/ to fetch for a target, which SHA-256 it must have, SHASUMS256.txt
// parsing, and pulling bin/node out of a .tar.gz. The download itself (with its cache) is
// fetchNodeBinary; the rest are pure functions, unit-tested in scripts/test/node-dist.test.mjs.
//
// Where the expected SHA-256 comes from, in this order:
//   1. node-hashes.mjs, for the pinned versions (signature-checked when they were added);
//   2. LYREN_NODE_SHASUMS=<file>, a SHASUMS256.txt the builder provides (offline builds);
//   3. SHASUMS256.txt from https://nodejs.org/dist (cached as SHASUMS256.nodejs.org.txt).
// Never from LYREN_NODE_MIRROR: a mirror only transports the file, and must use https.
// LYREN_NODE_PINNED_ONLY=1 (release builds, .github/workflows/release.yml) allows the pinned
// versions only: 2. and 3. are never used, and neither is an unverifiable LYREN_NODE_BINARY.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { PINNED_SHA256 } from './node-hashes.mjs';

export const OFFICIAL_DIST = 'https://nodejs.org/dist';

export const TARGETS = {
  'win-x64': { platform: 'win32', exe: true },
  'win-arm64': { platform: 'win32', exe: true },
  'linux-x64': { platform: 'linux', exe: false },
  'linux-arm64': { platform: 'linux', exe: false },
};

/** The SHASUMS256.txt entry to download for `target`, and the binary's path inside it (archives). */
export function nodeArtifact(target, version) {
  if (!TARGETS[target]) throw new Error(`Unknown target ${target} (expected ${Object.keys(TARGETS).join(', ')})`);
  if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error(`Bad Node.js version ${version}`);
  if (TARGETS[target].platform === 'win32') return { name: `${target}/node.exe`, member: null };
  const base = `node-${version}-${target}`;
  return { name: `${base}.tar.gz`, member: `${base}/bin/node` };
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** SHASUMS256.txt ("<hex>  <name>" per line) as a Map name -> lowercase hex. */
export function parseShasums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S.*?)\s*$/.exec(line);
    if (m) sums.set(m[2], m[1].toLowerCase());
  }
  return sums;
}

/** Throws unless `buf` hashes to the SHASUMS256 entry `name`. */
export function verifyAgainstShasums(buf, name, sums) {
  const expected = sums.get(name);
  if (!expected) throw new Error(`SHASUMS256.txt has no entry for ${name}`);
  const actual = sha256(buf);
  if (actual !== expected) throw new Error(`SHA-256 mismatch for ${name}: expected ${expected}, got ${actual}`);
  return actual;
}

/** One regular file from a gzip-compressed (ustar / GNU) tar archive, or null when absent. */
export function extractFromTarGz(archive, member) {
  const tar = gunzipSync(archive);
  let longName = null;
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const str = (start, len) => {
      const raw = header.subarray(start, start + len);
      const end = raw.indexOf(0);
      return raw.subarray(0, end === -1 ? len : end).toString('utf8');
    };
    const sizeField = header.subarray(124, 136);
    // Sizes are octal text, or base-256 binary when the high bit of the first byte is set.
    const size = sizeField[0] & 0x80 ? Number(sizeField.readBigUInt64BE(4)) : parseInt(str(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = str(345, 155);
    let name = longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    longName = null;
    const dataStart = off + 512;
    const next = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = tar.subarray(dataStart, dataStart + size).toString('utf8').replace(/\0+$/, '');
    } else if (type === 'x') {
      // pax extended header: "<len> <key>=<value>\n" records; `path` overrides the next name.
      const records = tar.subarray(dataStart, dataStart + size).toString('utf8');
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(records);
      if (m) longName = m[1];
    } else if ((type === '0' || type === '\0') && name.replace(/^\.\//, '') === member) {
      return Buffer.from(tar.subarray(dataStart, dataStart + size));
    }
    off = next;
  }
  return null;
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The mirror base URL to download from; https only (http only with LYREN_NODE_ALLOW_HTTP=1). */
export function mirrorBase(mirror, env = process.env) {
  let url;
  try {
    url = new URL(mirror);
  } catch {
    throw new Error(`LYREN_NODE_MIRROR is not a URL: ${mirror}`);
  }
  const insecureOk = url.protocol === 'http:' && env.LYREN_NODE_ALLOW_HTTP === '1';
  if (url.protocol !== 'https:' && !insecureOk) {
    throw new Error(`LYREN_NODE_MIRROR must be an https:// URL (got ${mirror}); set LYREN_NODE_ALLOW_HTTP=1 to allow plain http.`);
  }
  return url.href.replace(/\/+$/, '');
}

/** The pinned SHA-256 of release file `name` of `version` (node-hashes.mjs), or null. */
export function pinnedSha256(version, name, pinned = PINNED_SHA256) {
  return pinned[version]?.[name] ?? null;
}

/**
 * With LYREN_NODE_PINNED_ONLY=1: throws unless the release file of `version` for `target` has a
 * pinned SHA-256, so a release is never built on a binary checked against downloaded checksums.
 */
export function requirePinned(target, version, env = process.env, pinned = PINNED_SHA256) {
  if (!env.LYREN_NODE_PINNED_ONLY) return;
  // Any other value is refused rather than read as "off": the variable only ever makes a build stricter.
  if (env.LYREN_NODE_PINNED_ONLY !== '1') throw new Error(`LYREN_NODE_PINNED_ONLY must be 1 or unset (got ${env.LYREN_NODE_PINNED_ONLY})`);
  if (pinnedSha256(version, nodeArtifact(target, version).name, pinned)) return;
  const known = Object.keys(pinned).join(', ') || 'none';
  throw new Error(
    `Node.js ${version} is not pinned in scripts/lib/node-hashes.mjs for ${target} (pinned: ${known}), and ` +
      'LYREN_NODE_PINNED_ONLY=1 allows pinned versions only. Build with the Node.js version in .nvmrc, or pin this one.',
  );
}

/**
 * The SHA-256 that release file `name` must have, and where that value came from (see the header).
 * `online` false: no download of SHASUMS256.txt (then null when nothing else knows it).
 */
async function expectedSha256({ version, name, dir, env, log, online }) {
  const pinned = pinnedSha256(version, name);
  if (pinned) return { sha256: pinned, how: 'pinned in scripts/lib/node-hashes.mjs' };
  if (env.LYREN_NODE_SHASUMS) {
    const sums = parseShasums(fs.readFileSync(env.LYREN_NODE_SHASUMS, 'utf8'));
    const sha = sums.get(name);
    if (!sha) throw new Error(`${env.LYREN_NODE_SHASUMS} (LYREN_NODE_SHASUMS) has no entry for ${name}`);
    return { sha256: sha, how: `from ${env.LYREN_NODE_SHASUMS} (LYREN_NODE_SHASUMS)` };
  }
  const cached = path.join(dir, 'SHASUMS256.nodejs.org.txt');
  let text = fs.existsSync(cached) ? fs.readFileSync(cached, 'utf8') : null;
  if (text === null) {
    if (!online) return null;
    const url = `${OFFICIAL_DIST}/${version}/SHASUMS256.txt`;
    log(`Downloading ${url}`);
    try {
      text = (await download(url)).toString('utf8');
    } catch (err) {
      throw new Error(
        `Could not get ${url} to check the Node.js binary (${err.message}). Without access to nodejs.org, ` +
          'give a SHASUMS256.txt of that release with LYREN_NODE_SHASUMS=<file>.',
      );
    }
    fs.writeFileSync(cached, text);
  }
  const sha = parseShasums(text).get(name);
  if (!sha) throw new Error(`SHASUMS256.txt of ${version} on nodejs.org has no entry for ${name}`);
  return { sha256: sha, how: 'from SHASUMS256.txt on nodejs.org' };
}

function checkSha256(buf, name, expected) {
  const actual = sha256(buf);
  if (actual !== expected.sha256) {
    throw new Error(`SHA-256 mismatch for ${name}: expected ${expected.sha256} (${expected.how}), got ${actual}`);
  }
}

/**
 * The verified official Node.js binary for `target`, as a Buffer.
 *   - Downloads the release file (from `mirror`, default nodejs.org) into `cacheDir` once; later
 *     builds (also offline ones) use the cache, re-verified every time (a copy that doesn't match
 *     is downloaded again).
 *   - LYREN_NODE_BINARY=<file> uses that binary instead (offline builds). A node.exe is verified
 *     like a download when its SHA-256 is known (pinned, LYREN_NODE_SHASUMS, or a cached
 *     SHASUMS256.txt from nodejs.org); otherwise (and for a Linux binary, whose release file is a
 *     .tar.gz) it is used with a warning, or refused with LYREN_NODE_PINNED_ONLY=1.
 */
export async function fetchNodeBinary({ target, version, cacheDir, mirror = OFFICIAL_DIST, env = process.env, log = console.log }) {
  const { name, member } = nodeArtifact(target, version);
  requirePinned(target, version, env);
  const dir = path.join(cacheDir, version);
  fs.mkdirSync(dir, { recursive: true });

  if (env.LYREN_NODE_BINARY) {
    if (member && env.LYREN_NODE_PINNED_ONLY === '1') {
      throw new Error(`LYREN_NODE_BINARY can't be checked for ${target} (the pinned SHA-256 is of ${name}), and LYREN_NODE_PINNED_ONLY=1 allows checked binaries only.`);
    }
    const binary = fs.readFileSync(env.LYREN_NODE_BINARY);
    const expected = member ? null : await expectedSha256({ version, name, dir, env, log, online: false });
    if (expected) {
      checkSha256(binary, name, expected);
      log(`Using ${env.LYREN_NODE_BINARY} (LYREN_NODE_BINARY; SHA-256 ${expected.sha256} verified, ${expected.how})`);
    } else {
      log(`Warning: using ${env.LYREN_NODE_BINARY} (LYREN_NODE_BINARY) without checking its SHA-256.`);
    }
    return { binary, source: env.LYREN_NODE_BINARY, verified: Boolean(expected) };
  }

  const base = `${mirrorBase(mirror, env)}/${version}`;
  const expected = await expectedSha256({ version, name, dir, env, log, online: true });
  const cached = path.join(dir, name.replaceAll('/', '-'));
  let artifact = fs.existsSync(cached) ? fs.readFileSync(cached) : null;
  if (artifact && sha256(artifact) !== expected.sha256) {
    log(`Cached ${cached} does not have the expected SHA-256; downloading it again.`);
    artifact = null;
  }
  if (!artifact) {
    log(`Downloading ${base}/${name}`);
    artifact = await download(`${base}/${name}`);
    checkSha256(artifact, name, expected);
    fs.writeFileSync(cached, artifact);
  }
  log(`Node.js ${version} ${target}: ${name} (SHA-256 ${expected.sha256} verified, ${expected.how})`);
  if (!member) return { binary: artifact, source: cached, verified: true };
  const binary = extractFromTarGz(artifact, member);
  if (!binary) throw new Error(`${member} not found in ${name}`);
  return { binary, source: `${cached}!${member}`, verified: true };
}
