// Shared World, souldew 3.0's additions (docs/MULTIPLAYER.md › 9): the Pokémon following each player (trail, party
// icons from the ROM, the wire field), emotes and their limits, rock-paper-scissors with commit–reveal, partners on a
// connected map, and that the messages stay readable for 3.0 builds from before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '/vendor/htm-preact.mjs') return next(ROOT + 'node_modules/htm/preact/standalone.module.js', ctx);
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const W = await import('../shared/world.mjs');
const I = await import('../shared/worldicons.mjs');
const R = await import('../shared/rps.mjs');
const { findEntry } = await import('../shared/live/parse.mjs');
const addresses = JSON.parse(readFileSync(new URL('../shared/data/addresses.json', import.meta.url), 'utf8'));
const dexMap = JSON.parse(readFileSync(new URL('../shared/data/gen3_index_to_dex.json', import.meta.url), 'utf8')).map;
const T = W.TILE;

// ---- the follower's trail -------------------------------------------------------------------------------------------
test('follower: first seen one tile behind the leader’s back, then it walks the leader’s path – round corners too', () => {
  const f = new W.Follower();
  let r = f.update(1, 10 * T, 5 * T, W.DIR.E); // facing east: it stands west of them
  assert.deepEqual([r.x, r.y, r.moving, r.hidden], [9 * T, 5 * T, false, false]);
  assert.equal(r.flip, true, 'facing east: the icon looks right');
  // three tiles east, pixel by pixel: always exactly one tile behind
  for (let x = 10 * T + 1; x <= 13 * T; x++) {
    r = f.update(1, x, 5 * T, W.DIR.E);
    assert.equal(r.x, x - T);
    assert.equal(r.y, 5 * T);
  }
  // then south: the follower first finishes the way to the corner, never cuts it
  const seen = [];
  for (let y = 5 * T + 1; y <= 7 * T; y++) seen.push(f.update(1, 13 * T, y, W.DIR.S));
  assert.deepEqual([seen[7].x, seen[7].y], [12 * T + 8, 5 * T], 'half a tile into the leader’s turn it is half way to the corner');
  assert.deepEqual([seen[15].x, seen[15].y], [13 * T, 5 * T], 'on the corner tile when the leader is one below it');
  assert.deepEqual([seen.at(-1).x, seen.at(-1).y], [13 * T, 6 * T]);
  // it never stands more than a tile from the leader along the path, and the trail stays short
  assert.ok(f.trail.length <= 40);
});

test('follower: faces where it walks, two frames by the distance, still when the leader stops', () => {
  const f = new W.Follower();
  f.update(1, 5 * T, 5 * T, W.DIR.W);
  const frames = [];
  let r;
  for (let x = 5 * T - 1; x >= 3 * T; x--) {
    r = f.update(1, x, 5 * T, W.DIR.W);
    frames.push(r.frame);
  }
  assert.equal(r.flip, false, 'walking west: the icon looks left (as drawn)');
  assert.ok(frames.includes(0) && frames.includes(1), 'both frames while walking');
  // a new frame every 8 pixels
  assert.equal(frames.slice(0, 7).every((x) => x === frames[0]) && frames[7] !== frames[0], true);
  const still = f.update(1, 3 * T, 5 * T, W.DIR.W);
  assert.equal(still.moving, false);
  assert.equal(f.update(1, 3 * T, 5 * T, W.DIR.N).frame, still.frame, 'turning on the spot moves nothing');
});

test('follower: a warp, Fly or another map puts it onto the leader (hidden) – it steps out of the door after them', () => {
  const f = new W.Follower();
  f.update(1, 5 * T, 5 * T, W.DIR.S);
  for (let y = 5 * T + 1; y <= 6 * T; y++) f.update(1, 5 * T, y, W.DIR.S);
  // the door: map 2, the leader at (3, 9)
  let r = f.update(2, 3 * T, 9 * T, W.DIR.N);
  assert.deepEqual([r.x, r.y, r.hidden], [3 * T, 9 * T, true]);
  for (let y = 9 * T - 1; y >= 8 * T; y--) r = f.update(2, 3 * T, y, W.DIR.N);
  assert.deepEqual([r.x, r.y, r.hidden], [3 * T, 9 * T, false], 'one step later it stands on the door mat');
  // a jump of more than three tiles on the same map (Fly to the same town, a warp tile) is the same
  r = f.update(2, 20 * T, 9 * T, W.DIR.S);
  assert.equal(r.hidden, true);
  // surfing, diving and hidden players have no follower
  assert.equal(W.followerHidden({ kind: 'surf' }), true);
  assert.equal(W.followerHidden({ kind: 'dive' }), true);
  assert.equal(W.followerHidden({ hidden: true }), true);
  assert.equal(W.followerHidden({ kind: 'mach' }), false);
});

