// The pixel art of "playing together" (docs/MULTIPLAYER.md › 9): the battle bubble, the gift, the tombstone and the
// "come here" arrow. Original art, drawn for souldew – no game graphics. Same masks as web/lib/worldart.mjs ('#' the
// player's colour, 'o' the outline ink); the tombstone has a palette of its own (stone, light, shade, grass).
// The battle and gift masks join worldart's ART, so the overlay's speech bubble and the menus draw them like the emotes.
import { ART, INK, artUrl } from './worldart.mjs';

export const TOGETHER_ART = {
  // two crossed blades over their hilts – "in a battle"
  battle: ['##.....##', '###...###', '.###.###.', '..#####..', '...###...', '..#####..', '.oo.#.oo.', 'oo.....oo'],
  // a parcel tied with a ribbon – "give an item"
  gift: ['..oo.oo..', '..o#o#o..', 'ooooooooo', 'o###o###o', 'ooooooooo', '.o##o##o.', '.o##o##o.', '.ooooooo.'],
};
Object.assign(ART, TOGETHER_ART);

// the tombstone: o outline, h light, s stone, d shade, g / G grass
const TOMB = ['...ooooo...', '..ohhhhso..', '.ohhsdssdo.', '.ohsdddsdo.', '.ohssdssdo.', '.ohssdssdo.', '.ohsssssdo.', '.ohsssssdo.', '.ohsssssdo.', 'ooooooooooo', '.gGg.g.gGg.'];
const TOMB_INK = { o: INK, h: '#d9d5df', s: '#a9a5b2', d: '#77737f', g: '#79b36a', G: '#4f8a46' };
export const TOMB_SIZE = [TOMB[0].length, TOMB.length];

/** The tombstone's pixels (RGBA, for the overlay's cut-out against the map's top layer). */
export function tombPixels() {
  const [w, h] = TOMB_SIZE;
  const out = new Uint8ClampedArray(w * h * 4);
  TOMB.forEach((row, y) => [...row].forEach((ch, x) => {
    const c = TOMB_INK[ch];
    if (!c) return;
    const i = (y * w + x) * 4;
    out[i] = parseInt(c.slice(1, 3), 16);
    out[i + 1] = parseInt(c.slice(3, 5), 16);
    out[i + 2] = parseInt(c.slice(5, 7), 16);
    out[i + 3] = 255;
  }));
  return out;
}

// the "come here" arrow: pointing east and south-east – the other six are flips and a turn of these
const ARROW_E = ['oo.....', 'o#oo...', 'o###oo.', 'o#####o', 'o###oo.', 'o#oo...', 'oo.....'];
const ARROW_SE = ['......o', '.....oo', '....o#o', '...o##o', '..o###o', '.o####o', 'ooooooo'];
const flipX = (rows) => rows.map((r) => [...r].reverse().join(''));
const flipY = (rows) => [...rows].reverse();
const turn = (rows) => [...rows[0]].map((_, x) => rows.map((r) => r[x]).join('')); // E → S (transpose)
export const ARROWS = {
  E: ARROW_E, W: flipX(ARROW_E), S: turn(ARROW_E), N: flipY(turn(ARROW_E)),
  SE: ARROW_SE, SW: flipX(ARROW_SE), NE: flipY(ARROW_SE), NW: flipX(flipY(ARROW_SE)),
};
/** The arrow for an angle (radians, 0 = east, clockwise as the picture's y grows downward). */
export function arrowFor(angle) {
  const k = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
  return ARROWS[['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'][k]];
}

/** Paints a mask ('#' colour, 'o' ink, or a palette of its own) at (x, y), `px` pixels per art pixel. */
export function paintRows(ctx, rows, x, y, palette, px = 1) {
  rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      const c = palette[row[i]];
      if (!c) continue;
      ctx.fillStyle = c;
      ctx.fillRect(x + i * px, y + j * px, px, px);
    }
  });
}
export const tombPalette = TOMB_INK;
export const TOMB_ROWS = TOMB;

/** An <img> source for the views (the board, the cards): battle / gift in a colour. */
export const togetherArtUrl = (name, color = '#ebe6da', scale = 2) => artUrl(name, color, scale);
