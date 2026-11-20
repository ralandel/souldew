// The fast-forward sound of souldew's native hosts (native/ctr-host/ffsound.h – the 3DS host ctrhost.c and, since 2.8.2,
// the fast player's host retrohost.c with melonDS and the other native cores): the real C code, compiled with a small
// driver that plays a game whose speed swings – as a Windows player's Pokémon Y video showed it (2.8.x, 4× asked, the PC
// at ≈1.7–3.7×, the speed changing from frame to frame). Needs a C compiler (cc); skipped without one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const src = readFileSync(new URL('../native/ctr-host/ffsound.h', import.meta.url), 'utf8');
const cc = ['cc', 'clang', 'gcc'].find((c) => spawnSync(c, ['--version']).status === 0);

/** ffsound.h – it uses audio_buf / audio_n, send_msg and send_event from the file that includes it (the driver). */
function ffSection() {
  assert.ok(src.includes('static void ff_frame('), 'ffsound.h has ff_frame');
  return src;
}

const DRIVER = String.raw`
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdarg.h>
#include <math.h>
static int16_t *audio_buf;
static size_t audio_n, audio_cap;
static double now_t; // the driver's wall clock
static double out_frames; // output frames sent (message 3)
static void send_msg(uint32_t type, const void *p, uint32_t n) {
  (void)p;
  if (type == 3) {
    out_frames += n / 4.0;
    printf("o %.5f %.5f %u\n", now_t, out_frames, n / 4);
  }
}
static void send_event(const char *fmt, ...) {
  char b[256];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(b, sizeof b, fmt, ap);
  va_end(ap);
  printf("e %.5f %s\n", now_t, b);
}
@FF@
static uint32_t rnd = 12345;
static double urand(void) { rnd = rnd * 1103515245u + 12345u; return (rnd >> 8) / 16777216.0; }
int main(int argc, char **argv) {
  const double sr = 32728, fps = 59.83;
  const double base = atof(argv[1]), swing = atof(argv[2]), period = atof(argv[3]), jitter = atof(argv[4]), seconds = atof(argv[5]);
  const double start = argc > 6 ? atof(argv[6]) : 4; // the asked-for speed (16: "Max")
  const double stepAt = argc > 7 ? atof(argv[7]) : 1e9, after = argc > 8 ? atof(argv[8]) : 0; // the speed steps to after
  const size_t per = (size_t)(sr / fps); // samples per emulated frame
  audio_buf = calloc(per * 2, sizeof *audio_buf);
  ff_reset(start);
  double last = 0;
  int qlast = -1;
  while (now_t < seconds) {
    // the speed the game runs at now: a slow swing plus frame-to-frame jitter (some frames take far longer: a scene's
    // shaders, the picture going out)
    double sp = (now_t >= stepAt ? after : base) + swing * sin(2 * 3.14159265358979 * now_t / period);
    sp *= 1 + jitter * (urand() * 2 - 1);
    if (urand() < 0.01) sp *= 0.25;
    if (sp < 0.3) sp = 0.3;
    now_t += 1 / (fps * sp);
    for (size_t i = 0; i < per; i++) audio_buf[i * 2] = audio_buf[i * 2 + 1] = (int16_t)(8000 * sin(i * 0.05));
    audio_n = per * 2;
    ff_frame(now_t - last, sr);
    audio_n = 0;
    last = now_t;
    if ((int)(now_t * 10) != qlast) { // the queue: how late the sped-up sound comes (s), ten times a second
      qlast = (int)(now_t * 10);
      printf("q %.5f %.5f %u\n", now_t, ((double)ff.n - ff.pos) / ff.k / sr, ff.holes);
    }
  }
  printf("h %u\n", ff.holes);
  printf("s %u\n", ff.skips);
  return 0;
}
`;

