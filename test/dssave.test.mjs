// Playing a DS game with the melonDS app (2.8.2, a player's report on Discord: "even after saving souldew wouldn't
// update my team"). melonDS can't share the running game's memory, so souldew reads the battery save it writes after
// every in-game save – but only HeartGold/SoulSilver saves were ever read: for Diamond, Pearl, Platinum, Black, White,
// Black 2 and White 2 nothing watched the file at all. Every DS game the live readers know is read now
// (shared/live/parse.mjs readSaveFile – the games keep their save in RAM in the layout of the file, so the same
// readers read both), wherever melonDS writes it (next to the ROM, or the save folder set in melonDS), however it
// writes it (in place, through a temp file, in pieces), and the play view says which file it reads and when.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, renameSync, rmSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pbkdf2 } from 'node:crypto';
import { findEntry, readSaveFile, LiveTables } from '../shared/live/parse.mjs';
import { encryptPK4, crc16ccitt, writeFooters, SAVE_LAYOUT } from '../shared/gen4save.mjs';
import { SaveWatcher, saveParser, isHgssGame } from '../server/lib/savewatch.mjs';
import { melonSaveDirs, melonConfigFiles } from '../server/lib/emulator.mjs';

const L = (f) => JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url)));
const TABLE = L('addresses.json');
const GEN4 = L('gen4.json');
const T = new LiveTables({ gen4: GEN4 });
const TID = 50953;
const SID = 35290;

/** A Pokémon as the game stores it (encrypted): 236 bytes in a Gen 4 party, 220 in a Gen 5 one, 136 in the PC. */
function pk({ pid, species, level = 6, hp = 21, maxHp = 21, met = 16, gen = 4, size = 236, item = 0 }) {
  const d = new Uint8Array(size);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint16(0x08, species, true);
  dv.setUint16(0x0a, item, true);
  dv.setUint16(0x0c, TID, true);
  dv.setUint16(0x0e, SID, true);
  if (gen === 4) dv.setUint16(0x46, met, true);
  dv.setUint16(0x80, met, true);
  d[0x84] = 5;
  if (size > 136) {
    d[0x8c] = level;
    dv.setUint16(0x8e, hp, true);
    dv.setUint16(0x90, maxHp, true);
  }
  return encryptPK4(d);
}
const STARTER = { pid: 0x5bfb4c23, species: 390, met: 16 };
const CATCH = { pid: 0x7ad4ab79, species: 399, level: 3, hp: 14, maxHp: 14, met: 17 };
const BOXED = { pid: 0x11112222, species: 396, met: 18, size: 136 };

// Diamond/Pearl/Platinum (PKHeX SAV4DP/SAV4Pt; Platinum checked against real saves): block sizes, where the party and
// the trainer sit in the general block, the PC in the storage block (box 1 at +4, 0xFF0 per box), 0x14-byte footers
const LAYOUT4 = {
  pt: { general: 0xcf2c, storage: 0xcf2c, storageSize: 0x121e4, trainer: 0x68, count: 0x9c, party: 0xa0 },
  dp: { general: 0xc100, storage: 0xc100, storageSize: 0x121e0, trainer: 0x64, count: 0x94, party: 0x98 },
};
function footer4(u8, base, size, count) {
  const dv = new DataView(u8.buffer);
  const end = base + size;
  dv.setUint32(end - 0x14, 1, true);
  dv.setUint32(end - 0x10, count, true);
  dv.setUint32(end - 0x0c, size, true);
  dv.setUint32(end - 0x08, 0x20060623, true);
  dv.setUint16(end - 0x02, crc16ccitt(u8, base, end - 0x14), true);
}
/** A Sinnoh save: `parts` = [{ p: partition, count, party, boxes, badges, storageCount }] – erased flash elsewhere. */
function sinnohSave(fam, parts) {
  const Lt = LAYOUT4[fam];
  const u8 = new Uint8Array(0x80000).fill(0xff);
  const dv = new DataView(u8.buffer);
  for (const { p, count, party = [], boxes = [], badges = 0, storageCount = count } of parts) {
    u8.fill(0, p, p + Lt.general);
    const tr = p + Lt.trainer;
    [0x2b, 0x2c, 0x2d, 0xffff].forEach((c, i) => dv.setUint16(tr + i * 2, c, true)); // (three letters of the game's table)
    dv.setUint16(tr + 0x10, TID, true);
    dv.setUint16(tr + 0x12, SID, true);
    u8[tr + 0x1a] = badges;
    dv.setUint16(tr + 0x22, 12, true); // 12 h 34 min 56 s
    u8[tr + 0x24] = 34;
    u8[tr + 0x25] = 56;
    dv.setUint32(p + Lt.count - 4, 6, true);
    dv.setUint32(p + Lt.count, party.length, true);
    party.forEach((m, i) => u8.set(pk(m), p + Lt.party + i * 236));
    footer4(u8, p, Lt.general, count);
    if (storageCount !== null) {
      const s = p + Lt.storage;
      u8.fill(0, s, s + Lt.storageSize);
      boxes.forEach(({ box, slot, ...m }) => u8.set(pk({ ...m, size: 136 }), s + 4 + box * 0xff0 + slot * 136));
      footer4(u8, s, Lt.storageSize, storageCount);
    }
  }
  return u8;
}
const entry = (code) => findEntry(TABLE, { platform: 'nds', code });

