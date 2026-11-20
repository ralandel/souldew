// The launch animation's frames stay even (web/lib/handheld/steady.mjs, measured in the real app with the opt-in trace,
// web/lib/handheld/launchtrace.mjs): the glass keeps one shader to the end, the audio service starts before anything
// moves, the scene is freed after the hand-over – and the trace's numbers are the ones a hitch is judged by.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { glassCoat, GLASS_COAT, GLASS_COAT_MIN, warmAudio, resetAudioWarm, afterHandover, pixelRatioFor, PIXEL_BUDGET, CLEAR_BUDGET, budgetFor, settle, SETTLE_MAX } from '../web/lib/handheld/steady.mjs';
import { frameStats, traceWanted } from '../web/lib/handheld/launchtrace.mjs';

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the glass coat fades but never reaches 0 (three.js would build the glass a new shader mid-push)', () => {
  assert.equal(glassCoat(0), GLASS_COAT);
  assert.ok(glassCoat(0.5) < GLASS_COAT && glassCoat(0.5) > GLASS_COAT_MIN);
  for (const k of [1, 1.2, 0.9999, Infinity, NaN, -1]) assert.ok(glassCoat(k) > 0, `k = ${k}`);
  assert.equal(glassCoat(1), GLASS_COAT_MIN);
  assert.equal(glassCoat(NaN), GLASS_COAT); // (no fade asked for)
  // every step of the fade: the same side of 0 as the start – the program three.js picked stays
  for (let k = 0; k <= 1.0001; k += 0.01) assert.ok(glassCoat(k) > 0);
  // the scene uses it, both where the glass is made and where it fades
  const scene = src('web/lib/handheld/scene.mjs');
  assert.match(scene, /glassM\.clearcoat = glassCoat\(s\.glassOff \|\| 0\)/);
  assert.match(scene, /clearcoat: GLASS_COAT, clearcoatRoughness: 0\.1/);
  assert.doesNotMatch(scene, /glassM\.clearcoat = 0\.35 \* \(1 -/);
});

test('warmAudio: one silent, closed context per page; no audio API or a failing one is no error', () => {
  resetAudioWarm();
  const made = [];
  class AC { constructor() { this.closed = false; this.connected = false; made.push(this); } close() { this.closed = true; return Promise.resolve(); } }
  assert.equal(warmAudio(AC), true);
  assert.equal(made.length, 1);
  assert.equal(made[0].closed, true);
  assert.equal(made[0].connected, false); // nothing plays
  assert.equal(warmAudio(AC), false); // once
  assert.equal(made.length, 1);
  resetAudioWarm();
  assert.equal(warmAudio(undefined), false);
  resetAudioWarm();
  assert.equal(warmAudio(class { constructor() { throw new Error('no device'); } }), false);
  resetAudioWarm();
});

test('afterHandover: two frames on, then idle – and once only (run now when the page goes away)', () => {
  const rafs = [];
  const idles = [];
  const env = { requestAnimationFrame: (f) => rafs.push(f), requestIdleCallback: (f, o) => idles.push([f, o]), setTimeout };
  let n = 0;
  const now = afterHandover(() => n++, 400, env);
  assert.equal(n, 0);
  rafs.shift()();
  assert.equal(n, 0); // the hand-over's frame: nothing heavy
  rafs.shift()();
  assert.equal(n, 0);
  assert.equal(idles.length, 1);
  assert.equal(idles[0][1].timeout, 400);
  idles[0][0]();
  assert.equal(n, 1);
  now();
  assert.equal(n, 1);
  // without requestIdleCallback: a timer
  const timers = [];
  const env2 = { requestAnimationFrame: (f) => f(), setTimeout: (f, ms) => timers.push([f, ms]) };
  afterHandover(() => n++, 400, env2);
  assert.equal(timers.length, 1);
  timers[0][0]();
  assert.equal(n, 2);
});

