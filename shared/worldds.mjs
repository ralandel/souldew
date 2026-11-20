// Shared World on the DS (docs/MULTIPLAYER.md › 9, "Gen 4"): the partners drawn into the 3D field of Platinum,
// Diamond/Pearl and HeartGold/SoulSilver. As on the GBA nothing is written into the game – souldew reads where the
// player stands and how the game's own 3D camera looks at the field, and draws the partners on top of the picture.
//
// The camera is not modelled per map: every map type (the perspective camera outdoors, the orthographic one in most
// houses, HGSS's per-map tilts, the camera easing after the player) ends up in the same two matrices the game hands
// to NitroSystem's 3D engine – NNS_G3dGlb's projection and camera (view) matrices. souldew reads those and projects a
// world point exactly the way the geometry engine does: row vector × camera (4×3) × projection (4×4), then the
// viewport of the top screen.
//
// Timing: the picture shows the geometry of the game's previous main-loop iteration (the field runs at 30 fps; the
// matrices in RAM already belong to the frame being built). `Displayed` keeps one snapshot per iteration – told apart by
// gSystem.frameCounter, which the VBlank interrupt counts up and the main loop clears – and hands out the one the
// picture was drawn with. Measured against the real picture (block matching over 300+ frames while walking, turning
// and with the camera easing): 0.15 px mean, 0.55 px worst in Platinum's interiors; under a pixel outdoors in HeartGold.
//
// This module has no browser in it: the tables, the reads, the projection and the sprites' decoding live here (tests:
// test/worldds.test.mjs), the overlay in web/lib/worldds.mjs.
import { DIR } from './world.mjs';

const hex = (v) => (typeof v === 'string' ? parseInt(v, 16) : Number(v));
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const s32 = (b, o) => u32(b, o) | 0;
const ok = (b, n) => !!b && b.length >= n;
const inRam = (p) => p >= 0x02000000 && p < 0x02400000;

/** One tile of the field in world units (fx32 / 4096): 16, a player stands on its centre (tile × 16 + 8). */
export const DS_TILE = 16;
export const DS_SCREEN = { w: 256, h: 192 };
/** Game families whose maps share ids and coordinates: Diamond, Pearl and Platinum (map headers 0–558 are the same). */
export const DS_FAMILIES = { dppt: 21, hgss: 22 };

// Gen 4 facing (DIR_NORTH 0, SOUTH 1, WEST 2, EAST 3) → the wire's (shared/world.mjs DIR)
const FACING = [DIR.N, DIR.S, DIR.W, DIR.E];
/** PlayerAvatar states → the wire's kinds (walking, cycling, surfing; the rest – fishing, saving … – show walking). */
const KIND = { 0: 'walk', 1: 'bike', 2: 'surf' };

/**
 * The Shared World table of a DS game (addresses.json › world), or null: { gen: 4, id, family, fam, fieldSystem
 * (the static FieldSystem pointer), glb (NNS_G3dGlb), system (gSystem), off: FieldSystem field offsets, avatar:
 * PlayerAvatar offsets, sprites: the overworld texture names in the ROM, mmodel: their NARC }.
 */
export function dsWorldTable(entry) {
  const w = entry?.world;
  if (!w || entry.gen !== 4 || !w.fieldSystem || !w.g3dGlb || !w.system) return null;
  return {
    gen: 4,
    id: entry.id,
    family: w.family,
    fam: DS_FAMILIES[w.family] || 0,
    fieldSystem: hex(w.fieldSystem),
    glb: hex(w.g3dGlb),
    system: hex(w.system),
    off: { location: hex(w.off.location), mapMatrix: hex(w.off.mapMatrix), playerAvatar: hex(w.off.playerAvatar), task: hex(w.off.task), running: hex(w.off.runningFieldMap), followMon: w.off.followMon ? hex(w.off.followMon) : 0 },
    avatar: { mapObject: hex(w.avatar.mapObject), state: hex(w.avatar.state), gender: hex(w.avatar.gender) },
    mmodel: w.mmodel,
    sprites: w.sprites,
    followers: w.followers || 'icons',
    foot: w.billboardFoot ?? 4,
    // how far toward the camera the game draws its billboards (world units in view space – measured on the player's own
    // sprite in the depth buffer: Platinum 8, HeartGold 17): a partner is as deep as a game sprite on its tile
    toward: w.billboardDepth ?? 8,
    icons: w.icons || null,
    screen: DS_SCREEN,
  };
}