// ---- the party icons from the ROM --------------------------------------------------------------------------------
/** A synthetic 1 MB ROM with the three icon tables (pokemon_icon.c's layout) and one icon drawn into it. */
function iconRom() {
  const rom = new Uint8Array(0x100000);
  const put32 = (o, v) => { rom[o] = v & 255; rom[o + 1] = (v >> 8) & 255; rom[o + 2] = (v >> 16) & 255; rom[o + 3] = (v >>> 24) & 255; };
  const put16 = (o, v) => { rom[o] = v & 255; rom[o + 1] = (v >> 8) & 255; };
  const pals = 0x20000;
  const indices = pals - 440;
  const table = indices - 440 * 4;
  const img = 0x1000;
  const img2 = 0x2000; // Treecko's (internal 277)
  for (let i = 0; i < 440; i++) {
    put32(table + i * 4, 0x08000000 + (i === 277 ? img2 : img));
    rom[indices + i] = i === 277 ? 4 : 1;
  }
  for (let i = 0; i < 6; i++) {
    put32(pals + i * 8, 0x08000000 + 0x21000 + i * 32);
    put16(pals + i * 8 + 4, 0xdac0 + i);
    put16(0x21000 + i * 32 + 3 * 2, i === 1 ? 0x001f : 0x7c00); // colour 3: red in palette 1, blue in 4
  }
  // a 4×8 block of colour 3 at x 10–13, y 20–27 in frame 0, one row lower in frame 1
  const px = (base, x, y, ci) => {
    const t = (y >> 3) * 4 + (x >> 3);
    const o = base + t * 32 + (y & 7) * 4 + ((x & 7) >> 1);
    rom[o] = x & 1 ? (rom[o] & 0x0f) | (ci << 4) : (rom[o] & 0xf0) | ci;
  };
  for (let y = 20; y < 28; y++) for (let x = 10; x < 14; x++) (px(img, x, y, 3), px(img + 512, x, y + 1, 3), px(img2, x, y, 3));
  return { rom, table: 0x08000000 + table, indices: 0x08000000 + indices, pals: 0x08000000 + pals };
}

test('icons: the tables found by the palette tags, a frame decoded with its palette, its box of pixels', () => {
  const r = iconRom();
  const icons = I.findMonIcons(r.rom);
  assert.deepEqual(icons, { table: r.table, indices: r.indices, palettes: r.pals });
  assert.deepEqual(I.findMonIcons(r.rom, r.pals), icons, 'a hint that is right');
  const ic = I.monIcon(r.rom, icons, 25);
  assert.equal(ic.frames.length, 2);
  const at = (f, x, y) => [...ic.frames[f].subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)];
  assert.deepEqual(at(0, 10, 20), [255, 0, 0, 255]);
  assert.deepEqual(at(0, 9, 20), [0, 0, 0, 0], 'colour 0 is see-through');
  assert.deepEqual(at(1, 10, 20), [0, 0, 0, 0]);
  assert.deepEqual(at(1, 10, 21), [255, 0, 0, 255], 'the second frame is the one a row lower');
  assert.deepEqual([ic.top, ic.bottom, ic.left, ic.right], [20, 28, 10, 13], 'over both frames');
  // another palette per species
  const tr = I.monIcon(r.rom, icons, 277);
  assert.deepEqual([...tr.frames[0].subarray((20 * 32 + 10) * 4, (20 * 32 + 10) * 4 + 4)], [0, 0, 255, 255]);
  // out of range, broken tables, a hack without them
  assert.equal(I.monIcon(r.rom, icons, 0), null);
  assert.equal(I.monIcon(r.rom, icons, 440), null);
  const broken = iconRom();
  broken.rom[broken.indices - 0x08000000 + 3] = 9;
  assert.equal(I.findMonIcons(broken.rom), null, 'a palette index above 5: not the table');
  assert.equal(I.findMonIcons(new Uint8Array(0x100000)), null);
});

