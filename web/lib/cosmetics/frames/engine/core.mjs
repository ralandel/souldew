// souldew+ avatar-frame engine – core. Dependency-free ES module (browser runtime + Node tools).
//
// It reuses the banner engine's primitives read-only (hashing, noise, the 4×4 Bayer dither, colour maths):
//   ../../banners/engine/core.mjs  – nothing in banners/ is modified.
//
// A FRAME is a recipe (palette + ordered layers, plain data plus the odd small paint function). compileFrame(recipe,
// {N, O}) turns it into an indexed pixel scene for ONE avatar size:
//   N = the avatar box in native pixels (always even, so the box has a true centre line),
//   O = the overhang on every side (the frame may draw that far outside the avatar box – never further),
//   G = N + 2·O = the canvas.
// The art is procedural in N, so the same recipe draws crisply at 36, 40 or 44 native pixels (profile at 1×/2×,
// friend pane) – and below 28 it switches to the recipe's SMALL variant (friends list, chips): thinner ring, one mark,
// at most one quiet effect.
//
// Pixel rules: ≤ 12 colours per frame + transparent, every pixel a palette index, no alpha blending, soft
// transitions only through the ordered dither, every animation a whole number of cycles per loop.

import { rng, h1, h2, noise1, noise2, fbm1, od, hex, dist, mixRGB, luma } from '../../banners/engine/core.mjs';
export { rng, h1, h2, noise1, noise2, fbm1, od, hex, dist, mixRGB, luma };

export const TR = 255;            // transparent index
export const MAX_COLOURS = 12;
export const SMALL_BELOW = 28;    // N below this → small variant
export const RADIUS = 0.26;       // the app's avatar corner radius (border-radius: 26%)

export const PARTS = Object.create(null);
/** register a layer type: fn(ctx, params) draws static pixels and/or returns {draw(fb, t)} for animated ones */
export function part(name, fn) { PARTS[name] = fn; }

// ------------------------------------------------------------------ geometry of one avatar size
export function geometry(N, O, shape = 'rr', radius = RADIUS) {
  const G = N + 2 * O, C = G / 2, h = N / 2;
  const circ = shape === 'circle';
  const R = circ ? 0 : Math.max(1, radius * N), A = h - R;           // corner radius, half straight edge
  const Rc = circ ? N * 0.56 : 0;                                    // circle frames hug the avatar's corners
  const P = circ ? 2 * Math.PI * Rc : 8 * A + 2 * Math.PI * R;       // perimeter length (px)
  const arc = Math.PI * R / 2;
  // segments clockwise from top centre: [len, kind, ...]
  const segs = circ ? null : [
    [A, 'L', C, C - h, 1, 0],               // top, centre → right
    [arc, 'A', C + A, C - A, -Math.PI / 2],  // TR
    [2 * A, 'L', C + h, C - A, 0, 1],        // right, down
    [arc, 'A', C + A, C + A, 0],             // BR
    [2 * A, 'L', C + A, C + h, -1, 0],       // bottom, ← left
    [arc, 'A', C - A, C + A, Math.PI / 2],   // BL
    [2 * A, 'L', C - h, C + A, 0, -1],       // left, up
    [arc, 'A', C - A, C - A, Math.PI],       // TL
    [A, 'L', C - A, C - h, 1, 0],            // top, left → centre
  ];
  function sdAt(px, py) {
    const dx = px - C, dy = py - C;
    if (circ) return Math.hypot(dx, dy) - Rc;
    const qx = Math.abs(dx) - A, qy = Math.abs(dy) - A;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - R;
  }
  function nAt(px, py) {
    const dx = px - C, dy = py - C;
    if (circ) { const l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; }
    const qx = Math.abs(dx) - A, qy = Math.abs(dy) - A;
    if (qx > 0 && qy > 0) { const l = Math.hypot(qx, qy); return [Math.sign(dx) * qx / l, Math.sign(dy) * qy / l]; }
    return qx > qy ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dy) || 1];
  }
  /** perimeter parameter 0..1, clockwise from the top centre */
  function sAt(px, py) {
    const dx = px - C, dy = py - C;
    if (circ) { const a = Math.atan2(dx, -dy) / (2 * Math.PI); return a < 0 ? a + 1 : a; }
    const ax = Math.abs(dx), ay = Math.abs(dy);
    let L;
    const tb = ax <= A && (ay > A || ay >= ax), lr = !tb && ay <= A;
    if (tb) L = dy < 0 ? (dx >= 0 ? dx : P + dx) : A + 2 * arc + 2 * A + (A - dx);
    else if (lr) L = dx > 0 ? A + arc + (dy + A) : A + 3 * arc + 4 * A + (A - dy);
    else {
      const sx = Math.sign(dx), sy = Math.sign(dy);
      let a = Math.atan2(dy - sy * A, dx - sx * A);
      if (sx > 0 && sy < 0) L = A + (a + Math.PI / 2) * R;
      else if (sx > 0 && sy > 0) L = A + arc + 2 * A + a * R;
      else if (sx < 0 && sy > 0) L = A + 2 * arc + 4 * A + (a - Math.PI / 2) * R;
      else { if (a > 0) a -= 2 * Math.PI; L = A + 3 * arc + 6 * A + (a + Math.PI) * R; }
    }
    L = ((L % P) + P) % P; return L / P;
  }
  /** point at perimeter parameter s, d pixels outward along the normal */
  function at(s, d = 0) {
    s = ((s % 1) + 1) % 1;
    if (circ) { const a = s * 2 * Math.PI; const r = Rc + d; return [C + Math.sin(a) * r, C - Math.cos(a) * r]; }
    let L = s * P;
    for (const g of segs) {
      if (L <= g[0] || g === segs[segs.length - 1]) {
        if (g[1] === 'L') { const [, , x, y, ux, uy] = g; return [x + ux * L + uy * d, y + uy * L - ux * d]; }
        const [, , cx, cy, a0] = g; const a = a0 + L / R; return [cx + Math.cos(a) * (R + d), cy + Math.sin(a) * (R + d)];
      }
      L -= g[0];
    }
    return [C, C];
  }
  const sd = new Float32Array(G * G), S = new Float32Array(G * G), NX = new Float32Array(G * G), NY = new Float32Array(G * G);
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
    const i = y * G + x, px = x + 0.5, py = y + 0.5;
    sd[i] = sdAt(px, py); S[i] = sAt(px, py); const n = nAt(px, py); NX[i] = n[0]; NY[i] = n[1];
  }
  return { N, O, G, C, h, R, A, P, shape, sd, S, NX, NY, sdAt, sAt, nAt, at };
}

