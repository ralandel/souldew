// "Got away?" after a wild battle (2.8.2, a player's report on Discord: Platinum SoulLink – fleeing the first
// encounter on Route 204 never marked the area, the next catch there was filed as its encounter; the question "only
// shows up sometimes"). Measured in souldew's own player (Platinum US, Route 201, four wild battles fled in a row): the
// readers saw every battle as wild and its end at once (0x2100 → 0x2800 the poll after "Got away safely!") – but the
// next wild battle began 3.6–13 s after the last one ended (214–776 frames at 1×; far sooner with fast-forward or in
// Route 204's grass), and the play view's 10-second timer was cancelled by every change of the battle. So the question
// came only when no other battle began within 10 s, and a question on the screen went away with the next battle.
// web/lib/missed.mjs now gives every ended wild battle its own clock and keeps the question until it is answered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { findEntry, readLiveParty, readLiveBattle, playerBattle, LiveTables } from '../shared/live/parse.mjs';
import { encryptPK4 } from '../shared/gen4save.mjs';
import { MissedTracker, MISSED_WAIT, MISSED_WAIT_3DS, missedWait, MAX_WAITING, openQuestions, queueQuestions, dropQuestion, wildBattle } from '../web/lib/missed.mjs';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const { RunDoc } = await import('../web/lib/doc.mjs');
const R = await import('../web/lib/run.mjs');

const R201 = { gen: 4, id: 16, name: 'Route 201' };
const R204 = { gen: 4, id: 19, name: 'Route 204' };
const wild = (species, hp = 14) => ({ kind: 'wild', enemy: { species, level: 3, hp, maxHp: 14 }, active: null });
const trainer = (species) => ({ kind: 'trainer', enemy: { species, level: 5, hp: 20, maxHp: 20 }, active: null });

/** Polls every 700 ms like the live loop: `seq` = [[reading, polls], …] from `t0`. → the time after the last poll */
function play(tr, seq, t0 = 0, here = R201) {
  let t = t0;
  for (const [b, n] of seq) {
    for (let i = 0; i < n; i++) {
      tr.see(b, t, here);
      t += 700;
    }
  }
  return t;
}

test('the Platinum trace: two wild battles fled 3.6 s apart – both are asked about (the old timer asked about neither)', () => {
  const tr = new MissedTracker();
  // battle 1: Bidoof, fled after 4 s; 3.6 s on the overworld; battle 2: Bidoof again, fled after 4 s
  let t = play(tr, [[wild(399), 6], [null, 5]], 1000);
  assert.equal(tr.records.length, 1);
  t = play(tr, [[wild(399, 17), 6]], t);
  assert.deepEqual(tr.due(t), [], 'the first one waits on its own clock – the second battle doesn\'t cancel it');
  t = play(tr, [[null, 1]], t);
  assert.deepEqual(tr.due(t), [], 'the second battle ended just now: not yet');
  // the old play view: battle 1's timer was cleared when battle 2 began, battle 2's by any battle within 10 s
  t += MISSED_WAIT;
  const due = tr.due(t);
  assert.equal(due.length, 2, 'both');
  assert.ok(due.every((r) => r.foe.species === 399 && r.here === R201 && tr.caughtAt(r) === 0));
  assert.deepEqual(tr.due(t + 60000), [], 'handed out once');
  // a battle that ran long: its question is due 10 s after its end, also while the next battle runs (shown after it)
  const tr2 = new MissedTracker();
  const u = play(tr2, [[wild(399), 20], [null, 3], [wild(396), 20]], 1000);
  assert.deepEqual(tr2.due(u).map((r) => r.foe.species), [399]);
  assert.ok(tr2.fighting);
});

