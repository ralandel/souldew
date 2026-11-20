// Location data read from the ROM itself (shared/live/romloc.mjs) and its use by readLocation (ctx.rom).
// Synthetic files check the formats; real ROMs – when present – check the result against the tables:
//   SOULDEW_TEST_ROMS=/folder/with/roms node --test test/romloc.test.mjs
// (any .gb/.gbc/.gba/.nds in the folder; never commit ROMs). Without the variable those tests are skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gen4Messages, gen5Messages, gen4MapLocations, gen5ZoneLocations, gen3Names, romLocations, prettyName, langOfCode, gen1MapHeaders, gen2MapHeaders, gbMapHeaders, gen3MapHeaders } from '../shared/live/romloc.mjs';
import { readLocation, canReadLocation } from '../shared/live/location.mjs';
import { blzDecompress } from '../shared/nds.mjs';
import { romCrc } from '../server/lib/romloc.mjs';

const json = (f) => JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url), 'utf8'));
const maps = json('maps.json');
const gen4 = json('gen4.json');
const cs3 = json('charset_gen3.json');
const loc3 = json('locations_gen3.json');
const opts = { gen3Charset: cs3, gen4Chars: gen4.chars };

const put16 = (b, o, v) => { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; };
const put32 = (b, o, v) => { put16(b, o, v & 0xffff); put16(b, o + 2, (v >>> 16) & 0xffff); };
function bus(cells) {
  const mem = new Map();
  for (const [a, bytes] of Object.entries(cells)) bytes.forEach((b, i) => mem.set(Number(a) + i, b));
  return (addr, len) => Uint8Array.from({ length: len }, (_, i) => mem.get(addr + i) ?? 0);
}
const le16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const le32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

// the Gen 4 code of a character (inverse of gen4.json chars)
const code4 = Object.fromEntries(Object.entries(gen4.chars).map(([k, v]) => [v, Number(k)]));

/** Builds an encrypted Gen 4 message file (the inverse of gen4Messages). */
function gen4File(strings, seed = 0x1234) {
  const enc = strings.map((s) => [...[...s].map((c) => code4[c]), 0xffff]);
  const head = 4 + strings.length * 8;
  const size = head + enc.reduce((n, e) => n + e.length * 2, 0);
  const b = new Uint8Array(size);
  put16(b, 0, strings.length);
  put16(b, 2, seed);
  let off = head;
  enc.forEach((e, i) => {
    const k = (((seed * 0x2fd) & 0xffff) * (i + 1)) & 0xffff;
    const k32 = (k | (k << 16)) >>> 0;
    put32(b, 4 + i * 8, (off ^ k32) >>> 0);
    put32(b, 8 + i * 8, (e.length ^ k32) >>> 0);
    let ck = (0x91bd3 * (i + 1)) & 0xffff;
    e.forEach((c, j) => {
      put16(b, off + j * 2, c ^ ck);
      ck = (ck + 0x493d) & 0xffff;
    });
    off += e.length * 2;
  });
  return b;
}

/** Builds a Gen 5 message file (one section; the inverse of gen5Messages). */
function gen5File(strings) {
  const enc = strings.map((s) => [...[...s].map((c) => c.charCodeAt(0)), 0xffff]);
  const secOff = 16;
  const table = 4 + strings.length * 8;
  const size = secOff + table + enc.reduce((n, e) => n + e.length * 2, 0);
  const b = new Uint8Array(size);
  put16(b, 0, 1);
  put16(b, 2, strings.length);
  put32(b, 12, secOff);
  put32(b, secOff, size - secOff);
  let off = table;
  enc.forEach((e, i) => {
    put32(b, secOff + 4 + i * 8, off);
    put16(b, secOff + 8 + i * 8, e.length);
    // encrypted backwards from any start key: the terminator then encrypts to 0xFFFF ^ key, which is how
    // gen5Messages finds the key again
    let k = 0x7a3c;
    for (let j = e.length - 1; j >= 0; j--) {
      put16(b, secOff + off + j * 2, e[j] ^ k);
      k = ((k >> 3) | (k << 13)) & 0xffff;
    }
    off += e.length * 2;
  });
  return b;
}

test('Gen 4 message files decrypt (location names)', () => {
  const names = ['Mystery Zone', 'New Bark Town', 'Route 29', 'Cherrygrove City'];
  assert.deepEqual(gen4Messages(gen4File(names), gen4.chars), names);
});

test('Gen 5 message files decrypt; names built from variables are left out', () => {
  const names = ['', 'Mystery Zone', 'Nuvema Town', 'Route 1', 'Café Sonata'];
  assert.deepEqual(gen5Messages(gen5File(names)), names);
  const f = gen5File(['A', 'B']);
  assert.deepEqual(gen5Messages(f.subarray(0, 8)), [], 'a cut-off file gives nothing, not garbage');
});

test('Gen 4 map header table is found by its shape (music ids), name index at +0x12', () => {
  const arm9 = new Uint8Array(0x8000).fill(0x55);
  const T = 0x1004;
  const want = [];
  for (let i = 0; i < 150; i++) {
    const o = T + i * 24;
    arm9.fill(0, o, o + 24);
    put16(arm9, o + 12, 1000 + (i % 40)); // HGSS: music at u16 6 and 7
    put16(arm9, o + 14, 1000 + (i % 40));
    arm9[o + 0x12] = i % 90;
    want.push(i % 90);
  }
  const r = gen4MapLocations(arm9);
  assert.equal(r.offset, T);
  assert.deepEqual(r.map, want);
  assert.equal(gen4MapLocations(new Uint8Array(0x4000)), null, 'no table, no guess');
});

