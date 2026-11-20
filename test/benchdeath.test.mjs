// #79 (SoulSilver US, built-in player, solo Nuzlocke, 2.8.1): training on Route 32, the player knocked out a wild
// Taillow – and souldew marked the team's last Pokémon, a Houndour that never entered the battle, dead "against
// Taillow", logged under Ruins of Alph (where the Houndour was caught). Not reproducible on demand. These replay the
// live loop of the play view (web/views/play.mjs: readLiveParty → readLiveBattle → withBattleHp → confirmFaints →
// applySnapshot) on synthetic SoulSilver RAM, poll by poll.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { findEntry, readLiveParty, readLiveBattle, playerBattle, withBattleHp, confirmFaints, battleTwins, LiveTables } from '../shared/live/parse.mjs';
import { encryptPK4 } from '../shared/gen4save.mjs';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const { RunDoc } = await import('../web/lib/doc.mjs');
const R = await import('../web/lib/run.mjs');

const L = (f) => JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url)));
const T = new LiveTables({ gen4: L('gen4.json') });
const SS = findEntry(L('addresses.json'), { platform: 'nds', code: 'IPGE' });
const RUN = { id: 'ss79', mode: 'nuzlocke', game: { id: 'pokemon-soulsilver', code: 'IPGE', system: 'nds' }, players: { p1: { name: 'Ash' } } };

const TID = 4242;
const SID = 777;
const OT = ((SID << 16) | TID) >>> 0;
const BASE = 0x0227c218; // SaveData (behind the pointer at 0x02111880)
const CORE = BASE + 0xa0; // the party: { capacity 6, count, mons }
const BMONS = BASE + 0x49e14; // the battle's BattleMon array (addresses.json battleMons)
const FLAG = 0x02246f48; // 0x2100 in battle, 0x2800 on the overworld
const PLAYER_COPY = 0x02320000; // the battle's copy of the player's party (heap)
const WILD_COPY = 0x02300000; // the wild Pokémon's party (heap)

const ROUTE_32 = { gen: 4, id: 180, name: 'Route 32' };
const VIOLET = { gen: 4, id: 128, name: 'Violet City' };

function dsRam() {
  const m = new Uint8Array(0x400000);
  const w = (addr, bytes) => m.set(bytes, addr - 0x02000000);
  w(0x02111880, [BASE & 0xff, (BASE >> 8) & 0xff, (BASE >> 16) & 0xff, BASE >>> 24]);
  const read = (addr, len) => (addr >= 0x02000000 && addr + len <= 0x02400000 ? m.slice(addr - 0x02000000, addr - 0x02000000 + len) : null);
  const flag = (v) => w(FLAG, [v & 0xff, v >> 8]);
  return { w, read, flag };
}
function pk4({ pid, species, level = 9, hp = 25, maxHp = 25, met = 180, nick = '' }) {
  const d = new Uint8Array(236);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint16(0x08, species, true);
  dv.setUint16(0x0c, TID, true);
  dv.setUint16(0x0e, SID, true);
  for (let i = 0; i < 11; i++) dv.setUint16(0x48 + i * 2, i < nick.length ? nick.charCodeAt(i) : 0xffff, true);
  dv.setUint16(0x46, met, true);
  d[0x84] = level;
  d[0x8c] = level;
  dv.setUint16(0x8e, hp, true);
  dv.setUint16(0x90, maxHp, true);
  return encryptPK4(d);
}
const core = (mons) => [6, 0, 0, 0, mons.length, 0, 0, 0, ...mons.flatMap((x) => [...pk4(x)])];
function bmon({ species, level = 9, hp = 25, maxHp = 25, pid, otId = OT }) {
  const d = new Uint8Array(0xc0);
  const dv = new DataView(d.buffer);
  dv.setUint16(0, species, true);
  dv.setUint16(0x0c, 33, true);
  d[0x34] = level;
  dv.setUint32(0x4c, hp, true);
  dv.setUint32(0x50, maxHp, true);
  dv.setUint32(0x68, pid, true);
  dv.setUint32(0x74, otId, true);
  return d;
}
const battlers = (w, list) => list.forEach((b, i) => w(BMONS + i * 0xc0, b ? bmon(b) : new Uint8Array(0xc0)));

