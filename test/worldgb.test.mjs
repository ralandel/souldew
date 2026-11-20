// Shared World on the Game Boy (docs/MULTIPLAYER.md › 9, shared/worldgb.mjs): Red/Blue/Yellow and Gold/Silver/Crystal –
// the tables, the camera and the player from WRAM, connected maps, 2bpp sprites and party icons from a (synthetic)
// ROM, the colours SameBoy shows, the tall grass, Gen 2's LZ, and the ROM tables of a hack found by their shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { registerHooks } from 'node:module';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '/vendor/htm-preact.mjs') return next(ROOT + 'node_modules/htm/preact/standalone.module.js', ctx);
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const W = await import('../shared/world.mjs');
const G = await import('../shared/worldgb.mjs');
const { findEntry } = await import('../shared/live/parse.mjs');
const { gbWramShift, shiftEntry } = await import('../shared/live/romwram.mjs');
const addresses = JSON.parse(readFileSync(new URL('../shared/data/addresses.json', import.meta.url), 'utf8'));
const byId = (id) => addresses.games.find((g) => g.id === id);

function memory() {
  const m = new Map();
  const put = (addr, bytes) => bytes.forEach((b, i) => m.set(addr + i, b & 0xff));
  const read = (addr, len) => {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      if (!m.has(addr + i)) return null;
      out[i] = m.get(addr + i);
    }
    return out;
  };
  return { put, read, m };
}

/** Red on the overworld: map `map`, tile (x, y), facing (0/4/8/12), walk counter `wc` with step vector (vx, vy). */
function red({ id = 'red_us', map = 0, x = 5, y = 6, wc = 0, vx = 0, vy = 0, facing = 0, img = 0, font = 0, joy = 0, flags5 = 0, battle = 0, state = 0, grass = 0, sprite = 1 } = {}) {
  const t = W.worldTable(byId(id));
  const r = t.ram;
  const mem = memory();
  mem.put(r.curMap, [map, 0, 0, y, x]);
  mem.put(r.walkCounter, [wc]);
  const s1 = new Array(16).fill(0);
  [s1[0], s1[2], s1[3], s1[5], s1[9]] = [sprite, img, vy & 0xff, vx & 0xff, facing];
  mem.put(r.sprite1, s1);
  const s2 = new Array(16).fill(0);
  s2[7] = grass;
  mem.put(r.sprite2, s2);
  mem.put(r.fontLoaded, [font]);
  mem.put(r.joyIgnore, [joy]);
  mem.put(r.statusFlags5, [flags5]);
  mem.put(r.walkBikeSurf, [state]);
  mem.put(t.inBattle.addr, [battle]);
  return { t, mem };
}

/** Crystal (or Gold/Silver) on the overworld: map group/number, tile, the step's direction and BG offset. */
function crystal({ id = 'crystal_us', group = 24, num = 3, x = 47, y = 11, dir = 0xff, ox = 0, oy = 0, vx = 0, vy = 0, stepFlags = 0, facing = 0, state = 0, gender = 0, script = 0, status = 2, battle = 0, flags2 = 0, sign = 0 } = {}) {
  const t = W.worldTable(byId(id));
  const r = t.ram;
  const mem = memory();
  mem.put(r.mapGroup, [group, num, y, x]);
  const o = new Array(0x28).fill(0);
  [o[0], o[5], o[0x0d]] = [1, flags2, facing];
  mem.put(r.playerStruct, o);
  mem.put(r.bgMapOffsetX, [ox & 0xff, oy & 0xff, vx & 0xff, vy & 0xff, stepFlags, dir]);
  mem.put(r.playerState, [state]);
  if (r.playerGender) mem.put(r.playerGender, [gender]);
  mem.put(r.scriptRunning, [script]);
  mem.put(r.mapStatus, [status]);
  mem.put(r.timeOfDayPal, [1]);
  if (r.landmarkSign) mem.put(r.landmarkSign, [sign]);
  mem.put(t.inBattle.addr, [battle]);
  return { t, mem };
}

