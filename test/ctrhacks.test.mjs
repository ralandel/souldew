// 3DS ROM hacks shipped as an already-built game (souldew Renaissance: Rising Ruby / Sinking Sapphire): recognised by
// the contents fingerprint of their NCCH header, listed as their hack (not as Omega Ruby), never started with the base
// game's update, and compared between the players of a run like a GBA hack's checksum.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identifyCtrBytes, ncchFingerprint } from '../shared/ctr.mjs';
import { baseRomsFor, needsIdenticalRom } from '../shared/restart.mjs';
import { cci, cia, ncchHeader } from './fixtures/ctr.mjs';

const DATA = mkdtempSync(join(tmpdir(), 'sls-ctrhacks-'));
process.env.SLS_DATA_DIR = DATA;
const { scanLibrary, catalog, withEditionHacks, ctrHackOf } = await import('../server/lib/library.mjs');
const { buildRun, runPack } = await import('../server/lib/build.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const json = (f) => JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url), 'utf8'));
const upstream = json('catalog.json');
const edition = json('catalog-edition.json');
const i18n = (lang) => JSON.parse(readFileSync(new URL(`../web/i18n/${lang}.json`, import.meta.url), 'utf8'));
const OR = '000400000011C400';
const AS = '000400000011C500';
/** The header hashes (128 hex digits) whose fingerprint is `fp` (its 16 + 16 bytes, the rest of each hash zero). */
const hashesOf = (fp) => fp.slice(0, 32) + '0'.repeat(32) + fp.slice(32) + '0'.repeat(32);
const RR = edition.hacks.find((h) => h.id === 'rising-ruby');
const SS = edition.hacks.find((h) => h.id === 'sinking-sapphire');

test('the fingerprint: the first 16 bytes of the ExeFS and RomFS superblock hashes – the same in a .3ds, a .cxi and a .cia', () => {
  const hashes = 'ab12'.repeat(32);
  const fp = identifyCtrBytes(cci({ hashes }), '3ds').fingerprint;
  assert.match(fp, /^[0-9a-f]{64}$/);
  assert.equal(fp, 'ab12'.repeat(8) + 'ab12'.repeat(8));
  assert.equal(identifyCtrBytes(ncchHeader({ hashes }), 'cxi').fingerprint, fp);
  assert.equal(identifyCtrBytes(cia({ hashes }), 'cia').fingerprint, fp);
  // another game content, another fingerprint – a header without hashes, none
  assert.notEqual(identifyCtrBytes(cci({ hashes: 'cd34' }), '3ds').fingerprint, fp);
  assert.equal(identifyCtrBytes(cci(), '3ds').fingerprint, null);
  assert.equal(ncchFingerprint(new Uint8Array(0x100)), null);
  // an encrypted .cia's content isn't read: no fingerprint
  assert.equal(identifyCtrBytes(cia({ contentEncrypted: true }), 'cia').fingerprint, null);
});

test('catalog: the edition\'s hacks join upstream\'s – the same id replaces upstream\'s entry', () => {
  const merged = withEditionHacks({ games: [], hacks: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }, { hacks: [{ id: 'b', name: 'B2' }, { id: 'c' }] });
  assert.deepEqual(merged.hacks.map((h) => [h.id, h.name]), [['a', 'A'], ['b', 'B2'], ['c', undefined]]);
  const plain = { games: [], hacks: [] };
  assert.equal(withEditionHacks(plain, null), plain);
  const cat = catalog();
  assert.equal(cat.hacks.length, upstream.hacks.length + edition.hacks.filter((h) => !upstream.hacks.some((u) => u.id === h.id)).length);
  assert.ok(cat.hacks.some((h) => h.id === 'rising-ruby') && cat.hacks.some((h) => h.id === 'sinking-sapphire'));
});

test('catalog-edition.json: every hack is complete, on a game of the catalog, and its live state can be shown in every language', () => {
  const keyOf = { yes: 'lib.liveYes', partial: 'lib.livePartial', untested: 'lib.liveUntested', no: 'lib.liveNo' };
  const langs = ['en', 'de', 'es', 'fr', 'it'].map((l) => [l, i18n(l)]);
  for (const h of edition.hacks) {
    const base = upstream.games.find((g) => g.id === h.baseGameId);
    assert.ok(base, `${h.id}: base game ${h.baseGameId}`);
    assert.equal(h.system, base.system, h.id);
    for (const k of ['name', 'author', 'descriptionEn', 'descriptionDe', 'difficulty', 'uprCompatible', 'color']) assert.ok(h[k], `${h.id}: ${k}`);
    assert.ok(['yes', 'no', 'unknown'].includes(h.uprCompatible), h.id);
    assert.ok(!('url' in h) && !/https?:/.test(JSON.stringify(h)), `${h.id}: no links to ROM hacks`);
    if (h.live) for (const [l, d] of langs) assert.ok(d[keyOf[h.live]], `${l}: ${keyOf[h.live]}`);
    for (const fp of h.ctrFingerprints || []) assert.match(fp, /^[0-9a-f]{64}$/, h.id);
  }
  assert.equal(RR.baseGameId, 'pokemon-omega-ruby');
  assert.equal(SS.baseGameId, 'pokemon-alpha-sapphire');
  assert.equal(ctrHackOf(RR.ctrFingerprints[0].toUpperCase())?.id, 'rising-ruby', 'case does not matter');
  assert.equal(ctrHackOf('0'.repeat(64)), null);
});

test('library: Rising Ruby / Sinking Sapphire are their hacks, Omega Ruby stays Omega Ruby – and only the game itself gets the update', () => {
  const lib = join(DATA, 'Library');
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, 'Pokemon Rising Ruby v2d1.3ds'), cci({ productCode: 'CTR-P-ECRA', titleId: OR, hashes: hashesOf(RR.ctrFingerprints[0]) }));
  writeFileSync(join(lib, 'whatever.cxi'), ncchHeader({ productCode: 'CTR-P-ECLA', titleId: AS, hashes: hashesOf(SS.ctrFingerprints[0]) }));
  writeFileSync(join(lib, 'Pokemon Omega Ruby.3ds'), cci({ productCode: 'CTR-P-ECRA', titleId: OR, hashes: 'feed' }));
  writeFileSync(join(lib, 'Omega Ruby update.cia'), cia({ titleId: '0004000E0011C400', version: 7200 }));
  const scan = () => Object.fromEntries(scanLibrary({}).roms.filter((r) => r.system === '3ds').map((r) => [r.name, r]));
  for (const pass of [1, 2]) { // (the second from the index cache)
    const r = scan();
    assert.equal(r['Pokemon Rising Ruby v2d1.3ds'].hackId, 'rising-ruby', `pass ${pass}`);
    assert.equal(r['Pokemon Rising Ruby v2d1.3ds'].gameId, 'pokemon-omega-ruby');
    assert.equal(r['Pokemon Rising Ruby v2d1.3ds'].update, null, 'the hack never plays with the update');
    assert.equal(r['whatever.cxi'].hackId, 'sinking-sapphire', 'by its contents, whatever the file is called');
    assert.equal(r['Pokemon Omega Ruby.3ds'].hackId, null);
    assert.ok(r['Pokemon Omega Ruby.3ds'].update, 'the game itself keeps its update');
  }
});

