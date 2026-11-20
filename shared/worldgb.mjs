// Shared World for the Game Boy games (docs/MULTIPLAYER.md › 9): Red/Blue/Yellow (Gen 1) and Gold/Silver/Crystal
// (Gen 2). The same overlay as Gen 3 (web/lib/worldoverlay.mjs, shared/world.mjs) – this module is what differs: which
// WRAM to read (shared/data/addresses.json › world, from the pret symbol files), the 2bpp sprites and party icons from
// the player's own ROM, their colours, the map's tiles for the few places a Game Boy hides sprites behind the map
// (tall grass), and the map connections. Nothing is written into the game.
//
// Coordinates are world pixels of the current map, as for Gen 3: a step (16×16, a quarter of a 32×32 block) × 16 plus
// the part of a step walked. The player's step square sits at (64, 64) of the 160×144 picture; the games draw every
// overworld sprite 4 pixels higher than its square (`spriteDy`).
//
// Families: Red, Blue and Yellow share every map number (Yellow only adds the beach house, a number Red/Blue never
// use). Gold/Silver and Crystal share the maps but not all numbers – Crystal inserted maps into some groups – so a
// Gold/Silver map goes on the wire with Crystal's number (`canon`, generated from the pret map constants; every shared
// map has the same size in both).

const hex = (v) => (typeof v === 'string' ? parseInt(v, 16) : Number(v));
const s8 = (v) => (v << 24) >> 24;
const ok = (b, n) => !!b && b.length >= n;

export const GB_SCREEN = { w: 160, h: 144 };
/** Gen 1/2 directions on the sprite sheets (facing >> 2): down, up, left, right → shared/world.mjs DIR (S, N, W, E). */
const SHEET_DIR = [1, 2, 3, 4];
const DIR_SHEET = { 1: 0, 2: 1, 3: 2, 4: 3 };

/** A ROM address "bank:addr" (hex, as the symbol files write it) → the offset in the ROM file. */
export function romOffset(v) {
  if (typeof v === 'number') return v;
  const m = /^([0-9a-f]+):([0-9a-f]{4})$/i.exec(String(v || ''));
  if (!m) return -1;
  const bank = parseInt(m[1], 16);
  const addr = parseInt(m[2], 16);
  return addr < 0x4000 ? (bank ? -1 : addr) : bank * 0x4000 + addr - 0x4000;
}
/** A bank and a 16-bit pointer (as the games keep them in RAM) → the offset in the ROM file, or −1. */
export const bankPtr = (bank, ptr) => (ptr < 0x4000 ? (bank ? -1 : ptr) : ptr < 0x8000 ? bank * 0x4000 + ptr - 0x4000 : -1);

export const GB_FAMILIES = ['rby', 'gsc'];

/**
 * The Shared World table of a Game Boy game: `entry` the addresses.json game (findEntry), `world` its world part with
 * the RAM addresses of this ROM (the retail ones, or a hack's moved ones – shared/live/romwram.mjs). null without one.
 */
export function gbWorldTable(entry, world = entry?.world) {
  if (!entry || !world || !(entry.gen === 1 || entry.gen === 2) || !GB_FAMILIES.includes(world.family)) return null;
  const ram = {};
  for (const [k, v] of Object.entries(world)) if (/Addr$/.test(k)) ram[k.slice(0, -4)] = hex(v);
  const rom = {};
  for (const [k, v] of Object.entries(world.rom || {})) rom[k] = typeof v === 'string' && v.includes(':') ? romOffset(v) : v;
  // "GGNN>GGNN …": a Gold/Silver map (group, number) and Crystal's number of it (0000: Crystal has no such map)
  const canon = new Map(String(world.canon || '').split(/\s+/).filter(Boolean).map((p) => p.split('>').map((x) => parseInt(x, 16))));
  return {
    gen: entry.gen,
    id: entry.id,
    family: world.family,
    fam: world.family === 'rby' ? 11 : 13,
    ram,
    rom,
    canon,
    kris: !!ram.playerGender, // (Crystal: a girl to play)
    inBattle: entry.inBattle ? { addr: hex(entry.inBattle.addr), mask: hex(entry.inBattle.mask || '0xff') } : null,
    anchor: { x: 64, y: 64 },
    screen: GB_SCREEN,
    spriteDy: -4,
    overworldCb2: 0,
    avatars: [{ kind: 'walk', gfx: [0, 1] }, { kind: 'bike', gfx: [2, 3] }, { kind: 'surf', gfx: [4, 4] }],
  };
}

/** The bytes the overlay wants with every picture (the native player's WATCH): position, the step, the screen state. */
export function gbWatchRanges(t) {
  if (!t) return [];
  const r = t.ram;
  const out = [];
  if (t.gen === 1) {
    out.push([r.curMap, 5]); // wCurMap, wCurrentTileBlockMapViewPointer (2), wYCoord, wXCoord
    out.push([r.walkCounter, 1], [r.sprite1, 16], [r.sprite2, 16], [r.fontLoaded, 1], [r.joyIgnore, 1], [r.walkBikeSurf, 1], [r.statusFlags5, 1]);
    if (r.pikachu) out.push([r.pikachu, 16]);
  } else {
    out.push([r.mapGroup, 4], [r.playerStruct, 0x28], [r.bgMapOffsetX, 6], [r.playerState, 1], [r.scriptRunning, 1], [r.mapStatus, 1], [r.timeOfDayPal, 1]);
    if (r.playerGender) out.push([r.playerGender, 1]);
    if (r.landmarkSign) out.push([r.landmarkSign, 1]);
  }
  if (t.inBattle) out.push([t.inBattle.addr, 1]);
  return out;
}

