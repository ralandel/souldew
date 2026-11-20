// The partners' sprites for the Shared World overlay (shared/world.mjs), taken from the local game's own ROM at run
// time – souldew ships no Nintendo graphics. Gen 3: the object event graphics table (gObjectEventGraphicsInfoPointers)
// → the graphics info of the player's avatar (size, palette tag, frame images, animations) → its 4bpp frames and the
// palette with that tag (sObjectEventSpritePalettes). Randomized ROMs keep these; a hack that moved the tables is
// searched for; anything that doesn't look right gives null (the overlay then draws nothing for that partner).

const ROM_BASE = 0x08000000;
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Is `p` a pointer into this ROM (with `n` bytes behind it)? */
const inRom = (rom, p, n = 1) => p >= ROM_BASE && p - ROM_BASE + n <= rom.length;
const SIZES = new Set([8, 16, 32, 64]);

/** A graphics info struct (0x24 bytes) at ROM address `p` that looks like an object event's: { w, h, palTag, images, anims }. */
export function graphicsInfoAt(rom, p) {
  if (!inRom(rom, p, 0x24) || p & 3) return null;
  const o = p - ROM_BASE;
  const tileTag = u16(rom, o);
  const palTag = u16(rom, o + 2);
  const w = u16(rom, o + 8);
  const h = u16(rom, o + 10);
  const anims = u32(rom, o + 0x18);
  const images = u32(rom, o + 0x1c);
  if (tileTag !== 0xffff || (palTag & 0xff00) !== 0x1100 || !SIZES.has(w) || !SIZES.has(h) || !inRom(rom, images, 8) || !inRom(rom, anims, 4)) return null;
  return { w, h, palTag, images, anims };
}

/** The graphics info pointer table: at `hint` if it is right there, else searched (a hack that moved it). */
export function findGraphicsTable(rom, hint = 0) {
  const good = (a) => inRom(rom, a, 64 * 4) && [0, 1, 2, 3, 4, 5, 6, 7].every((i) => graphicsInfoAt(rom, u32(rom, a - ROM_BASE + i * 4)));
  if (hint && good(hint)) return hint;
  // entry 0 is always the (male) player: 16×32, palette 0x1100
  for (let o = 0; o + 64 <= rom.length; o += 4) {
    if (rom[o + 3] !== 0x08) continue;
    const g = graphicsInfoAt(rom, u32(rom, o));
    if (!g || g.w !== 16 || g.h !== 32 || g.palTag !== 0x1100) continue;
    if (good(ROM_BASE + o)) return ROM_BASE + o;
  }
  return 0;
}

/** The 16 colours (RGBA) of the object palette with `tag`: from the palette table at `hint`, else searched. */
export function findPalette(rom, tag, hint = 0) {
  const entryAt = (o) => (o + 8 <= rom.length && inRom(rom, u32(rom, o), 32) && u16(rom, o + 6) === 0 ? u16(rom, o + 4) : -1);
  const fromTable = (o) => {
    for (let i = 0; i < 64; i++) {
      const tg = entryAt(o + i * 8);
      if (tg === tag) return u32(rom, o + i * 8) - ROM_BASE;
      if (tg < 0 || tg === 0x11ff || (tg & 0xff00) !== 0x1100) return -1;
    }
    return -1;
  };
  let at = hint && inRom(rom, hint, 8) ? fromTable(hint - ROM_BASE) : -1;
  if (at < 0) {
    // a table of { ptr, tag, 0 } entries, the tags 0x11xx in a row
    for (let o = 0; o + 24 <= rom.length && at < 0; o += 4) {
      if (rom[o + 3] !== 0x08 || entryAt(o) !== tag || (entryAt(o + 8) & 0xff00) !== 0x1100) continue;
      at = u32(rom, o) - ROM_BASE;
    }
  }
  if (at < 0) return null;
  const pal = new Uint8Array(16 * 4);
  for (let i = 0; i < 16; i++) {
    const c = u16(rom, at + i * 2);
    const r = c & 31;
    const g = (c >> 5) & 31;
    const b = (c >> 10) & 31;
    pal.set([(r << 3) | (r >> 2), (g << 3) | (g >> 2), (b << 3) | (b >> 2), i ? 255 : 0], i * 4);
  }
  return pal;
}

/** One frame: 4bpp tiles (8×8, 1D mapping: row by row) → RGBA pixels. */
export function decode4bpp(rom, off, w, h, pal) {
  const px = new Uint8ClampedArray(w * h * 4);
  const tw = w >> 3;
  for (let t = 0; t < tw * (h >> 3); t++) {
    const bx = (t % tw) * 8;
    const by = Math.floor(t / tw) * 8;
    for (let i = 0; i < 32; i++) {
      const v = rom[off + t * 32 + i];
      for (const [n, ci] of [[0, v & 15], [1, v >> 4]]) {
        if (!ci) continue;
        const x = bx + ((i & 3) << 1) + n;
        const y = by + (i >> 2);
        px.set(pal.subarray(ci * 4, ci * 4 + 4), (y * w + x) * 4);
      }
    }
  }
  return px;
}

