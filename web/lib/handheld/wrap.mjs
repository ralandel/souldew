// Device skins ("wraps") for "Your handheld": printed vinyl whose art IS a banner, run by the app's public banner engine.
// A wrap is a banner recipe plus a few lines of composition: the banner's 56 rows become the landscape along the bottom of
// every panel, and the sky above is continued by the same engine (a second, sky-only recipe from the banner's own
// palette: its stars twinkle, its aurora waves, its clouds drift). One art pixel is PX mm on every device.
//
// The free wrap (Plain Dusk, from the free banner) ships here; the six souldew+ compositions come with the souldew+ pack
// (handheld/wraps.json), next to the banner recipes they need. The catalog (names, tiers) is shared/handheld.mjs.
//
//   const art = wrapArt(comp, recipe, panels) → { px (Uint32Array RGBA), w, h, rects, update(seconds) → changed?, animated }
// panels: [{ key, w, h (art px), cx (banner column at the panel's centre), base (panel row of the banner's last row),
//            word: [x, y] (panel px) | null }]
import { compile, H as BH } from '../cosmetics/banners/engine/index.mjs';
import { WORD_S } from '../cosmetics/banners/engine/brand.mjs';
import { content } from '../cosmetics/state.mjs';

export const PX = 0.6; // mm per art pixel: the wraps and the stickers, on every device

/** the free wrap's composition (made from the free "Plain Dusk" banner: a sky that just deepens, a quiet print) */
export const FREE_WRAPS = [
  { id: 'plain-dusk', banner: 'plain-dusk', t0: 0, cx: 192, zen: '#121019', plastic: '#1c1a26', keys: '#2a2638', dark: '#100e16', border: '#0c0b11', pulse: '#d6c4e0',
    ext: [['sky', { stops: ['zen', 's0'], at: [10, 54] }]], far: [['sky', { stops: ['zen', 'zen'], at: [0, 55] }]] },
];

const okComp = (c) => c && typeof c.id === 'string' && typeof c.banner === 'string' && Array.isArray(c.ext) && Array.isArray(c.far) && /^#[0-9a-f]{6}$/i.test(c.zen);

/** a wrap's composition (shared/handheld.mjs WRAPS has its name, tier and finish), or null when its data isn't here
 * (a souldew+ wrap without the pack) */
export function wrapComp(id) {
  const c = FREE_WRAPS.find((x) => x.id === id) || (content.handheld?.wraps || []).find((x) => x.id === id);
  return okComp(c) ? c : null;
}
/** the banner recipe a wrap is printed from (free set or the verified pack); null while it isn't in memory */
export const recipeOf = (comp) => (comp ? content.banners.get(comp.banner) || null : null);
/** can this wrap be drawn right now? */
export const wrapReady = (id) => !!recipeOf(wrapComp(id));

function frames(recipe, layers, seed) {
  const sc = compile({ ...recipe, layers, seed, intro: false, calm: [0, 0, 0, 0], pan: false }, { width: 384 });
  sc.noIntro = true;
  return { sc, out: new Uint32Array(sc.W * BH) };
}

