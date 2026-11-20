// Interface size (shared/uiscale.mjs, web/lib/uiscale.mjs, electron/main.mjs): "I play on a bigger monitor with a
// higher pixel count … the UI is unreadable and too small" (a player on Discord). The sizes, what a small window shows,
// the shortcuts and how they give way to the game's, the one-time hint on a big screen, the window's own buttons, and the
// setting in config.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UI_SCALES, MIN_VIEW, validUiScale, uiScaleLabel, fitUiScale, stepUiScale, uiScaleKey, suggestUiScale, windowChromeAt } from '../shared/uiscale.mjs';
import { resolveHotkeys, hotkeyOf } from '../web/lib/controls.mjs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('the sizes: 80–175 %, anything else stored or sent is 100 %', () => {
  assert.deepEqual(UI_SCALES, [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75]);
  for (const v of UI_SCALES) assert.equal(validUiScale(v), v);
  assert.equal(validUiScale('1.25'), 1.25);
  for (const v of [undefined, null, 0, 2, 3, 1.3, -1, 'big', {}, [], NaN, Infinity]) assert.equal(validUiScale(v), 1, String(v));
  assert.equal(uiScaleLabel(1.25), '125 %');
  assert.equal(uiScaleLabel(0.8), '80 %');
  assert.equal(uiScaleLabel(7), '100 %');
});

test('a window too small for the size shows the biggest one that leaves the room the interface needs', () => {
  // 4K and 1440p windows take every size
  for (const v of UI_SCALES) {
    assert.equal(fitUiScale(v, { w: 3840, h: 2160 }), v);
    assert.equal(fitUiScale(v, { w: 2560, h: 1440 }), v);
  }
  assert.equal(fitUiScale(1.75, { w: 1920, h: 1050 }), 1.5, 'a 1080p screen');
  assert.equal(fitUiScale(1.75, { w: 1280, h: 800 }), 1.25, 'Steam Deck');
  assert.equal(fitUiScale(1.5, { w: 1000, h: 700 }), 1, 'the smallest window');
  assert.equal(fitUiScale(1.1, { w: 1078, h: 704 }), 1.1, 'exactly the room it needs');
  // 100 % and smaller always apply; an unknown window size takes the chosen one
  assert.equal(fitUiScale(0.8, { w: 500, h: 400 }), 0.8);
  assert.equal(fitUiScale(1.75, null), 1.75);
  // what is shown never leaves less than MIN_VIEW
  for (const w of [980, 1100, 1280, 1440, 1600, 1920, 2560]) {
    for (const h of [640, 800, 900, 1080, 1440]) {
      for (const v of UI_SCALES) {
        const f = fitUiScale(v, { w, h });
        assert.ok(f <= v);
        if (f > 1) assert.ok(w / f >= MIN_VIEW.w - 0.5 && h / f >= MIN_VIEW.h - 0.5, `${w}×${h} ${v} → ${f}`);
      }
    }
  }
});

test('stepping: one size up or down from what is shown, ⌘0 back to 100 %', () => {
  assert.equal(stepUiScale(1, 'in'), 1.1);
  assert.equal(stepUiScale(1.1, 'in'), 1.25);
  assert.equal(stepUiScale(1.75, 'in'), 1.75);
  assert.equal(stepUiScale(1, 'out'), 0.9);
  assert.equal(stepUiScale(0.8, 'out'), 0.8);
  assert.equal(stepUiScale(1.5, 'reset'), 1);
  assert.equal(stepUiScale(1.25, 'sideways'), 1.25);
});

