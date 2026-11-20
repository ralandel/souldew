// Shared World (docs/MULTIPLAYER.md › 9): the RAM reads per game, the wire format, the interpolation, what is drawn
// where, the sprites from a (synthetic) ROM, the send policy and the peer channel's world action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '/vendor/htm-preact.mjs') return next(ROOT + 'node_modules/htm/preact/standalone.module.js', ctx);
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const W = await import('../shared/world.mjs');
const S = await import('../shared/worldsprites.mjs');
const M = await import('../shared/worldmap.mjs');
const { findEntry } = await import('../shared/live/parse.mjs');
const addresses = JSON.parse(readFileSync(new URL('../shared/data/addresses.json', import.meta.url), 'utf8'));
const entry = (code) => findEntry(addresses, { platform: 'gba', code });

// ---- a fake GBA memory -----------------------------------------------------------------------------------------------
function memory() {
  const m = new Map(); // byte address → value
  const put = (addr, bytes) => bytes.forEach((b, i) => m.set(addr + i, b & 0xff));
  const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
  const read = (addr, len) => {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      if (!m.has(addr + i)) return null;
      out[i] = m.get(addr + i);
    }
    return out;
  };
  return { put, read, u16, u32 };
}

/** Emerald on the overworld: SaveBlock1 at 0x02025000, the player at (x, y) on map 0.3 walking `ox` px of a step. */
function emerald({ x = 10, y = 7, ox = 0, oy = 0, map = [0, 3], facing = W.DIR.S, gfx = 0, flags = 1, gender = 0, locked = 0, fade = 0, battle = 0, cb2, objX = x, objY = y } = {}) {
  const t = W.worldTable(entry('BPEE'), 0);
  const mem = memory();
  const sb1 = 0x02025000;
  mem.put(t.saveBlock1Ptr, mem.u32(sb1));
  mem.put(sb1, [...mem.u16(x), ...mem.u16(y), map[0], map[1], 0, 0]);
  mem.put(t.fieldCamera + 0x10, [...mem.u32(ox), ...mem.u32(oy)]);
  mem.put(t.main + 4, mem.u32(cb2 ?? t.overworldCb2));
  mem.put(t.main + 0x2c, mem.u16(0));
  mem.put(t.paletteFade + 4, [fade ? (fade << 6) & 0xff : 0, fade ? fade >> 2 : 0, 0, fade ? 0x80 : 0]);
  mem.put(t.lock, [locked]);
  mem.put(t.inBattle.addr, [battle ? 2 : 0]);
  mem.put(t.playerAvatar, [flags, 0, 0, 0, 0, 0, 0, gender]);
  const o = new Array(0x24).fill(0);
  o[0] = 1; // active
  o[1] = 0x80; // trackedByCamera
  o[2] = 1; // isPlayer
  o[5] = gfx;
  [o[0x10], o[0x11]] = mem.u16(objX + 7);
  [o[0x12], o[0x13]] = mem.u16(objY + 7);
  o[0x18] = facing;
  mem.put(t.objectEvents, o);
  return { t, mem, sb1 };
}

test('the Gen 3 tables: every English/German RSE and FR/LG revision with pret addresses; nothing for other games', () => {
  for (const [code, fam, revs] of [['BPEE', 'e', [0]], ['BPRE', 'frlg', [0, 1]], ['BPGE', 'frlg', [0, 1]], ['AXVE', 'rs', [0, 1, 2]], ['AXPE', 'rs', [0, 1, 2]], ['AXVD', 'rs', [0]], ['AXPD', 'rs', [0, 1]], ['BPED', 'e', [0]]]) {
    for (const rev of revs) {
      const t = W.worldTable(entry(code), rev);
      assert.equal(t.family, fam, code);
      assert.ok(t.overworldCb2 & 1, `${code} rev ${rev}: a Thumb function`);
      assert.ok(t.graphicsInfo > 0x08000000 && t.spritePalettes > 0x08000000);
      assert.ok(t.objectEvents >= 0x02000000 && t.fieldCamera >= 0x03000000 && t.sprites >= 0x02000000);
      assert.ok(t.saveBlock1Ptr || t.saveBlock1);
      assert.ok(t.avatars.find((a) => a.kind === 'walk' && a.gfx.length === 2));
    }
  }
  // an unknown revision keeps the RAM table (the overworld callback is learned, the ROM tables searched)
  const r9 = W.worldTable(entry('BPEE'), 9);
  assert.equal(r9.overworldCb2, 0);
  assert.ok(r9.objectEvents);
  assert.equal(W.worldTable(findEntry(addresses, { platform: 'nds', code: 'IPKE' }), 0), null);
  assert.equal(W.worldTable(null), null);
  // FR/LG German (and French, Italian, Spanish – one entry each): the RAM 0xB0 lower from gMain on, the ROM per code
  for (const [code, cb2] of [['BPRD', 0x080565d5], ['BPGD', 0x080565d5], ['BPRF', 0], ['BPGS', 0]]) {
    const de = W.worldTable(entry(code), 0, code);
    assert.equal(de.family, 'frlg', code);
    assert.deepEqual([de.main, de.saveBlock1Ptr, de.fieldCamera, de.backupMap, de.tasks], [0x03003040, 0x03004f58, 0x03004fa0, 0x03004f90, 0x03004fe0], code);
    assert.equal(de.objectEvents, W.worldTable(entry('BPRE'), 0).objectEvents, 'EWRAM: as in English');
    assert.equal(de.overworldCb2, cb2, code);
    assert.equal(!!de.popup, !!cb2, `${code}: the popup cut-out only where its task is known`);
    assert.equal(de.questLog, 0x0203adfa);
  }
});

