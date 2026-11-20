// The FREE and EARNED sticker designs of "Your handheld" (shared/handheld.mjs has the catalog): original pixel art in the
// banner family – no Pokémon or Nintendo motifs. Build input only: scripts/build-handheld-atlas.mjs turns them into the
// app's pre-built atlas (web/assets/handheld/); the page never runs this. The souldew+ designs are not in this repository –
// they come with the souldew+ pack (scripts/plus-dev-pack.mjs --handheld).
import { WORD_S } from '../../web/lib/cosmetics/banners/engine/brand.mjs';
import { FONT_S, FONT_L } from './pixel-font.mjs';

const art = (rows, map) => ({ w: Math.max(...rows.map((r) => r.length)), h: rows.length, rows, map });

function raster(w, h) {
  const g = Array.from({ length: h }, () => Array(w).fill('.'));
  const map = {};
  let next = 0;
  const key = (c) => { for (const [k, v] of Object.entries(map)) if (v === c) return k; const k = 'abcdefghijklmnopqrstuvwxyz'[next++]; map[k] = c; return k; };
  return {
    w, h,
    put(x, y, c) { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < w && y < h) g[y][x] = c ? key(c) : '.'; },
    get(x, y) { return x >= 0 && y >= 0 && x < w && y < h ? map[g[y][x]] || null : null; },
    disc(cx, cy, r, c, test) { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy); if (d <= r && (!test || test(x, y, d))) this.put(x, y, c); } },
    /** every pixel through fn(x, y, colour now) → a colour, or undefined to leave it */
    fill(fn) { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = fn(x, y, this.get(x, y)); if (c !== undefined) this.put(x, y, c); } },
    /** a pixel mask (rows, '.' = empty) at x, y in colour c (or c(x, y)) */
    stamp(m, x0, y0, c) { m.rows.forEach((r, j) => [...r].forEach((ch, i) => { if (ch !== '.') this.put(x0 + i, y0 + j, typeof c === 'function' ? c(x0 + i, y0 + j) : c); })); },
    /** pixel art rows with their own map (a sprite inside a design) */
    sprite(rows, m, x0, y0) { rows.forEach((r, j) => [...r].forEach((ch, i) => { if (ch !== '.' && m[ch]) this.put(x0 + i, y0 + j, m[ch]); })); },
    done() { return { w, h, rows: g.map((r) => r.join('')), map }; },
  };
}

/** inside a rounded rectangle at x0, y0, w × h with corner radius r (pixel centres) */
const inRound = (x, y, x0, y0, w, h, r) => {
  const X = x - x0, Y = y - y0;
  if (X < 0 || Y < 0 || X >= w || Y >= h) return false;
  const cx = Math.min(X + 0.5, w - X - 0.5), cy = Math.min(Y + 0.5, h - Y - 0.5);
  return !(cx < r && cy < r && Math.hypot(r - cx, r - cy) > r);
};
/** a word in the wordmark's face (pixel-font.mjs) → { w, h, rows } ('a' = ink), caps height, trimmed left and right */
function text(s, F = FONT_S) {
  const rows = Array.from({ length: F.cap }, (_, y) => [...s].map((c) => { const gl = F.g[c]; if (!gl) throw new Error(`no glyph ${c}`); return gl[y]; }).join(''));
  const lead = Math.min(...rows.map((r) => r.length - r.replace(/^\.+/, '').length));
  const trail = Math.min(...rows.map((r) => r.length - r.replace(/\.+$/, '').length));
  const out = rows.map((r) => r.slice(lead, r.length - trail));
  return { w: out[0].length, h: F.cap, rows: out };
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

const od = (x, y, f) => f * 16 > BAYER[((y & 3) << 2) | (x & 3)] + 0.5;

function moonBadge() { // a night-sky disc with a crescent and three stars (The Night Train's palette)
  const R = raster(21, 21);
  R.disc(10.5, 10.5, 10.4, '#191f37');
  R.disc(10.5, 10.5, 10.4, '#2a3050', (x, y) => od(x, y, Math.max(0, (y - 9) / 14))); // a dithered horizon glow
  R.disc(11.6, 9.6, 6.4, '#ece6cf', (x, y) => Math.hypot(x + 0.5 - 14.4, y + 0.5 - 7.4) > 5.3);
  R.disc(11.6, 9.6, 6.4, '#b9b29a', (x, y) => Math.hypot(x + 0.5 - 14.4, y + 0.5 - 7.4) > 5.3 && Math.hypot(x + 0.5 - 13.6, y + 0.5 - 8.2) <= 6.3);
  for (const [x, y, big] of [[4, 6, 1], [16, 15, 0], [6, 15, 0], [16, 4, 0]]) {
    R.put(x, y, '#e8ecf6');
    if (big) { R.put(x - 1, y, '#8a92b4'); R.put(x + 1, y, '#8a92b4'); R.put(x, y - 1, '#8a92b4'); R.put(x, y + 1, '#8a92b4'); }
  }
  return R.done();
}

function sparkle() { // a four-point star, warm gold
  const R = raster(15, 15);
  for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) {
    const dx = Math.abs(x - 7) / 7.4, dy = Math.abs(y - 7) / 7.4;
    const v = Math.sqrt(dx) + Math.sqrt(dy);
    if (v <= 1) R.put(x, y, v < 0.42 ? '#fff4d2' : v < 0.72 ? '#f2c477' : '#d79a3e');
  }
  return R.done();
}

