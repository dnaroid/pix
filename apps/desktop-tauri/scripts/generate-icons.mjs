#!/usr/bin/env node
/**
 * Generate placeholder PNG icons for the Tauri app.
 *
 * Tauri's dev mode requires the icon paths referenced in tauri.conf.json to
 * exist; this script writes a minimal solid-color PNG at each required size
 * using only `node:zlib` (no native deps). Replace these with real artwork
 * later and regenerate platform-specific formats with `npx tauri icon icon.png`.
 *
 * Output:
 *   src-tauri/icons/32x32.png
 *   src-tauri/icons/128x128.png
 *   src-tauri/icons/128x128@2x.png   (256x256)
 *   src-tauri/icons/icon.png         (1024x1024 source for `tauri icon`)
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = resolve(HERE, "../src-tauri/icons");

// -- Tiny PNG encoder ----------------------------------------------------

/** CRC32 table (PNG uses the standard reflected polynomial). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/**
 * Encode a solid-color RGBA PNG of size `size x size`, with optional pixel
 * callback to override per-pixel color (e.g. for a simple two-tone design).
 */
function encodePng(size, pixel) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Raw scanline data: each row prefixed with filter byte (0 = none).
  const stride = size * 4;
  const raw = Buffer.alloc(size * (1 + stride));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + stride)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      const offset = y * (1 + stride) + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }

  const idat = deflateSync(raw);
  const iend = Buffer.alloc(0);

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", iend),
  ]);
}

// -- Pix-style placeholder design ---------------------------------------

// Dark background #1a1b26, accent square #7aa2f7 in center.
function pixel(x, y, size) {
  const bg = [0x1a, 0x1b, 0x26, 0xff];
  const fg = [0x7a, 0xa2, 0xf7, 0xff];
  // Center square covering ~40% of the icon, with margin.
  const margin = Math.floor(size * 0.25);
  const inX = x >= margin && x < size - margin;
  const inY = y >= margin && y < size - margin;
  return inX && inY ? fg : bg;
}

// -- Drive ---------------------------------------------------------------

function main() {
  mkdirSync(ICONS_DIR, { recursive: true });

  const targets = [
    { size: 32, name: "32x32.png" },
    { size: 128, name: "128x128.png" },
    { size: 256, name: "128x128@2x.png" },
    { size: 1024, name: "icon.png" },
  ];

  for (const { size, name } of targets) {
    const buf = encodePng(size, pixel);
    const outPath = join(ICONS_DIR, name);
    writeFileSync(outPath, buf);
    console.log(
      `  generated ${name.padEnd(20)} ${String(size).padStart(5)}×${size}  (${buf.length} bytes)`,
    );
  }

  console.log(`\nicons written to ${ICONS_DIR}`);
  console.log(
    "for production .icns/.ico bundles, replace icon.png with real artwork and run:\n" +
      "  npx tauri icon src-tauri/icons/icon.png",
  );
}

main();