test('Platinum save: the team, the PC and the badges – from the newest general block, the newest PC wherever it is', () => {
  const sav = sinnohSave('pt', [
    { p: 0, count: 4, party: [STARTER], storageCount: null }, // (that partition's PC never written: erased, as in real saves)
    // saved again after a catch: the general block in the other partition, the PC only written there once (count 1)
    { p: 0x40000, count: 5, party: [STARTER, CATCH], boxes: [{ ...BOXED, box: 0, slot: 2 }], badges: 0b11, storageCount: 1 },
  ]);
  for (const code of ['CPUE', 'CPUD', 'CPUF', 'CPUS', 'CPUI']) {
    const s = readSaveFile(entry(code), sav, T);
    assert.deepEqual(s.party.map((m) => [m.species, m.level, m.hp, m.metLocation, m.slot]), [[390, 6, 21, 16, 0], [399, 3, 14, 17, 1]], code);
    assert.deepEqual(s.boxes.map((m) => [m.species, m.box, m.slot, m.metLocation]), [[396, 0, 2, 18]]);
    assert.equal(s.badges.count, 2);
    assert.deepEqual([s.trainer.tid, s.trainer.sid], [TID, SID]);
    assert.deepEqual(s.playTime, { h: 12, m: 34, s: 56 });
    assert.equal(s.party[0].key, `5bfb4c23-${TID}-${SID}`, 'the live readers\' keys');
    assert.ok(s.party.every((m) => m.checksumOk && m.heldItem === 0));
  }
  // the older general block is newer now (the player saved again with the other partition): the team of that save
  const older = sinnohSave('pt', [{ p: 0, count: 6, party: [STARTER] }, { p: 0x40000, count: 5, party: [STARTER, CATCH] }]);
  assert.deepEqual(readSaveFile(entry('CPUE'), older, T).party.map((m) => m.species), [390]);
  // a torn block (a CRC that doesn't match – a write caught halfway) never counts
  const torn = sinnohSave('pt', [{ p: 0, count: 4, party: [STARTER] }, { p: 0x40000, count: 5, party: [STARTER, CATCH] }]);
  torn[0x40000 + 0x100] ^= 0xff;
  assert.deepEqual(readSaveFile(entry('CPUE'), torn, T).party.map((m) => m.species), [390]);
});

