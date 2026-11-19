// 2.8.3: 3DS game updates in souldew's own player ("I have the patch and the game but it just boots the base game"). An
// update file in the library is recognised by its title ID (0004000E + the game's low half), goes with its game – never
// a game of its own –, waits for a game that isn't there yet, can be taken off again, and is installed onto the save
// folder's SD card where Azahar's core finds it (shared/ctr/update.mjs, server/lib/ctrupdate.mjs). Encrypted updates
// are refused with a plain reason; a randomized run's game never gets one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { cia as gameCia, ncchHeader, cci } from './fixtures/ctr.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'sls-ctrupdate-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));
process.env.SLS_DATA_DIR = join(TMP, 'data');
process.env.SLS_TOOLS_DIR = join(TMP, 'tools');
const { identifyCtrBytes } = await import('../shared/ctr.mjs');
const { updateLayout, titleVersionText, updateTitleIdOf, gameTitleIdOf, updateStatus, pickUpdate, makeTmd, updatePaths, SD_ID } = await import('../shared/ctr/update.mjs');
const { scanLibrary, ctrInfo, removeCtrUpdate, importFiles } = await import('../server/lib/library.mjs');
const { unpackUpdate, installUpdate, installedUpdate, removeInstalledUpdate, prepareUpdate, pruneUpdateCache, updateStamp, sdOf, MARKER } = await import('../server/lib/ctrupdate.mjs');
const { LIBRARY_DIR, DATA_DIR } = await import('../server/lib/paths.mjs');
const ROOT = new URL('../', import.meta.url).href;
registerHooks({ resolve: (spec, ctx, next) => (spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx)) });
const { addedToLibrary, addedMessage } = await import('../web/lib/libadded.mjs');
const { ctrUpdateNote, updateVersionLabel } = await import('../web/lib/ctrupdate.mjs');

const US = '00040000001B5000'; // Ultra Sun
const US_UPDATE = '0004000E001B5000';
const bytesOf = (u8, o, n) => (o >= u8.length ? new Uint8Array(0) : u8.subarray(o, Math.min(u8.length, o + n)));
const readerOf = (u8) => (o, n) => bytesOf(u8, o, n);

/** An update's NCCH: the header (size in media units at 0x104) and `payload` bytes after it. */
function updateNcch({ titleId = US_UPDATE, encrypted = false, payload = 0x600, version = 0 } = {}) {
  const size = Math.ceil((0x200 + payload) / 0x200) * 0x200;
  const b = new Uint8Array(size);
  b.set(ncchHeader({ productCode: 'CTR-P-A2AA', titleId, encrypted, version }));
  b[0x104] = size / 0x200;
  for (let i = 0x200; i < size; i++) b[i] = (i * 7) & 0xff;
  return b;
}

const align = (n) => Math.ceil(n / 64) * 64;
/**
 * An update .cia: header (content index: every content present unless `missing`), certificates, ticket, an RSA-2048 TMD
 * with one record per content, the contents. `encryptedFlag`: TMD content type bit 0 on the first content.
 */
function updateCia({ titleId = US_UPDATE, version = 2080, contents = [updateNcch()], ids = null, encryptedFlag = false, missing = [], cut = 0 } = {}) {
  const certSize = 0xa00;
  const ticketSize = 0x350;
  const tmdSize = 0x140 + 0xc4 + 0x900 + 0x30 * contents.length;
  const tmdOff = align(0x2020) + align(certSize) + align(ticketSize);
  const contentOff = align(tmdOff + tmdSize);
  const present = contents.filter((_, i) => !missing.includes(i));
  const total = contentOff + present.reduce((s, c) => s + c.length, 0);
  const b = new Uint8Array(total);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x2020, true);
  dv.setUint32(0x08, certSize, true);
  dv.setUint32(0x0c, ticketSize, true);
  dv.setUint32(0x10, tmdSize, true);
  contents.forEach((_, i) => {
    if (!missing.includes(i)) b[0x20 + (i >> 3)] |= 0x80 >> (i & 7);
  });
  dv.setUint32(tmdOff, 0x10004);
  const hdr = tmdOff + 0x140;
  dv.setUint32(hdr + 0x4c, parseInt(titleId.slice(0, 8), 16));
  dv.setUint32(hdr + 0x50, parseInt(titleId.slice(8), 16));
  dv.setUint16(hdr + 0x9c, version);
  dv.setUint16(hdr + 0x9e, contents.length);
  let at = contentOff;
  contents.forEach((c, i) => {
    const rec = hdr + 0xc4 + 0x900 + i * 0x30;
    dv.setUint32(rec, ids ? ids[i] : 0x20 + i);
    dv.setUint16(rec + 4, i);
    dv.setUint16(rec + 6, i === 0 && encryptedFlag ? 1 : 0);
    dv.setUint32(rec + 12, c.length);
    if (missing.includes(i)) return;
    b.set(c, at);
    at += c.length;
  });
  return cut ? b.subarray(0, b.length - cut) : b;
}