/**
 * The heap objects of the field as the RAM mirror has them now: { fs, obj (the player's MapObject), pav, loc, mm, pm }
 * or null (no field: the title screen, a battle's own program in D/P). They move whenever a map is loaded – the
 * overlay asks again now and then and watches the new addresses.
 */
export function dsPointers(t, read) {
  const p = read(t.fieldSystem, 4);
  if (!ok(p, 4)) return null;
  const fs = u32(p, 0);
  if (!inRam(fs)) return null;
  const f = read(fs, 0x80);
  if (!ok(f, 0x80)) return null;
  const pm = u32(f, 0);
  const pav = u32(f, t.off.playerAvatar);
  const loc = u32(f, t.off.location);
  const mm = u32(f, t.off.mapMatrix);
  if (!inRam(pm) || !inRam(pav) || !inRam(loc) || !inRam(mm)) return null;
  const a = read(pav, 0x34);
  if (!ok(a, 0x34)) return null;
  const obj = u32(a, t.avatar.mapObject);
  if (!inRam(obj)) return null;
  // HeartGold/SoulSilver: the Pokémon walking behind you (FieldSystem.followMon) and its MapObject
  let follow = 0;
  if (t.off.followMon) {
    const fm = read(fs + t.off.followMon, 4);
    const p = ok(fm, 4) ? u32(fm, 0) : 0;
    follow = inRam(p) ? p : 0;
  }
  return { fs, pm, pav, loc, mm, obj, follow };
}

/**
 * What the overlay needs with every picture (the native player's WATCH): the two matrices, gSystem's counters and
 * keys, the FieldSystem's fields, the player's MapObject, the avatar's state, the location and the map matrix –
 * 9 ranges, ~330 bytes.
 */
export function dsWatchRanges(t, ptr) {
  if (!t) return [];
  const r = [
    [t.glb + 8, 0x74], // projMtx (4×4), mtxmode, cameraMtx (4×3)
    [t.system + 0x2c, 0x10], // vblankCounter, frameCounter, buttonMode, heldKeysRaw
    [t.fieldSystem, 4],
  ];
  if (ptr) {
    r.push([ptr.fs, 0x70], [ptr.pm, 8], [ptr.obj + 0x28, 0x54], [ptr.pav + t.avatar.state, 8], [ptr.loc, 4], [ptr.mm, 4]);
    // (HGSS: followMon's species … form, and its MapObject's facing and position)
    if (t.off.followMon) r.push([ptr.fs + t.off.followMon, 0x1c]);
    if (ptr.follow) r.push([ptr.follow + 0x28, 4], [ptr.follow + 0x70, 12]);
  }
  return r;
}

const fx = (b, o) => s32(b, o) / 4096;

/**
 * One picture's reading: { fc, vb, keys, P, C (matrices), field, task, running, child, map, matrix: [w, h, id],
 * player: { tx, ty, tz, x, y, z, facing, state, gender } } – `ptr` the pointers it was watched with. Null while the
 * bytes aren't there; `field: false` when there is no field to draw on.
 */