// The reporter's team (from the log): the starter Chinchou, Taillow (Route 30), Buizel (Route 32) and Houndour
// "Princess" (Ruins of Alph) in the last slot.
const CHINCHOU = { pid: 0x0c0c0001, species: 170, level: 11, hp: 33, maxHp: 33, met: 126 };
const TAILLOW = { pid: 0x0c0c0002, species: 276, level: 9, hp: 27, maxHp: 27, met: 178 };
const BUIZEL = { pid: 0x0c0c0003, species: 418, level: 10, hp: 30, maxHp: 30, met: 180 };
const HOUNDOUR = { pid: 0x0c0c0004, species: 228, level: 8, hp: 26, maxHp: 26, met: 209, nick: 'Princess' };
const TEAM = [CHINCHOU, TAILLOW, BUIZEL, HOUNDOUR];

function mkDoc() {
  const d = new RunDoc('t');
  d.by = 'a';
  d._persistSoon = () => {};
  return d;
}

/** The play view's live loop: one poll every 700 ms (the clock moves with it), its snapshot applied to the run. */
function session(read, d) {
  const state = {};
  let now = Date.now();
  const realNow = Date.now;
  const deaths = [];
  const poll = (here, n = 1) => {
    let out = null;
    for (let i = 0; i < n; i++) {
      Date.now = () => now;
      try {
        const res = readLiveParty(SS, read, T, state);
        const fight = playerBattle(readLiveBattle(SS, read, T, state, res.party));
        const party = confirmFaints(withBattleHp(res.party, fight, state), state, fight);
        const r = R.applySnapshot(d, RUN, 4, 'p1', { source: 'live', party, here }, { battle: fight });
        deaths.push(...r.deaths);
        out = { fight, party };
      } finally {
        Date.now = realNow;
      }
      now += 700;
    }
    return out;
  };
  return { poll, deaths, state };
}

/** Route 32: the team on the overworld, filed by the tracker. */
function onRoute32() {
  const ram = dsRam();
  const d = mkDoc();
  ram.w(CORE, core(TEAM));
  ram.flag(0x2800);
  const s = session(ram.read, d);
  s.poll(ROUTE_32, 3);
  assert.equal(d.get('enc:ruins-of-alph:p1').species, HOUNDOUR.species, 'Houndour is the Ruins of Alph encounter');
  assert.equal(d.get('enc:route-32:p1').species, BUIZEL.species);
  return { ...ram, d, ...s };
}

test('#79: a wild Pokémon whose PID is one of the team\'s is knocked out – its 0 HP never lands on that team member', () => {
  const { w, flag, d, poll, deaths } = onRoute32();
  // A wild Taillow (Lv. 9) whose personality value happens to be Houndour's – the game's random numbers repeat after a
  // reset or a loaded state, and a wild Pokémon carries the player's trainer ID: its one-Pokémon copy in the heap looked
  // like a copy of the player's party (every PID one of the team's), and its HP was folded onto Houndour.
  const foe = { pid: HOUNDOUR.pid, species: 276, level: 9, hp: 28, maxHp: 28 };
  flag(0x2100);
  battlers(w, [CHINCHOU, foe]);
  w(PLAYER_COPY, core(TEAM));
  w(WILD_COPY, core([foe]));
  let r = poll(ROUTE_32, 6); // (the heap search takes a few polls)
  assert.equal(r.fight.kind, 'wild');
  assert.equal(r.fight.enemy.species, 276);
  // Chinchou hits it, then knocks it out; the battle runs on through the EXP and the end of the battle
  battlers(w, [CHINCHOU, { ...foe, hp: 9 }]);
  w(WILD_COPY, core([{ ...foe, hp: 9 }]));
  poll(ROUTE_32, 3);
  battlers(w, [CHINCHOU, { ...foe, hp: 0 }]);
  w(WILD_COPY, core([{ ...foe, hp: 0 }]));
  r = poll(ROUTE_32, 6);
  assert.equal(r.fight.enemy.hp, 0);
  assert.ok(!(r.fight.party || []).some((m) => m.hp === 0), 'the wild copy is not taken for the player\'s');
  assert.equal(r.party.find((m) => m.species === HOUNDOUR.species).hp, HOUNDOUR.hp);
  flag(0x2800);
  poll(ROUTE_32, 4);
  assert.deepEqual(deaths, []);
  assert.notEqual(d.get('pair:ruins-of-alph', null)?.state, 'dead');
  assert.equal(d.get('run:status', null), null);
});

