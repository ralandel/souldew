// The big play view's layout and the players' scaling: where the dock goes (lib/playlayout.mjs), how big the picture
// gets, the partner tiles' columns, "sharp" and "whole pixels only" scaling (lib/pixelscale.mjs) and that a click on
// the touch screen lands on the same spot of the game in every layout, at every size and in both scaling modes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOCK_W, DOCK_GAP, BAR_H, FOLDED, dockHeight, fit, pictureFor, dockSide, tileColumns, tileHeight, rightDockWidth, initials } from '../web/lib/playlayout.mjs';
import { sharpScale, dsTouchAt, WHOLE_MAX_LOSS } from '../web/lib/pixelscale.mjs';
import { CTR_LAYOUTS, ctrLayout, ctrLayoutAspect, ctrTouchAt } from '../shared/ctrlayout.mjs';

// the play area (the session's body) of common windows: the window minus the session's padding (16 / 14, 42 top in the
// app with the folded sidebar's button) – windowed; fullscreen keeps 12 all round
const area = (w, h, fs = false) => (fs ? { w: w - 24, h: h - 24 } : { w: w - 32, h: h - 42 - 14 });
const AR = {
  gb: 10 / 9, gba: 3 / 2, dsTb: 256 / 384, dsLr: 512 / 192,
  ...Object.fromEntries(CTR_LAYOUTS.map((id) => [`3ds-${id}`, ctrLayoutAspect(id)])),
};
const WINDOWS = [[1280, 800], [1440, 900], [1920, 1080], [2560, 1440], [3440, 1440]];

test('the dock goes where the picture leaves room: right of tall pictures, under wide ones', () => {
  for (const [w, h] of WINDOWS) {
    for (const fs of [false, true]) {
      const a = area(w, h, fs);
      const at = `${w}×${h}${fs ? ' fs' : ''}`;
      for (const k of ['gb', 'gba', 'dsTb', '3ds-tb', '3ds-bt']) assert.equal(dockSide(a, AR[k], { dockH: dockHeight(4) }), 'right', `${k} ${at}`);
      // ultra-wide (21:9) has the width for a column even next to DS screens side by side – the picture is bigger there
      for (const k of ['dsLr', '3ds-lr']) assert.equal(dockSide(a, AR[k], { dockH: dockHeight(4) }), w / h > 2 && k === 'dsLr' ? 'right' : 'bottom', `${k} ${at}`);
    }
  }
  // 3DS large (7:3) and top only (5:3) are wide enough for the bottom on ordinary screens, ultra-wide keeps them right
  assert.equal(dockSide(area(1440, 900), AR['3ds-large'], { dockH: dockHeight(2) }), 'bottom');
  assert.equal(dockSide(area(3440, 1440), AR['3ds-top'], { dockH: dockHeight(2) }), 'right');
});

test('the side is the one with the bigger picture – deterministic, the same with the dock folded', () => {
  for (const [w, h] of WINDOWS) {
    const a = area(w, h);
    for (const [k, ar] of Object.entries(AR)) {
      for (const n of [1, 2, 3, 4]) {
        const dockH = dockHeight(n);
        const side = dockSide(a, ar, { dockH });
        const p = (s) => pictureFor(a, ar, s, { dockH });
        const mine = p(side).w * p(side).h;
        const other = p(side === 'right' ? 'bottom' : 'right');
        // never more than 2 % behind the other side (ties go right), and the same answer every time
        assert.ok(mine >= other.w * other.h / 1.02 - 1, `${k} ${w}×${h} ${n}p: ${side}`);
        assert.equal(dockSide(a, ar, { dockH }), side);
        assert.equal(dockSide({ ...a }, ar, { dockH, folded: true }), side, 'folding never moves it');
        // folded the picture only grows, on the same side
        const f = pictureFor(a, ar, side, { dockH, folded: true });
        assert.ok(f.w >= p(side).w && f.h >= p(side).h);
      }
    }
  }
  assert.equal(dockSide(null, 1.5), 'right');
  assert.equal(dockSide({ w: 0, h: 0 }, 1.5), 'right');
});

