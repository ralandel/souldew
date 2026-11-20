// Importing and exporting battery saves (a player on Discord: "can I import my old .sav?"): the formats and sizes per
// system, DeSmuME's footer, the clock footers, which game a save is from, the backup and the one Undo, the 3DS backup
// folders, and the run's rules – what an imported save brings along never counts (tracking, trophies), a SoulLink needs
// the host's rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import { registerHooks } from 'node:module';
import * as S from '../shared/savefile.mjs';
import { crc16ccitt } from '../shared/gen4save.mjs';
import * as I from '../server/lib/saveimport.mjs';
import * as Tr from '../shared/trophies.mjs';
import { DEFAULT_RULES } from '../shared/rules.mjs';
import { SOULLINK_RULE_KEYS } from '../shared/hostrules.mjs';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '/vendor/htm-preact.mjs') return next(ROOT + 'node_modules/htm/preact/standalone.module.js', ctx);
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const { RunDoc } = await import('../web/lib/doc.mjs');
const R = await import('../web/lib/run.mjs');

const KB = 1024;
const tmp = () => mkdtempSync(join(tmpdir(), 'sls-saveimport-'));
const fill = (n, v = 0) => new Uint8Array(n).fill(v);
const w32 = (u8, o, v) => { u8[o] = v & 0xff; u8[o + 1] = (v >>> 8) & 0xff; u8[o + 2] = (v >>> 16) & 0xff; u8[o + 3] = (v >>> 24) & 0xff; };
const w16 = (u8, o, v) => { u8[o] = v & 0xff; u8[o + 1] = (v >>> 8) & 0xff; };

// ---- saves made by hand, laid out as the games lay them out ------------------------------------------------------
function gen1Save() {
  const u8 = fill(32 * KB);
  for (let i = 0x2598; i < 0x3523; i++) u8[i] = (i * 7) & 0xff;
  let s = 0;
  for (let i = 0x2598; i < 0x3523; i++) s += u8[i];
  u8[0x3523] = (~s) & 0xff;
  return u8;
}
function crystalSave() {
  const u8 = fill(32 * KB);
  for (let i = 0x2009; i < 0x2b83; i++) u8[i] = (i * 3) & 0xff;
  let s = 0;
  for (let i = 0x2009; i < 0x2b83; i++) s += u8[i];
  w16(u8, 0x2d0d, s & 0xffff);
  return u8;
}
function gsSave() {
  const u8 = fill(32 * KB);
  for (let i = 0x2009; i < 0x2d69; i++) u8[i] = (i * 5) & 0xff;
  let s = 0;
  for (let i = 0x2009; i < 0x2d69; i++) s += u8[i];
  w16(u8, 0x2d69, s & 0xffff);
  return u8;
}
/** Gen 3: both slots of 14 signed sections; section 0's game code at 0xAC (0 R/S, 1 FR/LG, else Emerald). */
function gen3Save(code) {
  const u8 = fill(128 * KB, 0xff);
  for (const [slot, index] of [[0, 4], [0xe000, 3]]) {
    for (let i = 0; i < 14; i++) {
      const o = slot + i * 0x1000;
      u8.fill(0, o, o + 0xff4);
      w16(u8, o + 0xff4, (i + 3) % 14); // (the sections are rotated in a real save)
      w32(u8, o + 0xff8, 0x08012025);
      w32(u8, o + 0xffc, index);
      if ((i + 3) % 14 === 0) w32(u8, o + 0xac, code);
    }
  }
  return u8;
}
/** Gen 4: the General block (its size, a magic number and a CRC16 in the footer) in the first half. */
function gen4Save(size = 0xf628, foot = 0x10) {
  const u8 = fill(512 * KB, 0xff);
  u8.fill(0x11, 0, size - foot);
  w32(u8, size - 0x0c, size);
  w32(u8, size - 0x08, 0x20060623);
  w16(u8, size - 0x02, crc16ccitt(u8, 0, size - foot));
  return u8;
}
/** DeSmuME's .dsv: the data DeSmuME counted (up to the last byte written), its footer and cookie (web/player.html toDsv). */
function dsv(raw, counted = raw.length) {
  const txt = new TextEncoder().encode('|<--Snip above here to create a raw sav by excluding this DeSmuME savedata footer:');
  const cookie = new TextEncoder().encode('|-DESMUME SAVE-|');
  const out = new Uint8Array(counted + txt.length + 24 + cookie.length);
  out.set(raw.subarray(0, counted), 0);
  out.set(txt, counted);
  const dv = new DataView(out.buffer);
  [counted, counted, 3, 3, raw.length, 0].forEach((v, i) => dv.setUint32(counted + txt.length + i * 4, v, true));
  out.set(cookie, out.length - cookie.length);
  return out;
}
/** A zip of [{ name, data }] (deflated) – what a player zips a save into. */
function zipOf(files) {
  const parts = [];
  const cds = [];
  let offset = 0;
  for (const { name, data } of files) {
    const comp = deflateRawSync(Buffer.from(data));
    const nb = Buffer.from(name);
    const crc = crc32(Buffer.from(data));
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nb.length, 28); cd.writeUInt32LE(offset, 42);
    parts.push(lh, nb, comp);
    cds.push(cd, nb);
    offset += 30 + nb.length + comp.length;
  }
  const cdBuf = Buffer.concat(cds);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

