// The 3DS bag that isn't where souldew knows it (2.8.4): the 3DS player's page (web/lib/ctrplayer.mjs) run for real with
// a stand-in page and host around it (as test/ctrhalftilt-live) – the host keeps a synthetic game heap, answers WATCH
// with the regions asked for (MEM, unmapped ones empty) and WRITE as ctrhost.c does (only where the old bytes are still
// there). __emu.watch resolves once the regions are there; a Rare Candy cheat on an Ultra Moon whose bag sits at an
// address souldew doesn't know searches it through the page, writes there and keeps the place for the session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findEntry } from '../shared/live/parse.mjs';
import { applyCheat, readBalls } from '../shared/live/cheats.mjs';

const WEB = new URL('../web/', import.meta.url);
const SHARED = new URL('../shared/', import.meta.url);
const TMP = mkdtempSync(join(tmpdir(), 'sls-ctrbag-'));
const timers = new Set();
const { setInterval: realInterval, setTimeout: realTimeout } = globalThis;
test.after(() => {
  for (const t of timers) clearInterval(t), clearTimeout(t);
  rmSync(TMP, { recursive: true, force: true });
});

const TABLE = JSON.parse(readFileSync(new URL('../shared/data/addresses.json', import.meta.url)));
const UM = findEntry(TABLE, { platform: '3ds', titleId: '00040000001B5100' });
const le32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// the game's heap: 0x32F00000–0x33100000 mapped (zeros), Ultra Moon's bag 0x1F000 past where 1.0/1.2 keep it – an empty
// bag (a new game) with the game's pocket table behind it, in the order seen live in Ultra Moon 1.0
const HEAP = 0x32f00000;
const heap = new Uint8Array(0x200000);
const KNOWN = 0x33011934;
const BASE = KNOWN + 0x1f000;
heap.set([0xb74, 0x000, 0x9c4, 0xc64, 0x6ac, 0xd70, 0xdfc].flatMap((o) => le32(BASE + o)), BASE + 0xe28 - HEAP);
const mapped = (a, len) => a >= HEAP && a + len <= HEAP + heap.length;

// whatever the page asks of the DOM, WebGL or the sound that this test doesn't care about: a harmless "anything"
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
const event = (e) => msg(7, new TextEncoder().encode(JSON.stringify(e)));
// one 1×1 picture: the page counts as started
const picture = (() => {
  const p = new Uint8Array(8 + 4);
  const v = new DataView(p.buffer);
  v.setUint16(0, 1, true);
  v.setUint16(2, 1, true);
  return msg(2, p);
})();
const host = { watch: [], watches: 0, writes: [], stream: null };
function sendMem() {
  if (!host.stream) return;
  const parts = [le32(host.watch.length)];
  for (const { addr, len } of host.watch) {
    const ok = mapped(addr, len);
    parts.push(le32(addr), le32(ok ? len : 0));
    if (ok) parts.push([...heap.subarray(addr - HEAP, addr - HEAP + len)]);
  }
  host.stream.enqueue(msg(4, Uint8Array.from(parts.flat())));
}
function onCmd(b) {
  const v = new DataView(b.buffer, b.byteOffset, b.length);
  for (let o = 0; o + 8 <= b.length; o += 8 + v.getUint32(o + 4, true)) {
    const type = v.getUint32(o, true);
    const p = o + 8;
    if (type === 5) {
      const n = v.getUint32(p, true);
      host.watch = Array.from({ length: n }, (_, i) => ({ addr: v.getUint32(p + 4 + i * 8, true), len: v.getUint32(p + 8 + i * 8, true) }));
      host.watches++;
      realTimeout(sendMem, 5);
    } else if (type === 9) {
      const [id, addr, len] = [v.getUint32(p, true), v.getUint32(p + 4, true), v.getUint32(p + 8, true)];
      const old = b.subarray(p + 12, p + 12 + len);
      const val = b.subarray(p + 12 + len, p + 12 + 2 * len);
      const at = addr - HEAP;
      const same = mapped(addr, len) && old.every((x, i) => heap[at + i] === x);
      if (same) heap.set(val, at);
      host.writes.push(addr);
      realTimeout(() => host.stream.enqueue(event({ event: 'written', id, ok: same, ...(same ? {} : { why: 'changed' }) })), 5);
    }
  }
}
const json = (x) => new Response(JSON.stringify(x), { headers: { 'content-type': 'application/json' } });
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
    if (u.startsWith('/api/status')) return json({ config: { lang: 'en' } });
    if (u.startsWith('/api/ctr/start')) return json({ id: 's1' });
    if (u.startsWith('/shared/data/addresses.json')) return json(TABLE);
    if (u.startsWith('/api/ctr/stream')) {
      return new Response(new ReadableStream({
        start: (c) => {
          host.stream = c;
          c.enqueue(picture);
          c.enqueue(event({ event: 'loaded', memory: true }));
          c.enqueue(event({ event: 'title', titleId: '00040000001B5100' }));
          timers.add(realInterval(sendMem, 100)); // (the host: ten times a second)
        },
        pull: () => new Promise(() => {}),
      }));
    }
    if (u.startsWith('/api/ctr/cmd')) {
      onCmd(new Uint8Array(opts.body));
      return new Response(new Uint8Array(0));
    }
    return json({}); // translations, anything else
  },
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en', getGamepads: () => [null, null, null, null] } });

