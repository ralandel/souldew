// Shared World on the DS (shared/worldds.mjs, docs/MULTIPLAYER.md › 9 "Gen 4"): the tables, the projection with the
// game's own matrices (recorded from the running games), which reading the picture was drawn with, the reads from RAM,
// the sprites' decoding from the ROM's formats (made here, no game data), the light, and the wire's height.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  dsWorldTable, dsPointers, dsWatchRanges, dsReadFrame, Displayed, project, billboard, dsPlayer, dsDrawable, dsMapKey,
  dsFacedPartner, parseBtx, btxTexture, btxSheet, findBtx, dsAvatarFrame, dsFollowerFrame, findFollowerTable,
  findIconPalettes, dsMonIcon, dsAvatarSheets, measureTint, DS_FAMILIES,
} from '../shared/worldds.mjs';
import { packState, unpackState, packExt, changed, Track, DIR, FAMILIES } from '../shared/world.mjs';

const addresses = JSON.parse(readFileSync(new URL('../shared/data/addresses.json', import.meta.url)));
const entry = (id) => addresses.games.find((g) => g.id === id);
const hexBytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));

// The two matrices (NNS_G3dGlb + 8, 0x74 bytes) and the player's MapObject grid + pos (+0x64, 0x18 bytes), read from
// the running games standing still (19 Nov 2026): Platinum in the Sandgem Pokémon Center 2F (the orthographic interior
// camera), HeartGold in New Bark Town in the evening (the perspective camera, a height of 16). Where the game drew the
// player's 32×32 sprite was found by matching the frame decoded from the ROM against the picture (error 2.7 / 3.0 per
// channel): its top-left at (112, 68) and (112, 69).
const SAMPLES = [
  {
    game: 'platinum_us',
    glb: '20000000000000000000000000000000000000002b00000000000000000000000000000000000000fbffffff000000000000000000000000f9ecffff001000000200000000100000000000000000000000000000450a0000440c000000000000bcf3ffff450a00000080f7ffc8fe04008f319aff',
    obj: '080000000000000006000000008008000000000000800600',
    sprite: [112, 68],
  },
  {
    game: 'heartgold_us',
    glb: '7c54000000000000000000000000000000000000a4700000000000000000000000000000000000006eebffff00f0ffff00000000000000004992eaff000000000200000000100000000000000000000000000000920a0000030c000000000000fdf3ffff920a0000008070fe4f4d5b017062a3fe',
    obj: '8f01000002000000cf01000000808f01000001000080cf01',
    sprite: [112, 69],
  },
];

/** A reader over a few byte ranges of a fake console (address → bytes). */
function ram(parts) {
  return (addr, len) => {
    for (const [a, b] of parts) if (addr >= a && addr + len <= a + b.length) return b.subarray(addr - a, addr - a + len);
    return null;
  };
}
const u32le = (...v) => {
  const b = new Uint8Array(v.length * 4);
  const d = new DataView(b.buffer);
  v.forEach((x, i) => d.setUint32(i * 4, x >>> 0, true));
  return b;
};
const s32at = (b, o) => new DataView(b.buffer, b.byteOffset).getInt32(o, true);

test('the tables: Platinum and HeartGold/SoulSilver have one, a family each; nothing for other games', () => {
  const pt = dsWorldTable(entry('platinum_us'));
  assert.equal(pt.fam, DS_FAMILIES.dppt);
  assert.equal(pt.fieldSystem, 0x021c07dc);
  assert.equal(pt.glb, 0x021c5a8c);
  assert.equal(pt.foot, 4);
  const hg = dsWorldTable(entry('heartgold_us'));
  const ss = dsWorldTable(entry('soulsilver_us'));
  assert.equal(hg.fam, DS_FAMILIES.hgss);
  assert.deepEqual(ss, { ...hg, id: 'soulsilver_us' });
  assert.equal(hg.followers, 'overworld');
  assert.equal(FAMILIES.dppt, DS_FAMILIES.dppt); // (the wire's family numbers)
  assert.equal(dsWorldTable(entry('emerald_us')), null);
  assert.equal(dsWorldTable(null), null);
  // every DS table watches at most 16 ranges and 512 bytes (the host's WATCH limits)
  const ptr = { fs: 0x02200000, pm: 0x02201000, pav: 0x02202000, loc: 0x02203000, mm: 0x02204000, obj: 0x02205000 };
  for (const t of [pt, hg]) {
    const r = dsWatchRanges(t, ptr);
    assert.ok(r.length <= 16);
    assert.ok(r.reduce((n, x) => n + x[1], 0) <= 512);
  }
});

