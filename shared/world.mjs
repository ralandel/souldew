// Shared World (docs/MULTIPLAYER.md › 9): the partners of a SoulLink walk visibly in your own game when they are on
// the same map, and you can walk up to them and press A. souldew draws them as an overlay on top of the emulator
// picture – nothing is written into the game's memory, no game objects are injected.
//
// This module is the part without a browser: which RAM to read per game (shared/data/addresses.json › world, from the
// pret symbol files), what a player's state is, the compact message the players exchange, the interpolation that makes
// 10–15 messages a second look like 60 fps, and the rules for when a partner is drawn. The overlay itself is
// web/lib/worldoverlay.mjs (in the player page), the network side web/lib/sharedworld.mjs (in the play view).
//
// Coordinates are world pixels of the current map: tile × 16 (+ the sub-tile offset while walking). Gen 3 map coords
// are SaveBlock1 `pos` (the camera's tile = the player's tile), the object events' coords carry +7 (MAP_OFFSET).

import { gbWorldTable, gbWatchRanges, gbReadCamera, gbReadPlayer, gbDrawable, gbLocalSprite, gbReadConnections, gbPopupRect } from './worldgb.mjs';

const hex = (v) => (typeof v === 'string' ? parseInt(v, 16) : Number(v));
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const s16 = (b, o) => (u16(b, o) << 16) >> 16;
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const s32 = (b, o) => u32(b, o) | 0;
const ok = (b, n) => !!b && b.length >= n;

export const TILE = 16;
const FRAME_MS = 1000 / 59.7275;
/** Directions as the games number them (Gen 3 DIR_*): 1 south, 2 north, 3 west, 4 east. */
export const DIR = { S: 1, N: 2, W: 3, E: 4 };
const STEP = { 1: [0, 1], 2: [0, -1], 3: [-1, 0], 4: [1, 0] };

/** Avatar kinds (what the player rides or does). Index = the number on the wire. */
export const KINDS = ['walk', 'mach', 'acro', 'bike', 'surf', 'dive', 'fieldmove', 'fish', 'water', 'vsseeker'];
/**
 * Families whose maps share ids: a partner is only drawn in a game of the same family (Ruby ↔ Sapphire, FR ↔ LG; Red,
 * Blue and Yellow; Gold, Silver and Crystal – Gold/Silver maps go out with Crystal's numbers, shared/worldgb.mjs; Diamond,
 * Pearl and Platinum; HeartGold and SoulSilver – shared/worldds.mjs).
 */
export const FAMILIES = { rs: 1, e: 2, frlg: 3, rby: 11, gsc: 13, dppt: 21, hgss: 22 };

// GBA key bits (KEYINPUT / gMain.heldKeys)
export const GBA_KEY = { A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128, R: 256, L: 512 };

/**
 * The Shared World table of a running game, or null where souldew doesn't know its memory (another language, a hack
 * with a moved layout): no overlay then, the board keeps saying where the partner is.
 * `entry`: the addresses.json game (findEntry); `rev`: the ROM's software version (header 0xBC); `code`: its game code
 * (header 0xAC) – one entry can cover several languages that share the RAM but not the ROM (FireRed DE/FR/IT/ES): the
 * ROM addresses are then kept per code and revision ("BPRD:0"), and a language without its own is learned/searched.
 */
export function worldTable(entry, rev = 0, code = '') {
  const w = entry?.world;
  if (w && (entry.gen === 1 || entry.gen === 2)) return gbWorldTable(entry);
  if (!w || entry.gen !== 3) return null;
  const rom = (code && w.rom?.[`${code}:${rev}`]) || w.rom?.[String(rev)] || null;
  const inBattle = entry.inBattle ? { addr: hex(entry.inBattle.addr), mask: hex(entry.inBattle.mask || '0xff') } : null;
  return {
    gen: 3,
    id: entry.id,
    family: w.family,
    fam: FAMILIES[w.family] || 0,
    objectEvents: hex(w.objectEvents),
    playerAvatar: hex(w.playerAvatar),
    fieldCamera: hex(w.fieldCamera),
    saveBlock1Ptr: w.saveBlock1Ptr ? hex(w.saveBlock1Ptr) : 0,
    saveBlock1: w.saveBlock1 ? hex(w.saveBlock1) : 0,
    main: hex(w.main),
    paletteFade: hex(w.paletteFade),
    lock: hex(w.lockFieldControls),
    sprites: w.sprites ? hex(w.sprites) : 0,
    inBattle,
    // the map's top layer (occlusion, shared/worldmap.mjs) and the map-name popup – 0 / null where unknown: off then
    mapHeader: w.mapHeader ? hex(w.mapHeader) : 0,
    backupMap: w.backupMapLayout ? hex(w.backupMapLayout) : 0,
    tasks: w.tasks ? hex(w.tasks) : 0,
    help: w.inHelpSystem ? hex(w.inHelpSystem) : 0,
    // FR/LG's "Previously on your quest…" replays your last steps with the overworld callback, unlocked: gQuestLogState
    // 2/3 (QL_STATE_PLAYBACK*) – 1 is the recording that runs all the time
    questLog: w.questLogState ? hex(w.questLogState) : 0,
    popup: w.mapNamePopup && w.tasks && rom?.mapNamePopupTask
      ? { task: (hex(rom.mapNamePopupTask) | 1) >>> 0, rect: w.mapNamePopup.rect, data: w.mapNamePopup.offsetData ?? null, base: w.mapNamePopup.offsetBase ?? 0 }
      : null,
    // ROM addresses of this revision (unknown revisions: the overworld callback is learned, the tables are searched)
    overworldCb2: rom?.overworldCb2 ? (hex(rom.overworldCb2) | 1) >>> 0 : 0,
    fieldCb2s: fieldCallbacks(entry),
    graphicsInfo: rom?.graphicsInfo ? hex(rom.graphicsInfo) : 0,
    spritePalettes: rom?.spritePalettes ? hex(rom.spritePalettes) : 0,
    avatars: (w.avatars || []).map(([kind, male, female]) => ({ kind, gfx: [male, female] })),
    // where the player's tile is on the 240×160 picture (its top-left corner): the camera keeps the player there
    anchor: { x: 112, y: 72 },
    screen: { w: 240, h: 160 },
  };
}

/**
 * Every overworld callback this entry's ROMs can have (each game code and revision it matches), or null when one of them
 * isn't known (FireRed/LeafGreen in French, Italian, Spanish). readCamera's `field` asks these, so it holds whichever
 * revision runs – the cheats and wagers build their table without the ROM header (revision 0).
 */
function fieldCallbacks(entry) {
  const rom = entry?.world?.rom;
  const m = entry?.match;
  if (!rom || !m) return null;
  const codes = [].concat(m.gameCode ?? '');
  const revs = [].concat(m.softwareVersion ?? 0);
  const out = new Set();
  for (const code of codes) {
    for (const rev of revs) {
      const r = rom[`${code}:${rev}`] || rom[String(rev)];
      if (!r?.overworldCb2) return null;
      out.add((hex(r.overworldCb2) | 1) >>> 0);
    }
  }
  return out.size ? [...out] : null;
}

/** SaveBlock1's address (Emerald and FR/LG move it around: gSaveBlock1Ptr; Ruby/Sapphire: fixed). */
function saveBlock1(t, read) {
  if (t.saveBlock1) return t.saveBlock1;
  const p = read(t.saveBlock1Ptr, 4);
  if (!ok(p, 4)) return 0;
  const a = u32(p, 0);
  return a >= 0x02000000 && a < 0x02040000 ? a : 0;
}

/**
 * The byte ranges the overlay needs with every picture (the native player's WATCH, web/lib/nativeplayer.mjs): the
 * camera's sub-tile offset, SaveBlock1's pos and map, the keys, the screen state, the player's object (where you are
 * for your follower and your partners – from the RAM mirror, ten times a second, it lagged the camera by up to a few
 * tiles). `sb1`: SaveBlock1's address now (it moves – the overlay asks again when it does); `spriteId`/`objId`: the
 * player's sprite and object event (gPlayerAvatar).
 */
