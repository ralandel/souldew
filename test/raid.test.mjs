// Raids (shared/raid.mjs, shared/live/raidhp.mjs): the shared pool every computer folds from the same events, in the
// same order whatever order they arrived in; what comes from the other computers checked; one game's side (hits and
// heals become events, the pool becomes writes only while the game waits, our own writes never count as hits, a write
// that doesn't hold puts the player out); the phases, the result and the log line; the Game Boy HP bar as the games
// draw it and the writes per generation (the readings are the ones the running games showed – docs/MULTIPLAYER.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../shared/raid.mjs';
import * as H from '../shared/live/raidhp.mjs';
import { readFileSync } from 'node:fs';

const addresses = JSON.parse(readFileSync(new URL('../shared/data/addresses.json', import.meta.url), 'utf8'));

const entryOf = (id) => addresses.games.find((g) => g.id === id);
const raid = (players = ['p1', 'p2'], extra = {}) => ({ ...R.newRaid({ id: 'abcdef012345', host: players[0], players, at: 1000 }), state: 'go', go: 1000, ...extra });
const seat = (extra = {}) => ({ v: 1, join: true, b: { n: 1, max: [20], sp: [7], lv: [5], at: 2000, lc: 1 }, ev: [], out: null, fin: null, ...extra });

test('the pool: damage in basis points from every player, in the agreed order; a heal goes back in up to 100 %, never into an empty slot', () => {
  const r = raid(['p1', 'p2', 'p3']);
  const seats = {
    p1: seat({ ev: [[2, 'd', 0, 3000], [5, 'd', 0, 4000]] }),
    p2: seat({ ev: [[3, 'h', 0, 5000], [6, 'd', 0, 3500]] }),
    p3: seat({ ev: [[4, 'd', 0, 1000]] }),
  };
  const p = R.foldPool(r, seats);
  // 10000 −3000 = 7000, +5000 → 10000 (capped), −1000 = 9000, −4000 = 5000, −3500 = 1500
  assert.deepEqual(p.pools, [1500]);
  assert.deepEqual(p.dealt, { p1: 7000, p2: 3500, p3: 1000 });
  // a heal after the slot was emptied stays out; damage beyond what's left counts only what was left
  seats.p3.ev.push([7, 'd', 0, 4000], [8, 'h', 0, 9000]);
  const q = R.foldPool(r, seats);
  assert.deepEqual(q.pools, [0]);
  assert.equal(q.dealt.p3, 1000 + 1500);
  assert.deepEqual(q.downBy, ['p3']);
});

test('every computer folds the same pool from the same events, whatever order they arrived in; ties go by slot', () => {
  const r = raid(['p1', 'p2']);
  const a = { p1: seat({ ev: [[2, 'd', 0, 6000], [4, 'h', 0, 3000]] }), p2: seat({ ev: [[2, 'd', 0, 6000], [3, 'd', 0, 1000]] }) };
  const b = { p2: a.p2, p1: a.p1 };
  assert.deepEqual(R.foldPool(r, a), R.foldPool(r, b));
  // same clock 2 on both: p1 first (10000 → 4000), then p2 takes the 4000 left
  assert.deepEqual(R.foldPool(r, a).dealt, { p1: 6000, p2: 4000 });
  assert.deepEqual(R.foldPool(r, a).pools, [0]);
  // an event that arrives late is folded where its clock puts it – the result is what everybody else computed
  const late = { p1: seat({ ev: [[2, 'd', 0, 6000]] }), p2: seat({ ev: [[3, 'd', 0, 1000]] }) };
  const early = R.foldPool(r, late).pools[0];
  late.p1.ev.push([4, 'h', 0, 3000]);
  late.p2.ev.unshift([2, 'd', 0, 6000]);
  assert.deepEqual(R.foldPool(r, late), R.foldPool(r, a));
  assert.equal(early, 3000);
});

test('pool slots: as many as the biggest party any player shows; only the roster counts (not a decliner)', () => {
  const r = raid(['p1', 'p2', 'p3']);
  const seats = {
    p1: seat({ b: { n: 2, max: [20, 30], sp: [], lv: [], at: 1, lc: 1 }, ev: [[2, 'd', 1, 10000]] }),
    p2: seat({ b: { n: 3, max: [20, 30, 40], sp: [], lv: [], at: 1, lc: 1 }, ev: [[3, 'd', 2, 2500]] }),
    p3: { v: 1, join: false, ev: [[4, 'd', 0, 10000]] },
  };
  const p = R.foldPool(r, Object.fromEntries(Object.entries(seats).map(([k, v]) => [k, R.cleanSeat(v)])));
  assert.equal(p.size, 3);
  assert.deepEqual(p.pools, [10000, 0, 7500]);
  assert.equal(p.dealt.p3, undefined);
});

test('the Lamport clock: past every event, battle, end of anybody in the raid', () => {
  assert.equal(R.nextClock({}), 1);
  assert.equal(R.nextClock({ p1: seat({ ev: [[7, 'd', 0, 1]] }), p2: seat({ out: { why: 'wiped', at: 1, lc: 9 } }) }), 10);
});

test('HP from the pool: the game\'s share, at least 1 while the slot isn\'t empty; changes in basis points, at least 1', () => {
  assert.equal(R.hpFor(10000, 20), 20);
  assert.equal(R.hpFor(5000, 21), 11);
  assert.equal(R.hpFor(1, 300), 1);
  assert.equal(R.hpFor(0, 300), 0);
  assert.equal(R.bpOf(-3, 20), 1500);
  assert.equal(R.bpOf(1, 999), 10);
  assert.equal(R.bpOf(-1, 100000), 1);
  assert.equal(R.bpOf(0, 20), 0);
});