test('#79: a bench Pokémon at 0 HP in the battle\'s copy is no death – only one that has been out can go down in a battle', () => {
  const { w, flag, d, poll, deaths } = onRoute32();
  const foe = { pid: 0x7a110001, species: 276, level: 9, hp: 28, maxHp: 28 };
  flag(0x2100);
  battlers(w, [CHINCHOU, foe]);
  w(PLAYER_COPY, core(TEAM));
  w(WILD_COPY, core([foe]));
  poll(ROUTE_32, 6);
  // whatever the copy shows (a copy being rewritten, one of something else): Houndour at 0 HP, for many polls, while
  // the battle's own struct says Chinchou is out the whole time
  w(PLAYER_COPY, core([CHINCHOU, TAILLOW, BUIZEL, { ...HOUNDOUR, hp: 0 }]));
  battlers(w, [CHINCHOU, { ...foe, hp: 0 }]);
  w(WILD_COPY, core([{ ...foe, hp: 0 }]));
  const r = poll(ROUTE_32, 6);
  assert.equal(r.party.find((m) => m.species === HOUNDOUR.species).hp, HOUNDOUR.hp, 'Houndour keeps the HP of the party');
  // the battle is over – the party says Houndour is fine
  flag(0x2800);
  poll(ROUTE_32, 4);
  assert.deepEqual(deaths, []);
  assert.notEqual(d.get('pair:ruins-of-alph', null)?.state, 'dead');
});

test('#79: the Pokémon that is out and goes down dies, against the opponent, at the place of the battle', () => {
  const { w, flag, d, poll, deaths } = onRoute32();
  const foe = { pid: 0x7a110002, species: 276, level: 9, hp: 28, maxHp: 28 };
  flag(0x2100);
  battlers(w, [CHINCHOU, foe]);
  w(PLAYER_COPY, core(TEAM));
  w(WILD_COPY, core([foe]));
  poll(ROUTE_32, 6);
  battlers(w, [{ ...CHINCHOU, hp: 0 }, foe]);
  w(PLAYER_COPY, core([{ ...CHINCHOU, hp: 0 }, TAILLOW, BUIZEL, HOUNDOUR]));
  poll(ROUTE_32);
  assert.deepEqual(deaths, [], 'one read at 0 isn\'t enough');
  poll(ROUTE_32);
  assert.deepEqual(deaths, ['starter']);
  const p = d.get('pair:starter');
  assert.deepEqual([p.state, p.killer.species, p.place.name], ['dead', 276, 'Route 32']);
  const line = R.feedList(d).find((f) => f.type === 'death');
  assert.match(line.text, /: the Pokémon died – .* fainted against .* \(Lv\. 9, wild battle, Route 32\)$/);
  // Buizel, the Route 32 encounter, goes down on Route 32: the place isn't said twice
  battlers(w, [{ ...BUIZEL, hp: 0 }, foe]);
  w(PLAYER_COPY, core([{ ...CHINCHOU, hp: 0 }, TAILLOW, { ...BUIZEL, hp: 0 }, HOUNDOUR]));
  poll(ROUTE_32, 2);
  assert.deepEqual(deaths, ['starter', 'route-32']);
  assert.equal(R.feedList(d).find((f) => f.type === 'death' && f.area === 'route-32').cause.key, 'feed.faintedBy');
});

