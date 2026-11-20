// Two player ideas from Discord (2.8.3):
//  1. "Nothing counts before your first Poké Balls" (rules.startAtBalls, web/lib/run.mjs beforeBalls / startRules):
//     the balls read from the bag per bag layout (shared/live/cheats.mjs readBalls), the rule on and off, each player of
//     a SoulLink by their own bag, the run pack older apps refuse.
//  2. Deaths shown when the game shows them (web/lib/reveal.mjs DeathReveal, applySnapshot `held`, revealHeld): the
//     timing per generation and speed, the signals that end it early, and that a held death is recorded at once and
//     never taken back (reset, a loaded state, the game closed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { findEntry } from '../shared/live/parse.mjs';
import { readBalls } from '../shared/live/cheats.mjs';
import { packFormatOf, PACK_FORMAT, PACK_FORMAT_TMS } from '../shared/runpack.mjs';
import { DeathReveal, effectiveSpeed, REVEAL_MS, REVEAL_CAP_MS, POLL_MS } from '../web/lib/reveal.mjs';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const { RunDoc } = await import('../web/lib/doc.mjs');
const R = await import('../web/lib/run.mjs');
const { rulesWithDefaults, NEW_RUN_RULES } = await import('../shared/rules.mjs');

const TABLE = JSON.parse(readFileSync(new URL('../shared/data/addresses.json', import.meta.url)));
const entry = (header) => findEntry(TABLE, header);

function memory() {
  const blocks = [];
  return {
    poke(addr, bytes) { blocks.push({ addr, bytes: Uint8Array.from(bytes) }); },
    read(addr, len) {
      const out = new Uint8Array(len);
      for (const b of blocks) {
        for (let i = 0; i < len; i++) {
          const o = addr + i - b.addr;
          if (o >= 0 && o < b.bytes.length) out[i] = b.bytes[o];
        }
      }
      return out;
    },
  };
}
const le16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const le32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const slot = (id, qty) => [...le16(id), ...le16(qty)];

// ---- 1. Poké Balls in the bag, per bag layout ------------------------------------------------------------------

test('balls in the bag – Gen 1 (one bag) and Gen 2 (the ball pocket behind the key items)', () => {
  const red = entry({ platform: 'gb', title: 'POKEMON RED' });
  const m = memory();
  m.poke(0xd31d, [2, 0x14, 5, 0x04, 10, 0xff]); // Potion ×5, Poké Ball ×10
  m.poke(0xd347, [0x00, 0x30, 0x00]);
  assert.equal(readBalls(red, m.read), 10);
  const none = memory();
  none.poke(0xd31d, [1, 0x14, 5, 0xff]);
  none.poke(0xd347, [0x00, 0x30, 0x00]);
  assert.equal(readBalls(red, none.read), 0, 'a bag without a ball');
  const junk = memory();
  junk.poke(0xd31d, [30, 0x14]);
  assert.equal(readBalls(red, junk.read), null, 'not a bag: unknown, not 0');

  const crystal = entry({ platform: 'gbc', title: 'PM_CRYSTAL', code: 'BYTE' });
  const c = memory();
  c.poke(0xd892, [1, 0x12, 3, 0xff]);
  c.poke(0xd8bc, [1, 0x07, 0xff]);
  c.poke(0xd8bc + 27, [0, 0xff]);
  assert.equal(readBalls(crystal, c.read), 0);
  c.poke(0xd8bc + 27, [1, 0x05, 5, 0xff]); // Poké Ball ×5
  assert.equal(readBalls(crystal, c.read), 5);
});

function gen3Encrypted({ sb1Ptr, sb2Ptr, keyOff, money, items, balls }, ballSlots, { key = 0x1234abcd, sb1 = 0x02025a00, sb2 = 0x02024a00 } = {}) {
  const m = memory();
  const k = key & 0xffff;
  m.poke(sb1Ptr, le32(sb1));
  m.poke(sb2Ptr, le32(sb2));
  m.poke(sb2 + keyOff, le32(key));
  m.poke(sb1 + money, le32((3000 ^ key) >>> 0));
  m.poke(sb1 + items, [...slot(13, 5 ^ k), ...slot(0, k)]);
  m.poke(sb1 + balls, ballSlots.length ? ballSlots.flatMap(([id, q]) => slot(id, q ^ k)) : slot(0, k));
  return m;
}

