import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUTTONS, PRESETS, resolveHotkeys, bindable, detectLayout, currentLayout, tableLayout, layoutForLang, keyFor, presetMap, activePreset, resolve, keyLabel, ejsControls, defaults }
  from '../web/lib/controls.mjs';

const QWERTY = tableLayout('qwerty');
const QWERTZ = tableLayout('qwertz');
const AZERTY = tableLayout('azerty');
const LAYOUTS = { QWERTY, QWERTZ, AZERTY };
// what the Keyboard Map API would report for a real German keyboard
const realQwertz = { id: 'system', real: true, get: (c) => QWERTZ.get(c) };
const labels = (m, lay) => BUTTONS.map((b) => keyLabel(m[b.id], lay)).join(' ');

test('every preset binds all 12 buttons, distinct, bindable and never on a default shortcut – on every layout', () => {
  for (const p of PRESETS) {
    assert.deepEqual(Object.keys(p.keys).sort(), BUTTONS.map((b) => b.id).sort(), p.id);
    for (const [name, lay] of Object.entries(LAYOUTS)) {
      const m = presetMap(p.id, lay);
      const codes = BUTTONS.map((b) => m[b.id].keyCode);
      assert.equal(new Set(codes).size, codes.length, `${p.id} on ${name}: doubled key`);
      for (const c of codes) {
        assert.ok(bindable(c), `${p.id} on ${name}: ${c} not bindable`);
      }
      // picking a preset leaves every shortcut on its default keys (the presets keep off them)
      for (const mac of [true, false]) assert.deepEqual(resolveHotkeys(m, lay, mac), resolveHotkeys(null, lay, mac), `${p.id} on ${name}: a shortcut gave way`);
      // the app's letter shortcuts match on the printed character – none of them may be printed on a preset key
      for (const b of BUTTONS) assert.ok(!/^[fmprt]$/i.test(m[b.id].key), `${p.id} on ${name}: ${b.id} prints ${m[b.id].key}`);
      assert.deepEqual(resolve(m, lay), m, `${p.id} on ${name} survives resolve()`);
    }
  }
});

test('the arrow-key preset is the classic default on QWERTY', () => {
  const m = presetMap('arrows', QWERTY);
  for (const b of BUTTONS) assert.equal(m[b.id].keyCode, b.keyCode, b.id);
  assert.deepEqual(defaults(QWERTY), m);
  assert.deepEqual(ejsControls(null, QWERTY), ejsControls(m, QWERTY));
});

test('WASD means the same physical keys on every layout, printed as the layout prints them', () => {
  const dpad = (lay) => ['up', 'left', 'down', 'right'].map((id) => keyLabel(presetMap('wasd', lay)[id], lay)).join('');
  assert.equal(dpad(QWERTY), 'WASD');
  assert.equal(dpad(QWERTZ), 'WASD');
  assert.equal(dpad(AZERTY), 'ZQSD');
  // keyCode follows the printed letter: on AZERTY "up" is the key printing Z
  assert.equal(presetMap('wasd', AZERTY).up.keyCode, 90);
  assert.equal(presetMap('wasd', AZERTY).left.keyCode, 81);
  assert.equal(presetMap('wasd', AZERTY).up.code, 'KeyW');
});

test('QWERTZ swaps Y and Z, AZERTY moves A/Q/W/Z', () => {
  assert.deepEqual(keyFor('KeyZ', QWERTZ), { keyCode: 89, key: 'y', code: 'KeyZ' });
  assert.deepEqual(keyFor('KeyY', QWERTZ), { keyCode: 90, key: 'z', code: 'KeyY' });
  assert.equal(keyFor('KeyQ', AZERTY).keyCode, 65);
  assert.equal(keyFor('Semicolon', AZERTY).keyCode, 77);
  assert.equal(keyFor('KeyM', AZERTY), null); // prints "," – keyCode not predictable
  assert.equal(keyFor('Digit1', AZERTY).keyCode, 49);
  assert.deepEqual(keyFor('ArrowUp', AZERTY), { keyCode: 38, key: 'ArrowUp', code: 'ArrowUp' });
  assert.equal(keyFor('Space', QWERTY).keyCode, 32);
  // non-Latin layouts (e.g. Russian): browsers report the US letter
  assert.equal(keyFor('KeyF', { real: true, get: () => 'а' }).keyCode, 70);
  assert.equal(labels(presetMap('arrows', QWERTZ), QWERTZ), '↑ ↓ ← → Y X A S Q E Enter V C');
  assert.equal(labels(presetMap('arrows', AZERTY), AZERTY), '↑ ↓ ← → W X Q S A E Enter V C');
});

test('the fallback layout follows the UI language', () => {
  assert.equal(layoutForLang('de').id, 'qwertz');
  assert.equal(layoutForLang('de-AT').id, 'qwertz');
  assert.equal(layoutForLang('fr').id, 'azerty');
  for (const l of ['en', 'es', 'it', '', null, undefined]) assert.equal(layoutForLang(l).id, 'qwerty');
});

