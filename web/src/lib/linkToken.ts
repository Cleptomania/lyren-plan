// The token of an emailed or copied link (design §5.7, §12.7, §13.7): /signup/complete, /reset,
// /email/confirm and /invite carry it in the fragment, `#t=<token>`, which no request ever sends (and no
// Referer carries). It is taken out of the address bar before the router reads the address
// (takeLinkTokenFromAddress, app/App.tsx) and kept here, in memory only, for the page of that path: a
// reload or a bookmark no longer holds it, and nothing the page renders or asks for afterwards can leak it.
// A link opened inside the app (an in-app navigation to such a path) is taken by useLinkToken the same way.
// Pure but for the module's memory, so the handling is unit-tested (linkToken.test.ts).

/** The fragment parameter of a link's token (the server builds `/invite#t=…`). */
export const LINK_TOKEN_PARAM = 't';

/** The pages a link with a token opens. */
export const LINK_TOKEN_PAGES = ['/signup/complete', '/reset', '/email/confirm', '/invite'] as const;

/** The longest token taken (the server's are 43 characters; tokenInput allows 200). */
const MAX_TOKEN = 200;

function params(hash: string): URLSearchParams {
  return new URLSearchParams(hash.replace(/^#/, ''));
}

/** '/invite/' → '/invite'. */
function pagePath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

export function isLinkTokenPage(pathname: string): boolean {
  return (LINK_TOKEN_PAGES as readonly string[]).includes(pagePath(pathname));
}

/** The token in `hash` ('#t=…'), or null. */
export function linkTokenFromHash(hash: string): string | null {
  const token = params(hash).get(LINK_TOKEN_PARAM)?.trim();
  return token ? token.slice(0, MAX_TOKEN) : null;
}

/** `hash` without the token: '' when nothing else is left, else '#…'. */
export function hashWithoutLinkToken(hash: string): string {
  const p = params(hash);
  p.delete(LINK_TOKEN_PARAM);
  const rest = p.toString();
  return rest ? `#${rest}` : '';
}

export interface AddressParts {
  pathname: string;
  search: string;
  hash: string;
}

// The token taken last, and the page it belongs to.
let held: { path: string; token: string } | null = null;

/**
 * Take the token out of `address` when it is a token page's: kept for that page, and the address
 * without it handed to `replace` (history.replaceState). Returns whether a token was taken.
 */
export function takeLinkToken(address: AddressParts, replace: (url: string) => void): boolean {
  if (!isLinkTokenPage(address.pathname)) return false;
  const token = linkTokenFromHash(address.hash);
  if (token === null) return false;
  held = { path: pagePath(address.pathname), token };
  replace(`${address.pathname}${address.search}${hashWithoutLinkToken(address.hash)}`);
  return true;
}

/** The token held for the page at `pathname`, or null (none, or another page's). */
export function heldLinkToken(pathname: string): string | null {
  return held !== null && held.path === pagePath(pathname) ? held.token : null;
}

/** Keep `token` for the page at `path` (a link the app was handed, such as a recovery's reset link). */
export function holdLinkToken(path: string, token: string): void {
  held = { path: pagePath(path), token };
}

/** The link was used (or its page left for good): nothing holds its token any more. */
export function forgetLinkToken(): void {
  held = null;
}

/** At start, before the router reads the address: the page's link token leaves the address bar. */
export function takeLinkTokenFromAddress(): void {
  if (typeof window === 'undefined') return;
  takeLinkToken(window.location, (url) => window.history.replaceState(window.history.state, '', url));
}