test('library: an index from before the fingerprint is read again (a few header bytes)', () => {
  const index = join(DATA, 'library-index.json');
  const old = JSON.parse(readFileSync(index, 'utf8'));
  for (const v of Object.values(old)) if (v && v.system === '3ds') delete v.fingerprint;
  writeFileSync(index, JSON.stringify(old));
  const rr = scanLibrary({}).roms.find((r) => r.name === 'Pokemon Rising Ruby v2d1.3ds');
  assert.equal(rr.hackId, 'rising-ruby');
});

test('joining: a 3DS hack run takes the players\' copies of that hack (the host\'s build first) – a run of the game itself never a hack', () => {
  const host = RR.ctrFingerprints[0];
  const roms = [
    { id: 'or', system: '3ds', gameId: 'pokemon-omega-ruby', hackId: null, fingerprint: 'f'.repeat(64) },
    { id: 'rr-old', system: '3ds', gameId: 'pokemon-omega-ruby', hackId: 'rising-ruby', fingerprint: 'e'.repeat(64) },
    { id: 'rr', system: '3ds', gameId: 'pokemon-omega-ruby', hackId: 'rising-ruby', fingerprint: host },
    { id: 'as', system: '3ds', gameId: 'pokemon-alpha-sapphire', hackId: null, fingerprint: 'd'.repeat(64) },
  ];
  const cat = catalog();
  const rootOf = (id) => cat.games.find((g) => g.id === id)?.variantOf || id;
  const hackRun = { base: { crc: null, fingerprint: host }, game: { id: 'pokemon-omega-ruby', system: '3ds', code: 'ECRA', hackId: 'rising-ruby' }, randomizer: { enabled: false } };
  assert.equal(needsIdenticalRom(hackRun), true);
  assert.deepEqual(baseRomsFor(hackRun, roms, rootOf).map((r) => r.id), ['rr', 'rr-old']);
  const plain = { base: { crc: null }, game: { id: 'pokemon-omega-ruby', system: '3ds', code: 'ECRA' }, randomizer: { enabled: false } };
  assert.deepEqual(baseRomsFor(plain, roms, rootOf).map((r) => r.id), ['or', 'as'], 'Omega Ruby, or its pair mate – never Rising Ruby');
});