function logo() { // the souldew wordmark (the app's own pixel grid) on a cream pill
  const w = WORD_S[0].length + 6, h = WORD_S.length + 6;
  const R = raster(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const cx = Math.min(x + 0.5, w - x - 0.5), cy = Math.min(y + 0.5, h - y - 0.5);
    const r = h / 2;
    if (cx < r && Math.hypot(r - cx, r - cy) > r - 0.05) continue;
    R.put(x, y, '#ebe6da');
  }
  WORD_S.forEach((row, j) => [...row].forEach((ch, i) => { if (ch === 'a') R.put(i + 3, j + 3, '#1b1a1f'); }));
  return R.done();
}

function rings() { // two linked rings – cream and gold – tied by a red thread (earned: Bound by Fate)
  const R = raster(23, 19);
  const ring = (cx, cy, c, c2, front) => R.disc(cx, cy, 5.6, c, (x, y, d) => d > 3.3 && (!front || front(x, y)) && true) || R.disc(cx, cy, 5.6, c2, (x, y, d) => d > 3.3 && d <= 4.2 && (!front || front(x, y)));
  ring(8, 8, '#ebe6da', '#c9c2b0');
  ring(15, 8, '#e9c46e', '#b88a3a', (x, y) => !(x <= 11 && y < 8 && Math.hypot(x + 0.5 - 8, y + 0.5 - 8) > 3.3 && Math.hypot(x + 0.5 - 8, y + 0.5 - 8) <= 5.6));
  // the cream ring passes over the gold one at the bottom crossing
  R.disc(8, 8, 5.6, '#ebe6da', (x, y, d) => d > 3.3 && x >= 10 && y >= 8);
  for (const [x, y] of [[11, 13], [11, 14], [12, 15], [13, 15], [14, 16], [15, 16], [16, 17], [17, 17], [18, 16], [10, 14], [9, 15]]) R.put(x, y, '#d0443a');
  return R.done();
}

function laurel() { // a laurel wreath, open at the top, with a ribbon (earned: Untouchable)
  const R = raster(21, 19);
  const cx = 10.5, cy = 9.5;
  for (let k = 0; k < 2; k++) {
    const side = k ? 1 : -1;
    for (let i = 0; i < 10; i++) { // leaves along an arc from the bottom to the upper side
      const a = Math.PI / 2 + side * (0.22 + i * 0.27);
      const x = cx + Math.cos(a) * 7.6, y = cy + Math.sin(a) * 7.6;
      const ox = Math.cos(a + side * 1.25) * 1.9, oy = Math.sin(a + side * 1.25) * 1.9;
      R.put(x, y, '#9a7a2a');
      R.put(x + ox * 0.6, y + oy * 0.6, '#e9c46e');
      R.put(x + ox, y + oy, i % 2 ? '#e9c46e' : '#f6dc96');
      R.put(x - ox * 0.5, y - oy * 0.5, '#c9a24a');
      R.put(x - ox, y - oy, i % 2 ? '#c9a24a' : '#e9c46e');
    }
  }
  for (const [x, y] of [[9, 17], [10, 17], [11, 17], [8, 18], [12, 18], [10, 16]]) R.put(x, y, '#d0443a');
  return R.done();
}

