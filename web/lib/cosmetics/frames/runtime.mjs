// Avatar frames in the page. The art is drawn in a worker (sandbox.mjs + worker-host.mjs: the free frames from the app,
// the pack's frames from its signed module); this side owns the canvas element, its size and position, timing,
// visibility and reduced motion.
//
// Layout contract (skin-only, frames/README of the design): the frame is ONE absolutely positioned canvas inside the
// avatar box, inserted right after the <img> so a presence dot (a later sibling) still paints on top. It takes no space
// and moves nothing. It may draw outside the box by at most the overhang:
//   large (box ≥ 56 css px): 15 % of the box per side, never more than 16 css px;
//   small (20–55 css px): 2 native pixels;  below 20 css px no frame is drawn.
import { startWorker } from '../sandbox.mjs';
import { state, content, onChange } from '../state.mjs';
import { prefersReduced, onMotionChange, createTicker, watch, tabHidden } from '../motion.mjs';

const ticker = createTicker();
const instances = new Map(); // worker id → instance
let worker = null;
let workerGen = -1;
let nextId = 1;
const statWaiters = [];

/** the native grid for an avatar box of `css` px at device ratio dpr (null: too small for a frame) */
export function sizing(css, dpr = 1) {
  if (!(css >= 20)) return null;
  const dev = css * dpr;
  const small = css < 56;
  const k = Math.max(1, Math.round(dev / (small ? 19 : 40)));
  const N = Math.max(12, 2 * Math.round(dev / k / 2));
  const O = small ? 2 : Math.max(3, Math.min(Math.floor(N * 0.15), Math.floor((16 * dpr) / k)));
  return { k, N, O, small, dev };
}

function getWorker() {
  if (worker && workerGen === state.generation) return worker;
  worker?.terminate();
  workerGen = state.generation;
  worker = startWorker({ hostModule: 'frames/worker-host.mjs', freeModule: 'content/frames-free.mjs', packText: content.framesModule, packExport: 'RECIPES', name: 'souldew-frames' });
  worker.onmessage = (e) => {
    const m = e.data || {};
    if (m.op === 'stats') {
      for (const w of statWaiters.splice(0)) w(m);
      return;
    }
    const it = instances.get(m.id);
    if (m.op === 'meta') it?.onMeta(m);
    else if (m.op === 'missing' || m.op === 'error') it?.onMissing(m);
  };
  worker.onerror = (e) => {
    console.warn('souldew frames worker failed', e.message || e);
    for (const it of instances.values()) it.onMissing({});
  };
  return worker;
}

// a pack loaded or wiped: the worker is rebuilt and every frame remounts on the new one
onChange(() => {
  if (workerGen === state.generation) return;
  for (const it of [...instances.values()]) it.remount();
  if (!instances.size && worker) {
    worker.terminate();
    worker = null;
  }
});

/** frame stats of the worker (ms spent drawing, frames drawn) – for the perf check */
export function frameStats() {
  if (!worker) return Promise.resolve({ ms: 0, frames: 0, mounted: 0, running: 0 });
  return new Promise((resolve) => {
    statWaiters.push((m) => resolve({ ...m, running: ticker.live.size }));
    worker.postMessage({ op: 'stats' });
  });
}

/**
 * Mounts frame `recipeId` on the avatar box `el`. size: the avatar's css size – used until the box is laid out; from then
 * on the frame follows the box's own width (and re-sizes with it).
 * opts: { intro = true, reducedMotion (true/false overrides the OS), animate: 'always' | 'hover' | 'never', hoverTarget }
 */
