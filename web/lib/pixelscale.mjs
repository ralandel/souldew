// How the players draw the game's pixels at any size (lib/nativeplayer.mjs, lib/ctrplayer.mjs, player.html):
// "sharp" by default – each game pixel is first blown up by a whole number with hard edges (every pixel the same size,
// no shimmering rows), then the picture is smoothed the last bit to fit the frame exactly. Settings › "Whole pixels
// only" snaps to a whole multiple instead – when that costs no more than WHOLE_MAX_LOSS of the picture's area. (The
// browser emulator can't draw at a factor of its own – RetroArch sizes its buffer by the canvas – so it snaps to whole
// multiples when they cost little, see player.html.)
// Pure, tested in test/playlayout.test.mjs.

/** The most of the picture's area "Whole pixels only" may give up for a whole multiple. */
export const WHOLE_MAX_LOSS = 0.15;
/** The drawing buffer never gets wider or taller than this (a 3DS picture at 4× is 1600 px wide already). */
const MAX_BUFFER = 4096;

/**
 * The picture of `src` ({ w, h } game pixels) in a frame of `box` ({ w, h } CSS px) on a screen with `dpr` device pixels
 * per CSS px →
 *   pre    – whole factor the game's pixels are drawn at (hard edges): the drawing buffer is src × pre
 *   w, h   – the picture's size on the page in CSS px
 *   smooth – the last step to w × h is smoothed (false: it is a whole multiple – drawn as it is)
 *   whole  – snapped to a whole multiple ("Whole pixels only"; maxLoss: the most of the area that may cost)
 */
export function sharpScale(src, box, dpr = 1, { whole = false, maxLoss = WHOLE_MAX_LOSS } = {}) {
  const sw = src?.w;
  const sh = src?.h;
  const d = dpr > 0 ? dpr : 1;
  if (!(sw > 0 && sh > 0 && box?.w > 0 && box?.h > 0)) return { pre: 1, w: Math.max(0, box?.w || 0), h: Math.max(0, box?.h || 0), smooth: false, whole: false };
  const k = Math.min(box.w / sw, box.h / sh); // CSS px per game pixel
  const kd = k * d; // device px per game pixel
  const n = Math.floor(kd + 1e-6);
  const cap = Math.max(1, Math.floor(MAX_BUFFER / Math.max(sw, sh)));
  if (whole && n >= 1 && (n / kd) ** 2 >= 1 - maxLoss - 1e-9) {
    const m = Math.min(n, cap);
    return { pre: m, w: (sw * n) / d, h: (sh * n) / d, smooth: false, whole: true };
  }
  // whole device pixels for the picture (no half pixel at an edge)
  const w = Math.floor(sw * kd + 1e-6) / d;
  const h = Math.floor(sh * kd + 1e-6) / d;
  if (n < 1) return { pre: 1, w, h, smooth: true, whole: false }; // smaller than the game: plain smoothing
  const pre = Math.min(n, cap);
  return { pre, w, h, smooth: Math.abs(kd - pre) > 1e-6, whole: false };
}

/**
 * A DS click for the core, which takes the pointer over its own picture with the two screens on top of each other:
 * `fx`, `fy` 0…1 over the shown picture → { x, y } 0…1 over the core's picture. Side by side the right half is the
 * bottom screen.
 */
export function dsTouchAt(fx, fy, sideBySide = false) {
  const x = Math.min(1, Math.max(0, fx));
  const y = Math.min(1, Math.max(0, fy));
  if (!sideBySide) return { x, y };
  return x < 0.5 ? { x: x * 2, y: y * 0.5 } : { x: (x - 0.5) * 2, y: 0.5 + y * 0.5 };
}