/**
 * The animations of a graphics info (union AnimCmd lists): per animation index [{ img, dur, flip }] (one loop). Frame
 * commands are { imageValue:16, duration:6, hFlip:1, vFlip:1 }; END (-1), JUMP (-3) and LOOP (-2) end a list here.
 */
export function readAnims(rom, animsPtr, count = 24) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const p = u32(rom, animsPtr - ROM_BASE + i * 4);
    if (!inRom(rom, p, 4)) break;
    const list = [];
    for (let j = 0; j < 16; j++) {
      const c = u32(rom, p - ROM_BASE + j * 4);
      const type = c & 0xffff;
      if (type >= 0xfffc) break; // END / LOOP / JUMP (and the rest of the command kinds)
      list.push({ img: type, dur: Math.max(1, (c >> 16) & 0x3f), flip: !!((c >> 22) & 1) });
    }
    if (!list.length) break;
    out.push(list);
  }
  return out;
}

/**
 * Everything the overlay needs to draw one avatar: { w, h, frames: [RGBA], anims } – or null.
 * `t`: shared/world.mjs worldTable; `gfx`: the graphics id (gfxFor).
 */
export function gen3Avatar(rom, t, gfx, cache = {}) {
  if (!rom || !t) return null;
  const table = (cache.table ??= findGraphicsTable(rom, t.graphicsInfo));
  if (!table) return null;
  const g = graphicsInfoAt(rom, u32(rom, table - ROM_BASE + gfx * 4));
  if (!g) return null;
  const pal = findPalette(rom, g.palTag, t.spritePalettes);
  if (!pal) return null;
  const anims = readAnims(rom, g.anims);
  const n = Math.min(64, Math.max(1, ...anims.flat().map((c) => c.img + 1)));
  const size = (g.w * g.h) >> 1;
  const frames = [];
  for (let i = 0; i < n; i++) {
    const o = g.images - ROM_BASE + i * 8;
    const data = u32(rom, o);
    if (!inRom(rom, data, size) || u16(rom, o + 4) !== size) break;
    frames.push(decode4bpp(rom, data - ROM_BASE, g.w, g.h, pal));
  }
  if (!frames.length) return null;
  // animation frames that point past the images found would draw nothing: keep the lists to what exists
  const safe = anims.map((l) => l.filter((c) => c.img < frames.length)).map((l) => (l.length ? l : [{ img: 0, dur: 8, flip: false }]));
  return { w: g.w, h: g.h, frames, anims: safe };
}

/** The image of an animation at `time` (game frames since it began): { img, flip }. */
export function animFrame(avatar, anim, time) {
  const list = avatar?.anims?.[anim] || avatar?.anims?.[anim % 4] || [{ img: 0, dur: 1, flip: false }];
  const total = list.reduce((n, c) => n + c.dur, 0) || 1;
  let k = ((time % total) + total) % total;
  for (const c of list) {
    if (k < c.dur) return c;
    k -= c.dur;
  }
  return list[0];
}

/**
 * The frame the game shows for a sprite right now (the local player: shared/world.mjs readLocalSprite) – the image of
 * its current animation command, decoded with `pal`. Cached by image address. Returns RGBA pixels or null.
 */
export function liveFrame(rom, spr, pal, cache = new Map()) {
  if (!rom || !spr || !pal || !inRom(rom, spr.anims, 4) || !inRom(rom, spr.images, 8)) return null;
  const list = u32(rom, spr.anims - ROM_BASE + spr.animNum * 4);
  if (!inRom(rom, list, 4 * (spr.cmd + 1))) return null;
  const img = u32(rom, list - ROM_BASE + spr.cmd * 4) & 0xffff;
  if (img >= 0xfffc || img > 255) return null;
  const size = (spr.w * spr.h) >> 1;
  const o = spr.images - ROM_BASE + img * 8;
  const data = u32(rom, o);
  if (!inRom(rom, data, size) || u16(rom, o + 4) !== size) return null;
  const key = `${data}:${spr.w}x${spr.h}`;
  if (!cache.has(key)) {
    if (cache.size > 64) cache.clear();
    cache.set(key, decode4bpp(rom, data - ROM_BASE, spr.w, spr.h, pal));
  }
  return cache.get(key);
}

/** The palette of the avatar with graphics id `gfx` (for liveFrame). */
export function avatarPalette(rom, t, gfx, cache = {}) {
  const table = (cache.table ??= findGraphicsTable(rom, t.graphicsInfo));
  const g = table && graphicsInfoAt(rom, u32(rom, table - ROM_BASE + gfx * 4));
  return g ? findPalette(rom, g.palTag, t.spritePalettes) : null;
}