test('Diamond/Pearl save: the same, with their own layout', () => {
  const sav = sinnohSave('dp', [{ p: 0, count: 2, party: [STARTER, CATCH], boxes: [{ ...BOXED, box: 3, slot: 29 }], badges: 0b1 }]);
  for (const code of ['ADAE', 'APAE', 'ADAD', 'APAF']) {
    const s = readSaveFile(entry(code), sav, T);
    assert.deepEqual(s.party.map((m) => m.species), [390, 399], code);
    assert.deepEqual(s.boxes.map((m) => [m.species, m.box, m.slot]), [[396, 3, 29]]);
    assert.equal(s.badges.count, 1);
  }
  // a Platinum save is no Diamond save (other block sizes): nothing rather than garbage
  assert.throws(() => readSaveFile(entry('ADAE'), sinnohSave('pt', [{ p: 0, count: 1, party: [STARTER] }]), T), { code: 'saveNotFound' });
});

test('every Gen 4 save that holds no save – erased flash, a fresh game, a cut-off file – says so', () => {
  assert.throws(() => readSaveFile(entry('CPUE'), new Uint8Array(0x80000).fill(0xff), T), { code: 'saveNotFound' });
  assert.throws(() => readSaveFile(entry('CPUE'), new Uint8Array(0x80000), T), { code: 'saveNotFound' });
  // DeSmuME keeps a save only up to its last byte written: the first partition, the rest padded like erased flash
  const sav = sinnohSave('pt', [{ p: 0, count: 1, party: [STARTER] }]);
  assert.deepEqual(readSaveFile(entry('CPUE'), sav.subarray(0, 0x40001), T).party.map((m) => m.species), [390]);
});

test('HeartGold save: readSaveFile and the HGSS parser agree', async () => {
  const { parseHgssSave } = await import('../shared/gen4save.mjs');
  const u8 = new Uint8Array(0x80000);
  const dv = new DataView(u8.buffer);
  dv.setUint16(0x74, TID, true);
  dv.setUint16(0x76, SID, true);
  u8[0x7e] = 0b111;
  dv.setUint32(SAVE_LAYOUT.PARTY_COUNT, 2, true);
  u8.set(pk({ ...STARTER, species: 155, met: 126 }), SAVE_LAYOUT.PARTY_OFFSET);
  u8.set(pk({ ...CATCH, species: 16, met: 177 }), SAVE_LAYOUT.PARTY_OFFSET + 236);
  u8.set(pk({ ...BOXED, species: 19, met: 178 }), SAVE_LAYOUT.STORAGE_START + 0x1000 + 136 * 2);
  writeFooters(u8, 0, 3);
  const a = readSaveFile(entry('IPKE'), u8, T);
  const b = parseHgssSave(u8, GEN4);
  assert.deepEqual(a.party.map((m) => m.key), b.party.map((m) => m.key));
  assert.deepEqual(a.boxes.map((m) => [m.key, m.box, m.slot]), b.boxes.map((m) => [m.key, m.box, m.slot]));
  assert.equal(a.badges.count, b.badges.count);
});

/** A Black/White (or Black 2/White 2) save: the PC from 0x400, the party block at 0x18E00, the trainer at 0x19400. */
function unovaSave({ party, boxes = [], badges = 0, b2w2 = false, at = 0 }) {
  const u8 = new Uint8Array(0x80000);
  const dv = new DataView(u8.buffer);
  dv.setUint32(at + 0x18e04, party.length, true);
  party.forEach((m, i) => u8.set(pk({ ...m, gen: 5, size: 220 }), at + 0x18e08 + i * 220));
  boxes.forEach(({ box, slot, ...m }) => u8.set(pk({ ...m, gen: 5, size: 136 }), at + 0x400 + box * 0x1000 + slot * 136));
  [...'Ana'].forEach((c, i) => dv.setUint16(at + 0x19404 + i * 2, c.charCodeAt(0), true));
  dv.setUint16(at + 0x19404 + 6, 0xffff, true);
  dv.setUint16(at + 0x19414, TID, true);
  dv.setUint16(at + 0x19416, SID, true);
  const misc = at + (b2w2 ? 0x21100 : 0x21200);
  dv.setUint32(misc, 3000, true);
  u8[misc + 4] = badges;
  return u8;
}