export function dsReadFrame(t, read, ptr) {
  const g = read(t.glb + 8, 0x74);
  const s = read(t.system + 0x2c, 0x10);
  if (!ok(g, 0x74) || !ok(s, 0x10)) return null;
  const P = [];
  for (let i = 0; i < 16; i++) P.push(fx(g, i * 4));
  const C = [];
  for (let i = 0; i < 12; i++) C.push(fx(g, 0x44 + i * 4));
  const out = { vb: u32(s, 0), fc: u32(s, 4), keys: u32(s, 0x0c), P, C, field: false };
  const fp = read(t.fieldSystem, 4);
  if (!ptr || !ok(fp, 4) || u32(fp, 0) !== ptr.fs) return out;
  const f = read(ptr.fs, 0x70);
  const pm = read(ptr.pm, 8);
  const o = read(ptr.obj + 0x28, 0x54);
  const a = read(ptr.pav + t.avatar.state, 8);
  const loc = read(ptr.loc, 4);
  const mm = read(ptr.mm, 4);
  if (!ok(f, 0x70) || !ok(pm, 8) || !ok(o, 0x54) || !ok(a, 8) || !ok(loc, 4) || !ok(mm, 4)) return out;
  // (the player's MapObject from 0x28: facing 0x28, … grid x/y/z 0x64–0x6c, pos 0x70–0x78)
  const at = (k) => k - 0x28;
  const st = s32(a, 0);
  // HGSS: FollowMon { mapObject, …, species +0x10, gender +0x14, active +0x16, shiny +0x17, form +0x18 }
  let follow = null;
  const fm = t.off.followMon ? read(ptr.fs + t.off.followMon, 0x1c) : null;
  if (ok(fm, 0x1c) && ptr.follow && u32(fm, 0) === ptr.follow) {
    const fo = read(ptr.follow + 0x28, 4);
    const fp = read(ptr.follow + 0x70, 12);
    if (ok(fo, 4) && ok(fp, 12)) follow = { species: u32(fm, 0x10), active: !!fm[0x16], shiny: !!fm[0x17], form: u16(fm, 0x18), facing: s32(fo, 0), x: fx(fp, 0), y: fx(fp, 4), z: fx(fp, 8) };
  }
  return {
    ...out,
    follow,
    field: true,
    task: u32(f, t.off.task),
    running: u32(f, t.off.running),
    parent: u32(pm, 0),
    child: u32(pm, 4),
    map: s32(loc, 0),
    matrix: [mm[0], mm[1], mm[2]],
    player: {
      facing: s32(o, at(0x28)),
      tx: s32(o, at(0x64)),
      ty: s32(o, at(0x68)),
      tz: s32(o, at(0x6c)),
      x: fx(o, at(0x70)),
      y: fx(o, at(0x74)),
      z: fx(o, at(0x78)),
      state: st,
      gender: u32(a, t.avatar.gender - t.avatar.state) & 1,
    },
  };
}

/**
 * The reading the picture on screen was drawn with. Feed every picture's reading in order; one snapshot is kept per
 * main-loop iteration (the first reading after the VBlank that follows the iteration's work – frameCounter ≥ 1 after
 * a 0 – updated by later readings of the same iteration when the game ran late), and the picture shows the one before
 * the newest (`lag` 1).
 */
export class Displayed {
  constructor({ lag = 1, keep = 4 } = {}) {
    this.lag = lag;
    this.keep = keep;
    this.q = [];
    this.lastFc = null;
  }
  feed(r) {
    if (!r) return this.shown;
    if (r.fc) {
      if (this.lastFc === 0 || !this.q.length) {
        this.q.push(r);
        if (this.q.length > this.keep) this.q.shift();
      } else this.q[this.q.length - 1] = r;
    }
    this.lastFc = r.fc;
    return this.shown;
  }
  get shown() {
    return this.q.length ? this.q[Math.max(0, this.q.length - 1 - this.lag)] : null;
  }
  reset() {
    this.q = [];
    this.lastFc = null;
  }
}

/**
 * A world point on the top screen, as the geometry engine puts it there: { x, y (picture px), w (clip w), s (how
 * many pixels one world unit covers at that depth – a billboard's scale) } or null behind the camera.
 */
export function project(m, x, y, z) {
  if (!m) return null;
  const { P, C } = m;
  const vx = x * C[0] + y * C[3] + z * C[6] + C[9];
  const vy = x * C[1] + y * C[4] + z * C[7] + C[10];
  const vz = x * C[2] + y * C[5] + z * C[8] + C[11];
  const cx = vx * P[0] + vy * P[4] + vz * P[8] + P[12];
  const cy = vx * P[1] + vy * P[5] + vz * P[9] + P[13];
  const cw = vx * P[3] + vy * P[7] + vz * P[11] + P[15];
  if (!(cw > 1e-6)) return null;
  return { x: (cx / cw + 1) * (DS_SCREEN.w / 2), y: (1 - cy / cw) * (DS_SCREEN.h / 2), w: cw, s: (P[0] * DS_SCREEN.w) / 2 / cw };
}

/**
 * Where the game draws a 32×32 billboard standing at a world point (measured on the player: centred, its bottom `foot`
 * pixels below the projected point at scale 1 – Platinum 4, HeartGold 5): its top-left and size on the picture, or null.
 */
