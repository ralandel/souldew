// Profile banners and nameplates in the page. A banner is DATA (a recipe: palette + layer list, from the app's free set
// or the verified pack) turned into pixel art by the public engine (engine/), drawn at native resolution (56 rows × as
// many columns as the box needs) into one small canvas that CSS scales by whole device pixels.
//
//   mountBanner(el, id, { intro, reducedMotion, focusY })    – fills `el` (the profile strip), plays the intro once
//   mountNameplate(el, id, { reducedMotion, hoverTarget })   – the same scene as a nameplate behind a list row:
//                                                              still until the row is hovered
// One shared timer (motion.mjs) runs only banners that are on screen, in a visible tab, without reduced motion; an
// unchanged frame is not uploaded and hidden time is skipped.
import { compile, H } from './engine/index.mjs';
import { content, state, onChange } from '../state.mjs';
import { prefersReduced, onMotionChange, createTicker, watch, tabHidden } from '../motion.mjs';
import { onSkinChange } from '../skins.mjs';

const ticker = createTicker();
const all = new Set();

export function bannerStats() {
  let ms = 0, frames = 0;
  for (const b of all) {
    ms += b.stats.renderMs;
    frames += b.stats.frames;
  }
  return { ms, frames, running: ticker.live.size, mounted: all.size };
}

/** the colour a nameplate fades into: the row's own background (so a light skin fades to paper, not to dark grey) */
export function rowColour(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(getComputedStyle(n).backgroundColor || '');
    if (m && (m[4] === undefined || Number(m[4]) > 0.5)) return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
  }
  return '#1b1a1f';
}