test('icons: National Dex → internal index (Hoenn), Unown letters, the lead of a party', () => {
  const toI = I.dexToInternal(dexMap);
  assert.equal(I.iconIndex(toI, 25), 25, 'Kanto/Johto: the same number');
  assert.equal(I.iconIndex(toI, 252), 277, 'Treecko is 277 inside the game');
  assert.equal(I.iconIndex(toI, 386), 410, 'Deoxys');
  assert.equal(I.iconIndex(toI, 201, 0), 201, 'Unown A');
  assert.equal(I.iconIndex(toI, 201, 3), 413 + 2, 'Unown D: its own icon');
  assert.equal(I.iconIndex(toI, 387), 0, 'later generations: none');
  assert.equal(I.unownLetter(0), 0);
  assert.equal(I.unownLetter(0x00000003), 3);
  assert.equal(I.unownLetter(0x03030303), 255 % 28);
  const party = [{ species: 1, isEgg: true, hp: 0 }, { species: 4, hp: 0 }, { species: 201, hp: 20, pid: 3, shiny: true }, { species: 7, hp: 5 }];
  assert.deepEqual(I.leadOf(party), { species: 201, shiny: true, form: 3 }, 'not the egg, not the fainted one');
  assert.equal(I.leadOf([{ species: 25, isEgg: true }]), null);
  assert.equal(I.leadOf(null), null);
});

test('icons: the real ROM layouts (when the ROMs are in SOULDEW_TEST_ROMS)', { skip: !process.env.SOULDEW_TEST_ROMS }, () => {
  const dir = process.env.SOULDEW_TEST_ROMS;
  for (const f of ['emerald.gba', 'fr-us.gba', 'lg-de.gba', 'fr-de.gba', 'ruby-us.gba', 'sapphire.gba']) {
    let rom;
    try {
      rom = new Uint8Array(readFileSync(`${dir}/${f}`));
    } catch {
      continue;
    }
    const icons = I.findMonIcons(rom);
    assert.ok(icons, f);
    const pika = I.monIcon(rom, icons, 25);
    assert.ok(pika && pika.bottom > 20 && pika.top > 4, f);
  }
});

// ---- the wire -----------------------------------------------------------------------------------------------------
// The unpack of 3.0 builds before the followers (web/lib/sharedworld.mjs, Nov 2026) – what an older partner runs.
function unpackStateV30(a) {
  if (!Array.isArray(a) || a.length < 8 || a[0] !== 1 || !a.slice(1, 8).every(Number.isFinite)) return null;
  const [, seq, t, fam, map, x, y, flags] = a;
  if (Math.abs(x) > 0x8000 || Math.abs(y) > 0x8000 || map < 0 || map > 0xffff) return null;
  if (flags & (1 << 9)) return { seq, t, fam, hidden: true };
  const facing = flags & 7;
  return { seq, t, fam, map, x, y, facing: facing >= 1 && facing <= 4 ? facing : 1, kind: W.KINDS[(flags >> 3) & 15] || 'walk', gender: (flags >> 7) & 1, run: !!(flags & (1 << 8)), elev: (flags >> 10) & 15, hidden: false };
}

test('the wire: the follower and the map size ride along as an optional 9th field – older 3.0 builds read the rest', () => {
  const st = { fam: 2, map: 0x0103, x: 160, y: 112, facing: 4, kind: 'walk', gender: 1, run: true, elev: 3 };
  const ext = W.packExt({ follower: { species: 201, shiny: true, form: 3 }, size: [20, 30] });
  const withExt = W.packState(st, 7, 1000, ext);
  assert.equal(withExt.length, 9);
  assert.ok(JSON.stringify(withExt).length < 70);
  const plain = W.packState(st, 7, 1000);
  assert.equal(plain.length, 8, 'nothing new to say: the message as before');
  // an older partner reads the new message exactly like the old one
  assert.deepEqual(unpackStateV30(withExt), unpackStateV30(plain));
  assert.equal(unpackStateV30(withExt).x, 160);
  // and this build reads both
  const u = W.unpackState(withExt);
  assert.deepEqual(u.ext, { follower: { species: 201, shiny: true, form: 3 }, size: [20, 30] });
  assert.equal(W.unpackState(plain).ext, undefined, 'an older partner’s message: no follower known');
  const rest = { ...u };
  delete rest.ext;
  assert.deepEqual(rest, W.unpackState(plain));
  // "nobody follows" is said as 0; a hidden player can carry it too
  assert.deepEqual(W.unpackState(W.packState(null, 1, 0, W.packExt({ follower: null }))).ext, { follower: null });
  // malformed parts are dropped, the state still counts
  for (const bad of [{ f: ['x', 0] }, { f: [25, 999] }, { f: [0, 0] }, { z: [0, 5] }, { z: 'big' }, [1, 2], 'x', null]) {
    const m = W.unpackState([...plain, bad]);
    assert.ok(m && m.x === 160, JSON.stringify(bad));
    assert.ok(!m.ext || (!m.ext.size && !m.ext.follower), JSON.stringify(bad));
  }
});

