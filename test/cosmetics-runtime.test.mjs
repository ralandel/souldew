// Banner, nameplate and frame runtimes in a stand-in page: they draw, pause off-screen and in hidden tabs, follow
// reduced motion, run pack code only in a worker built from verified module text, and destroy() leaves nothing behind
// (listeners, observers, timers, canvases, worker instances).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ------------------------------------------------------------------ a small DOM
const listeners = new Map(); // target → Map(type → Set)
const count = () => [...listeners.values()].reduce((n, m) => n + [...m.values()].reduce((a, s) => a + s.size, 0), 0);
const evt = {
  addEventListener(type, fn) { const m = listeners.get(this) || new Map(); listeners.set(this, m); (m.get(type) || m.set(type, new Set()).get(type)).add(fn); },
  removeEventListener(type, fn) { listeners.get(this)?.get(type)?.delete(fn); },
  fire(type) { for (const fn of [...(listeners.get(this)?.get(type) || [])]) fn({ type }); },
};
let puts = 0;
function el(tag, size = [0, 0]) {
  const e = {
    ...evt, tagName: tag.toUpperCase(), nodeType: 1, children: [], style: {}, dataset: {}, className: '', parentElement: null, size,
    setAttribute() {}, getBoundingClientRect: () => ({ width: e.size[0], height: e.size[1] }), get offsetWidth() { return e.size[0]; },
    appendChild(c) { c.parentElement = e; e.children.push(c); return c; },
    prepend(c) { c.parentElement = e; e.children.unshift(c); },
    insertBefore(c, ref) { c.parentElement = e; e.children.splice(e.children.indexOf(ref), 0, c); },
    remove() { const p = e.parentElement; if (p) p.children.splice(p.children.indexOf(e), 1); e.parentElement = null; },
    querySelector: (sel) => (sel === ':scope > img' ? e.children.find((c) => c.tagName === 'IMG') || null : null),
    get nextSibling() { const p = e.parentElement; return p ? p.children[p.children.indexOf(e) + 1] || null : null; },
  };
  if (tag === 'canvas') {
    e.getContext = () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: () => puts++ });
    e.transferControlToOffscreen = () => ({ offscreen: true });
  }
  return e;
}
const observers = new Set();
class Obs { constructor(cb) { this.cb = cb; observers.add(this); } observe(t) { this.t = t; } disconnect() { observers.delete(this); } }
globalThis.IntersectionObserver = class extends Obs {};
globalThis.ResizeObserver = class extends Obs {};
globalThis.document = { ...evt, visibilityState: 'visible', createElement: (t) => el(t), querySelectorAll: () => [] };
globalThis.getComputedStyle = () => ({ position: 'relative', backgroundColor: 'rgb(27, 26, 31)' });
globalThis.devicePixelRatio = 2;
globalThis.location = { origin: 'http://127.0.0.1:47631' };
const workers = new Set();
const blobs = new Map();
globalThis.Blob = class { constructor(parts) { this.text = parts.join(''); } };
globalThis.URL.createObjectURL = (b) => { const u = `blob:x/${blobs.size}`; blobs.set(u, b.text); return u; };
globalThis.URL.revokeObjectURL = (u) => blobs.delete(u);
globalThis.Worker = class extends EventTarget {
  constructor(url, opts) { super(); this.src = blobs.get(url); this.opts = opts; this.sent = []; workers.add(this); }
  postMessage(m) { this.sent.push(m); }
  reply(m) { this.onmessage?.({ data: m }); this.dispatchEvent(new Event('message')); }
  terminate() { workers.delete(this); }
};

