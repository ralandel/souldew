// The big play view's layout (views/play.mjs, views/playdock.mjs): one dock next to the game – right of tall pictures
// (Game Boy, GBA, DS and 3DS screens on top of each other), under wide ones (DS / 3DS side by side, 3DS large) –
// wherever the picture comes out bigger. Pure, so the rule is tested without a page (test/playlayout.test.mjs).

/** The right dock's width (the column the session always had). */
export const DOCK_W = 300;
/** Between the game and the dock. */
export const DOCK_GAP = 14;
/** The game bar under the picture (36) and the gap above it (8). */
export const BAR_H = 44;
/** A folded dock: the strip's width on the right, its height at the bottom. */
export const FOLDED = 48;

/**
 * The bottom dock's height: enough for a linked group of every player to stay readable (one row per player in a
 * group's card), never less than the title card with the place and the level cap needs.
 */
export function dockHeight(players = 1) {
  const n = Math.max(1, Math.min(4, Number(players) || 1));
  return [196, 196, 196, 234, 266][n];
}

/** The biggest w×h of aspect `ar` inside w×h (whole pixels). */
export function fit(w, h, ar) {
  if (!(w > 0 && h > 0 && ar > 0)) return { w: 0, h: 0 };
  const pw = Math.min(w, h * ar);
  return { w: Math.floor(pw), h: Math.floor(pw / ar) };
}

/**
 * The picture's size in the play area `area` ({ w, h }) with the dock on `side` – the dock's own room, the gap and the
 * game bar under the picture taken off. `folded`: the dock is only its strip.
 */
export function pictureFor(area, ar, side, { dockW = DOCK_W, dockH = dockHeight(1), gap = DOCK_GAP, bar = BAR_H, folded = false } = {}) {
  if (!area?.w || !area?.h) return { w: 0, h: 0 };
  const room = folded ? FOLDED : side === 'bottom' ? dockH : dockW;
  return side === 'bottom' ? fit(area.w, area.h - room - gap - bar, ar) : fit(area.w - room - gap, area.h - bar, ar);
}

/**
 * Where the dock goes for a picture of aspect `ar` in `area`: the side that leaves the bigger picture. Deterministic –
 * the same area and aspect always give the same side (no memory of the last one), and it is decided with the dock
 * open, so folding or unfolding it never moves it to the other side. Near a tie (within 2 %) the right side wins: a
 * column reads better than a strip.
 */
export function dockSide(area, ar, opts = {}) {
  if (!area?.w || !area?.h || !(ar > 0)) return 'right';
  const size = (side) => {
    const p = pictureFor(area, ar, side, { ...opts, folded: false });
    return p.w * p.h;
  };
  return size('bottom') > size('right') * 1.02 ? 'bottom' : 'right';
}

/** A partner tile's height for a width: header (28), borders and margins around the picture. */
export const tileHeight = (w, ar) => Math.round(36 + Math.max(0, w - 14) / ar);

/**
 * How many partner tiles side by side in a box of `box` ({ w, h }; h may be Infinity): the most width per tile with
 * every row still fitting the height, at most `n` – one column when nothing fits better.
 */
export function tileColumns(n, ar, box, gap = 8) {
  if (!(n > 0) || !(box?.w > 0) || !(ar > 0)) return 1;
  let best = null;
  for (let c = 1; c <= n; c++) {
    const w = (box.w - (c - 1) * gap) / c;
    const rows = Math.ceil(n / c);
    const h = rows * tileHeight(w, ar) + (rows - 1) * gap;
    const fits = !(box.h > 0) || h <= box.h;
    // the widest tiles that fit; while none fits, the arrangement that comes closest
    if (fits ? !best?.fits || w > best.w : !best || (!best.fits && h < best.h)) best = { c, w, h, fits };
  }
  return best.c;
}

/** The right dock's width: the spare room next to the picture (the game bar's width counts), DOCK_W … max. */
export function rightDockWidth(area, stageW, max = 660) {
  if (!area?.w) return DOCK_W;
  return Math.max(DOCK_W, Math.min(max, Math.floor(area.w - stageW - DOCK_GAP)));
}

/**
 * The partners' marks on the folded strip: the first letter of each name – two letters for names that share their first
 * one ("Mi", "Ma"), the colour tells them apart as well.
 */
export function initials(names) {
  const first = names.map((n) => String(n || '').trim().slice(0, 1).toUpperCase());
  return names.map((n, i) => {
    const s = String(n || '').trim();
    if (first.filter((f) => f === first[i]).length < 2 || s.length < 2) return first[i];
    return first[i] + s.slice(1, 2).toLowerCase();
  });
}
