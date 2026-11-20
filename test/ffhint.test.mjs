// "Fast-forward is held back by the 3DS resolution" (support ticket #30, web/lib/ffhint.mjs): when the hint comes – a
// lasting shortfall in fast-forward at more than 1× resolution –, when it never does, and that it comes once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FfScaleWatch, FF_HINT, ffHintSession } from '../web/lib/ffhint.mjs';

const STEP = 2000; // the play view measures every 2 s
const fresh = () => new FfScaleWatch({ session: { shown: false } });
/** Feed samples every STEP ms from `t0`; returns the time of the first hit (or null) and the hit. */
function run(w, samples, opts = {}) {
  const { t0 = 0, target = 4, off = false } = opts;
  const scale = 'scale' in opts ? opts.scale : 3;
  let at = t0;
  for (const s of samples) {
    const o = typeof s === 'number' ? { reached: s } : s;
    const hit = w.add({ at, target, scale, off, ...o });
    if (hit) return { at, hit };
    at += STEP;
  }
  return { at: null, hit: null, next: at };
}
const times = (n, v) => Array(n).fill(v);

test('the ticket: 4× asked for, 1.1–3.3× reached at 3× – the hint comes once, after settling and ~10 s', () => {
  const w = fresh();
  const reached = [3.3, 1.1, 2.2, 1.6, 2.9, 1.4, 2.0, 3.1, 1.8, 2.4, 1.2, 2.6, 1.9, 2.1];
  const r = run(w, reached);
  assert.ok(r.hit, 'fires');
  assert.equal(r.hit.target, 4);
  assert.equal(r.hit.scale, 3);
  assert.ok(r.hit.reached > 1 && r.hit.reached < 2.8, String(r.hit.reached));
  // not before settling plus a full window – and not much later either (a 3.1× now and then doesn't keep it away)
  assert.ok(r.at >= FF_HINT.SETTLE_MS + FF_HINT.SUSTAIN_MS && r.at <= 20000, String(r.at));
  // …and never again in this session
  assert.equal(run(w, times(30, 1.5)).hit, null);
});

test('the threshold: below 70 % of the request counts, the AMD PC’s 3.99× of 4× never does', () => {
  assert.ok(run(fresh(), times(20, 4 * 0.69)).hit, '69 % fires');
  assert.equal(run(fresh(), times(40, 4 * 0.7)).hit, null, '70 % holds');
  assert.equal(run(fresh(), times(40, 3.99)).hit, null);
  assert.equal(run(fresh(), times(40, 2.2), { target: 3 }).hit, null, '2.2 of 3× is 73 %');
  assert.ok(run(fresh(), times(20, 1.3), { target: 2 }).hit, '1.3 of 2× is 65 %');
});

test('the sustain window: shorter stretches and a mostly good window don’t fire', () => {
  const w = fresh();
  // 6 s held back, then 6 s at full speed, over and over (a heavy area for a moment, scene changes)
  const wave = [...times(3, 1.5), ...times(3, 3.9)];
  assert.equal(run(w, [...wave, ...wave, ...wave, ...wave]).hit, null);
  // a mean below 70 % made by a few very slow samples while most are fine: not "held back"
  const lumpy = [];
  for (let i = 0; i < 30; i++) lumpy.push(i % 3 === 0 ? 0.6 : 3.2);
  assert.equal(run(fresh(), lumpy).hit, null);
  // exactly reaching the window: not one sample too early
  const w2 = fresh();
  const need = Math.ceil(FF_HINT.SETTLE_MS / STEP) + FF_HINT.SUSTAIN_MS / STEP;
  for (let i = 0; i < need; i++) assert.equal(w2.add({ at: i * STEP, target: 4, scale: 2, reached: 1.5 }), null, `sample ${i}`);
  assert.ok(w2.add({ at: need * STEP, target: 4, scale: 2, reached: 1.5 }));
});

test('loading and stalls start the window over instead of counting', () => {
  const w = fresh();
  // 8 s held back, a loading screen (the game nearly stands still), 8 s held back again: no 10 s in a row
  const r = run(w, [...times(6, 1.5), 0.2, 0.1, ...times(6, 1.5)]);
  assert.equal(r.hit, null);
  // a gap between samples (paused, the window hidden) starts it over too
  const w2 = fresh();
  let at = 0;
  for (let i = 0; i < 6; i++, at += STEP) assert.equal(w2.add({ at, target: 4, scale: 3, reached: 1.5 }), null);
  at += FF_HINT.MAX_GAP_MS + 1;
  for (let i = 0; i < 6; i++, at += STEP) assert.equal(w2.add({ at, target: 4, scale: 3, reached: 1.5 }), null, `after the gap ${i}`);
  // nonsense measures nothing and doesn't break the streak
  for (const x of [NaN, undefined, -1]) assert.equal(fresh().add({ at: 0, target: 4, scale: 3, reached: x }), null);
});

