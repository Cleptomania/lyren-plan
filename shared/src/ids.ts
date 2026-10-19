// Space ids (design §4.2): 16 characters of lower-case Crockford base32 encoding 80 random bits. They
// name a space's database file on Node and its Durable Object on Cloudflare, and appear in URLs
// (/api/s/<id>/…, /s/<id>/…). Lower case only, so file names are safe on case-insensitive disks. They
// are unguessable, which makes enumeration pointless, but authorization never depends on that.

/** Crockford base32 without i, l, o and u. */
export const SPACE_ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** A space id: 16 characters of SPACE_ID_ALPHABET. */
export const SPACE_ID_RE = /^[0-9a-hjkmnp-tv-z]{16}$/;

/** A new random space id (crypto.getRandomValues); `bytes` (exactly 10) is for tests. */
export function generateSpaceId(bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(10))): string {
  if (bytes.length !== 10) throw new Error('A space id encodes exactly 10 bytes');
  let id = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      id += SPACE_ID_ALPHABET[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return id;
}

export function isSpaceId(value: unknown): value is string {
  return typeof value === 'string' && SPACE_ID_RE.test(value);
}