test('Black/White and Black 2/White 2 saves: team, PC, badges, trainer – the first copy, else its backup', () => {
  const party = [{ pid: 0x0b0b0001, species: 495, met: 6 }, { pid: 0x0b0b0002, species: 504, level: 3, hp: 12, maxHp: 12, met: 4 }];
  const boxes = [{ pid: 0x0b0b0003, species: 506, met: 4, box: 1, slot: 0 }];
  for (const [code, b2w2] of [['IRBO', false], ['IRAO', false], ['IRBD', false], ['IREO', true], ['IRDO', true], ['IRDD', true]]) {
    const s = readSaveFile(entry(code), unovaSave({ party, boxes, badges: 0b111, b2w2 }), T);
    assert.deepEqual(s.party.map((m) => [m.species, m.level, m.metLocation]), [[495, 6, 6], [504, 3, 4]], code);
    assert.deepEqual(s.boxes.map((m) => [m.species, m.box, m.slot]), [[506, 1, 0]]);
    assert.equal(s.badges.count, 3);
    assert.equal(s.trainer.name, 'Ana');
  }
  // the first copy blank (never written there yet): the backup's
  const bak = unovaSave({ party: [party[0]], at: 0x24000 });
  assert.deepEqual(readSaveFile(entry('IRBO'), bak, T).party.map((m) => m.species), [495]);
  assert.throws(() => readSaveFile(entry('IRBO'), new Uint8Array(0x80000), T), { code: 'saveNotFound' });
});

test('which games\' saves are read: every DS game the readers know – HeartGold/SoulSilver with their own parser', () => {
  const p = (game) => saveParser(game, { gen4: GEN4, addresses: TABLE });
  for (const code of ['CPUE', 'CPUD', 'ADAE', 'APAE', 'IRBO', 'IRDO', 'IREO', 'IPKE', 'IPGD']) assert.equal(typeof p({ code, system: 'nds' }), 'function', code);
  assert.equal(p({ code: 'BPEE', system: 'gba' }), null, 'GBA: mGBA streams it live instead');
  assert.equal(p({ code: 'XXXX', system: 'nds' }), null);
  assert.ok(isHgssGame({ code: 'IPKD' }) && !isHgssGame({ code: 'CPUE' }));
  const sav = sinnohSave('pt', [{ p: 0, count: 1, party: [STARTER, CATCH] }]);
  assert.deepEqual(p({ code: 'CPUE', system: 'nds' })(sav, { shinyOdds: 8 }).party.map((m) => m.species), [390, 399]);
  // a run with a higher shiny rate: the same Pokémon may be shiny there (the save's own read, as the live one)
  const shinyAll = p({ code: 'CPUE', system: 'nds' })(sav, { shinyOdds: 65536 });
  assert.ok(shinyAll.party.every((m) => m.shiny));
});

// ---- the watcher: melonDS writing the save in every way it does ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000) => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) return false;
    await sleep(25);
  }
  return true;
};
function watcherFor(dir) {
  const events = [];
  const parse = saveParser({ code: 'CPUE', system: 'nds' }, { gen4: GEN4, addresses: TABLE });
  const w = new SaveWatcher(GEN4, (ev, data) => events.push({ ev, data }), { parserFor: () => parse, interval: 50, settleMs: 150 });
  const saves = () => events.filter((e) => e.ev === 'save').map((e) => e.data.save.party.map((m) => m.species).join());
  // the teams the page got, one after the other (a re-read that shows the same team changes nothing for it)
  const teams = () => saves().filter((x, i, a) => i === 0 || x !== a[i - 1]);
  return { w, events, saves, teams, last: () => saves().at(-1) };
}

