// The showcase's pickers: the trophy cabinet (rarest first, categories, rarity filters, three picks in order) and
// "Most trusted" – the lines this computer's runs relied on most, with teams, top level and fallen
// (shared/trustedlines.mjs), any other Pokémon by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const { cabinetList, togglePick, searchSpecies } = await import('../web/lib/showcasepick.mjs');
const { trustedLines, lineNumbers, lineRoot, stage } = await import('../shared/trustedlines.mjs');
const { evolvesFrom, names } = JSON.parse(readFileSync(new URL('../shared/data/pokeapi.json', import.meta.url), 'utf8'));

const earned = [
  { id: 'firstCatch', cat: 'journey', rarity: 'common', at: 5 },
  { id: 'hardcoreWin', cat: 'skill', rarity: 'legendary', at: 1 },
  { id: 'badges16', cat: 'journey', rarity: 'epic', at: 3 },
  { id: 'winSoulLink', cat: 'soullink', rarity: 'rare', at: 9 },
  { id: 'wins5', cat: 'skill', rarity: 'epic', at: 7 },
];

test('cabinet: rarest first, then the newest; category, rarity and search narrow it', () => {
  assert.deepEqual(cabinetList(earned).map((a) => a.id), ['hardcoreWin', 'wins5', 'badges16', 'winSoulLink', 'firstCatch']);
  assert.deepEqual(cabinetList(earned, { cat: 'journey' }).map((a) => a.id), ['badges16', 'firstCatch']);
  assert.deepEqual(cabinetList(earned, { rarity: 'epic' }).map((a) => a.id), ['wins5', 'badges16']);
  const name = (a) => ({ badges16: 'Two Regions, One Trainer', wins5: 'Seasoned Champion' }[a.id] || a.id);
  assert.deepEqual(cabinetList(earned, { q: '  two REGIONS ' }, name).map((a) => a.id), ['badges16']);
  assert.deepEqual(cabinetList(earned, { cat: 'fun' }), []);
});

test('cabinet: three picks in the order picked, a fourth is refused, a pick comes out again', () => {
  let c = [];
  for (const id of ['a', 'b', 'c', 'd']) c = togglePick(c, id);
  assert.deepEqual(c, ['a', 'b', 'c']);
  assert.deepEqual(togglePick(c, 'b'), ['a', 'c']);
  assert.deepEqual(togglePick(['a', 'c'], 'b'), ['a', 'c', 'b']);
});

test('most trusted: any Pokémon by name, two letters at least', () => {
  const en = (id) => names.en[id];
  assert.deepEqual(searchSpecies('swamp', en), [260]);
  assert.ok(searchSpecies('char', en).includes(4) && searchSpecies('char', en).includes(6));
  assert.deepEqual(searchSpecies('s', en), []);
  assert.equal(searchSpecies('a', en, 5).length, 0);
  assert.equal(searchSpecies('ar', en, 5).length, 5);
});

test('lines: an evolution line is one entry (Mudkip, Marshtomp and Swampert are the Swampert line)', () => {
  assert.equal(lineRoot(260, evolvesFrom), 258);
  assert.equal(lineRoot(258, evolvesFrom), 258);
  assert.equal(lineRoot(130, evolvesFrom), 129);
  assert.equal(stage(260, evolvesFrom), 2);
  assert.equal(lineRoot(9999, evolvesFrom), 9999, 'unknown ids stay as they are');
});

test('regulars: teams, top level, fallen and nicknames from the runs, most relied-on first', () => {
  const digests = [
    { id: 'r1', name: 'Emerald with Lou', catches: [{ species: 260, first: 258, level: 58, nickname: 'Marsh', dead: false }, { species: 130, first: 129, level: 40, dead: true }] },
    { id: 'r2', name: 'Hoenn Party', catches: [{ species: 259, first: 258, level: 33, nickname: 'Bog', dead: true }, { species: 41, first: 41, level: 9, dead: true }] },
    { id: 'r3', name: 'Crystal Clear', catches: [{ species: 260, first: 258, level: 51, nickname: 'Marsh', dead: false }] },
    { id: 'r4', name: 'odd', catches: [{ species: 0 }, { species: 'x' }] },
  ];
  const lines = trustedLines(digests, evolvesFrom);
  assert.deepEqual(lines.map((l) => l.line), [258, 129, 41]);
  assert.deepEqual(lines[0], { line: 258, species: 260, teams: 3, top: 58, fell: 1, caught: 3, nicknames: ['Marsh', 'Bog'], runs: ['Emerald with Lou', 'Hoenn Party', 'Crystal Clear'] });
  assert.deepEqual(lineNumbers(258, digests, evolvesFrom), { teams: 3, top_level: 58, fell: 1 });
  assert.deepEqual(lineNumbers(129, digests, evolvesFrom), { teams: 1, top_level: 40, fell: 1 });
  assert.equal(lineNumbers(25, digests, evolvesFrom), null, 'a line these runs never caught has no numbers');
  assert.deepEqual(trustedLines([], evolvesFrom), []);
});

test('regulars from the demo-like digests of a real run stay within the service\'s ranges', () => {
  const digests = [{ id: 'x', name: 'x', catches: Array.from({ length: 30 }, (_, i) => ({ species: 25, first: 172, level: 150 + i, dead: i % 2 === 0 })) }];
  const n = lineNumbers(172, digests, evolvesFrom);
  assert.deepEqual(n, { teams: 1, top_level: 100, fell: 15 });
});
