// 2.8.3, Discord: "Crouching in ORAS – where do I crouch? I can't find the button in the controls config." Omega Ruby /
// Alpha Sapphire sneak when the Circle Pad is tilted only part of the way – a key always gives full tilt. The 3DS player
// now has "Circle Pad: half tilt": held, it caps the Circle Pad (shared/ctrinput.mjs), re-bindable in Settings › Controls
// like every game button (and on a controller button in Settings › Controller), shown in Help › Controls & shortcuts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CTR_BIT, CTR_SNEAK_TILT, ctrInput, capStick } from '../shared/ctrinput.mjs';
import {
  BUTTONS, PRESETS, isJoypad, tableLayout, presetMap, activePreset, resolve, resolveHotkeys, keyButtons, ejsControls, assignKey, hotkeyOf,
  padMap, padActions, assignPad, PAD_PRESETS,
} from '../web/lib/controls.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');
const QWERTY = tableLayout('qwerty');
const QWERTZ = tableLayout('qwertz');
const AZERTY = tableLayout('azerty');
const bit = (...names) => names.reduce((m, n) => m | (1 << CTR_BIT[n]), 0);
const FULL = 0x7fff;
const DPAD = bit('up', 'down', 'left', 'right');

// what the game reads (Azahar 2126.2): int16 / INT16_MAX (citra_libretro LibRetroAxis), × 0x9A rounded (hid.cpp
// MAX_CIRCLEPAD_POS) – the Circle Pad's position on the console's own scale, full tilt = 154
const inGame = (v) => Math.round((v / 32767) * 0x9a);
const radius = ({ lx, ly }) => Math.hypot(inGame(lx), inGame(ly));

test('half tilt: the Circle Pad goes 40 % of the way – a light tilt in the game, above its threshold, below a normal walk', () => {
  assert.equal(CTR_SNEAK_TILT, 0.4);
  const walk = ctrInput({ keys: bit('right') });
  assert.deepEqual(walk, { buttons: bit('right'), lx: FULL, ly: 0 }, 'without it: full tilt, as before');
  const sneak = ctrInput({ keys: bit('right'), slow: true });
  assert.equal(sneak.lx, Math.round(0.4 * FULL));
  assert.equal(sneak.ly, 0);
  assert.equal(inGame(sneak.lx), 62, '62 of 154');
  // above the HID's direction threshold (radius 40: the game still sees "Circle Pad right") and the point where the
  // character starts to move (about a third), below half – where Omega Ruby / Alpha Sapphire walk normally
  assert.ok(radius(sneak) > 40 && radius(sneak) > 154 / 3 && radius(sneak) < 154 / 2, `radius ${radius(sneak)}`);
  // up / left are negative, every direction the same length
  for (const d of ['up', 'down', 'left', 'right']) assert.equal(Math.round(radius(ctrInput({ keys: bit(d), slow: true }))), 62, d);
  assert.equal(ctrInput({ keys: bit('up'), slow: true }).ly, -Math.round(0.4 * FULL));
});

test('half tilt on a diagonal caps the whole tilt, not each axis (0.4 on both axes would be a normal walk again)', () => {
  const s = ctrInput({ keys: bit('up', 'right'), slow: true });
  assert.ok(s.lx > 0 && s.ly < 0 && s.lx === -s.ly);
  assert.ok(Math.abs(Math.hypot(s.lx, s.ly) - 0.4 * FULL) < 2, `length ${Math.hypot(s.lx, s.ly)}`);
  assert.ok(radius(s) > 40 && radius(s) < 154 / 2, `radius ${radius(s)}`);
  // opposite keys cancel, as without it
  assert.deepEqual(ctrInput({ keys: bit('left', 'right'), slow: true }), { buttons: 0, lx: 0, ly: 0 });
});

test('half tilt: the direction keys move only the Circle Pad, not the D-pad as well – the other buttons stay', () => {
  // (Omega Ruby / Alpha Sapphire never sneak while the D-pad is held – without this the D-pad bit walked as before)
  const s = ctrInput({ keys: bit('down', 'a'), slow: true });
  assert.equal(s.buttons & DPAD, 0, 'no D-pad');
  assert.equal(s.buttons, bit('a'), 'A still pressed');
  assert.ok(s.ly > 0);
  // the key alone does nothing
  assert.deepEqual(ctrInput({ slow: true }), { buttons: 0, lx: 0, ly: 0 });
  assert.deepEqual(ctrInput({ keys: bit('b', 'start'), slow: true }), { buttons: bit('b', 'start'), lx: 0, ly: 0 });
});

