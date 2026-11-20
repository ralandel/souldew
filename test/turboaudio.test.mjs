import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioRing, TurboMixer, coarseLag, refineLag, runAll } from '../web/lib/turboaudio.mjs';

const SR = 16000;
const BLOCK = 128;

// A little tune: sine notes with soft attack/decay on a 0.2 s grid, the whole pattern repeating exactly
// every `period` seconds – like a town theme. `seed` picks the notes.
function tune({ period = 6.4, seed = 1, gain = 0.3 } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const step = Math.round(0.2 * SR);
  const steps = Math.round((period * SR) / step);
  const notes = Array.from({ length: steps }, () => 220 * 2 ** (Math.floor(rnd() * 15) / 12));
  const loud = Array.from({ length: steps }, () => 0.4 + rnd() * 0.6);
  const P = steps * step;
  return (t) => {
    const p = ((t % P) + P) % P;
    const k = Math.floor(p / step);
    const x = (p - k * step) / SR;
    const env = Math.min(1, x / 0.005) * Math.exp(-x * 6);
    return gain * loud[k] * env * Math.sin(2 * Math.PI * notes[k] * x);
  };
}

/** Feeds `seconds` of input (fn(t) per absolute sample t, or null for no input) and returns the output. */
function feed(mixer, fn, from, seconds) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const l = new Float32Array(BLOCK);
  const oL = new Float32Array(BLOCK);
  const oR = new Float32Array(BLOCK);
  for (let i = 0; i < n; i += BLOCK) {
    if (fn) for (let j = 0; j < BLOCK; j++) l[j] = fn(from + i + j);
    mixer.process(fn ? l : null, null, oL, oR, BLOCK);
    out.set(oL.subarray(0, Math.min(BLOCK, n - i)), i);
  }
  return out;
}

/** The sped-up sound RetroArch plays at `ratio` (audio_fastforward_speedup) for the music f. */
const sped = (f, ratio, from = 0) => (i) => f(from + ratio * i);
// sound during fast-forward that is no music the tests care about, but no silence either
const junk = (i) => 0.3 * Math.sin(i * 0.37) * Math.sin(i * 0.011);
/** Correlation of out[a..b) with f(t0 + i). */
function corr(out, f, t0, a, b) {
  let xy = 0;
  let xx = 0;
  let yy = 0;
  for (let i = a; i < b; i++) {
    const y = f(t0 + i);
    xy += out[i] * y;
    xx += out[i] * out[i];
    yy += y * y;
  }
  return xy / Math.sqrt(xx * yy || 1);
}
/** The most out[a..b) differs from fn(i) – 0: the input as it came (the game's own sound, sped up in fast-forward). */
function off(out, fn, a = 0, b = out.length) {
  let d = 0;
  for (let i = a; i < b; i++) d = Math.max(d, Math.abs(out[i] - fn(i)));
  return d;
}
/** Best correlation of out[a..b) with f, f shifted by back … ahead samples (a song at normal pitch, wherever it is). */
function bestCorr(out, f, a, b, { back = 0, ahead = 0, step = 1 } = {}) {
  let best = -1;
  for (let k = -back; k <= ahead; k += step) best = Math.max(best, corr(out, f, k, a, b));
  return best;
}
/** The last n samples the mixer recorded (its ring, mono) – in fast-forward the sped-up sound slowed back down. */
function recorded(m, n) {
  return m.ring.mono(m.ring.written - n, n);
}
const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
const maxJump = (a) => {
  let m = 0;
  for (let i = 1; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - a[i - 1]));
  return m;
};

test('AudioRing keeps the newest samples and wraps around', () => {
  const ring = new AudioRing(10);
  ring.push(Float32Array.from([1, 2, 3, 4, 5, 6, 7]));
  ring.push(Float32Array.from([8, 9, 10, 11, 12, 13, 14]), Float32Array.from([8, 9, 10, 11, 12, 13, 14]).map((x) => -x));
  assert.equal(ring.written, 14);
  assert.equal(ring.oldest, 4);
  assert.ok(ring.has(4, 14));
  assert.ok(!ring.has(3, 14));
  assert.ok(!ring.has(5, 15));
  assert.deepEqual([...ring.mono(4, 3)], [5, 6, 7]); // left = right in the first push
  assert.deepEqual([...ring.mono(10, 4)], [0, 0, 0, 0]); // left = −right in the second
  ring.push(new Float32Array(25).map((_, i) => i));
  assert.equal(ring.written, 39);
  assert.deepEqual([...ring.mono(29, 10)], [15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
});

test('coarseLag finds the period of a repeating envelope and prefers the longest match', () => {
  let s = 7;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pattern = Array.from({ length: 37 }, () => rnd() * 3);
  const n = 300;
  const fe = Float32Array.from({ length: n }, (_, i) => pattern[i % 37] + rnd() * 0.05);
  const fd = Float32Array.from({ length: n }, (_, i) => pattern[(i + 5) % 37] * 0.5);
  const res = runAll(coarseLag([fe, fd], n, { minLag: 20, win: 40 }));
  assert.ok(res.score > 0.95, `score ${res.score}`);
  assert.equal(res.lag % 37, 0);
  assert.equal(res.lag, 37 * Math.floor((n - 40) / 37)); // the longest multiple that fits
});

test('coarseLag gives up on a flat envelope', () => {
  const flat = new Float32Array(200).fill(-2);
  assert.equal(runAll(coarseLag([flat, flat], 200, { minLag: 20, win: 40 })), null);
});

test('refineLag aligns a coarse guess to the sample', () => {
  const f = tune({ period: 3.2 });
  const ring = new AudioRing(SR * 20);
  const block = new Float32Array(SR * 12);
  for (let i = 0; i < block.length; i++) block[i] = f(i);
  ring.push(block);
  const P = 3.2 * SR;
  const res = runAll(refineLag(ring, ring.written, P - 300));
  assert.equal(res.lag, P);
  assert.ok(res.corr > 0.99);
});

test('music mode: fast-forward continues the recorded tune seamlessly, then hands back to the game', () => {
  const f = tune({ period: 6.4 });
  const m = new TurboMixer(SR, { seconds: 30 });
  let t = 0;
  const pre = feed(m, f, t, 16);
  t += pre.length;
  assert.ok(m.found, 'a loop was found while playing at 1×');
  assert.equal(m.found.lag % (6.4 * SR), 0, `lag ${m.found.lag}`);
  m.command({ type: 'speed', ratio: 3 });
  // the game's own sound is now the same tune, sped up (RetroArch's audio_fastforward_speedup)
  const during = feed(m, sped(f, 3, t), 0, 8);
  // after the 80 ms crossfade the output is exactly how the tune goes on
  const from = Math.round(0.1 * SR);
  let err = 0;
  for (let i = from; i < during.length; i++) err = Math.max(err, Math.abs(during[i] - f(t + i)));
  assert.ok(err < 1e-3, `max deviation ${err}`);
  assert.ok(maxJump(during) < 0.2, 'no click at the switch');
  assert.equal(m.playing().src, 'loop', 'still the recorded loop – the same song was recognised');
  t += during.length;
  m.command({ type: 'speed', ratio: 1 });
  const back = feed(m, f, t, 1);
  // hold (0.15 s) + crossfade (0.08 s), then the game's sound again
  const live = Math.round(0.25 * SR);
  for (let i = live; i < back.length; i++) assert.ok(Math.abs(back[i] - f(t + i)) < 1e-6);
  assert.ok(maxJump(back) < 0.2, 'no click when switching back');
  assert.equal(m.voice, null);
});

test('mute mode silences fast-forward and fades back in', () => {
  const f = tune();
  const m = new TurboMixer(SR, { seconds: 30 });
  m.command({ type: 'mode', mode: 'mute' });
  feed(m, f, 0, 10);
  m.command({ type: 'speed', ratio: 2 });
  const during = feed(m, f, 0, 2);
  assert.ok(rms(during.subarray(Math.round(0.1 * SR))) === 0);
  assert.ok(maxJump(during) < 0.2);
  m.command({ type: 'speed', ratio: 1 });
  const back = feed(m, f, 0, 1);
  assert.ok(rms(back.subarray(0, Math.round(0.14 * SR))) === 0, 'stays quiet while sped-up sound drains');
  assert.ok(rms(back.subarray(Math.round(0.3 * SR))) > 0.05);
});

test('original mode passes the sped-up sound through', () => {
  const f = tune();
  const m = new TurboMixer(SR, { seconds: 30 });
  m.command({ type: 'mode', mode: 'original' });
  feed(m, f, 0, 8);
  m.command({ type: 'speed', ratio: 4 });
  const during = feed(m, f, 1000, 1);
  for (let i = 0; i < during.length; i++) assert.ok(Math.abs(during[i] - f(1000 + i)) < 1e-6);
});

test('nothing recorded for the song (fresh start): "Music continues" plays the game’s own sped-up sound – in step, no silence first', () => {
  // (a DS ROM hack in the fast player, 2.8.3: a moment of silence, then the game's sound at its normal speed while the
  // picture raced – up to a second late, skipping ahead in pieces – then a jump back when fast-forward ended)
  const m = new TurboMixer(SR, { seconds: 30 });
  feed(m, tune(), 0, 3);
  m.command({ type: 'speed', ratio: 3 });
  const f = tune({ seed: 9 });
  const during = feed(m, sped(f, 3), 0, 2);
  assert.ok(off(during, sped(f, 3)) < 1e-6, 'the sped-up sound as it comes, from the first sample');
  assert.equal(m.playing().src, 'game');
  assert.equal(m.carry, null);
  m.command({ type: 'speed', ratio: 1 });
  const back = feed(m, f, 6 * SR, 1);
  assert.ok(off(back, (i) => f(6 * SR + i)) < 1e-6, 'and back at 1× the game goes on – nothing to hand back');
});

test('a long silence (area change) drops the old music', () => {
  const m = new TurboMixer(SR, { seconds: 30 });
  let t = 0;
  t += feed(m, tune({ seed: 1 }), t, 14).length;
  assert.ok(m.found, 'the old song had a loop');
  t += feed(m, () => 0, t, 1).length;
  feed(m, tune({ seed: 5 }), t, 3);
  m.command({ type: 'speed', ratio: 3 });
  const f = tune({ seed: 9 });
  const during = feed(m, sped(f, 3), 0, 2);
  assert.ok(off(during, sped(f, 3)) < 1e-6, 'the new music as the game plays it, not the old loop');
});

test('the music changes during fast-forward → the old loop stops, the new song plays on as the game plays it', () => {
  const A = tune({ seed: 1, period: 6.4 });
  const B = tune({ seed: 7, period: 4 });
  const m = new TurboMixer(SR, { seconds: 60 });
  let t = 0;
  t += feed(m, A, t, 16).length;
  m.command({ type: 'speed', ratio: 3 });
  // still song A (sped up): the loop goes on exactly as A does
  const a = feed(m, sped(A, 3, t), 0, 2);
  assert.ok(corr(a, A, t, Math.round(0.2 * SR), a.length) > 0.99);
  // a door: 0.5 s of silence in the sped-up sound (1.5 s in the game), then song B
  const quiet = feed(m, () => 0, 0, 0.5);
  assert.ok(rms(quiet.subarray(quiet.length - Math.round(0.05 * SR))) < 1e-3, 'old loop faded out');
  const b = feed(m, sped(B, 3), 0, 6);
  // song B has nothing recorded at 1×: the game's own sped-up sound, music and effects, in step with the picture (until
  // 2.8.1 B's loop was searched in the slowed-down recording – a few seconds of raced-through sound on repeat; until
  // 2.8.3 B was "streamed": at its normal speed, up to a second late, skipping ahead in pieces)
  assert.ok(off(b, sped(B, 3)) < 1e-6, 'song B as the game plays it, right away');
  assert.equal(m.carry, null);
  assert.ok(maxJump(b) < 0.2, 'no clicks');
});

test('short 1× stretches between fast-forwards reuse the previous loop', () => {
  const f = tune({ period: 6.4 });
  const m = new TurboMixer(SR, { seconds: 30 });
  feed(m, f, 0, 16);
  m.command({ type: 'speed', ratio: 3 });
  feed(m, junk, 0, 2);
  m.command({ type: 'speed', ratio: 1 });
  feed(m, f, 50000, 2); // only 2 s at 1× – not enough for a loop of its own
  m.command({ type: 'speed', ratio: 3 });
  const during = feed(m, junk, 0, 2);
  assert.ok(rms(during.subarray(Math.round(0.1 * SR))) > 0.03);
});

test('pausing during fast-forward fades the loop out, resuming fades it back in', () => {
  const m = new TurboMixer(SR, { seconds: 30 });
  feed(m, tune(), 0, 16);
  m.command({ type: 'speed', ratio: 3 });
  feed(m, junk, 0, 0.5);
  m.command({ type: 'paused', paused: true });
  const paused = feed(m, null, 0, 1);
  assert.equal(rms(paused.subarray(Math.round(0.1 * SR))), 0);
  assert.ok(maxJump(paused) < 0.2);
  m.command({ type: 'paused', paused: false });
  const resumed = feed(m, junk, 0, 1);
  assert.ok(rms(resumed.subarray(Math.round(0.1 * SR))) > 0.03);
});

test('no sound from the core at all – nothing breaks', () => {
  const m = new TurboMixer(SR, { seconds: 30 });
  const out = feed(m, null, 0, 6);
  assert.equal(rms(out), 0);
  m.command({ type: 'speed', ratio: 3 });
  assert.equal(rms(feed(m, null, 0, 1)), 0);
  m.command({ type: 'speed', ratio: 1 });
  assert.equal(rms(feed(m, null, 0, 1)), 0);
});

test('switching the mode during fast-forward takes effect right away, without clicks', () => {
  const m = new TurboMixer(SR, { seconds: 30 });
  m.command({ type: 'mode', mode: 'mute' });
  feed(m, tune(), 0, 16);
  m.command({ type: 'speed', ratio: 2 });
  assert.equal(rms(feed(m, junk, 0, 0.5).subarray(Math.round(0.1 * SR))), 0);
  m.command({ type: 'mode', mode: 'music' });
  const music = feed(m, junk, 0, 1);
  assert.ok(rms(music.subarray(Math.round(0.1 * SR))) > 0.03);
  assert.ok(maxJump(music) < 0.2);
  m.command({ type: 'mode', mode: 'original' });
  const orig = feed(m, (i) => 0.1 * Math.sin(i * 0.05), 0, 0.5);
  for (let i = Math.round(0.1 * SR); i < orig.length; i++) assert.ok(Math.abs(orig[i] - 0.1 * Math.sin(i * 0.05)) < 1e-6);
});

test('a loaded state forgets the recording', () => {
  const m = new TurboMixer(SR, { seconds: 30 });
  feed(m, tune(), 0, 16);
  m.command({ type: 'cut' });
  feed(m, tune({ seed: 4 }), 0, 2);
  m.command({ type: 'speed', ratio: 3 });
  assert.equal(rms(feed(m, null, 0, 1).subarray(Math.round(0.1 * SR))), 0);
});

// ---- long fast-forwards without a loop: the game's sound stays in step --------------------------------------------
// 2.8.0 played a song with nothing recorded "streamed" (slowed back down) and skipped ahead only at half the ring: a
// player on Pokémon Black heard menu sounds long after pressing the button in "Music continues". 2.8.1–2.8.3 kept the
// stream within a second of the game – still late, and in pieces (a DS ROM hack on Linux: "the sound doesn't
// fast-forward and then desyncs"). Now that song is the game's own sped-up sound: a menu sound comes with the picture.

/** Magnitude of `hz` in out[a..a+n) (Goertzel), as the amplitude of a sine. */
function toneAt(out, hz, a, n) {
  const c = 2 * Math.cos((2 * Math.PI * hz) / SR);
  let s1 = 0;
  let s2 = 0;
  for (let i = a; i < a + n; i++) [s1, s2] = [out[i] + c * s1 - s2, s1];
  return (2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2))) / n;
}

