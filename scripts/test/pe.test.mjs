// PE helpers of scripts/package.mjs, on small synthetic images.
import { describe, expect, it } from 'vitest';
import { certificateTable, PE_MACHINES, peChecksum, peLayout, peMachine, stripAuthenticode, updatePeChecksum } from '../lib/pe.mjs';

/** A minimal PE32+ (or PE32) header block of `size` bytes, optionally followed by a certificate table. */
function fakePe({ size = 1024, pe32 = false, cert = null, after = null } = {}) {
  const buf = Buffer.alloc(size);
  buf.write('MZ', 0, 'latin1');
  buf.writeUInt32LE(0x80, 0x3c);
  buf.writeUInt32LE(0x00004550, 0x80); // "PE\0\0"
  const optional = 0x80 + 24;
  buf.writeUInt16LE(pe32 ? 0x10b : 0x20b, optional);
  buf.writeUInt32LE(16, optional + (pe32 ? 92 : 108));
  for (let i = 0x200; i < size; i++) buf[i] = (i * 7) & 0xff; // some "code"
  if (!cert) return buf;
  const dd = optional + (pe32 ? 96 : 112);
  const out = Buffer.concat([buf, cert, after ?? Buffer.alloc(0)]);
  out.writeUInt32LE(size, dd + 4 * 8);
  out.writeUInt32LE(cert.length, dd + 4 * 8 + 4);
  return out;
}

/** Reference implementation: plain 32-bit sum of 16-bit words, folded once at the end. */
function referenceChecksum(buf, checksumOffset) {
  let sum = 0n;
  for (let i = 0; i + 1 < buf.length; i += 2) if (i !== checksumOffset && i !== checksumOffset + 2) sum += BigInt(buf.readUInt16LE(i));
  if (buf.length % 2) sum += BigInt(buf[buf.length - 1]);
  while (sum > 0xffffn) sum = (sum & 0xffffn) + (sum >> 16n);
  return Number(sum) + buf.length;
}

describe('PE layout', () => {
  it('finds the headers of PE32+ and PE32 images', () => {
    expect(peLayout(fakePe())).toMatchObject({ pe: 0x80, is64: true, checksumOffset: 0x80 + 24 + 64, securityEntry: 0x80 + 24 + 112 + 32 });
    expect(peLayout(fakePe({ pe32: true }))).toMatchObject({ is64: false, securityEntry: 0x80 + 24 + 96 + 32 });
    expect(() => peLayout(Buffer.from('not an exe at all, really not one'.repeat(4)))).toThrow(/Not a PE file/);
    const noSig = fakePe();
    noSig.writeUInt32LE(0, 0x80);
    expect(() => peLayout(noSig)).toThrow(/no PE signature/);
  });

  it('reads the CPU an image is for (package.mjs checks it against the target)', () => {
    const x64 = fakePe();
    x64.writeUInt16LE(0x8664, 0x80 + 4);
    expect(peMachine(x64)).toBe(PE_MACHINES['win-x64']);
    const arm = fakePe();
    arm.writeUInt16LE(0xaa64, 0x80 + 4);
    expect(peMachine(arm)).toBe(PE_MACHINES['win-arm64']);
    expect(() => peMachine(Buffer.from('MZ placeholder'))).toThrow(/Not a PE file/);
  });
});

describe('stripAuthenticode', () => {
  it('cuts the certificate table off and clears its directory entry', () => {
    const cert = Buffer.alloc(296, 0xab);
    const signed = fakePe({ cert });
    expect(certificateTable(signed)).toEqual({ offset: 1024, size: 296 });
    const { data, stripped, removedBytes } = stripAuthenticode(signed);
    expect(stripped).toBe(true);
    expect(removedBytes).toBe(296);
    expect(data.length).toBe(1024);
    expect(certificateTable(data)).toBeNull();
    expect(data.equals(signed.subarray(0, 1024)) ).toBe(false); // the entry was zeroed
    const { securityEntry } = peLayout(data);
    expect(data.readUInt32LE(securityEntry)).toBe(0);
    expect(data.readUInt32LE(securityEntry + 4)).toBe(0);
    expect(signed.length).toBe(1320); // input untouched
  });

  it('leaves unsigned images alone and refuses odd layouts', () => {
    const plain = fakePe();
    const r = stripAuthenticode(plain);
    expect(r).toMatchObject({ stripped: false, removedBytes: 0 });
    expect(r.data.equals(plain)).toBe(true);
    expect(() => stripAuthenticode(fakePe({ cert: Buffer.alloc(64, 1), after: Buffer.from('trailing data') }))).toThrow(/after the certificate table/);
    const bad = fakePe({ cert: Buffer.alloc(64, 1) });
    bad.writeUInt32LE(9999, peLayout(bad).securityEntry + 4);
    expect(() => stripAuthenticode(bad)).toThrow(/past the end/);
  });
});

describe('PE checksum', () => {
  it('matches the reference algorithm, ignores the old value, and is written in place', () => {
    for (const size of [1024, 1025, 4097]) {
      const buf = fakePe({ size });
      const { checksumOffset } = peLayout(buf);
      expect(peChecksum(buf)).toBe(referenceChecksum(buf, checksumOffset));
      buf.writeUInt32LE(0xdeadbeef, checksumOffset);
      expect(peChecksum(buf)).toBe(referenceChecksum(buf, checksumOffset));
      const sum = updatePeChecksum(buf);
      expect(buf.readUInt32LE(checksumOffset)).toBe(sum);
      expect(peChecksum(buf)).toBe(sum);
    }
  });
});