// ---- formats and sizes --------------------------------------------------------------------------------------------
test('sizes: every cartridge size of a system goes in, anything else is refused with the sizes there are', () => {
  for (const [sys, sizes] of Object.entries({ gb: [512, 2 * KB, 8 * KB, 32 * KB, 64 * KB, 128 * KB], gba: [512, 8 * KB, 32 * KB, 64 * KB, 128 * KB], nds: [512, 8 * KB, 64 * KB, 256 * KB, 512 * KB, 1024 * KB] })) {
    for (const n of sizes) {
      const u8 = fill(n, 0xff);
      u8[1] = 0x42;
      assert.equal(S.normalizeSave(u8, sys).size, n, `${sys} ${n}`);
    }
  }
  for (const [sys, n] of [['gb', 31 * KB], ['gba', 100 * KB], ['gba', 256 * KB], ['nds', 100], ['nds', 2048 * KB], ['gbc', 33 * KB]]) {
    const u8 = fill(n, 0x42);
    u8[0] = 1;
    assert.throws(() => S.normalizeSave(u8, sys), (e) => e.code === 'saveImportSize' && e.vars.sizes.includes('KB') && e.vars.bytes === n, `${sys} ${n}`);
  }
  assert.throws(() => S.normalizeSave(new Uint8Array(0), 'gba'), (e) => e.code === 'saveImportEmpty');
  assert.throws(() => S.normalizeSave(fill(128 * KB, 0xff), 'gba'), (e) => e.code === 'saveImportEmpty', 'a never-written cartridge is no save');
  assert.throws(() => S.normalizeSave(fill(32 * KB, 1), '3ds'), (e) => e.code === 'saveImportSystem');
  const nocash = new Uint8Array(4096);
  nocash.set(new TextEncoder().encode('NocashGbaBackupMediaSavDataFile'));
  assert.throws(() => S.normalizeSave(nocash, 'nds'), (e) => e.code === 'saveImportNocash');
});

