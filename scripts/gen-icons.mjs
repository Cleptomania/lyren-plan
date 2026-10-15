#!/usr/bin/env node
// Generates the app icons in web/public from one geometric mark (three kanban columns on an
// indigo tile), without dependencies; the drawing code is in scripts/lib/icons.mjs. Re-run after
// changing the geometry:
//
//   node scripts/gen-icons.mjs
//
// Outputs: favicon.svg, icons/icon-192.png, icons/icon-512.png, icons/maskable-512.png,
// icons/apple-touch-icon.png (180). Keep components/layout/AppMark.tsx in sync.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iconPng, svg } from './lib/icons.mjs';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'public');

// ---- Main -------------------------------------------------------------------------------

const VARIANTS = [
  { file: 'icons/icon-192.png', size: 192, rounded: true, scale: 1 },
  { file: 'icons/icon-512.png', size: 512, rounded: true, scale: 1 },
  { file: 'icons/maskable-512.png', size: 512, rounded: false, scale: 0.78 },
  { file: 'icons/apple-touch-icon.png', size: 180, rounded: false, scale: 0.9 },
];

mkdirSync(join(PUBLIC_DIR, 'icons'), { recursive: true });
for (const v of VARIANTS) {
  const png = iconPng(v.size, v);
  writeFileSync(join(PUBLIC_DIR, v.file), png);
  console.log(`wrote web/public/${v.file} (${v.size}×${v.size}, ${png.length} bytes)`);
}
writeFileSync(join(PUBLIC_DIR, 'favicon.svg'), svg());
console.log('wrote web/public/favicon.svg');
