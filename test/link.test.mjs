// Link sessions (trades and battles between the players of a run, docs/MULTIPLAYER.md) – everything but the link host
// itself (test/linkhost.test.mjs): which file plays each seat (server/lib/linkroms.mjs), the TURN servers
// (server/lib/linkice.mjs), the link host's arguments and the commands a page may send (server/lib/native.mjs), the
// link rooms on the "You are here" sign, the trade's log entry, and the page's protocol (web/lib/linksession.mjs): two
// players wired through a fake peer channel – invite, the partner's game, saves, go, buttons, a gap and its resend,
// a desync and the saves going back, a rejoin from the others' state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { execFileSync } from 'node:child_process';
import { ownSeat, resolveSeat, pickSeat, loadPicks, partnerBuildRequest, extractTarget } from '../server/lib/linkroms.mjs';
import { cleanIceServers, linkIceServers, resetLinkIce } from '../server/lib/linkice.mjs';
import { LIVE_RUNS_URL } from '../server/lib/liveruns.mjs';
import { linkArgs, checkLinkCommands, LCMD, LINK_SYSTEMS } from '../server/lib/native.mjs';
import { command } from '../server/lib/ctr.mjs';
import { readLocation } from '../shared/live/location.mjs';
import { EDITION } from '../shared/edition.mjs';

