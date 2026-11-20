// Keyboard and controller mapping for the built-in emulator – shared by Settings, Help and player.html (no imports on purpose).
// config.controls = { [button]: { keyCode, key, code? } }; keyCode is what EmulatorJS matches on, key is only for display,
// code (KeyboardEvent.code, the physical key) is set by presets and newer bindings – older configs without it still work.
export const BUTTONS = [
  // ejs = RetroArch joypad index in EmulatorJS' controls table (controller bindings: PAD_PRESETS below)
  { id: 'up', ejs: 4, keyCode: 38, key: 'ArrowUp' },
  { id: 'down', ejs: 5, keyCode: 40, key: 'ArrowDown' },
  { id: 'left', ejs: 6, keyCode: 37, key: 'ArrowLeft' },
  { id: 'right', ejs: 7, keyCode: 39, key: 'ArrowRight' },
  { id: 'a', ejs: 8, keyCode: 90, key: 'z' },
  { id: 'b', ejs: 0, keyCode: 88, key: 'x' },
  { id: 'x', ejs: 9, keyCode: 65, key: 'a', systems: ['nds'] },
  { id: 'y', ejs: 1, keyCode: 83, key: 's', systems: ['nds'] },
  { id: 'l', ejs: 10, keyCode: 81, key: 'q', systems: ['nds', 'gba'] },
  { id: 'r', ejs: 11, keyCode: 69, key: 'e', systems: ['nds', 'gba'] },
  { id: 'start', ejs: 3, keyCode: 13, key: 'Enter' },
  { id: 'select', ejs: 2, keyCode: 86, key: 'v' },
  // 3DS only, no joypad button (no ejs): held, the Circle Pad goes only part of the way – a key gives full tilt, and
  // some games walk slowly on a light tilt (Omega Ruby / Alpha Sapphire sneak). shared/ctrinput.mjs CTR_SNEAK_TILT.
  { id: 'sneak', keyCode: 67, key: 'c', systems: ['3ds'] },
];
/** A button of the console's joypad (EmulatorJS / RetroArch index) – not the 3DS half tilt. */
export const isJoypad = (b) => Number.isInteger(b?.ejs);

const NAMED = { 8: 'Backspace', 13: 'Enter', 32: 'Space', 33: 'Page ↑', 34: 'Page ↓', 35: 'End', 36: 'Home', 37: '←', 38: '↑', 39: '→', 40: '↓',
  45: 'Insert', 46: 'Delete', 106: 'Num *', 107: 'Num +', 109: 'Num -', 110: 'Num ,', 111: 'Num /' };

/** Can EmulatorJS bind this key at all? (its keyMap; modifiers, Tab, Esc and lock keys are left out) */
export function bindable(keyCode) {
  const c = keyCode;
  return c in NAMED || (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 96 && c <= 105) || (c >= 112 && c <= 123)
    || (c >= 186 && c <= 192) || (c >= 219 && c <= 222);
}

