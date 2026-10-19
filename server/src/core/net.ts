// Rate-limit keys for client addresses (design §5.9): limiterKey groups a subscriber's addresses
// (moved unchanged from auth/rateLimit.ts), netKey the wider allocation around them, for clients
// that rotate addresses. The address checks are the expressions of Node's net.isIPv4 and net.isIPv6
// (lib/internal/net.js), so that node:net stays out of the Worker (design §14.6) and both runtimes
// decide alike; server/test/core.net.test.ts compares them with node:net.

const V4_SEG = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])';
const V4_STR = `(?:${V4_SEG}\\.){3}${V4_SEG}`;
const IPV4 = new RegExp(`^${V4_STR}$`);
const V6_SEG = '(?:[0-9a-fA-F]{1,4})';
const IPV6 = new RegExp(
  '^(?:' +
    `(?:${V6_SEG}:){7}(?:${V6_SEG}|:)|` +
    `(?:${V6_SEG}:){6}(?:${V4_STR}|:${V6_SEG}|:)|` +
    `(?:${V6_SEG}:){5}(?::${V4_STR}|(?::${V6_SEG}){1,2}|:)|` +
    `(?:${V6_SEG}:){4}(?:(?::${V6_SEG}){0,1}:${V4_STR}|(?::${V6_SEG}){1,3}|:)|` +
    `(?:${V6_SEG}:){3}(?:(?::${V6_SEG}){0,2}:${V4_STR}|(?::${V6_SEG}){1,4}|:)|` +
    `(?:${V6_SEG}:){2}(?:(?::${V6_SEG}){0,3}:${V4_STR}|(?::${V6_SEG}){1,5}|:)|` +
    `(?:${V6_SEG}:){1}(?:(?::${V6_SEG}){0,4}:${V4_STR}|(?::${V6_SEG}){1,6}|:)|` +
    `(?::(?:(?::${V6_SEG}){0,5}:${V4_STR}|(?::${V6_SEG}){1,7}|:))` +
    ')(?:%[0-9a-zA-Z-.:]{1,})?$',
);

/** Node's net.isIPv4. */
export const isIPv4 = (s: string): boolean => IPV4.test(s);
/** Node's net.isIPv6 (a zone id allowed). */
export const isIPv6 = (s: string): boolean => IPV6.test(s);

/** Expand a valid IPv6 address (no zone id) to its 8 hextets, as numbers. */
function ipv6Groups(ip: string): number[] {
  let s = ip;
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = s.split('::');
  const parse = (part: string) => (part ? part.split(':').map((g) => parseInt(g, 16)) : []);
  const h = parse(head);
  if (tail === undefined) return h;
  const t = parse(tail);
  return [...h, ...Array<number>(8 - h.length - t.length).fill(0), ...t];
}

/**
 * The rate-limit key for a client address. One IPv6 subscriber usually controls a whole /64
 * (2^64 addresses), so IPv6 addresses are grouped by their /64 network; IPv4-mapped IPv6
 * addresses (`::ffff:192.0.2.1`) count as the plain IPv4 address. Anything else (IPv4, or an
 * unparseable value such as 'unknown') is used as-is.
 */
export function limiterKey(ip: string): string {
  let s = ip.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  s = s.replace(/%.*$/, ''); // zone id (fe80::1%eth0)
  if (!isIPv6(s)) return ip;
  const groups = ipv6Groups(s.toLowerCase());
  if (groups.length !== 8) return ip;
  // IPv4-mapped: 0:0:0:0:0:ffff:x:y
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [hi, lo] = [groups[6]!, groups[7]!];
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

/**
 * The coarse key for a client address: its IPv6 /48 or IPv4 /24 (`2001:db8:1::/48`,
 * `192.0.2.0/24`); IPv4-mapped IPv6 addresses count as IPv4. Anything else is used as-is, like
 * limiterKey.
 */
export function netKey(ip: string): string {
  const key = limiterKey(ip.trim());
  if (isIPv4(key)) return `${key.split('.').slice(0, 3).join('.')}.0/24`;
  const v6 = /^([0-9a-f]+):([0-9a-f]+):([0-9a-f]+):[0-9a-f]+::\/64$/.exec(key);
  return v6 ? `${v6[1]}:${v6[2]}:${v6[3]}::/48` : key;
}