test('Gen 5 zone headers → name index at +0x1A', () => {
  const z = new Uint8Array(48 * 60);
  for (let i = 0; i < 60; i++) z[i * 48 + 0x1a] = i + 3;
  assert.deepEqual(gen5ZoneLocations(z).slice(0, 3), [3, 4, 5]);
  assert.equal(gen5ZoneLocations(z.subarray(0, 100)), null);
});

test('Gen 3 region map table: names by section, all-caps names prettified', () => {
  const rom = new Uint8Array(0x4000);
  rom[0xb2] = 0x96;
  const enc = (s) => [...s].map((c) => parseInt(Object.entries(cs3.table).find(([, v]) => v === c)[0], 16));
  let str = 0x2000;
  for (let i = 0; i < 70; i++) {
    const o = 0x400 + i * 8;
    rom.set([i % 28, i % 20, 1, 1], o);
    put32(rom, o + 4, 0x08000000 + str);
    const bytes = [...enc(i === 0 ? 'LITTLEROOT' : `ROUTE ${100 + i}`), 0xfc, 0x00, 0x00, ...(i === 0 ? enc('TOWN') : []), 0xff];
    rom.set(bytes, str);
    str += bytes.length;
  }
  const g = gen3Names(rom, cs3);
  assert.equal(g.offset, 0x400);
  assert.equal(g.names[0], 'Littleroot Town');
  assert.equal(g.names[5], 'Route 105');
  assert.equal(prettyName('MT. PYRE'), 'Mt. Pyre');
  assert.equal(prettyName('S.S. TIDAL'), 'S.S. Tidal');
  assert.equal(prettyName('Route 1'), 'Route 1');
  assert.equal(langOfCode('IPKD'), 'de');
  assert.equal(langOfCode('IREO'), 'en');
});

test('Gen 3 FireRed/LeafGreen names: the place-name table, not the longer Fame Checker one (German ROMs, #16)', () => {
  const rom = new Uint8Array(0x8000);
  rom[0xb2] = 0x96;
  rom.set([...'BPRD'].map((c) => c.charCodeAt(0)), 0xac);
  const enc = (t) => [...t].map((c) => parseInt(Object.entries(cs3.table).find(([, v]) => v === c)[0], 16));
  let str = 0x4000;
  const ptr = (t) => {
    const at = str;
    const bytes = [...enc(t), 0xff];
    rom.set(bytes, at);
    str += bytes.length;
    return 0x08000000 + at;
  };
  // the German Fame Checker: places and people, many of them twice – 120 entries, longer than the place names
  const fame = ['ALABASTIA', 'POKéMON-LABOR', 'POKéMON-LABOR', 'VERTANIA CITY', 'ARENA MARMORIA', 'ARENA MARMORIA', 'PROF. EICH', 'SCHILD'];
  for (let i = 0; i < 120; i++) put32(rom, 0x400 + i * 4, ptr(fame[i % fame.length]));
  // the place names by section from 0x58: 80 of them, one with a lower-case letter in it
  const places = Array.from({ length: 80 }, (_, i) => (i === 0 ? 'ALABASTIA' : i === 13 ? 'ROUTE 1' : i === 43 ? 'DIGDAs HÖHLE' : i === 47 ? 'POKéMON-HAUS' : `ORT ${i}`));
  places.forEach((t, i) => put32(rom, 0x1000 + i * 4, ptr(t)));
  const g = gen3Names(rom, cs3);
  assert.equal(g.layout, 'mapNamePointers');
  assert.equal(g.offset, 0x1000, 'the table with the most different names');
  assert.deepEqual([g.names[0x58], g.names[0x58 + 13], g.names[0x58 + 43], g.names[0x58 + 47]], ['Alabastia', 'Route 1', 'Digdas Höhle', 'Pokémon-Haus']);
  assert.equal(g.names.length, 0x58 + 80);
  assert.equal(prettyName('POKéMON LEAGUE'), 'Pokémon League');
  assert.equal(prettyName('Pokémon League'), 'Pokémon League');
});

test('BLZ: an uncompressed binary passes through', () => {
  const b = Uint8Array.from({ length: 64 }, (_, i) => (i < 60 ? i : 0)); // size increase 0 = not compressed
  assert.equal(blzDecompress(b), b);
  assert.throws(() => blzDecompress(Uint8Array.from({ length: 64 }, (_, i) => i)), /BLZ/, 'a footer that can\'t be right');
});