for (const ratio of [2, 4, 8]) {
  test(`"Music continues", a long fast-forward at ${ratio}× with nothing recorded: every menu sound right when the game makes it`, () => {
    const m = new TurboMixer(SR, { seconds: 10 }); // (32–64 s of game time through a 10 s ring)
    const f = tune({ seed: 3, period: 600 });
    feed(m, f, 0, 3);
    m.command({ type: 'speed', ratio });
    // a menu sound every 2 s of real time, 0.2 s of it; sped up with the game
    const BLIP = 700;
    const every = 2 * SR;
    const blipLen = Math.round(0.2 * SR);
    const game = (i) => f(3 * SR + ratio * i) + (i % every < blipLen ? 0.2 * Math.sin((2 * Math.PI * BLIP * ratio * i) / SR) : 0);
    const out = feed(m, game, 0, 30);
    assert.ok(off(out, game) < 1e-6, 'the game’s own sped-up sound, sample for sample');
    const W = Math.round(0.02 * SR);
    for (let s0 = every; s0 + every <= out.length; s0 += every) {
      assert.ok(toneAt(out, BLIP * ratio, s0 + W, W) > 0.1, `menu sound at ${(s0 / SR).toFixed(0)} s heard right away`);
      assert.ok(toneAt(out, BLIP * ratio, s0 - 2 * W, W) < 0.02, `… and not before`);
    }
    assert.equal(m.playing().src, 'game');
  });
}

test('3DS without a track from the ROM: "Music continues" plays the host’s sped-up sound as it comes – its own sound is only listened to', () => {
  const f = tune({ seed: 9, period: 600 });
  const m = new TurboMixer(SR);
  feed(m, () => 0, 0, 1);
  m.command({ type: 'speed', ratio: 4 });
  m.command({ type: 'rate', ratio: 4, exact: true });
  const out = feedHost(m, ctrHost(f, 4), 20, { keep: true });
  assert.ok(m.own, 'the own sound came');
  assert.ok(off(out, (i) => out.sped[i]) < 1e-6, 'the sped-up sound, as "Sped-up original" plays it');
  assert.ok(m.tRec && m.ring.written > 60 * SR, 'the own sound is recorded (it says where a song ends)');
  assert.equal(m.playing().src, 'game');
});

// ---- speed changes as the real emulator delivers them --------------------------------------------------------
// Measured in the app (Silver, Gambatte, 48 kHz, recorded at the worklet's input): OpenAL still plays ~60 ms of
// sound made at the old speed after a switch; changing the step while fast-forwarding (2× → 3×) switches
// fast-forward off for ~70 ms (player.html's re-toggle), so that stretch is 1× sound; and after fast-forward
// switches on, OpenAL runs dry for a few hundred ms – holes of 0.5–12 ms of digital silence in sound that
// otherwise goes on without a jump (the samples come late, not lost).

/**
 * The emulator's sound for a speed schedule: `music(c)` at content position c, which advances by the speed the
 * emulator ran at `lat` samples earlier; holes after every switch into fast-forward. Returns fn(i) for feed().
 */
function emulator(music, schedule, { lat = Math.round(0.06 * SR), dip = Math.round(0.07 * SR), holes = true } = {}) {
  // speed per real sample, from [[atSample, ratio], …]
  const speedAt = [];
  const hole = new Set();
  let prev = 1;
  for (const [at, ratio] of schedule) {
    speedAt.push([at, prev > 1 && ratio > 1 && ratio !== prev ? 1 : ratio]);
    if (prev > 1 && ratio > 1 && ratio !== prev) speedAt.push([at + dip, ratio]);
    if (ratio > 1 && holes) {
      // a burst of holes 60–360 ms after the switch (where the measurement had them)
      let s = (at * 7 + 3) % 1000;
      for (let t = at + lat; t < at + lat + Math.round(0.3 * SR); ) {
        s = (s * 1103 + 13) % 10007;
        const len = 8 + (s % 190);
        for (let k = 0; k < len; k++) hole.add(t + k);
        t += len + 200 + (s % 900);
      }
    }
    prev = ratio;
  }
  let c = 0;
  let last = -1;
  let k = 0;
  const speed = (t) => {
    while (k + 1 < speedAt.length && speedAt[k + 1][0] <= t) k++;
    return t < speedAt[0][0] ? 1 : speedAt[k][1];
  };
  return (i) => {
    if (i <= last) throw new Error('emulator() is sequential');
    for (let t = last + 1; t <= i; t++) if (!hole.has(t)) c += speed(t - lat);
    last = i;
    return hole.has(i) ? 0 : music(c);
  };
}

/** Feeds `fn` from absolute sample `from` (one call per sample, in order), commands at their sample positions. */
function play(m, fn, from, seconds, commands = [], onBlock = null) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const l = new Float32Array(BLOCK);
  const oL = new Float32Array(BLOCK);
  const oR = new Float32Array(BLOCK);
  let ci = 0;
  for (let i = 0; i < n; i += BLOCK) {
    while (ci < commands.length && commands[ci][0] <= from + i) m.command({ type: 'speed', ratio: commands[ci++][1] });
    for (let j = 0; j < BLOCK; j++) l[j] = fn(from + i + j);
    onBlock?.(i);
    m.process(l, null, oL, oR, BLOCK);
    out.set(oL.subarray(0, Math.min(BLOCK, n - i)), i);
  }
  return out;
}

const F0 = 440;
const sine = (c) => 0.3 * Math.sin((2 * Math.PI * F0 * c) / SR);
// the steepest a 0.3 sine at 440 Hz gets from one sample to the next – a click is a jump well beyond it
const SLOPE = 0.3 * 2 * Math.PI * (F0 / SR);

test('speed changes without a loop: "Music continues" plays exactly what "Sped-up original" plays – and still hears no song change', () => {
  const S = (s) => Math.round(s * SR);
  const sched = [[S(2), 2], [S(5), 3], [S(8), 4], [S(11), 1]];
  const outs = {};
  let changed = 0;
  for (const mode of ['music', 'original']) {
    const m = new TurboMixer(SR, { seconds: 30 });
    m.command({ type: 'mode', mode });
    if (mode === 'music') m.onEvent = (e) => e.changed && changed++;
    const emu = emulator(sine, sched);
    play(m, emu, 0, 2); // 2 s at 1×: too short for a loop of its own
    outs[mode] = play(m, emu, S(2), 10, sched);
  }
  assert.ok(off(outs.music, (i) => outs.original[i]) < 1e-6);
  assert.equal(changed, 0, 'the step changes and the holes after them are no song change');
});

test('rapid toggling 1×/4×/2×/1×/3× stays click-free and bounded', () => {
  const m = new TurboMixer(SR, { seconds: 30 });
  const S = (s) => Math.round(s * SR);
  const sched = [[S(2), 4], [S(2.3), 1], [S(2.6), 2], [S(2.9), 1], [S(3.2), 3], [S(3.5), 4], [S(3.8), 1], [S(4.1), 2]];
  // (without OpenAL's holes – with nothing recorded "music" plays the sped-up sound as it comes, holes and all, as
  // "original" does; the native hosts' sped-up sound has none)
  const emu = emulator(sine, sched, { holes: false });
  play(m, emu, 0, 2);
  const out = play(m, emu, S(2), 4, sched);
  let peak = 0;
  for (const x of out) {
    assert.ok(Number.isFinite(x));
    peak = Math.max(peak, Math.abs(x));
  }
  assert.ok(peak <= 0.3 * 1.05, `peak ${peak}`);
  // (the sped-up tone plays as it comes: at 4× its own steepest step is 4× the tone's)
  assert.ok(maxJump(out) < SLOPE * 4 * 1.05, `click: jump ${maxJump(out).toFixed(3)}`);
});

