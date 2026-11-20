// Controller navigation for souldew's own screens (issue #33): library, boards, runs, settings, dialogs and menus with
// nothing but a gamepad – for the couch and Steam Deck game mode.
//
// D-pad / left stick: move the focus to the nearest control in that direction (held: repeats). A: press it (a select
// steps to its next option, X to the previous one; a slider moves with left / right). Y: the focused card's own second
// action – today the favourite star of a look (lib/favourites.mjs: [data-pad-y] in [data-pad-y-scope]). B: back – closes the topmost
// dialog, drawer or menu, else goes back to the previous screen. L / R: the page's tabs (board, help, trophies, a
// dialog's tabs), else the previous / next section of the sidebar. Start: into the sidebar and back out. Right stick:
// scrolls what the focus is in. The buttons are the console buttons of Settings › Controller, so a remapped A is
// "confirm" here too; ZL/ZR (LT/RT, L2/R2) and Home stay the game's pause and turbo keys and are never used here.
//
// The game always comes first: while it fills the Play page and runs, the controller is the game's alone and this
// module only watches. Pausing it, opening a menu or dialog over it, or leaving it in the corner hands the controller
// to the app – and the game frame then ignores the buttons (window.__souldewPad.mute, read by lib/controls.mjs
// appHasPad in player.html, playernative.html and player3ds.html). Handing back waits until every button is released,
// so the A that pressed "Resume" doesn't also press A in the game.
//
// The pure parts (where the focus moves, key repeat, reading the pad, who owns it, the back stack) come first and are
// tested in test/padnav.test.mjs; the DOM part below them runs only in the app page (startPadNav in app.mjs).
import { padMap, pickPad, PAD_LABELS, padActions } from './controls.mjs';

// ---- where the focus moves ----------------------------------------------------------------------------------------

/** { left, top, right, bottom } (a DOMRect, or { x, y, width, height }) → edges and centre. */
export function edges(r) {
  const left = r.left ?? r.x ?? 0;
  const top = r.top ?? r.y ?? 0;
  const right = r.right ?? left + (r.width || 0);
  const bottom = r.bottom ?? top + (r.height || 0);
  return { left, top, right, bottom, cx: (left + right) / 2, cy: (top + bottom) / 2 };
}

const TOL = 4; // px two neighbours may overlap and still count as "next to" each other

/**
 * The control to move to from `from` in direction `dir` ('up' | 'down' | 'left' | 'right'): the index into `rects`, or
 * -1 when nothing lies that way. The nearest one ahead wins, where being off to the side counts double (moving down
 * from a card lands on the card below it, not on a closer button further left); among equals the better-aligned one.
 * Controls that overlap `from` (a button inside a big card) are taken when nothing lies cleanly ahead – a control
 * far off to the side and only "ahead" by its centre never is (right at the end of a row goes nowhere).
 */
export function pickTarget(from, dir, rects) {
  const f = edges(from);
  const horiz = dir === 'left' || dir === 'right';
  const sign = dir === 'right' || dir === 'down' ? 1 : -1;
  const score = (r, strict) => {
    const c = edges(r);
    const gap = sign > 0 ? (horiz ? c.left - f.right : c.top - f.bottom) : (horiz ? f.left - c.right : f.top - c.bottom);
    const ahead = sign * (horiz ? c.cx - f.cx : c.cy - f.cy);
    if (ahead <= 1 || (strict && gap < -TOL)) return Infinity;
    if (!strict && (c.right <= f.left || c.left >= f.right || c.bottom <= f.top || c.top >= f.bottom)) return Infinity;
    const side = horiz ? Math.max(0, c.top - f.bottom, f.top - c.bottom) : Math.max(0, c.left - f.right, f.left - c.right);
    const off = Math.abs(horiz ? c.cy - f.cy : c.cx - f.cx);
    return Math.max(0, strict ? gap : ahead) + side * 2 + off * 0.1;
  };
  for (const strict of [true, false]) {
    let best = -1;
    let bestScore = Infinity;
    rects.forEach((r, i) => {
      if (!r) return;
      const s = score(r, strict);
      if (s < bestScore) [best, bestScore] = [i, s];
    });
    if (best >= 0) return best;
  }
  return -1;
}

/**
 * Where the focus starts when there is none yet: the first control in reading order (rows top to bottom, left to right
 * within a row) – among those inside `view` (the visible area) if any are. Returns an index, or -1 for an empty list.
 */