test('readLocation with ROM data: Gen 4 map id → the ROM\'s location, through the module params pointer', () => {
  const save = 0x02230000;
  const rom = { gen: 4, family: 'hgss', code: 'IPKD', lang: 'de', mapLoc: [0, 0, 7, 9], names: ['Geheimort', 'A', 'B', 'C', 'D', 'E', 'F', 'Rosalia City', 'G', 'Route 29'] };
  // German HeartGold: no maps.json entry, a scanned party – the module params lead to the save data, taken once it
  // holds a trainer (PKHeX Trainer1 at +0x74: a name, money, gender)
  const entry = { id: 'heartgold_us~IPKD', gen: 4, partyCoreOffset: '0xA0' };
  const trainer = [0x2b, 0x01, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2, 0, ...le32(3000), 0, 5];
  const read = bus({ 0x02000ba8: le32(0x02111860), 0x02111880: le32(save), [save + 0x1244]: le32(3), [save + 0x74]: trainer });
  assert.equal(canReadLocation(maps, entry, null), false, 'without ROM data the language has no location');
  assert.equal(canReadLocation(maps, entry, rom), true);
  assert.deepEqual(readLocation(maps, entry, read, { rom }), { gen: 4, id: 9, map: 3, romName: 'Route 29' });
  assert.equal(readLocation(maps, entry, bus({ 0x02000ba8: le32(0x02111860), 0x02111880: le32(save), [save + 0x1244]: le32(3) }), { rom }), null, 'no trainer there: not the save data');
  // the party reader already knows the save data: that wins
  // (map 6 here – HG/SS's maps 2, 4 and 5 are the Union Room and the Colosseums: shared/live/location.mjs GEN4_LINK)
  const rom6 = { ...rom, mapLoc: [0, 0, 7, 9, 0, 0, 7] };
  const read2 = bus({ [0x02240000 + 0x1244]: le32(6) });
  assert.deepEqual(readLocation(maps, entry, read2, { rom: rom6, state: { saveBase: 0x02240000 } }), { gen: 4, id: 7, map: 6, romName: 'Rosalia City' });
  assert.equal(readLocation(maps, entry, bus({ [0x02240000 + 0x1244]: le32(2) }), { rom, state: { saveBase: 0x02240000 } }).link, 'union', 'HG/SS map 2: the Union Room');
  // only a scanned party (maybe a battle's copy): no save data is guessed from it
  const read3 = bus({ [0x02250000 + 0x1244]: le32(3) });
  assert.equal(readLocation(maps, entry, read3, { rom, state: { partyAddr: 0x02250000 + 0xa0 } }), null);
});

test('readLocation with ROM data: the vanilla table and the ROM agree; the ROM wins for a hack', () => {
  const save = 0x02230000;
  const trainer = [0x2b, 0x01, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2, 0, ...le32(3000), 0, 5];
  const read = bus({ 0x02000ba8: le32(0x02111860), 0x02111880: le32(save), [save + 0x1244]: le32(6), [save + 0x74]: trainer });
  const t = maps.tables.gen4.hgss;
  assert.equal(readLocation(maps, 'heartgold_us', read).id, t[6]);
  const hack = { gen: 4, family: 'hgss', code: 'IPKE', lang: 'en', mapLoc: t.map((v, i) => (i === 6 ? 200 : v)), names: Array.from({ length: 235 }, (_, i) => (i === 200 ? 'Hack Town' : `L${i}`)) };
  assert.deepEqual(readLocation(maps, 'heartgold_us', read, { rom: hack }), { gen: 4, id: 200, map: 6, romName: 'Hack Town' });
});

test('readLocation with ROM data: Gen 5 – Black 2\'s copy of the zone header behind the main pointer, parent zone as fallback (#1)', () => {
  const base = 0x02200000;
  // four zones of 48 bytes: zone 1 a room in zone 3 (parent at +0x18), zone 3 Aspertia City
  const zones = new Uint8Array(4 * 48);
  for (let z = 0; z < 4; z++) {
    zones[z * 48] = 0x10 + z;
    put16(zones, z * 48 + 0x18, z === 1 ? 3 : z);
  }
  const zoneHeaders = Array.from(zones, (v) => v.toString(16).padStart(2, '0')).join('');
  const rom = { gen: 5, family: 'b2w2', code: 'IREO', lang: 'en', mapLoc: [0, 0, 0, 117], names: Object.assign(new Array(118).fill(''), { 117: 'Aspertia City' }), zoneHeaders };
  // main pointer + 0x41B2C: the copy of the zone's header, the zone id after it (+0x30 = Ironmon's childMapHeader 0x41B5C)
  const copy = (z) => [...zones.subarray(z * 48, z * 48 + 48), ...le16(z)];
  const read = bus({ 0x02000024: le32(base), [base + 0x41b2c]: copy(3) });
  assert.equal(canReadLocation(maps, { id: 'black2_us', gen: 5 }, rom), true);
  assert.deepEqual(readLocation(maps, { id: 'black2_us', gen: 5 }, read, { rom }), { gen: 5, id: 117, map: 3, romName: 'Aspertia City' });
  const read2 = bus({ 0x02000024: le32(base), [base + 0x41b2c]: copy(1) });
  assert.equal(readLocation(maps, { id: 'black2_us', gen: 5 }, read2, { rom }).id, 117, 'zone without a name → its parent');
  // what Ironmon's addresses alone took on trust: a zone id there without its header – no place
  assert.equal(readLocation(maps, { id: 'black2_us', gen: 5 }, bus({ 0x02000024: le32(base), [base + 0x41b5c]: le16(3) }), { rom }), null);
  assert.equal(canReadLocation(maps, { id: 'black2_us', gen: 5 }, null), false, 'Gen 5 needs the ROM data');
});

