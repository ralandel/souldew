// Shared World: every sprite souldew draws walks like the game's own – a partner (shared/world.mjs Track), their
// follower and yours (Follower), on the pictures' own clock (PictureClock). Fed with player paths recorded in a real
// game (test/fixtures/worldmotion: Emerald, the camera that follows the player at every game picture), measured with
// the same metrics as world-e2e --smooth (scripts/world-motion.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Track, Follower, PictureClock, SEND, DIR, TILE, pixelSnapper, wholePx, watchRanges, unpackState, StepGate } from '../shared/world.mjs';
import { smoothness } from '../scripts/world-motion.mjs';

const FRAME = 1000 / 59.7275;
const rec = JSON.parse(readFileSync(new URL('./fixtures/worldmotion/emerald-walks.json', import.meta.url), 'utf8'));

// a small deterministic noise source (the same every run)
function noise(seed = 1) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

const facingOf = (dx, dy, was) => (dx > 0 ? DIR.E : dx < 0 ? DIR.W : dy > 0 ? DIR.S : dy < 0 ? DIR.N : was);

/**
 * The whole way a partner's walk takes: the sender's pictures (`path`: [frame, ms, x, y]), every `every`th of them sent
 * (or `pattern`: the gaps in pictures, repeated), stamped with `stamp(picture time, i)`, on the network for 10–25 ms; the
 * receiver's own game pictures at `phase` ms after the sender's, each one samples the track. Returns the drawn track
 * (whole pixels, as the overlay draws) and the track itself.
 */
function partnerWalk(path, { pattern = [4], stamp = (t) => t, phase = 7, latency = noise(7), receiverJitter = null } = {}) {
  const tr = new Track();
  const sent = [];
  // the sender's pictures on its own pictures' clock (they arrived unevenly in the recording – a loaded computer)
  const clock = new PictureClock();
  const at = path.map(([f, t]) => clock.picture(t, f));
  let facing = DIR.S;
  let last = null;
  let lastAt = -Infinity;
  for (let i = 0, k = 0; i < path.length; i += pattern[k++ % pattern.length]) {
    const [, t, x, y] = path[i];
    const prev = path[Math.max(0, i - 1)];
    facing = facingOf(x - prev[2], y - prev[3], facing);
    const moved = !last || last.x !== x || last.y !== y;
    if (!moved && t - lastAt < SEND.idleMs) continue; // (nothing new: only the heartbeat)
    const st = { seq: sent.length + 1, t: stamp(at[i], i), fam: 2, map: 1, x, y, facing, kind: 'walk', run: false, gender: 0, hidden: false };
    sent.push({ st, arrive: t + 10 + latency() * 15 });
    last = st;
    lastAt = t;
  }
  const out = [];
  const snap = pixelSnapper(); // (whole pixels as the overlay draws them)
  let j = 0;
  const t0 = path[0][1];
  const t1 = path[path.length - 1][1];
  for (let k = 0; t0 + k * FRAME + phase <= t1 + 400; k++) {
    const now = t0 + k * FRAME + phase + (receiverJitter ? receiverJitter() : 0);
    while (j < sent.length && sent[j].arrive <= now) tr.push(sent[j].st, sent[j].arrive), j++;
    const s = tr.sample(now);
    const [x, y] = s ? snap('p', s.x, s.y) : [];
    out.push(s ? { f: k, x, y, fx: s.x, fy: s.y, moving: s.moving } : { f: k, x: null, y: null });
  }
  return { drawn: out, tr };
}

const clean = (m) => ({ stalls: m.stalls, jumps: m.jumps, backs: m.backs, uneven: m.uneven });
const NONE = { stalls: 0, jumps: 0, backs: 0, uneven: 0 };