// ---- recognising an update ------------------------------------------------------------------------------------------
test('title IDs: an update is 0004000E + its game\'s low half; versions read as the 3DS shows them', () => {
  assert.equal(updateTitleIdOf(US), US_UPDATE);
  assert.equal(gameTitleIdOf(US_UPDATE), US);
  assert.equal(gameTitleIdOf(US), null, 'a game is no update');
  assert.equal(updateTitleIdOf('0004008C001B5000'), null, 'DLC has no update ID');
  assert.equal(titleVersionText(2080), 'v2.2.0'); // Ultra Sun / Ultra Moon 1.2
  assert.equal(titleVersionText(5232), 'v5.7.0'); // X 1.5
  assert.equal(titleVersionText(0), 'v0.0.0');
  assert.equal(identifyCtrBytes(updateCia(), 'cia').kind, 'update');
  assert.equal(identifyCtrBytes(updateCia(), 'cia').version, 2080);
  assert.equal(identifyCtrBytes(updateNcch(), 'cxi').kind, 'update');
  // what souldew knows: the latest update of a Pokémon game by name, an older one as such, other games as unknown
  assert.deepEqual(updateStatus(US, 2080), { versionText: 'v2.2.0', gameVersion: '1.2', latest: true, tracking: 'known' });
  assert.deepEqual(updateStatus(US, 1040), { versionText: 'v1.1.0', gameVersion: null, latest: false, tracking: 'older' });
  assert.equal(updateStatus(US, null).tracking, 'known', 'no update: version 1.0, which souldew knows');
  assert.equal(updateStatus('0004000000030800', 1024).tracking, 'unknown');
});

test('updateLayout: the TMD and where each content is in a .cia', () => {
  const contents = [updateNcch({ payload: 0x1000 }), updateNcch({ payload: 0x400 })];
  const file = updateCia({ contents, ids: [0x4e, 0x1234abcd] });
  const l = updateLayout(readerOf(file), 'cia', file.length);
  assert.equal(l.titleId, US_UPDATE);
  assert.equal(l.version, 2080);
  assert.equal(l.format, 'cia');
  assert.deepEqual(l.contents.map((c) => c.id), ['0000004e', '1234abcd']);
  assert.deepEqual(Array.from(file.subarray(l.contents[1].offset, l.contents[1].offset + l.contents[1].size)), Array.from(contents[1]));
  assert.equal(l.tmd.length, 0x140 + 0xc4 + 0x900 + 0x60, 'the TMD as it is in the CIA');
  // a content the CIA leaves out (its content index bit unset) takes no room: the next one starts where it would have
  const skipped = updateCia({ contents, missing: [0] });
  const ls = updateLayout(readerOf(skipped), 'cia', skipped.length);
  assert.equal(ls.contents.length, 1);
  assert.deepEqual(Array.from(skipped.subarray(ls.contents[0].offset, ls.contents[0].offset + 0x200)), Array.from(contents[1].subarray(0, 0x200)));
});