/** A DS main-RAM image (4 MiB, zeroed like at power-on) and its bus read. */
function mainRam() {
  const ram = new Uint8Array(0x400000);
  const at = (a) => a - 0x02000000;
  return {
    ram,
    put16: (a, v) => put16(ram, at(a), v),
    put32: (a, v) => put32(ram, at(a), v),
    read: (a, n) => (a >= 0x02000000 && a + n <= 0x02400000 ? ram.subarray(at(a), at(a) + n) : null),
  };
}

test('readLocation with ROM data: Black/White read the copy of the zone header, in every language (Discord: Black City, then nothing)', () => {
  // Black's zone table as the ROM has it (romloc gen5 `zoneHeaders`, 48 bytes a zone: its own id at +0x16, the parent
  // zone at +0x18, the name at +0x1A): 0 Black City, 152 a zone without a name, 317 Route 1, 389 Nuvema Town, 396
  // Juniper's lab (in Nuvema Town), 397 Accumula Town – the headers of 389 and 396 as captured from Black US
  const zones = new Uint8Array(427 * 48);
  for (let z = 0; z < 427; z++) {
    zones[z * 48] = 0x10;
    put16(zones, z * 48 + 0x08, 0x300 + z);
    put16(zones, z * 48 + 0x16, z);
    put16(zones, z * 48 + 0x18, z);
    zones[z * 48 + 0x1a] = 1;
  }
  const hex = (s) => Uint8Array.from(s.split(' '), (v) => parseInt(v, 16));
  zones.set(hex('00 00 02 00 00 00 0a 03 0b 03 ac 01 fa 03 fa 03 fa 03 fa 03 ff ff 85 01 85 01 04 04 40 00 40 ec 00 00 00 00 0e 03 00 00 00 00 00 00 ee 02 00 00'), 389 * 48);
  zones.set(hex('10 10 d5 00 2a 00 18 03 19 03 b3 01 28 04 28 04 28 04 28 04 ff ff 8c 01 85 01 04 00 00 00 21 49 2a 00 00 00 05 00 00 00 00 00 00 00 04 00 00 00'), 396 * 48);
  put16(zones, 152 * 48 + 0x18, 397);
  const name = { 0: 50, 152: 0, 317: 14, 389: 4, 396: 4, 397: 5 };
  for (const [z, n] of Object.entries(name)) zones[z * 48 + 0x1a] = n;
  const mapLoc = Array.from({ length: 427 }, (_, z) => zones[z * 48 + 0x1a]);
  const names = Object.assign(new Array(117).fill('Somewhere'), { 0: '', 4: 'Nuvema Town', 5: 'Accumula Town', 14: 'Route 1', 50: 'Black City' });
  const black = { gen: 5, family: 'bw', code: 'IRBO', lang: 'en', mapLoc, names, zoneHeaders: Array.from(zones, (v) => v.toString(16).padStart(2, '0')).join('') };
  const entry = { id: 'black_us', gen: 5 };
  // the game's copy of the current zone's header, followed by the zone id
  const inZone = (ram, a, z) => {
    ram.ram.set(zones.subarray(z * 48, z * 48 + 48), a - 0x02000000);
    ram.put16(a + 0x30, z);
  };

  // Black US as captured in souldew's players: Juniper's lab at 0x0225929C (the zone itself at 0x022592B2, the static
  // address NDS-Ironmon-Tracker has) – the lab's own name is Nuvema Town's
  const us = mainRam();
  inZone(us, 0x0225929c, 396);
  assert.deepEqual(readLocation(maps, entry, us.read, { rom: black }), { gen: 5, id: 4, map: 396, romName: 'Nuvema Town' });
  // White US: 0x20 further on
  const white = mainRam();
  inZone(white, 0x022592bc, 397);
  assert.equal(readLocation(maps, { id: 'white_us', gen: 5 }, white.read, { rom: { ...black, code: 'IRAO' } })?.id, 5);

  // another language (German Black, IRBD: found through the family): its static data sits elsewhere, the English
  // address holds no zone – read as zone 0, Black City, and nothing after it. The copy is searched for in RAM (with the
  // live reader's state), remembered, and followed from zone to zone.
  const de = mainRam();
  inZone(de, 0x0225a1c0, 317);
  const german = { ...black, code: 'IRBD', lang: 'de' };
  const deEntry = { id: 'black_us~IRBD', gen: 5 };
  const state = {};
  assert.equal(canReadLocation(maps, deEntry, german), true);
  assert.equal(readLocation(maps, deEntry, de.read, { rom: german }), null, 'without the reader\'s state: no search');
  assert.deepEqual(readLocation(maps, deEntry, de.read, { rom: german, state }), { gen: 5, id: 14, map: 317, romName: 'Route 1' });
  assert.equal(state.bwZoneAt, 0x0225a1c0);
  inZone(de, 0x0225a1c0, 389);
  assert.equal(readLocation(maps, deEntry, de.read, { rom: { ...german, family: undefined }, state })?.id, 4, 'the family from the game code too');
  // a few headers of the table side by side (the zones around a town) are no copy of the current one
  const town = mainRam();
  town.ram.set(zones.subarray(388 * 48, 392 * 48), 0x00150a00);
  inZone(town, 0x0225a1c0, 389);
  assert.equal(readLocation(maps, deEntry, town.read, { rom: german, state: {} })?.map, 389);
  // one poll that doesn't match (the game rewriting the copy on a zone change): the address and the place stay
  de.ram[0x0025a1c0 + 3] ^= 0xff;
  assert.equal(readLocation(maps, deEntry, de.read, { rom: german, state })?.id, 4, 'not dropped on one mismatch');
  assert.equal(state.bwZoneAt, 0x0225a1c0);
  de.ram[0x0025a1c0 + 3] ^= 0xff;
  assert.equal(readLocation(maps, deEntry, de.read, { rom: german, state })?.id, 4);
  assert.equal(state.bwMiss, 0);
  // the copy gone (back on the title screen): after a few polls no place, and searched for again later (not every read)
  de.ram.fill(0, 0x0025a1c0, 0x0025a1c0 + 0x40);
  assert.equal(readLocation(maps, deEntry, de.read, { rom: german, state })?.id, 4);
  assert.equal(readLocation(maps, deEntry, de.read, { rom: german, state })?.id, 4);
  assert.equal(readLocation(maps, deEntry, de.read, { rom: german, state }), null);
  assert.equal(state.bwLast, null, 'no place kept');
  // … but the address stays a candidate, read on every poll: back in the game, the copy where it was is the place at
  // once – no search, no wait for one (it was dropped: up to 30 s without a sign)
  let big = 0;
  const counted = (a, n) => {
    if (n === 0x400000) big++;
    return de.read(a, n);
  };
  state.bwZoneScan = Date.now(); // (a search just ran)
  for (let i = 0; i < 5; i++) assert.equal(readLocation(maps, deEntry, counted, { rom: german, state }), null);
  inZone(de, 0x0225a1c0, 317);
  assert.equal(readLocation(maps, deEntry, counted, { rom: german, state })?.id, 14);
  assert.equal(big, 0, 'found without a search');
  assert.equal(state.bwMiss, 0);
  // the remembered address takes only a copy followed by its zone id – a header of the table there is no copy
  de.ram.fill(0, 0x0025a1c0, 0x0025a1c0 + 0x40);
  for (let i = 0; i < 3; i++) readLocation(maps, deEntry, de.read, { rom: german, state });
  de.ram.set(zones.subarray(316 * 48, 319 * 48), 0x0025a1c0);
  assert.equal(readLocation(maps, deEntry, de.read, { rom: german, state: { ...state, bwZoneScan: Date.now() } }), null);
  assert.equal(readLocation(maps, deEntry, de.read, { rom: german, state }), null);

  // a zone without a name of its own: its parent zone's (150, 151 and 422 are the link rooms – test/link.test.mjs)
  const room = mainRam();
  inZone(room, 0x0225929c, 152);
  assert.deepEqual(readLocation(maps, entry, room.read, { rom: black }), { gen: 5, id: 5, map: 397, romName: 'Accumula Town' });

  // power-on / title screen: zeroed RAM is no zone – not zone 0, Black City; the same for Black 2's pointer
  assert.equal(readLocation(maps, entry, mainRam().read, { rom: black, state: {} }), null);
  const b2 = { gen: 5, family: 'b2w2', code: 'IREO', lang: 'en', mapLoc, names };
  assert.equal(readLocation(maps, { id: 'black2_us', gen: 5 }, mainRam().read, { rom: b2 }), null);
  // ROM data without the zone headers (an older cache): Black/White can't be read
  assert.equal(canReadLocation(maps, entry, { ...black, zoneHeaders: undefined }), false);

  // an English game whose copy at its own address differs from the ROM's header (a zone the game changes while it
  // runs): the id fields agree, most bytes are the ROM's – the sign stays, without any search
  const loose = mainRam();
  inZone(loose, 0x0225929c, 317);
  for (const i of [0, 2, 4, 6]) loose.ram[0x0025929c + i] ^= 0x5a;
  const looseState = {};
  assert.deepEqual(readLocation(maps, entry, loose.read, { rom: black, state: looseState }), { gen: 5, id: 14, map: 317, romName: 'Route 1' });
  assert.equal(looseState.bwZoneScan, 0, 'no RAM search for it');
  // … but only there, only in an English game, and only with the id fields in agreement
  const deLoose = mainRam();
  inZone(deLoose, 0x0225929c, 317);
  for (const i of [0, 2, 4, 6]) deLoose.ram[0x0025929c + i] ^= 0x5a;
  assert.equal(readLocation(maps, deEntry, deLoose.read, { rom: german }), null, 'another language: its static address isn\'t this one');
  loose.put16(0x0225929c + 0x30, 389);
  assert.equal(readLocation(maps, entry, loose.read, { rom: black, state: {} }), null, '+0x30 says another zone');
  const junk = mainRam();
  inZone(junk, 0x0225929c, 317);
  junk.ram.fill(0x77, 0x0025929c, 0x0025929c + 0x16);
  junk.ram.fill(0x77, 0x0025929c + 0x1c, 0x0025929c + 0x30);
  assert.equal(readLocation(maps, entry, junk.read, { rom: black, state: {} }), null, 'only the id fields fit: no copy');
  // zero-filled RAM with a zone id of 0 – never Black City, in either way of reading
  const zero = mainRam();
  assert.equal(readLocation(maps, entry, zero.read, { rom: black, state: {} }), null);

  // the RAM search backs off: every 3 s at first, every 30 s after several searches without a hit, fast again for
  // another game
  const real = Date.now;
  let now = 1e12;
  Date.now = () => now;
  try {
    const empty = mainRam();
    let reads = 0;
    const counted = (a, n) => {
      if (n === 0x400000) reads++;
      return empty.read(a, n);
    };
    const st = {};
    const poll = (rom = german) => readLocation(maps, deEntry, counted, { rom, state: st });
    for (let i = 0; i < 4; i++) {
      poll();
      now += 3000;
    }
    assert.equal(reads, 4, 'every 3 s while it may still turn up');
    for (let i = 0; i < 11; i++) {
      poll();
      now += 3000;
    }
    assert.equal(reads, 5, 'then every 30 s');
    // the game set something up (the title screen left, the save loaded: the party reader found the team) – the search
    // is back at the fast pace, the sign doesn't stay empty for up to 30 s
    st.partyAddr = 0x0221b590;
    poll();
    assert.equal(reads, 6, 'searched for at once');
    for (let i = 0; i < 3; i++) {
      now += 3000;
      poll();
    }
    assert.equal(reads, 9, 'every 3 s again');
    // the same with a new value of the main pointer
    for (let i = 0; i < 11; i++) {
      now += 3000;
      poll();
    }
    const slow = reads;
    empty.put32(0x02000024, 0x0221b2f0);
    now += 3000;
    poll();
    assert.equal(reads, slow + 1, 'the main pointer changed: searched for again');
    now += 3000;
    poll({ ...german, code: 'IRAD' });
    assert.equal(reads, slow + 2, 'another game: searched for right away');
    // found once: the misses start over
    inZone(empty, 0x0225a1c0, 317);
    now += 3000;
    assert.equal(poll({ ...german, code: 'IRAD' })?.map, 317);
    assert.equal(st.bwScanMiss, 0);
  } finally {
    Date.now = real;
  }
});