test('what comes from the other computers is checked: wrong versions, slots, ids, events – a broken event ends the list', () => {
  assert.equal(R.cleanRaid({ v: 1, id: 'nothex', host: 'p1', players: ['p1', 'p2'] }, 'nothex'), null);
  assert.equal(R.cleanRaid({ v: 2, id: 'abcdef012345', host: 'p1', players: ['p1', 'p2'] }, 'abcdef012345'), null);
  assert.equal(R.cleanRaid({ v: 1, id: 'abcdef012345', host: 'p1', players: ['p2', 'p1'] }, 'abcdef012345'), null, 'the host comes first');
  assert.equal(R.cleanRaid({ v: 1, id: 'abcdef012345', host: 'p1', players: ['p1'] }, 'abcdef012345'), null, 'nobody to raid with');
  const ok = R.cleanRaid({ v: 1, id: 'abcdef012345', host: 'p1', players: ['p1', 'p2', 'p2', 'p9'], state: 'weird', at: 5 }, 'abcdef012345');
  assert.deepEqual(ok.players, ['p1', 'p2']);
  assert.equal(ok.state, 'open');
  const s = R.cleanSeat({ v: 1, join: true, ev: [[1, 'd', 0, 500], [2, 'd', 9, 500], [3, 'd', 0, 500]], out: { why: 'hacked' } });
  assert.deepEqual(s.ev, [[1, 'd', 0, 500]]);
  assert.equal(s.out, null);
  assert.equal(R.cleanSeat({ v: 1, ev: [[1, 'x', 0, 5]] }).ev.length, 0);
  assert.equal(R.cleanSeat({ v: 1, ev: [[1, 'd', 0, 10001]] }).ev.length, 0, 'more than 100 % at once');
  assert.equal(R.cleanSeat({ v: 1, b: { n: 9 } }).b, null);
  assert.equal(R.cleanSeat(null), null);
});

test('raids in the doc: keys, the roster, seats of players who weren\'t invited ignored', () => {
  const entries = {
    abcdef012345: R.newRaid({ id: 'abcdef012345', host: 'p2', players: ['p1', 'p2'], at: 1 }),
    'abcdef012345:p1': { v: 1, join: true },
    'abcdef012345:p3': { v: 1, join: true },
    'abcdef012345:p2': { v: 1, join: true },
    junk: { v: 1 },
  };
  const doc = { scan: (prefix) => (prefix === R.DOC_PREFIX ? entries : {}) };
  const all = R.raidsIn(doc);
  assert.deepEqual(Object.keys(all), ['abcdef012345']);
  assert.deepEqual(all.abcdef012345.raid.players, ['p2', 'p1']);
  assert.deepEqual(Object.keys(all.abcdef012345.seats).sort(), ['p1', 'p2']);
  assert.deepEqual(R.rosterOf(all.abcdef012345.raid, all.abcdef012345.seats), ['p2', 'p1']);
});

test('phases: invite, countdown, hunt, fight, won once every battle is known and every slot empty, lost once everybody is out', () => {
  const r = raid(['p1', 'p2']);
  assert.equal(R.raidStatus({ ...r, state: 'open' }, {}, { now: 2000 }).phase, 'invite');
  assert.equal(R.raidStatus({ ...r, state: 'open' }, {}, { now: 1000 + R.RAID.answerMs * 4 + 1 }).phase, 'stale', 'the host\'s app went away before it started');
  assert.equal(R.raidStatus({ ...r, state: 'cancel' }, {}, { now: 2000 }).phase, 'cancelled');
  const ready = { p1: seat({ b: null }), p2: seat({ b: null }) };
  assert.equal(R.raidStatus(r, ready, { now: 3000, goSeen: 2000 }).phase, 'countdown');
  assert.equal(R.raidStatus(r, ready, { now: 2000 + R.RAID.countdownMs + 1, goSeen: 2000 }).phase, 'hunt');
  const one = { p1: seat({ ev: [[2, 'd', 0, 10000]] }), p2: seat({ b: null }) };
  // the pool is empty but p2's battle isn't known yet (it may have more Pokémon): not won yet
  assert.equal(R.raidStatus(r, one, { now: 99999, goSeen: 0 }).phase, 'fight');
  one.p2 = seat();
  assert.equal(R.raidStatus(r, one, { now: 99999, goSeen: 0 }).phase, 'won');
  const out = { p1: seat({ out: { why: 'wiped', at: 5, lc: 3 } }), p2: seat({ out: { why: 'left', at: 6, lc: 4 } }) };
  const st = R.raidStatus(r, out, { now: 99999 });
  assert.equal(st.phase, 'lost');
  assert.deepEqual(st.outWhy, { p1: 'wiped', p2: 'left' });
  assert.equal(R.raidStatus({ ...r, at: 0 }, ready, { now: R.RAID.keepMs + 1 }).phase, 'stale');
  assert.ok(R.raidOver({ phase: 'won' }) && !R.raidOver({ phase: 'fight' }));
});

test('the result: MVP by damage taken off the pool, survivors, time; the log entry and what stream tools get', () => {
  const r = raid(['p1', 'p2', 'p3']);
  const seats = {
    p1: seat({ ev: [[2, 'd', 0, 3000]], b: { n: 1, max: [20], sp: [7], lv: [5], at: 10000, lc: 1 }, fin: { at: 70000, lc: 9 } }),
    p2: seat({ ev: [[3, 'd', 0, 7000]], b: { n: 1, max: [30], sp: [4], lv: [5], at: 12000, lc: 1 } }),
    p3: seat({ out: { why: 'wiped', at: 50000, lc: 5 }, b: { n: 1, max: [30], sp: [1], lv: [5], at: 11000, lc: 1 } }),
  };
  const st = R.raidStatus(r, seats, { now: 80000 });
  assert.equal(st.phase, 'won');
  const res = R.raidResult(r, seats, st);
  assert.equal(res.mvp, 'p2');
  assert.deepEqual(res.survivors, ['p1', 'p2']);
  assert.equal(res.ms, 60000);
  assert.equal(R.durationText(res.ms), '1:00');
  const f = R.raidFeedEntry(r, res, 1);
  assert.equal(f.type, 'raid');
  assert.deepEqual(R.raidOfFeed(f), { won: true, players: ['p1', 'p2', 'p3'], mvp: 'p2', survivors: ['p1', 'p2'], ms: 60000, size: 1 });
  assert.deepEqual(R.raidOfFeed({ type: 'catch' }), {});
});

