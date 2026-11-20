// The map's top layer for the Shared World overlay (shared/world.mjs, docs/MULTIPLAYER.md › 9): which pixels of the map
// the game draws *above* object sprites – tree tops, roofs, the leaves of potted plants, the counter in front of the
// nurse – so a partner drawn by souldew disappears behind them exactly where the real player would. Nothing is
// shipped: the tilesets come from the local game's own ROM (the one the page already loaded for the sprites), the
// map's blocks from its RAM (shared/world.mjs readMapView).
//
// Gen 3 draws a map out of metatiles (16×16): eight tile entries – four for the bottom layer, four for the top – and an
// attribute word with the layer type (pokeemerald src/field_camera.c DrawMetatile). NORMAL and SPLIT put the top four
// tiles on BG1, which has priority 1 and so covers object sprites (OAM priority 2); COVERED puts them on BG2, under the
// sprites. Only the opacity of the top tiles matters here (colour index 0 = transparent), not their colours.

const ROM_BASE = 0x08000000;
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const inRom = (rom, p, n = 1) => p >= ROM_BASE && p - ROM_BASE + n <= rom.length;

/**
 * How each game family keeps its tilesets (struct Tileset, include/global.fieldmap.h): the primary tileset fills the
 * first metatiles and VRAM tiles, the secondary the rest of 1024. Emerald/RS: u16 attributes after the metatiles, the
 * layer type in bits 12–15; FR/LG: 640 of each in the primary, u32 attributes after the tileset callback, the layer
 * type in bits 29–30 (pokefirered src/fieldmap.c sMetatileAttrMasks).
 */
export const TILESET_FORMATS = {
  rs: { primaryMetatiles: 512, primaryTiles: 512, attrAt: 0x10, attrSize: 2 },
  e: { primaryMetatiles: 512, primaryTiles: 512, attrAt: 0x10, attrSize: 2 },
  frlg: { primaryMetatiles: 640, primaryTiles: 640, attrAt: 0x14, attrSize: 4 },
};
const TOTAL = 1024;
export const LAYER = { NORMAL: 0, COVERED: 1, SPLIT: 2 };

/** The layer type from a metatile's attributes. */
export const layerType = (fmt, attr) => (fmt.attrSize === 4 ? (attr >>> 29) & 3 : (attr >> 12) & 15);
/** Does a metatile of this layer type draw its top tiles above object sprites? */
export const coversObjects = (layer) => layer === LAYER.NORMAL || layer === LAYER.SPLIT;

// An object's OAM priority by its elevation (sElevationToPriority, src/event_object_movement.c): on a bridge or a
// raised walkway (priority 1, or 0) the sprite is drawn above BG1 – nothing on the map covers it then.
const ELEVATION_PRIORITY = [2, 2, 2, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 0, 0, 2];
export const aboveTopLayer = (elevation) => ELEVATION_PRIORITY[elevation & 15] < 2;

/**
 * The GBA BIOS's LZ77 (LZ77UnComp, type 0x10) at ROM offset `off`: the decoded bytes (at most `max`), or null when
 * the data isn't LZ77 or runs past the ROM.
 */
export function lz77(rom, off, max = 0x10000) {
  if (off < 0 || off + 4 > rom.length || rom[off] !== 0x10) return null;
  const size = Math.min(max, rom[off + 1] | (rom[off + 2] << 8) | (rom[off + 3] << 16));
  const out = new Uint8Array(size);
  let o = 0;
  let i = off + 4;
  while (o < size) {
    if (i >= rom.length) return null;
    const flags = rom[i++];
    for (let bit = 0x80; bit && o < size; bit >>= 1) {
      if (flags & bit) {
        if (i + 1 >= rom.length) return null;
        const len = (rom[i] >> 4) + 3;
        const disp = (((rom[i] & 15) << 8) | rom[i + 1]) + 1;
        i += 2;
        if (disp > o) return null;
        for (let k = 0; k < len && o < size; k++, o++) out[o] = out[o - disp];
      } else {
        if (i >= rom.length) return null;
        out[o++] = rom[i++];
      }
    }
  }
  return out;
}

/** A map layout (struct MapLayout) at ROM address `p`: { width, height, primary, secondary } (tileset addresses) or null. */
export function readLayout(rom, p) {
  if (!inRom(rom, p, 0x18) || p & 3) return null;
  const o = p - ROM_BASE;
  const width = u32(rom, o);
  const height = u32(rom, o + 4);
  const primary = u32(rom, o + 0x10);
  const secondary = u32(rom, o + 0x14);
  if (!width || !height || width > 0x400 || height > 0x400 || !inRom(rom, primary, 0x18)) return null;
  return { width, height, primary, secondary: inRom(rom, secondary, 0x18) ? secondary : 0 };
}

/**
 * A tileset (struct Tileset) at ROM address `p`: { tiles (4bpp bytes, decompressed), metatiles, attrs (ROM offsets),
 * count (metatiles) } – or null. `secondary`: the second half of the 1024 metatiles / tiles.
 */