test('a catch counts for its battle until the battle after it is over – told by its species', () => {
  const tr = new MissedTracker();
  // battle 1 fled; battle 2 begins at once (fast-forward), its Starly is caught – it shows up after battle 2
  let t = play(tr, [[wild(399), 10], [null, 1], [wild(396), 10], [null, 1]], 1000);
  const [b1, b2] = tr.records;
  tr.newMon(t, 396);
  t += MISSED_WAIT;
  const due = tr.due(t);
  assert.deepEqual(due.map((r) => [r.foe.species, tr.caughtAt(r) > 0]), [[399, false], [396, true]], 'Starly was caught, Bidoof got away');
  assert.ok(b1.until !== null && b2.until === null);
  // a full party: the caught Bidoof lands in the PC, read every few seconds – it shows up during the next battle
  const tr2 = new MissedTracker();
  let u = play(tr2, [[wild(399), 10], [null, 1], [wild(396), 3]], 1000);
  tr2.newMon(u, 399);
  u = play(tr2, [[wild(396), 5], [null, 1]], u);
  const [c1, c2] = tr2.records;
  assert.ok(tr2.caughtAt(c1) > 0, 'Bidoof caught');
  assert.equal(tr2.caughtAt(c2), 0, 'Starly got away');
  // Gen 3 puts a catch into the party mid-battle: the next battle's catch is that battle's, not the one before
  const tr3 = new MissedTracker();
  let v = play(tr3, [[wild(263), 10], [null, 1], [wild(265), 4]], 1000);
  tr3.newMon(v, 265);
  v = play(tr3, [[wild(265), 3], [null, 1]], v);
  assert.deepEqual(tr3.records.map((r) => tr3.caughtAt(r) > 0), [false, true]);
  // a Pokémon of the species much later (after the next battle was over) doesn't make the first one caught
  const tr4 = new MissedTracker();
  const w = play(tr4, [[wild(399), 6], [null, 2], [wild(396), 6], [null, 2]], 1000);
  tr4.newMon(w + 60000, 399);
  assert.equal(tr4.caughtAt(tr4.records[0]), 0);
});

test('wild or trainer: one stray reading decides nothing (Gen 4 guesses it from the battle\'s heap copies)', () => {
  assert.equal(wildBattle({ wild: 8, trainer: 1 }), true);
  assert.equal(wildBattle({ wild: 1, trainer: 8 }), false);
  assert.equal(wildBattle({ wild: 0, trainer: 0 }), false);
  const tr = new MissedTracker();
  let t = play(tr, [[wild(399), 6], [trainer(399), 1], [wild(399), 3], [null, 1]], 1000);
  assert.equal(tr.records.length, 1, 'still a wild battle');
  t = play(tr, [[trainer(403), 9], [wild(403), 1], [null, 1]], t);
  assert.equal(tr.records.length, 1, 'a trainer battle is never asked about');
  // a catching demo is no battle of the player's (playerBattle → null): nothing to ask
  const demo = { kind: 'wild', tutorial: true, enemy: { species: 399, level: 2 } };
  play(tr, [[playerBattle(demo), 8]], t);
  assert.equal(tr.records.length, 1);
});

test('the end of a battle is "no battle" – readings without an opponent in between keep it going (Gen 3, HGSS)', () => {
  const tr = new MissedTracker();
  // HGSS: the battle structs zeroed while the next Pokémon is set up; Gen 3: gEnemyParty cleared before gMain says so
  const blank = { kind: 'wild', enemy: null, active: null };
  const t = play(tr, [[wild(19), 5], [blank, 6], [null, 1]], 1000);
  assert.equal(tr.records.length, 1, 'the old play view lost this one: its last reading had no opponent');
  assert.equal(tr.due(t + MISSED_WAIT)[0].foe.species, 19);
});

test('the questions: oldest first, one per area, gone once caught or entered', () => {
  const q = (id, area, o = {}) => ({ id, area, from: id, until: null, ...o });
  const list = [q(1, 'm4-19'), q(2, 'm4-19'), q(3, 'm4-20'), q(4, null), q(5, null)];
  const areaOf = (x) => x.area;
  assert.deepEqual(openQuestions(list, { areaOf }).map((x) => x.id), [1, 3, 4, 5], 'Route 204\'s second miss waits behind its first');
  assert.deepEqual(openQuestions(list, { areaOf, stillOpen: (x) => x.id !== 1 }).map((x) => x.id), [2, 3, 4, 5], '"doesn\'t count" for the first: the next one there is asked');
  assert.deepEqual(openQuestions(list, { areaOf, caughtAt: (x) => (x.id === 3 ? 9 : 0) }).map((x) => x.id), [1, 4, 5]);
});