test('the projection with the game\'s own matrices puts the player\'s sprite where the game drew it', () => {
  for (const s of SAMPLES) {
    const t = dsWorldTable(entry(s.game));
    const g = hexBytes(s.glb);
    const o = hexBytes(s.obj);
    const m = dsReadFrame(t, ram([[t.glb + 8, g], [t.system + 0x2c, new Uint8Array(16)]]), null);
    const pos = { x: s32at(o, 12) / 4096, y: s32at(o, 16) / 4096, z: s32at(o, 20) / 4096 };
    const bb = billboard(m, pos.x, pos.y, pos.z, 32, 32, t.foot);
    assert.deepEqual([Math.round(bb.x), Math.round(bb.y)], s.sprite, s.game);
    // the camera follows the player: their feet near the screen's middle
    const p = project(m, pos.x, pos.y, pos.z);
    assert.ok(Math.abs(p.x - 128) < 1 && Math.abs(p.y - 96) < 1, s.game);
  }
  // Platinum's interior camera is orthographic: one world unit is one pixel everywhere, a tile 16 px wide
  const pt = SAMPLES[0];
  const t = dsWorldTable(entry(pt.game));
  const m = dsReadFrame(t, ram([[t.glb + 8, hexBytes(pt.glb)], [t.system + 0x2c, new Uint8Array(16)]]), null);
  const a = project(m, 136, 0, 104);
  const b = project(m, 152, 0, 104);
  const c = project(m, 136, 0, 72);
  assert.ok(Math.abs(b.x - a.x - 16) < 1e-6 && Math.abs(a.s - 1) < 1e-3);
  // two tiles further back: 32 units × sin(the 50° pitch's complement, 0.7666) higher up, at the projection's
  // 96.75 px per half screen (a nurse behind the counter at (7,4) stands there)
  assert.ok(Math.abs((a.y - c.y) - 32 * 0.7666 * 1.0078) < 0.05);
  // HeartGold outdoors is perspective: further away is smaller
  const h = SAMPLES[1];
  const th = dsWorldTable(entry(h.game));
  const mh = dsReadFrame(th, ram([[th.glb + 8, hexBytes(h.glb)], [th.system + 0x2c, new Uint8Array(16)]]), null);
  const near = project(mh, 6392, 16, 7416);
  const far = project(mh, 6392, 16, 7416 - 160);
  assert.ok(far.s < near.s && far.y < near.y);
  assert.equal(project(null, 0, 0, 0), null);
});