test('#79: a faint the battle reader missed shows once the battle is over – told where the battle was, not where the player is now', () => {
  const { w, flag, d, poll, deaths } = onRoute32();
  const foe = { pid: 0x7a110003, species: 276, level: 9, hp: 28, maxHp: 28 };
  flag(0x2100);
  battlers(w, [CHINCHOU, foe]);
  w(PLAYER_COPY, core(TEAM));
  w(WILD_COPY, core([foe]));
  poll(ROUTE_32, 6);
  // Houndour switched in and was knocked out between two polls (fast-forward): the struct never showed it, the copy does
  w(PLAYER_COPY, core([CHINCHOU, TAILLOW, BUIZEL, { ...HOUNDOUR, hp: 0 }]));
  poll(ROUTE_32, 3);
  assert.deepEqual(deaths, [], 'not in the battle – it was never seen out');
  // the battle ends, the party has Houndour at 0 HP; the place sign reads the next place already
  flag(0x2800);
  w(CORE, core([CHINCHOU, TAILLOW, BUIZEL, { ...HOUNDOUR, hp: 0 }]));
  poll(VIOLET, 2);
  assert.deepEqual(deaths, ['ruins-of-alph']);
  const p = d.get('pair:ruins-of-alph');
  assert.deepEqual([p.killer?.species, p.place?.name], [276, 'Route 32']);
  // "Ruins of Alph: the Pokémon died – Princess fainted against Taillow (Lv. 9, wild battle, Route 32)": the log line names
  // the area of Houndour's encounter, the cause where it fell
  const line = R.feedList(d).find((f) => f.type === 'death');
  assert.deepEqual([line.area, line.cause.key, line.cause.vars.place], ['ruins-of-alph', 'feed.faintedByAt', 'Route 32']);
  assert.match(line.text, /: the Pokémon died – .* fainted against .* \(Lv\. 9, wild battle, Route 32\)$/);
});

test('#79: a battle reading handed out again (structs held over a switch) is no second look at 0 HP', () => {
  const { w, flag, d, poll, deaths } = onRoute32();
  const foe = { pid: 0x7a110004, species: 276, level: 9, hp: 28, maxHp: 28 };
  flag(0x2100);
  battlers(w, [CHINCHOU, foe]);
  w(PLAYER_COPY, core(TEAM));
  w(WILD_COPY, core([foe]));
  poll(ROUTE_32, 6);
  // one read of battler 0 says 0 HP (the struct being rewritten) …
  battlers(w, [{ ...CHINCHOU, hp: 0 }, foe]);
  poll(ROUTE_32);
  // … then the struct can't be trusted for a moment (not one of the player's PIDs): the reader holds the last one
  battlers(w, [{ ...CHINCHOU, pid: 0x01020304 }, foe]);
  const r = poll(ROUTE_32, 2);
  assert.equal(r.fight.held, true);
  assert.deepEqual(deaths, [], 'the held reading doesn\'t confirm the first one');
  battlers(w, [{ ...CHINCHOU, hp: 21 }, foe]);
  poll(ROUTE_32, 3);
  flag(0x2800);
  poll(ROUTE_32, 2);
  assert.deepEqual(deaths, []);
  assert.notEqual(d.get('pair:starter', null)?.state, 'dead');
});

test('confirmFaints: a held reading neither starts nor confirms a faint; a fresh one after it does', () => {
  const mon = (hp) => ({ key: 'a', hp, maxHp: 20 });
  const st = {};
  const hp = (h, battle = null) => confirmFaints([mon(h)], st, battle)[0].hp;
  const held = { held: true };
  assert.equal(hp(17), 17);
  assert.equal(hp(0, held), 17, 'a held reading at 0: nothing new');
  assert.equal(hp(0, held), 17);
  assert.equal(hp(0), 17, 'the first fresh read at 0');
  assert.equal(hp(0, held), 17, 'held: still waiting');
  assert.equal(hp(0), 0, 'the second fresh read: down');
  assert.equal(hp(0, held), 0, 'and it stays down');
});

