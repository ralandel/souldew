// Pokémon Quetzal (English Alpha 9v1, checked in the running game): an Emerald hack that keeps Emerald's game code and
// tells itself apart by its header title only. What souldew reads from its ROM and RAM – its own 104-byte party struct
// (HP and status packed in front of an unencrypted data block), SaveBlock1's position 0x470 bytes behind the pointer,
// place names in several languages, item names in an array of their own, one species table where it keeps two – and
// what is off for it (link, raids, the randomizer). Synthetic data shaped like what was measured (numbers in comments);
// no ROM or save of the hack is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { isQuetzal, quetzalPk3, QUETZAL_PK3_SIZE } = await import('../shared/live/quetzal.mjs');
const { readLiveParty, readLiveBattle, findEntry, LiveTables, expandedEntry, parsePk3 } = await import('../shared/live/parse.mjs');
const { readLocation } = await import('../shared/live/location.mjs');
const { gen3Names } = await import('../shared/live/romloc.mjs');
const { gen3SpeciesNames, gen3ItemNames } = await import('../shared/live/romspecies.mjs');
const { matchHackHeader, matchCatalog } = await import('../shared/romid.mjs');
const { linkUnavailable } = await import('../shared/link.mjs');
const { raidSupport } = await import('../shared/live/raidhp.mjs');
const { cheatsFor, giftSupported } = await import('../shared/live/cheats.mjs');
const { worldTable } = await import('../shared/world.mjs');

const json = (f) => JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url), 'utf8'));
const addresses = json('addresses.json');
const catalog = json('catalog.json');
const cs3 = json('charset_gen3.json');
const code3 = Object.fromEntries(Object.entries(cs3.table).filter(([, v]) => v.length === 1).map(([k, v]) => [v, parseInt(k, 16)]));
const enc3 = (s) => [...s].map((c) => code3[c]);
const put32 = (b, o, v) => {
  for (let i = 0; i < 4; i++) b[o + i] = (v >>> (i * 8)) & 0xff;
};
const QUETZAL = { platform: 'gba', code: 'BPEE', title: 'PKM QUETZAL' };

test('recognised by its header title – never read as Emerald, and Emerald never as Quetzal', () => {
  assert.equal(findEntry(addresses, QUETZAL).id, 'quetzal_en');
  assert.equal(findEntry(addresses, { ...QUETZAL, title: 'pkm quetzal ' }).id, 'quetzal_en', 'case and padding');
  assert.equal(findEntry(addresses, { platform: 'gba', code: 'BPEE', title: 'POKEMON EMER' }).id, 'emerald_us');
  assert.equal(findEntry(addresses, { platform: 'gba', code: 'BPEE' }).id, 'emerald_us', 'without a title: the base game');
  assert.equal(findEntry(addresses, { platform: 'gba', code: 'BPRE', title: 'PKM QUETZAL' }).id, 'firered_us', 'the title alone isn\'t enough');
  assert.ok(isQuetzal({ system: 'gba', code: 'BPEE', title: 'PKM QUETZAL' }));
  assert.ok(isQuetzal({ platform: 'gba', code: 'bpee', title: 'PKM QUETZAL' }), 'a live bridge\'s HELLO');
  assert.ok(!isQuetzal({ system: 'gba', code: 'BPEE', title: 'POKEMON EMER' }));
  assert.ok(!isQuetzal({ system: 'nds', code: 'BPEE', title: 'PKM QUETZAL' }));
  assert.ok(!isQuetzal(null));
  // the library: every version by its header, the checked one by its checksum too
  const h = matchHackHeader({ system: 'gba', code: 'BPEE', title: 'PKM QUETZAL' }, catalog);
  assert.equal(h?.id, 'quetzal');
  assert.equal(matchHackHeader({ system: 'gba', code: 'BPEE', title: 'POKEMON EMER' }, catalog), null);
  assert.equal(matchHackHeader({ system: 'gba', code: 'BPRE', title: 'PKM QUETZAL' }, catalog), null, 'its code too');
  assert.ok(h.romCrc32.includes('E655684C'));
  assert.equal(h.uprCompatible, 'no');
  assert.equal(h.ownRandomizer, true);
  assert.equal(h.liveNote, 'quetzal');
  assert.equal(matchCatalog({ system: 'gba', code: 'BPEE', title: 'PKM QUETZAL' }, catalog).game.id, 'pokemon-emerald', 'its base game stays Emerald');
});

