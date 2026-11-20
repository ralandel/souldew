// The 3DS player's page (web/lib/ctrplayer.mjs) run for real with a stand-in page around it (as test/controls-live): a
// server that answers its requests and records every INPUT it sends the host – joypad bits and the Circle Pad (int16,
// native/ctr-host/ctrhost.c input.lx / ly). The half-tilt key (Settings › Controls "Circle Pad: half tilt", default C)
// held with a direction key: the Circle Pad at 40 % and no D-pad bit; on a controller button the same.
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

const WEB = new URL('../web/', import.meta.url);
const SHARED = new URL('../shared/', import.meta.url);
const TMP = mkdtempSync(join(tmpdir(), 'sls-ctrhalftilt-'));
const timers = new Set();
const { setInterval: realInterval, setTimeout: realTimeout } = globalThis;
test.after(() => {
  for (const t of timers) clearInterval(t), clearTimeout(t);
  rmSync(TMP, { recursive: true, force: true });
});

// whatever the page asks of the DOM, WebGL or the sound that this test doesn't care about: a harmless "anything"
const any = () => new Proxy(function () {}, {
  get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : k === 'then' ? undefined : any()),
  apply: () => any(),
  construct: () => any(),
  set: () => true,
});
const pad = {
  id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, connected: true, mapping: 'standard',
  axes: [0, 0, 0, 0], buttons: Array.from({ length: 18 }, () => ({ pressed: false, value: 0 })),
};
const press = (i, on) => Object.assign(pad.buttons[i], { pressed: on, value: on ? 1 : 0 });
const inputs = []; // every INPUT: { buttons, lx, ly }
const last = () => inputs.at(-1);
const UP = 1 << 4;
const DOWN = 1 << 5;
const LEFT = 1 << 6;
const RIGHT = 1 << 7;
const A = 1 << 8;
// one 1×1 picture: the page counts as started
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
const config = { lang: 'en', controls: null, pads: null }; // nothing saved: the half tilt on C

const page = new EventTarget();
Object.assign(globalThis, {
  // (3.0's players watch the screen's pixel density: lib/pixelscale.mjs)
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  devicePixelRatio: 1,
  location: { search: '?rom=%2From.3ds&key=k', origin: 'http://127.0.0.1' },
  document: Object.assign(any(), { visibilityState: 'visible', getElementById: () => any(), createElement: () => any(), body: any(), documentElement: any() }),
  window: globalThis,
  parent: { postMessage() {}, __souldewPad: { mute: false } },
  addEventListener: page.addEventListener.bind(page),
  removeEventListener: page.removeEventListener.bind(page),
  dispatchEvent: page.dispatchEvent.bind(page),
  requestAnimationFrame: () => 0,
  ResizeObserver: class { observe() {} },
  AudioContext: undefined,
  setInterval: (...a) => { const t = realInterval(...a); timers.add(t); return t; },
  setTimeout: (...a) => { const t = realTimeout(...a); timers.add(t); return t; },
  fetch: async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('/api/status')) return json({ config });
    if (u.startsWith('/api/ctr/start')) return json({ id: 's1' });
    if (u.startsWith('/api/ctr/stream')) {
      return new Response(new ReadableStream({ start: (c) => c.enqueue(picture), pull: () => new Promise(() => {}) }));
    }
    if (u.startsWith('/api/ctr/cmd')) {
      const b = new Uint8Array(opts.body);
      const v = new DataView(b.buffer, b.byteOffset, b.length);
      for (let o = 0; o + 8 <= b.length; o += 8 + v.getUint32(o + 4, true)) {
        if (v.getUint32(o, true) === 1) inputs.push({ buttons: v.getUint32(o + 8, true), lx: v.getInt16(o + 12, true), ly: v.getInt16(o + 14, true) });
      }
      return new Response(new Uint8Array(0));
    }
    return json({}); // translations, anything else
  },
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en', getGamepads: () => [pad, null, null, null] } });

// the page imports its modules by their path on the server – here from web/lib and shared/ (copied next to it, with
// their own server paths rewritten the same way)
const rewrite = (s) => s
  .replace(/from '\/lib\/([\w-]+\.mjs)'/g, (m, f) => `from '${new URL(`lib/${f}`, WEB).href}'`)
  .replace(/from '\/shared\/([\w/-]+\.mjs)'/g, (m, f) => `from '${new URL(f, SHARED).href}'`);