test('German Ruby/Sapphire/Emerald: Saphir has the German Ruby’s RAM, Smaragd the English Emerald’s – the ROM per game', () => {
  // (each verified in the running game, docs/MULTIPLAYER.md › 9; the addresses below are what was read there)
  const rubin = W.worldTable(entry('AXVD'), 0, 'AXVD');
  const ruby = W.worldTable(entry('AXVE'), 0, 'AXVE');
  for (const rev of [0, 1]) {
    const saphir = W.worldTable(entry('AXPD'), rev, 'AXPD');
    assert.equal(saphir.family, 'rs');
    assert.equal(saphir.fam, ruby.fam, 'the German Sapphire meets Ruby and Sapphire in any language');
    for (const k of ['objectEvents', 'playerAvatar', 'fieldCamera', 'saveBlock1', 'main', 'paletteFade', 'lock', 'sprites', 'mapHeader', 'backupMap', 'tasks']) assert.equal(saphir[k], rubin[k], k);
    assert.deepEqual([saphir.overworldCb2, saphir.graphicsInfo, saphir.spritePalettes, saphir.popup.task], [0x080546e9, 0x083793d4, 0x0837eef8, 0x080a3145], `Saphir rev ${rev}`);
    assert.deepEqual(saphir.popup.rect, ruby.popup.rect);
  }
  assert.deepEqual([rubin.objectEvents, rubin.fieldCamera, rubin.backupMap, rubin.tasks], [0x030048b0, 0x03004890, 0x03004880, 0x03004b30], 'German R/S: IWRAM 0x10 further on');
  const em = W.worldTable(entry('BPEE'), 0, 'BPEE');
  const smaragd = W.worldTable(entry('BPED'), 0, 'BPED');
  assert.equal(entry('BPED').id, 'emerald_de');
  assert.equal(smaragd.fam, em.fam, 'Smaragd meets Emerald');
  for (const k of ['objectEvents', 'playerAvatar', 'fieldCamera', 'saveBlock1Ptr', 'main', 'paletteFade', 'lock', 'sprites', 'mapHeader', 'backupMap', 'tasks']) assert.equal(smaragd[k], em[k], `Smaragd ${k}: the English RAM`);
  assert.deepEqual(smaragd.inBattle, em.inBattle);
  assert.deepEqual([smaragd.overworldCb2, smaragd.graphicsInfo, smaragd.spritePalettes, smaragd.popup.task], [0x08085e79, 0x08517350, 0x0851d8f8, 0x080d44d9]);
  assert.deepEqual(smaragd.avatars, em.avatars);
  // the tracker's tables too: the same party, battle and save block addresses as the English game
  const [de, us] = [entry('BPED'), entry('BPEE')];
  for (const k of ['partyAddr', 'partyCountAddr', 'enemyPartyAddr', 'battleTypeFlagsAddr']) assert.equal(de[k], us[k], k);
  assert.deepEqual(de.liveBattleHp, us.liveBattleHp);
  // an unknown Emerald language (Spanish, French, Italian): still nothing
  assert.equal(W.worldTable(entry('BPES'), 0, 'BPES'), null);
});

test('the camera: SaveBlock1 pos plus the camera object’s sub-tile offset (walking right, left, standing)', () => {
  const still = emerald({ x: 10, y: 7 });
  const c = W.readCamera(still.t, still.mem.read);
  assert.deepEqual([c.tx, c.ty, c.cx, c.cy, c.map], [10, 7, 160, 112, 3]);
  // walking right: pos is the new tile from the first frame on, the offset counts up from it
  const right = emerald({ x: 11, ox: 5 });
  assert.equal(W.readCamera(right.t, right.mem.read).cx, 10 * 16 + 5);
  const left = emerald({ x: 9, ox: -5 });
  assert.equal(W.readCamera(left.t, left.mem.read).cx, 10 * 16 - 5);
  const down = emerald({ y: 8, oy: 15 });
  assert.equal(W.readCamera(down.t, down.mem.read).cy, 7 * 16 + 15);
  // garbage (an intro, another layout) gives nothing
  const bad = emerald({ ox: 40 });
  assert.equal(W.readCamera(bad.t, bad.mem.read), null);
  const none = memory();
  assert.equal(W.readCamera(still.t, none.read), null);
});

test('the player mid-step: the camera’s pixels while the object’s tile still lags a tile behind (no stall, no jump)', () => {
  // Emerald walking south from tile 5 to 6, as measured: SaveBlock1's pos says 6 from the step's first frame on, the
  // camera counts 1…15 px, the player object's currentCoords (from the RAM mirror) still say 5 for the first frames
  const ys = [];
  for (let k = 1; k <= 16; k++) {
    const oy = k % 16;
    const { t, mem } = emerald({ y: 6, oy, objY: k <= 6 ? 5 : 6, facing: W.DIR.S });
    ys.push(W.readPlayer(t, mem.read).y);
  }
  assert.deepEqual(ys, Array.from({ length: 16 }, (_, k) => 80 + k + 1), 'one pixel every frame');
  // a cutscene that moved the camera elsewhere (more than a tile away): the player's own tile
  const far = emerald({ x: 20, y: 6, objX: 10, objY: 6 });
  assert.equal(W.readPlayer(far.t, far.mem.read).x, 160);
});

test('the player: facing, avatar kind and gender from the graphics id, running', () => {
  const { t, mem } = emerald({ facing: W.DIR.W, gfx: 90, flags: 2 }); // May on the Mach Bike
  const p = W.readPlayer(t, mem.read);
  assert.deepEqual({ facing: p.facing, kind: p.kind, gender: p.gender, x: p.x, y: p.y, map: p.map }, { facing: 3, kind: 'mach', gender: 1, x: 160, y: 112, map: 3 });
  const run = emerald({ gfx: 0, flags: 0x81 });
  assert.equal(W.readPlayer(run.t, run.mem.read).run, true);
  const surf = emerald({ gfx: 2 });
  assert.equal(W.readPlayer(surf.t, surf.mem.read).kind, 'surf');
});

test('drawable: the overworld only – not in a battle, a menu or message, a full fade or another screen', () => {
  const ok = emerald();
  assert.equal(W.drawable(ok.t, W.readCamera(ok.t, ok.mem.read)), true);
  for (const o of [{ battle: 1 }, { locked: 1 }, { fade: 16 }, { cb2: 0x08123457 }]) {
    const g = emerald(o);
    assert.equal(W.drawable(g.t, W.readCamera(g.t, g.mem.read)), false, JSON.stringify(o));
  }
  // FR/LG's help screen (L/R) keeps the overworld callback and doesn't lock: its own flag
  const fr = W.worldTable(entry('BPRE'), 0);
  assert.equal(W.drawable(fr, { ...W.readCamera(ok.t, ok.mem.read), cb2: fr.overworldCb2, help: true }), false);
  assert.equal(W.drawable(fr, { ...W.readCamera(ok.t, ok.mem.read), cb2: fr.overworldCb2, help: false }), true);
  const half = emerald({ fade: 8 });
  const c = W.readCamera(half.t, half.mem.read);
  assert.equal(c.fade, 8);
  assert.equal(W.drawable(half.t, c), true, 'half faded: drawn, the overlay fades along');
});