/** A Gold/Silver map number in Crystal's numbering (the wire's); Crystal's own and Gen 1's as they are. */
export const canonMap = (t, map) => (t.canon.size ? (t.canon.has(map) ? t.canon.get(map) : map) : map);

/**
 * The camera, per picture: { map, tx, ty (the player's tile – the one the step started on), cx, cy (world pixels),
 * as the picture after these bytes shows them – `prior` (optional): a reader of the bytes of the frame before;
 * keys: 0 (the Game Boy games keep the buttons in HRAM: the overlay takes the player's input), cb2: 0, locked, fade,
 * battle } – or null before a game is loaded.
 */
export function gbReadCamera(t, read, prior = null) {
  const r = t.ram;
  const battle = t.inBattle ? read(t.inBattle.addr, 1) : null;
  if (t.gen === 1) {
    const p = read(r.curMap, 5);
    const wc = read(r.walkCounter, 1);
    const s1 = read(r.sprite1, 16);
    const font = read(r.fontLoaded, 1);
    const joy = read(r.joyIgnore, 1);
    const flags5 = read(r.statusFlags5, 1);
    if (!ok(p, 5) || !ok(wc, 1) || !ok(s1, 16)) return null;
    // before a game is loaded (title, intro) the player's sprite slot is empty; on CONTINUE's screen the save is
    // loaded already but the player isn't drawn (image index $FF) – not the overworld either
    if (s1[0] === 0 || s1[2] === 0xff) return null;
    const tx = s8(p[4]);
    const ty = s8(p[3]);
    // AdvancePlayerSprite: 8 → 0, two pixels each time (four on the bike); the tile coordinates change at 0. The step's
    // first turn of the loop takes a frame longer (the new row or column of the map is drawn): its picture hasn't
    // scrolled yet – `prior`, the bytes of the frame before, says the counter was 0 then (measured, world-e2e --frames)
    const pwc = prior ? prior(r.walkCounter, 1) : null;
    const k = wc[0] > 0 && wc[0] <= 8 && !(pwc && pwc[0] === 0) ? (8 - wc[0]) * 2 : 0;
    const vy = s8(s1[3]);
    const vx = s8(s1[5]);
    return {
      map: p[0],
      tx,
      ty,
      cx: tx * 16 + (Math.abs(vx) === 1 ? vx * k : 0),
      cy: ty * 16 + (Math.abs(vy) === 1 ? vy * k : 0),
      keys: 0,
      cb2: 0,
      // a text box or a menu (the font is in VRAM), a script holding the player, simulated buttons (Oak walking you)
      locked: !!((font?.[0] ?? 0) & 1) || (joy?.[0] ?? 0) !== 0 || !!((flags5?.[0] ?? 0) & 0x80),
      fade: 0,
      battle: !!(battle && battle[0] & t.inBattle.mask),
      help: false,
      replay: false,
    };
  }
  const p = read(r.mapGroup, 4);
  const o = read(r.playerStruct, 0x28);
  const step = read(r.bgMapOffsetX, 6);
  const script = read(r.scriptRunning, 1);
  const status = read(r.mapStatus, 1);
  if (!ok(p, 4) || !ok(o, 0x28) || !ok(step, 6)) return null;
  if (!p[0] || !o[0]) return null; // no map yet, no player sprite (title, intro)
  const tx = s8(p[3]);
  const ty = s8(p[2]);
  // wPlayerBGMapOffsetX/Y: every object on screen is shifted by it while the player steps – minus the pixels walked
  // since the step began (0 again once a step is done)
  const dir = step[5]; // wPlayerStepDirection: 0 down, 1 up, 2 left, 3 right, $FF standing
  const ox = (-s8(step[0])) & 15;
  const oy = (-s8(step[1])) & 15;
  let cx = tx * 16;
  let cy = ty * 16;
  if (dir === 3) cx += ox;
  else if (dir === 2) cx -= (16 - ox) & 15;
  else if (dir === 0) cy += oy;
  else if (dir === 1) cy -= (16 - oy) & 15;
  // the picture after these bytes shows the scroll of the step's previous turn of the overworld loop (measured frame by
  // frame against the background, world-e2e --frames): back by the step vector – not on the step's first turn
  // (wPlayerStepFlags: START bit 7, CONTINUE bit 5)
  if (dir <= 3 && step[4] & 0x20 && !(step[4] & 0x80)) {
    cx -= s8(step[2]);
    cy -= s8(step[3]);
  }
  return {
    map: canonMap(t, p[0] * 256 + p[1]),
    tx,
    ty,
    cx,
    cy,
    keys: 0,
    cb2: 0,
    // a script runs (a person talking, a sign, the START menu, a warp), or the map isn't being played (entering it)
    locked: (script?.[0] ?? 0) !== 0 || (status?.[0] ?? 2) !== 2,
    // (only a script: the game runs one for a few frames when a step ends in some places – Route 29 – too)
    scripted: (script?.[0] ?? 0) !== 0 && (status?.[0] ?? 2) === 2,
    fade: 0,
    battle: !!(battle && battle[0] & t.inBattle.mask),
    help: false,
    replay: false,
  };
}