test('a route full of grass, nothing answered: one question for the area – one "No" and it is gone; a few areas at most', () => {
  // 30 wild battles on Route 204, 20 s apart, none answered (the area stays open): the play view's tick each second
  const tr = new MissedTracker();
  const here = { gen: 4, id: 204 };
  const areaOf = (q) => (q.here ? `m4-${q.here.id}` : null);
  let qs = [];
  let now = 1e6;
  const tick = () => {
    qs = queueQuestions(qs, tr.due(now), { areaOf });
  };
  for (let i = 0; i < 30; i++) {
    for (let k = 0; k < 6; k++) {
      tr.see({ kind: 'wild', enemy: { species: 396 + (i % 3), level: 4 } }, now, here);
      now += 700;
      tick();
    }
    tr.see(null, now, here);
    for (let k = 0; k < 15; k++) {
      now += 1000;
      tick();
    }
  }
  assert.equal(qs.length, 1, 'one waiting question for the area (2.8.2 kept all 30)');
  assert.equal(qs[0].foe.species, 396, 'the first encounter there');
  qs = dropQuestion(qs, qs[0], { areaOf });
  assert.deepEqual(qs, [], 'one "No" answers it');
  // the area is still open: the next battle that gets away there is asked about again
  tr.see({ kind: 'wild', enemy: { species: 399, level: 4 } }, now, here);
  tr.see(null, (now += 700), here);
  now += MISSED_WAIT;
  tick();
  assert.equal(qs.length, 1);

  // "No" drops the questions of that area only; one without a known area counts on its own
  const q = (id, area) => ({ id, area });
  const byArea = (x) => x.area;
  const list = [q(1, 'a'), q(2, 'b'), q(3, null), q(4, 'a')];
  assert.deepEqual(queueQuestions([], list, { areaOf: byArea }).map((x) => x.id), [1, 2, 3]);
  assert.deepEqual(dropQuestion(list, list[0], { areaOf: byArea }).map((x) => x.id), [2, 3]);
  assert.deepEqual(dropQuestion(list, list[2], { areaOf: byArea }).map((x) => x.id), [1, 2, 4]);
  // many areas: a few wait at most (the oldest stay), answered ones and closed areas make room
  const many = Array.from({ length: 10 }, (_, i) => q(i + 1, `r${i}`));
  const held = queueQuestions([], many, { areaOf: byArea });
  assert.equal(held.length, MAX_WAITING);
  assert.deepEqual(held.map((x) => x.id), [1, 2, 3, 4]);
  assert.deepEqual(queueQuestions(held, [q(11, 'r10')], { areaOf: byArea, stillOpen: (x) => x.id !== 2 }).map((x) => x.id), [1, 3, 4, 11]);
});

// ---- end to end on the run logic: a Platinum SoulLink (two players), as the play view uses it ----

const PT = { id: 'pt282', mode: 'soullink', game: { id: 'pokemon-platinum', code: 'CPUE', system: 'nds' }, players: { p1: { name: 'Ana' }, p2: { name: 'Ben' } } };
const rd = { familyRoot: (id) => ({ 397: 396, 398: 396, 400: 399, 404: 403, 405: 403 })[id] || id, types: () => [] };
function mkDoc(rules) {
  const d = new RunDoc('t');
  d.by = 'a';
  d._persistSoon = () => {};
  if (rules) d.set('rules', rules);
  return d;
}
const mon = (o = {}) => ({ key: 'k1', species: 393, nickname: 'PIPLUP', level: 5, hp: 20, maxHp: 20, metLocation: 1, metLevel: 5, ...o });
const snap = (d, slot, party) => R.applySnapshot(d, PT, 4, slot, { source: 'live', party }, { rd });

