// Partner screens popped out into windows: the layout math of lib/pslayout.mjs – aspect, clamping into the play area,
// staying off the game bar, light snapping, resizing from a corner, the remembered position, where new windows start
// and the per-run layout in localStorage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEAD, MIN_W, MAX_W, GAP, SNAP, SYSTEM_AR, arOf, heightFor, widthFor, maxWidth, sizeFor, defaultWidth, clampRect, snapRect,
  gripSide, resizeRect, resizeAnchored, toStored, fromStored, cornerLayout, avoidRect, runLayout, winState, updateRun,
} from '../web/lib/pslayout.mjs';

const area = { w: 1200, h: 800 };
const inside = (r, a = area) => r.x >= 0 && r.y >= 0 && r.x + r.w <= a.w && r.y + r.h <= a.h;
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
// the picture's own aspect inside a window (header and borders off)
const pictureAr = (r) => (r.w - 14) / (r.h - HEAD - 8);

test('aspect: height follows the width, and back', () => {
  for (const ar of Object.values(SYSTEM_AR)) {
    for (const w of [MIN_W, 240, 333, 480]) {
      const h = heightFor(w, ar);
      assert.ok(Math.abs(pictureAr({ w, h }) - ar) < 0.02, `ar ${ar} at ${w}`);
      assert.ok(Math.abs(widthFor(h, ar) - w) <= 1);
    }
  }
  assert.equal(arOf('nds'), 256 / 384);
  assert.equal(arOf('gba', 2.67), 2.67, 'a measured picture wins (DS screens side by side)');
  assert.equal(arOf('psx'), 3 / 2, 'unknown system: landscape');
  assert.equal(defaultWidth(3 / 2), 240);
  assert.equal(defaultWidth(256 / 384), 176);
  assert.equal(defaultWidth(3 / 2, true), 480);
});

test('size: never below the minimum, never bigger than the area or the maximum', () => {
  assert.equal(sizeFor(10, 3 / 2, area).w, MIN_W);
  assert.equal(sizeFor(5000, 3 / 2, { w: 5000, h: 5000 }).w, MAX_W);
  const tall = sizeFor(5000, 256 / 384, area); // a DS screen is limited by the height
  assert.ok(tall.h <= area.h && tall.h >= area.h - 2, `${tall.h}`);
  const narrow = sizeFor(900, 3 / 2, { w: 500, h: 800 });
  assert.equal(narrow.w, 500);
  assert.equal(maxWidth(3 / 2, { w: 100, h: 100 }), MIN_W, 'a tiny area still gets a usable window');
  assert.equal(sizeFor(NaN, 3 / 2, area).w, MIN_W);
});

test('clamping keeps a window inside the play area', () => {
  assert.deepEqual(clampRect({ x: -50, y: -20, w: 200, h: 150 }, area), { x: 0, y: 0, w: 200, h: 150 });
  assert.deepEqual(clampRect({ x: 1150, y: 790, w: 200, h: 150 }, area), { x: 1000, y: 650, w: 200, h: 150 });
  assert.deepEqual(clampRect({ x: 10, y: 10, w: 2000, h: 900 }, area), { x: 0, y: 0, w: 2000, h: 900 }, 'too big: top-left');
});

test('snapping: area edges, neighbours side by side and flush, guides – only when close', () => {
  const r = { x: 0, y: 0, w: 200, h: 150 };
  assert.deepEqual(snapRect({ ...r, x: 6, y: 300 }, [], area), { ...r, x: 0, y: 300 }, 'left edge');
  assert.deepEqual(snapRect({ ...r, x: 993, y: 643 }, [], area), { ...r, x: 1000, y: 650 }, 'bottom-right corner');
  assert.deepEqual(snapRect({ ...r, x: 500, y: 300 }, [], area), { ...r, x: 500, y: 300 }, 'far from everything: stays');
  const o = { x: 600, y: 300, w: 200, h: 150 };
  // next to the neighbour, GAP between
  assert.equal(snapRect({ ...r, x: 600 - GAP - 200 + 7, y: 305 }, [o], area).x, 600 - GAP - 200);
  assert.equal(snapRect({ ...r, x: 800 + GAP - 6, y: 310 }, [o], area).x, 800 + GAP);
  // flush with its top when level
  assert.equal(snapRect({ ...r, x: 380, y: 306 }, [o], area).y, 300);
  // under it: GAP below, left edges aligned
  const below = snapRect({ ...r, x: 604, y: 450 + GAP + 5 }, [o], area);
  assert.deepEqual([below.x, below.y], [600, 450 + GAP]);
  // a neighbour far above doesn't pull sideways
  assert.equal(snapRect({ ...r, x: 600 - GAP - 200 + 7, y: 650 }, [o], area).x, 600 - GAP - 200 + 7);
  // guide: the right column's left edge
  assert.equal(snapRect({ ...r, x: 905, y: 400 }, [], area, { guides: { x: [900] } }).x, 900);
  assert.equal(snapRect({ ...r, x: 900 - 200 - 4, y: 400 }, [], area, { guides: { x: [900] } }).x, 700);
  // the snap distance is light
  assert.equal(snapRect({ ...r, x: SNAP + 2, y: 400 }, [], area).x, SNAP + 2);
  // never outside, also when dragged past the edge
  assert.ok(inside(snapRect({ ...r, x: 5000, y: -300 }, [o], area)));
});