test('active preset or custom', () => {
  assert.equal(activePreset(null, QWERTZ), 'arrows');
  for (const [, lay] of Object.entries(LAYOUTS)) for (const p of PRESETS) assert.equal(activePreset(presetMap(p.id, lay), lay), p.id);
  const m = presetMap('wasd', QWERTY);
  assert.equal(activePreset({ ...m, select: { keyCode: 66, key: 'b', code: 'KeyB' } }, QWERTY), null);
  // an old config without codes that equals the classic default is still recognised
  const old = Object.fromEntries(BUTTONS.map((b) => [b.id, { keyCode: b.keyCode, key: b.key }]));
  assert.equal(activePreset(old, QWERTY), 'arrows');
});

test('old configs (keyCode only) keep their keys; physical codes follow the real layout', () => {
  const old = { a: { keyCode: 75, key: 'k' }, up: { keyCode: 87, key: 'w' } };
  for (const lay of [QWERTY, QWERTZ, realQwertz]) {
    const m = resolve(old, lay);
    assert.equal(m.a.keyCode, 75);
    assert.equal(m.up.keyCode, 87);
  }
  // the arrow preset saved on a US keyboard, later played on a real German keyboard: still the same physical keys
  const saved = presetMap('arrows', QWERTY);
  assert.equal(saved.a.keyCode, 90);
  assert.equal(resolve(saved, realQwertz).a.keyCode, 89);
  assert.equal(keyLabel(saved.a, realQwertz), 'Y');
  // a guessed layout never overrides what was stored (label and keyCode stay consistent)
  assert.equal(resolve(saved, QWERTZ).a.keyCode, 90);
  assert.equal(keyLabel(saved.a, QWERTZ), 'Z');
  // EmulatorJS table carries the live keyCodes
  assert.equal(ejsControls(saved, realQwertz)[0][8].value, 89);
});

test('unbindable or doubled saved keys fall back to the layout default – a shortcut\'s key is the player\'s choice', () => {
  const m = resolve({ a: { keyCode: 80, key: 'p' }, b: { keyCode: 16, key: 'Shift' }, x: { keyCode: 38, key: 'ArrowUp' } }, QWERTZ);
  assert.equal(m.a.keyCode, 80); // P (pause by default): the game button has it, pause gives way (resolveHotkeys)
  assert.equal(m.b.keyCode, 88);
  assert.equal(m.up.keyCode, 38);
  assert.equal(m.x.keyCode, 65); // ArrowUp already taken by up
});

test('detectLayout guesses from the language, then prefers the Keyboard Map API (kept across language changes)', async () => {
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true, writable: true });
    assert.equal((await detectLayout('fr')).id, 'azerty');
    assert.equal((await detectLayout(null)).id, 'qwerty'); // no app language yet → the browser's
    assert.equal(keyLabel(resolve(null).a), 'Z');
    globalThis.navigator.keyboard = { getLayoutMap: async () => new Map([['KeyZ', 'y'], ['KeyY', 'z'], ['KeyW', 'w']]) };
    assert.equal((await detectLayout('fr')).real, true);
    assert.equal(keyLabel(resolve(null).a), 'Y');
    assert.equal((await detectLayout('en')).id, 'system');
    assert.equal(currentLayout().real, true);
  } finally {
    if (nav) Object.defineProperty(globalThis, 'navigator', nav);
    else delete globalThis.navigator;
  }
});

test('controllers: Nintendo layout by default, family from the id, re-bound buttons never doubled', async () => {
  const c = await import('../web/lib/controls.mjs');
  const def = c.padMap(null);
  assert.equal(def.a, 'BUTTON_2'); // right face button, like on the GBA / DS
  assert.equal(def.b, 'BUTTON_1');
  assert.equal(c.padMap({ preset: 'xbox' }).a, 'BUTTON_1');
  // a re-bound button wins – also on ZR (turbo then gives way, padHotkeys) – and no label is used twice
  const m = c.padMap({ preset: 'nintendo', map: { a: 'BUTTON_4', select: 'RIGHT_BOTTOM_SHOULDER', start: 'BUTTON_4' } });
  assert.equal(m.a, 'BUTTON_4');
  assert.equal(m.select, 'RIGHT_BOTTOM_SHOULDER');
  assert.equal(m.start, 'START');
  const labels = Object.values(m).filter(Boolean);
  assert.equal(new Set(labels).size, labels.length);
  assert.equal(c.padFamily('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'), 'playstation');
  assert.equal(c.padFamily('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'), 'xbox');
  assert.equal(c.padFamily('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)'), 'switch');
  assert.equal(c.padFamily('8BitDo SN30 Pro (Vendor: 2dc8)'), 'generic');
  assert.equal(c.padLabel('BUTTON_2', 'switch'), 'A');
  assert.equal(c.padLabel('BUTTON_1', 'playstation'), '✕');
  // the EmulatorJS table carries the controller labels next to the keys
  const table = c.ejsControls(null, undefined, { preset: 'xbox' });
  assert.equal(table[0][8].value2, 'BUTTON_1'); // RetroArch A
});

