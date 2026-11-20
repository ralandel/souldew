// The Pokémon that follows a player in the Shared World overlay (shared/world.mjs Follower, docs/MULTIPLAYER.md › 9).
// Gen 3 retail games have no overworld sprites of Pokémon, so the follower is the Pokémon's party-menu icon: 32×32,
// two frames, 4bpp, one of six shared palettes – taken from the local game's own ROM at run time, like the partners'
// sprites (shared/worldsprites.mjs). souldew ships no Pokémon graphics.
//
// The tables (pokeemerald src/pokemon_icon.c, the same in Ruby/Sapphire and FireRed/LeafGreen, every language) lie
// one after the other in the ROM: gMonIconTable (440 pointers: the species by their internal index, the Egg at 412,
// Unown B–? from 413), gMonIconPaletteIndices (440 bytes, 0–5) and gMonIconPaletteTable (6 × { palette, tag 0xDAC0 + i }).
// They're found by that palette table's tags – no per-revision addresses, so other languages and randomized ROMs
// (which keep the tables) work the same. A hack that changed the table (more species, other tags) isn't recognised:
// no follower then.

const ROM_BASE = 0x08000000;
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const inRom = (rom, p, n = 1) => p >= ROM_BASE && p - ROM_BASE + n <= rom.length;

export const ICON = { w: 32, h: 32, frames: 2, count: 440, egg: 412, unownB: 413, palTag: 0xdac0 };
const FRAME_BYTES = (ICON.w * ICON.h) >> 1;

/**
 * The icon tables of a Gen 3 ROM: { table, indices, palettes } (ROM addresses) or null. `hint`: a known palette table
 * address to try first (none needed – the search is one pass over the ROM, ~20 ms).
 */
export function findMonIcons(rom, hint = 0) {
  if (!rom || rom.length < 0x100000) return null;
  const palAt = (o) => {
    for (let i = 0; i < 6; i++) {
      const e = o + i * 8;
      if (e + 8 > rom.length || u16(rom, e + 4) !== ICON.palTag + i || u16(rom, e + 6) !== 0 || !inRom(rom, u32(rom, e), 32)) return false;
    }
    return true;
  };
  const tables = (o) => {
    // the palette indices right before the palette table, the icon pointers right before those
    const indices = o - ICON.count;
    const table = indices - ICON.count * 4;
    if (table < 0 || table & 3) return null;
    for (let i = 0; i < ICON.count; i++) if (rom[indices + i] > 5) return null;
    for (let i = 0; i < ICON.count; i++) if (!inRom(rom, u32(rom, table + i * 4), FRAME_BYTES)) return null;
    return { table: table + ROM_BASE, indices: indices + ROM_BASE, palettes: o + ROM_BASE };
  };
  if (hint && inRom(rom, hint, 48) && palAt(hint - ROM_BASE)) {
    const r = tables(hint - ROM_BASE);
    if (r) return r;
  }
  for (let o = 0; o + 48 <= rom.length; o += 4) {
    // (cheap first test: the first entry's tag and a ROM pointer)
    if (rom[o + 4] !== 0xc0 || rom[o + 5] !== 0xda || rom[o + 3] !== 0x08 || !palAt(o)) continue;
    const r = tables(o);
    if (r) return r;
  }
  return null;
}

/** The six icon palettes as RGBA (index 0 transparent). */
export function iconPalettes(rom, icons) {
  if (!icons) return null;
  const out = [];
  for (let i = 0; i < 6; i++) {
    const p = u32(rom, icons.palettes - ROM_BASE + i * 8) - ROM_BASE;
    const pal = new Uint8Array(64);
    for (let c = 0; c < 16; c++) {
      const v = u16(rom, p + c * 2);
      const r = v & 31;
      const g = (v >> 5) & 31;
      const b = (v >> 10) & 31;
      pal.set([(r << 3) | (r >> 2), (g << 3) | (g >> 2), (b << 3) | (b >> 2), c ? 255 : 0], c * 4);
    }
    out.push(pal);
  }
  return out;
}