const ROOT = new URL('../', import.meta.url).href;
// The link sessions of a build before the 'linked' announcement (git history; the test using it is skipped without it)
const OLD_LINKSESSION = `${ROOT}web/lib/linksession.mjs?before-linked`;
let oldLinkSource = null;
try {
  oldLinkSource = execFileSync('git', ['show', '1512c29:web/lib/linksession.mjs'], { cwd: new URL(ROOT), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch {
  // a checkout without that history
}
registerHooks({
  load(url, ctx, next) {
    if (url === OLD_LINKSESSION && oldLinkSource) return { format: 'module', source: oldLinkSource, shortCircuit: true };
    return next(url, ctx);
  },
  resolve(spec, ctx, next) {
    if (spec.startsWith('/shared/')) return next(ROOT + spec.slice(1), ctx);
    if (spec === '/vendor/htm-preact.mjs') return next(ROOT + 'node_modules/htm/preact/standalone.module.js', ctx);
    if (spec.startsWith('/vendor/')) return next(ROOT + 'web' + spec, ctx);
    return next(spec, ctx);
  },
});

const dir = mkdtempSync(join(tmpdir(), 'souldew-link-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const sha1 = (b) => createHash('sha1').update(b).digest('hex');
const file = (name, bytes) => {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
};

// ---- server/lib/linkroms.mjs ---------------------------------------------------------------------------------------
test('linkroms: my own seat – its SHA-1, and the CRC only for a plain run (the library ROM as it is)', () => {
  const rom = file('a.gba', Buffer.from('emerald'));
  const runFile = (id, name) => join(dir, name);
  const plain = { id: 'r1', outputs: { p1: { rom: 'a.gba' } }, base: { crc: 'abcd1234' }, randomizer: { enabled: false } };
  assert.deepEqual(ownSeat(plain, 'p1', runFile), { path: rom, sha1: sha1(Buffer.from('emerald')), crc: 'ABCD1234' });
  assert.equal(ownSeat({ ...plain, randomizer: { enabled: true } }, 'p1', runFile).crc, null, 'a randomized game is no library ROM');
  assert.deepEqual(ownSeat(plain, 'p2', runFile), { path: null, sha1: null, crc: null });
});

test('linkroms: a seat is found by SHA-1 – the build, another build, a pick, the library by CRC (zips unpacked)', () => {
  const run = join(dir, 'run');
  mkdirSync(run, { recursive: true });
  const runFile = (id, name) => join(run, name);
  const mine = Buffer.from('my emerald'), theirs = Buffer.from('their firered'), other = Buffer.from('another file');
  writeFileSync(join(run, 'p1.gba'), mine);
  writeFileSync(join(run, 'p2.gba'), mine); // a plain run built both seats from my file
  const m = { id: 'r', outputs: { p1: { rom: 'p1.gba' }, p2: { rom: 'p2.gba' } }, randomizer: { enabled: false } };
  const deps = { runFile, dir: run, libraryRoms: [] };
  assert.equal(resolveSeat(m, 'p1', sha1(mine), null, deps).how, 'build');
  assert.equal(resolveSeat({ ...m, outputs: { p1: m.outputs.p1 } }, 'p2', sha1(mine), null, deps).how, 'same', 'the partner plays the same file as me');
  assert.equal(resolveSeat(m, 'p2', sha1(theirs), null, deps), null, 'their game isn\'t here');
  assert.equal(resolveSeat(m, 'p2', 'nope', null, deps), null);
  // the library: only a ROM with their CRC is hashed, and only an equal SHA-1 counts
  const fr = file('FireRed.gba', theirs);
  const lib = [{ id: 'x', file: file('Other.gba', other), crc: '11111111' }, { id: 'y', file: fr, crc: 'DEADBEEF' }];
  assert.equal(resolveSeat(m, 'p2', sha1(theirs), 'deadbeef', { ...deps, libraryRoms: lib }).path, fr);
  assert.ok(loadPicks(run)[sha1(theirs)], 'remembered for next time');
  assert.equal(resolveSeat(m, 'p2', sha1(theirs), null, deps).how, 'picked', 'found again without the library');
  assert.equal(resolveSeat(m, 'p2', sha1(other), '11111110', { ...deps, libraryRoms: lib }), null, 'another CRC: not looked at');
  // a zipped library ROM: unpacked (here: a stand-in) and checked
  const zipped = { id: 'z::g.gba', container: 'z.zip', entry: 'g.gba', crc: 'CAFEF00D', system: 'gba' };
  const target = extractTarget(run, zipped);
  assert.match(target, /link-g-CAFEF00D\.gba$/, "named with its CRC: another zip's same-named entry is another file");
  const ex = () => (writeFileSync(target, Buffer.from('zipped')), target);
  assert.equal(resolveSeat(m, 'p2', sha1(Buffer.from('zipped')), 'cafef00d', { ...deps, libraryRoms: [zipped], extract: ex }).path, target);
});

test('linkroms: "Pick your copy" takes a file only when its SHA-1 is the partner\'s', () => {
  const run = join(dir, 'pick');
  const good = file('good.gba', Buffer.from('same')), bad = file('bad.gba', Buffer.from('different'));
  assert.equal(pickSeat({ id: 'g', file: good }, sha1(Buffer.from('same')), { dir: run }), good);
  assert.equal(pickSeat({ id: 'b', file: bad }, sha1(Buffer.from('same')), { dir: run }), null);
  assert.equal(pickSeat(null, sha1(Buffer.from('same')), { dir: run }), null);
  assert.equal(loadPicks(run)[sha1(Buffer.from('same'))].path, good);
});

test('linkroms: "Build Tim\'s game" – the run\'s own base, patch, settings and seeds, that slot only', () => {
  const m = { id: 'r9', name: 'Run', mode: 'soullink', players: { p1: { name: 'A' }, p2: { name: 'B' } }, base: { crc: 'AAAA0001' }, game: { id: 'pokemon-emerald', hackId: null, system: 'gba' },
    patch: { sha1: 'p'.repeat(40), hackId: 'h' }, randomizer: { enabled: true, values: { x: 1 }, seeds: { p1: '1', p2: '2' }, sharedSeed: false }, expectedOutputs: { p2: { sha1: 'e'.repeat(40) } } };
  const lib = { roms: [{ id: 'rom1', crc: 'AAAA0001', gameId: 'pokemon-emerald' }], patches: [{ id: 'pat', sha1: 'p'.repeat(40) }] };
  const b = partnerBuildRequest(m, 'p2', lib);
  assert.deepEqual([b.runId, b.romId, b.patchId, b.buildFor, b.seeds, b.randomize, b.values], ['r9', 'rom1', 'pat', ['p2'], { p1: '1', p2: '2' }, true, { x: 1 }]);
  assert.deepEqual(b.expectedOutputs, m.expectedOutputs);
  assert.throws(() => partnerBuildRequest(m, 'p2', { roms: [], patches: lib.patches }), (e) => e.code === 'no-rom');
  assert.throws(() => partnerBuildRequest(m, 'p2', { roms: lib.roms, patches: [] }), (e) => e.code === 'no-patch');
});

// ---- server/lib/linkice.mjs ------------------------------------------------------------------------------------------
test('linkice: only well-formed STUN/TURN entries; TURN only with credentials', () => {
  assert.deepEqual(cleanIceServers([
    { urls: ['stun:stun.cloudflare.com:3478', 'javascript:alert(1)'] },
    { urls: 'turn:turn.cloudflare.com:3478?transport=udp', username: 'u', credential: 'c' },
    { urls: ['turns:turn.cloudflare.com:5349?transport=tcp'] }, // no credentials
    { urls: [] }, null,
  ]), [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }]);
  assert.deepEqual(cleanIceServers('x'), []);
});

test('linkice: the bot\'s /link/ice, cached while the credentials are young; STUN only when it can\'t be reached', async () => {
  resetLinkIce();
  const calls = [];
  const answer = { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }], ttl: 7200, turn: true };
  const fetchImpl = async (url) => (calls.push(url), { ok: true, json: async () => answer });
  // souldew Renaissance has no bot (shared/edition.mjs liveRunsUrl: null): nobody is asked, the page keeps this build's
  // own STUN/TURN (web/lib/sync.mjs P2P_CONFIG)
  if (!EDITION.liveRunsUrl) {
    assert.deepEqual(await linkIceServers({ fetchImpl, env: {}, now: 1 }), { iceServers: [], turn: false, ttl: 0 });
    assert.equal(calls.length, 0, 'no request without a bot');
    resetLinkIce();
  }
  const bot = EDITION.liveRunsUrl ? {} : { SOULDEW_LIVE_URL: 'https://bot.example' };
  const a = await linkIceServers({ fetchImpl, env: bot, now: 1000 });
  assert.equal(a.turn, true);
  assert.equal(a.iceServers.length, 2);
  assert.equal(calls[0], `${EDITION.liveRunsUrl ? LIVE_RUNS_URL : 'https://bot.example'}/link/ice`);
  await linkIceServers({ fetchImpl, env: bot, now: 1000 + 3600_000 });
  assert.equal(calls.length, 1, 'cached');
  await linkIceServers({ fetchImpl, env: bot, now: 1000 + 7000_000 });
  assert.equal(calls.length, 2, 'renewed before the credentials run out');
  resetLinkIce();
  const down = await linkIceServers({ fetchImpl: async () => { throw new Error('offline'); }, env: bot, now: 5 });
  assert.deepEqual(down, { iceServers: [], turn: false, ttl: 0 });
  resetLinkIce();
  assert.equal((await linkIceServers({ fetchImpl, env: { SOULDEW_LINK_ICE: 'off' } })).turn, false);
  resetLinkIce();
});

// ---- server/lib/native.mjs ---------------------------------------------------------------------------------------------
test('native: link host arguments – every system incl. the DS, a rejoin\'s state, the clock', () => {
  assert.ok(LINK_SYSTEMS.includes('nds') && LINK_SYSTEMS.includes('gb') && LINK_SYSTEMS.includes('gba'));
  const a = linkArgs({ system: 'nds', roms: ['/a.nds', '/b.nds'], saves: ['/a.sav', null], local: 1, delay: 6, rtc: 1234, state: '/s.state' });
  assert.deepEqual(a.slice(0, 12), ['--rom', '/a.nds', '--sram', '/a.sav', '--state', '-', '--rom', '/b.nds', '--sram', '-', '--state', '-']);
  assert.deepEqual(a.slice(a.indexOf('--local'), a.indexOf('--local') + 7), ['--local', '1', '--net', '--delay', '6', '--rtc', '1234']);
  assert.ok(a.includes('--ram') && a[a.indexOf('--ram') + 1] === '0x2000000:0x400000', 'the DS main RAM for live tracking');
  assert.deepEqual(a.slice(-2), ['--load', '/s.state']);
  // seamless: a seat whose game was running starts from its state (the fast player's), the others from their saves
  const b = linkArgs({ system: 'gba', roms: ['/a.gba', '/b.gba'], saves: ['/a.sav', '/b.sav'], states: ['/a.state', null], local: 0, delay: 4, rtc: 1 });
  assert.deepEqual(b.slice(0, 12), ['--rom', '/a.gba', '--sram', '/a.sav', '--state', '/a.state', '--rom', '/b.gba', '--sram', '/b.sav', '--state', '-']);
  assert.ok(!b.includes('--load'));
  // Game Boy seats: each on its player's console (the same list on every peer); a GBC game always on a GBC
  const gb = linkArgs({ system: 'gb', roms: ['/a.gb', '/b.gb'], saves: [], models: ['dmg', 'cgb'], local: 0, delay: 4, rtc: 1 });
  assert.deepEqual(gb.filter((x, i, l) => l[i - 1] === '--model'), ['dmg', 'cgb']);
  const gbc = linkArgs({ system: 'gbc', roms: ['/a.gbc', '/b.gbc'], saves: [], models: ['cgb', null], local: 0, delay: 4, rtc: 1 });
  assert.deepEqual(gbc.filter((x, i, l) => l[i - 1] === '--model'), ['cgb', 'cgb']);
  // Blue (gb, the original Game Boy) ↔ Yellow (gbc): the Blue player's computer has system 'gb', the Yellow player's
  // 'gbc' – both must form the same consoles from the announced list (the e2e found the invite refused before)
  const blue = linkArgs({ system: 'gb', roms: ['/blue.gb', '/yellow.gb'], saves: [], models: ['dmg', 'cgb'], local: 0, delay: 4, rtc: 1 });
  const yellow = linkArgs({ system: 'gbc', roms: ['/blue.gb', '/yellow.gb'], saves: [], models: ['dmg', 'cgb'], local: 1, delay: 4, rtc: 1 });
  const models = (a) => a.filter((x, i, l) => l[i - 1] === '--model');
  assert.deepEqual(models(blue), ['dmg', 'cgb']);
  assert.deepEqual(models(yellow), models(blue), 'the same consoles on both computers');
  // the e2e's recording and fixed clock: only with SLS_E2E=1 – a stray variable never changes a real session
  const env = { SLS_LINK_TEST_SCRIPT: '/rec', SLS_LINK_TEST_RTC: '42' };
  const plain = linkArgs({ system: 'gba', roms: ['/a', '/b'], saves: [], local: 0, rtc: 7, env });
  assert.ok(!plain.includes('--script') && plain[plain.indexOf('--rtc') + 1] === '7');
  const e2e = linkArgs({ system: 'gba', roms: ['/a', '/b'], saves: [], local: 0, rtc: 7, env: { ...env, SLS_E2E: '1' } });
  assert.ok(e2e.includes('--script') && e2e[e2e.indexOf('--rtc') + 1] === '42');
  assert.throws(() => linkArgs({ system: '3ds', roms: ['a', 'b'], saves: [], local: 0 }), { code: 'linkSystem' });
  assert.throws(() => linkArgs({ system: 'gba', roms: ['a'], saves: [], local: 0 }), { code: 'linkSeats' });
});

test('native: a page may send a link session buttons, a peer\'s request, a session state request, a small READ – never LOAD, POKE', () => {
  const u32 = (...v) => Buffer.from(new Uint32Array(v).buffer);
  const ok = Buffer.concat([command(LCMD.INPUT, Buffer.alloc(17)), command(LCMD.RINPUT, u32(1, 10, 5)), command(LCMD.NEED, u32(1, 10)), command(LCMD.SAVE), command(LCMD.UNTIL, u32(99)),
    command(LCMD.SEATSTATE, u32(300)), command(LCMD.READ, u32(1, 0x0202433a, 1)), command(LCMD.READ, u32(0, 0x02000000, 4096))]);
  assert.equal(checkLinkCommands(ok), ok);
  for (const bad of [command(4, Buffer.alloc(8)), command(23, u32(0, 0, 1)), command(22, u32(0, 0, 4097)), command(22, u32(0, 0)), command(LCMD.NEED, u32(1)), command(LCMD.RINPUT, Buffer.alloc(9)), command(LCMD.SEATSTATE, Buffer.alloc(0))]) {
    assert.throws(() => checkLinkCommands(bad), { code: 'badCommand' });
  }
});

// ---- the "You are here" sign in a link room --------------------------------------------------------------------------
test('location: the link rooms are named as such, not after the place their map number shares', () => {
  const maps = JSON.parse(readFileSync(new URL('../shared/data/maps.json', import.meta.url), 'utf8'));
  const bus = (cells) => (addr, len) => Uint8Array.from({ length: len }, (_, i) => cells[addr + i] ?? 0);
  const at = (base, bytes) => Object.fromEntries(bytes.map((b, i) => [base + i, b]));
  // (Gen 1: wCurMap, and the header copy after it loaded – its height and width are never 0; zeroed WRAM is no place)
  const gen1 = (map) => at(0xd35e, [map, 0, 0, 0, 0, 0, 0, 0, 0, 0x0e, 4, 5]);
  assert.deepEqual(readLocation(maps, 'red_us', bus(gen1(0xef))), { gen: 1, id: 'link:trade', link: 'trade', map: 0xef });
  assert.equal(readLocation(maps, 'red_us', bus(gen1(0xf0))).link, 'colosseum');
  assert.equal(readLocation(maps, 'red_us', bus(at(0xd35e, [0xef]))), null, 'no header loaded yet: no place');
  assert.equal(readLocation(maps, 'crystal_us', bus(at(0xdcb5, [20, 2]))).link, 'trade');
  assert.equal(readLocation(maps, 'silver_us', bus(at(0xda00, [20, 3]))).link, 'colosseum');
  // Gen 3: the header the link host read in Emerald's Trade Center (MAPSEC 0x57, music 0x1A6) – and the S.S. Tidal
  const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
  const hdr = (music, sec) => [...le(0x08442540), ...le(0x08539de8), ...le(0x0823b77e), 0, 0, 0, 0, music & 0xff, music >> 8, 0xde, 0, sec, 0, 0, 8];
  assert.equal(readLocation(maps, 'emerald_us', bus(at(0x02037318, hdr(0x1a6, 0x57)))).link, 'cableclub');
  assert.equal(readLocation(maps, 'emerald_us', bus(at(0x02037318, hdr(0x190, 0x57)))).link, undefined, 'a real place with that MAPSEC');
  // Platinum: the save data (behind its pointer) says map 466 – the Union Room
  // (the save data holds a named trainer – "Lou", money, a gender – or it is no save data: gen4HasTrainer)
  const trainer = [0x16, 0x01, 0x19, 0x01, 0x1f, 0x01, 0xff, 0xff, ...Array(12).fill(0), ...le(3000), 0];
  const pt = { ...at(0x02101d40, le(0x0227e148)), ...at(0x0227e148 + 0x1294, le(466)), ...at(0x0227e148 + 0x14 + 0x68, trainer) };
  assert.equal(readLocation(maps, 'platinum_us', bus(pt)).link, 'union');
  // the other Gen 4 games and the wireless club's Colosseums (pret's map constants): the same save data, its own map id
  const save4 = (ptr, base, mapOff, trainerOff, map) => ({ ...at(ptr, le(base)), ...at(base + mapOff, le(map)), ...at(base + trainerOff, trainer) });
  assert.equal(readLocation(maps, 'platinum_us', bus(save4(0x02101d40, 0x0227e148, 0x1294, 0x14 + 0x68, 332))).link, 'colosseum');
  assert.equal(readLocation(maps, 'platinum_us', bus(save4(0x02101d40, 0x0227e148, 0x1294, 0x14 + 0x68, 333))).link, 'colosseum');
  for (const id of ['diamond_us', 'pearl_us']) {
    assert.equal(readLocation(maps, id, bus(save4(0x02106fc0, 0x0227e148, 0x144c, 0x214 + 0x64, 466))).link, 'union', id);
    assert.equal(readLocation(maps, id, bus(save4(0x02106fc0, 0x0227e148, 0x144c, 0x214 + 0x64, 332))).link, 'colosseum', id);
  }
  for (const id of ['heartgold_us', 'soulsilver_us']) {
    assert.equal(readLocation(maps, id, bus(save4(0x02111880, 0x0227e148, 0x1244, 0x10 + 0x64, 2))).link, 'union', id);
    assert.equal(readLocation(maps, id, bus(save4(0x02111880, 0x0227e148, 0x1244, 0x10 + 0x64, 4))).link, 'colosseum', id);
    assert.equal(readLocation(maps, id, bus(save4(0x02111880, 0x0227e148, 0x1244, 0x10 + 0x64, 5))).link, 'colosseum', id);
    assert.equal(readLocation(maps, id, bus(save4(0x02111880, 0x0227e148, 0x1244, 0x10 + 0x64, 466))).link, undefined, `${id}: 466 is a place of Johto`);
  }
});

test('location: the Gen 5 Union Room (zone 422, no place in the ROM\'s table) is named as such – Black/White and Black 2/White 2', () => {
  const maps = JSON.parse(readFileSync(new URL('../shared/data/maps.json', import.meta.url), 'utf8'));
  const n = 427;
  const zones = new Uint8Array(n * 48);
  for (let z = 0; z < n; z++) {
    zones[z * 48] = 0x10;
    zones[z * 48 + 0x08] = z & 0xff; zones[z * 48 + 0x09] = z >> 8;
    zones[z * 48 + 0x16] = z & 0xff; zones[z * 48 + 0x17] = z >> 8;
    zones[z * 48 + 0x18] = z & 0xff; zones[z * 48 + 0x19] = z >> 8;
  }
  const mapLoc = Array.from({ length: n }, (_, z) => (z === 397 || z === 398 ? 5 : z === 422 || z === 150 || z === 151 ? 0 : 1));
  const names = Object.assign(new Array(117).fill('Somewhere'), { 0: '', 5: 'Accumula Town' });
  const hex = Array.from(zones, (v) => v.toString(16).padStart(2, '0')).join('');
  const ram = new Uint8Array(0x400000);
  const read = (a, len) => (a >= 0x02000000 && a + len <= 0x02400000 ? ram.subarray(a - 0x02000000, a - 0x02000000 + len) : null);
  const copy = (a, z) => { ram.set(zones.subarray(z * 48, z * 48 + 48), a - 0x02000000); ram[a - 0x02000000 + 0x30] = z & 0xff; ram[a - 0x02000000 + 0x31] = z >> 8; };
  const black = { gen: 5, family: 'bw', code: 'IRBO', lang: 'en', mapLoc, names, zoneHeaders: hex };
  copy(0x0225929c, 422); // (as the link host read it: both consoles in the Union Room)
  const u = readLocation(maps, { id: 'black_us', gen: 5 }, read, { rom: black });
  assert.deepEqual([u.id, u.link, u.map], ['link:union', 'union', 422]);
  copy(0x0225929c, 398); // the Pokémon Center downstairs: Accumula Town as before
  assert.equal(readLocation(maps, { id: 'black_us', gen: 5 }, read, { rom: black })?.id, 5);
  copy(0x0225929c, 150); // the Colosseum a Union Room battle goes to
  assert.equal(readLocation(maps, { id: 'black_us', gen: 5 }, read, { rom: black })?.link, 'colosseum');
  // Black 2: the copy behind the main pointer (+0x41B2C), matched by the zone id after it
  ram.fill(0);
  ram.set([0xa0, 0xe1, 0x21, 0x02], 0x24);
  const b2 = { ...black, family: 'b2w2', code: 'IREO' };
  copy(0x0221e1a0 + 0x41b2c, 422);
  assert.equal(readLocation(maps, { id: 'black2_us', gen: 5 }, read, { rom: b2 })?.link, 'union');
  // White 2: the same zones, but not run in a link room yet – no sign there
  assert.equal(readLocation(maps, { id: 'white2_us', gen: 5 }, read, { rom: { ...b2, code: 'IRDO' } })?.link, undefined);
});

// ---- the trade's log entry --------------------------------------------------------------------------------------------
test('run: a trade in a link session is logged from the team before and after', async () => {
  const { RunDoc } = await import('../web/lib/doc.mjs');
  const R = await import('../web/lib/run.mjs');
  const d = new RunDoc('t');
  d.by = 'a';
  d._persistSoon = () => {};
  const m = { id: 'r', mode: 'soullink', game: { system: 'gba' }, players: { p1: { name: 'Sam' }, p2: { name: 'Tim' } } };
  const before = [{ key: 'a', species: 255 }, { key: 'b', species: 261 }];
  assert.equal(R.logLinkTrade(d, m, 'p1', 'p2', before, before), false, 'nothing changed: no entry');
  // Gen 2 (the recorded Crystal ↔ Silver trade): Cyndaquil and Pidgey share trainer ID and DVs – the same key
  const d2 = new RunDoc('t2');
  d2.by = 'a';
  d2._persistSoon = () => {};
  const crystal = [{ key: 'g2-75bf-dae8', species: 155 }, { key: 'g2-75bf-dae8', species: 16 }];
  assert.equal(R.logLinkTrade(d2, m, 'p1', 'p2', crystal, [{ key: 'g2-75bf-dae8', species: 16 }, { key: 'g2-1ba3-cb32', species: 158 }]), true, 'Cyndaquil left, Totodile came');
  const e2 = Object.values(d2.scan('feed:')).map((v) => v?.v ?? v).find((x) => x?.type === 'trade');
  assert.deepEqual([e2.gave, e2.got], [[155], [158]]);
  assert.equal(R.logLinkTrade(d2, m, 'p1', 'p2', crystal, [...crystal].reverse()), false, 'the same two in another order: no trade');
  assert.equal(R.logLinkTrade(d, m, 'p1', 'p2', before, [{ key: 'a', species: 255 }, { key: 'c', species: 265 }]), true);
  const f = R.feedList(d).find((x) => x.type === 'trade' || /traded/.test(x.text || ''));
  assert.ok(f, 'in the log');
});

// ---- web/lib/linksession.mjs: two players over a fake peer channel ---------------------------------------------------
/** Browser bits the page module uses, for Node. */
function browserGlobals() {
  const listeners = new Set();
  globalThis.location = { origin: 'http://127.0.0.1:7373' };
  globalThis.addEventListener = (t, fn) => t === 'message' && listeners.add(fn);
  globalThis.removeEventListener = (t, fn) => listeners.delete(fn);
  globalThis.window = { dispatchEvent: () => {} };
  const ls = new Map();
  globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
  return { post: (data) => listeners.forEach((fn) => fn({ origin: 'http://127.0.0.1:7373', data })), ls };
}

/** Two pages of one run (p1 = Sam, p2 = Tim): their channel, their servers (fetch), what reached the link hosts. */
async function pair({ missingOnB = false, seamless = false, binary = false, saveStatus = 200, consoles = null, oldB = false, rules = {}, third = null, beforeRestore = undefined, system = 'gba' } = {}) {
  const g = browserGlobals();
  const { LinkSessions } = await import('../web/lib/linksession.mjs');
  const roms = { p1: 'a'.repeat(40), p2: 'b'.repeat(40), p3: 'c'.repeat(40) };
  const peers = {};
  const net = { delivered: 0, drop: false, log: [] };
  // third: a third player of the run (p3, not in the session) – 'new' or an older build ('old': web/lib/linksession.mjs
  // as it was before the 'linked' announcement); the channel then knows every player (sync.others)
  const sync = (slot) => ({
    ...(third ? { others: ['p1', 'p2', 'p3'].filter((s) => s !== slot) } : {}),
    onLink: (fn) => ((peers[slot] = fn), () => delete peers[slot]),
    sendLink: (msg, to) => {
      // (oldB: B's souldew is an older 3.0 build – it knows no caps and no wager)
      const old = (m) => Object.fromEntries(Object.entries(m).filter(([k]) => !['caps', 'wager', 'format'].includes(k)));
      for (const t of to) {
        if (net.drop && msg.t === 'in') continue;
        if (oldB && (slot === 'p2' || t === 'p2')) msg = old(msg);
        net.log.push({ from: slot, to: t, t: msg.t });
        queueMicrotask(() => peers[t]?.({ ...msg, from: slot }));
      }
      return true;
    },
    linkDirect: () => true,
    linkRoute: async () => ({ route: 'relayed', rtt: 40 }),
    // (binary: the channel's binary transfer for states, as web/lib/sync.mjs sendLinkBinary)
    ...(binary ? { sendLinkBinary: (msg, bytes, to) => {
      for (const t of to) { net.log.push({ from: slot, to: t, t: msg.t, bin: bytes.length }); queueMicrotask(() => peers[t]?.({ ...msg, from: slot, bin: bytes })); }
      return true;
    } } : {}),
  });
  const server = { p3: { cmds: [], starts: [], restores: [], missing: [] }, p1: { cmds: [], starts: [], restores: [], missing: [] }, p2: { cmds: [], starts: [], restores: [], missing: missingOnB ? [{ slot: 'p1', canBuild: false }] : [] } };
  /** Each player's own local server. */
  const fetchFor = (who) => async (url, opts = {}) => {
    const s = server[who];
    const body = opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    const json = (v) => ({ ok: true, status: 200, json: async () => v });
    if (url.startsWith('/api/link/check')) return json({ tool: true, supported: true, system, slots: { [who]: { rom: true, sha1: roms[who], crc: null } } });
    if (url === '/api/link/resolve') return json({ seats: {}, missing: s.missing });
    if (url === '/api/link/pick') { s.missing = []; return json({ ok: true }); }
    if (url.startsWith('/api/runs/')) return { ok: saveStatus === 200, status: saveStatus, arrayBuffer: async () => new TextEncoder().encode(`save of ${who}`).buffer };
    if (url === '/api/link/start') { s.starts.push(body); return json({ id: `host-${who}`, local: body.seats.findIndex((x) => x.slot === who), seats: 2 }); }
    if (url === '/api/link/restore') { s.restores.push(body); return json({ ok: true, restored: true, backup: 'p.link-x.sav' }); }
    if (url.startsWith('/api/native/cmd')) { s.cmds.push(new Uint8Array(opts.body)); return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }; }
    throw new Error(`unexpected ${url}`);
  };
  const closed = { p1: 0, p2: 0, p3: 0 };
  const emuState = { p1: null, p2: null, p3: null };
  // seamless: each player's game runs in the fast player – what the page asked of it is logged
  const emuLog = { p1: [], p2: [], p3: [] };
  // consoles: every seat's memory (seat → { read(addr, len) }) – every peer's link host runs the same consoles
  const emuFor = (slot) => ({
    linkState: async () => emuState[slot],
    ...(consoles ? { linkRead: async (seat, addr, len) => consoles[seat].read(addr, len), linkSeatSaves: async () => null } : {}),
    ...(seamless ? {
      linkSnapshot: async () => (emuLog[slot].push(['snapshot']), { state: new TextEncoder().encode(`running game of ${slot} `.repeat(500)), frame: 1234, model: slot === 'p1' ? 'dmg' : 'cgb' }),
      linkSnapshotCancel: async (st) => (emuLog[slot].push(['cancel', !!st]), true),
      attachLink: (id) => (emuLog[slot].push(['attach', id]), true),
      resumeSolo: async (from) => (emuLog[slot].push(['resume', from ? new TextDecoder().decode(from.state).slice(0, 22) : null]), true),
    } : {}),
  });
  const results = { p1: [], p2: [], p3: [] };
  const changes = { p1: 0, p2: 0, p3: 0 };
  const OldLinkSessions = third === 'old' ? (await import(OLD_LINKSESSION)).LinkSessions : null;
  const mk = (slot, Cls = LinkSessions) => new Cls({ sync: sync(slot), runId: 'run1', me: slot, onChange: () => changes[slot]++, openSession: () => {}, closeSession: () => closed[slot]++,
    emu: () => emuFor(slot), ownGame: () => seamless, fetchImpl: fetchFor(slot), rules: () => rules, onResult: (e) => results[slot].push(e),
    ...(beforeRestore ? { beforeRestore: (st) => beforeRestore(slot, st) } : {}) });
  const A = mk('p1'), B = mk('p2');
  const C = third ? mk('p3', OldLinkSessions || LinkSessions) : null;
  const settle = async (ms = 1700) => { for (let i = 0; i < ms / 50; i++) await new Promise((r) => setTimeout(r, 50)); };
  const as = (slot, fn) => fn; // (each page has its own server now)
  return { A, B, C, g, server, net, as, settle, closed, emuState, emuLog, roms, fetchFor, sync, results, changes };
}

test('linksession: invite → join → every game here → saves → go: both link hosts start with the same seats', async () => {
  const { A, B, server, as, settle, roms } = await pair();
  await as('p1', () => A.invite('trade', ['p2']))();
  await settle(100);
  assert.equal(B.state.phase, 'invited');
  await as('p2', () => B.accept())();
  await settle(3500);
  assert.equal(A.state.phase, 'running', JSON.stringify(A.state.ended));
  assert.equal(B.state.phase, 'running');
  const [sa, sb] = [server.p1.starts[0], server.p2.starts[0]];
  assert.deepEqual(sa.seats.map((s) => [s.slot, s.sha1]), [['p1', roms.p1], ['p2', roms.p2]]);
  assert.deepEqual(sb.seats.map((s) => [s.slot, s.sha1]), [['p1', roms.p1], ['p2', roms.p2]]);
  assert.equal(sa.delay, sb.delay);
  assert.equal(sa.rtc, sb.rtc, 'one clock for every console');
  assert.ok(sa.seats[1].save && !sa.seats[0].save, 'A gets B\'s save, its own comes from its disk');
  assert.match(sa.seats[1].saveSha1, /^[0-9a-f]{40}$/, 'with its SHA-1 (the server checks it)');
  A.stop(), B.stop();
});

test('linksession, seamless: the running games go into the session (every host the same states) and on alone after it', async () => {
  const { A, B, server, settle, emuLog, net } = await pair({ seamless: true });
  await A.invite('trade', ['p2']);
  await settle(100);
  await B.accept();
  await settle(4000);
  assert.equal(A.state.phase, 'running', JSON.stringify(A.state.ended));
  assert.equal(B.state.phase, 'running');
  // the round trips were measured before the states went out (snapnow), then each game's state went to the partner
  const order = net.log.filter((m) => m.from === 'p1').map((m) => m.t);
  assert.ok(order.lastIndexOf('ping') < order.indexOf('snapnow') && order.indexOf('snapnow') < order.indexOf('snap'), order.join(' '));
  const [sa, sb] = [server.p1.starts[0], server.p2.starts[0]];
  for (const st of [sa, sb]) for (const seat of st.seats) {
    assert.ok(seat.state && /^[0-9a-f]{40}$/.test(seat.stateSha1), `${seat.slot} starts from its running game`);
  }
  assert.deepEqual(sa.seats.map((x) => [x.state, x.stateSha1]), sb.seats.map((x) => [x.state, x.stateSha1]), 'every host gets the same states');
  assert.deepEqual(sa.seats.map((x) => x.model), ['dmg', 'cgb'], 'each seat on its running game\'s console (a Game Boy linked with a GBC)');
  assert.deepEqual(sb.seats.map((x) => x.model), ['dmg', 'cgb']);
  assert.deepEqual(emuLog.p1, [['snapshot'], ['attach', 'host-p1']]);
  assert.deepEqual(emuLog.p2, [['snapshot'], ['attach', 'host-p2']]);
  assert.equal(A.state.seamless, true);
  // leave: each console goes on alone from where the session left it (no state given: the link host's own)
  A.leave('left');
  await settle(300);
  assert.equal(B.state.phase, 'ended');
  assert.deepEqual(emuLog.p1.at(-1), ['resume', null]);
  assert.deepEqual(emuLog.p2.at(-1), ['resume', null]);
  assert.equal(A.state.ended.resumed, true);
  A.stop(), B.stop();
  // out of step: back to the game as it was before the link
  const p = await pair({ seamless: true });
  await p.A.invite('trade', ['p2']);
  await p.settle(100);
  await p.B.accept();
  await p.settle(4000);
  p.A._hash('p1', 240, 'aaaa');
  p.A._hash('p2', 240, 'bbbb');
  await p.settle(800);
  assert.equal(p.A.state.ended?.reason, 'linkDesync');
  assert.equal(p.server.p1.restores.length, 1, 'the run\'s save goes back as before');
  assert.deepEqual(p.emuLog.p1.at(-1), ['resume', 'running game of p1 run']);
  assert.deepEqual(p.emuLog.p2.at(-1), ['resume', 'running game of p2 run']);
  p.A.stop(), p.B.stop();
});

test('linksession: states go as bytes when the channel can; a busy player says so; nothing of a session carries over', async () => {
  const { A, B, server, settle, net } = await pair({ seamless: true, binary: true });
  await A.invite('trade', ['p2']);
  await settle(100);
  await B.accept();
  await settle(4000);
  assert.equal(A.state.phase, 'running');
  assert.ok(net.log.some((m) => m.t === 'snap' && m.bin > 0), 'the snap went as bytes');
  assert.deepEqual(server.p1.starts[0].seats.map((x) => x.stateSha1), server.p2.starts[0].seats.map((x) => x.stateSha1));
  // B is in this session: another invite to it is answered with "busy"
  await B._in({ t: 'invite', sid: 'other', seats: ['p3', 'p2'], from: 'p1', kind: 'trade' });
  assert.ok(net.log.some((m) => m.from === 'p2' && m.t === 'refuse'), 'busy');
  assert.equal(B.state.phase, 'running', 'the running session goes on');
  A.leave('left');
  await settle(300);
  // a new session starts clean: no id, models or snaps of the last one
  await A.invite('battle', ['p2']);
  assert.equal(A.state.id, undefined);
  assert.deepEqual(A.state.snaps, {});
  assert.equal(A.state.models, undefined);
  A.stop(), B.stop();
});

test('linksession, bystander: the players outside a session see who is linked with whom – until it ends', async () => {
  const { A, B, C, settle, net, changes } = await pair({ third: 'new' });
  await A.invite('trade', ['p2']);
  await settle(100);
  assert.equal(C.linkedElsewhere('p1'), null, 'only invited: nothing said yet');
  await B.accept();
  await settle(3500);
  assert.equal(A.state.phase, 'running');
  assert.equal(C.state.phase, 'idle', 'the third player isn\'t part of it');
  assert.deepEqual(C.linkedElsewhere('p1'), { seats: ['p1', 'p2'], kind: 'trade' });
  assert.deepEqual(C.linkedElsewhere('p2'), { seats: ['p1', 'p2'], kind: 'trade' });
  assert.ok(changes.p3 > 0, 'the third player\'s page re-renders');
  assert.equal(A.linkedElsewhere('p2'), null, 'the seats know their own session');
  const said = net.log.filter((m) => m.t === 'linked');
  assert.ok(said.length >= 2 && said.every((m) => m.to === 'p3'), 'told only to the players outside the session');
  // a heartbeat brings it to a page that wasn't there yet (reload, came online)
  C.elsewhere = {};
  A._announce(true);
  await settle(100);
  assert.deepEqual(C.linkedElsewhere('p1')?.seats, ['p1', 'p2']);
  // only ever about the sender itself: a claim for others, or a session with me in it, is dropped
  await C._in({ t: 'linked', on: true, seats: ['p2', 'p4'], kind: 'battle', from: 'p1' });
  await C._in({ t: 'linked', on: true, seats: ['p1', 'p3'], kind: 'battle', from: 'p1' });
  await C._in({ t: 'linked', on: true, seats: ['p4', 'p4'], kind: 'battle', from: 'p4' });
  assert.deepEqual(C.linkedElsewhere('p1'), { seats: ['p1', 'p2'], kind: 'trade' });
  assert.equal(C.linkedElsewhere('p4'), null);
  // the session ends: cleared right away
  A.leave('left');
  await settle(300);
  assert.equal(C.linkedElsewhere('p1'), null);
  assert.equal(C.linkedElsewhere('p2'), null);
  // a seat that went quiet (crash, closed page) is no longer shown after a while
  await C._in({ t: 'linked', on: true, seats: ['p1', 'p2'], kind: 'battle', from: 'p2' });
  assert.equal(C.linkedElsewhere('p2')?.kind, 'battle');
  C.elsewhere.p2.at -= 11000;
  assert.equal(C.linkedElsewhere('p2'), null);
  const before = changes.p3;
  C._expire();
  assert.deepEqual(C.elsewhere, {});
  assert.equal(changes.p3, before + 1);
  A.stop(), B.stop(), C.stop();
});

test('board: a partner linked with others – "In a link with Tim" on their card, Trade / Battle wait (the reason as their hint)', async () => {
  const { linkedText } = await import('../web/views/linkplay.mjs');
  const names = { p1: { name: 'Sam' }, p2: { name: 'Tim' }, p3: { name: 'Lou' }, p4: { name: 'Robin' } };
  const sessions = (e) => ({ linkedElsewhere: (s) => e[s] || null });
  assert.equal(linkedText(sessions({ p1: { seats: ['p1', 'p2'], kind: 'trade' } }), 'p1', names), 'In a link with Tim');
  assert.equal(linkedText(sessions({ p2: { seats: ['p1', 'p2'], kind: 'trade' } }), 'p2', names), 'In a link with Sam');
  assert.equal(linkedText(sessions({ p1: { seats: ['p1', 'p2', 'p4'], kind: 'battle' } }), 'p1', names), 'In a link battle with Tim, Robin');
  assert.equal(linkedText(sessions({}), 'p1', names), null, 'not linked: nothing');
  assert.equal(linkedText(null, 'p1', names), null);
  assert.equal(linkedText({}, 'p1', names), null, '(a page without the announcement)');
});

test('linksession, bystander: an older 3.0 build ignores the announcement – idle, after a session, or in its own', { skip: !oldLinkSource && 'no git history' }, async () => {
  const { A, B, C, settle, net } = await pair({ third: 'old' });
  assert.equal(typeof C.linkedElsewhere, 'undefined', 'the build before it');
  await A.invite('trade', ['p2']);
  await settle(100);
  await B.accept();
  await settle(3500);
  assert.equal(A.state.phase, 'running');
  assert.ok(net.log.some((m) => m.t === 'linked' && m.to === 'p3'), 'it was told');
  assert.equal(C.state.phase, 'idle');
  assert.ok(!net.log.some((m) => m.from === 'p3'), 'and said nothing back');
  // in a session of its own (with a fourth player) and after one: still untouched
  C._new({ phase: 'running', sid: 'own', seats: ['p3', 'p4'], kind: 'battle' });
  await C._in({ t: 'linked', on: true, seats: ['p1', 'p2'], kind: 'trade', from: 'p1' });
  await C._in({ t: 'linked', on: false, from: 'p1' });
  assert.equal(C.state.phase, 'running');
  C._set({ phase: 'ended' });
  await C._in({ t: 'linked', on: true, seats: ['p1', 'p2'], kind: 'trade', from: 'p1' });
  assert.equal(C.state.phase, 'ended');
  assert.ok(!net.log.some((m) => m.from === 'p3'));
  A.leave('left');
  await settle(300);
  A.stop(), B.stop(), C.stop();
});

test('linksession: our save that can\'t be read stops the start (a partner would boot a blank cartridge)', async () => {
  const { A, B, settle, server } = await pair({ saveStatus: 500 });
  await A.invite('trade', ['p2']);
  await settle(100);
  await B.accept();
  await settle(3500);
  assert.notEqual(A.state.phase, 'running');
  assert.equal(server.p1.starts.length + server.p2.starts.length, 0, 'no host started');
  A.stop(), B.stop();
});

test('linksession: the partner\'s game missing → "need" until picked; buttons flow; a gap is asked for and resent; hashes', async () => {
  const { A, B, g, server, as, settle, net } = await pair({ missingOnB: true });
  await as('p1', () => A.invite('battle', ['p2']))();
  await settle(100);
  await as('p2', () => B.accept())();
  await settle(2500);
  assert.equal(B.state.phase, 'need');
  assert.deepEqual(B.state.missing.map((m) => m.slot), ['p1']);
  assert.equal(A.state.phase, 'preparing', 'A waits for B to be ready');
  await as('p2', () => B.pickRom('p1', 'lib-rom'))();
  await settle(2500);
  assert.equal(A.state.phase, 'running');
  assert.equal(B.state.phase, 'running');
  // A's host sends its seat's buttons (LINPUT) → they reach B's host as RINPUT
  const linput = (seat, first, ks) => { const b = new Uint8Array(8 + ks.length * 4); const v = new DataView(b.buffer); v.setUint32(0, seat, true); v.setUint32(4, first, true); ks.forEach((k, i) => v.setUint32(8 + i * 4, k, true)); return b; };
  g.post({ type: 'emu-link-input', bytes: linput(0, 10, [1, 2, 3]) });
  await settle(200);
  const words = (b) => [...new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))];
  assert.deepEqual(words(server.p2.cmds.at(-1)), [21, 20, 0, 10, 1, 2, 3], 'RINPUT seat 0 from frame 10');
  // B's host waits for seat 0 at frame 13: B asks, A's host is told NEED (25) seat 0 from 13
  g.post({ type: 'emu-link-wait', seats: 1, frame: 13, ms: 300 });
  await settle(200);
  assert.ok(net.log.some((m) => m.from === 'p2' && m.t === 'need'));
  assert.ok(server.p1.cmds.some((c) => words(c)[0] === 25 && words(c)[2] === 0 && words(c)[3] === 13), 'NEED to A\'s host');
  // equal hashes: nothing happens
  g.post({ type: 'emu-link-hash', frame: 120, hash: 'aaaa' });
  await settle(200);
  assert.equal(A.state.phase, 'running');
  A.stop(), B.stop();
});