// ---- which connected device plays (issue #2: a USB microphone was taken for the controller) ----
const fakePad = (index, id, { mapping = '', buttons = 17, axes = 4, connected = true } = {}) => ({
  index, id, mapping, connected, buttons: Array.from({ length: buttons }, () => ({ pressed: false, value: 0 })), axes: Array(axes).fill(0),
});
const DUALSENSE = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)';
const XBOX = 'Xbox 360 Controller (XInput STANDARD GAMEPAD)';
const MIC = 'DGM20 USB Microphone (Vendor: 1fc9 Product: 0117)';

test('controllers: a USB microphone listed first never beats the PS5 controller', async () => {
  const c = await import('../web/lib/controls.mjs');
  const mic = fakePad(0, MIC, { buttons: 3, axes: 0 });
  const ps5 = fakePad(1, DUALSENSE, { mapping: 'standard' });
  assert.equal(c.pickPad([mic, ps5]), ps5);
  assert.equal(c.pickPad([ps5, mic]), ps5);
  // the microphone alone is no controller – nothing plays rather than the mic
  assert.equal(c.pickPad([mic]), null);
  assert.equal(c.looksLikePad(mic), false);
  // even a microphone/headset that reports plenty of buttons and axes, by its name
  assert.equal(c.pickPad([fakePad(0, 'HyperX Cloud II Wireless Headset (Vendor: 03f0)', { buttons: 12, axes: 2 })]), null);
  assert.equal(c.pickPad([fakePad(0, 'USB Audio Device (Vendor: 0d8c Product: 0014)', { buttons: 8, axes: 1 })]), null);
  // anything with 0–3 buttons and no standard layout
  for (const n of [0, 1, 2, 3]) assert.equal(c.pickPad([fakePad(0, `HID device ${n} (Vendor: 1234 Product: 5678)`, { buttons: n, axes: n ? 1 : 0 })]), null, `${n} buttons`);
  // "Microsoft" is no "mic": an Xbox pad by its maker's name still plays
  assert.ok(c.looksLikePad(fakePad(0, 'Controller (Xbox One For Windows) (Vendor: 045e Product: 02ea) Microsoft', { mapping: 'standard' })));
});

test('controllers: the most controller-like device plays – standard layout, known make, buttons and sticks', async () => {
  const c = await import('../web/lib/controls.mjs');
  const xbox = fakePad(2, XBOX, { mapping: 'standard' });
  const ps5 = fakePad(1, DUALSENSE, { mapping: 'standard' });
  const generic = fakePad(0, 'USB Gamepad (Vendor: 0079 Product: 0011)', { buttons: 10, axes: 2 });
  // a cheap pad without the standard layout is still a controller – and plays when it is the only one
  assert.equal(c.pickPad([generic]), generic);
  assert.ok(c.padScore(ps5) > c.padScore(generic));
  // standard + known make: the lowest index among equals (the one connected first)
  assert.equal(c.pickPad([generic, ps5, xbox]), ps5);
  assert.equal(c.pickPad([xbox, generic]), xbox);
  // disconnected slots and holes (Chrome keeps null for a pad that left)
  assert.equal(c.pickPad([null, fakePad(1, DUALSENSE, { mapping: 'standard', connected: false }), xbox]), xbox);
  assert.equal(c.pickPad([]), null);
  assert.equal(c.pickPad(null), null);
  // counts work as well as arrays (the Settings page keeps counts)
  assert.equal(c.padScore({ id: DUALSENSE, standard: true, buttons: 17, axes: 4 }), c.padScore(ps5));
});

test('controllers: the controller chosen in Settings plays whenever it is connected – even one that looks odd', async () => {
  const c = await import('../web/lib/controls.mjs');
  const mic = fakePad(0, MIC, { buttons: 3, axes: 0 });
  const ps5 = fakePad(1, DUALSENSE, { mapping: 'standard' });
  const xbox = fakePad(2, XBOX, { mapping: 'standard' });
  assert.equal(c.pickPad([mic, ps5, xbox], XBOX), xbox);
  // the player's own choice wins over the heuristics
  assert.equal(c.pickPad([mic, ps5], MIC), mic);
  // remembered but not connected: the automatic choice
  assert.equal(c.pickPad([mic, ps5], 'Some Other Pad (Vendor: 0001)'), ps5);
  // the stored key is the trimmed id (indexes change from start to start, the id doesn't)
  assert.equal(c.padKey(`  ${DUALSENSE} `), DUALSENSE);
  assert.equal(c.pickPad([mic, xbox, ps5], ` ${DUALSENSE}`), ps5);
  assert.equal(c.padKey('x'.repeat(300)).length, 200);
});