test('the picture keeps its aspect and fits the room the dock and the game bar leave', () => {
  const a = area(1440, 900);
  const r = pictureFor(a, AR.gba, 'right');
  assert.ok(r.w <= a.w - DOCK_W - DOCK_GAP && r.h <= a.h - BAR_H);
  assert.ok(Math.abs(r.w / r.h - AR.gba) < 0.01);
  const b = pictureFor(a, AR.dsLr, 'bottom', { dockH: dockHeight(4) });
  assert.ok(b.h <= a.h - dockHeight(4) - DOCK_GAP - BAR_H && b.w <= a.w);
  const f = pictureFor(a, AR.dsLr, 'bottom', { dockH: dockHeight(4), folded: true });
  assert.ok(f.h <= a.h - FOLDED - DOCK_GAP - BAR_H && f.w >= b.w);
  assert.deepEqual(fit(0, 100, 1), { w: 0, h: 0 });
  assert.deepEqual(fit(400, 300, 4 / 3), { w: 400, h: 300 });
  // the bottom dock grows with the players, so a group of four stays readable
  assert.ok(dockHeight(4) > dockHeight(3) && dockHeight(3) > dockHeight(2) && dockHeight(2) === dockHeight(1));
  assert.equal(dockHeight(9), dockHeight(4));
});

test('before vs. after: the new layout never shrinks the picture of the old one (1440×900, 4 players)', () => {
  // the old view: sidebar 220, left column 270 + right column 300 + gaps, header 30 + bar 36 (audit-before.md)
  const old = { gba: [574, 383], dsTb: [514, 772], dsLr: [574, 215], '3ds-lr': [574, 191] };
  const a = area(1440, 900);
  for (const [k, [w, h]] of Object.entries(old)) {
    const side = dockSide(a, AR[k], { dockH: dockHeight(4) });
    const p = pictureFor(a, AR[k], side, { dockH: dockHeight(4) });
    assert.ok(p.w * p.h > w * h, `${k}: ${p.w}×${p.h} vs ${w}×${h}`);
  }
});

test('partner tiles: as many side by side as give the biggest pictures that still fit', () => {
  const ds = AR.dsTb;
  assert.equal(tileColumns(3, ds, { w: 300, h: 380 }), 3, 'three DS screens in a narrow dock: one row');
  assert.equal(tileColumns(3, 1.5, { w: 300, h: 380 }), 2, 'three GBA screens: two per row');
  assert.equal(tileColumns(1, ds, { w: 300, h: 380 }), 1, 'a single partner: full width even when tall');
  assert.equal(tileColumns(3, ds, { w: 330, h: 800 }), 2, 'a wide dock\'s column');
  assert.equal(tileColumns(0, ds, { w: 300, h: 300 }), 1);
  for (const n of [1, 2, 3]) {
    for (const box of [{ w: 300, h: 380 }, { w: 340, h: 820 }, { w: 500, h: 600 }]) {
      const c = tileColumns(n, ds, box);
      const w = (box.w - (c - 1) * 8) / c;
      const rows = Math.ceil(n / c);
      const fitsSome = [...Array(n)].some((_, i) => { const cw = (box.w - i * 8) / (i + 1); return Math.ceil(n / (i + 1)) * tileHeight(cw, ds) + (Math.ceil(n / (i + 1)) - 1) * 8 <= box.h; });
      if (fitsSome) assert.ok(rows * tileHeight(w, ds) + (rows - 1) * 8 <= box.h, `${n} in ${JSON.stringify(box)} → ${c}`);
    }
  }
  assert.equal(rightDockWidth({ w: 1408, h: 850 }, 560), 660, 'spare room: wider, up to the maximum');
  assert.equal(rightDockWidth({ w: 1000, h: 850 }, 900), DOCK_W, 'never narrower than the column');
  assert.equal(rightDockWidth({ w: 1200, h: 850 }, 700), 486);
});