/** the art for one wrap and a list of panels: one atlas (panels stacked in a column with a 2-px gutter) */
export function wrapArt(comp, recipe, panels, { reduced = false } = {}) {
  if (!comp || !recipe) return null;
  const pal = { ...recipe.pal, zen: comp.zen };
  const base = { ...recipe, pal };
  const banner = frames(base, recipe.layers, recipe.seed);
  const near = frames(base, comp.ext, (recipe.seed || 1) + 101);
  const far = frames(base, comp.far, (recipe.seed || 1) + 202);
  const far2 = frames(base, comp.far, (recipe.seed || 1) + 303);
  let y = 0;
  const W = Math.max(...panels.map((p) => p.w)) + 4;
  const rects = {};
  for (const p of panels) { rects[p.key] = { x: 2, y: y + 2, w: p.w, h: p.h, p }; y += p.h + 4; }
  const H = y;
  const px = new Uint32Array(W * H);
  // the wordmark's ink: the palette colour that sits best on the sky (a quiet print, not a logo stamp)
  const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  const zen = hex(comp.zen);
  const cands = Object.values(pal).filter((c) => /^#[0-9a-f]{6}$/i.test(c)).map(hex).filter((c) => Math.abs(lum(c) - lum(zen)) > 28 && Math.abs(lum(c) - lum(zen)) < 90);
  const aim = lum(zen) < 128 ? 50 : -40;
  cands.sort((a, b) => Math.abs(lum(a) - lum(zen) - aim) - Math.abs(lum(b) - lum(zen) - aim));
  const ink = cands[0] || (lum(zen) < 128 ? [200, 200, 210] : [40, 40, 50]);
  const ink32 = ((255 << 24) | (ink[2] << 16) | (ink[1] << 8) | ink[0]) >>> 0;
  let lastT = -1;
  const t0 = comp.t0 || 0;
  const still = recipe.still ?? t0;
  const fps = recipe.fps || 10;

  function update(sec) {
    const t = reduced ? still : t0 + sec;
    const tq = Math.floor(t * fps) / fps; // the banner's own frame rate: whole frames
    if (tq === lastT) return false;
    lastT = tq;
    for (const f of [banner, near, far, far2]) f.sc.frame(tq, f.out);
    for (const p of panels) {
      const r = rects[p.key];
      const x0 = Math.round(p.cx - p.w / 2);
      for (let j = 0; j < p.h; j++) {
        const row = j - (p.base - BH); // row inside the banner (0..55); < 0 = sky above, ≥ 56 = ground below
        let src, sy;
        if (row >= 0 && row < BH) { src = banner; sy = row; } else if (row >= BH) { src = banner; sy = BH - 4 + ((row - BH) % 4); } // the ground: its bottom 4 rows repeat (keeps the dither)
        else {
          const k = Math.floor(-row / BH); // 0 = the block just above the banner, then further up
          src = k === 0 ? near : k % 2 ? far : far2;
          sy = BH - 1 - ((-row - 1) % BH);
        }
        const so = sy * 384, d = (r.y + j) * W + r.x;
        for (let i = 0; i < p.w; i++) px[d + i] = src.out[so + ((((x0 + i) % 384) + 384) % 384)];
      }
      if (p.word) {
        const [wx, wy] = p.word;
        WORD_S.forEach((rw, j) => [...rw].forEach((ch, i) => { if (ch === 'a') px[(r.y + wy + j) * W + r.x + wx + i] = ink32; }));
      }
    }
    return true;
  }
  update(0);
  return { px, w: W, h: H, rects, update, animated: !reduced && (banner.sc.animated || near.sc.animated) };
}

/** the art as a canvas (the page's half: a texture, a card) – `art.update()` then `paint()` again */
export function wrapCanvas(art) {
  const c = document.createElement('canvas');
  c.width = art.w;
  c.height = art.h;
  const g = c.getContext('2d');
  const img = g.createImageData(art.w, art.h);
  const paint = () => {
    new Uint32Array(img.data.buffer).set(art.px);
    g.putImageData(img, 0, 0);
  };
  paint();
  return { canvas: c, paint };
}

const thumbs = new Map();
/** a skin card's picture: the art at its own pixels (a window onto the wrap), as a data: URL; null without its data */
export function wrapThumb(id) {
  const comp = wrapComp(id);
  const recipe = recipeOf(comp);
  if (!recipe) return null;
  const key = `${id}@${content.banners.get(comp.banner) === recipe ? 1 : 0}`;
  if (thumbs.has(key)) return thumbs.get(key);
  const art = wrapArt(comp, recipe, [{ key: 't', w: 112, h: 74, cx: comp.cx + 20, base: 72, word: null }], { reduced: true });
  const url = wrapCanvas(art).canvas.toDataURL();
  thumbs.set(key, url);
  return url;
}

// ---- a souldew+ wrap you don't own, from its public preview picture -------------------------------------------------
// The souldew+ page lets everyone put every skin on the 3D handheld. A wrap's composition and banner recipe come with
// the souldew+ pack only; without it the scene prints the wrap's public preview picture (the accounts service's
// previews: wraps/<id>.png – the skin card's window onto the wrap, shot a few degrees turned, ×2, with a light sheen;
// scripts/plus-dev-pack.mjs handheldPreviews). Nothing more than that picture is used: it is levelled again, read at
// its art pixels and continued past its edges (mirrored sideways, the sky above, the ground below) to cover each panel.
// It never animates, and the page marks it as a souldew+ preview.

/** preview-shot.mjs's seed hash (FNV-1a → 0..0.999): where a picture's sheen crosses */
export const sheenHash = (str) => {
  let x = 2166136261;
  for (const ch of String(str)) x = Math.imul(x ^ ch.charCodeAt(0), 16777619);
  return ((x >>> 0) % 1000) / 1000;
};

/** how the preview pictures are shot (scripts/plus-dev-pack.mjs handheldPreviews): the thumb's window, ×2, turned 4° */
export const PREVIEW_SHOT = { w: 112, h: 74, base: 72, k: 2, angle: 4 };

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * The preview picture back at its art pixels: { w, h, px (Uint32Array RGBA), base } – the shot turned level and read at
 * one sample per art pixel (bilinear), cropped to what the turned shot fully covers. `base`: the row of the banner's
 * last row (may lie below the crop). pic: { w, h, rgba (Uint8ClampedArray | Uint8Array) }; seed: the shot's seed (the
 * wrap's id) – its sheen is taken off.
 */
export function levelPreview(pic, shot = PREVIEW_SHOT, seed = null) {
  const { w, h, rgba } = pic;
  // the shot's sheen (preview-shot.mjs: a soft diagonal band of light, placed by the wrap's id) taken off again –
  // mirrored copies of it would read as streaks across the device
  const sheenAt = seed == null ? null : 0.25 + sheenHash(seed) * 0.5;
  const unsheen = (x, y, v) => {
    if (sheenAt == null) return v;
    const d = (x / w + y / h) / 2 - sheenAt;
    const k = 0.16 * Math.exp(-(d * d) / 0.006);
    return (v - 255 * k) / (1 - k);
  };
  const a = (shot.angle * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  // the shot zoomed the turned picture until it covered its frame (preview-shot.mjs, opaque): k = |cos| + |sin| · max(w/h, h/w)
  const zoom = Math.abs(cos) + Math.abs(sin) * Math.max(w / h, h / w);
  const s = (w / shot.w) * zoom; // shot pixels per art pixel
  // the largest window of the shot's aspect that stays inside the frame once turned back
  const lam = Math.min(w / (w * cos + h * sin), h / (w * sin + h * cos));
  const W = Math.max(8, Math.floor((lam * w) / s)), H = Math.max(8, Math.floor((lam * h) / s));
  const px = new Uint32Array(W * H);
  const at = (x, y, c) => {
    const X = Math.min(w - 1, Math.max(0, x)), Y = Math.min(h - 1, Math.max(0, y));
    return unsheen(X, Y, rgba[(Y * w + X) * 4 + c]);
  };
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      // art pixel centre (relative to the picture's centre) → turned like the shot → shot pixels
      const ax = (i + 0.5 - W / 2) * s, ay = (j + 0.5 - H / 2) * s;
      const x = w / 2 + cos * ax - sin * ay - 0.5, y = h / 2 + sin * ax + cos * ay - 0.5;
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      const c = [0, 1, 2].map((k) => (at(x0, y0, k) * (1 - fx) + at(x0 + 1, y0, k) * fx) * (1 - fy) + (at(x0, y0 + 1, k) * (1 - fx) + at(x0 + 1, y0 + 1, k) * fx) * fy);
      px[j * W + i] = ((255 << 24) | (clamp8(c[2]) << 16) | (clamp8(c[1]) << 8) | clamp8(c[0])) >>> 0;
    }
  }
  return { w: W, h: H, px, base: Math.round(H / 2 + (shot.base - shot.h / 2)) };
}