test('controller diagnostics: the picked device and each new press with the game buttons it maps to', async () => {
  const { padRecorder, padMap } = await import('../web/lib/controls.mjs');
  const rec = padRecorder(3);
  const map = padMap({ preset: 'nintendo', map: { a: 'BUTTON_1', b: 'BUTTON_2' } });
  const pad = (pressed) => ({ id: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', index: 0, mapping: 'standard',
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })), axes: [0, 0, 0, 0] });
  rec.see(pad([0]), map);
  rec.see(pad([0]), map); // held: one press, not two
  rec.see(pad([]), map);
  rec.see(pad([1]), map, true);
  const info = rec.info({ preset: 'nintendo' }, map);
  assert.equal(info.picked.mapping, 'standard');
  assert.deepEqual(info.presses.map(({ i, label, game, app }) => ({ i, label, game, app })), [
    { i: 0, label: 'BUTTON_1', game: ['a'], app: false },
    { i: 1, label: 'BUTTON_2', game: ['b'], app: true },
  ]);
  rec.see(null, map);
  assert.equal(rec.info(null, map).picked, null);
});

const TAB = { keyCode: 9, key: 'Tab', code: 'Tab' };
const G = { keyCode: 71, key: 'g', code: 'KeyG' };
const R = { keyCode: 82, key: 'r', code: 'KeyR' };

test('shortcuts: the keys of 2.8.1 by default – on every layout and preset, on a Mac and elsewhere', async () => {
  const { HOTKEYS } = await import('../web/lib/controls.mjs');
  // the keys the play view had fixed until 2.8.1 (and the two fast-forward keys of 2.8.1) – unchanged for everyone
  const OLD = { ffHold: ['9'], ffToggle: ['9s'], turbo: ['84'], pause: ['80'], reset: ['82'], quicksave: ['116'], quickload: ['119'],
    save1: ['49s'], save2: ['50s'], save3: ['51s'], save4: ['52s'], load1: ['49', '97'], load2: ['50', '98'], load3: ['51', '99'], load4: ['52', '100'],
    screenshot: ['123'], mute: ['77'], louder: ['187', '187s', '107'], quieter: ['189', '109'], fullscreen: ['70'],
    faster: ['187m'], slower: ['189m'] }; // (⌘ / Ctrl + and – were the desktop menu's)
  const sig = (c, mac) => `${c.keyCode}${c.shift ? 's' : ''}${(mac ? c.meta : c.ctrl) ? 'm' : ''}${(mac ? c.ctrl : c.meta) || c.alt ? '?' : ''}`;
  assert.deepEqual(HOTKEYS.map((h) => h.id).sort(), Object.keys(OLD).sort());
  for (const [name, lay] of Object.entries(LAYOUTS)) {
    for (const p of [null, ...PRESETS.map((x) => presetMap(x.id, lay))]) {
      for (const mac of [true, false]) {
        const hot = resolveHotkeys(p, lay, mac);
        for (const [id, keys] of Object.entries(OLD)) assert.deepEqual(hot[id].map((c) => sig(c, mac)), keys, `${id} on ${name}`);
      }
    }
  }
  assert.deepEqual(resolveHotkeys(null, QWERTY, true).ffHold, [TAB]);
  assert.deepEqual(resolveHotkeys(null, QWERTY, true).faster, [{ keyCode: 187, key: '+', meta: true }]);
  assert.deepEqual(resolveHotkeys(null, QWERTY, false).faster, [{ keyCode: 187, key: '+', ctrl: true }]);
});

test('shortcuts: a key press is a shortcut only with exactly its modifiers', async () => {
  const { hotkeyOf, keyMatches, isHotkeyKey } = await import('../web/lib/controls.mjs');
  const hot = resolveHotkeys(null, QWERTY, true);
  // what the player pages forward ({ key, code, keyCode, shift, ctrl, alt, meta }) – and older ones without the keyCode
  assert.equal(hotkeyOf({ key: 'Tab', code: 'Tab', keyCode: 9, shift: false }, hot), 'ffHold');
  assert.equal(hotkeyOf({ key: 'Tab', code: 'Tab', keyCode: 9, shift: true }, hot), 'ffToggle');
  assert.equal(hotkeyOf({ key: 'Tab', shift: false }, hot), 'ffHold');
  assert.equal(hotkeyOf({ key: 't', code: 'KeyT', keyCode: 84 }, hot), 'turbo');
  assert.equal(hotkeyOf({ key: 'r', code: 'KeyR', keyCode: 82 }, hot), 'reset');
  assert.equal(hotkeyOf({ key: 'r', code: 'KeyR', keyCode: 82, meta: true }, hot), null, '⌘R is no reset');
  assert.equal(hotkeyOf({ key: '!', code: 'Digit1', keyCode: 49, shift: true }, hot), 'save1');
  assert.equal(hotkeyOf({ key: '&', code: 'Digit1', keyCode: 49 }, hot), 'load1', 'AZERTY prints & on the 1 key');
  assert.equal(hotkeyOf({ key: '1', code: 'Numpad1', keyCode: 97 }, hot), 'load1');
  assert.equal(hotkeyOf({ key: '=', code: 'Equal', keyCode: 187 }, hot), 'louder');
  assert.equal(hotkeyOf({ key: '+', code: 'Equal', keyCode: 187, shift: true }, hot), 'louder', '+ is Shift+= on US keyboards');
  assert.equal(hotkeyOf({ key: '+', code: 'NumpadAdd', keyCode: 107 }, hot), 'louder');
  assert.equal(hotkeyOf({ key: '=', code: 'Equal', keyCode: 187, meta: true }, hot), 'faster');
  assert.equal(hotkeyOf({ key: '-', code: 'Minus', keyCode: 189, meta: true }, hot), 'slower');
  assert.equal(hotkeyOf({ key: 'g', code: 'KeyG', keyCode: 71 }, hot), null);
  // DOM events (the player pages) carry shiftKey / ctrlKey …: the same
  assert.ok(isHotkeyKey({ keyCode: 9, code: 'Tab', shiftKey: true }, hot));
  assert.ok(!isHotkeyKey({ keyCode: 9, code: 'Tab', ctrlKey: true }, hot), 'Ctrl+Tab stays the system’s');
  assert.ok(!isHotkeyKey({ keyCode: 90, code: 'KeyZ' }, hot));
  // the release of the hold key matches with or without Shift (Shift may be let go first)
  assert.ok(keyMatches({ key: 'Tab', code: 'Tab', shift: true }, hot.ffHold));
  assert.ok(!keyMatches({ key: 'g', code: 'KeyG', keyCode: 71 }, hot.ffHold));
});

