// Layer types for avatar frames. Static parts draw once into the base bitmap at compile time; animated parts return
// {draw(fb, t)} and touch only a precomputed pixel list per frame (a few hundred pixels at most).
import { part, sprite, fitWidth, flipRows, od, noise2, TR, fput } from './core.mjs';
import { ART } from './sprites.mjs';

const TAU = Math.PI * 2;
const LIGHT = (() => { const v = [-0.55, -0.72, 0.42]; const l = Math.hypot(...v); return v.map(c => c / l); })();
const inArc = (s, arc) => !arc || (arc[0] <= arc[1] ? s >= arc[0] && s <= arc[1] : s >= arc[0] || s <= arc[1]);
const PRES = [0.31, 0.44];      // perimeter range under the presence dot (bottom-right corner) – keep ornaments out
export const inPresence = s => s > PRES[0] && s < PRES[1];

function info(ctx, i) {
  const { geo, G } = ctx; const y = (i / G) | 0, x = i - y * G;
  return { i, x, y, sd: geo.sd[i], s: geo.S[i], nx: geo.NX[i], ny: geo.NY[i], along: geo.S[i] * geo.P, cur: ctx.base[i] };
}
const artRows = (a) => (typeof a === 'string' ? ART[a] : a);

// ------------------------------------------------------------------ ring: the lit band that carries every frame
// d0..d1 = signed distance band (negative = over the avatar's edge), profile = how the metal/wood/enamel is shaped:
//   round (a torus: light top-left outside, bottom-right inside) · bevel (two facets) · flat (edge bevels only) ·
//   groove (a channel) · none (no lighting: a flat colour, ramp[0])
part('ring', (ctx, p) => {
  const { geo, G } = ctx; const d0 = p.d0 ?? -2, d1 = p.d1 ?? 3, w = d1 - d0;
  const ramp = p.ramp, prof = p.profile || 'round', tilt = p.tilt ?? 0.85, kind = p.kind || 'band';
  const L = p.light ? (() => { const l = Math.hypot(...p.light); return p.light.map(c => c / l); })() : LIGHT;
  const px = [], br = [];
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < G * G; i++) {
    const sd = geo.sd[i]; if (sd < d0 || sd >= d1) continue; if (!inArc(geo.S[i], p.arc)) continue;
    const t = (sd - d0 + 0.5) / (w + 0.0);
    let f;
    if (prof === 'round') f = -Math.cos(Math.PI * Math.min(1, t));
    else if (prof === 'bevel') f = t < 0.5 ? -1 : 1;
    else if (prof === 'flat') f = t < 1 / w ? -1 : t > 1 - 1 / w ? 1 : 0;
    else if (prof === 'groove') f = Math.cos(Math.PI * Math.min(1, t));
    else f = 0;
    const nx = geo.NX[i] * f * tilt, ny = geo.NY[i] * f * tilt, nz = Math.sqrt(Math.max(0, 1 - (f * tilt) ** 2));
    const b = nx * L[0] + ny * L[1] + nz * L[2];
    px.push(i); br.push(b); lo = Math.min(lo, b); hi = Math.max(hi, b);
  }
  const span = hi - lo || 1;
  px.forEach((i, k) => {
    const y = (i / G) | 0, x = i - y * G; let v = (br[k] - lo) / span; if (p.gamma) v = Math.pow(v, p.gamma);
    if (prof === 'none') v = p.level ?? 0.5;
    let col = ctx.ramp(ramp, v, x, y, p.dither ?? 0);
    if (p.hi && v >= (p.hiCut ?? 0.94)) col = ctx.c(p.hi);
    if (p.fn) { const o = p.fn({ ...info(ctx, i), t: (geo.sd[i] - d0) / w, v }, ctx); if (o != null) col = ctx.c(o); }
    ctx.put(x, y, col, kind);
  });
  // 1-px 4-connected contour lines: outline (outside the band) and inline (over the avatar, gives it depth)
  const inBand = new Uint8Array(G * G); px.forEach(i => { inBand[i] = 1; });
  const edge = (col, outside) => {
    if (!col) return; const c = ctx.c(col);
    for (let i = 0; i < G * G; i++) {
      if (inBand[i]) continue; const sd = geo.sd[i]; if (outside ? sd < d1 : sd >= d0) continue; if (!inArc(geo.S[i], p.arc)) continue;
      const y = (i / G) | 0, x = i - y * G;
      if ((x > 0 && inBand[i - 1]) || (x < G - 1 && inBand[i + 1]) || (y > 0 && inBand[i - G]) || (y < G - 1 && inBand[i + G])) ctx.put(x, y, c, kind);
    }
  };
  edge(p.outline, true); edge(p.inline, false);
});

