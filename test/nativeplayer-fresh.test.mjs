// The fast player's copy of the game's memory (web/lib/nativeplayer.mjs): a cheat's write goes into the page's copy at
// once, and the host only ever sends the blocks that changed against what it sent last – so a write the game lost
// (Emerald moving its save blocks just then) never comes back, and reading the page's copy "back" proved nothing.
// __emu.fresh() asks the host for the whole memory once more (RESYNC): what the core really holds.
//
// The page runs here for real (as test/controls-live.test.mjs does), with a stand-in host behind its stream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('/shared/')) return next(ROOT + spec.slice(1), ctx);
    if (spec.startsWith('/lib/')) return next(`${ROOT}web${spec}`, ctx);
    return next(spec, ctx);
  },
});

const LIB = new URL('../web/lib/', import.meta.url);
const TMP = mkdtempSync(join(tmpdir(), 'sls-native-fresh-'));
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

// ---- the stand-in host: one RAM region, a core that may lose a write ----------------------------------------------
const BASE = 0x02000000;
const LEN = 0x1000;
const host = { core: new Uint8Array(LEN), shadow: new Uint8Array(LEN), lose: false, resyncs: 0, stream: null };
const msg = (type, payload) => {
  const b = new Uint8Array(8 + payload.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, type, true);
  v.setUint32(4, payload.length, true);
  b.set(payload, 8);
  return b;
};
const event = (o) => msg(7, new TextEncoder().encode(JSON.stringify(o)));
/** MSG.RAM: the whole region (full), or only the bytes that differ from what was sent last (as ramstream.c, per block). */
function ram(full) {
  const parts = [];
  for (let at = 0; at < LEN; at += 64) {
    if (!full && host.core.subarray(at, at + 64).every((x, i) => x === host.shadow[at + i])) continue;
    parts.push(at);
  }
  host.shadow.set(host.core);
  if (!parts.length) return null;
  const entries = full ? [[0, LEN]] : parts.map((at) => [at, 64]);
  const b = new Uint8Array(4 + entries.reduce((n, [, l]) => n + 8 + l, 0));
  const v = new DataView(b.buffer);
  v.setUint32(0, entries.length, true);
  let o = 4;
  for (const [at, l] of entries) {
    v.setUint32(o, BASE + at, true);
    v.setUint32(o + 4, l, true);
    b.set(host.core.subarray(at, at + l), o + 8);
    o += 8 + l;
  }
  return msg(8, b);
}
const send = (m) => m && host.stream?.enqueue(m);
const picture = (() => {
  const b = new Uint8Array(8 + 4);
  const v = new DataView(b.buffer);
  v.setUint16(0, 1, true);
  v.setUint16(2, 1, true);
  return msg(2, b);
})();
function onCmd(type, p) {
  if (type === 9) { // WRITE: between two frames – then the frame's RAM
    const addr = new DataView(p.buffer, p.byteOffset, 4).getUint32(0, true);
    if (!host.lose) host.core.set(p.subarray(4), addr - BASE);
    send(event({ event: 'written', addr, len: p.length - 4, ok: true }));
    send(ram(false));
  } else if (type === 12) { // RESYNC
    host.resyncs++;
    send(ram(true));
  }
}

const json = (x) => new Response(JSON.stringify(x), { headers: { 'content-type': 'application/json' } });
const page = new EventTarget();
Object.assign(globalThis, {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  devicePixelRatio: 1,
  location: { search: '?system=nds&rom=%2From&key=k&name=Platinum', origin: 'http://127.0.0.1' },
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
          c.enqueue(event({ event: 'loaded', ram: [{ addr: BASE, len: LEN, ok: true }] }));
          c.enqueue(picture);
        },
        pull: () => new Promise(() => {}),
      }));
    }
    if (u.startsWith('/api/native/cmd')) {
      const b = new Uint8Array(opts.body);
      const v = new DataView(b.buffer, b.byteOffset, b.length);
      for (let o = 0; o + 8 <= b.length; o += 8 + v.getUint32(o + 4, true)) onCmd(v.getUint32(o, true), b.subarray(o + 8, o + 8 + v.getUint32(o + 4, true)));
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

test('fast player: fresh() reads what the core holds – a write the game lost shows as lost', async () => {
  const emu = globalThis.__emu;
  await until(() => emu?.ready && emu.read(BASE, 1));
  assert.equal(typeof emu.fresh, 'function');
  // a write that lands: the page's copy, the core and a fresh read agree
  assert.equal(await emu.writeChecked(BASE + 0x100, Uint8Array.of(7, 8)), true);
  assert.equal(await emu.fresh(), true);
  assert.deepEqual([...emu.read(BASE + 0x100, 2)], [7, 8]);
  // a write the game lost: the host said "written", the page's copy holds it – and nothing ever corrects that copy
  host.lose = true;
  assert.equal(await emu.writeChecked(BASE + 0x200, Uint8Array.of(9)), true);
  await sleep(50);
  assert.equal(emu.read(BASE + 0x200, 1)[0], 9, '(the page\'s own copy: a read-back there proves nothing)');
  const before = host.resyncs;
  assert.equal(await emu.fresh(), true);
  assert.equal(host.resyncs, before + 1, 'the whole memory asked for once more');
  assert.equal(emu.read(BASE + 0x200, 1)[0], 0, 'the core never got it');
  host.lose = false;
});