test('Platinum SoulLink: Shinx flees on Route 204, the next wild battle comes 2 s later – Ben is still asked, the area fails, the next catch there isn\'t its encounter', () => {
  const d = mkDoc({ dupes: 'player' });
  snap(d, 'p1', [mon({ key: 'a1' })]);
  const team = [mon({ key: 'b1', species: 390, nickname: 'CHIMCHAR' })];
  snap(d, 'p2', team);
  const tr = new MissedTracker();
  // Ben's play view: Shinx (403) on Route 204 flees, Kricketot (401) comes right after and flees too
  let t = play(tr, [[wild(403), 12], [null, 3], [wild(401), 8], [null, 1]], 1000, R204);
  t += MISSED_WAIT;
  const ask = (r) => R.missedQuestion(d, PT, rd, 'p2', { foe: r.foe, wild: true, from: r.from, newMonAt: tr.caughtAt(r), boxes: true, partySize: team.length, here: r.here });
  const due = tr.due(t).filter(ask);
  assert.equal(due.length, 2);
  const area = (r) => R.areaForPlace(d, PT, 4, r.here);
  const open = openQuestions(due, { caughtAt: (r) => tr.caughtAt(r), stillOpen: ask, areaOf: area });
  assert.deepEqual(open.map((r) => r.foe.species), [403], 'one question for Route 204: the first encounter there');
  // "Mark as spent" – the place sign's area
  assert.equal(R.markMissed(d, PT, R.areaForCatch(d, PT, 4, 19), 'p2', { species: 403, by: 'p2' }), true);
  assert.equal(R.pairState(d, 'm4-19', PT).state, 'failed');
  assert.deepEqual(openQuestions(due, { caughtAt: (r) => tr.caughtAt(r), stillOpen: ask, areaOf: area }), [], 'the Kricketot question is moot');
  // Ben catches a Budew on Route 204 afterwards: not entered as the area's encounter – he already has one there
  const res = snap(d, 'p2', [...team, mon({ key: 'b2', species: 406, nickname: 'BUDEW', metLocation: 19 })]);
  assert.equal(d.get('enc:m4-19:p2').outcome, 'missed');
  assert.deepEqual(res.inbox.map((i) => [i.mon.key, i.reason]), [['b2', 'occupied']]);
});

test('3DS: the question waits a minute – X/Y file a catch only after the Pokédex entry and the nickname screen', () => {
  assert.equal(missedWait(6), MISSED_WAIT_3DS);
  assert.equal(missedWait(7), MISSED_WAIT_3DS);
  assert.equal(missedWait(4), MISSED_WAIT);
  assert.ok(MISSED_WAIT_3DS >= 60000);
  const tr = new MissedTracker({ wait: missedWait(6) });
  const t = play(tr, [[wild(511), 10], [null, 1]], 1000);
  // the player names Pansage: 40 s after the battle nothing is asked yet
  assert.deepEqual(tr.due(t + 40000), []);
  tr.newMon(t + 45000, 511);
  const [r] = tr.due(t + MISSED_WAIT_3DS);
  assert.equal(tr.caughtAt(r), t + 45000, 'the catch answers it – no question');
});

test('"Mark as spent", then the Pokémon turns up after all: the area becomes the catch (not the inbox)', () => {
  const d = mkDoc({ dupes: 'player' });
  snap(d, 'p1', [mon({ key: 'a1' })]);
  const team = [mon({ key: 'b1', species: 390, nickname: 'CHIMCHAR' })];
  snap(d, 'p2', team);
  const area = R.areaForCatch(d, PT, 4, 19);
  assert.equal(R.markMissed(d, PT, area, 'p2', { species: 403, by: 'p2', asked: true }), true);
  assert.equal(R.pairState(d, area, PT).state, 'failed');
  // another species there: stays the inbox's (the miss stands)
  let res = snap(d, 'p2', [...team, mon({ key: 'b2', species: 406, nickname: 'BUDEW', metLocation: 19 })]);
  assert.deepEqual(res.inbox.map((i) => [i.mon.key, i.reason]), [['b2', 'occupied']]);
  // the Shinx it asked about joins: caught after all
  res = snap(d, 'p2', [...team, mon({ key: 'b3', species: 403, nickname: 'SHINX', metLocation: 19 })]);
  assert.deepEqual(res.newCatches, [area]);
  assert.deepEqual([d.get(`enc:${area}:p2`).outcome, d.get(`enc:${area}:p2`).key], ['caught', 'b3']);
  assert.notEqual(R.pairState(d, area, PT).state, 'failed');
  // a miss entered on the board (not the question's), or one long ago, isn't taken back
  const d2 = mkDoc({ dupes: 'player' });
  snap(d2, 'p2', team);
  R.markMissed(d2, PT, area, 'p2', { species: 403, by: 'p2' });
  res = snap(d2, 'p2', [...team, mon({ key: 'b3', species: 403, nickname: 'SHINX', metLocation: 19 })]);
  assert.equal(d2.get(`enc:${area}:p2`).outcome, 'missed');
  const d3 = mkDoc({ dupes: 'player' });
  snap(d3, 'p2', team);
  R.markMissed(d3, PT, area, 'p2', { species: 403, by: 'p2', asked: true });
  d3.set(`enc:${area}:p2`, { ...d3.get(`enc:${area}:p2`), at: Date.now() - R.CAUGHT_AFTER_MISS - 1 });
  snap(d3, 'p2', [...team, mon({ key: 'b3', species: 403, nickname: 'SHINX', metLocation: 19 })]);
  assert.equal(d3.get(`enc:${area}:p2`).outcome, 'missed');
});

