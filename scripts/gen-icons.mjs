#!/usr/bin/env node
/**
 * Generates the PWA icons (PNG) without any image libraries: a rounded square
 * in the default brand colour with the three-bar mark from favicon.svg.
 *   node scripts/gen-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const out = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '../apps/web/public/icons');
mkdirSync(out, { recursive: true });

const BRAND = [0x4f, 0x46, 0xe5];

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** maskable: full-bleed background with the mark inside the 80% safe zone. */
function icon(size, { maskable = false } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const radius = maskable ? 0 : size * 0.22;
  const inside = (x, y) => {
    const r = radius;
    const cx = x < r ? r : x > size - r ? size - r : x;
    const cy = y < r ? r : y > size - r ? size - r : y;
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  // The mark: three rounded bars (like the favicon), scaled to the safe zone.
  const s = maskable ? size * 0.62 : size * 0.78;
  const ox = (size - s) / 2;
  const oy = (size - s) / 2;
  const bars = [
    [0.28, 0.31, 0.72],
    [0.28, 0.5, 0.6],
    [0.28, 0.69, 0.72],
  ].map(([x1, y, x2]) => ({ x1: ox + x1 * s, x2: ox + x2 * s, y: oy + y * s }));
  const thick = s * 0.095;
  const onBar = (x, y) =>
    bars.some((b) => {
      const cx = Math.max(b.x1, Math.min(b.x2, x));
      return (x - cx) ** 2 + (y - b.y) ** 2 <= (thick / 2) ** 2;
    });
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // 2x2 supersampling for smooth edges
      let bg = 0;
      let fg = 0;
      for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const sx = x + dx;
        const sy = y + dy;
        if (inside(sx, sy)) {
          bg++;
          if (onBar(sx, sy)) fg++;
        }
      }
      const a = bg / 4;
      const f = fg / Math.max(bg, 1);
      px[i] = Math.round(BRAND[0] * (1 - f) + 255 * f);
      px[i + 1] = Math.round(BRAND[1] * (1 - f) + 255 * f);
      px[i + 2] = Math.round(BRAND[2] * (1 - f) + 255 * f);
      px[i + 3] = Math.round(a * 255);
    }
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

writeFileSync(path.join(out, 'icon-192.png'), icon(192));
writeFileSync(path.join(out, 'icon-512.png'), icon(512));
writeFileSync(path.join(out, 'maskable-512.png'), icon(512, { maskable: true }));
writeFileSync(path.join(out, 'apple-touch-icon.png'), icon(180, { maskable: true }));
console.log('Icons written to', out);