test('the picture is drawn with the previous main-loop iteration\'s matrices (recorded frame counters and cameras)', () => {
  // Platinum walking east, frames 18–31 of a recording: [frameCounter, the camera's x translation]. The game ran late
  // at frame 23 (no new camera at 23, the iteration ended at 24); the picture moved 2 px every even frame all along.
  const pt = [[1, -126], [0, -124], [1, -124], [0, -122], [1, -122], [0, -122], [1, -120], [0, -118], [1, -118], [0, -116], [1, -116], [0, -114], [1, -114], [0, -112]];
  const d = new Displayed();
  const shown = pt.map(([fc, x]) => d.feed({ fc, C: [x] })?.C[0]);
  // (from frame 20 on: two frames per value, steadily, through the late iteration)
  assert.deepEqual(shown.slice(2), [-126, -126, -124, -124, -122, -122, -120, -120, -118, -118, -116, -116]);
  // HeartGold walking north, frames 145–163: a late iteration with frameCounter 2 at 159; the picture moved at 150,
  // 152, 154, 156, 158 and then 161 – not at 160
  const hg = [[0, 5522.3], [1, 5523.8], [0, 5523.8], [1, 5525.3], [0, 5525.3], [1, 5526.8], [0, 5526.8], [1, 5528.3], [0, 5528.3], [1, 5529.8], [0, 5529.8], [1, 5531.3], [0, 5531.3], [1, 5532.8], [2, 5532.8], [0, 5532.8], [1, 5532.8], [0, 5532.8], [1, 5532.8]];
  const e = new Displayed();
  const sh = hg.map(([fc, y]) => e.feed({ fc, C: [y] })?.C[0]);
  const moved = [];
  for (let i = 5; i < sh.length; i++) if (sh[i] !== sh[i - 1]) moved.push(145 + i);
  assert.deepEqual(moved, [150, 152, 154, 156, 158, 161]);
  e.reset();
  assert.equal(e.shown, null);
});

test('reading the field: the pointers, the player, the map key, when partners may be drawn', () => {
  const t = dsWorldTable(entry('platinum_us'));
  const FS = 0x02290000, PM = 0x02291000, PAV = 0x02292000, LOC = 0x02293000, MM = 0x02294000, OBJ = 0x02295000;
  const fs = new Uint8Array(0x80);
  fs.set(u32le(PM), 0);
  fs.set(u32le(LOC), t.off.location);
  fs.set(u32le(MM), t.off.mapMatrix);
  fs.set(u32le(PAV), t.off.playerAvatar);
  fs.set(u32le(1), t.off.running);
  const pav = new Uint8Array(0x40);
  pav.set(u32le(OBJ), t.avatar.mapObject);
  pav.set(u32le(1), t.avatar.state); // cycling
  pav.set(u32le(1), t.avatar.gender);
  const obj = new Uint8Array(0x128);
  obj.set(u32le(3), 0x28); // facing east
  obj.set(u32le(399, 2, 460), 0x64);
  obj.set(u32le(6392 * 4096, 16 * 4096, 7368 * 4096), 0x70);
  const parts = [[t.fieldSystem, u32le(FS)], [FS, fs], [PM, u32le(0x02299000, 0)], [PAV, pav], [OBJ, obj], [LOC, u32le(3)], [MM, Uint8Array.from([30, 30, 0, 0])],
    [t.glb + 8, new Uint8Array(0x74)], [t.system + 0x2c, u32le(100, 1, 0, 1)]];
  const read = ram(parts);
  const ptr = dsPointers(t, read);
  assert.deepEqual(ptr, { fs: FS, pm: PM, pav: PAV, loc: LOC, mm: MM, obj: OBJ, follow: 0 });
  const r = dsReadFrame(t, read, ptr);
  assert.equal(r.fc, 1);
  assert.equal(r.keys, 1); // A held
  const me = dsPlayer(t, r);
  assert.deepEqual(me, { map: 0x8000, x: 6392, y: 7368, h: 16, tx: 399, ty: 460, facing: DIR.E, kind: 'bike', gender: 1 });
  assert.equal(dsMapKey(r), 0x8000); // the overworld matrix: one key for all its maps
  assert.equal(dsMapKey({ ...r, matrix: [1, 1, 77] }), 3); // a house: its map header
  assert.equal(dsDrawable(r), true);
  assert.equal(dsDrawable({ ...r, task: 0x02280000 }), false); // a script / message / warp
  assert.equal(dsDrawable({ ...r, child: 0x02280000 }), false); // a menu screen, the bag, a battle
  assert.equal(dsDrawable({ ...r, running: 0 }), false);
  // another FieldSystem now (a new map, pointers not watched yet): no field reading
  assert.equal(dsReadFrame(t, read, { ...ptr, fs: FS + 4 }).field, false);
  // HeartGold/SoulSilver: the Pokémon the game walks behind you (FieldSystem.followMon) – species, form, shiny, where
  const th = dsWorldTable(entry('heartgold_us'));
  const FMO = 0x02296000;
  const fsh = new Uint8Array(0x100);
  fsh.set(u32le(PM), 0);
  fsh.set(u32le(LOC), th.off.location);
  fsh.set(u32le(MM), th.off.mapMatrix);
  fsh.set(u32le(PAV), th.off.playerAvatar);
  fsh.set(u32le(1), th.off.running);
  fsh.set(u32le(FMO), th.off.followMon);
  fsh.set(u32le(249), th.off.followMon + 0x10);
  fsh[th.off.followMon + 0x16] = 1; // active
  const fmo = new Uint8Array(0x128);
  fmo.set(u32le(1), 0x28);
  fmo.set(u32le(6392 * 4096, 16 * 4096, 7384 * 4096), 0x70);
  const pavh = new Uint8Array(0x40);
  pavh.set(u32le(OBJ), th.avatar.mapObject);
  const readh = ram([[th.fieldSystem, u32le(FS)], [FS, fsh], [PM, u32le(0x02299000, 0)], [PAV, pavh], [OBJ, obj], [LOC, u32le(3)], [MM, Uint8Array.from([30, 30, 0, 0])],
    [FMO, fmo], [th.glb + 8, new Uint8Array(0x74)], [th.system + 0x2c, u32le(100, 1, 0, 0)]]);
  const ph = dsPointers(th, readh);
  assert.equal(ph.follow, FMO);
  assert.deepEqual(dsReadFrame(th, readh, ph).follow, { species: 249, active: true, shiny: false, form: 0, facing: 1, x: 6392, y: 16, z: 7384 });
  assert.ok(dsWatchRanges(th, ph).reduce((n, x) => n + x[1], 0) <= 512);
  // no FieldSystem (the title screen)
  assert.equal(dsPointers(t, ram([[t.fieldSystem, u32le(0)]])), null);
});

