// "Share to Discord" (Live runs): the card – a 1200×675 PNG in the souldew look, drawn on a canvas in the page.
//
// Two steps: cardModel() reads the run (doc + manifest) into plain text and numbers – the headline, the cause (the
// killer from the battle the Pokémon fell in, its level, wild or trainer, the place sign where it happened) and every
// player's team –, and drawCard() paints that model. The model holds every visible word already translated, so
// drawCard knows nothing about runs or languages (scripts/render-live-cards.mjs paints fixtures with it).
// Nothing on the card is a file name, an invite code or a path: streamer mode can share it as it is.
import { CARD_W, CARD_H } from '/shared/liveruns.mjs';
import { pixelIconPath } from './icons.mjs';

// ---- colours: the app's (web/styles.css) and the banner's (build/readme/art.html) ----
const C = {
  bg: '#121116', shell: '#1b1a1f', panel: '#1d1c24', panelHi: '#24232c', edge: '#393842', edgeHi: '#4a4954',
  ink: '#ebe6da', ink2: '#b4b0a6', ink3: '#8d897f', ink4: '#5f5c66',
  lcd0: '#0e130f', lcd1: '#18211a', lcd2: '#2c3b2d', lcd3: '#6f8a62', lcd4: '#b9cb98', lcd5: '#dbe6c2',
  alive: '#6fb39b', dead: '#dc7268', deadInk: '#ef9a90', gold: '#e1b05a', goldHi: '#ffd37a',
  p1: '#8cb0ff', p2: '#ff8fdc', p3: '#b3c770', p4: '#a993e6', p5: '#64c6dc', p6: '#e888a8', p7: '#e2d26c', p8: '#cdbfa3',
};
export const PLAYER_COLORS = { p1: C.p1, p2: C.p2, p3: C.p3, p4: C.p4, p5: C.p5, p6: C.p6, p7: C.p7, p8: C.p8 };

const PIXEL = '"Pixel Digits", "Pixelify Sans", monospace';
const DISPLAY = '"Pixelify Sans", monospace';
const BODY = '"IBM Plex Sans", system-ui, sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, monospace';

// ---- fonts: the app's own files, loaded by the card itself (it is drawn outside the app's pages too) ----
const LATIN = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
const LATIN_EXT = 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF';
const FACES = [
  ...[500, 700].flatMap((w) => [['Pixelify Sans', w, `PixelifySans-${w}-latin.woff2`, LATIN], ['Pixelify Sans', w, `PixelifySans-${w}-latin-ext.woff2`, LATIN_EXT]]),
  ...[400, 500, 600].flatMap((w) => [['IBM Plex Sans', w, `IBMPlexSans-${w}-latin.woff2`, LATIN], ['IBM Plex Sans', w, `IBMPlexSans-${w}-latin-ext.woff2`, LATIN_EXT]]),
  ['IBM Plex Mono', 500, 'IBMPlexMono-500-latin.woff2', LATIN], ['IBM Plex Mono', 500, 'IBMPlexMono-500-latin-ext.woff2', LATIN_EXT],
  ['Pixel Digits', 700, 'PixelDigits-700.ttf', 'U+0030-0039'],
];
let fontsReady = null;
export function ensureFonts() {
  if (!fontsReady) {
    fontsReady = Promise.all(FACES.map(async ([family, weight, file, unicodeRange]) => {
      try {
        const face = new FontFace(family, `url(/assets/fonts/${file})`, { weight: String(weight), unicodeRange });
        document.fonts.add(await face.load());
      } catch {
        // the system font stands in
      }
    }));
  }
  return fontsReady;
}

// ---- sprites: the app's own (/sprites/<set>/<id>.png, served and cached by the local server) ----
const imageCache = new Map();
function loadImage(src) {
  if (!src) return Promise.resolve(null);
  if (!imageCache.has(src)) {
    imageCache.set(src, new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    }));
  }
  return imageCache.get(src);
}

/** The visible part of a sprite (its alpha box) – sprites sit small in a big transparent square. */
const boxCache = new WeakMap();
function alphaBox(img) {
  if (boxCache.has(img)) return boxCache.get(img);
  let box = { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
  try {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const { data, width, height } = g.getImageData(0, 0, c.width, c.height);
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 16) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 >= x0) box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  } catch {
    // a foreign image: the whole square
  }
  boxCache.set(img, box);
  return box;
}

/** The biggest whole-number scale at which every sprite fits a w×h box (1 when one doesn't even fit as it is). */
function commonScale(imgs, w, h, maxScale) {
  let s = maxScale;
  for (const img of imgs) {
    if (!img) continue;
    const b = alphaBox(img);
    s = Math.min(s, Math.max(1, Math.floor(Math.min((w * 1.2) / b.w, (h * 1.15) / b.h))));
  }
  return Math.max(1, s);
}

/**
 * A sprite fitted into a w×h box, centred on its visible part, standing on the box's floor. Pixel sprites are
 * scaled by whole numbers only (crisp); a sprite that is bigger than the box is scaled down smoothly.
 * `look`: 'dead' (grey, dim), 'fallen' (grey with a red cast).
 */
