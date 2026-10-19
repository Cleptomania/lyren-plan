import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';
import {
  diskSource,
  etagMatches,
  hasWebClient,
  isCanonicalPath,
  isWindowsAlias,
  memorySource,
  staticSite,
  type StaticSource,
} from '../src/http/static';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function site() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-web-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Lyren</title>' + ' '.repeat(2000));
  fs.writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1);'.repeat(500));
  fs.writeFileSync(path.join(dir, 'sw.js'), 'self.x = 1;');
  const handler = staticSite(dir);
  const app = new Hono();
  app.use('*', handler);
  app.notFound((c) => c.text('nope', 404));
  return { app, handler, dir };
}

const gz = { headers: { 'accept-encoding': 'gzip' } };

describe('static site', () => {
  it('serves files, hashed assets immutable and the rest revalidated', async () => {
    const { app } = site();
    const asset = await app.request('/assets/app-abc123.js', gz);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(asset.headers.get('content-encoding')).toBe('gzip');
    const index = await app.request('/');
    expect(index.status).toBe(200);
    expect(index.headers.get('cache-control')).toBe('no-cache');
    const route = await app.request('/projects/1/board');
    expect(route.status).toBe(200);
    expect(route.headers.get('content-type')).toMatch(/text\/html/);
    expect((await app.request('/missing.js')).status).toBe(404);
  });

  it('URL aliases of one file never grow the in-memory cache', async () => {
    const { app, handler } = site();
    expect((await app.request('/assets/app-abc123.js', gz)).status).toBe(200);
    expect(handler.cacheSize()).toBe(1);
    // Spellings that only become aliases after percent-decoding are refused.
    const aliases = [
      '/assets//app-abc123.js',
      '/assets/%2e%2f/app-abc123.js',
      '/assets%5capp-abc123.js',
      ...Array.from({ length: 50 }, (_, i) => `/assets/a${i}%2f..%2fapp-abc123.js`),
    ];
    for (const alias of aliases) {
      const res = await app.request(alias, gz);
      expect(res.status, alias).toBe(404);
    }
    // Dot segments the URL parser resolves itself map to the same file and the same entry.
    for (const alias of ['/assets/./app-abc123.js', '/assets/x/../app-abc123.js', '/assets/%2e/app-abc123.js']) {
      expect((await app.request(alias, gz)).status, alias).toBe(200);
    }
    expect(handler.cacheSize()).toBe(1);
    // Extension-less aliases fall back to index.html: still one entry per real file.
    for (let i = 0; i < 20; i++) expect((await app.request(`/projects/${i}%2f..%2f/x`)).status).toBe(200);
    expect(handler.cacheSize()).toBe(2);
  });

  it('a file outside /assets/ is never served with the immutable header', async () => {
    const { app } = site();
    for (const p of ['/assets/..%2findex.html', '/assets/../index.html', '/assets/%2e%2e/sw.js', '/assets/x%2f..%2f..%2fsw.js']) {
      const res = await app.request(p);
      expect(res.headers.get('cache-control') ?? '', p).not.toMatch(/immutable/);
    }
    const sw = await app.request('/sw.js');
    expect(sw.status).toBe(200);
    expect(sw.headers.get('cache-control')).toBe('no-cache');
  });

  it('never escapes webDir', async () => {
    const { app } = site();
    const { app: app2, dir } = site();
    fs.writeFileSync(path.join(path.dirname(dir), 'lyren-secret.txt'), 'secret');
    for (const p of ['/..%2flyren-secret.txt', '/assets/..%2f..%2flyren-secret.txt', '/assets/..%5c..%5clyren-secret.txt']) {
      const res = await app2.request(p);
      expect(res.status, p).toBe(404);
    }
    fs.rmSync(path.join(path.dirname(dir), 'lyren-secret.txt'));
    // Extension-less traversal attempts get the SPA shell, never the file.
    for (const p of ['/..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd']) {
      const res = await app.request(p);
      expect(await res.text(), p).toMatch(/<title>Lyren<\/title>/);
    }
    expect((await app.request('/a%00b')).status).toBe(400);
  });

  it('isCanonicalPath', () => {
    expect(isCanonicalPath('/assets/app.js')).toBe(true);
    expect(isCanonicalPath('/projects/')).toBe(true);
    expect(isCanonicalPath('/assets//app.js')).toBe(false);
    expect(isCanonicalPath('/assets/./app.js')).toBe(false);
    expect(isCanonicalPath('/assets/../index.html')).toBe(false);
    expect(isCanonicalPath('/assets\\app.js')).toBe(false);
    expect(isCanonicalPath('assets/app.js')).toBe(false);
  });

  it('without a built client, app routes explain it (503) and pick the client up once built', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-noweb-'));
    dirs.push(dir);
    const app = new Hono();
    app.use('*', staticSite(dir));
    app.get('/api/health', (c) => c.json({ ok: true }));
    app.notFound((c) => c.text('nope', 404));
    const html = { headers: { accept: 'text/html,application/xhtml+xml' } };
    expect(hasWebClient(dir)).toBe(false);
    for (const p of ['/', '/setup', '/projects/1/board']) {
      const res = await app.request(p, html);
      expect(res.status, p).toBe(503);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.text();
      expect(body).toContain('web client is missing');
      expect(body).toContain('npm run build');
      expect(body).not.toContain(dir); // public page: no paths
    }
    // curl's default Accept, and HEAD.
    expect((await app.request('/', { headers: { accept: '*/*' } })).status).toBe(503);
    // HEAD carries the same header fields as GET, with no body (curl -I, uptime monitors).
    for (const headers of [html.headers, { accept: '*/*' }]) {
      const get = await app.request('/projects/1', { headers });
      const head = await app.request('/projects/1', { method: 'HEAD', headers });
      expect(head.status).toBe(503);
      expect(head.headers.get('content-type')).toMatch(/^text\/html/);
      expect(head.headers.get('content-type')).toBe(get.headers.get('content-type'));
      expect(head.headers.get('cache-control')).toBe('no-store');
      expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength(await get.text())));
      expect(await head.text()).toBe('');
    }
    // Files, non-HTML requests and the API are unaffected.
    expect((await app.request('/assets/app-abc123.js', html)).status).toBe(404);
    expect((await app.request('/projects/1', { headers: { accept: 'application/json' } })).status).toBe(404);
    expect((await app.request('/api/health', html)).status).toBe(200);
    // A build that appears later is served without a restart.
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Lyren</title>');
    expect(hasWebClient(dir)).toBe(true);
    const res = await app.request('/', html);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>Lyren</title>');
    // A WEB_DIR that does not exist at all.
    expect(hasWebClient(path.join(dir, 'nope'))).toBe(false);
    const missing = new Hono();
    missing.use('*', staticSite(path.join(dir, 'nope')));
    expect((await missing.request('/', html)).status).toBe(503);
  });
});