// ---- presets & keyboard layouts ---------------------------------------------------------------------------------
// Presets name physical keys (KeyboardEvent.code), so "WASD" is the same four keys on QWERTY, QWERTZ and AZERTY
// (where they print Z Q S D). None of them touches a default shortcut key on any of the three layouts
// (test/controls.test.mjs), so picking one leaves the shortcuts where they are.
export const PRESETS = [
  // the classic default: D-pad on the arrows (right hand), buttons under the left hand
  // (the 3DS half tilt on C, next to A and B: held by the left hand while the right one walks)
  { id: 'arrows', keys: { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', a: 'KeyZ', b: 'KeyX', x: 'KeyA', y: 'KeyS', l: 'KeyQ', r: 'KeyE', start: 'Enter', select: 'KeyV', sneak: 'KeyC' } },
  // D-pad under the left hand, face buttons as the console has them (B left of A, Y left of X) under the right;
  // R stays off the R key (reset) – Q/E sit right next to WASD anyway; the 3DS half tilt on L, next to A, for the right
  // hand while the left one walks
  { id: 'wasd', keys: { up: 'KeyW', left: 'KeyA', down: 'KeyS', right: 'KeyD', b: 'KeyJ', a: 'KeyK', y: 'KeyU', x: 'KeyI', l: 'KeyQ', r: 'KeyE', start: 'Enter', select: 'Space', sneak: 'KeyL' } },
];

// What a layout prints on the keys where it differs from QWERTY – the fallback when the browser can't tell (no Keyboard Map API).
export const LAYOUTS = {
  qwerty: {},
  qwertz: { KeyY: 'z', KeyZ: 'y' },
  azerty: { KeyQ: 'a', KeyA: 'q', KeyW: 'z', KeyZ: 'w', KeyM: ',', Semicolon: 'm' },
};
const LANG_LAYOUT = { de: 'qwertz', fr: 'azerty' }; // es, it, en: QWERTY

const usChar = (code) => (/^Key[A-Z]$/.test(code) ? code[3].toLowerCase() : /^Digit\d$/.test(code) ? code[5] : undefined);
/** layout = { id, real, get(code) → printed character }; real = read from the system, not guessed. */
export function tableLayout(id) {
  const name = LAYOUTS[id] ? id : 'qwerty';
  return { id: name, real: false, get: (code) => LAYOUTS[name][code] ?? usChar(code) };
}
export const layoutForLang = (lang) => tableLayout(LANG_LAYOUT[String(lang || '').slice(0, 2).toLowerCase()]);

let current = tableLayout('qwerty');
export const currentLayout = () => current;

/** Use the system keyboard layout (Keyboard Map API: Chromium/Electron) or else guess it from the UI language. */
export async function detectLayout(lang) {
  if (!current.real) current = layoutForLang(lang ?? globalThis.navigator?.language);
  let nav = globalThis.navigator;
  try { if (globalThis.top && globalThis.top !== globalThis && globalThis.top.navigator) nav = globalThis.top.navigator; } catch { /* other origin */ }
  try {
    // only a top-level page may ask – from the emulator frame we ask the app window (same origin)
    const map = await Promise.race([nav?.keyboard?.getLayoutMap?.(), new Promise((r) => setTimeout(r, 500))]);
    if (map?.size) current = { id: 'system', real: true, get: (code) => map.get(code) };
  } catch { /* not allowed or not supported */ }
  return current;
}

const FIXED = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Enter: 13, NumpadEnter: 13, Space: 32, Backspace: 8,
  Delete: 46, Insert: 45, Home: 36, End: 35, PageUp: 33, PageDown: 34 };

/** Physical key → binding on a layout ({ keyCode, key, code }), or null if its keyCode can't be known in advance. */
export function keyFor(code, lay = current) {
  if (code in FIXED) return { keyCode: FIXED[code], key: code === 'Space' ? ' ' : code, code };
  let m = /^Numpad(\d)$/.exec(code);
  if (m) return { keyCode: 96 + Number(m[1]), key: m[1], code };
  m = /^F(\d{1,2})$/.exec(code);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return { keyCode: 111 + Number(m[1]), key: code, code };
  const ch = lay.get(code);
  m = /^Digit(\d)$/.exec(code);
  if (m) return { keyCode: 48 + Number(m[1]), key: ch || m[1], code }; // also on AZERTY, where the row prints & é " …
  // keyCode follows the printed letter (QWERTZ: the key left of X is Y = 89)
  if (ch && /^[a-z]$/i.test(ch)) return { keyCode: ch.toUpperCase().charCodeAt(0), key: ch.toLowerCase(), code };
  if (!/^Key[A-Z]$/.test(code)) return null;
  if (ch && /^[\x20-\x7e]$/.test(ch)) return null; // punctuation (AZERTY's M key prints ","): its keyCode differs per platform
  return { keyCode: code.charCodeAt(3), key: ch || code[3].toLowerCase(), code }; // non-Latin layouts: browsers use the US letter
}

/** A preset as bindings on a layout. */
export function presetMap(id, lay = current) {
  const p = PRESETS.find((x) => x.id === id) || PRESETS[0];
  return Object.fromEntries(BUTTONS.map((b) => [b.id, keyFor(p.keys[b.id], lay) || keyFor(p.keys[b.id], tableLayout('qwerty'))]));
}

/** Which preset the saved mapping is, on this layout – null = custom. No saved mapping = the default preset. */
export function activePreset(saved, lay = current) {
  if (!saved) return PRESETS[0].id;
  const m = resolve(saved, lay);
  return PRESETS.find((p) => { const pm = presetMap(p.id, lay); return BUTTONS.every((b) => m[b.id]?.keyCode === pm[b.id].keyCode); })?.id || null;
}

// A stored binding as it works on the layout in use: once the real layout is known, the physical key decides
// (keyCode follows the printed letter, so it changes with the layout). Guessed layouts keep the stored keyCode.
const live = (s, lay) => (s?.code && lay.real && keyFor(s.code, lay)) || s;

export function keyLabel(b, lay = current) {
  b = live(b, lay);
  const c = b?.keyCode;
  if (c == null) return '–';
  if (NAMED[c]) return NAMED[c];
  if (c >= 96 && c <= 105) return `Num ${c - 96}`; // (the number pad's digits print as the row's – told apart here)
  if (b.key && b.key.length === 1 && b.key !== ' ') return b.key.toUpperCase();
  if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90)) return String.fromCharCode(c);
  if (c >= 96 && c <= 105) return `Num ${c - 96}`;
  if (c >= 112 && c <= 123) return `F${c - 111}`;
  return b.key || `#${c}`;
}

/** The default mapping (first preset) on a layout – on QWERTZ the A button is the key printed Y, left of X. */
export const defaults = (lay = current) => presetMap(PRESETS[0].id, lay);

/** A binding the player switched off ("none") – stored as { none: true }, so it doesn't fall back to the default. */
export const NONE = Object.freeze({ none: true });
const isNone = (s) => !!s && typeof s === 'object' && s.none === true;

const storedKey = (s) => !!s && typeof s === 'object' && Number.isInteger(s.keyCode);

/**
 * Whose defaults a stored mapping falls back on: the preset all its joypad buttons are – a mapping saved before a button
 * existed (2.8.2 had no 3DS half tilt) gets that button's key from the preset the player picked – else the first one.
 */
function fallbackPreset(saved, lay) {
  const joy = BUTTONS.filter(isJoypad);
  if (!joy.every((b) => storedKey(saved?.[b.id]) || isNone(saved?.[b.id]))) return PRESETS[0].id;
  return PRESETS.find((p) => {
    const pm = presetMap(p.id, lay);
    return joy.every((b) => storedKey(saved[b.id]) && live(saved[b.id], lay).keyCode === pm[b.id].keyCode);
  })?.id || PRESETS[0].id;
}

/**
 * Stored mapping → complete, valid mapping (unknown, unbindable or doubled keys fall back to the default; a button the
 * player left without a key – { none: true } – stays null). The game buttons may have any key a shortcut has by
 * default: the shortcut then gives way (resolveHotkeys). The 3DS half tilt (new in 2.8.3) never takes a key the player
 * gave a shortcut by default – it has no key then, instead of quietly taking the player's one (a joypad button's
 * default still does, as it always did).
 */