/** The local player for the partners: { map, x, y, tx, ty, facing, kind, gender, run, elev } or null. */
export function gbReadPlayer(t, read, cam) {
  if (!cam) return null;
  const r = t.ram;
  let facing = 1;
  let kind = 'walk';
  let gender = 0;
  if (t.gen === 1) {
    const s1 = read(r.sprite1, 16);
    const st = read(r.walkBikeSurf, 1);
    if (!ok(s1, 16)) return null;
    facing = SHEET_DIR[(s1[9] >> 2) & 3];
    kind = ['walk', 'bike', 'surf'][st?.[0]] || 'walk';
  } else {
    const o = read(r.playerStruct, 0x28);
    const st = read(r.playerState, 1);
    const g = r.playerGender ? read(r.playerGender, 1) : null;
    if (!ok(o, 0x28)) return null;
    // OBJECT_FACING: FACING_STEP_DOWN_0 … FACING_STEP_RIGHT_3 (four per direction)
    if (o[0x0d] < 16) facing = SHEET_DIR[o[0x0d] >> 2];
    const s = st?.[0] ?? 0;
    kind = s === 1 ? 'bike' : s === 4 || s === 8 ? 'surf' : 'walk'; // PLAYER_BIKE, PLAYER_SURF(_PIKA); skates walk
    gender = g ? g[0] & 1 : 0;
  }
  return { map: cam.map, x: cam.cx, y: cam.cy, tx: cam.tx, ty: cam.ty, facing, kind, gender, run: false, elev: 0 };
}

/** Can partners be drawn now? The overworld of a loaded game, no battle, no text box, menu or script. */
export const gbDrawable = (t, cam) => !!t && !!cam && !cam.battle && !cam.locked && cam.fade < 16;

/**
 * The local player's sprite this picture, for drawing it again over a partner that overlaps it: { x, y, w, h, img,
 * flip, grass } – the sheet frame (0–5) and its flip, the tall grass over its lower half – or null when hidden.
 */
export function gbLocalSprite(t, read) {
  const r = t.ram;
  let dir = 0;
  let phase = 0;
  let grass = false;
  if (t.gen === 1) {
    const s1 = read(r.sprite1, 16);
    const s2 = read(r.sprite2, 16);
    if (!ok(s1, 16) || s1[2] === 0xff) return null; // (image index $FF: not on screen)
    dir = (s1[2] >> 2) & 3;
    phase = s1[2] & 3;
    grass = !!(s2 && s2[7] & 0x80);
  } else {
    const o = read(r.playerStruct, 0x28);
    if (!ok(o, 0x28) || o[0x0d] >= 16) return null;
    dir = o[0x0d] >> 2;
    phase = o[0x0d] & 3;
    grass = !!(o[0x05] & 0x08); // OBJECT_FLAGS2 IN_GRASS_F (bit 3)
  }
  const f = WALK[dir][phase];
  return { x: t.anchor.x, y: t.anchor.y + t.spriteDy, w: 16, h: 16, img: f.img, flip: f.flip, grass, dir, phase };
}

/** Yellow: is the game's own Pikachu walking behind the player (sprite slot 15 on screen)? */
export function gameFollower(t, read) {
  if (!t.ram.pikachu) return false;
  const p = read(t.ram.pikachu, 16);
  return !!p && p[0] !== 0 && p[2] !== 0xff;
}

/** Yellow: the tile its Pikachu stands on ([x, y]; the sprite data keeps them 4 higher), or null. */
export function gameFollowerTile(t, read) {
  if (!gameFollower(t, read) || !t.ram.pikachuMap) return null;
  const m = read(t.ram.pikachuMap, 2);
  return m ? [m[1] - 4, m[0] - 4] : null;
}

/**
 * Crystal's place sign (the window's bottom four rows, drawn over the sprites – pokecrystal PlaceMapNameSign), like
 * Gen 3's map-name popup: its rectangle while its timer runs, else null.
 */
export function gbPopupRect(t, read) {
  const s = t?.ram.landmarkSign ? read(t.ram.landmarkSign, 1) : null;
  return s && s[0] > 0 && s[0] < 60 ? { x: 0, y: 112, w: 160, h: 32, shown: 32, grows: false } : null;
}

// ---- connected maps -------------------------------------------------------------------------------------------------
/**
 * The local map's size (tiles of 16 px) and its connections from RAM: { map, w, h, list: [{ dir, map, ox, oy }] } –
 * a partner on a connected map at (x, y) of theirs stands at (x + ox, y + oy) in the local map. The games' own
 * numbers: entering the north map puts you at its row YAlignment with X + XAlignment (pokered CheckMapConnections,
 * pokecrystal EnterMapConnection), the other directions likewise.
 */
export function gbReadConnections(t, read, map) {
  const r = t.ram;
  const size = read(r.mapHeight, 2); // (height, width – next to each other in both generations)
  const flags = read(r.connections, 1);
  if (!ok(size, 2) || !ok(flags, 1)) return null;
  const h = size[0] * 2;
  const w = size[1] * 2;
  if (!w || !h) return null;
  const len = t.gen === 1 ? 11 : 12;
  const list = [];
  // headers in the order north, south, west, east; the flags bits 3, 2, 1, 0
  const dirs = [[2, 8], [1, 4], [3, 2], [4, 1]];
  dirs.forEach(([dir, bit], i) => {
    if (!(flags[0] & bit)) return;
    const c = read(r.connections + 1 + i * len, len);
    if (!ok(c, len)) return;
    const cmap = t.gen === 1 ? c[0] : canonMap(t, c[0] * 256 + c[1]);
    const yA = s8(c[len - 4]);
    const xA = s8(c[len - 3]);
    // (their tile → ours: north/south keep the column shifted by xA, west/east the row by yA)
    let ox;
    let oy;
    if (dir === 2) [ox, oy] = [-xA, -yA - 1];
    else if (dir === 1) [ox, oy] = [-xA, h - yA];
    else if (dir === 3) [ox, oy] = [-xA - 1, -yA];
    else [ox, oy] = [w - xA, -yA];
    list.push({ dir, map: cmap, ox: ox * 16 + 0, oy: oy * 16 + 0 }); // (+ 0: no −0)
  });
  return { map, w, h, list };
}