const file = join(TMP, 'ctrplayer.mjs');
writeFileSync(file, rewrite(readFileSync(new URL('lib/ctrplayer.mjs', WEB), 'utf8')));
await import(pathToFileURL(file).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, ms = 3000) {
  const t0 = Date.now();
  while (!what()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await sleep(10);
  }
}
const key = (type, keyCode, code = '') => {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, { keyCode, key: '', code, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
  page.dispatchEvent(e);
  return e;
};
const TILT = Math.round(0.4 * 0x7fff);

test('3DS player: C held with → – the Circle Pad at 40 %, no D-pad; let go – full tilt again', async () => {
  await until(() => globalThis.__emu?.ready);
  key('keydown', 39, 'ArrowRight');
  await sleep(30);
  assert.deepEqual(last(), { buttons: RIGHT, lx: 0x7fff, ly: 0 }, 'without it: D-pad and full tilt, as before');
  assert.equal(key('keydown', 67, 'KeyC').defaultPrevented, true, 'C is the game’s now');
  await sleep(30);
  assert.deepEqual(last(), { buttons: 0, lx: TILT, ly: 0 });
  key('keydown', 38, 'ArrowUp');
  await sleep(30);
  assert.equal(last().buttons, 0);
  assert.ok(Math.abs(Math.hypot(last().lx, last().ly) - TILT) < 2 && last().ly < 0, JSON.stringify(last()));
  key('keyup', 38, 'ArrowUp');
  key('keyup', 67, 'KeyC');
  await sleep(30);
  assert.deepEqual(last(), { buttons: RIGHT, lx: 0x7fff, ly: 0 });
  key('keyup', 39, 'ArrowRight');
  await sleep(30);
  assert.deepEqual(last(), { buttons: 0, lx: 0, ly: 0 });
  // the window losing the focus lets go of it (no half tilt stuck on)
  key('keydown', 67, 'KeyC');
  page.dispatchEvent(new Event('blur'));
  key('keydown', 37, 'ArrowLeft');
  await sleep(30);
  assert.deepEqual(last(), { buttons: LEFT, lx: -0x7fff, ly: 0 });
  key('keyup', 37, 'ArrowLeft');
});

test('3DS player: the half tilt re-bound in Settings applies at once – the old key is a plain key again', async () => {
  await until(() => globalThis.__emu?.ready);
  globalThis.__emu.setControls({ controls: { sneak: { keyCode: 71, key: 'g', code: 'KeyG' } }, pads: null });
  key('keydown', 71, 'KeyG');
  key('keydown', 40, 'ArrowDown');
  await sleep(30);
  assert.deepEqual(last(), { buttons: 0, lx: 0, ly: TILT });
  key('keyup', 71, 'KeyG');
  await sleep(30);
  assert.deepEqual(last(), { buttons: DOWN, lx: 0, ly: 0x7fff });
  assert.equal(key('keydown', 67, 'KeyC').defaultPrevented, false, 'C does nothing now');
  key('keyup', 67, 'KeyC');
  key('keyup', 40, 'ArrowDown');
  // switched off: no key
  globalThis.__emu.setControls({ controls: { sneak: { none: true } }, pads: null });
  key('keydown', 67, 'KeyC');
  key('keydown', 38, 'ArrowUp');
  await sleep(30);
  assert.deepEqual(last(), { buttons: UP, lx: 0, ly: -0x7fff });
  key('keyup', 38, 'ArrowUp');
  key('keyup', 67, 'KeyC');
  globalThis.__emu.setControls({ controls: null, pads: null });
});

test('3DS player: on a controller button (Settings › Controller) it caps the left stick, and the D-pad sneaks too', async () => {
  await until(() => globalThis.__emu?.ready);
  // L3 (standard button 10) as the half tilt
  globalThis.__emu.setControls({ controls: null, pads: { preset: 'nintendo', map: { sneak: 'LEFT_STICK' } } });
  pad.axes = [1, 0, 0, 0];
  await sleep(80);
  assert.deepEqual(last(), { buttons: 0, lx: 0x7fff, ly: 0 }, 'the stick as it is');
  press(10, true);
  await sleep(80);
  assert.deepEqual(last(), { buttons: 0, lx: TILT, ly: 0 }, 'capped at 40 %');
  pad.axes = [0.25, 0, 0, 0];
  await sleep(80);
  assert.deepEqual(last(), { buttons: 0, lx: Math.round(0.25 * 0x7fff), ly: 0 }, 'a light tilt stays light');
  pad.axes = [0, 0, 0, 0];
  press(14, true); // D-pad left
  press(1, true); // A on the Nintendo layout
  await sleep(80);
  assert.deepEqual(last(), { buttons: A, lx: -TILT, ly: 0 }, 'the D-pad moves the Circle Pad at 40 %, A stays');
  press(10, false);
  await sleep(80);
  assert.deepEqual(last(), { buttons: A | LEFT, lx: 0, ly: 0 }, 'without it: the D-pad as before');
  press(14, false);
  press(1, false);
  await sleep(80);
  assert.deepEqual(last(), { buttons: 0, lx: 0, ly: 0 });
  // the half tilt is no joypad button: it never presses B (1 << undefined)
  press(10, true);
  await sleep(80);
  assert.equal(last().buttons, 0);
  press(10, false);
  // __emu.input (diagnostics) says what goes out
  globalThis.__emu.halfTilt(true);
  assert.deepEqual(globalThis.__emu.input(), { buttons: 0, lx: 0, ly: 0 });
  globalThis.__emu.stick(0, -1);
  assert.deepEqual(globalThis.__emu.input(), { buttons: 0, lx: 0, ly: -TILT });
  globalThis.__emu.stick(0, 0);
  globalThis.__emu.halfTilt(false);
  globalThis.__emu.setControls({ controls: null, pads: null });
});
