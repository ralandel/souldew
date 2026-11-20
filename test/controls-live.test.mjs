// Ticket #18 (Discord, 2.7.4, Windows 11, two DualSense controllers in a Platinum SoulLink): the controller was re-bound in
// Settings › Controller, Settings showed the new buttons – and the game kept the old ones. The game frames read
// Settings › Controls / › Controller once when they start; the game keeps running in the corner while Settings is open,
// and neither "Back to the game" nor the reset button loads the frame again. Now the play view hands every change over
// (__emu.setControls) and the players switch to it right away.
//
// The fast player's page (web/lib/nativeplayer.mjs – where DS games run by default) is run here for real, with a
// stand-in page around it: a fake DualSense, a server that answers its requests and records the input it sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

// 3.0: the players' modules import further modules by their server paths (/lib/…, /shared/…) – resolved to the files here
const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('/shared/')) return next(ROOT + spec.slice(1), ctx);
    if (spec.startsWith('/lib/')) return next(`${ROOT}web${spec}`, ctx);
    return next(spec, ctx);
  },
});

const LIB = new URL('../web/lib/', import.meta.url);
const TMP = mkdtempSync(join(tmpdir(), 'sls-controls-live-'));
const timers = new Set();
const { setInterval: realInterval, setTimeout: realTimeout } = globalThis;
test.after(() => {
  for (const t of timers) clearInterval(t), clearTimeout(t);
  rmSync(TMP, { recursive: true, force: true });
});

// ---- a stand-in page ------------------------------------------------------------------------------------------------
// Whatever the player asks of the DOM, WebGL or the sound that this test doesn't care about: a harmless "anything".
const any = () => new Proxy(function () {}, {
  get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : k === 'then' ? undefined : any()),
  apply: () => any(),
  construct: () => any(),
  set: () => true,
});
const pad = {
  id: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', index: 0, connected: true, mapping: 'standard',
  axes: [0, 0, 0, 0], buttons: Array.from({ length: 18 }, () => ({ pressed: false, value: 0 })),
};
const press = (i, on) => Object.assign(pad.buttons[i], { pressed: on, value: on ? 1 : 0 });
const inputs = []; // the buttons of every INPUT command the page sent (libretro bits)
const BITS = ['b', 'y', 'select', 'start', 'up', 'down', 'left', 'right', 'a', 'x', 'l', 'r'];
const held = () => BITS.filter((n, i) => inputs.at(-1) & (1 << i));
// a 1×1 picture: the page counts as started
const picture = (() => {
  const b = new Uint8Array(8 + 8 + 4);
  const v = new DataView(b.buffer);
  v.setUint32(0, 2, true); // MSG.VIDEO
  v.setUint32(4, 12, true);
  v.setUint16(8, 1, true);
  v.setUint16(10, 1, true);
  return b;
})();
const json = (x) => new Response(JSON.stringify(x), { headers: { 'content-type': 'application/json' } });
const config = { lang: 'en', controls: null, pads: null }; // nothing saved: the Nintendo layout, A on ○

const page = new EventTarget();
Object.assign(globalThis, {
  // (3.0's players watch the screen's pixel density: lib/pixelscale.mjs)
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  devicePixelRatio: 1,
  location: { search: '?system=nds&rom=%2From&key=k&name=Platinum', origin: 'http://127.0.0.1' },
  document: Object.assign(any(), { visibilityState: 'visible', getElementById: () => any(), body: any(), documentElement: any() }),
  window: globalThis,
  parent: { postMessage() {}, __souldewPad: { mute: false } }, // the app, its menus don't have the controller
  addEventListener: page.addEventListener.bind(page),
  removeEventListener: page.removeEventListener.bind(page),
  dispatchEvent: page.dispatchEvent.bind(page),
  requestAnimationFrame: () => 0,
  ResizeObserver: class { observe() {} },
  // (the page's timers end with this file)
  setInterval: (...a) => { const t = realInterval(...a); timers.add(t); return t; },
  setTimeout: (...a) => { const t = realTimeout(...a); timers.add(t); return t; },
  fetch: async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('/api/status')) return json({ config });
    if (u.startsWith('/api/native/start')) return json({ id: 's1', core: 'melonds' });
    if (u.startsWith('/api/native/stream')) {
      return new Response(new ReadableStream({ start: (c) => c.enqueue(picture), pull: () => new Promise(() => {}) }));
    }
    if (u.startsWith('/api/native/cmd')) {
      const b = new Uint8Array(opts.body);
      const v = new DataView(b.buffer, b.byteOffset, b.length);
      for (let o = 0; o + 8 <= b.length; o += 8 + v.getUint32(o + 4, true)) if (v.getUint32(o, true) === 1) inputs.push(v.getUint32(o + 8, true));
      return new Response(new Uint8Array(0));
    }
    return json({}); // translations
  },
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en', getGamepads: () => [pad, null, null, null] } });