test('updateLayout: encrypted updates are refused (title key or NCCH crypto), a game or a cut-off file is no update', () => {
  const code = (fn) => {
    try {
      fn();
    } catch (e) {
      return e.code;
    }
    return 'ok';
  };
  const enc1 = updateCia({ encryptedFlag: true });
  assert.equal(code(() => updateLayout(readerOf(enc1), 'cia', enc1.length)), 'encrypted');
  const enc2 = updateCia({ contents: [updateNcch({ encrypted: true })] });
  assert.equal(code(() => updateLayout(readerOf(enc2), 'cia', enc2.length)), 'encrypted');
  const enc3 = updateNcch({ encrypted: true });
  assert.equal(code(() => updateLayout(readerOf(enc3), 'cxi', enc3.length)), 'encrypted');
  const game = gameCia();
  assert.equal(code(() => updateLayout(readerOf(game), 'cia', game.length)), 'notUpdate');
  assert.equal(code(() => updateLayout(readerOf(cci()), '3ds', cci().length)), 'notUpdate');
  const cut = updateCia({ cut: 0x100 });
  assert.equal(code(() => updateLayout(readerOf(cut), 'cia', cut.length)), 'invalid');
  assert.equal(code(() => updateLayout(readerOf(new Uint8Array(0x10)), 'cia', 0x10)), 'invalid');
  assert.equal(code(() => updateLayout(readerOf(new Uint8Array(0x10)), 'nds', 0x10)), 'notUpdate');
});

test('an update as a bare NCCH (.cxi): installed with a TMD souldew writes – Azahar reads the content ID and size from it', () => {
  const n = updateNcch({ payload: 0x800, version: 2080 });
  const l = updateLayout(readerOf(n), 'cxi', n.length);
  assert.deepEqual(l.contents, [{ id: '00000000', offset: 0, size: n.length }]);
  const tmd = new DataView(l.tmd.buffer, l.tmd.byteOffset, l.tmd.byteLength);
  assert.equal(tmd.getUint32(0), 0x10004);
  const body = 0x140;
  assert.equal(tmd.getUint32(body + 0x4c).toString(16).padStart(8, '0') + tmd.getUint32(body + 0x50).toString(16).padStart(8, '0'), US_UPDATE.toLowerCase());
  assert.equal(tmd.getUint16(body + 0x9c), 2080);
  assert.equal(tmd.getUint16(body + 0x9e), 1);
  const rec = body + 0xc4 + 0x900;
  assert.equal(tmd.getUint32(rec), 0, 'content ID 0 → 00000000.app');
  assert.equal(tmd.getUint32(rec + 12), n.length);
  assert.equal(makeTmd(US_UPDATE, 1, 0x1_0000_0200).length, l.tmd.length);
  // inside a cartridge image (partition 0)
  const img = new Uint8Array(0x4000 + n.length);
  img.set(cci({ titleId: US_UPDATE }).subarray(0, 0x200));
  img.set(n, 0x4000);
  const li = updateLayout(readerOf(img), '3ds', img.length);
  assert.deepEqual(li.contents, [{ id: '00000000', offset: 0x4000, size: n.length }]);
  assert.equal(li.format, 'cci');
});

test('pickUpdate: the newest one souldew can install; an encrypted one only when there is no other; taken-off ones never', () => {
  const u = (version, extra = {}) => ({ gameTitleId: US, version, name: `u${version}`, ...extra });
  assert.equal(pickUpdate([u(1040), u(2080), u(4000, { encrypted: true })], US).version, 2080);
  assert.equal(pickUpdate([u(2080, { encrypted: true })], US).encrypted, true);
  assert.equal(pickUpdate([u(2080, { detached: true })], US), null);
  assert.equal(pickUpdate([u(2080)], '0004000000164800'), null);
  assert.equal(pickUpdate(null, US), null);
});

