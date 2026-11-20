// A small PNG writer for the build scripts (8-bit RGBA or grey, no filter, zlib level 9) – the pre-built sticker atlas.
import { deflateSync, crc32 } from 'node:zlib';

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, c]);
}

/** pixels: Uint8(Clamped)Array, `channels` per pixel (1 = grey, 4 = RGBA) → PNG bytes */
export function encodePng(w, h, pixels, channels = 4) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 1 ? 0 : 6;
  const stride = w * channels;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** an atlas (web/lib/handheld/atlas.mjs buildAtlas) → { art, cut, layout } file contents */
export async function atlasFiles(atlas) {
  const { encodeLayout } = await import('../../web/lib/handheld/atlas.mjs');
  return {
    art: encodePng(atlas.w, atlas.h, atlas.rgba, 4),
    cut: encodePng(atlas.sw, atlas.sh, atlas.sdf, 1),
    layout: Buffer.from(`${JSON.stringify(encodeLayout(atlas))}\n`),
  };
}