export function watchRanges(t, sb1, spriteId = null, objId = null) {
  if (!t) return [];
  if (t.gen <= 2) return gbWatchRanges(t);
  const r = [
    [t.fieldCamera + 0x10, 8], // CameraObject x, y (s32)
    [t.main + 4, 4], // gMain.callback2
    [t.main + 0x2c, 2], // gMain.heldKeys
    [t.paletteFade + 4, 4], // PaletteFadeControl: y, blendColor, active
    [t.lock, 1], // sLockFieldControls
  ];
  if (t.saveBlock1Ptr) r.push([t.saveBlock1Ptr, 4]);
  if (sb1) r.push([sb1, 8]); // pos (x, y), location (mapGroup, mapNum)
  if (t.inBattle) r.push([t.inBattle.addr, 1]);
  if (t.questLog) r.push([t.questLog, 1]);
  r.push([t.playerAvatar, 8]); // running, the player's sprite and object event ids, gender
  if (t.sprites && Number.isInteger(spriteId) && spriteId < 64) r.push([t.sprites + spriteId * 0x44, 0x44]);
  if (Number.isInteger(objId) && objId < 16) r.push([t.objectEvents + objId * 0x24, 0x24]);
  return r;
}

/**
 * The local player's sprite as the game draws it this frame (gSprites[spriteId]: its OAM position, the frame image
 * and the flip) – so a partner walking behind the player can be drawn behind them: { x, y, w, h, images, anims,
 * animNum, cmd, flip } or null. `cam` gives nothing here; the sprite id comes from gPlayerAvatar.
 */
export function readLocalSprite(t, read) {
  if (t?.gen <= 2) return gbLocalSprite(t, read);
  if (!t?.sprites) return null;
  const av = read(t.playerAvatar + 4, 2);
  if (!ok(av, 2) || av[0] >= 64) return null;
  const s = read(t.sprites + av[0] * 0x44, 0x44);
  if (!ok(s, 0x44) || !(s[0x3e] & 1) || s[0x3e] & 4) return null; // inUse, invisible
  const attr0 = u16(s, 0);
  const attr1 = u16(s, 2);
  if ((attr0 >> 8) & 3) return null; // affine / hidden OAM: not the plain player sprite
  const shape = attr0 >> 14;
  const size = attr1 >> 14;
  const dims = [[[8, 8], [16, 16], [32, 32], [64, 64]], [[16, 8], [32, 8], [32, 16], [64, 32]], [[8, 16], [8, 32], [16, 32], [32, 64]]][shape]?.[size];
  if (!dims) return null;
  let x = attr1 & 0x1ff;
  if (x >= 240 + 64) x -= 512;
  let y = attr0 & 0xff;
  if (y >= 160 + 64) y -= 256;
  return { spriteId: av[0], x, y, w: dims[0], h: dims[1], anims: u32(s, 8), images: u32(s, 12), animNum: s[0x2a], cmd: s[0x2b], flip: !!(attr1 & 0x1000) };
}

/** A read function over WATCHED bytes (`ranges` as watchRanges gave them, `bytes` one after the other). */
export function rangeReader(ranges, bytes) {
  const at = [];
  let o = 0;
  for (const [addr, len] of ranges) {
    at.push([addr, len, o]);
    o += len;
  }
  return (addr, len) => {
    for (const [a, l, off] of at) if (addr >= a && addr + len <= a + l && off + (addr - a) + len <= bytes.length) return bytes.subarray(off + (addr - a), off + (addr - a) + len);
    return null;
  };
}

/** The first reader that has the bytes. */
export const chainReaders = (...readers) => (addr, len) => {
  for (const r of readers) {
    const b = r && r(addr, len);
    if (b) return b;
  }
  return null;
};

/**
 * The camera, per picture: { sb1, map, tx, ty (the camera's tile), cx, cy (its world pixels), keys, cb2, locked, fade
 * (0 = clear … 16 = black/white), battle, field (the overworld callback runs) } – or null when SaveBlock1 isn't there
 * yet (title screen, intro).
 */
export function readCamera(t, read, prior = null) {
  if (t?.gen <= 2) return gbReadCamera(t, read, prior);
  const sb1 = saveBlock1(t, read);
  if (!sb1) return null;
  const pos = read(sb1, 8);
  const cam = read(t.fieldCamera + 0x10, 8);
  if (!ok(pos, 8) || !ok(cam, 8)) return null;
  const tx = s16(pos, 0);
  const ty = s16(pos, 2);
  // CameraObject x/y: how far the camera has come from the last tile toward the current one (−15…15); CameraMove()
  // already counted the whole tile in pos when the step began
  const ox = s32(cam, 0);
  const oy = s32(cam, 4);
  if (Math.abs(ox) > 15 || Math.abs(oy) > 15 || Math.abs(tx) > 0x400 || Math.abs(ty) > 0x400) return null;
  const main = read(t.main + 4, 4);
  const keys = read(t.main + 0x2c, 2);
  const fade = read(t.paletteFade + 4, 4);
  const lock = read(t.lock, 1);
  const battle = t.inBattle ? read(t.inBattle.addr, 1) : null;
  const help = t.help ? read(t.help, 1) : null;
  const ql = t.questLog ? read(t.questLog, 1) : null;
  const fadeActive = ok(fade, 4) && !!(fade[3] & 0x80);
  return {
    sb1,
    map: pos[4] * 256 + pos[5],
    tx,
    ty,
    cx: tx * TILE + ox - Math.sign(ox) * TILE,
    cy: ty * TILE + oy - Math.sign(oy) * TILE,
    keys: ok(keys, 2) ? u16(keys, 0) : 0,
    cb2: ok(main, 4) ? u32(main, 0) : 0,
    locked: ok(lock, 1) && lock[0] !== 0,
    fade: fadeActive ? (u16(fade, 0) >> 6) & 0x1f : 0,
    battle: !!(battle && battle[0] & t.inBattle.mask),
    // FR/LG's help screen (L/R) runs over the overworld without locking it or changing the callback
    help: !!(help && help[0]),
    replay: !!(ql && (ql[0] === 2 || ql[0] === 3)),
    // the game's overworld callback running (true), another one – the title screen, the Continue menu, a battle's or a
    // menu's own screen (false) – or null where this revision's isn't known (shared/linkbattle.mjs camIdle)
    field: t.fieldCb2s && ok(main, 4) ? t.fieldCb2s.includes(u32(main, 0)) : null,
  };
}

/**
 * The local player for the partners (read from the RAM mirror, 10–15 times a second): where, which way, riding what.
 * { map, x, y (world px), tx, ty, facing, kind, gender, run } or null. `cam`: readCamera's result of the same moment.
 */
export function readPlayer(t, read, cam = readCamera(t, read)) {
  if (!cam) return null;
  if (t.gen <= 2) return gbReadPlayer(t, read, cam);
  const av = read(t.playerAvatar, 8);
  if (!ok(av, 8)) return null;
  const id = av[5];
  if (id >= 16) return null;
  const o = read(t.objectEvents + id * 0x24, 0x24);
  if (!ok(o, 0x24) || !(o[0] & 1) || !(o[2] & 1)) return null; // active, isPlayer
  const ctx = s16(o, 0x10) - 7;
  const cty = s16(o, 0x12) - 7;
  // the camera follows the player (trackedByCamera): its pixels are the player's; else (a cutscene moved the camera)
  // the player's own tile. (At the start of every step the camera's tile – SaveBlock1's pos – moves on a few frames
  // before the object's currentCoords do, and the object comes from the RAM mirror, which is older still: a tile
  // apart is the same player mid-step – going by the tile there held the follower and the partners' picture of you
  // for 3–6 frames each tile, then jumped them 6–7 px.)
  const follows = (o[1] & 0x80) && Math.abs(ctx - cam.tx) + Math.abs(cty - cam.ty) <= 1;
  const gfx = o[5];
  let kind = 'walk';
  let gender = av[7] & 1;
  for (const a of t.avatars) {
    const g = a.gfx.indexOf(gfx);
    if (g >= 0) {
      kind = a.kind;
      gender = g;
      break;
    }
  }
  return {
    map: cam.map,
    x: follows ? cam.cx : ctx * TILE,
    y: follows ? cam.cy : cty * TILE,
    tx: ctx,
    ty: cty,
    facing: o[0x18] & 0x0f || DIR.S,
    kind,
    gender,
    run: kind === 'walk' && !!(av[0] & 0x80),
    // previousElevation: what the game sets the sprite's priority from – on a bridge nothing on the map covers it
    elev: o[0x0b] >> 4,
  };
}