// ---- one game's side ----------------------------------------------------------------------------------------------

/** A trainer battle as a driver reads it: one or more opponents, `quiet` while the game waits for the player. */
const view = (foes, { quiet = true, active = [0], key = 'k1', hud } = {}) => ({ trainer: true, quiet, key, trainerId: 1, foes: foes.map(([hp, maxHp], idx) => ({ idx, hp, maxHp, species: 7, level: 5 })), active, ...(hud === undefined ? {} : { hud }) });
const pool = (pools) => ({ size: pools.length, pools });

test('one game: its battle begins, hits become events, the pool goes in only while it waits – our own writes are no hits', () => {
  const p = new R.RaidPlayer({ me: 'p1' });
  assert.equal(p.tick({ view: null, pool: pool([]) }).begin, null);
  assert.equal(p.tick({ view: { ...view([[20, 20]]), trainer: false }, pool: pool([]) }).begin, null, 'not a wild battle');
  const b = p.tick({ view: view([[20, 20], [30, 30]]), pool: pool([]) }).begin;
  assert.deepEqual(b.max, [20, 30]);
  assert.equal(b.n, 2);
  // the player hits: 20 → 14 = 30 %
  let r = p.tick({ view: view([[14, 20], [30, 30]], { quiet: false }), pool: pool([10000, 10000]) });
  assert.deepEqual(r.events, [['d', 0, 3000]]);
  assert.deepEqual(r.writes, [], 'not while the move runs');
  // the pool says 40 % (a partner hit too): written once the game waits
  r = p.tick({ view: view([[14, 20], [30, 30]]), pool: pool([4000, 10000]) });
  assert.deepEqual(r.writes, [{ idx: 0, hp: 8, active: true }]);
  // our write reads back: no event
  r = p.tick({ view: view([[8, 20], [30, 30]]), pool: pool([4000, 10000]) });
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.writes, []);
  // the slot empties in the pool: the one out goes to 1 HP – never 0 – and the game's next hit knocks it out
  r = p.tick({ view: view([[8, 20], [30, 30]]), pool: pool([0, 10000]) });
  assert.deepEqual(r.writes, [{ idx: 0, hp: 1, active: true }]);
  p.tick({ view: view([[1, 20], [30, 30]]), pool: pool([0, 10000]) });
  r = p.tick({ view: view([[0, 20], [30, 30]], { quiet: false }), pool: pool([0, 10000]) });
  assert.deepEqual(r.events, [['d', 0, 10000]], 'a knock-out empties the slot, whatever the rounding left in it');
  // the next one comes out; the partner's hits on it go in; one that isn't out goes to 0 in the party (skipped)
  r = p.tick({ view: view([[0, 20], [30, 30]], { active: [1] }), pool: pool([0, 5000]) });
  assert.deepEqual(r.writes, [{ idx: 1, hp: 15, active: true }]);
});

test('one game: a write that doesn\'t hold is tried again, then the game is out of step and gets no more writes', () => {
  const p = new R.RaidPlayer({ me: 'p1' });
  p.tick({ view: view([[20, 20]]), pool: pool([]), now: 0 });
  let r = p.tick({ view: view([[20, 20]]), pool: pool([5000]), now: 100 });
  assert.equal(r.writes[0].hp, 10);
  // the mirror hasn't caught up yet: wait
  assert.deepEqual(p.tick({ view: view([[20, 20]]), pool: pool([5000]), now: 200 }).writes, []);
  // still 20 long after: once more
  r = p.tick({ view: view([[20, 20]]), pool: pool([5000]), now: 100 + R.RAID.verifyMs * 5 });
  assert.equal(r.writes[0]?.hp, 10);
  r = p.tick({ view: view([[20, 20]]), pool: pool([5000]), now: 300 + R.RAID.verifyMs * 10 });
  assert.deepEqual(r.out, { why: 'desync' });
  assert.deepEqual(p.tick({ view: view([[20, 20]]), pool: pool([5000]), now: 400 + R.RAID.verifyMs * 10 }).writes, []);
});

test('one game: a heal is an event; a switch reads another copy without counting it; the battle\'s end: done or out', () => {
  const p = new R.RaidPlayer({ me: 'p1' });
  p.tick({ view: view([[20, 20], [30, 30]]), pool: pool([]) });
  p.tick({ view: view([[10, 20], [30, 30]], { quiet: false }), pool: pool([10000, 10000]) });
  let r = p.tick({ view: view([[15, 20], [30, 30]], { quiet: false }), pool: pool([5000, 10000]) });
  assert.deepEqual(r.events, [['h', 0, 2500]]);
  // the trainer switches: 0 goes back (its party copy says 16 – the copies differ by a point), 1 comes out
  r = p.tick({ view: view([[16, 20], [30, 30]], { quiet: false, active: [1] }), pool: pool([7500, 10000]) });
  assert.deepEqual(r.events, []);
  // every opponent down here, then the battle ends: this player is done
  p.tick({ view: view([[0, 20], [0, 30]], { quiet: false, active: [1] }), pool: pool([0, 0]) });
  for (let i = 0; i < 2; i++) assert.equal(p.tick({ view: null, pool: pool([0, 0]) }).fin, null, 'one missed reading is no end');
  assert.ok(p.tick({ view: null, pool: pool([0, 0]) }).fin);
  // a battle that ends with opponents left: out – wiped when the team is down
  const q = new R.RaidPlayer({ me: 'p2' });
  q.tick({ view: view([[20, 20]]), pool: pool([]) });
  for (let i = 0; i < 2; i++) q.tick({ view: null, pool: pool([10000]), team: [{ hp: 0, maxHp: 20 }] });
  assert.deepEqual(q.tick({ view: null, pool: pool([10000]), team: [{ hp: 0, maxHp: 20 }] }).out, { why: 'wiped' });
  const w = new R.RaidPlayer({ me: 'p3' });
  w.tick({ view: view([[20, 20]]), pool: pool([]) });
  assert.deepEqual(w.tick({ view: view([[20, 20]]), pool: pool([10000]), team: [{ hp: 0, maxHp: 9 }] }).out, { why: 'wiped' });
});