test('the Game Boy tables: Red, Blue, Yellow (family rby), Gold, Silver, Crystal (gsc) – from the pret symbol files', () => {
  for (const [id, gen, fam] of [['red_us', 1, 11], ['blue_us', 1, 11], ['yellow_us', 1, 11], ['gold_us', 2, 13], ['silver_us', 2, 13], ['crystal_us', 2, 13]]) {
    const t = W.worldTable(byId(id));
    assert.equal(t.gen, gen, id);
    assert.equal(t.fam, fam, id);
    assert.deepEqual([t.screen, t.anchor, t.spriteDy], [{ w: 160, h: 144 }, { x: 64, y: 64 }, -4]);
    for (const [k, v] of Object.entries(t.ram)) assert.ok(v >= 0xc000 && v < 0xe000, `${id} ${k}: WRAM banks 0/1 (what the mirror and WATCH reach)`);
    for (const [k, v] of Object.entries(t.rom)) if (typeof v === 'number' && !/Count$/.test(k)) assert.ok(v > 0x4000 && v < (gen === 1 ? 0x100000 : 0x200000), `${id} ${k}`);
  }
  // pret: Red and Blue share everything; Yellow moved most WRAM one byte down; Gold/Silver vs Crystal
  const [r, b, y] = ['red_us', 'blue_us', 'yellow_us'].map((id) => W.worldTable(byId(id)));
  assert.deepEqual(r.ram, b.ram);
  assert.deepEqual([r.ram.curMap, y.ram.curMap, r.ram.sprite1, y.ram.sprite1, y.ram.pikachu], [0xd35e, 0xd35d, 0xc100, 0xc100, 0xc1f0]);
  assert.deepEqual([W.worldTable(byId('crystal_us')).ram.mapGroup, W.worldTable(byId('gold_us')).ram.mapGroup], [0xdcb5, 0xda00]);
  assert.ok(W.worldTable(byId('crystal_us')).kris && !W.worldTable(byId('silver_us')).kris, 'only Crystal has a girl to play');
  assert.equal(W.FAMILIES.rby, 11);
  assert.equal(W.FAMILIES.gsc, 13);
  // found by the header like every Game Boy game
  assert.equal(findEntry(addresses, { platform: 'gbc', title: 'POKEMON YEL', code: 'LOW' }).id, 'yellow_us');
});

test('Gold/Silver maps go out with Crystal’s numbers – the 68 that differ, every shared map the same size', () => {
  const gs = W.worldTable(byId('gold_us'));
  assert.equal(gs.canon.size, 68);
  // Union Cave 1F: Gold/Silver 3.29, Crystal 3.37; New Bark Town (24.4) the same in both
  assert.equal(G.canonMap(gs, 3 * 256 + 29), 3 * 256 + 37);
  assert.equal(G.canonMap(gs, 24 * 256 + 4), 24 * 256 + 4);
  assert.equal(G.canonMap(W.worldTable(byId('crystal_us')), 3 * 256 + 29), 3 * 256 + 29, 'Crystal’s own as they are');
  // (the camera says the canonical one)
  const { t, mem } = crystal({ id: 'gold_us', group: 3, num: 29 });
  assert.equal(W.readCamera(t, mem.read).map, 3 * 256 + 37);
  // the Tin Tower back entrance exists only in Gold/Silver: 0, a map nobody else is on
  assert.ok([...gs.canon.values()].includes(0));
});

test('Gen 1 camera: the walk counter (8 → 0, two pixels at a time) and the step vector; the tile changes at 0', () => {
  const at = (o) => {
    const { t, mem } = red(o);
    const c = W.readCamera(t, mem.read);
    return [c.tx, c.ty, c.cx, c.cy];
  };
  assert.deepEqual(at({ x: 5, y: 6 }), [5, 6, 80, 96]);
  assert.deepEqual(at({ x: 5, y: 6, wc: 7, vx: 1 }), [5, 6, 82, 96], 'the first two pixels to the right');
  assert.deepEqual(at({ x: 5, y: 6, wc: 1, vx: -1 }), [5, 6, 66, 96], 'almost a whole step left');
  assert.deepEqual(at({ x: 5, y: 6, wc: 4, vy: 1 }), [5, 6, 80, 104]);
  assert.deepEqual(at({ x: 5, y: 7, wc: 0, vy: 1 }), [5, 7, 80, 112], 'done: the new tile');
  // the step's first turn of the loop lasts a frame longer: with the frame before still at 0, its picture hasn't moved
  const first = red({ x: 5, y: 6, wc: 7, vx: 1 });
  const before = red({ x: 5, y: 6, wc: 0, vx: 1 });
  assert.equal(W.readCamera(first.t, first.mem.read, before.mem.read).cx, 80);
  assert.equal(W.readCamera(first.t, first.mem.read, first.mem.read).cx, 82, 'the frame after: two pixels');
  // the edge of a map: wXCoord $FF for a moment (−1), before the connection takes over
  assert.deepEqual(at({ x: 0xff, y: 6 }).slice(0, 2), [-1, 6]);
  // before a game is loaded (title, Oak's talk): nothing; CONTINUE's screen (the save loaded, the player not drawn) neither
  const { t, mem } = red({ sprite: 0 });
  assert.equal(W.readCamera(t, mem.read), null);
  const menu = red({ img: 0xff });
  assert.equal(W.readCamera(menu.t, menu.mem.read), null);
});