/**
 * The map as the game holds it now (gMapHeader.mapLayout: the layout in the ROM, for the tilesets; gBackupMapLayout:
 * its blocks in RAM with 7 tiles of the connected maps around them – doors that opened, trees that were cut, the
 * generated floors of the Battle Pyramid are in there): { layout, w, h, map } or null.
 */
export function readMapView(t, read) {
  if (!t?.mapHeader || !t.backupMap) return null;
  const h = read(t.mapHeader, 4);
  const b = read(t.backupMap, 12);
  if (!ok(h, 4) || !ok(b, 12)) return null;
  const layout = u32(h, 0);
  const w = s32(b, 0);
  const hh = s32(b, 4);
  const map = u32(b, 8);
  if (layout < 0x08000000 || layout >= 0x0a000000 || w <= 15 || hh <= 14 || w * hh > 0x2800 || map < 0x02000000 || map + w * hh * 2 > 0x02040000) return null;
  return { layout, w, h: hh, map };
}

/** A reader of the metatile ids of a map view (map coordinates; −1 outside what the game holds). */
export function blockReader(view, read) {
  return (mx, my) => {
    const x = mx + 7;
    const y = my + 7;
    if (!view || x < 0 || y < 0 || x >= view.w || y >= view.h) return -1;
    const b = read(view.map + (y * view.w + x) * 2, 2);
    return ok(b, 2) ? u16(b, 0) & 0x3ff : -1;
  };
}

/**
 * The map-name popup (it slides in at the top left when you enter a town or a route, without holding the player): its
 * rectangle on the picture { x, y, w, h, shown, grows } while the game's popup task runs, else null. The slide offset comes
 * from the task's data (Emerald tYOffset, Ruby data[2], FR/LG tPos; `shown`: the rows on screen by it). The tasks come
 * from the RAM mirror, a few frames late: while the popup grows (`prev`: the last result) 12 rows more are cut away.
 */
export function popupRect(t, read, prev = null) {
  if (t?.gen <= 2) return gbPopupRect(t, read);
  const p = t?.popup;
  if (!p) return null;
  const b = read(t.tasks, 16 * 0x28);
  if (!ok(b, 16 * 0x28)) return null;
  for (let i = 0; i < 16; i++) {
    const o = i * 0x28;
    if (!b[o + 4] || u32(b, o) !== p.task) continue;
    const [x, y, w, h] = p.rect;
    const shown = p.data === null ? h : Math.min(h, Math.abs(p.base - s16(b, o + 8 + p.data * 2)));
    // (the same reading comes back for several pictures in a row: the direction it went last holds until it changes)
    const grows = !prev || (shown === prev.shown ? prev.grows !== false : shown > prev.shown);
    const cut = Math.min(h, shown + (grows ? 12 : 0));
    return cut > 0 ? { x, y, w, h: cut, shown, grows } : null;
  }
  return null;
}

/**
 * Can partners be drawn over the picture right now? The overworld (the game's own overworld callback, or the one
 * learned while the player walked: `learned`), no battle, no menu or script holding the player, no full fade.
 */
export function drawable(t, cam, learned = 0) {
  if (t?.gen <= 2) return gbDrawable(t, cam);
  if (!t || !cam || cam.battle || cam.locked || cam.help || cam.replay || cam.fade >= 16) return false;
  const cb2 = t.overworldCb2 || learned;
  return cb2 ? cam.cb2 === cb2 : true;
}

/**
 * Pressing A toward a partner (the Shared World A menu). A press counts from the moment the button goes down – not
 * from a picture that happens to show it held: a short tap between two drawn pictures (a busy or slow computer draws
 * fewer of them) is still a press.
 *
 * `input(down, now)`: the player's own buttons as the fast player sends them to the game – from the first call on only
 * these count, and true means a press began. `sample(down, now)`: the game's held keys as read with a picture (the
 * browser player – nothing else tells it). `swallow()`: the A that chose in a menu doesn't open it again. `due(now, ms)`:
 * the press is `ms` old – true once.
 */
export class APress {
  constructor() {
    this.held = false;
    this.at = 0;
    this.direct = false; // the buttons come through input()
    this.inputDown = false;
  }

  input(down, now) {
    this.direct = true;
    this.inputDown = !!down;
    if (down && !this.held) {
      this.held = true;
      this.at = now || 1;
      return true;
    }
    if (!down) this.held = false;
    return false;
  }

  sample(down, now) {
    // (the fast player: the buttons themselves say it – a swallowed A is over once it isn't held any more)
    if (this.direct) {
      if (!this.inputDown) this.held = false;
      return false;
    }
    const edge = !!down && !this.held;
    this.held = !!down;
    if (edge) this.at = now || 1;
    return edge;
  }

  swallow() {
    this.held = true;
    this.at = 0;
  }

  cancel() {
    this.at = 0;
  }

  get pending() {
    return !!this.at;
  }

  due(now, ms) {
    if (!this.at || now - this.at < ms) return false;
    this.at = 0;
    return true;
  }
}

/**
 * Starts something once: every call gets the promise of the first – also calls made while it still runs. The Shared
 * World overlay is configured again whenever the play view's players, rules or lead change; a second start while the
 * first still loaded its ROM made a second overlay, and the two took turns at the native player's one WATCH list – the
 * one left without bytes kept its first reading and said "not on the field" (a DS partner flickering away).
 */
export function startOnce(fn) {
  let p = null;
  return (...args) => (p ||= Promise.resolve().then(() => fn(...args)));
}

/**
 * Learns the overworld callback of a game whose revision souldew has no address for: the callback that runs while the
 * camera steps one tile on the same map without a fade is the overworld's (a map change or warp never counts).
 */
export class OverworldLearner {
  constructor() {
    this.prev = null;
    this.votes = new Map();
    this.cb2 = 0;
  }
  feed(cam) {
    const p = this.prev;
    this.prev = cam;
    if (this.cb2 || !p || !cam || cam.fade || p.fade || cam.battle || cam.map !== p.map || cam.cb2 !== p.cb2) return this.cb2;
    if (Math.abs(cam.tx - p.tx) + Math.abs(cam.ty - p.ty) !== 1 || (cam.cb2 & 0xff000001) !== 0x08000001) return this.cb2;
    const n = (this.votes.get(cam.cb2) || 0) + 1;
    this.votes.set(cam.cb2, n);
    if (n >= 3) this.cb2 = cam.cb2;
    return this.cb2;
  }
}

// ---- the message -------------------------------------------------------------------------------------------------
/**
 * A player's state on the wire (~40 bytes of JSON): [v, seq, t, fam, map, x, y, flags, ext?]. flags: facing (bits 0–2),
 * kind (3–6), gender (7), run (8), hidden (9: not on the overworld – nothing to draw), elevation (10–13: 0 from older
 * versions, which counts as the ground). `t`: the sender's clock (ms).
 * `ext` (optional, 3.0 builds before the followers stop reading at index 7 and never see it): what changes seldom –
 * sent when it changed and with the heartbeat (packExt), so ~0 bytes while walking:
 *   f: [species (National Dex), flags (bit 0 shiny, bits 1–5 the form: Unown's letter)] – the Pokémon following them,
 *      0 = none (no lead that can walk, or an egg-only team);
 *   z: [w, h] – the size of their map in tiles (a partner on a connected map north or west of yours is placed by it).
 * `h` (optional, the DS: Gen 4 has heights – stairs, slopes, bridges): the 10th element, world units; a 0 stands in
 * for a missing ext before it. Builds without the DS overlay never read past the ext.
 */