test('resizing from the corner keeps the aspect, the limits and the window inside', () => {
  const ar = 3 / 2;
  const start = { x: 100, y: 100, ...sizeFor(240, ar, area) };
  const wider = resizeRect(start, 120, 0, ar, area, 'right');
  assert.equal(wider.w, 360);
  assert.deepEqual([wider.x, wider.y], [100, 100], 'top-left stays');
  assert.ok(Math.abs(pictureAr(wider) - ar) < 0.02);
  const down = resizeRect(start, 0, 80, ar, area, 'right'); // dragging down alone works too
  assert.ok(down.w > start.w && Math.abs(down.h - start.h - 80) <= 2, `${down.h - start.h}`);
  assert.equal(resizeRect(start, -500, 0, ar, area, 'right').w, MIN_W);
  // grip on the left: the top-right corner stays, dragging left grows
  const right = { x: 900, y: 100, ...sizeFor(240, ar, area) };
  const l = resizeRect(right, -100, 0, ar, area, 'left');
  assert.equal(l.w, 340);
  assert.equal(l.x + l.w, right.x + right.w);
  // growing past the bottom: the window moves up instead of sticking out
  const low = { x: 100, y: 600, ...sizeFor(240, ar, area) };
  const big = resizeRect(low, 400, 0, ar, area, 'right');
  assert.ok(inside(big) && big.w === 640, JSON.stringify(big));
  // never bigger than the area
  const huge = resizeRect(start, 5000, 5000, ar, area, 'right');
  assert.ok(inside(huge) && huge.h <= area.h);
  assert.equal(gripSide({ x: 900, y: 0, w: 200, h: 100 }, area), 'left');
  assert.equal(gripSide({ x: 50, y: 0, w: 200, h: 100 }, area), 'right');
});

test('Bigger / Smaller keeps the corner nearest to the area corner', () => {
  const ar = 3 / 2;
  const br = { x: 1200 - 240, y: 800 - heightFor(240, ar), w: 240, h: heightFor(240, ar) };
  const big = resizeAnchored(br, 480, ar, area);
  assert.deepEqual([big.x + big.w, big.y + big.h], [1200, 800], 'still in the bottom-right corner');
  const tl = resizeAnchored({ x: 20, y: 30, w: 240, h: heightFor(240, ar) }, 480, ar, area);
  assert.deepEqual([tl.x, tl.y], [20, 30]);
});

test('a moved window is remembered relative to the free room and comes back at the same edges', () => {
  const ar = 3 / 2;
  const r = { x: 1200 - 300, y: 800 - heightFor(300, ar), w: 300, h: heightFor(300, ar) };
  const s = toStored(r, area);
  assert.deepEqual(s, { fx: 1, fy: 1, w: 300 });
  assert.deepEqual(fromStored(s, ar, area), r);
  // the app window got smaller: still in the bottom-right corner, still inside
  const small = { w: 900, h: 600 };
  const back = fromStored(s, ar, small);
  assert.deepEqual([back.x + back.w, back.y + back.h], [900, 600]);
  const mid = toStored({ x: 450, y: 325, w: 300, h: heightFor(300, ar) }, area);
  const m2 = fromStored(mid, ar, area);
  assert.ok(Math.abs(m2.x - 450) <= 1 && Math.abs(m2.y - 325) <= 1);
  // a stored size bigger than the area now is shrunk to fit
  assert.ok(inside(fromStored({ fx: 0.5, fy: 0.5, w: 700 }, ar, { w: 500, h: 300 }), { w: 500, h: 300 }));
  // nonsense values don't break anything
  assert.ok(inside(fromStored({ fx: 'x', fy: 7, w: -3 }, ar, area)));
});