test('Gen 1 player and drawable: facing, bike and surf; text boxes, menus, scripts and battles hide the partners', () => {
  const p = (o) => {
    const { t, mem } = red(o);
    return W.readPlayer(t, mem.read, W.readCamera(t, mem.read));
  };
  assert.deepEqual([p({ facing: 0 }).facing, p({ facing: 4 }).facing, p({ facing: 8 }).facing, p({ facing: 12 }).facing], [W.DIR.S, W.DIR.N, W.DIR.W, W.DIR.E]);
  assert.deepEqual([p({ state: 0 }).kind, p({ state: 1 }).kind, p({ state: 2 }).kind], ['walk', 'bike', 'surf']);
  assert.equal(p({}).gender, 0);
  const d = (o) => {
    const { t, mem } = red(o);
    return W.drawable(t, W.readCamera(t, mem.read));
  };
  assert.equal(d({}), true);
  assert.equal(d({ font: 1 }), false, 'a text box or a menu: the font is loaded');
  assert.equal(d({ joy: 0xff }), false, 'buttons ignored (a script)');
  assert.equal(d({ flags5: 0x80 }), false, 'scripted movement (Oak walking you)');
  assert.equal(d({ battle: 1 }), false);
  // Yellow: its own Pikachu on screen
  const { t, mem } = red({ id: 'yellow_us' });
  mem.put(t.ram.pikachu, [0x3d, 0, 4, ...new Array(13).fill(0)]);
  assert.equal(G.gameFollower(t, mem.read), true);
  mem.put(t.ram.pikachu + 2, [0xff]);
  assert.equal(G.gameFollower(t, mem.read), false, 'off screen');
  assert.equal(G.gameFollower(red().t, red().mem.read), false, 'Red: none');
  // where it stands (the sprite data keeps the tile 4 higher): pressing A at it is the game's (it talks to Pikachu)
  mem.put(t.ram.pikachu + 2, [4]);
  mem.put(t.ram.pikachuMap, [6 + 4, 7 + 4]);
  assert.deepEqual(G.gameFollowerTile(t, mem.read), [7, 6]);
});

test('Gen 2 camera: wPlayerBGMapOffset counts the pixels of the step; wXCoord/wYCoord change when it ends', () => {
  const at = (o) => {
    const { t, mem } = crystal(o);
    const c = W.readCamera(t, mem.read);
    return [c.cx, c.cy];
  };
  assert.deepEqual(at({ x: 47, y: 11 }), [752, 176]);
  assert.deepEqual(at({ x: 47, y: 11, dir: 3, ox: -6 }), [758, 176], 'six pixels right');
  assert.deepEqual(at({ x: 47, y: 11, dir: 2, ox: 6 }), [746, 176], 'six pixels left');
  assert.deepEqual(at({ x: 47, y: 11, dir: 0, oy: -12 }), [752, 188], 'down');
  assert.deepEqual(at({ x: 47, y: 11, dir: 1, oy: 4 }), [752, 172], 'up');
  assert.deepEqual(at({ x: 47, y: 11, dir: 1, oy: 16 }), [752, 176], 'a whole step: the tile itself');
  // the picture shows the loop's turn before (measured frame by frame): back by the step vector while the step goes
  // on (CONTINUE), not on its first turn (START) – the tile coordinates already moved on its last one
  assert.deepEqual(at({ x: 47, y: 11, dir: 3, ox: -6, vx: 2, stepFlags: 0x20 }), [756, 176]);
  assert.deepEqual(at({ x: 47, y: 11, dir: 3, ox: 0, vx: 2, stepFlags: 0xa0 }), [752, 176], 'the first turn');
  assert.deepEqual(at({ x: 48, y: 11, dir: 3, ox: -16, vx: 2, stepFlags: 0x60 }), [766, 176], 'the last turn (STOP)');
  assert.deepEqual(at({ x: 47, y: 11, dir: 1, oy: 6, vy: -2, stepFlags: 0x20 }), [752, 172], 'six up, the picture four');
  const d = (o) => {
    const { t, mem } = crystal(o);
    return W.drawable(t, W.readCamera(t, mem.read));
  };
  assert.equal(d({}), true);
  assert.equal(d({ script: 1 }), false, 'a script (talking, a sign, START, a warp)');
  assert.equal(d({ status: 1 }), false, 'entering a map');
  assert.equal(d({ battle: 1 }), false);
  const { t, mem } = crystal({ group: 0 });
  assert.equal(W.readCamera(t, mem.read), null, 'no map yet');
});

test('Gen 2 player: facing from OBJECT_FACING, bike/surf/surfing Pikachu, Crystal’s girl; the place sign', () => {
  const p = (o) => {
    const { t, mem } = crystal(o);
    return W.readPlayer(t, mem.read, W.readCamera(t, mem.read));
  };
  assert.deepEqual([0, 5, 10, 15].map((f) => p({ facing: f }).facing), [W.DIR.S, W.DIR.N, W.DIR.W, W.DIR.E]);
  assert.deepEqual([0, 1, 2, 4, 8].map((s) => p({ state: s }).kind), ['walk', 'bike', 'walk', 'surf', 'surf']);
  assert.equal(p({ gender: 1 }).gender, 1);
  assert.equal(p({ id: 'silver_us', gender: 1 }).gender, 0, 'Gold/Silver: always the boy');
  // the local sprite: its frame (dir/phase → sheet image and flip) and the tall grass over its legs
  const { t, mem } = crystal({ facing: 15, flags2: 0x08 });
  assert.deepEqual(W.readLocalSprite(t, mem.read), { x: 64, y: 60, w: 16, h: 16, img: 5, flip: true, grass: true, dir: 3, phase: 3 });
  // Crystal's place sign: the bottom four rows while its timer runs
  assert.equal(W.popupRect(crystal({ sign: 0 }).t, crystal({ sign: 0 }).mem.read), null);
  const s = crystal({ sign: 40 });
  assert.deepEqual(W.popupRect(s.t, s.mem.read), { x: 0, y: 112, w: 160, h: 32, shown: 32, grows: false });
  assert.equal(W.popupRect(crystal({ id: 'gold_us' }).t, crystal({ id: 'gold_us' }).mem.read), null, 'Gold/Silver have none');
});

