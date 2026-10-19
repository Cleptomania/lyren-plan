// The ustar files of the backup sets (design §9.5), written and read here: regular files and folders
// only, names under 100 bytes, mode 0600 (folders 0700), uid and gid 0, one mtime for every entry, and
// the end of the archive (two empty blocks). `tar -xf` (GNU tar, bsdtar, Windows' tar.exe) reads them.
// Files are copied in chunks, so a large database never sits in memory.
//
// The reader is for archives from anywhere (a restore), so it is strict: a header must carry the ustar
// magic and a correct checksum; an entry must be a regular file or a folder (no links, devices, FIFOs or
// pax and GNU extension headers) with a relative name of plain segments (no absolute path, `.`, `..`,
// backslash or control characters), each name at most once; a size must be plain octal, within the
// caller's bound and inside the file; and the archive must end with its empty blocks. What the names may
// be is the caller's (backupSet.ts allows the manifest's).

import fs from 'node:fs';

/** The largest file a backup can hold: anything this large is refused. */
export const TAR_MAX_FILE_BYTES = 8 * 1024 ** 3;

export interface TarEntry {
  /** The name in the archive: relative, '/'-separated, without `.` or `..` segments, under 100 bytes. */
  name: string;
  /** The file whose content the entry holds; omit both for a folder. */
  file?: string;
  /** The content itself (a small file, such as a manifest). */
  data?: Uint8Array;
}

/** An entry the reader found: its name (a folder without the trailing '/') and where its content is. */
export interface TarItem {
  name: string;
  type: 'file' | 'dir';
  size: number;
  /** The content's offset in the archive. */
  offset: number;
}

/** The archive is not one this reader accepts (malformed, truncated, or with an entry of another kind). */
export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarError';
  }
}

const BLOCK = 512;
const CHUNK = 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const MAGIC = 'ustar\u000000';

/** One octal field of `width` bytes: digits padded with zeros, then NUL. */
function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

/** The checksum of a header: its bytes summed, with the checksum field counted as spaces. */
function checksum(block: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  return sum;
}

function header(name: string, o: { size: number; dir: boolean; mtime: number }): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const put = (offset: number, text: string) => block.set(new TextEncoder().encode(text), offset);
  put(0, o.dir ? `${name}/` : name);
  put(100, octal(o.dir ? 0o700 : 0o600, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, octal(o.size, 12));
  put(136, octal(o.mtime, 12));
  put(156, o.dir ? '5' : '0');
  put(257, MAGIC);
  put(148, `${checksum(block).toString(8).padStart(6, '0')}\0 `);
  return block;
}

/** A name of plain segments (see the header), or null. */
function plainName(name: string): string | null {
  return NAME_RE.test(name) && !name.split('/').some((s) => s === '.' || s === '..') ? name : null;
}

function checkName(name: string, dir: boolean): void {
  const bytes = new TextEncoder().encode(dir ? `${name}/` : name).length;
  if (plainName(name) === null || bytes >= 100) throw new Error(`Not a name a backup can hold: ${name}`);
}

/**
 * Write `entries` to a new file `target` (refused when it exists), owner-only, flushed to the disk.
 * Returns its size in bytes. A file of TAR_MAX_FILE_BYTES or more is refused, as is a file that changes
 * size while it is copied. A failure removes `target`.
 */
export function writeTar(target: string, entries: readonly TarEntry[], o: { mtime: Date }): number {
  const mtime = Math.floor(o.mtime.getTime() / 1000);
  const out = fs.openSync(target, 'wx', 0o600);
  let written = 0;
  const write = (bytes: Uint8Array) => {
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(out, bytes, offset, bytes.length - offset);
    written += bytes.length;
  };
  const pad = (size: number) => {
    if (size % BLOCK !== 0) write(new Uint8Array(BLOCK - (size % BLOCK)));
  };
  try {
    for (const entry of entries) {
      const dir = entry.file === undefined && entry.data === undefined;
      checkName(entry.name, dir);
      if (dir) {
        write(header(entry.name, { size: 0, dir, mtime }));
        continue;
      }
      if (entry.data !== undefined) {
        write(header(entry.name, { size: entry.data.length, dir, mtime }));
        write(entry.data);
        pad(entry.data.length);
        continue;
      }
      const input = fs.openSync(entry.file!, 'r');
      try {
        const size = fs.fstatSync(input).size;
        if (size >= TAR_MAX_FILE_BYTES) {
          throw new Error(`${entry.file} is too large for a backup (8 GiB or more): copy the files while Lyren Plan is stopped instead`);
        }
        write(header(entry.name, { size, dir, mtime }));
        const buffer = new Uint8Array(CHUNK);
        let copied = 0;
        for (;;) {
          const n = fs.readSync(input, buffer, 0, CHUNK, copied);
          if (n === 0) break;
          copied += n;
          if (copied > size) break;
          write(buffer.subarray(0, n));
        }
        if (copied !== size) throw new Error(`${entry.file} changed while it was copied into the backup`);
        pad(size);
      } finally {
        fs.closeSync(input);
      }
    }
    // The end of the archive: two empty blocks.
    write(new Uint8Array(2 * BLOCK));
    fs.fsyncSync(out);
  } catch (err) {
    fs.closeSync(out);
    fs.rmSync(target, { force: true });
    throw err;
  }
  fs.closeSync(out);
  return written;
}