// the page imports its modules by their path on the server – here from web/lib and shared/
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
const emu = () => globalThis.__emu;
const started = () => until(() => emu()?.ready && emu().read(KNOWN, 4)); // (the game's own regions are read)

test('3DS player: watch() resolves once the host has sent the regions – then read() has them; too many: false', async () => {
  await started();
  const r = { addr: 0x33050000, len: 0x10000 };
  assert.equal(emu().read(r.addr, 4), null);
  assert.equal(await emu().watch([r]), true);
  assert.ok(emu().read(r.addr + 0xfffc, 4), 'all of it');
  assert.equal(await emu().watch([{ addr: 0x40000000, len: 0x1000 }]), true, 'an unmapped region comes too – empty');
  assert.equal(emu().read(0x40000000, 4), null);
  // more than fit next to the game's own (16 together): not all of them would ever come
  assert.equal(await emu().watch(Array.from({ length: 16 }, (_, i) => ({ addr: 0x32f00000 + i * 0x10000, len: 0x10000 }))), false);
  assert.equal(await emu().watch([]), true);
  assert.equal(emu().read(r.addr, 4), null, 'let go again');
});

test('3DS player: a bag souldew doesn’t know the place of is searched through the page, written there and kept', async () => {
  await started();
  const state = { g67: 0 };
  const mem = { read: emu().read, write: emu().write, watch: emu().watch };
  // the known address: all zeros and no table there – not the bag
  assert.equal(readBalls(UM, mem.read, state), null);
  const before = host.watches;
  const res = await applyCheat('rareCandy', UM, mem, state);
  assert.deepEqual(res, { ok: true, before: 0, after: 99, added: 99 });
  assert.deepEqual(state.ctrBag, { base: BASE, how: 'table' });
  assert.ok(host.watches > before, 'the page was asked for more memory');
  assert.equal(u32(heap, BASE + 0xb74 - HEAP), (50 | (99 << 10) | 0x40000000) >>> 0, 'Medicine of the bag found');
  assert.equal(u32(heap, KNOWN + 0xb74 - HEAP), 0, 'nothing written at the known address');
  // the place stays watched – the next cheat and the Poké Ball count need no search
  const n = host.watches;
  assert.deepEqual(await applyCheat('maxRepel', UM, mem, state), { ok: true, before: 0, after: 10, added: 10 });
  assert.equal(u32(heap, BASE - HEAP), (77 | (10 << 10) | 0x40000000) >>> 0);
  assert.equal(readBalls(UM, mem.read, state), 0);
  assert.equal(host.watches, n);
  assert.ok(host.watch.some((r) => r.addr === BASE && r.len === 0xe28 + 28));
  assert.ok(!host.watch.some((r) => r.len === 0x10000), 'the search windows are let go');
});
