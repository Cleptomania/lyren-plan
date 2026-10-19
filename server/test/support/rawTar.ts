// Tar archives built byte by byte for the strict reader's tests (runtime/node/tar.ts, backupSet.ts and
// restore.ts): any name, type, magic, size field or prefix, a corrupted header, a missing end or data
// after it, which the archive writer would never produce.

export interface RawEntry {
  name: string;
  data?: Uint8Array;
  type?: string;
  /** Overrides of header bytes after the checksum is computed (a corrupted header). */
  corrupt?: (block: Uint8Array) => void;
  magic?: string;
  prefix?: string;
  size?: number;
  /** The size field as written (a malformed one). */
  sizeText?: string;
}

export function rawTar(entries: RawEntry[], o: { end?: boolean; trailing?: Uint8Array } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const block = Buffer.alloc(512);
    const data = e.data ?? new Uint8Array();
    block.write(e.name, 0, 'latin1');
    block.write('0000600\0', 100);
    block.write('0000000\0', 108);
    block.write('0000000\0', 116);
    block.write(e.sizeText ?? `${(e.size ?? data.length).toString(8).padStart(11, '0')}\0`, 124, 'latin1');
    block.write('00000000000\0', 136);
    block.write(e.type ?? '0', 156);
    block.write(e.magic ?? 'ustar\u000000', 257, 'latin1');
    if (e.prefix) block.write(e.prefix, 345);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
    block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    e.corrupt?.(block);
    parts.push(block, Buffer.from(data), Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  if (o.end !== false) parts.push(Buffer.alloc(1024));
  if (o.trailing) parts.push(Buffer.from(o.trailing));
  return Buffer.concat(parts);
}