export function resolve(saved, lay = current) {
  const out = {};
  const used = new Set();
  const def = presetMap(fallbackPreset(saved, lay), lay);
  // the plain keys the player gave shortcuts (one with modifiers doesn't clash with a game button's key)
  const chosen = new Set(HOTKEYS.flatMap((h) => (Array.isArray(saved?.[h.id]) ? saved[h.id] : [saved?.[h.id]]))
    .filter((c) => storedKey(c) && !c.mod && !MODS.some((m) => c[m])).map((c) => live(c, lay).keyCode));
  for (const b of BUTTONS) {
    if (isNone(saved?.[b.id])) {
      out[b.id] = null;
      continue;
    }
    const s = live(saved?.[b.id], lay);
    let v = s && Number.isInteger(s.keyCode) && bindable(s.keyCode) && !used.has(s.keyCode) ? s : null;
    if (!v && !used.has(def[b.id].keyCode) && (isJoypad(b) || !chosen.has(def[b.id].keyCode))) v = def[b.id];
    if (v) used.add(v.keyCode);
    out[b.id] = v ? { keyCode: v.keyCode, key: v.key || '', ...(v.code ? { code: v.code } : {}) } : null;
  }
  return out;
}

/**
 * Stored mapping → { keyCode: button } – how the native players (lib/nativeplayer.mjs, lib/ctrplayer.mjs) read keys: the
 * joypad buttons (the 3DS player reads the half tilt's key itself, resolve().sneak).
 */
export function keyButtons(saved, lay = current) {
  const m = resolve(saved, lay);
  return Object.fromEntries(BUTTONS.filter((b) => isJoypad(b) && m[b.id]).map((b) => [m[b.id].keyCode, b.id]));
}

/** EmulatorJS controls table (EJS_defaultControls): the 12 game buttons on keyboard and controller. */
export function ejsControls(saved, lay = current, pads = null) {
  const m = resolve(saved, lay);
  const pm = padMap(pads);
  const p1 = {};
  for (const b of BUTTONS.filter(isJoypad)) p1[b.ejs] = { value: m[b.id]?.keyCode ?? -1, value2: pm[b.id] || '' };
  return { 0: p1, 1: {}, 2: {}, 3: {} };
}

// ---- shortcuts while playing --------------------------------------------------------------------------------------
// Every key the play view acts on while a game runs (web/views/play.mjs onKey – the player pages only forward the keys).
// Each one can be re-bound in Settings › Controls or switched off, and a game button may take any of their keys: the
// shortcut then gives way (it has no key, or the player gives it another). A player's "I have used R for B for ten
// years, now it is locked for reset" (Discord) – nothing is locked any more.
// Stored next to the game buttons: config.controls[id] = a key { keyCode, key, code?, shift?, ctrl?, alt?, meta? }, a
// list of them, or { none: true } (switched off); nothing stored = the default. In the defaults `mod` is ⌘ on a Mac,
// Ctrl elsewhere. Some defaults have more than one key (1 and Num 1, + and Num +) – a key taken by something else drops
// out of the list. On a controller config.pads.map[id] = a button label (PAD_HOTKEY_DEFAULTS below).
const K = (keyCode, key, code, mods = {}) => ({ keyCode, key, ...(code ? { code } : {}), ...mods });
const SLOTS = [1, 2, 3, 4];
export const HOTKEYS = [
  // as in mGBA: hold Tab = fast-forward while it is held, Shift+Tab = on / off – at the turbo speed picked last
  { id: 'ffHold', keys: [K(9, 'Tab', 'Tab')] },
  { id: 'ffToggle', keys: [K(9, 'Tab', 'Tab', { shift: true })] },
  { id: 'turbo', keys: [K(84, 't')] }, // 2× → 3× → 4× → 1×
  { id: 'faster', keys: [K(187, '+', null, { mod: true })] }, // (the desktop app's menu shows these with ⌘ / Ctrl)
  { id: 'slower', keys: [K(189, '-', null, { mod: true })] },
  { id: 'pause', keys: [K(80, 'p')] },
  { id: 'reset', keys: [K(82, 'r')] }, // asks first – and the play bar's reset button is always there
  { id: 'quicksave', keys: [K(116, 'F5', 'F5')] }, // the selected slot
  { id: 'quickload', keys: [K(119, 'F8', 'F8')] },
  ...SLOTS.map((n) => ({ id: `save${n}`, slot: n, keys: [K(48 + n, String(n), `Digit${n}`, { shift: true })] })),
  ...SLOTS.map((n) => ({ id: `load${n}`, slot: n, keys: [K(48 + n, String(n), `Digit${n}`), K(96 + n, String(n), `Numpad${n}`)] })),
  { id: 'screenshot', keys: [K(123, 'F12', 'F12')] },
  { id: 'mute', keys: [K(77, 'm')] },
  // "+" is Shift+= on US keyboards and a key of its own on German ones (both keyCode 187)
  { id: 'louder', keys: [K(187, '+'), K(187, '+', null, { shift: true }), K(107, '+', 'NumpadAdd')] },
  { id: 'quieter', keys: [K(189, '-'), K(109, '-', 'NumpadSubtract')] },
  { id: 'fullscreen', keys: [K(70, 'f')] },
];
export const HOTKEY_IDS = HOTKEYS.map((h) => h.id);
/**
 * The shortcut rows of Settings › Controls and Help, in this order: one per shortcut, the four save and the four load
 * slots in a row each. Every shortcut has its row (test/shortcuts.test.mjs) – none can be unchangeable.
 */
export const HOTKEY_ROWS = [
  ...['ffHold', 'ffToggle', 'turbo', 'faster', 'slower', 'pause', 'quicksave', 'quickload'].map((id) => ({ id, ids: [id] })),
  { id: 'save', ids: SLOTS.map((n) => `save${n}`) },
  { id: 'load', ids: SLOTS.map((n) => `load${n}`) },
  ...['screenshot', 'mute', 'louder', 'quieter', 'fullscreen', 'reset'].map((id) => ({ id, ids: [id] })),
];
export const isHotkeyId = (id) => HOTKEY_IDS.includes(id);
const TAB = 9;
const MODS = ['shift', 'ctrl', 'alt', 'meta'];