test('.dsv: DeSmuME’s footer comes off, a save it counted short is padded to the chip as erased flash', () => {
  const raw = gen4Save();
  const full = S.normalizeSave(dsv(raw), 'nds');
  assert.equal(full.from, 'dsv');
  assert.deepEqual(full.notes, ['dsv']);
  assert.equal(full.size, 512 * KB);
  assert.deepEqual(full.bytes, raw);
  // a fresh HeartGold save: DeSmuME counted 256 KB + 1 of the 512 KB chip
  const shortRaw = raw.slice();
  shortRaw.fill(0xff, 256 * KB + 1);
  const short = S.normalizeSave(dsv(shortRaw, 256 * KB + 1), 'nds');
  assert.equal(short.size, 512 * KB);
  assert.deepEqual(short.bytes, shortRaw);
  assert.ok(S.isDsv(dsv(raw)) && !S.isDsv(raw));
  // the same save as a raw file cut short (DeSmuME's raw export, an older souldew): padded the same way
  const cut = S.normalizeSave(shortRaw.slice(0, 256 * KB + 1), 'nds');
  assert.deepEqual([cut.size, cut.notes], [512 * KB, ['padded']]);
  assert.deepEqual(cut.bytes, shortRaw);
  assert.equal(S.saveFamily(full.bytes, 'nds'), 'hgss', 'the game is still recognised behind the footer');
});

test('Game Boy clock footers: 48 bytes kept, the older 44-byte one widened, dropped for a game without a clock', () => {
  const base = crystalSave();
  const foot48 = new Uint8Array(48);
  foot48[0] = 12; foot48[4] = 34; w32(foot48, 40, 1700000000);
  const with48 = new Uint8Array([...base, ...foot48]);
  const k = S.normalizeSave(with48, 'gbc', { clock: true });
  assert.deepEqual(k.notes, ['clockKept']);
  assert.deepEqual(k.bytes, with48);
  const foot44 = new Uint8Array(44);
  foot44[0] = 12; w32(foot44, 40, 1700000000);
  const w = S.normalizeSave(new Uint8Array([...base, ...foot44]), 'gbc');
  assert.deepEqual(w.notes, ['clockWidened']);
  assert.equal(w.size, 32 * KB + 48);
  assert.equal(new DataView(w.bytes.buffer).getUint32(32 * KB + 40, true), 1700000000, 'the time is the low half of the u64');
  assert.equal(new DataView(w.bytes.buffer).getUint32(32 * KB + 44, true), 0);
  const red = S.normalizeSave(new Uint8Array([...gen1Save(), ...foot48]), 'gb', { clock: false });
  assert.deepEqual(red.notes, ['clockDropped']);
  assert.equal(red.size, 32 * KB);
});

test('mGBA’s clock record behind a GBA save goes; a flash cart’s blank padding past the game’s size goes', () => {
  const fr = gen3Save(1);
  const withRtc = new Uint8Array([...fr, ...fill(16, 7)]);
  const n = S.normalizeSave(withRtc, 'gba');
  assert.deepEqual(n.notes, ['gbaClockDropped']);
  assert.deepEqual(n.bytes, fr);
  // a DS flash cart padding HeartGold's 512 KB to 1 MB
  const padded = new Uint8Array(1024 * KB).fill(0xff);
  padded.set(gen4Save());
  const p = S.normalizeSave(padded, 'nds', { expected: 512 * KB });
  assert.deepEqual(p.notes, ['padTrimmed']);
  assert.equal(p.size, 512 * KB);
  // …but not when there is data past it
  padded[700 * KB] = 1;
  assert.equal(S.normalizeSave(padded, 'nds', { expected: 512 * KB }).size, 1024 * KB);
});

