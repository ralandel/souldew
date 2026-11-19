// Runs of up to 8 players (shared/edition.mjs → maxPlayers): every slot pattern, colour and layout covers them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EDITION } from '../shared/edition.mjs';
import { ALL_SLOTS, MAX_PLAYERS, slotsOf, othersOf, defaultRunName } from '../shared/slots.mjs';
import { PLAYER_COLORS } from '../shared/streamapi.mjs';
import { overlaySize, slotVar } from '../shared/overlay.mjs';
import { runPlayers, checkPack } from '../server/lib/build.mjs';
import { SyncLink } from '../web/lib/sync.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const EIGHT = Object.fromEntries(ALL_SLOTS.map((s, i) => [s, { name: `Joueur ${i + 1}` }]));

test('the edition allows 8 players: slots p1..p8', () => {
  assert.equal(EDITION.maxPlayers, 8);
  assert.equal(MAX_PLAYERS, 8);
  assert.deepEqual([...ALL_SLOTS], ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']);
});

test('a run of 8: slots, partners, name, build request, invite pack', () => {
  const manifest = { mode: 'soullink', players: EIGHT };
  assert.equal(slotsOf(manifest).length, 8);
  assert.equal(othersOf('p5', manifest).length, 7);
  assert.match(defaultRunName(EIGHT), /^Joueur 1, .* & Joueur 8$/);
  const r = runPlayers({ players: EIGHT });
  assert.deepEqual(r.slots, [...ALL_SLOTS]);
  assert.equal(r.players.p8.name, 'Joueur 8');
  // a gap is still refused, and a slot beyond the last one is not a player
  assert.throws(() => runPlayers({ players: { p1: {}, p2: {}, p4: {} } }), /without gaps/);
  assert.deepEqual(runPlayers({ players: { ...EIGHT, p9: { name: 'Neuf' } } }).slots, [...ALL_SLOTS]);
  const pack = checkPack({ room: 'room-0123456789', secret: 'SECRET-ROOM-KEY', players: EIGHT });
  assert.deepEqual(Object.keys(pack.players), [...ALL_SLOTS]);
});

test('sync: without the run\'s slots, every other slot is a partner', () => {
  const l = new SyncLink({ room: 'r', secret: 's', slot: 'p3', name: 'p3', doc: {} });
  assert.equal(l.others.length, MAX_PLAYERS - 1);
  assert.ok(l.others.includes('p8') && !l.others.includes('p3'));
});

function sources() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (!['vendor', 'assets', 'i18n', 'node_modules'].includes(name)) walk(p);
      } else if (/\.(mjs|cjs|js|html)$/.test(name)) out.push(p);
    }
  };
  for (const d of ['server', 'shared', 'web', 'electron']) walk(join(ROOT, d));
  return out;
}

test('every slot pattern in the code covers all slots (p[1-N] with N = MAX_PLAYERS)', () => {
  const wrong = [];
  for (const f of sources()) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/p\[1-(\d)\]/g)) if (Number(m[1]) !== MAX_PLAYERS) wrong.push(`${relative(ROOT, f).split(sep).join('/')}: ${m[0]}`);
  }
  assert.deepEqual(wrong, []);
  const re = new RegExp(`^p[1-${MAX_PLAYERS}]$`);
  for (const s of ALL_SLOTS) assert.ok(re.test(s), s);
});

test('every slot has its colour: app themes, overlays, stream API', () => {
  const css = read('web/styles.css');
  const block = (sel) => css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)));
  for (const s of ALL_SLOTS) {
    assert.match(block(':root {'), new RegExp(`--${s}:`), `:root --${s}`);
    for (const theme of ['contrast', 'deutan', 'tritan']) {
      // p1/p2 follow --crs/--sqr, which every scheme sets; the others are set per scheme
      const b = block(`html[data-theme='${theme}'] {`);
      assert.ok(s === 'p1' || s === 'p2' ? /--crs:/.test(b) && /--sqr:/.test(b) : new RegExp(`--${s}:`).test(b), `${theme} --${s}`);
    }
    assert.match(css, new RegExp(`\\.who-${s} \\{`), `.who-${s}`);
    assert.match(css, new RegExp(`\\.player-tag\\.${s} \\.who`), `.player-tag.${s}`);
    assert.match(read('web/overlay.html'), new RegExp(`--${s}:`), `overlay --${s}`);
    assert.match(PLAYER_COLORS[s] || '', /^#[0-9a-f]{6}$/, `PLAYER_COLORS.${s}`);
    assert.equal(slotVar(s), `var(--${s})`);
  }
});

test('layouts for 5–8 players: board head strip, columns, routes, sidebar', () => {
  const css = read('web/session-info.css');
  for (let n = 5; n <= MAX_PLAYERS; n++) {
    assert.match(css, new RegExp(`\\.board-head\\.multi\\.n${n}::before`), `strip n${n}`);
    for (const sel of ['board-head', 'group-mons', 'team-cols', 'routes-wrap', 'pairs', 'death-mons']) {
      assert.match(css, new RegExp(`\\.${sel}:is\\([^)]*\\.n${n}\\b`), `${sel} n${n}`);
    }
  }
});

test('overlays size their widgets for up to 8 players', () => {
  assert.ok(overlaySize('team', 8, { layout: 'v' })[0] > overlaySize('team', 4, { layout: 'v' })[0]);
  assert.deepEqual(overlaySize('team', 20), overlaySize('team', MAX_PLAYERS));
});