// ---- the library ------------------------------------------------------------------------------------------------------
test('library: an update goes with its game (never a game of its own), waits for a game that isn\'t there, shows its version', () => {
  mkdirSync(LIBRARY_DIR, { recursive: true });
  writeFileSync(join(LIBRARY_DIR, 'Ultra Sun Update 1.2.cia'), updateCia());
  let lib = scanLibrary({});
  assert.equal(lib.roms.filter((r) => r.system === '3ds').length, 0, 'an update is never listed as a game');
  assert.equal(lib.ctrUpdates.length, 1);
  const u = lib.ctrUpdates[0];
  assert.deepEqual({ titleId: u.titleId, gameTitleId: u.gameTitleId, gameId: u.gameId, versionText: u.versionText, gameVersion: u.gameVersion, encrypted: u.encrypted, detached: u.detached },
    { titleId: US_UPDATE, gameTitleId: US, gameId: 'pokemon-ultra-sun', versionText: 'v2.2.0', gameVersion: '1.2', encrypted: false, detached: false });
  assert.equal(ctrInfo(join(LIBRARY_DIR, 'Ultra Sun Update 1.2.cia'), 'cia'), null, 'not a playable game');
  // the game arrives: the update is attached to it
  writeFileSync(join(LIBRARY_DIR, 'Ultra Sun.cxi'), ncchHeader({ productCode: 'CTR-P-A2AA', titleId: US }));
  lib = scanLibrary({});
  const game = lib.roms.find((r) => r.name === 'Ultra Sun.cxi');
  assert.equal(game.gameId, 'pokemon-ultra-sun');
  assert.equal(game.update.versionText, 'v2.2.0');
  assert.equal(game.update.gameVersion, '1.2');
  assert.equal(game.update.tracking, 'known');
  assert.equal(game.update.id, u.id);
  // an older one next to it: the newest is used
  writeFileSync(join(LIBRARY_DIR, 'Ultra Sun Update 1.1.cia'), updateCia({ version: 1040 }));
  assert.equal(scanLibrary({}).roms.find((r) => r.name === 'Ultra Sun.cxi').update.version, 2080);
  rmSync(join(LIBRARY_DIR, 'Ultra Sun Update 1.1.cia'));
  // an index from before 2.8.3 remembered update files as "nothing" – they are read again
  const indexPath = join(DATA_DIR, 'library-index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  for (const k of Object.keys(index)) if (k.includes('Update 1.2')) index[k] = null;
  writeFileSync(indexPath, JSON.stringify(index));
  assert.equal(scanLibrary({}).ctrUpdates.length, 1);
});

test('library: an encrypted update is listed with why it isn\'t used; removing one deletes souldew\'s copy or marks the player\'s own', () => {
  const other = join(TMP, 'my-folder');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'Moon Update.cia'), updateCia({ titleId: '0004000E00175E00', version: 2112, encryptedFlag: true }));
  const config = { libraryFolders: [other] };
  let lib = scanLibrary(config);
  const enc = lib.ctrUpdates.find((u) => u.gameTitleId === '0004000000175E00');
  assert.equal(enc.encrypted, true);
  assert.equal(enc.gameId, 'pokemon-moon');
  // the player's own file in an included folder: only marked, never deleted
  const r1 = removeCtrUpdate(enc.id, config);
  assert.equal(r1.deleted, false);
  assert.ok(existsSync(join(other, 'Moon Update.cia')));
  lib = scanLibrary({ ...config, ctrUpdatesDetached: r1.ctrUpdatesDetached });
  assert.equal(lib.ctrUpdates.find((u) => u.id === enc.id).detached, true);
  // souldew's copy in the library folder: deleted (the original stays wherever it came from)
  const copy = lib.ctrUpdates.find((u) => u.gameTitleId === US);
  const r2 = removeCtrUpdate(copy.id, { ...config, ctrUpdatesDetached: r1.ctrUpdatesDetached });
  assert.equal(r2.deleted, true);
  assert.deepEqual(r2.ctrUpdatesDetached, r1.ctrUpdatesDetached);
  assert.equal(existsSync(join(LIBRARY_DIR, 'Ultra Sun Update 1.2.cia')), false);
  assert.equal(scanLibrary({}).roms.find((r) => r.name === 'Ultra Sun.cxi').update, null);
  // only updates
  assert.throws(() => removeCtrUpdate(scanLibrary({}).roms.find((r) => r.name === 'Ultra Sun.cxi').id, config), (e) => e.code === 'notCtrUpdate');
});