test('the partner the player faces: one tile ahead, the same map key, about the same height', () => {
  const me = { map: 0x8000, x: 6392, y: 7368, h: 16, tx: 399, ty: 460, facing: DIR.E };
  const at = (tx, tz, h = 16, map = 0x8000) => ({ map, x: tx * 16 + 8, y: tz * 16 + 8, h });
  assert.equal(dsFacedPartner(me, [{ slot: 'p2', state: at(400, 460) }]), 'p2');
  assert.equal(dsFacedPartner(me, [{ slot: 'p2', state: at(401, 460) }]), null);
  assert.equal(dsFacedPartner(me, [{ slot: 'p2', state: at(400, 460, 48) }]), null); // on the bridge above
  assert.equal(dsFacedPartner(me, [{ slot: 'p2', state: at(400, 460, 16, 3) }]), null);
  assert.equal(dsFacedPartner({ ...me, facing: DIR.N }, [{ slot: 'p3', state: at(399, 459) }]), 'p3');
});

test('the wire carries the DS height; older messages and readers are unaffected', () => {
  const st = { fam: 21, map: 0x8000, x: 6392, y: 7368, h: 16, facing: DIR.E, kind: 'walk', gender: 0 };
  const w = packState(st, 5, 1000);
  assert.equal(w.length, 10);
  assert.equal(w[8], 0); // (no ext this time)
  assert.equal(w[9], 16);
  const back = unpackState(w);
  assert.equal(back.h, 16);
  assert.equal(back.ext, undefined);
  const withExt = packState(st, 6, 1100, packExt({ follower: { species: 25, shiny: false, form: 0 } }));
  assert.equal(unpackState(withExt).ext.follower.species, 25);
  assert.equal(unpackState(withExt).h, 16);
  // a GBA state has no height and stays 8 (or 9) long
  assert.equal(packState({ ...st, h: undefined }, 1, 1).length, 8);
  assert.equal(unpackState(packState({ ...st, h: undefined }, 1, 1)).h, undefined);
  assert.equal(packState({ hidden: true, fam: 21 }, 1, 1).length, 8);
  // a height out of range from the network is left out
  assert.equal(unpackState([...w.slice(0, 9), 1e9]).h, undefined);
  assert.equal(changed(st, { ...st, h: 32 }), true);
  // the track interpolates it
  const tr = new Track();
  tr.push(unpackState(packState({ ...st, h: 0 }, 1, 0)), 0);
  tr.push(unpackState(packState({ ...st, x: 6408, h: 16 }, 2, 100)), 100);
  const s = tr.sample(50 + tr.delay); // (halfway between the two)
  assert.ok(s.h > 0 && s.h < 16 && s.x > 6392 && s.x < 6408);
});