test('controllers: a stick is capped, not scaled (a light tilt stays light) – and with a half-tilt button the D-pad sneaks too', () => {
  // without the half tilt nothing changes: the stick as it is, the controller's D-pad only the D-pad
  assert.deepEqual(ctrInput({ lx: 9000, ly: -3000 }), { buttons: 0, lx: 9000, ly: -3000 });
  assert.deepEqual(ctrInput({ pad: bit('left') }), { buttons: bit('left'), lx: 0, ly: 0 });
  // held: full tilt → 40 %, a light tilt below it stays
  const full = ctrInput({ lx: FULL, ly: 0, slow: true });
  assert.equal(full.lx, Math.round(0.4 * FULL));
  assert.deepEqual(ctrInput({ lx: 6000, ly: 2000, slow: true }), { buttons: 0, lx: 6000, ly: 2000 });
  // a tilted stick leads over the keys
  assert.deepEqual(ctrInput({ keys: bit('left'), lx: 5000, ly: 0, slow: true }), { buttons: 0, lx: 5000, ly: 0 });
  // the controller's D-pad with a half-tilt button: the Circle Pad at 40 %, no D-pad bit
  const pad = ctrInput({ pad: bit('left', 'x'), slow: true });
  assert.deepEqual(pad, { buttons: bit('x'), lx: -Math.round(0.4 * FULL), ly: 0 });
  // tests / diagnostics (__emu.stick) are capped the same way
  assert.equal(ctrInput({ stickX: FULL, stickY: 0, slow: true }).lx, Math.round(0.4 * FULL));
  assert.deepEqual(capStick(3, 4, 10), [3, 4]);
  assert.deepEqual(capStick(30, 40, 10), [6, 8]);
  assert.deepEqual(capStick(0, 0, 10), [0, 0]);
});

test('Settings › Controls: a 13th row "Circle Pad: half tilt", 3DS only – default C (arrow keys) / L (WASD), no joypad button', () => {
  const sneak = BUTTONS.find((b) => b.id === 'sneak');
  assert.deepEqual(sneak.systems, ['3ds']);
  assert.ok(!isJoypad(sneak) && BUTTONS.filter(isJoypad).length === 12);
  for (const lay of [QWERTY, QWERTZ, AZERTY]) {
    assert.equal(resolve(null, lay).sneak.keyCode, 67, 'C on every layout');
    assert.equal(presetMap('wasd', lay).sneak.code, 'KeyL');
    // the GB / GBA / DS players and EmulatorJS never see it: C presses nothing there
    assert.ok(!Object.values(keyButtons(null, lay)).includes('sneak'));
    assert.equal(keyButtons(null, lay)[67], undefined);
    assert.equal(Object.keys(ejsControls(null, lay)[0]).length, 12);
  }
  // no default shortcut on C or L (Shift+Tab / Shift+1–4 / Shift++ use Shift, so a held Shift would change them)
  for (const p of PRESETS) for (const mac of [true, false]) assert.deepEqual(resolveHotkeys(presetMap(p.id, QWERTY), QWERTY, mac), resolveHotkeys(null, QWERTY, mac));
});

test('configs from 2.8.2: the preset they are keeps being that preset, and a shortcut the player put on C keeps it', () => {
  // every button stored (a preset picked or a key changed in 2.8.2) – without the new one
  const without = (m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'sneak'));
  for (const lay of [QWERTY, QWERTZ, AZERTY]) {
    const wasd = without(presetMap('wasd', lay));
    assert.equal(resolve(wasd, lay).sneak.code, 'KeyL', 'WASD players get L');
    assert.equal(activePreset(wasd, lay), 'wasd', 'still "WASD", not "Custom"');
    const arrows = without(presetMap('arrows', lay));
    assert.equal(resolve(arrows, lay).sneak.keyCode, 67);
    assert.equal(activePreset(arrows, lay), 'arrows');
  }
  // a custom 2.8.2 mapping: the default C (if free)
  const custom = { ...without(presetMap('arrows', QWERTY)), a: { keyCode: 75, key: 'k', code: 'KeyK' } };
  assert.equal(resolve(custom, QWERTY).sneak.keyCode, 67);
  // a game button already on C: the half tilt has no key (the player's button keeps it)
  assert.equal(resolve({ ...custom, select: { keyCode: 67, key: 'c', code: 'KeyC' } }, QWERTY).sneak, null);
  // a shortcut the player put on C: it keeps C, the half tilt has none until the player picks one
  const shot = { screenshot: { keyCode: 67, key: 'c', code: 'KeyC' } };
  assert.equal(resolve(shot, QWERTY).sneak, null);
  assert.equal(hotkeyOf({ key: 'c', code: 'KeyC', keyCode: 67 }, resolveHotkeys(shot, QWERTY, true)), 'screenshot');
  // (Shift+C for a shortcut doesn't clash: the half tilt keeps C)
  assert.equal(resolve({ screenshot: { keyCode: 67, key: 'c', code: 'KeyC', shift: true } }, QWERTY).sneak.keyCode, 67);
});

