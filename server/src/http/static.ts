// Serves the built single-page app with SPA fallback, from one of two sources:
// - diskSource(webDir): the dist/web folder (the Node and Docker builds, and WEB_DIR);
// - memorySource(files): files held in memory, e.g. the web client embedded in the single-file
//   desktop app (desktop/assets.ts).
// The HTTP rules are the same for both: hashed files under /assets/ are cached forever, everything
// else revalidates; text files are gzip-compressed once in memory and served when the client
// accepts it; HEAD answers with GET's headers; unknown extension-less paths get index.html.
// A source may give its files an entity tag (the embedded client does: its content is fixed at
// build time), which is then sent as ETag and honoured in If-None-Match (304).
//
// The disk source re-validates unhashed files (index.html, sw.js, ...) by mtime so a rebuild is
// picked up without restarting the server.
//
// Without a built client (no index.html: an interrupted build, only dist/server.mjs copied, a
// wrong WEB_DIR) app routes get a short 503 page that says so instead of a bare "Not found";
// startServer logs the folder it looked in.
//
// This runs before authentication, so the in-memory cache must stay bounded: only canonical
// request paths (no `//`, `.`/`..` segments or backslashes after percent-decoding) are looked
// up, and the disk cache is keyed by the resolved absolute file path. It can therefore hold at
// most one entry per real file in webDir, however many URL spellings a client invents. On
// case-insensitive file systems (Windows, macOS) the key is case-folded, and on Windows paths that
// the file system would silently rewrite (a trailing dot or space in a segment, `:` for an
// alternate data stream, `~` of an 8.3 short name such as ACCOUN~1.JS) are not looked up at all,
// so neither can create aliases either.

import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import type { MiddlewareHandler } from 'hono';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.txt', '.map']);

const IMMUTABLE = 'public, max-age=31536000, immutable';

/** One servable file. */
export interface StaticFile {
  body: Uint8Array;
  /** gzip-compressed body, or null when not worth it (small, binary, or no gain). */
  gzip: Uint8Array | null;
  type: string;
  /**
   * Opaque entity tag of `body` (no quotes), or undefined for none. The gzip representation
   * gets `<etag>-gz`.
   */
  etag?: string | undefined;
}

/** Where the web client's files come from. */
export interface StaticSource {
  /** The file at canonical request path `rel` (e.g. '/index.html'; see isCanonicalPath), or null. */
  load(rel: string): StaticFile | null;
  /** Number of files held in memory (for tests and diagnostics). */
  cacheSize(): number;
}

/**
 * True when `pathname` (already percent-decoded) is the one canonical spelling of a path:
 * absolute, no empty / `.` / `..` segments and no backslashes. Anything else is never mapped to
 * a file, so aliases like `/assets//x.js` or `/assets/a%2f..%2fx.js` can't create cache entries
 * or borrow the immutable caching of /assets/.
 */
export function isCanonicalPath(pathname: string): boolean {
  if (!pathname.startsWith('/') || pathname.includes('\\')) return false;
  return path.posix.normalize(pathname) === pathname;
}

/**
 * Whether Windows would open a different name than `rel` spells: it drops a trailing dot or space
 * from each segment (`/index.html.` opens index.html), reads `name:stream` as an alternate data
 * stream (`/index.html::$DATA`), and NTFS answers to an 8.3 short name (`/assets/ACCOUN~1.JS`
 * opens AccountSettings-AlLRl53y.js; short names depend on creation order, so one could even name
 * another file after a rebuild). Such paths are never looked up on Windows. No file of the built
 * client has a `~` in its name (Vite's hashed names use [A-Za-z0-9_-]).
 */
export function isWindowsAlias(rel: string): boolean {
  return rel.includes(':') || rel.includes('~') || rel.split('/').some((seg) => /[. ]$/.test(seg));
}

/** Whether `webDir` holds a built web client. */
export function hasWebClient(webDir: string): boolean {
  try {
    return fs.statSync(path.join(path.resolve(webDir), 'index.html')).isFile();
  } catch {
    return false;
  }
}

/**
 * Served (503) for app routes while the client is missing. Self-contained (no scripts or
 * external files), and public, so it names no paths (the server log does).
 */