// the page imports its modules by their path on the server – here they come from web/lib/
const src = readFileSync(new URL('nativeplayer.mjs', LIB), 'utf8').replace(/from '\/lib\/([\w-]+\.mjs)'/g, (m, f) => `from '${new URL(f, LIB).href}'`);
const file = join(TMP, 'nativeplayer.mjs');
writeFileSync(file, src);
await import(pathToFileURL(file).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, ms = 3000) {
  const t0 = Date.now();
  while (!what()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await sleep(10);
  }
}
const key = (type, keyCode) => {
  const e = new Event(type);
  Object.assign(e, { keyCode, key: '', code: '' });
  page.dispatchEvent(e);
};
// one press and release of a controller button → what the game got while it was down
async function tap(i) {
  press(i, true);
  await sleep(80);
  const got = held();
  press(i, false);
  await sleep(80);
  return got;
}

test('fast player: a controller re-bound while the game runs applies at once – no new game start needed', async () => {
  await until(() => globalThis.__emu?.ready);
  assert.equal(typeof globalThis.__emu.setControls, 'function');
  // as started: the Nintendo layout – ✕ (bottom) is B, ○ (right) is A
  assert.deepEqual(await tap(0), ['b']);
  assert.deepEqual(await tap(1), ['a']);
  // Settings › Controller: A re-bound to ✕ (the two swap) – what PadSection saves
  const pads = { preset: 'nintendo', map: { up: 'DPAD_UP', down: 'DPAD_DOWN', left: 'DPAD_LEFT', right: 'DPAD_RIGHT', a: 'BUTTON_1', b: 'BUTTON_2', x: 'BUTTON_4', y: 'BUTTON_3', l: 'LEFT_TOP_SHOULDER', r: 'RIGHT_TOP_SHOULDER', start: 'START', select: 'SELECT' } };
  globalThis.__emu.setControls({ controls: null, pads });
  assert.deepEqual(await tap(0), ['a'], '✕ is A now');
  assert.deepEqual(await tap(1), ['b'], '○ is B now');
  // or the Xbox layout (A bottom) picked from the two presets
  globalThis.__emu.setControls({ controls: null, pads: { preset: 'xbox' } });
  assert.deepEqual(await tap(0), ['a']);
  assert.deepEqual(await tap(3), ['y'], '△ (top) is Y on the Xbox layout');
  // back to "nothing saved"
  globalThis.__emu.setControls({ controls: null, pads: null });
  assert.deepEqual(await tap(0), ['b']);
});

test('fast player: re-bound keyboard keys apply at once too; the same settings again change nothing', async () => {
  await until(() => globalThis.__emu?.ready);
  const before = inputs.length;
  key('keydown', 75); // K: no game button by default
  key('keyup', 75);
  assert.equal(inputs.length, before, 'K does nothing yet');
  const controls = { a: { keyCode: 75, key: 'k', code: 'KeyK' } };
  globalThis.__emu.setControls({ controls, pads: null });
  key('keydown', 75);
  await sleep(30);
  assert.deepEqual(held(), ['a'], 'K is A now');
  // the play view hands the settings over again (a re-render, the game starting): a key held meanwhile stays held
  globalThis.__emu.setControls({ controls, pads: null });
  await sleep(30);
  assert.deepEqual(held(), ['a']);
  key('keyup', 75);
  await sleep(30);
  assert.deepEqual(held(), []);
  // a change while a key is down lets go of it – it isn't stuck under the button it no longer means
  key('keydown', 75);
  await sleep(30);
  globalThis.__emu.setControls({ controls: null, pads: null });
  await sleep(30);
  assert.deepEqual(held(), []);
});