// ---- the Gen 4 battle readers on synthetic RAM: a wild battle that is fled ----

const L = (f) => JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url)));
const TABLE = L('addresses.json');
const T = new LiveTables({ gen4: L('gen4.json') });
const TID = 4242;
const SID = 777;
function ram() {
  const m = new Uint8Array(0x400000);
  const at = (a) => a - 0x02000000;
  return {
    m,
    read: (a, n) => (a >= 0x02000000 && a + n <= 0x02400000 ? m.slice(at(a), at(a) + n) : null),
    put: (a, bytes) => m.set(bytes, at(a)),
    u32: (a, v) => new DataView(m.buffer).setUint32(at(a), v >>> 0, true),
    u16: (a, v) => new DataView(m.buffer).setUint16(at(a), v, true),
  };
}
function pk4({ pid = 0x1234abcd, species = 152, level = 12, tid = TID, sid = SID, hp = 30, maxHp = 34 } = {}) {
  const d = new Uint8Array(236);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint16(0x08, species, true);
  dv.setUint16(0x0c, tid, true);
  dv.setUint16(0x0e, sid, true);
  dv.setUint16(0x46, 16, true);
  d[0x84] = 5;
  d[0x8c] = level;
  dv.setUint16(0x8e, hp, true);
  dv.setUint16(0x90, maxHp, true);
  return encryptPK4(d);
}
function partyAt(r, core, mons) {
  r.u32(core, 6);
  r.u32(core + 4, mons.length);
  mons.forEach((m, i) => r.put(core + 8 + i * 236, m));
}
function saveImage(r, entry, base, mons) {
  const general = base + parseInt(entry.badges.generalOffsetFromSaveBase, 16);
  const trainer = general + parseInt(entry.badges.trainerOffset, 16);
  r.u16(trainer + 0x10, TID);
  r.u16(trainer + 0x12, SID);
  partyAt(r, base + parseInt(entry.partyMonsOffset, 16) - 8, mons);
}
/** One live-loop poll: the party, then the battle (as the play view reads them). */
const poll = (e, r, state) => playerBattle(readLiveBattle(e, r.read, T, state, readLiveParty(e, r.read, T, state).party));

test('Platinum (English): a wild Bidoof, fled – the battle is wild on every poll and over the poll the flag says so', () => {
  const e = findEntry(TABLE, { platform: 'nds', code: 'CPUE' });
  const r = ram();
  const base = 0x02270000;
  r.u32(0x02101d40, base);
  const me = { pid: 0x0a0a0001, species: 387, level: 6, hp: 23, maxHp: 23 };
  saveImage(r, e, base, [pk4(me)]);
  r.u16(0x0224a55a, 0x2800);
  const state = {};
  const tr = new MissedTracker();
  let t = 0;
  const step = () => {
    const b = poll(e, r, state);
    tr.see(b, t, R201);
    t += 700;
    return b;
  };
  for (let i = 0; i < 3; i++) assert.equal(step(), null, 'overworld');
  // the battle: the flag, the player's copy and the wild Bidoof's (the player's own trainer ID – wild Pokémon carry it)
  r.u16(0x0224a55a, 0x2100);
  partyAt(r, 0x02302000, [pk4(me)]);
  partyAt(r, 0x02300000, [pk4({ pid: 0x5eed0001, species: 399, level: 2, hp: 14, maxHp: 14 })]);
  const kinds = [];
  for (let i = 0; i < 10; i++) kinds.push(step()?.kind ?? null);
  assert.ok(kinds.filter((k) => k === 'wild').length >= 7, kinds.join());
  assert.ok(!kinds.includes('trainer'));
  // "Got away safely!" → the overworld
  r.u16(0x0224a55a, 0x2800);
  assert.equal(step(), null);
  assert.equal(tr.records.length, 1);
  assert.equal(tr.records[0].foe.species, 399);
});