const S = await import('../web/lib/cosmetics/state.mjs');
const { mountBanner, mountNameplate, bannerStats } = await import('../web/lib/cosmetics/banners/runtime.mjs');
const { mountFrame, frameCounts } = await import('../web/lib/cosmetics/frames/runtime.mjs');
const { setReducedMotion } = await import('../web/lib/cosmetics/motion.mjs');
const { workerSource, setWorkerFactory } = await import('../web/lib/cosmetics/sandbox.mjs');
// no browser here: the worker the sandboxed iframe would start is the mock above (test/cosmetics-sandbox.test.mjs runs the real one)
setWorkerFactory((source, name) => new Worker(URL.createObjectURL(new Blob([source])), { type: 'module', name }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

afterEach(() => setReducedMotion(null));

test('banner: draws at native size, pauses off-screen, destroy leaves nothing behind', async () => {
  const before = count();
  const strip = el('div', [1147, 160]);
  const h = mountBanner(strip, 'plain-dusk');
  assert.ok(h.mounted, 'free banner compiled');
  const cv = strip.children[0].children[0];
  assert.equal(cv.height, 56, '56 native rows');
  assert.equal(cv.width, Math.ceil((1147 * 2) / Math.ceil(320 / 56)));
  assert.ok(puts > 0, 'a frame was uploaded');
  assert.equal(bannerStats().running, 1, 'the intro runs');
  // scrolled away: the shared timer drops it
  for (const o of observers) if (o instanceof IntersectionObserver && o.t === strip) o.cb([{ isIntersecting: false }]);
  assert.equal(bannerStats().running, 0, 'off-screen → paused');
  for (const o of observers) if (o instanceof IntersectionObserver && o.t === strip) o.cb([{ isIntersecting: true }]);
  document.visibilityState = 'hidden';
  document.fire('visibilitychange');
  assert.equal(bannerStats().running, 0, 'hidden tab → paused');
  document.visibilityState = 'visible';
  h.destroy();
  assert.equal(strip.children.length, 0, 'canvas removed');
  assert.equal(count(), before, 'no listener left');
  assert.equal(observers.size, 0, 'no observer left');
  assert.deepEqual([bannerStats().mounted, bannerStats().running], [0, 0]);
});

test('banner: reduced motion shows the still frame and never ticks; a missing banner draws nothing', () => {
  setReducedMotion(true);
  const strip = el('div', [800, 160]);
  const h = mountBanner(strip, 'plain-dusk');
  assert.equal(bannerStats().running, 0);
  const none = mountBanner(el('div', [800, 160]), 'aurora-fjord'); // a souldew+ banner without the pack
  assert.equal(none.mounted, false);
  h.destroy();
  none.destroy();
  assert.equal(bannerStats().mounted, 0);
});

test('nameplate: still until its row is hovered, fades into the row colour; content arriving later mounts it', async () => {
  const row = el('div', [300, 52]);
  const n = mountNameplate(row, 'night-marsh-test');
  assert.equal(n.mounted, false, 'not in memory yet');
  S.setContent({ banners: [{ id: 'night-marsh-test', name: 'T', set: 'night', seed: 1, loop: 24, pal: { a: '#101820', b: '#203040', c: '#ffe9a8' },
    layers: [['sky', { stops: ['a', 'b'], at: [0, 40] }], ['stars', { y: [0, 30], density: 5, c: ['c'], twinkle: 0.5 }]] }] });
  S.update({});
  assert.equal(n.mounted, true, 'remounted when the pack arrived');
  assert.equal(bannerStats().running, 0, 'still until hovered');
  row.fire('pointerenter');
  assert.equal(bannerStats().running, 1, 'animates on hover');
  row.fire('pointerleave');
  assert.equal(bannerStats().running, 0);
  n.destroy();
  S.setContent(null);
  S.update({});
  assert.equal(count(), 0);
});

test('frames: drawn in a worker built from the free module (and the verified pack module), destroy unmounts', async () => {
  const av = el('span', [104, 104]);
  av.appendChild(el('img'));
  const pres = av.appendChild(el('span'));
  const f = mountFrame(av, 'plain', 104);
  assert.equal(workers.size, 1);
  const [w] = workers;
  assert.equal(w.opts.type, 'module');
  assert.match(w.src, /import __souldewFree from 'http:\/\/127\.0\.0\.1:47631\/lib\/cosmetics\/content\/frames-free\.mjs'/);
  assert.match(w.src, /from 'http:\/\/127\.0\.0\.1:47631\/lib\/cosmetics\/frames\/worker-host\.mjs'/);
  const mount = w.sent.find((m) => m.op === 'mount');
  assert.deepEqual([mount.recipe, mount.N, mount.small, !!mount.canvas.offscreen], ['plain', 42, false, true]);
  assert.equal(av.children.indexOf(av.children.find((c) => c.className === 'sd-frame')), 1, 'right after the img – the presence dot stays on top');
  assert.ok(av.children.indexOf(pres) > 1);
  w.reply({ op: 'meta', id: mount.id, G: 52, fps: 12, animated: false, still: 0, intro: null, small: false });
  assert.ok(w.sent.some((m) => m.op === 'draw' && m.id === mount.id), 'the still frame is drawn');
  const cv = av.children[1];
  assert.equal(cv.style.width, `${(52 * 5) / 2}px`);
  assert.equal(cv.style.left, `${-(6 * 5 + (42 * 5 - 208) / 2) / 2}px`, 'overhang within the safe area');
  f.destroy();
  assert.ok(w.sent.some((m) => m.op === 'unmount' && m.id === mount.id));
  assert.equal(av.children.length, 2, 'canvas removed');
  assert.deepEqual(frameCounts(), { mounted: 0, running: 0 });
  assert.equal(count(), 0);
  assert.equal(observers.size, 0);
});

test('frames: a pack loaded later → a new worker with the pack module, every frame remounts; too small = no frame', () => {
  const av = el('span', [38, 38]);
  av.appendChild(el('img'));
  const f = mountFrame(av, 'tide-ring', 38);
  const w1 = [...workers].find((w) => w.sent.some((m) => m.recipe === 'tide-ring'));
  w1.reply({ op: 'missing', id: w1.sent.find((m) => m.op === 'mount').id });
  S.setContent({ framesModule: "import { fl } from '@cosmetics/frames/recipe-lib.mjs';\nexport const RECIPES = [{ id: 'tide-ring' }];", frameIds: ['tide-ring'] });
  S.update({});
  assert.ok(!workers.has(w1), 'the old worker is gone');
  const [w2] = workers;
  assert.match(w2.src, /from 'http:\/\/127\.0\.0\.1:47631\/lib\/cosmetics\/frames\/recipe-lib\.mjs'/, "the pack's engine imports point at the public engine");
  assert.doesNotMatch(w2.src, /@cosmetics\//);
  assert.match(w2.src, /__souldewHost\(\[\.\.\.__souldewFree, \.\.\.RECIPES\]\)/);
  const mount = w2.sent.find((m) => m.op === 'mount');
  assert.deepEqual([mount.recipe, mount.small], ['tide-ring', true], 'list size uses the small variant');
  f.destroy();
  const tiny = el('span', [16, 16]);
  const t = mountFrame(tiny, 'plain', 16);
  assert.equal(tiny.children.length, 0, 'below 20 px no frame is drawn');
  t.destroy();
  S.setContent(null);
  S.update({});
  assert.equal(workers.size, 0, 'no frames mounted → no worker kept');
  assert.equal(count(), 0);
});

test('frames: sized to the avatar box as laid out – a 104 px avatar the CSS shows at 76 px gets a 76 px frame, and follows a resize', () => {
  const av = el('span', [76, 76]); // the profile editor's preview: <Avatar size=104> shrunk by .pf-preview .av-104
  av.appendChild(el('img'));
  const f = mountFrame(av, 'plain', 104);
  const w = [...workers].find((x) => x.sent.some((m) => m.op === 'mount' && m.recipe === 'plain'));
  const mount = w.sent.find((m) => m.op === 'mount');
  assert.deepEqual([mount.N, mount.O], [38, 5], 'the grid of a 76 px box at 2× (k 4) – not the 104 px one (N 42)');
  w.reply({ op: 'meta', id: mount.id, G: mount.N + 2 * mount.O, fps: 12, animated: false, still: 0, intro: null, small: false });
  const cv = av.children[1];
  const over = (parseFloat(cv.style.width) - 76) / 2;
  assert.ok(over > 0 && over <= 76 * 0.15 + 0.5, `overhang ${over} px ≤ 15 % of 76 px`);
  av.size = [104, 104];
  for (const o of observers) if (o instanceof ResizeObserver && o.t === av) o.cb([]);
  const resized = w.sent.filter((m) => m.op === 'size' && m.id === mount.id).pop();
  assert.equal(resized?.N, 42, 'resized with the box');
  f.destroy();
});

test('worker source: no pack → only the free content; the pack text is used as given otherwise', () => {
  const free = workerSource({ hostModule: 'frames/worker-host.mjs', freeModule: 'content/frames-free.mjs' });
  assert.match(free, /__souldewHost\(\[\.\.\.__souldewFree, \.\.\.\[\]\]\)/);
  const pack = workerSource({ hostModule: 'frames/worker-host.mjs', packText: "import { od } from '@cosmetics/frames/engine/core.mjs';\nexport const RECIPES = [];", packExport: 'RECIPES' });
  assert.match(pack, /^import 'http:\/\/127\.0\.0\.1:47631\/lib\/cosmetics\/canvas-proxy\.mjs';\n/, 'the canvas stand-ins first');
  assert.match(pack, /\nimport \{ od \} from 'http:\/\/127\.0\.0\.1:47631\/lib\/cosmetics\/frames\/engine\/core\.mjs';/);
  assert.match(pack, /__souldewHost\(\[\.\.\.\[\], \.\.\.RECIPES\]\)/);
  void wait;
});