test('SharedWorld: the follower goes out when it changes and with the heartbeat, not with every step', async () => {
  globalThis.addEventListener ??= () => {};
  globalThis.removeEventListener ??= () => {};
  globalThis.dispatchEvent ??= () => true;
  globalThis.CustomEvent ??= class { constructor(type, o) { this.type = type; this.detail = o?.detail; } };
  const { SharedWorld } = await import('../web/lib/sharedworld.mjs');
  const sent = [];
  const sync = { others: ['p2'], status: { partners: { p2: {} } }, onWorld: () => () => {}, sendWorld: (m, o = {}) => (sent.push({ m, relay: !!o.relay }), new Set(['p2'])) };
  let now = 0;
  const w = new SharedWorld({ sync, me: 'p1', frame: () => null, now: () => now, lead: { species: 25, shiny: false, form: 0 } });
  clearInterval(w.timer);
  const st = { fam: 2, map: 1, x: 0, y: 0, facing: 1, kind: 'walk', gender: 0, run: false };
  w.size = [20, 20];
  w._send(st);
  assert.deepEqual(sent.at(-1).m.w[8], { f: [25, 0], z: [20, 20] }, 'the first message says it');
  for (let i = 1; i <= 10; i++) {
    now = i * 70;
    w._send({ ...st, x: i });
  }
  const walking = sent.slice(1).filter((s) => !s.relay);
  assert.ok(walking.length >= 9);
  assert.ok(walking.filter((s) => s.m.w.length > 8).length <= 1, 'walking: at most the once-a-second refresh');
  w.lead = { species: 6, shiny: true, form: 0 };
  now += 70;
  w._send({ ...st, x: 50 });
  assert.deepEqual(sent.at(-1).m.w[8].f, [6, 1], 'a new lead: right away');
  w.stop();
});

// ---- emotes and their limits -------------------------------------------------------------------------------------
test('rate limits: a burst, then one every few seconds – on the sender and on every receiver', async () => {
  const l = new W.RateLimit({ burst: 3, everyMs: 1000 });
  assert.deepEqual([l.take(0), l.take(0), l.take(0), l.take(0)], [true, true, true, false]);
  assert.equal(l.take(500), false);
  assert.equal(l.take(1000), true);
  assert.equal(l.take(1100), false);
  assert.equal(l.take(60000), true, 'it fills up again …');
  assert.deepEqual([l.take(60000), l.take(60000), l.take(60000)], [true, true, false], '… to the burst, not more');

  const { SharedWorld } = await import('../web/lib/sharedworld.mjs');
  const sent = [];
  let worldIn = null;
  const sync = { others: ['p2'], status: { partners: { p2: {} } }, onWorld: (f) => ((worldIn = f), () => {}), sendWorld: (m, o = {}) => (sent.push({ m, relay: !!o.relay }), new Set(['p2'])) };
  let now = 0;
  const shown = [];
  const fake = { config: () => true, partner() {}, gone() {}, emote: (s, e) => shown.push([s, e]) };
  const w = new SharedWorld({ sync, me: 'p1', frame: () => ({ contentWindow: { __world: fake } }), now: () => now });
  clearInterval(w.timer);
  // mine: four quick ones, then the limit
  const mine = ['wave', 'heart', 'gg', 'excl', 'quest'].map((e) => w.emote(e));
  assert.deepEqual(mine, [true, true, true, true, false]);
  assert.deepEqual(sent.map((s) => s.m), [{ t: 'wave' }, { t: 'emote', e: 'heart' }, { t: 'emote', e: 'gg' }, { t: 'emote', e: 'excl' }], 'wave stays the old message');
  assert.equal(w.emote('dance'), false, 'only the known ones');
  now += EMOTE_EVERY();
  assert.equal(w.emote('quest'), true);
  // theirs: a flood shows a handful
  shown.length = 0;
  for (let i = 0; i < 40; i++) worldIn({ from: 'p2', t: i % 2 ? 'wave' : 'emote', e: 'heart' });
  assert.equal(shown.length, W.EMOTE_LIMIT.burst + 1);
  worldIn({ from: 'p2', t: 'emote', e: '<img src=x>' });
  assert.equal(shown.length, W.EMOTE_LIMIT.burst + 1, 'unknown emotes are dropped');
  w.stop();
});
const EMOTE_EVERY = () => W.EMOTE_LIMIT.everyMs;