test('balls in the bag – Gen 3: Ruby/Sapphire plain, Emerald and FireRed through the save blocks, encrypted', () => {
  const ruby = entry({ platform: 'gba', code: 'AXVE' });
  const sb1 = 0x02025734;
  const m = memory();
  m.poke(sb1 + 0x490, le32(3000));
  m.poke(sb1 + 0x560, slot(13, 5));
  assert.equal(readBalls(ruby, m.read), 0);
  m.poke(sb1 + 0x600, [...slot(4, 10), ...slot(2, 3)]); // Poké Ball ×10, Ultra Ball ×3
  assert.equal(readBalls(ruby, m.read), 13);
  const emerald = { sb1Ptr: 0x03005d8c, sb2Ptr: 0x03005d90, keyOff: 0xac, money: 0x490, items: 0x560, balls: 0x650 };
  const firered = { sb1Ptr: 0x03005008, sb2Ptr: 0x0300500c, keyOff: 0xf20, money: 0x290, items: 0x310, balls: 0x430 };
  for (const [code, L] of [['BPEE', emerald], ['BPRE', firered]]) {
    assert.equal(readBalls(entry({ platform: 'gba', code }), gen3Encrypted(L, []).read), 0, code);
    assert.equal(readBalls(entry({ platform: 'gba', code }), gen3Encrypted(L, [[4, 5]]).read), 5, code);
  }
  // a wrong key decodes the money into nonsense: unknown
  const wrong = gen3Encrypted(emerald, [[4, 5]]);
  wrong.poke(0x02024a00 + 0xac, le32(0x0badf00d));
  assert.equal(readBalls(entry({ platform: 'gba', code: 'BPEE' }), wrong.read), null);
});

test('balls in the bag – Gen 4 (the Poké Ball pocket) and Gen 5 (balls among the items)', () => {
  const hg = entry({ platform: 'nds', code: 'IPKE' });
  const saveBase = 0x0227c2c8;
  const bag = saveBase + 0x10 + 0x644;
  const m = memory();
  // a fresh game: nothing in the bag – read as "no balls" where the save data came from its pointer
  assert.equal(readBalls(hg, m.read, { saveBase }), 0);
  assert.equal(readBalls(hg, m.read, { partyAddr: saveBase + 0xa8 - 8 }), null, 'found by a scan: an empty bag proves nothing');
  m.poke(bag + 0x6c0, [...slot(4, 5), ...slot(3, 2)]); // Poké Ball ×5, Great Ball ×2
  assert.equal(readBalls(hg, m.read, { saveBase }), 7);
  const pt = entry({ platform: 'nds', code: 'CPUE' });
  const p = memory();
  p.poke(0x02270000 + 0x14 + 0x630 + 0x6bc, slot(4, 5));
  assert.equal(readBalls(pt, p.read, { saveBase: 0x02270000 }), 5);

  const black = entry({ platform: 'nds', code: 'IRBO' });
  const partyAddr = 0x022349ac;
  const b = memory();
  b.poke(partyAddr - 0xa00, [...slot(17, 2), ...slot(4, 5)]); // Potion ×2, Poké Ball ×5 in the Items pocket
  b.poke(partyAddr - 0xa00 + 0x624, slot(618, 1));
  assert.equal(readBalls(black, b.read, { partyAddr }), 5);
  const nb = memory();
  nb.poke(partyAddr - 0xa00, slot(17, 2));
  assert.equal(readBalls(black, nb.read, { partyAddr }), 0);
});

test('balls in the bag – 3DS: X/Y and ORAS { id, count }, Sun/Moon packed slots', () => {
  const xy = entry({ platform: '3ds', titleId: '0004000000055D00' });
  const b10 = 0x08c67554;
  const m = memory();
  m.poke(b10 + 0x968, slot(17, 2)); // a Potion in Medicine
  assert.equal(readBalls(xy, m.read, { g67: 1 }), 0);
  m.poke(b10, [...slot(4, 10), ...slot(495, 1)]); // Poké Ball ×10, an Apricorn ball
  assert.equal(readBalls(xy, m.read, { g67: 1 }), 11);
  const sm = entry({ platform: '3ds', titleId: '0004000000164800' });
  const base = 0x330d5934;
  const g7 = (id, qty) => le32((id | (qty << 10) | 0x40000000) >>> 0);
  const s = memory();
  s.poke(base + 0x6b8, g7(845, 1)); // only the key item from Hala
  assert.equal(readBalls(sm, s.read, {}), 0);
  s.poke(base, g7(4, 10));
  assert.equal(readBalls(sm, s.read, {}), 10);
  assert.equal(readBalls(null, s.read), null);
  assert.equal(readBalls(entry({ platform: 'gba', code: 'BPES' }), s.read), null, 'no bag layout for this release: unknown');
});