test('a partner walking (recorded in Emerald): one pixel every picture – no stall, no catch-up, no jump, no step back', () => {
  const { drawn } = partnerWalk(rec.B);
  const m = smoothness(drawn);
  assert.ok(m.moving > 150, `the recording walks (${m.moving} moving pictures)`);
  assert.deepEqual(clean(m), NONE, JSON.stringify(m.events));
  // (two clocks never run exactly alike: a partner whose game is 0.5 % faster gains a pixel every ~200 frames – one
  // double step there is their speed, not a stutter)
  assert.ok(Object.keys(m.steps).every((d) => d <= 2) && (m.steps[2] || 0) <= Math.ceil(m.moving / 150), `steps ${JSON.stringify(m.steps)}`);
});

test('a partner’s states stamped late or early by a few milliseconds, every second one lost: still even', () => {
  // (before: the play view stamped each state when the page's message reached it – up to a frame late – and dropped
  // one that came a millisecond early: gaps of 66 or 133 ms at random)
  const r = noise(3);
  const { drawn } = partnerWalk(rec.B, { pattern: [4, 8, 4, 4, 8], stamp: (t) => t + r() * 6 });
  const m = smoothness(drawn);
  assert.equal(m.stalls, 0, JSON.stringify(m.events));
  assert.equal(m.jumps, 0, JSON.stringify(m.events));
  assert.equal(m.backs, 0, JSON.stringify(m.events));
});

test('the receiver draws once per game picture: a picture that comes a little early or late doesn’t shake the partner', () => {
  const clock = new PictureClock();
  const r = noise(11);
  const ts = [];
  for (let k = 0; k < 600; k++) ts.push(clock.picture(1000 + k * FRAME + (r() - 0.5) * 10, 100 + k));
  const steps = ts.slice(1).map((t, i) => t - ts[i]);
  const off = steps.filter((d, i) => i > 30 && Math.abs(d - FRAME) > 1.5);
  assert.equal(off.length, 0, `every picture ~${FRAME.toFixed(2)} ms after the one before (${off.slice(0, 5).map((d) => d.toFixed(2))})`);
  // a picture the page never drew (two frames on): two frames of time
  const a = clock.picture(1000 + 600 * FRAME, 700);
  const b = clock.picture(1000 + 602 * FRAME, 702);
  assert.ok(Math.abs(b - a - 2 * FRAME) < 2, `${(b - a).toFixed(2)}`);
  // between two pictures the time stands; once they stop (a pause) it runs on, and goes on from there
  assert.equal(clock.at(1000 + 602 * FRAME + 10), b);
  const later = clock.at(1000 + 602 * FRAME + 500);
  assert.ok(later > b + 400 && later < b + 500);
  const back = clock.picture(1000 + 602 * FRAME + 520, 734);
  assert.ok(back >= later, 'never backwards after a pause');
});

test('a partner drawn on the pictures’ clock: the recorded walk on a receiver whose pictures come unevenly', () => {
  const r = noise(5);
  const clock = new PictureClock();
  const path = rec.B;
  const tr = new Track();
  const sent = [];
  for (let i = 0; i < path.length; i += 4) sent.push({ st: { seq: i + 1, t: path[i][1], fam: 2, map: 1, x: path[i][2], y: path[i][3], facing: DIR.S, kind: 'walk' }, arrive: path[i][1] + 14 });
  const out = [];
  const snap = pixelSnapper();
  let j = 0;
  for (let k = 0; k < 700; k++) {
    const arrive = path[0][1] + k * FRAME + 7 + (r() - 0.5) * 12; // (a busy page: ±6 ms)
    while (j < sent.length && sent[j].arrive <= arrive) tr.push(sent[j].st, sent[j].arrive), j++;
    const s = tr.sample(clock.picture(arrive, k));
    const [x, y] = s ? snap('p', s.x, s.y) : [];
    out.push(s ? { f: k, x, y } : { f: k, x: null, y: null });
  }
  const m = smoothness(out);
  assert.deepEqual(clean(m), NONE, JSON.stringify(m.events));
});