test('linksession: hashes differ → the session ends on both, each run\'s save goes back to before the link', async () => {
  const { A, B, server, as, settle, closed } = await pair();
  await as('p1', () => A.invite('trade', ['p2']))();
  await settle(100);
  await as('p2', () => B.accept())();
  await settle(3500);
  assert.equal(A.state.phase, 'running');
  A._hash('p1', 240, 'aaaa');
  A._hash('p2', 240, 'bbbb'); // (B's hash for that frame arrives – another one)
  await settle(800);
  assert.equal(A.state.phase, 'ended');
  assert.equal(B.state.phase, 'ended');
  assert.equal(A.state.ended.reason, 'linkDesync');
  assert.equal(B.state.ended.reason, 'linkDesync');
  assert.equal(server.p1.restores.length, 1);
  assert.equal(server.p2.restores.length, 1);
  assert.deepEqual([server.p1.restores[0].slot, server.p2.restores[0].slot], ['p1', 'p2']);
  assert.equal(A.state.ended.restored.backup, 'p.link-x.sav');
  // both sides may see it at once: the other's bye arriving afterwards changes nothing (no second restore)
  await A._in({ t: 'bye', reason: 'linkDesync', sid: A.state.sid, from: 'p2' });
  assert.equal(server.p1.restores.length, 1);
  assert.equal(A.state.ended.restored.backup, 'p.link-x.sav');
  assert.equal(closed.p1 + closed.p2, 2);
  A.stop(), B.stop();
});