test('shortcuts: re-bound with modifiers, stored by the physical key; a clash falls back to the default', async () => {
  const { hotkeyOf, isHotkeyKey } = await import('../web/lib/controls.mjs');
  // 2.8.1 configs: fast-forward on G and Shift+G – the same as before, Tab is free again
  let hot = resolveHotkeys({ ffHold: G, ffToggle: { ...G, shift: true } }, QWERTY, true);
  assert.deepEqual(hot.ffHold, [G]);
  assert.deepEqual(hot.ffToggle, [{ ...G, shift: true }]);
  assert.equal(hotkeyOf({ key: 'G', code: 'KeyG', keyCode: 71, shift: true }, hot), 'ffToggle');
  assert.ok(!isHotkeyKey({ keyCode: 9, code: 'Tab' }, hot));
  assert.deepEqual(resolve({ ffHold: G }, QWERTY), defaults(QWERTY), 'the game buttons stay as they were');
  // Ctrl+R and ⌥⇧F5 – any modifiers the system leaves alone
  hot = resolveHotkeys({ reset: { ...R, ctrl: true }, quicksave: { keyCode: 116, key: 'F5', code: 'F5', alt: true, shift: true } }, QWERTY, false);
  assert.equal(hotkeyOf({ key: 'r', code: 'KeyR', keyCode: 82, ctrl: true }, hot), 'reset');
  assert.equal(hotkeyOf({ key: 'r', code: 'KeyR', keyCode: 82 }, hot), null, 'plain R does nothing now');
  assert.equal(hotkeyOf({ key: 'F5', code: 'F5', keyCode: 116, alt: true, shift: true }, hot), 'quicksave');
  // stored with the physical key: on a real QWERTZ keyboard the key printing Z (KeyY) still is the one picked
  hot = resolveHotkeys({ ffHold: { keyCode: 89, key: 'y', code: 'KeyY' } }, realQwertz, true);
  assert.equal(hot.ffHold[0].code, 'KeyY');
  assert.equal(hot.ffHold[0].keyCode, 90);
  // a game button's key (Z = A), junk, a reserved combo → the default
  assert.equal(resolveHotkeys({ ffHold: { keyCode: 90, key: 'z', code: 'KeyZ' } }, QWERTY).ffHold[0].keyCode, 9);
  assert.equal(resolveHotkeys({ ffHold: { keyCode: 'x' } }, QWERTY).ffHold[0].keyCode, 9);
  assert.equal(resolveHotkeys({ reset: { keyCode: 81, key: 'q', meta: true } }, QWERTY, true).reset[0].keyCode, 82, '⌘Q stays quit');
  // another shortcut's default key: the player's choice wins, the default gives way (T: turbo has none then)
  hot = resolveHotkeys({ ffToggle: { keyCode: 84, key: 't', code: 'KeyT' } }, QWERTY, true);
  assert.equal(hot.ffToggle[0].keyCode, 84);
  assert.deepEqual(hot.turbo, []);
  // both on Shift+Tab: the first keeps it; the two swapped
  hot = resolveHotkeys({ ffHold: { ...TAB, shift: true } }, QWERTY, true);
  assert.deepEqual(hot.ffHold, [{ ...TAB, shift: true }]);
  assert.deepEqual(hot.ffToggle, [], 'Shift+Tab is taken and the default is the same – no toggle key then');
  hot = resolveHotkeys({ ffHold: { ...TAB, shift: true }, ffToggle: TAB }, QWERTY, true);
  assert.equal(hotkeyOf({ key: 'Tab', code: 'Tab', keyCode: 9, shift: true }, hot), 'ffHold');
  assert.equal(hotkeyOf({ key: 'Tab', code: 'Tab', keyCode: 9 }, hot), 'ffToggle');
  // a preset that puts a game button on the shortcut's key wins: the shortcut goes back to its default
  const wasd = presetMap('wasd', QWERTY); // B on J
  assert.equal(resolveHotkeys({ ...wasd, ffHold: { keyCode: 74, key: 'j', code: 'KeyJ' } }, QWERTY).ffHold[0].keyCode, 9);
  // switched off
  assert.deepEqual(resolveHotkeys({ reset: { none: true } }, QWERTY).reset, []);
});

