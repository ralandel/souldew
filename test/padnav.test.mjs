// Controller navigation of the app's screens (web/lib/padnav.mjs, issue #33): where the focus moves, key repeat,
// reading the controller with the player's mapping, who owns the controller, the back stack – and the game frames
// ignoring the controller while the app has it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickTarget, firstTarget, createRepeat, readPad, gameOwnsPad, createLayerStack, trackHistory, backAction, edges } from '../web/lib/padnav.mjs';
import { appHasPad } from '../web/lib/controls.mjs';

const R = (left, top, width = 100, height = 40) => ({ left, top, right: left + width, bottom: top + height });

// a shelf of cartridges: 3 per row, 2 rows
const grid = [R(0, 0, 120, 150), R(140, 0, 120, 150), R(280, 0, 120, 150), R(0, 170, 120, 150), R(140, 170, 120, 150), R(280, 170, 120, 150)];

test('the focus moves to the neighbour in the pressed direction', () => {
  assert.equal(pickTarget(grid[0], 'right', grid), 1);
  assert.equal(pickTarget(grid[0], 'down', grid), 3);
  assert.equal(pickTarget(grid[4], 'up', grid), 1);
  assert.equal(pickTarget(grid[4], 'left', grid), 3);
  assert.equal(pickTarget(grid[5], 'up', grid), 2);
  // nothing that way
  assert.equal(pickTarget(grid[0], 'left', grid), -1);
  assert.equal(pickTarget(grid[0], 'up', grid), -1);
  assert.equal(pickTarget(grid[5], 'right', grid), -1);
  assert.equal(pickTarget(grid[0], 'down', []), -1);
  // the end of a row: a button high above whose centre merely lies further right is not "right"
  assert.equal(pickTarget(grid[2], 'right', [...grid, R(330, -400, 120, 30)]), -1);
});

test('being off to the side counts more than being a little further away', () => {
  const from = R(400, 0, 100, 40);
  const below = R(400, 220, 100, 40); // straight below, far
  const nearSide = R(0, 60, 100, 40); // much closer, but way off to the left
  assert.equal(pickTarget(from, 'down', [nearSide, below]), 1);
  // with nothing below it, the one off to the side is still reachable
  assert.equal(pickTarget(from, 'down', [nearSide]), 0);
});

test('of two equally near controls the better aligned one wins', () => {
  // a wide search field above a row of three buttons: down lands on the one under its centre
  const field = R(0, 0, 300, 40);
  const row = [R(0, 60, 90, 30), R(105, 60, 90, 30), R(210, 60, 90, 30)];
  assert.equal(pickTarget(field, 'down', row), 1);
  // a control that starts a bit higher but is still clearly to the right counts as "right"
  assert.equal(pickTarget(R(0, 100, 100, 40), 'right', [R(120, 96, 100, 40), R(120, 300, 100, 40)]), 0);
});

test('controls that only overlap the focused one are reached when nothing lies cleanly ahead', () => {
  // the focus sits on a big card; its own small button lies inside, below the card's centre
  const card = R(0, 0, 300, 200);
  const inner = R(100, 150, 100, 30);
  assert.equal(pickTarget(card, 'down', [inner]), 0);
  // but a control cleanly below wins over the overlapping one
  assert.equal(pickTarget(card, 'down', [inner, R(0, 220, 300, 40)]), 1);
});

test('rects can be given as DOMRect-like { x, y, width, height }', () => {
  assert.deepEqual(edges({ x: 10, y: 20, width: 30, height: 40 }), { left: 10, top: 20, right: 40, bottom: 60, cx: 25, cy: 40 });
  assert.equal(pickTarget({ x: 0, y: 0, width: 50, height: 50 }, 'right', [{ x: 60, y: 0, width: 50, height: 50 }]), 0);
});

test('the first focus is the first control in reading order – in sight if possible', () => {
  const list = [R(300, 10), R(20, 12), R(20, 200)];
  assert.equal(firstTarget(list), 1, 'same row (within 16 px): the left one');
  assert.equal(firstTarget(list, { left: 0, top: 100, right: 800, bottom: 600 }), 2, 'scrolled down: the first one on screen');
  assert.equal(firstTarget([]), -1);
});

test('a held direction moves at once, again after a pause, then steadily', () => {
  const rep = createRepeat({ delay: 300, rate: 100 });
  assert.equal(rep('down', 0), 'down');
  assert.equal(rep('down', 16), null);
  assert.equal(rep('down', 290), null);
  assert.equal(rep('down', 300), 'down');
  assert.equal(rep('down', 350), null);
  assert.equal(rep('down', 400), 'down');
  // another direction starts over, a release resets
  assert.equal(rep('right', 410), 'right');
  assert.equal(rep('right', 500), null);
  assert.equal(rep(null, 520), null);
  assert.equal(rep('right', 530), 'right');
});