test('the shortcuts: ⌘ on a Mac, Ctrl elsewhere – +, =, −, 0 and the keypad, on any keyboard layout', () => {
  const mac = (o) => uiScaleKey({ meta: true, ...o }, true);
  const pc = (o) => uiScaleKey({ ctrl: true, ...o }, false);
  // US "=" / German "+" (keyCode 187), Shift+= is "+"
  assert.equal(mac({ keyCode: 187, key: '=' }), 'in');
  assert.equal(mac({ keyCode: 187, key: '+', shift: true }), 'in');
  assert.equal(pc({ keyCode: 187, key: '+' }), 'in');
  assert.equal(pc({ keyCode: 107, key: '+', code: 'NumpadAdd' }), 'in');
  assert.equal(pc({ keyCode: 189, key: '-' }), 'out');
  assert.equal(pc({ keyCode: 109, key: '-', code: 'NumpadSubtract' }), 'out');
  assert.equal(mac({ keyCode: 48, key: '0' }), 'reset');
  assert.equal(pc({ keyCode: 96, key: '0', code: 'Numpad0' }), 'reset');
  // Shift+0 is "=" on a German keyboard – no shortcut; nor Shift+−
  assert.equal(pc({ keyCode: 48, key: '=', shift: true }), null);
  assert.equal(pc({ keyCode: 189, key: '_', shift: true }), null);
  // a layout with + / − elsewhere: the character
  assert.equal(pc({ keyCode: 0, key: '+' }), 'in');
  assert.equal(pc({ keyCode: 54, key: '-' }), 'out');
  // the wrong modifier, Alt, both, none
  assert.equal(uiScaleKey({ ctrl: true, keyCode: 187 }, true), null, 'Ctrl on a Mac');
  assert.equal(uiScaleKey({ meta: true, keyCode: 187 }, false), null, 'the Windows key');
  assert.equal(mac({ keyCode: 187, alt: true }), null);
  assert.equal(mac({ keyCode: 187, ctrl: true }), null);
  assert.equal(uiScaleKey({ keyCode: 187, key: '+' }, false), null, 'plain + is the volume while playing');
  assert.equal(pc({ keyCode: 82, key: 'r' }), null);
  // a DOM event's own names work as well
  assert.equal(uiScaleKey({ ctrlKey: true, keyCode: 48, key: '0' }, false), 'reset');
  assert.equal(uiScaleKey(null, false), null);
});

test('the game’s shortcuts go first: by default ⌘+ / ⌘− stay its speed while it fills the window', () => {
  for (const mac of [true, false]) {
    const hot = resolveHotkeys(null, undefined, mac);
    const mod = mac ? { meta: true } : { ctrl: true };
    // the same key presses are both – so the play view says which ones are its own
    assert.equal(hotkeyOf({ keyCode: 187, key: '=', ...mod }, hot), 'faster');
    assert.equal(uiScaleKey({ keyCode: 187, key: '=', ...mod }, mac), 'in');
    assert.equal(hotkeyOf({ keyCode: 189, key: '-', ...mod }, hot), 'slower');
    assert.equal(uiScaleKey({ keyCode: 189, key: '-', ...mod }, mac), 'out');
    // ⌘0 is no game shortcut by default
    assert.equal(hotkeyOf({ keyCode: 48, key: '0', ...mod }, hot), null);
    // re-bound elsewhere, ⌘+ is the interface's in the game too; a shortcut put on ⌘0 takes it there
    const moved = resolveHotkeys({ faster: { keyCode: 190, key: '.' }, load1: { keyCode: 48, key: '0', ...mod } }, undefined, mac);
    assert.equal(hotkeyOf({ keyCode: 187, key: '=', ...mod }, moved), null);
    assert.equal(hotkeyOf({ keyCode: 48, key: '0', ...mod }, moved), 'load1');
  }
  const play = read('web/views/play.mjs');
  // the page's keys: the play view claims the ones its onKey would act on (shown big, a shortcut, no field or dialog)
  assert.match(play, /setPlayKeys\(\(k\) => modeRef\.current === 'full' && !notGame\(k\.target\) && !!hotkeyOf\(k, hotRef\.current\)\)/);
  // keys from inside the game frame: only when no shortcut took them
  assert.match(play, /if \(!id\) return !!fromGame && uiScaleKeyDown\(k, \{ fromGame: true \}\);/);
  const lib = read('web/lib/uiscale.mjs');
  assert.match(lib, /if \(!fromGame && playKeys\?\.\(k\)\) return false;/);
  // in a browser the browser's own zoom keeps the keys
  assert.match(lib, /export function uiScaleKeyDown[^]*?if \(!uiScaleNative\(\)\) return false;/);
  assert.match(read('web/app.mjs'), /watchUiScaleKeys\(\{ onLimit: uiScaleLimited \}\)/);
});