test('R for B (Discord): a game button takes any shortcut key – the shortcut gives way, swaps or moves', async () => {
  const { assignKey, clearKey, changedBindings, hotkeyOf, keyButtons } = await import('../web/lib/controls.mjs');
  // B takes R: reset has no key now (and says so) – the default arrow preset is stored as every button's key
  const { next, lost, swap } = assignKey(null, 'b', R, QWERTY, true);
  assert.deepEqual(lost, [{ id: 'reset', key: { keyCode: 82, key: 'r' }, left: [] }]);
  assert.equal(resolve(next, QWERTY).b.keyCode, 82);
  assert.equal(resolve(next, QWERTY).a.keyCode, 90, 'the others keep their keys');
  assert.deepEqual(resolveHotkeys(next, QWERTY, true).reset, []);
  assert.equal(hotkeyOf({ key: 'r', code: 'KeyR', keyCode: 82 }, resolveHotkeys(next, QWERTY, true)), null, 'R no longer resets');
  assert.equal(keyButtons(next, QWERTY)[82], 'b', 'R presses B in the game');
  assert.deepEqual(changedBindings(null, next, 'b', QWERTY, true), [{ id: 'reset', before: [{ keyCode: 82, key: 'r' }], after: [] }]);
  // …or the two swap: reset goes to X, B's old key
  assert.equal(resolve(swap, QWERTY).b.keyCode, 82);
  assert.equal(resolveHotkeys(swap, QWERTY, true).reset[0].keyCode, 88);
  // …or reset moves to Shift+R – while R is B (a combo with Shift is no game button's key)
  const moved = assignKey(next, 'reset', { ...R, shift: true }, QWERTY, true);
  assert.deepEqual(moved.lost, []);
  const hot = resolveHotkeys(moved.next, QWERTY, true);
  assert.equal(hotkeyOf({ key: 'R', code: 'KeyR', keyCode: 82, shift: true }, hot), 'reset');
  assert.equal(resolve(moved.next, QWERTY).b.keyCode, 82);
  // a shortcut taking a game button's key leaves that button without one (never two actions on one key)
  const took = assignKey(null, 'pause', { keyCode: 90, key: 'z', code: 'KeyZ' }, QWERTY, true);
  assert.deepEqual(took.lost.map((l) => l.id), ['a']);
  assert.equal(resolve(took.next, QWERTY).a, null);
  assert.equal(resolveHotkeys(took.next, QWERTY, true).pause[0].keyCode, 90);
  assert.equal(resolve(took.swap, QWERTY).a.keyCode, 80, 'swapped: A on P');
  // a shortcut taking another's: that one is off
  const t2 = assignKey(null, 'ffHold', { keyCode: 84, key: 't', code: 'KeyT' }, QWERTY, true);
  assert.deepEqual(t2.lost.map((l) => l.id), ['turbo']);
  assert.deepEqual(resolveHotkeys(t2.next, QWERTY, true).turbo, []);
  assert.deepEqual(resolve(t2.next, QWERTY), defaults(QWERTY), 'no game button changed – none stored');
  assert.equal(t2.next.a, undefined);
  // one of two keys: B on Num 1 – "load slot 1" keeps 1
  const np = assignKey(null, 'b', { keyCode: 97, key: '1', code: 'Numpad1' }, QWERTY, true);
  assert.deepEqual(np.lost.map((l) => [l.id, l.left.map((c) => c.code)]), [['load1', ['Digit1']]]);
  assert.equal(np.swap, null, 'nothing to swap: it still has a key');
  assert.deepEqual(resolveHotkeys(np.next, QWERTY, true).load1.map((c) => c.keyCode), [49]);
  // switched off: no key, also not the default
  const off = clearKey(null, 'reset');
  assert.deepEqual(resolveHotkeys(off, QWERTY, true).reset, []);
  assert.deepEqual(resolveHotkeys(off, QWERTY, true).pause.map((c) => c.keyCode), [80], 'the others stay');
  // a game button left without a key stays without (not the default)
  assert.equal(resolve({ ...defaults(QWERTY), a: { none: true } }, QWERTY).a, null);
});

