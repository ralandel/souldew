// Play together (3.0, run mode 'together' – shared/playtogether.mjs): the mode's rules (nothing of a challenge applies,
// whatever is stored), the save model (the run plays the library game's own battery save), which games link with
// which, the run pack older apps refuse, and the server's guards (no intro save, no outside emulator, deleting the run
// keeps the save, no trophies).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});

const DATA = mkdtempSync(join(tmpdir(), 'sls-together-'));
process.env.SLS_DATA_DIR = DATA;
const S = await import('../shared/slots.mjs');
const { rulesWithDefaults, TOGETHER_FIXED, TOGETHER_RULE_KEYS, togetherDefaults } = await import('../shared/rules.mjs');
const PT = await import('../shared/playtogether.mjs');
const { packFormatOf, packFormatState, packMinVersion, PACK_FORMAT_TOGETHER, PACK_FORMATS } = await import('../shared/runpack.mjs');
const { PACK_FORMATS: CODE_FORMATS } = await import('../web/lib/invitecode.mjs');
const { presenceOf } = await import('../server/lib/presence.mjs');
const { buildRun, readManifest, writeManifest, runPack, checkPack } = await import('../server/lib/build.mjs');
const { isHostComputer } = await import('../server/lib/hostkey.mjs');
const { ownSeat } = await import('../server/lib/linkroms.mjs');
const { defaultSavePath, librarySavePath, startServer } = await import('../server/app.mjs');
const { applyIntroSave } = await import('../server/lib/introsave.mjs');
const { runDigests, syncTrophies } = await import('../server/lib/trophies.mjs');
const R = await import('../web/lib/run.mjs');
const { RunDoc } = await import('../web/lib/doc.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

// ---- the mode -----------------------------------------------------------------------------------------------------

test('the mode: its own name, in the SoulLink section, a run for friends to the accounts service', () => {
  assert.ok(S.MODES.includes('together'));
  const m = { mode: 'together', players: { p1: { name: 'Sam' }, p2: { name: 'Tim' } } };
  assert.equal(S.runMode(m), 'together');
  assert.equal(S.isTogether(m), true);
  assert.equal(S.isChallenge(m), false);
  assert.equal(S.runSection(m), 'soullink');
  assert.equal(S.runSection({ mode: 'nuzlocke' }), 'nuzlocke');
  assert.equal(S.runMode({ mode: 'weird' }), 'soullink', 'unknown modes stay SoulLinks, as before');
  assert.equal(S.wireMode(m), 'together', 'the accounts service takes together since 19 Nov 2026');
  assert.deepEqual(S.slotsOf(m), ['p1', 'p2']);
  assert.deepEqual(S.slotsOf({ mode: 'together', players: { p1: { name: 'Sam' } } }), ['p1', 'p2'], 'a partner who hasn’t joined yet');
  assert.equal(S.defaultRunName(m.players, 'together'), 'Sam & Tim – together');
  assert.equal(S.defaultRunName({ ...m.players, p3: { name: 'Lena' } }, 'together'), 'Sam, Tim & Lena – together');
});

test('rules: the host picks only what the players can do together – nothing of a challenge, whatever is stored', () => {
  const r = rulesWithDefaults(null, 'together');
  for (const [k, v] of Object.entries(TOGETHER_FIXED)) assert.deepEqual(r[k], v, k);
  assert.equal(r.autoDeath, false);
  assert.equal(r.autoAssign, false, 'no encounter linking');
  assert.equal(r.levelCaps, false);
  assert.equal(r.typeClause, 'off');
  assert.equal(r.dupes, 'off');
  assert.equal(r.lives, 0);
  assert.equal(r.linkBattleDeaths, false);
  assert.equal(r.raidDeaths, false);
  assert.equal(r.startAtBalls, false);
  assert.deepEqual([r.linkTrades, r.linkBattles, r.linkWagers, r.raids, r.itemGifts, r.cheats], ['on', 'on', 'on', 'on', 'on', false], 'everything together on, cheats off');
  // a hand-written doc (or a SoulLink's rules carried over) can't switch a challenge rule on
  const forced = rulesWithDefaults({ autoDeath: true, levelCaps: 'strict', lives: 3, linkBattleDeaths: true, raidDeaths: true, dupes: 'line', typeClause: 'global', startAtBalls: true, cheats: true, cheatSet: 'money', linkTrades: 'off' }, 'together');
  assert.deepEqual([forced.autoDeath, forced.levelCaps, forced.lives, forced.linkBattleDeaths, forced.raidDeaths, forced.dupes, forced.typeClause, forced.startAtBalls],
    [false, false, 0, false, false, 'off', 'off', false]);
  assert.deepEqual([forced.cheats, forced.cheatSet, forced.linkTrades], [true, 'money', 'off'], 'the host’s own choices are kept');
  assert.deepEqual(Object.keys(togetherDefaults()).sort(), [...TOGETHER_RULE_KEYS].sort());
});

test('the run pack: Play together travels as @5 – 2.8 apps say "update to 3.0.0" instead of reading a SoulLink', () => {
  const m = { id: 'a1b2c3d4', name: 'Sam & Tim – together', room: 'r', secret: 's', mode: 'together', players: { p1: { name: 'Sam' } }, outputs: {} };
  assert.deepEqual(packFormatOf(m), { format: PACK_FORMAT_TOGETHER, minVersion: '3.0.0' });
  const pack = runPack(m);
  assert.equal(pack.format, 'soullink-studio/run-pack@5');
  assert.equal(pack.mode, 'together');
  assert.ok(PACK_FORMATS.includes(PACK_FORMAT_TOGETHER));
  assert.deepEqual(CODE_FORMATS, PACK_FORMATS, 'the code invite reads it too');
  assert.equal(packFormatState(pack), 'ok');
  // what 2.8.3 does with it (its formats are @1–@4): "newer", naming 3.0.0
  const OLD = ['soullink-studio/run-pack@1', 'soullink-studio/run-pack@2', 'soullink-studio/run-pack@3', 'soullink-studio/run-pack@4'];
  const oldState = (p) => (OLD.includes(p.format) ? 'ok' : /^soullink-studio\/run-pack@\d{1,4}$/.test(p.format) ? 'newer' : 'invalid');
  assert.equal(oldState(pack), 'newer');
  assert.equal(packMinVersion(pack), '3.0.0');
  // a SoulLink stays as it was
  assert.equal(packFormatOf({ ...m, mode: 'soullink' }).format, 'soullink-studio/run-pack@1');
  // the joining app takes the mode and the host's key from the pack
  const checked = checkPack({ ...pack, room: 'room-123', secret: 'secret-123', hostKey: 'A'.repeat(43), host: 'p1', players: { p1: { name: 'Sam' }, p2: { name: 'Tim' } } });
  assert.equal(checked.mode, 'together');
  assert.equal(checked.host, 'p1');
});

// ---- which games link with which ----------------------------------------------------------------------------------

const G = {
  emerald: { id: 'pokemon-emerald', root: 'pokemon-emerald', gen: 3, system: 'gba' },
  sapphire: { id: 'pokemon-sapphire', root: 'pokemon-sapphire', gen: 3, system: 'gba' },
  ruby: { id: 'pokemon-ruby', root: 'pokemon-ruby', gen: 3, system: 'gba' },
  firered: { id: 'pokemon-firered', root: 'pokemon-firered', gen: 3, system: 'gba' },
  platinum: { id: 'pokemon-platinum', root: 'pokemon-platinum', gen: 4, system: 'nds' },
  heartgold: { id: 'pokemon-heartgold', root: 'pokemon-heartgold', gen: 4, system: 'nds' },
  black: { id: 'pokemon-black', root: 'pokemon-black', gen: 5, system: 'nds' },
  red: { id: 'pokemon-red', root: 'pokemon-red', gen: 1, system: 'gb' },
  blue: { id: 'pokemon-blue', root: 'pokemon-blue', gen: 1, system: 'gb' },
  crystal: { id: 'pokemon-crystal', root: 'pokemon-crystal', gen: 2, system: 'gbc' },
  y: { id: 'pokemon-x', root: 'pokemon-x', gen: 6, system: '3ds' },
};

test('which pairs link: the same generation trades and battles, the same maps see each other', () => {
  const w = (a, b) => PT.linkWith(G[a], G[b]);
  assert.deepEqual(w('emerald', 'sapphire'), { trade: true, battle: true, world: false, why: null }, 'Emerald and Sapphire number their maps differently');
  assert.deepEqual(w('ruby', 'sapphire'), { trade: true, battle: true, world: true, why: null });
  assert.equal(w('emerald', 'firered').trade, true, 'every Gen 3 game has the Cable Club');
  assert.equal(w('emerald', 'firered').world, false);
  assert.equal(w('platinum', 'heartgold').battle, true, 'the Gen 4 Union Room');
  assert.equal(w('platinum', 'heartgold').world, false);
  assert.deepEqual(w('platinum', 'black'), { trade: false, battle: false, world: false, why: 'gen' }, 'Gen 4 and Gen 5 share the DS, not the Union Room');
  assert.deepEqual(w('red', 'blue'), { trade: true, battle: true, world: true, why: null });
  assert.deepEqual(w('red', 'crystal'), { trade: 'untested', battle: false, world: false, why: null }, 'the Time Capsule: trades only, never run here');
  assert.equal(w('emerald', 'platinum').why, 'system');
  assert.equal(w('emerald', 'y').why, 'system', 'no 3DS link');
  assert.equal(PT.linkWith(G.emerald, null).why, 'unknown');
  assert.equal(PT.linkWith({ ...G.firered, quetzal: true }, G.emerald).why, 'hack');
});

test('inviting: every seat must link with every other one; an unknown game doesn’t stop the invite', () => {
  const games = { p1: G.emerald, p2: G.sapphire, p3: G.platinum, p4: null };
  assert.equal(PT.inviteBlock(games, 'p1', ['p2'], 'trade'), null);
  assert.equal(PT.inviteBlock(games, 'p1', ['p2'], 'battle'), null);
  assert.deepEqual(PT.inviteBlock(games, 'p1', ['p3'], 'trade'), { slot: 'p3', why: 'system' });
  assert.deepEqual(PT.inviteBlock(games, 'p1', ['p2', 'p3'], 'battle'), { slot: 'p3', why: 'system' }, '“Link all of us” with a DS player in it');
  assert.equal(PT.inviteBlock(games, 'p1', ['p4'], 'trade'), null, 'p4 hasn’t said which game – their app answers the invite itself');
  assert.deepEqual(PT.inviteBlock({ p1: G.red, p2: G.crystal }, 'p1', ['p2'], 'battle'), { slot: 'p2', why: 'battle' });
  assert.equal(PT.inviteBlock({ p1: G.red, p2: G.crystal }, 'p1', ['p2'], 'trade'), null);
  assert.equal(PT.BLOCK_CODE.gen, 'linkGen');
  const pairs = PT.linkPairs({ p1: G.ruby, p2: G.sapphire, p3: G.black }, ['p1', 'p2', 'p3']);
  assert.deepEqual(pairs.map((p) => [p.a, p.b, p.trade, p.world]), [['p1', 'p2', true, true], ['p1', 'p3', false, false], ['p2', 'p3', false, false]]);
});

test('games: what a player announces, cleaned on the way in; which library ROMs can play together', () => {
  const info = PT.gameInfo({ id: 'pokemon-emerald', system: 'gba', code: 'BPEE', hackId: null }, { id: 'pokemon-emerald', generation: 3, system: 'gba' });
  assert.deepEqual(info, { id: 'pokemon-emerald', root: 'pokemon-emerald', gen: 3, system: 'gba', hack: null, code: 'BPEE', quetzal: false });
  assert.deepEqual(PT.cleanGameInfo(info), info);
  assert.equal(PT.cleanGameInfo({ gen: 'x', system: 'gba' }), null);
  assert.equal(PT.cleanGameInfo({ gen: 3, system: 'psx' }), null);
  assert.equal(PT.cleanGameInfo({ ...info, id: 'x'.repeat(500) }).id.length, 60);
  assert.equal(PT.togetherRomBlock({ system: 'gba', code: 'BPEE' }), null);
  assert.equal(PT.togetherRomBlock({ system: '3ds' }), 'system');
  assert.equal(PT.libraryIdOf('Emerald.gba'), 'Emerald.gba');
  assert.equal(PT.libraryIdOf('FireRed.gba', 'Unbound.bps'), 'FireRed.gba|Unbound.bps');
  assert.equal(PT.okLibraryId(''), false);
  assert.equal(PT.okLibraryId('a\u0000b'), false);
});

test('presence: a Play together game counts as together for the bot', () => {
  assert.deepEqual(presenceOf({ system: 'gba', mode: 'together' }), { system: 'gba', mode: 'together' });
  assert.deepEqual(presenceOf({ system: 'gba', mode: 'soullink' }), { system: 'gba', mode: 'soullink' });
});

// ---- the tracker: no challenge ------------------------------------------------------------------------------------

const mon = (key, species, hp = 20, level = 10) => ({ key, species, level, hp, maxHp: 20, moves: [33] });
const runOf = (o = {}) => ({ id: 'tg000001', mode: 'together', name: 'Sam & Tim – together', players: { p1: { name: 'Sam' }, p2: { name: 'Tim' } }, game: { id: 'pokemon-emerald', system: 'gba' }, outputs: { p1: { rom: 'x.gba', library: 'Emerald.gba' } }, ...o });

test('the tracker writes the live team – no encounter, no death, no failing, a badge goes to the log', () => {
  const doc = new RunDoc('tg000001');
  const m = runOf();
  const first = R.applySnapshot(doc, m, 3, 'p1', { source: 'live', party: [mon('a', 252), mon('b', 263)], badges: 1 });
  assert.deepEqual(first, { inbox: [], alerts: [], newCatches: [], deaths: [], failed: null });
  assert.equal(R.live(doc, 'p1').party.length, 2);
  assert.equal(R.live(doc, 'p1').badges, 1);
  // the whole team down: nothing dies, the run doesn't fail
  const down = R.applySnapshot(doc, m, 3, 'p1', { source: 'live', party: [mon('a', 252, 0), mon('b', 263, 0)], badges: 2 }, { battle: { kind: 'wild', enemy: { species: 16, level: 5 } } });
  assert.deepEqual(down.deaths, []);
  assert.equal(R.live(doc, 'p1').party[0].hp, 0);
  const keys = Object.keys(doc.scan(''));
  assert.ok(!keys.some((k) => /^(enc|pair|area|party|held|balls|capbreak):/.test(k)), `no challenge keys: ${keys.join(', ')}`);
  assert.equal(doc.get('run:status', null), null);
  assert.equal(R.failRun(doc, m, 'p1', 'wipe'), false);
  assert.equal(R.markDead(doc, m, 'r101', { slot: 'p1' }), false);
  assert.equal(R.wipedSlot(doc, ['p1'], m), R.wipedSlot(doc, ['p1'], m)); // (whatever it says, nothing acts on it in this mode)
  assert.equal(doc.get('run:status', null), null);
  assert.deepEqual(R.checks(doc, m, null), [], 'no rules to break');
  const feed = R.feedList(doc).map((f) => f.type);
  assert.deepEqual(feed, ['badge'], 'only the new badge – no catch, no death, no “run failed”');
  // the title screen (an empty party) changes nothing
  R.applySnapshot(doc, m, 3, 'p1', { source: 'live', party: [] });
  assert.equal(R.live(doc, 'p1').party.length, 2);
});

test('the game a player announces, and the save states of their library game', () => {
  const doc = new RunDoc('tg000001');
  const m = runOf();
  assert.equal(R.announceGame(doc, m, 'p1'), true);
  assert.equal(doc.get('game:p1').gen, 3);
  assert.equal(R.announceGame(doc, m, 'p1'), false, 'once – again only when it changes');
  assert.equal(R.announceGame(doc, { ...m, mode: 'soullink' }, 'p1'), false, 'a SoulLink: everybody plays the run’s game');
  doc.set('game:p2', { gen: 3, system: 'gba', id: 'pokemon-sapphire', root: 'pokemon-sapphire' });
  const games = R.togetherGames(doc, m, 'p1');
  assert.equal(games.p1.id, 'pokemon-emerald');
  assert.equal(games.p2.id, 'pokemon-sapphire');
  assert.equal(R.runStateId(m, 'p1'), 'Emerald.gba', 'states and “where you left off” go with the library game');
  assert.equal(R.runStateId({ ...m, mode: 'soullink' }, 'p1'), 'run-tg000001-p1');
});

// ---- the save model, on the server ----------------------------------------------------------------------------------

const LIB = join(DATA, 'Library');
mkdirSync(LIB, { recursive: true });
function fakeGba(name, fill, code = 'BPEE01', title = 'POKEMON EMER') {
  const p = join(LIB, name);
  const b = Buffer.alloc(0x10000, fill);
  b.write(title, 0xa0, 'ascii');
  b.write(code, 0xac, 'ascii');
  writeFileSync(p, b);
  return p;
}
fakeGba('Fake Emerald.gba', 3);
fakeGba('Fake Sapphire.gba', 5, 'AXPE01', 'POKEMON SAPP');

test('the server: the run plays the library game’s own save; no intro save, no outside emulator; deleting keeps the save', async () => {
  const { server, url } = await startServer({ port: 0, background: false });
  const call = (method, path, body, raw = false) => fetch(`${url}${path}`, { method, headers: { 'content-type': raw ? 'application/octet-stream' : 'application/json', 'x-soullink': '1' }, body: raw ? body : body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, body: raw && method === 'GET' ? Buffer.from(await r.arrayBuffer()) : await r.json().catch(() => null) }));
  try {
    const lib = (await call('GET', '/api/library')).body;
    const emerald = lib.roms.find((r) => r.name.startsWith('Fake Emerald'));
    // the game's progress so far, played alone from the library
    const before = Buffer.alloc(0x20000, 0x5a);
    assert.equal((await call('PUT', `/api/saves/solo?id=${encodeURIComponent(emerald.id)}`, before, true)).status, 200);
    const built = await call('POST', '/api/runs/build', { mode: 'together', romId: emerald.id, randomize: true, shiny: { rate: 100 }, players: { p1: { name: 'Sam' }, p2: { name: 'Tim' } },
      buildFor: ['p1'], host: 'p1', rules: { linkTrades: 'on', autoDeath: true }, introSave: true, introSlot: 'p1' });
    assert.equal(built.status, 200, JSON.stringify(built.body));
    const m = built.body.manifest;
    assert.equal(m.mode, 'together');
    assert.equal(m.randomizer.enabled, false, 'never randomized');
    assert.equal(m.shiny, null, 'never shiny-patched');
    assert.equal(m.outputs.p1.library, emerald.id);
    assert.deepEqual(Object.keys(m.outputs), ['p1'], 'only this computer’s player');
    assert.equal(m.intro, undefined, 'no intro save');
    assert.equal(readFileSync(join(DATA, 'runs', m.id, m.outputs.p1.rom)).equals(readFileSync(join(LIB, 'Fake Emerald.gba'))), true, 'the run’s ROM is the library ROM byte for byte');
    assert.equal(m.host, 'p1');
    assert.ok(m.hostKey, 'the host signs the choices, as in a SoulLink');
    assert.equal(isHostComputer(m), true);
    // one save, two ways in
    const p = defaultSavePath(m, 'p1');
    assert.equal(p, librarySavePath(emerald.id));
    const viaRun = await call('GET', `/api/runs/${m.id}/save/p1`, null, true);
    assert.equal(viaRun.status, 200);
    assert.ok(viaRun.body.equals(before), 'the run starts with the game’s own progress');
    const after = Buffer.alloc(0x20000, 0x77);
    assert.equal((await call('PUT', `/api/runs/${m.id}/save/p1`, after, true)).status, 200);
    const viaLib = await call('GET', `/api/saves/solo?id=${encodeURIComponent(emerald.id)}`, null, true);
    assert.ok(viaLib.body.equals(after), 'what was played together is in the library game’s save');
    assert.equal(existsSync(join(DATA, 'runs', m.id, m.outputs.p1.rom.replace(/\.gba$/, '.sav'))), false, 'no second copy in the run folder');
    // the guards
    assert.equal(applyIntroSave(m.id, 'p1', { savePath: defaultSavePath }), null);
    const ext = await call('POST', '/api/emulators/mgba/launch', { runId: m.id, slot: 'p1' });
    assert.deepEqual([ext.status, ext.body?.code], [409, 'togetherBuiltIn']);
    // the pack names the mode and the format older apps refuse
    const full = (await call('GET', `/api/runs/${m.id}`)).body;
    assert.equal(full.pack.format, PACK_FORMAT_TOGETHER);
    assert.equal(full.pack.outputs.p1.library, undefined, 'the library id stays on this computer');
    // no trophies, no profile stats
    syncTrophies();
    assert.ok(!runDigests().some((d) => d.id === m.id));
    // deleting the run keeps the game's save
    assert.equal((await call('DELETE', `/api/runs/${m.id}`)).status, 200);
    assert.ok(readFileSync(librarySavePath(emerald.id)).equals(after));
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('joining: the friend builds only their own game – any linkable one – and plays its library save', async () => {
  const lib = join(LIB, 'Fake Sapphire.gba');
  const host = await buildRun({ romId: join(LIB, 'Fake Emerald.gba'), mode: 'together', randomize: false, config: {}, players: { p1: { name: 'Sam' }, p2: { name: 'Tim' } }, buildFor: ['p1'], host: 'p1' });
  // the friend's computer: the imported invite (no games yet), then their own build with Sapphire
  const pack = runPack(host);
  const joined = { ...host, ...checkPack(pack), id: 'b2c3d4e5', imported: true, outputs: {}, expectedOutputs: pack.outputs, game: pack.game, base: pack.base };
  delete joined.hostKey;
  writeManifest(joined);
  await assert.rejects(buildRun({ identity: { id: joined.id, room: joined.room, secret: joined.secret }, romId: lib, mode: 'together', config: {}, players: joined.players, buildFor: ['p1', 'p2'] }),
    { code: 'togetherOneSlot' });
  const m = await buildRun({ identity: { id: joined.id, room: joined.room, secret: joined.secret }, romId: lib, mode: 'together', config: {}, players: joined.players, buildFor: ['p2'], gameId: 'pokemon-sapphire' });
  assert.deepEqual(Object.keys(m.outputs), ['p2']);
  assert.equal(m.outputs.p2.library, lib);
  assert.equal(m.outputs.p2.expectedSha1, null, 'another game than the host’s is no mismatch');
  assert.equal(m.game.id, 'pokemon-sapphire', 'the run is built for the friend’s own game (live tracking, Shared World)');
  assert.equal(defaultSavePath(m, 'p2'), librarySavePath(lib));
  assert.equal(defaultSavePath(m, 'p1'), null, 'the host’s seat has no save here');
  assert.equal(isHostComputer(readManifest(m.id)), false);
  // the partners find this game in their library by its CRC (a plain game)
  const seat = ownSeat(m, 'p2', (id, name) => join(DATA, 'runs', id, name));
  assert.ok(seat.crc && seat.sha1);
  // a library id that isn't one gets no save at all (never another file)
  assert.equal(defaultSavePath({ ...m, outputs: { p2: { ...m.outputs.p2, library: '' } } }, 'p2'), null);
});