test('Platinum in another language: the English battle flag\'s address counts only once it showed both values there', () => {
  // German Platinum (CPUD): no pointer – the party is searched for; the flag's address is the English game's. A word
  // there that reads 0x2800 all the time hid every battle before (and with it every "got away?").
  const e = findEntry(TABLE, { platform: 'nds', code: 'CPUD' });
  assert.ok(e.scanOnly);
  const r = ram();
  const base = 0x02270000;
  const me = { pid: 0x0a0a0001, species: 387, level: 6, hp: 23, maxHp: 23 };
  saveImage(r, e, base, [pk4(me)]);
  r.u16(0x0224a55a, 0x2800); // not the flag in this language: it stays 0x2800 in battle too
  const state = {};
  for (let i = 0; i < 3; i++) poll(e, r, state);
  partyAt(r, 0x02302000, [pk4({ ...me, hp: 20 })]); // the battle's copy of the player's party (Turtwig took a hit)
  partyAt(r, 0x02300000, [pk4({ pid: 0x5eed0001, species: 399, level: 2, hp: 14, maxHp: 14 })]);
  let b = null;
  for (let i = 0; i < 8 && !b; i++) b = poll(e, r, state);
  assert.equal(b?.kind, 'wild', 'seen from the copies');
  assert.equal(b.enemy.species, 399);
  // where the address does hold the flag in that language: trusted once it showed both values
  const r2 = ram();
  saveImage(r2, e, base, [pk4(me)]);
  r2.u16(0x0224a55a, 0x2800);
  const s2 = {};
  for (let i = 0; i < 3; i++) poll(e, r2, s2);
  r2.u16(0x0224a55a, 0x2100);
  partyAt(r2, 0x02302000, [pk4(me)]);
  partyAt(r2, 0x02300000, [pk4({ pid: 0x5eed0002, species: 396, level: 3, hp: 16, maxHp: 16 })]);
  b = null;
  for (let i = 0; i < 8 && !b; i++) b = poll(e, r2, s2);
  assert.equal(b?.enemy?.species, 396);
  r2.u16(0x0224a55a, 0x2800);
  assert.equal(poll(e, r2, s2), null, 'over the poll the flag says so');
});

// ---- #80 (SoulSilver US, built-in player, solo Nuzlocke, 2.8.1): a wild Pokémon knocked out or fled, the player walks
// straight on into an area whose first encounter is still open – and about one time in three souldew asked whether
// THAT area was spent. 2.8.1 checked the place sign as the battle ended and put the place the player stood at when the
// question came up (10 s later) first in the prompt. The question is about the place of the battle, captured while it
// runs; when that isn't known in a game that shows places, nothing is asked.

const SS = { id: 'ss80', mode: 'nuzlocke', game: { id: 'pokemon-soulsilver', code: 'IPGE', system: 'nds' }, players: { p1: { name: 'Ash' } } };
const R32 = { gen: 4, id: 180, name: 'Route 32' };
const R33 = { gen: 4, id: 181, name: 'Route 33' };

test('#80: knocked out on Route 32 (its encounter entered), straight on into Route 33 (open) – no question; asked about Route 32 only', () => {
  const d = mkDoc();
  R.setEncounter(d, SS, 'route-32', 'p1', { outcome: 'caught', species: 418, key: 'buizel' }, { quiet: true });
  const tr = new MissedTracker();
  let t = play(tr, [[null, 3]], 1000, R32);
  t = play(tr, [[wild(19), 8], [wild(19, 0), 4]], t, R32); // the Rattata knocked out
  t = play(tr, [[null, 2]], t, R32); // (the battle is over the poll after)
  t = play(tr, [[null, 4]], t, R33); // a few steps on: Route 33
  const [r] = tr.due(t + MISSED_WAIT);
  assert.deepEqual(r.here, R32, 'the place of the battle, not the one after it');
  const ask = (here) => R.missedQuestion(d, SS, rd, 'p1', { foe: r.foe, wild: true, from: r.from, newMonAt: 0, boxes: true, partySize: 4, here });
  assert.equal(ask(r.here), false, 'Route 32 has its encounter: nothing to ask');
  assert.equal(ask(R33), true, '(what asking about the place the player is at now did)');
  // the same where the battle's area is open: the question names Route 32
  const d2 = mkDoc();
  R.setEncounter(d2, SS, 'route-33', 'p1', { outcome: 'caught', species: 41, key: 'zubat' }, { quiet: true });
  assert.equal(R.missedQuestion(d2, SS, rd, 'p1', { foe: r.foe, wild: true, from: r.from, newMonAt: 0, boxes: true, partySize: 4, here: r.here }), true);
  assert.equal(R.areaForPlace(d2, SS, 4, r.here), 'route-32');
});