/** A BTX0 with 4-bit 8×8 textures named `name.1` … and one palette (transparent colour 0). */
function makeBtx(name, frames, colors) {
  const n = frames.length;
  const texBytes = 32 * n;
  const dictTex = 8 + 4 + n * 8 + n * 16;
  const dictPal = 8 + 4 + 4 + 16;
  const texInfo = 0x3c;
  const palInfo = texInfo + dictTex;
  const texData = palInfo + dictPal;
  const palData = texData + texBytes;
  const size = palData + 32;
  const T = 0x14; // (after the 16-byte header and the one block's offset)
  const b = new Uint8Array(T + size);
  const d = new DataView(b.buffer);
  b.set([0x42, 0x54, 0x58, 0x30], 0);
  d.setUint32(0x10, T, true);
  d.setUint16(0x0e, 1, true);
  b.set([0x54, 0x45, 0x58, 0x30], T);
  d.setUint16(T + 0x0e, texInfo, true);
  d.setUint32(T + 0x14, texData, true);
  d.setUint32(T + 0x34, palInfo, true);
  d.setUint32(T + 0x38, palData, true);
  // texture dictionary, in text order like the game's ('.10' before '.2')
  const order = frames.map((_, i) => i).sort((p, q) => String(p + 1).localeCompare(String(q + 1)));
  b[T + texInfo + 1] = n;
  d.setUint16(T + texInfo + 6, 8, true);
  const e = T + texInfo + 8;
  d.setUint16(e, 8, true);
  d.setUint16(e + 2, 4 + n * 8, true);
  order.forEach((fi, k) => {
    d.setUint32(e + 4 + k * 8, ((fi * 32) >> 3) | (0 << 20) | (0 << 23) | (3 << 26) | (1 << 29), true);
    const nm = `${name}.${fi + 1}`;
    for (let c = 0; c < nm.length; c++) b[e + 4 + n * 8 + k * 16 + c] = nm.charCodeAt(c);
  });
  b[T + palInfo + 1] = 1;
  d.setUint16(T + palInfo + 6, 8, true);
  const ep = T + palInfo + 8;
  d.setUint16(ep, 4, true);
  d.setUint16(ep + 2, 8, true);
  for (let c = 0; c < name.length; c++) b[ep + 8 + c] = name.charCodeAt(c);
  frames.forEach((ci, fi) => {
    for (let i = 0; i < 64; i++) {
      const v = ci(i);
      b[T + texData + fi * 32 + (i >> 1)] |= i & 1 ? v << 4 : v;
    }
  });
  colors.forEach((c, i) => d.setUint16(T + palData + i * 2, c, true));
  return b;
}