test('one game: holds at its first menu while the others\' battles haven\'t begun – at most RAID.waitMs', () => {
  const p = new R.RaidPlayer({ me: 'p1' });
  p.tick({ view: view([[20, 20]]), pool: pool([]), now: 0 });
  assert.equal(p.tick({ view: view([[20, 20]]), pool: pool([10000]), now: 10, allIn: false }).hold, true);
  assert.equal(p.tick({ view: view([[20, 20]]), pool: pool([10000]), now: R.RAID.waitMs + 20, allIn: false }).hold, false);
  assert.equal(p.tick({ view: view([[20, 20]]), pool: pool([10000]), now: 30, allIn: true }).hold, false);
});

test('one game: a battle that was already on when the raid started is not the raid\'s', () => {
  const p = new R.RaidPlayer({ me: 'p1', skipKey: 'old' });
  assert.equal(p.tick({ view: view([[20, 20]], { key: 'old' }), pool: pool([]) }).begin, null);
  assert.ok(p.tick({ view: view([[20, 20]], { key: 'new' }), pool: pool([]) }).begin);
});

test('one game: the bar on screen out of date (the game brought back a saved screen) is drawn again', () => {
  const p = new R.RaidPlayer({ me: 'p1' });
  p.tick({ view: view([[20, 20]]), pool: pool([]) });
  const r = p.tick({ view: view([[20, 20]], { hud: false }), pool: pool([10000]) });
  assert.deepEqual(r.writes, [{ idx: 0, hp: 20, active: true, hud: true }]);
});

// ---- the games -----------------------------------------------------------------------------------------------------

test('Game Boy HP bar: the tiles DrawHPBar / DrawBattleHPBar put down (Red: 10/20 and 1/20 as the running game drew them)', () => {
  assert.deepEqual([...H.gbBarTiles(1, 20, 20)], [0x71, 0x62, 0x6b, 0x6b, 0x6b, 0x6b, 0x6b, 0x6b, 0x6c]);
  assert.deepEqual([...H.gbBarTiles(1, 10, 20)], [0x71, 0x62, 0x6b, 0x6b, 0x6b, 0x63, 0x63, 0x63, 0x6c]);
  assert.deepEqual([...H.gbBarTiles(1, 1, 20)], [0x71, 0x62, 0x65, 0x63, 0x63, 0x63, 0x63, 0x63, 0x6c]);
  assert.deepEqual([...H.gbBarTiles(1, 7, 20)], [0x71, 0x62, 0x6b, 0x6b, 0x63, 0x63, 0x63, 0x63, 0x6c]); // (the game's own after Scratch)
  assert.deepEqual([...H.gbBarTiles(1, 0, 20)].slice(2, 8), [0x63, 0x63, 0x63, 0x63, 0x63, 0x63]);
  // a max HP above 255: both divided by 4 first, as the game does
  assert.equal(H.gbBarPixels(1, 700), 1);
  assert.equal(H.gbBarPixels(350, 700), 24);
  assert.deepEqual([...H.gbBarTiles(2, 20, 20)], [0x60, 0x61, 0x6a, 0x6a, 0x6a, 0x6a, 0x6a, 0x6a, 0x6b]);
});

/** A Game Boy's WRAM as the page's mirror has it. */
function gbBus() {
  const m = new Uint8Array(0x2000);
  return { m, read: (a, n) => (a >= 0xc000 && a + n <= 0xe000 ? m.slice(a - 0xc000, a - 0xc000 + n) : null), put: (a, bytes) => m.set(bytes, a - 0xc000) };
}

test('Red: the rival\'s battle as the running game held it – view, quiet at the battle menu, writes (battle copy, bar, its saved copy, party)', () => {
  const e = entryOf('red_us');
  const b = gbBus();
  b.put(0xd057, [2]); // wIsInBattle: trainer
  b.put(0xd89c, [1]); // wEnemyPartyCount
  const mon = new Uint8Array(44);
  mon[0] = 177; // Squirtle (internal)
  mon.set([0, 20], 1);
  mon[0x21] = 5;
  mon.set([0, 20], 0x22);
  b.put(0xd8a4, mon);
  b.put(0xcfe6, [0, 20]); // wEnemyMonHP
  b.put(0xcff4, [0, 20]); // wEnemyMonMaxHP
  b.put(0xcfe8, [0]); // wEnemyMonPartyPos
  b.put(0xd031, [0x19]);
  b.put(0xd05d, [1]);
  b.put(0xc3ca, H.gbBarTiles(1, 20, 20));
  b.put(0xcc24, [0x0e, 9, 0, 0x7f, 1, 0x11]); // the battle menu
  const v = H.raidView(e, b.read, {});
  assert.equal(v.quiet, true);
  assert.equal(v.hud, true);
  assert.deepEqual(v.foes, [{ idx: 0, hp: 20, maxHp: 20, species: 177, level: 5 }]);
  assert.deepEqual(v.active, [0]);
  // the move menu: not quiet (its parameters stay while the move runs)
  b.put(0xcc24, [0x0c, 5, 1, 0x7f, 3, 0xc7]);
  assert.equal(H.raidView(e, b.read, {}).quiet, false);
  const w = H.raidWrites(e, b.read, {}, v, 0, 10);
  assert.deepEqual(w.map((x) => [x.addr, [...x.bytes]]), [
    [0xcfe6, [0, 10]],
    [0xc3ca, [0x71, 0x62, 0x6b, 0x6b, 0x6b, 0x63, 0x63, 0x63, 0x6c]],
    [0xc532, [0x71, 0x62, 0x6b, 0x6b, 0x6b, 0x63, 0x63, 0x63, 0x6c]],
    [0xd8a5, [0, 10]],
  ]);
  // never in a wild battle, a link battle, or with a battle copy that isn't this battle's yet
  b.put(0xd057, [1]);
  assert.equal(H.raidView(e, b.read, {}), null);
  b.put(0xd057, [2]);
  b.put(0xd12b, [4]);
  assert.equal(H.raidView(e, b.read, {}), null);
  b.put(0xd12b, [0]);
  b.put(0xcff4, [0, 33]);
  assert.equal(H.raidView(e, b.read, {}), null);
});