test('adding an update says what it is and whether the game is there', async () => {
  const src = join(TMP, 'downloads');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'US 1.2.cia'), updateCia());
  const before = scanLibrary({});
  const added = await importFiles([join(src, 'US 1.2.cia')], {}, { roots: [src] });
  const after = scanLibrary({});
  const res = addedToLibrary(before, after, added);
  assert.equal(res.added.length, 1);
  assert.equal(res.added[0].kind, 'update');
  assert.equal(res.added[0].hasGame, true);
  const catalog = JSON.parse(readFileSync(new URL('../shared/data/catalog.json', import.meta.url), 'utf8'));
  const msg = addedMessage(res, catalog);
  assert.equal(msg.kind, 'ok');
  assert.match(msg.title, /Update v2\.2\.0 for Pokémon Ultra Sun/);
  assert.match(msg.text, /starts the game with it/);
  // the same file again: already there
  assert.equal(addedToLibrary(after, scanLibrary({}), added).already.length, 1);
});

// ---- installing it where the core looks -------------------------------------------------------------------------------
test('unpackUpdate + installUpdate: the TMD and the .app where Azahar\'s core finds the update, linked from the cache, once', async () => {
  const lib = scanLibrary({});
  const u = pickUpdate(lib.ctrUpdates, US);
  const cache = join(TMP, 'cache');
  const unpacked = await unpackUpdate(u.file, { cache });
  assert.equal(unpacked.titleId, US_UPDATE);
  const save = join(TMP, 'save-a');
  assert.equal(installUpdate(save, unpacked), true);
  const content = join(sdOf(save), 'Nintendo 3DS', SD_ID, SD_ID, 'title', '0004000e', '001b5000', 'content');
  assert.deepEqual(readdirSync(content).sort(), ['00000000.tmd', '00000020.app']);
  const cia = readFileSync(u.file);
  const layout = updateLayout(readerOf(new Uint8Array(cia)), 'cia', cia.length);
  assert.deepEqual(readFileSync(join(content, '00000020.app')), cia.subarray(layout.contents[0].offset, layout.contents[0].offset + layout.contents[0].size));
  assert.deepEqual(new Uint8Array(readFileSync(join(content, '00000000.tmd'))), layout.tmd);
  assert.equal(statSync(join(content, '00000020.app')).ino, statSync(join(unpacked.dir, ...updatePaths(US_UPDATE).appDir, '00000020.app')).ino, 'a hard link, no second copy');
  assert.equal(installedUpdate(save, US).version, 2080);
  assert.ok(existsSync(join(content, '..', MARKER)));
  // the same update again: nothing to do; a second unpack finds the cache
  assert.equal(installUpdate(save, unpacked), false);
  assert.equal((await unpackUpdate(u.file, { cache })).dir, unpacked.dir);
  // removed – only what souldew installed
  assert.equal(removeInstalledUpdate(save, US), true);
  assert.equal(existsSync(join(content, '..')), false);
  assert.equal(removeInstalledUpdate(save, US), false);
  const own = join(sdOf(save), ...updatePaths(US_UPDATE).tmdDir);
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, '00000000.tmd'), 'the player\'s own');
  assert.equal(removeInstalledUpdate(save, US), false);
  assert.ok(existsSync(join(own, '00000000.tmd')));
  // the cache keeps the updates the library has
  pruneUpdateCache([], { cache });
  assert.equal(existsSync(join(cache, unpacked.stamp)), false);
});