test('linksession: a link that stands still is never silent – waiting at one frame for a minute ends it on both with a message, each game goes on', async () => {
  const { A, B, g, settle, closed, emuLog } = await pair({ seamless: true });
  const { STALL_MS } = await import('../web/lib/linksession.mjs');
  const { diagDump } = await import('../web/lib/diag.mjs');
  await A.invite('trade', ['p2']);
  await settle(100);
  await B.accept();
  await settle(3500);
  assert.equal(A.state.phase, 'running');
  // the host waits at frame 500 (the page hears it every 250 ms) – a short wait is only shown, nothing ends
  g.post({ type: 'emu-link-wait', seats: 2, frame: 500, ms: 250 });
  await settle(100);
  assert.equal(A.state.phase, 'running');
  assert.ok(A.state.waiting, 'the bar says it waits');
  // frames go on (a hash) and a wait at another frame: the clock starts again
  A.stall.since -= STALL_MS - 1000;
  g.post({ type: 'emu-link-hash', frame: 600, hash: 'aaaa', done: [600, 600], have: [604, 603] });
  await settle(50);
  assert.equal(A.stall, null, 'frames went on');
  g.post({ type: 'emu-link-wait', seats: 2, frame: 700, ms: 250 });
  await settle(50);
  assert.equal(A.state.phase, 'running');
  // a partner coming back (rejoin) has a reason and an end: no stall meanwhile
  A.stall.since -= STALL_MS;
  await A._in({ t: 'rejoin', sid: A.state.sid, from: 'p2' }).catch(() => {});
  assert.equal(A.stall, null);
  // still at frame 700 a minute later: the link ends – on both (the bye), with the message, each game alone again
  g.post({ type: 'emu-link-wait', seats: 2, frame: 700, ms: 250 });
  await settle(50);
  A.stall.since -= STALL_MS;
  B.stall = null; // (B's host is not the one waiting)
  g.post({ type: 'emu-link-wait', seats: 2, frame: 700, ms: 250 });
  await settle(800);
  assert.equal(A.state.phase, 'ended');
  assert.equal(B.state.phase, 'ended');
  assert.equal(A.state.ended.reason, 'linkStalled');
  assert.equal(B.state.ended.reason, 'linkStalled');
  assert.equal(A.state.ended.mine, true);
  assert.equal(closed.p1 + closed.p2, 2);
  assert.ok(emuLog.p1.some((e) => e[0] === 'resume' && e[1] === null), 'A goes on alone from where the session left it');
  assert.ok(emuLog.p2.some((e) => e[0] === 'resume' && e[1] === null), 'B too');
  // what Help's "Save diagnostics" now holds of it: the start, the session running, the waits, the end
  const log = diagDump().logs.link || [];
  for (const type of ['start', 'run', 'wait', 'end']) assert.ok(log.some((e) => e.type === type), `diagnostics: ${type}`);
  const run = log.find((e) => e.type === 'run' && e.frame === 600); // (the log is the page's: other tests' sessions are in it too)
  assert.deepEqual([run?.done, run?.have], [[600, 600], [604, 603]]);
  assert.ok(log.some((e) => e.type === 'end' && e.reason === 'linkStalled'));
  assert.ok(log.some((e) => e.type === 'start' && e.fromState.length === 2), 'both seats from the running games');
  A.stop(), B.stop();
});