test('support per game: verified engines take part, the others say why', () => {
  assert.deepEqual(H.raidSupport(entryOf('red_us')), { ok: true });
  assert.deepEqual(H.raidSupport(null), { ok: false, why: 'unknown' });
});

test('another language of a DS game (French Platinum, German HeartGold): "not in this version yet" – not "this ROM hack"', async () => {
  const { findEntry } = await import('../shared/live/parse.mjs');
  for (const code of ['CPUF', 'IPKD', 'IPGS']) {
    const e = findEntry(addresses, { platform: 'nds', code });
    assert.ok(e.scanOnly, code);
    assert.deepEqual(H.raidSupport(e), { ok: false, why: 'version' }, code);
  }
  // a hack whose memory moved stays a hack
  assert.deepEqual(H.raidSupport({ ...entryOf('crystal_us'), wram: { delta: 11 } }), { ok: false, why: 'hack' });
  assert.deepEqual(H.raidSupport({ ...entryOf('emerald_us'), scan3: true }), { ok: false, why: 'hack' });
});

test('stream tools: a finished raid is a `raid` event, its log entry carries the result', async () => {
  const { eventsBetween, EVENT_TYPES } = await import('../shared/streamapi.mjs');
  assert.ok(EVENT_TYPES.includes('raid'));
  const base = { run: { id: 'r1', status: null }, players: [], encounters: [], feed: [], generatedAt: 5 };
  const f = { id: 'raid-abcdef012345', type: 'raid', ...R.raidOfFeed({ type: 'raid', won: true, players: ['p1', 'p2'], mvp: 'p2', survivors: ['p2'], ms: 61000, size: 2 }) };
  const evs = eventsBetween(base, { ...base, feed: [f] });
  assert.deepEqual(evs, [{ type: 'raid', run: 'r1', at: 5, won: true, players: ['p1', 'p2'], mvp: 'p2', survivors: ['p2'], ms: 61000, size: 2 }]);
  assert.deepEqual(eventsBetween({ ...base, feed: [f] }, { ...base, feed: [f] }), [], 'once');
});

// ---- Crystal and FireRed / Emerald: what the running games held (scratch states, docs/MULTIPLAYER.md › "Raid") --------

test('Crystal: quiet at the battle menu and in the move menu (its "TYPE/" box) – not while the move runs; the bar in the tile map', () => {
  const e = entryOf('crystal_us');
  const b = gbBus();
  b.put(0xd22d, [2]);
  b.put(0xd280, [1]);
  const mon = new Uint8Array(0x30);
  mon[0] = 187;
  mon[0x1f] = 3;
  mon.set([0, 15], 0x22);
  mon.set([0, 15], 0x24);
  b.put(0xd288, mon);
  b.put(0xd216, [0, 15]);
  b.put(0xd218, [0, 15]);
  b.put(0xc4ca, H.gbBarTiles(2, 15, 15));
  b.put(0xcfa1, [0x0e, 9, 2, 2]); // the battle menu's 2D menu
  let v = H.raidView(e, b.read, {});
  assert.equal(v.quiet, true);
  b.put(0xcfa1, [0x0d, 5, 2, 1]); // the move menu's – also while the move runs
  assert.equal(H.raidView(e, b.read, {}).quiet, false);
  b.put(0xc4a0 + 9 * 20 + 1, [0x93, 0x98, 0x8f, 0x84, 0xf3]); // "TYPE/": the move menu waits
  v = H.raidView(e, b.read, {});
  assert.equal(v.quiet, true);
  assert.deepEqual(H.raidWrites(e, b.read, {}, v, 0, 7).map((x) => [x.addr, [...x.bytes]]), [
    [0xd216, [0, 7]], [0xc4ca, [0x60, 0x61, 0x6a, 0x6a, 0x68, 0x62, 0x62, 0x62, 0x6b]], [0xd2aa, [0, 7]],
  ]);
  // the move menu brought back the bar of the turn's start: drawn again
  assert.equal(H.raidView(e, b.read, {}).hud, true);
  b.put(0xd216, [0, 7]);
  assert.equal(H.raidView(e, b.read, {}).hud, false);
});

/** A GBA's EWRAM + IWRAM as the mirror has them. */
function gbaBus() {
  const ew = new Uint8Array(0x40000);
  const iw = new Uint8Array(0x8000);
  const at = (a) => (a >= 0x03000000 ? [iw, a - 0x03000000] : [ew, a - 0x02000000]);
  return {
    read: (a, n) => { const [m, o] = at(a); return o >= 0 && o + n <= m.length ? m.slice(o, o + n) : null; },
    put: (a, bytes) => { const [m, o] = at(a); m.set(bytes, o); },
  };
}
const le32b = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];