export function billboard(m, x, y, z, w = 32, h = 32, foot = 4) {
  const p = project(m, x, y, z);
  if (!p) return null;
  const k = p.s;
  return { x: p.x - (w / 2) * k, y: p.y - (h - foot) * k, w: w * k, h: h * k, k, foot: p.y + foot * k, cx: p.x };
}

/**
 * The map a position belongs to for the partners: in a map matrix of several maps (the overworld, big caves) the
 * coordinates run across them all, so the matrix is the key (0x8000 | its id); a single-map matrix (a house) is keyed by
 * its map header.
 */
export const dsMapKey = (r) => (r?.matrix && r.matrix[0] * r.matrix[1] > 1 ? 0x8000 | r.matrix[2] : r?.map ?? 0) & 0xffff;

/**
 * The local player for the partners from a reading: { map, x, y (world units on the ground plane: x and z), h
 * (height), tx, ty (the tile, x and z), facing (wire), kind, gender } or null.
 */
export function dsPlayer(t, r) {
  const p = r?.field ? r.player : null;
  if (!p || p.facing < 0 || p.facing > 3) return null;
  return { map: dsMapKey(r), x: p.x, y: p.z, h: p.y, tx: p.tx, ty: p.tz, facing: FACING[p.facing], kind: KIND[p.state] || 'walk', gender: p.gender };
}

/**
 * Can partners be drawn now? The field map runs (its program is the field's, nothing on top of it – a menu screen,
 * the bag, a battle run as the field's child) and no event holds the player (a script, a message, a warp's fade).
 */
export const dsDrawable = (r) => !!r?.field && !!r.running && !!r.parent && !r.child && !r.task;

/** The tile in front of a player and the partner standing on it (same map key, about the same height) – or null. */
export function dsFacedPartner(local, partners) {
  if (!local) return null;
  const step = { [DIR.S]: [0, 1], [DIR.N]: [0, -1], [DIR.W]: [-1, 0], [DIR.E]: [1, 0] }[local.facing] || [0, 0];
  const fx0 = local.tx + step[0];
  const fz0 = local.ty + step[1];
  for (const { slot, state } of partners) {
    if (!state || state.hidden || state.map !== local.map) continue;
    if (Math.floor(state.x / DS_TILE) === fx0 && Math.floor(state.y / DS_TILE) === fz0 && Math.abs((state.h ?? local.h) - local.h) < DS_TILE) return slot;
  }
  return null;
}

// ---- the overworld sprites from the ROM (BTX0 textures) -----------------------------------------------------------
/**
 * The textures of a BTX0 file (NitroSystem's texture container): [{ name, w, h, fmt, off, c0 }], the palettes
 * [{ name, off }] and where their data lies – or null for anything else. Formats 2/3/4 (2, 4 and 8 bits per pixel,
 * palette) are what the field's sprites use.
 */
export function parseBtx(b) {
  if (!b || b.length < 0x40 || u32(b, 0) !== 0x30585442) return null; // 'BTX0'
  const T = u32(b, 0x10);
  if (T + 0x3c > b.length || u32(b, T) !== 0x30584554) return null; // 'TEX0'
  const dict = (off, parse) => {
    const o = T + off;
    if (o + 8 > b.length) return [];
    const n = b[o + 1];
    const e = o + u16(b, o + 6);
    const unit = u16(b, e);
    const names = e + u16(b, e + 2);
    if (names + n * 16 > b.length) return [];
    const out = [];
    for (let i = 0; i < n; i++) {
      let name = '';
      for (let k = 0; k < 16 && b[names + i * 16 + k]; k++) name += String.fromCharCode(b[names + i * 16 + k]);
      out.push({ name, ...parse(e + 4 + i * unit) });
    }
    return out;
  };
  const textures = dict(u16(b, T + 0x0e), (p) => {
    const v = u32(b, p);
    return { off: (v & 0xffff) << 3, w: 8 << ((v >> 20) & 7), h: 8 << ((v >> 23) & 7), fmt: (v >> 26) & 7, c0: (v >> 29) & 1 };
  });
  const palettes = dict(u32(b, T + 0x34), (p) => ({ off: u16(b, p) << 3 }));
  return { b, T, texData: T + u32(b, T + 0x14), palData: T + u32(b, T + 0x38), textures, palettes };
}