test('re-binding the half tilt goes through the same conflict handling as every key (taken over, swap, undo)', () => {
  // the half tilt on R: reset gives R up (or the two swap: reset on C)
  const r = assignKey(null, 'sneak', { keyCode: 82, key: 'r', code: 'KeyR' }, QWERTY, true);
  assert.deepEqual(r.lost.map((l) => l.id), ['reset']);
  assert.equal(resolve(r.next, QWERTY).sneak.keyCode, 82);
  assert.deepEqual(resolveHotkeys(r.next, QWERTY, true).reset, []);
  assert.equal(resolveHotkeys(r.swap, QWERTY, true).reset[0].keyCode, 67, 'swapped: reset on C');
  // a game button taking C leaves the half tilt without a key – or the two swap
  const sel = assignKey(null, 'select', { keyCode: 67, key: 'c', code: 'KeyC' }, QWERTY, true);
  assert.deepEqual(sel.lost.map((l) => l.id), ['sneak']);
  assert.equal(resolve(sel.next, QWERTY).sneak, null);
  assert.equal(resolve(sel.swap, QWERTY).sneak.keyCode, 86, 'swapped: half tilt on V');
  // the half tilt on a joypad button's key takes it (never two actions on one key)
  const z = assignKey(null, 'sneak', { keyCode: 90, key: 'z', code: 'KeyZ' }, QWERTY, true);
  assert.deepEqual(z.lost.map((l) => l.id), ['a']);
  assert.equal(resolve(z.next, QWERTY).a, null);
  assert.equal(keyButtons(z.next, QWERTY)[90], undefined, 'Z presses no joypad button then');
  // a shortcut taking C
  const pause = assignKey(null, 'pause', { keyCode: 67, key: 'c', code: 'KeyC' }, QWERTY, true);
  assert.deepEqual(pause.lost.map((l) => l.id), ['sneak']);
  assert.equal(resolve(pause.next, QWERTY).sneak, null);
});

test('Settings › Controller: the half tilt has no button by default, can take one (with the same conflict handling)', () => {
  for (const p of PAD_PRESETS) assert.equal(padMap({ preset: p.id }).sneak, '', p.id);
  assert.equal(padMap(null).sneak, '');
  // on L3: nothing else had it
  const l3 = assignPad(null, 'sneak', 'LEFT_STICK');
  assert.deepEqual(l3.lost, []);
  assert.equal(padMap(l3.next).sneak, 'LEFT_STICK');
  // on LB / L1: the L button gives it up
  const lb = assignPad(null, 'sneak', 'LEFT_TOP_SHOULDER');
  assert.deepEqual(lb.lost.map((l) => l.id), ['l']);
  assert.equal(padMap(lb.next).l, '');
  // on ZL / LT / L2: pause gives it up (Home still pauses)
  const zl = assignPad(null, 'sneak', 'LEFT_BOTTOM_SHOULDER');
  assert.deepEqual(zl.lost.map((l) => l.id), ['pause']);
  assert.ok(!Object.values(padActions(zl.next)).includes('sneak') && padActions(zl.next)[16] === 'pause');
  // a controller binding switched off stays tidy (no "NONE" stored for a button that has none by default)
  assert.equal(lb.next.map.sneak, 'LEFT_TOP_SHOULDER');
  assert.equal(assignPad(null, 'a', 'BUTTON_1').next.map.sneak, undefined);
});

test('the 3DS player sends the capped Circle Pad and reads the half-tilt key and button from the settings', () => {
  const src = read('web/lib/ctrplayer.mjs');
  assert.match(src, /import \{ CTR_BIT, ctrInput \} from '\/shared\/ctrinput\.mjs';/);
  assert.match(src, /ctrInput\(\{ \.\.\.inp, slow: inp\.slowKey \|\| inp\.slowPad \|\| inp\.slowTest \}\)/);
  assert.match(src, /halfTiltKey = controls\.resolve\(config\?\.controls\)\.sneak;/);
  assert.match(src, /inp\.slowPad = !controls\.appHasPad\(\) && slow !== undefined/);
  // a controller binding that is no joypad button never presses one (1 << undefined is B)
  assert.match(src, /pad\.buttons\[i\]\?\.pressed && btn in BIT\) bits \|= 1 << BIT\[btn\]/);
  // let go with the window's focus, and when the settings change
  assert.equal((src.match(/inp\.slowKey = false;/g) || []).length, 3);
  // the other players: only joypad buttons
  assert.match(read('web/lib/nativeplayer.mjs'), /btn in BIT\) bits \|= 1 << BIT\[btn\]/);
  assert.match(read('web/player.html'), /c\.BUTTONS\.filter\(c\.isJoypad\)/);
});

test('Help › Controls & shortcuts and Settings show the half tilt, in all five languages', () => {
  assert.match(read('web/views/guide.mjs'), /k\('sneak'\)/);
  assert.match(read('web/views/guide.mjs'), /sneak: t\('ctl\.sneak', 'Circle Pad: half tilt \(sneak\)'\)/);
  assert.match(read('web/views/settings/controls.mjs'), /'3ds': '3DS'/);
  for (const lang of ['en', 'de', 'fr', 'es', 'it']) {
    const j = JSON.parse(read(`web/i18n/${lang}.json`));
    for (const k of ['ctl.sneak', 'ctl.sneakHint', 'keys.sneak', 'pad.sneak']) assert.ok(j[k] && j[k].trim(), `${lang}: ${k}`);
  }
});