test('overworld sprites from a BTX0: textures in their frame order, the palette, colour 0 transparent', () => {
  // 11 frames: frame k has colour 1 in its first k+1 pixels (so '.10' sorted before '.2' must still come out as 10th)
  const frames = [...Array(11)].map((_, k) => (i) => (i <= k ? 1 : i === 63 ? 2 : 0));
  const b = makeBtx('pl_boy01c', frames, [0, 0x001f, 0x7c00]);
  const btx = parseBtx(b);
  assert.equal(btx.textures.length, 11);
  assert.equal(btx.textures[1].name, 'pl_boy01c.10');
  const sheet = btxSheet(b);
  assert.equal(sheet.name, 'pl_boy01c');
  assert.equal(sheet.frames.length, 11);
  assert.equal(sheet.w, 8);
  for (let k = 0; k < 11; k++) {
    const f = sheet.frames[k].rgba;
    let red = 0;
    for (let i = 0; i < 64; i++) if (f[i * 4] === 255 && f[i * 4 + 3] === 255) red++;
    assert.equal(red, k + 1, `frame ${k + 1}`);
    assert.equal(f[1 * 4 + 3], k >= 1 ? 255 : 0); // colour 0 is see-through
    assert.deepEqual([...f.subarray(63 * 4, 63 * 4 + 4)], [0, 0, 255, 255]); // colour 2: blue
  }
  assert.equal(sheet.top, 0);
  assert.equal(btxTexture(btx, { ...btx.textures[0], fmt: 7 }), null); // a direct-colour texture isn't a sprite
  assert.equal(parseBtx(new Uint8Array(64)), null);
  // found by the texture's name in a NARC's members – any language or randomized copy has the same names
  assert.equal(findBtx([new Uint8Array(8), makeBtx('hero', frames.slice(0, 2), [0, 1]), b], 'pl_boy01c'), 2);
  assert.equal(findBtx([b], 'heroine'), -1);
  const sheets = dsAvatarSheets([b, makeBtx('pl_girl01c', frames.slice(0, 4), [0, 1])], { walk: ['pl_boy01c', 'pl_girl01c'], surf: ['pl_swimhiro', 'pl_swimhiroine'] });
  assert.equal(sheets.walk[1].frames.length, 4);
  assert.deepEqual(sheets.surf, [null, null]);
});

test('which frame shows: four per direction walking, the running half, one per direction surfing; followers two', () => {
  const sheet = (n) => ({ frames: Array(n).fill({}) });
  assert.equal(dsAvatarFrame(sheet(32), DIR.N, false, 0), 0);
  assert.equal(dsAvatarFrame(sheet(32), DIR.S, false, 0), 4);
  assert.equal(dsAvatarFrame(sheet(32), DIR.W, true, 8, 1), 9); // a step
  assert.equal(dsAvatarFrame(sheet(32), DIR.E, true, 24, 1), 15);
  assert.equal(dsAvatarFrame(sheet(32), DIR.E, true, 8, 2), 29); // running
  assert.equal(dsAvatarFrame(sheet(24), DIR.S, true, 8, 2, 'bike'), 5); // no running half on a bike
  assert.equal(dsAvatarFrame(sheet(4), DIR.W, true, 8, 1, 'surf'), 2);
  assert.equal(dsFollowerFrame(sheet(8), DIR.E, true, 8), 7);
  assert.equal(dsFollowerFrame(sheet(8), DIR.S, false, 8), 2);
});

test('HeartGold\'s follower table and the icons\' palette table are found in ARM9 by their shape', () => {
  const arm9 = new Uint8Array(4096);
  const lut = [0, 0, 1, 2, 4];
  for (let i = 5; i < 494; i++) lut.push(lut[i - 1] + (i === 202 ? 28 : 1));
  const at = 1000;
  lut.forEach((v, i) => (arm9[at + i * 2] = v & 255, arm9[at + i * 2 + 1] = v >> 8));
  assert.equal(findFollowerTable(arm9), at);
  arm9[at + 300] = 0; // broken: not counting up any more
  arm9[at + 301] = 0;
  assert.equal(findFollowerTable(arm9), -1);
  const pals = new Uint8Array(2000);
  pals.set([2, 1, 1, 1, 0, 0, 0, 0, 2, 2, 1, 1, 0, 1, 2, 2, 0, 0, 0, 2, 1, 0, 0, 2, 2, 2, 0, 2, 2, 2, 2], 700);
  assert.equal(findIconPalettes(pals), 700);
  assert.equal(findIconPalettes(new Uint8Array(100)), -1);
});

