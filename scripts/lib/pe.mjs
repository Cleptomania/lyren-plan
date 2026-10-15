// Minimal Portable Executable (Windows .exe) helpers for scripts/package.mjs: locate the
// headers, remove an Authenticode signature, and recompute the PE checksum. Pure functions on
// Buffers, unit-tested in scripts/test/pe.test.mjs.
//
// Layout (Microsoft PE/COFF specification):
//   0x3C                    e_lfanew: file offset of the "PE\0\0" signature
//   PE + 4                  COFF file header (20 bytes)
//   PE + 24                 optional header: magic 0x10B (PE32) or 0x20B (PE32+)
//   optional + 64           CheckSum (uint32)
//   optional + 92 / 108     NumberOfRvaAndSizes (PE32 / PE32+)
//   optional + 96 / 112     data directories, 8 bytes each; index 4 = certificate table, whose
//                           "address" is a FILE offset (not an RVA) and which sits at the end of
//                           the file, outside every section.

const CERTIFICATE_TABLE = 4;

/** Header offsets of a PE image, or an Error explaining why `buf` is not one. */
export function peLayout(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) throw new Error('Not a PE file (no MZ header)');
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) throw new Error('Not a PE file (no PE signature)');
  const optional = pe + 24;
  const magic = buf.readUInt16LE(optional);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error(`Unknown optional header magic 0x${magic.toString(16)}`);
  const plus = magic === 0x20b;
  const numberOfRvaAndSizes = buf.readUInt32LE(optional + (plus ? 108 : 92));
  const dataDirectories = optional + (plus ? 112 : 96);
  return {
    pe,
    optional,
    is64: plus,
    checksumOffset: optional + 64,
    dataDirectories,
    numberOfRvaAndSizes,
    /** Offset of the certificate-table directory entry, or null when the header has none. */
    securityEntry: numberOfRvaAndSizes > CERTIFICATE_TABLE ? dataDirectories + CERTIFICATE_TABLE * 8 : null,
  };
}

/** The COFF header's Machine field of each Windows target (IMAGE_FILE_MACHINE_AMD64 / _ARM64). */
export const PE_MACHINES = { 'win-x64': 0x8664, 'win-arm64': 0xaa64 };

/** The CPU a PE image is for: its COFF header's Machine field (see PE_MACHINES). */
export function peMachine(buf) {
  const { pe } = peLayout(buf);
  return buf.readUInt16LE(pe + 4);
}

/** The certificate table's {offset, size} (file offsets), or null when the image is unsigned. */
export function certificateTable(buf) {
  const { securityEntry } = peLayout(buf);
  if (securityEntry === null) return null;
  const offset = buf.readUInt32LE(securityEntry);
  const size = buf.readUInt32LE(securityEntry + 4);
  if (offset === 0 || size === 0) return null;
  return { offset, size };
}

/**
 * Remove the Authenticode signature: clear the certificate-table directory entry and cut the
 * table off the end of the file. Injecting into a signed image would leave an invalid signature,
 * which is worse than none. Returns a new Buffer.
 */
export function stripAuthenticode(buf) {
  const table = certificateTable(buf);
  if (!table) return { data: Buffer.from(buf), stripped: false, removedBytes: 0 };
  const { offset, size } = table;
  if (offset + size > buf.length) throw new Error('Certificate table extends past the end of the file');
  // Anything after the table would be unusual; refuse rather than silently dropping data.
  if (buf.subarray(offset + size).some((b) => b !== 0)) throw new Error('Unexpected data after the certificate table');
  const { securityEntry } = peLayout(buf);
  const out = Buffer.from(buf.subarray(0, offset));
  out.writeUInt32LE(0, securityEntry);
  out.writeUInt32LE(0, securityEntry + 4);
  return { data: out, stripped: true, removedBytes: buf.length - offset };
}

/**
 * The PE checksum as computed by imagehlp's CheckSumMappedFile: the one's-complement style sum
 * of all 16-bit little-endian words with the CheckSum field taken as zero, folded to 16 bits,
 * plus the file length.
 */
export function peChecksum(buf) {
  const { checksumOffset } = peLayout(buf);
  let sum = 0;
  const words = Math.floor(buf.length / 2);
  for (let i = 0; i < words; i++) {
    const off = i * 2;
    if (off === checksumOffset || off === checksumOffset + 2) continue;
    sum += buf.readUInt16LE(off);
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  if (buf.length % 2) {
    sum += buf[buf.length - 1];
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  sum = (sum & 0xffff) + (sum >>> 16);
  return (sum + buf.length) >>> 0;
}

/** Write the correct checksum into the header (in place). Returns it. */
export function updatePeChecksum(buf) {
  const sum = peChecksum(buf);
  buf.writeUInt32LE(sum, peLayout(buf).checksumOffset);
  return sum;
}