function drawSprite(ctx, img, x, y, w, h, { look = null, maxScale = 3, pixel = true, scale = null } = {}) {
  if (!img) return;
  const b = alphaBox(img);
  let s = Math.min(w / b.w, h / b.h);
  if (scale && b.w * scale <= w * 1.2 && b.h * scale <= h * 1.15) s = scale; // the same size as its neighbours
  else if (s >= 1 && pixel) s = Math.max(1, Math.min(maxScale, Math.floor(s)));
  const dw = b.w * s;
  const dh = b.h * s;
  const dx = Math.round(x + (w - dw) / 2);
  const dy = Math.round(y + h - dh - Math.max(0, (h - dh) / 4));
  ctx.save();
  ctx.imageSmoothingEnabled = !(pixel && s >= 1);
  ctx.imageSmoothingQuality = 'high';
  if (look === 'dead') {
    ctx.filter = 'grayscale(1) brightness(.62) contrast(.9)';
    ctx.globalAlpha = 0.55;
  } else if (look === 'fallen') {
    ctx.filter = 'grayscale(1) sepia(1) hue-rotate(-50deg) saturate(2.2) brightness(.8)';
  }
  ctx.drawImage(img, b.x, b.y, b.w, b.h, dx, dy, dw, dh);
  ctx.restore();
}

