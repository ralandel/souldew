// The showcase pickers' logic (web/views/showcase.mjs), pure so test/showcasepick.test.mjs checks it without a page:
// what the trophy cabinet lists and in what order, the three picks, and "any other Pokémon" by name.
import { RARITIES } from '/shared/trophies.mjs';
import { SPECIES_MAX } from '/shared/trustedlines.mjs';

const RANK = Object.fromEntries(RARITIES.map((r, i) => [r, i]));

/**
 * The earned trophies the cabinet shows: rarest first, then the newest, filtered by category, rarity and the search
 * words (in the achievement's name, `nameOf(a)` – the UI language).
 */
export function cabinetList(earned, { cat = 'all', rarity = 'all', q = '' } = {}, nameOf = (a) => a.id) {
  const words = q.trim().toLowerCase();
  return earned
    .filter((a) => (cat === 'all' || a.cat === cat) && (rarity === 'all' || a.rarity === rarity) && (!words || nameOf(a).toLowerCase().includes(words)))
    .sort((a, b) => (RANK[b.rarity] ?? 0) - (RANK[a.rarity] ?? 0) || (b.at || 0) - (a.at || 0) || a.id.localeCompare(b.id));
}

/** Toggle a trophy in the picks (catalog ids, in the order picked); one more than `max` is refused. */
export function togglePick(chosen, id, max = 3) {
  if (chosen.includes(id)) return chosen.filter((x) => x !== id);
  return chosen.length >= max ? chosen : [...chosen, id];
}

/** Pokémon whose name contains the words (two letters at least), in dex order – for "any other Pokémon". */
export function searchSpecies(q, nameOf, max = 12) {
  const words = String(q || '').trim().toLowerCase();
  if (words.length < 2) return [];
  const out = [];
  for (let id = 1; id <= SPECIES_MAX && out.length < max; id++) if ((nameOf(id) || '').toLowerCase().includes(words)) out.push(id);
  return out;
}
