// The web client as single-executable-application assets: every file of dist/web except source
// maps and _headers (the Cloudflare static assets' header rules, which the app never serves), keyed
// `web/<path>`, plus a manifest (server/src/desktop/assets.ts reads both), and the sea-config.json that
// names them. Pure apart from reading the files; unit-tested in
// scripts/test/sea-assets.test.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './node-dist.mjs';

/** Must match MANIFEST_KEY in server/src/desktop/assets.ts. */
export const MANIFEST_KEY = 'lyren/manifest.json';

/**
 * The notification-area icon (a .ico of the app icon's small sizes, see TRAY_ICON_SIZES in
 * scripts/package.mjs). Must match TRAY_ICON_KEY in server/src/desktop/assets.ts.
 */
export const TRAY_ICON_KEY = 'lyren/tray-icon.ico';

/** Files at the top of dist/web that are configuration for another server (server/src/http/static.ts NOT_SERVED). */
const NOT_EMBEDDED = new Set(['_headers']);

/** Files under `webDir` to embed: [{ path: '/assets/x.js', key: 'web/assets/x.js', file, size, sha256, etag }]. */
export function collectWebAssets(webDir) {
  const root = path.resolve(webDir);
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && !entry.name.endsWith('.map') && !(dir === root && NOT_EMBEDDED.has(entry.name))) {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        const body = fs.readFileSync(abs);
        const hash = sha256(body);
        out.push({ path: `/${rel}`, key: `web/${rel}`, file: abs, size: body.length, sha256: hash, etag: hash.slice(0, 32) });
      }
    }
  };
  walk(root);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (!out.some((f) => f.path === '/index.html')) throw new Error(`No index.html in ${root}: run npm run build first`);
  return out;
}

/** The manifest embedded next to the files (format 1). */
export function buildAssetManifest(files, { version, builtAt }) {
  return {
    format: 1,
    version,
    builtAt,
    files: files.map(({ path: p, key, size, sha256: hash, etag }) => ({ path: p, key, size, sha256: hash, etag })),
  };
}

/**
 * sea-config.json for `node --experimental-sea-config`. No snapshot and no code cache: both are
 * specific to the platform that builds the blob, and the Windows app is built on any platform.
 * execArgvExtension "none": the app ignores NODE_OPTIONS, so a developer's NODE_OPTIONS (e.g.
 * --require hooks) can't change how it runs.
 */
export function seaConfig({ main, output, assets }) {
  return {
    main,
    output,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    execArgv: ['--disable-warning=ExperimentalWarning'],
    execArgvExtension: 'none',
    assets,
  };
}

/**
 * Strings that would reveal where the app was built (the checkout and the home folder, with either
 * kind of slash), to make sure none ends up in the executable. The home folder only when it has
 * two or more segments (/home/ann, C:\Users\ann): a short one like /root occurs in node itself.
 */
export function buildPathNeedles(root, home) {
  const needles = new Set();
  const add = (p) => {
    needles.add(p);
    needles.add(p.replaceAll('\\', '/'));
    needles.add(p.replaceAll('/', '\\'));
  };
  add(path.resolve(root));
  const h = home ? home.replace(/[\\/]+$/, '') : '';
  if (h.split(/[\\/]/).filter(Boolean).length >= 2) add(h + path.sep);
  return [...needles];
}

/** The `needles` found in `buf` as UTF-8 or UTF-16LE text. */
export function findStrings(buf, needles) {
  return needles.filter((n) => buf.includes(Buffer.from(n, 'utf8')) || buf.includes(Buffer.from(n, 'utf16le')));
}