test('never at 1× resolution, never without fast-forward, never at “Max”, and a new request starts over', () => {
  for (const scale of [1, 0, undefined, NaN]) assert.equal(run(fresh(), times(40, 1.2), { scale }).hit, null, `scale ${scale}`);
  assert.equal(run(fresh(), times(40, 0.6), { target: 1 }).hit, null, '1×: not fast-forward (slowdown.mjs has that case)');
  assert.equal(run(fresh(), times(40, 1.5), { target: Infinity }).hit, null, '“Max” asks for no speed');
  // the speed changed every 8 s (4× → 3× → 4× …): each request gets its own window
  const w = fresh();
  let at = 0;
  for (let k = 0; k < 6; k++) {
    for (let i = 0; i < 4; i++, at += STEP) assert.equal(w.add({ at, target: k % 2 ? 3 : 4, scale: 3, reached: 1.2 }), null);
  }
  // fast-forward stopped in between (the play view resets): the streak is gone
  const w2 = fresh();
  for (let i = 0; i < 6; i++) w2.add({ at: i * STEP, target: 4, scale: 3, reached: 1.5 });
  w2.reset();
  assert.equal(w2.add({ at: 6 * STEP, target: 4, scale: 3, reached: 1.5 }), null);
});

test('once per session, and “Don’t show again” keeps it away', () => {
  const session = { shown: false };
  assert.ok(run(new FfScaleWatch({ session }), times(20, 1.5)).hit);
  assert.equal(session.shown, true);
  assert.equal(run(new FfScaleWatch({ session }), times(40, 1.5)).hit, null, 'another game in the same app session');
  assert.ok(run(new FfScaleWatch({ session: { shown: false } }), times(20, 1.5)).hit, 'the next app start');
  // switched off: never, and it isn't marked as shown either
  const s2 = { shown: false };
  assert.equal(run(new FfScaleWatch({ session: s2 }), times(40, 1.5), { off: true }).hit, null);
  assert.equal(s2.shown, false);
  // the default session is the module's own (shared by every game of this app session)
  assert.equal(new FfScaleWatch().session, ffHintSession);
});

test('wiring: the 3DS player says its resolution, the play view watches and logs it, the setting is stored and its texts exist', async () => {
  const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const ctr = src('web/lib/ctrplayer.mjs');
  assert.match(ctr, /scale: \(\) => st\.scale/);
  assert.match(ctr, /st\.scale = \[1, 2, 3\]\.includes\(j\.scale\)/, 'from the server’s answer to start');
  assert.match(ctr, /st\.scale = 1; \/\/ \(the safer renderer/, 'a renderer fallback plays at 1×');
  const play = src('web/views/play.mjs');
  assert.match(play, /new FfScaleWatch\(\)/);
  assert.match(play, /target\.system !== '3ds' \|\| ffHintOff/);
  assert.match(play, /scale: e\.scale\?\.\(\) \?\? 1/);
  assert.match(play, /diag\('perf', \{ type: 'ffScale'/, 'a diagnostics line when it fires');
  assert.match(play, /api\.post\('\/api\/config', \{ ctrFfHintOff: true \}\)/);
  assert.doesNotMatch(play, /ctrScale: /, 'the play view never changes the resolution');
  const dock = src('web/views/playdock.mjs');
  assert.match(dock, /settingsLink\('ctr-scale'\)/, '“Open Settings” lands on the resolution');
  assert.match(src('web/views/settings/play.mjs'), /save\(\{ ctrFfHintOff: !v \}\)/);
  const keys = ['play.ffScaleTitle', 'play.ffScaleShort', 'play.ffScaleWhy', 'play.ffScaleNever', 'set.ctrFfHint', 'set.ctrFfHintHint'];
  for (const lang of ['en', 'de', 'fr', 'es', 'it']) {
    const j = JSON.parse(src(`web/i18n/${lang}.json`));
    for (const k of keys) assert.ok(j[k], `${lang} ${k}`);
    for (const v of ['{n}', '{set}', '{scale}']) assert.ok(j['play.ffScaleWhy'].includes(v), `${lang} play.ffScaleWhy ${v}`);
  }

  // the server keeps only true / false
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'sls-ffhint-'));
  process.env.SLS_DATA_DIR = dir;
  const { startServer } = await import('../server/app.mjs');
  const { url, server } = await startServer({ port: 0, background: false });
  try {
    const H = { 'x-soullink': '1', 'content-type': 'application/json' };
    const post = (body) => fetch(`${url}/api/config`, { method: 'POST', headers: H, body: JSON.stringify(body) }).then((r) => r.json());
    const status = () => fetch(`${url}/api/status`, { headers: H }).then((r) => r.json());
    assert.equal((await status()).config.ctrFfHintOff, false, 'on by default');
    assert.equal((await post({ ctrFfHintOff: 'yes' })).ctrFfHintOff, false);
    await post({ ctrFfHintOff: true });
    assert.equal((await status()).config.ctrFfHintOff, true);
    await post({ ctrFfHintOff: false });
    assert.equal((await status()).config.ctrFfHintOff, false);
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
