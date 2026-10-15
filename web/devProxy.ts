// Where the Vite dev server (`npm run dev`, `npm run dev:web`) proxies /api.
//
// It follows the API server's own variables, so one environment drives both processes
// (scripts/dev.mjs passes it to each): `PORT=9000 npm run dev` starts the API on 9000 and
// proxies to 9000. LYREN_API_URL overrides it, e.g. for an API running on another machine
// or in Docker: `LYREN_API_URL=http://192.168.1.20:8080 npm run dev:web`.

export const DEFAULT_API_PORT = 8080;

type Env = Record<string, string | undefined>;

/** Wildcard bind addresses: the API is reached through loopback. */
const WILDCARD_HOSTS = new Set(['', '0.0.0.0', '::', '[::]']);

export function apiProxyTarget(env: Env): string {
  const explicit = env.LYREN_API_URL?.trim();
  if (explicit) {
    let url: URL;
    try {
      url = new URL(explicit);
    } catch {
      throw new Error(`LYREN_API_URL must be an http:// or https:// URL (got "${explicit}")`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`LYREN_API_URL must be an http:// or https:// URL (got "${explicit}")`);
    }
    if (url.pathname !== '/' || url.search || url.hash) {
      throw new Error(`LYREN_API_URL is the server's origin, without a path (got "${explicit}")`);
    }
    return url.origin;
  }

  const rawPort = env.PORT?.trim() || String(DEFAULT_API_PORT);
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a port number 1-65535 (got "${rawPort}")`);
  }
  const host = env.HOST?.trim() ?? '';
  const target = WILDCARD_HOSTS.has(host) ? '127.0.0.1' : host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${target}:${port}`;
}