test('shortcuts: what the system or souldew’s menu does is refused (⌘Q, Alt+F4, the Windows key …)', async () => {
  const { reservedCombo } = await import('../web/lib/controls.mjs');
  const k = (x, m = {}) => ({ keyCode: typeof x === 'number' ? x : x.toUpperCase().charCodeAt(0), ...m });
  for (const c of [k('q', { meta: 1 }), k('w', { meta: 1 }), k('h', { meta: 1 }), k('m', { meta: 1 }), k(9, { meta: 1 }), k(32, { meta: 1 }), k('f', { meta: 1, ctrl: 1 }), k(52, { meta: 1, shift: 1 })]) {
    assert.equal(reservedCombo(c, true), 'system', JSON.stringify(c));
  }
  for (const c of [k(115, { alt: 1 }), k(9, { alt: 1 }), k(46, { ctrl: 1, alt: 1 }), k(27, { ctrl: 1 }), k(27, { ctrl: 1, shift: 1 }), k('r', { meta: 1 }), k(32, { alt: 1 })]) {
    assert.equal(reservedCombo(c, false), 'system', JSON.stringify(c));
  }
  // souldew's menu: settings, the sections, add games, the sidebar, copy & paste, fullscreen (F11 on Windows / Linux)
  for (const [c, mac] of [[k(188, { meta: 1 }), true], [k(49, { meta: 1 }), true], [k('o', { ctrl: 1 }), false], [k('b', { ctrl: 1 }), false], [k('c', { meta: 1 }), true], [k('v', { ctrl: 1 }), false], [k(122), false]]) {
    assert.equal(reservedCombo(c, mac), 'menu', JSON.stringify(c));
  }
  // free: plain keys, Shift+R, Ctrl+R, ⌘R (no reload in the app), Alt+R, F11 on a Mac
  for (const [c, mac] of [[k('r'), true], [k('r', { shift: 1 }), true], [k('r', { ctrl: 1 }), false], [k('r', { meta: 1 }), true], [k('r', { alt: 1 }), false], [k(122), true], [k(9, { shift: 1 }), false]]) {
    assert.equal(reservedCombo(c, mac), null, JSON.stringify(c));
  }
});

test('shortcuts: the desktop menu shows the keys in use (accelerators)', async () => {
  const { accelerator } = await import('../web/lib/controls.mjs');
  const hot = resolveHotkeys(null, QWERTY, true);
  assert.equal(accelerator(hot.pause[0]), 'P');
  assert.equal(accelerator(hot.faster[0]), 'Cmd+Plus');
  assert.equal(accelerator(hot.slower[0]), 'Cmd+-');
  assert.equal(accelerator(hot.ffToggle[0]), 'Shift+Tab');
  assert.equal(accelerator(hot.quicksave[0]), 'F5');
  assert.equal(accelerator({ ...R, ctrl: true, alt: true }), 'Ctrl+Alt+R');
  assert.equal(accelerator({ keyCode: 97, key: '1', code: 'Numpad1' }), 'num1');
  assert.equal(accelerator(undefined), null);
});