test('melonDS rewriting the .sav in place, through a temp file, in two pieces, and the first save of a new game', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'souldew-savewatch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sav = join(dir, 'p1.sav');
  const { w, events, saves, teams, last } = watcherFor(dir);
  t.after(() => w.unwatch('r1'));
  // not saved yet: watched anyway, nothing read
  assert.deepEqual(w.watch('r1', sav), { ...w.status('r1'), watching: true, exists: false });
  await sleep(200);
  assert.equal(events.length, 0);
  // 1) the first in-game save: the file appears
  writeFileSync(sav, sinnohSave('pt', [{ p: 0, count: 1, party: [STARTER] }]));
  assert.ok(await until(() => last() === '390'), 'read after the first save');
  const st = w.status('r1');
  assert.equal(st.path, sav);
  assert.ok(st.exists && st.readAt && st.lastAt && !st.error);
  // 2) in place (melonDS 1.x: fopen "wb" – truncated, then written)
  writeFileSync(sav, sinnohSave('pt', [{ p: 0, count: 1, party: [STARTER] }, { p: 0x40000, count: 2, party: [STARTER, CATCH] }]));
  assert.ok(await until(() => last() === '390,399'));
  // 3) through a temp file swapped in (a rename over the old one)
  const tmp = join(dir, 'p1.sav.tmp');
  writeFileSync(tmp, sinnohSave('pt', [{ p: 0, count: 3, party: [CATCH] }, { p: 0x40000, count: 2, party: [STARTER, CATCH] }]));
  renameSync(tmp, sav);
  assert.ok(await until(() => last() === '399'));
  // 4) in two pieces (the first half written, the second a moment later): never read halfway – the half holds the
  // older partition, which passes every check
  const next = sinnohSave('pt', [{ p: 0, count: 3, party: [CATCH] }, { p: 0x40000, count: 4, party: [CATCH, STARTER] }]);
  writeFileSync(sav, next.subarray(0, 0x40000));
  await sleep(20);
  writeFileSync(sav, next);
  assert.ok(await until(() => last() === '399,390'));
  await sleep(500);
  assert.deepEqual(teams(), ['390', '390,399', '399', '399,390'], 'never another team in between');
  // 5) the same bytes again (melonDS flushing an unchanged save): nothing new
  const n = saves().length;
  writeFileSync(sav, next);
  await sleep(600);
  assert.equal(saves().length, n);
  assert.equal(events.filter((e) => e.ev === 'save-error').length, 0);
});

test('melonDS with its own save folder: the newest of the places is read; a save it can\'t read says why', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'souldew-savewatch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const next = join(dir, 'run', 'p1.sav');
  const own = join(dir, 'melon saves', 'p1.sav');
  mkdirSync(join(dir, 'run'));
  mkdirSync(join(dir, 'melon saves'));
  writeFileSync(next, sinnohSave('pt', [{ p: 0, count: 1, party: [STARTER] }]));
  const old = new Date(Date.now() - 60000);
  utimesSync(next, old, old); // (the save the built-in player left there before)
  const { w, events, last } = watcherFor(dir);
  t.after(() => w.unwatch('r1'));
  w.watch('r1', [next, own]);
  assert.ok(await until(() => last() === '390'));
  assert.deepEqual(w.paths('r1'), [next, own]);
  // melonDS saves into its own folder: that file is newer – it is the one read, and the status names it
  writeFileSync(own, sinnohSave('pt', [{ p: 0, count: 2, party: [STARTER, CATCH] }]));
  assert.ok(await until(() => last() === '390,399'));
  assert.equal(w.status('r1').path, own);
  // a file that isn't a save of this game: an error after a few tries (a write in progress gets them), with its code
  writeFileSync(own, new Uint8Array(0x80000).fill(0x55));
  assert.ok(await until(() => events.some((e) => e.ev === 'save-error')));
  assert.equal(events.find((e) => e.ev === 'save-error').data.code, 'saveNotFound');
  assert.equal(w.status('r1').errorCode, 'saveNotFound');
});