test('the menu shows the keys but never takes one: the page decides (the game’s shortcuts first)', () => {
  const main = read('electron/main.mjs');
  const view = main.slice(main.indexOf("label: l('view'"), main.indexOf("label: l('go'"));
  const items = view.match(/\{ label: [^\n]*\}/g);
  assert.equal(items.length, 3);
  for (const it of items) {
    assert.match(it, /registerAccelerator: false/, it);
    assert.match(it, /click: \(\) => send\('menu', 'ui-(in|out|reset)'\)/, it);
  }
  // no role that zooms by itself (Chromium's own zoom would bypass the setting)
  assert.doesNotMatch(main, /role: '(zoomIn|zoomOut|resetZoom|viewMenu)'/);
  assert.match(read('web/app.mjs'), /if \(what === 'ui-in' \|\| what === 'ui-out' \|\| what === 'ui-reset'\) stepUi\(what\.slice\(3\)/);
});

test('the window: the size from config.json from the first picture on, checked, and the window’s own buttons move with it', () => {
  const main = read('electron/main.mjs');
  assert.match(main, /ui\.chosen = validUiScale\(readConfig\(\)\.uiScale\);/);
  assert.match(main, /zoomFactor: ui\.applied,/);
  assert.match(main, /handle\('ui-scale', \(e, v\) => \{\n\s+if \(v !== undefined\) ui\.chosen = validUiScale\(v\);/);
  assert.match(main, /win\.on\('resize', applyUiScale\);/);
  // the page may only ask through the preload's one call and hear the one channel
  const pre = read('electron/preload.cjs');
  assert.match(pre, /uiScale: \(v\) => \(v === undefined \? ipcRenderer\.invoke\('ui-scale'\) : ipcRenderer\.invoke\('ui-scale', v\)\),/);
  assert.match(pre, /'fullscreen', 'ui-scale'\]\.includes\(channel\)/);
  // at 100 % exactly the old traffic-light position and Windows title bar height
  assert.deepEqual(windowChromeAt(1), { lights: { x: 16, y: 18 }, titleBar: 36 });
  assert.deepEqual(windowChromeAt(1.5), { lights: { x: 24, y: 27 }, titleBar: 54 });
  assert.deepEqual(windowChromeAt(0.8), { lights: { x: 13, y: 14 }, titleBar: 29 });
  assert.deepEqual(windowChromeAt('junk'), windowChromeAt(1));
});

test('the hint: once, quietly, on a large screen at 100 % with the window big on it – a size that fits', () => {
  const win = { w: 3840, h: 2100 };
  assert.equal(suggestUiScale({ display: { w: 3840, h: 2160, scale: 1 }, win }), 1.5, '4K at 100 %');
  assert.equal(suggestUiScale({ display: { w: 5120, h: 2880, scale: 1 }, win }), 1.5, '5K at 100 %');
  assert.equal(suggestUiScale({ display: { w: 2560, h: 1440, scale: 1 }, win: { w: 2560, h: 1400 } }), 1.25, '1440p at 100 %');
  assert.equal(suggestUiScale({ display: { w: 3440, h: 1440, scale: 1 }, win: { w: 3440, h: 1400 } }), 1.25, 'ultrawide 1440p');
  assert.equal(suggestUiScale({ display: { w: 2160, h: 3840, scale: 1 }, win: { w: 2100, h: 3800 } }), 1.5, 'portrait 4K');
  // a Retina Mac's "looks like 2560 × 1440": the system already picked the size
  assert.equal(suggestUiScale({ display: { w: 2560, h: 1440, scale: 2 }, win: { w: 2560, h: 1400 } }), null);
  // 4K at 150 % (Windows' own scaling) is a 2560 × 1440 screen in points – the OS sized it already
  assert.equal(suggestUiScale({ display: { w: 2560, h: 1440, scale: 1.5 }, win: { w: 2560, h: 1400 } }), 1.25);
  // 1080p, a laptop, a small window, a size already picked, nothing known
  assert.equal(suggestUiScale({ display: { w: 1920, h: 1080, scale: 1 }, win: { w: 1920, h: 1040 } }), null);
  assert.equal(suggestUiScale({ display: { w: 1440, h: 900, scale: 2 }, win: { w: 1440, h: 860 } }), null);
  assert.equal(suggestUiScale({ display: { w: 3840, h: 2160, scale: 1 }, win: { w: 1360, h: 880 } }), null);
  assert.equal(suggestUiScale({ display: { w: 3840, h: 2160, scale: 1 }, win, chosen: 1.25 }), null);
  assert.equal(suggestUiScale({ display: { w: 3840, h: 2160, scale: 1 }, win, chosen: 0.9 }), null);
  assert.equal(suggestUiScale({}), null);
  // the suggestion fits the window
  assert.equal(suggestUiScale({ display: { w: 3840, h: 2160, scale: 1 }, win: { w: 1700, h: 1000 } }), 1.5);
  assert.equal(suggestUiScale({ display: { w: 3840, h: 2160, scale: 1 }, win: { w: 1600, h: 900 } }), 1.25);
  // asked once per computer: the page stores it when it shows the hint, whatever the answer
  const app = read('web/app.mjs');
  assert.match(app, /status\.config\.uiScaleHint\) return;/);
  assert.match(app, /api\.post\('\/api\/config', \{ uiScaleHint: true \}\)/);
  assert.match(app, /suggestUiScale\(uiScale\)/);
});

test('server: uiScale and its hint are stored per computer, checked', async () => {
  const DATA = mkdtempSync(join(tmpdir(), 'sls-uiscale-'));
  process.env.SLS_DATA_DIR = DATA;
  const { startServer } = await import('../server/app.mjs');
  const { server, url } = await startServer({ port: 0, background: false });
  const headers = { 'content-type': 'application/json', 'x-soullink': '1' };
  const post = (body) => fetch(`${url}/api/config`, { method: 'POST', headers, body: JSON.stringify(body) }).then((r) => r.json());
  const status = () => fetch(`${url}/api/status`, { headers }).then((r) => r.json());
  try {
    let c = (await status()).config;
    assert.equal(c.uiScale, 1);
    assert.equal(c.uiScaleHint, false);
    assert.equal((await post({ uiScale: 1.5 })).uiScale, 1.5);
    assert.equal((await status()).config.uiScale, 1.5);
    assert.equal((await post({ uiScale: 40 })).uiScale, 1, 'nothing but a size');
    assert.equal((await post({ uiScale: '<script>' })).uiScale, 1);
    assert.equal((await post({ uiScaleHint: 'yes' })).uiScaleHint, false);
    assert.equal((await post({ uiScaleHint: true })).uiScaleHint, true);
    c = JSON.parse(readFileSync(join(DATA, 'config.json'), 'utf8'));
    assert.equal(c.uiScaleHint, true);
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(DATA, { recursive: true, force: true });
  }
});

test('Settings, Help and the texts', () => {
  const general = read('web/views/settings/general.mjs');
  assert.match(general, /<\$\{Item\} id="ui-scale"><\$\{UiScaleSetting\} cfg=\$\{cfg\} \/><\/\/>/);
  assert.match(general, /onClick=\$\{\(\) => setUiScale\(v\)\}/);
  assert.match(read('web/views/guide.mjs'), /uiScaleKeys\(\{ space: true \}\)/);
  const en = JSON.parse(read('web/i18n/en.json'));
  const keys = ['set.uiScale', 'set.uiScaleHint', 'set.uiScaleFit', 'set.uiScaleGame', 'set.uiScaleBrowser', 'ui.scaleHintTitle', 'ui.scaleHintText', 'ui.scaleHintYes',
    'ui.scaleLimitTitle', 'ui.scaleLimitText', 'keys.uiScale', 'menu.view', 'menu.uiBigger', 'menu.uiSmaller', 'menu.uiReset'];
  assert.equal(en['ui.scaleHintTitle'], 'The interface looks small on this screen – make it bigger?');
  for (const lang of ['de', 'fr', 'es', 'it']) {
    const tr = JSON.parse(read(`web/i18n/${lang}.json`));
    for (const k of keys) {
      assert.ok(tr[k], `${lang}: ${k}`);
      for (const v of en[k].match(/\{\w+\}/g) || []) assert.ok(tr[k].includes(v), `${lang}: ${k} keeps ${v}`);
    }
  }
});

test('the reset key without a keyCode (key/code only) still resets', () => {
  assert.equal(uiScaleKey({ key: '0', ctrl: true }, false), 'reset');
  assert.equal(uiScaleKey({ key: '0', code: 'Numpad0', ctrl: true }, false), 'reset');
  assert.equal(uiScaleKey({ key: '0', meta: true }, true), 'reset');
  assert.equal(uiScaleKey({ key: '0', ctrl: true, shift: true }, false), null);
  assert.equal(uiScaleKey({ key: '0' }, false), null);
});