// ---- small drawing helpers ----
function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
function font(ctx, f, spacing = 0) {
  ctx.font = f;
  ctx.letterSpacing = `${spacing}px`;
}
/** `text` cut with "…" to fit `max` px in the current font. */
function fit(ctx, text, max) {
  const s = String(text ?? '');
  if (ctx.measureText(s).width <= max) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${s.slice(0, mid).trimEnd()}…`).width <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${s.slice(0, lo).trimEnd()}…`;
}
/** Words into at most `lines` lines of `max` px (the last one cut with "…"). */
function wrap(ctx, text, max, lines) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const out = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (ctx.measureText(next).width <= max || !line) {
      line = next;
      continue;
    }
    out.push(line);
    line = words[i];
    if (out.length === lines - 1) {
      line = words.slice(i).join(' ');
      break;
    }
  }
  if (line) out.push(line);
  return out.slice(0, lines).map((l, i, a) => (i === a.length - 1 ? fit(ctx, l, max) : l));
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function darken(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${Math.round(((n >> 16) & 255) * f)},${Math.round(((n >> 8) & 255) * f)},${Math.round((n & 255) * f)})`;
}
/** For each character of `text`: the colour of the highlight it belongs to, or null. */
function colorMap(text, highlights = []) {
  const out = new Array(String(text).length).fill(null);
  for (const h of highlights || []) {
    if (!h?.text) continue;
    for (let i = text.indexOf(h.text); i >= 0; i = text.indexOf(h.text, i + h.text.length)) {
      for (let k = 0; k < h.text.length; k++) out[i + k] = h.color;
    }
  }
  return out;
}
function glow(ctx, x, y, r, color, a) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, hexA(color, a));
  g.addColorStop(1, hexA(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}
/** The banner's ordered dither: 2 px dots on a 4 px grid, fading out from the centre. */
function dither(ctx, x, y, r, color, a) {
  const c = document.createElement('canvas');
  c.width = c.height = Math.ceil(r * 2);
  const g = c.getContext('2d');
  g.fillStyle = color;
  for (let py = 0; py < c.height; py += 8) {
    for (let px = 0; px < c.width; px += 8) {
      g.fillRect(px, py, 2, 2);
      g.fillRect(px + 4, py + 4, 2, 2);
    }
  }
  g.globalCompositeOperation = 'destination-in';
  const m = g.createRadialGradient(r, r, 0, r, r, r);
  m.addColorStop(0, `rgba(0,0,0,${a})`);
  m.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = m;
  g.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(c, x - r, y - r);
}

// the app mark (web/lib/icons.mjs AppMark): a handheld whose screen shows the two linked rings
const RING1 = 'M4 2h6v2H4zM2 4h2v8H2zM10 4h2v2h-2zM10 10h2v2h-2zM4 12h6v2H4z';
const RING2 = 'M22 2h6v2h-6zM28 4h2v8h-2zM20 4h2v2h-2zM20 10h2v2h-2zM22 12h6v2h-6z';
const BAR = 'M12 6h8v4h-8z';
function appMark(ctx, x, y, size) {
  const s = size / 824;
  ctx.save();
  ctx.translate(x - 100 * s, y - 100 * s);
  ctx.scale(s, s);
  const body = ctx.createLinearGradient(0, 100, 0, 924);
  body.addColorStop(0, '#34323f');
  body.addColorStop(1, '#0c0b10');
  ctx.fillStyle = body;
  rr(ctx, 100, 100, 824, 824, 190);
  ctx.fill();
  ctx.fillStyle = '#060508';
  rr(ctx, 160, 170, 704, 560, 70);
  ctx.fill();
  ctx.fillStyle = '#13201a';
  rr(ctx, 190, 200, 644, 500, 44);
  ctx.fill();
  ctx.save();
  ctx.translate(272, 330);
  ctx.scale(15, 15);
  ctx.shadowBlur = 30;
  ctx.shadowColor = '#6f9bff';
  ctx.fillStyle = '#8cb0ff';
  ctx.fill(new Path2D(RING1));
  ctx.shadowColor = '#ff74d4';
  ctx.fillStyle = '#ff8fdc';
  ctx.fill(new Path2D(RING2));
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#f2ffdc';
  ctx.fill(new Path2D(BAR));
  ctx.restore();
  ctx.fillStyle = '#ff4a3d';
  ctx.beginPath();
  ctx.arc(300, 820, 30, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = '#ff74d4';
  ctx.beginPath();
  ctx.arc(640, 820, 40, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#6f9bff';
  ctx.beginPath();
  ctx.arc(760, 790, 40, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// the app's pixel icons (web/lib/icons.mjs), drawn on the canvas: grave, map pin, trophy, close
function glyph(ctx, name, x, y, size, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 16, size / 16);
  ctx.fillStyle = color;
  ctx.fill(new Path2D(pixelIconPath(name)));
  ctx.restore();
}

const ACCENT = { death: C.dead, wipe: C.dead, victory: C.gold, badge: C.gold };

/**
 * Paint `model` (cardModel) on a 1200×675 2D context. `sprites`: species → image (loadSprites).
 */
export function drawCard(ctx, model, sprites = new Map()) {
  const W = CARD_W;
  const H = CARD_H;
  const accent = ACCENT[model.kind] || C.dead;
  const sprite = (id) => sprites.get(id) || null;
  const pixel = (model.gen || 4) <= 5; // 3DS runs use the smooth artwork-style sprites
  ctx.save();
  ctx.textBaseline = 'alphabetic';

  // ---- backdrop: night shell, the event's colour glowing behind the headline, the banner's violet in the corner ----
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  glow(ctx, 260, 150, 520, accent, 0.2);
  glow(ctx, 1080, -40, 560, '#7d5cff', 0.26);
  glow(ctx, 1180, 640, 420, '#3d6cff', 0.12);
  dither(ctx, 1020, 70, 260, model.kind === 'victory' ? C.goldHi : C.p2, 0.16);
  dither(ctx, 140, 560, 220, accent, 0.1);
  const vig = ctx.createLinearGradient(0, 0, 0, H);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, W, H);

  // ---- top: the mark and the wordmark, the mode on the right ----
  appMark(ctx, 56, 38, 44);
  font(ctx, `700 32px ${DISPLAY}`, 0.6);
  ctx.fillStyle = '#3a3842';
  ctx.fillText('souldew', 114, 72 + 3);
  ctx.fillStyle = C.ink;
  ctx.fillText('souldew', 114, 72);
  font(ctx, `500 13px ${MONO}`, 2);
  const pill = String(model.kicker || '').toUpperCase();
  const pw = ctx.measureText(pill).width + 26;
  rr(ctx, W - 56 - pw, 44, pw, 30, 7);
  ctx.fillStyle = 'rgba(22,21,27,.75)';
  ctx.fill();
  ctx.strokeStyle = '#3d3c46';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = C.ink3;
  ctx.fillText(pill, W - 56 - pw + 13, 64);
  // the event, as a tag left of the mode
  if (model.tag) {
    font(ctx, `700 13px ${MONO}`, 2);
    const tag = String(model.tag).toUpperCase();
    const tw = ctx.measureText(tag).width + 38;
    const tx = W - 56 - pw - 10 - tw;
    rr(ctx, tx, 44, tw, 30, 7);
    ctx.fillStyle = hexA(accent, 0.16);
    ctx.fill();
    ctx.strokeStyle = hexA(accent, 0.55);
    ctx.stroke();
    glyph(ctx, model.kind === 'victory' ? 'trophy' : 'grave', tx + 10, 51, 16, accent);
    ctx.fillStyle = accent;
    ctx.fillText(tag, tx + 30, 64);
  }

  // ---- headline (pixel display type, as on the banner) and the run line ----
  let size = 60;
  let lines;
  for (;;) {
    font(ctx, `700 ${size}px ${DISPLAY}`, 0.3);
    lines = wrap(ctx, model.headline, W - 112, 2);
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
    if ((lines.length === 1 || size <= 44) && widest <= W - 112) break;
    if (lines.length === 2 && size <= 44) break;
    size -= 4;
  }
  const lh = Math.round(size * 1.08);
  const blockH = lines.length * lh + 44;
  let y = 104 + Math.round((178 - blockH) / 2) + size;
  const colors = colorMap(model.headline, model.highlights);
  let cursor = 0;
  for (const l of lines) {
    const plain = l.replace(/…$/, '');
    const at = Math.max(0, model.headline.indexOf(plain, cursor));
    cursor = at + plain.length;
    // runs of one colour: the names in their player's colour (as the banner's "together"), the rest in ink
    let x = 56;
    let i = 0;
    while (i < l.length) {
      const c = i < plain.length ? colors[at + i] : null;
      let j = i + 1;
      while (j < l.length && (j < plain.length ? colors[at + j] : null) === c) j++;
      const seg = l.slice(i, j);
      ctx.save();
      ctx.shadowColor = hexA(c || accent, c ? 0.6 : 0.5);
      ctx.shadowBlur = 34;
      ctx.fillStyle = c ? darken(c, 0.32) : model.kind === 'victory' ? '#4d3a12' : '#3a2226';
      ctx.fillText(seg, x, y + 4);
      ctx.restore();
      ctx.fillStyle = c || C.ink;
      ctx.fillText(seg, x, y);
      x += ctx.measureText(seg).width;
      i = j;
    }
    y += lh;
  }
  font(ctx, `500 21px ${BODY}`);
  ctx.fillStyle = C.ink2;
  const runLine = [model.run, model.game, model.hof?.labels?.attempt].filter(Boolean).join('  ·  ');
  ctx.fillText(fit(ctx, runLine, W - 112), 56, y - lh + 40);

  // ---- body: the cause on the left, the teams on the right (a won run: its numbers and rules, the final team) ----
  const top = 300;
  const bottom = 610;
  if (model.hof) {
    drawHofRun(ctx, model, { x: 56, y: top, w: 330, h: bottom - top });
    drawHofTeam(ctx, model, { x: 410, y: top, w: W - 56 - 410, h: bottom - top, sprite, pixel });
  } else {
    drawCause(ctx, model, { x: 56, y: top, w: 344, h: bottom - top, accent, sprite, pixel });
    drawTeams(ctx, model, { x: 424, y: top, w: W - 56 - 424, h: bottom - top, sprite, pixel });
  }

  // ---- the ticker at the bottom (the banner's LCD strip) ----
  const ty = H - 46;
  const tick = ctx.createLinearGradient(0, ty, 0, H);
  tick.addColorStop(0, '#1a2a1d');
  tick.addColorStop(1, '#101912');
  ctx.fillStyle = tick;
  ctx.fillRect(0, ty, W, 46);
  ctx.fillStyle = '#2f4a33';
  ctx.fillRect(0, ty, W, 1);
  font(ctx, `700 16px ${PIXEL}`, 1.4);
  let tx = 56;
  const items = (model.ticker || []).map((s) => String(s).toUpperCase());
  items.forEach((s, i) => {
    if (i) {
      ctx.fillStyle = C.lcd3;
      ctx.fillRect(tx, ty + 20, 6, 6);
      tx += 22;
    }
    ctx.fillStyle = i === 0 ? C.lcd5 : C.lcd4;
    const text = fit(ctx, s, W - 56 - tx);
    ctx.fillText(text, tx, ty + 29);
    tx += ctx.measureText(text).width + 16;
  });
  // the right end: the mark again, small, with the version
  font(ctx, `700 16px ${PIXEL}`, 1);
  const brand = model.app ? `souldew ${model.app}` : 'souldew';
  const bw = ctx.measureText(brand).width;
  ctx.fillStyle = C.lcd5;
  ctx.fillText(brand, W - 56 - bw, ty + 29);
  appMark(ctx, W - 56 - bw - 30, ty + 12, 22);

  // ---- scanlines over everything ----
  ctx.fillStyle = 'rgba(255,255,255,0.022)';
  for (let sy = 0; sy < H; sy += 3) ctx.fillRect(0, sy, W, 1);
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  for (let sy = ty + 1; sy < H; sy += 3) ctx.fillRect(0, sy, W, 1);
  ctx.restore();
}

/** The left panel: what killed it (sprite, level, wild or trainer, the place) – or the run's end with its numbers. */
function drawCause(ctx, model, { x, y, w, h, accent, sprite, pixel }) {
  const c = model.cause || {};
  // panel with the accent edge
  rr(ctx, x, y, w, h, 12);
  ctx.fillStyle = 'rgba(29,28,36,.92)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.save();
  rr(ctx, x, y, w, h, 12);
  ctx.clip();
  ctx.fillStyle = accent;
  ctx.fillRect(x, y, 4, h);
  glow(ctx, x + 70, y + 20, 200, accent, 0.1);
  ctx.restore();

  // kicker
  font(ctx, `500 13px ${MONO}`, 2.2);
  ctx.fillStyle = accent;
  ctx.fillText(String(c.label || '').toUpperCase(), x + 22, y + 32);

  // the LCD window with the killer (or a glyph)
  const lx = x + 22;
  const ly = y + 46;
  const ls = 128;
  rr(ctx, lx, ly, ls, ls, 10);
  const lcd = ctx.createRadialGradient(lx + ls / 2, ly + 20, 10, lx + ls / 2, ly + ls / 2, ls);
  lcd.addColorStop(0, '#22301f');
  lcd.addColorStop(0.6, C.lcd1);
  lcd.addColorStop(1, C.lcd0);
  ctx.fillStyle = lcd;
  ctx.fill();
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.save();
  rr(ctx, lx, ly, ls, ls, 10);
  ctx.clip();
  if (c.species && sprite(c.species)) {
    // a floor shadow, then the opponent – big, as it looked in the fight
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.beginPath();
    ctx.ellipse(lx + ls / 2, ly + ls - 18, 40, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    drawSprite(ctx, sprite(c.species), lx + 4, ly + 2, ls - 8, ls - 12, { maxScale: 2, pixel, scale: commonScale([sprite(c.species)], (ls - 8) / 1.2, (ls - 12) / 1.15, 2) });
  } else {
    glyph(ctx, c.icon || (model.kind === 'victory' ? 'trophy' : 'grave'), lx + ls / 2 - 32, ly + ls / 2 - 32, 64, model.kind === 'victory' ? C.goldHi : C.lcd4);
  }
  ctx.fillStyle = 'rgba(0,0,0,.18)';
  for (let sy = ly; sy < ly + ls; sy += 3) ctx.fillRect(lx, sy, ls, 1);
  ctx.restore();

  // to the right of the window: name, level, the battle kind
  const rx = lx + ls + 16;
  const rw = x + w - 18 - rx;
  let ry = ly + 30;
  if (c.title) {
    let fs = 28;
    font(ctx, `700 ${fs}px ${DISPLAY}`, 0.2);
    while (ctx.measureText(c.title).width > rw && fs > 18) font(ctx, `700 ${(fs -= 2)}px ${DISPLAY}`, 0.2);
    ctx.fillStyle = C.ink;
    ctx.fillText(fit(ctx, c.title, rw), rx, ry);
    ry += 34;
  }
  if (c.level) {
    font(ctx, `700 22px ${PIXEL}`, 0.5);
    ctx.fillStyle = C.ink2;
    ctx.fillText(`${c.lvLabel || 'Lv'} ${c.level}`, rx, ry);
    ry += 30;
  }
  if (c.chip) {
    font(ctx, `600 13px ${BODY}`, 0.3);
    const text = fit(ctx, c.chip, rw - 26);
    const cw = ctx.measureText(text).width + 24;
    rr(ctx, rx, ry - 16, cw, 26, 13);
    ctx.fillStyle = hexA(c.chipTone === 'wild' ? C.alive : C.gold, 0.16);
    ctx.fill();
    ctx.strokeStyle = hexA(c.chipTone === 'wild' ? C.alive : C.gold, 0.5);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = c.chipTone === 'wild' ? '#9ed3bf' : C.goldHi;
    ctx.fillText(text, rx + 12, ry + 2);
  }

  // the run in numbers at the bottom, as the board's counters; the place and a note above them where they fit
  const stats = (model.stats || []).slice(0, 3);
  const statsTop = stats.length ? y + h - 62 : y + h - 14;
  let by = ly + ls + 34;
  if (c.place) {
    glyph(ctx, 'map', x + 20, by - 18, 20, accent);
    font(ctx, `700 22px ${DISPLAY}`, 0.3);
    ctx.fillStyle = C.ink;
    ctx.fillText(fit(ctx, c.place, w - 70), x + 48, by);
    by += 26;
  }
  if (c.note) {
    font(ctx, `400 14.5px ${BODY}`);
    ctx.fillStyle = C.ink3;
    for (const l of wrap(ctx, c.note, w - 44, 2)) {
      if (by > statsTop - 10) break;
      ctx.fillText(l, x + 22, by);
      by += 20;
    }
  }
  if (stats.length) {
    const gap = 8;
    const sw = (w - 44 - gap * (stats.length - 1)) / stats.length;
    const sy = statsTop;
    stats.forEach((st, i) => {
      const sx = x + 22 + i * (sw + gap);
      rr(ctx, sx, sy, sw, 46, 8);
      ctx.fillStyle = 'rgba(14,13,18,.7)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.06)';
      ctx.lineWidth = 1;
      ctx.stroke();
      const tone = { alive: C.alive, dead: C.dead, gold: C.gold }[st.tone] || C.ink;
      font(ctx, `700 24px ${PIXEL}`, 0.5);
      ctx.fillStyle = tone;
      ctx.fillText(String(st.value), sx + 12, sy + 31);
      const vw = ctx.measureText(String(st.value)).width;
      font(ctx, `500 12.5px ${BODY}`);
      ctx.fillStyle = C.ink3;
      ctx.fillText(fit(ctx, st.label, sw - vw - 26), sx + 18 + vw, sy + 29);
    });
  }
}

/** The right side: every player's team side by side (a solo Nuzlocke: one team in two columns). */
function drawTeams(ctx, model, { x, y, w, h, sprite, pixel }) {
  const teams = (model.teams || []).slice(0, 4);
  if (!teams.length) return;
  const solo = teams.length === 1;
  const allMons = teams.flatMap((tm) => (tm.mons || []).slice(0, 6));
  const gap = 16;
  const cw = (w - gap * (teams.length - 1)) / teams.length;
  teams.forEach((team, ti) => {
    const tx = x + ti * (cw + gap);
    const color = team.color || C.p1;
    // header: name in the player's colour, the count on the right, a coloured rule
    font(ctx, `600 15px ${MONO}`, 1.8);
    ctx.fillStyle = color;
    const count = team.count || '';
    font(ctx, `700 15px ${PIXEL}`, 0.5);
    const countW = count ? ctx.measureText(count).width : 0;
    font(ctx, `600 15px ${MONO}`, 1.8);
    ctx.fillText(fit(ctx, String(team.name || '').toUpperCase(), cw - countW - 16), tx, y + 14);
    if (count) {
      font(ctx, `700 15px ${PIXEL}`, 0.5);
      ctx.fillStyle = C.ink3;
      ctx.fillText(count, tx + cw - countW, y + 14);
    }
    const rule = ctx.createLinearGradient(tx, 0, tx + cw, 0);
    rule.addColorStop(0, color);
    rule.addColorStop(1, hexA(color, 0.05));
    ctx.fillStyle = rule;
    ctx.fillRect(tx, y + 24, cw, 2);

    const mons = (team.mons || []).slice(0, 6);
    const top = y + 34;
    const avail = y + h - top;
    if (!mons.length) {
      rr(ctx, tx, top, cw, avail, 10);
      ctx.strokeStyle = '#3a3942';
      ctx.setLineDash([5, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
      font(ctx, `400 15px ${BODY}`);
      ctx.fillStyle = C.ink3;
      const t = fit(ctx, team.empty || '', cw - 24);
      ctx.fillText(t, tx + (cw - ctx.measureText(t).width) / 2, top + avail / 2 + 5);
      return;
    }
    const cols = solo ? 2 : 1;
    const rows = solo ? 3 : 6;
    const rg = solo ? 10 : 6;
    const colG = 12;
    const rw = (cw - colG * (cols - 1)) / cols;
    const rh = (avail - rg * (rows - 1)) / rows;
    const box = solo ? Math.min(rh - 10, 76) : Math.min(rh - 4, 46);
    const scale = commonScale(allMons.map((m) => sprite(m.species)), box, box, solo ? 2 : 1);
    mons.forEach((m, i) => {
      const col = solo ? i % cols : 0;
      const row = solo ? Math.floor(i / cols) : i;
      drawMon(ctx, m, { x: tx + col * (rw + colG), y: top + row * (rh + rg), w: rw, h: rh, color, big: solo, img: sprite(m.species), pixel, scale, labels: model.labels || {} });
    });
  });
}

/** A won run, left: the run in four numbers (deaths, play time, badges, alive) and its rules as chips. */
function drawHofRun(ctx, model, { x, y, w, h }) {
  const hof = model.hof;
  rr(ctx, x, y, w, h, 12);
  ctx.fillStyle = 'rgba(29,28,36,.92)';
  ctx.fill();
  ctx.strokeStyle = hexA(C.gold, 0.28);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.save();
  rr(ctx, x, y, w, h, 12);
  ctx.clip();
  ctx.fillStyle = C.gold;
  ctx.fillRect(x, y, 4, h);
  glow(ctx, x + 80, y + 10, 220, C.gold, 0.12);
  ctx.restore();

  font(ctx, `500 13px ${MONO}`, 2.2);
  ctx.fillStyle = C.gold;
  ctx.fillText(String(hof.labels?.run || '').toUpperCase(), x + 22, y + 32);
  glyph(ctx, 'trophy', x + w - 40, y + 16, 20, C.goldHi);

  // 2×2 tiles: the value big in the pixel digits, its word under it
  const boxes = (hof.boxes || []).slice(0, 4);
  const gap = 10;
  const tw = (w - 44 - gap) / 2;
  const th = 66;
  boxes.forEach((b, i) => {
    const tx = x + 22 + (i % 2) * (tw + gap);
    const ty = y + 48 + Math.floor(i / 2) * (th + gap);
    const tone = { alive: C.alive, dead: C.dead, gold: C.gold }[b.tone] || C.ink;
    rr(ctx, tx, ty, tw, th, 9);
    ctx.fillStyle = 'rgba(14,13,18,.72)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    ctx.stroke();
    if (b.icon) glyph(ctx, b.icon, tx + tw - 26, ty + 10, 16, hexA(tone, 0.75));
    let fs = 34;
    font(ctx, `700 ${fs}px ${PIXEL}`, 0.6);
    while (ctx.measureText(b.value).width > tw - 40 && fs > 20) font(ctx, `700 ${(fs -= 2)}px ${PIXEL}`, 0.6);
    ctx.fillStyle = tone;
    ctx.fillText(b.value, tx + 14, ty + 36);
    font(ctx, `500 13.5px ${BODY}`);
    ctx.fillStyle = C.ink3;
    ctx.fillText(fit(ctx, b.label, tw - 28), tx + 14, ty + 56);
  });

  // the rules: chips that wrap, at most two lines
  const rules = hof.rules || [];
  let ry = y + 48 + 2 * th + gap + 30;
  if (rules.length && ry + 30 < y + h) {
    font(ctx, `500 12px ${MONO}`, 2);
    ctx.fillStyle = C.ink3;
    ctx.fillText(String(hof.labels?.rules || '').toUpperCase(), x + 22, ry);
    ry += 12;
    font(ctx, `600 13px ${BODY}`, 0.2);
    let cx = x + 22;
    let line = 0;
    for (const r of rules) {
      const text = fit(ctx, r, w - 44 - 24);
      const cw = ctx.measureText(text).width + 22;
      if (cx + cw > x + w - 22 && cx > x + 22) {
        if (++line > 1) break;
        cx = x + 22;
        ry += 32;
      }
      if (ry + 26 > y + h - 8) break;
      rr(ctx, cx, ry, cw, 26, 13);
      ctx.fillStyle = hexA(C.gold, 0.1);
      ctx.fill();
      ctx.strokeStyle = hexA(C.gold, 0.38);
      ctx.stroke();
      ctx.fillStyle = '#f0d9a4';
      ctx.fillText(text, cx + 11, ry + 18);
      cx += cw + 8;
    }
  }
}

/**
 * A won run, right: the final team as trophy cards – a solo Nuzlocke one Pokémon per card, a SoulLink one linked
 * group per card (each player's Pokémon in their colour, the link between them).
 */
function drawHofTeam(ctx, model, { x, y, w, h, sprite, pixel }) {
  const hof = model.hof;
  const groups = (hof.groups || []).slice(0, 6);
  const players = hof.players || [];
  const n = Math.max(1, players.length);

  // header: "FINAL TEAM · LINKED", the players' names in their colours on the right
  font(ctx, `600 15px ${MONO}`, 1.8);
  ctx.fillStyle = C.gold;
  const head = String(hof.labels?.team || '').toUpperCase();
  ctx.fillText(head, x, y + 14);
  const headW = ctx.measureText(head).width;
  if (n > 1) {
    font(ctx, `600 14px ${MONO}`, 1.4);
    let px = x + w;
    for (const p of [...players].reverse()) {
      const name = fit(ctx, String(p.name).toUpperCase(), Math.max(60, (w - headW - 40) / n - 22));
      const nw = ctx.measureText(name).width;
      px -= nw;
      ctx.fillStyle = p.color;
      ctx.fillText(name, px, y + 14);
      px -= 12;
      ctx.fillRect(px, y + 5, 8, 8);
      px -= 18;
    }
  }
  const rule = ctx.createLinearGradient(x, 0, x + w, 0);
  rule.addColorStop(0, C.gold);
  rule.addColorStop(1, hexA(C.gold, 0.05));
  ctx.fillStyle = rule;
  ctx.fillRect(x, y + 24, w, 2);

  const top = y + 38;
  const avail = y + h - top;
  if (!groups.length) {
    rr(ctx, x, top, w, avail, 10);
    ctx.strokeStyle = '#3a3942';
    ctx.setLineDash([5, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    font(ctx, `400 15px ${BODY}`);
    ctx.fillStyle = C.ink3;
    const text = fit(ctx, model.teams?.[0]?.empty || '', w - 24);
    ctx.fillText(text, x + (w - ctx.measureText(text).width) / 2, top + avail / 2 + 5);
    return;
  }
  const cols = 3;
  const rows = Math.max(1, Math.ceil(groups.length / cols));
  const gap = 12;
  const cw = (w - gap * (cols - 1)) / cols;
  const ch = Math.min(150, (avail - gap * (rows - 1)) / rows);
  const box = n === 1 ? Math.min(ch - 56, 92) : n === 2 ? Math.min(ch - 60, (cw - 54) / 2, 80) : Math.min(ch - 60, (cw - 16) / n - 10, 60);
  const scale = commonScale(groups.flatMap((g) => g.mons.filter(Boolean).map((m) => sprite(m.species))), box, box, n <= 2 ? 2 : 1);
  groups.forEach((g, i) => {
    const gx = x + (i % cols) * (cw + gap);
    const gy = top + Math.floor(i / cols) * (ch + gap);
    drawHofGroup(ctx, g, { x: gx, y: gy, w: cw, h: ch, n, box, scale, sprite, pixel, lv: model.labels?.lv || 'Lv' });
  });
}

function drawHofGroup(ctx, g, { x, y, w, h, n, box, scale, sprite, pixel, lv }) {
  // the card: dark glass, a gold rim at the top, a soft spotlight
  rr(ctx, x, y, w, h, 10);
  const bg = ctx.createLinearGradient(0, y, 0, y + h);
  bg.addColorStop(0, 'rgba(40,37,46,.95)');
  bg.addColorStop(1, 'rgba(25,24,31,.95)');
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.07)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.save();
  rr(ctx, x, y, w, h, 10);
  ctx.clip();
  const rim = ctx.createLinearGradient(x, 0, x + w, 0);
  rim.addColorStop(0, hexA(C.gold, 0));
  rim.addColorStop(0.5, hexA(C.goldHi, 0.8));
  rim.addColorStop(1, hexA(C.gold, 0));
  ctx.fillStyle = rim;
  ctx.fillRect(x, y, w, 2);
  glow(ctx, x + w / 2, y + 8, w * 0.6, C.gold, 0.09);
  ctx.restore();

  const mons = g.mons;
  const slotW = (w - 16) / n;
  const nameSize = n === 1 ? 19 : n === 2 ? 16 : 13;
  const subSize = n === 1 ? 13.5 : n === 2 ? 12.5 : 11;
  // sprite, name and level as one block, in the middle of the card
  const spriteTop = y + Math.max(10, Math.round((h - (box + nameSize + subSize + 13)) / 2));
  mons.forEach((m, k) => {
    const sx = x + 8 + k * slotW;
    const cx = sx + slotW / 2;
    // the link between the group's Pokémon
    if (k > 0 && n > 1) {
      const lx = sx - 1;
      const ly = spriteTop + box / 2;
      ctx.fillStyle = hexA(C.goldHi, 0.85);
      if (n === 2) glyph(ctx, 'link', lx - 10, ly - 10, 20, hexA(C.goldHi, 0.9));
      else ctx.fillRect(lx, ly - box / 3, 1, (box * 2) / 3);
    }
    if (!m) {
      font(ctx, `700 ${nameSize}px ${DISPLAY}`);
      ctx.fillStyle = C.ink4;
      ctx.fillText('–', cx - 4, spriteTop + box / 2 + 6);
      return;
    }
    // pedestal shadow, the sprite, the player's colour as a small bar under it
    ctx.fillStyle = 'rgba(0,0,0,.4)';
    ctx.beginPath();
    ctx.ellipse(cx, spriteTop + box - 3, Math.min(box * 0.42, slotW * 0.4), 5, 0, 0, Math.PI * 2);
    ctx.fill();
    drawSprite(ctx, sprite(m.species), cx - box / 2, spriteTop, box, box, { maxScale: n <= 2 ? 2 : 1, pixel, scale });
    const textW = slotW - 10;
    let ty = spriteTop + box + nameSize + 4;
    font(ctx, `700 ${nameSize}px ${DISPLAY}`, 0.2);
    ctx.fillStyle = n === 1 ? C.ink : m.color || C.ink;
    const name = fit(ctx, m.name, textW);
    ctx.fillText(name, cx - ctx.measureText(name).width / 2, ty);
    if (m.shiny) glyph(ctx, 'star', cx + ctx.measureText(name).width / 2 + 3, ty - nameSize + 2, 12, C.goldHi);
    ty += subSize + 5;
    if (ty > y + h - 3) return;
    const lvText = m.level ? `${lv} ${m.level}` : '';
    const sub = n <= 2 && m.sub ? m.sub : '';
    font(ctx, `700 ${subSize + 1}px ${PIXEL}`, 0.4);
    const lvW = lvText ? ctx.measureText(lvText).width : 0;
    font(ctx, `400 ${subSize}px ${BODY}`);
    const subFit = sub ? fit(ctx, sub, textW - lvW - 8) : '';
    const subW = subFit ? ctx.measureText(subFit).width : 0;
    let sx2 = cx - (lvW + (subFit ? 8 + subW : 0)) / 2;
    if (lvText) {
      font(ctx, `700 ${subSize + 1}px ${PIXEL}`, 0.4);
      ctx.fillStyle = C.ink2;
      ctx.fillText(lvText, sx2, ty);
      sx2 += lvW + 8;
    }
    if (subFit) {
      font(ctx, `400 ${subSize}px ${BODY}`);
      ctx.fillStyle = C.ink3;
      ctx.fillText(subFit, sx2, ty);
    }
  });
}

function drawMon(ctx, m, { x, y, w, h, color, big, img, pixel, scale, labels }) {
  const fallen = m.state === 'fallen';
  const dead = m.state === 'dead' || fallen;
  const down = m.state === 'down';
  rr(ctx, x, y, w, h, 8);
  ctx.fillStyle = fallen ? 'rgba(68,30,34,.85)' : dead ? 'rgba(24,23,29,.85)' : 'rgba(34,33,42,.92)';
  ctx.fill();
  ctx.strokeStyle = fallen ? hexA(C.dead, 0.8) : 'rgba(255,255,255,.07)';
  ctx.lineWidth = fallen ? 1.5 : 1;
  ctx.stroke();
  ctx.save();
  rr(ctx, x, y, w, h, 8);
  ctx.clip();
  ctx.fillStyle = dead ? (fallen ? C.dead : '#4a4954') : color;
  ctx.fillRect(x, y, 3, h);
  if (fallen) glow(ctx, x + 30, y + h / 2, h * 1.2, C.dead, 0.22);
  ctx.restore();

  const ss = big ? Math.min(h - 10, 76) : Math.min(h - 4, 46);
  const sx = x + 8;
  drawSprite(ctx, img, sx, y + (h - ss) / 2, ss, ss, { look: fallen ? 'fallen' : dead ? 'dead' : null, maxScale: big ? 2 : 1, pixel, scale });
  if (down && !dead) {
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.fillRect(sx, y + 4, ss, h - 8);
  }

  const tx = sx + ss + (big ? 12 : 8);
  // a tag on the right for the fallen (this event) and the dead – where the row is wide enough; a narrow row says
  // it with its colours alone (red edge, grey sprite, struck-through name)
  let tagW = 0;
  if (dead && w >= 300) {
    const tag = String(fallen ? labels.fallen || 'Gone' : labels.dead || 'Dead').toUpperCase();
    font(ctx, `700 11px ${MONO}`, 1.2);
    tagW = ctx.measureText(tag).width + 14;
    const gx = x + w - tagW - 8;
    const gy = big ? y + 10 : y + (h - 20) / 2;
    rr(ctx, gx, gy, tagW, 20, 4);
    ctx.fillStyle = fallen ? C.dead : '#2f2e36';
    ctx.fill();
    ctx.fillStyle = fallen ? '#1a0d0e' : C.ink3;
    ctx.fillText(tag, gx + 7, gy + 14);
    tagW += 10;
  }
  const textW = x + w - tx - 10 - (big ? 0 : tagW);
  const nameSize = big ? 24 : w < 200 ? 16 : 19;
  const subSize = big ? 15 : w < 200 ? 12 : 13.5;
  const mid = y + h / 2;
  font(ctx, `700 ${nameSize}px ${DISPLAY}`, 0.2);
  ctx.fillStyle = dead ? (fallen ? '#f4c9c3' : C.ink3) : C.ink;
  const name = fit(ctx, m.name, big ? x + w - tx - 10 - (dead ? tagW : 0) : textW);
  const ny = big ? mid - 2 : mid - 1;
  ctx.fillText(name, tx, ny);
  if (dead && !fallen) {
    const nw = ctx.measureText(name).width;
    ctx.fillStyle = C.ink3;
    ctx.fillRect(tx, ny - nameSize * 0.32, nw, 2);
  }
  // "Lv 18 · Cyndaquil"
  const lv = m.level ? `${labels.lv || 'Lv'} ${m.level}` : '';
  font(ctx, `700 ${subSize + 1}px ${PIXEL}`, 0.4);
  ctx.fillStyle = dead ? C.ink4 : C.ink2;
  let sx2 = tx;
  const sy = ny + (big ? 24 : 17);
  if (lv) {
    ctx.fillText(lv, sx2, sy);
    sx2 += ctx.measureText(lv).width + 8;
  }
  if (m.sub) {
    font(ctx, `400 ${subSize}px ${BODY}`);
    ctx.fillStyle = dead ? C.ink4 : C.ink3;
    ctx.fillText(fit(ctx, m.sub, textW - (sx2 - tx)), sx2, sy);
  }
}

/** Every sprite the model shows, loaded (species → image or null). */
export async function loadSprites(model, spriteUrl) {
  const ids = new Set();
  if (model.cause?.species) ids.add(model.cause.species);
  for (const t of model.teams || []) for (const m of t.mons || []) if (m.species) ids.add(m.species);
  for (const g of model.hof?.groups || []) for (const m of g.mons || []) if (m?.species) ids.add(m.species);
  const map = new Map();
  await Promise.all([...ids].map(async (id) => {
    const img = (await loadImage(spriteUrl(id))) || (await loadImage(spriteUrl(id, true)));
    map.set(id, img);
  }));
  return map;
}

/** The card as PNG bytes (Uint8Array): fonts and sprites loaded, painted, encoded. */
export async function renderCardPng(model, spriteUrl) {
  await ensureFonts();
  const sprites = await loadSprites(model, spriteUrl);
  const canvas = document.createElement('canvas');
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  drawCard(canvas.getContext('2d'), model, sprites);
  const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}