// ---- which game ---------------------------------------------------------------------------------------------------
test('which game a save is from: Gen 1/2 sums, the Gen 3 signature and game code, the Gen 4 block footers', () => {
  assert.equal(S.saveFamily(gen1Save(), 'gb'), 'gen1');
  assert.equal(S.saveFamily(crystalSave(), 'gbc'), 'crystal');
  assert.equal(S.saveFamily(gsSave(), 'gbc'), 'gs');
  assert.equal(S.saveFamily(gen3Save(0), 'gba'), 'rs');
  assert.equal(S.saveFamily(gen3Save(1), 'gba'), 'frlg');
  assert.equal(S.saveFamily(gen3Save(0x5a3c91e7), 'gba'), 'e');
  assert.equal(S.saveFamily(gen4Save(), 'nds'), 'hgss');
  assert.equal(S.saveFamily(gen4Save(0xcf2c, 0x14), 'nds'), 'pt');
  assert.equal(S.saveFamily(gen4Save(0xc100, 0x14), 'nds'), 'dp');
  assert.equal(S.saveFamily(fill(32 * KB, 3), 'gb'), null);
  for (const [id, f] of [['pokemon-red', 'gen1'], ['pokemon-blue-de', 'gen1'], ['pokemon-crystal-de', 'crystal'], ['pokemon-gold', 'gs'], ['pokemon-firered-de', 'frlg'],
    ['pokemon-emerald', 'e'], ['pokemon-ruby', 'rs'], ['pokemon-omega-ruby', 'oras'], ['pokemon-heartgold-eu', 'hgss'], ['pokemon-black-2', 'b2w2'], ['pokemon-white', 'bw'],
    ['pokemon-green-jp', null], ['pokemon-ultra-sun', 'usum'], [null, null]]) assert.equal(S.familyOfGame(id), f, String(id));
});

test('the game check: a match, another game’s save (warned – the player may go on), unknown, a size the game doesn’t write', () => {
  assert.equal(S.checkSaveForGame(gen3Save(1), 'gba', 'pokemon-firered').verdict, 'match');
  const m = S.checkSaveForGame(gen3Save(0x1234), 'gba', 'pokemon-firered');
  assert.deepEqual([m.verdict, m.found, m.want], ['mismatch', 'e', 'frlg']);
  assert.equal(S.checkSaveForGame(gen1Save(), 'gbc', 'pokemon-crystal').verdict, 'mismatch', 'a Red save into Crystal');
  assert.equal(S.checkSaveForGame(gen4Save(), 'nds', 'pokemon-diamond').verdict, 'mismatch');
  assert.equal(S.checkSaveForGame(gen4Save(), 'nds', 'pokemon-soulsilver').verdict, 'match');
  assert.equal(S.checkSaveForGame(gen4Save(), 'nds', null).verdict, 'unknown', 'a hack: the size check only');
  assert.equal(S.checkSaveForGame(fill(32 * KB, 9), 'gb', 'pokemon-red').verdict, 'unknown');
  const small = gen3Save(1).slice(0, 64 * KB);
  assert.notEqual(S.checkSaveForGame(small, 'gba', 'pokemon-firered').verdict, 'match');
  assert.equal(S.checkSaveForGame(new Uint8Array([...crystalSave(), ...fill(48, 1)]), 'gbc', 'pokemon-crystal').verdict, 'match', 'with its clock');
  // the server's check: normalized, then checked
  const c = I.checkImport(dsv(gen4Save()), { system: 'nds', gameId: 'pokemon-heartgold' });
  assert.deepEqual([c.from, c.size, c.check.verdict], ['dsv', 512 * KB, 'match']);
  assert.throws(() => I.checkImport(fill(1000, 1), { system: 'gba', gameId: 'pokemon-emerald' }), (e) => e.status === 422 && e.code === 'saveImportSize');
});