/** A BTX0 texture as RGBA (transparent colour 0 where the texture says so). */
export function btxTexture(btx, tex, pal = btx.palettes[0]) {
  const { b } = btx;
  const n = tex.w * tex.h;
  const rgba = new Uint8ClampedArray(n * 4);
  const bits = { 2: 2, 3: 4, 4: 8 }[tex.fmt];
  if (!bits || !pal) return null;
  const base = btx.texData + tex.off;
  if (base + (n * bits) / 8 > b.length) return null;
  const colors = 1 << bits;
  const lut = [];
  for (let i = 0; i < colors; i++) {
    const at = btx.palData + pal.off + i * 2;
    const c = at + 1 < b.length ? u16(b, at) : 0;
    lut.push([((c & 31) * 255) / 31, (((c >> 5) & 31) * 255) / 31, (((c >> 10) & 31) * 255) / 31]);
  }
  for (let i = 0; i < n; i++) {
    const bit = i * bits;
    const ci = (b[base + (bit >> 3)] >> (bit & 7)) & (colors - 1);
    if (ci === 0 && tex.c0) continue;
    const [r, g, bl] = lut[ci];
    rgba.set([r, g, bl, 255], i * 4);
  }
  return rgba;
}

/**
 * A sprite sheet from a BTX0: the frames in their order (texture names end in ".1", ".2" … – the dictionary keeps
 * them sorted as text), each { rgba, w, h }, plus the box of opaque pixels over all of them (the head line).
 */
export function btxSheet(b) {
  const btx = parseBtx(b);
  if (!btx || !btx.textures.length) return null;
  const order = [...btx.textures].sort((p, q) => (Number(p.name.split('.').pop()) || 0) - (Number(q.name.split('.').pop()) || 0));
  const frames = order.map((tex) => ({ rgba: btxTexture(btx, tex), w: tex.w, h: tex.h }));
  if (frames.some((f) => !f.rgba)) return null;
  const { w, h } = frames[0];
  let top = h;
  for (const f of frames.slice(0, 8)) {
    for (let i = 3; i < f.rgba.length; i += 4) {
      if (f.rgba[i]) {
        top = Math.min(top, Math.floor((i >> 2) / f.w));
        break;
      }
    }
  }
  return { name: order[0].name.replace(/\.\d+$/, ''), w, h, frames, top };
}

/** The index of the first BTX0 in a NARC whose first texture is called `name` (".1" etc. left out), or −1. */
export function findBtx(files, name) {
  for (let i = 0; i < files.length; i++) {
    const btx = parseBtx(files[i]);
    if (btx?.textures.some((x) => x.name.replace(/\.\d+$/, '') === name)) return i;
  }
  return -1;
}

/**
 * Which frame of a player's sheet shows (wire facing, walking/running, the distance walked in world units): the
 * walking sheets have four frames per direction (north, south, west, east: standing, step, standing, step), a
 * running half after them (frames 16–31) when the sheet has it; bikes 24 frames, surfing 4 (one per direction).
 */
export function dsAvatarFrame(sheet, facing, moving, dist, speed = 1, kind = 'walk') {
  const d = { [DIR.N]: 0, [DIR.S]: 1, [DIR.W]: 2, [DIR.E]: 3 }[facing] ?? 1;
  const n = sheet.frames.length;
  if (n <= 4 || kind === 'surf') return Math.min(n - 1, d);
  const step = moving ? Math.floor(dist / 8) % 4 : 0;
  const run = moving && kind === 'walk' && speed > 1.5 && n >= 32;
  const i = (run ? 16 : 0) + d * 4 + step;
  return i < n ? i : d * 4;
}

/**
 * A follower's frame (HeartGold/SoulSilver's own overworld Pokémon: eight frames, two per direction in the order
 * north, south, west, east).
 */
export function dsFollowerFrame(sheet, facing, moving, dist) {
  const d = { [DIR.N]: 0, [DIR.S]: 1, [DIR.W]: 2, [DIR.E]: 3 }[facing] ?? 1;
  const i = d * 2 + (moving ? Math.floor(dist / 8) & 1 : 0);
  return Math.min(sheet.frames.length - 1, i);
}