export function firstTarget(rects, view = null) {
  const inView = (r) => {
    if (!view) return true;
    const c = edges(r);
    const v = edges(view);
    return c.bottom > v.top && c.top < v.bottom && c.right > v.left && c.left < v.right;
  };
  const pool = rects.map((r, i) => [r, i]).filter(([r]) => r);
  const shown = pool.filter(([r]) => inView(r));
  let best = -1;
  let key = null;
  for (const [r, i] of shown.length ? shown : pool) {
    const c = edges(r);
    const k = [Math.round(c.top / 16), c.left]; // a row: within 16 px
    if (!key || k[0] < key[0] || (k[0] === key[0] && k[1] < key[1])) [best, key] = [i, k];
  }
  return best;
}

// ---- key repeat -----------------------------------------------------------------------------------------------------

/**
 * Key repeat for a held direction: call it every frame with the direction held (or null) and the time; it returns the
 * direction when the focus should move – at once, again after `delay` ms, then every `rate` ms. Another direction
 * starts over.
 */
export function createRepeat({ delay = 380, rate = 95 } = {}) {
  let cur = null;
  let next = 0;
  return (dir, now) => {
    if (!dir) {
      cur = null;
      return null;
    }
    if (dir !== cur) {
      cur = dir;
      next = now + delay;
      return dir;
    }
    if (now >= next) {
      next = now + rate;
      return dir;
    }
    return null;
  };
}

// ---- reading the controller ----------------------------------------------------------------------------------------

const STICK = 0.5;
const deadzone = (v) => (Math.abs(v) < 0.25 ? 0 : v);

/**
 * What the app reads from a controller (a Gamepad, or { buttons: [{ pressed }], axes }), with the console buttons of
 * Settings › Controller (`pads` = config.pads): dir (null | 'up' | 'down' | 'left' | 'right' – the D-pad, else the left
 * stick), confirm (A), back (B), alt (X), extra (Y), prev / next (L / R), menu (Start), scrollX / scrollY (right stick, -1…1),
 * and `any`: something but the game's hotkeys is pressed or pushed.
 */
export function readPad(pad, pads = null) {
  const pm = padMap(pads);
  const on = (label) => {
    const i = PAD_LABELS.indexOf(label);
    return i >= 0 && !!pad?.buttons?.[i]?.pressed;
  };
  const [lx = 0, ly = 0, rx = 0, ry = 0] = pad?.axes || [];
  let dir = on(pm.up) ? 'up' : on(pm.down) ? 'down' : on(pm.left) ? 'left' : on(pm.right) ? 'right' : null;
  if (!dir && Math.max(Math.abs(lx), Math.abs(ly)) > STICK) dir = Math.abs(lx) > Math.abs(ly) ? (lx < 0 ? 'left' : 'right') : (ly < 0 ? 'up' : 'down');
  const buttons = [...(pad?.buttons || [])];
  const hot = padActions(pads); // the game's shortcut buttons (ZL / ZR unless re-bound) and Home
  const any = buttons.some((b, i) => b?.pressed && !(i in hot)) || [lx, ly, rx, ry].some((v) => Math.abs(v) > STICK);
  return { dir, confirm: on(pm.a), back: on(pm.b), alt: on(pm.x), extra: on(pm.y), prev: on(pm.l), next: on(pm.r), menu: on(pm.start), scrollX: deadzone(rx), scrollY: deadzone(ry), any };
}

// ---- who owns the controller ----------------------------------------------------------------------------------------

/**
 * Does the game own the controller right now? `game` is what the running game session reports (null when there is
 * none): { mode: 'full' | 'mini', playing, paused, overlay }. The game owns it while it fills the Play page and plays
 * (also while it boots – A/B/Start are the game's from the first frame), is not paused, and nothing is open over it:
 * no menu, panel or prompt of the play view (`overlay`) and no dialog of the app (`dialog`). In the corner (mini) the
 * pages around it get the controller.
 */
export function gameOwnsPad(game, { dialog = false } = {}) {
  return !!game && game.mode === 'full' && !!game.playing && !game.paused && !game.overlay && !dialog;
}

// ---- the back stack -------------------------------------------------------------------------------------------------