// ---- backup and Undo ----------------------------------------------------------------------------------------------
test('import: the old save is backed up before anything is written; Undo puts it back once, keeping what was played since', () => {
  const dir = tmp();
  const path = join(dir, 'game.sav');
  const backups = join(dir, 'backups');
  writeFileSync(path, Buffer.from('old save'));
  const r = I.replaceSave({ path, bytes: Buffer.from('new save'), backupDir: backups, key: 'p1', name: 'Emerald.sav', now: Date.UTC(2026, 10, 1) });
  assert.equal(r.replaced, true);
  assert.equal(readFileSync(path, 'utf8'), 'new save');
  assert.equal(readFileSync(join(backups, r.backup), 'utf8'), 'old save');
  assert.ok(readdirSync(backups).some((n) => /imported\.sav$/.test(n)), 'the imported file is kept too');
  assert.deepEqual(I.lastImport(backups, 'p1').name, 'Emerald.sav');
  // played since: the save changed – Undo still goes back, and keeps what was played as a backup
  writeFileSync(path, Buffer.from('played on'));
  const u = I.undoImport({ path, backupDir: backups, key: 'p1' });
  assert.deepEqual([u.restored, u.playedSince], [true, true]);
  assert.equal(readFileSync(path, 'utf8'), 'old save');
  assert.ok(readdirSync(backups).some((n) => n.endsWith('-undone.sav') && readFileSync(join(backups, n), 'utf8') === 'played on'));
  assert.throws(() => I.undoImport({ path, backupDir: backups, key: 'p1' }), (e) => e.code === 'noImportToUndo', 'once');
  rmSync(dir, { recursive: true, force: true });
});

test('import into a game without a save: Undo removes it again; other saves’ backups in the folder are never touched', () => {
  const dir = tmp();
  const path = join(dir, 'p2.sav');
  const backups = join(dir, 'backups');
  mkdirSync(backups);
  writeFileSync(join(backups, '2026-01-01.sav'), 'graveyard backup'); // (the graveyard's, server/app.mjs)
  const r = I.replaceSave({ path, bytes: Buffer.from('fresh'), backupDir: backups, key: 'p2' });
  assert.equal(r.backup, null);
  const u = I.undoImport({ path, backupDir: backups, key: 'p2' });
  assert.deepEqual([u.restored, u.removed], [false, true]);
  assert.equal(existsSync(path), false);
  // many imports: only this save's oldest import backups go
  for (let i = 0; i < 20; i++) I.replaceSave({ path, bytes: Buffer.from(`v${i}`), backupDir: backups, key: 'p2', now: Date.UTC(2026, 0, 1, 0, i) });
  assert.ok(I.importBackups(backups, 'p2').length <= I.KEEP_BACKUPS + 1, '(+ the save from before the first import)');
  assert.ok(existsSync(join(backups, '2026-01-01.sav')));
  rmSync(dir, { recursive: true, force: true });
});

test('file errors: a locked file, a full or failing disk, anything else – each with its code and a detail for the diagnostics line', () => {
  const e = (code) => Object.assign(new Error(code), { code });
  assert.deepEqual([I.fsFailure(e('EBUSY')).code, I.fsFailure(e('EBUSY')).status], ['saveFileLocked', 423]);
  assert.equal(I.fsFailure(e('EPERM')).code, 'saveFileLocked');
  assert.equal(I.fsFailure(e('EACCES'), 'backup').vars.what, 'backup');
  assert.equal(I.fsFailure(e('ENOSPC')).code, 'saveDiskProblem');
  assert.equal(I.fsFailure(e('EIO')).code, 'saveDiskProblem');
  assert.deepEqual([I.fsFailure(e('EXDEV')).code, I.fsFailure(e('EXDEV')).vars.detail], ['saveWriteFailed', 'EXDEV']);
  // a folder where the save should be: written nowhere, the old one is untouched
  const dir = tmp();
  mkdirSync(join(dir, 'game.sav'));
  assert.throws(() => I.replaceSave({ path: join(dir, 'game.sav'), bytes: Buffer.from('x'), backupDir: join(dir, 'b'), key: 'k' }), (x) => x.status >= 400 && /^save/.test(x.code));
  rmSync(dir, { recursive: true, force: true });
});