export const WIRE_V = 1;
export function packState(st, seq, t, ext = null) {
  const base = !st || st.hidden
    ? [WIRE_V, seq >>> 0, Math.round(t), st?.fam || 0, 0, 0, 0, 1 << 9]
    : [WIRE_V, seq >>> 0, Math.round(t), st.fam | 0, st.map | 0, Math.round(st.x), Math.round(st.y),
      (st.facing & 7) | (Math.max(0, KINDS.indexOf(st.kind)) << 3) | ((st.gender & 1) << 7) | (st.run ? 1 << 8 : 0) | ((st.elev & 15) << 10)];
  if (ext && (ext.f !== undefined || ext.z)) base.push(ext);
  // the DS field's height (world units: stairs, slopes, bridges) as a 10th element – after the ext or a 0 in its place
  if (st && !st.hidden && Number.isFinite(st.h)) {
    if (base.length === 8) base.push(0);
    base.push(Math.round(st.h));
  }
  return base;
}

/** The ext object for packState from a follower { species, shiny, form } (or null: none) and a map size [w, h]. */
export function packExt({ follower, size } = {}) {
  const ext = {};
  if (follower !== undefined) ext.f = follower && follower.species > 0 ? [follower.species | 0, (follower.shiny ? 1 : 0) | ((follower.form & 31) << 1)] : 0;
  if (size && size[0] > 0 && size[1] > 0) ext.z = [size[0] | 0, size[1] | 0];
  return ext;
}

const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
/** The ext of a wire message: { follower?: { species, shiny, form } | null, size?: [w, h] } – malformed parts left out. */
export function unpackExt(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  const out = {};
  if (e.f === 0 || e.f === null) out.follower = null;
  else if (Array.isArray(e.f) && int(e.f[0], 1, 2047) && int(e.f[1], 0, 63)) out.follower = { species: e.f[0], shiny: !!(e.f[1] & 1), form: e.f[1] >> 1 };
  if (Array.isArray(e.z) && int(e.z[0], 1, 1024) && int(e.z[1], 1, 1024)) out.size = [e.z[0], e.z[1]];
  return Object.keys(out).length ? out : null;
}

/** The other way – null for anything malformed (it comes from the network). */
export function unpackState(a) {
  if (!Array.isArray(a) || a.length < 8 || a[0] !== WIRE_V || !a.slice(1, 8).every(Number.isFinite)) return null;
  const [, seq, t, fam, map, x, y, flags] = a;
  if (Math.abs(x) > 0x8000 || Math.abs(y) > 0x8000 || map < 0 || map > 0xffff) return null;
  const ext = a.length > 8 ? unpackExt(a[8]) : null;
  if (flags & (1 << 9)) return { seq, t, fam, hidden: true, ...(ext ? { ext } : {}) };
  const facing = flags & 7;
  const h = a.length > 9 && Number.isFinite(a[9]) && Math.abs(a[9]) <= 0x8000 ? a[9] : undefined;
  return { seq, t, fam, map, x, y, facing: facing >= 1 && facing <= 4 ? facing : DIR.S, kind: KINDS[(flags >> 3) & 15] || 'walk', gender: (flags >> 7) & 1, run: !!(flags & (1 << 8)), elev: (flags >> 10) & 15, hidden: false, ...(h !== undefined ? { h } : {}), ...(ext ? { ext } : {}) };
}

/** How often the sender sends: while something changes up to 15 a second, else a heartbeat once a second. */
export const SEND = { minMs: 66, idleMs: 1000, relayMs: 2000 };
/** Is `st` different enough from the last sent one to send now? */
export function changed(a, b) {
  if (!a || !b) return a !== b;
  return a.hidden !== b.hidden || a.map !== b.map || a.x !== b.x || a.y !== b.y || a.facing !== b.facing || a.kind !== b.kind || a.run !== b.run || a.gender !== b.gender || (a.elev | 0) !== (b.elev | 0) || (a.h ?? null) !== (b.h ?? null);
}

// ---- interpolation -------------------------------------------------------------------------------------------------
/**
 * The overlay's clock, one tick per game picture: the time a picture belongs to, taken from when the pictures arrive
 * (smoothed – they come a few milliseconds early or late) and the host's frame number in front of their bytes (a
 * picture the page never drew still counts). Everything souldew draws moves with the game's pictures: sampled at
 * this time, a partner steps exactly when the game's own sprites and background do – on the animation frames between
 * two pictures nothing moves, as nothing in the game does. `at(now)`: the time to draw at; once pictures stop coming
 * (a pause, the A menu) it runs on with the real clock.
 */
export class PictureClock {
  constructor({ frameMs = FRAME_MS } = {}) {
    this.frameMs = frameMs;
    this.per = frameMs; // ms per game frame, as measured (a slow computer runs the game slower)
    this.t = null;
    this.frame = null;
    this.seenAt = 0;
  }

  /** A new game picture shows at `now` (`frame`: the host's frame number, if known) – its time on this clock. */
  picture(now, frame = null) {
    let df = 1;
    if (Number.isFinite(frame) && Number.isFinite(this.frame)) df = frame - this.frame;
    if (Number.isFinite(frame)) this.frame = frame;
    if (df === 0 && this.t !== null) return this.t; // (the same picture again)
    if (this.t === null || df < 0 || df > 600) {
      this.t = now;
    } else {
      const was = this.t;
      const ran = this.at(now); // (pictures that stopped for a while: on from where the clock ran to)
      // (never ahead of the moment the picture came: a host that ran several frames between two pictures – a busy
      // computer catching up – counts them, but they took no more time than went by; ahead, the partners ran ahead
      // and jumped back when the clock started over)
      const pred = Math.min(Math.max(this.t + df * this.per, ran), now + this.per / 2);
      const err = now - pred;
      if (err > 120) this.t = Math.max(ran, now - 60); // (a long stall)
      else {
        // (gently: on a busy computer pictures arrive ±10 ms – followed closely, the clock's own steps would wobble by
        // 10 %, and so would a partner's walking speed)
        this.t = pred + err * 0.03;
        if (df <= 4) this.per = Math.min(this.frameMs * 4, Math.max(this.frameMs / 4, this.per + (err / df) * 0.002));
      }
      this.t = Math.max(was, this.t); // (and never back)
    }
    this.seenAt = now;
    return this.t;
  }

  at(now) {
    if (this.t === null) return now;
    const late = now - this.seenAt - 3 * this.per;
    return late > 0 ? this.t + late : this.t;
  }
}

/**
 * Whole pixels for a position that moves in fractions (a partner between two of their states, their follower): the
 * step the position made since the picture before, rounded – not the position rounded. At a constant speed of one
 * pixel a frame a position halfway between two pixels rounded now up, now down (a frame standing, then a double step);
 * this keeps one pixel a frame and stays within ¾ px of the true place. `last`: { v, px } of the picture before (or
 * null: a position seen anew).
 */
export function wholePx(last, v) {
  if (!last || !Number.isFinite(last.v) || Math.abs(v - last.v) > 2 * TILE) return Math.round(v);
  const px = last.px + Math.round(v - last.v);
  return Math.abs(v - px) <= 0.75 ? px : Math.round(v);
}

/**
 * wholePx for a sprite's x and y, kept per sprite: snap(key, x, y) → [x, y] in whole pixels. Round a corner the two
 * axes share the frame's step (each rounded on its own made a diagonal double step there).
 */