test('a Rising Ruby SoulLink: the run pack carries the host\'s fingerprint, a friend\'s other build is flagged', async () => {
  const lib = join(DATA, 'Library');
  const rom = join(lib, 'Pokemon Rising Ruby v2d1.3ds');
  const opts = { romId: rom, gameId: 'pokemon-omega-ruby', hackId: 'rising-ruby', gameTitle: 'Pokémon Rising Ruby', randomize: false, mode: 'soullink', players: { p1: { name: 'Ash' }, p2: { name: 'Misty' } }, config: {} };
  const m = await buildRun(opts);
  assert.equal(m.game.hackId, 'rising-ruby');
  assert.equal(m.base.fingerprint, RR.ctrFingerprints[0]);
  assert.equal(m.outputs.p1.sha1, null, 'a 2 GB game is never hashed');
  const pack = runPack(m);
  assert.equal(pack.base.fingerprint, RR.ctrFingerprints[0]);
  assert.deepEqual(pack.outputs.p2, { sha1: null, fingerprint: RR.ctrFingerprints[0] });
  // the friend with the same build
  const same = [];
  const a = await buildRun({ ...opts, identity: { id: m.id, room: m.room, secret: m.secret }, buildFor: ['p2'], expectedOutputs: pack.outputs }, (l) => same.push(l));
  assert.equal(a.outputs.p2.matchesFriend, true);
  // the friend with another build of the hack (another version): said in the build log
  const other = join(lib, 'Rising Ruby (other build).3ds');
  writeFileSync(other, cci({ productCode: 'CTR-P-ECRA', titleId: OR, hashes: 'beef' }));
  const log = [];
  const b = await buildRun({ ...opts, romId: other, identity: { id: m.id, room: m.room, secret: m.secret }, buildFor: ['p2'], expectedOutputs: pack.outputs }, (l) => log.push(l));
  assert.equal(b.outputs.p2.matchesFriend, false);
  assert.ok(log.some((l) => /differs|weicht|diff/i.test(JSON.stringify(l))), JSON.stringify(log));
  // a run of the plain game carries no fingerprint per player (each plays their own release)
  const plain = await buildRun({ ...opts, romId: join(lib, 'Pokemon Omega Ruby.3ds'), hackId: null, gameTitle: 'Pokémon Omega Ruby' });
  assert.deepEqual(runPack(plain).outputs.p1, { sha1: null });
});