test('linksession, DS: a partner on souldew 3.0.0 (no session clock) – the link doesn\'t start, both are told to update', async () => {
  // (oldB: everything to and from B goes without caps, as an older build sends it)
  const { A, B, settle } = await pair({ system: 'nds', oldB: true });
  await A.invite('trade', ['p2']);
  await settle(100);
  await B.accept();
  await settle(800);
  assert.equal(B.state.phase, 'ended');
  assert.equal(B.state.ended.reason, 'linkOlder');
  assert.equal(A.state.phase, 'ended');
  assert.equal(A.state.ended.reason, 'linkOlder');
  A.stop(), B.stop();
  // the same builds: a DS link goes ahead
  const p = await pair({ system: 'nds' });
  await p.A.invite('trade', ['p2']);
  await p.settle(100);
  await p.B.accept();
  await p.settle(3500);
  assert.equal(p.A.state.phase, 'running');
  assert.equal(p.B.state.phase, 'running');
  p.A.stop(), p.B.stop();
});

test('linksession: a console the link host reports stuck ends the link on both with a message (never a silent black game)', async () => {
  const { A, B, g, settle, closed } = await pair({ seamless: true });
  await A.invite('trade', ['p2']);
  await settle(100);
  await B.accept();
  await settle(3500);
  assert.equal(A.state.phase, 'running');
  g.post({ type: 'emu-link-stuck', seats: 2, frame: 840, behind: 720 });
  await settle(800);
  assert.equal(A.state.ended.reason, 'linkStuck');
  assert.equal(B.state.ended.reason, 'linkStuck');
  assert.equal(closed.p1 + closed.p2, 2);
  const { diagDump } = await import('../web/lib/diag.mjs');
  assert.ok((diagDump().logs.link || []).some((e) => e.type === 'stuck' && e.behind === 720));
  A.stop(), B.stop();
});