/** A header field up to its first NUL, as text; non-ASCII bytes are kept (and then refused by the name rule). */
function field(block: Uint8Array, offset: number, length: number): string {
  const bytes = block.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return Buffer.from(end === -1 ? bytes : bytes.subarray(0, end)).toString('latin1');
}

/** A numeric field: octal digits, optionally padded with leading spaces and ended by NUL or spaces. */
function number(block: Uint8Array, offset: number, length: number, what: string): number {
  const text = Buffer.from(block.subarray(offset, offset + length)).toString('latin1');
  const m = /^ *([0-7]{1,12})[ \0]*$/.exec(text);
  if (!m) throw new TarError(`The ${what} of an entry is not a plain octal number`);
  return parseInt(m[1]!, 8);
}

function readBlock(fd: number, position: number): Uint8Array {
  const block = new Uint8Array(BLOCK);
  let read = 0;
  while (read < BLOCK) {
    const n = fs.readSync(fd, block, read, BLOCK - read, position + read);
    if (n === 0) break;
    read += n;
  }
  if (read < BLOCK) throw new TarError('The archive is truncated');
  return block;
}

const isZero = (block: Uint8Array) => block.every((b) => b === 0);

export interface TarListOptions {
  /** The largest content an entry may have, by its name (default TAR_MAX_FILE_BYTES - 1). */
  maxBytes?: (name: string) => number;
  /** The most entries the archive may have. */
  maxEntries: number;
}

/** The entries of the archive `file`, checked as the header describes. Throws TarError. */
export function listTar(file: string, o: TarListOptions): TarItem[] {
  const fd = fs.openSync(file, 'r');
  try {
    const length = fs.fstatSync(fd).size;
    if (length % BLOCK !== 0) throw new TarError('The archive is truncated');
    const items: TarItem[] = [];
    const names = new Set<string>();
    let at = 0;
    for (;;) {
      if (at + BLOCK > length) throw new TarError('The archive is truncated (it has no end)');
      const block = readBlock(fd, at);
      if (isZero(block)) break;
      if (Buffer.from(block.subarray(257, 265)).toString('latin1') !== MAGIC) throw new TarError('An entry is not in the ustar format');
      if (number(block, 148, 8, 'checksum') !== checksum(block)) throw new TarError('An entry has a wrong checksum');
      const type = String.fromCharCode(block[156]!);
      if (type !== '0' && type !== '\0' && type !== '5') {
        throw new TarError('The archive holds something other than files and folders (a link, a device or an extension header)');
      }
      const prefix = field(block, 345, 155);
      const raw = `${prefix ? `${prefix}/` : ''}${field(block, 0, 100)}`;
      const dir = type === '5';
      const name = plainName(dir ? raw.replace(/\/$/, '') : raw);
      if (name === null) throw new TarError(`The archive holds a name that is not allowed: ${JSON.stringify(raw)}`);
      if (names.has(name)) throw new TarError(`The archive holds ${name} twice`);
      names.add(name);
      if (items.length >= o.maxEntries) throw new TarError('The archive holds too many entries');
      const size = number(block, 124, 12, 'size');
      if (dir && size !== 0) throw new TarError(`The folder ${name} has a size`);
      const max = o.maxBytes?.(name) ?? TAR_MAX_FILE_BYTES - 1;
      if (size > max) throw new TarError(`The archive's ${name} is too large (${size} bytes)`);
      const offset = at + BLOCK;
      const end = offset + Math.ceil(size / BLOCK) * BLOCK;
      if (end > length) throw new TarError(`The archive is truncated (in ${name})`);
      items.push({ name, type: dir ? 'dir' : 'file', size, offset });
      at = end;
    }
    // The end: the empty blocks, and nothing else after them.
    if (at + 2 * BLOCK > length) throw new TarError('The archive is truncated (its end is missing)');
    for (let rest = at; rest < length; rest += BLOCK) {
      if (!isZero(readBlock(fd, rest))) throw new TarError('The archive has data after its end');
    }
    return items;
  } finally {
    fs.closeSync(fd);
  }
}

/** The content of a (small) file entry of `file`. */
export function readTarItem(file: string, item: TarItem): Uint8Array {
  const fd = fs.openSync(file, 'r');
  try {
    const data = new Uint8Array(item.size);
    let read = 0;
    while (read < item.size) {
      const n = fs.readSync(fd, data, read, item.size - read, item.offset + read);
      if (n === 0) throw new TarError(`The archive is truncated (in ${item.name})`);
      read += n;
    }
    return data;
  } finally {
    fs.closeSync(fd);
  }
}

/** Copy a file entry of `file` to the new file `target` (0600), in chunks, flushed to the disk. */
export function extractTarItem(file: string, item: TarItem, target: string): void {
  const input = fs.openSync(file, 'r');
  try {
    const out = fs.openSync(target, 'wx', 0o600);
    try {
      const buffer = new Uint8Array(CHUNK);
      let copied = 0;
      while (copied < item.size) {
        const n = fs.readSync(input, buffer, 0, Math.min(CHUNK, item.size - copied), item.offset + copied);
        if (n === 0) throw new TarError(`The archive is truncated (in ${item.name})`);
        let offset = 0;
        while (offset < n) offset += fs.writeSync(out, buffer, offset, n - offset);
        copied += n;
      }
      fs.fsyncSync(out);
    } finally {
      fs.closeSync(out);
    }
  } finally {
    fs.closeSync(input);
  }
}