test('prepareUpdate: installs the library\'s update, replaces another, removes it again – never for a randomized game or an encrypted update', async () => {
  const cache = join(TMP, 'cache2');
  const save = join(TMP, 'save-b');
  const u = pickUpdate(scanLibrary({}).ctrUpdates, US);
  const r = await prepareUpdate({ saveDir: save, gameTid: US, update: u, cache });
  assert.deepEqual({ installed: r.installed, versionText: r.versionText, gameVersion: r.gameVersion, tracking: r.tracking }, { installed: true, versionText: 'v2.2.0', gameVersion: '1.2', tracking: 'known' });
  assert.equal(installedUpdate(save, US).version, 2080);
  // another update file (an older one): it replaces the first one
  const older = join(LIBRARY_DIR, 'US 1.1.cia');
  writeFileSync(older, updateCia({ version: 1040, ids: [0x99] }));
  const o = await prepareUpdate({ saveDir: save, gameTid: US, update: { file: older, version: 1040 }, cache });
  assert.equal(o.tracking, 'older');
  const content = join(sdOf(save), ...updatePaths(US_UPDATE).tmdDir);
  assert.deepEqual(readdirSync(content).sort(), ['00000000.tmd', '00000099.app'], 'one update only – Azahar would pick either .tmd');
  rmSync(older);
  // a randomized run's game: the update's code would undo the randomization
  const rnd = await prepareUpdate({ saveDir: save, gameTid: US, update: u, randomized: true, cache });
  assert.deepEqual({ installed: rnd.installed, why: rnd.why }, { installed: false, why: 'randomized' });
  assert.equal(installedUpdate(save, US), null);
  // a ROM hack (Rising Ruby, built on 1.0): the update's code would replace the hack's – installed before, removed now
  await prepareUpdate({ saveDir: save, gameTid: US, update: u, cache });
  const hack = await prepareUpdate({ saveDir: save, gameTid: US, update: u, hacked: true, cache });
  assert.deepEqual({ installed: hack.installed, why: hack.why }, { installed: false, why: 'hack' });
  assert.equal(installedUpdate(save, US), null);
  assert.match(ctrUpdateNote(hack), /hack/i, 'the play view says why');
  // encrypted: not installed, said why
  const enc = await prepareUpdate({ saveDir: save, gameTid: US, update: { ...u, encrypted: true }, cache });
  assert.deepEqual({ installed: enc.installed, why: enc.why }, { installed: false, why: 'encrypted' });
  // an update file that turns out encrypted when unpacked (the header looked fine)
  const sneaky = join(TMP, 'sneaky.cia');
  writeFileSync(sneaky, updateCia({ contents: [updateNcch({ encrypted: true })] }));
  const sn = await prepareUpdate({ saveDir: save, gameTid: US, update: { file: sneaky, version: 2080 }, cache });
  assert.deepEqual({ installed: sn.installed, why: sn.why }, { installed: false, why: 'encrypted' });
  // the library has none any more: what souldew installed goes
  await prepareUpdate({ saveDir: save, gameTid: US, update: u, cache });
  assert.equal(await prepareUpdate({ saveDir: save, gameTid: US, update: null, cache }), null);
  assert.equal(installedUpdate(save, US), null);
  // not a game (homebrew): nothing
  assert.equal(await prepareUpdate({ saveDir: save, gameTid: null, update: u, cache }), null);
  // an update file for another game is never installed for this one
  const wrong = await prepareUpdate({ saveDir: save, gameTid: '0004000000164800', update: u, cache });
  assert.equal(wrong.installed, false);
  assert.equal(wrong.why, 'otherGame');
  // the cache: a changed update file is unpacked anew, the stale copy pruned once the library no longer has it
  const stamp1 = updateStamp(u.file);
  utimesSync(u.file, new Date(), new Date(Date.now() + 5000));
  const stamp2 = updateStamp(u.file);
  assert.notEqual(stamp1, stamp2);
  await prepareUpdate({ saveDir: save, gameTid: US, update: u, cache, keep: [stamp2] });
  assert.equal(existsSync(join(cache, stamp1)), false);
  assert.ok(existsSync(join(cache, stamp2)));
});

test('the play view and the library say what the update does', () => {
  assert.equal(updateVersionLabel({ versionText: 'v2.2.0', gameVersion: '1.2' }), 'v2.2.0 (game version 1.2)');
  assert.equal(updateVersionLabel({ versionText: 'v1.1.0', gameVersion: null }), 'v1.1.0');
  assert.equal(ctrUpdateNote(null), '');
  assert.equal(ctrUpdateNote({ installed: true, tracking: 'known', versionText: 'v2.2.0' }), '');
  assert.match(ctrUpdateNote({ installed: true, tracking: 'older', versionText: 'v1.1.0' }), /older update \(v1\.1\.0\)/);
  assert.equal(ctrUpdateNote({ installed: true, tracking: 'older', versionText: 'v1.1.0' }, true), '', 'the team is found: no warning');
  assert.match(ctrUpdateNote({ installed: false, why: 'randomized', versionText: 'v2.2.0' }), /Randomized games start without their update/);
  assert.match(ctrUpdateNote({ installed: false, why: 'encrypted', versionText: 'v2.2.0' }), /encrypted/);
  assert.match(ctrUpdateNote({ installed: false, why: 'diskFull', versionText: 'v2.2.0' }), /couldn’t be installed/);
});