/** Is this a Mac (⌘ instead of Ctrl)? The desktop app says it, a browser's navigator otherwise. */
export function isMac(env = globalThis) {
  if (env.sls?.platform) return env.sls.platform === 'darwin';
  const nav = env.navigator;
  return /mac|iphone|ipad/i.test(`${nav?.userAgentData?.platform || ''} ${nav?.platform || ''} ${nav?.userAgent || ''}`);
}

/** Can a shortcut sit on this key (with or without modifiers)? Tab, or any key a game button could have. */
export const hotkeyBindable = (keyCode) => keyCode === TAB || bindable(keyCode);

/** A key with modifiers as stored ({ mod } → ⌘ / Ctrl), normalized: { keyCode, key, code?, shift?, ctrl?, alt?, meta? }. */
export function combo(c, mac = isMac()) {
  const out = { keyCode: c.keyCode, key: c.key || '', ...(c.code ? { code: c.code } : {}) };
  if (c.shift) out.shift = true;
  if (c.ctrl || (c.mod && !mac)) out.ctrl = true;
  if (c.alt) out.alt = true;
  if (c.meta || (c.mod && mac)) out.meta = true;
  return out;
}
/** No modifier at all – the only kind of key a game button can have. */
export const plainCombo = (c) => !!c && !MODS.some((m) => c[m]);
/** The same key with the same modifiers (Tab and Shift+Tab are two shortcuts). */
export const sameCombo = (a, b) => !!a && !!b && a.keyCode === b.keyCode && MODS.every((m) => !!a[m] === !!b[m]);

// What the system or souldew's own menu does with a combo – refused for the shortcuts (Settings › Controls says why).
// mac: ⌘Q / ⌘W / ⌘H / ⌘M / ⌘Tab / ⌘Space …; Windows and Linux: Alt+F4, Alt+Tab, Ctrl+Alt+Del, Ctrl+Esc, the Windows /
// Super key … – and the app menu's own (⌘, settings, ⌘1–5, ⌘O, ⌘B, ⌘/, the edit menu's ⌘Z / X / C / V / A, fullscreen) and
// the play view's ⌘I (the dock).
const L = (ch) => ch.toUpperCase().charCodeAt(0);
const SYS_MAC = [
  [{ meta: 1 }, [L('q'), L('w'), L('h'), L('m'), TAB, 32, 192]], // quit, close, hide, minimize, app switcher, Spotlight, window switcher
  [{ meta: 1, alt: 1 }, [L('h'), 27, L('d')]], // hide others, force quit, Dock
  [{ meta: 1, shift: 1 }, [L('q'), 51, 52, 53]], // log out, screenshots ⌘⇧3 / 4 / 5
  [{ meta: 1, ctrl: 1 }, [L('q'), L('f'), 32]], // lock screen, fullscreen, emoji
  [{ ctrl: 1 }, [37, 38, 39, 40, 32]], // Mission Control / Spaces, input source
];
const SYS_PC = [
  [{ alt: 1 }, [115, TAB, 27, 32]], // Alt+F4, Alt+Tab, Alt+Esc, Alt+Space (window menu)
  [{ ctrl: 1 }, [27]], // Start menu
  [{ ctrl: 1, alt: 1 }, [46, L('t'), 37, 38, 39, 40]], // Ctrl+Alt+Del, terminal / workspaces (Linux)
  [{ ctrl: 1, shift: 1 }, [27]], // Task Manager
  [{ alt: 1, shift: 1 }, [TAB]],
];
const MENU = (mac) => [
  // (⌘I / Ctrl+I: the play view's dock – views/play.mjs folds it before any shortcut sees the key)
  [{ [mac ? 'meta' : 'ctrl']: 1 }, [188, 49, 50, 51, 52, 53, L('o'), L('b'), L('i'), 191, L('z'), L('x'), L('c'), L('v'), L('a'), L('q'), L('w'), ...(mac ? [] : [L('y')])]],
  [{ [mac ? 'meta' : 'ctrl']: 1, shift: 1 }, [L('z')]],
  ...(mac ? [] : [[{}, [122]]]), // F11: fullscreen (Windows, Linux)
];
const listed = (list, c) => list.some(([m, keys]) => keys.includes(c.keyCode) && MODS.every((k) => !!m[k] === !!c[k]));
/**
 * Why a combo can't be a shortcut: 'system' (the system's own – ⌘Q, Alt+F4, any Windows-key combo …), 'menu' (souldew's
 * menu has it) or null = free.
 */
export function reservedCombo(c, mac = isMac()) {
  if (!c) return null;
  if (!mac && c.meta) return 'system'; // the Windows / Super key belongs to the system
  if (listed(mac ? SYS_MAC : SYS_PC, c)) return 'system';
  if (listed(MENU(mac), c)) return 'menu';
  return null;
}

// a stored key (or list of keys) as it works on the layout in use, with its modifiers
const stored = (s, lay, mac) => (Array.isArray(s) ? s : s && typeof s === 'object' ? [s] : [])
  .filter((x) => x && typeof x === 'object' && Number.isInteger(x.keyCode))
  .map((x) => combo({ ...x, ...live(x, lay) }, mac));

/**
 * Stored mapping → every shortcut's keys, { [id]: [{ keyCode, key, code?, shift?, ctrl?, alt?, meta? }, …] } – an empty
 * list = no key. The game buttons come first: a key one of them has (without modifiers) is no shortcut's. A key no
 * shortcut may have, a reserved combo or one an earlier shortcut has drops out; nothing usable stored = the default
 * (its keys that are still free). { none: true } = switched off.
 */