test('controller shortcuts: ZR turbo, ZL pause, fast-forward none – all re-bindable, a game button may take ZL / ZR', async () => {
  const { padHotkeys, padActions, padHotkeyPresses, padMap: pm, assignPad } = await import('../web/lib/controls.mjs');
  assert.deepEqual(padHotkeys(null), { ffHold: '', ffToggle: '', turbo: 'RIGHT_BOTTOM_SHOULDER', pause: 'LEFT_BOTTOM_SHOULDER' });
  assert.deepEqual(padActions(null), { 7: 'turbo', 6: 'pause', 16: 'pause' });
  const pads = { preset: 'nintendo', map: { ffHold: 'RIGHT_STICK', ffToggle: 'LEFT_STICK' } }; // a 2.8.1 config
  assert.deepEqual(padHotkeys(pads), { ffHold: 'RIGHT_STICK', ffToggle: 'LEFT_STICK', turbo: 'RIGHT_BOTTOM_SHOULDER', pause: 'LEFT_BOTTOM_SHOULDER' });
  assert.deepEqual(padActions(pads), { 7: 'turbo', 6: 'pause', 16: 'pause', 11: 'ffHold', 10: 'ffToggle' });
  assert.deepEqual(pm(pads), pm(null), 'the game buttons don\'t change');
  assert.equal(padHotkeys({ map: { ffHold: 'BUTTON_2' } }).ffHold, '', 'A (Nintendo layout) is a game button');
  assert.deepEqual(padHotkeys({ map: { ffHold: 'LEFT_STICK', ffToggle: 'LEFT_STICK' } }).ffToggle, '');
  assert.equal(padHotkeys({ map: { ffHold: 'NOPE' } }).ffHold, '');
  // fast-forward on ZR: picked by the player, so turbo (its default) gives way
  assert.deepEqual(padActions({ map: { ffHold: 'RIGHT_BOTTOM_SHOULDER' } }), { 7: 'ffHold', 6: 'pause', 16: 'pause' });
  // a game button on ZL: pause gives way – Home still pauses
  const { next, lost, swap } = assignPad(null, 'b', 'LEFT_BOTTOM_SHOULDER');
  assert.deepEqual(lost, [{ id: 'pause', label: 'LEFT_BOTTOM_SHOULDER' }]);
  assert.equal(pm(next).b, 'LEFT_BOTTOM_SHOULDER');
  assert.equal(padHotkeys(next).pause, '');
  assert.deepEqual(padActions(next), { 7: 'turbo', 16: 'pause' });
  assert.equal(padHotkeys(swap).pause, 'BUTTON_1', 'swapped: pause on B\'s old button');
  // switched off – and a game button left without one
  assert.equal(padHotkeys({ map: { turbo: 'NONE' } }).turbo, '');
  assert.equal(pm({ map: { a: 'NONE' } }).a, '');
  const a = assignPad(null, 'turbo', 'BUTTON_2'); // A's button
  assert.equal(pm(a.next).a, '');
  assert.equal(padHotkeys(a.next).turbo, 'BUTTON_2');

  // a poll after another: the hold is pressed and released, the toggle and ZR only pressed
  const actions = padActions(pads);
  const held = {};
  const pad = { buttons: Array.from({ length: 17 }, () => ({ pressed: false })) };
  const poll = (on, appHas = false) => {
    pad.buttons.forEach((b, i) => (b.pressed = on.includes(i)));
    return padHotkeyPresses(pad, actions, held, appHas).map((m) => `${m.action}:${m.down}`);
  };
  assert.deepEqual(poll([11]), ['ffHold:true']);
  assert.deepEqual(poll([11]), [], 'held: nothing new');
  assert.deepEqual(poll([]), ['ffHold:false']);
  assert.deepEqual(poll([10]), ['ffToggle:true']);
  assert.deepEqual(poll([]), [], 'the toggle has no release');
  assert.deepEqual(poll([7]), ['turbo:true']);
  assert.deepEqual(poll([]), []);
  // the app's menus have the controller: fast-forward doesn't start, ZL still resumes the game
  assert.deepEqual(poll([11, 6], true), ['pause:true']);
  assert.deepEqual(poll([], true), ['ffHold:false'], 'a release never hurts');
});

test('a 2.8.1 fast-forward key souldew’s menu has here (F11 on Windows / Linux) is said, not quietly put back on Tab; one that works stays', async () => {
  const { refusedHotkeys } = await import('../web/lib/controls.mjs');
  const F11 = { keyCode: 122, key: 'F11', code: 'F11' };
  const saved = { ffHold: F11 };
  // Windows / Linux: F11 is the menu's fullscreen – it plays on Tab for now, and Settings says why
  assert.deepEqual(resolveHotkeys(saved, QWERTY, false).ffHold.map((c) => c.keyCode), [9]);
  assert.deepEqual(refusedHotkeys(saved, QWERTY, false), [{ id: 'ffHold', key: { keyCode: 122, key: 'F11', code: 'F11' }, why: 'menu' }]);
  // a Mac: F11 is free – kept, nothing to say
  assert.deepEqual(resolveHotkeys(saved, QWERTY, true).ffHold.map((c) => c.keyCode), [122]);
  assert.deepEqual(refusedHotkeys(saved, QWERTY, true), []);
  // any other 2.8.1 key stays as it was
  const g = { ffHold: { keyCode: 71, key: 'g' }, ffToggle: { keyCode: 71, key: 'g', shift: true } };
  for (const mac of [true, false]) {
    assert.deepEqual(resolveHotkeys(g, QWERTY, mac).ffHold.map((c) => c.keyCode), [71]);
    assert.deepEqual(refusedHotkeys(g, QWERTY, mac), []);
  }
  // switched off, or not set: nothing to say
  assert.deepEqual(refusedHotkeys({ ffHold: { none: true } }, QWERTY, false), []);
  assert.deepEqual(refusedHotkeys(null, QWERTY, false), []);
  // the Settings row says it in all five languages
  const { readFileSync } = await import('node:fs');
  for (const lang of ['en', 'de', 'fr', 'es', 'it']) {
    const j = JSON.parse(readFileSync(new URL(`../web/i18n/${lang}.json`, import.meta.url), 'utf8'));
    for (const k of ['ctl.refusedNow', 'ctl.refusedNone', 'ctl.keepKey', 'ctl.ownerMenu', 'ctl.ownerSystem']) assert.ok(j[k], `${lang}: ${k}`);
  }
});

test('3.0: ⌘I / Ctrl+I folds the play view\'s dock – no shortcut can take it (it would never fire)', async () => {
  const C = await import('../web/lib/controls.mjs');
  assert.equal(C.reservedCombo({ keyCode: 73, meta: true }, true), 'menu');
  assert.equal(C.reservedCombo({ keyCode: 73, ctrl: true }, false), 'menu');
  assert.equal(C.reservedCombo({ keyCode: 73 }, true), null, 'I alone stays free');
});