test('/api/ctr/start: the game starts with its update on the save folder\'s SD card – a randomized run\'s game without it', async () => {
  const { PLATFORM_DIR, saveDirFor } = await import('../server/lib/ctr.mjs');
  const { buildRun, writeManifest, readManifest } = await import('../server/lib/build.mjs');
  // stand-in tools: the host never really runs (an empty file can't start – the session just ends)
  const tools = join(TMP, 'tools', 'ctr', PLATFORM_DIR);
  mkdirSync(tools, { recursive: true });
  for (const f of ['ctrhost', 'ctrhost.exe', 'azahar_libretro.dylib', 'azahar_libretro.dll', 'azahar_libretro.so', 'libMoltenVK.dylib', 'vulkan-1.dll', 'libvulkan.so.1']) writeFileSync(join(tools, f), '');
  writeFileSync(join(LIBRARY_DIR, 'Ultra Sun Update 1.2.cia'), updateCia());
  const { startServer } = await import('../server/app.mjs');
  const { server, url } = await startServer({ port: 0, background: false });
  const post = (path, body) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-soullink': '1' }, body: JSON.stringify(body) });
  try {
    const lib = await fetch(`${url}/api/library`, { headers: { 'x-soullink': '1' } }).then((r) => r.json());
    const rom = lib.roms.find((r) => r.name === 'Ultra Sun.cxi');
    assert.equal(rom.update.versionText, 'v2.2.0');
    const res = await post('/api/ctr/start', { rom: `/api/library/rom?id=${encodeURIComponent(rom.id)}`, key: 'solo-us' });
    const j = await res.json();
    assert.equal(res.status, 200, JSON.stringify(j));
    assert.equal(j.update.installed, true);
    assert.equal(j.update.gameVersion, '1.2');
    assert.equal(installedUpdate(saveDirFor('solo-us'), US).version, 2080);
    await post('/api/ctr/stop', { id: j.id });

    // a randomized run of the same game (its .cxi keeps the game's title ID): no update
    const m = await buildRun({ romId: rom.id, gameId: 'pokemon-ultra-sun', gameTitle: 'Pokémon Ultra Sun', randomize: false, mode: 'nuzlocke', players: { p1: { name: 'Ash' } }, config: {} }, () => {});
    writeManifest({ ...readManifest(m.id), randomizer: { ...m.randomizer, enabled: true } });
    const key = `run-${m.id}-p1`;
    mkdirSync(saveDirFor(key), { recursive: true });
    const r2 = await post('/api/ctr/start', { rom: `/api/runs/${m.id}/file?name=${encodeURIComponent(m.outputs.p1.rom)}`, key });
    const j2 = await r2.json();
    assert.equal(r2.status, 200, JSON.stringify(j2));
    assert.deepEqual({ installed: j2.update.installed, why: j2.update.why }, { installed: false, why: 'randomized' });
    assert.equal(installedUpdate(saveDirFor(key), US), null);
    await post('/api/ctr/stop', { id: j2.id });

    // "Remove" in the game's details: the next start has no update, and what was installed is gone
    // (the update added in an earlier test is there as well: both go)
    for (const u of lib.ctrUpdates.filter((x) => x.gameTitleId === US)) {
      const rm = await post('/api/library/ctr-update/remove', { id: u.id });
      assert.equal((await rm.json()).deleted, true);
    }
    const r3 = await post('/api/ctr/start', { rom: `/api/library/rom?id=${encodeURIComponent(rom.id)}`, key: 'solo-us' });
    const j3 = await r3.json();
    assert.equal(j3.update, null);
    assert.equal(installedUpdate(saveDirFor('solo-us'), US), null);
    await post('/api/ctr/stop', { id: j3.id });
  } finally {
    await new Promise((r) => server.close(r));
  }
});