export function pixelSnapper() {
  const last = new Map();
  return (key, x, y) => {
    const l = last.get(key);
    let px = wholePx(l?.x, x);
    let py = wholePx(l?.y, y);
    if (l && Math.abs(x - l.x.v) + Math.abs(y - l.y.v) <= 2 * TILE) {
      const n = Math.round(Math.abs(x - l.x.v) + Math.abs(y - l.y.v));
      if (Math.abs(px - l.x.px) + Math.abs(py - l.y.px) > n && px !== l.x.px && py !== l.y.px) {
        // (one axis keeps its pixel this frame: the one that stays closer to its true place)
        if (Math.abs(x - l.x.px) <= Math.abs(y - l.y.px)) px = l.x.px;
        else py = l.y.px;
      }
    }
    last.set(key, { x: { v: x, px }, y: { v: y, px: py } });
    return [px, py];
  };
}

/**
 * When partners move: with every game picture – but while you walk in a game that moves its picture only on some
 * frames (the Game Boy games and the DS field every other one), only on those: on a frame where your camera stood
 * mid-step they wait with it. A partner walking beside you then keeps their place next to you, instead of shaking
 * by a pixel against you and the ground. `at(now, fresh, x, y, map)`: the time to sample partners at – `now` the
 * pictures' clock, `fresh` a new game picture, x/y/map your own position on it (null: unknown).
 */
export class StepGate {
  constructor() {
    this.key = null;
    this.held = false;
    this.moved = false;
    this.t = null;
  }

  at(now, fresh, x = null, y = null, map = null) {
    if (fresh) {
      // (walking: your picture moved on the picture before and stands on this one)
      const known = Number.isFinite(x) && Number.isFinite(y);
      const key = known ? `${map}:${x}:${y}` : null;
      const same = known && key === this.key;
      this.held = same && this.moved;
      this.moved = known && !same && this.key !== null;
      this.key = key;
    } else if (this.t !== null && now - this.t > 3 * FRAME_MS) this.held = false; // (no pictures: a pause – on with the clock)
    if (!this.held || this.t === null || now < this.t) this.t = now;
    return this.t;
  }
}

// how fast a player goes (px per game frame) before a track has measured it: walking 1, running and riding 2
const SPEED = { walk: 1, run: 2, mach: 2, acro: 2, bike: 2, surf: 2, dive: 1 };

/**
 * One partner's track: the states as they arrive, sampled at any moment. The render time trails the newest state by a
 * little more than the usual gap between messages, so there is (almost) always a state on both sides to interpolate
 * between; past the newest one it extrapolates for a short while, then holds. A map change or a jump of more than
 * a few tiles (a warp, Fly) snaps instead of sliding.
 *
 * Players move like the game moves them: along the tile grid at a constant speed, starting and stopping on a tile.
 * The states (10–15 a second) don't say when between two of them a walk began or ended – a straight line from the
 * standing state to the first walking one crept for up to a second, one into the stop slowed down: so a stretch that
 * starts from standing begins as late as the walking speed allows, one that ends a walk goes on at the speed it had,
 * and a stretch round a corner goes round it (along the grid, not across). `grid`: { size, origin } – where players
 * stand (the DS: tile centres).
 */
export class Track {
  constructor({ maxExtrapolate = 150, snapPx = 3 * TILE, grid = { size: TILE, origin: 0 } } = {}) {
    this.buf = [];
    this.offset = null; // our clock minus theirs (smallest seen = least delayed message)
    this.gaps = [];
    this.lastSeq = -1;
    this.maxExtrapolate = maxExtrapolate;
    this.snapPx = snapPx;
    this.grid = grid;
    this.seenAt = 0;
    this.speeds = new Map(); // `kind:run` → px per ms, measured while walking
    this.busy = false; // walking at the last sample (the delay changes only gently then)
  }

  /** A state from the network, `now` on our clock. Old or repeated ones (out of order) are dropped. */
  push(st, now) {
    if (!st || st.seq <= this.lastSeq) return false;
    this.lastSeq = st.seq;
    this.seenAt = now;
    const off = now - st.t;
    // the offset follows a clock that drifts or a path that got slower – slowly, so jitter doesn't shake it; a faster
    // message takes it down at once while the partner stands, by a millisecond a message while they walk (at once, the
    // picture jumped ahead by the difference)
    if (this.offset === null) this.offset = off;
    else if (off < this.offset) this.offset = this.busy ? Math.max(off, this.offset - 1) : off;
    else this.offset += Math.min(2, (off - this.offset) * 0.01);
    const last = this.buf[this.buf.length - 1];
    if (last) {
      const gap = st.t - last.t;
      // (a heartbeat while standing still says nothing about how fast walking states arrive: kept out, or the delay
      // sits at its cap while idle and drops by ~0.5 s the moment the partner walks off – a jump forward)
      if (gap > 0 && gap < SEND.idleMs * 0.9) {
        this.gaps.push(gap);
        if (this.gaps.length > 20) this.gaps.shift();
      }
      this._learn(this.buf[this.buf.length - 2], last, st);
    }
    this.buf.push(st);
    if (this.buf.length > 64) this.buf.shift();
    return true;
  }

  /** Is world pixel `v` where a player stands (on the grid)? */
  _onGrid(v) {
    const g = this.grid.size;
    return (((v - this.grid.origin) % g) + g) % g === 0;
  }

  /** The walking speed, from a stretch in the middle of a walk (off the grid at both ends, moving before it). */
  _learn(p, a, n) {
    if (!p || p.hidden || a.hidden || n.hidden || p.map !== a.map || a.map !== n.map || p.fam !== n.fam) return;
    const T = n.t - a.t;
    const d = Math.abs(n.x - a.x) + Math.abs(n.y - a.y);
    const pd = Math.abs(a.x - p.x) + Math.abs(a.y - p.y);
    if (!(T > 0) || T > SEND.idleMs * 0.9 || !d || d > this.snapPx || !pd || a.t - p.t > SEND.idleMs * 0.9) return;
    if (this._onGrid(a.x) && this._onGrid(a.y)) return;
    if (this._onGrid(n.x) && this._onGrid(n.y)) return;
    const key = `${n.kind}:${n.run ? 1 : 0}`;
    const v = d / T;
    const was = this.speeds.get(key);
    this.speeds.set(key, was ? was + (v - was) * 0.2 : v);
  }

  /** px per ms a player of this kind walks – measured, else the game's usual speed. */
  speedOf(st) {
    return this.speeds.get(`${st.kind}:${st.run ? 1 : 0}`) || (st.run && st.kind === 'walk' ? SPEED.run : SPEED[st.kind] || 1) / FRAME_MS;
  }

  /** The usual gap between two states (ms). */
  get gap() {
    if (!this.gaps.length) return 66;
    return [...this.gaps].sort((a, b) => a - b)[Math.floor(this.gaps.length / 2)];
  }

  /**
   * How far behind the newest state the picture runs (ms): 1.5 typical gaps, plus the half-window a straight walk is
   * evened out over (smoothMs) – 60–600 ms.
   */
  get delay() {
    if (!this.gaps.length) return 120 + this.smoothMs;
    const g = [...this.gaps].sort((a, b) => a - b)[Math.floor(this.gaps.length * 0.75)];
    return Math.min(600, Math.max(60, g * 1.5 + 16 + this.smoothMs));
  }

  /** Half the window a straight walk is evened out over: one usual gap (≤ 100 ms). */
  get smoothMs() {
    return Math.min(100, this.gaps.length ? this.gap : 66);
  }

  /**
   * The delay the picture uses at `now`: follows `delay`, but never faster than half a millisecond per millisecond, so
   * a change in the network's rhythm slows the partner down or speeds them up a little instead of making them jump.
   * While the partner walks it holds (half a millisecond per millisecond made a walking partner 50 % faster or slower
   * for a moment – a stutter, and on whole pixels a double step) – unless the states run out: then it grows by a tenth
   * of a millisecond per millisecond. Asked for an earlier moment than before (a second caller with an older clock) it
   * stays as it is.
   */
  renderDelay(now) {
    const target = this.delay;
    if (this._rd === undefined || !Number.isFinite(this._rdAt)) {
      this._rd = target;
      this._rdAt = now;
    } else if (now > this._rdAt) {
      const rate = !this.busy ? 0.5 : this.starved && target > this._rd ? 0.1 : 0;
      const step = (now - this._rdAt) * rate;
      this._rd = this._rd < target ? Math.min(target, this._rd + step) : Math.max(target, this._rd - step);
      this._rdAt = now;
    }
    return this._rd;
  }