test('walking off after standing: no creeping ahead before the walk, the first step at walking speed', () => {
  const tr = new Track();
  let seq = 0;
  // walking, then standing for 3 s (heartbeats), then a walk of three tiles at 1 px per frame
  // (the sender's states: every 4th game picture, its position then)
  for (let f = 0; f <= 60; f += 4) tr.push({ seq: ++seq, t: f * FRAME, fam: 2, map: 1, x: Math.min(64, f), y: 0, facing: DIR.E, kind: 'walk' }, f * FRAME);
  for (let t = 1500; t <= 4000; t += 1000) tr.push({ seq: ++seq, t, fam: 2, map: 1, x: 64, y: 0, facing: DIR.E, kind: 'walk' }, t);
  const go = 4300;
  let j = 0;
  const states = [];
  for (let f = 4; f <= 60; f += 4) states.push({ seq: 0, t: go + f * FRAME, fam: 2, map: 1, x: 64 + Math.min(48, f), y: 0, facing: DIR.E, kind: 'walk' });
  const xs = [];
  for (let now = go - 300; now < go + 1400; now += FRAME) {
    while (j < states.length && states[j].t + 15 <= now) tr.push({ ...states[j], seq: ++seq }, states[j].t + 15), j++;
    xs.push(tr.sample(now).x);
  }
  // (the first and the last step are a part of a frame: where the picture falls in the game's frame)
  const steps = xs.slice(1).map((x, i) => x - xs[i]).filter((d) => d > 1e-6).slice(1, -1);
  const slow = steps.filter((d) => d < 0.8);
  assert.equal(slow.length, 0, `no creeping (${slow.map((d) => d.toFixed(2))})`);
  assert.ok(Math.max(...steps) < 1.3, `no hurrying (${Math.max(...steps).toFixed(2)})`);
  assert.equal(Math.round(xs[xs.length - 1]), 112, 'ends on the tile');
});

test('stopping: the last stretch at walking speed, then standing – not slower into the stop', () => {
  const tr = new Track();
  let seq = 0;
  // walking right 1 px per frame from x=0 to the tile at 48, stopping at 48 (frame 48 ≈ 804 ms); the state that says
  // so goes out with the next post, 60 ms later
  const st = (t, x) => ({ seq: ++seq, t, fam: 2, map: 1, x, y: 0, facing: DIR.E, kind: 'walk' });
  for (let f = 0; f <= 44; f += 4) tr.push(st(f * FRAME, f), f * FRAME + 15);
  tr.push(st(52 * FRAME, 48), 52 * FRAME + 15);
  const xs = [];
  for (let now = 100; now < 1300; now += FRAME) xs.push(tr.sample(now).x);
  const steps = xs.slice(1).map((x, i) => x - xs[i]).filter((d) => d > 1e-6).slice(1, -1);
  assert.ok(steps.every((d) => d > 0.85 && d < 1.2), `even to the end (${steps.map((d) => d.toFixed(2)).join(' ')})`);
  assert.equal(xs[xs.length - 1], 48);
});

test('round a corner along the grid, never across it (the DS: tile centres)', () => {
  for (const origin of [0, 8]) {
    const tr = new Track({ grid: { size: TILE, origin } });
    let seq = 0;
    const st = (t, x, y, facing) => ({ seq: ++seq, t, fam: 2, map: 1, x, y, facing, kind: 'walk' });
    // right to the tile at origin+32, then down: one state just before the corner, one just after
    tr.push(st(0, origin + 20, origin, DIR.E), 0);
    tr.push(st(66, origin + 24, origin, DIR.E), 66);
    tr.push(st(132, origin + 28, origin, DIR.E), 132);
    tr.push(st(198, origin + 32, origin + 4, DIR.S), 198);
    tr.push(st(264, origin + 32, origin + 8, DIR.S), 264);
    for (let now = 140; now < 470; now += 5) {
      const s = tr.sample(now);
      assert.ok(s.y === origin || s.x === origin + 32, `on the grid: (${s.x.toFixed(2)}, ${s.y.toFixed(2)}) at ${now}`);
    }
  }
});