test('a speed change while the loop plays keeps the loop (the re-toggle hiccup is no song change)', () => {
  const A = tune({ seed: 1, period: 6.4 });
  const m = new TurboMixer(SR, { seconds: 60 });
  const S = (s) => Math.round(s * SR);
  const sched = [[S(16), 2], [S(17), 3], [S(18), 4], [S(19), 2]];
  const emu = emulator(A, sched, { holes: true });
  let changed = 0;
  m.onEvent = (e) => e.changed && changed++;
  play(m, emu, 0, 16);
  assert.ok(m.found);
  const out = play(m, emu, S(16), 4, sched);
  assert.equal(changed, 0, 'no song change detected');
  assert.equal(m.playing().src, 'loop', 'still the loop');
  assert.ok(corr(out, A, S(16), S(0.2), out.length) > 0.99, 'the loop goes on exactly as the tune does');
});

// DeSmuME (HeartGold, measured in the app, threaded or not, any audio_latency): the sped-up sound comes in pieces
// of ~280 samples with holes between them (40–47 % of the time, ~75 per second), and the pieces don't join up.
/** The emulator's sped-up sound as DeSmuME delivers it: `music` at `ratio`, chopped, with sound lost at every hole. */
function choppy(music, ratio, from = 0) {
  const piece = Math.round((280 / 48000) * SR);
  const hole = Math.round((230 / 48000) * SR);
  return (i) => {
    const k = i % (piece + hole);
    return k < piece ? music(from + ratio * i) : 0;
  };
}

test('DS: chopped sped-up sound is not slowed down into buzz, nor played – without a loop it stays quiet', () => {
  const m = new TurboMixer(SR, { seconds: 30 });
  play(m, sine, 0, 2);
  m.command({ type: 'speed', ratio: 3 });
  const out = feed(m, choppy(sine, 3, 2 * SR), 0, 3);
  // (the first quarter second plays as it comes, as with any sped-up sound with nothing recorded: then it is judged)
  assert.ok(rms(out.subarray(SR)) < 1e-3, `rms ${rms(out.subarray(SR))}`);
  assert.ok(maxJump(out.subarray(Math.round(0.45 * SR))) < SLOPE * 1.6, 'no click once the game’s own (chopped) sound is faded out');
  // back at 1× the game's own sound plays; the next fast-forward knows the sound is choppy right away
  m.command({ type: 'speed', ratio: 1 });
  feed(m, sine, 0, 1);
  m.command({ type: 'speed', ratio: 2 });
  const again = feed(m, choppy(sine, 2), 0, 1.5);
  assert.ok(rms(again.subarray(Math.round(0.3 * SR))) < 1e-3, 'no buzz at the start of the next fast-forward');
});

test('DS: the loop recorded at 1× keeps playing through chopped sped-up sound, no song change', () => {
  const A = tune({ seed: 1, period: 6.4 });
  const m = new TurboMixer(SR, { seconds: 30 });
  let changed = 0;
  m.onEvent = (e) => e.changed && changed++;
  const t = feed(m, A, 0, 16).length;
  assert.ok(m.found);
  m.command({ type: 'speed', ratio: 3 });
  const out = feed(m, choppy(A, 3, t), 0, 4);
  assert.equal(changed, 0);
  assert.ok(corr(out, A, t, Math.round(0.2 * SR), out.length) > 0.99, 'the loop goes on as the tune does');
});

/** Longest run of near-silence (|x| < 1e-4) in out[a..b), in seconds. */
function longestQuiet(out, a, b) {
  let m = 0;
  let c = 0;
  for (let i = a; i < b; i++) {
    c = Math.abs(out[i]) < 1e-4 ? c + 1 : 0;
    m = Math.max(m, c);
  }
  return m / SR;
}

test('DS without a loop: a music bed from the 1× recording keeps the music going, also through a song change, hands back', () => {
  const A = tune({ seed: 5, period: 120 }); // no repeat within the recording: no loop, only a bed
  const m = new TurboMixer(SR, { seconds: 60 });
  const ev = [];
  m.onEvent = (e) => ev.push(e);
  let t = feed(m, A, 0, 25).length;
  assert.ok(!m.found && m.bed, 'a bed, no loop');
  assert.ok(m.bed.lag >= 12 * SR && m.bed.xfade === 2 * SR, `bed ${m.bed.lag / SR} s, crossfade ${m.bed.xfade / SR} s`);
  // first fast-forward: the sound turns out to be choppy within half a second, then the bed plays
  m.command({ type: 'speed', ratio: 3 });
  const first = feed(m, choppy(A, 3, t), 0, 20);
  assert.ok(ev.some((e) => e.type === 'turbo' && e.bed), 'the bed took over');
  assert.ok(longestQuiet(first, Math.round(0.8 * SR), first.length) < 0.05, `quiet for ${longestQuiet(first, Math.round(0.8 * SR), first.length)} s`);
  assert.ok(maxJump(first.subarray(Math.round(0.1 * SR))) < 0.2, 'no clicks, also across the bed’s jumps');
  let peak = 0;
  for (const x of first) peak = Math.max(peak, Math.abs(x));
  assert.ok(peak < 0.45, `peak ${peak}`);
  m.command({ type: 'speed', ratio: 1 });
  t += feed(m, A, t, 3).length;
  // the next fast-forward knows the sound is choppy: the bed starts right away and plays the music as recorded
  m.command({ type: 'speed', ratio: 2 });
  const pos0 = m.carry?.pos;
  assert.ok(m.carry?.bed, 'bed chosen at the switch');
  const second = feed(m, choppy(A, 2, t), 0, 1);
  // what the bed should play from there: the recording, blended into the stretch one jump back near its end
  const { start, end, lag, xfade } = m.carry;
  const bedAt = (i) => {
    let p = pos0 + i;
    while (p >= end) p -= lag;
    const into = p - (end - xfade);
    if (into < 0 || p < start) return A(p);
    const k = (into / xfade) * Math.PI * 0.5;
    return A(p) * Math.cos(k) + A(p - lag) * Math.sin(k);
  };
  assert.ok(corr(second, bedAt, 0, Math.round(0.1 * SR), second.length) > 0.99, 'the 1× music at its own pitch');
  // a door: the sped-up sound goes quiet, then another song (still choppy) – it can't be heard in that sound, so
  // the bed goes on rather than silence
  feed(m, () => 0, 0, 0.5);
  const after = feed(m, choppy(tune({ seed: 8 }), 2), 0, 2);
  assert.ok(ev.some((e) => e.changed && e.kept), 'song change noticed in the choppy sound');
  assert.ok(longestQuiet(after, 0, after.length) < 0.05, 'the music goes on');
  m.command({ type: 'speed', ratio: 1 });
  const back = feed(m, A, 0, 1);
  for (let i = Math.round(0.25 * SR); i < back.length; i++) assert.ok(Math.abs(back[i] - A(i)) < 1e-6);
});

// DeSmuME runs without audio_fastforward_speedup (player.html): its fast-forward sound is the song at normal pitch in
// pieces, skipping ahead (measured with HeartGold: pieces match the 1× music at normal pitch, NCC median 0.70).
/** That sound: `music` at normal pitch in pieces of `piece` samples, jumping ahead so the song runs `ratio`× fast. */
function skipping(music, ratio, from = 0, piece = Math.round(0.02 * SR)) {
  return (i) => {
    const k = Math.floor(i / piece);
    return music(from + k * piece * ratio + (i - k * piece));
  };
}
const quietWin = (out, a, b, W = Math.round(0.05 * SR)) => {
  // the longest stretch in which every 50 ms window is (nearly) silent
  let m = 0;
  for (let s = a; s + W <= b; s += W) if (rms(out.subarray(s, s + W)) < 1e-3) m++;
  return m;
};

test('DS without speed-up sound, straight into fast-forward with nothing recorded: original plays the skipping sound (de-clicked), music stays quiet', () => {
  const f = tune({ seed: 5, period: 120 });
  const m = new TurboMixer(SR, { seconds: 60 });
  m.command({ type: 'skip', on: true });
  feed(m, f, 0, 1); // barely any 1× sound: nothing to make a bed of
  m.command({ type: 'speed', ratio: 4 });
  const src = skipping(f, 2.7, SR); // the machine only reaches 2.7×
  const raw = Float32Array.from({ length: 4 * SR }, (_, i) => src(i));
  // "original": the skipping sound, its jumps smoothed (1 ms late: the de-click delay)
  m.command({ type: 'mode', mode: 'music' });
  const music = feed(m, src, 0, 2);
  assert.equal(rms(music.subarray(Math.round(0.2 * SR))), 0, 'music: nothing recorded – quiet, never the skipping (sped-up sounding) music');
  for (const [mode, from] of [['original', 2 * SR]]) {
    m.command({ type: 'mode', mode });
    const out = feed(m, (i) => src(from + i), 0, 2);
    assert.equal(quietWin(out, 0, out.length), 0, `${mode}: never silent`);
    assert.ok(corr(out, (i) => src(from + i), -m.dc.D, Math.round(0.1 * SR), out.length) > 0.9, `${mode}: the game’s own sound, not stretched`);
    assert.ok(maxJump(out.subarray(Math.round(0.1 * SR))) < maxJump(raw) * 0.25, `${mode}: jumps ${maxJump(out).toFixed(3)} vs ${maxJump(raw).toFixed(3)}`);
  }
});

test('DS: fast-forward right after the start is quiet (nothing recorded), the next one plays the bed recorded at 1× in between', () => {
  const A = tune({ seed: 3, period: 120 });
  const m = new TurboMixer(SR, { seconds: 60 });
  m.command({ type: 'skip', on: true });
  let t = feed(m, A, 0, 2).length; // 2 s: too little for a bed
  m.command({ type: 'speed', ratio: 3 });
  const first = feed(m, skipping(A, 3, t), 0, 3);
  assert.equal(m.carry, null);
  assert.equal(rms(first.subarray(Math.round(0.2 * SR))), 0, 'quiet – not the skipping sound');
  m.command({ type: 'speed', ratio: 1 });
  t += 9 * SR;
  t += feed(m, A, t, 9).length; // enough 1× music for a bed that is more than a stutter (≥ 3.5 s)
  assert.ok(m.bed, 'a bed from 9 s of music');
  m.command({ type: 'speed', ratio: 3 });
  assert.ok(m.carry?.bed, 'the bed plays now');
  const out = feed(m, skipping(A, 3, t), 0, 3);
  assert.ok(longestQuiet(out, 0, out.length) < 0.05, `quiet for ${longestQuiet(out, 0, out.length)} s`);
  assert.ok(m.live.t === 0, 'the skipping sound is faded out under the bed');
});