test('FireRed: the rival\'s battle – quiet only at the action / move menu with the opponent\'s controller idle; the HP bar the game\'s own way', () => {
  const e = entryOf('firered_us');
  const b = gbaBus();
  b.put(0x03003529, [0x02]); // gMain.inBattle
  b.put(0x02022b4c, le32b(0x08)); // trainer battle (not FireRed's first one)
  const mon = new Uint8Array(100);
  mon.set(le32b(0x12345678), 0);
  mon[0x54] = 5;
  mon.set([19, 0], 0x56);
  mon.set([19, 0], 0x58);
  b.put(0x0202402c, mon);
  b.put(0x02023bce, [0, 0, 0, 0]); // gBattlerPartyIndexes
  const bm = new Uint8Array(0x58);
  bm.set([19, 0], 0x28);
  bm.set([19, 0], 0x2c);
  bm.set(le32b(0x12345678), 0x48);
  b.put(0x02023be4 + 0x58, bm);
  b.put(0x03004f84, le32b(0x08014040 | 1)); // HandleTurnActionSelectionState
  b.put(0x03004fe0, [...le32b(0x0802e438 | 1), ...le32b(0x08035a98 | 1)]); // the player chooses, the opponent idles
  b.put(0x020386ae, [0x46, 0x01]);
  let v = H.raidView(e, b.read, {});
  assert.equal(v.quiet, true);
  assert.equal(v.trainerId, 326);
  assert.deepEqual(v.foes, [{ idx: 0, hp: 19, maxHp: 19, level: 5 }]);
  const w = H.raidWrites(e, b.read, {}, v, 0, 10);
  assert.deepEqual(w.map((x) => [x.addr, [...x.bytes], x.wait || null]), [
    [0x02023be4 + 0x58 + 0x28, [10, 0], null], // the battle's HP
    [0x02022bc4 + 0x200, [24, 0, 9, 0], null], // CONTROLLER_HEALTHBARUPDATE, 9 damage
    [0x03004fe0 + 4, le32b(0x08038844 | 1), null], // the opponent's controller → its HP bar handler
    [0x0202402c + 0x56, [10, 0], { addr: 0x03004fe0 + 4, value: 0x08035a98 | 1, ms: 4000 }], // the party's, once it's idle again
  ]);
  // the opponent's controller busy (the bar sliding): not quiet
  b.put(0x03004fe0 + 4, le32b(0x080360a0 | 1));
  assert.equal(H.raidView(e, b.read, {}).quiet, false);
  b.put(0x03004fe0 + 4, le32b(0x08035a98 | 1));
  // FireRed's first rival battle: before Oak's "Inflicting damage…" lesson the bar command would start it in the action
  // menu – plain writes, the bar follows the next hit; once it was shown, the bar command again
  b.put(0x02022b4c, le32b(0x1c));
  b.put(0x02023fe8, le32b(0x02030000));
  v = H.raidView(e, b.read, {});
  assert.deepEqual(H.raidWrites(e, b.read, {}, v, 0, 10).map((x) => x.addr), [0x02023be4 + 0x58 + 0x28, 0x0202402c + 0x56]);
  b.put(0x02030000 + 0x96, [1]);
  v = H.raidView(e, b.read, {});
  assert.equal(H.raidWrites(e, b.read, {}, v, 0, 10).length, 4);
  // the move animation: another main function – not quiet; a wild battle or a link battle: no raid at all
  b.put(0x03004f84, le32b(0x080155c8 | 1));
  assert.equal(H.raidView(e, b.read, {}).quiet, false);
  b.put(0x02022b4c, le32b(0x04));
  assert.equal(H.raidView(e, b.read, {}), null);
  b.put(0x02022b4c, le32b(0x0a));
  assert.equal(H.raidView(e, b.read, {}), null);
  // after the battle gBattleTypeFlags stays: gMain.inBattle decides
  b.put(0x02022b4c, le32b(0x08));
  b.put(0x03003529, [0]);
  assert.equal(H.raidView(e, b.read, {}), null);
});

test('Gen 3: no raid in the challenge facilities – Emerald\'s Battle Frontier and Pyramid, FireRed\'s Trainer Tower (their own bits)', () => {
  // pokeemerald / pokefirered include/constants/battle.h: the bits above 8 mean different things in the two games
  const view = (id, T, flags) => {
    const e = entryOf(id);
    const b = gbaBus();
    b.put(Number(e.inBattle.addr), [Number(e.inBattle.mask || 2)]);
    b.put(T.typeFlags, le32b(flags));
    const mon = new Uint8Array(100);
    mon.set(le32b(0x12345678), 0);
    mon[0x54] = 50;
    mon.set([90, 0], 0x56);
    mon.set([90, 0], 0x58);
    b.put(T.enemyParty, mon);
    b.put(T.partyIndexes, [0, 0, 0, 0]);
    const bm = new Uint8Array(0x58);
    bm.set([90, 0], 0x28);
    bm.set([90, 0], 0x2c);
    bm.set(le32b(0x12345678), 0x48);
    b.put(T.battleMons + 0x58, bm);
    return H.raidView(e, b.read, {});
  };
  const EM = { typeFlags: 0x02022fec, enemyParty: 0x02024744, partyIndexes: 0x0202406e, battleMons: 0x02024084 };
  const FR = { typeFlags: 0x02022b4c, enemyParty: 0x0202402c, partyIndexes: 0x02023bce, battleMons: 0x02023be4 };
  assert.ok(view('emerald_us', EM, 0x08), 'an ordinary trainer battle');
  assert.ok(view('emerald_us', EM, 0x08 | 0x400000), 'Steven at your side (INGAME_PARTNER): an ordinary one too');
  for (const [bit, what] of [[0x100, 'Battle Tower'], [0x10000, 'Dome'], [0x20000, 'Palace'], [0x40000, 'Arena'], [0x80000, 'Factory'], [0x100000, 'Pike'], [0x200000, 'Pyramid']]) {
    assert.equal(view('emerald_us', EM, 0x08 | bit), null, `Emerald: ${what}`);
  }
  assert.ok(view('firered_us', FR, 0x08));
  assert.equal(view('firered_us', FR, 0x08 | 0x80000), null, 'FireRed: the Trainer Tower');
  assert.equal(view('leafgreen_us', FR, 0x08 | 0x80000), null, 'LeafGreen: the Trainer Tower');
});