test('withBattleHp: a 0 HP of the battle\'s copy counts only for a Pokémon that has been out in this battle', () => {
  const party = [{ pid: 1, key: 'a', hp: 20, maxHp: 20 }, { pid: 2, key: 'b', hp: 30, maxHp: 30 }];
  const st = {};
  const fight = (active, hps) => ({ kind: 'wild', enemy: { species: 16 }, active: { index: active }, party: [{ pid: 1, hp: hps[0], maxHp: 20 }, { pid: 2, hp: hps[1], maxHp: 30 }] });
  assert.deepEqual(withBattleHp(party, fight(0, [12, 0]), st).map((m) => m.hp), [12, 30], 'b was never out');
  assert.deepEqual(withBattleHp(party, fight(1, [12, 25]), st).map((m) => m.hp), [12, 25], 'b is sent out');
  assert.deepEqual(withBattleHp(party, fight(0, [12, 0]), st).map((m) => m.hp), [12, 0], 'b was out in this battle: its 0 counts');
  withBattleHp(party, null, st); // the battle is over
  assert.deepEqual(withBattleHp(party, fight(0, [20, 0]), st).map((m) => m.hp), [20, 30], 'the next battle starts afresh');
  // without the reader state (tests, tools): as before
  assert.deepEqual(withBattleHp(party, fight(0, [12, 0])).map((m) => m.hp), [12, 0]);
});

// ---- clones -------------------------------------------------------------------------------------------------------
// A cloning glitch leaves the same Pokémon twice in the team (the Platinum link recordings' saves hold such clones).
// The party reader took that for a misread and showed no team at all. Now they are two Pokémon – and none of the #79
// guards above gives way: a wild Pokémon sharing a PID still never passes for one of the team.
const BUIZEL2 = { ...BUIZEL }; // the clone: every byte alike

function withClone() {
  const s = onRoute32();
  s.w(CORE, core([...TEAM, BUIZEL2]));
  s.poll(ROUTE_32, 3);
  const live = s.d.get('live:p1').party;
  assert.equal(live.length, 5, 'the team is read again – the clone counted');
  const [k1, k2] = live.filter((m) => m.species === BUIZEL.species).map((m) => m.key);
  assert.equal(k2, `${k1}~2`);
  assert.equal(s.d.get('enc:route-32:p1').key, k1, 'the Route 32 encounter stays the Buizel it was');
  return { ...s, k1, k2 };
}

test('clones (DS): the same Pokémon twice is read as two – the encounter stays, the clone is no catch of anyone\'s', () => {
  const { d } = withClone();
  // the clone isn't filed anywhere: its route is taken by the original (the inbox asks what it is)
  const filed = Object.keys(d.scan('enc:')).filter((k) => d.get(k)?.key?.endsWith('~2'));
  assert.deepEqual(filed, []);
});

test('clones (DS): the clone faints – the original lives on, also when the team is reordered afterwards', () => {
  const { w, d, poll, deaths, k2 } = withClone();
  w(CORE, core([...TEAM, { ...BUIZEL2, hp: 0 }]));
  poll(ROUTE_32, 3);
  assert.deepEqual(deaths, []);
  assert.notEqual(d.get('pair:route-32', null)?.state, 'dead');
  // the fainted clone moved in front of the original
  w(CORE, core([CHINCHOU, TAILLOW, { ...BUIZEL2, hp: 0 }, HOUNDOUR, BUIZEL]));
  poll(ROUTE_32, 4);
  assert.deepEqual(deaths, []);
  assert.notEqual(d.get('pair:route-32', null)?.state, 'dead', 'the 0 HP stays with the clone');
  const live = d.get('live:p1').party;
  assert.deepEqual(live.filter((m) => m.species === BUIZEL.species).map((m) => [m.key === k2, m.hp]), [[true, 0], [false, BUIZEL.hp]]);
});

test('clones (DS): in a battle the original goes down – its own death only; the clone that was never out keeps its HP', () => {
  const { w, flag, d, poll, deaths, k2 } = withClone();
  const foe = { pid: 0x7a110005, species: 276, level: 9, hp: 28, maxHp: 28 };
  flag(0x2100);
  battlers(w, [BUIZEL, foe]);
  w(PLAYER_COPY, core([...TEAM, BUIZEL2]));
  w(WILD_COPY, core([foe]));
  poll(ROUTE_32, 6);
  battlers(w, [{ ...BUIZEL, hp: 0 }, foe]);
  w(PLAYER_COPY, core([CHINCHOU, TAILLOW, { ...BUIZEL, hp: 0 }, HOUNDOUR, BUIZEL2]));
  poll(ROUTE_32, 2);
  assert.deepEqual(deaths, ['route-32']);
  const live = d.get('live:p1').party;
  assert.equal(live.find((m) => m.key === k2).hp, BUIZEL.hp, 'the clone isn\'t hit');
  flag(0x2800);
  w(CORE, core([CHINCHOU, TAILLOW, { ...BUIZEL, hp: 0 }, HOUNDOUR, BUIZEL2]));
  poll(ROUTE_32, 3);
  assert.deepEqual(deaths, ['route-32']);
});