test('an unknown revision learns its overworld callback from the camera stepping on one map', () => {
  const t = { ...W.worldTable(entry('BPEE'), 9) };
  const l = new W.OverworldLearner();
  const cam = (tx, cb2 = 0x08085e5d, extra = {}) => ({ map: 3, tx, ty: 4, cb2, fade: 0, battle: false, ...extra });
  l.feed(cam(1));
  l.feed(cam(5, 0x08000101, { fade: 4 })); // a warp: never counts
  l.feed(cam(6, 0x08000101, { map: 9 }));
  assert.equal(l.cb2, 0);
  for (let x = 10; x < 14; x++) l.feed(cam(x));
  assert.equal(l.cb2, 0x08085e5d);
  assert.equal(W.drawable(t, cam(1), l.cb2), true);
  assert.equal(W.drawable(t, cam(1, 0x0800aaab), l.cb2), false);
});

test('the wire: ~40 bytes, round trip, hidden, malformed input rejected', () => {
  const st = { fam: 2, map: 515, x: 149, y: 64, facing: 4, kind: 'acro', gender: 1, run: false, elev: 13 };
  const w = W.packState(st, 7, 1234.6);
  assert.ok(JSON.stringify(w).length <= 48, JSON.stringify(w));
  assert.deepEqual(W.unpackState(w), { seq: 7, t: 1235, fam: 2, map: 515, x: 149, y: 64, facing: 4, kind: 'acro', gender: 1, run: false, elev: 13, hidden: false });
  // an older sender has no elevation bits: the ground (the map's top layer covers it)
  assert.equal(W.unpackState([1, 1, 0, 2, 515, 0, 0, 4]).elev, 0);
  assert.equal(W.changed(st, { ...st, elev: 4 }), true);
  assert.equal(W.unpackState(W.packState({ ...st, kind: 'walk', run: true }, 8, 0)).run, true);
  assert.equal(W.unpackState(W.packState({ hidden: true, fam: 2 }, 9, 5)).hidden, true);
  for (const bad of [null, 'x', [], [2, 1, 1, 1, 1, 1, 1, 0], [1, 1, 1, 1, 1, 'a', 1, 0], [1, 1, 1, 1, 1, 1e9, 1, 0], [1, 1, 1, 1, -1, 1, 1, 0]]) assert.equal(W.unpackState(bad), null, JSON.stringify(bad));
  assert.equal(W.changed(st, { ...st }), false);
  assert.equal(W.changed(st, { ...st, x: 150 }), true);
  assert.equal(W.changed(st, null), true);
});

test('interpolation: smooth between messages, late and repeated ones dropped, a warp snaps, a stop never overshoots', () => {
  const tr = new W.Track();
  const at = (t, x, y = 0, extra = {}) => ({ seq: t, t, fam: 2, map: 1, x, y, facing: 4, kind: 'walk', gender: 0, run: false, hidden: false, ...extra });
  // messages every 66 ms from a peer whose clock is 5000 ms behind ours, ~30 ms on the way
  for (let i = 0; i <= 10; i++) tr.push(at(i * 66, i * 4), 5000 + i * 66 + 30);
  assert.equal(tr.push(at(5 * 66, 999), 9999), false, 'older seq dropped');
  const d = tr.delay;
  assert.ok(d >= 60 && d < 200, `delay ${d}`);
  const now = 5000 + 10 * 66 + 30;
  const s = tr.sample(now);
  // render time = now − offset − delay → between two messages, linear
  const rt = 10 * 66 - d;
  assert.ok(Math.abs(s.x - (rt / 66) * 4) < 0.01, `${s.x}`);
  assert.equal(s.moving, true);
  assert.ok(s.speed > 0.9 && s.speed < 1.1, `speed ${s.speed} px per frame`);
  // past the newest: keeps walking a little, but never past the tile it heads for
  const later = tr.sample(now + d + 100);
  assert.ok(later.x > 40 && later.x <= 48, `${later.x}`);
  assert.equal(tr.sample(now + d + 2000).x <= 48, true);
  // a warp (another map) snaps instead of sliding
  const w = new W.Track();
  w.push(at(0, 0), 100);
  w.push(at(66, 0, 0, { map: 2, x: 400 }), 166);
  const mid = w.sample(166 + w.delay - 33);
  assert.equal(mid.x, 0);
  assert.equal(w.sample(1000).x, 400);
  // a long jump on the same map (Fly, a scripted move) snaps too
  const j = new W.Track();
  j.push(at(0, 0), 100);
  j.push(at(66, 160), 166);
  assert.ok([0, 160].includes(j.sample(166 + j.delay - 33).x));
  assert.equal(new W.Track().sample(0), null);
});

test('where partners are drawn: relative to the camera, same map and family only, off-picture culled, faced tile', () => {
  const t = W.worldTable(entry('BPEE'), 0);
  const cam = { map: 515, cx: 160, cy: 64 };
  const p = { fam: 2, map: 515, x: 192, y: 64, hidden: false };
  assert.deepEqual(W.screenPos(t, cam, p), { x: t.anchor.x + 32, y: t.anchor.y });
  assert.equal(W.screenPos(t, cam, { ...p, map: 516 }), null);
  assert.equal(W.screenPos(t, cam, { ...p, fam: 1 }), null, 'Ruby’s maps aren’t Emerald’s');
  assert.equal(W.screenPos(t, cam, { ...p, x: 160 + 400 }), null);
  assert.equal(W.screenPos(t, cam, { ...p, hidden: true }), null);
  const local = { map: 515, tx: 10, ty: 4, facing: W.DIR.E };
  const partners = [{ slot: 'p2', state: { ...p, x: 11 * 16, y: 4 * 16 } }, { slot: 'p3', state: { ...p, x: 9 * 16, y: 4 * 16 } }];
  assert.equal(W.facedPartner(t, local, partners), 'p2');
  assert.equal(W.facedPartner(t, { ...local, facing: W.DIR.W }, partners), 'p3');
  assert.equal(W.facedPartner(t, { ...local, facing: W.DIR.N }, partners), null);
  assert.deepEqual(W.frontTile(3, 3, W.DIR.S), [3, 4]);
});