// ------------------------------------------------------------------ paint: a per-pixel function over a distance band
part('paint', (ctx, p) => {
  const { geo, G } = ctx; const [a, b] = p.where || [-99, 99];
  for (let i = 0; i < G * G; i++) {
    const sd = geo.sd[i]; if (sd < a || sd >= b) continue; if (!inArc(geo.S[i], p.arc)) continue;
    const o = p.fn(info(ctx, i), ctx); if (o == null) continue;
    const y = (i / G) | 0; if (o === 'erase') ctx.erase(i - y * G, y); else ctx.put(i - y * G, y, o, p.kind || 'band');
  }
});

// ------------------------------------------------------------------ orn: a hand-drawn ornament (sprites.mjs or inline rows)
// at = perimeter param (0 top, .125 TR corner, .25 right … .875 TL) or [x, y] as fractions of the canvas;
// d = distance outward from the avatar edge; mirror = also place the exact mirror image on the left/right.
function placeOrn(ctx, p, rows, cx, cy, flip) {
  const map = p.map || {};
  if (flip) rows = flipRows(rows);
  const sp = sprite(rows, map);
  let x0 = Math.round(cx - sp.w / 2), y0 = Math.round(cy - sp.h / 2);
  if (p.ox) x0 += p.ox; if (p.oy) y0 += p.oy;
  return { sp, x0, y0 };
}
part('orn', (ctx, p) => {
  const { geo, G } = ctx;
  let rows = artRows(p.art); if (!rows) throw new Error(`${ctx.recipe.id}: no art "${p.art}"`);
  let cx, cy;
  const axis = typeof p.at === 'number' && (Math.abs(p.at % 0.5) < 1e-6);
  if (axis && p.sym !== false) rows = fitWidth(rows, G % 2 === 0);
  if (Array.isArray(p.at)) { cx = p.at[0] * G; cy = p.at[1] * G; }
  else [cx, cy] = geo.at(p.at ?? 0, p.d ?? 0);
  const one = placeOrn(ctx, p, rows, cx, cy, p.flip);
  const draw = ({ sp, x0, y0 }, mx) => { for (const [x, y, n] of sp.px) { const X = mx ? G - 1 - (x0 + x) : x0 + x; if (n === '_') ctx.erase(X, y0 + y); else ctx.put(X, y0 + y, n, p.kind || 'orn'); } };
  draw(one, false); ctx.nextOrn();
  if (p.mirror) { draw(one, true); }
});

// ------------------------------------------------------------------ studs: a sprite repeated along the perimeter
part('studs', (ctx, p) => {
  const { geo } = ctx; const rows = artRows(p.art), n = p.n || 8;
  for (let k = 0; k < n; k++) {
    const s = ((p.s0 ?? 0) + k / n) % 1; if (p.skipPresence !== false && inPresence(s)) continue; if (!inArc(s, p.arc)) continue;
    const [cx, cy] = geo.at(s, p.d ?? 0.5);
    const { sp, x0, y0 } = placeOrn(ctx, p, rows, cx, cy, false);
    for (const [x, y, c] of sp.px) ctx.put(x0 + x, y0 + y, c, p.kind || 'band');
  }
});