test('clones (DS): a wild Pokémon with the clones\' PID is knocked out – neither of them dies (#79 holds)', () => {
  const { w, flag, d, poll, deaths, k1, k2 } = withClone();
  const foe = { pid: BUIZEL.pid, species: 276, level: 9, hp: 28, maxHp: 28 };
  flag(0x2100);
  battlers(w, [CHINCHOU, foe]);
  w(PLAYER_COPY, core([...TEAM, BUIZEL2]));
  w(WILD_COPY, core([foe]));
  poll(ROUTE_32, 6);
  battlers(w, [CHINCHOU, { ...foe, hp: 0 }]);
  w(WILD_COPY, core([{ ...foe, hp: 0 }]));
  const r = poll(ROUTE_32, 6);
  assert.equal(r.fight.enemy.hp, 0);
  assert.deepEqual([k1, k2].map((k) => r.party.find((m) => m.key === k).hp), [BUIZEL.hp, BUIZEL.hp]);
  flag(0x2800);
  poll(ROUTE_32, 4);
  assert.deepEqual(deaths, []);
  assert.notEqual(d.get('pair:route-32', null)?.state, 'dead');
});

test('clones: the battle\'s copy goes to the team by PID, the n-th clone with the n-th – a faint lands on the one it hit', () => {
  const party = [{ key: 'a', pid: 1, hp: 30, maxHp: 30 }, { key: 'b', pid: 2, hp: 20, maxHp: 20 }, { key: 'a~2', pid: 1, hp: 30, maxHp: 30 }];
  const battle = { active: { index: 2, hp: 0, maxHp: 30 }, party: [{ pid: 1, hp: 30, maxHp: 30 }, { pid: 2, hp: 20, maxHp: 20 }, { pid: 1, hp: 0, maxHp: 30 }] };
  assert.deepEqual(battleTwins(party, battle.party).map((b) => b.hp), [30, 20, 0]);
  assert.deepEqual(withBattleHp(party, battle, {}).map((m) => [m.key, m.hp]), [['a', 30], ['b', 20], ['a~2', 0]]);
  // (a bench clone at 0 HP in the copy, the other one out: kept – #79)
  const bench = { active: { index: 0, hp: 30, maxHp: 30 }, party: battle.party };
  assert.deepEqual(withBattleHp(party, bench, {}).map((m) => m.hp), [30, 20, 30]);
});

test('clones: a trade of one moves one – the log names it, the other stays', () => {
  const d = mkDoc();
  const pair = { ...RUN, id: 'tr1', mode: 'soullink', players: { p1: { name: 'Ash' }, p2: { name: 'Tim' } } };
  const before = [{ key: 'k', species: 418 }, { key: 'k~2', species: 418 }, { key: 'c', species: 170 }];
  const after = [{ key: 'k', species: 418 }, { key: 'c', species: 170 }, { key: 'x', species: 25 }];
  assert.equal(R.logLinkTrade(d, pair, 'p1', 'p2', before, after), true);
  const f = R.feedList(d).find((x) => x.type === 'trade');
  assert.deepEqual([f.gave, f.got], [[418], [25]]);
  // after a reload the remaining one may be read under the plain key: still one gone, not two
  const d2 = mkDoc();
  R.logLinkTrade(d2, pair, 'p1', 'p2', before, [{ key: 'k', species: 418 }, { key: 'c', species: 170 }, { key: 'x', species: 25 }]);
  assert.deepEqual(R.feedList(d2).find((x) => x.type === 'trade').gave, [418]);
});
