// Interface size (Settings › General): how big souldew draws its own interface on this computer – the sidebar, the
// dock, the board, partner windows, menus, toasts, the names and menus over the game. "On a bigger monitor with a higher
// pixel count the UI is unreadable and too small to see" (a player on Discord).
//
// electron/main.mjs applies it as the window's zoom (Chromium's page zoom): everything is laid out again at the new
// size, so text, icons and borders stay crisp, and every canvas that sizes itself by devicePixelRatio draws sharper.
// The game picture isn't scaled by it: the players size the picture in device pixels (web/lib/pixelscale.mjs), so it
// stays whole-number sharp in whatever room the play view leaves it. The stream overlays aren't touched either – OBS
// loads them in its own browser at the size the streamer gives them (they have a scale of their own).
//
// Stored per computer (config.json `uiScale`), not per account: the same player may have a 4K screen at home and a
// laptop elsewhere. Pure functions – the window (main.mjs), the server (validation) and the page (web/lib/uiscale.mjs)
// share them; tested in test/uiscale.test.mjs.

/** The sizes Settings offers, smallest first. 1 = as designed. */
export const UI_SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75];

/**
 * The smallest room the interface is laid out for (CSS px) – the window's own minimum size at 100 %. A bigger size that
 * would leave less than this in the window is shown one step smaller until the window is larger again (a 1080p laptop
 * at 175 % would have 1097 × 600 px – the dock, the board and Settings don't fit); 100 % and below always apply.
 */
export const MIN_VIEW = { w: 980, h: 640 };

/** A stored or sent value → one of UI_SCALES (anything else: 1). */
export function validUiScale(v) {
  const n = Number(v);
  return UI_SCALES.includes(n) ? n : 1;
}

/** "125 %" (the page puts the number in its language's format). */
export const uiScaleLabel = (v, fmt = (n) => String(n)) => `${fmt(Math.round(validUiScale(v) * 100))} %`;

/**
 * The size that is shown for the chosen one in a window whose content is `win` ({ w, h } in screen points – DIP): the
 * chosen size, or the biggest smaller one above 100 % that still leaves MIN_VIEW. Unknown window size: the chosen one.
 */
export function fitUiScale(chosen, win) {
  const c = validUiScale(chosen);
  if (c <= 1 || !(win?.w > 0 && win?.h > 0)) return c;
  const fits = (s) => win.w / s >= MIN_VIEW.w - 0.5 && win.h / s >= MIN_VIEW.h - 0.5;
  for (let i = UI_SCALES.indexOf(c); i >= 0 && UI_SCALES[i] > 1; i--) if (fits(UI_SCALES[i])) return UI_SCALES[i];
  return 1;
}

/**
 * The next size for a shortcut or menu entry: 'in' one step bigger, 'out' one step smaller, 'reset' 100 %. Steps from
 * what is shown (`from`), so ⌘− right after a window too small for 175 % made it show 125 % gives 110 %, not 150 %.
 */
export function stepUiScale(from, dir) {
  if (dir === 'reset') return 1;
  const cur = validUiScale(from);
  const i = UI_SCALES.indexOf(cur);
  if (dir === 'in') return UI_SCALES[Math.min(UI_SCALES.length - 1, i + 1)];
  if (dir === 'out') return UI_SCALES[Math.max(0, i - 1)];
  return cur;
}

/**
 * Which interface size shortcut a key press is – 'in' (⌘+ / Ctrl++, also ⌘= and the keypad's +, as in every browser),
 * 'out' (⌘− / Ctrl+−, keypad −), 'reset' (⌘0 / Ctrl+0, keypad 0) – or null. `e`: a DOM KeyboardEvent or what the player
 * pages forward ({ key, code, keyCode, shift, ctrl, alt, meta }). ⌘ on a Mac, Ctrl elsewhere, never with Alt or the other
 * one; Shift only for "+" (Shift+= on US keyboards). The keyCode first (the physical key, any layout: 187 is "=" in the
 * US and "+" in Germany; Shift+0 is "=" on a German keyboard and isn't "+"), the character for layouts that put + or −
 * elsewhere.
 */
export function uiScaleKey(e, mac) {
  if (!e) return null;
  const meta = !!(e.meta ?? e.metaKey);
  const ctrl = !!(e.ctrl ?? e.ctrlKey);
  const alt = !!(e.alt ?? e.altKey);
  const shift = !!(e.shift ?? e.shiftKey);
  if (alt || (mac ? !meta || ctrl : !ctrl || meta)) return null;
  const k = Number(e.keyCode) || 0;
  if (k === 187 || k === 107) return 'in';
  if (k === 189 || k === 109 || k === 173) return shift ? null : 'out';
  if (k === 48 || k === 96) return shift ? null : 'reset';
  if (e.key === '+') return 'in';
  if (e.key === '-' && !shift) return 'out';
  if ((e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0') && !shift) return 'reset';
  return null;
}

/**
 * Should souldew suggest a bigger interface on this screen – and which size? `display`: the window's screen ({ w, h }
 * in DIP, `scale`: its device pixels per DIP), `win`: the window's content ({ w, h } DIP), `chosen`: the size set now.
 * Returns a size from UI_SCALES or null.
 *
 * Only while the interface is at 100 % (someone who picked a size has decided), on a large screen in DIP – 4K or 5K at
 * 100 % (≥ 3200 × 1600: 150 %), 1440p-class at 100 % (≥ 2400 × 1300: 125 %) – and with the window big on it (≥ 1600 ×
 * 900, maximised more or less): the text is small on such a screen at any window size, but a small window is no place
 * for bigger panels. Not for a 1440p-class screen with ≥ 2 device pixels per point (a Retina Mac's "looks like 2560 ×
 * 1440"): the system's own display setting already chose that size. The suggestion is one that fits the window.
 */
export function suggestUiScale({ display, win, chosen = 1 } = {}) {
  if (validUiScale(chosen) !== 1) return null;
  const long = Math.max(Number(display?.w) || 0, Number(display?.h) || 0);
  const short = Math.min(Number(display?.w) || 0, Number(display?.h) || 0);
  if (!(Number(win?.w) >= 1600 && Number(win?.h) >= 900)) return null;
  let s = null;
  if (long >= 3200 && short >= 1600) s = 1.5;
  else if (long >= 2400 && short >= 1300 && !((Number(display?.scale) || 1) >= 2)) s = 1.25;
  if (!s) return null;
  const fit = fitUiScale(s, win);
  return fit > 1 ? fit : null;
}

/**
 * The window's own controls at a size: the macOS traffic lights' position and the height of the Windows title bar
 * buttons, so they keep their place next to the page's (scaled) title strip – at 100 % the values main.mjs always had.
 */
export function windowChromeAt(z) {
  const s = validUiScale(z);
  return { lights: { x: Math.round(16 * s), y: Math.round(18 * s) }, titleBar: Math.round(36 * s) };
}