export function resolveHotkeys(saved, lay = current, mac = isMac()) {
  // (a game button's key is a combo without modifiers – Shift+R stays free for a shortcut while R is the B button)
  const taken = Object.values(resolve(saved, lay)).filter(Boolean).map((v) => ({ keyCode: v.keyCode }));
  const take = (list) => {
    const out = list.filter((c) => hotkeyBindable(c.keyCode) && !reservedCombo(c, mac) && !taken.some((x) => sameCombo(x, c)) && taken.push(c));
    return out;
  };
  const out = {};
  // what the player set comes first, then the defaults of the rest – a default never pushes a chosen key out
  for (const h of HOTKEYS) {
    const s = saved?.[h.id];
    if (isNone(s)) out[h.id] = [];
    else {
      const mine = take(stored(s, lay, mac));
      if (mine.length) out[h.id] = mine;
    }
  }
  for (const h of HOTKEYS) if (!out[h.id]) out[h.id] = take(h.keys.map((k) => combo(k, mac)));
  return Object.fromEntries(HOTKEYS.map((h) => [h.id, out[h.id]]));
}

/**
 * The keys the player set for a shortcut that it can't have here – one souldew's menu or the system has (a 2.8.1
 * fast-forward key on F11, Windows / Linux fullscreen) – while it plays on another key now: [{ id, key, why }] (why:
 * 'menu' / 'system'). Settings › Controls says so under the row, instead of the key quietly going back to Tab.
 */
export function refusedHotkeys(saved, lay = current, mac = isMac()) {
  const out = [];
  for (const h of HOTKEYS) {
    const s = saved?.[h.id];
    if (!s || isNone(s)) continue;
    const keys = stored(s, lay, mac);
    const bad = keys.filter((c) => hotkeyBindable(c.keyCode) && reservedCombo(c, mac));
    // (only when none of its own keys is left: one that still works is no surprise)
    if (bad.length && bad.length === keys.length) out.push({ id: h.id, key: bad[0], why: reservedCombo(bad[0], mac) });
  }
  return out;
}

/** The default keys of a shortcut (combos for this computer). */
export const hotkeyDefaults = (id, mac = isMac()) => (HOTKEYS.find((h) => h.id === id)?.keys || []).map((k) => combo(k, mac));

/** Is this key event ({ keyCode?, code?, key? }) on the binding's key – modifiers aside? The physical key when both know it. */
export function keyMatches(e, b) {
  if (!b || !e) return false;
  if (Array.isArray(b)) return b.some((x) => keyMatches(e, x));
  if (e.code && b.code) return e.code === b.code;
  const code = Number.isInteger(e.keyCode) && e.keyCode ? e.keyCode : e.key === 'Tab' ? TAB : null;
  return code === b.keyCode;
}

// a DOM KeyboardEvent or what the player pages forward ({ shift, ctrl, alt, meta }) – the same modifiers either way
const modsOf = (e) => ({ shift: !!(e.shift ?? e.shiftKey), ctrl: !!(e.ctrl ?? e.ctrlKey), alt: !!(e.alt ?? e.altKey), meta: !!(e.meta ?? e.metaKey) });
/** This key press exactly: the key and every modifier as bound. */
export const comboMatches = (e, c) => !!e && !!c && keyMatches(e, c) && (({ shift, ctrl, alt, meta }) => shift === !!c.shift && ctrl === !!c.ctrl && alt === !!c.alt && meta === !!c.meta)(modsOf(e));

/** Which shortcut a key press is (a DOM event or a forwarded { keyCode, code, key, shift, ctrl, alt, meta }) – else null. */
export function hotkeyOf(e, hot) {
  return HOTKEYS.find((h) => (hot?.[h.id] || []).some((c) => comboMatches(e, c)))?.id || null;
}

/**
 * Does a player page keep this key press to itself? A shortcut's exact combo: Tab doesn't move the focus out of the
 * game while it is the fast-forward key, Ctrl+R doesn't reload the page when it is the reset key – and the game never
 * sees it (Shift+R as reset while R is the B button). Every other key goes on as before.
 */
export const isHotkeyKey = (e, hot) => !!hotkeyOf(e, hot);

/**
 * A binding as an Electron menu accelerator (only shown next to the menu entry – the play view handles the key):
 * 'Shift+Tab', 'Cmd+Plus', 'Ctrl+R', 'F5' … – or null when there is no way to write it.
 */