test('a party icon from the icon NARC: two 32×32 frames from 8×8 tiles, the palette by species', () => {
  const nclr = new Uint8Array(0x18 + 0x18 + 3 * 32);
  const nd = new DataView(nclr.buffer);
  nclr.set([0x52, 0x4c, 0x43, 0x4e], 0); // 'RLCN', as the file has it
  nd.setUint16(0x0c, 0x10, true);
  nd.setUint16(0x10 + 0x18 + 2 * 32 + 2, 0x03e0, true); // palette 2, colour 1: green
  const ncgr = () => {
    const g = new Uint8Array(0x30 + 1024);
    const d = new DataView(g.buffer);
    g.set([0x52, 0x47, 0x43, 0x4e], 0); // 'RGCN'
    d.setUint16(0x0c, 0x10, true);
    // frame 1, tile 5 (row 1, column 1): its first pixel colour 1 → (8, 8); frame 2, tile 0: (1, 0)
    g[0x30 + 5 * 32] = 0x01;
    g[0x30 + 16 * 32] = 0x10;
    return g;
  };
  const files = [nclr, new Uint8Array(8), ncgr(), ncgr()];
  const pals = new Uint8Array(494);
  pals[1] = 2;
  const ic = dsMonIcon(files, pals, 1);
  assert.deepEqual([...ic.frames[0].subarray((8 * 32 + 8) * 4, (8 * 32 + 8) * 4 + 4)], [0, 255, 0, 255]);
  assert.equal(ic.frames[1][(0 * 32 + 1) * 4 + 3], 255);
  assert.deepEqual([ic.top, ic.left, ic.bottom, ic.right], [0, 1, 8, 8]);
  assert.equal(dsMonIcon(files, pals, 0), null);
  assert.equal(dsMonIcon(files, pals, 600), null);
});

test('the field\'s light, measured off the player\'s own sprite (a blue evening in HeartGold)', () => {
  const w = 256;
  const frame = { w: 4, h: 20, rgba: new Uint8ClampedArray(4 * 20 * 4) };
  for (let i = 0; i < 80; i++) frame.rgba.set([200, 160, 120, 255], i * 4);
  const pic = { w, h: 384, fmt: 0, px: new Uint8Array(w * 384 * 4) };
  // BGRA picture: the sprite at (10, 20) lit (0.6, 0.6, 0.9)
  for (let y = 0; y < 20; y++) for (let x = 0; x < 4; x++) pic.px.set([108, 96, 120, 255], ((20 + y) * w + 10 + x) * 4);
  const r = measureTint(pic, frame, 10, 20);
  assert.deepEqual(r.tint.map((v) => Math.round(v * 100) / 100), [0.6, 0.6, 0.9]);
  assert.ok(r.err < 1);
  // something in front of the player: the fit is bad and isn't used
  for (let y = 0; y < 10; y++) for (let x = 0; x < 4; x++) pic.px.set([0, 255, 0, 255], ((20 + y) * w + 10 + x) * 4);
  assert.ok(measureTint(pic, frame, 10, 20).err > 10);
  // …unless the depth says which pixels are the player's own (a follower stands in front of the upper half)
  const own = measureTint(pic, frame, 10, 20, (sx, sy) => sy >= 30);
  assert.ok(own.err < 1 && Math.abs(own.tint[2] - 0.9) < 0.01);
  assert.equal(measureTint(pic, frame, 300, 20), null); // off the screen
});