const rgbOf = (p) => [p & 255, (p >>> 8) & 255, (p >>> 16) & 255];
const hexOf = (c) => `#${c.map((v) => clamp8(v).toString(16).padStart(2, '0')).join('')}`;
const lumOf = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

/**
 * A wrap "composition" for the scene from a levelled preview: the moulded parts take the picture's own sky colour, as a
 * real wrap's do (Plain Dusk: zen #121019 → plastic #1c1a26, keys #2a2638, dark #100e16, border #0c0b11).
 */
export function previewComp(id, lv, finish = 'satin') {
  const n = Math.max(1, Math.min(3, lv.h)) * lv.w;
  const sum = [0, 0, 0];
  for (let i = 0; i < n; i++) { const c = rgbOf(lv.px[i]); sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2]; }
  const zen = sum.map((v) => v / n);
  const toward = (c, k) => c.map((v) => v + ((k > 0 ? 255 : 0) - v) * Math.abs(k));
  const light = lumOf(zen) > 140; // a pale sky: the plastic goes a little darker instead of lighter
  return { id, preview: true, finish, cx: 200, zen: hexOf(zen), plastic: hexOf(toward(zen, light ? -0.08 : 0.05)), keys: hexOf(toward(zen, light ? -0.18 : 0.12)),
    dark: hexOf(toward(zen, -0.15)), border: hexOf(toward(zen, -0.35)) };
}