test('support per game: the verified ones; other versions and the 3DS say why', () => {
  for (const id of ['red_us', 'blue_us', 'crystal_us', 'emerald_us', 'firered_us', 'leafgreen_us', 'platinum_us', 'heartgold_us', 'black2_us']) assert.equal(H.raidSupport(entryOf(id)).ok, true, id);
  for (const id of ['yellow_us', 'gold_us', 'ruby_us', 'emerald_de', 'diamond_us', 'soulsilver_us', 'black_us', 'white2_us']) assert.deepEqual(H.raidSupport(entryOf(id)), { ok: false, why: 'version' }, id);
  assert.deepEqual(H.raidSupport(entryOf('sm')), { ok: false, why: 'ctr' });
});

// ---- the hub: capability, the host's start, the rule ------------------------------------------------------------

test('the hub: only partners whose souldew announced raids (and whose game can take part) are asked; the host starts once all answered', async () => {
  const ROOT = new URL('../', import.meta.url).href;
  const { registerHooks } = await import('node:module');
  registerHooks({ resolve: (spec, ctx, next) => next(spec.startsWith('/shared/') ? new URL(`.${spec}`, ROOT).href : spec === '/vendor/htm-preact.mjs' ? new URL('./node_modules/htm/preact/standalone.module.js', ROOT).href : spec, ctx) });
  const { RunDoc } = await import('../web/lib/doc.mjs');
  const { RaidHub, raidRules } = await import('../web/lib/raid.mjs');
  assert.deepEqual(raidRules({}), { on: true, deaths: true });
  assert.deepEqual(raidRules({ raids: 'off', raidDeaths: false }), { on: false, deaths: false });
  const doc = new RunDoc('raidtest');
  doc._persistSoon = () => {};
  const manifest = { id: 'raidtest', mode: 'soullink', players: { p1: { name: 'A' }, p2: { name: 'B' }, p3: { name: 'C' } } };
  let now = 1000;
  const hub = new RaidHub({ doc, manifest, me: 'p1', now: () => now });
  clearInterval(hub.timer);
  hub.online = new Set(['p2', 'p3']);
  assert.deepEqual(hub.canInvite('p2'), { ok: false, why: 'old' }, 'an older 3.0 build never wrote raidcap');
  doc.set('raidcap:p2', { v: 1, at: 1, game: { gen: 3, ok: true } });
  doc.set('raidcap:p3', { v: 1, at: 1, game: { gen: 7, ok: false, why: 'ctr' } });
  assert.deepEqual(hub.canInvite('p2'), { ok: true });
  assert.equal(hub.canInvite('p3').why, 'game');
  hub.online = new Set(['p3']);
  assert.equal(hub.canInvite('p2').why, 'offline');
  hub.online = new Set(['p2', 'p3']);
  const raid = hub.start(['p2', 'p3']);
  assert.deepEqual(raid.players, ['p1', 'p2'], 'only the one who can take part is asked');
  assert.equal(hub.start(['p2']).error, 'busy');
  hub._hostTick();
  assert.equal(doc.get(`raid:${raid.id}`).state, 'open', 'waits for the answer');
  doc.set(`raid:${raid.id}:p2`, { v: 1, join: true, ev: [] });
  hub._hostTick();
  assert.equal(doc.get(`raid:${raid.id}`).state, 'go');
  // nobody joins: called off after RAID.answerMs
  const doc2 = new RunDoc('raidtest2');
  doc2._persistSoon = () => {};
  const h2 = new RaidHub({ doc: doc2, manifest, me: 'p1', now: () => now });
  clearInterval(h2.timer);
  h2.online = new Set(['p2']);
  doc2.set('raidcap:p2', { v: 1, at: 1, game: null });
  const r2 = h2.start(['p2']);
  now += R.RAID.answerMs + 1;
  h2._hostTick();
  assert.equal(doc2.get(`raid:${r2.id}`).state, 'cancel');
  hub.stop();
  h2.stop();
});

test('"Deaths in a raid count" off: Pokémon that went down in the raid stand until healed – kept in the run', async () => {
  const { RunDoc } = await import('../web/lib/doc.mjs');
  const { RaidHub } = await import('../web/lib/raid.mjs');
  const doc = new RunDoc('raidspare');
  doc._persistSoon = () => {};
  const hub = new RaidHub({ doc, manifest: { id: 'raidspare', mode: 'soullink', players: { p1: {}, p2: {} } }, me: 'p1' });
  clearInterval(hub.timer);
  hub.online = new Set(['p2']);
  doc.set('raidcap:p2', { v: 1, at: 1, game: null });
  const r = hub.start(['p2']);
  doc.set(`raid:${r.id}:p2`, { v: 1, join: true, ev: [] });
  hub._hostTick();
  hub.spare([{ key: 'a', hp: 20, maxHp: 20 }, { key: 'b', hp: 0, maxHp: 20 }]); // b was down before the raid
  hub.spare([{ key: 'a', hp: 0, maxHp: 20 }, { key: 'b', hp: 0, maxHp: 20 }]);
  assert.deepEqual(doc.get('raidspared:p1'), ['a']);
  const held = new Map([['a', 5]]);
  const s = hub.spared([{ key: 'a', hp: 0, maxHp: 20 }, { key: 'b', hp: 0, maxHp: 20 }], held);
  assert.deepEqual(s.party.map((m) => m.hp), [1, 0]);
  assert.equal(s.held.has('a'), false);
  // healed: no longer spared
  assert.equal(hub.spared([{ key: 'a', hp: 20, maxHp: 20 }]), null);
  assert.deepEqual(doc.get('raidspared:p1'), []);
  hub.stop();
});