const HEART = art([
  '.ooo...ooo.',
  'ohhro.orrro',
  'ohrrrorrrro',
  'orrrrrrrrdo',
  'orrrrrrrrdo',
  '.orrrrrrdo.',
  '..orrrrdo..',
  '...orrdo...',
  '....odo....',
  '.....o.....',
], { o: '#9c3d45', r: '#dc7268', h: '#f8b9ad', d: '#b4505a' });

const SIGNPOST = art([
  '.....aa........',
  '.aaaaaaaaaaaa..',
  '.abbbbbbbbbbba.',
  '.aaaaaaaaaaaa..',
  '.....aa........',
  '..aaaaaaaaaaaa.',
  '.abbbbbbbbbbba.',
  '..aaaaaaaaaaaa.',
  '.....aa........',
  '.....aa........',
  '.....aa........',
  '..ggggggg......',
  '.gGGGgggpppp...',
  'ggggpppp....pp.',
  '..pp.........pp',
], { a: '#6a4a30', b: '#c8a070', g: '#5ea048', G: '#86c060', p: '#d6c49a' });

const STAR = art([ // a tiny five-point star for clusters
  '...y...',
  '..yWy..',
  'yyyWyyy',
  '.yyyyd.',
  '..yyd..',
  '.yy.dd.',
  '.y...d.',
], { y: '#f2c477', W: '#fff4d2', d: '#d79a3e' });

const DOT = art([ // a round dot (a confetti dot, for clusters)
  '.ccc.',
  'cWccc',
  'ccccc',
  'cccCC',
  '.CCC.',
], { c: '#dc7268', W: '#f8b9ad', C: '#b4505a' });

const DEW = art([ // a dew drop – the app's name, in one drop
  '..b..',
  '..b..',
  '.bbb.',
  '.bbbb',
  'bWbbb',
  'bWbbd',
  'bbbbd',
  '.bdd.',
], { b: '#7fc4d8', W: '#eef9fc', d: '#4a8aa8' });

const CLOUD = art([ // a cumulus in three puffs: lit rims on top, a shaded belly
  '.......hhhh........',
  '.....hhwwwwhh......',
  '....hwwwwwwwwh.....',
  '....wwwwwwwwwwh.hh.',
  '.hh.wwwwwwwwwwwwwwh',
  'hwwhwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwwwwww',
  'mwwwwwwwwwwwwwwwwwm',
  'smmmmmmmmmmmmmmmmms',
  '.sssssssssssssssss.',
], { h: '#ffffff', w: '#eceef3', m: '#d0d6e4', s: '#a8b2c8' });

// ---- round 7: the free three of the cool and funny stickers (the other 17 come with souldew+) ------------------------
// The same designs as the souldew+ design sources' handheld/stickers-fun.mjs (the sheet's source) – keep them the same.
const F7 = {
  g1: '#f0f2f6', g2: '#c8ccd6', g3: '#9aa0ae', g4: '#6a7080', g5: '#434856', grass: '#5ea048', grass2: '#86c060', grass3: '#3a7038', dirt2: '#5a3a28',
  coral: '#dc7268', gold: '#f2c477', gold3: '#a8702a', sun: '#fff4d2', navy: '#151b30', navy2: '#2a3050', cream: '#ece6cf', red: '#d0443a', pink: '#f8b9ad',
  plum: '#3a2440', plum2: '#5a3a5e',
};

