// "I play using keyboard keys that are blocked by poorly chosen keybinds that cannot be changed – R has been my B button
// for ten years, now it is locked for reset" (a player on Discord, 2.8.1). Since 2.8.2 every key the players act on
// while a game runs is a shortcut of Settings › Controls (lib/controls.mjs HOTKEYS): re-bindable, switchable off, and a
// game button may take its key. These checks keep it that way – a key handled anywhere else, an EmulatorJS or RetroArch
// hotkey, or a menu accelerator that grabs a key would be an unchangeable shortcut again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HOTKEYS, HOTKEY_IDS, HOTKEY_ROWS, PAD_HOTKEY_IDS, ejsControls, BUTTONS } from '../web/lib/controls.mjs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
/** The body of `name = …((args) => {` / `function name(` up to its closing brace at the same indentation. */
function body(src, start) {
  const i = src.indexOf(start);
  assert.ok(i >= 0, `not found: ${start}`);
  const indent = /^ */.exec(src.slice(src.lastIndexOf('\n', i) + 1))[0];
  const end = src.indexOf(`\n${indent}}`, i);
  return src.slice(i, end);
}
// a key compared with a literal: e.key === 'p', k.code === 'F5', keyCode === 82, /^[1-4]$/.test(k.key) …
const KEY_LITERAL = /\b(?:key|code|keyCode)\s*===?\s*(?:'[^']*'|"[^"]*"|\d+)|['"][^'"]*['"]\s*===?\s*\w+\.(?:key|code)\b|\.test\(\s*\w+\.(?:key|code)\b/;
const literals = (src) => src.match(new RegExp(KEY_LITERAL.source, 'g')) || [];

test('every shortcut has its row in Settings › Controls (and Help) – exactly once', () => {
  const rows = HOTKEY_ROWS.flatMap((r) => r.ids);
  assert.deepEqual([...rows].sort(), [...HOTKEY_IDS].sort());
  assert.equal(new Set(rows).size, rows.length);
  // every one has a default and a name
  for (const h of HOTKEYS) assert.ok(h.keys.length, h.id);
  const guide = read('web/views/guide.mjs');
  const names = body(guide, 'export function hotkeyLabel(id) {');
  for (const id of HOTKEY_IDS.filter((x) => !/^(save|load)\d$/.test(x))) assert.match(names, new RegExp(`\\b${id}: t\\(`), `${id} has a name`);
  assert.match(names, /\^\(save\|load\)\(\\d\)\$/);
  // Settings and Help draw the table from these rows
  assert.match(read('web/views/settings/controls.mjs'), /\$\{HOTKEY_ROWS\.map\(\(r\) => \{/);
  assert.match(guide, /\.\.\.HOTKEY_ROWS\.map\(/);
  // the controller's shortcuts are shortcuts of the same list
  for (const id of PAD_HOTKEY_IDS) assert.ok(HOTKEY_IDS.includes(id), id);
});

test('the play view acts on no key of its own – only on the shortcuts of Settings › Controls', () => {
  const play = read('web/views/play.mjs');
  const onKey = body(play, 'const onKey = useCallback((k, fromGame) => {');
  // the one fixed key: Escape answers the "Load state?" prompt over the game (as every prompt's Escape does), and Tab
  // keeps moving the focus on the page – both no shortcuts
  assert.deepEqual(literals(onKey), ["key === 'Escape'", "key === 'Tab'"]);
  assert.match(onKey, /const id = hotkeyOf\(k, hot\);/);
  assert.match(onKey, /HOTKEY_ACTIONS\[id\]\(act\.current\)/);
  // one action per shortcut
  const actions = body(play, 'export const HOTKEY_ACTIONS = {');
  for (const id of HOTKEY_IDS.filter((x) => !/^(save|load)\d$/.test(x))) assert.match(actions, new RegExp(`\\n  ${id}: \\(a\\) => `), id);
  assert.match(actions, /\[`save\$\{n\}`, \(a\) => a\.quicksave\(n\)\], \[`load\$\{n\}`, \(a\) => a\.quickload\(n\)\]/);
  // the page's own keydown (the game shown big) goes through onKey too
  const effect = body(play, '    const down = (e) => {');
  assert.match(effect, /onKey\(\{ key: e\.key, code: e\.code, keyCode: e\.keyCode, shift: e\.shiftKey, ctrl: e\.ctrlKey, alt: e\.altKey, meta: e\.metaKey/);
  assert.doesNotMatch(effect, KEY_LITERAL);
  // the play bar names each button's key as bound (or none) – no fixed "(P)" any more
  assert.doesNotMatch(play, /' \((?:P|R|T|F5|F8|F12|M|F|\+|–)\)'/);
});

test('the player pages handle no key themselves: game buttons from the table, every other key goes to the play view', () => {
  for (const f of ['web/lib/nativeplayer.mjs', 'web/lib/ctrplayer.mjs']) {
    const s = read(f);
    for (const type of ['keydown', 'keyup']) {
      const h = body(s, `addEventListener('${type}', (e) => {`);
      assert.match(h, /forwardKey\(e, (true|false)\);/, `${f} ${type} forwards`);
      assert.match(h, /keyMap\[e\.keyCode\]/, `${f} ${type}: game buttons from Settings › Controls`);
      assert.doesNotMatch(h, KEY_LITERAL, `${f} ${type}`);
    }
  }
  const html = read('web/player.html');
  const down = body(html, "  window.addEventListener('keydown', (e) => {");
  // (before the controls are read, Tab is the fast-forward key – its default)
  assert.deepEqual(literals(down), ["key === 'Tab'"]);
  assert.match(down, /controlsLib\.isHotkeyKey\(e, hotkeys\)/);
  // the 3DS and fast player pages are only shells around those modules
  for (const f of ['web/player3ds.html', 'web/playernative.html']) assert.doesNotMatch(read(f), /addEventListener\('key(down|up)'/, f);
});

test('EmulatorJS and RetroArch keep no hotkeys of their own: only the 12 game buttons, no direct keyboard', () => {
  const html = read('web/player.html');
  // EmulatorJS' extras (index 12 and up: L2/R2, the sticks, its hotkeys 24–29 on 1/2/3 …) are dropped once it runs
  assert.match(html, /for \(const n of Object\.keys\(p\)\) if \(Number\(n\) >= 12\) delete p\[n\];/);
  // the table souldew hands it: the 12 game buttons (RetroArch joypad 0–11), nothing else
  const t = ejsControls(null)[0];
  // (the 3DS half tilt is no joypad button – EmulatorJS never gets it)
  assert.deepEqual(Object.keys(t).map(Number).sort((a, b) => a - b), BUTTONS.filter((b) => b.ejs !== undefined).map((b) => b.ejs).sort((a, b) => a - b));
  assert.equal(Object.keys(t).length, 12);
  assert.ok(Object.keys(t).every((n) => Number(n) < 12));
  // the core's own keyboard (RetroArch's F1 menu, Space fast-forward, P pause, H reset …) stays off
  assert.match(html, /keyboardInput: 'disabled',/);
  assert.match(html, /altKeyboardInput: 'disabled',/);
});

test('the desktop menu only shows the emulator\'s keys – it never takes one from the game', () => {
  const main = read('electron/main.mjs');
  const emu = body(main, "      label: l('emulator', t('menu.emulator', 'Emulator')),");
  const items = emu.match(/\{ label: [^\n]*\}/g);
  for (const it of items.filter((x) => /click: emu\(/.test(x))) {
    assert.doesNotMatch(it, /accelerator:/, `${it}: the key comes from the page (shown())`);
    assert.match(it, /\.\.\.shown\('(\w+)'/, it);
  }
  assert.match(main, /\? \{ accelerator: k, registerAccelerator: false \} : \{\};/);
  // the page sends each of them – the keys of Settings › Controls
  const shown = [...emu.matchAll(/shown\('(\w+)'/g)].map((m) => m[1]);
  const app = read('web/app.mjs');
  const sent = /\[('[^\]]+')\]\.map\(\(id\) => \[id, accelerator\(hot\[id\]\[0\]\) \|\| ''\]\)/.exec(app)?.[1];
  assert.ok(sent, 'app.mjs sends the menu keys');
  assert.deepEqual(sent.split(', ').map((x) => x.replace(/'/g, '')).sort(), [...shown].sort());
  for (const id of shown) assert.ok(HOTKEY_IDS.includes(id), id);
});