/**
 * Open layers (dialogs, drawers, menus) in the order they opened, each with the control that had the focus before
 * it – B closes the newest one first and the focus goes back where it was. sync() is called with the layers open now
 * (in document order: of two that turn up at once the inner, later one counts as newer) and the recent focus history
 * (newest first); it returns the layers that closed since, newest first, with their openers.
 * `contains(layer, node)`: is node inside layer (default: DOM contains).
 */
export function createLayerStack({ contains = (layer, node) => !!layer?.contains?.(node) } = {}) {
  let seq = 0;
  const open = new Map(); // layer → { seq, opener }
  return {
    sync(present, history = []) {
      const closed = [];
      for (const [layer, info] of open) {
        if (!present.includes(layer)) {
          open.delete(layer);
          closed.push({ layer, ...info });
        }
      }
      for (const layer of present) {
        if (open.has(layer)) continue;
        open.set(layer, { seq: ++seq, opener: history.find((n) => n && !contains(layer, n)) || null });
      }
      return closed.sort((a, b) => b.seq - a.seq);
    },
    top() {
      let best = null;
      let bestSeq = -1;
      for (const [layer, info] of open) if (info.seq > bestSeq) [best, bestSeq] = [layer, info.seq];
      return best;
    },
    get size() {
      return open.size;
    },
  };
}

/** The app's own screen history (hashes): a step forward is added, going back to the one before removes the last. */
export function trackHistory(stack, hash) {
  if (stack.at(-1) === hash) return stack;
  if (stack.length > 1 && stack.at(-2) === hash) return stack.slice(0, -1);
  return [...stack, hash].slice(-50);
}

/** What B does: close the newest layer, else go back a screen, else go to the sidebar. */
export function backAction({ layer = null, depth = 0 } = {}) {
  return layer ? 'layer' : depth > 0 ? 'history' : 'menu';
}

// ---- the app page ---------------------------------------------------------------------------------------------------

const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable="true"], [data-pad]';
// Layers that keep the focus inside while open. [role=dialog] includes the non-modal panels (save states, cheats) –
// B closes them first. data-pad-layer: prompts drawn over the game that aren't dialogs.
const LAYERS = 'dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"], [data-pad-layer]';
const TEXT = /^(text|search|email|url|tel|password|number)$/;

const state = {
  started: false,
  config: () => ({}),
  claim: null, // () => what the game session reports (gameOwnsPad)
  suspended: 0,
  padMode: false,
  owner: 'ui',
  muteHold: false,
  prev: {},
  blockDir: null,
  history: [],
  focusTrail: [],
  layers: null,
  repeat: createRepeat(),
  timer: 0,
  lastScan: 0,
  raw: '',
  activeAt: -Infinity,
};
const shared = () => (globalThis.__souldewPad ||= { mute: false });

/** The running game session reports here what gameOwnsPad needs; returns the function that ends the claim. */
export function claimPad(report) {
  state.claim = report;
  return () => {
    if (state.claim === report) state.claim = null;
  };
}

/**
 * Pause controller navigation while the page needs the raw buttons (Settings › Controller listening for a new
 * button). Returns the function that resumes it (once).
 */
export function suspendPadNav() {
  state.suspended++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    state.suspended = Math.max(0, state.suspended - 1);
  };
}

const enabled = () => state.config()?.padNav !== false;

