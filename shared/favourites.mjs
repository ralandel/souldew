// Favourites in the cosmetics pickers (banners, frames, nameplates, themes, launch animations, the handheld's skins,
// stickers and designs – and any kind added later): one object keyed by kind, { banner: [ids], frame: [ids], … }, kept
// in the local config (config.json `favourites`, POST /api/config) next to the theme and the launch animation. The pure
// parts live here so the server (which only stores the shape) and the page (web/lib/favourites.mjs: the star, the
// filter row) share one set of rules, and test/favourites.test.mjs checks them without a page.
//
// Rules: a favourite is a wish as much as a choice – souldew+ and locked items can be one too. The lists keep the
// order things were starred in, but a picker always shows its items in its own order; a favourite is never moved up.
// Ids the catalog doesn't know (an item retired from the pack, a typo in a hand-edited config) are ignored when a
// picker filters and pruned quietly the next time that kind is written.

/** The kinds the app's own pickers use – "Your handheld" adds its skins, stickers and saved designs. Other kinds are kept as
 * long as their shape is right. */
export const FAV_KINDS = ['banner', 'frame', 'nameplate', 'theme', 'launch', 'skin', 'sticker', 'design'];

/** The cosmetics catalog's list names (web/lib/cosmetics catalog()) → favourite kinds. */
export const FAV_KIND_OF = { banners: 'banner', frames: 'frame', nameplates: 'nameplate', skins: 'theme' };
// ('launch' is the 3D launch's looks – shared/handheld.mjs LAUNCH_LOOKS, not a catalog list)

/** The filter row's chips, in their order. */
export const FAV_FILTERS = ['all', 'favs', 'owned', 'plus', 'earned'];

const KIND = /^[a-z][a-z0-9-]{0,23}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const FAV_MAX_KINDS = 16;
export const FAV_MAX_PER_KIND = 500;

/** Anything (the config file, a POST body) → a clean favourites object: known shape only, no duplicates, no empty kinds. */
export function cleanFavourites(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [kind, ids] of Object.entries(raw)) {
    if (Object.keys(out).length >= FAV_MAX_KINDS) break;
    if (!KIND.test(kind) || !Array.isArray(ids)) continue;
    const list = [...new Set(ids.filter((id) => typeof id === 'string' && ID.test(id)))].slice(0, FAV_MAX_PER_KIND);
    if (list.length) out[kind] = list;
  }
  return out;
}

export const isFavourite = (favs, kind, id) => !!id && !!favs?.[kind]?.includes(id);

/** Star or unstar one item; returns a new object (the old one is left alone). */
export function toggleFavourite(favs, kind, id) {
  const clean = cleanFavourites(favs);
  if (!KIND.test(kind) || typeof id !== 'string' || !ID.test(id)) return clean;
  const list = clean[kind] || [];
  const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id].slice(-FAV_MAX_PER_KIND);
  const out = { ...clean };
  if (next.length) out[kind] = next;
  else delete out[kind];
  return out;
}

/**
 * Drop the ids the catalog doesn't know. `known`: { kind: iterable of ids } – only the kinds named there are pruned,
 * every other kind is kept as it is (a kind this version of the app has no picker for).
 */
export function pruneFavourites(favs, known) {
  const out = cleanFavourites(favs);
  for (const [kind, ids] of Object.entries(known || {})) {
    if (!out[kind]) continue;
    const set = ids instanceof Set ? ids : new Set(ids);
    const list = out[kind].filter((id) => set.has(id));
    if (list.length) out[kind] = list;
    else delete out[kind];
  }
  return out;
}

const tests = (opts) => ({
  favs: (it) => isFavourite(opts.favs, opts.kind, it.id),
  owned: opts.owned || ((it) => !!it.owned),
  plus: opts.plus || ((it) => !!it.plus),
  earned: opts.earned || ((it) => !!it.earned),
});

/**
 * The items a filter shows, in the list's own order. opts: { favs, kind, owned(it), plus(it), earned(it) } – the
 * predicates default to the catalog's `owned`, `plus` and `earned` fields.
 */
export function filterItems(items, filter, opts = {}) {
  const list = items || [];
  if (!filter || filter === 'all') return list;
  const fn = tests(opts)[filter];
  return fn ? list.filter((it) => fn(it)) : list;
}

/** How many items each filter shows: { all, favs, owned, plus, earned }. */
export function filterCounts(items, opts = {}) {
  const list = items || [];
  const fns = tests(opts);
  const out = { all: list.length };
  for (const k of ['favs', 'owned', 'plus', 'earned']) out[k] = list.filter((it) => fns[k](it)).length;
  return out;
}

/**
 * The chips a list's filter row shows: All and Favourites always; Owned and souldew+ only where they narrow the list
 * (a member's "Owned" would be everything, a list without souldew+ items needs no souldew+ chip); Earned only where
 * something in the list is earned. Keeps the row short – it must never outweigh the list.
 */
export function filterChips(counts) {
  const c = counts || { all: 0 };
  const narrows = (n) => n > 0 && n < c.all;
  return FAV_FILTERS.filter((k) => k === 'all' || k === 'favs' || (k === 'earned' ? c.earned > 0 : narrows(c[k])));
}

/** A remembered filter that this list no longer offers falls back to All. */
export const shownFilter = (filter, chips) => (chips.includes(filter) ? filter : 'all');
