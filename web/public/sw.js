// Lyren Plan service worker: an offline app shell. Registered by web/src/main.tsx in
// production builds only.
//
// Strategy
//   /api/*, non-GET, cross-origin   → not handled (always the network)
//   navigations                      → network first; the latest index.html is cached and
//                                      served when the network fails
//   /assets/* (hashed, immutable)    → cache first
//   other same-origin static files   → stale-while-revalidate (icons, manifest, favicon,
//                                      theme-init.js)
// A request that fails with nothing cached fails exactly like a plain network error.
//
// Bump VERSION when changing this file's caching behaviour: old caches are deleted on
// activate. App releases need no bump (index.html is network-first, assets are hashed).

const VERSION = 'v1';
const SHELL_CACHE = `lyren-shell-${VERSION}`;
const ASSET_CACHE = `lyren-assets-${VERSION}`;
const PRECACHE = ['/', '/index.html', '/theme-init.js', '/manifest.webmanifest', '/favicon.svg'];
// Old hashed bundles pile up across releases; keep the most recent entries only.
const MAX_ASSET_ENTRIES = 200;

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // One failed URL must not abort installation (cache.addAll is all-or-nothing).
      Promise.allSettled(PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' })))),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith('lyren-') && !keep.has(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/sw.js') return;
  // DevTools quirk: only-if-cached requests outside same-origin mode throw in fetch().
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(req));
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(req));
  } else {
    event.respondWith(staleWhileRevalidate(req, event));
  }
});

function isCacheable(res) {
  return res.ok && res.type === 'basic';
}

async function networkFirstNavigation(req) {
  try {
    const res = await fetch(req);
    const type = res.headers.get('content-type') || '';
    if (isCacheable(res) && type.includes('text/html')) {
      const copy = res.clone();
      caches
        .open(SHELL_CACHE)
        .then((cache) => cache.put('/index.html', copy))
        .catch(() => {});
    }
    return res;
  } catch (err) {
    const cached = await caches.match('/index.html', { cacheName: SHELL_CACHE });
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (isCacheable(res)) {
    await cache.put(req, res.clone()).catch(() => {});
    trimCache(cache, MAX_ASSET_ENTRIES);
  }
  return res;
}

async function staleWhileRevalidate(req, event) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(req, { ignoreVary: true });
  const network = fetch(req).then(async (res) => {
    if (isCacheable(res)) await cache.put(req, res.clone()).catch(() => {});
    return res;
  });
  if (cached) {
    // Refresh in the background; a failure just keeps the cached copy.
    event.waitUntil(network.catch(() => {}));
    return cached;
  }
  return network;
}

/** Delete the oldest entries (cache.keys() is in insertion order) beyond `max`. */
async function trimCache(cache, max) {
  try {
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - max)).map((k) => cache.delete(k)));
  } catch {
    /* best effort */
  }
}
