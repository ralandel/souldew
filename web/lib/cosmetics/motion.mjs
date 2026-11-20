// Shared by the banner and frame runtimes: reduced motion (the OS setting, or an override) and one timer for all live
// instances, ticking at the fastest fps among them – only instances that are on screen, in a visible tab and allowed to
// move are in it, so a page full of cosmetics that are off-screen costs nothing.

const query = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
let forced = null;
const subs = new Set();
const notify = () => {
  for (const fn of [...subs]) fn();
};
query?.addEventListener?.('change', notify);

export const prefersReduced = () => forced ?? !!query?.matches;
/** Override prefers-reduced-motion everywhere (true / false); null follows the OS again. */
export function setReducedMotion(v) {
  forced = v == null ? null : !!v;
  notify();
}
export function onMotionChange(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

/** A shared ticker: add(inst) with inst.fps and inst.tick(now); delete(inst). */
export function createTicker() {
  const live = new Set();
  let timer = 0;
  const schedule = () => {
    if (timer || !live.size) return;
    let fps = 1;
    for (const i of live) fps = Math.max(fps, i.fps || 10);
    timer = setTimeout(() => {
      timer = 0;
      const now = performance.now();
      for (const i of [...live]) i.tick(now);
      schedule();
    }, 1000 / fps);
  };
  return {
    live,
    add(i) {
      live.add(i);
      schedule();
    },
    delete(i) {
      live.delete(i);
      if (!live.size && timer) {
        clearTimeout(timer);
        timer = 0;
      }
    },
    has: (i) => live.has(i),
  };
}

/** Observers an instance needs, all released by the returned function (no listener outlives destroy()). */
export function watch(el, { onVisible, onResize, hoverTarget, onHover }) {
  const offs = [];
  if (typeof IntersectionObserver === 'function' && onVisible) {
    const io = new IntersectionObserver((es) => onVisible(es[es.length - 1].isIntersecting), { rootMargin: '16px' });
    io.observe(el);
    offs.push(() => io.disconnect());
  }
  if (typeof ResizeObserver === 'function' && onResize) {
    const ro = new ResizeObserver(() => onResize());
    // the device-pixel box: it also changes with the interface size (the window's zoom, lib/uiscale.mjs) or another
    // screen's pixel density – the canvas is drawn again sharp instead of stretched
    try {
      ro.observe(el, { box: 'device-pixel-content-box' });
    } catch {
      ro.observe(el);
    }
    offs.push(() => ro.disconnect());
  }
  if (onVisible && typeof document !== 'undefined') {
    const vis = () => onVisible(null);
    document.addEventListener('visibilitychange', vis);
    offs.push(() => document.removeEventListener('visibilitychange', vis));
  }
  if (onHover) {
    const t = hoverTarget || el;
    const enter = () => onHover(true);
    const leave = () => onHover(false);
    t.addEventListener('pointerenter', enter);
    t.addEventListener('pointerleave', leave);
    offs.push(() => {
      t.removeEventListener('pointerenter', enter);
      t.removeEventListener('pointerleave', leave);
    });
  }
  return () => {
    for (const off of offs.splice(0)) off();
  };
}

export const tabHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