test('sharp scaling: whole-number hard edges first, the rest smoothed; never bigger than the frame', () => {
  const gba = { w: 240, h: 160 };
  const s = sharpScale(gba, { w: 1094, h: 729 }, 1);
  assert.equal(s.pre, 4, 'drawn at 4× with hard edges');
  assert.equal(s.smooth, true);
  assert.ok(s.w <= 1094 && s.h <= 729 && s.w > 1090, `fills the frame (${s.w}×${s.h})`);
  const retina = sharpScale(gba, { w: 1094, h: 729 }, 2);
  assert.equal(retina.pre, 9, 'device pixels count: 2× screen → 9× buffer');
  assert.ok(Math.abs(retina.w - s.w) < 1);
  const exact = sharpScale(gba, { w: 960, h: 640 }, 1);
  assert.deepEqual([exact.pre, exact.w, exact.h, exact.smooth], [4, 960, 640, false], 'an exact multiple is drawn as it is');
  const small = sharpScale(gba, { w: 200, h: 200 }, 1);
  assert.deepEqual([small.pre, small.smooth], [1, true], 'smaller than the game: plain smoothing');
  assert.ok(small.w <= 200);
  const huge = sharpScale({ w: 400, h: 480 }, { w: 6000, h: 6000 }, 2);
  assert.ok(huge.pre * 480 <= 4096, `the buffer stays sane (${huge.pre})`);
  assert.equal(sharpScale(null, { w: 10, h: 10 }).pre, 1);
});

test('"whole pixels only" snaps to a whole multiple when that costs at most ~15 % of the area, else stays sharp', () => {
  const gba = { w: 240, h: 160 };
  const snap = sharpScale(gba, { w: 1000, h: 700 }, 1, { whole: true }); // 4.17× → 4× costs 8 %
  assert.deepEqual([snap.pre, snap.w, snap.h, snap.smooth, snap.whole], [4, 960, 640, false, true]);
  const keep = sharpScale(gba, { w: 860, h: 700 }, 1, { whole: true }); // 3.58× → 3× would cost 30 %
  assert.equal(keep.whole, false);
  assert.ok(keep.w > 850 && keep.smooth);
  // at the limit: (n / k)² ≥ 1 − WHOLE_MAX_LOSS
  const k = 3 / Math.sqrt(1 - WHOLE_MAX_LOSS);
  assert.equal(sharpScale(gba, { w: 240 * k - 0.5, h: 2000 }, 1, { whole: true }).whole, true);
  assert.equal(sharpScale(gba, { w: 240 * k + 2, h: 2000 }, 1, { whole: true }).whole, false);
  const hi = sharpScale(gba, { w: 1000, h: 700 }, 2, { whole: true }); // 8.33 device px → 8
  assert.deepEqual([hi.pre, hi.w, hi.h, hi.whole], [8, 960, 640, true]);
});

// Where the canvas sits in the frame (centred, the size sharpScale gives) and where a click on it lands for the core.
function clickOnCanvas(box, s, fx, fy) {
  const left = (box.w - s.w) / 2;
  const top = (box.h - s.h) / 2;
  const x = left + fx * s.w;
  const y = top + fy * s.h;
  return { fx: (x - left) / s.w, fy: (y - top) / s.h };
}

test('DS touch: the same spot of the bottom screen in both layouts, at every size and in both scaling modes', () => {
  const spots = [[0, 0], [0.5, 0.5], [1, 1], [0.25, 0.8]]; // over the bottom screen, 0…1
  for (const lr of [false, true]) {
    const src = lr ? { w: 512, h: 192 } : { w: 256, h: 384 };
    for (const box of [{ w: 474, h: 711 }, { w: 1408, h: 528 }, { w: 2832, h: 1062 }, { w: 300, h: 300 }]) {
      for (const whole of [false, true]) {
        for (const dpr of [1, 2]) {
          const s = sharpScale(src, box, dpr, { whole });
          for (const [bx, by] of spots) {
            // the spot on the shown picture: below the top screen, or in the right half side by side
            const sx = lr ? 0.5 + bx * 0.5 : bx;
            const sy = lr ? by : 0.5 + by * 0.5;
            const { fx, fy } = clickOnCanvas(box, s, sx, sy);
            const p = dsTouchAt(fx, fy, lr);
            assert.ok(Math.abs(p.x - bx) < 1e-9 && Math.abs(p.y - (0.5 + by * 0.5)) < 1e-9, `${lr ? 'lr' : 'tb'} ${JSON.stringify(box)} ${whole} ${dpr}: ${bx},${by} → ${p.x},${p.y}`);
          }
        }
      }
    }
  }
  assert.deepEqual(dsTouchAt(-1, 2, false), { x: 0, y: 1 }, 'clamped');
});