export function accelerator(c) {
  if (!c) return null;
  const NAMES = { 9: 'Tab', 13: 'Return', 32: 'Space', 8: 'Backspace', 46: 'Delete', 45: 'Insert', 36: 'Home', 35: 'End', 33: 'PageUp', 34: 'PageDown',
    37: 'Left', 38: 'Up', 39: 'Right', 40: 'Down', 186: ';', 187: c.key === '=' ? '=' : 'Plus', 188: ',', 189: '-', 190: '.', 191: '/', 192: '`', 219: '[', 220: '\\', 221: ']', 222: '\'',
    106: 'nummult', 107: 'numadd', 109: 'numsub', 110: 'numdec', 111: 'numdiv' };
  const k = c.keyCode;
  const key = NAMES[k] || (k >= 65 && k <= 90 ? String.fromCharCode(k) : k >= 48 && k <= 57 ? String.fromCharCode(k) : k >= 96 && k <= 105 ? `num${k - 96}`
    : k >= 112 && k <= 123 ? `F${k - 111}` : null);
  if (!key) return null;
  return [c.meta && 'Cmd', c.ctrl && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift', key].filter(Boolean).join('+');
}

// ---- changing a binding (Settings › Controls and › Controller) -------------------------------------------------------
/**
 * Every binding in one table: { [id]: [keys] } – a game button has one key or none, a shortcut a list (resolveHotkeys).
 * With `pads` the same for the controller: { [id]: [label] } (padMap + padHotkeys).
 */
export function bindingTable(saved, lay = current, mac = isMac()) {
  const m = resolve(saved, lay);
  return { ...Object.fromEntries(BUTTONS.map((b) => [b.id, m[b.id] ? [m[b.id]] : []])), ...resolveHotkeys(saved, lay, mac) };
}

const plainKey = (k) => (k ? { keyCode: k.keyCode, key: k.key || '', ...(k.code ? { code: k.code } : {}) } : k);
const isButton = (id) => BUTTONS.some((b) => b.id === id);

/**
 * Give `id` the key `k` (a game button or a shortcut, keyboard): it takes the key over – whatever else had it gives it
 * up and is left without that key (none at all, or its other keys). Returns { next, lost, swap }: the new stored mapping,
 * which bindings lost a key ([{ id, key, left }] – left: the keys they still have), and – when exactly one lost its only
 * key – the mapping with the two keys swapped instead (null when the old key can't go there).
 */
export function assignKey(saved, id, k, lay = current, mac = isMac()) {
  const before = bindingTable(saved, lay, mac);
  const key = isButton(id) ? plainKey(k) : combo(k, mac);
  const hits = (x) => sameCombo(x, key); // (a game button's key has no modifiers)
  const lost = [];
  // the game buttons are stored all together once one of them changes (the default preset is "nothing stored" otherwise)
  const next = { ...(saved || {}) };
  const materialize = () => {
    const m = resolve(saved, lay);
    for (const b of BUTTONS) if (!(b.id in next) || next[b.id] == null) next[b.id] = m[b.id] || NONE;
  };
  for (const [other, keys] of Object.entries(before)) {
    if (other === id || !keys.some(hits)) continue;
    const left = keys.filter((x) => !hits(x));
    lost.push({ id: other, key: keys.find(hits), left });
    if (isButton(other)) {
      materialize();
      next[other] = NONE;
    } else next[other] = left.length ? left : NONE;
  }
  if (isButton(id)) {
    materialize();
    next[id] = key;
  } else next[id] = key;
  // one binding lost its only key: it may take the old key of `id` instead (when that one fits it)
  let swap = null;
  const old = before[id]?.[0];
  if (lost.length === 1 && !lost[0].left.length && old) {
    const o = lost[0].id;
    if (isButton(o) ? plainCombo(old) && bindable(old.keyCode) : true) swap = { ...next, [o]: isButton(o) ? plainKey(old) : old };
  }
  return { next, lost, swap };
}

/** Switch a shortcut off (Settings › Controls "no key"). */
export const clearKey = (saved, id) => ({ ...(saved || {}), [id]: NONE });

/**
 * What changed for the other bindings between two stored mappings (a preset picked, a key taken over): [{ id, before,
 * after }] with their keys – for the note under the table ("Reset has no key now").
 */
export function changedBindings(a, b, skip = null, lay = current, mac = isMac()) {
  const x = bindingTable(a, lay, mac);
  const y = bindingTable(b, lay, mac);
  const sig = (l) => l.map((c) => [c.keyCode, ...MODS.map((m) => (c[m] ? 1 : 0))].join('.')).join(',');
  return Object.keys(x).filter((id) => id !== skip && sig(x[id]) !== sig(y[id])).map((id) => ({ id, before: x[id], after: y[id] }));
}

// ---- controllers ------------------------------------------------------------------------------------------------
// The browser reports every controller in the "standard" layout (Gamepad API): button 0 is the bottom face button,
// 1 the right, 2 the left, 3 the top – whatever is printed on them. EmulatorJS names them BUTTON_1 … BUTTON_4.
// config.pads = { preset: 'nintendo'|'xbox', map?: { [button]: label } } – map holds what the player re-bound.
export const PAD_LABELS = ['BUTTON_1', 'BUTTON_2', 'BUTTON_3', 'BUTTON_4', 'LEFT_TOP_SHOULDER', 'RIGHT_TOP_SHOULDER',
  'LEFT_BOTTOM_SHOULDER', 'RIGHT_BOTTOM_SHOULDER', 'SELECT', 'START', 'LEFT_STICK', 'RIGHT_STICK', 'DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT'];
// (the 3DS half tilt has no button unless the player picks one: the stick already tilts part of the way)
const SHARED_PAD = { up: 'DPAD_UP', down: 'DPAD_DOWN', left: 'DPAD_LEFT', right: 'DPAD_RIGHT', l: 'LEFT_TOP_SHOULDER', r: 'RIGHT_TOP_SHOULDER', start: 'START', select: 'SELECT', sneak: '' };
export const PAD_PRESETS = [
  // where the buttons sit on a Game Boy Advance / DS: A right, B bottom, X top, Y left
  { id: 'nintendo', map: { ...SHARED_PAD, a: 'BUTTON_2', b: 'BUTTON_1', x: 'BUTTON_4', y: 'BUTTON_3' } },
  // what an Xbox pad prints: A bottom, B right, X left, Y top
  { id: 'xbox', map: { ...SHARED_PAD, a: 'BUTTON_1', b: 'BUTTON_2', x: 'BUTTON_3', y: 'BUTTON_4' } },
];
/**
 * The shortcuts a controller button can have, with their default buttons ('' = none): ZR / RT / R2 steps the turbo,
 * ZL / LT / L2 pauses, fast-forward has no button unless the player picks one. All of them can be re-bound or switched
 * off, and a game button may take their buttons – Home (not in PAD_LABELS) always pauses, so the game can always be
 * stopped.
 */
export const PAD_HOTKEY_DEFAULTS = { ffHold: '', ffToggle: '', turbo: 'RIGHT_BOTTOM_SHOULDER', pause: 'LEFT_BOTTOM_SHOULDER' };
export const PAD_HOTKEY_IDS = Object.keys(PAD_HOTKEY_DEFAULTS);
/** A controller binding the player switched off (config.pads.map[id] = 'NONE'). */
export const PAD_NONE = 'NONE';
const HOME = 16;

/** Saved controller settings → complete label per game button (a doubled or unknown label falls back to the preset; '' = none). */
export function padMap(pads) {
  const preset = PAD_PRESETS.find((p) => p.id === pads?.preset) || PAD_PRESETS[0];
  const out = {};
  const used = new Set();
  for (const b of BUTTONS) {
    const want = pads?.map?.[b.id];
    if (want === PAD_NONE) {
      out[b.id] = '';
      continue;
    }
    const v = PAD_LABELS.includes(want) && !used.has(want) ? want : preset.map[b.id];
    out[b.id] = used.has(v) ? '' : v;
    if (v) used.add(v);
  }
  return out;
}

/**
 * Saved controller settings → the shortcuts' buttons, { ffHold, ffToggle, turbo, pause }: a label, or '' (none). Never
 * a game button's or another shortcut's; a button picked by the player comes before another shortcut's default.
 */
export function padHotkeys(pads) {
  const used = new Set(Object.values(padMap(pads)).filter(Boolean));
  const out = {};
  const take = (v) => (PAD_LABELS.includes(v) && !used.has(v) ? (used.add(v), v) : '');
  for (const id of PAD_HOTKEY_IDS) {
    const want = pads?.map?.[id];
    if (want === PAD_NONE) out[id] = '';
    else if (take(want)) out[id] = want;
  }
  for (const id of PAD_HOTKEY_IDS) if (!(id in out)) out[id] = take(PAD_HOTKEY_DEFAULTS[id]);
  return Object.fromEntries(PAD_HOTKEY_IDS.map((id) => [id, out[id]]));
}

/**
 * The controller buttons a player page hands to the play view, by their standard index → action: the shortcuts'
 * buttons (by default ZR / RT / R2 steps the turbo, ZL / LT / L2 pauses; ffHold: pressed and released, the others:
 * pressed) – and Home (16), which always pauses.
 */
export function padActions(pads) {
  const out = { [HOME]: 'pause' };
  for (const [id, label] of Object.entries(padHotkeys(pads))) if (label) out[PAD_LABELS.indexOf(label)] = id;
  return out;
}

/**
 * Controller version of assignKey: give `id` (a game button or a shortcut) the button `label`. Whatever had it is left
 * without a button; returns { next (config.pads), lost: [{ id, label }], swap } – swap: the two buttons swapped instead.
 */
export function assignPad(pads, id, label) {
  const all = { ...padMap(pads), ...padHotkeys(pads) };
  const map = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v || PAD_NONE]));
  const lost = Object.keys(all).filter((o) => o !== id && all[o] === label).map((o) => ({ id: o, label }));
  for (const l of lost) map[l.id] = PAD_NONE;
  const old = all[id];
  map[id] = label;
  const keep = { preset: (PAD_PRESETS.find((p) => p.id === pads?.preset) || PAD_PRESETS[0]).id, ...(pads?.device ? { device: pads.device } : {}) };
  const tidy = (m) => Object.fromEntries(Object.entries(m).filter(([k, v]) => !(v === PAD_NONE && (PAD_HOTKEY_DEFAULTS[k] === '' || SHARED_PAD[k] === ''))));
  const next = { ...keep, map: tidy(map) };
  const swap = lost.length === 1 && old ? { ...keep, map: tidy({ ...map, [lost[0].id]: old }) } : null;
  return { next, lost, swap };
}