// ---------------------------------------------------------------- Game Boy map headers

/**
 * A made-up Gen 1 ROM (512 KB) with its map tables where no English game has them – as another language might. `maps`:
 * Red/Blue 248, Yellow 249.
 */
function gen1Rom({ pointers = 0x2345, banks = 0x13579, maps: n = 248 } = {}) {
  const rom = new Uint8Array(0x80000);
  for (let i = 0; i < n; i++) {
    const bank = 5 + (i % 3);
    const ptr = 0x4100 + i * 24;
    put16(rom, pointers + i * 2, ptr);
    rom[banks + i] = i === 11 ? 0 : bank; // (an unused map: no header)
    const o = bank * 0x4000 + (ptr - 0x4000);
    rom.set([i < 9 ? 0 : 1 + (i % 20), 9 + (i % 7), 10 + (i % 5), 0x00, 0x50, 0x10, 0x60, 0x20, 0x70, i % 16], o);
  }
  return rom;
}

test('Gen 1 map headers: the pointer and bank tables found by their structure, wherever they are', () => {
  const g = gen1MapHeaders(gen1Rom());
  assert.deepEqual(g.offset, { pointers: 0x2345, banks: 0x13579 });
  assert.equal(g.headers.length, 248);
  assert.equal(g.headers[11], null, 'an unused map has no header');
  assert.equal(g.headers[0], '00090a005010602070' + '00');
  const moved = gen1MapHeaders(gen1Rom({ pointers: 0x3001, banks: 0x2fff0 }));
  assert.deepEqual(moved.offset, { pointers: 0x3001, banks: 0x2fff0 });
  assert.deepEqual(moved.headers, g.headers, 'the same headers – another place in the ROM');
  assert.equal(gbMapHeaders(gen1Rom(), 1, maps.tables.gen1.pokered).headers[12], g.headers[12]);
  assert.equal(gen1MapHeaders(new Uint8Array(0x80000)), null, 'no tables: nothing');
});

