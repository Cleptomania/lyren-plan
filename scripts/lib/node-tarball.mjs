// The release download for Node.js installs (scripts/pack-node.mjs): what goes into
// lyren-plan-<version>-node.tar.gz and how the archive is written. A small POSIX ustar writer of
// its own, so the tar is the same on every build machine (Linux, macOS, Windows), whatever tar it
// has: entries in a fixed order (each folder before its contents, names sorted), owner and group
// root (uid/gid 0), modes 0755 for folders and 0644 for files, one modification time for all. The
// gzip header has no time stamp; the compressed bytes can still differ between zlib builds (Node 24
// and Ubuntu's Node 22 compress the same tar differently). Pure apart from reading the files;
// unit-tested in scripts/test/node-tarball.test.mjs.
//
// Contents: one top folder lyren-plan-<version>/ holding server.mjs and web/, which is all that
// `node server.mjs` reads at run time (the version is compiled in; no node_modules, no
// package.json). Source maps are left out: the browser and Node only load them for debugging, and
// they are three quarters of dist/ (as in the single-file app, scripts/lib/sea-assets.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { sha256 } from './node-dist.mjs';

/** What the release workflow accepts as a version (x.y.z or x.y.z-prerelease). */
export const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

export const DIR_MODE = 0o755;
export const FILE_MODE = 0o644;
/** GNU tar's default record size: the archive is padded to a multiple of it. */
export const RECORD_SIZE = 10240;

export function nodeTarballName(version) {
  checkVersion(version);
  return `lyren-plan-${version}-node.tar.gz`;
}

/** The archive's top folder, which is also the folder it extracts to. */
export function topFolder(version) {
  checkVersion(version);
  return `lyren-plan-${version}`;
}

function checkVersion(version) {
  if (!VERSION_RE.test(version)) throw new Error(`Not a release version: ${version}`);
}

/**
 * Seconds since 1970 for every archive entry: SOURCE_DATE_EPOCH (the reproducible-builds convention)
 * when set, else the modification time of `serverFile` (dist/server.mjs, i.e. when it was built).
 */
export function archiveTime(env, serverFile) {
  const v = env.SOURCE_DATE_EPOCH;
  if (v !== undefined && v !== '') {
    if (!/^\d+$/.test(v)) throw new Error(`SOURCE_DATE_EPOCH must be a whole number of seconds (got ${v})`);
    return Number(v);
  }
  return Math.floor(fs.statSync(serverFile).mtimeMs / 1000);
}

/** The line of a .sha256 file, as for the other release files: "<hex>  <name>\n". */
export function sha256Line(buf, fileName) {
  return `${sha256(buf)}  ${fileName}\n`;
}

/**
 * What to pack from `distDir`, in archive order: [{ rel: 'server.mjs', type: 'file', file, size },
 * { rel: 'web', type: 'dir' }, ...], with `/` separators. Only server.mjs and web/ are taken (not the
 * single-file apps or anything else in dist/), every *.map file is left out (`skipped` lists them).
 * Throws when server.mjs or web/index.html is missing, or for anything but regular files and
 * folders (a symbolic link would point outside the archive).
 */
export function collectNodeFiles(distDir) {
  const root = path.resolve(distDir);
  const entries = [];
  const skipped = [];
  const statOf = (abs) => {
    const st = fs.lstatSync(abs);
    if (!st.isFile() && !st.isDirectory()) throw new Error(`${abs} is neither a file nor a folder (a symbolic link?); it can't go into the archive`);
    return st;
  };
  const server = path.join(root, 'server.mjs');
  if (!fs.existsSync(server)) throw new Error(`No server.mjs in ${root}: run npm run build first`);
  if (!fs.existsSync(path.join(root, 'web', 'index.html'))) throw new Error(`No web/index.html in ${root}: run npm run build first`);
  const add = (abs, rel) => {
    const st = statOf(abs);
    if (st.isDirectory()) {
      entries.push({ rel, type: 'dir' });
      for (const name of fs.readdirSync(abs).sort(byteOrder)) add(path.join(abs, name), `${rel}/${name}`);
    } else if (rel.endsWith('.map')) {
      skipped.push({ rel, size: st.size });
    } else {
      entries.push({ rel, type: 'file', file: abs, size: st.size });
    }
  };
  if (!statOf(server).isFile()) throw new Error(`${server} is not a file`);
  entries.push({ rel: 'server.mjs', type: 'file', file: server, size: fs.statSync(server).size });
  if (fs.existsSync(`${server}.map`)) skipped.push({ rel: 'server.mjs.map', size: fs.statSync(`${server}.map`).size });
  add(path.join(root, 'web'), 'web');
  return { entries, skipped };
}

/** Names in byte order (as GNU tar --sort=name), the same on every platform and locale. */
function byteOrder(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** [prefix, name] for the ustar header (name at most 100 bytes, prefix at most 155), or throw. */
export function splitUstarName(full) {
  const bytes = Buffer.byteLength(full);
  if (bytes <= 100) return ['', full];
  for (let i = full.indexOf('/'); i !== -1; i = full.indexOf('/', i + 1)) {
    const prefix = full.slice(0, i);
    const name = full.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name !== '') return [prefix, name];
  }
  throw new Error(`The path ${full} is too long for a ustar archive`);
}

function octal(n, width) {
  const s = n.toString(8);
  if (s.length > width - 1) throw new Error(`${n} does not fit a ${width}-byte tar field`);
  return s.padStart(width - 1, '0') + '\0';
}

