// Addresses the desktop app prints and opens.

import { SETUP_CODE_FRAGMENT_PARAM } from '@shared/constants';

const WILDCARDS = new Set(['', '0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0']);

/** Host to put in a browser URL for a server bound to `host` (a wildcard becomes 127.0.0.1). */
export function browserHost(host: string): string {
  const h = host.trim();
  if (WILDCARDS.has(h)) return '127.0.0.1';
  if (h.includes(':') && !h.startsWith('[')) return `[${h}]`; // IPv6 literal
  return h;
}

/** The address the browser connects to for a server bound to `host`, without URL brackets. */
export function connectHost(host: string): string {
  return browserHost(host).replace(/^\[(.*)\]$/, '$1');
}

/** The app's address on this computer, e.g. http://127.0.0.1:43770/ */
export function appUrl(host: string, port: number): string {
  return new URL(`http://${browserHost(host)}:${port}/`).href;
}

/**
 * The setup page with the setup code in the fragment (never in the query string, which would
 * reach the server log and Referer headers). SetupPage removes it from the address bar.
 */
export function setupUrl(base: string, code: string): string {
  const url = new URL('/setup', base);
  url.hash = `${SETUP_CODE_FRAGMENT_PARAM}=${encodeURIComponent(code)}`;
  return url.href;
}

/**
 * Where to open the browser. While no account exists that is the setup page, with the setup code
 * filled in (setupUrl) on Windows only: on Linux and macOS every local user can read a program's
 * command line (/proc/<pid>/cmdline, ps), and so the URL handed to xdg-open / open and to a newly
 * started browser; there the code stays in the console window, which only its user sees.
 */
export function browserTarget(options: {
  platform: NodeJS.Platform;
  url: string;
  setupRequired: boolean;
  setupCode: string | null;
}): { url: string; codeFilledIn: boolean } {
  const { platform, url, setupRequired, setupCode } = options;
  if (!setupRequired) return { url, codeFilledIn: false };
  if (platform === 'win32' && setupCode) return { url: setupUrl(url, setupCode), codeFilledIn: true };
  return { url: new URL('/setup', url).href, codeFilledIn: false };
}

export interface NetworkAddress {
  address: string;
  family: string | number;
  internal: boolean;
}

/**
 * Addresses other devices on the network can use when the server listens on every interface
 * (HOST=0.0.0.0): the machine's private IPv4 addresses (no loopback, no 169.254 link-local).
 */
export function lanUrls(host: string, port: number, interfaces: Record<string, NetworkAddress[] | undefined>): string[] {
  if (!WILDCARDS.has(host.trim())) return [];
  const urls: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const a of list ?? []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal || a.address.startsWith('169.254.')) continue;
      urls.push(`http://${a.address}:${port}/`);
    }
  }
  return [...new Set(urls)];
}
