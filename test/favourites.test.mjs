// Favourites in the cosmetics pickers (shared/favourites.mjs): the stored shape, star / unstar, pruning ids the catalog
// no longer knows, the filters (in the list's own order) and which chips the filter row shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanFavourites, isFavourite, toggleFavourite, pruneFavourites, filterItems, filterCounts, filterChips, shownFilter, FAV_KIND_OF, FAV_MAX_PER_KIND } from '../shared/favourites.mjs';

const CATALOG = (await import('../web/lib/cosmetics/content/catalog.mjs')).default;

test('cleanFavourites keeps ids per kind only: no junk, no duplicates, no empty kinds', () => {
  assert.deepEqual(cleanFavourites(null), {});
  assert.deepEqual(cleanFavourites([]), {});
  assert.deepEqual(cleanFavourites('banner'), {});
  assert.deepEqual(cleanFavourites({ banner: ['night-train', 'night-train', 'aurora-fjord'], frame: [], theme: 'dusk' }), { banner: ['night-train', 'aurora-fjord'] });
  // ids and kinds must look like catalog ids – nothing path-like or huge gets into the config
  assert.deepEqual(cleanFavourites({ banner: ['../x', 'A', '', 7, null, 'ok-1'], 'Bad Kind': ['x'], __proto__: ['x'] }), { banner: ['ok-1'] });
  // a kind this app version has no picker for (handheld skins, stickers …) is kept
  assert.deepEqual(cleanFavourites({ sticker: ['pixel-heart'] }), { sticker: ['pixel-heart'] });
  const many = Array.from({ length: FAV_MAX_PER_KIND + 20 }, (_, i) => `b-${i}`);
  assert.equal(cleanFavourites({ banner: many }).banner.length, FAV_MAX_PER_KIND);
});

test('toggleFavourite stars and unstars without touching the old object', () => {
  const a = {};
  const b = toggleFavourite(a, 'banner', 'night-train');
  assert.deepEqual(a, {});
  assert.deepEqual(b, { banner: ['night-train'] });
  assert.equal(isFavourite(b, 'banner', 'night-train'), true);
  assert.equal(isFavourite(b, 'nameplate', 'night-train'), false, 'a banner and its nameplate are starred apart');
  const c = toggleFavourite(toggleFavourite(b, 'banner', 'aurora-fjord'), 'theme', 'dusk');
  assert.deepEqual(c, { banner: ['night-train', 'aurora-fjord'], theme: ['dusk'] });
  const d = toggleFavourite(c, 'banner', 'night-train');
  assert.deepEqual(d, { banner: ['aurora-fjord'], theme: ['dusk'] });
  assert.deepEqual(toggleFavourite(d, 'theme', 'dusk'), { banner: ['aurora-fjord'] }, 'the last one out drops the kind');
  assert.deepEqual(toggleFavourite(d, 'banner', '../etc'), d, 'a bad id changes nothing');
  assert.equal(isFavourite(null, 'banner', 'x'), false);
});

test('pruneFavourites drops ids the catalog no longer knows, only for the kinds it is given', () => {
  const favs = { banner: ['night-train', 'retired-one'], frame: ['gone'], sticker: ['pixel-heart'] };
  const known = { banner: CATALOG.banners.map((b) => b.id), frame: new Set(CATALOG.frames.map((f) => f.id)) };
  assert.deepEqual(pruneFavourites(favs, known), { banner: ['night-train'], sticker: ['pixel-heart'] });
  assert.deepEqual(pruneFavourites(favs, {}), favs);
  assert.deepEqual(pruneFavourites(favs, null), favs);
});

const items = [
  { id: 'basic', plus: false, owned: true },
  { id: 'a', plus: true, owned: false },
  { id: 'b', plus: true, owned: false },
  { id: 'c', plus: true, owned: false, earned: true },
  { id: 'd', plus: true, owned: false },
];

test('filters keep the list order – a favourite is never moved to the top', () => {
  const favs = { banner: ['d', 'a', 'retired'] }; // starred d first, and one the list doesn't have
  const o = { favs, kind: 'banner' };
  assert.deepEqual(filterItems(items, 'favs', o).map((x) => x.id), ['a', 'd']);
  assert.deepEqual(filterItems(items, 'all', o).map((x) => x.id), ['basic', 'a', 'b', 'c', 'd']);
  assert.deepEqual(filterItems(items, 'owned', o).map((x) => x.id), ['basic']);
  assert.deepEqual(filterItems(items, 'plus', o).map((x) => x.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(filterItems(items, 'earned', o).map((x) => x.id), ['c']);
  assert.deepEqual(filterItems(items, 'nonsense', o).length, 5);
  assert.deepEqual(filterItems(null, 'favs', o), []);
  // own predicates (the profile editor's "owned" for a member, a picker without catalog fields)
  assert.deepEqual(filterItems(items, 'owned', { ...o, owned: () => true }).length, 5);
  // counts: the unknown id isn't counted
  assert.deepEqual(filterCounts(items, o), { all: 5, favs: 2, owned: 1, plus: 4, earned: 1 });
});

test('the filter row shows only chips that narrow the list; a vanished filter falls back to All', () => {
  // a free player: Owned (the free ones) and souldew+ both narrow
  assert.deepEqual(filterChips({ all: 5, favs: 0, owned: 1, plus: 4, earned: 0 }), ['all', 'favs', 'owned', 'plus']);
  // a member: everything is owned – no Owned chip; Earned only where something is earned
  assert.deepEqual(filterChips({ all: 5, favs: 2, owned: 5, plus: 4, earned: 1 }), ['all', 'favs', 'plus', 'earned']);
  // the launch picker of a non-member that lists free things only
  assert.deepEqual(filterChips({ all: 3, favs: 0, owned: 3, plus: 0, earned: 0 }), ['all', 'favs']);
  assert.equal(shownFilter('owned', ['all', 'favs', 'plus']), 'all');
  assert.equal(shownFilter('favs', ['all', 'favs']), 'favs');
});

test('every catalog list maps to a favourite kind, and catalog ids pass the shape check', () => {
  assert.deepEqual(Object.values(FAV_KIND_OF).sort(), ['banner', 'frame', 'nameplate', 'theme']);
  for (const [list, kind] of Object.entries(FAV_KIND_OF)) {
    const src = list === 'nameplates' ? CATALOG.banners : CATALOG[list];
    const ids = src.map((x) => x.id);
    const all = ids.reduce((f, id) => toggleFavourite(f, kind, id), {});
    assert.deepEqual(all[kind], ids, `${list}: every id can be starred`);
  }
});
