// The web client embedded in the single-file app as SEA assets (see scripts/package.mjs): every
// file of dist/web except source maps under the key `web/<path>`, plus a manifest listing them
// with size and SHA-256. The files are served straight from the executable's memory
// (getRawAsset does not copy). The Windows app also embeds its notification-area icon.

import { createHash } from 'node:crypto';
import { getAsset, getRawAsset } from 'node:sea';
import { memorySource, type MemoryFile, type StaticSource } from '../http/static';

export const MANIFEST_KEY = 'lyren/manifest.json';

/** The notification-area icon (Windows app only): a .ico of the app icon at 16 to 48 px. */
export const TRAY_ICON_KEY = 'lyren/tray-icon.ico';

export interface AssetManifestFile {
  /** Request path, e.g. '/assets/index-abc123.js'. */
  path: string;
  /** SEA asset key. */
  key: string;
  size: number;
  /** SHA-256 of the content, hex. */
  sha256: string;
  /** Entity tag (no quotes). */
  etag: string;
}

export interface AssetManifest {
  format: 1;
  version: string;
  builtAt: string;
  files: AssetManifestFile[];
}

export interface EmbeddedWeb {
  source: StaticSource;
  manifest: AssetManifest;
}

/** Thrown when the embedded files don't match their manifest (a damaged download). */
export class DamagedAppError extends Error {}

/** Check `files` against the manifest and make the static source. */
export function webSourceFromAssets(manifest: AssetManifest, read: (key: string) => Uint8Array): EmbeddedWeb {
  if (manifest.format !== 1 || !Array.isArray(manifest.files)) throw new DamagedAppError('Unknown asset manifest format');
  const files: MemoryFile[] = manifest.files.map((f) => {
    const body = read(f.key);
    if (body.length !== f.size || createHash('sha256').update(body).digest('hex') !== f.sha256) {
      throw new DamagedAppError(`Embedded file ${f.path} is damaged`);
    }
    return { path: f.path, body, etag: f.etag };
  });
  if (!files.some((f) => f.path === '/index.html')) throw new DamagedAppError('Embedded web client has no index.html');
  return { source: memorySource(files), manifest };
}

/** The web client embedded in this executable. Only call inside a single-executable app. */
export function embeddedWeb(): EmbeddedWeb {
  const manifest = JSON.parse(getAsset(MANIFEST_KEY, 'utf8')) as AssetManifest;
  return webSourceFromAssets(manifest, (key) => new Uint8Array(getRawAsset(key)));
}

/** The notification-area icon embedded in this executable, or null (not a Windows build, or not a SEA). */
export function embeddedTrayIcon(): Buffer | null {
  try {
    return Buffer.from(getRawAsset(TRAY_ICON_KEY));
  } catch {
    return null;
  }
}