// ---- sprites -------------------------------------------------------------------------------------------------------
/** One 8×8 tile of 2bpp (16 bytes: low plane, high plane per row) → 64 colour numbers 0–3. */
export function decode2bpp(rom, off) {
  const out = new Uint8Array(64);
  if (off < 0 || off + 16 > rom.length) return out;
  for (let y = 0; y < 8; y++) {
    const lo = rom[off + y * 2];
    const hi = rom[off + y * 2 + 1];
    for (let x = 0; x < 8; x++) out[y * 8 + x] = ((lo >> (7 - x)) & 1) | (((hi >> (7 - x)) & 1) << 1);
  }
  return out;
}

/** A 16×16 frame of four tiles (top-left, top-right, bottom-left, bottom-right) → 256 colour numbers. */
export function frame16(rom, off) {
  const out = new Uint8Array(256);
  for (let q = 0; q < 4; q++) {
    const t = decode2bpp(rom, off + q * 16);
    for (let i = 0; i < 64; i++) out[((q >> 1) * 8 + (i >> 3)) * 16 + (q & 1) * 8 + (i & 7)] = t[i];
  }
  return out;
}

/**
 * The walking frames as the games show them (pokered data/sprites/facings.asm, pokecrystal data/sprites/facings.asm):
 * per direction (down, up, left, right) four phases of { img (0–5: standing down/up/left, walking down/up/left), flip }.
 */
export const WALK = [
  [{ img: 0, flip: false }, { img: 3, flip: false }, { img: 0, flip: false }, { img: 3, flip: true }],
  [{ img: 1, flip: false }, { img: 4, flip: false }, { img: 1, flip: false }, { img: 4, flip: true }],
  [{ img: 2, flip: false }, { img: 5, flip: false }, { img: 2, flip: false }, { img: 5, flip: false }],
  [{ img: 2, flip: true }, { img: 5, flip: true }, { img: 2, flip: true }, { img: 5, flip: true }],
];
/** The animations in shared/world.mjs animFor's numbering (face 0–3, walking from 4 on, S N W E), 8 frames a phase. */
export const GB_ANIMS = Array.from({ length: 24 }, (_, i) => {
  const d = [0, 1, 2, 3][i % 4];
  return i < 4 ? [{ ...WALK[d][0], dur: 8 }] : WALK[d].map((f) => ({ ...f, dur: 8 }));
});

/**
 * Where the player's sprite sheet of `kind` (walk, bike, surf) and `gender` is in the ROM, and its OBJ palette (Gen 2;
 * Gen 1 colours come from the picture): { off, pal } or null. Gen 1: the sheets by their symbols; Gen 2: the game's
 * OverworldSprites table (pointer, tiles, bank, type, palette) by sprite id.
 */
export function gbSheet(rom, t, kind, gender) {
  if (!rom) return null;
  if (t.gen === 1) {
    const off = kind === 'bike' ? t.rom.bikeSprite : kind === 'surf' ? t.rom.surfSprite : t.rom.playerSprite;
    return off > 0 && off + 0x180 <= rom.length ? { off, pal: 0 } : null;
  }
  const ids = t.rom.sprites || {};
  const id = kind === 'bike' ? (gender && t.kris ? ids.krisBike : ids.bike) : kind === 'surf' ? ids.surf : gender && t.kris ? ids.kris : ids.player;
  const base = t.rom.overworldSprites;
  if (!id || !(base > 0)) return null;
  const e = base + (id - 1) * 6;
  if (e + 6 > rom.length) return null;
  const off = bankPtr(rom[e + 3], rom[e] | (rom[e + 1] << 8));
  return off > 0 && off + 0x180 <= rom.length ? { off, pal: rom[e + 5] & 7 } : null;
}

/**
 * The ROM tables of `t` checked against the ROM, and – where one doesn't fit (a hack moved it) – found again by its
 * shape; what can't be found is left out (0), and the overlay does without it: no partner sprites without the sheets,
 * no followers without the icons, the party menu's colours without the Pokémon's palettes. Returns the `rom` part.
 */