test('connected maps from RAM: entering the neighbour puts you where its alignment says – a partner there in your frame', () => {
  // Pallet Town (10×9 blocks) – Route 1 north (10×18 blocks, offset 0): YAlignment 35, XAlignment 0 (pokered's connection
  // macro); and an east neighbour with a row offset of −8 steps (YAlignment 8)
  const { t, mem } = red({ map: 0 });
  const r = t.ram;
  mem.put(r.mapHeight, [9, 10]);
  const hdr = (map, yA, xA) => [map, 0, 0, 0, 0, 10, 10, yA & 0xff, xA & 0xff, 0, 0];
  mem.put(r.connections, [8 | 1, ...hdr(12, 35, 0), ...new Array(22).fill(0), ...hdr(33, 8, 0)]);
  const c = W.readConnections(t, mem.read, null, 0);
  assert.deepEqual([c.w, c.h], [20, 18]);
  assert.deepEqual(c.list.map((x) => [x.dir, x.map, x.ox / 16, x.oy / 16]), [[W.CONN.N, 12, 0, -36], [W.CONN.E, 33, 20, -8]]);
  // on Route 1's bottom row (x 10, y 35) = just north of Pallet Town (10, −1)
  assert.deepEqual(W.inLocalFrame(c, { map: 12, x: 160, y: 35 * 16 }), { x: 160, y: -16 });
  // the east map's (0, 10): one step east of Pallet Town's right edge, two rows up
  assert.deepEqual(W.inLocalFrame(c, { map: 33, x: 0, y: 160 }), { x: 320, y: 32 });
  assert.equal(W.inLocalFrame(c, { map: 7, x: 0, y: 0 }), null, 'not connected');
  // Gen 2: 12-byte headers (group, number …), Gold/Silver numbers made Crystal's
  const g = crystal({ id: 'gold_us' });
  g.mem.put(g.t.ram.mapHeight, [9, 10]);
  g.mem.put(g.t.ram.connections, [4, ...new Array(12).fill(0), 3, 29, 0, 0, 0, 0, 0, 10, 0, (-4) & 0xff, 0, 0]);
  const gc = W.readConnections(g.t, g.mem.read, null, 1);
  assert.deepEqual(gc.list, [{ dir: W.CONN.S, map: 3 * 256 + 37, ox: 64, oy: 18 * 16 }]);
});

test('the wire and the picture: a Game Boy partner round trips, drawn from the 160×144 anchor, other families never', () => {
  const { t, mem } = red({ x: 5, y: 6 });
  const cam = W.readCamera(t, mem.read);
  const me = W.readPlayer(t, mem.read, cam);
  const back = W.unpackState(W.packState({ ...me, fam: t.fam, x: 7 * 16, y: 6 * 16 }, 1, 0));
  assert.equal(back.fam, 11);
  assert.deepEqual(W.screenPos(t, cam, back), { x: 96, y: 64 });
  assert.equal(W.screenPos(t, cam, { ...back, fam: 13 }), null, 'Gold/Silver/Crystal maps are other maps');
  assert.equal(W.screenPos(t, cam, { ...back, x: 20 * 16 }), null, 'off the 160-pixel picture');
  assert.equal(W.facedPartner(t, { ...me, facing: W.DIR.E, tx: 6 }, [{ slot: 'p2', state: back }]), 'p2');
  // what the native player sends with every picture: the position, the step, the screen state
  const ranges = W.watchRanges(t);
  assert.ok(ranges.length <= 16 && ranges.reduce((n, x) => n + x[1], 0) <= 512);
  const c = crystal().t;
  assert.ok(W.watchRanges(c).reduce((n, x) => n + x[1], 0) <= 512);
});

// ---- the ROM ----------------------------------------------------------------------------------------------------------
test('2bpp: low plane then high plane per row, MSB first; a 16×16 frame of four tiles', () => {
  const rom = new Uint8Array(64);
  rom[0] = 0b10000001; // row 0: colour 1 at x 0 and 7 …
  rom[1] = 0b10000000; // … colour 3 at x 0
  const t = G.decode2bpp(rom, 0);
  assert.deepEqual([t[0], t[7], t[1]], [3, 1, 0]);
  rom[16 * 3 + 14] = 0x01; // the bottom-right tile's last row, last pixel
  const f = G.frame16(rom, 0);
  assert.equal(f[15 * 16 + 15], 1);
  assert.equal(f[0], 3);
  // the walking table: down = stand, walk, stand, walk mirrored; right = left mirrored
  assert.deepEqual(G.WALK[0].map((x) => [x.img, x.flip]), [[0, false], [3, false], [0, false], [3, true]]);
  assert.ok(G.WALK[3].every((x) => x.flip));
  assert.equal(G.GB_ANIMS[0].length, 1);
  assert.equal(G.GB_ANIMS[5].length, 4);
});