test('linksession: a page that went away offers to rejoin; the one who stayed sends the session\'s state; it starts from it', async () => {
  const { A, B, server, as, settle, emuState, g, fetchFor } = await pair();
  await as('p1', () => A.invite('trade', ['p2']))();
  await settle(100);
  await as('p2', () => B.accept())();
  await settle(3500);
  assert.equal(B.state.phase, 'running');
  // B's page reloads: a new LinkSessions for the same run finds the session it was in
  B.stop();
  const { LinkSessions } = await import('../web/lib/linksession.mjs');
  assert.ok(g.ls.get('sl-link-run1'), 'remembered');
  emuState.p1 = new Uint8Array(4000).fill(7); // A's host: the whole session's state
  const peersBefore = A.sync;
  const B2 = new LinkSessions({ sync: B.sync, runId: 'run1', me: 'p2', emu: () => null, fetchImpl: fetchFor('p2') });
  assert.equal(B2.state.phase, 'rejoinable');
  assert.ok(peersBefore);
  // (the fake channel delivers to the newest listener of a slot – B2 now)
  await as('p2', () => B2.rejoin())();
  await settle(2500);
  assert.equal(B2.state.phase, 'running', JSON.stringify(B2.state.ended));
  const start = server.p2.starts.at(-1);
  assert.ok(typeof start.state === 'string' && start.state.length > 10, 'started from the state');
  assert.ok(start.seats.every((s) => !s.save), 'no saves: the state has them');
  assert.equal(A.stats.donated, 1);
  A.stop(), B2.stop();
});