// ------------------------------------------------------------------ live: an animated per-pixel function (palette cycling, waves, glows)
part('live', (ctx, p) => {
  const { geo, G } = ctx; const [a, b] = p.where || [-99, 99]; const list = [];
  for (let i = 0; i < G * G; i++) { const sd = geo.sd[i]; if (sd < a || sd >= b) continue; if (!inArc(geo.S[i], p.arc)) continue; const inf = info(ctx, i); if (p.only && !p.only(inf, ctx)) continue; list.push(inf); }
  const cache = new Map(); const C = n => { if (n == null) return null; let v = cache.get(n); if (v === undefined) { v = ctx.c(n); cache.set(n, v); } return v; };
  return { draw(fb, t) { for (const inf of list) { inf.cur = fb[inf.i]; const o = p.fn(inf, t, ctx); if (o == null) continue; fb[inf.i] = o === 'erase' ? TR : C(o); } } };
});

// ------------------------------------------------------------------ glint: a highlight sweeping diagonally over chosen colours
part('glint', (ctx, p) => {
  const { G } = ctx; const map = new Int16Array(256).fill(-1);
  for (const [a, b] of Object.entries(p.map)) map[ctx.c(a)] = ctx.c(b);
  const cycles = ctx.cyc(p.every || 6), dur = p.dur || 0.7, w = p.width || 1.5, slope = p.slope ?? 1;
  const per = ctx.L / cycles; const span = G * (1 + slope);
  return { draw(fb, t) {
    const q = (((t % per) + per) % per) / dur; if (q >= 1) return;
    const pos = -w * 2 + q * (span + w * 4);
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
      const u = x + y * slope; if (Math.abs(u - pos) > w) continue; const i = y * G + x; const m = map[fb[i]]; if (m >= 0) fb[i] = m;
    }
  } };
});

// ------------------------------------------------------------------ sparkle: 4-point glints that bloom and fade at fixed spots
const SPARK = [[[0, 0, 1]], [[0, 0, 0], [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1]], [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [2, 0, 1], [-2, 0, 1], [0, 2, 1], [0, -2, 1]], [[0, 0, 0], [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1]], [[0, 0, 1]]];
part('sparkle', (ctx, p) => {
  const { geo, G } = ctx; const r = ctx.rand(p.salt || 77); const c0 = ctx.c(p.c[0]), c1 = ctx.c(p.c[1] ?? p.c[0]);
  let spots = p.spots;
  if (!spots) { spots = []; let guard = 0; while (spots.length < (p.n || 3) && guard++ < 200) { const s = r(); if (inPresence(s)) continue; spots.push([s, (p.d ?? 0) + (r() - 0.5) * (p.jitter ?? 0)]); } }
  const pts = spots.map(([s, d], k) => { const [x, y] = Array.isArray(s) ? [s[0] * G, s[1] * G] : geo.at(s, d); return { x: Math.floor(x), y: Math.floor(y), off: (k / spots.length + (p.offset || 0)) % 1 }; });
  const cycles = ctx.cyc(p.every || 4), life = p.life ?? 0.12, big = p.big !== false;
  return { draw(fb, t) {
    for (const s of pts) {
      const q = (ctx.phase(t, cycles) + s.off) % 1; if (q >= life) continue;
      let st = Math.floor((q / life) * 5); if (!big && st === 2) st = 1;
      for (const [dx, dy, k] of SPARK[st]) fput(fb, G, s.x + dx, s.y + dy, k ? c1 : c0);
    }
  } };
});

// ------------------------------------------------------------------ orbit: bodies running round the frame with a short tail
part('orbit', (ctx, p) => {
  const { geo, G } = ctx; const n = p.n || 1, cycles = p.cycles || 1, dir = p.dir || 1;
  const tail = (p.tail || []).map(c => ctx.c(c)); const head = p.head ? ctx.c(p.head) : null;
  const hs = p.art ? sprite(artRows(p.art), p.map || {}) : null;
  const clip = p.clip ?? -99;
  return { draw(fb, t) {
    for (let k = 0; k < n; k++) {
      const s = (p.s0 || 0) + k / n + dir * ctx.phase(t, cycles);
      for (let j = tail.length; j >= 1; j--) { const [x, y] = geo.at(s - dir * j * (p.step || 1.1) / geo.P, p.d ?? 2); const xi = Math.floor(x), yi = Math.floor(y); if (geo.sdAt(xi + 0.5, yi + 0.5) > clip) fput(fb, G, xi, yi, tail[j - 1]); }
      const [x, y] = geo.at(s, p.d ?? 2);
      if (hs) { const x0 = Math.round(x - hs.w / 2), y0 = Math.round(y - hs.h / 2); for (const [a, b, c] of hs.px) fput(fb, G, x0 + a, y0 + b, ctx.c(c)); }
      else if (head != null) fput(fb, G, Math.floor(x), Math.floor(y), head);
    }
  } };
});