test('colours: SameBoy’s Game Boy Color correction ("emulate hardware") and the original Game Boy’s lime shades', () => {
  assert.deepEqual(G.cgbRgb(0x7fff), [255, 255, 255]);
  assert.deepEqual(G.cgbRgb(0), [0, 0, 0]);
  assert.deepEqual(G.cgbRgb(0x001f), [255, 0, 0]);
  assert.deepEqual(G.cgbRgb(0x7c00), [0, 107, 255], 'blue lifts green a little, as the screen did');
  assert.deepEqual(G.DMG_SHADES[0], [0xc6, 0xde, 0x8c]);
  assert.deepEqual(G.DMG_OBP0, [0, 0, 1, 3]);
  // sampling a picture: the colour numbers of the frame against the pixels there (the top half only)
  const idx = new Uint8Array(256);
  idx[0] = 1;
  idx[1] = 2;
  idx[2] = 3;
  idx[15 * 16] = 2; // (bottom half: not looked at)
  const px = (x, y) => (y === 10 ? [[9, 9, 9], [10, 20, 30], [40, 50, 60], [70, 80, 90]][x - 4] || [0, 0, 0] : [0, 0, 0]);
  assert.deepEqual(G.samplePalette(idx, false, 5, 10, px), { 1: [10, 20, 30], 2: [40, 50, 60], 3: [70, 80, 90] });
  // flipped: the frame's x 0 is the picture's x 15
  const flipped = G.samplePalette(idx, true, 2 - 15, 10, (x, y) => (y === 10 && x === 2 ? [1, 2, 3] : [0, 0, 0]));
  assert.deepEqual(flipped[1], [1, 2, 3]);
  const rgba = G.paint(idx, [[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]], (() => { const h = new Uint8Array(256); h[1] = 1; return h; })());
  assert.deepEqual([...rgba.subarray(0, 12)], [1, 1, 1, 255, 0, 0, 0, 0, 3, 3, 3, 255], 'colour 0 and hidden pixels stay clear');
});

/** A synthetic Gen 1 ROM: the icon pointer table, MonPartyData, tiles to point at. */
function gen1Rom() {
  const rom = new Uint8Array(0x80000);
  const t = W.worldTable(byId('red_us'));
  const tables = { ...t, rom: { ...t.rom, iconPointers: 0x4000 * 7 + 0x100, iconData: 0x4000 * 7 + 0x300, iconCount: 2 } };
  const ptrs = tables.rom.iconPointers;
  // entry 0: 4 tiles at bank 7 $5000 → vSprites tile 0 (ICON_MON, frame 1); entry 1: frame 2 at tile $40
  const e = (i, src, n, dest) => rom.set([src & 0xff, src >> 8, n, 7, dest & 0xff, dest >> 8], ptrs + i * 6);
  e(0, 0x5000, 4, 0x8000);
  e(1, 0x5040, 4, 0x8400);
  rom[7 * 0x4000 + 0x1000] = 0x80; // tile 0, row 0: colour 1 at x 0
  rom[7 * 0x4000 + 0x1000 + 32] = 0x01; // tile 2 (bottom left), row 0: colour 1 at x 7
  rom[7 * 0x4000 + 0x1040] = 0x40; // frame 2: colour 1 at x 1
  rom[tables.rom.iconData] = 0x00; // Bulbasaur (odd: high nybble) and Ivysaur: ICON_MON
  return { rom, t: tables };
}

test('Gen 1 icons: the game’s generic party icons, built like its OAM writer – the left half mirrored', () => {
  const { rom, t } = gen1Rom();
  const ic = G.gen1Icon(rom, t, 1);
  assert.equal(ic.frames.length, 2);
  const f = ic.frames[0];
  assert.deepEqual([f[0], f[15]], [1, 1], 'top left and its mirror at the right edge');
  assert.deepEqual([f[8 * 16 + 7], f[8 * 16 + 8]], [1, 1], 'the bottom tile and its mirror');
  assert.equal(ic.frames[1][1], 1, 'the second frame from ICONOFFSET');
  assert.deepEqual([ic.top, ic.bottom, ic.left, ic.right], [0, 8, 0, 15]);
  assert.equal(G.gen1Icon(rom, t, 0), null);
  assert.equal(G.gen1Icon(rom, t, 152), null, 'no such Pokémon in Gen 1');
  assert.equal(G.gen1Icon(rom, { ...t, rom: { ...t.rom, iconPointers: 0 } }, 1), null);
});