export function mountFrame(el, recipeId, size, opts = {}) {
  const st = { id: 0, cv: null, key: '', z: null, meta: null, t0: performance.now(), paused: false, pausedAt: 0, onScreen: true, hover: false, lastFrame: -1, introDone: opts.intro === false, missing: false, destroyed: false };
  if (typeof getComputedStyle === 'function' && getComputedStyle(el).position === 'static') el.style.position = 'relative';

  const reduced = () => opts.reducedMotion ?? prefersReduced();
  const mode = () => opts.animate || (st.meta?.small ? 'hover' : 'always');
  const moving = () => !reduced() && mode() !== 'never' && (mode() !== 'hover' || st.hover);

  const inst = {
    get fps() { return st.meta?.fps || 12; },
    tick(now) { draw((now - st.t0) / 1000); refresh(); },
    onMeta(m) {
      st.meta = m;
      if (m.small) st.introDone = true; // intros belong to the profile, never to lists
      place();
      st.lastFrame = -1;
      refresh();
    },
    onMissing() {
      st.missing = true;
      if (st.cv) st.cv.style.display = 'none';
      ticker.delete(inst);
    },
    remount() {
      if (st.destroyed) return;
      detach();
      st.missing = false;
      st.key = '';
      layout();
      refresh();
    },
  };

  function makeCanvas() {
    const cv = document.createElement('canvas');
    cv.className = 'sd-frame';
    cv.setAttribute('aria-hidden', 'true');
    cv.style.cssText = 'position:absolute;pointer-events:none;image-rendering:pixelated;image-rendering:crisp-edges;visibility:hidden';
    const img = el.querySelector(':scope > img');
    if (img?.nextSibling) el.insertBefore(cv, img.nextSibling);
    else el.appendChild(cv);
    return cv;
  }
  function detach() {
    if (st.id) {
      instances.delete(st.id);
      if (worker && workerGen === state.generation) worker.postMessage({ op: 'unmount', id: st.id });
    }
    ticker.delete(inst);
    st.cv?.remove();
    st.cv = null;
    st.id = 0;
    st.meta = null;
  }
  function place() {
    const { z, meta, cv } = st;
    if (!z || !meta || !cv) return;
    const dpr = globalThis.devicePixelRatio || 1;
    const css = (meta.G * z.k) / dpr;
    const off = (z.O * z.k + (z.N * z.k - z.dev) / 2) / dpr;
    cv.style.width = cv.style.height = `${css}px`;
    cv.style.left = cv.style.top = `${-off}px`;
    cv.style.visibility = '';
  }
  function layout() {
    if (st.destroyed || st.missing) return;
    const dpr = globalThis.devicePixelRatio || 1;
    // the box as laid out (offsetWidth: CSS may resize it – the editor's preview shows the 104 px avatar at 76 px – and
    // an opening dialog's scale transform must not count); `size` only while the box isn't laid out yet
    const css = el.offsetWidth || size || el.getBoundingClientRect().width;
    const z = sizing(css, dpr);
    if (!z) {
      if (st.cv) st.cv.style.display = 'none';
      return;
    }
    const key = `${z.N}:${z.O}:${z.k}:${dpr}:${z.small}`;
    if (key === st.key && st.cv) return;
    st.key = key;
    st.z = z;
    const w = getWorker();
    if (!st.cv) {
      st.cv = makeCanvas();
      st.id = nextId++;
      instances.set(st.id, inst);
      const off = st.cv.transferControlToOffscreen();
      w.postMessage({ op: 'mount', id: st.id, recipe: recipeId, canvas: off, N: z.N, O: z.O, small: z.small }, [off]);
    } else {
      st.cv.style.display = '';
      w.postMessage({ op: 'size', id: st.id, N: z.N, O: z.O, small: z.small });
    }
  }
  function draw(t) {
    const m = st.meta;
    if (!m || !st.id) return;
    const introOn = !st.introDone && m.intro && moving() && t < m.intro.dur;
    if (!introOn && !st.introDone && t >= (m.intro ? m.intro.dur : 0)) st.introDone = true;
    const still = !moving() || (!m.animated && !introOn);
    const tt = still ? m.still : t;
    const f = still ? -2 : Math.floor(tt * m.fps);
    if (f === st.lastFrame) return;
    st.lastFrame = f;
    worker.postMessage({ op: 'draw', id: st.id, t: tt, noIntro: !introOn });
  }
  function refresh() {
    if (st.destroyed) return;
    const m = st.meta;
    const t = (performance.now() - st.t0) / 1000;
    const wants = m && moving() && (m.animated || (!st.introDone && m.intro && t < m.intro.dur + 0.1));
    const running = wants && st.onScreen && !tabHidden();
    if (running && !ticker.has(inst)) {
      if (st.paused) {
        st.t0 += performance.now() - st.pausedAt; // hidden time is skipped: the frame resumes where it was
        st.paused = false;
      }
      ticker.add(inst);
    } else if (!running && ticker.has(inst)) {
      ticker.delete(inst);
      st.paused = true;
      st.pausedAt = performance.now();
    }
    if (!running) draw(t);
  }

  const unwatch = watch(el, {
    onVisible: (v) => { if (v !== null) st.onScreen = v; refresh(); },
    onResize: () => { layout(); st.lastFrame = -1; refresh(); },
    // a small frame in a list moves while its ROW is hovered (the nameplate row, or any [data-cos-row])
    hoverTarget: opts.hoverTarget || el.closest?.('[data-cos-row], .cos-nameplate') || el,
    onHover: (h) => { st.hover = h; st.lastFrame = -1; refresh(); },
  });
  const unmotion = onMotionChange(() => { st.lastFrame = -1; refresh(); });
  layout();

  return {
    get mounted() { return !!st.id && !st.missing; },
    replay() { st.introDone = false; st.t0 = performance.now(); st.lastFrame = -1; refresh(); },
    destroy() {
      if (st.destroyed) return;
      st.destroyed = true;
      unwatch();
      unmotion();
      detach();
    },
  };
}

/** live instances (tests, perf) */
export const frameCounts = () => ({ mounted: instances.size, running: ticker.live.size });