test('DS: a song change at 1× and straight back into fast-forward – the most recent song’s bed plays', () => {
  const A = tune({ seed: 3, period: 120 });
  const m = new TurboMixer(SR, { seconds: 60 });
  m.command({ type: 'skip', on: true });
  let t = feed(m, A, 0, 9).length; // 9 s: enough for a bed that plays (≥ 3.5 s of it)
  assert.ok(m.bed, 'a bed from 9 s of music');
  t += feed(m, () => 0, t, 1).length; // a door
  t += feed(m, tune({ seed: 8, period: 120 }), t, 1).length; // the next area's song, only 1 s of it
  m.command({ type: 'speed', ratio: 3 });
  assert.ok(m.carry?.bed, 'the previous song’s bed');
  const out = feed(m, skipping(A, 3, t), 0, 3);
  assert.ok(longestQuiet(out, 0, out.length) < 0.05, `quiet for ${longestQuiet(out, 0, out.length)} s`);
  assert.ok(maxJump(out.subarray(Math.round(0.1 * SR))) < 0.2, 'no clicks');
});

test('DS without speed-up sound: the bed plays from the first fast-forward and goes on through a song change', () => {
  const A = tune({ seed: 3, period: 120 });
  const m = new TurboMixer(SR, { seconds: 60 });
  m.command({ type: 'skip', on: true });
  const t = feed(m, A, 0, 25).length;
  m.command({ type: 'speed', ratio: 3 });
  assert.ok(m.carry?.bed, 'bed chosen at the switch');
  const out = feed(m, skipping(A, 3, t), 0, 3);
  assert.ok(longestQuiet(out, 0, out.length) < 0.05, `quiet for ${longestQuiet(out, 0, out.length)} s`);
  assert.ok(m.voice?.bed && m.live.v === 0, 'only the bed is heard');
  // a door (≥0.25 s quiet in the fast-forward sound), then the next area's song: it can't be heard in the skipping
  // sound, so the bed goes on – never the skipping sound, never silence
  let changed = 0;
  m.onEvent = (e) => e.changed && e.kept && changed++;
  const B = tune({ seed: 8, period: 120 });
  const door = feed(m, () => 0, 0, 0.4);
  const next = feed(m, skipping(B, 3), 0, 2);
  assert.equal(changed, 1, 'the song change was noticed');
  assert.ok(m.voice?.bed && m.live.v === 0, 'still the bed, not the game’s sound');
  assert.ok(longestQuiet(door, 0, door.length) < 0.05 && longestQuiet(next, 0, next.length) < 0.05, 'never silent');
  assert.ok(maxJump(door) < 0.2 && maxJump(next) < 0.2);
});

test('slower than requested (4× asked, 2.7× reached): the measured speed sets the slow-down of what the mixer listens to', () => {
  // (with nothing recorded the sped-up sound plays as it comes; its slowed-down copy is what the mixer hears song changes in)
  const f = tune({ seed: 9 });
  const run = (rate) => {
    const m = new TurboMixer(SR, { seconds: 30 });
    feed(m, tune(), 0, 3);
    m.command({ type: 'speed', ratio: 4 });
    if (rate) m.command({ type: 'rate', ratio: rate });
    const during = feed(m, sped(f, 2.7), 0, 2);
    assert.ok(off(during, sped(f, 2.7)) < 1e-6, 'the sped-up sound plays as it comes');
    return bestCorr(recorded(m, Math.round(0.5 * SR)), f, 0, Math.round(0.5 * SR), { ahead: 6 * SR, step: 1 });
  };
  assert.ok(run(0) < 0.5, 'slowed down by the requested 4× the song is out of tune');
  assert.ok(run(2.7) > 0.95, 'by the measured 2.7×: normal pitch and tempo');
});

test('3DS: the host’s own ratio (exact) sets the slow-down and holds until the host says otherwise', () => {
  const f = tune({ seed: 9 });
  const m = new TurboMixer(SR, { seconds: 30 });
  feed(m, tune(), 0, 3);
  m.command({ type: 'speed', ratio: 4 });
  // 4× asked, the game reaches 2.7× – the host says so (ffrate) right before the sound made with that ratio
  m.command({ type: 'rate', ratio: 2.7, exact: true });
  feed(m, sped(f, 2.7), 0, 2);
  assert.ok(bestCorr(recorded(m, Math.round(0.5 * SR)), f, 0, Math.round(0.5 * SR), { ahead: 6 * SR }) > 0.95, 'normal pitch and tempo');
  m.command({ type: 'speed', ratio: 3 }); // a step on the toolbar: the host's ratio still holds until it says otherwise
  assert.equal(m.rate, 2.7);
  m.command({ type: 'rate', ratio: 1.6, exact: true });
  m.command({ type: 'rate', ratio: 2.2 }); // the page's own measurement doesn't override the host's
  assert.equal(m.rate, 1.6);
});

test('DS: a short new stretch of the same song does not replace the loop found before (fast-forward splits songs)', () => {
  const A = tune({ seed: 1, period: 6.4 });
  const m = new TurboMixer(SR, { seconds: 60 });
  m.command({ type: 'skip', on: true });
  let t = feed(m, A, 0, 16).length;
  const loop = m.found;
  assert.ok(loop && !loop.bed);
  m.command({ type: 'speed', ratio: 3 });
  feed(m, skipping(A, 3, t), 0, 2);
  m.command({ type: 'speed', ratio: 1 });
  t += feed(m, A, t, 5).length; // 5 s at 1×: a (poor) bed of this stretch only
  m.command({ type: 'speed', ratio: 4 });
  assert.equal(m.carry, loop, 'the good loop of the same song');
  // after a real song change, the newer recording counts
  m.command({ type: 'speed', ratio: 1 });
  t += feed(m, () => 0, t, 1).length;
  t += feed(m, tune({ seed: 8, period: 120 }), t, 9).length;
  m.command({ type: 'speed', ratio: 3 });
  // (the old song's loop plays until the search in the new song's 9 s is done, then its bed takes over)
  const out = feed(m, skipping(A, 3, t), 0, 1.5);
  assert.ok(m.carry && m.carry !== loop && m.carry.song === m.song, 'the new song’s own bed');
  assert.ok(longestQuiet(out, 0, out.length) < 0.2 && maxJump(out.subarray(Math.round(0.1 * SR))) < 0.2);
});

// --- the game says which song plays (song key from RAM) ----------------------------------------------------------

/** The tune's note per 25 ms frame (tune() picks from 15 semitones above 220 Hz): Goertzel power, the loudest wins. */
const NOTES = Array.from({ length: 15 }, (_, k) => 220 * 2 ** (k / 12));
function notes(get, n0, frames, F = Math.round(0.025 * SR)) {
  const seq = new Int8Array(frames);
  for (let j = 0; j < frames; j++) {
    let best = -1;
    let bp = 1e-6;
    for (let k = 0; k < NOTES.length; k++) {
      const c = 2 * Math.cos((2 * Math.PI * NOTES[k]) / SR);
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < F; i++) {
        const s0 = get(n0 + j * F + i) + c * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      const pw = s1 * s1 + s2 * s2 - c * s1 * s2;
      if (pw > bp) [bp, best] = [pw, k];
    }
    seq[j] = best;
  }
  return seq;
}
/** Per song: the share of out[a..b)'s note frames that follow that song's melody (best alignment over one 6.4 s period). */
const whichSong = (out, a, b, songs) => {
  const F = Math.round(0.025 * SR);
  const n = Math.floor((b - a) / F);
  const heard = notes((i) => out[i] || 0, a, n, F);
  return songs.map((f) => {
    const period = Math.round((6.4 * SR) / F);
    const ref = notes(f, 0, period + n, F);
    let best = 0;
    for (let o = 0; o < period; o++) {
      let hit = 0;
      for (let j = 0; j < n; j++) if (heard[j] >= 0 && heard[j] === ref[o + j]) hit++;
      best = Math.max(best, hit / n);
    }
    return best;
  });
};

test('song key, DeSmuME: a route change during fast-forward plays the new route’s loop from the library, an unheard one keeps the music going', () => {
  const A = tune({ seed: 1 });
  const B = tune({ seed: 2 });
  const C = tune({ seed: 7 });
  const m = new TurboMixer(SR, { seconds: 30 });
  m.command({ type: 'skip', on: true });
  m.command({ type: 'song', key: 'mA' });
  let t = feed(m, A, 0, 14).length;
  assert.ok(m.lib.has('mA'), 'route A’s loop kept');
  m.command({ type: 'song', key: 'mB' }); // walked onto route B at 1×
  feed(m, B, 0, 14);
  assert.ok(m.lib.has('mB'));
  t = 14 * SR;
  m.command({ type: 'speed', ratio: 3 });
  let out = feed(m, skipping(B, 3, t), 0, 2);
  let [a, b] = whichSong(out, Math.round(0.3 * SR), out.length, [A, B]);
  assert.ok(b > 0.8 && a < 0.4, `route B plays (A ${a.toFixed(2)}, B ${b.toFixed(2)})`);
  // back onto route A while fast-forwarding: A's music, not B's
  m.command({ type: 'song', key: 'mA' });
  out = feed(m, skipping(A, 3, 0), 0, 2);
  [a, b] = whichSong(out, Math.round(0.4 * SR), out.length, [A, B]);
  assert.ok(a > 0.8 && b < 0.4, `route A plays (A ${a.toFixed(2)}, B ${b.toFixed(2)})`);
  assert.ok(longestQuiet(out, 0, out.length) < 0.25, `quiet for ${longestQuiet(out, 0, out.length)} s`);
  // a route never played at 1×: route A's loop goes on (music continues) – never the game's skipping sound
  m.command({ type: 'song', key: 'mC' });
  const src = skipping(C, 3, 0);
  out = feed(m, src, 0, 2);
  assert.ok(Math.abs(corr(out, src, -m.dc.D, Math.round(0.4 * SR), out.length)) < 0.2, 'not the game’s own sound');
  [a] = whichSong(out, Math.round(0.1 * SR), out.length, [A]);
  assert.ok(a > 0.8, `route A’s loop goes on (${a.toFixed(2)})`);
  assert.ok(longestQuiet(out, 0, out.length) < 0.05, `quiet for ${longestQuiet(out, 0, out.length)} s`);
  // the next fast-forward on route C after 1× there: C's own loop
  m.command({ type: 'speed', ratio: 1 });
  feed(m, C, 0, 14);
  assert.ok(m.lib.has('mC'));
  m.command({ type: 'speed', ratio: 3 });
  out = feed(m, skipping(C, 3, 14 * SR), 0, 2);
  const [, , c] = whichSong(out, Math.round(0.3 * SR), out.length, [A, B, C]);
  assert.ok(c > 0.8, `route C’s loop (${c.toFixed(2)})`);
});

test('song key, DeSmuME: fast-forward on a route not yet recorded plays the previous route’s bed, never its skipping sound', () => {
  const A = tune({ seed: 3, period: 120 });
  const B = tune({ seed: 8, period: 120 });
  const m = new TurboMixer(SR, { seconds: 60 });
  m.command({ type: 'skip', on: true });
  m.command({ type: 'song', key: 'mA' });
  feed(m, A, 0, 12); // (a bed is filed once the key held keyLag past its stretch's end)
  assert.ok(m.lib.get('mA')?.bed, 'route A’s bed kept');
  m.command({ type: 'song', key: 'mB' });
  feed(m, B, 0, 1); // only 1 s on route B
  m.command({ type: 'speed', ratio: 3 });
  assert.ok(m.carry?.lib && m.carry.key === 'mA', 'route A’s bed (music continues)');
  const src = skipping(B, 3, SR);
  const out = feed(m, src, 0, 2);
  assert.ok(Math.abs(corr(out, src, -m.dc.D, Math.round(0.1 * SR), out.length)) < 0.2, 'not route B’s skipping sound');
  assert.ok(longestQuiet(out, 0, out.length) < 0.05);
});