function visible(el) {
  if (!el?.isConnected) return false;
  if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function usable(el) {
  if (el.disabled || el.tagName === 'IFRAME' || el.closest('[inert], [aria-hidden="true"], [data-pad-skip]')) return false;
  if (el.getAttribute('tabindex') === '-1' && !el.hasAttribute('data-pad')) return false;
  // a <label class="check"> with its checkbox inside: the checkbox is the stop
  return visible(el);
}

function openLayers() {
  return [...document.querySelectorAll(LAYERS)].filter(visible);
}

function topLayer() {
  const top = state.layers?.top();
  return top && visible(top) ? top : null;
}

const scopeOf = () => topLayer() || document;

function candidates(scope) {
  return [...scope.querySelectorAll(FOCUSABLE)].filter(usable);
}

function setPadMode(on) {
  if (state.padMode === on) return;
  state.padMode = on;
  document.documentElement.classList.toggle('pad-nav', on);
}

// A checkbox or radio is as wide as its label: the row with its text is what the eye sees and moves along.
function rectOf(el) {
  const label = el.matches('input[type="checkbox"], input[type="radio"]') && el.closest('label');
  return (label || el).getBoundingClientRect();
}

function focusEl(el) {
  if (!el) return;
  el.focus({ preventScroll: true });
  const row = el.matches('input[type="checkbox"], input[type="radio"]') && el.closest('label');
  (row || el).scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

const viewport = () => ({ left: 0, top: 0, right: innerWidth, bottom: innerHeight });

/**
 * Where the focus lands on a screen or in a dialog: a control marked data-pad-first, else (on a page) the first
 * primary button in sight, else the first control in reading order – page content before the sidebar.
 */
function firstFocus(scope = scopeOf(), { fromTop = false } = {}) {
  const list = candidates(scope);
  const marked = list.find((el) => el.hasAttribute('data-pad-first'));
  if (marked) return marked;
  let pool = list;
  if (scope === document) {
    const main = list.filter((el) => !el.closest('.rail'));
    if (main.length) pool = main;
    const v = viewport();
    const primary = pool.find((el) => el.matches('.primary') && edges(el.getBoundingClientRect()).top < v.bottom && el.getBoundingClientRect().bottom > 0);
    if (primary) return primary;
  }
  return pool[firstTarget(pool.map(rectOf), fromTop ? null : viewport())] || null;
}

function currentFocus(scope) {
  const el = document.activeElement;
  if (!el || el === document.body || el.tagName === 'IFRAME' || !visible(el)) return null;
  if (scope !== document && !scope.contains(el)) return null;
  // scrolled out of sight with the right stick: start again from what is on screen
  const r = el.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
  return el;
}

function fire(el, ...types) {
  for (const type of types) el.dispatchEvent(new Event(type, { bubbles: true }));
}

function stepSelect(sel, d) {
  const opts = [...sel.options];
  const n = opts.length;
  for (let k = 1; k <= n; k++) {
    const j = (((sel.selectedIndex + d * k) % n) + n) % n;
    if (!opts[j].disabled) {
      if (j !== sel.selectedIndex) {
        sel.selectedIndex = j;
        fire(sel, 'input', 'change');
      }
      return;
    }
  }
}

function move(dir) {
  const scope = scopeOf();
  const from = currentFocus(scope);
  if (!from) return focusEl(firstFocus(scope));
  if (from.matches('input[type="range"]') && (dir === 'left' || dir === 'right')) {
    if (dir === 'right') from.stepUp();
    else from.stepDown();
    return fire(from, 'input', 'change');
  }
  let list = candidates(scope).filter((el) => el !== from && !el.contains(from));
  // up / down stay on their side of the sidebar edge (the sidebar's last item is no way down from a page);
  // left / right cross it
  if (dir === 'up' || dir === 'down') {
    const inRail = (el) => !!el.closest('.rail');
    const same = list.filter((el) => inRail(el) === inRail(from));
    if (same.length) list = same;
  }
  const i = pickTarget(rectOf(from), dir, list.map(rectOf));
  if (i >= 0) return focusEl(openTab(list[i], from) || list[i]);
  // nothing further that way: scroll on, so text below the last control comes into view
  if (dir === 'up' || dir === 'down') scroller(from)?.scrollBy({ top: (dir === 'down' ? 1 : -1) * innerHeight * 0.4, behavior: 'smooth' });
}

/** Moving into a tab list from outside lands on the open tab, not on whichever tab happens to be nearest. */
function openTab(target, from) {
  const tabs = target.getAttribute('role') === 'tab' && target.closest('[role="tablist"]');
  if (!tabs || tabs.contains(from)) return null;
  const open = tabs.querySelector('[role="tab"][aria-selected="true"]');
  return open && usable(open) ? open : null;
}

function scroller(from) {
  for (let el = from; el && el !== document.documentElement; el = el.parentElement) {
    const s = getComputedStyle(el);
    if (/(auto|scroll)/.test(s.overflowY + s.overflowX) && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) return el;
  }
  return document.querySelector('.main') || document.scrollingElement;
}

function confirm() {
  const scope = scopeOf();
  const el = currentFocus(scope);
  if (!el) return focusEl(firstFocus(scope));
  if (el.tagName === 'SELECT') return stepSelect(el, 1);
  if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && TEXT.test(el.type)) || el.matches('input[type="range"]')) return; // typing needs a keyboard
  el.click();
}