/**
 * One poll of those buttons (`held`: what was down at the last poll, updated here) → the messages for the play view,
 * { type: 'emu-pad', action, down }: a press of each, and the release of the fast-forward hold. While the app's menus
 * have the controller (appHasPad) only pause and turbo go through – ZL / Home still resume the game.
 */
export function padHotkeyPresses(pad, actions, held, appHas = false) {
  const out = [];
  for (const [i, action] of Object.entries(actions)) {
    const on = !!pad?.buttons?.[i]?.pressed;
    if (on && !held[i] && !(appHas && (action === 'ffHold' || action === 'ffToggle'))) out.push({ type: 'emu-pad', action, down: true });
    else if (!on && held[i] && action === 'ffHold') out.push({ type: 'emu-pad', action, down: false });
    held[i] = on;
  }
  return out;
}

/**
 * Diagnostics of a player page's controller: the device that plays and the last presses – which standard button (index,
 * label) came in, which game buttons it was mapped to and whether the app's menus had the controller then. A player's
 * "the remapping doesn't apply in game" (Discord, Windows, a DualSense and an Xbox pad) is otherwise invisible.
 */
export function padRecorder(max = 40) {
  const presses = [];
  let last = [];
  let picked = null;
  return {
    /** Every poll: the picked device (or null) and what the page made of it. */
    see(pad, map, appHas = false) {
      if (!pad) {
        picked = null;
        last = [];
        return;
      }
      if (picked?.id !== pad.id || picked?.index !== pad.index) {
        picked = { id: String(pad.id).slice(0, 120), index: pad.index, mapping: pad.mapping || '', buttons: pad.buttons.length, axes: pad.axes.length };
      }
      pad.buttons.forEach((b, i) => {
        const on = !!b.pressed;
        if (on && !last[i]) {
          const label = PAD_LABELS[i] ?? null;
          presses.push({ t: Math.round(performance.now()), i, label, game: Object.keys(map).filter((k) => map[k] === label), app: !!appHas });
          if (presses.length > max) presses.shift();
        }
        last[i] = on;
      });
    },
    info: (cfg, map) => ({ cfg: cfg || null, map, picked, presses: presses.slice() }),
  };
}

/** Which kind of controller, from the id the browser reports (vendor ids: 054c Sony, 045e Microsoft, 057e Nintendo). */
export function padFamily(id = '') {
  const s = String(id).toLowerCase();
  // vendor ids first (exact), then names – "Wireless Controller" alone is Sony's name, but Xbox pads say it too
  if (/vendor: 054c|054c-/.test(s)) return 'playstation';
  if (/vendor: 045e|045e-/.test(s)) return 'xbox';
  if (/vendor: 057e|057e-/.test(s)) return 'switch';
  if (/xbox|xinput/.test(s)) return 'xbox';
  if (/dualsense|dualshock|playstation|^wireless controller/.test(s)) return 'playstation';
  if (/pro controller|joy-con|nintendo|switch/.test(s)) return 'switch';
  return 'generic';
}