test('Gen 2 icons and colours: MonMenuIcons → IconPointers, two frames; the Pokémon’s own palette, its shiny one too', () => {
  const rom = new Uint8Array(0x100000);
  const t0 = W.worldTable(byId('crystal_us'));
  const bank = 0x23;
  const t = { ...t0, rom: { ...t0.rom, monMenuIcons: bank * 0x4000 + 0x100, iconPointers: bank * 0x4000 + 0x200, icons: bank * 0x4000 + 0x400, pokemonPalettes: 2 * 0x4000 + 0x100 } };
  rom[t.rom.monMenuIcons + 24] = 2; // Pikachu → icon 2
  rom.set([0x80, 0x44], t.rom.iconPointers + 4); // icon 2 at $4480
  rom[bank * 0x4000 + 0x480] = 0x80; // frame 1, tile 0, row 0, colour 1 at x 0
  rom[bank * 0x4000 + 0x480 + 64 + 1] = 0x80; // frame 2: colour 2 at x 0
  const ic = G.gen2Icon(rom, t, 25);
  assert.equal(ic.frames[0][0], 1);
  assert.equal(ic.frames[1][0], 2);
  assert.equal(G.gen2Icon(rom, t, 252), null);
  rom.set([0x1f, 0x00, 0x00, 0x7c, 0xe0, 0x03, 0x00, 0x00], t.rom.pokemonPalettes + 25 * 8);
  assert.deepEqual(G.gen2MonPalette(rom, t, 25), [[255, 255, 255], [255, 0, 0], [0, 107, 255], [0, 0, 0]]);
  assert.deepEqual(G.gen2MonPalette(rom, t, 25, true)[1], G.cgbRgb(0x03e0));
});

test('Gen 2 sheets and palettes: OverworldSprites by sprite id (Chris, his bike, surfing; Kris in Crystal), the time of day', () => {
  const rom = new Uint8Array(0x200000);
  const t0 = W.worldTable(byId('crystal_us'));
  const t = { ...t0, rom: { ...t0.rom, overworldSprites: 5 * 0x4000 + 0x736, mapObjectPals: 2 * 0x4000 + 0x3469 } };
  const put = (id, ptr, bank, pal) => rom.set([ptr & 0xff, ptr >> 8, 0xc0, bank, 1, pal], t.rom.overworldSprites + (id - 1) * 6);
  put(1, 0x4000, 0x30, 0);
  put(0x60, 0x7a40, 0x31, 1);
  put(0x53, 0x5000, 0x30, 1);
  assert.deepEqual(G.gbSheet(rom, t, 'walk', 0), { off: 0x30 * 0x4000, pal: 0 });
  assert.deepEqual(G.gbSheet(rom, t, 'walk', 1), { off: 0x31 * 0x4000 + 0x3a40, pal: 1 }, 'Kris, blue');
  assert.deepEqual(G.gbSheet(rom, t, 'surf', 1), { off: 0x30 * 0x4000 + 0x1000, pal: 1 });
  assert.equal(G.gbSheet(rom, t, 'bike', 0), null, 'an empty entry');
  // MapObjectPals: day (1) palette 0 colour 3 – the time of day picks the set of eight
  rom.set([0xff, 0x7f], t.rom.mapObjectPals + (1 * 8 + 0) * 8 + 2);
  assert.deepEqual(G.gen2ObjPalette(rom, t, 0, 1)[1], [255, 255, 255]);
  assert.deepEqual(G.gen2ObjPalette(rom, t, 0, 0)[1], [0, 0, 0]);
});

test('Gen 2 LZ: literal, iterate, alternate, zero, repeat (back and absolute), flip, reverse, the long form', () => {
  const lz = new Uint8Array([
    0x02, 1, 2, 3, // literal ×3
    0x21, 9, // iterate ×2
    0x43, 5, 6, // alternate ×4
    0x61, // zero ×2
    0x82, 0x80 | 10, // repeat ×3 from 11 back (the start: 1 2 3)
    0xa0, 0, 0, // flip ×1 of byte 0 (1 → $80)
    0xc1, 0, 2, // reverse ×2 from 2 (3 2)
    0xe4, 0x02, 0x22, // long: iterate (1 << 2) ×3 of $22
    0xff,
  ]);
  assert.deepEqual([...G.gbLz(lz, 0)], [1, 2, 3, 9, 9, 5, 6, 5, 6, 0, 0, 1, 2, 3, 0x80, 3, 2, 0x22, 0x22, 0x22]);
  assert.equal(G.gbLz(new Uint8Array([0x80, 0x80 | 5, 0xff]), 0), null, 'a reference before the start');
});

