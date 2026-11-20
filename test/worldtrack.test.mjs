// Shared World: a partner who stood still and then walks off must not jump forward (shared/world.mjs, Track).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Track, SEND } from '../shared/world.mjs';

const st = (seq, t, x) => ({ seq, t, map: 1, fam: 3, x, y: 0, facing: 0, kind: 0 });

test('after standing still (heartbeats only) a partner who walks off slides – no jump of a tile or more', () => {
  const tr = new Track();
  let seq = 0;
  let t = 0;
  // walking for a while: a state every 66 ms, 1 px per frame (16 px per tile)
  let x = 0;
  for (; t < 2000; t += SEND.minMs) tr.push(st(++seq, t, (x = Math.round(t / 16.7))), t);
  // standing still for 30 s: only heartbeats, once a second
  for (const end = t + 30000; t < end; t += SEND.idleMs) tr.push(st(++seq, t, x), t);
  assert.ok(tr.delay < 200, `heartbeats leave the delay alone (${tr.delay})`);
  // walking off again – sample every frame, as the overlay draws
  const start = t;
  let prev = null;
  let maxStep = 0;
  for (let now = start; now < start + 3000; now += 16) {
    while (t <= now) { tr.push(st(++seq, t, x + Math.round((t - start) / 16.7)), t); t += SEND.minMs; }
    const s = tr.sample(now);
    if (prev && s) maxStep = Math.max(maxStep, Math.abs(s.x - prev.x));
    if (s) prev = s;
  }
  assert.ok(maxStep <= 4, `never more than a few pixels per frame (${maxStep})`);
});

test('the picture’s delay changes gently when the rhythm changes', () => {
  const tr = new Track();
  let seq = 0;
  for (let t = 0; t <= 2000; t += 400) tr.push(st(++seq, t, 0), t);
  const slow = tr.renderDelay(2000);
  for (let t = 2066; t <= 4000; t += 66) tr.push(st(++seq, t, 0), t);
  const next = tr.renderDelay(2016 + 2000 - 2000); // 16 ms later on our clock
  assert.ok(slow - next <= 8 + 1e-9, `at most half a millisecond per millisecond (${slow} → ${next})`);
});