test('the delay doesn’t change while the partner walks (it made them 50 % faster or slower for a moment)', () => {
  const tr = new Track();
  let seq = 0;
  const r = noise(9);
  // standing with steady states (the delay settles), then walking with uneven gaps – 50–80 ms, now and then one lost
  for (let t = 0; t <= 2000; t += 66) tr.push({ seq: ++seq, t, fam: 2, map: 1, x: 0, y: 0, facing: DIR.E, kind: 'walk' }, t);
  // (a state every 3–5 game pictures – 50–84 ms – its position then; every ninth one lost)
  let f = 0;
  let t = 2000;
  const xs = [];
  let now = 2000;
  const delays = [];
  for (let k = 0; t < 5000; k++) {
    f += k % 9 === 4 ? 8 : 3 + Math.floor(r() * 3);
    t = 2000 + f * FRAME;
    tr.push({ seq: ++seq, t, fam: 2, map: 1, x: f, y: 0, facing: DIR.E, kind: 'walk' }, t + 10 + r() * 6);
    for (; now < t + 10; now += FRAME) {
      xs.push(tr.sample(now).x);
      delays.push(tr._rd);
    }
  }
  const steps = xs.slice(1).map((x, i) => x - xs[i]).filter((d, i) => i > 30 && d > 0);
  assert.ok(steps.every((d) => d > 0.85 && d < 1.15), `steady speed (${Math.min(...steps).toFixed(3)}–${Math.max(...steps).toFixed(3)})`);
  const moving = delays.slice(30);
  assert.ok(Math.max(...moving) - Math.min(...moving) < 25, `the delay holds (${Math.min(...moving).toFixed(1)}–${Math.max(...moving).toFixed(1)})`);
});

test('the states stop mid-walk (lost, or the partner’s game paused): on to the tile ahead, then wait – no snapping back', () => {
  const tr = new Track();
  let seq = 0;
  for (let f = 0; f <= 20; f += 4) tr.push({ seq: ++seq, t: f * FRAME, fam: 2, map: 1, x: 100 + f, y: 0, facing: DIR.E, kind: 'walk' }, f * FRAME + 12);
  const xs = [];
  for (let now = 200; now < 1500; now += FRAME) xs.push(tr.sample(now).x);
  const steps = xs.slice(1).map((x, i) => x - xs[i]);
  assert.ok(steps.every((d) => d >= 0 && d < 1.2), `forward only (${steps.filter((d) => d < 0 || d >= 1.2).map((d) => d.toFixed(2))})`);
  assert.equal(xs[xs.length - 1], 128, 'waits on the tile it was heading for');
});

test('your own follower (the recorded walk): a tile behind, one pixel every picture, round the corners', () => {
  const f = new Follower();
  const out = [];
  let facing = DIR.S;
  for (const [k, [frame, , x, y]] of rec.A.entries()) {
    const prev = rec.A[Math.max(0, k - 1)];
    facing = facingOf(x - prev[2], y - prev[3], facing);
    const r = f.update('L1', x, y, facing);
    out.push({ f: frame, x: Math.round(r.x), y: Math.round(r.y) });
  }
  const m = smoothness(out);
  assert.ok(m.moving > 60, `it walks (${m.moving})`);
  assert.deepEqual(clean(m), NONE, JSON.stringify(m.events));
});

test('a partner’s follower (the recorded walk through the track): as even as the partner', () => {
  const { drawn } = partnerWalk(rec.B);
  const f = new Follower();
  const snap = pixelSnapper();
  const out = drawn.map((p) => {
    if (p.x === null) return { f: p.f, x: null, y: null };
    const r = f.update(1, p.fx, p.fy, DIR.S);
    const [x, y] = snap('f', r.x, r.y);
    return { f: p.f, x, y };
  });
  const m = smoothness(out);
  assert.ok(m.moving > 150);
  assert.deepEqual(clean(m), NONE, JSON.stringify(m.events));
});

test('whole pixels: a position halfway between two pixels steps one pixel a frame, not 0 and 2 by turns', () => {
  let last = null;
  const steps = [];
  for (let k = 0; k < 200; k++) {
    // one pixel a frame, sitting on the half pixel, with a little noise
    const v = 100.5 + k + Math.sin(k * 1.7) * 0.04;
    const px = wholePx(last, v);
    if (last) steps.push(px - last.px);
    last = { v, px };
    assert.ok(Math.abs(v - px) <= 0.75);
  }
  assert.ok(steps.every((d) => d === 1), `${[...new Set(steps)]}`);
  // standing: exactly on its pixel; a jump (a warp): right there
  assert.equal(wholePx({ v: 47.6, px: 48 }, 48), 48);
  assert.equal(wholePx({ v: 10, px: 10 }, 300), 300);
});