test('avatars across games: a kind the game lacks becomes the closest one; animations by speed', () => {
  const e = W.worldTable(entry('BPEE'), 0);
  const fr = W.worldTable(entry('BPRE'), 0);
  assert.equal(W.gfxFor(e, 'walk', 1), 89);
  assert.equal(W.gfxFor(fr, 'mach', 0), 1, 'FR/LG has one bike');
  assert.equal(W.gfxFor(fr, 'dive', 1), 9, 'nobody dives in Kanto: surfing');
  assert.equal(W.gfxFor(e, 'bike', 0), 1);
  assert.equal(W.kindFor(e, 'vsseeker'), 'walk');
  const st = { facing: W.DIR.N, moving: true, kind: 'walk', run: false };
  assert.equal(W.animFor({ ...st, moving: false }, 0), 1);
  assert.equal(W.animFor(st, 1), 5);
  assert.equal(W.animFor({ ...st, run: true }, 2), 21);
  assert.equal(W.animFor({ ...st, kind: 'mach' }, 2), 9);
  assert.equal(W.animFor({ ...st, kind: 'mach' }, 4), 17);
});

test('per-picture bytes: the WATCH ranges, read back in order, falling back to the memory', () => {
  const g = emerald({ x: 12, ox: 3 });
  const ranges = W.watchRanges(g.t, g.sb1, 0);
  assert.ok(ranges.reduce((n, r) => n + r[1], 0) <= 512);
  assert.ok(ranges.length <= 16);
  const bytes = new Uint8Array(ranges.reduce((n, r) => n + r[1], 0));
  let o = 0;
  for (const [a, l] of ranges) {
    bytes.set(g.mem.read(a, l) || new Uint8Array(l), o);
    o += l;
  }
  const r = W.rangeReader(ranges, bytes);
  assert.deepEqual([...r(g.sb1, 4)], [...g.mem.read(g.sb1, 4)]);
  assert.equal(r(0x02000000, 4), null);
  const chained = W.chainReaders(r, g.mem.read);
  assert.equal(W.readCamera(g.t, chained).cx, 11 * 16 + 3);
  assert.ok(W.readPlayer(g.t, chained));
});

// ---- sprites from a synthetic ROM -------------------------------------------------------------------------------------
function synthRom() {
  const rom = new Uint8Array(0x20000);
  const w32 = (o, v) => rom.set([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff], o);
  const w16 = (o, v) => rom.set([v & 0xff, (v >> 8) & 0xff], o);
  const A = (o) => 0x08000000 + o;
  // two 16×32 frames: frame 0 = colour 1 everywhere but the top 4 rows, frame 1 = colour 2
  const img = 0x1000;
  for (let f = 0; f < 2; f++) {
    for (let tIdx = 0; tIdx < 8; tIdx++) for (let i = 0; i < 32; i++) {
      const row = Math.floor(tIdx / 2) * 8 + (i >> 2);
      rom[img + f * 256 + tIdx * 32 + i] = row < 4 ? 0 : (f + 1) * 0x11;
    }
  }
  const images = 0x2000;
  for (let f = 0; f < 2; f++) { w32(images + f * 8, A(img + f * 256)); w16(images + f * 8 + 4, 256); }
  // anims: 24 lists → [frame 0 ×8, frame 1 ×8 flipped, END]
  const lists = 0x2100;
  const cmds = 0x2200;
  w32(cmds, (8 << 16) | 0); w32(cmds + 4, (8 << 16) | (1 << 22) | 1); w32(cmds + 8, 0xffff);
  for (let i = 0; i < 24; i++) w32(lists + i * 4, A(cmds));
  // graphics infos (8 of them, all the same) and the table, preceded by junk
  const info = 0x3000;
  for (let i = 0; i < 8; i++) {
    const o = info + i * 0x24;
    w16(o, 0xffff); w16(o + 2, 0x1100); w16(o + 8, 16); w16(o + 10, 32); w32(o + 0x18, A(lists)); w32(o + 0x1c, A(images));
  }
  const table = 0x4000;
  for (let i = 0; i < 64; i++) w32(table + i * 4, A(info + (i % 8) * 0x24));
  // the palette table: { ptr, tag, 0 } … with tag 0x1100 second
  const pal = 0x5000;
  w16(pal + 2, 0x001f); // colour 1: red
  w16(pal + 4, 0x03e0); // colour 2: green
  const ptab = 0x5100;
  w32(ptab, A(0x5080)); w16(ptab + 4, 0x1103);
  w32(ptab + 8, A(pal)); w16(ptab + 12, 0x1100);
  w32(ptab + 16, A(0x5080)); w16(ptab + 20, 0x11ff);
  return { rom, table: A(table), ptab: A(ptab) };
}

test('sprites from the ROM: the graphics table (given or searched), 4bpp frames, the palette, the animations', () => {
  const { rom, table, ptab } = synthRom();
  assert.equal(S.findGraphicsTable(rom, table), table);
  assert.equal(S.findGraphicsTable(rom, 0), table, 'searched when not given');
  assert.equal(S.findGraphicsTable(rom, 0x08000010), table, 'a wrong hint falls back to the search');
  const pal = S.findPalette(rom, 0x1100, ptab);
  assert.deepEqual([...pal.subarray(4, 8)], [255, 0, 0, 255]);
  assert.equal(pal[3], 0, 'colour 0 is transparent');
  assert.deepEqual([...S.findPalette(rom, 0x1100, 0).subarray(8, 12)], [0, 255, 0, 255], 'searched');
  const t = { graphicsInfo: table, spritePalettes: ptab };
  const a = S.gen3Avatar(rom, t, 0);
  assert.equal(a.w, 16);
  assert.equal(a.h, 32);
  assert.equal(a.frames.length, 2);
  assert.equal(a.frames[0][3], 0, 'top rows empty');
  assert.deepEqual([...a.frames[0].subarray((10 * 16 + 3) * 4, (10 * 16 + 3) * 4 + 4)], [255, 0, 0, 255]);
  assert.deepEqual([...a.frames[1].subarray((31 * 16 + 15) * 4, (31 * 16 + 15) * 4 + 4)], [0, 255, 0, 255]);
  assert.equal(a.anims.length, 24);
  assert.deepEqual(S.animFrame(a, 4, 3), { img: 0, dur: 8, flip: false });
  assert.deepEqual(S.animFrame(a, 4, 9), { img: 1, dur: 8, flip: true });
  assert.deepEqual(S.animFrame(a, 4, 16), { img: 0, dur: 8, flip: false }, 'loops');
  assert.equal(S.gen3Avatar(new Uint8Array(1024), t, 0), null);
  // the frame the game shows now (the local player's gSprites entry)
  const px = S.liveFrame(rom, { anims: 0x08002100, images: 0x08002000, animNum: 4, cmd: 1, w: 16, h: 32 }, pal);
  assert.deepEqual([...px.subarray((20 * 16) * 4, (20 * 16) * 4 + 4)], [0, 255, 0, 255]);
  assert.equal(S.liveFrame(rom, { anims: 0x0900_0000, images: 0x08002000, animNum: 0, cmd: 0, w: 16, h: 32 }, pal), null);
});