/**
 * HeartGold/SoulSilver's table from species to its overworld Pokémon (sModelIndexLUT: u16 per National Dex number,
 * 0 for none and Bulbasaur, then counting up with the female and form sprites in between) – found in the game's ARM9
 * by its shape, so any language or randomized copy works. Returns the table's start in `arm9`, or −1.
 */
export function findFollowerTable(arm9, count = 494) {
  if (!arm9) return -1;
  const need = count * 2;
  outer: for (let o = 0; o + need <= arm9.length; o += 2) {
    if (u16(arm9, o) !== 0 || u16(arm9, o + 2) !== 0 || u16(arm9, o + 4) !== 1 || u16(arm9, o + 6) !== 2) continue;
    let prev = 2;
    for (let i = 4; i < count; i++) {
      const v = u16(arm9, o + i * 2);
      if (v <= prev || v - prev > 28) continue outer;
      prev = v;
    }
    return o;
  }
  return -1;
}

// ---- followers in Diamond/Pearl/Platinum: the Pokémon's party icon --------------------------------------------------
/** The first 30 entries after "none" of the icons' palette table (Bulbasaur … Nidorino): how the table is found. */
const ICON_PAL_KEY = [1, 1, 1, 0, 0, 0, 0, 2, 2, 1, 1, 0, 1, 2, 2, 0, 0, 0, 2, 1, 0, 0, 2, 2, 2, 0, 2, 2, 2, 2];

/** The icons' palette numbers (u8 per icon) in the game's ARM9, found by their first entries: the offset, or −1. */
export function findIconPalettes(arm9) {
  if (!arm9) return -1;
  outer: for (let o = 1; o + ICON_PAL_KEY.length < arm9.length; o++) {
    for (let i = 0; i < ICON_PAL_KEY.length; i++) if (arm9[o + i] !== ICON_PAL_KEY[i]) continue outer;
    return o - 1;
  }
  return -1;
}

/**
 * A Pokémon's party icon from the icon NARC (an NCLR with the palettes first, then cells and animations, then one
 * NCGR per icon from "none" on): { w: 32, h: 32, frames: [rgba, rgba], top, bottom, left, right } – two frames, the
 * box of their opaque pixels – or null. `pals`: the palette numbers (findIconPalettes' table, indexed by species).
 */