export function gbRomTables(rom, t) {
  const r = { ...t.rom };
  const ptr = (o) => rom[o] | (rom[o + 1] << 8);
  const inBank = (p) => p >= 0x4000 && p < 0x8000;
  const banks = rom.length >> 14;
  if (t.gen === 1) {
    // MonPartySpritePointers: { pointer, tiles 1–8, bank, VRAM tile } per entry, the first at vSprites tile 0
    const icons = (o) => o > 0 && o + r.iconCount * 6 <= rom.length && ptr(o + 4) === 0x8000 && Array.from({ length: r.iconCount }, (_, i) => o + i * 6)
      .every((e) => rom[e + 2] >= 1 && rom[e + 2] <= 8 && rom[e + 3] < banks && inBank(ptr(e)) && ptr(e + 4) >= 0x8000 && ptr(e + 4) < 0x9000);
    if (!icons(r.iconPointers)) r.iconPointers = 0;
    for (const k of ['playerSprite', 'bikeSprite', 'surfSprite']) if (!(r[k] > 0 && r[k] + 0x180 <= rom.length)) r[k] = 0;
    return r;
  }
  // OverworldSprites: { pointer, 12 tiles' bytes ($C0), bank, type, palette } – the player and his bike walking in red,
  // then the Game Boy kid standing in green
  const spriteAt = (o, type, pal) => o + 6 <= rom.length && inBank(ptr(o)) && rom[o + 2] === 0xc0 && rom[o + 3] > 0 && rom[o + 3] < banks && rom[o + 4] === type && rom[o + 5] === pal;
  const sprites = (o) => o > 0 && spriteAt(o, 1, 0) && spriteAt(o + 6, 1, 0) && spriteAt(o + 12, 2, 2)
    && [3, 4, 5, 6, 7].every((i) => o + i * 6 + 6 <= rom.length && inBank(ptr(o + i * 6)) && rom[o + i * 6 + 2] <= 0xc0 && rom[o + i * 6 + 4] <= 3);
  if (!sprites(r.overworldSprites)) {
    r.overworldSprites = 0;
    for (let o = 0; o + 64 <= rom.length && !r.overworldSprites; o++) if (rom[o + 2] === 0xc0 && rom[o + 8] === 0xc0 && sprites(o)) r.overworldSprites = o;
  }
  // IconPointers: the icons one after the other, eight tiles ($80 bytes) each; MonMenuIcons (251 icon numbers: every one
  // an icon, families sharing theirs – Bulbasaur, Ivysaur, Venusaur – most icons used) right before them. Only the two
  // together count: a run of $80 steps alone is found in other tables too (no icons beat wrong ones)
  // (the first entry, the null icon, is the second's address: the run of $80 steps begins after it)
  const iconRun = (o) => o > 0 && o + 80 <= rom.length && ptr(o) <= ptr(o + 2) && inBank(ptr(o + 2)) && Array.from({ length: 37 }, (_, i) => ptr(o + i * 2 + 4) - ptr(o + i * 2 + 2)).every((d) => d === 0x80);
  const iconCount = (o) => {
    let n = 2;
    while (n < 64 && ptr(o + n * 2 + 2) - ptr(o + n * 2) === 0x80) n++;
    return n + 1;
  };
  const menuAt = (m, count) => {
    if (!(m > 0) || m + 251 > rom.length || rom[m] !== rom[m + 1] || rom[m] !== rom[m + 2]) return false;
    const seen = new Set();
    for (let i = 0; i < 251; i++) {
      const v = rom[m + i];
      if (!v || v >= count) return false;
      seen.add(v);
    }
    return seen.size >= Math.min(30, count - 2);
  };
  const iconsAt = (o) => iconRun(o) && (menuAt(o - 251, iconCount(o)) || (o === t.rom.iconPointers && menuAt(r.monMenuIcons, iconCount(o))));
  if (!iconsAt(r.iconPointers)) {
    r.iconPointers = 0;
    for (let o = 251; o + 80 <= rom.length && !r.iconPointers; o += 1) if (ptr(o + 4) - ptr(o + 2) === 0x80 && iconsAt(o)) r.iconPointers = o;
    if (r.iconPointers) r.monMenuIcons = r.iconPointers - 251;
  }
  if (r.iconPointers) r.icons = bankPtr(Math.floor(r.iconPointers / 0x4000), ptr(r.iconPointers + 2));
  else r.icons = r.monMenuIcons = 0;
  // MapObjectPals: 4 times of day × 8 palettes, the people's palettes (0–5) ending in black, the sixth ("silver")
  // beginning with two whites; colours are 15 bits
  const pals = (o) => o > 0 && o + 256 <= rom.length && [0, 1, 2, 3].every((d) => [0, 1, 2, 3, 4, 5].every((p) => ptr(o + (d * 8 + p) * 8 + 6) === 0)
    && ptr(o + (d * 8 + 5) * 8) === 0x7fff && ptr(o + (d * 8 + 5) * 8 + 2) === 0x7fff) && Array.from({ length: 128 }, (_, i) => ptr(o + i * 2)).every((c) => c < 0x8000);
  if (!pals(r.mapObjectPals)) {
    r.mapObjectPals = 0;
    for (let o = 0; o + 256 <= rom.length && !r.mapObjectPals; o += 1) if (ptr(o + 6) === 0 && ptr(o + 14) === 0 && pals(o)) r.mapObjectPals = o;
  }
  // PokemonPalettes (252 × 2 × 2 colours): only where it is (no shape to find it by) – else the party menu's colours
  if (!(r.pokemonPalettes > 0 && r.pokemonPalettes + 252 * 8 <= rom.length && Array.from({ length: 252 * 4 }, (_, i) => ptr(r.pokemonPalettes + i * 2)).every((c) => c < 0x8000))) r.pokemonPalettes = 0;
  return r;
}

/** The six frames (colour numbers) of a sheet: standing down, up, left, walking down, up, left. */
export const sheetFrames = (rom, off) => Array.from({ length: 6 }, (_, i) => frame16(rom, off + i * 64));

