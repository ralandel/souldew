// The pixel art of the Shared World bubbles (docs/MULTIPLAYER.md › 9): emotes and the rock-paper-scissors hands.
// Original art, drawn for souldew (no game graphics): small masks (emotes 9×8, hands up to 10×10), '#' = the player's colour.
// The overlay (web/lib/worldoverlay.mjs) draws them into its 240×160 canvas; the rock-paper-scissors card (web/views/rps.mjs) and
// the menus draw the same masks into small canvases.

export const ART = {
  wave: ['..#.#.#..', '..#.#.#.#', '#.#.#.#.#', '#.#######', '#########', '.########', '..######.', '...####..'],
  heart: ['.##...##.', '####.####', '#########', '#########', '.#######.', '..#####..', '...###...', '....#....'],
  excl: ['...###...', '...###...', '...###...', '...###...', '....#....', '.........', '...###...', '...###...'],
  quest: ['..#####..', '.##...##.', '......##.', '....###..', '...##....', '.........', '...##....', '...##....'],
  gg: ['.........', '.###..###', '#....#...', '#.##.#.##', '#..#.#..#', '.###..###', '.........', '.........'],
  // the hands: 'o' the dark outline, '#' the player's colour
  rock: ['.oo.oo.oo.', 'o##o##o##o', 'o##o##o##o', 'o########o', 'oooooo###o', 'o######o#o', '.o######o.', '..oooooo..'],
  paper: ['..o.o.o...', '.o#o#o#o..', '.o#o#o#oo.', '.o#o#o#o#o', 'oo#######o', 'o#o######o', 'o##o#####o', '.o#######o', '..o#####o.', '...ooooo..'],
  scissors: ['oo...oo...', 'o#o.o#o...', 'o#o.o#o...', '.o#o#o.o..', 'oo###oo#o.', 'o#######o.', 'ooooo###o.', 'o#####o#o.', '.o#####o..', '..ooooo...'],
};
/** Hands by their number on the wire (shared/rps.mjs: 0 rock, 1 paper, 2 scissors). */
export const HAND_ART = ['rock', 'paper', 'scissors'];

export const INK = '#26232c';
/** The size of an art in its pixels: [w, h]. */
export const artSize = (name) => [ART[name]?.[0]?.length || 0, ART[name]?.length || 0];

/** Fills `art` at (x, y) in a 2D context, `px` pixels per art pixel ('#' in `color`, 'o' in the outline ink). */
export function paintArt(ctx, name, x, y, color, px = 1) {
  const rows = ART[name];
  if (!rows) return;
  for (const [ch, fill] of [['#', color], ['o', INK]]) {
    ctx.fillStyle = fill;
    rows.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) if (row[i] === ch) ctx.fillRect(x + i * px, y + j * px, px, px);
    });
  }
}

/** A small canvas with the art (for buttons): `scale` CSS pixels per art pixel, crisp. */
export function artCanvas(name, color = 'currentColor', scale = 2) {
  const c = document.createElement('canvas');
  const [w, h] = artSize(name);
  c.width = w * scale;
  c.height = h * scale;
  c.className = 'px-art';
  c.setAttribute('aria-hidden', 'true');
  const ctx = c.getContext('2d');
  const col = color === 'currentColor' ? getComputedStyle(document.documentElement).color || '#ebe6da' : color;
  paintArt(ctx, name, 0, 0, col, scale);
  return c;
}

/** The same art as a data URL (Preact views: an <img> with image-rendering: pixelated). */
const urls = new Map();
export function artUrl(name, color = '#ebe6da', scale = 4) {
  const key = `${name}:${color}:${scale}`;
  if (!urls.has(key)) urls.set(key, artCanvas(name, color, scale).toDataURL());
  return urls.get(key);
}