// ---- link battles: the result read on every peer, the wager ------------------------------------------------------
/** Two GBAs as the link host runs them on every peer: Emerald (seat 0) and Sapphire (seat 1), ₽3,000 each. */
function twoGbas() {
  const mem = () => {
    const m = new Map();
    const put = (a, bytes) => bytes.forEach((b, i) => m.set(a + i, b));
    return { m, put, read: (a, n) => Uint8Array.from({ length: n }, (_, i) => m.get(a + i) ?? 0) };
  };
  const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
  const e = mem(), sa = mem();
  e.put(0x080000ac, [...'BPEE'].map((c) => c.charCodeAt(0)));
  sa.put(0x080000ac, [...'AXPE'].map((c) => c.charCodeAt(0)));
  e.put(0x03005d8c, le(0x02025a00)); e.put(0x03005d90, le(0x02024a00)); e.put(0x02024a00 + 0xac, le(0)); e.put(0x02025a00 + 0x490, le(3000));
  sa.put(0x02025734 + 0x490, le(3000));
  // the battle: gBattleOutcome cleared with a link battle's flags, later each side's outcome
  const fight = () => { e.put(0x02022fec, le(0x2e)); e.put(0x0202433a, [0]); sa.put(0x020239f8, le(0x2a)); sa.put(0x02024d26, [0]); };
  const end = (eo, so) => { e.put(0x0202433a, [eo]); sa.put(0x02024d26, [so]); };
  return { consoles: [e, sa], fight, end };
}