test('the stage: audio warmed before the build (not for a preview), the scene freed after the hand-over, the clock on the first frame', () => {
  const s = src('web/views/launchstage.mjs');
  const warm = s.indexOf('if (warmAudio())');
  assert.ok(warm > 0 && warm < s.indexOf('await loadScene()'), 'warmed before the scene is built');
  assert.match(s, /if \(!picture\) \{\n\s+await new Promise\(\(r\) => requestAnimationFrame/);
  assert.match(s, /if \(gone\) afterHandover\(\(\) => gone\.dispose\(\)\);/);
  const fin = s.slice(s.indexOf('const finish = () => {'), s.indexOf('// the play view\'s screen waits under the stage'));
  assert.doesNotMatch(fin, /scene\?\.dispose\(\)/, 'nothing freed on the hand-over\'s frame');
  assert.match(s, /if \(t0 === null\) t0 = prev = now;/);
});

test('pixelRatioFor: within the pixel budget, never above 2× or the screen, never below 1×', () => {
  // the measured case: a 1280 × 800 window on a Retina – the screen area 891 × 594 – draws at ≈ 1.5×
  const r = pixelRatioFor(891, 594, 2);
  assert.ok(r >= 1.45 && r <= 1.6, String(r));
  assert.ok(891 * 594 * r * r <= PIXEL_BUDGET * 1.01);
  assert.equal(pixelRatioFor(300, 200, 2), 2); // small: the screen's own
  assert.equal(pixelRatioFor(300, 200, 3), 2); // never above 2×
  assert.equal(pixelRatioFor(300, 200, 1), 1); // a 1× screen stays 1×
  assert.equal(pixelRatioFor(2400, 1400, 2), 1); // huge: never below 1×
  assert.equal(pixelRatioFor(2400, 1400, 0.8), 0.8); // (a screen below 1× keeps its own)
  assert.equal(pixelRatioFor(0, 0, 2), 2);
  assert.equal(pixelRatioFor(800, 600, NaN), 1);
  const scene = src('web/lib/handheld/scene.mjs');
  assert.match(scene, /o\.pixelBudget \? pixelRatioFor\(w, h, devicePixelRatio \|\| 1, o\.pixelBudget\)/);
  assert.match(scene, /resize\(w, h\) \{ o\.w = w; o\.h = h; renderer\.setPixelRatio\(ratio\(w, h\)\);/);
  assert.match(src('web/views/launchstage.mjs'), /pixelBudget: budgetFor\(V\.look\),/); // (the launch only: the editor and the stills keep 2×)
  // the Clear shell (drawn twice: the transmission pass) has the smaller budget; Gold and "Your colours" the full one
  assert.equal(budgetFor('clear'), CLEAR_BUDGET);
  assert.ok(CLEAR_BUDGET < PIXEL_BUDGET);
  assert.equal(budgetFor('gold'), PIXEL_BUDGET);
  assert.equal(budgetFor('theme'), PIXEL_BUDGET);
  assert.ok(pixelRatioFor(891, 594, 2, CLEAR_BUDGET) >= 1 && pixelRatioFor(891, 594, 2, CLEAR_BUDGET) < r);
});

test('settle: the clock starts once two frames in a row came in time – or after SETTLE_MAX', () => {
  const a = settle(0);
  assert.equal(a.step(450), false); // the GPU's first-use frame
  assert.equal(a.step(467), false);
  assert.equal(a.step(484), true);
  const b = settle(0);
  assert.equal(b.step(17), false);
  assert.equal(b.step(80), false); // a slow one in between starts over
  assert.equal(b.step(97), false);
  assert.equal(b.step(114), true);
  const c = settle(0);
  let t = 0, started = false;
  while (!started && t < 2000) started = c.step((t += 40)); // a computer that never comes in time
  assert.ok(started && t >= SETTLE_MAX && t < SETTLE_MAX + 40);
});

test('the scene is warmed before the launch: every pass and texture drawn once, at the plan\'s moments, invisibly', () => {
  const scene = src('web/lib/handheld/scene.mjs');
  const warm = scene.slice(scene.indexOf("await pause('warm')"), scene.indexOf("o.mark?.('warmed')"));
  assert.match(warm, /for \(const at of \[\.\.\.\(o\.warmAt \|\| \[\]\), 0\]\)/);
  assert.match(warm, /apply\(at\);[\s\S]*x\.visible = true[\s\S]*x\.frustumCulled = false[\s\S]*renderer\.render\(scene, cam\)/);
  assert.match(src('web/views/launchstage.mjs'), /warmAt: reduced \? \[\] : \[plan\.L \+ 40, plan\.power\[0\] \+ 200, plan\.H0 - 120, plan\.H0\]/);
  assert.match(scene, /if \(o\.pixelBudget\) renderer\.transmissionResolutionScale = 0\.5;/);
});

test('frameStats: max, p99, the counts over 20 and 33 ms', () => {
  assert.deepEqual(frameStats([]), { n: 0, max: 0, p99: 0, over20: 0, over33: 0, mean: 0 });
  const iv = [...Array(99).fill(16.7), 84];
  const st = frameStats(iv);
  assert.equal(st.n, 100);
  assert.equal(st.max, 84);
  assert.equal(st.p99, 16.7);
  assert.equal(st.over33, 1);
  assert.equal(st.over20, 1);
  assert.equal(frameStats([16, 25, 40, NaN, -1]).n, 3);
  assert.equal(frameStats([16, 25, 40]).over20, 2);
});

test('the trace is opt-in and never throws', () => {
  const had = globalThis.__launchTrace;
  delete globalThis.__launchTrace;
  assert.equal(traceWanted(), false);
  globalThis.__launchTrace = true;
  assert.equal(traceWanted(), true);
  if (had === undefined) delete globalThis.__launchTrace;
  else globalThis.__launchTrace = had;
});
