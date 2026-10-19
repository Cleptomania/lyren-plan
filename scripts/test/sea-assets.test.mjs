// Embedded web client and SEA configuration of scripts/package.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildIco, iconPng } from '../lib/icons.mjs';
import { sha256 } from '../lib/node-dist.mjs';
import { buildAssetManifest, buildPathNeedles, collectWebAssets, findStrings, MANIFEST_KEY, seaConfig, TRAY_ICON_KEY } from '../lib/sea-assets.mjs';
import { MANIFEST_KEY as RUNTIME_MANIFEST_KEY, TRAY_ICON_KEY as RUNTIME_TRAY_ICON_KEY } from '../../server/src/desktop/assets';

const dirs = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function webDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-sea-web-'));
  dirs.push(dir);
  for (const [p, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), body);
  }
  return dir;
}

describe('collectWebAssets', () => {
  it('every file but source maps and _headers, with request paths, asset keys and hashes', () => {
    const dir = webDir({
      'index.html': '<title>x</title>',
      'sw.js': 'sw',
      _headers: '/*\n  X-Frame-Options: DENY\n',
      'assets/index-abc.js': 'js',
      'assets/index-abc.js.map': '{}',
      'icons/icon-192.png': 'png',
    });
    const files = collectWebAssets(dir);
    expect(files.map((f) => f.path)).toEqual(['/assets/index-abc.js', '/icons/icon-192.png', '/index.html', '/sw.js']);
    const js = files[0];
    expect(js).toMatchObject({ key: 'web/assets/index-abc.js', size: 2, sha256: sha256(Buffer.from('js')) });
    expect(js.etag).toBe(js.sha256.slice(0, 32));
    expect(js.file).toBe(path.join(dir, 'assets', 'index-abc.js'));
  });

  it('refuses a folder without index.html', () => {
    expect(() => collectWebAssets(webDir({ 'sw.js': 'x' }))).toThrow(/No index.html/);
  });

  it('manifest and sea-config', () => {
    const files = collectWebAssets(webDir({ 'index.html': 'i' }));
    const manifest = buildAssetManifest(files, { version: '1.2.3', builtAt: '2026-10-14T00:00:00.000Z' });
    expect(manifest).toEqual({
      format: 1,
      version: '1.2.3',
      builtAt: '2026-10-14T00:00:00.000Z',
      files: [{ path: '/index.html', key: 'web/index.html', size: 1, sha256: sha256(Buffer.from('i')), etag: sha256(Buffer.from('i')).slice(0, 32) }],
    });
    expect(MANIFEST_KEY).toBe(RUNTIME_MANIFEST_KEY);
    expect(TRAY_ICON_KEY).toBe(RUNTIME_TRAY_ICON_KEY);
    const config = seaConfig({ main: '/m.cjs', output: '/b.blob', assets: { a: '/a' } });
    // Portable blob (built on Linux for Windows): no snapshot, no code cache.
    expect(config).toMatchObject({ main: '/m.cjs', output: '/b.blob', useSnapshot: false, useCodeCache: false, disableExperimentalSEAWarning: true, execArgvExtension: 'none', assets: { a: '/a' } });
  });
});

describe('icon', () => {
  it('a .ico of PNG images, 256 stored as 0', () => {
    const images = [16, 32, 256].map((size) => ({ size, png: iconPng(size) }));
    for (const { png } of images) expect(png.subarray(0, 8).toString('latin1')).toBe('\x89PNG\r\n\x1a\n');
    const ico = buildIco(images);
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(3);
    let offset = 6 + 16 * 3;
    images.forEach(({ size, png }, i) => {
      const e = 6 + 16 * i;
      expect(ico[e]).toBe(size === 256 ? 0 : size);
      expect(ico.readUInt16LE(e + 6)).toBe(32);
      expect(ico.readUInt32LE(e + 8)).toBe(png.length);
      expect(ico.readUInt32LE(e + 12)).toBe(offset);
      expect(ico.subarray(offset, offset + png.length).equals(png)).toBe(true);
      offset += png.length;
    });
    expect(ico.length).toBe(offset);
  });
});

describe('no build-machine paths in the executable', () => {
  it('looks for the checkout and the home folder, either slash, UTF-8 or UTF-16', () => {
    // The checkout is resolved on this host (C:\home\ann\src\lyren-plan on Windows).
    const root = path.resolve('/home/ann/src/lyren-plan');
    const needles = buildPathNeedles(root, '/home/ann');
    expect(needles).toEqual(expect.arrayContaining([root.replaceAll('\\', '/'), root.replaceAll('/', '\\'), '/home/ann/', '\\home\\ann\\']));
    // A one-segment home folder (/root) also occurs in node itself (ICU data): not searched for.
    expect(buildPathNeedles('/root/lyren-plan', '/root')).not.toContain('/root/');
    const exe = Buffer.concat([Buffer.from('MZ... at f (lyren-plan.cjs:1:21) ...'), Buffer.from('C:\\Users\\ann\\x', 'utf16le')]);
    expect(findStrings(exe, ['/home/ann/', 'C:\\Users\\ann\\', 'lyren-plan.cjs'])).toEqual(['C:\\Users\\ann\\', 'lyren-plan.cjs']);
  });
});