test('tall grass: Gen 1 the tileset’s grass tile under the lower left, Gen 2 the quadrant’s collision; the grass’s colours', () => {
  const rom = new Uint8Array(0x80000);
  const { t, mem } = red();
  const r = t.ram;
  // a 2×2-block map, tileset bank 1: blocks at $4000, graphics at $4100, grass tile $52
  mem.put(r.mapHeight, [2, 2]);
  const blocks = new Array(8 * 8).fill(0);
  blocks[3 * 8 + 3] = 1; // block (0, 0) = metatile 1
  mem.put(r.overworldMap, blocks);
  mem.put(r.tilesetBank, [1, 0x00, 0x40, 0x00, 0x41]);
  mem.put(r.grassTile, [0x52]);
  rom.fill(0x52, 0x4000 + 16, 0x4000 + 32); // metatile 1: grass everywhere
  rom[0x4000 + 0x100 + 0x52 * 16 + 2 * 1] = 0xf0; // the grass tile's row 1: colour 1 in its left half
  const v = G.gbMapView(t, mem.read, rom);
  assert.equal(v.grassAt(0, 0), true);
  assert.equal(v.grassAt(2, 0), false, 'block (1, 0) is metatile 0');
  assert.equal(v.bgIndex(0, 9), 1);
  assert.equal(v.bgIndex(5, 9), 0);
  // the sprite's lower half (rows 8–15 = world y 8–15 here) is covered where the grass isn't colour 0
  const m = G.grassMask(v, 0, 0);
  assert.equal(m[9 * 16 + 0], 1);
  assert.equal(m[9 * 16 + 5], 0);
  assert.equal(m[1 * 16 + 0], 0, 'never the upper half');
  // Gen 2: the collision of the step's quadrant ($18 tall grass, $14 long grass, water $20; $29 not)
  const c = crystal();
  const cr = c.t.ram;
  const rom2 = new Uint8Array(0x80000);
  c.mem.put(cr.mapHeight, [1, 1]);
  const b2 = new Array(7 * 7).fill(0);
  c.mem.put(cr.overworldMap, b2);
  c.mem.put(cr.tilesetBank, [1, 0x00, 0x60, 1, 0x00, 0x40, 1, 0x00, 0x50]);
  rom2[0x4000 + 0x2000] = 0xff; // the graphics: an empty LZ stream
  rom2.set([0x18, 0x29, 0x14, 0x00], 0x4000 + 0x1000); // metatile 0's quadrants
  const v2 = G.gbMapView(c.t, c.mem.read, rom2);
  assert.deepEqual([v2.grassAt(0, 0), v2.grassAt(1, 0), v2.grassAt(0, 1), v2.grassAt(1, 1)], [true, false, true, false]);
});

test('a hack’s ROM tables: checked where the table says, else found by their shape, else left out', () => {
  const t0 = W.worldTable(byId('crystal_us'));
  const rom = new Uint8Array(0x200000);
  // OverworldSprites somewhere else: Chris and his bike (12 tiles, walking, red), the Game Boy kid (standing, green) …
  const at = 0x1234;
  for (let i = 0; i < 8; i++) rom.set([0x00, 0x40 + i, 0xc0, 0x30, i === 2 ? 2 : 1, i === 2 ? 2 : i < 2 ? 0 : i & 7], at + i * 6);
  // IconPointers: the null icon, then $80 steps; MonMenuIcons right before them (a family of three, then all the icons)
  const ip = 0x88000;
  rom.set([0x00, 0x60], ip);
  for (let i = 1; i < 40; i++) rom.set([(0x6000 + (i - 1) * 0x80) & 0xff, (0x6000 + (i - 1) * 0x80) >> 8], ip + i * 2);
  for (let i = 0; i < 251; i++) rom[ip - 251 + i] = i < 3 ? 1 : 1 + (i % 38);
  // a run of $80 steps without the icon numbers before it isn't taken for the icons
  const decoy = 0x40000;
  rom.set([0x00, 0x50], decoy);
  for (let i = 1; i < 40; i++) rom.set([(0x5000 + (i - 1) * 0x80) & 0xff, (0x5000 + (i - 1) * 0x80) >> 8], decoy + i * 2);
  const r = G.gbRomTables(rom, t0);
  assert.equal(r.overworldSprites, at);
  assert.equal(r.iconPointers, ip);
  assert.equal(r.monMenuIcons, ip - 251);
  assert.equal(r.icons, Math.floor(ip / 0x4000) * 0x4000 + 0x2000);
  assert.equal(r.mapObjectPals, 0, 'not there: left out');
  assert.equal(r.pokemonPalettes > 0, true, 'zeros are valid colours (an empty table still reads)');
  // Gen 1: a broken icon table is left out
  const g1 = W.worldTable(byId('red_us'));
  assert.equal(G.gbRomTables(new Uint8Array(0x100000), g1).iconPointers, 0);
});

test('a hack built from the disassembly with moved WRAM: the world table follows the code’s references', () => {
  // a fake Crystal-engine ROM whose code names everything in WRAMX bank 1 eleven bytes further on (Crystal Legacy)
  const crystalEntry = byId('crystal_us');
  const rom = new Uint8Array(0x8000);
  let o = 0;
  const ref = (addr, n) => { for (let i = 0; i < n; i++) rom.set([0xfa, addr & 0xff, addr >> 8], (o += 3)); };
  ref(0xdcd7 + 11, 40); // wPartyCount
  ref(0xd22d + 11, 40); // wBattleMode
  ref(0xdcb5 + 11, 40); // wMapGroup
  const shift = gbWramShift(rom, crystalEntry, { mapGroupAddr: crystalEntry.world.mapGroupAddr });
  assert.equal(shift.delta, 11);
  const t = W.worldTable(shiftEntry(crystalEntry, shift));
  assert.equal(t.ram.mapGroup, 0xdcb5 + 11);
  assert.equal(t.ram.playerStruct, 0xd4d6 + 11, 'the rest of the bank goes along');
  assert.equal(t.ram.landmarkSign, 0xc2da, 'bank 0 stays');
});