/** A Quetzal party struct as measured (104 bytes): see shared/live/quetzal.mjs. */
function qzPk3({ pid, otId, species, hp, maxHp, level, status = 0, item = 0, moves = [10, 39], exp = 140, egg = false, metLocation = 0x58, nick = 'AAAAAA' }) {
  const d = new Uint8Array(QUETZAL_PK3_SIZE);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint32(4, otId, true);
  d.fill(0xff, 8, 18);
  d.set(enc3(nick), 8);
  d[0x12] = 2;
  d[0x13] = egg ? 0x06 : 0x02;
  d.set([...enc3('AAAAAAA')], 0x14);
  d[0x1b] = 0xe0;
  // the packed field: HP low byte at 0x23, bits 8–9 in 0x24, bits 10–11 at the top of 0x22; the status 2 bits up
  d[0x21] = 0x01;
  d[0x22] = ((hp >> 10) & 3) << 6;
  d[0x23] = hp & 0xff;
  const st = ((status & 0xff) << 2) | ((hp >> 8) & 3);
  d[0x24] = st & 0xff;
  d[0x25] = st >> 8;
  d[0x26] = 0x80;
  dv.setUint16(0x28, species, true);
  dv.setUint16(0x2a, item, true);
  dv.setUint32(0x2c, exp, true);
  d[0x30] = 0xff; // PP Ups
  d[0x31] = 70;
  moves.forEach((m, i) => {
    dv.setUint16(0x34 + i * 2, m, true);
    d[0x3c + i] = 56;
  });
  d[0x4d] = metLocation;
  dv.setUint16(0x4e, 0x0180 | level, true);
  dv.setUint32(0x50, 0x3e2ff3e0, true); // IVs
  d[0x58] = level;
  d[0x59] = 0xff;
  dv.setUint16(0x5a, maxHp, true);
  [13, 11, 11, 9, 11].forEach((v, i) => dv.setUint16(0x5c + i * 2, v, true));
  return d;
}

test('the 104-byte party struct as the 100-byte layout: HP and status unpacked, the data block moved', () => {
  const T = new LiveTables({ charsetGen3: cs3 }).withSpecies({ engine: 'expanded', map: Object.assign([], { 1214: 906 }) }).withRom({ layout3: 'quetzal' });
  // the starter (Sprigatito, species 1214 in the game) – and the HP the party menu showed when the field was written
  for (const [hp, status] of [[19, 0], [7, 0], [0, 0], [261, 0], [517, 0], [1024, 0], [19, 2], [19, 0x08], [19, 0x10], [19, 0x40], [19, 0x80]]) {
    const raw = qzPk3({ pid: 0xb1, otId: 0x97585be6, species: 1214, hp, maxHp: 19, level: 5, status });
    const d = quetzalPk3(raw);
    assert.equal(d.length, 100);
    const m = parsePk3(d, T);
    assert.deepEqual([m.hp, m.status], [hp, status], `HP ${hp}, status ${status}`);
    assert.deepEqual([m.species, m.level, m.maxHp, m.metLocation, m.metLevel, m.nickname, m.isEgg], [906, 5, 19, 0x58, 5, 'AAAAAA', false]);
    assert.deepEqual(m.moves, [10, 39]);
  }
  // the bytes the game wrote in the party menu test: 0x22 = 0x40 → 1024, 0x24 = 0x08 → asleep (2 turns)
  const raw = qzPk3({ pid: 0xb1, otId: 0x97585be6, species: 1214, hp: 19, maxHp: 19, level: 5 });
  raw[0x22] = 0xc0;
  raw[0x23] = 0x04;
  raw[0x24] = 0x08;
  const m = parsePk3(quetzalPk3(raw), T);
  assert.deepEqual([m.hp, m.status], [3076, 2]);
  assert.ok(quetzalPk3(new Uint8Array(10)).every((b) => b === 0), 'a short read is no Pokémon');
});