test('song key, Gambatte: a route change during fast-forward switches to the stored loop, an unheard route plays its sped-up sound', () => {
  const A = tune({ seed: 1 });
  const B = tune({ seed: 2 });
  const C = tune({ seed: 7 });
  const m = new TurboMixer(SR, { seconds: 30 });
  m.command({ type: 'song', key: 'mA' });
  feed(m, A, 0, 14);
  m.command({ type: 'song', key: 'mB' });
  feed(m, B, 0, 14);
  assert.ok(m.lib.has('mA') && m.lib.has('mB'));
  m.command({ type: 'speed', ratio: 3 });
  feed(m, sped(B, 3, 14 * SR), 0, 1);
  m.command({ type: 'song', key: 'mA' });
  let out = feed(m, sped(A, 3, 0), 0, 2);
  const [a, b] = whichSong(out, Math.round(0.4 * SR), out.length, [A, B]);
  assert.ok(a > 0.8 && b < 0.4, `route A’s loop (A ${a.toFixed(2)}, B ${b.toFixed(2)})`);
  // unheard route: the game's own sped-up sound (route A's loop fades out over it)
  m.command({ type: 'song', key: 'mC' });
  assert.equal(m.carry, null);
  out = feed(m, sped(C, 3, 0), 0, 2);
  assert.ok(off(out, sped(C, 3, 0), Math.round(0.1 * SR)) < 1e-6, 'route C as the game plays it');
  assert.ok(maxJump(out) < 0.2, 'no click at the change');
});

test('song library: bounded, least recently heard dropped, a loop is not replaced by a bed', () => {
  const m = new TurboMixer(SR, { seconds: 30 });
  m.k.libTotal = 15 * SR; // room for two 6.4 s loops
  for (const [k, seed] of [['m1', 1], ['m2', 2], ['m3', 3]]) {
    m.command({ type: 'song', key: k });
    feed(m, tune({ seed }), 0, 14);
  }
  assert.deepEqual([...m.lib.keys()], ['m2', 'm3']);
  let total = 0;
  for (const e of m.lib.values()) total += e.end;
  assert.ok(total <= m.k.libTotal);
  const loop = m.lib.get('m3');
  assert.equal(loop.bed, false);
  m.keep({ key: 'm3', bed: true, start: m.ring.written - 5 * SR, end: m.ring.written, lag: 5 * SR, xfade: SR, curve: 'power', score: 0.5, fine: 0.5 });
  assert.equal(m.lib.get('m3'), loop);
});

/** Which of `songs` a library entry holds (whichSong over its whole recording). */
const libSong = (e, songs) => whichSong(Float32Array.from(e.l, (v) => v / 32767), 0, e.end, songs);

test('song key: the first key (start, title screen) does not adopt what played before it', () => {
  const title = tune({ seed: 11 });
  const A = tune({ seed: 1 });
  const m = new TurboMixer(SR, { seconds: 30 });
  m.command({ type: 'skip', on: true });
  feed(m, title, 0, 12); // the title screen: no key yet (RAM not found), a bed/loop of it is found
  assert.equal(m.lib.size, 0, 'nothing is kept without a key');
  m.command({ type: 'song', key: 'mA' }); // the game continues on route A
  feed(m, A, 0, 2);
  assert.ok(!m.lib.has('mA'), 'the title music is not filed as route A');
  m.command({ type: 'speed', ratio: 3 });
  const src = skipping(A, 3, 2 * SR);
  const out = feed(m, src, 0, 2);
  // nothing of route A recorded yet: the music heard last (the title's) goes on – never the skipping sound
  assert.ok(Math.abs(corr(out, src, -m.dc.D, Math.round(0.3 * SR), out.length)) < 0.2, 'not route A’s skipping sound');
  assert.ok(longestQuiet(out, 0, out.length) < 0.1, 'music, not silence');
  m.command({ type: 'speed', ratio: 1 });
  feed(m, A, 0, 12);
  const [t, a] = libSong(m.lib.get('mA'), [title, A]);
  assert.ok(a > 0.8 && t < 0.4, `route A’s own loop (title ${t.toFixed(2)}, A ${a.toFixed(2)})`);
});

test('song key arriving late: a search reaching into the new song is dropped, the old song’s entry stays clean', () => {
  const A = tune({ seed: 1 });
  const B = tune({ seed: 2 });
  for (const phase of [0, 0.5, 1, 1.5, 2, 2.5]) {
    const m = new TurboMixer(SR, { seconds: 30 });
    m.command({ type: 'skip', on: true });
    m.command({ type: 'song', key: 'mA' });
    feed(m, A, 0, 9 + phase);
    // battle music starts at once; the key comes 0.3 s later (polled RAM)
    feed(m, B, 0, 0.3);
    m.command({ type: 'song', key: 'mB' });
    assert.ok(!m.job || m.job.end <= m.ring.written - m.k.keyLag, `no search over the change (phase ${phase})`);
    feed(m, B, 0.3 * SR, 12);
    const [a, b] = libSong(m.lib.get('mA'), [A, B]);
    assert.ok(a > 0.8 && b < 0.3, `route A’s entry holds A only (phase ${phase}: A ${a.toFixed(2)}, B ${b.toFixed(2)})`);
    const [a2, b2] = libSong(m.lib.get('mB'), [A, B]);
    assert.ok(b2 > 0.8 && a2 < 0.3, `B’s entry holds B only (phase ${phase}: A ${a2.toFixed(2)}, B ${b2.toFixed(2)})`);
  }
});

test('a loaded state forgets the song key: the same key again starts a new stretch and fast-forward plays its loop', () => {
  const A = tune({ seed: 1 });
  const m = new TurboMixer(SR, { seconds: 30 });
  m.command({ type: 'skip', on: true });
  m.command({ type: 'song', key: 'mA' });
  feed(m, A, 0, 12);
  assert.ok(m.lib.has('mA'));
  m.command({ type: 'cut' });
  assert.equal(m.key, null, 'unknown until the page reads it again');
  const song = m.song;
  m.command({ type: 'song', key: 'mA' });
  assert.ok(m.song > song && !m.open, 'a new stretch');
  m.command({ type: 'speed', ratio: 3 });
  const out = feed(m, skipping(A, 3, 0), 0, 2);
  const [a] = whichSong(out, Math.round(0.3 * SR), out.length, [A]);
  assert.ok(a > 0.8, `route A’s loop (${a.toFixed(2)})`);
});

test('song library: a short visit later does not replace a song’s long bed with a stutter', () => {
  const A = tune({ seed: 3, period: 120 });
  const B = tune({ seed: 8, period: 120 });
  const m = new TurboMixer(SR, { seconds: 60 });
  m.command({ type: 'skip', on: true });
  m.command({ type: 'song', key: 'mA' });
  feed(m, A, 0, 30); // a long stay: a long bed
  const long = m.lib.get('mA');
  assert.ok(long && long.lag > 10 * SR, `a long bed (${(long?.lag / SR).toFixed(1)} s)`);
  m.command({ type: 'song', key: 'mB' });
  feed(m, B, 0, 10);
  m.command({ type: 'song', key: 'mA' }); // back for 6 s: only a short bed can be found in that
  feed(m, A, 40 * SR, 6);
  assert.equal(m.lib.get('mA').lag, long.lag, 'the long bed stays');
  m.command({ type: 'speed', ratio: 3 });
  const out = feed(m, skipping(A, 3, 46 * SR), 0, 3);
  assert.ok(m.voice?.lag >= 10 * SR, 'the long bed plays, not a few seconds of it');
  assert.ok(longestQuiet(out, 0, out.length) < 0.1);
});

test('DS: a bed of only a few seconds is a stutter – fast-forward stays quiet instead (never the skipping sound)', () => {
  const A = tune({ seed: 3, period: 120 });
  const m = new TurboMixer(SR, { seconds: 60 });
  m.command({ type: 'skip', on: true });
  m.command({ type: 'song', key: 'mA' });
  let found = 0;
  m.onEvent = (e) => e.type === 'bed' && found++;
  feed(m, A, 0, 6); // 6 s at 1×: the beds found in it are ~2.5 s long
  assert.ok(found > 0 && m.bed.lag < m.k.minPlay, `only a short bed (${found}, ${(m.bed?.lag / SR).toFixed(1)} s)`);
  assert.ok(!m.lib.has('mA'), 'not kept for the song');
  m.command({ type: 'speed', ratio: 3 });
  assert.equal(m.carry, null);
  const src = skipping(A, 3, 5 * SR);
  const out = feed(m, src, 0, 2);
  assert.equal(rms(out.subarray(Math.round(0.2 * SR))), 0, 'quiet');
});

// ---- the frame pacer (2.2): a GBA game at the sound card's own rate --------------------------------------------------
// Measured in the app (synthetic GBA tune in mGBA, 48 kHz, pacer at 75 Hz): the sped-up sound is sped up (median pitch
// 450 → 1275 Hz at 4×), OpenAL runs dry ~8 times a second for ~6 ms (late, not lost), and the low half waves of the Game
// Boy square waves are runs of exact zeros (0.5–1.9 ms). The page clamps "Max" to 16 and reports the speed reached.

/** A PSG-like tune at `rate`: square waves whose low half is exact zero, a new note every 0.2 s, repeating every 6.4 s. */
function squareTune(rate, { seed = 1, period = 6.4 } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const step = Math.round(0.2 * rate);
  const steps = Math.round((period * rate) / step);
  const notes = Array.from({ length: steps }, () => 220 * 2 ** (Math.floor(rnd() * 15) / 12));
  const P = steps * step;
  return (c) => {
    const p = ((c % P) + P) % P;
    const k = Math.floor(p / step);
    const x = (p - k * step) / rate;
    return (x * notes[k]) % 1 < 0.5 ? 0.3 * Math.exp(-x * 4) : 0;
  };
}

/** The emulator under the pacer at `rate`: drives a mixer as player.html does; run() returns what it played. */
function pacedGame(rate, music) {
  const m = new TurboMixer(rate, { seconds: 60 });
  const ev = [];
  m.onEvent = (e) => ev.push(e);
  const B = 128;
  const l = new Float32Array(B);
  const oL = new Float32Array(B);
  const oR = new Float32Array(B);
  const hole = { every: Math.round(rate / 8), len: Math.round(0.006 * rate) };
  const g = { m, ev, c: 0, i: 0, step: 1, real: 1, music };
  g.speed = (ratio, reached = Math.min(ratio, 16)) => {
    g.step = ratio;
    g.real = ratio > 1 ? reached : 1;
    m.command({ type: 'speed', ratio: Math.min(ratio, 16) }); // (player.html: "Max" is Infinity, the mixer gets 16)
    if (ratio > 1 && reached < Math.min(ratio, 16)) m.command({ type: 'rate', ratio: reached });
  };
  /** `sec` seconds of play (input false: the core gives no sound at all); returns { out, srcs }. */
  g.run = (sec, { input = true } = {}) => {
    const n = Math.round(sec * rate);
    const out = new Float32Array(n);
    const srcs = [];
    for (let k = 0; k < n; k += B) {
      for (let j = 0; j < B; j++, g.i++) {
        if (g.step > 1 && g.i % hole.every < hole.len) l[j] = 0; // OpenAL ran dry: the sound comes later
        else {
          l[j] = g.music(g.c);
          g.c += g.real;
        }
      }
      m.process(input ? l : null, null, oL, oR, B);
      out.set(oL.subarray(0, Math.min(B, n - k)), k);
      srcs.push(m.playing().src);
    }
    return { out, srcs };
  };
  return g;
}
/** Longest stretch of out[a..b) whose 20 ms windows are all near silence, in seconds. */
function quietest(out, rate, a, b = out.length) {
  const W = Math.round(0.02 * rate);
  let run = 0;
  let worst = 0;
  for (let s = a; s + W <= b; s += W) {
    let e = 0;
    for (let i = s; i < s + W; i++) e += out[i] * out[i];
    run = Math.sqrt(e / W) < 1e-3 ? run + W : 0;
    worst = Math.max(worst, run);
  }
  return worst / rate;
}

