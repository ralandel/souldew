// Small helpers shared by the recipe files (not layer types – those live in engine/parts.mjs).
import { geometry, rotRows, flipRows, flipCols, h1, h2, fbm1, noise1, noise2, od } from './engine/core.mjs';
import { inPresence } from './engine/parts.mjs';
export { h1, h2, fbm1, noise1, noise2, od, flipRows, flipCols, rotRows, inPresence };
export const fl = Math.floor, TAU = Math.PI * 2;
const UNIT = geometry(40, 6);

/** per-compile cache (recipes are compiled once per avatar size; never keep size-dependent state in module scope) */
export function memo(ctx, key, fn) { const m = ctx._m || (ctx._m = {}); return key in m ? m[key] : (m[key] = fn()); }
/** turn an ornament drawn pointing up-right so that it points away from the avatar at perimeter s */
export function outward(rows, s) { const [x, y] = UNIT.at(s, 0); const n = UNIT.nAt(x, y); let r = rows; if (n[0] < -0.01 || (Math.abs(n[0]) < 0.01 && s > 0.5)) r = flipRows(r); if (n[1] > 0.01) r = flipCols(r); return r; }
/** n ornament layers spread round the frame (skipping the presence corner), optionally turned outward */
export function along(art, { n, s0 = 0, d = 1, map, orient = false, skip = true, jitter = 0, seed = 1, kind } = {}) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const s = (s0 + k / n + (jitter ? (h1(k, seed) - 0.5) * jitter : 0) + 1) % 1; if (skip && inPresence(s)) continue;
    const a = typeof art === 'function' ? art(k, s) : art;
    out.push(['orn', { art: orient ? outward(a, s) : a, at: s, d: typeof d === 'function' ? d(k, s) : d, map, sym: Math.abs(s % 0.5) < 1e-6 && !orient ? undefined : false, kind }]);   // on the centre line: parity fit
  }
  return out;
}
/** a disc-shaped live/paint helper: polar coords of pixel p around (cx, cy) */
export const polar = (p, cx, cy) => { const dx = p.x + 0.5 - cx, dy = p.y + 0.5 - cy; return { r: Math.hypot(dx, dy), a: Math.atan2(dy, dx), dx, dy }; };
/** a point on the frame for the current size: [x, y] */
export const pt = (ctx, s, d) => memo(ctx, `pt${s}:${d}`, () => ctx.geo.at(s, d));
/** palette name by hash among weighted choices: pick([['a', 3], ['b', 1]], u) */
export function pick(choices, u) { const tot = choices.reduce((a, c) => a + c[1], 0); let x = u * tot; for (const [n, w] of choices) { if ((x -= w) < 0) return n; } return choices[choices.length - 1][0]; }
/** a gear (static or turning): returns colour name or null for pixel p; teeth = count, rot = radians */
export function gear(p, cx, cy, R, teeth, rot, cols) {
  const { r, a, dx, dy } = polar(p, cx, cy); if (r > R + 0.5) return null;
  const u = (((a - rot) / TAU) * teeth % 1 + 1) % 1; const tooth = u < 0.5;
  const rIn = R - 1.6; if (r > rIn && !tooth) return null;
  if (r < 1.1) return cols.hole;
  if (r > rIn + 0.9 && tooth) return (dx + dy < 0) ? cols.lit : cols.mid;
  const lit = -(dx * 0.6 + dy * 0.8) / (r || 1);
  if (r > rIn - 0.9) return lit > 0.3 ? cols.lit : lit < -0.3 ? cols.dark : cols.mid;
  return r < 2.3 ? cols.dark : (lit > 0.4 ? cols.mid : cols.mid);
}
