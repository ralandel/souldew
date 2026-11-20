// "Most trusted" on the profile used to be free text the player typed ("Breloom line – on 6 teams, fell once"); it is a
// Pokémon line now (shared/trustedlines.mjs), and an old text is shown as it was until a line replaces it. When it names a
// Pokémon – in any of the app's languages, the way the editor's quick picks write it ("Kapilz line", "Breloom-Linie") –
// the profile shows that Pokémon's sprite next to it (design "A – Logbook"); otherwise a neutral placeholder.
// Pure functions over the PokeAPI name table (shared/data/pokeapi.json `names`), so they test without a page.

const LANGS = ['en', 'de', 'fr', 'es', 'it'];
const fold = (s) => String(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const WORD = /[\p{L}\p{N}]/u;
const cache = new WeakMap();

/** [folded name, id] for every species name in the app's languages, longest first (so "Mr. Mime" beats "Mime"). */
function index(names) {
  if (cache.has(names)) return cache.get(names);
  const seen = new Map();
  for (const lang of LANGS) {
    for (const [id, name] of Object.entries(names?.[lang] || {})) {
      const n = Number(id);
      if (!Number.isInteger(n) || n < 1 || n > 10000 || typeof name !== 'string') continue;
      const f = fold(name).trim();
      if (f.length >= 3 && !seen.has(f)) seen.set(f, n);
    }
  }
  const list = [...seen].sort((a, b) => b[0].length - a[0].length);
  cache.set(names, list);
  return list;
}

/**
 * The species the text names first (the earliest whole-word match; at the same place the longer name), or null.
 * `names` is pokeapi.json's `names` table ({ en: { 1: 'Bulbasaur', … }, de: … }).
 */
export function speciesInText(text, names) {
  if (!text || !names) return null;
  const hay = fold(text);
  let best = null;
  for (const [name, id] of index(names)) {
    let from = 0;
    for (;;) {
      const at = hay.indexOf(name, from);
      if (at < 0 || (best && at > best.at)) break;
      const before = at > 0 ? hay[at - 1] : '';
      const after = hay[at + name.length] || '';
      if (!WORD.test(before) && !WORD.test(after)) {
        if (!best || at < best.at || (at === best.at && name.length > best.len)) best = { id, at, len: name.length };
        break;
      }
      from = at + 1;
    }
  }
  return best ? best.id : null;
}

/** "Breloom line – on 6 teams" → { head: 'Breloom line', rest: 'on 6 teams' }; without a dash or colon: { head: null, rest: text }. */
export function splitTrusted(text) {
  const s = String(text || '').trim();
  const m = /^(.{1,48}?)\s*(?:\s[–—-]\s|:\s)\s*(.+)$/su.exec(s);
  return m ? { head: m[1].trim(), rest: m[2].trim() } : { head: null, rest: s };
}