// ------------------------------------------------------------------ fall: drifting particles (petals, leaves, snow, rain, embers, bubbles)
// They live in the overhang only: a particle pixel is drawn where the distance to the avatar is > clip (default 0.5),
// so nothing ever crosses the face. Each particle loops a whole number of times per loop → seamless.
part('fall', (ctx, p) => {
  const { geo, G } = ctx; const r = ctx.rand(p.salt || 31);
  const arts = (p.art || ['dot']).map(a => sprite(artRows(a) || [a], p.map || {}));
  const n = p.n || 6, clip = p.clip ?? 0.5, vy = p.vy ?? 1, vx = p.vx ?? 0, sway = p.sway ?? 1;
  const span = G + 8;
  const parts = Array.from({ length: n }, (_, k) => ({ x0: r() * span, y0: r() * span, cy: (p.cycles ? p.cycles[0] + Math.floor(r() * (p.cycles[1] - p.cycles[0] + 1)) : 1), sw: 1 + Math.floor(r() * 2), ph: r() * TAU, art: k % arts.length, fl: Math.floor(r() * 2) }));
  const ok = new Uint8Array(G * G); for (let i = 0; i < G * G; i++) ok[i] = geo.sd[i] > clip && (!p.zone || p.zone(info(ctx, i), ctx)) ? 1 : 0;
  const flutter = ctx.cyc(p.flutter || 0.5);
  return { draw(fb, t) {
    for (const q of parts) {
      const f = ctx.phase(t, q.cy);
      const y = ((q.y0 + vy * f * span) % span + span) % span - 4;
      const x = ((q.x0 + vx * f * span + sway * Math.sin(TAU * ctx.phase(t, q.sw) + q.ph)) % span + span) % span - 4;
      let a = arts[q.art]; if (p.flip && ((Math.floor(ctx.phase(t, flutter) * 2) + q.fl) & 1)) a = arts[(q.art + 1) % arts.length];
      const x0 = Math.round(x), y0 = Math.round(y);
      for (const [dx, dy, c] of a.px) { const X = x0 + dx, Y = y0 + dy; if (X < 0 || Y < 0 || X >= G || Y >= G) continue; const i = Y * G + X; if (ok[i] && (p.under !== true || fb[i] === TR)) fb[i] = ctx.c(c); }
    }
  } };
});

// ------------------------------------------------------------------ flame: tongues licking outward from the band (pixel fire, no blending)
part('flame', (ctx, p) => {
  const { geo, G } = ctx; const base = p.base ?? 2, H = p.h ?? 5, ramp = p.ramp.map(c => ctx.c(c));
  const cut = p.cut || [0.72, 0.46, 0.22];
  const list = [];
  for (let i = 0; i < G * G; i++) {
    const sd = geo.sd[i]; if (sd < base - 1 || sd > base + H + 1) continue;
    const s = geo.S[i]; const wgt = p.weight ? p.weight(s, geo.NX[i], geo.NY[i]) : 1; if (wgt <= 0) continue;
    if (p.keep && !p.keep(info(ctx, i))) continue;
    list.push({ i, sd, u: s * geo.P, wgt, x: i % G, y: (i / G) | 0 });
  }
  const per = p.period || 16, cycles = ctx.cyc(p.speed || 1.2);
  return { draw(fb, t) {
    const ph = ctx.phase(t, cycles) * per;
    for (const q of list) {
      const n = noise2((q.sd - base) * 0.55 - ph, q.u * 0.42, ctx.seed, per) * 0.75 + noise2((q.sd - base) * 1.1 - ph * 2, q.u * 0.9, ctx.seed + 9, per * 2) * 0.25;
      const v = 1 - (q.sd - base) / (H * q.wgt) + (n - 0.5) * 1.15;
      let c = -1; if (v > cut[0]) c = ramp[0]; else if (v > cut[1]) c = ramp[1]; else if (v > cut[2]) c = ramp[2] ?? ramp[1];
      if (c < 0) continue; if (p.under && fb[q.i] !== TR) continue; fb[q.i] = c;
    }
  } };
});