// ---- 1. the rule in the run ----------------------------------------------------------------------------------

const HG = { id: 'run1', game: { code: 'IPKE', system: 'nds' } };
const SOLO = { ...HG, mode: 'nuzlocke', name: 'Lou – Nuzlocke #1', players: { p1: { name: 'Lou' } } };
const PAIR = { ...HG, players: { p1: { name: 'Lou' }, p2: { name: 'Robin' } } };
function mkDoc(rules) {
  const d = new RunDoc('t');
  d.by = 'a';
  d._persistSoon = () => {};
  if (rules) d.set('rules', rules);
  return d;
}
const mon = (o = {}) => ({ key: 'k1', species: 152, nickname: 'CHIKO', level: 5, hp: 20, maxHp: 20, metLocation: 126, metLevel: 5, ...o });
const feedOf = (d) => R.feedList(d).map((f) => f.msg?.key);
const snap = (d, party, opts = {}, m = SOLO, slot = 'p1') => R.applySnapshot(d, m, 4, slot, { source: 'live', party }, opts);

test('a new run starts with the rule on; a run from before keeps counting from the start', () => {
  assert.equal(NEW_RUN_RULES.startAtBalls, true);
  assert.equal(rulesWithDefaults({}, 'nuzlocke').startAtBalls, false, 'stored rules without it: off');
  assert.equal(R.beforeBalls(mkDoc(), SOLO, 'p1'), false);
  const old = mkDoc();
  snap(old, [mon()]);
  const res = snap(old, [mon({ hp: 0 })]);
  assert.deepEqual(res.deaths, ['starter'], 'rule off: the starter dies as before');
  assert.equal(res.failed, 'blackout');
});

test('before the first Poké Balls: no death, no blackout, no missed encounter – the balls start the rules, once', () => {
  const d = mkDoc({ ...R.NUZLOCKE_RULES, startAtBalls: true });
  assert.equal(R.beforeBalls(d, SOLO, 'p1'), true);
  snap(d, [mon()]);
  assert.equal(R.encounter(d, 'starter', 'p1')?.species, 152, 'the starter is filed as always');
  const res = snap(d, [mon({ hp: 0 })]);
  assert.deepEqual([res.deaths, res.failed, res.alerts.length], [[], null, 0], 'the rival battle lost: nothing counts');
  assert.equal(R.pairState(d, 'starter', ['p1']).state, 'linked');
  assert.equal(d.get('run:status', null), null);
  assert.equal(R.missedQuestion(d, SOLO, null, 'p1', { foe: { species: 16 }, wild: true, from: 1, here: { gen: 4, id: 177, name: 'Route 29' } }), false, 'no first encounter is spent');
  assert.equal(R.lives(mkDoc({ ...R.NUZLOCKE_RULES, startAtBalls: true, lives: 3 }), SOLO).pools.all.used, 0);
  // the balls: the rules start, the log says so once; the starter still at 0 HP from before isn't dead yet
  assert.equal(R.startRules(d, SOLO, 'p1', 'bag', ['k1']), true);
  assert.equal(R.startRules(d, SOLO, 'p1', 'bag'), false, 'once');
  assert.equal(feedOf(d).filter((k) => k === 'feed.ballsStart').length, 1);
  assert.equal(R.beforeBalls(d, SOLO, 'p1'), false);
  assert.deepEqual(snap(d, [mon({ hp: 0 })]).deaths, [], 'knocked out before the rules started: not dead');
  snap(d, [mon({ hp: 20 })]); // healed
  d.set('balls:p1', { ...d.get('balls:p1'), at: Date.now() - 1000 }); // (a moment ago – a whiteout counts from after it)
  assert.deepEqual(d.get('balls:p1').down, undefined, 'healed: no longer spared');
  assert.equal(R.missedQuestion(d, SOLO, null, 'p1', { foe: { species: 16 }, wild: true, from: 1, here: { gen: 4, id: 177, name: 'Route 29' } }), true);
  const res2 = snap(d, [mon({ hp: 0 })]);
  assert.deepEqual(res2.deaths, ['starter']);
  assert.equal(res2.failed, 'blackout');
});