test('a window never covers the game bar: moved above it, below it or beside it', () => {
  const bar = { x: 400, y: 600, w: 500, h: 36 };
  const w = { x: 500, y: 520, w: 240, h: 170 };
  const up = avoidRect(w, bar, area);
  assert.ok(!overlap(up, bar) && up.y + up.h <= bar.y - GAP + 0.5, `above: ${JSON.stringify(up)}`);
  assert.equal(up.x, w.x, 'only moved up');
  const low = avoidRect({ ...w, y: 610 }, { ...bar, y: 100 }, area);
  assert.ok(!overlap(low, { ...bar, y: 100 }) && low.y >= 100 + 36 + GAP, 'below when it sits lower');
  const tall = avoidRect({ x: 450, y: 0, w: 200, h: 700 }, { x: 400, y: 380, w: 500, h: 36 }, area);
  assert.ok(!overlap(tall, { x: 400, y: 380, w: 500, h: 36 }) && inside(tall), `beside when neither fits: ${JSON.stringify(tall)}`);
  assert.deepEqual(avoidRect({ x: 0, y: 0, w: 100, h: 100 }, bar, area), { x: 0, y: 0, w: 100, h: 100 }, 'far away: unchanged');
  assert.deepEqual(avoidRect(w, null, area), w);
  for (const y of [0, 300, 480, 560, 600, 630]) {
    for (const x of [0, 380, 700, 960]) {
      const r = avoidRect({ x, y, w: 240, h: 170 }, bar, area);
      assert.ok(!overlap(r, bar) && inside(r), `${x},${y} → ${JSON.stringify(r)}`);
    }
  }
});

test('popped-out windows start as small tiles down the left edge of the stage, a new column when full', () => {
  const stage = { x: 270, y: 0, w: 600, h: 500 };
  const items = ['p2', 'p3', 'p4'].map((id) => ({ id, ar: 3 / 2 }));
  const c = cornerLayout(items, stage, area);
  assert.deepEqual([c.p2.x, c.p2.y], [stage.x + GAP, stage.y + GAP]);
  assert.ok(c.p2.w >= 180 && c.p2.w <= 240);
  const list = Object.values(c);
  for (const r of list) assert.ok(inside(r) && r.y + r.h <= stage.y + stage.h, JSON.stringify(r));
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) assert.ok(!overlap(list[i], list[j]));
  const short = cornerLayout(items, { ...stage, h: 260 }, area);
  assert.ok(short.p3.x > short.p2.x, 'wrapped into a second column');
  const ds = cornerLayout([{ id: 'p2', ar: 256 / 384 }], stage, area);
  assert.ok(ds.p2.h > ds.p2.w, 'a DS tile stays portrait');
});

test('the remembered layout: per run and partner, tiles by default, older layouts read as tiles, pruning', () => {
  let pref = { hidden: true, big: false, runs: { old: { preset: 'corner', wins: { p2: { hidden: true, fx: 0.5, fy: 0, w: 300 } } } } };
  assert.deepEqual(winState(runLayout(pref, 'run-a'), 'p2'), { popped: false, stored: null }, 'a tile in the dock to start with');
  assert.deepEqual(winState(runLayout(pref, 'old'), 'p2'), { popped: false, stored: null }, 'the windows-only version: back in the dock');
  pref = updateRun(pref, 'run-a', (l) => ({ wins: { ...l.wins, p2: { popped: true } } }), 1);
  assert.deepEqual(winState(runLayout(pref, 'run-a'), 'p2'), { popped: true, stored: null }, 'popped out, not moved yet');
  pref = updateRun(pref, 'run-a', (l) => ({ wins: { ...l.wins, p2: { ...l.wins.p2, fx: 1, fy: 0.5, w: 300 } } }), 2);
  assert.deepEqual(winState(runLayout(pref, 'run-a'), 'p2'), { popped: true, stored: { fx: 1, fy: 0.5, w: 300 } });
  assert.deepEqual(winState(runLayout(pref, 'run-a'), 'p3'), { popped: false, stored: null });
  assert.equal(winState(runLayout(pref, 'run-b'), 'p2').popped, false, 'other runs are untouched');
  pref = updateRun(pref, 'run-a', (l) => ({ wins: { ...l.wins, p2: { ...l.wins.p2, popped: false } } }), 3);
  assert.deepEqual(winState(runLayout(pref, 'run-a'), 'p2'), { popped: false, stored: null }, 'back in the dock');
  assert.deepEqual(runLayout({ runs: { x: { wins: 5 } } }, 'x').wins, {});
  for (let i = 0; i < 60; i++) pref = updateRun(pref, `r${i}`, (l) => l, 10 + i);
  assert.ok(Object.keys(pref.runs).length <= 40, 'old runs are dropped');
  assert.ok(pref.runs.r59 && !pref.runs['run-a'], 'the oldest go first');
});