// ---- colours -------------------------------------------------------------------------------------------------------
// SameBoy (the fast player's and the link host's emulator) with the settings souldew gives it: the original Game Boy
// with its "lime" palette (GB_PALETTE_DMG), Game Boy Color colours "emulate hardware" (GB_COLOR_CORRECTION_MODERN_BALANCED)
// – Core/display.c GB_convert_rgb15 – so a partner's colours are the ones the game's own sprites have on screen.
/** The four shades of the original Game Boy (0 = lightest) as SameBoy shows them. */
export const DMG_SHADES = [[0xc6, 0xde, 0x8c], [0x84, 0xa5, 0x63], [0x39, 0x61, 0x39], [0x08, 0x18, 0x10]];
const CURVE = [0, 6, 12, 20, 28, 36, 45, 56, 66, 76, 88, 100, 113, 125, 137, 149, 161, 172, 182, 192, 202, 210, 218, 225, 232, 238, 243, 247, 250, 252, 254, 255];
/** A Game Boy Color colour (BGR555) → [r, g, b] as SameBoy draws it. */
export function cgbRgb(c) {
  const r = CURVE[c & 31];
  const g0 = CURVE[(c >> 5) & 31];
  const b = CURVE[(c >> 10) & 31];
  const g = g0 === b ? g0 : Math.round(Math.pow((Math.pow(g0 / 255, 1.6) * 3 + Math.pow(b / 255, 1.6)) / 4, 1 / 1.6) * 255);
  return [r, g, b];
}
/** Gen 1's object palette on the original Game Boy (rOBP0 %11010000: colour 1 and 2 light, 3 black) as shades. */
export const DMG_OBP0 = [0, 0, 1, 3];

/** Gen 2: an overworld OBJ palette (MapObjectPals: 4 times of day × 8 palettes × 4 colours) → 4 × [r, g, b]. */
export function gen2ObjPalette(rom, t, pal, timeOfDay = 1) {
  const base = t.rom.mapObjectPals;
  const o = base + ((timeOfDay & 3) * 8 + (pal & 7)) * 8;
  if (!(base > 0) || o + 8 > rom.length) return null;
  return [0, 1, 2, 3].map((i) => cgbRgb(rom[o + i * 2] | (rom[o + i * 2 + 1] << 8)));
}

/**
 * The colours of the picture's own player sprite (Gen 1: every overworld sprite has OBP0, partners look like you – on
 * the original Game Boy, on a Game Boy Color in its colours for Red/Blue, in Yellow's own): the colour numbers of the
 * frame the game shows against the picture's pixels there, its top half only (tall grass may cover the bottom).
 * `px(x, y)` → [r, g, b] of the picture. Returns { 1: rgb, 2: rgb, 3: rgb } with what was seen, or null.
 */
export function samplePalette(idx, flip, x0, y0, px) {
  const seen = {};
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 16; x++) {
      const c = idx[y * 16 + (flip ? 15 - x : x)];
      if (!c) continue;
      const p = px(x0 + x, y0 + y);
      if (!p) return null;
      const k = `${c}:${p[0]},${p[1]},${p[2]}`;
      seen[k] = (seen[k] || 0) + 1;
    }
  }
  const out = {};
  for (const c of [1, 2, 3]) {
    let best = null;
    for (const [k, n] of Object.entries(seen)) if (k.startsWith(`${c}:`) && (!best || n > best[1])) best = [k, n];
    if (best) out[c] = best[0].slice(2).split(',').map(Number);
  }
  return Object.keys(out).length ? out : null;
}