// ---- the real ROMs (SOULDEW_TEST_ROMS: a folder with red.gb, blue.gb, yellow.gb, gold.gbc, silver.gbc, crystal.gbc) ----
const ROMS = process.env.SOULDEW_TEST_ROMS;
test('the real ROMs: every table where the symbol files say, the sheets and icons drawn', { skip: !ROMS }, async () => {
  const { identifyRom } = await import('../shared/romid.mjs');
  for (const f of ['red.gb', 'blue.gb', 'yellow.gb', 'gold.gbc', 'silver.gbc', 'crystal.gbc']) {
    if (!existsSync(join(ROMS, f))) continue;
    const rom = new Uint8Array(readFileSync(join(ROMS, f)));
    const id = identifyRom(rom, f.split('.')[1]);
    const t = W.worldTable(findEntry(addresses, { platform: id.system, code: id.code, title: id.title }));
    assert.deepEqual(G.gbRomTables(rom, t), t.rom, `${f}: nothing searched`);
    for (const [kind, gender] of [['walk', 0], ['bike', 0], ['surf', 0], ...(t.kris ? [['walk', 1]] : [])]) {
      const sh = G.gbSheet(rom, t, kind, gender);
      assert.ok(sh, `${f} ${kind}`);
      assert.ok(G.sheetFrames(rom, sh.off).every((fr) => fr.filter(Boolean).length > 60), `${f} ${kind}: six drawn frames`);
    }
    for (const dex of [1, 25, 151, ...(t.gen === 2 ? [152, 251] : [])]) {
      const ic = t.gen === 1 ? G.gen1Icon(rom, t, dex) : G.gen2Icon(rom, t, dex);
      assert.ok(ic && ic.frames[0].filter(Boolean).length > 30, `${f} #${dex}`);
    }
    if (t.gen === 2) assert.deepEqual(G.gen2ObjPalette(rom, t, 0, 1)[3], [0, 0, 0], `${f}: the people's palettes end in black`);
  }
});

test('SharedWorld: Yellow’s own Pikachu following you goes out as your follower; the Game Boy systems have Shared World', async () => {
  globalThis.addEventListener ??= () => {};
  globalThis.removeEventListener ??= () => {};
  globalThis.dispatchEvent ??= () => true;
  globalThis.CustomEvent ??= class { constructor(type, o) { this.type = type; this.detail = o?.detail; } };
  const { SharedWorld, WORLD_SYSTEMS } = await import('../web/lib/sharedworld.mjs');
  assert.deepEqual(WORLD_SYSTEMS, ['gb', 'gbc', 'gba', 'nds']);
  const sent = [];
  const sync = { others: ['p2'], status: { partners: { p2: {} } }, onWorld: () => () => {}, sendWorld: (m, o = {}) => (sent.push({ m, relay: !!o.relay }), new Set(['p2'])) };
  let now = 0;
  const page = { postMessage() {} };
  const w = new SharedWorld({ sync, me: 'p1', frame: () => ({ contentWindow: page }), now: () => now, lead: { species: 4, shiny: false, form: 0 } });
  clearInterval(w.timer);
  globalThis.location ??= { origin: 'http://x' };
  const st = { fam: 11, map: 0, x: 0, y: 0, facing: 1, kind: 'walk', gender: 0, run: false };
  w._fromPlayer({ origin: location.origin, source: page, data: { type: 'emu-world', st, gameLead: { species: 25, shiny: false, form: 0 } } });
  assert.deepEqual(sent.at(-1).m.w[8].f, [25, 0], 'the game’s Pikachu, not the lead');
  now += 1100;
  w._fromPlayer({ origin: location.origin, source: page, data: { type: 'emu-world', st: { ...st, x: 16 }, gameLead: null } });
  assert.deepEqual(sent.at(-1).m.w[8].f, [4, 0], 'Pikachu back in its ball: the lead again');
  w.stop();
});

test('Gen 2: a script alone (the few frames one runs when a step ends) is told apart from a map being entered', () => {
  const run = crystal({ script: 1 });
  const c = W.readCamera(run.t, run.mem.read);
  assert.deepEqual([c.locked, c.scripted], [true, true], 'still locked: the A menu waits for it');
  const entering = crystal({ script: 1, status: 0 });
  assert.equal(W.readCamera(entering.t, entering.mem.read).scripted, false);
  const free = crystal();
  assert.deepEqual([W.readCamera(free.t, free.mem.read).locked, W.readCamera(free.t, free.mem.read).scripted], [false, false]);
});