test('every player takes changed controls while it runs, and the play view hands them over', () => {
  for (const f of ['../web/lib/nativeplayer.mjs', '../web/lib/ctrplayer.mjs']) {
    const s = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(s, /setControls\(config\) \{\n\s+applyControls\(config\);/, `${f}: __emu.setControls`);
    // the controller loop reads the current settings on every poll, not a copy made at start
    assert.match(s, /controls\.pickPad\(navigator\.getGamepads\?\.\(\) \|\| \[\], padCfg\?\.device \|\| null\)/, f);
    assert.match(s, /Object\.entries\(padButtons\)/, f);
    assert.doesNotMatch(s, /function startPads\(pads\)/, f);
  }
  const html = readFileSync(new URL('../web/player.html', import.meta.url), 'utf8');
  assert.match(html, /setControls: \(config\) => setControls\(config\)/);
  assert.match(html, /c\.pickPad\(navigator\.getGamepads\?\.\(\) \|\| \[\], padWanted\)/);
  // EmulatorJS' live table gets the new bindings (it looks every key and gamepad event up there)
  assert.match(html, /const now = E\(\)\?\.controls\?\.\[0\];/);
  const play = readFileSync(new URL('../web/views/play.mjs', import.meta.url), 'utf8');
  assert.match(play, /const controlsSig = JSON\.stringify\(\[status\?\.config\?\.controls \|\| null, status\?\.config\?\.pads \|\| null\]\);/);
  assert.match(play, /emu\(\)\?\.setControls\?\.\(\{ controls, pads \}\);\n\s+\}, \[phase, controlsSig\]\);/);
});

test('fast player: Tab fast-forwards instead of moving the focus; the controller can have fast-forward buttons too', async () => {
  await until(() => globalThis.__emu?.ready);
  const sent = [];
  const parentWas = globalThis.parent;
  globalThis.parent = { ...parentWas, postMessage: (m) => sent.push(m) };
  try {
    globalThis.__emu.setControls({ controls: null, pads: null });
    const down = (props) => {
      const e = new Event('keydown', { cancelable: true });
      Object.assign(e, { keyCode: 0, key: '', code: '', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }, props);
      page.dispatchEvent(e);
      return e;
    };
    // Tab and Shift+Tab: the play view gets them (with the keyCode it matches re-bound keys by), the focus stays here
    const tab = down({ keyCode: 9, key: 'Tab', code: 'Tab' });
    assert.equal(tab.defaultPrevented, true);
    assert.equal(down({ keyCode: 9, key: 'Tab', code: 'Tab', shiftKey: true }).defaultPrevented, true);
    assert.equal(down({ keyCode: 9, key: 'Tab', code: 'Tab', ctrlKey: true }).defaultPrevented, false, 'Ctrl+Tab stays the system’s');
    assert.equal(down({ keyCode: 71, key: 'g', code: 'KeyG' }).defaultPrevented, false, 'G is nothing');
    const k = sent.find((m) => m.type === 'emu-key' && m.key === 'Tab');
    assert.equal(k.keyCode, 9);
    assert.equal(down({ keyCode: 82, key: 'r', code: 'KeyR' }).defaultPrevented, true, 'R (reset) is the play view’s');
    // re-bound to G: G is kept, Tab moves the focus again (the way out of the game for keyboard users)
    globalThis.__emu.setControls({ controls: { ffHold: { keyCode: 71, key: 'g', code: 'KeyG' }, ffToggle: { keyCode: 72, key: 'h', code: 'KeyH' } }, pads: null });
    assert.equal(down({ keyCode: 71, key: 'g', code: 'KeyG' }).defaultPrevented, true);
    assert.equal(down({ keyCode: 9, key: 'Tab', code: 'Tab' }).defaultPrevented, false);
    // focus lost: the play view is told, so a held fast-forward ends whatever key it is on
    page.dispatchEvent(new Event('blur'));
    assert.ok(sent.some((m) => m.type === 'emu-key' && m.down === false && m.blur === true));

    // controller: R3 holds fast-forward, L3 switches it on / off – pressed and released like the keyboard's
    globalThis.__emu.setControls({ controls: null, pads: { preset: 'nintendo', map: { ffHold: 'RIGHT_STICK', ffToggle: 'LEFT_STICK' } } });
    sent.length = 0;
    await tap(11);
    assert.deepEqual(sent.filter((m) => m.type === 'emu-pad').map((m) => [m.action, m.down]), [['ffHold', true], ['ffHold', false]]);
    sent.length = 0;
    await tap(10);
    assert.deepEqual(sent.filter((m) => m.type === 'emu-pad').map((m) => [m.action, m.down]), [['ffToggle', true]]);
    sent.length = 0;
    assert.deepEqual(await tap(7), [], 'ZR (turbo) presses no game button');
    assert.deepEqual(sent.filter((m) => m.type === 'emu-pad').map((m) => m.action), ['turbo']);
  } finally {
    globalThis.parent = parentWas;
    globalThis.__emu.setControls({ controls: null, pads: null });
  }
});

