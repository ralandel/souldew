// The rail (owner's choice "B – by use", web/lib/railnav.mjs + app.mjs): every entry is still there, the three daily
// ones first with a line under Nuzlocke, souldew+ replaced "Buy me a coffee" and leads to its own page, Settings and
// Help moved to the foot – still reachable by keyboard and controller (the foot row is a .nav like the rest).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NAV_GROUPS, FOOT_SECTIONS, RAIL_ROUTES, railGroups } from '../web/lib/railnav.mjs';

const app = readFileSync(new URL('../web/app.mjs', import.meta.url), 'utf8');
const css = readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');

test('order: Library, SoulLink, Nuzlocke – a line – Friends, Trophies – a line – Connection, Stream', () => {
  assert.deepEqual(NAV_GROUPS, [['library', 'soullink', 'nuzlocke'], ['friends', 'trophies'], ['link', 'stream']]);
  assert.deepEqual(FOOT_SECTIONS, ['settings', 'guide']);
  // nothing that was in the rail is gone, and the rail reaches the souldew+ page
  for (const id of ['library', 'soullink', 'nuzlocke', 'link', 'friends', 'stream', 'trophies', 'settings', 'guide', 'plus']) assert.ok(RAIL_ROUTES.includes(id), id);
});

test('signed out: no Friends entry, no empty group', () => {
  const out = new Set(['library', 'soullink', 'nuzlocke', 'link', 'stream', 'trophies', 'settings', 'guide']);
  assert.deepEqual(railGroups(out), [['library', 'soullink', 'nuzlocke'], ['trophies'], ['link', 'stream']]);
  assert.deepEqual(railGroups(new Set(['library'])), [['library']]);
  assert.deepEqual(railGroups(), NAV_GROUPS);
});

test('routing: #/plus is the souldew+ page; every "Get souldew+" leads there, "Buy me a coffee" is gone from the rail', () => {
  assert.match(app, /plus: PlusView, thanks: ThanksView, handheld: HandheldView \}\[route\.route\]/);
  assert.match(app, /href="#\/plus"/);
  // souldew Renaissance (no account, no souldew+): the rail's souldew+ entry is "Buy me a coffee" again – only there
  assert.doesNotMatch(app, /CoffeeLink/);
  assert.equal((app.match(/rail\.coffee'/g) || []).length, 1);
  assert.match(app, /if \(!EDITION\.accounts\) \{[\s\S]*?openExternal\(LINKS\.coffee\)/);
  const social = readFileSync(new URL('../web/lib/socialapp.mjs', import.meta.url), 'utf8');
  assert.match(social, /setPlusHandler\(\(\) => navigate\('plus'\)\)/, 'signed in or not, never Settings or a pop-up');
});

test('the foot row is a .nav: hover light, active pill, skins and the controller\'s shoulder buttons reach Settings and Help', () => {
  assert.match(app, /<div class="nav rail-tools"/);
  assert.match(app, /aria-label=\$\{n\.label\}/, 'icon buttons carry their label for screen readers');
  const pad = readFileSync(new URL('../web/lib/padnav.mjs', import.meta.url), 'utf8');
  assert.match(pad, /querySelectorAll\('\.nav a\[href\]'\)/);
  assert.match(css, /\.nav-rule \{/);
  assert.match(css, /\.nav\.rail-tools \{/);
  // the coffee moments stayed with souldew+ and still keep still for reduced motion
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.cfx \{ display: none; \} \.rail-plus\.cfx-live \.rail-plus-mark \{ animation: none; \} \}/);
});