function alt() {
  const el = currentFocus(scopeOf());
  if (el?.tagName === 'SELECT') stepSelect(el, -1);
}

// Y: the focused card's second action (its [data-pad-y] control – the favourite star), never moving the focus
function extra() {
  const el = currentFocus(scopeOf());
  el?.closest('[data-pad-y-scope]')?.querySelector('[data-pad-y]')?.click();
}

const frames = (n) => new Promise((res) => {
  const step = () => (n-- <= 0 ? res() : requestAnimationFrame(step));
  step();
});

async function back() {
  const layer = topLayer();
  const expanded = !layer && [...document.querySelectorAll('[aria-expanded="true"]')].find(visible);
  const action = backAction({ layer: layer || expanded || null, depth: state.history.length - 1 });
  if (action === 'history') return history.back();
  if (action === 'menu') return menu(true);
  // the layer's own Escape handling first (dialogs, drawers, popovers all close on it) …
  const target = layer && layer.contains(document.activeElement) ? document.activeElement : layer || expanded;
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
  await frames(2);
  // … else its cancel / close button, or the menu's own toggle
  if (layer && visible(layer)) layer.querySelector('[data-pad-back], .modal-x')?.click();
  else if (expanded && expanded.getAttribute('aria-expanded') === 'true' && visible(expanded)) expanded.click();
}

function menu(fromBack = false) {
  if (topLayer()) return; // the sidebar is behind the dialog
  const rail = document.querySelector('.rail');
  if (!fromBack && rail?.contains(document.activeElement)) return focusEl(firstFocus(document));
  focusEl(document.querySelector('.nav a.active') || document.querySelector('.nav a[href]'));
}

function tabs(d) {
  const layer = topLayer();
  const list = layer ? layer.querySelector('[data-pad-tabs], [role="tablist"]') : document.querySelector('[data-pad-tabs]');
  if (list && visible(list)) {
    const items = [...list.querySelectorAll('[role="tab"]')].filter(usable);
    if (!items.length) return;
    const cur = items.findIndex((el) => el.getAttribute('aria-selected') === 'true' || el.classList.contains('on'));
    const next = items[(((cur < 0 ? 0 : cur + d) % items.length) + items.length) % items.length];
    next.click();
    focusEl(next);
    return;
  }
  if (layer) return;
  const links = [...document.querySelectorAll('.nav a[href]')];
  if (!links.length) return;
  const cur = links.findIndex((a) => a.classList.contains('active'));
  links[(((cur + d) % links.length) + links.length) % links.length].click();
}

function scroll(x, y) {
  const el = currentFocus(scopeOf());
  const target = el ? scroller(el) : topLayer() ? scroller(topLayer().querySelector(FOCUSABLE) || topLayer()) : scroller(null);
  const speed = (v) => Math.sign(v) * v * v * 24;
  target?.scrollBy({ left: speed(x), top: speed(y) });
}

// After a screen change or a closed dialog: put the focus somewhere sensible if it got lost.
function settleFocus({ fromTop = false } = {}) {
  if (!state.padMode) return;
  const el = document.activeElement;
  const scope = scopeOf();
  const lost = !el || el === document.body || el.tagName === 'IFRAME' || !visible(el) || (scope !== document && !scope.contains(el)) || (scope === document && el.closest('.rail'));
  if (lost) focusEl(firstFocus(scope, { fromTop }));
}

function scanLayers() {
  const closed = state.layers.sync(openLayers(), state.focusTrail);
  if (!closed.length || !state.padMode) return;
  const el = document.activeElement;
  if (el && el !== document.body && visible(el)) return; // the dialog gave the focus back itself (ui.mjs Modal)
  const opener = closed.map((c) => c.opener).find((o) => o && visible(o) && (scopeOf() === document || scopeOf().contains(o)));
  if (opener) focusEl(opener);
  else settleFocus();
}

