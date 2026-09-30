import { deflateSync } from "node:zlib";

// Deterministic, valid RGB PNG above Claude Code's 256 KiB @file limit.
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

const size = 384;
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 2;
const pixels = Buffer.alloc(size * (size * 3 + 1));
let seed = 123456;
for (let y = 0; y < size; y++) {
  for (let x = 1; x <= size * 3; x++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    pixels[y * (size * 3 + 1) + x] = seed & 255;
  }
}
export const largePng = Buffer.concat([
  Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
  chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0)),
]);
