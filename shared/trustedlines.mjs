// "Most trusted" on the profile is a Pokémon LINE (API.md §2.2 showcase.trusted: { species, line, note, teams,
// top_level, fell }): the picker offers the lines this computer's runs relied on most – "your regulars" – each with how
// many teams it was on, its highest level and how often it fell; the numbers come from the same runs and update
// themselves (server/lib/accounts/index.mjs refreshes them while "Show my runs on my profile" is on).
// Pure functions over the trophy digests (shared/trophies.mjs digestRun) and PokeAPI's evolvesFrom table
// (shared/data/pokeapi.json: index = species id, value = the species it evolves from, 0 = none).

export const SPECIES_MAX = 1025;
export const TRUSTED_NOTE_MAX = 60;
/** How many regulars the picker shows. */
export const REGULARS = 12;

const isSpecies = (id) => Number.isInteger(id) && id >= 1 && id <= SPECIES_MAX;

/** The first species of the evolution line of `id` (Swampert → Mudkip), or `id` itself. */
export function lineRoot(id, evolvesFrom) {
  let cur = id;
  for (let i = 0; i < 4; i++) {
    const prev = evolvesFrom?.[cur];
    if (!isSpecies(prev)) break;
    cur = prev;
  }
  return cur;
}

/** How many steps `id` is from its line's first species (Mudkip 0, Marshtomp 1, Swampert 2). */
export function stage(id, evolvesFrom) {
  let d = 0;
  for (let cur = id; d < 4; d++) {
    const prev = evolvesFrom?.[cur];
    if (!isSpecies(prev)) break;
    cur = prev;
  }
  return d;
}

/**
 * Every line this computer caught, most relied-on first: [{ line, species, teams, top, fell, caught, nicknames, runs }].
 * `species` is the form it was used as most (the further one on a tie), `teams` the runs it was caught in, `top` the
 * highest level, `fell` how many of its catches died, `nicknames` up to four, `runs` up to three run names.
 */
export function trustedLines(digests, evolvesFrom) {
  const lines = new Map();
  for (const d of digests || []) {
    for (const c of d?.catches || []) {
      const sp = isSpecies(c.species) ? c.species : isSpecies(c.first) ? c.first : null;
      if (!sp) continue;
      const root = lineRoot(isSpecies(c.first) ? c.first : sp, evolvesFrom);
      const l = lines.get(root) || { line: root, forms: new Map(), runs: new Map(), nicknames: new Set(), top: 0, fell: 0, caught: 0 };
      l.caught++;
      l.forms.set(sp, (l.forms.get(sp) || 0) + 1);
      if (d.id != null) l.runs.set(d.id, d.name || '');
      if (c.nickname && l.nicknames.size < 4) l.nicknames.add(c.nickname);
      if (Number.isFinite(c.level) && c.level > l.top) l.top = Math.min(100, c.level);
      if (c.dead) l.fell++;
      lines.set(root, l);
    }
  }
  return [...lines.values()].map((l) => {
    const species = [...l.forms.entries()].sort((a, b) => b[1] - a[1] || stage(b[0], evolvesFrom) - stage(a[0], evolvesFrom) || a[0] - b[0])[0][0];
    const teams = l.runs.size;
    return { line: l.line, species, teams, top: l.top, fell: l.fell, caught: l.caught, nicknames: [...l.nicknames], runs: [...new Set(l.runs.values())].filter(Boolean).slice(0, 3),
      score: teams * 10 + l.top / 4 + (l.caught - l.fell) * 3 };
  }).sort((a, b) => b.score - a.score || a.line - b.line).map(({ score: _s, ...l }) => l);
}

/** The numbers the service stores for one line: { teams, top_level, fell }, or null when the runs don't know it. */
export function lineNumbers(line, digests, evolvesFrom) {
  const l = trustedLines(digests, evolvesFrom).find((x) => x.line === line);
  return l ? { teams: Math.min(10000, l.teams), top_level: Math.max(1, Math.min(100, l.top || 1)), fell: Math.min(10000, l.fell) } : null;
}