function tick() {
  state.timer = setTimeout(tick, 16);
  const now = performance.now();
  const g = globalThis.navigator?.getGamepads?.() || [];
  const cfg = state.config() || {};
  const pad = pickPad(g, cfg.pads?.device || null);
  const on = enabled();
  if (!pad || !on) {
    shared().mute = false;
    state.owner = 'ui';
    state.prev = {};
    if (!on) setPadMode(false);
    return;
  }
  const s = readPad(pad, cfg.pads);
  const prev = state.prev;
  state.prev = s;
  const raw = pad.buttons.map((b) => (b?.pressed ? 1 : 0)).join('');
  if (raw !== state.raw || s.dir || s.scrollX || s.scrollY) state.activeAt = now; // incl. the game's pause and turbo buttons
  state.raw = raw;
  if (now - state.lastScan > 100) {
    state.lastScan = now;
    scanLayers();
  }
  const game = state.claim?.() || null;
  // (a closed <dialog> of ui.mjs Modal stays in the page, hidden – only a shown one counts)
  const dialog = [...document.querySelectorAll('dialog[open], [aria-modal="true"]')].some(visible);
  if (gameOwnsPad(game, { dialog })) {
    if (state.owner !== 'game') {
      state.owner = 'game';
      state.muteHold = true; // until the button that handed it over is up again
    }
    if (state.muteHold && !s.any) {
      state.muteHold = false;
      shared().mute = false;
      const el = document.activeElement;
      if (!el || el === document.body || el.closest?.('.session')) game.focus?.();
    }
    state.repeat(null, now);
    return;
  }
  shared().mute = !!game; // the game in the corner or paused: its buttons are the app's now
  if (state.owner !== 'ui') {
    state.owner = 'ui';
    state.blockDir = s.dir; // a direction still held from the game doesn't move the focus
    // paused with the controller (ZL / Home) or a prompt popped up while playing with it: show where the focus is
    if (game && now - state.activeAt < 1500) setPadMode(true);
    if (state.padMode) settleFocus();
  }
  if (state.suspended || document.visibilityState === 'hidden' || !document.hasFocus() || document.querySelector('.boot')) {
    state.repeat(null, now);
    return;
  }
  if (state.blockDir && s.dir !== state.blockDir) state.blockDir = null;
  const dir = state.repeat(state.blockDir ? null : s.dir, now);
  const pressed = (k) => s[k] && !prev[k];
  const acted = dir || pressed('confirm') || pressed('back') || pressed('alt') || pressed('extra') || pressed('prev') || pressed('next') || pressed('menu') || s.scrollX || s.scrollY;
  if (!acted) return;
  const wasPadMode = state.padMode;
  setPadMode(true);
  if (dir) {
    // the first press after the mouse only shows where the focus is
    if (!wasPadMode && currentFocus(scopeOf())) return;
    move(dir);
  }
  if (pressed('confirm')) confirm();
  if (pressed('back')) back();
  if (pressed('alt')) alt();
  if (pressed('extra')) extra();
  if (pressed('prev')) tabs(-1);
  if (pressed('next')) tabs(1);
  if (pressed('menu')) menu();
  if (s.scrollX || s.scrollY) scroll(s.scrollX, s.scrollY);
}

/**
 * Start controller navigation for the app page. `config`: () => the current config (status.config – padNav, pads).
 * Returns the function that stops it.
 */
export function startPadNav({ config }) {
  if (state.started) return () => {};
  state.started = true;
  state.config = config;
  state.layers = createLayerStack();
  state.history = [location.hash || '#/'];
  const onHash = () => {
    state.history = trackHistory(state.history, location.hash || '#/');
    if (!state.padMode) return;
    // the new screen renders first
    // the new screen renders first; its focus starts at the top, wherever the page was scrolled to
    frames(2).then(() => setTimeout(() => settleFocus({ fromTop: true }), 30));
  };
  const onFocus = (e) => {
    state.focusTrail = [e.target, ...state.focusTrail.filter((x) => x !== e.target)].slice(0, 12);
  };
  // the mouse or the keyboard takes over again: the focus ring goes (only real input – B sends a synthetic Escape)
  const off = (e) => {
    if (!e.isTrusted) return;
    if (e.type === 'mousemove' && !e.movementX && !e.movementY) return;
    setPadMode(false);
  };
  addEventListener('hashchange', onHash);
  document.addEventListener('focusin', onFocus);
  for (const type of ['pointerdown', 'mousemove', 'keydown', 'wheel']) addEventListener(type, off, { passive: true, capture: true });
  tick();
  return () => {
    clearTimeout(state.timer);
    removeEventListener('hashchange', onHash);
    document.removeEventListener('focusin', onFocus);
    for (const type of ['pointerdown', 'mousemove', 'keydown', 'wheel']) removeEventListener(type, off, { capture: true });
    shared().mute = false;
    setPadMode(false);
    state.started = false;
  };
}