for (const rate of [44100, 48000]) {
  for (const [label, step, reached] of [['2×', 2, 2], ['4×', 4, 4], ['Max', Infinity, 7.3]]) {
    test(`pacer, ${rate} Hz, ${label}: 1× → fast-forward → 1× → fast-forward plays the loop both times, the game’s sound in between`, () => {
      const A = squareTune(rate);
      const g = pacedGame(rate, A);
      g.run(10);
      assert.ok(g.m.found, 'a loop was found at 1×');
      for (const round of [1, 2]) {
        const c0 = g.c;
        g.speed(step, reached);
        const ff = g.run(5);
        assert.ok(ff.srcs.slice(-Math.round((4.8 * rate) / 128)).every((s) => s === 'loop'), `round ${round}: the loop plays (${[...new Set(ff.srcs)]})`);
        assert.ok(quietest(ff.out, rate, Math.round(0.1 * rate)) < 0.1, `round ${round}: no silence`);
        if (round === 1) assert.ok(corr(ff.out, A, c0, Math.round(0.2 * rate), ff.out.length) > 0.99, 'the tune goes on exactly');
        g.speed(1);
        const back = g.run(5);
        assert.ok(back.srcs.slice(Math.round((0.3 * rate) / 128)).every((s) => s === 'game'), `round ${round}: the game’s sound again`);
      }
      assert.deepEqual(g.ev.filter((e) => e.changed || e.type === 'chop'), [], 'no song change, never "choppy"');
      assert.equal(g.m.chop.level, 0);
    });
  }

  test(`pacer, ${rate} Hz: a new song after a fast-forward plays its sped-up sound in the next one (square waves and OpenAL’s holes are not "choppy")`, () => {
    const g = pacedGame(rate, squareTune(rate));
    g.run(10);
    g.speed(2);
    g.run(5);
    g.speed(1);
    g.run(1);
    // a state is loaded: another place, another song (square waves over a sampled instrument), too little of it for a loop
    g.m.command({ type: 'cut' });
    const sq = squareTune(rate, { seed: 9 });
    g.music = (c) => sq(c) + 0.05 * Math.sin((2 * Math.PI * 330 * c) / rate);
    g.run(2);
    g.speed(2);
    const ff = g.run(3);
    assert.equal(g.m.chop.level, 0, 'not judged choppy');
    assert.equal(g.m.carry, null);
    assert.ok(ff.srcs.every((x) => x === 'game'), `the new song’s sped-up sound plays (${[...new Set(ff.srcs)]})`);
    assert.ok(quietest(ff.out, rate, Math.round(0.6 * rate)) < 0.15, 'music, not silence');
  });
}

test('pacer: step changes 2× → 3× → 4× → Max, pause and resume while the loop plays – it plays on, no song change', () => {
  const rate = 48000;
  const g = pacedGame(rate, squareTune(rate));
  g.run(10);
  g.speed(2);
  g.run(1);
  for (const s of [3, 4, Infinity]) {
    g.speed(s, s === Infinity ? 9 : s);
    const o = g.run(1);
    assert.ok(o.srcs.slice(-100).every((x) => x === 'loop'), `${s}×: the loop`);
  }
  g.m.command({ type: 'paused', paused: true });
  const p = g.run(1, { input: false });
  assert.equal(rms(p.out.subarray(Math.round(0.1 * rate))), 0, 'quiet while paused');
  g.m.command({ type: 'paused', paused: false });
  const r = g.run(2);
  assert.ok(quietest(r.out, rate, Math.round(0.1 * rate)) < 0.1, 'back after the pause');
  assert.ok(r.srcs.slice(-100).every((x) => x === 'loop'));
  assert.deepEqual(g.ev.filter((e) => e.changed), []);
});

test('a mixer whose sound stops right after the switch to fast-forward goes quiet instead of looping forever', () => {
  // (the core rebuilt its audio: this mixer's context gets nothing any more – player.html retires it now, but on its
  // own it must not keep playing either)
  const rate = 48000;
  const g = pacedGame(rate, squareTune(rate));
  g.run(10);
  g.speed(4);
  g.run(0.1);
  const after = g.run(3, { input: false });
  assert.equal(rms(after.out.subarray(Math.round(2 * rate))), 0, 'quiet within two seconds');
});

test('every speed, mode, pause and cut command leaves a state for diagnostics', () => {
  const m = new TurboMixer(SR, { seconds: 30 });
  const ev = [];
  m.onEvent = (e) => e.type === 'state' && ev.push(e);
  feed(m, tune(), 0, 16);
  m.command({ type: 'speed', ratio: 3 });
  m.command({ type: 'mode', mode: 'mute' });
  m.command({ type: 'paused', paused: true });
  m.command({ type: 'cut' });
  m.command({ type: 'song', key: 'm1' }); // (not a control command: no state)
  assert.deepEqual(ev.map((e) => [e.cmd, e.arg]), [['speed', 3], ['mode', 'mute'], ['paused', true], ['cut', null]]);
  assert.equal(ev[0].turbo, true);
  assert.equal(ev[0].carry, 'loop');
  assert.ok(ev[0].seg > 15, `seconds recorded: ${ev[0].seg}`);
  assert.equal(ev[3].sr, SR);
});

// ---- 2.2.0-beta.3: every core without the sound speed-up, the mixer at up to 96 kHz --------------------------------
// Paced from the display, RetroArch's sped-up sound came out chopped (48 kHz) or at a pitch jumping between 1× and ~8×
// (96 kHz); slowed down it sounded fast (a player with a 96 kHz sound card, GBA). Now every core plays the classic
// fast-forward sound – the song at normal pitch, skipping ahead – and the mixer runs in its skip mode. player.html runs
// the sound at ≤ 48 kHz (lib/pacer.mjs soundRate), but if the browser refuses, the mixer gets the card's 96 kHz.

/** A little tune at `rate`, as tune() (sine notes, a new one every 0.2 s, repeating every `period` s). */
function tuneAt(rate, { period = 6.4, seed = 1 } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const step = Math.round(0.2 * rate);
  const steps = Math.round((period * rate) / step);
  const notes = Array.from({ length: steps }, () => 220 * 2 ** (Math.floor(rnd() * 15) / 12));
  const loud = Array.from({ length: steps }, () => 0.4 + rnd() * 0.6);
  const P = steps * step;
  return (t) => {
    const p = ((t % P) + P) % P;
    const k = Math.floor(p / step);
    const x = (p - k * step) / rate;
    return 0.3 * loud[k] * Math.min(1, x / 0.005) * Math.exp(-x * 6) * Math.sin(2 * Math.PI * notes[k] * x);
  };
}
/** Feeds fn(i) for `seconds` at `rate` in 128-sample blocks; returns the output and what played per block. */
function feedAt(m, rate, fn, seconds) {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  const srcs = [];
  const l = new Float32Array(128);
  const oL = new Float32Array(128);
  const oR = new Float32Array(128);
  for (let i = 0; i < n; i += 128) {
    for (let j = 0; j < 128; j++) l[j] = fn(i + j);
    m.process(l, null, oL, oR, 128);
    out.set(oL.subarray(0, Math.min(128, n - i)), i);
    srcs.push(m.playing().src);
  }
  return { out, srcs };
}
/** The classic fast-forward sound at `rate`: 20 ms pieces of the song at normal pitch, `ratio`× as far apart. */
const skippingAt = (rate, music, ratio, from = 0) => {
  const piece = Math.round(0.02 * rate);
  return (i) => {
    const k = Math.floor(i / piece);
    return music(from + k * piece * ratio + (i - k * piece));
  };
};

for (const rate of [48000, 96000]) {
  test(`skip mode at ${rate / 1000} kHz (GBA, song keys): the loop plays in every fast-forward, a new scene's unheard song keeps it going, never slowed down`, () => {
    const A = tuneAt(rate, { seed: 1 });
    const C = tuneAt(rate, { seed: 7 });
    const m = new TurboMixer(rate, { seconds: 60 });
    m.command({ type: 'skip', on: true }); // (player.html, every core)
    m.command({ type: 'song', key: 'p3.84' });
    let t = feedAt(m, rate, A, 14).out.length;
    assert.ok(m.lib.has('p3.84'), 'the route’s loop is kept');
    assert.ok(Math.abs(m.found.lag - 6.4 * rate) < 0.002 * rate, `loop of ${(m.found.lag / rate).toFixed(3)} s`);
    for (const [round, step] of [[1, 4], [2, 16]]) {
      m.command({ type: 'speed', ratio: step }); // (16: "Max", as player.html sends it)
      const ff = feedAt(m, rate, skippingAt(rate, A, step, t), 3);
      assert.ok(ff.srcs.slice(Math.round((0.2 * rate) / 128)).every((s) => s === 'loop' || s === 'lib'), `round ${round}: the loop (${[...new Set(ff.srcs)]})`);
      assert.ok(longestQuiet(ff.out, 0, ff.out.length) * (SR / rate) < 0.1, `round ${round}: no silence`);
      m.command({ type: 'speed', ratio: 1 });
      const back = feedAt(m, rate, (i) => A(t + i), 3);
      t += back.out.length;
      assert.ok(back.srcs.slice(Math.round((0.3 * rate) / 128)).every((s) => s === 'game'), `round ${round}: the game’s sound again`);
    }
    // a scene change while fast-forwarding, to a song never heard at 1× (the player's "m405"): the route's loop goes on
    // (2.2.1-beta.1 played the game's skipping sound here – what the player heard as sped-up music)
    m.command({ type: 'speed', ratio: 4 });
    feedAt(m, rate, skippingAt(rate, A, 4, t), 1);
    m.command({ type: 'song', key: 'm405' });
    const src = skippingAt(rate, C, 4, 0);
    const scene = feedAt(m, rate, src, 2);
    assert.ok(Math.abs(corr(scene.out, src, -m.dc.D, Math.round(0.4 * rate), scene.out.length)) < 0.2, 'not the game’s own sound');
    assert.ok(scene.srcs.every((s) => s === 'loop' || s === 'lib'), `the loop goes on (${[...new Set(scene.srcs)]})`);
  });
}

// ---- 2.2.1-beta.2: "Music continues" never plays the game's own fast-forward sound; mixers hand over what they recorded --
// A Windows player (2.2.1-beta.1, GBA) heard sped-up music in "Music continues" after scene changes – "Sped-up original"
// and "Plain" then sounded the same, only "Mute" differed. The skipping fast-forward sound (every core since 2.2) was the
// mixer's fallback whenever it had nothing recorded for the song: after a scene change to an unheard song, and after every
// rebuild of the core's sound (a new AudioContext when Windows restarts its GPU process – the new mixer knew nothing).