test('#80: the place of a battle is read in it or the moment before it – never after it; two places, or none, is no place', () => {
  // no place sign during the battle: the one read on the overworld right before it began
  let tr = new MissedTracker();
  let t = play(tr, [[null, 3]], 1000, R32);
  t = play(tr, [[wild(19), 8]], t, null);
  play(tr, [[null, 3]], t, R33);
  assert.deepEqual(tr.records[0].here, R32);
  assert.equal(tr.records[0].placeLost, undefined);
  // … but not one read long before it, and never the one read after it (2.8.2 took that one)
  tr = new MissedTracker();
  t = play(tr, [[null, 1]], 1000, R32);
  t = play(tr, [[null, 16]], t, null); // (a menu, a cut scene: no place for a while)
  t = play(tr, [[wild(19), 8]], t, null);
  play(tr, [[null, 3]], t, R33);
  assert.equal(tr.records[0].here, null);
  assert.equal(tr.records[0].placeLost, true, 'the game shows places: ask nothing rather than guess');
  // a reader that sees the battle go on after it ended (no battle flag), while the player walks on: two places
  tr = new MissedTracker();
  t = play(tr, [[wild(19), 8]], 1000, R32);
  play(tr, [[wild(19), 6], [null, 2]], t, R33);
  assert.equal(tr.records[0].here, null);
  assert.equal(tr.records[0].placeLost, true);
  // a game without a place sign at all: the solo question offers the open areas, as before
  tr = new MissedTracker();
  play(tr, [[null, 3], [wild(19), 8], [null, 3]], 1000, null);
  assert.equal(tr.records[0].here, null);
  assert.equal(tr.records[0].placeLost, undefined);
});

test('#80 end to end: Platinum in another language (no battle flag), Bidoof fled without a hit – the copies keep the battle going while the player walks on', () => {
  const e = findEntry(TABLE, { platform: 'nds', code: 'CPUD' });
  const r = ram();
  const base = 0x02270000;
  const me = { pid: 0x0a0a0001, species: 387, level: 6, hp: 23, maxHp: 23 };
  saveImage(r, e, base, [pk4(me)]);
  r.u16(0x0224a55a, 0x2800); // not the flag in this language
  const state = {};
  const tr = new MissedTracker();
  let t = 0;
  const step = (here) => {
    const b = poll(e, r, state);
    tr.see(b, t, here);
    t += 700;
    return b;
  };
  for (let i = 0; i < 3; i++) step(R201);
  partyAt(r, 0x02302000, [pk4(me)]); // the battle's copy of the player's party – no hit taken
  partyAt(r, 0x02300000, [pk4({ pid: 0x5eed0001, species: 399, level: 2, hp: 14, maxHp: 14 })]);
  for (let i = 0; i < 8; i++) step(R201);
  assert.equal(tr.fighting, true);
  // "Got away safely!" – the save party is as it was, the copies stay in RAM: the reader still sees the battle while the
  // player walks into Route 202
  const R202 = { gen: 4, id: 17, name: 'Route 202' };
  for (let i = 0; i < 4; i++) assert.equal(step(R202)?.enemy?.species, 399);
  // the blocks are reused: the battle is over
  r.put(0x02300000, new Uint8Array(0x200));
  r.put(0x02302000, new Uint8Array(0x200));
  for (let i = 0; i < 5; i++) step(R202); // (a copy that can't be read is held for a few polls)
  assert.equal(tr.records.length, 1);
  assert.equal(tr.records[0].here, null, '2.8.2 asked about Route 202 here');
  assert.equal(tr.records[0].placeLost, true);
});