// ------------------------------------------------------------------ ripple: rings that leave the frame and thin out (rain halo, tide, sonar)
part('ripple', (ctx, p) => {
  const { geo, G } = ctx; const from = p.from ?? 3, to = p.to ?? ctx.O, n = p.n || 1, cycles = ctx.cyc(p.every || 3);
  const ramp = p.ramp.map(c => ctx.c(c)); const list = [];
  for (let i = 0; i < G * G; i++) { const sd = geo.sd[i]; if (sd >= from - 1 && sd <= to + 1 && (!p.arc || inArc(geo.S[i], p.arc))) list.push([i, sd, i % G, (i / G) | 0]); }
  return { draw(fb, t) {
    for (let k = 0; k < n; k++) {
      const q = (ctx.phase(t, cycles) + k / n) % 1; const rr = from + (to - from) * q; const c = ramp[Math.min(ramp.length - 1, Math.floor(q * ramp.length))];
      for (const [i, sd, x, y] of list) { if (Math.abs(sd - rr) >= 0.5) continue; if (fb[i] !== TR && !p.over) continue; if (!od(x, y, 1 - q * (p.fade ?? 0.85))) continue; fb[i] = c; }
    }
  } };
});

// ------------------------------------------------------------------ blink: single pixels or tiny sprites switching on a schedule (LEDs, windows)
part('blink', (ctx, p) => {
  const { geo, G } = ctx; const cycles = ctx.cyc(p.every || 2), duty = p.duty ?? 0.5;
  const pts = p.pts.map(([a, b], k) => { const [x, y] = p.abs ? [a, b] : geo.at(a, b); return [Math.floor(x), Math.floor(y), (p.offsets ? p.offsets[k] : k * 0.37) % 1]; });
  const on = ctx.c(p.on), off = p.off ? ctx.c(p.off) : null;
  return { draw(fb, t) { for (const [x, y, o] of pts) { const lit = (ctx.phase(t, cycles) + o) % 1 < duty; if (lit) fput(fb, G, x, y, on); else if (off != null) fput(fb, G, x, y, off); } } };
});

// ------------------------------------------------------------------ draw: free-form animated sprites (fireflies, a moth, birds)
// fn(t, ctx, plot) calls plot(x, y, colour) for the few pixels it needs; plot skips pixels closer to the avatar than clip.
part('draw', (ctx, p) => {
  const { geo, G } = ctx; const clip = p.clip ?? -99; const cache = new Map();
  const C = n => { let v = cache.get(n); if (v === undefined) { v = ctx.c(n); cache.set(n, v); } return v; };
  let fb = null;
  const plot = (x, y, c, under = false) => { x = Math.floor(x); y = Math.floor(y); if (x < 0 || y < 0 || x >= G || y >= G) return; const i = y * G + x; if (geo.sd[i] <= clip) return; if (under && fb[i] !== TR) return; fb[i] = C(c); };
  return { draw(f, t) { fb = f; p.fn(t, ctx, plot, f); } };
});

// ------------------------------------------------------------------ stamp: art at a computed pixel position (x, y may be functions of ctx)
part('stamp', (ctx, p) => {
  const rows = artRows(p.art); const sp = sprite(rows, p.map || {});
  const x0 = Math.round(typeof p.x === 'function' ? p.x(ctx, sp) : p.x), y0 = Math.round(typeof p.y === 'function' ? p.y(ctx, sp) : p.y);
  for (const [x, y, c] of sp.px) ctx.put(x0 + x, y0 + y, c, p.kind || 'orn');
  ctx.nextOrn();
});