// ------------------------------------------------------------------ sprites (ascii → indexed)
/** '.' transparent; any other char looked up in map (char → colour name). Returns {w, h, px: [[x,y,colName]…]} */
export function sprite(rows, map) {
  const px = [];
  rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.' && ch !== ' ') px.push([x, y, map[ch] ?? ch]); }));
  return { w: Math.max(...rows.map(r => r.length)), h: rows.length, px };
}
/** widen/narrow a mirror-symmetric sprite by one column so it centres exactly on an integer (even) or half (odd) axis */
export function fitWidth(rows, wantEven) {
  const w = rows[0].length; if ((w % 2 === 0) === wantEven) return rows;
  const m = Math.floor(w / 2);
  return rows.map(r => r.slice(0, m + (w % 2 ? 1 : 0)) + r.slice(m));
}
export const flipRows = rows => rows.map(r => [...r].reverse().join(''));
export const flipCols = rows => [...rows].reverse();
/** rotate rows 90° clockwise */
export const rotRows = rows => { const h = rows.length, w = rows[0].length; const out = []; for (let x = 0; x < w; x++) { let s = ''; for (let y = h - 1; y >= 0; y--) s += rows[y][x] ?? '.'; out.push(s); } return out; };

// ------------------------------------------------------------------ compile
/**
 * recipe = { id, name, set, rarity, seed, pal: {name: '#rrggbb'}, layers: [[type, params], …],
 *            loop (s, default 12), fps (default 12), still (t of the static frame), shape ('rr' | 'circle'),
 *            intro: {kind: 'trace' | 'grow' | 'pop' | 'none', dur, head} ,
 *            small: { layers } – the hand-tuned variant below SMALL_BELOW }
 * opts   = { N (even, default 40), O (default 15 % of N, ≥ 2), small (force) }
 */