test('the team, a catch\'s met place, held items by the game\'s names, a battle and a faint (the scan reader with the entry\'s addresses)', () => {
  const entry = expandedEntry(findEntry(addresses, QUETZAL), { gMain: 0x03002660, party3: { player: 0x02023a04, enemy: 0x02023554 } }, null);
  assert.equal(entry.scan3, true);
  assert.equal(entry.inBattle.addr, '0x3002a99', 'gMain + 0x439 – measured: 2 in battle, 0 outside');
  const items = { names: Object.assign([''], { 1: 'Poké Ball', 102: 'Rare Candy', 300: 'Gengarite' }) };
  const T = new LiveTables({ charsetGen3: cs3 }).withSpecies({ engine: 'expanded', map: Object.assign([], { 1214: 906, 16: 16, 7: 7 }) }, { items }).withRom({ layout3: 'quetzal' });
  const mem = new Map();
  const put = (a, bytes) => bytes.forEach((b, i) => mem.set(a + i, b));
  const read = (a, n) => Uint8Array.from({ length: n }, (_, i) => mem.get(a + i) ?? 0);
  const ME = 0x97585be6;
  const starter = qzPk3({ pid: 0xb1, otId: ME, species: 1214, hp: 19, maxHp: 19, level: 5, item: 300 });
  const pidgey = qzPk3({ pid: 0xeb, otId: ME, species: 16, hp: 16, maxHp: 16, level: 3, item: 102, moves: [33, 45], metLocation: 0x65, nick: 'Pidgey' });
  put(0x020235c9, [2]); // gPlayerPartyCount, 3 bytes in front of gPlayerParty
  put(0x020235cc, [...starter, ...pidgey]);
  const state = {};
  const r = readLiveParty(entry, read, T, state);
  assert.equal(state.party3, 0x020235cc, 'the entry\'s address – the ROM\'s own hint (600 bytes apart) is a retail-sized guess');
  assert.deepEqual(r.party.map((m) => [m.species, m.level, m.hp, m.maxHp, m.metLocation]), [[906, 5, 19, 19, 0x58], [16, 3, 16, 16, 0x65]]);
  assert.deepEqual(r.party.map((m) => m.itemName), ['Gengarite', 'Rare Candy'], 'as the summary screen names them');
  assert.equal(r.boxes, undefined, 'its PC isn\'t read');

  // the rival's Squirtle (L2, 13 HP) in gEnemyParty 0x4E0 bytes on; gBattleMons at 0x0202305C, 0x60 bytes a battler
  const squirtle = qzPk3({ pid: 0xe7, otId: 0x466ab708, species: 7, hp: 13, maxHp: 13, level: 2, moves: [55, 33, 39, 110], nick: 'Squirtle' });
  put(0x02023aac, [...squirtle]);
  const battler = (raw, species, hp, maxHp, level) => {
    const b = new Uint8Array(0x60);
    const dv = new DataView(b.buffer);
    dv.setUint16(0, species, true);
    dv.setUint16(0x2a, hp, true);
    b[0x2c] = level;
    dv.setUint16(0x2e, maxHp, true);
    b.set(raw.subarray(0, 4), 0x4c);
    b.set(raw.subarray(4, 8), 0x58);
    return b;
  };
  put(0x0202305c, [...battler(starter, 1214, 19, 19, 5), ...battler(squirtle, 7, 7, 13, 2)]);
  put(0x03002a99, [0x02]);
  const party = readLiveParty(entry, read, T, state).party;
  state.lastBmScan3 = 0;
  const b = readLiveBattle(entry, read, T, state, party);
  assert.deepEqual([b.kind, b.enemy.species, b.enemy.level, b.enemy.hp, b.enemy.maxHp], ['trainer', 7, 2, 7, 13]);
  assert.deepEqual([b.active.index, b.active.hp], [0, 19]);
  assert.equal(state.bmSize3, 0x60);
  // the starter goes down: the party struct says 0
  put(0x020235cc, [...qzPk3({ pid: 0xb1, otId: ME, species: 1214, hp: 0, maxHp: 19, level: 5 })]);
  assert.equal(readLiveParty(entry, read, T, state).party[0].hp, 0);
  put(0x03002a99, [0]);
  assert.equal(readLiveBattle(entry, read, T, state, party), null, 'over with the flag');
});