test('crossing into a connected map: the follower walks on behind you (it used to start again on you, as after a door)', () => {
  const f = new Follower();
  // walking north on map A (y falls), the follower a tile behind
  let r = null;
  for (let y = 100; y >= 0; y--) r = f.update('L1', 160, y, DIR.N);
  assert.deepEqual([r.x, r.y, r.hidden], [160, 16, false]);
  // map B lies north: the same ground is 20 tiles further down in B's frame
  const dy = 20 * TILE;
  f.rekey('L2', 0, dy);
  const steps = [];
  let last = { ...r, y: r.y + dy }; // (where it was, in B's frame)
  for (let y = dy - 1; y >= dy - 40; y--) {
    r = f.update('L2', 160, y, DIR.N);
    steps.push(last.y - r.y);
    last = r;
  }
  assert.ok(steps.every((d) => d === 1) && !r.hidden, `one pixel a frame on (${[...new Set(steps)]})`);
});

test('the player’s object comes with every picture (the RAM mirror lagged the camera by a few tiles)', () => {
  const t = { gen: 3, fieldCamera: 0x03005d00, main: 0x030022c0, paletteFade: 0x02037fd0, lock: 0x03000f9c, saveBlock1Ptr: 0x03005d8c, inBattle: null, questLog: 0, playerAvatar: 0x02037590, sprites: 0x02020630, objectEvents: 0x02037350 };
  const ranges = watchRanges(t, 0x02025a00, 0, 0);
  assert.ok(ranges.some(([a, l]) => a === t.objectEvents && l === 0x24), 'the player object');
  assert.ok(ranges.some(([a, l]) => a === t.playerAvatar && l === 8), 'running, the ids');
  assert.ok(ranges.length <= 16 && ranges.reduce((n, x) => n + x[1], 0) <= 512);
});

test('a partner from a real session: the states as they came over the network, drawn at each game picture', () => {
  const wire = JSON.parse(readFileSync(new URL('./fixtures/worldmotion/emerald-wire.json', import.meta.url), 'utf8'));
  const tr = new Track();
  const f = new Follower();
  const snap = pixelSnapper();
  let j = 0;
  const p = [];
  const fo = [];
  for (const [frame, t] of wire.draws) {
    while (j < wire.wires.length && wire.wires[j][0] <= t) tr.push(unpackState(wire.wires[j][1]), wire.wires[j][0]), j++;
    const s = tr.sample(t);
    if (!s) continue;
    const [x, y] = snap('p', s.x, s.y);
    p.push({ f: frame, t, x, y });
    const r = f.update(s.map, s.x, s.y, s.facing);
    const [fx, fy] = snap('f', r.x, r.y);
    fo.push({ f: frame, t, x: fx, y: fy });
  }
  for (const [name, m] of [['partner', smoothness(p)], ['their follower', smoothness(fo)]]) {
    assert.ok(m.moving > 80, `${name} walks (${m.moving})`);
    assert.deepEqual(clean(m), NONE, `${name}: ${JSON.stringify(m.events)}`);
  }
});

test('walking in a game that moves its picture every other frame: a partner beside you keeps their place (no shaking)', () => {
  // you and the partner walk right side by side, 2 px every other frame (a Game Boy game); the partner's track moves
  // 1 px every frame – drawn against your camera it shook by a pixel; with the gate it steps with your picture
  const gate = new StepGate();
  const rel = [];
  for (let k = 0; k < 64; k++) {
    const now = k * FRAME;
    const camX = 160 + 2 * Math.floor(k / 2); // (your camera: every other frame)
    const t = gate.at(now, true, camX, 112, 1);
    const partnerX = 160 + t / FRAME; // (the partner on their track: smooth)
    rel.push(Math.round(partnerX - camX));
  }
  const moves = rel.slice(1).map((v, i) => v - rel[i]).slice(2);
  assert.ok(moves.every((d) => d === 0), `the partner stays beside you (${[...new Set(moves)]})`);
  // standing: every picture moves them
  const g2 = new StepGate();
  for (let k = 0; k < 5; k++) assert.equal(g2.at(k * FRAME, true, 160, 112, 1), k * FRAME);
  // a Game Boy Advance game moves its picture every frame: nothing held
  const g3 = new StepGate();
  for (let k = 0; k < 40; k++) assert.equal(g3.at(k * FRAME, true, 160 + k, 112, 1), k * FRAME);
});