test('the map in front: the DS depth of a world point, the host\'s DEPTH message, the mask, the rectangles asked for', async () => {
  const { depthAt, parseDepth, depthMask, depthRects, depthPixel } = await import('../shared/worldds.mjs');
  const s = SAMPLES[0];
  const t = dsWorldTable(entry(s.game));
  const m = dsReadFrame(t, ram([[t.glb + 8, hexBytes(s.glb)], [t.system + 0x2c, new Uint8Array(16)]]), null);
  // Platinum's interior camera (Z-buffered): the player's own billboard was in the depth buffer at 0xDA9E00 – its spot
  // moved 8 units toward the camera (the table's billboardDepth); the spot itself is further away (larger)
  assert.ok(Math.abs(depthAt(m, 136, 0, 104, { toward: t.toward }) - 0xda9e00) < 0x400);
  assert.ok(depthAt(m, 136, 0, 104) > depthAt(m, 136, 0, 104, { toward: 8 }));
  assert.ok(depthAt(m, 136, 0, 88) > depthAt(m, 136, 0, 104)); // a tile further back: deeper
  assert.equal(depthAt(null, 0, 0, 0), null);
  // the message: frame, flags, then each rectangle with where it is
  const msg = new Uint8Array(8 + 8 + 2 * 2 * 4);
  const v = new DataView(msg.buffer);
  v.setUint32(0, 77, true);
  v.setInt32(4, 1, true);
  v.setInt16(8, 10, true);
  v.setInt16(10, 20, true);
  v.setUint16(12, 2, true);
  v.setUint16(14, 2, true);
  [500, 900, 500, 900].forEach((d, i) => v.setUint32(16 + i * 4, d, true));
  const d = parseDepth(msg);
  assert.deepEqual([d.frame, d.wbuffer, d.rects.length, d.rects[0].x, d.rects[0].y], [77, false, 1, 10, 20]);
  assert.equal(depthPixel(d, 11, 20), 900);
  assert.equal(depthPixel(d, 12, 20), -1);
  assert.equal(parseDepth(msg.slice(0, 8).fill(0)), null); // flags 0: nothing kept
  // a sprite whose box covers those pixels: hidden where the map is nearer (500 < 700), not where it's further
  const mask = depthMask(d, { x: 10, y: 20, w: 3, h: 2 }, Infinity, 700);
  assert.deepEqual([...mask], [1, 0, 0, 1, 0, 0]);
  assert.deepEqual([...depthMask(d, { x: 10, y: 20, w: 2, h: 2 }, 21, 700)], [1, 0, 0, 0]); // (rows from footY on: left alone)
  assert.equal(depthMask(d, { x: 100, y: 100, w: 2, h: 2 }, Infinity, 700), null); // no depth there
  assert.equal(depthMask(null, { x: 0, y: 0, w: 1, h: 1 }, Infinity, 1), null);
  // the rectangles: around what's drawn, on an 8-pixel grid, merged, clipped, at most 8 and 16384 pixels
  const r = depthRects([{ x: 100, y: 50, w: 32, h: 32 }, { x: 110, y: 60, w: 32, h: 32 }, { x: -20, y: 180, w: 32, h: 32 }]);
  assert.equal(r.length, 2);
  for (const [x, y, w, h] of r) assert.ok(x >= 0 && y >= 0 && x + w <= 256 && y + h <= 192 && !(x % 8) && !(y % 8));
  assert.ok(r.reduce((n, [, , w, h]) => n + w * h, 0) <= 16384);
  assert.ok(depthRects(Array.from({ length: 20 }, (_, i) => ({ x: (i % 5) * 50, y: Math.floor(i / 5) * 48, w: 8, h: 8 }))).length <= 8);
});

test('one overlay per page: a config() while the first start still loads waits for it (the HGSS "away" flicker)', async () => {
  // Captured 19 Nov 2026 (world-e2e --plus, HeartGold, 2 of 5 runs failed): the play view configures the overlay again
  // when its players, rules or lead change; the DS start fetches and decodes the ROM for seconds, so a second start ran
  // alongside – two overlays per page (counted: [2, 2]). They took turns at the native player's one WATCH list; the one
  // left without bytes kept its first reading (field: false) and kept sending "hidden" between the other's states, so
  // the partner flickered away and the A menu found nobody. With startOnce: one start, one overlay (counted: [1, 1]).
  const { startOnce } = await import('../shared/world.mjs');
  let starts = 0;
  const begin = startOnce(async (cfg) => {
    starts++;
    await new Promise((r) => setTimeout(r, 20));
    return { cfg };
  });
  const [a, b] = await Promise.all([begin({ n: 1 }), begin({ n: 2 })]);
  assert.equal(starts, 1);
  assert.equal(a, b);
  assert.deepEqual(a.cfg, { n: 1 });
  assert.equal(await begin({ n: 3 }), a); // (later calls too)
  assert.equal(starts, 1);
});