// ---- rock-paper-scissors ----------------------------------------------------------------------------------------
/** Hubs for p1–p3 on one fake channel (messages go to everyone, in order); `tamper(m)` may change what's sent. */
function table({ tamper = (m) => m, slots = ['p1', 'p2', 'p3'] } = {}) {
  let t = 1000;
  const q = [];
  const hubs = {};
  const events = [];
  for (const me of slots) {
    hubs[me] = new R.RpsHub({ me, now: () => t, send: (m) => q.push(tamper({ ...m, from: me })) });
    hubs[me].on((e) => e.type !== 'change' && events.push({ me, type: e.type, end: e.game.end, result: e.round?.result }));
  }
  const flush = async (drop = () => false) => {
    while (q.length) {
      const m = q.shift();
      if (drop(m)) continue;
      for (const s of slots) if (s !== m.from) await hubs[s].receive(m);
    }
  };
  const tick = async (ms) => {
    t += ms;
    for (const s of slots) hubs[s].tick();
    await flush();
  };
  return { hubs, flush, tick, events, q };
}

test('rps: best of 1 – both pick, both see the same hands and the same winner; a spectator sees them too', async () => {
  const { hubs, flush, events } = table();
  const g = hubs.p1.challenge('p2');
  await flush();
  assert.equal(hubs.p2.list()[0].phase, 'pick', 'asked');
  assert.equal(hubs.p3.list().length, 0, 'p3 isn’t asked …');
  await hubs.p1.pick(g.id, 0); // rock
  await flush();
  // p2 has only a hash of p1’s hand: nothing in it says rock
  const r2 = hubs.p2.games.get(g.id).rounds[0];
  assert.match(r2.commits.p1, /^[0-9a-f]{64}$/);
  assert.equal(r2.reveals.p1, undefined, 'no hand before p2 picked');
  await hubs.p2.pick(g.id, 2); // scissors
  await flush();
  for (const s of ['p1', 'p2']) assert.deepEqual(hubs[s].games.get(g.id).end && hubs[s].games.get(g.id).end.winner, 'p1');
  const rounds = events.filter((e) => e.type === 'round');
  assert.deepEqual(rounds.map((e) => e.me).sort(), ['p1', 'p2', 'p3'], '… but sees the hands over their heads');
  assert.ok(rounds.every((e) => e.result.hands.p1 === 0 && e.result.hands.p2 === 2 && e.result.winner === 'p1'));
  const v = hubs.p2.list()[0];
  assert.deepEqual([v.phase, v.last.mine, v.last.theirs, v.end.why], ['end', 2, 0, 'won']);
  assert.equal(R.rpsLine(v, 'p2', {}, 'Sam'), 'Sam wins');
});

test('rps: a draw is played again; best of 3 goes to two wins', async () => {
  const { hubs, flush, tick } = table();
  const g = hubs.p1.challenge('p2', 3);
  await flush();
  const play = async (a, b) => {
    await hubs.p1.pick(g.id, a);
    await hubs.p2.pick(g.id, b);
    await flush();
    await tick(R.RPS.showMs + 10);
  };
  await play(1, 1); // draw
  assert.equal(hubs.p1.games.get(g.id).rounds.length, 2);
  await play(1, 0); // p1
  await play(2, 0); // p2
  assert.equal(hubs.p1.games.get(g.id).end, null);
  await play(0, 2); // p1
  const end = hubs.p2.games.get(g.id).end;
  assert.deepEqual([end.winner, end.why], ['p1', 'won']);
  assert.deepEqual(hubs.p1.list()[0].wins, { me: 2, them: 1 });
});

test('rps: a cheating peer that reveals another hand than it committed to is refused – nobody wins', async () => {
  // p2's client commits to rock, then (having seen p1's paper) "reveals" scissors with the same nonce
  const { hubs, flush, events } = table({
    tamper: (m) => (m.from === 'p2' && m.op === 'v' ? { ...m, hand: 2 } : m),
  });
  const g = hubs.p1.challenge('p2');
  await flush();
  await hubs.p1.pick(g.id, 1);
  await hubs.p2.pick(g.id, 0);
  await flush();
  const end = hubs.p1.games.get(g.id).end;
  assert.deepEqual([end.winner, end.why, end.by], [null, 'mismatch', 'p2']);
  assert.equal(hubs.p3.games.get(g.id).end.why, 'mismatch', 'the spectator refuses it too');
  assert.equal(events.filter((e) => e.type === 'round' && e.me !== 'p2').length, 0, 'no hands shown as a result (but on the cheater’s own screen)');
});

