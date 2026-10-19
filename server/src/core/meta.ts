// TrustedMeta on the wire (design §2.2, §10.2): the Cloudflare Worker deletes any x-lyren-meta header
// a client sent and sets its own, base64url(JSON(meta)); the Durable Object decodes it. The header is
// trustworthy because Durable Objects are reachable only through the Worker's bindings. Decoding
// still validates every field, so a malformed value is refused rather than half-used.

import { fromBase64Url, toBase64Url } from './crypto';
import type { TrustedMeta } from './ports';

export const META_HEADER = 'x-lyren-meta';

/** Longest header value decodeMeta accepts (a real one is a few hundred characters). */
const MAX_ENCODED = 2048;

const KEYS = ['clientIp', 'secure', 'requestId', 'userAgent', 'sessionTokenHash', 'sessionCookie'] as const;

export function encodeMeta(meta: TrustedMeta): string {
  const plain: TrustedMeta = {
    clientIp: meta.clientIp,
    secure: meta.secure,
    requestId: meta.requestId,
    userAgent: meta.userAgent,
    sessionTokenHash: meta.sessionTokenHash,
    sessionCookie: meta.sessionCookie,
  };
  if (!isTrustedMeta(plain)) throw new Error('Invalid TrustedMeta');
  return toBase64Url(new TextEncoder().encode(JSON.stringify(plain)));
}

/** The meta in a header value, or null when it is missing or not exactly a valid TrustedMeta. */
export function decodeMeta(value: string | null | undefined): TrustedMeta | null {
  if (!value || value.length > MAX_ENCODED || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(fromBase64Url(value)));
  } catch {
    return null;
  }
  return isTrustedMeta(parsed) ? parsed : null;
}

function isTrustedMeta(v: unknown): v is TrustedMeta {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  if (Object.keys(m).some((k) => !(KEYS as readonly string[]).includes(k))) return false;
  const nullableString = (x: unknown, max: number) => x === null || (typeof x === 'string' && x.length <= max);
  return (
    typeof m.clientIp === 'string' &&
    m.clientIp.length <= 100 &&
    typeof m.secure === 'boolean' &&
    typeof m.requestId === 'string' &&
    m.requestId.length > 0 &&
    m.requestId.length <= 100 &&
    nullableString(m.userAgent, 300) &&
    (m.sessionTokenHash === null ||
      (typeof m.sessionTokenHash === 'string' && /^[0-9a-f]{64}$/.test(m.sessionTokenHash))) &&
    (m.sessionCookie === null || m.sessionCookie === 'host' || m.sessionCookie === 'plain') &&
    (m.sessionTokenHash === null) === (m.sessionCookie === null)
  );
}