test('Gen 1 map headers: Yellow has a map more (249: Summer Beach House) – its ROM passes the check against its own table', () => {
  const yellow = maps.tables.gen1.pokeyellow;
  assert.equal(Object.keys(yellow).filter((k) => !k.startsWith('_')).length, 249);
  const rom = gen1Rom({ maps: 249 });
  const g = gbMapHeaders(rom, 1, yellow);
  // (it gave 248 headers for a table of 249 maps: null for every Yellow ROM, the place from the unchecked wCurMap)
  assert.ok(g, 'Yellow\'s headers');
  assert.equal(g.headers.length, 249);
  assert.equal(g.headers[248], gen1MapHeaders(rom, 249).headers[248], 'map 248 too');
  assert.ok(g.headers[248]);
  assert.equal(gen1MapHeaders(rom).headers.length, 248, 'Red/Blue: 248 maps');
});

test('Gen 1 map headers: bytes made to look like thousands of tables give up quickly – null, never minutes of work', () => {
  const rom = new Uint8Array(0x100000);
  // a town's header at the start of a few banks, and thousands of pointer tables leading there
  for (let k = 1; k < 4; k++) rom.set([0, 9, 10, 0, 0x50, 0x10, 0x60, 0x20, 0x70, 0], k * 0x4000);
  for (let o = 0; o < 0x4000; o += 2) put16(rom, o, 0x4000);
  let t = Date.now();
  assert.equal(gen1MapHeaders(rom), null, 'no banks table');
  // and banks tables everywhere
  for (let k = 1; k < 4; k++) rom.fill(2, k * 0x4000 + 16, (k + 1) * 0x4000);
  assert.equal(gen1MapHeaders(rom), null, 'too many to be a game\'s');
  assert.equal(gbMapHeaders(rom, 1, maps.tables.gen1.pokered), null);
  t = Date.now() - t;
  assert.ok(t < 10000, `${t} ms (it took minutes: a pass over the ROM for each table)`);
});