test('the place: SaveBlock1\'s position 0x470 bytes behind gSaveBlock1Ptr (0x030055BC), the ROM\'s map → section table', () => {
  const entry = expandedEntry(findEntry(addresses, QUETZAL), null, null);
  const names = Object.assign([], { 0x58: 'Pallet Town', 0x65: 'Route 1' });
  const rom = { gen: 3, family: 'rse', lang: 'en', names, maps3: { mapsec: { '37.57': 0x58, '37.76': 0x65, '37.120': 0x58 }, iwram: [0x03005640, 0x030055c0, 0x030055bc] } };
  const mem = new Map();
  const put = (a, bytes) => bytes.forEach((b, i) => mem.set(a + i, b));
  const read = (a, n) => Uint8Array.from({ length: n }, (_, i) => mem.get(a + i) ?? 0);
  put(0x030055bc, [0x98, 0x44, 0x02, 0x02]); // → 0x02024498
  put(0x030055c0, [0x00, 0x3e, 0x02, 0x02]); // SaveBlock2 (its first bytes are the name – not a map)
  put(0x02023e00, [0xbb, 0xbb, 0xbb, 0xbb, 0xbb, 0xbb, 0xbb, 0xff]);
  const state = {};
  // the title screen: nothing there yet – no place
  assert.equal(readLocation({}, entry, read, { rom, state }), null);
  put(0x02024498 + 0x470, [13, 0, 36, 0, 37, 76]); // Route 1, x 13, y 36
  const r = readLocation({}, entry, read, { rom, state });
  assert.deepEqual([r.id, r.map, r.romName], [0x65, '37.76', 'Route 1']);
  assert.equal(state.sb1PtrAddr, 0x030055bc);
  // (a fixed pointer's first bytes at +0 would be a map 0.0 at 0,0 – the base game's place, the wrong one)
  put(0x02024498 + 0x470, [6, 0, 8, 0, 37, 57]);
  assert.equal(readLocation({}, entry, read, { rom, state }).romName, 'Pallet Town');
});