const pad = (pressed = [], axes = [0, 0, 0, 0]) => ({ buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })), axes });

test('the controller is read with the console buttons of Settings › Controller', () => {
  // Nintendo layout (the default): A is the right face button (1), B the bottom one (0)
  assert.equal(readPad(pad([1])).confirm, true);
  assert.equal(readPad(pad([0])).back, true);
  assert.equal(readPad(pad([0])).confirm, false);
  // Xbox layout: A bottom
  assert.equal(readPad(pad([0]), { preset: 'xbox' }).confirm, true);
  assert.equal(readPad(pad([1]), { preset: 'xbox' }).back, true);
  // a remapped A follows the player's choice
  assert.equal(readPad(pad([3]), { preset: 'nintendo', map: { a: 'BUTTON_4', x: 'BUTTON_2' } }).confirm, true);
  // shoulders, Start and X (the previous option of a select)
  const s = readPad(pad([4, 5, 9, 3]));
  assert.deepEqual([s.prev, s.next, s.menu, s.alt], [true, true, true, true]);
  // Y (the favourite star of a focused look): left face button on the Nintendo layout, top on Xbox
  assert.equal(readPad(pad([2])).extra, true);
  assert.equal(readPad(pad([3])).extra, false);
  assert.equal(readPad(pad([3]), { preset: 'xbox' }).extra, true);
});

test('directions come from the D-pad, else the left stick; the right stick scrolls', () => {
  assert.equal(readPad(pad([12])).dir, 'up');
  assert.equal(readPad(pad([15])).dir, 'right');
  assert.equal(readPad(pad([], [-0.9, 0.2, 0, 0])).dir, 'left');
  assert.equal(readPad(pad([], [0.3, 0.8, 0, 0])).dir, 'down');
  assert.equal(readPad(pad([], [0.3, 0.3, 0, 0])).dir, null, 'a slightly pushed stick is no direction');
  const s = readPad(pad([], [0, 0, 0.1, -0.7]));
  assert.equal(s.scrollX, 0, 'dead zone');
  assert.equal(s.scrollY, -0.7);
});

test('the game\'s own hotkeys (ZL/ZR, Home) are no app input', () => {
  assert.equal(readPad(pad([6])).any, false);
  assert.equal(readPad(pad([7, 16])).any, false);
  assert.equal(readPad(pad([1])).any, true);
  assert.equal(readPad(pad([], [0.9, 0, 0, 0])).any, true);
  assert.equal(readPad(pad()).any, false);
});

test('the game owns the controller while it fills the page and plays – and only then', () => {
  const game = { mode: 'full', playing: true, paused: false, overlay: false };
  assert.equal(gameOwnsPad(game), true);
  assert.equal(gameOwnsPad({ ...game, paused: true }), false, 'paused: the menus get it');
  assert.equal(gameOwnsPad({ ...game, mode: 'mini' }), false, 'in the corner: the pages around it get it');
  assert.equal(gameOwnsPad({ ...game, overlay: true }), false, 'a menu, panel or prompt over the game');
  assert.equal(gameOwnsPad(game, { dialog: true }), false, 'a dialog of the app (death alert, close game …)');
  assert.equal(gameOwnsPad({ ...game, playing: false }), false, 'the game could not start');
  assert.equal(gameOwnsPad(null), false, 'no game at all');
});

test('B closes the newest layer first and the focus goes back where it was', () => {
  const box = (name, kids = []) => ({ name, kids });
  const contains = (layer, node) => layer.kids.includes(node);
  const stack = createLayerStack({ contains });
  const opener = { name: 'details button' };
  const inA = { name: 'button in the dialog' };
  const a = box('game dialog', [inA]);
  const b = box('cover picker', []);
  assert.equal(stack.top(), null);
  assert.deepEqual(stack.sync([a], [inA, opener]), [], 'the dialog moved the focus inside already: the opener is the one before');
  assert.equal(stack.top(), a);
  stack.sync([a, b], [inA, opener]);
  assert.equal(stack.top(), b, 'opened from inside the dialog: newest on top');
  assert.equal(stack.size, 2);
  const closed = stack.sync([a], []);
  assert.deepEqual(closed.map((c) => [c.layer, c.opener]), [[b, inA]]);
  assert.equal(stack.top(), a);
  assert.deepEqual(stack.sync([], []).map((c) => [c.layer, c.opener]), [[a, opener]]);
  assert.equal(stack.top(), null);
  // two that turn up at once: the later (inner) one is newer
  const outer = box('drawer');
  const inner = box('dialog in the drawer');
  stack.sync([outer, inner], []);
  assert.equal(stack.top(), inner);
  // both close at once: newest first
  assert.deepEqual(stack.sync([], []).map((c) => c.layer), [inner, outer]);
});