test('skip mode: a scene change during fast-forward to an unheard song keeps the previous loop – never the skipping sound', () => {
  const rate = 48000;
  const A = tuneAt(rate, { seed: 1 });
  const C = tuneAt(rate, { seed: 7 });
  const m = new TurboMixer(rate, { seconds: 60 });
  m.command({ type: 'skip', on: true });
  m.command({ type: 'song', key: 'p3.84' });
  const t = feedAt(m, rate, A, 14).out.length;
  m.command({ type: 'speed', ratio: 4 });
  feedAt(m, rate, skippingAt(rate, A, 4, t), 1);
  m.command({ type: 'song', key: 'm405' }); // a song never heard at 1×
  const src = skippingAt(rate, C, 4, 0);
  const scene = feedAt(m, rate, src, 3);
  const from = Math.round(0.2 * rate);
  assert.ok(scene.srcs.slice(from / 128).every((s) => s === 'loop' || s === 'lib'), `the previous loop (${[...new Set(scene.srcs)]})`);
  assert.ok(Math.abs(corr(scene.out, src, -m.dc.D, from, scene.out.length)) < 0.2, 'not the game’s skipping sound');
  assert.ok(longestQuiet(scene.out, 0, scene.out.length) * (SR / rate) < 0.1, 'music, not silence');
  assert.equal(m.live.t, 0, 'the game’s sound stays muted');
});

test('skip mode, nothing recorded at all: "Music continues" is quiet while fast-forwarding, "Sped-up original" plays the game', () => {
  const f = tune({ seed: 5, period: 120 });
  const m = new TurboMixer(SR, { seconds: 60 });
  m.command({ type: 'skip', on: true });
  feed(m, f, 0, 1);
  m.command({ type: 'speed', ratio: 4 });
  const src = skipping(f, 4, SR);
  const music = feed(m, src, 0, 2);
  assert.equal(rms(music.subarray(Math.round(0.2 * SR))), 0, 'music mode: silence, not the sped-up music');
  m.command({ type: 'mode', mode: 'original' });
  const orig = feed(m, (i) => src(2 * SR + i), 0, 2);
  assert.ok(corr(orig, (i) => src(2 * SR + i), -m.dc.D, Math.round(0.2 * SR), orig.length) > 0.9, 'original: the game’s own sound');
});

test('mute while fast-forwarding silences every state the mixer can be in (loop, bed, library, sped-up sound, nothing)', () => {
  const A = tune({ seed: 1 });
  for (const setup of ['loop', 'sped', 'skip-lib', 'skip-nothing']) {
    const m = new TurboMixer(SR, { seconds: 30 });
    if (setup.startsWith('skip')) m.command({ type: 'skip', on: true });
    m.command({ type: 'song', key: 'mA' });
    if (setup === 'loop' || setup === 'skip-lib') feed(m, A, 0, 14);
    m.command({ type: 'speed', ratio: 3 });
    feed(m, sped(A, 3, 14 * SR), 0, 1.5);
    m.command({ type: 'mode', mode: 'mute' });
    const out = feed(m, sped(A, 3, 16 * SR), 0, 1);
    assert.equal(rms(out.subarray(Math.round(0.2 * SR))), 0, `${setup}: silent`);
  }
});

test('a voice without length, score or fine never makes the status report throw', () => {
  const m = new TurboMixer(SR, { seconds: 30 });
  const d = m.describe({ lag: Infinity, xfade: 0 });
  assert.deepEqual(d, { seconds: null, score: null, fine: null, xfade: 0 });
});

/** A mixer that heard `songs` ({ key: tune }) at 1× for 14 s each, in that order. */
function heard(rate, songs, { skip = true } = {}) {
  const m = new TurboMixer(rate, { seconds: 60 });
  if (skip) m.command({ type: 'skip', on: true });
  for (const [key, f] of Object.entries(songs)) {
    m.command({ type: 'song', key });
    feedAt(m, rate, f, 14);
  }
  return m;
}

test('the core rebuilt its sound: the new mixer takes over the old one’s library and plays the song’s loop right away', () => {
  const rate = 48000;
  const A = tuneAt(rate, { seed: 1 });
  const B = tuneAt(rate, { seed: 2 });
  const old = heard(rate, { mA: A, mB: B });
  assert.ok(old.lib.has('mA') && old.lib.has('mB'));
  let memory = null;
  old.onEvent = (e) => e.type === 'export' && (memory = e);
  old.command({ type: 'export' });
  assert.ok(memory && memory.lib.length === 2 && memory.sr === rate, 'exported');
  // the new context's mixer: attached while fast-forwarding, told what player.html tells it, then the hand-over
  const m = new TurboMixer(rate, { seconds: 60 });
  const ev = [];
  m.onEvent = (e) => ev.push(e);
  m.command({ type: 'mode', mode: 'music' });
  m.command({ type: 'speed', ratio: 4 });
  m.command({ type: 'skip', on: true });
  m.command({ type: 'song', key: 'mA' });
  m.command({ ...structuredClone(memory), type: 'import' });
  assert.ok(ev.some((e) => e.type === 'import' && e.ok && e.songs === 2));
  const out = feedAt(m, rate, skippingAt(rate, A, 4, 0), 2);
  assert.ok(out.srcs.slice(Math.round((0.2 * rate) / 128)).every((s) => s === 'lib'), `route A’s loop (${[...new Set(out.srcs)]})`);
  // and a scene change to B while still fast-forwarding: B's loop from the handed-over library
  m.command({ type: 'song', key: 'mB' });
  const b = feedAt(m, rate, skippingAt(rate, B, 4, 0), 2);
  assert.ok(m.voice?.lib && m.voice.key === 'mB', 'route B’s loop');
  assert.ok(longestQuiet(b.out, 0, b.out.length) * (SR / rate) < 0.15);
});

test('hand-over without song keys: the music that played last goes on in the new mixer', () => {
  const rate = 48000;
  const A = tuneAt(rate, { seed: 3 });
  const old = new TurboMixer(rate, { seconds: 60 });
  old.command({ type: 'skip', on: true });
  const t = feedAt(old, rate, A, 14).out.length;
  old.command({ type: 'speed', ratio: 4 });
  feedAt(old, rate, skippingAt(rate, A, 4, t), 1);
  assert.equal(old.playing().src, 'loop');
  let memory = null;
  old.onEvent = (e) => e.type === 'export' && (memory = e);
  old.command({ type: 'export' });
  assert.ok(memory.last?.l instanceof Int16Array, 'the playing loop, copied out');
  const m = new TurboMixer(rate, { seconds: 60 });
  m.command({ type: 'speed', ratio: 4 });
  m.command({ type: 'skip', on: true });
  m.command({ ...memory, type: 'import' });
  const out = feedAt(m, rate, skippingAt(rate, A, 4, t + 4 * rate), 2);
  assert.ok(out.srcs.slice(Math.round((0.2 * rate) / 128)).every((s) => s === 'lib'), `the handed-over loop (${[...new Set(out.srcs)]})`);
  assert.ok(whichSongAt(out.out, rate, A) > 0.8, 'it is the song that played');
});

test('hand-over between contexts at different rates is refused (the samples are not resampled)', () => {
  const old = heard(16000, { mA: tune({ seed: 1 }) });
  let memory = null;
  old.onEvent = (e) => e.type === 'export' && (memory = e);
  old.command({ type: 'export' });
  const m = new TurboMixer(48000, { seconds: 10 });
  const ev = [];
  m.onEvent = (e) => ev.push(e);
  m.command({ ...memory, type: 'import' });
  assert.equal(m.lib.size, 0);
  assert.ok(ev.some((e) => e.type === 'import' && e.ok === false && e.why === 'rate'));
});

test('hand-over: what the new mixer recorded itself wins, the library stays within its bounds', () => {
  const A = tune({ seed: 1 });
  const B = tune({ seed: 2 });
  const old = heard(SR, { mA: A, mB: B });
  let memory = null;
  old.onEvent = (e) => e.type === 'export' && (memory = e);
  old.command({ type: 'export' });
  const m = heard(SR, { mB: tune({ seed: 9 }) });
  const own = m.lib.get('mB');
  m.k.libTotal = own.end + memory.lib.find((e) => e.key === 'mA').end; // room for exactly one more
  m.command({ ...memory, type: 'import' });
  assert.equal(m.lib.get('mB'), own, 'its own recording of B stays');
  assert.ok(m.lib.has('mA'), 'A taken over');
  assert.deepEqual([...m.lib.keys()], ['mA', 'mB'], 'taken over = least recently heard');
});

test('the mixer reports the blocks it processed (diagnostics: is the audio thread running it?)', () => {
  const m = new TurboMixer(SR, { seconds: 10 });
  feed(m, tune(), 0, 1);
  let p = null;
  m.onEvent = (e) => e.type === 'probe' && (p = e);
  m.command({ type: 'probe' });
  assert.equal(p.quanta, Math.ceil(SR / BLOCK));
  assert.equal(p.playing, 'game');
});

/** Share of out's 25 ms note frames that follow the melody of f at `rate` (any alignment within one 6.4 s period). */
function whichSongAt(out, rate, f) {
  const F = Math.round(0.025 * rate);
  const n = Math.floor((out.length - Math.round(0.3 * rate)) / F);
  const ref = (get, n0, frames) => {
    const seq = new Int8Array(frames);
    for (let j = 0; j < frames; j++) {
      let best = -1;
      let bp = 1e-6;
      for (let k = 0; k < 15; k++) {
        const c = 2 * Math.cos((2 * Math.PI * 220 * 2 ** (k / 12)) / rate);
        let s1 = 0;
        let s2 = 0;
        for (let i = 0; i < F; i++) {
          const s0 = get(n0 + j * F + i) + c * s1 - s2;
          s2 = s1;
          s1 = s0;
        }
        const pw = s1 * s1 + s2 * s2 - c * s1 * s2;
        if (pw > bp) [bp, best] = [pw, k];
      }
      seq[j] = best;
    }
    return seq;
  };
  const heardSeq = ref((i) => out[i] || 0, Math.round(0.3 * rate), n);
  const period = Math.round((6.4 * rate) / F);
  const want = ref(f, 0, period + n);
  let best = 0;
  for (let o = 0; o < period; o++) {
    let hit = 0;
    for (let j = 0; j < n; j++) if (heardSeq[j] >= 0 && heardSeq[j] === want[o + j]) hit++;
    best = Math.max(best, hit / n);
  }
  return best;
}

// --- 3DS: the host's own fast-forward sound (ctrhost.c message 8 → TurboMixer.ffSound) ------------------------------

/**
 * The 3DS host while fast-forwarding at k×, as ctrhost.c ff_frame: the core's sound (`music`, in the game's samples)
 * low-passed (4th-order Butterworth at 0.45 × the output's Nyquist / k) and resampled by k to real time (Hermite) – and
 * the core's sound as it is (FFSOUND). Each call: the next `n` real-time samples → { own, sped }; setK changes the ratio
 * (the host's "ffrate").
 */
function ctrHost(music, k) {
  const bq = [0.5412, 1.3066].map(() => ({ z0: 0, z1: 0 }));
  const setK = (to) => {
    k = to;
    const w = (2 * Math.PI * 0.45 * 0.5) / k;
    [0.5412, 1.3066].forEach((q, s) => {
      const c = Math.cos(w);
      const al = Math.sin(w) / (2 * q);
      const a0 = 1 + al;
      Object.assign(bq[s], { b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0, a1: (-2 * c) / a0, a2: (1 - al) / a0 });
    });
  };
  setK(k);
  const lp = (x) => {
    for (const b of bq) {
      const y = b.b0 * x + b.z0;
      b.z0 = b.b1 * x - b.a1 * y + b.z1;
      b.z1 = b.b2 * x - b.a2 * y;
      x = y;
    }
    return x;
  };
  const q = [];
  let pos = 1;
  const next = (n) => {
    const own = new Float32Array(Math.max(0, Math.ceil(pos + n * k + 3) - q.length));
    for (let i = 0; i < own.length; i++) q.push(lp((own[i] = music(q.length))));
    const sped = new Float32Array(n);
    for (let j = 0; j < n; j++, pos += k) {
      const i = Math.floor(pos);
      const t = pos - i;
      const [xm, x0, x1, x2] = [q[i - 1], q[i], q[i + 1], q[i + 2]];
      sped[j] = (((0.5 * (x2 - xm) + 1.5 * (x0 - x1)) * t + (xm - 2.5 * x0 + 2 * x1 - 0.5 * x2)) * t + 0.5 * (x1 - xm)) * t + x0;
    }
    return { own, sped };
  };
  next.setK = setK;
  return next;
}