  /**
   * How far along the stretch a → n the player is at render time `rt` (0…1) and at what speed (px per ms), given the
   * state before it (`p`): a walk that ended inside the stretch went on at its speed and then stood; one that began
   * inside it began as late as the walking speed allows. Only a stretch slower than the walk itself is reshaped.
   */
  _progress(p, a, n, d, rt, nn = null) {
    const T = n.t - a.t;
    const lin = Math.min(1, Math.max(0, (rt - a.t) / T));
    const pd = p ? Math.abs(a.x - p.x) + Math.abs(a.y - p.y) : 0;
    const pT = p ? a.t - p.t : 0;
    const standing = this._onGrid(a.x) && this._onGrid(a.y);
    // (the walk goes on past n the same way: n was no stop – a game that moves unevenly within a tile, HeartGold's
    // running, is slow at a tile's edge without standing there)
    const goesOn = !!nn && !nn.hidden && nn.map === n.map && nn.fam === n.fam && nn.t > n.t && nn.t - n.t < SEND.idleMs * 0.9
      && Math.sign(nn.x - n.x) === Math.sign(n.x - a.x) && Math.sign(nn.y - n.y) === Math.sign(n.y - a.y) && (nn.x !== n.x || nn.y !== n.y);
    if (p && pd > 0 && pd <= this.snapPx && pT > 0 && pT < SEND.idleMs * 0.9 && !standing) {
      // mid-step at a: the walk went on at its speed – into the stop at n (the only place it could stand)
      const v = pd / pT;
      if (d / T < 0.8 * v && !goesOn) return { k: Math.min(1, Math.max(lin, (v * (rt - a.t)) / d)), v };
      return { k: lin, v: d / T };
    }
    // standing at a (or the state before was long ago): the walk began as late as its speed lets it arrive on time.
    // (Walking on, a state can fall on a tile's edge too: there only a stretch much slower than walking stood first.)
    const v = Math.max(this.speedOf(n), d / T);
    const rest = !(p && pd > 0 && pd <= this.snapPx && pT > 0 && pT < SEND.idleMs * 0.9);
    if (d / T < (rest ? 0.8 : 0.6) * v) return { k: Math.max(0, 1 - (v * (n.t - rt)) / d), v };
    return { k: lin, v: d / T };
  }

  /**
   * The point `k` (0…1) of the way from a to n along the grid: both coordinates changed – the player went round a
   * corner, one axis after the other (first the one a is between two tiles on, else the one walked before a, else the
   * one away from where n faces). Returns { x, y, dir } (dir: the way it goes there, 1–4).
   */
  _along(p, a, n, k) {
    const dx = n.x - a.x;
    const dy = n.y - a.y;
    const sx = Math.sign(dx);
    const sy = Math.sign(dy);
    const dirOf = (ax) => (ax === 'x' ? (sx > 0 ? DIR.E : DIR.W) : sy > 0 ? DIR.S : DIR.N);
    if (!dx || !dy) return { x: a.x + dx * k, y: a.y + dy * k, dir: dirOf(dx ? 'x' : 'y') };
    let first;
    if (!this._onGrid(a.x)) first = 'x';
    else if (!this._onGrid(a.y)) first = 'y';
    else if (p && p.x !== a.x && p.y === a.y) first = 'x';
    else if (p && p.y !== a.y && p.x === a.x) first = 'y';
    else first = n.facing === DIR.E || n.facing === DIR.W ? 'y' : 'x';
    const d1 = first === 'x' ? Math.abs(dx) : Math.abs(dy);
    const s = k * (Math.abs(dx) + Math.abs(dy));
    if (first === 'x') return s <= d1 ? { x: a.x + sx * s, y: a.y, dir: dirOf('x') } : { x: n.x, y: a.y + sy * (s - d1), dir: dirOf('y') };
    return s <= d1 ? { x: a.x, y: a.y + sy * s, dir: dirOf('y') } : { x: a.x + sx * (s - d1), y: n.y, dir: dirOf('x') };
  }

  /**
   * The state at `now` (our clock): { map, x, y, facing, kind, gender, run, fam, moving, hidden } or null.
   * `conv(state)` (optional): the state's position in the local player's frame – { x, y } or null (another map that
   * isn't connected to yours). With it, x/y come back in that frame (`local: true`, or `away: true` when it has none)
   * and the partner slides across a map connection instead of stopping at the edge.
   */
  sample(now, conv = null) {
    const b = this.buf;
    if (!b.length || this.offset === null) return null;
    const at = (st) => {
      if (!conv) return st;
      const p = st.hidden ? null : conv(st);
      return p ? { ...st, x: p.x, y: p.y, local: true } : { ...st, away: true };
    };
    const same = (p, q) => p.fam === q.fam && (conv ? !!p.local && !!q.local : p.map === q.map);
    const rt = now - this.offset - this.renderDelay(now); // render time on the sender's clock
    let out = this._sample(b, rt, at, same);
    if (out?.moving) out = this._even(b, rt, at, same, out);
    if (now >= (this._busyAt ?? -Infinity)) {
      this.busy = !!out?.moving;
      this.starved = rt > b[b.length - 1].t; // (past the newest state: guessing)
      this._busyAt = now;
    }
    return out;
  }

  /**
   * A straight walk evened out: the mean position over a window of two usual gaps around `rt`, never reaching past
   * where the walk began, turned or stopped (there the window narrows to nothing – starts, stops and corners stay
   * exact). A game that moves its players unevenly within a tile – HeartGold/SoulSilver run 8, 4, 4, 0 units a frame
   * – gave states 12 and 4 units apart by turns, and the partner ran fast and slow by turns; a walk at an even speed
   * is the same with or without it.
   */
  _even(b, rt, at, same, out) {
    let i = b.length - 1;
    while (i > 0 && b[i].t > rt) i--;
    if (i >= b.length - 1) return out; // (past the newest: no window)
    const st = (k) => (b[k] ? at(b[k]) : null);
    // one stretch k → k+1: its way (sign of x, y), and when the walk in it moves – a stretch from standing begins
    // late, one into a stop ends early (shaped: it ends the run of even stretches)
    const seg = (k) => {
      const a = st(k);
      const n = st(k + 1);
      if (!a || !n || a.hidden || n.hidden || !same(a, n) || !(n.t > a.t) || n.t - a.t > SEND.idleMs * 0.9) return null;
      const d = Math.abs(n.x - a.x) + Math.abs(n.y - a.y);
      if (!d || d > this.snapPx || (n.x !== a.x && n.y !== a.y)) return null;
      const p = st(k - 1);
      const { v } = this._progress(p && !p.hidden && same(p, a) ? p : null, a, n, d, a.t, st(k + 2));
      const shaped = Math.abs(v - d / (n.t - a.t)) > 1e-9;
      return { dir: `${Math.sign(n.x - a.x)}:${Math.sign(n.y - a.y)}`, shaped, from: shaped ? Math.max(a.t, n.t - d / v) : a.t, to: shaped ? Math.min(n.t, a.t + d / v) : n.t, a, n, d, v };
    };
    const cur = seg(i);
    if (!cur) return out;
    let from = cur.from;
    let to = cur.to;
    if (!cur.shaped || cur.a.t + cur.d / cur.v >= cur.n.t - 1e-6) {
      // back while the stretches before go the same way evenly (a shaped one – the start – ends it, counted)
      for (let k = i - 1; k >= 0; k--) {
        const q = seg(k);
        if (!q || q.dir !== cur.dir) break;
        from = q.from;
        if (q.shaped) break;
      }
    }
    if (!cur.shaped) {
      for (let k = i + 1; k < b.length - 1; k++) {
        const q = seg(k);
        if (!q || q.dir !== cur.dir) break;
        to = q.to;
        if (q.shaped) break;
      }
    }
    // (the newest state on a tile may be the stop: the walk's speed into it)
    const last = st(b.length - 1);
    if (to >= last.t - 1e-6 && this._onGrid(last.x) && this._onGrid(last.y)) {
      const q = seg(b.length - 2);
      if (q && q.dir === cur.dir) to = Math.min(to, q.a.t + q.d / Math.max(q.v, this.speedOf(q.n)));
    }
    const h = Math.min(this.smoothMs, rt - from, to - rt);
    if (!(h > 1)) return out;
    let x = 0;
    let y = 0;
    const N = 8;
    for (let m = 0; m <= N; m++) {
      const q = this._sample(b, rt - h + (2 * h * m) / N, at, same);
      x += q.x;
      y += q.y;
    }
    return { ...out, x: x / (N + 1), y: y / (N + 1) };
  }