test('the screen history: forward adds, back removes, B goes back – or to the sidebar at the start', () => {
  let h = ['#/library'];
  h = trackHistory(h, '#/settings');
  h = trackHistory(h, '#/guide?tab=keys');
  assert.deepEqual(h, ['#/library', '#/settings', '#/guide?tab=keys']);
  h = trackHistory(h, '#/settings'); // history.back()
  assert.deepEqual(h, ['#/library', '#/settings']);
  assert.equal(trackHistory(h, '#/settings'), h, 'the same screen again changes nothing');
  assert.equal(Array.from({ length: 80 }, (_, i) => `#/x${i}`).reduce(trackHistory, []).length, 50, 'capped');
  assert.equal(backAction({ layer: {}, depth: 3 }), 'layer');
  assert.equal(backAction({ layer: null, depth: 1 }), 'history');
  assert.equal(backAction({ layer: null, depth: 0 }), 'menu');
});

test('the game frames ignore their buttons while the app has the controller', async () => {
  const app = { __souldewPad: { mute: true } };
  const frame = { parent: app };
  assert.equal(appHasPad(frame), true);
  app.__souldewPad.mute = false;
  assert.equal(appHasPad(frame), false);
  const alone = {};
  alone.parent = alone; // a player page opened on its own (the ROM matrix, emu-test.html)
  assert.equal(appHasPad(alone), false);
  const foreign = { get parent() { throw new Error('cross-origin'); } };
  assert.equal(appHasPad(foreign), false);
  // all three players ask – and keep the pause / turbo hotkeys working meanwhile
  for (const f of ['../web/player.html', '../web/lib/nativeplayer.mjs', '../web/lib/ctrplayer.mjs']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(src, /appHasPad\(\)/, `${f} asks whether the app has the controller`);
    // (lib/controls.mjs padActions / padHotkeyPresses: ZR turbo, ZL and Home pause – and those while the app has it)
    assert.match(src, /padHotkeyPresses\(pad, padActions, held, (muted|controls\.appHasPad\(\))\)/, `${f} still has its hotkeys`);
  }
  const { padActions, padHotkeyPresses } = await import('../web/lib/controls.mjs');
  assert.deepEqual(padActions(null), { 7: 'turbo', 6: 'pause', 16: 'pause' });
  const pressed = (i) => ({ buttons: Array.from({ length: 17 }, (_, k) => ({ pressed: k === i })) });
  assert.deepEqual(padHotkeyPresses(pressed(6), padActions(null), {}, true).map((m) => m.action), ['pause'], 'ZL resumes from the menus');
  // the play view tells the app what it needs to decide, and stops when it closes
  const play = readFileSync(new URL('../web/views/play.mjs', import.meta.url), 'utf8');
  assert.match(play, /useEffect\(\(\) => claimPad\(/);
  // (with the 3DS screen-layout menu and the "3DS player stopped" message – both are drawn over the game)
  assert.match(play, /overlay: !!\(rulesOpen \|\| statesOpen \|\| soundOpen \|\| cheatOpen \|\| layoutOpen \|\| ctrFail \|\| confirmReset \|\| pendingLoad \|\| confirmCheat \|\| asked \|\| giftFor \|\| watchFor\)/);
  // the stopped-3DS message: A starts with "Play 3DS games in Azahar", B is "Close game" (the game is gone already)
  assert.match(play, /data-pad-first disabled=\$\{busy\} onClick=\$\{toAzahar\}/);
  assert.match(play, /data-pad-back onClick=\$\{onClose\}>\$\{t\('play\.close'/);
});

test('controller navigation is a setting, on unless switched off', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'sls-padnav-'));
  process.env.SLS_DATA_DIR = dir;
  const { startServer } = await import('../server/app.mjs');
  const { url, server } = await startServer({ port: 0, background: false });
  try {
    const H = { 'x-soullink': '1', 'content-type': 'application/json' };
    const status = () => fetch(`${url}/api/status`, { headers: H }).then((r) => r.json());
    const post = (body) => fetch(`${url}/api/config`, { method: 'POST', headers: H, body: JSON.stringify(body) }).then((r) => r.json());
    assert.equal((await status()).config.padNav, true);
    assert.equal((await post({ padNav: false })).padNav, false);
    assert.equal((await status()).config.padNav, false);
    assert.equal((await post({ padNav: 'yes' })).padNav, true, 'anything but false is on');
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
  // every language has the setting
  for (const lang of ['en', 'de', 'fr', 'es', 'it']) {
    const j = JSON.parse(readFileSync(new URL(`../web/i18n/${lang}.json`, import.meta.url), 'utf8'));
    assert.ok(j['pad.nav'] && j['pad.navHint']?.includes('{button}'), lang);
  }
});
