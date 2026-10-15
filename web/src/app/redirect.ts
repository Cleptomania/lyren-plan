// Where to go after signing in: the in-app path the signed-out user originally asked for.

/**
 * `from` as a same-origin in-app path (pathname + search + hash), or '/' when it is anything
 * else. A protocol-relative value such as '//evil.example/x' (a crafted link like
 * https://host//evil.example/x) must never reach navigate(): React Router throws on external
 * targets, which would crash the login page.
 */
export function safeRedirectPath(from: unknown, origin: string = window.location.origin): string {
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//') || from.startsWith('/\\')) return '/';
  let url: URL;
  try {
    url = new URL(from, origin);
  } catch {
    return '/';
  }
  // Dot segments can still resolve to a '//host' pathname (e.g. '/..//evil.example').
  if (url.origin !== origin || url.pathname.startsWith('//')) return '/';
  return url.pathname + url.search + url.hash;
}