  _sample(b, rt, at, same) {
    let i = b.length - 1;
    while (i > 0 && b[i].t > rt) i--;
    const a = at(b[i]);
    const n = b[i + 1] ? at(b[i + 1]) : null;
    if (a.t > rt) return { ...a, moving: false }; // older than anything we have: the oldest
    if (a.hidden) return { ...a, moving: false };
    const p = b[i - 1] ? at(b[i - 1]) : null;
    const prev = p && !p.hidden && same(p, a) ? p : null;
    if (n && !n.hidden && same(a, n) && n.t > a.t) {
      const d = Math.abs(n.x - a.x) + Math.abs(n.y - a.y);
      if (d > this.snapPx) return { ...a, moving: false };
      if (!d) return { ...a, facing: rt - a.t < (n.t - a.t) / 2 ? a.facing : n.facing, moving: false };
      const nn = b[i + 2] ? at(b[i + 2]) : null;
      const { k, v } = this._progress(prev, a, n, d, rt, nn);
      const pos = this._along(prev, a, n, k);
      const h = Number.isFinite(a.h) && Number.isFinite(n.h) ? { h: a.h + (n.h - a.h) * k } : {};
      const moving = k > 0 && k < 1;
      // (speed in pixels per game frame: 1 walking, 2 running or cycling, more on the Mach Bike)
      return { ...a, ...h, x: pos.x, y: pos.y, facing: moving ? pos.dir : k >= 1 ? n.facing : a.facing, moving, speed: v * FRAME_MS };
    }
    if (n) return { ...a, moving: false }; // the next one is on another map / hidden: hold until it's due
    // past the newest: keep going the way it went, for a moment (a held direction keeps walking in the game too) – at
    // the speed it ended with (a stretch that began from standing: walking speed, not its average), then wait there
    // (going back to the newest state after the moment snapped the partner back by up to 9 px)
    const pd = prev ? Math.abs(a.x - prev.x) + Math.abs(a.y - prev.y) : 0;
    if (prev && a.t > prev.t && pd > 0 && pd <= this.snapPx && (a.x === prev.x || a.y === prev.y)) {
      const pp = b[i - 2] ? at(b[i - 2]) : null;
      const v = this._progress(pp && !pp.hidden && same(pp, prev) ? pp : null, prev, a, pd, a.t).v;
      const vx = (Math.sign(a.x - prev.x) * v) || 0;
      const vy = (Math.sign(a.y - prev.y) * v) || 0;
      const dt = Math.min(rt - a.t, this.maxExtrapolate);
      // never past the tile it was heading for: a stop must not overshoot and snap back
      const g = this.grid.size;
      const o = this.grid.origin;
      const tx = vx > 0 ? Math.ceil((a.x - o) / g) * g + o : vx < 0 ? Math.floor((a.x - o) / g) * g + o : a.x;
      const ty = vy > 0 ? Math.ceil((a.y - o) / g) * g + o : vy < 0 ? Math.floor((a.y - o) / g) * g + o : a.y;
      const clamp = (val, lim, dir) => (dir > 0 ? Math.min(val, lim) : dir < 0 ? Math.max(val, lim) : val);
      const x = clamp(a.x + vx * dt, tx, vx);
      const y = clamp(a.y + vy * dt, ty, vy);
      const going = rt - a.t < this.maxExtrapolate && (x !== tx || !vx) && (y !== ty || !vy);
      return { ...a, x, y, facing: a.facing, moving: going, speed: v * FRAME_MS };
    }
    return { ...a, moving: false };
  }
}

// ---- what is drawn where -------------------------------------------------------------------------------------------
/**
 * Where a partner appears on the picture: their world pixels relative to the camera, from the local player's spot.
 * Returns { x, y } of the partner's tile (top-left, picture pixels) or null when they are not on the same map of the
 * same game family (or a connected one: a state Track.sample put into the local frame, `local`), or off the picture
 * (with a margin for the sprite and the name).
 */
export function screenPos(t, cam, p) {
  if (!t || !cam || !p || p.hidden || p.away || p.fam !== t.fam || (!p.local && p.map !== cam.map)) return null;
  const x = t.anchor.x + (p.x - cam.cx);
  const y = t.anchor.y + (p.y - cam.cy);
  if (x < -48 || y < -48 || x > t.screen.w + 32 || y > t.screen.h + 48) return null;
  return { x, y };
}

/** The tile in front of a player (facing 1–4). */
export const frontTile = (tx, ty, facing) => [tx + (STEP[facing]?.[0] || 0), ty + (STEP[facing]?.[1] || 0)];

/**
 * The partner the local player faces – standing on the tile in front of them, on the same map – or null.
 * `partners`: [{ slot, state }] with the interpolated states.
 */
export function facedPartner(t, local, partners) {
  if (!local) return null;
  const [fx, fy] = frontTile(local.tx, local.ty, local.facing);
  for (const { slot, state } of partners) {
    if (!state || state.hidden || state.away || state.fam !== t.fam || (!state.local && state.map !== local.map)) continue;
    if (Math.round(state.x / TILE) === fx && Math.round(state.y / TILE) === fy) return slot;
  }
  return null;
}

/** The kind a game draws for a partner's kind it doesn't have (FR/LG has one bike, Emerald two; nobody dives in Kanto). */
export function kindFor(t, kind) {
  const have = new Set(t.avatars.map((a) => a.kind));
  if (have.has(kind)) return kind;
  const alt = { mach: ['bike', 'acro'], acro: ['bike', 'mach'], bike: ['mach', 'acro'], dive: ['surf'], water: ['walk'], vsseeker: ['walk'] }[kind] || [];
  return alt.find((k) => have.has(k)) || 'walk';
}

/** The game's graphics id for a partner (kind + gender) – what the sprite sheet is extracted for. */
export function gfxFor(t, kind, gender) {
  const k = kindFor(t, kind);
  const a = t.avatars.find((x) => x.kind === k) || t.avatars[0];
  return a ? a.gfx[gender ? 1 : 0] : 0;
}

// Object event animations (Gen 3 ANIM_STD_*): face 0–3, go 4–7, go fast 8–11, go faster 12–15, go fastest 16–19;
// the player's run 20–23. Order within each group: south, north, west, east.
const DIR_INDEX = { 1: 0, 2: 1, 3: 2, 4: 3 };
/** Which animation a partner shows: standing (face), walking, running or riding fast – from the speed (px/frame). */
export function animFor(st, speed) {
  const d = DIR_INDEX[st.facing] ?? 0;
  if (!st.moving) return d;
  if (st.run && st.kind === 'walk') return 20 + d;
  if (speed > 3.5) return 16 + d;
  if (speed > 2.5) return 12 + d;
  if (speed > 1.5) return 8 + d;
  return 4 + d;
}

// ---- connected maps ------------------------------------------------------------------------------------------------
/** Map connection directions (Gen 3 CONNECTION_*); dive/emerge (5, 6) lead to another layer, never side by side. */
export const CONN = { S: 1, N: 2, W: 3, E: 4 };

/**
 * The local map's size and its connections, from gMapHeader (RAM: its layout and connections pointers) and the ROM:
 * { map, w, h, list: [{ dir, offset, map }] } or null. Cached per connections pointer (`cache`: a Map).
 */
