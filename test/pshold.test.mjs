// A partner's picture keeps its last good frame instead of going black (web/lib/pshold.mjs,
// views/partnerscreen.mjs Picture) – the trailer's "Lena live" tile went black for ~1.6 s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meanLuma, keepable, pictureLayers, DARK_LUMA } from '../web/lib/pshold.mjs';

const frame = (r, g, b, n = 64) => {
  const u8 = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) u8.set([r, g, b, 255], i * 4);
  return u8;
};

test('meanLuma / keepable: black and near-black frames are never kept, game pictures are', () => {
  assert.equal(meanLuma(frame(0, 0, 0)), 0);
  assert.ok(Math.abs(meanLuma(frame(255, 255, 255)) - 255) < 0.01);
  assert.equal(meanLuma(new Uint8ClampedArray(0)), 0);
  assert.equal(keepable(frame(0, 0, 0)), false); // a turned-off track sends these
  assert.equal(keepable(frame(3, 3, 3)), false); // encoder noise on black
  assert.equal(keepable(frame(40, 60, 40)), true); // a dark cave still counts
  assert.equal(keepable(frame(150, 210, 170)), true); // Oldale Town grass
  // a black picture with a little light in it: kept once the mean is past the line
  const mixed = frame(0, 0, 0);
  for (let i = 0; i < 8; i++) mixed.set([255, 255, 255, 255], i * 4);
  assert.equal(keepable(mixed), meanLuma(mixed) >= DARK_LUMA);
});

test('pictureLayers: with a kept frame there is never an empty (black) box', () => {
  const S = {}; // a stream
  for (const live of [true, false]) for (const stream of [S, null]) for (const imageMode of [true, false]) for (const ready of [true, false]) {
    const L = pictureLayers({ live, stream, imageMode, ready, hasHold: true });
    const shown = ((L.video || L.img) && ready) || L.hold;
    assert.ok(shown, JSON.stringify({ live, stream: !!stream, imageMode, ready }));
  }
});

test('pictureLayers: the cases of the trailer take and the ones around it', () => {
  const S = {};
  // running video: just the video
  assert.deepEqual(pictureLayers({ live: true, stream: S, imageMode: false, ready: true, hasHold: true }), { video: true, img: false, hold: false, dim: false, msg: false });
  // new stream / remounted video that hasn't drawn yet: the kept frame, not dimmed, no message
  assert.deepEqual(pictureLayers({ live: true, stream: S, imageMode: false, ready: false, hasHold: true }), { video: true, img: false, hold: true, dim: false, msg: false });
  // video → stills (the still hasn't loaded yet): the kept frame
  assert.deepEqual(pictureLayers({ live: true, stream: null, imageMode: true, ready: false, hasHold: true }), { video: false, img: true, hold: true, dim: false, msg: false });
  // the partner's picture stopped (an older app pausing): the last frame, dimmed, with the message on it
  assert.deepEqual(pictureLayers({ live: false, stream: null, imageMode: false, ready: false, hasHold: true }), { video: false, img: false, hold: true, dim: true, msg: true });
  // never had a picture: only the message
  assert.deepEqual(pictureLayers({ live: false, stream: null, imageMode: false, ready: false, hasHold: false }), { video: false, img: false, hold: false, dim: false, msg: true });
});