test('rps: copying the other’s commitment doesn’t work, reveals before both committed are kept back, junk is dropped', async () => {
  // p2 copies p1's hash as its own commitment, then copies p1's reveal: bound to p1, so refused
  let p1Commit = null;
  let p1Reveal = null;
  const { hubs, flush, q } = table({
    tamper: (m) => {
      if (m.from === 'p1' && m.op === 'c') p1Commit = m.h;
      if (m.from === 'p1' && m.op === 'v') p1Reveal = m;
      return m;
    },
  });
  const g = hubs.p1.challenge('p2');
  await flush();
  await hubs.p1.pick(g.id, 0);
  await flush();
  q.push({ t: 'rps', op: 'c', id: g.id, r: 1, h: p1Commit, from: 'p2' });
  await flush();
  q.push({ ...p1Reveal, from: 'p2' });
  await flush();
  assert.equal(hubs.p1.games.get(g.id).end.why, 'mismatch');

  // an early reveal (before I committed) never shows: my picker doesn't know their hand
  const t2 = table();
  const g2 = t2.hubs.p1.challenge('p2');
  await t2.flush();
  const nonce = 'n0nce';
  const h = await R.rpsHash(g2.id, 1, 'p2', 1, nonce);
  await t2.hubs.p1.receive({ t: 'rps', op: 'c', id: g2.id, r: 1, h, from: 'p2' });
  await t2.hubs.p1.receive({ t: 'rps', op: 'v', id: g2.id, r: 1, hand: 1, n: nonce, from: 'p2' });
  const v = t2.hubs.p1.list()[0];
  assert.deepEqual([v.phase, v.last], ['pick', null]);
  await t2.hubs.p1.pick(g2.id, 2);
  assert.equal(t2.hubs.p1.games.get(g2.id).end.winner, 'p1', 'after my pick it counts');
  // junk
  for (const m of [{ t: 'rps', op: 'c', id: g2.id, r: 1, h: 'zz', from: 'p2' }, { t: 'rps', op: 'ask', id: '!', to: 'p1', from: 'p2' }, { t: 'rps', op: 'v', id: g2.id, r: 99, hand: 7, from: 'p2' }, null, { t: 'rps', from: 'p1', op: 'x', id: g2.id }]) {
    await t2.hubs.p1.receive(m);
  }
  assert.equal(t2.hubs.p1.games.get(g2.id).end.winner, 'p1');
});

test('rps: time limits – no answer, no hand shown after both picked (a loss), passing, giving up later', async () => {
  // no answer within the 10 s: nothing happened
  let T1 = table();
  let g = T1.hubs.p1.challenge('p2');
  await T1.flush();
  await T1.hubs.p1.pick(g.id, 0);
  await T1.flush();
  await T1.tick(R.RPS.pickMs + 1);
  assert.deepEqual([T1.hubs.p1.games.get(g.id).end.why, T1.hubs.p2.games.get(g.id).end.why], ['noAnswer', 'expired']);
  assert.equal(T1.hubs.p1.games.get(g.id).end.winner, null);
  // p2 sees p1's hand and doesn't show its own: p2 loses
  T1 = table();
  g = T1.hubs.p1.challenge('p2');
  await T1.flush();
  await T1.hubs.p1.pick(g.id, 0);
  await T1.hubs.p2.pick(g.id, 1);
  await T1.flush((m) => m.from === 'p2' && m.op === 'v');
  await T1.tick(R.RPS.revealMs + 1);
  assert.deepEqual([T1.hubs.p1.games.get(g.id).end.winner, T1.hubs.p1.games.get(g.id).end.why], ['p1', 'noReveal']);
  // "not now" before anything: nobody wins
  T1 = table();
  g = T1.hubs.p1.challenge('p2');
  await T1.flush();
  T1.hubs.p2.pass(g.id);
  await T1.flush();
  assert.deepEqual([T1.hubs.p1.games.get(g.id).end.why, T1.hubs.p1.games.get(g.id).end.winner], ['passed', null]);
  // giving up in round two of a best of 3 is a loss
  T1 = table();
  g = T1.hubs.p1.challenge('p2', 3);
  await T1.flush();
  await T1.hubs.p1.pick(g.id, 0);
  await T1.hubs.p2.pick(g.id, 2);
  await T1.flush();
  await T1.tick(R.RPS.showMs + 1);
  T1.hubs.p2.pass(g.id);
  await T1.flush();
  assert.deepEqual([T1.hubs.p1.games.get(g.id).end.winner, T1.hubs.p1.games.get(g.id).end.why], ['p1', 'gaveUp']);
  // finished games are forgotten after a few seconds
  await T1.tick(R.RPS.keepMs + 1);
  assert.equal(T1.hubs.p1.games.size, 0);
});