test('the ROM: place names in several languages per section, one species table of two, item names in an array of their own', () => {
  const rom = new Uint8Array(0x60000);
  rom[3] = 0xea;
  rom[0xb2] = 0x96;
  const str = (at, s) => rom.set([...enc3(s), 0xff], at);
  // place names: { names → [English, Spanish, Spanish, short], x, y, w, h } – Littleroot "LITTLEROOT TOWN"/"VILLA RAÍZ"
  let o = 0x10000;
  const tab = 0x20000;
  for (let i = 0; i < 0xd5; i++) {
    const en = i === 0x58 ? 'PALLET TOWN' : i === 0x65 ? 'ROUTE 1' : `PLACE ${i}`;
    const s = o;
    str(s, en);
    str(s + 20, 'VILLA RAÍZ');
    o += 40;
    const g = o;
    put32(rom, g, 0x08000000 + s);
    put32(rom, g + 4, 0x08000000 + s + 20);
    o += 8;
    put32(rom, tab + i * 8, 0x08000000 + g);
    // the last section (Trainer Hill) has no position that reads as one
    rom.set(i === 0xd4 ? [0xbb, 0xd4, 0xbb, 0xc6] : [4, 9, 1, 1], tab + i * 8 + 4);
  }
  const g = gen3Names(rom, cs3, 'BPEE');
  assert.equal(g.layout, 'regionMapNameGroups');
  assert.equal(g.names.length, 0xd5);
  assert.deepEqual([g.names[0x58], g.names[0x65], g.names[0xd4]], ['Pallet Town', 'Route 1', 'Place 212']);

  // species: 13-byte names, a second copy right behind the first (Quetzal: 1,528 names twice) – one table
  const sp = new Uint8Array(0x20000);
  const names = ['??????????', 'Bulbasaur', 'Ivysaur', ...Array.from({ length: 420 }, (_, i) => `Mon${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`), 'Browt'];
  [...names, ...names].forEach((n, i) => sp.set([...enc3(n), 0xff], 0x100 + i * 13));
  const t = gen3SpeciesNames(sp, cs3);
  assert.equal(t.stride, 13);
  assert.equal(t.names.length, names.length, 'not the second copy\'s Pokémon');
  assert.equal(t.names.at(-1), 'Browt');

  // item names: 20 bytes each, zeros after the terminator, unused numbers all zeros, the next language's array behind
  const it = new Uint8Array(0x20000);
  const items = ['????????', 'Poké Ball', 'Great Ball', 'Ultra Ball', 'Master Ball', ...Array.from({ length: 97 }, (_, i) => `Item ${i}`), 'Rare Candy', ...Array.from({ length: 300 }, (_, i) => `Thing ${i}`)];
  items.forEach((n, i) => {
    if (i >= 150 && i < 160) return; // unused (Quetzal's TM51 …)
    it.set([...enc3(n), 0xff], 0x400 + i * 20);
  });
  const pt = 0x400 + (items.length + 5) * 20;
  ['????????', 'Pokébola', 'Grande Bola', ...Array.from({ length: 600 }, (_, i) => `Coisa ${i}`)].forEach((n, i) => it.set([...enc3(n), 0xff], pt + i * 20));
  const r = gen3ItemNames(it, cs3);
  assert.equal(r.offset, 0x400, 'the first (English) array, not the longer one behind it');
  assert.deepEqual([r.names[1], r.names[4], r.names[102], r.names[150]], ['Poké Ball', 'Master Ball', 'Rare Candy', '']);
  assert.equal(r.names.length, items.length);
});

test('off for Quetzal: link sessions, raids, cheats and gifts, Shared World – the base game\'s addresses would be wrong', () => {
  assert.equal(linkUnavailable({ system: 'gba', code: 'BPEE', title: 'PKM QUETZAL' }), 'hack', 'a run made before souldew knew the hack');
  assert.equal(linkUnavailable({ system: 'gba', code: 'BPEE', title: 'POKEMON EMER', hackId: 'quetzal' }), 'hack');
  assert.equal(linkUnavailable({ system: 'gba', code: 'BPEE', title: 'POKEMON EMER' }), null, 'Emerald links');
  assert.equal(linkUnavailable({ system: '3ds' }), 'system');
  const q = findEntry(addresses, QUETZAL);
  const x = expandedEntry(q, null, null);
  assert.deepEqual(raidSupport(x), { ok: false, why: 'hack' });
  assert.deepEqual(raidSupport(findEntry(addresses, { platform: 'gba', code: 'BPEE', title: 'POKEMON EMER' })), { ok: true });
  assert.deepEqual(cheatsFor(x), []);
  assert.equal(giftSupported(x), false);
  assert.equal(worldTable(q, 0, 'BPEE'), null);
});