test('where the bag can’t be read: the first catch starts the rules', () => {
  const d = mkDoc({ ...R.NUZLOCKE_RULES, startAtBalls: true });
  snap(d, [mon()]);
  assert.equal(R.beforeBalls(d, SOLO, 'p1'), true, 'the starter is no catch');
  snap(d, [mon(), mon({ key: 'k2', species: 16, nickname: 'PIDGE', metLocation: 177, level: 3, metLevel: 3 })]);
  assert.equal(R.beforeBalls(d, SOLO, 'p1'), false);
  assert.equal(d.get('balls:p1').how, 'catch');
});

test('SoulLink: each player by their own bag – a partner’s death still takes the linked one along', () => {
  const d = mkDoc({ ...R.rules(mkDoc(), PAIR), startAtBalls: true });
  snap(d, [mon()], {}, PAIR, 'p1');
  snap(d, [mon({ key: 'r1', species: 155 })], {}, PAIR, 'p2');
  R.startRules(d, PAIR, 'p1', 'bag');
  assert.deepEqual([R.beforeBalls(d, PAIR, 'p1'), R.beforeBalls(d, PAIR, 'p2')], [false, true]);
  // Robin (no balls yet) loses the rival battle: nothing happens, the run goes on
  assert.deepEqual(snap(d, [mon({ key: 'r1', species: 155, hp: 0 })], {}, PAIR, 'p2').deaths, []);
  assert.equal(R.wipedSlot(d, ['p2'], PAIR), null);
  assert.equal(R.pairState(d, 'starter', ['p1', 'p2']).state, 'linked');
  // Lou (balls) loses the starter: the pair dies – Robin's linked one too; the death is Lou's
  assert.deepEqual(snap(d, [mon({ hp: 0 })], {}, PAIR, 'p1').deaths, ['starter']);
  assert.equal(R.pairState(d, 'starter', ['p1', 'p2']).state, 'dead');
  assert.equal(d.get('pair:starter').by, 'p1');
  // Robin's whited-out team doesn't end the run while Robin's rules haven't started
  assert.equal(R.wipedSlot(d, ['p2'], PAIR), null);
  assert.equal(R.wipedSlot(d, ['p1'], PAIR), 'p1');
});

test('the rule is the host’s: logged for everyone, and a SoulLink with it travels as the pack 2.8.2 refuses', () => {
  const d = mkDoc();
  R.logRulesChange(d, PAIR, 'p1', R.rules(d, PAIR), { ...R.rules(d, PAIR), startAtBalls: true });
  assert.equal(R.feedList(d)[0].msg.vars.rule.key, 'rules.balls');
  assert.deepEqual(packFormatOf({ ...PAIR, rules: { startAtBalls: true } }), { format: PACK_FORMAT_TMS, minVersion: '2.8.3' });
  assert.deepEqual(packFormatOf({ ...PAIR, rules: { startAtBalls: false } }), { format: PACK_FORMAT });
  assert.deepEqual(packFormatOf({ ...SOLO, rules: { startAtBalls: true } }), { format: PACK_FORMAT }, 'a solo run has no partner to refuse');
});

// ---- 2. deaths shown when the game shows them --------------------------------------------------------------

const P = (hp, o = {}) => [{ key: 'k1', species: 152, hp, maxHp: 20, ...o }, { key: 'k2', species: 16, hp: 12, maxHp: 12 }];

test('reveal timing per generation at 1× – one poll of it went into confirming the 0 HP', () => {
  for (const gen of [1, 2, 3, 4, 5, 6, 7]) {
    const r = new DeathReveal();
    r.see(P(20), { now: 0, gen });
    const need = REVEAL_MS[gen] - POLL_MS;
    let t = 700;
    let out = r.see(P(0), { now: t, gen });
    assert.deepEqual([...out.held], [['k1', 20]], `gen ${gen}: held at the HP last shown`);
    assert.equal(out.party[0].hp, 20, 'the team panel keeps showing it');
    while (r.held.size) out = r.see(P(0), { now: (t += 100), gen });
    assert.ok(t - 700 >= need && t - 700 < need + 100, `gen ${gen}: shown after ${t - 700} ms (want ${need})`);
    assert.equal(out.party[0].hp, 0);
  }
});