// fs.watchFile (what the watcher used) takes what it compares against from its first stat, which runs later on libuv's
// thread pool: a save written between watch() and that stat became the baseline and was never reported – the test
// above failed every time in a busy full test run. The thread pool is kept busy here, so that stat comes late.
test('a save written the moment the watch starts (a busy moment) is still read – a new file and a changed one', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'souldew-savewatch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const busy = () => {
    const jobs = [];
    for (let i = 0; i < Number(process.env.UV_THREADPOOL_SIZE || 4); i++) jobs.push(new Promise((r) => pbkdf2('souldew', 'busy', 200000, 64, 'sha512', r)));
    return Promise.all(jobs);
  };
  // 1) melonDS's own folder has no save yet; the first one is written right after the watch starts
  const own = join(dir, 'melon saves', 'p1.sav');
  mkdirSync(join(dir, 'melon saves'));
  const a = watcherFor(dir);
  t.after(() => a.w.unwatch('r1'));
  let pool = busy();
  a.w.watch('r1', [join(dir, 'p1.sav'), own]);
  writeFileSync(own, sinnohSave('pt', [{ p: 0, count: 1, party: [STARTER] }]));
  await pool;
  assert.ok(await until(() => a.last() === '390'), 'the save that appeared is read');
  assert.equal(a.w.status('r1').path, own);
  // 2) an existing save (read when the watch starts) saved over right after
  const sav = join(dir, 'p2.sav');
  writeFileSync(sav, sinnohSave('pt', [{ p: 0, count: 1, party: [STARTER] }]));
  const old = new Date(Date.now() - 60000);
  utimesSync(sav, old, old);
  const b = watcherFor(dir);
  t.after(() => b.w.unwatch('r2'));
  pool = busy();
  b.w.watch('r2', sav);
  assert.equal(b.last(), '390');
  writeFileSync(sav, sinnohSave('pt', [{ p: 0, count: 2, party: [STARTER, CATCH] }]));
  await pool;
  assert.ok(await until(() => b.last() === '390,399'), 'the save written over it is read');
  // nothing is watched anymore once unwatched: a later save isn't read
  b.w.unwatch('r2');
  const n = b.saves().length;
  writeFileSync(sav, sinnohSave('pt', [{ p: 0, count: 3, party: [CATCH] }]));
  await sleep(400);
  assert.equal(b.saves().length, n);
});

test('melonDS\'s settings: the save folder from melonDS.toml (1.x, per instance) or melonDS.ini (0.9.x)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'souldew-melonconf-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const toml = join(dir, 'melonDS.toml');
  writeFileSync(toml, '[Instance0]\nSaveFilePath = "C:\\\\Users\\\\Ana\\\\Saves"\nSavestatePath = ""\n\n[Instance1]\nSaveFilePath = ""\n');
  assert.deepEqual(melonSaveDirs([toml]), ['C:\\Users\\Ana\\Saves']);
  const ini = join(dir, 'melonDS.ini');
  writeFileSync(ini, 'SavestatePath=\nSaveFilePath=/home/ana/ds saves\r\nCheatFilePath=\n');
  assert.deepEqual(melonSaveDirs([ini]), ['/home/ana/ds saves']);
  writeFileSync(toml, '[Instance0]\nSaveFilePath = "saves"\n');
  assert.deepEqual(melonSaveDirs([toml]), [join(dir, 'saves')], 'relative: from melonDS\'s config folder');
  // "next to the ROM" (empty) in the config melonDS uses: no other folder – a config further down the list doesn't count
  writeFileSync(toml, '[Instance0]\nSaveFilePath = ""\n');
  assert.deepEqual(melonSaveDirs([toml, ini]), []);
  assert.deepEqual(melonSaveDirs([join(dir, 'missing.toml'), ini]), ['/home/ana/ds saves']);
  // where melonDS keeps its config: next to a portable program first, then the user's config folder
  const win = melonConfigFiles({ exePath: 'C:\\melonDS\\melonDS.exe', platform: 'win32', env: { APPDATA: 'C:\\Users\\Ana\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Ana\\AppData\\Local' } });
  assert.ok(win[0].endsWith('melonDS.toml') && win[0].startsWith('C:\\melonDS'), win[0]);
  assert.ok(win.some((f) => f.includes('AppData')));
  const mac = melonConfigFiles({ exePath: '/Applications/melonDS.app', platform: 'darwin', env: { HOME: '/Users/ana' } });
  assert.deepEqual(mac, ['/Users/ana/Library/Preferences/melonDS/melonDS.toml', '/Users/ana/Library/Preferences/melonDS/melonDS.ini']);
});