/** Colour numbers → RGBA with `pal` (4 × [r, g, b]; colour 0 transparent), `hide` (optional): pixels left out. */
export function paint(idx, pal, hide = null) {
  const out = new Uint8ClampedArray(idx.length * 4);
  for (let i = 0; i < idx.length; i++) {
    const c = idx[i];
    if (!c || (hide && hide[i])) continue;
    const p = pal[c];
    out[i * 4] = p[0];
    out[i * 4 + 1] = p[1];
    out[i * 4 + 2] = p[2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

// ---- party icons (the followers) ----------------------------------------------------------------------------------
/**
 * Gen 1: the party menu icon of a Pokémon (National Dex number): one of the generic icons (a monster, a bird, a ball,
 * a helix …) as the game builds it (pokered engine/gfx/mon_icons.asm): MonPartyData's nybble per Pokémon picks the
 * icon, MonPartySpritePointers copies its tiles (some from overworld sprites, some 8×16 halves) and the OAM writer
 * mirrors the left half – except the helix. Two frames: { w: 16, h: 16, frames: [Uint8Array(256) ×2] } or null.
 */
export function gen1Icon(rom, t, dex, cache = null) {
  if (!rom || !(dex >= 1 && dex <= 151)) return null;
  const { iconPointers: ptrs, iconCount: count, iconData: data } = t.rom;
  if (!(ptrs > 0) || !(data > 0) || !count) return null;
  const b = rom[data + ((dex - 1) >> 1)];
  const icon = dex & 1 ? b >> 4 : b & 15;
  const key = `g1:${icon}`;
  if (cache?.has(key)) return cache.get(key);
  // the sprite tiles as MonPartySpritePointers leaves them in VRAM (tile number → 16 bytes)
  const vram = new Map();
  for (let i = 0; i < count; i++) {
    const e = ptrs + i * 6;
    const src = bankPtr(rom[e + 3], rom[e] | (rom[e + 1] << 8));
    const n = rom[e + 2];
    const dest = ((rom[e + 4] | (rom[e + 5] << 8)) - 0x8000) >> 4;
    for (let k = 0; k < n && src >= 0; k++) vram.set(dest + k, src + k * 16);
  }
  const tile = (n) => (vram.has(n) ? decode2bpp(rom, vram.get(n)) : new Uint8Array(64));
  const HELIX = 2;
  const make = (base) => {
    const out = new Uint8Array(256);
    // symmetric: top-left = base, top-right = base mirrored, bottom = base + 2 (and mirrored); the helix: four tiles
    const q = icon === HELIX ? [[base, false], [base + 1, false], [base + 2, false], [base + 3, false]] : [[base, false], [base, true], [base + 2, false], [base + 2, true]];
    q.forEach(([n, flip], i) => {
      const px = tile(n);
      for (let p = 0; p < 64; p++) {
        const x = p & 7;
        out[((i >> 1) * 8 + (p >> 3)) * 16 + (i & 1) * 8 + (flip ? 7 - x : x)] = px[p];
      }
    });
    return out;
  };
  const base = icon << 2;
  const frames = [make(base), make(base + 0x40)];
  const out = frames.some((f) => f.some(Boolean)) ? withBox({ w: 16, h: 16, frames }) : null;
  cache?.set(key, out);
  return out;
}

/** Gen 2: the party menu icon (MonMenuIcons → IconPointers, 8 tiles: two 16×16 frames), or null. */
export function gen2Icon(rom, t, dex, cache = null) {
  if (!rom || !(dex >= 1 && dex <= 251)) return null;
  const { monMenuIcons: menu, iconPointers: ptrs, icons } = t.rom;
  if (!(menu > 0) || !(ptrs > 0) || !(icons > 0)) return null;
  const icon = rom[menu + dex - 1];
  const key = `g2:${icon}`;
  if (cache?.has(key)) return cache.get(key);
  const bank = Math.floor(icons / 0x4000);
  const off = bankPtr(bank, rom[ptrs + icon * 2] | (rom[ptrs + icon * 2 + 1] << 8));
  const out = icon && off > 0 && off + 128 <= rom.length ? withBox({ w: 16, h: 16, frames: [frame16(rom, off), frame16(rom, off + 64)] }) : null;
  cache?.set(key, out);
  return out;
}

/** Gen 2: a Pokémon's own two colours (PokemonPalettes: normal, then shiny) with white and black → 4 × [r, g, b]. */
export function gen2MonPalette(rom, t, dex, shiny = false) {
  const base = t.rom.pokemonPalettes;
  const o = base + dex * 8 + (shiny ? 4 : 0);
  if (!(base > 0) || o + 4 > rom.length) return null;
  return [[255, 255, 255], cgbRgb(rom[o] | (rom[o + 1] << 8)), cgbRgb(rom[o + 2] | (rom[o + 3] << 8)), [0, 0, 0]];
}

/** The box of an icon's drawn pixels over both frames (the follower stands on its bottom row). */
function withBox(ic) {
  let [top, bottom, left, right] = [ic.h, -1, ic.w, -1];
  for (const f of ic.frames) {
    for (let i = 0; i < f.length; i++) {
      if (!f[i]) continue;
      const x = i % ic.w;
      const y = (i / ic.w) | 0;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  return bottom >= 0 ? { ...ic, top, bottom, left, right } : null;
}

// ---- the map: tall grass ------------------------------------------------------------------------------------------
/**
 * Gen 2's LZ (pokecrystal home/decompress.asm): literal, iterate, alternate, zero, repeat, bit-flipped and reversed
 * copies, a long form with 10-bit lengths, $FF at the end. The decoded bytes (at most `max`) or null.
 */
export function gbLz(rom, off, max = 0x2000) {
  if (off < 0 || off >= rom.length) return null;
  const out = new Uint8Array(max);
  let o = 0;
  let i = off;
  const flip = (v) => {
    let r = 0;
    for (let k = 0; k < 8; k++) r |= ((v >> k) & 1) << (7 - k);
    return r;
  };
  while (i < rom.length && rom[i] !== 0xff) {
    let cmd = rom[i] >> 5;
    let len;
    if (cmd === 7) {
      cmd = (rom[i] >> 2) & 7;
      len = (((rom[i] & 3) << 8) | rom[i + 1]) + 1;
      i += 2;
    } else {
      len = (rom[i] & 31) + 1;
      i += 1;
    }
    if (cmd === 0) for (let k = 0; k < len && o < max; k++) out[o++] = rom[i++];
    else if (cmd === 1) {
      const v = rom[i++];
      for (let k = 0; k < len && o < max; k++) out[o++] = v;
    } else if (cmd === 2) {
      const a = rom[i];
      const b = rom[i + 1];
      i += 2;
      for (let k = 0; k < len && o < max; k++) out[o++] = k & 1 ? b : a;
    } else if (cmd === 3) for (let k = 0; k < len && o < max; k++) out[o++] = 0;
    else {
      let src;
      if (rom[i] & 0x80) {
        src = o - (rom[i] & 0x7f) - 1;
        i += 1;
      } else {
        src = (rom[i] << 8) | rom[i + 1];
        i += 2;
      }
      if (src < 0) return null;
      for (let k = 0; k < len && o < max; k++) {
        const s = cmd === 6 ? src - k : src + k;
        if (s < 0 || s >= o) return null;
        out[o++] = cmd === 5 ? flip(out[s]) : out[s];
      }
    }
    if (o >= max) break;
  }
  return out.subarray(0, o);
}

/**
 * The map as the game holds it, for the one place a Game Boy hides sprites behind the map: the tall grass. Sprites
 * standing in it get the OAM priority bit on their lower half (pokered UpdateSpriteImage / the player's
 * wSpritePlayerStateData2GrassPriority, pokecrystal SetTallGrassFlags → IN_GRASS_F), so the grass's colours 1–3 cover
 * those rows – colour 0 shows them. Neither generation sets the Game Boy Color's background priority attribute on map
 * tiles (Crystal's palette maps carry the palette and the VRAM bank only), so that is all.
 * Returns { key, grassAt(tx, ty), bgIndex(x, y) } (tile coordinates, world pixels) or null.
 */
export function gbMapView(t, read, rom, cache = new Map()) {
  if (!rom) return null;
  const r = t.ram;
  const size = read(r.mapHeight, 2);
  if (!ok(size, 2)) return null;
  const bw = size[1];
  const bh = size[0];
  const stride = bw + 6;
  const blocks = read(r.overworldMap, stride * (bh + 6));
  if (!blocks || !bw || !bh) return null;
  let ts;
  if (t.gen === 1) {
    const h = read(r.tilesetBank, 5);
    const g = read(r.grassTile, 1);
    if (!ok(h, 5)) return null;
    const blk = bankPtr(h[0], h[1] | (h[2] << 8));
    const gfx = bankPtr(h[0], h[3] | (h[4] << 8));
    const key = `1:${blk}:${gfx}`;
    if (!cache.has(key)) cache.set(key, blk > 0 && gfx > 0 ? { blk, tiles: rom.subarray(gfx, Math.min(rom.length, gfx + 0x600)), tileAt: (n) => n * 16 } : null);
    ts = cache.get(key);
    if (ts) ts = { ...ts, grass: g ? g[0] : 0xff };
  } else {
    const h = read(r.tilesetBank, 9);
    if (!ok(h, 9)) return null;
    const gfx = bankPtr(h[0], h[1] | (h[2] << 8));
    const blk = bankPtr(h[3], h[4] | (h[5] << 8));
    const coll = bankPtr(h[6], h[7] | (h[8] << 8));
    const key = `2:${gfx}:${blk}:${coll}`;
    if (!cache.has(key)) {
      const tiles = gfx > 0 ? gbLz(rom, gfx, 0xc0 * 16) : null;
      // Crystal puts the tileset's second $60 tiles into VRAM bank 1, numbered $80 on in the blocks
      cache.set(key, tiles && blk > 0 && coll > 0 ? { blk, coll, tiles, tileAt: (n) => (t.kris && n >= 0x80 ? n - 0x80 + 0x60 : n) * 16 } : null);
    }
    ts = cache.get(key);
  }
  if (!ts) return null;
  const blockAt = (bx, by) => (bx < -3 || by < -3 || bx >= bw + 3 || by >= bh + 3 ? -1 : blocks[(by + 3) * stride + bx + 3]);
  const tileAt = (x, y) => {
    const b = blockAt(Math.floor(x / 32), Math.floor(y / 32));
    if (b < 0) return -1;
    const o = ts.blk + b * 16 + ((((y % 32) + 32) % 32) >> 3) * 4 + ((((x % 32) + 32) % 32) >> 3);
    return o < rom.length ? rom[o] : -1;
  };
  const bgIndex = (x, y) => {
    const n = tileAt(x, y);
    if (n < 0) return 0;
    const o = ts.tileAt(n);
    if (o < 0 || o + 16 > ts.tiles.length) return 0;
    const ry = ((y % 8) + 8) % 8;
    const rx = ((x % 8) + 8) % 8;
    return ((ts.tiles[o + ry * 2] >> (7 - rx)) & 1) | (((ts.tiles[o + ry * 2 + 1] >> (7 - rx)) & 1) << 1);
  };
  const grassAt = (tx, ty) => {
    if (t.gen === 1) return ts.grass !== 0xff && tileAt(tx * 16, ty * 16 + 8) === ts.grass; // (the tile under its lower left)
    const b = blockAt(Math.floor(tx / 2), Math.floor(ty / 2));
    if (b < 0) return false;
    const o = ts.coll + b * 4 + (((ty % 2) + 2) % 2) * 2 + (((tx % 2) + 2) % 2);
    const c = o < rom.length ? rom[o] : 0;
    // CheckSuperTallGrassTile / CheckGrassTile: long grass, or tall grass and water with the low bits clear
    return c === 0x14 || c === 0x1c || (((c & 0xf0) === 0x10 || (c & 0xf0) === 0x20) && !(c & 7));
  };
  return { key: `${t.gen}:${ts.blk}`, grassAt, bgIndex };
}

/**
 * The pixels of a 16×16 sprite (its top left at world pixels x, y) that the tall grass covers: its lower half, where
 * the grass is not colour 0. Uint8Array(256) or null.
 */
export function grassMask(view, x, y) {
  if (!view) return null;
  let out = null;
  for (let r = 8; r < 16; r++) {
    for (let c = 0; c < 16; c++) if (view.bgIndex(x + c, y + r)) (out ??= new Uint8Array(256))[r * 16 + c] = 1;
  }
  return out;
}

/** shared/world.mjs DIR → the sheet's direction row (down, up, left, right). */
export const sheetDir = (facing) => DIR_SHEET[facing] ?? 0;