// The same HTTP semantics whether the client comes from disk (Node build, Docker, WEB_DIR) or from
// memory (the web client embedded in the desktop app).
const FILES: Record<string, string> = {
  '/index.html': '<!doctype html><title>Lyren</title>' + ' '.repeat(2000),
  '/assets/app-abc123.js': 'console.log(1);'.repeat(500),
  '/sw.js': 'self.x = 1;',
  '/manifest.webmanifest': '{"name":"Lyren Plan"}',
  '/icons/icon-192.png': 'PNG',
  // The Cloudflare static assets' header rules (web/public/_headers), copied into dist/web by Vite.
  '/_headers': "/*\n  X-Frame-Options: DENY\n",
};

function sourceOf(kind: 'disk' | 'memory'): StaticSource {
  if (kind === 'memory') {
    return memorySource(Object.entries(FILES).map(([p, body]) => ({ path: p, body: Buffer.from(body), etag: `e${p.length}` })));
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-web-'));
  dirs.push(dir);
  for (const [p, body] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), body);
  }
  return diskSource(dir);
}

function appFor(source: StaticSource) {
  const app = new Hono();
  app.use('*', staticSite(source));
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.notFound((c) => c.text('nope', 404));
  return app;
}

describe.each(['disk', 'memory'] as const)('static semantics (%s source)', (kind) => {
  it('hashed assets immutable + gzip, the rest revalidated, SPA fallback, 404s, API untouched', async () => {
    const app = appFor(sourceOf(kind));
    const asset = await app.request('/assets/app-abc123.js', gz);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(asset.headers.get('content-encoding')).toBe('gzip');
    expect(asset.headers.get('vary')).toBe('Accept-Encoding');
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    const plain = await app.request('/assets/app-abc123.js');
    expect(plain.headers.get('content-encoding')).toBeNull();
    expect(await plain.text()).toBe(FILES['/assets/app-abc123.js']);
    for (const p of ['/', '/index.html', '/projects/1/board', '/setup']) {
      const res = await app.request(p);
      expect(res.status, p).toBe(200);
      expect(res.headers.get('cache-control'), p).toBe('no-cache');
      expect(res.headers.get('content-type'), p).toBe('text/html; charset=utf-8');
    }
    const sw = await app.request('/sw.js');
    expect(sw.headers.get('cache-control')).toBe('no-cache');
    expect(sw.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect((await app.request('/manifest.webmanifest')).headers.get('content-type')).toBe('application/manifest+json; charset=utf-8');
    expect((await app.request('/icons/icon-192.png')).headers.get('content-type')).toBe('image/png');
    expect((await app.request('/missing.js')).status).toBe(404);
    expect((await app.request('/assets/missing-123.js')).status).toBe(404);
    expect((await app.request('/assets//app-abc123.js')).status).toBe(404);
    expect((await app.request('/assets/app-abc123.js.map')).status).toBe(404);
    expect((await app.request('/a%00b')).status).toBe(400);
    expect((await app.request('/api/health')).status).toBe(200);
    expect((await app.request('/', { method: 'POST' })).status).toBe(404);
    // _headers is never served: the path is an app route like any unknown one.
    const headers = await app.request('/_headers');
    expect(headers.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await headers.text()).toBe(FILES['/index.html']);
  });

  it('HEAD answers with the headers of GET and no body', async () => {
    const app = appFor(sourceOf(kind));
    for (const p of ['/', '/assets/app-abc123.js']) {
      const get = await app.request(p, gz);
      const head = await app.request(p, { ...gz, method: 'HEAD' });
      expect(head.status).toBe(200);
      for (const h of ['content-type', 'cache-control', 'content-encoding', 'etag']) expect(head.headers.get(h), `${p} ${h}`).toBe(get.headers.get(h));
      expect(await head.text()).toBe('');
    }
  });
});

describe('entity tags (sources that provide them)', () => {
  it('memory files carry an ETag per representation and answer If-None-Match with 304', async () => {
    const app = appFor(sourceOf('memory'));
    const index = await app.request('/');
    const etag = index.headers.get('etag')!;
    expect(etag).toMatch(/^"e11"$/);
    const notModified = await app.request('/', { headers: { 'if-none-match': etag } });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get('etag')).toBe(etag);
    expect(notModified.headers.get('cache-control')).toBe('no-cache');
    expect(await notModified.text()).toBe('');
    // The gzip representation has its own tag.
    const zipped = await app.request('/assets/app-abc123.js', gz);
    expect(zipped.headers.get('etag')).toBe('"e21-gz"');
    expect((await app.request('/assets/app-abc123.js', { headers: { 'accept-encoding': 'gzip', 'if-none-match': '"e21-gz"' } })).status).toBe(304);
    expect((await app.request('/assets/app-abc123.js', { headers: { 'if-none-match': '"e21-gz"' } })).status).toBe(200);
    // An SPA route revalidates against index.html's tag.
    expect((await app.request('/projects/1', { headers: { 'if-none-match': `W/${etag}` } })).status).toBe(304);
    expect((await app.request('/', { headers: { 'if-none-match': '"other"' } })).status).toBe(200);
  });

  it('disk files send no ETag (unchanged behaviour of the Node build)', async () => {
    const app = appFor(sourceOf('disk'));
    const res = await app.request('/');
    expect(res.headers.get('etag')).toBeNull();
    expect((await app.request('/', { headers: { 'if-none-match': '*' } })).status).toBe(200);
  });

  it('etagMatches', () => {
    expect(etagMatches('"a"', 'a')).toBe(true);
    expect(etagMatches('W/"a"', 'a')).toBe(true);
    expect(etagMatches('"b", W/"a"', 'a')).toBe(true);
    expect(etagMatches('*', 'a')).toBe(true);
    expect(etagMatches('"ab"', 'a')).toBe(false);
    expect(etagMatches('a', 'a')).toBe(false);
  });
});

