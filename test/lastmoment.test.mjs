// "Where you left off" when a game is closed from the UI (web/lib/lastmoment.mjs). The fast player and the 3DS player
// answer getState through their frame – the play view took the state only in its cleanup, the frame went in the same
// moment, the answer never came, and "Close game" left no "where you left off" (found in 3.0 testing; 2.8.3 did the
// same). Now the close takes the state first and ends the game once its bytes are in hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lastMoment, LAST_STATE_WAIT_MS } from '../web/lib/lastmoment.mjs';

/** A player like the fast one: a state asked for comes a moment later – and never once its frame is gone. */
function framePlayer(state = new Uint8Array([1, 2, 3])) {
  const p = { alive: true, asked: 0 };
  p.getState = () => {
    p.asked++;
    return new Promise((res) => setTimeout(() => p.alive && res(state), 5));
  };
  return p;
}

test('lastmoment: the fast player\'s state is in hand before the game (and its frame) goes', async () => {
  const lm = lastMoment();
  const player = framePlayer();
  let stored = null;
  lm.set(() => {
    const st = player.getState();
    st.then((b) => { stored = b; });
    return st;
  });
  let ended = false;
  const done = lm.close(() => {
    assert.ok(stored, 'the state arrived before the session ended');
    player.alive = false; // the play view unmounts – its frame goes
    ended = true;
  });
  assert.equal(ended, false, 'the close waits for the state');
  await done;
  assert.equal(ended, true);
  assert.deepEqual([...stored], [1, 2, 3]);
  assert.equal(player.asked, 1);
});

test('lastmoment: the old way loses it – a state asked for while the frame goes never comes', async () => {
  const player = framePlayer();
  const st = player.getState();
  player.alive = false; // (what the play view's cleanup did: ask, and the frame went in the same moment)
  const got = await Promise.race([st, new Promise((res) => setTimeout(() => res('lost'), 30))]);
  assert.equal(got, 'lost');
});

test('lastmoment: a state taken at once (the browser player), no game, or nothing to take: the close is immediate', () => {
  const lm = lastMoment();
  let n = 0;
  lm.close(() => n++);
  assert.equal(n, 1, 'no game registered');
  lm.set(() => new Uint8Array([9])); // the browser player's getState: the bytes themselves
  lm.close(() => n++);
  assert.equal(n, 2, 'bytes in hand');
  lm.set(() => null); // (not loaded yet / already stopped)
  lm.close(() => n++);
  assert.equal(n, 3);
  lm.set(() => {
    throw new Error('player busy');
  });
  lm.close(() => n++);
  assert.equal(n, 4, 'a player that throws never keeps the game open');
});

test('lastmoment: a stuck player keeps the game open at most LAST_STATE_WAIT_MS', async () => {
  let fire = null;
  let waited = 0;
  const lm = lastMoment({ setTimer: (f, ms) => { fire = f; waited = ms; return 1; }, clearTimer: () => {} });
  lm.set(() => new Promise(() => {})); // never answers
  let ended = false;
  const done = lm.close(() => { ended = true; });
  await Promise.resolve();
  assert.equal(ended, false);
  assert.equal(waited, LAST_STATE_WAIT_MS);
  fire();
  await done;
  assert.equal(ended, true);
  assert.ok(LAST_STATE_WAIT_MS >= 1000 && LAST_STATE_WAIT_MS <= 5000);
});

test('lastmoment: a second click while the state comes is the same close; the state is taken once', async () => {
  const lm = lastMoment();
  const player = framePlayer();
  lm.set(() => player.getState());
  let ends = 0;
  const a = lm.close(() => ends++);
  const b = lm.close(() => ends++);
  await Promise.all([a, b]);
  assert.equal(ends, 1);
  assert.equal(player.asked, 1);
  // the next game registers again
  lm.set(() => player.getState());
  await lm.close(() => ends++);
  assert.equal(ends, 2);
  assert.equal(player.asked, 2);
});

test('lastmoment: a game that went (the play view\'s cleanup) is not asked any more – a newer one stays', () => {
  const lm = lastMoment();
  let asked = '';
  const offOld = lm.set(() => { asked += 'old'; return null; });
  lm.set(() => { asked += 'new'; return null; }); // the next game registered before the old one's cleanup ran
  offOld();
  lm.close(() => {});
  assert.equal(asked, 'new');
  const offNew = lm.set(() => { asked += 'x'; return null; });
  offNew();
  lm.close(() => {});
  assert.equal(asked, 'new');
});

test('lastmoment: every close from the UI goes through it, and the play view takes its state there', () => {
  const app = readFileSync(new URL('../web/app.mjs', import.meta.url), 'utf8');
  const close = app.slice(app.indexOf('const closeSession = useCallback'), app.indexOf('const setMe = useCallback'));
  assert.match(close, /lastRef\.current\.close\(\(\) => \{\s*endSession\(\);\s*after\?\.\(\);/, '"Close game"');
  assert.match(app, /setPendingClose\(null\); lastRef\.current\.close\(\(\) => \{ endSession\(\); p\?\.after\?\.\(\); \}\)/, '"close anyway" after the unsaved question');
  assert.match(app, /setPendingRun\(null\); lastRef\.current\.close\(\(\) => \{ endSession\(\); switchRun\(id\); \}\)/, '"Close game & switch"');
  assert.match(app, /lastMoment: lastRef\.current/);
  const play = readFileSync(new URL('../web/views/play.mjs', import.meta.url), 'utf8');
  const take = play.slice(play.indexOf('const offLast = lastMoment?.set('), play.indexOf("window.addEventListener('sl-save-now', flushNow)"));
  assert.match(take, /const st = grabState\(\);\s*saveAuto\(st\);\s*return st;/, 'the state promise goes back to the close');
  assert.match(play, /stopped = true;\s*offLast\?\.\(\);/, 'the cleanup unregisters');
  assert.match(play, /if \(!lastTaken\) saveAuto\(loadedOk \? grabState\(\) : null\);/, 'closed another way: the cleanup still tries');
});