export function readConnections(t, read, rom, map, cache = null) {
  if (t?.gen <= 2) return gbReadConnections(t, read, map);
  if (!t?.mapHeader || !rom) return null;
  const h = read(t.mapHeader, 0x10);
  if (!ok(h, 0x10)) return null;
  const layout = u32(h, 0);
  const conns = u32(h, 0x0c);
  const key = `${map}:${layout}:${conns}`;
  if (cache?.has(key)) return cache.get(key);
  const R = (p, n) => (p >= 0x08000000 && p - 0x08000000 + n <= rom.length ? p - 0x08000000 : -1);
  let out = null;
  const lo = R(layout, 8);
  if (lo >= 0) {
    const w = s32(rom, lo);
    const hh = s32(rom, lo + 4);
    if (w > 0 && hh > 0 && w <= 0x400 && hh <= 0x400) {
      const list = [];
      const co = conns ? R(conns, 8) : -1;
      const count = co >= 0 ? s32(rom, co) : 0;
      const at = co >= 0 ? R(u32(rom, co + 4), 12 * Math.max(1, count)) : -1;
      if (count > 0 && count <= 8 && at >= 0) {
        for (let i = 0; i < count; i++) {
          const c = at + i * 12;
          const dir = rom[c];
          if (dir >= CONN.S && dir <= CONN.E) list.push({ dir, offset: s32(rom, c + 4), map: rom[c + 8] * 256 + rom[c + 9] });
        }
      }
      out = { map, w, h: hh, list };
    }
  }
  if (cache) {
    if (cache.size > 64) cache.clear();
    cache.set(key, out);
  }
  return out;
}

/**
 * A partner's position in the local map's frame (world pixels): on the same map as it is, on a map connected to it
 * shifted by the connection (pokeemerald fieldmap.c Fill*Connection: south at your height, east at your width, north
 * and west at minus *their* size – `size` [w, h], which the partner sends) – or null.
 */
export function inLocalFrame(conns, st, size = null) {
  if (!conns || !st || st.hidden) return null;
  if (st.map === conns.map) return { x: st.x, y: st.y };
  const c = conns.list.find((x) => x.map === st.map);
  if (!c) return null;
  // (the Game Boy games: the offsets from your own RAM – shared/worldgb.mjs gbReadConnections)
  if (c.ox !== undefined) return { x: st.x + c.ox, y: st.y + c.oy };
  const o = c.offset * TILE;
  if (c.dir === CONN.S) return { x: st.x + o, y: st.y + conns.h * TILE };
  if (c.dir === CONN.E) return { x: st.x + conns.w * TILE, y: st.y + o };
  if (!size) return null;
  if (c.dir === CONN.N) return { x: st.x + o, y: st.y - size[1] * TILE };
  return { x: st.x - size[0] * TILE, y: st.y + o };
}

// ---- the Pokémon following a player ---------------------------------------------------------------------------------
/**
 * The follower of one player: it walks the player's path one tile (`gap` px) behind – the trail of where the player
 * has been, not a straight line, so it goes round corners and through doors after them. Fed with the player's
 * position every picture (a partner's interpolated one, or your own); a warp, Fly or another map puts it back onto
 * the player (it steps out of the door after them), the first sight of a player one tile behind their back.
 * Nothing in the game knows about it: it overlaps people and walls like the partners do.
 */
export class Follower {
  constructor({ gap = TILE, snapPx = 3 * TILE } = {}) {
    this.gap = gap;
    this.snapPx = snapPx;
    this.trail = [];
    this.key = null;
    this.pos = null;
    this.dist = 0;
    this.flip = false;
  }

  /**
   * The frame moved under the leader (the local player crossed into a connected map: the same ground, other
   * coordinates): the path goes along, `dx`/`dy` further – the follower walks on instead of starting again on them.
   */
  rekey(key, dx, dy) {
    if (this.key === null || !this.trail.length) return;
    for (const p of this.trail) (p.x += dx), (p.y += dy);
    if (this.pos) (this.pos.x += dx), (this.pos.y += dy);
    this.key = key;
  }

  _reset(x, y, behind) {
    const [dx, dy] = STEP[behind] || [0, 0];
    this.trail = behind ? [{ x: x - dx * this.gap, y: y - dy * this.gap }, { x, y }] : [{ x, y }];
    this.out = !!behind; // (put onto the leader: hidden until they step away from it)
    if (behind === DIR.E) this.flip = true;
    else if (behind === DIR.W) this.flip = false;
    this.pos = null;
  }

  /**
   * The leader at world pixels (x, y) in frame `key` (the map – or the local map for partners shown across a
   * connection), facing 1–4. Returns { x, y (the follower's tile, world px), moving, flip (faces right), frame (0/1),
   * hidden (still on the leader after a warp) }.
   */
  update(key, x, y, facing = DIR.S) {
    const last = this.trail[this.trail.length - 1];
    if (!last) this._reset(x, y, facing);
    else if (key !== this.key || Math.abs(x - last.x) + Math.abs(y - last.y) > this.snapPx) this._reset(x, y, 0);
    else if (x !== last.x || y !== last.y) this.trail.push({ x, y });
    this.key = key;
    // keep just enough path behind the leader
    const len = (from) => {
      let n = 0;
      for (let i = from + 1; i < this.trail.length; i++) n += Math.abs(this.trail[i].x - this.trail[i - 1].x) + Math.abs(this.trail[i].y - this.trail[i - 1].y);
      return n;
    };
    while (this.trail.length > 2 && len(1) >= this.gap) this.trail.shift();
    // one gap back along the path from the leader (or the start of a shorter path)
    let left = this.gap;
    let px = this.trail[0].x;
    let py = this.trail[0].y;
    for (let i = this.trail.length - 1; i > 0; i--) {
      const b = this.trail[i];
      const a = this.trail[i - 1];
      const d = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      if (d >= left) {
        const k = d ? left / d : 0;
        px = b.x + (a.x - b.x) * k;
        py = b.y + (a.y - b.y) * k;
        left = 0;
        break;
      }
      left -= d;
    }
    const prev = this.pos;
    const dx = prev ? px - prev.x : 0;
    const dy = prev ? py - prev.y : 0;
    const moved = Math.abs(dx) + Math.abs(dy);
    this.dist += moved;
    if (dx > 0.01) this.flip = true;
    else if (dx < -0.01) this.flip = false;
    this.pos = { x: px, y: py };
    // hidden only while it waits on the leader after a door or a warp – not when the leader turns back and walks
    // through it (it vanished for a few frames there)
    if (Math.abs(px - x) + Math.abs(py - y) >= 6) this.out = true;
    return { x: px, y: py, moving: moved > 0.01, flip: this.flip, frame: Math.floor(this.dist / 8) & 1, hidden: !this.out && Math.abs(px - x) + Math.abs(py - y) < 6 };
  }
}

/** Kinds a follower doesn't walk along with: on the water, under it (it would stand on the sea). */
export const followerHidden = (st) => !st || st.hidden || st.kind === 'surf' || st.kind === 'dive' || st.kind === 'water';

// ---- emotes -----------------------------------------------------------------------------------------------------------
/** The emote bubbles (pixel art in web/lib/worldoverlay.mjs), the names on the wire. 'wave' goes as { t: 'wave' }. */
export const EMOTES = ['wave', 'heart', 'excl', 'quest', 'gg'];

/**
 * A token bucket: `burst` at once, then one every `everyMs`. Emotes use it on both ends – the sender's buttons and
 * every partner's receiver (a modified client can't flood your picture with bubbles).
 */
export class RateLimit {
  constructor({ burst = 4, everyMs = 2500 } = {}) {
    this.burst = burst;
    this.everyMs = everyMs;
    this.tokens = burst;
    this.at = null;
  }
  take(now) {
    if (this.at === null) this.at = now;
    this.tokens = Math.min(this.burst, this.tokens + (now - this.at) / this.everyMs);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
export const EMOTE_LIMIT = { burst: 4, everyMs: 2500 };