test('a zip with one save in it is read; one with several is refused', () => {
  const dir = tmp();
  const fr = gen3Save(1);
  const one = I.unzipSingleSave(zipOf([{ name: 'saves/FireRed.sav', data: fr }, { name: 'readme.txt', data: Buffer.from('hi') }]), dir);
  assert.equal(one.name, 'FireRed.sav');
  assert.deepEqual(new Uint8Array(one.bytes), fr);
  assert.throws(() => I.unzipSingleSave(zipOf([{ name: 'a.sav', data: fr }, { name: 'b.sav', data: fr }]), dir), (e) => e.code === 'saveImportZip');
  const plain = Buffer.from(fr);
  assert.equal(I.unzipSingleSave(plain, dir).bytes, plain, 'not a zip: as it is');
  rmSync(dir, { recursive: true, force: true });
});

// ---- 3DS ----------------------------------------------------------------------------------------------------------
test('3DS: a Checkpoint backup (zipped with its folders) goes into the save folder the game made; Undo puts the old one back', () => {
  const parsed = S.ctrImportFiles([{ path: 'Checkpoint/saves/0x00055 X/20260101-1200/main', bytes: fill(0x65600, 3) }, { path: 'Checkpoint/saves/0x00055 X/20260101-1200/.DS_Store', bytes: fill(4, 1) }]);
  assert.deepEqual(parsed.files.map((f) => f.path), ['main']);
  assert.equal(parsed.family, 'xy');
  assert.throws(() => S.ctrImportFiles([{ path: '../evil/main', bytes: fill(10, 1) }]), (e) => e.code === 'saveImportFormat');
  assert.throws(() => S.ctrImportFiles([{ path: 'a/main', bytes: fill(0x65600, 0xff) }]), (e) => e.code === 'saveImportEmpty');
  const dir = tmp();
  const root = join(dir, 'Azahar', 'sdmc', 'Nintendo 3DS');
  const archive = join(root, '0'.repeat(32), '0'.repeat(32), 'title', '00040000', '00055d00', 'data', '00000001');
  const backups = join(dir, 'backups');
  // not started yet: nothing to replace
  assert.equal(I.ctrSaveArchives(root, ['0004000000055D00']).length, 0);
  assert.throws(() => I.replaceCtrSave({ archive: null, files: parsed.files, backupDir: backups, key: 'k' }), (e) => e.code === 'ctrSaveNotStarted');
  mkdirSync(archive, { recursive: true });
  writeFileSync(join(archive, 'main'), 'old main');
  writeFileSync(join(archive, 'extra'), 'old extra');
  assert.deepEqual(I.ctrSaveArchives(root, ['0004000000055D00']), [archive]);
  assert.equal(I.ctrSaveArchives(root, ['000400000011C400']).length, 0, 'another game’s title');
  const check = I.checkCtrImport([{ path: 'X/main', bytes: fill(0x65600, 3) }], { archive, gameId: 'pokemon-x' });
  assert.deepEqual([check.verdict, check.missing], ['match', ['extra']]);
  assert.equal(I.checkCtrImport([{ path: 'main', bytes: fill(0x76000, 3) }], { archive, gameId: 'pokemon-x' }).verdict, 'mismatch', 'an ORAS save into X');
  I.replaceCtrSave({ archive, files: check.files, backupDir: backups, key: 'k' });
  assert.deepEqual(readdirSync(archive), ['main']);
  assert.equal(readFileSync(join(archive, 'main')).length, 0x65600);
  I.undoCtrImport({ archive, backupDir: backups, key: 'k' });
  assert.deepEqual(readdirSync(archive).sort(), ['extra', 'main']);
  assert.equal(readFileSync(join(archive, 'main'), 'utf8'), 'old main');
  assert.throws(() => I.undoCtrImport({ archive, backupDir: backups, key: 'k' }), (e) => e.code === 'noImportToUndo');
  rmSync(dir, { recursive: true, force: true });
});

// ---- the run's rules ----------------------------------------------------------------------------------------------
function mkDoc() {
  const d = new RunDoc('t');
  d.by = 'a';
  d._persistSoon = () => {};
  return d;
}
const mon = (key, species, level, extra = {}) => ({ key, species, level, hp: 20, maxHp: 20, metLocation: 16, metLevel: level, ...extra });