export function readTileset(rom, p, fmt, secondary) {
  if (!p || !inRom(rom, p, 0x18)) return null;
  const o = p - ROM_BASE;
  const nTiles = secondary ? TOTAL - fmt.primaryTiles : fmt.primaryTiles;
  const count = secondary ? TOTAL - fmt.primaryMetatiles : fmt.primaryMetatiles;
  const tilesPtr = u32(rom, o + 4);
  const metatiles = u32(rom, o + 0xc);
  const attrs = u32(rom, o + fmt.attrAt);
  if (!inRom(rom, tilesPtr, 32) || !inRom(rom, metatiles, 16) || !inRom(rom, attrs, fmt.attrSize) || attrs & 1) return null;
  const t = tilesPtr - ROM_BASE;
  // (compressed tiles are what most tilesets have; an uncompressed one is just as many tiles as fit)
  const tiles = rom[o] ? lz77(rom, t, nTiles * 32) : rom.subarray(t, Math.min(rom.length, t + nTiles * 32));
  if (!tiles) return null;
  return { tiles, metatiles: metatiles - ROM_BASE, attrs: attrs - ROM_BASE, count };
}

/**
 * The 16×16 coverage of a metatile's top layer (1 = an opaque pixel), or null when nothing in it is opaque.
 * `entries`: its four top tile entries (top-left, top-right, bottom-left, bottom-right: tile index in bits 0–9, h-flip
 * bit 10, v-flip bit 11); `tile(index)`: that tile's 32 bytes of 4bpp, or null (unknown: transparent).
 */
export function topLayerMask(entries, tile) {
  let out = null;
  for (let q = 0; q < 4; q++) {
    const e = entries[q];
    const px = tile(e & 0x3ff);
    if (!px) continue;
    const hf = e & 0x400;
    const vf = e & 0x800;
    const ox = (q & 1) * 8;
    const oy = (q >> 1) * 8;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const sx = hf ? 7 - x : x;
        const sy = vf ? 7 - y : y;
        const b = px[sy * 4 + (sx >> 1)];
        if (!((sx & 1 ? b >> 4 : b) & 15)) continue;
        (out ??= new Uint8Array(256))[(oy + y) * 16 + ox + x] = 1;
      }
    }
  }
  return out;
}

/**
 * Everything about one map layout's tilesets that the overlay needs: mask(metatileId) → the top-layer coverage of
 * that metatile (built on first use, then kept), or null where it covers nothing. null when the layout can't be read
 * (an unknown ROM layout: the overlay then simply draws without occlusion). `cache`: decoded tilesets by address –
 * many maps share them, and decoding is the only costly part.
 */
export function mapTop(rom, family, layoutPtr, cache = new Map()) {
  const fmt = TILESET_FORMATS[family];
  const layout = fmt && rom ? readLayout(rom, layoutPtr) : null;
  if (!layout) return null;
  const tileset = (p, secondary) => {
    const k = `${p}:${secondary}`;
    if (!cache.has(k)) cache.set(k, readTileset(rom, p, fmt, secondary));
    return cache.get(k);
  };
  const prim = tileset(layout.primary, false);
  if (!prim) return null;
  const sec = layout.secondary ? tileset(layout.secondary, true) : null;
  const tile = (i) => {
    const [ts, k] = i < fmt.primaryTiles ? [prim, i] : [sec, i - fmt.primaryTiles];
    if (!ts || (k + 1) * 32 > ts.tiles.length) return null;
    return ts.tiles.subarray(k * 32, k * 32 + 32);
  };
  const masks = new Map();
  const mask = (id) => {
    if (!(id >= 0 && id < TOTAL)) return null;
    if (masks.has(id)) return masks.get(id);
    let m = null;
    const [ts, k] = id < fmt.primaryMetatiles ? [prim, id] : [sec, id - fmt.primaryMetatiles];
    const a = ts && ts.attrs + (k + 1) * fmt.attrSize <= rom.length ? ts.attrs + k * fmt.attrSize : -1;
    const e = ts ? ts.metatiles + k * 16 + 8 : -1;
    if (a >= 0 && e + 8 <= rom.length && coversObjects(layerType(fmt, fmt.attrSize === 4 ? u32(rom, a) : u16(rom, a)))) {
      m = topLayerMask([u16(rom, e), u16(rom, e + 2), u16(rom, e + 4), u16(rom, e + 6)], tile);
    }
    masks.set(id, m);
    return m;
  };
  return { key: `${layout.primary}:${layout.secondary}`, layout, mask };
}

/**
 * Which pixels of a sprite's rectangle the map's top layer hides: Uint8Array(w × h), 1 = hidden – or null when none
 * is. `rect`: { x, y, w, h } in world pixels of the map (tile × 16); `blockAt(mx, my)` → the metatile id there (or
 * −1); `maskOf(id)` → 16×16 coverage or null (mapTop's mask).
 */
export function coverMask(rect, blockAt, maskOf) {
  const { x, y, w, h } = rect;
  let out = null;
  for (let my = Math.floor(y / 16); my <= Math.floor((y + h - 1) / 16); my++) {
    for (let mx = Math.floor(x / 16); mx <= Math.floor((x + w - 1) / 16); mx++) {
      const id = blockAt(mx, my);
      const m = id >= 0 ? maskOf(id) : null;
      if (!m) continue;
      const x0 = Math.max(x, mx * 16);
      const x1 = Math.min(x + w, mx * 16 + 16);
      const y0 = Math.max(y, my * 16);
      const y1 = Math.min(y + h, my * 16 + 16);
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          if (m[(py - my * 16) * 16 + (px - mx * 16)]) (out ??= new Uint8Array(w * h))[(py - y) * w + (px - x)] = 1;
        }
      }
    }
  }
  return out;
}