// What is printed on each standard button, per family (Switch: B bottom, A right, Y left, X top).
const PAD_PRINT = {
  playstation: { BUTTON_1: '✕', BUTTON_2: '○', BUTTON_3: '□', BUTTON_4: '△', LEFT_TOP_SHOULDER: 'L1', RIGHT_TOP_SHOULDER: 'R1', LEFT_BOTTOM_SHOULDER: 'L2', RIGHT_BOTTOM_SHOULDER: 'R2', SELECT: 'Create', START: 'Options', LEFT_STICK: 'L3', RIGHT_STICK: 'R3' },
  xbox: { BUTTON_1: 'A', BUTTON_2: 'B', BUTTON_3: 'X', BUTTON_4: 'Y', LEFT_TOP_SHOULDER: 'LB', RIGHT_TOP_SHOULDER: 'RB', LEFT_BOTTOM_SHOULDER: 'LT', RIGHT_BOTTOM_SHOULDER: 'RT', SELECT: 'View', START: 'Menu', LEFT_STICK: 'LS', RIGHT_STICK: 'RS' },
  switch: { BUTTON_1: 'B', BUTTON_2: 'A', BUTTON_3: 'Y', BUTTON_4: 'X', LEFT_TOP_SHOULDER: 'L', RIGHT_TOP_SHOULDER: 'R', LEFT_BOTTOM_SHOULDER: 'ZL', RIGHT_BOTTOM_SHOULDER: 'ZR', SELECT: '−', START: '+', LEFT_STICK: 'L3', RIGHT_STICK: 'R3' },
  generic: { BUTTON_1: '⬇', BUTTON_2: '➡', BUTTON_3: '⬅', BUTTON_4: '⬆', LEFT_TOP_SHOULDER: 'L1', RIGHT_TOP_SHOULDER: 'R1', LEFT_BOTTOM_SHOULDER: 'L2', RIGHT_BOTTOM_SHOULDER: 'R2', SELECT: 'Select', START: 'Start', LEFT_STICK: 'L3', RIGHT_STICK: 'R3' },
};
const DPAD_PRINT = { DPAD_UP: '↑', DPAD_DOWN: '↓', DPAD_LEFT: '←', DPAD_RIGHT: '→' };
/** names: the page's localized words for buttons without a print (generic pads: "bottom button" …). */
export const padLabel = (label, family = 'generic', names = {}) => (label
  ? DPAD_PRINT[label] || (family === 'generic' && names[label]) || PAD_PRINT[family]?.[label] || PAD_PRINT.generic[label] || label : '–');

// ---- which connected device plays ---------------------------------------------------------------------------------
// The Gamepad API lists more than controllers: on Windows a USB microphone or headset with its own buttons (a player's
// "DGM20 USB Microphone", issue #2) shows up as a gamepad too – often before the real one, which then never got to
// play. So souldew picks the controller itself: the one chosen in Settings › Controller (config.pads.device, the id
// the browser reports, remembered across starts) when it is connected, else the most controller-like device. A device
// that doesn't look like a controller at all is never picked on its own – only when the player chooses it.

/** Names of devices that are no controllers (audio, cameras, keyboards, mice …) – unless they report a standard layout. */
const NOT_A_PAD = /\b(mic|mics|microphone|headset|headphones?|earphones?|earbuds?|speakers?|audio|sound|webcam|camera|keyboard|mouse|dac|yeti|quadcast|stream ?deck)\b/i;

const count = (x) => (Array.isArray(x) || (x && typeof x === 'object' && Number.isInteger(x.length)) ? x.length : Number(x) || 0);
const isStandard = (p) => p?.mapping === 'standard' || p?.standard === true;

/** A device's id without what changes from start to start – what config.pads.device stores. */
export const padKey = (id) => String(id || '').trim().slice(0, 200);

/**
 * How much a device looks like a game controller: -1 = not one (a microphone, headset or anything with fewer than
 * four buttons), else higher = more likely (standard layout, a known make, enough buttons and a stick).
 * `p`: a Gamepad from navigator.getGamepads() or { id, mapping | standard, buttons, axes } (arrays or counts).
 */
export function padScore(p) {
  if (!p) return -1;
  const standard = isStandard(p);
  const buttons = count(p.buttons);
  const axes = count(p.axes);
  if (!standard && (buttons < 4 || NOT_A_PAD.test(String(p.id || '')))) return -1;
  return (standard ? 8 : 0) + (padFamily(p.id) !== 'generic' ? 4 : 0) + (buttons >= 10 ? 2 : 0) + (axes >= 2 ? 1 : 0);
}

export const looksLikePad = (p) => padScore(p) >= 0;

/**
 * The connected device that plays: the remembered one (`wanted` = config.pads.device) if it is there – the player
 * chose it, whatever it looks like – else the most controller-like one (the lowest index among equals), or null when
 * nothing connected looks like a controller.
 */
export function pickPad(pads, wanted = null) {
  const list = [...(pads || [])].filter((p) => p && p.connected !== false);
  const key = wanted ? padKey(wanted) : '';
  const mine = key && list.find((p) => padKey(p.id) === key);
  if (mine) return mine;
  let best = null;
  let bestScore = -1;
  for (const p of list) {
    const s = padScore(p);
    if (s > bestScore || (s === bestScore && s >= 0 && p.index < best.index)) [best, bestScore] = [p, s];
  }
  return bestScore >= 0 ? best : null;
}

// ---- the app's own screens ----------------------------------------------------------------------------------------
/**
 * Does the app use the controller right now (web/lib/padnav.mjs: the game is paused, in the corner or a menu is open
 * over it)? The game frames ask with their own window and then ignore the game buttons – never the turbo / pause
 * hotkeys, so ZL / Home still resume the game. False outside the app (a frame of its own, another origin).
 */
export function appHasPad(win = globalThis) {
  try {
    return win.parent !== win && !!win.parent?.__souldewPad?.mute;
  } catch {
    return false;
  }
}