export function dsMonIcon(files, pals, species) {
  if (!files?.length || !pals || !(species > 0 && species <= 493)) return null;
  const first = files.findIndex((f) => f && u32(f, 0) === 0x4e434752); // 'RGCN'
  const g = first >= 0 ? files[first + species] : null;
  const nclr = files[0];
  if (!g || u32(g, 0) !== 0x4e434752 || !nclr || u32(nclr, 0) !== 0x4e434c52) return null;
  const char = u16(g, 0x0c);
  const data = char + 0x20;
  const pal = u16(nclr, 0x0c) + 0x18 + (pals[species] & 7) * 32;
  if (data + 1024 > g.length || pal + 32 > nclr.length) return null;
  const lut = [];
  for (let i = 0; i < 16; i++) {
    const c = u16(nclr, pal + i * 2);
    lut.push([((c & 31) * 255) / 31, (((c >> 5) & 31) * 255) / 31, (((c >> 10) & 31) * 255) / 31]);
  }
  const frames = [new Uint8ClampedArray(32 * 32 * 4), new Uint8ClampedArray(32 * 32 * 4)];
  let top = 32, bottom = -1, left = 32, right = -1;
  // 32×32 per frame in 8×8 tiles, row by row (OBJ 1D): 16 tiles a frame
  for (let tile = 0; tile < 32; tile++) {
    for (let py = 0; py < 8; py++) {
      for (let px = 0; px < 8; px++) {
        const byte = g[data + tile * 32 + py * 4 + (px >> 1)];
        const ci = px & 1 ? byte >> 4 : byte & 15;
        if (!ci) continue;
        const f = tile >> 4;
        const t = tile & 15;
        const x = (t & 3) * 8 + px;
        const y = (t >> 2) * 8 + py;
        frames[f].set([...lut[ci], 255], (y * 32 + x) * 4);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
  }
  return bottom < 0 ? null : { w: 32, h: 32, frames, top, bottom, left, right };
}

/**
 * The overworld graphics a game draws its players with, from this computer's ROM: `files` the mmodel NARC's members,
 * `names` the table's texture names { walk: [male, female], bike: [...], surf: [...] }. Returns { walk: [sheet,
 * sheet], bike, surf } with null where a sheet isn't found (a hack that renamed it: that kind shows walking).
 */
export function dsAvatarSheets(files, names) {
  const out = {};
  for (const [kind, pair] of Object.entries(names || {})) {
    out[kind] = (pair || []).map((n) => {
      const i = findBtx(files, n);
      return i >= 0 ? btxSheet(files[i]) : null;
    });
  }
  return out;
}

// ---- the field's light -----------------------------------------------------------------------------------------------
/**
 * How the game lights its billboards right now, measured on the local player's own sprite: HeartGold/SoulSilver tint
 * the field by the time of day (a blue evening, a dark night), caves are darker – a partner drawn in full colour would
 * glow. `pic`: the picture { w, h, fmt (0 BGRA, 2 RGB565), px } (the top screen is its first 256×192, or the left half
 * side by side – `stride` its width); `frame`: the player's frame { rgba, w, h } drawn with its top-left at (x, y).
 * Returns [r, g, b] multipliers (least squares over the sprite's opaque pixels) with the fit's mean error, or null when
 * the sprite isn't there as expected (something covers it, it's another frame: the error is large). `keep(sx, sy)`:
 * only those pixels (where the depth says they are the player's own – not a follower in front of them).
 */
export function measureTint(pic, frame, x, y, keep = null) {
  if (!pic || !frame) return null;
  const { w: pw, fmt, px } = pic;
  const sum = [[0, 0], [0, 0], [0, 0]];
  const pairs = [];
  for (let r = 0; r < frame.h; r++) {
    for (let c = 0; c < frame.w; c++) {
      const i = (r * frame.w + c) * 4;
      if (!frame.rgba[i + 3]) continue;
      const sx = x + c;
      const sy = y + r;
      if (sx < 0 || sy < 0 || sx >= DS_SCREEN.w || sy >= DS_SCREEN.h || (keep && !keep(sx, sy))) continue;
      let R, G, B;
      if (fmt === 2) {
        const v = px[(sy * pw + sx) * 2] | (px[(sy * pw + sx) * 2 + 1] << 8);
        R = (((v >> 11) & 31) * 255) / 31;
        G = (((v >> 5) & 63) * 255) / 63;
        B = ((v & 31) * 255) / 31;
      } else {
        const o = (sy * pw + sx) * 4;
        R = px[o + 2];
        G = px[o + 1];
        B = px[o];
      }
      const want = [frame.rgba[i], frame.rgba[i + 1], frame.rgba[i + 2]];
      const got = [R, G, B];
      for (let k = 0; k < 3; k++) {
        sum[k][0] += got[k] * want[k];
        sum[k][1] += want[k] * want[k];
      }
      pairs.push([got, want]);
    }
  }
  if (pairs.length < 32) return null;
  const tint = sum.map(([a, b]) => (b ? Math.min(1.2, a / b) : 1));
  let err = 0;
  for (const [got, want] of pairs) for (let k = 0; k < 3; k++) err += Math.abs(got[k] - tint[k] * want[k]);
  err /= pairs.length * 3;
  return { tint, err };
}

// ---- the map in front: the DS's own depth buffer ----------------------------------------------------------------------
/**
 * The depth value the DS keeps for a world point (24 bits, as the geometry engine computes it – melonDS GPU3D.cpp):
 * Z-buffered `((z/w)·0x4000 + 0x3FFF)·0x200`, W-buffered the clip w (fx 12-bit). `toward`: the point moved that many world
 * units toward the camera first (a margin). Null behind the camera.
 */
export function depthAt(m, x, y, z, { wbuffer = false, toward = 0 } = {}) {
  if (!m) return null;
  const { P, C } = m;
  const vx = x * C[0] + y * C[3] + z * C[6] + C[9];
  const vy = x * C[1] + y * C[4] + z * C[7] + C[10];
  const vz = x * C[2] + y * C[5] + z * C[8] + C[11] + toward; // (the camera looks down −z: nearer is more)
  const cz = vx * P[2] + vy * P[6] + vz * P[10] + P[14];
  const cw = vx * P[3] + vy * P[7] + vz * P[11] + P[15];
  if (!(cw > 1e-6)) return null;
  const d = wbuffer ? cw * 4096 : ((cz / cw) * 0x4000 + 0x3fff) * 0x200;
  return Math.max(0, Math.min(0xffffff, Math.round(d)));
}

/**
 * The host's DEPTH message: { frame, wbuffer, rects: [{ x, y, w, h, d: Uint32Array }] } or null (nothing kept: an
 * older core, a frame without 3D).
 */
export function parseDepth(bytes) {
  if (!bytes || bytes.length < 8) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = v.getInt32(4, true);
  if (flags <= 0) return null;
  const rects = [];
  let o = 8;
  while (o + 8 <= bytes.length) {
    const x = v.getInt16(o, true);
    const y = v.getInt16(o + 2, true);
    const w = v.getUint16(o + 4, true);
    const h = v.getUint16(o + 6, true);
    o += 8;
    if (!w || !h || o + w * h * 4 > bytes.length) break;
    const d = new Uint32Array(w * h);
    for (let i = 0; i < w * h; i++) d[i] = v.getUint32(o + i * 4, true);
    o += w * h * 4;
    rects.push({ x, y, w, h, d });
  }
  return { frame: v.getUint32(0, true), wbuffer: !!(flags & 2), rects };
}

/** The depth at a pixel of the top screen from a parsed DEPTH (−1 where no rectangle has it). */
export function depthPixel(depth, sx, sy) {
  for (const r of depth?.rects || []) {
    const x = sx - r.x;
    const y = sy - r.y;
    if (x >= 0 && y >= 0 && x < r.w && y < r.h) return r.d[y * r.w + x];
  }
  return -1;
}

/**
 * What of a sprite the map hides: a mask (1 = hidden) over the screen box { x, y, w, h } (whole pixels) where the depth
 * is nearer than `limit` – the depth a game sprite standing there has (its billboard is drawn a few units toward the
 * camera), a little nearer still. `footY`: rows from there down are left alone (Infinity: none). `null`: no depth for
 * the box (nothing to hide by).
 */
export function depthMask(depth, box, footY, limit) {
  if (!depth || limit === null) return null;
  const mask = new Uint8Array(box.w * box.h);
  let known = false;
  for (let r = 0; r < box.h; r++) {
    const sy = box.y + r;
    if (sy >= footY) break;
    for (let c = 0; c < box.w; c++) {
      const d = depthPixel(depth, box.x + c, sy);
      if (d < 0) continue;
      known = true;
      if (d < limit) mask[r * box.w + c] = 1;
    }
  }
  return known ? mask : null;
}

/**
 * The rectangles to ask the host's depth for: the boxes things are drawn in, a margin around (they move before the
 * next answer), merged where they overlap, clipped to the screen – at most 8 and 16384 pixels (the host's limits).
 */
export function depthRects(boxes, margin = 10) {
  let rs = boxes.map((b) => {
    const x0 = Math.max(0, Math.floor((b.x - margin) / 8) * 8);
    const y0 = Math.max(0, Math.floor((b.y - margin) / 8) * 8);
    const x1 = Math.min(DS_SCREEN.w, Math.ceil((b.x + b.w + margin) / 8) * 8);
    const y1 = Math.min(DS_SCREEN.h, Math.ceil((b.y + b.h + margin) / 8) * 8);
    return [x0, y0, x1, y1];
  }).filter(([x0, y0, x1, y1]) => x1 > x0 && y1 > y0);
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < rs.length; i++) {
      for (let j = i + 1; j < rs.length; j++) {
        const a = rs[i];
        const b = rs[j];
        if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) {
          rs[i] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
          rs.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  rs = rs.map(([x0, y0, x1, y1]) => [x0, y0, x1 - x0, y1 - y0]).sort((a, b) => a[2] * a[3] - b[2] * b[3]);
  const out = [];
  let px = 0;
  for (const r of rs) {
    if (out.length >= 8 || px + r[2] * r[3] > 16384) break;
    out.push(r);
    px += r[2] * r[3];
  }
  return out;
}