/** a ping-pong index: 0 … n-1, then back (mirrored copies – no seam at the picture's edges) */
const mirror = (i, n) => { const p = 2 * n; const m = ((i % p) + p) % p; return m < n ? m : p - 1 - m; };

/**
 * The art for the scene's panels from a levelled preview – the same shape as wrapArt's ({ px, w, h, rects, update,
 * animated }), never animated. Sideways the picture repeats mirrored from the panel's centre; above it the sky fades into
 * its own top colour; below the banner's last row its bottom 4 rows repeat (the ground), like wrapArt.
 */
export function previewArt(lv, panels) {
  if (!lv || !panels?.length) return null;
  let y = 0;
  const W = Math.max(...panels.map((p) => p.w)) + 4;
  const rects = {};
  for (const p of panels) { rects[p.key] = { x: 2, y: y + 2, w: p.w, h: p.h, p }; y += p.h + 4; }
  const H = y;
  const px = new Uint32Array(W * H);
  const sky = Math.max(4, Math.min(lv.h, Math.round(lv.h * 0.35))); // the rows that are sky, mirrored upwards
  const groundAt = Math.min(lv.base, lv.h) - 4; // the 4 rows repeated below the banner's last row (or the crop's)
  const zen = [0, 0, 0]; // the picture's top row, averaged: the sky's own colour
  for (let i = 0; i < lv.w; i++) { const c = rgbOf(lv.px[i]); zen[0] += c[0] / lv.w; zen[1] += c[1] / lv.w; zen[2] += c[2] / lv.w; }
  const ink = lumOf(zen) < 128 ? zen.map((v) => v + (255 - v) * 0.35) : zen.map((v) => v * 0.6);
  const ink32 = ((255 << 24) | (clamp8(ink[2]) << 16) | (clamp8(ink[1]) << 8) | clamp8(ink[0])) >>> 0;
  for (const p of panels) {
    const r = rects[p.key];
    for (let j = 0; j < p.h; j++) {
      const row = j - (p.base - lv.base); // the preview's row for this panel row
      const sy = row < 0 ? mirror(row, sky) : row < groundAt + 4 && row < lv.h ? row : groundAt + (((row - groundAt) % 4) + 4) % 4;
      // above the picture the mirrored sky fades into its own top colour within a few rows (mirrored again and again, an
      // aurora or a cloud bank would stack up into stripes)
      const fade = row < 0 ? Math.min(1, -row / 10) : 0;
      for (let i = 0; i < p.w; i++) {
        const sx = mirror(i - Math.round(p.w / 2) + Math.floor(lv.w / 2), lv.w);
        const v = lv.px[Math.min(lv.h - 1, Math.max(0, sy)) * lv.w + sx];
        if (!fade) { px[(r.y + j) * W + r.x + i] = v; continue; }
        const c = rgbOf(v).map((x, k) => x + (zen[k] - x) * fade);
        px[(r.y + j) * W + r.x + i] = ((255 << 24) | (clamp8(c[2]) << 16) | (clamp8(c[1]) << 8) | clamp8(c[0])) >>> 0;
      }
    }
    if (p.word) {
      const [wx, wy] = p.word;
      WORD_S.forEach((rw, j) => [...rw].forEach((ch, i) => { if (ch === 'a') px[(r.y + wy + j) * W + r.x + wx + i] = ink32; }));
    }
  }
  return { px, w: W, h: H, rects, update: () => false, animated: false };
}