test('fast-forward: scaled by the speed the game runs at – at Max next to nothing; paused time doesn’t count', () => {
  const at = (speed, gen = 4) => {
    const r = new DeathReveal();
    r.see(P(20), { now: 0, gen, speed });
    let t = 700;
    r.see(P(0), { now: t, gen, speed });
    while (r.held.size && t < 60000) r.see(P(0), { now: (t += 50), gen, speed });
    return t - 700;
  };
  assert.ok(at(1) >= 2300 && at(1) < 2400);
  assert.ok(at(2) >= 800 && at(2) < 850, `2×: ${at(2)}`); // (3000 − 1400) / 2
  assert.equal(at(4), 50, '4×: the confirming poll covered nearly all of it');
  assert.equal(effectiveSpeed(Infinity), 16);
  assert.equal(effectiveSpeed(Infinity, { reach: 6 }), 6);
  assert.equal(effectiveSpeed(3, { paused: true }), 0);
  const max = new DeathReveal();
  max.see(P(20), { now: 0, speed: effectiveSpeed(Infinity) });
  assert.equal(max.see(P(0), { now: 700, speed: effectiveSpeed(Infinity) }).held.size, 0, 'Max: shown at once');
  // paused mid-animation: held as long as it is paused, the time goes on once it runs again
  const p = new DeathReveal();
  p.see(P(20), { now: 0 });
  p.see(P(0), { now: 700 });
  p.see(P(0), { now: 1000 });
  for (let t = 1000; t <= 60000; t += 1000) p.see(P(0), { now: t, speed: 0 });
  assert.equal(p.held.size, 1, 'paused for a minute: still held');
  p.see(P(0), { now: 61000 });
  p.see(P(0), { now: 63500 });
  assert.equal(p.held.size, 0);
  // a game that runs very slowly can't hold it longer than the cap of running time
  const slow = new DeathReveal();
  slow.see(P(20), { now: 0, speed: 0.05 });
  slow.see(P(0), { now: 700, speed: 0.05 });
  let t = 700;
  while (slow.held.size) slow.see(P(0), { now: (t += 500), speed: 0.05 });
  assert.ok(t - 700 >= REVEAL_CAP_MS && t - 700 <= REVEAL_CAP_MS + 500);
});

test('the Pokémon leaves the field: its replacement comes out, or the battle is over – shown then', () => {
  const battle = (index, hp) => ({ kind: 'wild', enemy: { species: 19, level: 3 }, active: { index, hp, maxHp: index === 0 ? 20 : 12 } });
  const r = new DeathReveal();
  r.see(P(20), { now: 0, gen: 6, battle: battle(0, 20) });
  let out = r.see(P(0), { now: 700, gen: 6, battle: battle(0, 0) });
  assert.equal(out.battle.active.hp, 20, 'the battle helper keeps the HP too');
  out = r.see(P(0), { now: 1400, gen: 6, battle: battle(0, 0) });
  assert.equal(out.held.size, 1);
  out = r.see(P(0), { now: 1500, gen: 6, battle: battle(1, 12) });
  assert.equal(out.held.size, 0, 'the next one is out');
  // a whiteout: the battle ends after the message – two readings without a battle
  const w = new DeathReveal();
  w.see(P(20), { now: 0, gen: 7, battle: battle(0, 20) });
  w.see(P(0), { now: 700, gen: 7, battle: battle(0, 0) });
  assert.equal(w.see(P(0), { now: 800, gen: 7, battle: null }).held.size, 1, 'one reading without a battle can be a flicker');
  assert.equal(w.see(P(0), { now: 900, gen: 7, battle: null }).held.size, 0);
  // reset, a loaded state: HP again, or the team gone – shown at once (releaseAll for the buttons)
  const z = new DeathReveal();
  z.see(P(20), { now: 0 });
  z.see(P(0), { now: 700 });
  assert.equal(z.see(P(20), { now: 800 }).held.size, 0);
  z.see(P(0, { key: 'k3' }), { now: 900 });
  z.releaseAll();
  assert.equal(z.held.size, 0);
  // down already when tracking started: nothing to hold
  assert.equal(new DeathReveal().see(P(0), { now: 0 }).held.size, 0);
});

