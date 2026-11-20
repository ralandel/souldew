// Interface size, the page's half (shared/uiscale.mjs; the window's zoom is set by electron/main.mjs): what the window
// shows now, Settings › General's choice, the View menu and the shortcuts ⌘+ / ⌘− / ⌘0 (Ctrl elsewhere), and the
// one-time hint on a big screen. Only in the desktop app – in a browser (`npm start`) the browser's own zoom does it.
//
// The shortcuts never take a key from the game: while a game fills the window, a shortcut of Settings › Controls on the
// same key acts instead (⌘+ / ⌘− are the game's speed there by default, as since 2.8), so `setPlayKeys` lets the play
// view say which keys are its own. Keys pressed inside the game frame reach the page through the play view
// (views/play.mjs onKey → uiScaleKeyDown).
import { useState, useEffect } from '/vendor/htm-preact.mjs';
import { UI_SCALES, validUiScale, stepUiScale, uiScaleKey, suggestUiScale } from '/shared/uiscale.mjs';
import { api } from './api.mjs';
import { IS_MAC, shortcut } from './platform.mjs';

export { UI_SCALES, suggestUiScale };

/** The shortcuts for display: { bigger: '⌘+', smaller: '⌘−', reset: '⌘0' } on a Mac, 'Ctrl++' … elsewhere. */
export function uiScaleKeys({ space = false } = {}) {
  const base = shortcut('Mod+0', { space });
  return { bigger: base.replace(/0$/, '+'), smaller: base.replace(/0$/, '−'), reset: base };
}

/** Can souldew size its interface here (the desktop app)? */
export const uiScaleNative = () => typeof window !== 'undefined' && typeof window.sls?.uiScale === 'function';

let state = { chosen: 1, applied: 1, fit: 1.75, display: null, win: null };
const subs = new Set();

function take(next) {
  if (!next || typeof next !== 'object') return;
  state = { ...state, ...next, chosen: validUiScale(next.chosen ?? state.chosen), applied: validUiScale(next.applied ?? state.applied) };
  // (styles.css: the few places that keep their room for the window's own buttons at sizes below 100 %)
  document.documentElement.style.setProperty('--ui-zoom', String(state.applied));
  for (const fn of subs) fn(state);
}

/** What the window shows now: { chosen, applied, fit (the biggest size this window takes), display, win }. */
export const uiScaleState = () => state;

/** Follows the window's interface size (once at the start, then whenever it changes). */
export function initUiScale() {
  if (!uiScaleNative()) return () => {};
  window.sls.uiScale().then(take, () => {});
  return window.sls.on?.('ui-scale', take) || (() => {});
}

/** Show `v` from now on and keep it in this computer's config. Returns the window's answer. */
export async function setUiScale(v) {
  if (!uiScaleNative()) return state;
  const chosen = validUiScale(v);
  take(await window.sls.uiScale(chosen));
  await api.post('/api/config', { uiScale: chosen }).catch(() => {});
  return state;
}

/**
 * One step bigger / smaller, or back to 100 % (dir 'in' / 'out' / 'reset'). `onLimit()`: the window is too small to show
 * a bigger size (it wouldn't change anything visible) – the caller says so.
 */
let limitFn = null; // the app's "no room for bigger" (watchUiScaleKeys)
export async function stepUi(dir, { onLimit = limitFn } = {}) {
  if (!uiScaleNative()) return;
  const next = stepUiScale(state.applied, dir);
  if (dir === 'in' && next === state.applied) return;
  const r = await setUiScale(next);
  if (dir === 'in' && r.applied < next) onLimit?.(r);
}

let playKeys = null;
/**
 * The play view says which key presses are its own right now: `fn(k)` → true when a shortcut of Settings › Controls
 * acts on this key (the game fills the window). Returns the function that takes it back.
 */
export function setPlayKeys(fn) {
  playKeys = fn;
  return () => {
    if (playKeys === fn) playKeys = null;
  };
}

/**
 * A key press (a DOM event or a key the player page forwarded): an interface size shortcut? Then it is done and true
 * comes back. Not in a browser (its own zoom has the keys there), not a key the play view takes.
 */
export function uiScaleKeyDown(k, { onLimit = limitFn, fromGame = false } = {}) {
  if (!uiScaleNative()) return false;
  const dir = uiScaleKey(k, IS_MAC);
  if (!dir) return false;
  if (!fromGame && playKeys?.(k)) return false;
  if (!(k.repeat && dir === 'reset')) stepUi(dir, { onLimit });
  return true;
}

/** Settings: the interface size as it is now – re-renders when it changes. */
export function useUiScale() {
  const [s, setS] = useState(state);
  useEffect(() => {
    subs.add(setS);
    setS(state);
    return () => subs.delete(setS);
  }, []);
  return s;
}

/** The app's own listener (web/app.mjs): the shortcuts on the page. */
export function watchUiScaleKeys({ onLimit } = {}) {
  limitFn = onLimit || null;
  const down = (e) => {
    if (e.defaultPrevented) return;
    const k = { key: e.key, code: e.code, keyCode: e.keyCode, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, repeat: e.repeat, target: e.target };
    if (uiScaleKeyDown(k)) e.preventDefault();
  };
  addEventListener('keydown', down);
  return () => {
    removeEventListener('keydown', down);
    if (limitFn === onLimit) limitFn = null;
  };
}