export const MISSING_CLIENT_HTML = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lyren Plan: web client missing</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#1f2937}code{background:#f3f4f6;padding:0 .25rem;border-radius:.25rem}</style>
<h1>Lyren Plan is running, but its web client is missing</h1>
<p>The server found no <code>index.html</code> in its web folder.</p>
<ul>
<li>Build the client with <code>npm run build</code>, or copy the whole <code>dist/</code> folder (not just <code>dist/server.mjs</code>).</li>
<li>Or set <code>WEB_DIR</code> to the folder that holds <code>index.html</code>. The server log names the folder it looked in.</li>
</ul>
<p>Then reload this page; no restart is needed after a build.</p>
`;

function contentType(rel: string): string {
  return TYPES[path.extname(rel).toLowerCase()] ?? 'application/octet-stream';
}

function gzipOf(rel: string, body: Uint8Array): Uint8Array | null {
  if (!COMPRESSIBLE.has(path.extname(rel).toLowerCase()) || body.length <= 1024) return null;
  const gz = gzipSync(body);
  return gz.length < body.length ? gz : null;
}

interface DiskFile extends StaticFile {
  mtimeMs: number;
  size: number;
}

/** The built client in `webDir` on disk (see the header comment for the cache rules). */
export function diskSource(webDir: string, platform: NodeJS.Platform = process.platform): StaticSource {
  const root = path.resolve(webDir);
  // A drive or file-system root (C:\, /) already ends with the separator.
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  const cache = new Map<string, DiskFile>();
  const caseInsensitive = platform === 'win32' || platform === 'darwin';

  return {
    cacheSize: () => cache.size,
    load(rel) {
      if (platform === 'win32' && isWindowsAlias(rel)) return null;
      const abs = path.resolve(root, '.' + rel);
      if (!abs.startsWith(prefix)) return null;
      const key = caseInsensitive ? abs.toLowerCase() : abs;
      const hit = cache.get(key);
      // Hashed assets never change under the same name; skip the stat.
      if (hit && rel.startsWith('/assets/')) return hit;
      try {
        const st = fs.statSync(abs);
        if (!st.isFile()) {
          cache.delete(key);
          return null;
        }
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
        const body = fs.readFileSync(abs);
        const file: DiskFile = { mtimeMs: st.mtimeMs, size: st.size, body, gzip: gzipOf(abs, body), type: contentType(abs) };
        // Only cache hits (one entry per real file); misses may appear later (e.g. a rebuild).
        cache.set(key, file);
        return file;
      } catch {
        cache.delete(key);
        return null;
      }
    },
  };
}

export interface MemoryFile {
  /** Request path, e.g. '/index.html' or '/assets/index-abc123.js'. Must be canonical. */
  path: string;
  body: Uint8Array;
  /** Opaque entity tag (no quotes), e.g. a content hash. Omit to send no ETag. */
  etag?: string | undefined;
}

/**
 * A fixed set of files held in memory, looked up by exact path (so no URL spelling but the
 * canonical one can match). gzip versions are made on first use and kept.
 */
export function memorySource(files: Iterable<MemoryFile>): StaticSource {
  const entries = new Map<string, { file: MemoryFile; served: StaticFile | null }>();
  for (const file of files) {
    if (!isCanonicalPath(file.path) || file.path.endsWith('/')) throw new Error(`Not a canonical file path: ${file.path}`);
    entries.set(file.path, { file, served: null });
  }
  return {
    cacheSize: () => [...entries.values()].filter((e) => e.served).length,
    load(rel) {
      const entry = entries.get(rel);
      if (!entry) return null;
      entry.served ??= {
        body: entry.file.body,
        gzip: gzipOf(rel, entry.file.body),
        type: contentType(rel),
        etag: entry.file.etag,
      };
      return entry.served;
    },
  };
}

/** Whether an If-None-Match header value matches `etag` (weak comparison, RFC 9110 §13.1.2). */
export function etagMatches(ifNoneMatch: string, etag: string): boolean {
  if (ifNoneMatch.trim() === '*') return true;
  return ifNoneMatch.split(',').some((tag) => tag.trim().replace(/^W\//, '') === `"${etag}"`);
}

export type StaticSite = MiddlewareHandler & {
  /** Number of files held in memory (for tests and diagnostics). */
  cacheSize(): number;
};

/** The web client from `source`, or from the folder `source` names on disk. */
export function staticSite(source: StaticSource | string): StaticSite {
  const files = typeof source === 'string' ? diskSource(source) : source;

  const handler: MiddlewareHandler = async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.text('Bad request', 400);
    }
    if (pathname.startsWith('/api/') || pathname === '/api') return next();
    if (pathname.includes('\0')) return c.text('Bad request', 400);

    const rel = pathname === '/' ? '/index.html' : pathname;
    // Non-canonical spellings are never looked up: they fall through to the SPA fallback
    // (extension-less) or a 404 like any other unknown file.
    let file = isCanonicalPath(rel) ? files.load(rel) : null;
    let cacheControl = rel.startsWith('/assets/') ? IMMUTABLE : 'no-cache';
    if (!file) {
      // Unknown paths without a file extension are client-side routes.
      const appRoute = rel === '/index.html' || path.extname(rel) === '';
      if (!appRoute) return next();
      file = files.load('/index.html');
      cacheControl = 'no-cache';
      if (!file) {
        // No client built: say so to browsers (and curl), 404 for anything else.
        if (!/text\/html|\*\/\*/.test(c.req.header('accept') ?? '')) return next();
        // HEAD answers with the same header fields as GET (RFC 9110 §9.3.2).
        c.header('Content-Type', 'text/html; charset=UTF-8');
        c.header('Cache-Control', 'no-store');
        if (c.req.method === 'HEAD') {
          c.header('Content-Length', String(Buffer.byteLength(MISSING_CLIENT_HTML)));
          return c.body(null, 503);
        }
        return c.html(MISSING_CLIENT_HTML, 503);
      }
    }
    c.header('Content-Type', file.type);
    c.header('Cache-Control', cacheControl);
    let body = file.body;
    let etag = file.etag;
    if (file.gzip) {
      c.header('Vary', 'Accept-Encoding');
      if (/\bgzip\b/i.test(c.req.header('accept-encoding') ?? '')) {
        c.header('Content-Encoding', 'gzip');
        body = file.gzip;
        if (etag) etag += '-gz';
      }
    }
    if (etag) {
      c.header('ETag', `"${etag}"`);
      const ifNoneMatch = c.req.header('if-none-match');
      if (ifNoneMatch && etagMatches(ifNoneMatch, etag)) {
        c.header('Content-Encoding', undefined);
        return c.body(null, 304);
      }
    }
    if (c.req.method === 'HEAD') return c.body(null, 200);
    return c.body(body as Uint8Array<ArrayBuffer>, 200);
  };
  return Object.assign(handler, { cacheSize: () => files.cacheSize() });
}