function rip() { // a tombstone with "RIP" cut in, a hairline crack, grass and one tiny flower – for every box that filled up
  const W = 23, H = 25;
  const R = raster(W, H);
  const stone = (x, y) => x >= 1 && x <= 21 && y <= 20 && (y >= 10 || Math.hypot(x + 0.5 - 11.5, y + 0.5 - 10.5) <= 10.5);
  R.fill((x, y) => {
    if (!stone(x, y)) return undefined;
    if (!stone(x - 1, y) || !stone(x, y - 1)) return F7.g1; // lit from the top left
    if (!stone(x + 1, y) || !stone(x + 1, y + 1) && y < 20) return F7.g4;
    if (!stone(x + 2, y)) return F7.g3;
    return F7.g2;
  });
  R.stamp(text('RIP'), 3, 8, F7.g5);
  for (const [x, y] of [[16, 2], [15, 3], [15, 4], [16, 5], [16, 6]]) R.put(x, y, F7.g3); // a hairline crack
  for (let x = 0; x < W; x++) { // the ground: grass on earth
    R.put(x, 21, (x * 7) % 5 < 3 ? F7.grass2 : F7.grass);
    R.put(x, 22, F7.grass);
    R.put(x, 23, F7.grass3);
    if (x > 0 && x < W - 1) R.put(x, 24, F7.dirt2);
  }
  for (const [x, y] of [[0, 20], [2, 19], [2, 20], [5, 20], [9, 20], [13, 20], [20, 19], [20, 20], [22, 20]]) R.put(x, y, F7.grass);
  R.sprite(['.p.', 'pyp', '.p.', '.s.', 'ss.'], { p: F7.coral, y: F7.gold, s: F7.grass3 }, 16, 17); // the flower
  return R.done();
}

function oneHp() { // "1 HP": a health bar with one sliver of red left
  const W = 46, H = 13;
  const R = raster(W, H);
  R.fill((x, y) => (inRound(x, y, 0, 0, W, H, 3) ? (y === 1 ? F7.navy2 : F7.navy) : undefined));
  R.stamp(text('1 HP'), 4, 3, F7.cream);
  const bx = 26, by = 3, bw = 17, bh = 7; // the bar: a cream frame, an empty dark track, 2 px of red
  for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) {
    const edge = x === bx || x === bx + bw - 1 || y === by || y === by + bh - 1;
    if (edge) { if (!((x === bx || x === bx + bw - 1) && (y === by || y === by + bh - 1))) R.put(x, y, F7.cream); continue; }
    R.put(x, y, x <= bx + 2 ? (y === by + 1 ? F7.pink : F7.red) : y === by + 1 ? '#22283e' : '#0c1020');
  }
  return R.done();
}

function gg() { // "GG" in a chat bubble, in the big wordmark size
  const W = 30, H = 23;
  const R = raster(W, H);
  R.fill((x, y) => {
    const body = inRound(x, y, 0, 0, W, 19, 5);
    const tail = y >= 18 && y < 23 && x >= 4 && x < 4 + (23 - y) - 0 && x < 9;
    if (!body && !tail) return undefined;
    return y === 1 && body ? F7.plum2 : F7.plum;
  });
  const t = text('GG', FONT_L);
  R.stamp(t, 6, 4, F7.gold3); // a drop shadow, then the letters
  R.stamp(t, 5, 3, (x, y) => (y < 7 ? F7.sun : F7.gold));
  return R.done();
}

/** { id, outline, art } for every free and earned sticker */
export const DESIGNS = [
  { id: 'heart', outline: '#5a2228', art: HEART },
  { id: 'moon', outline: '#0a0d19', art: moonBadge() },
  { id: 'sparkle', outline: '#7a5420', art: sparkle() },
  { id: 'logo', outline: '#1b1a1f', art: logo() },
  { id: 'star', outline: '#6a4418', art: STAR },
  { id: 'dot', outline: '#6a2228', art: DOT },
  { id: 'dew', outline: '#1a3a4a', art: DEW },
  { id: 'cloud', outline: '#3a4258', art: CLOUD },
  { id: 'rip', outline: '#2a2e3a', art: rip() },
  { id: 'one-hp', outline: '#05070f', art: oneHp() },
  { id: 'gg', outline: '#1e1024', art: gg() },
  { id: 'thread', outline: '#1b1a1f', art: rings() },
  { id: 'signpost', outline: '#2a1e14', art: SIGNPOST },
  { id: 'laurel', outline: '#5a4214', art: laurel() },
];