describe('memorySource', () => {
  it('rejects non-canonical paths and holds gzip only for files served', async () => {
    expect(() => memorySource([{ path: 'index.html', body: new Uint8Array() }])).toThrow(/canonical/);
    expect(() => memorySource([{ path: '/a/../b.js', body: new Uint8Array() }])).toThrow(/canonical/);
    const source = sourceOf('memory');
    expect(source.cacheSize()).toBe(0);
    const app = appFor(source);
    await app.request('/assets/app-abc123.js', gz);
    await app.request('/assets/app-abc123.js', gz);
    expect(source.cacheSize()).toBe(1);
    // Exact paths only: case variants and aliases are unknown files.
    expect((await app.request('/ASSETS/app-abc123.js')).status).toBe(404);
    expect((await app.request('/index.html.')).status).toBe(404);
  });
});

describe('disk source on case-insensitive file systems (Windows, macOS)', () => {
  it('URL spellings Windows would map to the same file never add cache entries', async () => {
    expect(isWindowsAlias('/index.html.')).toBe(true);
    expect(isWindowsAlias('/assets/app.js ')).toBe(true);
    expect(isWindowsAlias('/index.html::$DATA')).toBe(true);
    expect(isWindowsAlias('/assets./app.js')).toBe(true);
    // NTFS 8.3 short names: a second spelling of a file, assigned by creation order.
    expect(isWindowsAlias('/assets/ACCOUN~1.JS')).toBe(true);
    expect(isWindowsAlias('/assets/accoun~1.js')).toBe(true);
    expect(isWindowsAlias('/ASSETS~1/app.js')).toBe(true);
    expect(isWindowsAlias('/assets/app-abc123.js')).toBe(false);
    expect(isWindowsAlias('/projects/1/board')).toBe(false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-web-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<title>Lyren</title>');
    fs.writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'x');
    // Simulate a case-insensitive file system: the key is folded on win32 and darwin.
    const source = diskSource(dir, 'darwin');
    expect(source.load('/assets/app-abc123.js')).not.toBeNull();
    expect(source.cacheSize()).toBe(1);
    source.load('/assets/APP-abc123.js'); // not found on this (case-sensitive) test FS, but never a 2nd key
    expect(source.cacheSize()).toBe(1);
    const win = diskSource(dir, 'win32');
    expect(win.load('/index.html.')).toBeNull();
    expect(win.load('/index.html::$DATA')).toBeNull();
    expect(win.load('/assets/APP-AB~1.JS')).toBeNull();
    expect(win.cacheSize()).toBe(0);
  });

  it('a web folder at the root of a drive (WEB_DIR=W:\\) or of the file system', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-web-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'index.html'), '<title>Lyren</title>');
    const root = path.parse(dir).root; // '/' here, 'C:\\' on Windows: both end with the separator
    const source = diskSource(root);
    const rel = '/' + path.relative(root, path.join(dir, 'index.html')).split(path.sep).join('/');
    expect(Buffer.from(source.load(rel)!.body).toString()).toBe('<title>Lyren</title>');
  });
});