const builds = new Map();
/** The driver around ffsound.h, compiled once per set of defines in front of it (`pre`: a host's own FF_TARGET). */
function build(pre = '') {
  if (builds.has(pre)) return builds.get(pre);
  const dir = mkdtempSync(join(tmpdir(), 'souldew-ff-'));
  const c = join(dir, 'ff.c');
  writeFileSync(c, DRIVER.replace('@FF@', pre + ffSection()));
  const exe = join(dir, 'ff');
  const r = spawnSync(cc, ['-O2', '-std=c11', '-o', exe, c, '-lm'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `the fast-forward section compiles on its own:\n${r.stderr}`);
  const b = { dir, exe };
  builds.set(pre, b);
  return b;
}
test.after(() => {
  for (const b of builds.values()) rmSync(b.dir, { recursive: true, force: true });
});

/** Runs the driver; returns the ratio in use over time ([t, k]), the output's pace and the times the queue ran dry. */
function run({ base, swing, period, jitter, seconds, start = 4, pre = '', stepAt = 1e9, after = 0 }) {
  const { exe } = build(pre);
  const r = spawnSync(exe, [base, swing, period, jitter, seconds, start, stepAt, after].map(String), { encoding: 'utf8', maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, r.stderr);
  const ks = [[0, start]];
  const outs = [];
  const queue = [];
  let holes = 0;
  let skips = 0;
  for (const line of r.stdout.split('\n')) {
    const p = line.split(' ');
    if (p[0] === 'e' && line.includes('"ffrate"')) ks.push([+p[1], +/"k":([\d.]+)/.exec(line)[1]]);
    else if (p[0] === 'o') outs.push([+p[1], +p[2]]);
    else if (p[0] === 'q') queue.push([+p[1], +p[2], +p[3]]);
    else if (p[0] === 'h') holes = +p[1];
    else if (p[0] === 's') skips = +p[1];
  }
  return { ks, outs, queue, holes, skips };
}

/** The ratio at time t (the last one announced before it). */
const kAt = (ks, t) => {
  let k = ks[0][1];
  for (const [at, v] of ks) {
    if (at > t) break;
    k = v;
  }
  return k;
};
const cents = (a, b) => 1200 * Math.log2(a / b);

test('3DS fast-forward sound: a speed that swings from frame to frame doesn’t make the pitch warble (Pokémon Y video, 2.8.x)', { skip: !cc && 'no C compiler' }, () => {
  // the video: 4× asked, ≈1.7–3.7× reached; the sped-up sound ("Sped-up original", "Plain") warbled by about a
  // semitone, up and down every second or so, as the ratio followed every swing
  const { ks, outs, holes } = run({ base: 2.6, swing: 0.9, period: 1.6, jitter: 0.35, seconds: 40 });
  // how far the pitch moves within any half second, after the first 5 s (the ratio settling from the asked-for 4×)
  // (until 2.8.1: 900–1300 cents most of the time in this simulation; a rare hole may still jump once. The first 2.8.2
  // builds kept up to 0.45 s of queue for this and moved ~50 cents at the 95th percentile – now at most 0.2 s, so the
  // sped-up sound stays within 0.3 s of the picture: ~75–90)
  const moves = [];
  for (let t = 5; t < 39.5; t += 0.05) {
    let lo = Infinity;
    let hi = 0;
    for (let s = t; s <= t + 0.5; s += 0.01) {
      const k = kAt(ks, s);
      lo = Math.min(lo, k);
      hi = Math.max(hi, k);
    }
    moves.push(cents(hi, lo));
  }
  moves.sort((a, b) => a - b);
  const p50 = moves[Math.floor(moves.length / 2)];
  const p95 = moves[Math.floor(moves.length * 0.95)];
  assert.ok(p50 < 40 && p95 < 95, `the pitch moves ${p50.toFixed(0)} cents within half a second, ${p95.toFixed(0)} at most 1 time in 20 (a semitone is 100)`);
  // still exactly real time, without holes: the output keeps pace with the clock
  const late = outs.filter(([t]) => t > 5).map(([t, n]) => t - n / 32728);
  const drift = Math.max(...late) - Math.min(...late);
  assert.ok(drift < 0.6, `the output keeps pace with real time (it drifts ${drift.toFixed(2)} s)`);
  assert.ok(holes <= 2, `the queue ran dry ${holes} times`);
});

test('3DS fast-forward sound: the ratio still follows a lasting change of speed (4× asked, 1.8× reached) – no holes, no lag that grows', { skip: !cc && 'no C compiler' }, () => {
  const { ks, outs, holes } = run({ base: 1.8, swing: 0, period: 1, jitter: 0.1, seconds: 20 });
  const k = kAt(ks, 19.9);
  assert.ok(Math.abs(k / 1.8 - 1) < 0.06, `the ratio settles at the real speed (${k.toFixed(2)})`);
  const settled = ks.find(([, v]) => Math.abs(v / 1.8 - 1) < 0.1);
  assert.ok(settled && settled[0] < 6, `it gets there within seconds (${settled?.[0].toFixed(1)} s)`);
  const late = outs.filter(([t]) => t > 6).map(([t, n]) => t - n / 32728);
  assert.ok(Math.max(...late) - Math.min(...late) < 0.3, 'then the output keeps pace with real time');
  assert.ok(holes <= 3, `the queue ran dry ${holes} times`);
});

test('both native hosts use the shared fast-forward sound – the fast player’s host no longer drops whole frames or jumps its ratio', () => {
  const host = (f) => readFileSync(new URL(`../native/${f}`, import.meta.url), 'utf8');
  const ctr = host('ctr-host/ctrhost.c');
  assert.ok(ctr.includes('#include "ffsound.h"'), 'ctrhost.c includes ffsound.h');
  assert.ok(/ff_reset\(turbo \?/.test(ctr) && ctr.includes('ff_frame(t - last_audio, sample_rate)'), 'ctrhost.c resets it at each switch and feeds it every fast-forwarded frame');
  assert.ok(ctr.includes('ffrate'), 'ctrhost.c announces the ratio at the switch');
  // 3.0: the fast player's host and the souldew engine (the link host) send their sound through native/common/ffaudio.c,
  // which is ffsound.h
  const common = host('common/ffaudio.c');
  assert.ok(common.includes('#include "../ctr-host/ffsound.h"'), 'common/ffaudio.c includes ffsound.h');
  assert.ok(/ff_reset\(turbo \?/.test(common) && common.includes('ff_frame(now - fa->last, fa->rate)'), 'common/ffaudio.c resets it at each switch and feeds it every fast-forwarded frame');
  assert.ok(common.includes('ffrate'), 'common/ffaudio.c announces the ratio at the switch');
  assert.ok(host('retro-host/retrohost.c').includes('ffa_frame(&ffa, audio_buf, audio_n / 2, turbo, speed, t)'), 'retrohost.c sends every frame through it');
  assert.ok(host('link-host/avout.c').includes('ffa_frame(&ffa, snd, have, turbo, asked, now)'), 'the link host too');
  assert.ok(host('retro-host/retrohost.c').includes('ffa_idle('), 'retrohost.c: a pause is no time the sound owes');
  assert.ok(host('link-host/linkhost.c').includes('avout_idle('), 'linkhost.c: a pause is no time the sound owes');
  // (until 2.8.1 retrohost.c – and 3.0's ffaudio.c until the merge of 2.8.3 – averaged each frame down by the speed
  // measured every 0.25 s and left out whole frames of sound once it came out ahead of real time)
  for (const f of ['retro-host/retrohost.c', 'common/ffaudio.c']) assert.ok(!/speed_up|ff_budget|budget/.test(host(f)), `no frame-dropping speed-up left in ${f}`);
  const page = readFileSync(new URL('../web/lib/nativeplayer.mjs', import.meta.url), 'utf8');
  assert.ok(/e\.event === 'ffrate'[\s\S]{0,160}type: 'rate', ratio: e\.k, exact: true, inband: true/.test(page), 'the fast player hands the host’s ratio to the mixer, in band');
});

test('fast-forward sound at "Max" (a PC that reaches ~9×): the ratio comes down from 16× and holds, without holes', { skip: !cc && 'no C compiler' }, () => {
  const { ks, holes } = run({ base: 9, swing: 1, period: 2, jitter: 0.2, seconds: 20, start: 16 });
  const k = kAt(ks, 19.9);
  assert.ok(Math.abs(k / 9 - 1) < 0.12, `the ratio settles near the real speed (${k.toFixed(2)})`);
  assert.ok(holes <= 2, `the queue ran dry ${holes} times`);
});

test('fast player (retrohost.c, melonDS): its shallower queue keeps the pitch steady too, and the sped-up sound close to the picture', { skip: !cc && 'no C compiler' }, () => {
  // (3.0: the fast player's host and the souldew engine take it from native/common/ffaudio.c)
  const retro = readFileSync(new URL('../native/common/ffaudio.c', import.meta.url), 'utf8');
  const target = /#define FF_TARGET ([\d.]+)\s*\n#include "\.\.\/ctr-host\/ffsound.h"/.exec(retro)?.[1];
  assert.ok(target && +target <= 0.3, `common/ffaudio.c keeps at most 0.3 s in the queue (${target})`);
  const pre = `#define FF_TARGET ${target}\n`;
  // a DS player: "the audio gets desynced when fast-forwarding". Until 2.8.1 the ratio jumped every quarter second to the
  // measured speed (here: 670 cents per half second, 1160 at the 95th percentile) and 3 % of the frames' sound was left out
  const { ks, outs, holes } = run({ base: 2.6, swing: 0.9, period: 1.6, jitter: 0.35, seconds: 40, pre });
  const moves = [];
  for (let t = 5; t < 39.5; t += 0.05) {
    let lo = Infinity;
    let hi = 0;
    for (let x = t; x <= t + 0.5; x += 0.01) {
      const k = kAt(ks, x);
      lo = Math.min(lo, k);
      hi = Math.max(hi, k);
    }
    moves.push(cents(hi, lo));
  }
  moves.sort((a, b) => a - b);
  const p50 = moves[Math.floor(moves.length / 2)];
  const p95 = moves[Math.floor(moves.length * 0.95)];
  assert.ok(p50 < 45 && p95 < 95, `the pitch moves ${p50.toFixed(0)} cents within half a second (${p95.toFixed(0)} at the 95th percentile)`);
  assert.ok(holes <= 2, `the queue ran dry ${holes} times`);
  // the sound never trails the picture by more than the queue: the output keeps pace with real time
  const late = outs.filter(([t]) => t > 5).map(([t, n]) => t - n / 32728);
  assert.ok(Math.max(...late) - Math.min(...late) < 0.35, 'the output keeps pace with real time (no lag that grows)');
});

test('the queue is only as deep as the speed makes it swing: a steady 4× keeps ~0.12 s (until 2.8.2: 0.45 s at any speed)', { skip: !cc && 'no C compiler' }, () => {
  const late = (queue) => {
    const v = queue.filter(([t]) => t > 25).map(([, q]) => q);
    return v.reduce((x, y) => x + y, 0) / v.length;
  };
  const steady = run({ base: 3.9, swing: 0.1, period: 3, jitter: 0.1, seconds: 40 });
  assert.ok(late(steady.queue) < 0.16, `steady 4×: the sped-up sound ${(late(steady.queue) * 1000).toFixed(0)} ms behind the picture`);
  assert.equal(steady.holes, 0);
  // the Pokémon Y video's swinging speed still gets a deep queue (its pitch: the first test), just not deeper than needed
  const swinging = run({ base: 2.6, swing: 0.9, period: 1.6, jitter: 0.35, seconds: 40 });
  const q = late(swinging.queue);
  assert.ok(q > 0.15 && q < 0.33, `swinging: ${(q * 1000).toFixed(0)} ms`);
});

test('the sped-up sound stays close to the picture when the game gets faster: at most ~0.3 s behind, only for a moment (until 2.8.2: seconds)', { skip: !cc && 'no C compiler' }, () => {
  // the review of 2.8.2: k followed a step up over 5 s and the queue only skipped above 16× – the sped-up sound trailed
  // the picture by 1.5 s after 2× → 8× and by ~5 s after 2× → 30× (and stayed > 0.5 s behind for the next 20 s)
  for (const [base, after, start] of [[2, 8, 8], [1.7, 3.7, 4], [1.5, 14, 16], [3, 12, 16], [2, 30, 16]]) {
    const { queue, skips } = run({ base, swing: 0, period: 1, jitter: 0.1, seconds: 25, start, stepAt: 10, after });
    const holes = queue.at(-1)[2] - queue.find(([t]) => t > 10)[2]; // (after the step – the start from the asked-for speed has its own)
    const late = queue.filter(([t]) => t > 10).map(([, q]) => q);
    const worst = Math.max(...late);
    const over = late.filter((q) => q > 0.25).length * 0.1; // (sampled ten times a second)
    const settled = queue.filter(([t]) => t > 20).map(([, q]) => q);
    const mean = settled.reduce((a, b) => a + b, 0) / settled.length;
    const what = `${base}× → ${after}×: up to ${(worst * 1000).toFixed(0)} ms behind, > 0.25 s for ${over.toFixed(1)} s, then ${(mean * 1000).toFixed(0)} ms (${skips} skips, ${holes} holes)`;
    assert.ok(worst < 0.36, what);
    assert.ok(over <= 0.5, what);
    assert.ok(mean < (after > 16 ? 0.25 : 0.17), what);
    assert.ok(holes <= 3, what);
    if (after <= 16) assert.ok(skips <= 15, `${what} – k follows, the queue doesn't keep skipping`);
  }
  // slower again: smooth, never deep
  const down = run({ base: 8, swing: 0, period: 1, jitter: 0.1, seconds: 25, start: 8, stepAt: 10, after: 2 });
  assert.ok(Math.max(...down.queue.filter(([t]) => t > 10).map(([, q]) => q)) < 0.25);
  assert.equal(down.skips, 0);
});

// a tone sped up at "Max" (the sound at the 16× FF_MAXK) – its output, int16 stereo
const ALIAS_DRIVER = String.raw`
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdarg.h>
#include <math.h>
static int16_t *audio_buf;
static size_t audio_n;
static FILE *outf;
static void send_msg(uint32_t type, const void *p, uint32_t n) { if (type == 3) fwrite(p, 1, n, outf); }
static void send_event(const char *fmt, ...) { (void)fmt; }
@FF@
int main(int argc, char **argv) {
  const double sr = 32728, fps = 59.83, sp = atof(argv[1]), hz = atof(argv[2]), seconds = atof(argv[3]);
  outf = fopen(argv[4], "wb");
  const size_t per = (size_t)(sr / fps);
  audio_buf = calloc(per * 2, sizeof *audio_buf);
  ff_reset(sp > FF_MAXK ? FF_MAXK : sp);
  double now = 0, last = 0;
  long idx = 0;
  while (now < seconds) {
    now += 1 / (fps * sp);
    for (size_t i = 0; i < per; i++, idx++) audio_buf[i * 2] = audio_buf[i * 2 + 1] = (int16_t)(16000 * sin(2 * 3.14159265358979 * hz * idx / sr));
    audio_n = per * 2;
    ff_frame(now - last, sr);
    audio_n = 0;
    last = now;
  }
  fclose(outf);
  return 0;
}
`;

/** Magnitude spectrum (Blackman-Harris, 2^15 points, re. the tone's amplitude) of the middle of an int16 stereo file. */
function spectrum(file) {
  const b = readFileSync(file);
  const s = new Int16Array(b.buffer, b.byteOffset, b.length >> 1);
  const N = 32768;
  const from = (s.length >> 2) - N / 2;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let wsum = 0;
  for (let i = 0; i < N; i++) {
    const x = (2 * Math.PI * i) / (N - 1);
    const w = 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x);
    re[i] = (s[(from + i) * 2] / 16000) * w;
    wsum += w;
  }
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [re[i], re[j]] = [re[j], re[i]];
  }
  for (let len = 2; len <= N; len <<= 1) {
    for (let i = 0; i < N; i += len) {
      for (let j = 0; j < len / 2; j++) {
        const a = (-2 * Math.PI * j) / len;
        const [wr, wi] = [Math.cos(a), Math.sin(a)];
        const [p, q] = [i + j, i + j + len / 2];
        const vr = re[q] * wr - im[q] * wi;
        const vi = re[q] * wi + im[q] * wr;
        [re[q], im[q]] = [re[p] - vr, im[p] - vi];
        [re[p], im[p]] = [re[p] + vr, im[p] + vi];
      }
    }
  }
  return Array.from({ length: N / 2 }, (_, i) => (2 * Math.hypot(re[i], im[i])) / wsum);
}

test('fast-forward sound at "Max" (16×) is clean: what is sped up past the new Nyquist frequency doesn’t fold back (until 2.8.2: aliases at −28 to −49 dB)', { skip: !cc && 'no C compiler' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'souldew-ffa-'));
  try {
    const c = join(dir, 'a.c');
    writeFileSync(c, ALIAS_DRIVER.replace('@FF@', ffSection()));
    const exe = join(dir, 'a');
    const r = spawnSync(cc, ['-O2', '-std=c11', '-o', exe, c, '-lm'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const SR = 32728;
    // (the game at 16×, the sound at FF_MAXK. Faster than that the queue skips ahead every half second or so, crossfaded –
    // that it stays close to the picture there is the step-up test's)
    const k = 16;
    const peak = (hz) => {
      const f = join(dir, 'out.raw');
      assert.equal(spawnSync(exe, ['16', String(hz), '8', f]).status, 0);
      const m = spectrum(f);
      let p = 0;
      for (let i = 4; i < m.length; i++) p = Math.max(p, m[i]);
      return 20 * Math.log10(Math.max(p, 1e-9));
    };
    // in the passband: a game tone that ends up at 2 / 6 / 10 kHz comes out whole
    for (const out of [2000, 6000, 10000]) assert.ok(peak(out / k) > -1.5, `${out} Hz sped up: ${peak(out / k).toFixed(1)} dB`);
    // past the new Nyquist frequency (16.4 kHz): gone, not folded back down (2.8.1: −28 dB at 16 kHz, −42 at 8 kHz, −49 at 3 kHz)
    for (const out of [1.03, 1.1, 1.25, 1.5, 1.8, 2.3, 3].map((x) => x * (SR / 2))) {
      const db = peak(out / k);
      assert.ok(db < -70, `a tone sped up to ${(out / 1000).toFixed(1)} kHz folds back at ${db.toFixed(1)} dB`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