test('rps: one game per pair, asking too often is limited on both ends', async () => {
  const { hubs, flush, q } = table();
  const g = hubs.p1.challenge('p2');
  assert.deepEqual(hubs.p1.challenge('p2'), { error: 'busy' });
  assert.deepEqual(hubs.p1.challenge('p1'), { error: 'self' });
  await flush();
  // p2 is asked by p3 meanwhile: p3 hears "busy" only if p2 is playing p3 already – a second partner is fine
  const g3 = hubs.p3.challenge('p2');
  await flush();
  assert.equal(hubs.p2.list().length, 2);
  hubs.p2.pass(g.id);
  hubs.p2.pass(g3.id);
  await flush();
  // the sender's limit: three asks, then one every 20 s ('busy' costs nothing)
  const second = hubs.p1.challenge('p3');
  assert.ok(second.id);
  assert.deepEqual(hubs.p1.challenge('p3'), { error: 'busy' });
  const third = hubs.p1.challenge('p2');
  assert.ok(third.id);
  hubs.p1.pass(second.id);
  hubs.p1.pass(third.id);
  await flush();
  assert.deepEqual(hubs.p1.challenge('p2'), { error: 'limit' });
  // a flooding client (no limit of its own): the receiver ignores the asks past its limit
  let n = 0;
  for (let i = 0; i < 20; i++) q.push({ t: 'rps', op: 'ask', id: `flood${i}xx`, to: 'p3', bo: 1, from: 'p2' });
  await flush();
  n = hubs.p3.list().filter((x) => x.other === 'p2' && !x.end).length;
  assert.ok(q.length === 0 && hubs.p3.askIn.get('p2').tokens < 1, 'the limit is spent');
  assert.ok(n <= 1, `one game at a time, the rest ignored: ${n}`);
});

// ---- partners next door ------------------------------------------------------------------------------------------
test('connected maps: your map’s size and connections from gMapHeader and the ROM; partners placed across the edge', () => {
  const t = W.worldTable(findEntry(addresses, { platform: 'gba', code: 'BPEE' }), 0);
  const rom = new Uint8Array(0x10000);
  const put32 = (o, v) => { rom[o] = v & 255; rom[o + 1] = (v >> 8) & 255; rom[o + 2] = (v >> 16) & 255; rom[o + 3] = (v >>> 24) & 255; };
  put32(0x100, 20); // layout: 20 × 30
  put32(0x104, 30);
  put32(0x200, 3); // connections: 3
  put32(0x204, 0x08000300);
  const conn = (i, dir, offset, group, num) => { rom[0x300 + i * 12] = dir; put32(0x300 + i * 12 + 4, offset); rom[0x300 + i * 12 + 8] = group; rom[0x300 + i * 12 + 9] = num; };
  conn(0, W.CONN.S, -2, 0, 9);
  conn(1, W.CONN.N, 5, 0, 10);
  conn(2, 5, 0, 0, 11); // dive: never side by side
  const hdr = new Uint8Array(16);
  hdr.set([0x00, 0x01, 0x00, 0x08], 0);
  hdr.set([0x00, 0x02, 0x00, 0x08], 12);
  const read = (a, n) => (a === t.mapHeader && n === 16 ? hdr : null);
  const c = W.readConnections(t, read, rom, 0x0003, new Map());
  assert.deepEqual(c, { map: 3, w: 20, h: 30, list: [{ dir: 1, offset: -2, map: 9 }, { dir: 2, offset: 5, map: 10 }] });
  // the same map; south: below your bottom row, shifted by the offset; north: needs their height
  assert.deepEqual(W.inLocalFrame(c, { map: 3, x: 16, y: 32 }), { x: 16, y: 32 });
  assert.deepEqual(W.inLocalFrame(c, { map: 9, x: 4 * T, y: 0 }), { x: 2 * T, y: 30 * T });
  assert.equal(W.inLocalFrame(c, { map: 10, x: 0, y: 0 }), null, 'north without their size (an older partner)');
  assert.deepEqual(W.inLocalFrame(c, { map: 10, x: 0, y: 9 * T }, [40, 10]), { x: 5 * T, y: -T });
  assert.equal(W.inLocalFrame(c, { map: 11, x: 0, y: 0 }), null);
  const e = { ...c, list: [{ dir: W.CONN.E, offset: 1, map: 12 }, { dir: W.CONN.W, offset: -1, map: 13 }] };
  assert.deepEqual(W.inLocalFrame(e, { map: 12, x: 0, y: 0 }), { x: 20 * T, y: T });
  assert.deepEqual(W.inLocalFrame(e, { map: 13, x: 7 * T, y: T }, [8, 8]), { x: -T, y: 0 });
});