test('a Platinum save from melonDS reaches the run: the team, and a catch filed under its area (as the page applies it)', async () => {
  const { registerHooks } = await import('node:module');
  const ROOT = new URL('../', import.meta.url).href;
  registerHooks({ resolve: (spec, ctx, next) => (spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx)) });
  const { RunDoc } = await import('../web/lib/doc.mjs');
  const R = await import('../web/lib/run.mjs');
  const PT = { id: 'ptsav', mode: 'soullink', game: { id: 'pokemon-platinum', code: 'CPUE', system: 'nds' }, players: { p1: { name: 'Ana' }, p2: { name: 'Ben' } } };
  const d = new RunDoc('t');
  d.by = 'a';
  d._persistSoon = () => {};
  const read = (sav) => R.snapshotFromSave(readSaveFile(entry('CPUE'), sav, T));
  R.applySnapshot(d, PT, 4, 'p1', read(sinnohSave('pt', [{ p: 0, count: 1, party: [STARTER] }])));
  assert.deepEqual(R.live(d, 'p1').party.map((m) => m.species), [390]);
  // saved again after catching a Bidoof on Route 202 (met location 17)
  const res = R.applySnapshot(d, PT, 4, 'p1', read(sinnohSave('pt', [{ p: 0, count: 1, party: [STARTER] }, { p: 0x40000, count: 2, party: [STARTER, CATCH], storageCount: null }])));
  assert.deepEqual(R.live(d, 'p1').party.map((m) => m.species), [390, 399]);
  assert.deepEqual(res.newCatches, ['m4-17']);
  assert.equal(d.get('enc:m4-17:p1').species, 399);
  // a save whose PC block is nowhere valid: the PC is unknown (null), not empty
  const noPc = readSaveFile(entry('CPUE'), sinnohSave('pt', [{ p: 0, count: 1, party: [STARTER], storageCount: null }]), T);
  assert.equal(noPc.boxes, null);
  assert.equal(R.snapshotFromSave(noPc).boxes, null);
});

// #43: a new game prepares its flash during the intro (Blaze Black 2 Redux, Black 2: the fast player hands souldew a
// battery save half a minute in) – that file holds no save yet, and "Save file unreadable" at the intro of every new
// run only alarmed players. A save that was readable and then isn't, or one that was there when the watch started and
// can't be read, still says so.
test('a new game\'s prepared flash (no save in it yet) is no error message; the first in-game save is read as always', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'souldew-savewatch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sav = join(dir, 'p1.sav');
  const { w, events, last } = watcherFor(dir);
  t.after(() => w.unwatch('r1'));
  w.watch('r1', sav);
  const prepared = new Uint8Array(0x80000).fill(0xff);
  prepared.fill(0, 0x100, 0x400); // (not blank: the game wrote something, but no block passes)
  writeFileSync(sav, prepared);
  assert.ok(await until(() => w.status('r1').errorCode === 'saveNotFound'), 'read, and why it holds no save is in the status');
  await sleep(300);
  assert.equal(events.filter((e) => e.ev === 'save-error').length, 0, 'no message');
  writeFileSync(sav, sinnohSave('pt', [{ p: 0, count: 1, party: [STARTER] }]));
  assert.ok(await until(() => last() === '390'), 'the first in-game save');
  assert.equal(w.status('r1').error, null);
  // readable before, unreadable now: said
  writeFileSync(sav, prepared);
  assert.ok(await until(() => events.some((e) => e.ev === 'save-error')));
  // a file there from the start that holds no save (a broken save of an older session): said too
  const dir2 = mkdtempSync(join(tmpdir(), 'souldew-savewatch-'));
  t.after(() => rmSync(dir2, { recursive: true, force: true }));
  const sav2 = join(dir2, 'p1.sav');
  writeFileSync(sav2, prepared);
  const b = watcherFor(dir2);
  t.after(() => b.w.unwatch('r2'));
  b.w.watch('r2', sav2);
  assert.ok(await until(() => b.events.some((e) => e.ev === 'save-error')));
});
