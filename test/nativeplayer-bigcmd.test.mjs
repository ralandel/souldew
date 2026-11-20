// The fast player (web/lib/nativeplayer.mjs) sends a big command – "where you left off" (a DS save state is ≈ 20 MB)
// – as a Blob: copied once when it is made, never concatenated into a new array and copied again into the request.
// It loads while the 3D launch animation runs, and those copies were 40–55 ms on the main thread – a dropped frame of the
// device (measured with the launch trace, web/lib/handheld/launchtrace.mjs). The bytes the host gets stay exactly the
// state, in order with the small commands around it; the play view's state (another window's Uint8Array, a view into a
// bigger buffer) is not copied first.
//
// The page runs here for real (as test/nativeplayer-fresh.test.mjs does), with a stand-in host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('/shared/')) return next(ROOT + spec.slice(1), ctx);
    if (spec.startsWith('/lib/')) return next(`${ROOT}web${spec}`, ctx);
    return next(spec, ctx);
  },
});

const LIB = new URL('../web/lib/', import.meta.url);
const TMP = mkdtempSync(join(tmpdir(), 'sls-native-bigcmd-'));
const timers = new Set();
const { setInterval: realInterval, setTimeout: realTimeout } = globalThis;
test.after(() => {
  for (const t of timers) clearInterval(t), clearTimeout(t);
  rmSync(TMP, { recursive: true, force: true });
});

const any = () => new Proxy(function () {}, {
  get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : k === 'then' ? undefined : any()),
  apply: () => any(),
  construct: () => any(),
  set: () => true,
});
const msg = (type, payload) => {
  const b = new Uint8Array(8 + payload.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, type, true);
  v.setUint32(4, payload.length, true);
  b.set(payload, 8);
  return b;
};
const event = (o) => msg(7, new TextEncoder().encode(JSON.stringify(o)));
const picture = (() => {
  const b = new Uint8Array(8 + 4);
  const v = new DataView(b.buffer);
  v.setUint16(0, 1, true);
  v.setUint16(2, 1, true);
  return msg(2, b);
})();

const host = { stream: null, bodies: [], cmds: [] };
const json = (x) => new Response(JSON.stringify(x), { headers: { 'content-type': 'application/json' } });
const page = new EventTarget();
Object.assign(globalThis, {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  devicePixelRatio: 1,
  location: { search: '?system=nds&rom=%2From&key=k&name=Platinum&audio=0', origin: 'http://127.0.0.1' },
  document: Object.assign(any(), { visibilityState: 'visible', getElementById: () => any(), body: any(), documentElement: any() }),
  window: globalThis,
  parent: { postMessage() {}, __souldewPad: { mute: false } },
  addEventListener: page.addEventListener.bind(page),
  removeEventListener: page.removeEventListener.bind(page),
  dispatchEvent: page.dispatchEvent.bind(page),
  requestAnimationFrame: () => 0,
  ResizeObserver: class { observe() {} },
  setInterval: (...a) => { const t = realInterval(...a); timers.add(t); return t; },
  setTimeout: (...a) => { const t = realTimeout(...a); timers.add(t); return t; },
  fetch: async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('/api/status')) return json({ config: { lang: 'en', controls: null, pads: null } });
    if (u.startsWith('/api/native/start')) return json({ id: 's1', core: 'melonds' });
    if (u.startsWith('/api/native/stream')) {
      return new Response(new ReadableStream({
        start: (c) => {
          host.stream = c;
          c.enqueue(event({ event: 'loaded', ram: [{ addr: 0x02000000, len: 0x100, ok: true }] }));
          c.enqueue(picture);
        },
        pull: () => new Promise(() => {}),
      }));
    }
    if (u.startsWith('/api/native/cmd')) {
      host.bodies.push(opts.body instanceof Blob ? 'blob' : 'bytes');
      const b = opts.body instanceof Blob ? new Uint8Array(await opts.body.arrayBuffer()) : new Uint8Array(opts.body);
      const v = new DataView(b.buffer, b.byteOffset, b.length);
      for (let o = 0; o + 8 <= b.length; o += 8 + v.getUint32(o + 4, true)) {
        const type = v.getUint32(o, true);
        const p = b.slice(o + 8, o + 8 + v.getUint32(o + 4, true));
        host.cmds.push([type, p]);
        if (type === 4) host.stream?.enqueue(event({ event: 'stateLoaded', ok: true })); // LOAD
      }
      return new Response(new Uint8Array(0));
    }
    return json({});
  },
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en', getGamepads: () => [null, null, null, null] } });

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

test('fast player: a big save state goes as one Blob, byte for byte; small commands stay plain bytes', async () => {
  const emu = globalThis.__emu;
  await until(() => emu?.ready);
  // the play view's state: a Uint8Array of ANOTHER window (realm), a view into a bigger buffer
  const other = vm.runInNewContext('new Uint8Array(3 * 1024 * 1024 + 64)');
  for (let i = 0; i < other.length; i++) other[i] = (i * 7 + 3) & 0xff;
  const state = other.subarray(32, other.length - 32);
  assert.equal(state instanceof Uint8Array, false, '(another realm: not an instanceof here)');
  host.cmds.length = 0;
  host.bodies.length = 0;
  assert.equal(await emu.loadState(state), true);
  const loads = host.cmds.filter(([t]) => t === 4);
  assert.equal(loads.length, 1);
  assert.equal(loads[0][1].length, state.length);
  assert.ok(loads[0][1].every((x, i) => x === state[i]), 'the host gets exactly the state');
  assert.ok(host.bodies.includes('blob'), 'sent as a Blob');
  // a small command: plain bytes, as before
  host.bodies.length = 0;
  emu.getState(); // (SAVE, no payload – the stand-in never answers it)
  await until(() => host.bodies.length);
  assert.deepEqual(host.bodies, ['bytes']);
});

test('fast player: the bytes of a big command are the ones of the moment it was made', async () => {
  const emu = globalThis.__emu;
  const big = new Uint8Array(300 * 1024).fill(5);
  host.cmds.length = 0;
  const p = emu.loadState(big);
  big.fill(9); // (the caller reuses its buffer at once)
  assert.equal(await p, true);
  const load = host.cmds.find(([t]) => t === 4);
  assert.ok(load[1].every((x) => x === 5));
});