test('linksession, wager: the challenge carries the wager; the partner joins for less; both work out the same stake', async () => {
  const gbas = twoGbas();
  const { A, B, settle, results } = await pair({ consoles: gbas.consoles });
  await A.invite('battle', ['p2'], { wager: 2500, format: 'single' });
  await settle(100);
  assert.equal(B.state.phase, 'invited');
  assert.deepEqual([B.state.wager.offer, B.state.format], [2500, 'single']);
  await B.accept({ wager: 2000 }); // (Tim has ₽2,000)
  await settle(3500);
  assert.equal(A.state.phase, 'running');
  assert.deepEqual([A.state.stake, B.state.stake], [2000, 2000]);
  gbas.fight();
  await settle(1200);
  gbas.end(1, 2); // Emerald (Sam) wins
  await settle(1200);
  A.leave('left');
  await settle(800);
  const [ra, rb] = [results.p1[0], results.p2[0]];
  assert.ok(ra && rb, 'both computers wrote what they read');
  assert.deepEqual(ra.per, { p1: { w: 1, l: 0, d: 0 }, p2: { w: 0, l: 1, d: 0 } });
  assert.equal(ra.h, rb.h, 'the same result on both: the same hash');
  assert.equal(ra.wager, 2000);
  A.stop(), B.stop();
});

test('linksession, wager: a partner on an older build (no caps) – the battle is for nothing; out of step – void', async () => {
  const gbas = twoGbas();
  const { A, B, settle, results } = await pair({ consoles: gbas.consoles, oldB: true });
  await A.invite('battle', ['p2'], { wager: 1000 });
  await settle(100);
  assert.equal(B.state.wager.offer, 0, 'the old build saw no wager');
  await B.accept();
  await settle(3500);
  assert.equal(A.state.stake, 0, 'no caps from Tim: no wager');
  A._hash('p1', 240, 'aaaa');
  A._hash('p2', 240, 'bbbb');
  await settle(800);
  assert.equal(results.p1[0].void, 'desync');
  assert.equal(results.p2[0].void, 'desync');
  A.stop(), B.stop();
});

test('linksession, wager: the run\'s rule – off: no wager; a cap lowers the offer', async () => {
  const off = await pair({ rules: { linkWagers: 'off' } });
  await off.A.invite('battle', ['p2'], { wager: 1000 });
  assert.equal(off.A.state.wager.offer, 0);
  off.A.leave('left'); off.A.stop(); off.B.stop();
  const cap = await pair({ rules: { linkWagerCap: 500 } });
  await cap.A.invite('battle', ['p2'], { wager: 1000 });
  assert.equal(cap.A.state.wager.offer, 500);
  await cap.A.invite('trade', ['p2'], { wager: 1000 }).catch(() => {});
  cap.A.leave('left'); cap.A.stop(); cap.B.stop();
});

test('"Pick your copy": a failed step always says something – the server\'s code translated, else the error\'s own text', async () => {
  const { needRomsError } = await import('../web/views/linkplay.mjs');
  const names = { p2: { name: 'Tim' } };
  assert.match(needRomsError({ code: 'linkPickDiffers', slot: 'p2' }, names), /Tim/);
  // linksession's _api: the text is translated already, the code is one the tables may not know
  assert.equal(needRomsError(Object.assign(new Error('The base game of this run is missing'), { code: 'noSuchCode' }), names), 'The base game of this run is missing');
  // a network error (no code at all) – it used to leave the alert empty
  assert.equal(needRomsError(new TypeError('Failed to fetch'), names), 'Failed to fetch');
  assert.ok(needRomsError({}, names).length > 0, 'never empty');
});

test('linksession: out of step – the play view\'s saves on their way land before the run\'s save goes back, never after', async () => {
  const order = [];
  let server = null;
  const beforeRestore = async (slot) => {
    order.push(`${slot}: stop writing`);
    await new Promise((r) => setTimeout(r, 150)); // an upload still on its way
    order.push(`${slot}: uploads done (${server[slot].restores.length} restores yet)`);
  };
  const p = await pair({ beforeRestore });
  server = p.server;
  const { A, B, as, settle } = p;
  await as('p1', () => A.invite('trade', ['p2']))();
  await settle(100);
  await as('p2', () => B.accept())();
  await settle(3500);
  assert.equal(A.state.phase, 'running');
  A._hash('p1', 240, 'aaaa');
  A._hash('p2', 240, 'bbbb');
  await settle(1000);
  assert.equal(A.state.ended.reason, 'linkDesync');
  for (const slot of ['p1', 'p2']) {
    assert.deepEqual(order.filter((x) => x.startsWith(slot)), [`${slot}: stop writing`, `${slot}: uploads done (0 restores yet)`]);
    assert.equal(server[slot].restores.length, 1, 'then restored');
  }
  A.stop(), B.stop();
});

test('save import: the game running in the browser player is "this save" from either side – the run slot or the library game', async () => {
  const { playsThisSave } = await import('../web/views/saveimport.mjs');
  const lib = '/games/Pokemon Emerald.gba';
  const run = { id: 'abcd1234', mode: 'together', players: { p1: {}, p2: {} }, outputs: { p1: { rom: 'p1.gba', library: lib } } };
  // the Play together run's game is open (stateId = the library game's): an import into the library game is refused
  const runGame = { saveUrl: '/api/runs/abcd1234/save/p1', runId: 'abcd1234', key: 'link-x', stateId: lib };
  assert.equal(playsThisSave(runGame, { id: lib }), true);
  // the library game is open on its own: an import into the run's slot is refused
  const freePlay = { saveUrl: `/api/saves/solo?id=${encodeURIComponent(lib)}`, key: lib, stateId: lib };
  assert.equal(playsThisSave(freePlay, { runId: 'abcd1234', slot: 'p1' }, run), true);
  // another game: not this save
  assert.equal(playsThisSave({ saveUrl: '/api/saves/solo?id=other', key: 'other', stateId: 'other' }, { id: lib }), false);
  assert.equal(playsThisSave(null, { id: lib }), false);
  // an ordinary run's slot keeps its own save
  assert.equal(playsThisSave(freePlay, { runId: 'abcd1234', slot: 'p1' }, { ...run, mode: 'soullink' }), false);
});

test('linksession: "Leave it" on a session this page dropped out of tells the others (bye) – a battle is void from this side', async () => {
  const { A, B, settle, g, fetchFor, results, net } = await pair();
  await A.invite('battle', ['p2']);
  await settle(100);
  await B.accept();
  await settle(3500);
  assert.equal(A.state.phase, 'running', JSON.stringify(A.state.ended));
  const sid = A.state.sid;
  // B's page reloads and offers to rejoin – the player picks "Leave it"
  B.stop();
  const { LinkSessions } = await import('../web/lib/linksession.mjs');
  const mine = [];
  const B2 = new LinkSessions({ sync: B.sync, runId: 'run1', me: 'p2', emu: () => null, fetchImpl: fetchFor('p2'), onResult: (e) => mine.push(e) });
  assert.equal(B2.state.phase, 'rejoinable');
  const before = net.log.length;
  B2.leave('left');
  await settle(300);
  assert.equal(B2.state.phase, 'idle');
  assert.equal(g.ls.get('sl-link-run1'), undefined, 'no rejoin offered again');
  assert.ok(net.log.slice(before).some((m) => m.from === 'p2' && m.to === 'p1' && m.t === 'bye'), 'the partner is told');
  assert.equal(A.state.phase, 'ended', 'the partner doesn\'t wait for a rejoin that never comes');
  assert.equal(A.state.ended.reason, 'left');
  assert.deepEqual(mine.map((e) => [e.sid, e.void]), [[sid, 'rejoin']], 'void from this side: nobody pays on a result it can\'t know');
  assert.equal(results.p1.at(-1)?.sid, sid, '(the partner writes its own entry as it ends)');
  A.stop(), B2.stop();
});