test('rules: a Nuzlocke may import, a SoulLink only with the host’s rule – a new rule, off by default, signed with the others', () => {
  assert.equal(DEFAULT_RULES.saveImports, false);
  assert.ok(SOULLINK_RULE_KEYS.includes('saveImports'));
  const d = mkDoc();
  const solo = { id: 'r1', mode: 'nuzlocke', game: { system: 'gba', id: 'pokemon-firered' }, players: { p1: { name: 'A' } } };
  const link = { id: 'r2', game: { system: 'gba', id: 'pokemon-firered' }, players: { p1: { name: 'A' }, p2: { name: 'B' } } };
  assert.deepEqual(R.canImportSave(d, solo), { ok: true });
  assert.deepEqual(R.canImportSave(d, link), { ok: false, reason: 'host' });
  d.set('rules', { ...DEFAULT_RULES, saveImports: true });
  assert.equal(R.canImportSave(d, link).ok, true);
  // the import and its undo go into the log, with an English text older partners show
  R.logSaveImport(d, link, 'p2');
  R.logSaveImport(d, link, 'p2', { undo: true });
  const lines = R.feedList(d).filter((f) => f.type === 'saveImport');
  assert.equal(lines.length, 2);
  assert.ok(lines.every((f) => f.slot === 'p2' && f.text && f.msg?.def));
  assert.ok(lines.some((f) => f.undo));
});

test('tracking after an import: the save’s Pokémon are set aside, its badges are no news, tracked ones are updated quietly', () => {
  const d = mkDoc();
  const M = { id: 'r1', mode: 'nuzlocke', game: { system: 'gba', id: 'pokemon-firered', code: 'BPRE' }, players: { p1: { name: 'A' } } };
  const starter = mon('g3-a', 4, 5, { metLocation: 0 });
  R.applySnapshot(d, M, 3, 'p1', { source: 'live', party: [starter], badges: 1 });
  assert.equal(R.encounter(d, 'starter', 'p1').species, 4);
  const feedBefore = R.feedList(d).length;
  // the import: marker first, then the save – the game shows a finished team, 8 badges, the starter evolved
  R.markSaveImport(d, 'p1');
  const t0 = Date.now();
  const first = R.applySnapshot(d, M, 3, 'p1', { source: 'live', party: [mon('g3-a', 6, 70), mon('g3-x', 150, 70), mon('g3-y', 249, 60)], badges: 8 });
  assert.deepEqual([first.newCatches, first.inbox, first.deaths], [[], [], []]);
  assert.equal(d.get('ign:p1:g3-x').reason, 'imported');
  assert.equal(d.get('ign:p1:g3-y').reason, 'imported');
  assert.equal(R.encounter(d, 'starter', 'p1').species, 6, 'brought up to date (the level once a second look confirms the jump)');
  assert.equal(R.feedList(d).length, feedBefore, 'no evolution, no catch, no badge in the log');
  assert.ok(d.get('simport:p1').since >= t0 && !d.get('simport:p1').done, 'the PC wasn’t read yet');
  // the PC arrives: still the save's – then the window closes
  R.applySnapshot(d, M, 3, 'p1', { source: 'live', party: [mon('g3-a', 6, 70)], boxes: [mon('g3-z', 144, 50)], badges: 8 });
  assert.equal(d.get('ign:p1:g3-z').reason, 'imported');
  assert.equal(R.encounter(d, 'starter', 'p1').level, 70);
  assert.equal(d.get('simport:p1').done, true);
  // from here on a real catch and a real badge count again
  const later = R.applySnapshot(d, M, 3, 'p1', { source: 'live', party: [mon('g3-a', 6, 70), mon('g3-new', 16, 3, { metLocation: 101 })], boxes: [mon('g3-z', 144, 50)], badges: 9 });
  assert.equal(later.newCatches.length + later.inbox.length, 1);
  assert.ok(R.feedList(d).some((f) => f.type === 'badge' && f.msg?.vars?.n === 9));
  // a failed import takes its marker back
  R.markSaveImport(d, 'p1');
  R.markSaveImport(d, 'p1', { clear: true });
  assert.equal(d.get('simport:p1', null), null);
  // the window also ends by time for a game whose PC isn't read
  d.set('simport:p1', { at: 1, since: Date.now() - R.IMPORT_WINDOW - 1 });
  assert.equal(R.importBaseline(d, 'p1', { party: [1] }).writes['simport:p1'].done, true);
});