test('connected maps: a partner walking across the edge slides on in your frame instead of stopping', () => {
  const tr = new W.Track();
  const conns = { map: 3, w: 20, h: 30, list: [{ dir: W.CONN.S, offset: 0, map: 9 }] };
  const conv = (st) => W.inLocalFrame(conns, st);
  const base = { fam: 2, facing: W.DIR.S, kind: 'walk', gender: 0, run: false, elev: 0, hidden: false };
  // down your last row, on to their map's first row
  tr.push({ ...base, seq: 1, t: 0, map: 3, x: 5 * T, y: 29 * T }, 0);
  tr.push({ ...base, seq: 2, t: 66, map: 3, x: 5 * T, y: 29 * T + 8 }, 66);
  tr.push({ ...base, seq: 3, t: 132, map: 9, x: 5 * T, y: 0 }, 132);
  tr.push({ ...base, seq: 4, t: 198, map: 9, x: 5 * T, y: 8 }, 198);
  const at = (ms) => tr.sample(ms + tr.delay, conv);
  const mid = at(99);
  assert.equal(mid.local, true);
  assert.equal(mid.moving, true);
  assert.ok(mid.y > 29 * T + 8 && mid.y < 30 * T, `between the two maps: ${mid.y}`);
  assert.equal(at(165).y, 30 * T + 4);
  // without the frame (an unknown connection) it holds at the edge as before
  assert.equal(tr.sample(99 + tr.delay).moving, false);
  // screenPos takes the local position
  const t = W.worldTable(findEntry(addresses, { platform: 'gba', code: 'BPEE' }), 0);
  const cam = { map: 3, cx: 5 * T, cy: 28 * T };
  assert.deepEqual(W.screenPos(t, cam, at(165)), { x: t.anchor.x, y: t.anchor.y + 2 * T + 4 });
  assert.equal(W.screenPos(t, cam, { ...at(165), local: false, away: true }), null);
});

test('world tables: ROM addresses per language where one entry covers several (FireRed DE/FR/IT/ES)', () => {
  const entry = { gen: 3, id: 'x', world: { family: 'frlg', objectEvents: '0x02036E38', playerAvatar: '0x02037078', fieldCamera: '0x03004FA0', main: '0x03003040', paletteFade: '0x02037AB8', lockFieldControls: '0x03000F9C', rom: { 'BPRD:0': { overworldCb2: '0x08001001', graphicsInfo: '0x08100000', spritePalettes: '0x08200000' } }, avatars: [['walk', 0, 7]] } };
  assert.equal(W.worldTable(entry, 0, 'BPRD').overworldCb2, 0x08001001);
  const fr = W.worldTable(entry, 0, 'BPRF');
  assert.deepEqual([fr.overworldCb2, fr.graphicsInfo], [0, 0], 'French: learned and searched');
  assert.equal(fr.main, 0x03003040, 'the RAM is the same');
});

test('FR/LG: the replay of your last steps after loading ("Previously on your quest…") isn’t the overworld', () => {
  const t = W.worldTable(findEntry(addresses, { platform: 'gba', code: 'BPGD' }), 0, 'BPGD');
  const mem = new Map();
  const put = (a, bytes) => bytes.forEach((b, i) => mem.set(a + i, b));
  const read = (a, n) => {
    const o = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!mem.has(a + i)) return null;
      o[i] = mem.get(a + i);
    }
    return o;
  };
  const u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  put(t.saveBlock1Ptr, u32(0x02025000));
  put(0x02025000, [14, 0, 14, 0, 3, 0, 0, 0]);
  put(t.fieldCamera + 0x10, [...u32(0), ...u32(0)]);
  put(t.main + 4, u32(t.overworldCb2));
  put(t.main + 0x2c, [0, 0]);
  put(t.paletteFade + 4, [0, 0, 0, 0]);
  put(t.lock, [0]);
  put(t.help, [0]);
  put(t.questLog, [1]); // recording: that's normal play
  assert.equal(W.drawable(t, W.readCamera(t, read)), true);
  put(t.questLog, [2]);
  assert.equal(W.readCamera(t, read).replay, true);
  assert.equal(W.drawable(t, W.readCamera(t, read)), false);
  assert.ok(W.watchRanges(t, 0x02025000, 0).some(([a]) => a === t.questLog), 'read with every picture');
  assert.ok(W.watchRanges(t, 0x02025000, 0).length <= 16);
});