test('decode4bpp: low nibble first, 8×8 tiles row by row', () => {
  const rom = new Uint8Array(64);
  rom[0] = 0x21; // tile 0, row 0: pixel 0 = 1, pixel 1 = 2
  rom[32 + 4] = 0x30; // tile 1 (x 8–15), row 1: pixel 9 = 3
  const pal = new Uint8Array(64);
  for (let i = 1; i < 16; i++) pal.set([i, i, i, 255], i * 4);
  const px = S.decode4bpp(rom, 0, 16, 8, pal);
  assert.equal(px[0], 1);
  assert.equal(px[4], 2);
  assert.equal(px[(16 + 9) * 4], 3);
  assert.equal(px[(16 + 8) * 4 + 3], 0);
});

// ---- occlusion: the map's top layer (shared/worldmap.mjs) and the map-name popup -------------------------------------
/** The GBA BIOS's LZ77 for tests: literals only (valid for the decoder, just not small). */
function lz77Literal(bytes) {
  const out = [0x10, bytes.length & 0xff, (bytes.length >> 8) & 0xff, (bytes.length >> 16) & 0xff];
  for (let i = 0; i < bytes.length; i += 8) out.push(0, ...bytes.slice(i, i + 8));
  return out;
}

test('lz77: literals and back references (also overlapping ones), bad data gives null', () => {
  const abc = [0x10, 10, 0, 0, 0x10, 65, 66, 67, 0x30, 0x02, 88];
  assert.equal(String.fromCharCode(...M.lz77(Uint8Array.from(abc), 0)), 'ABCABCABCX');
  assert.equal(String.fromCharCode(...M.lz77(Uint8Array.from([0x10, 5, 0, 0, 0x40, 65, 0x10, 0x00]), 0)), 'AAAAA', 'disp 1 repeats');
  assert.equal(M.lz77(Uint8Array.from(abc), 0, 4).length, 4, 'capped at max');
  assert.deepEqual([...M.lz77(Uint8Array.from([7, 7, ...lz77Literal([1, 2, 3, 4, 5, 6, 7, 8, 9])]), 2)], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(M.lz77(Uint8Array.from([0x11, 4, 0, 0, 0, 1, 2, 3, 4]), 0), null, 'not LZ77');
  assert.equal(M.lz77(Uint8Array.from([0x10, 4, 0, 0, 0x80, 0x00, 0x05]), 0), null, 'a reference before the start');
  assert.equal(M.lz77(Uint8Array.from([0x10, 9, 0, 0, 0, 1, 2]), 0), null, 'runs past the end');
});

test('topLayerMask: opaque pixels of the four top tiles, flips, transparent tiles give null', () => {
  const tile = new Uint8Array(32);
  tile[0] = 0x01; // (0,0) opaque
  tile[7 * 4 + 3] = 0x20; // (7,7) opaque
  const tiles = { 5: tile };
  const at = (i) => tiles[i] || null;
  const m = M.topLayerMask([5, 0, 0, 0x400 | 0x800 | 5], at);
  assert.equal(m.length, 256);
  assert.equal(m[0], 1);
  assert.equal(m[7 * 16 + 7], 1);
  // the bottom-right quarter, flipped both ways: (0,0) → (7,7), (7,7) → (0,0) of that quarter
  assert.equal(m[15 * 16 + 15], 1);
  assert.equal(m[8 * 16 + 8], 1);
  assert.equal(m.reduce((a, b) => a + b, 0), 4);
  const h = M.topLayerMask([0, 0x400 | 5, 0, 0], at);
  assert.equal(h[0 * 16 + 15], 1, 'h-flip: (0,0) → (7,0)');
  assert.equal(h[7 * 16 + 8], 1);
  assert.equal(M.topLayerMask([0, 1, 2, 3], at), null);
});

/**
 * A ROM with one map layout: a primary and a secondary tileset (`family`'s format), metatiles 1–4 and secondary 0
 * (id = primary count): 1 NORMAL with an opaque top row, 2 COVERED (opaque – but under the sprites), 3 SPLIT with an
 * opaque left column, 4 NORMAL but transparent on top; the secondary's metatile draws a secondary tile fully opaque.
 */
function mapRom(family) {
  const fmt = M.TILESET_FORMATS[family];
  const rom = new Uint8Array(0x10000);
  const A = (o) => 0x08000000 + o;
  const w32 = (o, v) => rom.set([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff], o);
  const w16 = (o, v) => rom.set([v & 0xff, (v >> 8) & 0xff], o);
  const layout = 0x100;
  const prim = 0x200;
  const sec = 0x220;
  w32(layout, 20); w32(layout + 4, 15); w32(layout + 8, A(0x300)); w32(layout + 12, A(0x300));
  w32(layout + 0x10, A(prim)); w32(layout + 0x14, A(sec));
  // primary tiles (compressed): tile 1 = opaque top row, tile 2 = opaque everywhere, tile 3 = opaque left column
  const pt = new Uint8Array(4 * 32);
  pt.fill(0x11, 32, 36);
  pt.fill(0x11, 64, 96);
  for (let r = 0; r < 8; r++) pt[96 + r * 4] = 0x01;
  rom.set(lz77Literal([...pt]), 0x1000);
  const meta = (base, id, top) => top.forEach((e, q) => w16(base + id * 16 + 8 + q * 2, e));
  const attr = (base, id, layer) => (fmt.attrSize === 4 ? w32(base + id * 4, (layer << 29) | 0x5) : w16(base + id * 2, (layer << 12) | 0x5));
  const pm = 0x2000;
  const pa = 0x6000;
  meta(pm, 1, [1, 1, 0, 0]); attr(pa, 1, M.LAYER.NORMAL);
  meta(pm, 2, [2, 2, 2, 2]); attr(pa, 2, M.LAYER.COVERED);
  meta(pm, 3, [3, 0, 3, 0]); attr(pa, 3, M.LAYER.SPLIT);
  meta(pm, 4, [0, 0, 0, 0]); attr(pa, 4, M.LAYER.NORMAL);
  rom[prim] = 1; // compressed
  w32(prim + 4, A(0x1000)); w32(prim + 8, A(0x1800)); w32(prim + 0xc, A(pm)); w32(prim + fmt.attrAt, A(pa));
  if (fmt.attrAt === 0x14) w32(prim + 0x10, A(0x9001)); // FR/LG: the callback sits where Emerald has the attributes
  // the secondary (uncompressed): its tile 0 is VRAM tile `primaryTiles`, fully opaque
  const st = 0x8000;
  rom.fill(0x22, st, st + 32);
  const sm = 0xa000;
  const sa = 0xb000;
  meta(sm, 0, [fmt.primaryTiles, fmt.primaryTiles, fmt.primaryTiles, fmt.primaryTiles]); attr(sa, 0, M.LAYER.NORMAL);
  rom[sec + 1] = 1;
  w32(sec + 4, A(st)); w32(sec + 8, A(0x1800)); w32(sec + 0xc, A(sm)); w32(sec + fmt.attrAt, A(sa));
  return { rom, layout: A(layout), fmt };
}

test('mapTop: the top-layer masks from the ROM (Emerald/RS and FR/LG formats), lazily, NORMAL and SPLIT only', () => {
  for (const family of ['e', 'frlg']) {
    const { rom, layout, fmt } = mapRom(family);
    const top = M.mapTop(rom, family, layout);
    assert.ok(top, family);
    assert.deepEqual({ w: top.layout.width, h: top.layout.height }, { w: 20, h: 15 });
    const n = (m) => (m ? m.reduce((a, b) => a + b, 0) : 0);
    assert.equal(n(top.mask(1)), 16, `${family}: NORMAL, the top row of two tiles`);
    assert.equal(top.mask(1)[5], 1);
    assert.equal(top.mask(1)[16 + 5], 0);
    assert.equal(top.mask(2), null, `${family}: COVERED is drawn under the sprites`);
    assert.equal(n(top.mask(3)), 16, `${family}: SPLIT covers (its top tiles go to BG1 too)`);
    assert.equal(top.mask(3)[15 * 16], 1);
    assert.equal(top.mask(4), null, 'nothing opaque on top');
    assert.equal(n(top.mask(fmt.primaryMetatiles)), 256, `${family}: the secondary tileset's metatile and tile`);
    assert.equal(top.mask(1), top.mask(1), 'built once');
    assert.equal(top.mask(-1), null);
    assert.equal(top.mask(5000), null);
    // another layout of the same tilesets reuses the decoded ones
    const cache = new Map();
    M.mapTop(rom, family, layout, cache);
    assert.equal(cache.size, 2);
  }
  const { rom, layout } = mapRom('e');
  assert.equal(M.mapTop(rom, 'e', 0x08000004), null, 'no layout there');
  assert.equal(M.mapTop(rom, 'x', layout), null, 'unknown family');
  assert.equal(M.mapTop(null, 'e', layout), null);
  assert.equal(M.mapTop(rom, 'e', 0x09000000), null, 'outside the ROM');
});

test('coverMask: the hidden pixels of a sprite rectangle over the blocks it touches', () => {
  const full = new Uint8Array(256).fill(1);
  const row = new Uint8Array(256);
  row.fill(1, 15 * 16, 16 * 16); // the bottom row of a metatile
  const blocks = { '2,3': 1, '3,3': 2, '2,2': 9 };
  const blockAt = (mx, my) => blocks[`${mx},${my}`] ?? -1;
  const maskOf = (id) => (id === 1 ? full : id === 2 ? row : null);
  // a 16×32 sprite standing on (2,3): its feet in the covering block (2,3), its head in (2,2) (covers nothing)
  const m = M.coverMask({ x: 32, y: 32, w: 16, h: 32 }, blockAt, maskOf);
  assert.equal(m.length, 512);
  assert.equal(m.reduce((a, b) => a + b, 0), 256);
  assert.equal(m[15 * 16], 0);
  assert.equal(m[16 * 16], 1);
  // half a tile to the right: 8 columns over (2,3), 8 over (3,3)'s bottom row
  const h = M.coverMask({ x: 40, y: 32, w: 16, h: 32 }, blockAt, maskOf);
  assert.equal(h.reduce((a, b) => a + b, 0), 8 * 16 + 8);
  assert.equal(h[31 * 16 + 15], 1);
  assert.equal(h[30 * 16 + 15], 0);
  assert.equal(M.coverMask({ x: 100, y: 100, w: 16, h: 32 }, blockAt, maskOf), null, 'nothing over it');
  assert.equal(M.coverMask({ x: -8, y: -40, w: 16, h: 32 }, blockAt, maskOf), null, 'off the map');
  // a bridge: the overlay doesn't even ask (sprites at priority 1 are drawn above BG1)
  assert.equal(M.aboveTopLayer(0), false);
  assert.equal(M.aboveTopLayer(3), false);
  assert.equal(M.aboveTopLayer(4), true);
  assert.equal(M.aboveTopLayer(15), false);
});

test('the map in RAM: gMapHeader’s layout, gBackupMapLayout’s blocks with the 7-tile border', () => {
  const { t, mem } = emerald();
  assert.ok(t.mapHeader && t.backupMap && t.tasks);
  assert.equal(W.readMapView(t, mem.read), null, 'nothing there yet');
  mem.put(t.mapHeader, mem.u32(0x08427080));
  mem.put(t.backupMap, [...mem.u32(14 + 15), ...mem.u32(10 + 14), ...mem.u32(0x02032318)]);
  const v = W.readMapView(t, mem.read);
  assert.deepEqual(v, { layout: 0x08427080, w: 29, h: 24, map: 0x02032318 });
  // map (5, 8) is block (12, 15) of the backup: id in bits 0–9, collision and elevation above
  mem.put(0x02032318 + (15 * 29 + 12) * 2, mem.u16(0x3000 | 0x0400 | 0x2a1));
  const at = W.blockReader(v, mem.read);
  assert.equal(at(5, 8), 0x2a1);
  assert.equal(at(-7, -7), -1, 'not in the fake memory');
  assert.equal(at(-8, 0), -1, 'outside what the game holds');
  assert.equal(at(22, 0), -1);
  mem.put(t.backupMap, [...mem.u32(29), ...mem.u32(24), ...mem.u32(0x03000000)]);
  assert.equal(W.readMapView(t, mem.read), null, 'blocks not in EWRAM');
  mem.put(t.mapHeader, mem.u32(0x02000000));
  assert.equal(W.readMapView(t, mem.read), null, 'a layout not in the ROM');
  assert.equal(W.readMapView({ ...t, mapHeader: 0 }, mem.read), null, 'no address for this game');
});

test('the map-name popup: its rectangle while the game’s task runs, by the slide offset', () => {
  const { t, mem } = emerald();
  assert.equal(t.popup.task, 0x080d487d);
  const tasks = (slot, func, active, offset) => {
    mem.put(t.tasks, new Array(16 * 0x28).fill(0));
    const o = new Array(0x28).fill(0);
    o.splice(0, 4, ...mem.u32(func));
    o[4] = active;
    o.splice(8 + 4, 2, ...mem.u16(offset)); // data[2]
    mem.put(t.tasks + slot * 0x28, o);
  };
  assert.equal(W.popupRect(t, mem.read), null, 'no tasks readable');
  tasks(3, t.popup.task, 1, 0);
  assert.deepEqual(W.popupRect(t, mem.read), { x: 0, y: 0, w: 96, h: 40, shown: 40, grows: true }, 'all the way in');
  tasks(3, t.popup.task, 1, 30);
  const growing = W.popupRect(t, mem.read, { shown: 4, grows: true });
  assert.deepEqual(growing, { x: 0, y: 0, w: 96, h: 22, shown: 10, grows: true }, 'sliding in: 12 rows ahead');
  assert.equal(W.popupRect(t, mem.read, growing).h, 22, 'the same reading again: still growing');
  const shrinking = W.popupRect(t, mem.read, { shown: 20, grows: false });
  assert.equal(shrinking.h, 10, 'sliding out: as it is');
  assert.equal(W.popupRect(t, mem.read, shrinking).h, 10, 'the same reading again: still sliding out');
  tasks(3, t.popup.task, 0, 0);
  assert.equal(W.popupRect(t, mem.read), null, 'a finished task');
  tasks(5, 0x08123457, 1, 0);
  assert.equal(W.popupRect(t, mem.read), null, 'another task');
  // FR/LG slides the other way: tPos 0 → −24
  const fr = { ...W.worldTable(entry('BPRE'), 1), tasks: t.tasks };
  tasks(0, fr.popup.task, 1, -24);
  assert.deepEqual(W.popupRect(fr, mem.read, { shown: 24, grows: true }), { x: 0, y: 0, w: 192, h: 24, shown: 24, grows: true });
  assert.equal(W.popupRect({ ...t, popup: null }, mem.read), null);
});

test('the occlusion and popup tables: every game with a world table, per revision', () => {
  for (const [code, revs, help] of [['BPEE', [0], false], ['BPRE', [0, 1], true], ['BPGE', [0, 1], true], ['AXVE', [0, 1, 2], false], ['AXPE', [0, 1, 2], false], ['AXVD', [0, 1], false], ['AXPD', [0, 1], false], ['BPED', [0], false]]) {
    for (const rev of revs) {
      const t = W.worldTable(entry(code), rev);
      assert.ok(t.mapHeader >= 0x02000000 && t.mapHeader < 0x02040000, code);
      assert.ok(t.backupMap >= 0x03000000 && t.backupMap < 0x03008000, code);
      assert.ok(t.tasks >= 0x03000000 && t.tasks < 0x03008000, code);
      assert.ok(t.popup && t.popup.task & 1 && t.popup.task > 0x08000000, `${code} rev ${rev}: the popup task`);
      assert.equal(!!t.help, help, code);
      assert.ok(M.TILESET_FORMATS[t.family]);
    }
  }
  // an unknown revision: no popup (its task address is per revision), the map still from RAM
  const r9 = W.worldTable(entry('BPEE'), 9);
  assert.equal(r9.popup, null);
  assert.ok(r9.mapHeader);
});

// ---- the play view's half: what goes out, how often -----------------------------------------------------------------
test('SharedWorld: sends on change (≤ 15/s), a heartbeat when still, the relay only for partners without a direct link', async () => {
  const listeners = {};
  globalThis.addEventListener ??= (k, f) => (listeners[k] = f);
  globalThis.removeEventListener ??= () => {};
  globalThis.dispatchEvent ??= () => true;
  globalThis.CustomEvent ??= class { constructor(type, o) { this.type = type; this.detail = o?.detail; } };
  const { SharedWorld } = await import('../web/lib/sharedworld.mjs');
  const sent = [];
  let direct = new Set(['p2']);
  let worldIn = null;
  const sync = {
    others: ['p2', 'p3'],
    status: { partners: { p2: {}, p3: {} } },
    onWorld: (f) => ((worldIn = f), () => {}),
    sendWorld: (m, o = {}) => (sent.push({ m, relay: !!o.relay }), o.relay ? new Set() : direct),
  };
  let now = 0;
  const calls = [];
  const fakeWorld = { config: () => true, partner: (...a) => calls.push(['partner', ...a]), wave: (s) => calls.push(['wave', s]), gone: (s) => calls.push(['gone', s]) };
  const w = new SharedWorld({ sync, me: 'p1', frame: () => ({ contentWindow: { __world: fakeWorld } }), now: () => now });
  clearInterval(w.timer);
  const st = { fam: 2, map: 1, x: 0, y: 0, facing: 1, kind: 'walk', gender: 0, run: false };
  w._send(st);
  assert.equal(sent.filter((s) => !s.relay).length, 1);
  assert.equal(sent.filter((s) => s.relay).length, 1, 'p3 has no direct link: the relay too');
  for (let i = 1; i <= 30; i++) {
    now = i * 16.7; // 60 fps of changes for half a second
    w._send({ ...st, x: i });
  }
  const direct1 = sent.filter((s) => !s.relay).length;
  assert.ok(direct1 >= 7 && direct1 <= 9, `≤ 15 a second: ${direct1}`);
  assert.equal(sent.filter((s) => s.relay).length, 1, 'the relay at most every 2 s');
  now += 100;
  w._send({ ...st, x: 30 }); // (the last change goes out once the 66 ms are over)
  const before = sent.length;
  now += 500;
  w._send({ ...st, x: 30 });
  assert.equal(sent.length, before, 'nothing new, no heartbeat yet');
  now += 600;
  w._send({ ...st, x: 30 });
  assert.ok(sent.length > before, 'a heartbeat after a second');
  direct = new Set(['p2', 'p3']);
  now += 3000;
  const n = sent.filter((s) => s.relay).length;
  w._send({ ...st, x: 31 });
  assert.equal(sent.filter((s) => s.relay).length, n, 'everyone direct: no relay');
  assert.ok(w.stats.bytes / w.stats.sent < 80, 'small messages');
  // incoming: into the player page; a silent partner goes away
  worldIn({ from: 'p2', t: 'p', w: [1, 1, 0, 2, 1, 0, 0, 1] });
  worldIn({ from: 'p2', t: 'wave' });
  worldIn({ from: 'p1', t: 'wave' });
  assert.deepEqual(calls.map((c) => c[0]), ['partner', 'wave']);
  now += 6000;
  w._tick();
  assert.deepEqual(calls.at(-1), ['gone', 'p2']);
  w.stop();
});

test('SyncLink: presence goes over its own action to every partner peer; the relay only on request', async () => {
  const { SyncLink } = await import('../web/lib/sync.mjs');
  const s = new SyncLink({ room: 'r', secret: 's', slot: 'p1', slots: ['p1', 'p2', 'p3'], name: 'A', doc: { onLocalChange: () => () => {} } });
  const out = [];
  s.status.p2p = 'connected';
  s.peers.set('peerB', 'p2');
  s.peers.set('peerC', 'p3');
  s.peers.set('peerMe', 'p1');
  s.worldAct = { send: (m, o) => out.push([m, o.target]) };
  const relayed = [];
  s.sendMessage = (p) => relayed.push(p);
  const reached = s.sendWorld({ t: 'p', w: [1] });
  assert.deepEqual([...reached].sort(), ['p2', 'p3']);
  assert.deepEqual(out.map((x) => x[1]).sort(), ['peerB', 'peerC']);
  assert.equal(out[0][0].from, 'p1');
  assert.equal(relayed.length, 0);
  s.sendWorld({ t: 'wave' }, { relay: true });
  assert.equal(relayed[0].world.t, 'wave');
  const got = [];
  s.onWorld((m, via) => got.push([m.from, m.t, via]));
  s._worldIn({ from: 'p2', t: 'p' }, 'peerB');
  s._worldIn({ from: 'p1', t: 'p' }); // ourselves
  s._worldIn({ from: 'p9', t: 'p' }); // nobody of this run
  s._worldIn('junk');
  assert.deepEqual(got, [['p2', 'p', 'p2p']]);
  s.stopped = true;
});

test('the native player’s WATCH command: allowed with up to 16 ranges, nothing bigger', async () => {
  const { NCMD, checkNativeCommands } = await import('../server/lib/native.mjs');
  const cmd = (type, payload) => {
    const b = Buffer.alloc(8 + payload.length);
    b.writeUInt32LE(type, 0);
    b.writeUInt32LE(payload.length, 4);
    payload.copy(b, 8);
    return b;
  };
  const watch = (n) => {
    const p = Buffer.alloc(4 + n * 8);
    p.writeUInt32LE(n, 0);
    for (let i = 0; i < n; i++) (p.writeUInt32LE(0x02000000 + i * 16, 4 + i * 8), p.writeUInt32LE(8, 8 + i * 8));
    return cmd(NCMD.WATCH, p);
  };
  assert.ok(checkNativeCommands(watch(0)));
  assert.ok(checkNativeCommands(Buffer.concat([cmd(NCMD.INPUT, Buffer.alloc(17)), watch(16)])));
  assert.throws(() => checkNativeCommands(watch(17)));
});

test('APress: a tap of A between two pictures still opens the A menu (the fast player tells the button itself)', () => {
  const a = new W.APress();
  // down and up again before any picture was drawn: still a press, checked 110 ms later – once
  assert.equal(a.input(true, 1000), true);
  assert.equal(a.input(false, 1060), false);
  assert.equal(a.pending, true);
  assert.equal(a.due(1100, 110), false);
  assert.equal(a.due(1110, 110), true);
  assert.equal(a.due(1300, 110), false);
  // other buttons changing while A stays down are no new press; a second tap is
  assert.equal(a.input(true, 2000), true);
  assert.equal(a.input(true, 2030), false); // (A + a direction)
  assert.equal(a.input(false, 2050), false);
  assert.equal(a.input(true, 2100), true);
  assert.equal(a.due(2210, 110), true);
});

test('APress: the fast player ignores the game’s held keys – a stale picture with A held is no second press', () => {
  const a = new W.APress();
  a.input(true, 0);
  a.input(false, 50);
  assert.equal(a.due(200, 110), true);
  // (the picture drawn now still shows the A of before)
  assert.equal(a.sample(true, 210), false);
  assert.equal(a.pending, false);
});

test('APress: the A that chose in the menu doesn’t open it again; the next one does', () => {
  // a controller's A chose: it is still held when the menu closes
  const a = new W.APress();
  a.input(false, 0);
  a.swallow();
  assert.equal(a.input(true, 10), false); // (it reaches the game's buttons only now)
  assert.equal(a.input(false, 80), false);
  assert.equal(a.input(true, 300), true);
  // the keyboard chose (the key never reached the game): the next picture says A isn't held – the next press counts
  const k = new W.APress();
  k.input(false, 0);
  k.swallow();
  k.sample(false, 16);
  assert.equal(k.input(true, 500), true);
  // cancelled (a menu opened, the game took the button): nothing left to check
  k.cancel();
  assert.equal(k.due(9999, 110), false);
});

test('APress: the browser player – the press as the game’s held keys show it, picture by picture', () => {
  const a = new W.APress();
  assert.equal(a.sample(false, 0), false);
  assert.equal(a.sample(true, 16), true);
  assert.equal(a.sample(true, 33), false); // (held: one press)
  assert.equal(a.due(100, 110), false);
  assert.equal(a.due(126, 110), true);
  a.sample(false, 140);
  a.swallow();
  assert.equal(a.sample(true, 160), false); // (still the one that chose)
  a.sample(false, 180);
  assert.equal(a.sample(true, 200), true);
});