/** A made-up Gen 2 ROM: the maps of `table` (group.number) in a group table at `at`, attributes in the next bank. */
function gen2Rom(table, at = 0x40123) {
  const rom = new Uint8Array(0x100000);
  const keys = Object.keys(table).filter((k) => !k.startsWith('_'));
  const groups = Math.max(...keys.map((k) => Number(k.split('.')[0])));
  const bank = at >> 14;
  let next = (at & 0x3fff) + 0x4000 + groups * 2;
  let attr = 0x4000;
  for (let gi = 1; gi <= groups; gi++) {
    put16(rom, at + (gi - 1) * 2, next);
    const n = keys.filter((k) => k.startsWith(`${gi}.`)).length;
    for (let m = 0; m < n; m++, next += 9, attr += 12) {
      const o = bank * 0x4000 + next - 0x4000;
      rom.set([bank + 1, 1 + (m % 30), 1 + (gi % 7), attr & 0xff, attr >> 8, gi, 5, 0, 1], o);
      rom.set([0, 5 + (m % 9), 5 + (gi % 11), 0x20, 0x00, 0x50, 0x21, 0x00, 0x60, 0x10, 0x70, m % 16], (bank + 1) * 0x4000 + attr - 0x4000);
    }
  }
  return rom;
}

test('Gen 2 map headers: the group table found by its structure; its maps must be the table\'s', () => {
  const t = maps.tables.gen2.pokecrystal;
  const g = gen2MapHeaders(gen2Rom(t));
  assert.equal(g.offset, 0x40123);
  assert.deepEqual(Object.keys(g.maps).sort(), Object.keys(t).filter((k) => !k.startsWith('_')).sort());
  assert.equal(g.maps['24.3'].length, 34, '5 + 12 bytes');
  assert.ok(gbMapHeaders(gen2Rom(t), 2, t), 'the same maps as the table');
  // a table with other maps (a hack with maps of its own): the reader keeps to the fixed addresses
  const fewer = Object.fromEntries(Object.entries(t).filter(([k]) => k !== '24.3'));
  assert.equal(gbMapHeaders(gen2Rom(fewer), 2, t), null);
  assert.equal(gbMapHeaders(gen2Rom(t), 2, maps.tables.gen2.pokegold), null, 'Gold/Silver have fewer maps');
  assert.equal(gen2MapHeaders(new Uint8Array(0x100000)), null);
});

// ---------------------------------------------------------------- real ROMs (optional)

const DIR = process.env.SOULDEW_TEST_ROMS;
const roms = DIR && existsSync(DIR) ? readdirSync(DIR).filter((f) => /\.(nds|gba)$/i.test(f)).map((f) => join(DIR, f)) : [];
const gbRoms = DIR && existsSync(DIR) ? readdirSync(DIR).filter((f) => /\.gbc?$/i.test(f)).map((f) => join(DIR, f)) : [];
// only retail dumps can be compared with the tables (a hack or a randomized game is checked in test/romdata.test.mjs)
const RETAIL = new Set(json('catalog.json').games.flatMap((g) => g.crc32 || []).map((c) => String(c).toUpperCase()));
const retail = (bytes) => RETAIL.has(romCrc(bytes));

