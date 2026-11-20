// "Most trusted" on the profile: the Pokémon a free-text line names (web/lib/trusted.mjs) – its sprite replaces the old
// heart – in any of the app's languages, as a whole word, the first one in the line; nothing for a line without one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { speciesInText, splitTrusted } from '../web/lib/trusted.mjs';

const { names } = JSON.parse(readFileSync(new URL('../shared/data/pokeapi.json', import.meta.url), 'utf8'));

test('finds the species a trusted line names, in every app language', () => {
  assert.equal(speciesInText('Breloom line – on 6 teams, fell once (Crystal, to Whitney)', names), 286);
  assert.equal(speciesInText('Kapilz-Linie – nie gefallen', names), 286); // German, the editor's "{name} line"
  assert.equal(speciesInText('Gyarados – the Magikarp that made it, every time', names), 130); // the first one wins
  assert.equal(speciesInText('my ol’ reliable: GARCHOMP', names), 445); // any case
  assert.equal(speciesInText('Ligne de Flabébé', names), 669); // accents
  assert.equal(speciesInText('Mr. Mime carried the run', names), 122); // longest name at the same place
  assert.equal(speciesInText('Nidoran♀ forever', names), 29);
});

test('only whole words, and nothing when no Pokémon is named', () => {
  assert.equal(speciesInText('the starter that never fell', names), null);
  assert.equal(speciesInText('Pikachuuu', names), null); // not a word of its own
  assert.equal(speciesInText('', names), null);
  assert.equal(speciesInText('Breloom', null), null); // data not loaded yet
});

test('splits the line into the name part and the story', () => {
  assert.deepEqual(splitTrusted('Breloom line – on 6 teams, fell once'), { head: 'Breloom line', rest: 'on 6 teams, fell once' });
  assert.deepEqual(splitTrusted('Ho-Oh: never lost a fight'), { head: 'Ho-Oh', rest: 'never lost a fight' });
  assert.deepEqual(splitTrusted('Porygon-Z, obviously'), { head: null, rest: 'Porygon-Z, obviously' });
});
