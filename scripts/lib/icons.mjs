// The app icon, drawn without dependencies: one geometric mark (three kanban columns on an
// indigo tile) rasterized with 4x4 supersampling and encoded as PNG with node:zlib, the same
// mark as SVG, and a Windows .ico of PNG images. Used by scripts/gen-icons.mjs (web/public) and
// scripts/package.mjs (the desktop app's icon). Keep components/layout/AppMark.tsx in sync.

import { deflateSync } from 'node:zlib';

// ---- Geometry (32×32 design grid) --------------------------------------------------------

const BRAND = [0x4f, 0x46, 0xe5]; // indigo-600, same as the light-theme accent
const WHITE = [0xff, 0xff, 0xff];

/** The three columns: x, y, width, height, corner radius, opacity. */
const BARS = [
  { x: 6.5, y: 7, w: 5, h: 18, r: 1.5, a: 1 },
  { x: 13.5, y: 7, w: 5, h: 11, r: 1.5, a: 0.9 },
  { x: 20.5, y: 7, w: 5, h: 14.5, r: 1.5, a: 0.8 },
];

/**
 * Shapes for one icon variant, in design units.
 * - rounded: transparent corners (purpose "any"); otherwise a full-bleed square (maskable,
 *   apple-touch-icon — the platform applies its own mask).
 * - scale: glyph scale around the center (maskable icons must fit the 80% safe circle).
 */
export function shapes({ rounded, scale }) {
  const tile = { x: 0, y: 0, w: 32, h: 32, r: rounded ? 8 : 0, color: BRAND, a: 1 };
  const bars = BARS.map((b) => ({
    x: 16 + (b.x - 16) * scale,
    y: 16 + (b.y - 16) * scale,
    w: b.w * scale,
    h: b.h * scale,
    r: b.r * scale,
    color: WHITE,
    a: b.a,
  }));
  return [tile, ...bars];
}

// ---- Rasterizer -------------------------------------------------------------------------

function insideRoundedRect(px, py, s) {
  if (px < s.x || px > s.x + s.w || py < s.y || py > s.y + s.h) return false;
  if (s.r <= 0) return true;
  const cx = Math.min(Math.max(px, s.x + s.r), s.x + s.w - s.r);
  const cy = Math.min(Math.max(py, s.y + s.r), s.y + s.h - s.r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= s.r * s.r;
}

const SAMPLES = 4;

/** Rasterize shapes (painted in order, "over" compositing) to non-premultiplied RGBA. */
export function rasterize(size, list) {
  const unit = size / 32;
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Premultiplied accumulation.
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const s of list) {
        let hits = 0;
        for (let sy = 0; sy < SAMPLES; sy++) {
          for (let sx = 0; sx < SAMPLES; sx++) {
            const px = (x + (sx + 0.5) / SAMPLES) / unit;
            const py = (y + (sy + 0.5) / SAMPLES) / unit;
            if (insideRoundedRect(px, py, s)) hits++;
          }
        }
        if (hits === 0) continue;
        const cov = (hits / (SAMPLES * SAMPLES)) * s.a;
        r = s.color[0] * cov + r * (1 - cov);
        g = s.color[1] * cov + g * (1 - cov);
        b = s.color[2] * cov + b * (1 - cov);
        a = cov + a * (1 - cov);
      }
      const i = (y * size + x) * 4;
      if (a > 0) {
        rgba[i] = Math.round(r / a);
        rgba[i + 1] = Math.round(g / a);
        rgba[i + 2] = Math.round(b / a);
        rgba[i + 3] = Math.round(a * 255);
      }
    }
  }
  return rgba;
}

// ---- PNG encoder ------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // no interlace
  // Each scanline: filter byte 0 (None) + RGBA pixels.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- SVG --------------------------------------------------------------------------------

export function svg() {
  const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  const bars = BARS.map(
    (b) =>
      `  <rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${b.r}" fill="#fff"${b.a < 1 ? ` fill-opacity="${b.a}"` : ''}/>`,
  ).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">\n  <rect width="32" height="32" rx="8" fill="${hex(BRAND)}"/>\n${bars}\n</svg>\n`;
}

/** PNG of the icon at `size` px. variant: { rounded, scale } as in shapes(). */
export function iconPng(size, variant = { rounded: true, scale: 1 }) {
  return encodePng(size, rasterize(size, shapes(variant)));
}

/**
 * A Windows .ico holding one PNG image per size (supported since Windows Vista). Directory
 * entries store 256 as 0.
 */
export function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // width
    e[1] = size >= 256 ? 0 : size; // height
    e[2] = 0; // palette colors
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}