test('Platinum: the opponent\'s party HP in its encrypted block; the one out from the battle; quiet only while the battle waits for the player', () => {
  const e = entryOf('platinum_us');
  const m = new Uint8Array(0x400000);
  const put = (a, bytes) => m.set(bytes, a - 0x02000000);
  const read = (a, n) => (a >= 0x02000000 && a + n <= 0x02400000 ? m.slice(a - 0x02000000, a - 0x02000000 + n) : null);
  const key = (pid, w) => { let s = pid >>> 0; let k = 0; for (let i = 0; i <= w; i++) { s = (Math.imul(s, 0x41c64e6d) + 0x6073) >>> 0; k = s >>> 16; } return k; };
  const le16b = (v) => [v & 0xff, (v >> 8) & 0xff];
  put(Number(e.inBattle.addr), le16b(0x2100));
  const save = 0x02200000;
  put(0x02101d40, le32b(save));
  const ctx = save + 0x44878;
  const sys = save + 0x417fc;
  const party = 0x02300000;
  const bd1 = 0x02310000;
  const pid = 0x1234abcd;
  put(sys + 0x30, le32b(ctx));
  put(sys + 0x44, le32b(2));
  put(sys + 0x34, [...le32b(0x02310400), ...le32b(bd1)]);
  put(sys + 0x2c, le32b(1)); // a trainer battle
  put(sys + 0x68 + 4, le32b(party));
  put(sys + 0xa0, [0, 0, 0x53, 0x03]);
  put(party, [...le32b(6), ...le32b(1)]);
  const mon = party + 8;
  put(mon, le32b(pid));
  put(mon + 0x8c, le16b(5 ^ key(pid, 2)));
  put(mon + 0x8e, le16b(19 ^ key(pid, 3)));
  put(mon + 0x90, le16b(19 ^ key(pid, 4)));
  // the one out: battler 1 is party slot 0, 19/19
  put(ctx + 0x2d40 + 0xc0, le16b(390));
  put(ctx + 0x2d40 + 0xc0 + 0x4c, le32b(19));
  put(ctx + 0x2d40 + 0xc0 + 0x50, le32b(19));
  put(ctx + 0x2d40 + 0xc0 + 0x68, le32b(pid));
  put(ctx + 0x2d40 + 0xc0 + 0x34, [5]);
  put(ctx + 0x08, le32b(5)); // the battle waits for the player's command
  put(ctx, [1, 0, 0, 0]); // the player's battler in its action menu
  const v = H.raidView(e, read, {});
  assert.equal(v.quiet, true);
  assert.equal(v.trainerId, 851);
  assert.deepEqual(v.foes.map(({ debug, ...f }) => f), [{ idx: 0, hp: 19, maxHp: 19, level: 5 }]);
  const w = H.raidWrites(e, read, {}, v, 0, 10);
  assert.deepEqual([...w[0].bytes], le16b(10 ^ key(pid, 3)), 'the party copy, encrypted');
  assert.deepEqual([w[1].addr, [...w[1].bytes]], [ctx + 0x2d40 + 0xc0 + 0x4c, le32b(10)], 'the battle\'s HP');
  // its bar shows 19: the game's own UpdateHPGauge command (queue entry, message, command byte last)
  put(bd1 + 0x50, le32b(19));
  assert.deepEqual(H.raidWrites(e, read, {}, v, 0, 10).slice(2).map((x) => x.addr), [ctx + 0x2200 + 16, bd1 + 0x95, bd1 + 0x94]);
  assert.equal(H.raidWrites(e, read, {}, v, 0, 0)[1].bytes[0], 1, 'never 0 for the one out');
  put(ctx + 0x08, le32b(22)); // the turn runs
  assert.equal(H.raidView(e, read, {}).quiet, false);
  put(Number(e.inBattle.addr), le16b(0x2800));
  assert.equal(H.raidView(e, read, {}), null, 'the overworld: the battle\'s memory keeps its bytes, the word decides');
});

test('a write that waits for the game (Gen 3: the party copy once the HP bar has slid) is left out when the game never gets there', async () => {
  const ROOT = new URL('../', import.meta.url).href;
  const { registerHooks } = await import('node:module');
  registerHooks({ resolve: (spec, ctx, next) => next(spec.startsWith('/shared/') ? new URL(`.${spec}`, ROOT).href : spec === '/vendor/htm-preact.mjs' ? new URL('./node_modules/htm/preact/standalone.module.js', ROOT).href : spec, ctx) });
  const { writeInOrder } = await import('../web/lib/raid.mjs');
  const b = gbaBus();
  const idle = 0x08035a98 | 1;
  const list = [
    { addr: 0x02023be4 + 0x58 + 0x28, bytes: Uint8Array.of(10, 0) },
    { addr: 0x0202402c + 0x56, bytes: Uint8Array.of(10, 0), wait: { addr: 0x03004fe0 + 4, value: idle, ms: 120 } },
  ];
  const wrote = [];
  const write = async (a, bytes) => (wrote.push(a), b.put(a, bytes), true);
  // the opponent's controller still in its HP bar handler after the wait: the party copy is not written
  b.put(0x03004fe0 + 4, le32b(0x08038844 | 1));
  assert.equal(await writeInOrder(list, b.read, write), true);
  assert.deepEqual(wrote, [0x02023be4 + 0x58 + 0x28], 'only the battle\'s HP');
  assert.deepEqual([...b.read(0x0202402c + 0x56, 2)], [0, 0]);
  // idle again in time: written
  wrote.length = 0;
  b.put(0x03004fe0 + 4, le32b(idle));
  assert.equal(await writeInOrder(list, b.read, write), true);
  assert.deepEqual(wrote, [0x02023be4 + 0x58 + 0x28, 0x0202402c + 0x56]);
  // a refusal stops the rest
  wrote.length = 0;
  assert.equal(await writeInOrder(list, b.read, async (a) => (wrote.push(a), false)), false);
  assert.deepEqual(wrote, [0x02023be4 + 0x58 + 0x28]);
});