test('fast player: R for B (Discord) – R presses B and no longer resets; Shift+R resets and presses nothing', async () => {
  await until(() => globalThis.__emu?.ready);
  const sent = [];
  const parentWas = globalThis.parent;
  globalThis.parent = { ...parentWas, postMessage: (m) => sent.push(m) };
  const ev = (type, props) => {
    const e = new Event(type, { cancelable: true });
    Object.assign(e, { keyCode: 82, key: 'r', code: 'KeyR', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }, props);
    page.dispatchEvent(e);
    return e;
  };
  try {
    // what Settings › Controls saves for "B on R, reset on Shift+R"
    const { assignKey } = await import('../web/lib/controls.mjs');
    const step1 = assignKey(null, 'b', { keyCode: 82, key: 'r', code: 'KeyR' }).next;
    const controls = assignKey(step1, 'reset', { keyCode: 82, key: 'r', code: 'KeyR', shift: true }).next;
    globalThis.__emu.setControls({ controls, pads: null });
    ev('keydown', {});
    await sleep(30);
    assert.deepEqual(held(), ['b'], 'R is B');
    ev('keyup', {});
    await sleep(30);
    assert.deepEqual(held(), []);
    // Shift+R: the play view's (reset) – the game gets nothing
    const e = ev('keydown', { key: 'R', shiftKey: true });
    await sleep(30);
    assert.equal(e.defaultPrevented, true);
    assert.deepEqual(held(), [], 'Shift+R presses no game button');
    ev('keyup', { key: 'R', shiftKey: true });
    assert.ok(sent.some((m) => m.type === 'emu-key' && m.keyCode === 82 && m.shift === true && m.down === true), 'forwarded to the play view');
  } finally {
    globalThis.parent = parentWas;
    globalThis.__emu.setControls({ controls: null, pads: null });
  }
});

test('every player keeps the shortcuts’ keys and hands the controller hotkeys over', () => {
  for (const f of ['../web/lib/nativeplayer.mjs', '../web/lib/ctrplayer.mjs']) {
    const s = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(s, /if \(controls\.isHotkeyKey\(e, hotkeys\)\) return e\.preventDefault\(\);/, f);
    assert.match(s, /hotkeys = controls\.resolveHotkeys\(config\?\.controls\);/, f);
    assert.match(s, /controls\.padHotkeyPresses\(pad, padActions, held, controls\.appHasPad\(\)\)/, f);
    assert.match(s, /keyCode: e\.keyCode/, f);
  }
  const html = readFileSync(new URL('../web/player.html', import.meta.url), 'utf8');
  assert.match(html, /controlsLib\.isHotkeyKey\(e, hotkeys\)[^]*?e\.stopPropagation\(\);\n\s+\}\n\s+\}, true\);/, 'player.html: before EmulatorJS (capture), which never sees it');
  assert.match(html, /hotkeys = c\.resolveHotkeys\(config\?\.controls\);/);
  assert.match(html, /c\.padHotkeyPresses\(pad, padActions, held, muted\)/);
  assert.match(html, /keyCode: e\.keyCode/);
  const play = readFileSync(new URL('../web/views/play.mjs', import.meta.url), 'utf8');
  assert.match(play, /hotRef\.current = resolveHotkeys\(status\?\.config\?\.controls\);/);
  assert.match(play, /else if \(e\.data\.action === 'ffHold'\) act\.current\.ffHold\(e\.data\.down !== false\);/);
});