function mount(el, id, opts, plateOpts) {
  const st = { recipe: null, gen: -1, scene: null, img: null, out: null, W: 0, k: 1, t0: performance.now(), paused: false, pausedAt: 0, onScreen: true, hover: false, lastFrame: -1, renderMs: 0, frames: 0, destroyed: false };
  const wrap = document.createElement('div');
  wrap.className = 'cos-art';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.style.cssText = 'position:absolute;inset:0;overflow:hidden;border-radius:inherit;pointer-events:none';
  const cv = document.createElement('canvas');
  cv.style.cssText = 'position:absolute;image-rendering:pixelated;image-rendering:crisp-edges';
  wrap.appendChild(cv);
  if (typeof getComputedStyle === 'function' && getComputedStyle(el).position === 'static') el.style.position = 'relative';
  el.prepend(wrap);
  const ctx = cv.getContext('2d', { alpha: false });
  const mode = opts.animate || (plateOpts ? 'hover' : 'always');
  const reduced = () => opts.reducedMotion ?? prefersReduced();
  const noIntro = () => opts.intro === false;

  const inst = {
    get fps() { return st.recipe?.fps || 10; },
    get stats() { return { frames: st.frames, renderMs: st.renderMs, W: st.W, k: st.k }; },
    tick(now) {
      const t = (now - st.t0) / 1000;
      draw(t);
      // a still banner stops ticking once its intro is over
      if (st.scene && !st.scene.animated && t > (st.scene.intro && !noIntro() ? st.scene.intro.dur : 0) + 0.2) ticker.delete(inst);
    },
  };

  function resolve() {
    if (st.gen === state.generation) return !!st.recipe;
    st.gen = state.generation;
    const recipe = content.banners.get(id) || null;
    if (recipe !== st.recipe) {
      st.recipe = recipe;
      st.scene = null;
      st.W = 0;
    }
    wrap.style.display = recipe ? '' : 'none';
    return !!recipe;
  }

  function layout() {
    if (!resolve()) return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const plate = plateOpts ? { rows: 28, at: 0.8, fade: 0.6, band: 14, ...(st.recipe.plate || {}), ...plateOpts } : null;
    const dpr = globalThis.devicePixelRatio || 1;
    const devW = r.width * dpr, devH = r.height * dpr;
    const k = Math.max(1, Math.ceil(devH / (plate ? plate.rows : H)));
    const W = Math.ceil(devW / k);
    const rows = plate ? Math.ceil(devH / k) : H;
    if (W !== st.W || k !== st.k || !st.scene) {
      st.W = W;
      st.k = k;
      try {
        const recipe = plate ? { ...st.recipe, plateBg: opts.plateBg || rowColour(opts.hoverTarget || el) } : st.recipe;
        st.plateBg = recipe.plateBg;
        st.scene = compile(recipe, { width: plate ? Math.max(480, W * 2) : W });
      } catch (e) {
        console.warn('banner failed to compile', id, e);
        st.scene = null;
        wrap.style.display = 'none';
        return false;
      }
      cv.width = W;
      cv.height = rows;
      st.img = ctx.createImageData(W, rows);
      st.out = new Uint32Array(st.img.data.buffer);
      st.lastFrame = -1;
      st.plate = plate;
    }
    const cssW = (W * k) / dpr, cssH = (rows * k) / dpr;
    const focusY = opts.focusY ?? st.recipe.focusY ?? 0.45;
    cv.style.width = `${cssW}px`;
    cv.style.height = `${cssH}px`;
    cv.style.left = `${Math.round(((r.width - cssW) / 2) * dpr) / dpr}px`;
    cv.style.top = `${Math.round((r.height - cssH) * (plate ? 0.5 : focusY) * dpr) / dpr}px`;
    return true;
  }

  const still = () => reduced() || mode === 'never' || (mode === 'hover' && !st.hover);
  function draw(t) {
    const sc = st.scene;
    if (!sc) return;
    const s = still();
    sc.noIntro = s || noIntro();
    const tt = s ? sc.still : t;
    const f = s ? -2 : Math.floor(tt * sc.fps);
    if (f === st.lastFrame) return;
    st.lastFrame = f;
    const a = performance.now();
    const p = st.plate;
    const changed = p ? sc.plate(tt, st.out, { w: st.W, h: cv.height, x: p.x ?? st.recipe.focusX ?? 250, y: p.y ?? 18, at: p.at, fade: p.fade, band: p.band }) : sc.frame(tt, st.out);
    if (changed) ctx.putImageData(st.img, 0, 0);
    st.renderMs += performance.now() - a;
    st.frames++;
  }

  function refresh() {
    if (st.destroyed) return;
    const t = (performance.now() - st.t0) / 1000;
    const sc = st.scene;
    const running = sc && st.onScreen && !tabHidden() && !still() && (sc.animated || (sc.intro && !noIntro() && t < sc.intro.dur + 0.2));
    if (running && !ticker.has(inst)) {
      if (st.paused) {
        st.t0 += performance.now() - st.pausedAt;
        st.paused = false;
      }
      ticker.add(inst);
    } else if (!running && ticker.has(inst)) {
      ticker.delete(inst);
      st.paused = true;
      st.pausedAt = performance.now();
    }
    draw(t);
  }

  const unwatch = watch(el, {
    onVisible: (v) => { if (v !== null) st.onScreen = v; refresh(); },
    onResize: () => { if (layout()) { st.lastFrame = -1; refresh(); } },
    hoverTarget: opts.hoverTarget,
    onHover: mode === 'hover' ? (h) => { st.hover = h; refresh(); } : null,
  });
  const unmotion = onMotionChange(() => { st.lastFrame = -1; refresh(); });
  const unchange = onChange(() => {
    if (st.gen === state.generation) return;
    st.t0 = performance.now();
    if (layout()) { st.lastFrame = -1; refresh(); } else ticker.delete(inst);
  });
  // a nameplate fades into its row's colour: when the skin changes that colour, recompile
  const unskin = plateOpts && !opts.plateBg ? onSkinChange(() => {
    if (!st.recipe || rowColour(opts.hoverTarget || el) === st.plateBg) return;
    st.scene = null;
    if (layout()) { st.lastFrame = -1; refresh(); }
  }) : () => {};
  all.add(inst);
  layout();
  refresh();

  return {
    get mounted() { return !!st.scene; },
    get stats() { return inst.stats; },
    replay() { st.t0 = performance.now(); st.lastFrame = -1; refresh(); },
    destroy() {
      if (st.destroyed) return;
      st.destroyed = true;
      unwatch();
      unmotion();
      unchange();
      unskin();
      ticker.delete(inst);
      all.delete(inst);
      wrap.remove();
    },
  };
}

/** The profile strip. opts: { intro = true, reducedMotion, focusY, animate } */
export const mountBanner = (el, id, opts = {}) => mount(el, id, opts, null);
/** The nameplate behind a list row (the banner's nameplate window). opts: { reducedMotion, hoverTarget, animate } */
export const mountNameplate = (el, id, opts = {}) => mount(el, id, { intro: false, ...opts }, opts.plate || {});