// ---- trophies -----------------------------------------------------------------------------------------------------
const T0 = Date.UTC(2026, 9, 1, 12);
const docOf = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { v, t: 1, by: 'a' }]));
test('trophies: a run with an imported save earns nothing for winning, counts only badges seen earned, no level records', () => {
  const run = (extra = {}) => ({ id: 'aaaa0009', name: 'R', mode: 'nuzlocke', createdAt: new Date(T0).toISOString(), players: { p1: { name: 'A' } }, game: { id: 'pokemon-firered', system: 'gba' }, ...extra });
  const entries = docOf({
    'enc:starter:p1': { outcome: 'caught', species: 6, level: 100, metLevel: 5, at: T0 + 1 },
    'feed:a': { type: 'catch', slot: 'p1', area: 'starter', species: 4, at: T0 + 1 },
    'feed:b': { type: 'badge', slot: 'p1', at: T0 + 5, msg: { vars: { n: 1 } } },
    'live:p1': { badges: 8, party: [{ species: 6, level: 100 }] },
    'run:status': { state: 'won', at: T0 + 100, by: 'p1' },
  });
  const honest = Tr.digestRun(run(), entries, 'p1');
  const imported = Tr.digestRun(run({ saveImports: { p1: [{ at: T0 + 50 }] } }), entries, 'p1');
  assert.equal(honest.badges, 8);
  assert.equal(imported.badges, 1, 'only the badge seen earned');
  assert.equal(imported.imported, true);
  const ev = (d) => Object.fromEntries(Tr.evaluate(Tr.context([d])).map((s) => [s.id, s]));
  assert.ok(ev(honest).firstWin.ok && ev(honest).level100.ok && ev(honest).badges8.ok);
  assert.ok(!ev(imported).firstWin.ok && !ev(imported).winNuzlocke.ok, 'no win from an imported save');
  assert.ok(!ev(imported).level100.ok && !ev(imported).badges8.ok);
  // the Pokédex: what was seen caught, not the species it has from the save
  const dex = Tr.buildDex([imported]);
  assert.equal(dex[4].caught, 1);
  assert.equal(dex[6]?.caught || 0, 0);
  // another player's import in the same run doesn't touch this player's trophies
  assert.equal(Tr.digestRun(run({ saveImports: { p2: [{ at: T0 }] } }), entries, 'p1').imported, undefined);
});

test('many imports in a row: the save from before the first one is never pruned away', () => {
  const dir = tmp();
  const path = join(dir, 'p1.sav');
  const backups = join(dir, 'backups');
  writeFileSync(path, 'my real save');
  for (let i = 0; i < 20; i++) I.replaceSave({ path, bytes: Buffer.from(`try ${i}`), backupDir: backups, key: 'p1', now: Date.UTC(2026, 0, 1, 0, i) });
  const kept = I.importBackups(backups, 'p1');
  assert.ok(kept.length <= I.KEEP_BACKUPS + 1);
  const first = kept.filter((b) => b.kind === 'before').at(-1);
  assert.equal(readFileSync(join(backups, first.file), 'utf8'), 'my real save');
  rmSync(dir, { recursive: true, force: true });
});