test('real ROMs: the ROM-derived locations match the tables', { skip: roms.length ? false : 'set SOULDEW_TEST_ROMS to a folder with ROMs' }, () => {
  const table4 = { hgss: maps.tables.gen4.hgss, pt: maps.tables.gen4.pt, dp: maps.tables.gen4.dp };
  for (const f of roms) {
    const bytes = new Uint8Array(readFileSync(f));
    if (!retail(bytes)) continue;
    const r = romLocations(bytes, opts);
    assert.ok(r, `${f}: location data found`);
    if (r.gen === 4) {
      const t = table4[r.family];
      assert.deepEqual(r.mapLoc.slice(0, t.length), t, `${f}: map → location equals maps.json ${r.family}`);
      // gen4.json holds the HeartGold/SoulSilver names; Diamond/Pearl/Platinum have their own list
      if (r.lang === 'en' && r.family === 'hgss') assert.deepEqual(r.names, gen4.locations, `${f}: names equal gen4.json`);
      if (r.lang === 'en' && r.family !== 'hgss') assert.equal(r.names[1], 'Twinleaf Town', f);
    } else if (r.gen === 3) {
      assert.equal(r.vanilla, undefined, 'romLocations itself knows nothing about checksums (the server adds it)');
      // the table's labels carry notes for the other versions: "Battle Tower (RS) / Battle Frontier (E)"
      const variants = (label) => label.split(' / ').map((x) => x.replace(/\s*\([^)]*\)/g, '').trim().toLowerCase());
      let same = 0;
      for (const [k, v] of Object.entries(loc3.map)) {
        const n = r.names[Number(k)];
        if (!n || r.lang !== 'en') continue;
        assert.ok(variants(v.en).some((x) => x.startsWith(n.toLowerCase()) || n.toLowerCase().startsWith(x) || n.toLowerCase().endsWith(x)), `${f}: section ${k} "${n}" vs "${v.en}"`);
        same++;
      }
      if (r.lang === 'en') assert.ok(same >= 80, `${f}: ${same} sections compared`);
      // a German ROM against the app's German names (FireRed/LeafGreen: the Fame Checker's table was read once, #16)
      if (r.lang === 'de') {
        const de = Object.entries(loc3.map).filter(([k, v]) => v.de && r.names[Number(k)]);
        const hits = de.filter(([k, v]) => variants(v.de).some((x) => x.toLowerCase() === r.names[Number(k)].toLowerCase()));
        assert.ok(de.length >= 80 && hits.length >= de.length * 0.8, `${f}: ${hits.length} of ${de.length} German names agree`);
      }
    } else if (r.gen === 5) {
      if (r.lang === 'en') {
        assert.equal(r.names[4], 'Nuvema Town', f);
        if (r.family === 'b2w2') assert.equal(r.names[r.mapLoc[427]], 'Aspertia City', `${f}: the player's home zone`);
      }
      assert.ok(r.mapLoc.every((v) => v < r.names.length), f);
    }
  }
});

test('real Game Boy ROMs: the map headers are where pret\'s symbols put them, and are the tables\' maps', { skip: gbRoms.length ? false : 'set SOULDEW_TEST_ROMS to a folder with ROMs' }, () => {
  // pret: pokered.sym 00:01AE MapHeaderPointers, 03:423D MapHeaderBanks; pokeyellow 3F:41F2 / 3F:43E4;
  // pokecrystal.sym 25:4000 MapGroupPointers, pokegold/pokesilver.sym 25:40ED
  const at = (bank, a) => bank * 0x4000 + (a - 0x4000);
  const gen1 = { 'POKEMON RED': [0x1ae, at(3, 0x423d)], 'POKEMON BLUE': [0x1ae, at(3, 0x423d)], 'POKEMON YELLOW': [at(0x3f, 0x41f2), at(0x3f, 0x43e4)] };
  const gen2 = { PM_CRYSTAL: [at(0x25, 0x4000), 'pokecrystal'], POKEMON_GLD: [at(0x25, 0x40ed), 'pokegold'], POKEMON_SLV: [at(0x25, 0x40ed), 'pokegold'] };
  let checked = 0;
  for (const f of gbRoms) {
    const bytes = new Uint8Array(readFileSync(f));
    if (!retail(bytes)) continue;
    const title = String.fromCharCode(...bytes.subarray(0x134, 0x144)).replace(/\0.*$/, '').trim();
    const g1 = Object.entries(gen1).find(([k]) => title.startsWith(k));
    const g2 = Object.entries(gen2).find(([k]) => title.startsWith(k));
    if (g1) {
      const table = maps.tables.gen1[g1[0] === 'POKEMON YELLOW' ? 'pokeyellow' : 'pokered'];
      const g = gen1MapHeaders(bytes, Object.keys(table).filter((k) => !k.startsWith('_')).length);
      assert.deepEqual(g.offset, { pointers: g1[1][0], banks: g1[1][1] }, f);
      assert.ok(g.headers.filter(Boolean).length >= 220, f);
      assert.ok(gbMapHeaders(bytes, 1, table), `${f}: the maps of maps.json ${g1[0]}`);
      checked++;
    }
    if (g2) {
      const g = gen2MapHeaders(bytes);
      assert.equal(g.offset, g2[1][0], f);
      assert.ok(gbMapHeaders(bytes, 2, maps.tables.gen2[g2[1][1]]), `${f}: the same maps as maps.json ${g2[1][1]}`);
      assert.equal(new Set(Object.values(g.maps)).size, Object.keys(g.maps).length, `${f}: every map's 17 bytes are its own`);
      checked++;
    }
  }
  assert.ok(checked > 0, 'a retail Game Boy ROM was checked');
});

test('real GBA ROMs: every map header’s events pointer names one section', { skip: roms.length ? false : 'set SOULDEW_TEST_ROMS to a folder with ROMs' }, () => {
  for (const f of roms.filter((x) => /\.gba$/i.test(x))) {
    const bytes = new Uint8Array(readFileSync(f));
    if (!retail(bytes)) continue;
    const h = gen3MapHeaders(bytes);
    assert.ok(h && h.length / 10 >= 300, `${f}: map headers`);
    const sec = new Map();
    for (let i = 0; i < h.length; i += 10) {
      const k = h.substr(i, 8);
      assert.ok(!sec.has(k) || sec.get(k) === h.substr(i + 8, 2), `${f}: events ${k} in two sections`);
      sec.set(k, h.substr(i + 8, 2));
    }
  }
});