/** One 32×32 frame: 4bpp tiles, 1D mapping (4×4 tiles, row by row) → RGBA. */
function decodeFrame(rom, off, pal) {
  const px = new Uint8ClampedArray(ICON.w * ICON.h * 4);
  for (let t = 0; t < 16; t++) {
    const bx = (t & 3) * 8;
    const by = (t >> 2) * 8;
    for (let i = 0; i < 32; i++) {
      const v = rom[off + t * 32 + i];
      for (const [n, ci] of [[0, v & 15], [1, v >> 4]]) {
        if (!ci) continue;
        const x = bx + ((i & 3) << 1) + n;
        const y = by + (i >> 2);
        px.set(pal.subarray(ci * 4, ci * 4 + 4), (y * ICON.w + x) * 4);
      }
    }
  }
  return px;
}

/**
 * The icon of internal species `idx` (iconIndex): { w, h, frames: [RGBA, RGBA], top, bottom, left, right } – the
 * box of its opaque pixels over both frames (the follower stands on its bottom row) – or null.
 * `deoxys`: the game's own Deoxys form icon (Emerald Speed, FireRed Attack, LeafGreen Defense: right after the normal one).
 */
export function monIcon(rom, icons, idx, { deoxys = false, cache = null } = {}) {
  if (!rom || !icons || !Number.isInteger(idx) || idx <= 0 || idx >= ICON.count) return null;
  const key = `${idx}:${deoxys ? 1 : 0}`;
  if (cache?.has(key)) return cache.get(key);
  let img = u32(rom, icons.table - ROM_BASE + idx * 4);
  if (deoxys) img += 2 * FRAME_BYTES;
  const palIdx = rom[icons.indices - ROM_BASE + idx];
  const pals = (cache && cache.pals) || iconPalettes(rom, icons);
  if (cache) cache.pals = pals;
  let out = null;
  if (inRom(rom, img, 2 * FRAME_BYTES) && pals?.[palIdx]) {
    const frames = [0, 1].map((f) => decodeFrame(rom, img - ROM_BASE + f * FRAME_BYTES, pals[palIdx]));
    let top = ICON.h;
    let bottom = -1;
    let left = ICON.w;
    let right = -1;
    for (const f of frames) {
      for (let i = 3; i < f.length; i += 4) {
        if (!f[i]) continue;
        const p = i >> 2;
        const x = p % ICON.w;
        const y = (p / ICON.w) | 0;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
    if (bottom >= 0) out = { w: ICON.w, h: ICON.h, frames, top, bottom, left, right };
  }
  cache?.set(key, out);
  return out;
}

// ---- which icon --------------------------------------------------------------------------------------------------
/** The Unown letter (0 = A … 25 = Z, 26 = !, 27 = ?) from the personality value (GetUnownLetterByPersonality). */
export function unownLetter(pid) {
  const p = pid >>> 0;
  return (((p & 0x03000000) >>> 18) | ((p & 0x00030000) >>> 12) | ((p & 0x00000300) >>> 6) | (p & 0x00000003)) % 28;
}

export const NAT = { UNOWN: 201, DEOXYS: 386 };

/** National Dex number → Gen 3 internal species index, from shared/data/gen3_index_to_dex.json's map (internal → dex). */
export function dexToInternal(map) {
  const out = new Map();
  for (const [k, v] of Object.entries(map || {})) if (v) out.set(Number(v), Number(k));
  return out;
}

/**
 * The icon index of a follower { species (National Dex), form }: Unown's letters have icons of their own (form = the
 * letter), everything else by its internal index. 0 when the game has no such species (newer generations, a hack).
 */
export function iconIndex(toInternal, species, form = 0) {
  if (species === NAT.UNOWN && form > 0 && form < 28) return ICON.unownB + form - 1;
  const idx = toInternal?.get(species) || 0;
  return idx > 0 && idx < ICON.egg ? idx : 0;
}

/**
 * The lead of a party as live tracking reads it (shared/live/parse.mjs): the first Pokémon that isn't an egg and
 * hasn't fainted → { species, shiny, form } or null. form: Unown's letter, else 0.
 */
export function leadOf(party) {
  const m = (party || []).find((x) => x && !x.isEgg && x.species > 0 && (x.hp ?? 1) > 0);
  if (!m) return null;
  return { species: m.species, shiny: !!m.shiny, form: m.species === NAT.UNOWN && Number.isFinite(m.pid) ? unownLetter(m.pid) : 0 };
}