test('a held death is recorded at once and revealed as it was – the partners and the log see it only then', () => {
  const d = mkDoc({ ...R.rules(mkDoc(), PAIR) });
  snap(d, [mon()], {}, PAIR, 'p1');
  snap(d, [mon({ key: 'r1', species: 155 })], {}, PAIR, 'p2');
  const fight = { kind: 'trainer', enemy: { species: 158, level: 5 } };
  const here = { gen: 4, id: 126, name: 'New Bark Town' };
  const held = new Map([['k1', 20]]);
  const res = R.applySnapshot(d, PAIR, 4, 'p1', { source: 'live', party: [mon({ hp: 0 })], here }, { battle: fight, held });
  assert.deepEqual(res.deaths, []);
  assert.equal(R.pairState(d, 'starter', ['p1', 'p2']).state, 'linked', 'nothing for the partners yet');
  assert.ok(!feedOf(d).includes('feed.death'));
  assert.equal(d.get('live:p1').party[0].hp, 20, 'the team the partners and the overlay see keeps its HP');
  const rec = d.get('held:p1:starter');
  assert.equal(rec.key, 'k1');
  assert.equal(rec.killer.species, 158, 'recorded with the battle of that moment');
  // the battle is over by the time it is shown – the cause still names the opponent
  const later = R.applySnapshot(d, PAIR, 4, 'p1', { source: 'live', party: [mon({ hp: 0 })] }, { battle: null, held: new Map() });
  assert.deepEqual(later.deaths, ['starter']);
  assert.equal(d.get('pair:starter').killer.species, 158);
  assert.equal(d.get('held:p1:starter', null), null);
  assert.equal(feedOf(d).filter((k) => k === 'feed.death').length, 1);
  assert.equal(d.get('live:p1').party[0].hp, 0);
});

test('reset, a loaded state or the game closed during the delay: the death stands – and a whiteout ends the run', () => {
  const d = mkDoc({ ...R.NUZLOCKE_RULES });
  snap(d, [mon()]);
  // the only Pokémon falls (a whiteout) – held – and the player resets before the game shows it
  snap(d, [mon({ hp: 0 })], { held: new Map([['k1', 20]]) });
  assert.equal(d.get('run:status', null), null, 'not over while the game still shows it');
  assert.equal(d.get('held:p1:starter').down, true);
  const res = snap(d, [mon({ hp: 20 })], { held: new Map() }); // the save loaded again: full HP
  assert.deepEqual(res.deaths, ['starter']);
  assert.equal(res.failed, 'blackout');
  assert.equal(d.get('run:status').reason, 'blackout');

  // the game closed (play view gone): revealHeld from the app, and a partner's app reveals what is left behind
  const p = mkDoc(R.rules(mkDoc(), PAIR));
  snap(p, [mon(), mon({ key: 'k2', species: 16, metLocation: 177, metLevel: 3, level: 3 })], {}, PAIR, 'p1');
  snap(p, [mon({ key: 'r1', species: 155 })], {}, PAIR, 'p2');
  snap(p, [mon({ hp: 0 }), mon({ key: 'k2', species: 16, metLocation: 177, metLevel: 3, level: 3 })], { held: new Map([['k1', 20]]) }, PAIR, 'p1');
  assert.deepEqual(R.revealHeld(p, PAIR, 'p1', { olderThan: 120000 }).deaths, [], 'a partner waits while it can still be held');
  const out = R.revealHeld(p, PAIR, 'p1', { olderThan: 120000, now: Date.now() + 130000 });
  assert.deepEqual(out.deaths, ['starter']);
  assert.equal(R.revealHeld(p, PAIR, 'p1').deaths.length, 0, 'once');
  assert.equal(p.get('run:status', null), null, 'not a wipe: the second Pokémon stands');
});

test('a simulated fight through the whole chain: no death in the doc until the game has shown it, also at 4×', () => {
  for (const [speed, gen] of [[1, 3], [4, 4], [1, 6]]) {
    const d = mkDoc({ ...R.NUZLOCKE_RULES, blackout: 'off' });
    const r = new DeathReveal();
    const team = (hp) => [mon({ hp }), mon({ key: 'k2', species: 16, metLocation: 177, metLevel: 3, level: 3, hp: 12, maxHp: 12 })];
    let t = 0;
    const poll = (hp) => {
      const shown = r.see(team(hp), { now: (t += 700), speed, gen });
      return R.applySnapshot(d, SOLO, 4, 'p1', { source: 'live', party: team(hp) }, { held: shown.held });
    };
    poll(20);
    poll(8);
    let deadAt = null;
    for (let i = 0; i < 12 && deadAt === null; i++) if (poll(0).deaths.length) deadAt = t;
    // (the 0 HP held from the poll that confirmed it; each poll moves the game on 700 ms × the speed)
    const want = (Math.ceil((REVEAL_MS[gen] - POLL_MS * speed) / (700 * speed)) + 1) * 700;
    assert.equal(deadAt - 1400, want, `gen ${gen} at ${speed}×: in the doc ${deadAt - 1400} ms after the first 0 HP poll`);
  }
});