test('the leader turns back and walks through their follower: it stays in sight (only after a door it waits on them)', () => {
  const f = new Follower();
  let r;
  for (let x = 0; x <= 64; x++) r = f.update(1, x, 0, DIR.E);
  const hidden = [];
  for (let x = 63; x >= 30; x--) hidden.push(f.update(1, x, 0, DIR.W).hidden);
  assert.ok(hidden.every((h) => !h), 'never hidden while they pass');
  // a warp puts it onto them, hidden until they step away
  r = f.update(1, 400, 400, DIR.S);
  assert.equal(r.hidden, true);
  for (let y = 401; y <= 420; y++) r = f.update(1, 400, y, DIR.S);
  assert.equal(r.hidden, false);
});

test('a game that moves its player unevenly (HeartGold running: 8, 4, 4, 0 units a frame): the partner runs evenly', () => {
  // the DS field moves every other frame; per tile 8, 4, 4, 0 units; a state every 4 game pictures (12 and 4 apart)
  const pos = (f) => { const c = Math.floor(f / 8); const r = Math.floor((f % 8) / 2); return c * 16 + [0, 8, 12, 16][r]; };
  const tr = new Track({ grid: { size: TILE, origin: 8 } });
  let seq = 0;
  for (let f = -120; f < 0; f += 60) tr.push({ seq: ++seq, t: f * FRAME, fam: 22, map: 1, x: 8, y: 8, facing: DIR.E, kind: 'walk', run: true }, f * FRAME + 12);
  const states = [];
  for (let f = 0; f <= 160; f += 4) states.push({ t: f * FRAME, fam: 22, map: 1, x: 8 + pos(f), y: 8, facing: DIR.E, kind: 'walk', run: true });
  states.push({ t: 168 * FRAME, fam: 22, map: 1, x: 8 + pos(160), y: 8, facing: DIR.E, kind: 'walk', run: true });
  const snap = pixelSnapper();
  const xs = [];
  let j = 0;
  for (let k = 0; k < 260; k++) {
    const now = k * FRAME + 5;
    while (j < states.length && states[j].t + 12 <= now) tr.push({ ...states[j], seq: ++seq }, states[j].t + 12), j++;
    xs.push(snap('p', tr.sample(now).x, 8)[0]);
  }
  const steps = xs.slice(1).map((x, i) => x - xs[i]);
  const run = steps.slice(steps.findIndex((d) => d > 0) + 12, steps.lastIndexOf(2) - 12);
  assert.ok(run.length > 80 && run.every((d) => d === 2), `two units every frame (${[...new Set(run)]})`);
  assert.equal(xs[xs.length - 1], 8 + pos(160), 'stops on its tile');
  assert.ok(steps.every((d) => d >= 0 && d <= 3), `never back, never a jump (${[...new Set(steps)]})`);
});

test('the pictures’ clock never runs ahead of the pictures (a host catching up counts frames that took no time)', () => {
  const clock = new PictureClock();
  let frame = 0;
  let prev = -Infinity;
  for (let k = 0; k < 400; k++) {
    const now = 1000 + k * FRAME;
    frame += k % 50 > 40 ? 6 : 1; // (now and then six frames between two pictures)
    const t = clock.picture(now, frame);
    assert.ok(t <= now + FRAME / 2 + 1e-9, `not ahead (${(t - now).toFixed(1)} ms at ${k})`);
    assert.ok(t >= prev, 'never back');
    prev = t;
  }
});