/** One 512-byte POSIX ustar header: type 'file' or 'dir', owned by root (0/0). */
export function ustarHeader({ name, type, size = 0, mode, mtime }) {
  if (name.startsWith('/') || name.split('/').some((s) => s === '..' || s === '.')) throw new Error(`Unsafe archive path ${name}`);
  if (!Number.isInteger(mtime) || mtime < 0) throw new Error(`Bad modification time ${mtime}`);
  const full = type === 'dir' ? `${name.replace(/\/+$/, '')}/` : name;
  const [prefix, base] = splitUstarName(full);
  const h = Buffer.alloc(512);
  h.write(base, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii'); // uid
  h.write(octal(0, 8), 116, 'ascii'); // gid
  h.write(octal(type === 'dir' ? 0 : size, 12), 124, 'ascii');
  h.write(octal(mtime, 12), 136, 'ascii');
  h.write('        ', 148, 'ascii'); // checksum, counted as spaces
  h.write(type === 'dir' ? '5' : '0', 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  h.write('root', 265, 32, 'ascii'); // uname
  h.write('root', 297, 32, 'ascii'); // gname
  h.write(octal(0, 8), 329, 'ascii'); // devmajor
  h.write(octal(0, 8), 337, 'ascii'); // devminor
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

/**
 * The uncompressed archive: `top`/ first, then every entry below it. `read(entry)` returns a file's
 * bytes (fs.readFileSync of entry.file by default); a file whose size changed since it was
 * collected is refused.
 */
export function buildTar(entries, { top, mtime, read = (e) => fs.readFileSync(e.file) }) {
  const parts = [ustarHeader({ name: top, type: 'dir', mode: DIR_MODE, mtime })];
  for (const e of entries) {
    const name = `${top}/${e.rel}`;
    if (e.type === 'dir') {
      parts.push(ustarHeader({ name, type: 'dir', mode: DIR_MODE, mtime }));
      continue;
    }
    const body = read(e);
    if (e.size !== undefined && body.length !== e.size) throw new Error(`${e.rel} changed while it was being packed`);
    parts.push(ustarHeader({ name, type: 'file', size: body.length, mode: FILE_MODE, mtime }), body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024)); // end of archive: two zero blocks
  const length = parts.reduce((n, p) => n + p.length, 0);
  const rest = (RECORD_SIZE - (length % RECORD_SIZE)) % RECORD_SIZE;
  if (rest) parts.push(Buffer.alloc(rest));
  return Buffer.concat(parts);
}

/** gzip at level 9 with no time stamp and "Unix" as the OS byte (zlib writes 10 on Windows). */
export function gzipDeterministic(buf) {
  const gz = gzipSync(buf, { level: 9 });
  gz.writeUInt32LE(0, 4); // MTIME (zlib already writes 0)
  gz[9] = 3; // OS: Unix
  return gz;
}

/** The entries of an uncompressed ustar archive (for checks and tests): [{ name, type, mode, uid, gid, uname, gname, size, mtime, body }]. */
export function readTarEntries(tar) {
  const out = [];
  for (let off = 0; off + 512 <= tar.length; ) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (start, len) => {
      const raw = h.subarray(start, start + len);
      const end = raw.indexOf(0);
      return raw.subarray(0, end === -1 ? len : end).toString('utf8');
    };
    const num = (start, len) => parseInt(str(start, len).trim() || '0', 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== num(148, 8)) throw new Error(`Bad header checksum at offset ${off}`);
    const prefix = str(345, 155);
    const name = prefix ? `${prefix}/${str(0, 100)}` : str(0, 100);
    const typeflag = String.fromCharCode(h[156] || 0x30);
    const size = num(124, 12);
    const type = typeflag === '5' ? 'dir' : typeflag === '0' ? 'file' : `type ${typeflag}`;
    out.push({
      name,
      type,
      mode: num(100, 8),
      uid: num(108, 8),
      gid: num(116, 8),
      uname: str(265, 32),
      gname: str(297, 32),
      size,
      mtime: num(136, 12),
      magic: str(257, 6),
      body: Buffer.from(tar.subarray(off + 512, off + 512 + size)),
    });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/**
 * The finished .tar.gz of `distDir` for `version`, with the details pack-node.mjs prints:
 * { name, top, gz, tarLength, entries, skipped, sha256 }. Reads the archive back to check that every
 * entry is under `top`, owned by root and the size of its file.
 */
export function packNodeTarball(distDir, { version, mtime }) {
  const name = nodeTarballName(version);
  const top = topFolder(version);
  const { entries, skipped } = collectNodeFiles(distDir);
  const tar = buildTar(entries, { top, mtime });
  const gz = gzipDeterministic(tar);
  const back = readTarEntries(gunzipSync(gz));
  if (back.length !== entries.length + 1) throw new Error(`The archive has ${back.length} entries, expected ${entries.length + 1}`);
  back.forEach((e, i) => {
    const want = i === 0 ? `${top}/` : `${top}/${entries[i - 1].rel}${entries[i - 1].type === 'dir' ? '/' : ''}`;
    if (e.name !== want || e.uid !== 0 || e.gid !== 0) throw new Error(`Archive entry ${i} is ${e.name} (${e.uid}/${e.gid}), expected ${want} (0/0)`);
    if (i > 0 && entries[i - 1].type === 'file' && e.size !== entries[i - 1].size) throw new Error(`Archive entry ${e.name} has the wrong size`);
  });
  return { name, top, gz, tarLength: tar.length, entries, skipped, sha256: sha256(gz) };
}
