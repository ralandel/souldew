// Runs inside the frames worker (sandbox.mjs): compiles frame recipes and draws them into the OffscreenCanvases the page
// hands over. The page's runtime (runtime.mjs) owns timing, visibility and reduced motion; this only draws frame t.
//
// Messages in:  { op: 'mount', id, recipe, canvas, N, O, small } · { op: 'size', id, N, O, small }
//               { op: 'draw', id, t, noIntro } · { op: 'unmount', id } · { op: 'stats' }
// Messages out: { op: 'ready', ids } · { op: 'meta', id, G, fps, animated, still, intro, small } · { op: 'missing', id }
//               { op: 'stats', ms, frames, mounted } · { op: 'error', id, message }
import { compileFrame } from './engine/index.mjs';

export function host(recipes) {
  const byId = new Map(recipes.filter((r) => r && typeof r.id === 'string').map((r) => [r.id, r]));
  const inst = new Map();
  const totals = { ms: 0, frames: 0 };

  function size(id, m) {
    const it = inst.get(id);
    if (!it) return;
    try {
      it.scene = compileFrame(it.recipe, { N: m.N, O: m.O, small: !!m.small });
    } catch (e) {
      self.postMessage({ op: 'error', id, message: String(e?.message || e) });
      return;
    }
    const G = it.scene.G;
    it.canvas.width = G;
    it.canvas.height = G;
    it.img = it.ctx.createImageData(G, G);
    it.out = new Uint32Array(it.img.data.buffer);
    const sc = it.scene;
    self.postMessage({ op: 'meta', id, G, fps: sc.fps || it.recipe.fps || 12, animated: !!sc.animated, still: sc.still ?? 0, intro: sc.intro ? { dur: sc.intro.dur } : null, small: !!sc.small });
  }

  self.onmessage = (e) => {
    const m = e.data || {};
    switch (m.op) {
      case 'mount': {
        const recipe = byId.get(m.recipe);
        if (!recipe || !m.canvas) {
          self.postMessage({ op: 'missing', id: m.id });
          return;
        }
        inst.set(m.id, { recipe, canvas: m.canvas, ctx: m.canvas.getContext('2d'), scene: null });
        size(m.id, m);
        return;
      }
      case 'size':
        size(m.id, m);
        return;
      case 'draw': {
        const it = inst.get(m.id);
        if (!it?.scene) return;
        const a = performance.now();
        it.scene.noIntro = !!m.noIntro;
        if (it.scene.frame(m.t, it.out)) it.ctx.putImageData(it.img, 0, 0);
        totals.ms += performance.now() - a;
        totals.frames++;
        return;
      }
      case 'unmount':
        inst.delete(m.id);
        return;
      case 'stats':
        self.postMessage({ op: 'stats', ms: totals.ms, frames: totals.frames, mounted: inst.size });
        return;
      default:
    }
  };
  self.postMessage({ op: 'ready', ids: [...byId.keys()] });
}