test('3DS touch: every layout, every size, sharp and whole pixels – the bottom screen maps to the core\'s, the top screen is no touch', () => {
  for (const id of CTR_LAYOUTS) {
    for (const res of [1, 2]) {
      const lay = ctrLayout(id, 400 * res, 480 * res);
      const bottom = lay.quads.find((q) => q.screen === 'bottom');
      const top = lay.quads.find((q) => q.screen === 'top');
      for (const box of [{ w: 1408, h: 469 }, { w: 643, h: 772 }, { w: 3396, h: 1132 }, { w: 500, h: 900 }]) {
        for (const whole of [false, true]) {
          const s = sharpScale({ w: lay.width, h: lay.height }, box, 2, { whole });
          assert.ok(s.w <= box.w + 1e-9 && s.h <= box.h + 1e-9, 'inside the frame');
          if (top) {
            const c = clickOnCanvas(box, s, (top.dst.x + top.dst.w / 2) / lay.width, (top.dst.y + top.dst.h / 2) / lay.height);
            assert.equal(ctrTouchAt(lay, c.fx, c.fy), null, `${id}: the top screen is no touch`);
          }
          if (!bottom) continue;
          for (const [u, v] of [[0.1, 0.1], [0.5, 0.5], [0.9, 0.75]]) {
            const c = clickOnCanvas(box, s, (bottom.dst.x + u * bottom.dst.w) / lay.width, (bottom.dst.y + v * bottom.dst.h) / lay.height);
            const p = ctrTouchAt(lay, c.fx, c.fy);
            // the core's bottom screen: x 40…360, y 240…480 of 400×480
            assert.ok(Math.abs(p.x - (40 + u * 320) / 400) < 0.004 && Math.abs(p.y - (240 + v * 240) / 480) < 0.004, `${id} ${res}× ${JSON.stringify(box)} ${whole}: ${p.x},${p.y}`);
          }
        }
      }
    }
  }
});

test('the players draw with the shared scaling and the play view hands "whole pixels only" over', () => {
  const read = (p) => readFileSync(new URL(`../web/${p}`, import.meta.url), 'utf8');
  for (const f of ['lib/nativeplayer.mjs', 'lib/ctrplayer.mjs', 'player.html']) {
    const src = read(f);
    assert.match(src, /pixelscale\.mjs/, `${f} uses lib/pixelscale.mjs`);
    assert.match(src, /setWholePixels/, `${f} can switch while playing`);
    assert.match(src, /px'?\)? === 'whole'|get\('px'\) === 'whole'/, `${f} reads ?px=whole`);
  }
  assert.match(read('views/play.mjs'), /&px=whole/);
  assert.match(read('index.html'), /playdock\.css/);
  assert.doesNotMatch(read('views/play.mjs'), /proto/i, 'no prototype left');
});

test('folded strip: one letter per partner, two where names share their first letter', () => {
  assert.deepEqual(initials(['Misty', 'Brock', 'May']), ['Mi', 'B', 'Ma']);
  assert.deepEqual(initials(['misty', 'Brock']), ['M', 'B']);
  assert.deepEqual(initials(['A', 'Al']), ['A', 'Al'], 'a one-letter name stays one letter');
  assert.deepEqual(initials([' ash ', 'Amy']), ['As', 'Am']);
});

test('the partners\' video stays at the picture\'s own size (no extra upload from the sharp scaling); one group look', () => {
  const read = (p) => readFileSync(new URL(`../web/${p}`, import.meta.url), 'utf8');
  for (const f of ['lib/nativeplayer.mjs', 'lib/ctrplayer.mjs']) {
    const src = read(f);
    assert.match(src, /return streamCanvas\.captureStream\(fps\);/, `${f} streams the small canvas`);
    assert.doesNotMatch(src, /canvas\.captureStream\(fps\) :/, `${f} no longer streams the drawing buffer`);
    assert.match(src, /const w = pic\.w \|\| canvas\.width;/);
  }
  const dock = read('views/playdock.mjs');
  assert.match(read('lib/playlayout.mjs'), /export function initials\(names\)/);
  assert.match(dock, /\$\{marks\[i\]\}/);
  const info = read('views/session-info.mjs');
  assert.doesNotMatch(info, /sl-groups-variant|gchain|gcard/, 'the chain look is gone');
  assert.match(info, /class=\$\{`gtable n\$\{slots\.length\}`\}/);
});
