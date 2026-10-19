// Who sent a request, on Node (design §2.2): the client address and whether the browser's request was
// HTTPS, by today's TRUST_PROXY and COOKIE_SECURE rules (moved from auth/middleware.ts). The gateway
// (gateway/app.ts) puts both into the TrustedMeta. Cloudflare has its own rule (CF-Connecting-IP,
// runtime/cloudflare/worker.ts).

import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Config } from '../../config';

/** Longest client address kept (TrustedMeta.clientIp). */
const MAX_IP_LENGTH = 100;

/**
 * Client address, or '' when unknown. With TRUST_PROXY the RIGHTMOST X-Forwarded-For entry is used:
 * it is the one appended by the (trusted) reverse proxy, while entries to its left are
 * client-controlled.
 */
export function clientIp(c: Context, trustProxy: boolean): string {
  let ip = '';
  if (trustProxy) {
    const xff = c.req.header('x-forwarded-for');
    ip =
      xff
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .at(-1) ??
      c.req.header('x-real-ip')?.trim() ??
      '';
  }
  if (!ip) {
    try {
      ip = getConnInfo(c).remote.address ?? '';
    } catch {
      // Not served by @hono/node-server (app.request in tests): unknown.
    }
  }
  return ip.slice(0, MAX_IP_LENGTH);
}

/**
 * Whether the browser's request was HTTPS: COOKIE_SECURE true or false forces it; 'auto' looks at
 * X-Forwarded-Proto (with TRUST_PROXY) or else the request's own scheme.
 */
export function isSecureRequest(c: Context, cookieSecure: 'auto' | boolean, trustProxy: boolean): boolean {
  if (cookieSecure !== 'auto') return cookieSecure;
  if (trustProxy) {
    const proto = c.req.header('x-forwarded-proto');
    if (proto) return proto.split(',')[0]!.trim().toLowerCase() === 'https';
  }
  return new URL(c.req.url).protocol === 'https:';
}

/** The connection facts the gateway needs, by the Node configuration. */
export function nodeConnection(config: Pick<Config, 'trustProxy' | 'cookieSecure'>) {
  return (c: Context): { clientIp: string; secure: boolean } => ({
    clientIp: clientIp(c, config.trustProxy),
    secure: isSecureRequest(c, config.cookieSecure, config.trustProxy),
  });
}
