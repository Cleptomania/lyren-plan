// Hashing, random tokens and byte encodings for both runtimes (node:crypto works in workerd with
// nodejs_compat). Code that also compiles for the Worker (tsconfig.worker.json) encodes bytes with
// the helpers here rather than Buffer#toString(encoding): @cloudflare/workers-types declares a global
// `Buffer: any`, which hides @types/node's Buffer methods from the type checker there.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** Standard base64 with padding (what Buffer#toString('base64') gives). */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** base64url without padding (what Buffer#toString('base64url') gives). */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Bytes of a base64url (or base64) text; throws on characters outside the alphabet. */
export function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** sha256 of the UTF-8 text, as lower-case hex (how session and email tokens are stored). */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** `bytes` random bytes as base64url: 32 bytes (the default) give 43 characters, 256 bits. */
export function randomToken(bytes = 32): string {
  return toBase64Url(randomBytes(bytes));
}

/** Constant-time string comparison; hashing first makes the time independent of both lengths. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