/**
 * `seconds` of fast-forward from a ctrHost: the sped-up sound through process(), the own sound (`own`) to ffSound. With
 * `keep` the sped-up sound that went in is returned too (out.sped).
 */
function feedHost(m, host, seconds, { own = true, rate = m.sr, keep = false } = {}) {
  const n = Math.ceil((seconds * rate) / BLOCK) * BLOCK; // (whole blocks: what is fed is what comes out)
  const out = new Float32Array(n);
  const sped = keep ? new Float32Array(n) : null;
  const oL = new Float32Array(BLOCK);
  const oR = new Float32Array(BLOCK);
  for (let i = 0; i < n; i += BLOCK) {
    const h = host(BLOCK);
    if (own) m.ffSound(h.own, h.own, h.own.length);
    m.process(h.sped, null, oL, oR, BLOCK);
    out.set(oL.subarray(0, Math.min(BLOCK, n - i)), i);
    sped?.set(h.sped.subarray(0, Math.min(BLOCK, n - i)), i);
  }
  if (keep) out.sped = sped;
  return out;
}

test('3DS own fast-forward sound: only "music" uses it – "original" plays the sped-up sound, "mute" nothing, 1× ignores it', () => {
  const A = tune({ seed: 4 });
  const B = tune({ seed: 9 });
  for (const mode of ['original', 'mute']) {
    const m = new TurboMixer(SR, { seconds: 30 });
    m.command({ type: 'mode', mode });
    feed(m, A, 0, 6);
    m.command({ type: 'speed', ratio: 3 });
    m.command({ type: 'rate', ratio: 3, exact: true });
    const host = ctrHost(B, 3);
    const n = Math.round(1.5 * SR);
    const out = new Float32Array(n);
    const sped = new Float32Array(n);
    const oL = new Float32Array(BLOCK);
    const oR = new Float32Array(BLOCK);
    for (let i = 0; i < n; i += BLOCK) {
      const h = host(BLOCK);
      m.ffSound(h.own, h.own, h.own.length);
      m.process(h.sped, null, oL, oR, BLOCK);
      out.set(oL.subarray(0, Math.min(BLOCK, n - i)), i);
      sped.set(h.sped.subarray(0, Math.min(BLOCK, n - i)), i);
    }
    assert.equal(m.own, false, `${mode}: not taken`);
    const tail = Math.round(0.2 * SR);
    if (mode === 'mute') assert.equal(rms(out.subarray(tail)), 0, 'mute stays mute');
    else for (let i = tail; i < n; i++) assert.ok(Math.abs(out[i] - sped[i]) < 1e-6, 'original: the sped-up sound as it is');
  }
  const m = new TurboMixer(SR, { seconds: 30 });
  feed(m, A, 0, 2);
  const before = m.ring.written;
  m.ffSound(new Float32Array(4096).fill(0.1), new Float32Array(4096).fill(0.1));
  assert.equal(m.ring.written, before, 'at 1× the own sound is not recorded (the game’s sound is)');
  assert.equal(m.own, false);
});

test('3DS own fast-forward sound: speed steps and the host’s ratio changes – "Music continues" with nothing recorded plays the sped-up sound as it comes', () => {
  const f = tune({ seed: 9, period: 120 });
  const m = new TurboMixer(SR, { seconds: 60 });
  feed(m, () => 0, 0, 1);
  m.command({ type: 'speed', ratio: 2 });
  const host = ctrHost(f, 2);
  let out = new Float32Array(0);
  let sped = new Float32Array(0);
  let changed = 0;
  m.onEvent = (e) => e.changed && changed++;
  for (const [k, sec] of [[2, 1.5], [3.4, 1], [2.6, 1], [4, 1.5]]) {
    if (k !== 2) m.command({ type: 'speed', ratio: Math.ceil(k) });
    m.command({ type: 'rate', ratio: k, exact: true });
    host.setK(k);
    const o = feedHost(m, host, sec, { keep: true });
    out = Float32Array.of(...out, ...o);
    sped = Float32Array.of(...sped, ...o.sped);
  }
  assert.ok(m.own);
  assert.ok(off(out, (i) => sped[i]) < 1e-6, 'the host’s sped-up sound, sample for sample, through every step');
  assert.equal(changed, 0, 'no song change heard in the steps');
});

test('3DS battle (song keys from the zone and the battle reader): the battle music plays in the battle and stops with it – never stuck', () => {
  const A = tune({ seed: 1 }); // the route
  const B = tune({ seed: 2 }); // the battle
  const R = SR;
  const m = new TurboMixer(R, { seconds: 60 });
  m.command({ type: 'song', key: 'p7.20' });
  feed(m, A, 0, 14);
  assert.ok(m.lib.has('p7.20'), 'the route’s loop, recorded at 1×');
  // fast-forward at 4× (the game's time runs 4× the real one): 1 s on the route, a battle of 40 s, the route again
  const t0 = 14 * R;
  const tB = t0 + 4 * R;
  const tEnd = tB + 40 * R;
  const game = (t) => (t < tB || t >= tEnd ? A(t) : B(t - tB));
  m.command({ type: 'speed', ratio: 4 });
  m.command({ type: 'rate', ratio: 4, exact: true });
  const host = ctrHost((i) => game(t0 + i), 4);
  let out = feedHost(m, host, 1);
  let [a, b] = whichSong(out, Math.round(0.3 * R), out.length, [A, B]);
  assert.ok(a > 0.8, `the route’s loop (A ${a.toFixed(2)})`);
  // the battle music begins; the 'battle' key comes 2 s later (battle flag + the live reader's 0.7 s)
  feedHost(m, host, 2);
  m.command({ type: 'song', key: 'battle' });
  out = feedHost(m, host, 7, { keep: true });
  // nothing recorded of the battle: the game's own sped-up sound, as the game plays it (the route's loop faded out)
  assert.equal(m.playing().src, 'game', `the battle's own sound plays (${JSON.stringify(m.playing())})`);
  assert.ok(off(out, (i) => out.sped[i], Math.round(0.1 * R)) < 1e-6, 'the battle as the game plays it');
  // the battle ends (game time tEnd = real 11 s), the route's key comes 1.5 s after the route's music
  feedHost(m, host, 1 + 1.5);
  m.command({ type: 'song', key: 'p7.20' });
  out = feedHost(m, host, 3);
  [a, b] = whichSong(out, Math.round(0.5 * R), out.length, [A, B]);
  assert.ok(a > 0.8 && b < 0.4, `the route’s music after the battle (A ${a.toFixed(2)}, B ${b.toFixed(2)})`);
  // a few seconds at 1× and fast-forward again: still the route
  m.command({ type: 'speed', ratio: 1 });
  feed(m, A, 0, 2);
  m.command({ type: 'speed', ratio: 4 });
  out = feedHost(m, ctrHost(A, 4), 3);
  [a, b] = whichSong(out, Math.round(0.5 * R), out.length, [A, B]);
  assert.ok(a > 0.8 && b < 0.4, `the route again, not the battle (A ${a.toFixed(2)}, B ${b.toFixed(2)})`);
  const [la, lb] = libSong(m.lib.get('p7.20'), [A, B]);
  assert.ok(la > 0.8 && lb < 0.3, `the route’s entry holds the route only (A ${la.toFixed(2)}, B ${lb.toFixed(2)})`);
});

test('a battle key that comes 2 s late at 1× (the battle reader): nothing of the battle is filed under the route', () => {
  const A = tune({ seed: 1, period: 30 }); // a long route theme (beds, no loop yet)
  // the battle: a tone the route never plays, so any of it in the route's entry can be measured
  const B = (t) => 0.2 * Math.sin((2 * Math.PI * 1500 * t) / SR) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 3 * t) / SR));
  const battleShare = (e) => {
    const x = Float32Array.from(e.l, (v) => v / 32767);
    const F = 400;
    const c = 2 * Math.cos((2 * Math.PI * 1500) / SR);
    let hit = 0;
    let n = 0;
    for (let o = 0; o + F <= x.length; o += F, n++) {
      let s1 = 0;
      let s2 = 0;
      for (let i = o; i < o + F; i++) [s1, s2] = [x[i] + c * s1 - s2, s1];
      if ((Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) * 2) / F > 0.05) hit++;
    }
    return hit / n;
  };
  let kept = 0;
  for (let phase = 0.5; phase <= 7; phase += 0.5) {
    const m = new TurboMixer(SR, { seconds: 30 });
    m.command({ type: 'song', key: 'p7.20' });
    feed(m, A, 0, 6 + phase);
    feed(m, B, 0, 2); // the battle music; the key 2 s later
    m.command({ type: 'song', key: 'battle' });
    feed(m, B, 2 * SR, 3);
    const e = m.lib.get('p7.20');
    if (!e) continue;
    kept++;
    // (before 2.8.0 up to 11 % of the entry – the battle's first ~0.6 s, played on the route every time the bed came round)
    assert.equal(battleShare(e), 0, `phase ${phase}: ${(battleShare(e) * 100).toFixed(0)} % of the route’s entry is battle music`);
  }
  assert.ok(kept >= 10, `the route’s entry is still kept on most visits (${kept} of 14)`);
});

test('3DS own fast-forward sound: the game’s own sound goes on – no loop of raced-through sound that repeats its effects and hides the real ones', () => {
  // A Windows player's Pokémon Y video (2.8.x, "Music continues" at 4×, the PC at ≈1.8–3.7×): in the first trainer battle a
  // 5.66 s loop found in the fast-forward recording played on through the knock-out, the level-up and the prize money –
  // an attack sound from before the knock-out came round every 5.66 s, the real sounds of the battle never came. (2.8.1
  // played the game's own sound "streamed" instead – each sound up to a second late; now it is the sped-up sound.)
  const B = tune({ seed: 2 }); // the battle music (repeats every 6.4 s: a loop is there to be found)
  const FX = 1500; // a battle sound the music never plays
  const fxAt = [2, 25].map((s) => s * SR); // game time: one early in the battle (inside any loop found), one late
  const game = (t) => B(t) + (fxAt.some((a) => t >= a && t < a + 0.3 * SR) ? 0.25 * Math.sin((2 * Math.PI * FX * t) / SR) : 0);
  const k = 3.6;
  const m = new TurboMixer(SR, { seconds: 60 });
  m.command({ type: 'song', key: 'p6.1' });
  feed(m, tune({ seed: 1 }), 0, 3); // the town at 1× (too short for a loop)
  m.command({ type: 'speed', ratio: 4 });
  m.command({ type: 'rate', ratio: k, exact: true });
  m.command({ type: 'song', key: 'battle' });
  const out = feedHost(m, ctrHost(game, k), 12, { keep: true });
  // what the game plays, as it plays it: each battle sound once, with the picture – nothing on repeat
  assert.ok(off(out, (i) => out.sped[i]) < 1e-6, 'the host’s sped-up sound, sample for sample');
  assert.equal(m.carry, null, 'no loop found in the fast-forward recording');
});