export function compileFrame(recipe, opts = {}) {
  const N = Math.max(12, (opts.N ?? 40) & ~1);
  const small = opts.small ?? N < SMALL_BELOW;
  const O = opts.O ?? (small ? 2 : Math.max(3, Math.floor(N * 0.15)));
  const spec = small ? (recipe.small || autoSmall(recipe)) : recipe;
  const geo = geometry(N, O, spec.shape || recipe.shape, recipe.radius);
  const names = Object.keys(recipe.pal);
  if (names.length > MAX_COLOURS) throw new Error(`${recipe.id}: ${names.length} colours (max ${MAX_COLOURS})`);
  const rgb = names.map(n => hex(recipe.pal[n]));
  const pal = Object.fromEntries(names.map((n, i) => [n, i]));
  const L = recipe.loop || 12, G = geo.G;
  const base = new Uint8Array(G * G).fill(TR);
  const rev = new Float32Array(G * G).fill(0);   // intro reveal key per pixel (0 first … 1 last)
  const role = new Uint8Array(G * G);            // 0 empty, 1 band, 2 ornament
  let ornCount = 0;
  const ctx = {
    recipe, small, N, O, G, L, geo, pal, rgb, names, base, rev, role,
    seed: recipe.seed ?? 1,
    c(n) { if (n == null) return null; if (typeof n === 'number') return n; if (!(n in pal)) throw new Error(`${recipe.id}: unknown colour "${n}"`); return pal[n]; },
    rand(salt = 0) { return rng(((recipe.seed ?? 1) * 7919 + salt * 104729) >>> 0); },
    cyc(per) { return Math.max(1, Math.round(L / per)); },
    phase(t, cycles) { return (((t / L) * cycles) % 1 + 1) % 1; },
    /** static pixel. kind: 'band' (revealed along the perimeter) | 'orn' (pops in after the band) */
    put(x, y, col, kind = 'band') {
      x |= 0; y |= 0; if (x < 0 || y < 0 || x >= G || y >= G || col == null) return;
      const i = y * G + x; base[i] = typeof col === 'number' ? col : ctx.c(col);
      if (kind === 'orn') { role[i] = 2; rev[i] = 1.02 + Math.min(0.3, ornCount * 0.04); }
      else { role[i] = 1; rev[i] = revKey(i); }
    },
    erase(x, y) { x |= 0; y |= 0; if (x >= 0 && y >= 0 && x < G && y < G) { base[y * G + x] = TR; role[y * G + x] = 0; } },
    get(x, y) { x |= 0; y |= 0; return x >= 0 && y >= 0 && x < G && y < G ? base[y * G + x] : TR; },
    nextOrn() { ornCount++; },
    /** shade helper: value 0..1 → ramp entry, ordered dither in the middle of each step (dw = dither width 0..1) */
    ramp(ramp, v, x, y, dw = 0) {
      const n = ramp.length; v = Math.min(1, Math.max(0, v)) * (n - 1); let i = Math.floor(v); const f = v - i;
      if (i >= n - 1) return ctx.c(ramp[n - 1]);
      if (dw > 0 && Math.abs(f - 0.5) < dw / 2) { if (od(x, y, (f - 0.5 + dw / 2) / dw)) i++; }
      else if (f >= 0.5) i++;
      return ctx.c(ramp[i]);
    },
  };
  const introKind = (recipe.intro && recipe.intro.kind) || 'trace';
  function revKey(i) {
    if (introKind === 'grow') return Math.min(1, Math.max(0, (geo.sd[i] + 3) / (O + 4)));
    const s = geo.S[i]; return Math.min(s, 1 - s) * 2;   // 0 at the top centre → 1 at the bottom centre, both sides
  }

  const fx = [];
  for (const [type, p0] of spec.layers) {
    const fn = PARTS[type]; if (!fn) throw new Error(`${recipe.id}: unknown layer "${type}"`);
    const res = fn(ctx, p0 || {});
    if (res && res.draw) fx.push(res);
  }

  const intro = (recipe.intro && recipe.intro.kind === 'none') || opts.noIntro ? null : { dur: 1.1, ...(recipe.intro || {}) };
  if (intro && small) intro.dur = Math.min(intro.dur, 0.7);
  let headCol = intro && intro.head ? ctx.c(intro.head) : 0;
  if (intro && !intro.head) { let best = -1; rgb.forEach((c, i) => { const l = luma(c); if (l > best) { best = l; headCol = i; } }); }

  const fb = new Uint8Array(G * G);
  const pal32 = new Uint32Array(256);
  rgb.forEach((c, i) => { pal32[i] = ((255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0; });
  pal32[TR] = 0;
  const scene = { id: recipe.id, N, O, G, small, fb, rgb, pal32, loop: L, fps: recipe.fps || 12, animated: fx.length > 0, still: recipe.still ?? 0, intro, noIntro: false };

  scene.index = function (t) {
    fb.set(base);
    if (intro && !scene.noIntro && t >= 0 && t < intro.dur) {
      const p = (t / intro.dur) * 1.45 - 0.05;   // band first (0..1), then the ornaments pop (1..1.35)
      for (let i = 0; i < fb.length; i++) {
        if (fb[i] === TR) continue; const k = rev[i];
        if (k > p) { const y = (i / G) | 0, x = i - y * G; if (k - p < 0.06 && od(x, y, 0.5)) continue; fb[i] = TR; }
        else if (role[i] === 1 && p - k < 0.05 && p < 1.02) fb[i] = headCol;
      }
      return fb;
    }
    for (const f of fx) f.draw(fb, t);
    return fb;
  };
  scene.frame = function (t, out32) {
    scene.index(t); let changed = false;
    for (let i = 0; i < fb.length; i++) { const v = pal32[fb[i]]; if (out32[i] !== v) { out32[i] = v; changed = true; } }
    return changed;
  };
  scene.colours = names.length;
  return scene;
}

/** default small variant: the recipe's own ring layer squeezed to 2 px + its declared mark */
function autoSmall(recipe) {
  const ring = recipe.layers.find(l => l[0] === 'ring');
  const p = ring ? ring[1] : { ramp: Object.keys(recipe.pal).slice(0, 3) };
  return { layers: [['ring', { ...p, d0: -1, d1: 1, dither: 0, studs: 0 }]] };
}

// ------------------------------------------------------------------ frame-buffer helper for effects
export function fput(fb, G, x, y, c) { x |= 0; y |= 0; if (x >= 0 && y >= 0 && x < G && y < G) fb[y * G + x] = c; }
