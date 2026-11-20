// "Your handheld" and the 3.0 launch animation: the local setting (shared/handheld.mjs – its shape, the migration of
// older values, the server keeping only that shape), saved designs (save, overwrite, rename, duplicate, delete, put on,
// the limit of 12), what the launch plays (a membership that ended, an earned sticker not earned yet, Surprise me from
// the ★ designs, a device without stickers), the favourites kinds, and placing a sticker (web/lib/handheld/geometry.mjs
// with the app's pre-built atlas): clamped, moved clear of a button, refused where there is no room, at most 8.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanHandheld, cleanSticker, cleanLaunchLook, cleanLaunchPace, cleanClearTint, migrateFavourites, lookToPlay, designNotes, designDirty,
  saveAsNew, overwriteDesign, renameDesign, duplicateDesign, deleteDesign, applyDesign, exportHandheld, importHandheld, emptyHandheld,
  STICKERS, WRAPS, UNLOCKS, STICKER_MAX, DESIGN_MAX, SCALE_MIN, SCALE_MAX, HH_BYTES_MAX, REGIONS, FINISHES,
  stickerById, stickerSet, sheetItems, sheetCounts, sheetPass, groupStickers, launchRights,
} from '../shared/handheld.mjs';
import { FAV_KINDS, toggleFavourite, cleanFavourites, isFavourite, filterChips, shownFilter } from '../shared/favourites.mjs';
import { createHash } from 'node:crypto';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { regionsOf, surfacesOf, stickerClearance, snapSticker, slideSticker, snapTurn, firstFree, placeLayout, fits, PX, GAP } from '../web/lib/handheld/geometry.mjs';
import { decodeLayout, buildAtlas, encodeLayout, stackAtlases, insideCut } from '../web/lib/handheld/atlas.mjs';
import { DESIGNS } from '../scripts/handheld/stickers-app.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const st = (id, region, U, o = {}) => ({ id, finish: 'vinyl', region, U, rot: 0, scale: 1, ...o });

test('cleanHandheld keeps the shape only: known ids, known faces, clamped numbers, ≤ 8 per device, ≤ 12 designs', () => {
  assert.deepEqual(cleanHandheld(null), emptyHandheld());
  assert.deepEqual(cleanHandheld('x'), emptyHandheld());
  assert.deepEqual(cleanHandheld([]), emptyHandheld());
  const h = cleanHandheld({
    skin: 'night-train',
    stickers: {
      nds: [st('heart', 'lid:top', [999, -999], { rot: 7, scale: 9, finish: 'glitter' }), st('nope', 'lid:top', [0, 0]), st('heart', 'body:top', [0, 0]), st('cloud', 'deck:top', [1, 2], { finish: 'holo' })],
      gbc: [st('heart', 'body:top', [0, 0])], // (a GB Color plays with the GB's stickers: there is no gbc key)
      gb: Array.from({ length: 12 }, (_, i) => st('star', 'body:bottom', [i, 0])),
    },
    surprise: 'yes',
  });
  assert.equal(h.skin, 'night-train');
  assert.equal(h.stickers.nds.length, 2, 'an unknown sticker and a face the DS hasn’t go');
  const [a, b] = h.stickers.nds;
  assert.deepEqual(a.U, [120, -120], 'positions are clamped');
  assert.equal(a.scale, SCALE_MAX);
  assert.ok(a.rot > -Math.PI && a.rot <= Math.PI, 'the turn is normalised');
  assert.ok(Math.abs(a.rot - (7 - 2 * Math.PI)) < 1e-3);
  assert.equal(a.finish, 'glitter');
  assert.equal(b.finish, 'vinyl', 'a finish the sticker doesn’t come in becomes vinyl (the cloud is vinyl only)');
  assert.equal(h.stickers.gbc, undefined);
  assert.equal(h.stickers.gb.length, STICKER_MAX);
  assert.equal(h.surprise, false, 'only true is true');
  assert.equal(cleanSticker(st('heart', 'lid:top', [0, 0], { scale: 0.1 }), 'nds').scale, SCALE_MIN);
  assert.equal(cleanHandheld({ skin: 'pokeball' }).skin, null, 'an unknown skin is the theme colour');
  // designs: unique ids, ≤ 12, the worn one must exist, names without control characters and ≤ 28 characters
  const designs = Array.from({ length: 15 }, (_, i) => ({ id: `d${i}`, name: `  Look\u0007 ${i} ${'x'.repeat(40)}`, skin: 'plain-dusk', stickers: {} }));
  const h2 = cleanHandheld({ designs: [...designs, { id: 'd1', name: 'dup' }, { id: '../x', name: 'bad' }], active: 'd14' });
  assert.equal(h2.designs.length, DESIGN_MAX);
  assert.equal(h2.designs[1].name.length, 28);
  assert.ok(!h2.designs[1].name.includes(String.fromCharCode(7)));
  assert.equal(h2.active, null, 'the worn design was cut off');
  assert.equal(cleanHandheld({ designs: [{ id: 'd1' }], active: 'd1' }).designs[0].name, 'Design 1');
  assert.ok(JSON.stringify(cleanHandheld({ designs, stickers: { nds: Array(8).fill(st('heart', 'lid:top', [1.23456, 2])) } })).length <= HH_BYTES_MAX);
});

test('the launch settings migrate: the 2.x cartridge and the earlier souldew+ animations become “Your colours”', () => {
  assert.equal(cleanLaunchLook('cartridge'), 'your-colours');
  assert.equal(cleanLaunchLook('low-tide'), 'your-colours');
  assert.equal(cleanLaunchLook(undefined), 'your-colours');
  for (const id of ['your-colours', 'clear-shell', 'gold', 'holo']) assert.equal(cleanLaunchLook(id), id);
  assert.equal(cleanLaunchLook('rare'), 'your-colours', 'Rare start is a surprise, never a pick');
  assert.equal(cleanLaunchPace('quick'), 'quick');
  assert.equal(cleanLaunchPace('slow'), 'full');
  assert.equal(cleanClearTint('ice'), 'ice');
  assert.equal(cleanClearTint('neon'), 'atomic');
  // the design sketch kept the stars inside the handheld: they move to config `favourites`
  assert.deepEqual(migrateFavourites({ favourites: { skin: ['night-train'], design: ['d1'], other: ['x'] } }, { banner: ['b'], skin: ['coral-shelf'] }),
    { banner: ['b'], skin: ['coral-shelf', 'night-train'], design: ['d1'] });
  assert.equal(cleanHandheld({ favourites: { skin: ['x'] } }).favourites, undefined, 'the handheld itself keeps no favourites');
});

test('saved designs: save as new, overwrite, rename, duplicate, delete (with the old one for Undo), put on, the limit of 12', () => {
  let h = cleanHandheld({ skin: 'plain-dusk', stickers: { nds: [st('heart', 'lid:top', [0, 0])] } });
  h = saveAsNew(h, { name: 'Night', id: 'd1', now: 1 });
  assert.equal(h.designs.length, 1);
  assert.equal(h.active, 'd1');
  assert.equal(designDirty(h), false);
  h = { ...h, skin: null };
  assert.equal(designDirty(h), true, 'a change since the design was saved');
  h = overwriteDesign(h, { now: 2 });
  assert.equal(h.designs[0].skin, null);
  assert.equal(designDirty(h), false);
  h = renameDesign(h, 'd1', '  Coral Days  ');
  assert.equal(h.designs[0].name, 'Coral Days');
  assert.equal(renameDesign(h, 'd1', '   '), h, 'an empty name changes nothing');
  h = duplicateDesign(h, 'd1', { newId: 'd2', now: 3 });
  assert.deepEqual(h.designs.map((d) => [d.id, d.name]), [['d1', 'Coral Days'], ['d2', 'Coral Days copy']]);
  assert.equal(h.active, 'd2');
  h = { ...h, surprise: true };
  const before = h;
  h = deleteDesign(h, 'd2');
  assert.deepEqual(h.designs.map((d) => d.id), ['d1']);
  assert.equal(h.active, null);
  assert.equal(h.surprise, false, 'Surprise me needs two designs');
  assert.equal(before.designs.length, 2, 'the old handheld is untouched – Undo puts it back');
  // putting a design on dresses every device: one it has no stickers for plays bare
  const d = { id: 'd9', name: 'Bare GB', skin: 'plain-dusk', stickers: { nds: [st('star', 'lid:top', [5, 5])] } };
  h = applyDesign({ ...h, stickers: { gb: [st('heart', 'body:top', [0, 0])] }, designs: [...h.designs, d] }, 'd9');
  assert.deepEqual(Object.keys(h.stickers), ['nds']);
  assert.equal(h.active, 'd9');
  assert.deepEqual(designNotes(d, { member: true, trophies: new Set() }).empty, ['gba', '3ds', 'gb']);
  // the limit
  let full = emptyHandheld();
  for (let i = 0; i < DESIGN_MAX; i++) full = saveAsNew(full, { id: `d${i}`, now: i });
  assert.equal(full.designs.length, DESIGN_MAX);
  assert.equal(saveAsNew(full, { id: 'dx' }), null);
  assert.equal(duplicateDesign(full, 'd0', { newId: 'dx' }), null);
});

test('what the launch plays: owned items only – the design keeps the rest (membership ended, earned not yet)', () => {
  const doc = cleanHandheld({
    skin: 'night-train',
    stickers: {
      nds: [st('heart', 'lid:top', [0, 0], { finish: 'holo' }), st('comet', 'lid:top', [10, 0]), st('thread', 'base:bottom', [0, 0]), st('laurel', 'base:bottom', [20, 0])],
      gba: [st('ridge', 'body:bottom', [0, 0])],
    },
  });
  const member = lookToPlay(doc, { member: true, trophies: new Set(['winSoulLink', 'deathlessWin']) });
  assert.equal(member.skin, 'night-train');
  assert.deepEqual(member.stickers.nds.map((x) => [x.id, x.finish]), [['heart', 'holo'], ['comet', 'vinyl'], ['thread', 'vinyl'], ['laurel', 'vinyl']]);
  const ended = lookToPlay(doc, { member: false, trophies: new Set(['winSoulLink']) });
  assert.equal(ended.skin, null, 'a souldew+ skin falls back to the theme colour');
  assert.deepEqual(ended.stickers.nds.map((x) => [x.id, x.finish]), [['heart', 'vinyl'], ['thread', 'vinyl']], 'souldew+ stickers drop out, holo becomes vinyl, the earned one not earned yet waits');
  assert.equal(ended.stickers.gba, undefined, 'a device left with nothing plays bare');
  assert.deepEqual(designNotes(doc, { member: false, trophies: new Set(['winSoulLink']) }), { plus: 4, earned: 1, empty: ['3ds', 'gb'] });
  assert.equal(doc.stickers.nds.length, 4, 'nothing is deleted from the look');
  // the free wrap plays for everyone
  assert.equal(lookToPlay({ skin: 'plain-dusk' }, { member: false }).skin, 'plain-dusk');
});

test('Surprise me at start picks only from the ★ designs once any are starred – and only with two designs or more', () => {
  const designs = ['d1', 'd2', 'd3'].map((id, i) => ({ id, name: id, skin: i === 0 ? 'plain-dusk' : null, stickers: {} }));
  const doc = cleanHandheld({ skin: null, designs, surprise: true });
  const seen = new Set();
  for (let i = 0; i < 30; i++) seen.add(lookToPlay(doc, { member: true, rnd: () => i / 30 }).design);
  assert.deepEqual([...seen].sort(), ['d1', 'd2', 'd3']);
  const favSeen = new Set();
  for (let i = 0; i < 30; i++) favSeen.add(lookToPlay(doc, { member: true, favDesigns: ['d2', 'd3'], rnd: () => i / 30 }).design);
  assert.deepEqual([...favSeen].sort(), ['d2', 'd3']);
  assert.equal(lookToPlay({ ...doc, surprise: false, active: 'd1', skin: 'plain-dusk' }, { member: true }).skin, 'plain-dusk');
  assert.equal(lookToPlay({ ...doc, designs: designs.slice(0, 1) }, { member: true }).design, null, 'one design: the look itself');
});

test('favourites: the handheld’s skins, stickers and designs are kinds of the same favourites object', () => {
  for (const k of ['skin', 'sticker', 'design']) assert.ok(FAV_KINDS.includes(k));
  let f = toggleFavourite({ banner: ['night-train'] }, 'skin', 'night-train');
  f = toggleFavourite(f, 'sticker', 'heart');
  f = toggleFavourite(f, 'design', 'dmhu3l2k1');
  assert.deepEqual(cleanFavourites(f), { banner: ['night-train'], skin: ['night-train'], sticker: ['heart'], design: ['dmhu3l2k1'] });
  assert.equal(isFavourite(f, 'skin', 'night-train'), true);
  assert.equal(isFavourite(f, 'banner', 'heart'), false);
});

test('the catalog: 54 stickers (11 free, 40 souldew+, 3 earned), 7 skins (1 free), four earned items tied to trophies', () => {
  const by = (tier) => STICKERS.filter((s) => s.tier === tier).length;
  assert.deepEqual([STICKERS.length, by('free'), by('plus'), by('earned')], [54, 11, 40, 3]);
  assert.equal(new Set(STICKERS.map((s) => s.id)).size, STICKERS.length, 'unique ids');
  assert.ok(STICKERS.some((s) => s.id === 'pennant-s') && STICKERS.some((s) => s.id === 'pennant'), 'the short pennant sits next to the wide one');
  assert.deepEqual(WRAPS.filter((w) => w.tier === 'free').map((w) => w.id), ['plain-dusk']);
  assert.deepEqual(UNLOCKS.map((u) => [u.id, u.trophy]), [['summit-dawn', 'hardcoreWin'], ['thread', 'winSoulLink'], ['signpost', 'badges16'], ['laurel', 'deathlessWin']]);
  for (const s of STICKERS) assert.ok(s.finishes.includes('vinyl'));
  for (const dev of Object.keys(REGIONS)) assert.deepEqual(Object.keys(regionsOf(dev)).sort(), [...REGIONS[dev]].sort(), `the faces of ${dev}`);
});

test('round 7, the cool and funny stickers: RIP, 1 HP and GG free (vinyl – holo and glitter stay souldew+), 17 souldew+, the sizes', () => {
  const fun = STICKERS.filter((s) => stickerSet(s) === 'fun');
  assert.deepEqual(fun.map((s) => s.id), ['rip', 'one-hp', 'gg', 'skill-issue', 'rng', 'crit', 'blow', 'grass', 'duck', 'shades', 'flame-skull', 'bolt', 'hardcore', 'arcade', 'floppy', 'glitch', 'stripe', 'verified', 'live', 'flag']);
  assert.deepEqual(fun.filter((s) => s.tier === 'free').map((s) => s.name), ['RIP', '1 HP', 'GG']);
  assert.equal(fun.filter((s) => s.tier === 'plus').length, 17);
  assert.equal(stickerById('blow').name, 'Blow On It');
  assert.equal(stickerById('blow').tier, 'plus');
  // the large ones: the Racing Stripe and Verified Nuzlocker, and Hardcore (bigger than Campsite) and Glitch (wider than Night Ridge)
  assert.deepEqual(fun.filter((s) => s.size === 'l').map((s) => s.id), ['hardcore', 'glitch', 'stripe', 'verified']);
  assert.equal(stickerSet(stickerById('heart')), 'cosy');
  // a free sticker: vinyl for everyone, holo / glitter are souldew+ finishes – what the launch plays for a Supporter
  for (const id of ['rip', 'one-hp', 'gg']) assert.ok(stickerById(id).finishes.includes('vinyl'));
  assert.equal(FINISHES.holo.plus && FINISHES.glitter.plus, true);
  const doc = { stickers: { gb: [st('gg', 'body:top', [0, 0], { finish: 'glitter' }), st('one-hp', 'body:top', [0, 10], { finish: 'holo' }), st('blow', 'body:top', [0, -10])] } };
  const sup = lookToPlay(doc, { member: false, trophies: new Set() });
  assert.deepEqual(sup.stickers.gb.map((x) => [x.id, x.finish]), [['gg', 'vinyl'], ['one-hp', 'vinyl']], 'a Supporter: the free ones in vinyl, Blow On It waits');
  const mem = lookToPlay(doc, { member: true, trophies: new Set() });
  assert.deepEqual(mem.stickers.gb.map((x) => [x.id, x.finish]), [['gg', 'glitter'], ['one-hp', 'holo'], ['blow', 'vinyl']]);
  // RIP only comes in vinyl: a stored holo one is cleaned to vinyl
  assert.equal(cleanSticker({ ...st('rip', 'lid:top', [0, 0]), finish: 'holo' }, 'nds').finish, 'vinyl');
});

test('the editor’s sheet: the filter row over 61 items, four sticker groups, favourites – for a member, a Supporter and with stars', () => {
  const isFav0 = () => false;
  // a Supporter without trophies: 11 free stickers and the free skin are theirs; souldew+ and the earned ones are not
  const supItems = sheetItems({ member: launchRights('supporter').plus, trophies: new Set() });
  const sc = sheetCounts(supItems, isFav0);
  assert.deepEqual(sc, { all: 61, favs: 0, owned: 12, plus: 46, earned: 3 });
  assert.deepEqual(filterChips(sc), ['all', 'favs', 'owned', 'plus', 'earned']);
  const shown = (items, f, isFav = isFav0) => groupStickers(items.filter((x) => x.kind === 'sticker' && sheetPass(x, f, isFav))).map((g) => [g.key, g.list.length]);
  assert.deepEqual(shown(supItems, 'all'), [['free', 11], ['plus-cosy', 23], ['plus-fun', 17], ['earned', 3]]);
  assert.deepEqual(shown(supItems, 'owned'), [['free', 11]]);
  assert.deepEqual(shown(supItems, 'plus'), [['plus-cosy', 23], ['plus-fun', 17]]);
  assert.deepEqual(shown(supItems, 'earned'), [['earned', 3]]);
  // the new free ones sit in the free group, at its end
  assert.deepEqual(groupStickers(supItems.filter((x) => x.kind === 'sticker'))[0].list.slice(-3).map((s) => s.id), ['rip', 'one-hp', 'gg']);
  // a member with one trophy: everything but two earned stickers; "Owned" narrows, "souldew+" too
  const memItems = sheetItems({ member: true, trophies: new Set(['winSoulLink']) });
  const mc = sheetCounts(memItems, isFav0);
  assert.equal(mc.owned, 59);
  assert.deepEqual(shown(memItems, 'owned'), [['free', 11], ['plus-cosy', 23], ['plus-fun', 17], ['earned', 1]]);
  // favourites: a star on a new sticker (and a skin) – the ★ filter shows just those, in their groups
  let favs = toggleFavourite({}, 'sticker', 'blow');
  favs = toggleFavourite(favs, 'sticker', 'rip');
  favs = toggleFavourite(favs, 'skin', 'night-train');
  const isFav = (it) => isFavourite(favs, it.kind, it.id);
  assert.equal(sheetCounts(memItems, isFav).favs, 3);
  assert.deepEqual(shown(memItems, 'favs', isFav), [['free', 1], ['plus-fun', 1]]);
  // a remembered filter this sheet no longer offers falls back to All (a member has no "Owned" chip when everything is theirs)
  const all = sheetItems({ member: true, trophies: null });
  assert.equal(shownFilter('owned', filterChips(sheetCounts(all, isFav0))), 'all');
});

test('no souldew+ sticker art in the public app: the atlas, the build input and the round-7 designs (as hashes)', () => {
  const plus = new Set(STICKERS.filter((s) => s.tier === 'plus').map((s) => s.id));
  assert.deepEqual(DESIGNS.filter((d) => plus.has(d.id)).map((d) => d.id), [], 'scripts/handheld/stickers-app.mjs');
  const layout = JSON.parse(readFileSync(join(ROOT, 'web', 'assets', 'handheld', 'stickers.json'), 'utf8'));
  assert.deepEqual(Object.keys(layout.rects).filter((id) => plus.has(id)), [], 'web/assets/handheld/stickers.json');
  assert.equal(Object.keys(layout.rects).length, 14, '11 free + 3 earned');
  // two lines of each of the 17 souldew+ designs of round 7 (the private design source's stickers-fun.mjs), as hashes so this
  // test doesn't publish them: none may turn up in the app's code
  const h8 = (x) => createHash('sha256').update(x).digest('hex').slice(0, 8);
  const lines = (src) => src.split('\n').map((l) => l.trim()).filter((l) => l.length > 30);
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (['node_modules', 'vendor', 'assets', 'i18n', '.git'].includes(n)) continue; if (statSync(p).isDirectory()) walk(p); else if (/\.(m?js|css|html)$/.test(n)) files.push(p); } };
  for (const d of ['web', 'shared', 'scripts', 'server', 'electron']) walk(join(ROOT, d));
  const hits = files.flatMap((f) => lines(readFileSync(f, 'utf8')).filter((l) => FUN_PAID.has(h8(l))).map(() => f));
  assert.deepEqual(hits, [], 'souldew+ sticker art in the app');
  // and the private source, where it is next to this checkout, has every one of them (the list stays honest)
  const src = join(ROOT, '..', 'design-plus', 'design', 'plus', 'handheld', 'stickers-fun.mjs');
  if (existsSync(src)) {
    const have = new Set(lines(readFileSync(src, 'utf8')).map(h8));
    for (const x of FUN_PAID) assert.ok(have.has(x), `hash ${x} is not in the private stickers-fun.mjs`);
  }
});
test('texts: the free sticker count is counted, not written in (11 now), and the two souldew+ groups are translated', () => {
  for (const lang of ['en', 'de', 'fr', 'es', 'it']) {
    const T = JSON.parse(readFileSync(join(ROOT, 'web', 'i18n', `${lang}.json`), 'utf8'));
    for (const k of ['hh.supporterHas', 'launch.tierSupWhat']) assert.ok(T[k].includes('{n}') && !/\b8\b/.test(T[k]), `${lang} ${k}`);
    for (const k of ['hh.groupPlusCosy', 'hh.groupPlusFun']) assert.ok(T[k]?.startsWith('souldew+ · '), `${lang} ${k}`);
  }
});

const FUN_PAID = new Set([
  '17d5989b', '242e2332', 'b54982f5', '75095ae1', 'c2b37d57', '2b567cf2', '26bd0b38', 'c5f26507', 'd5764363', 'bcc27dd8', 'ca2dfdf1', 'bbae8e30',
  '96c076b4', '4f1ab55a', '9f3c4fbe', 'a742eddb', '3ac5d7dd', 'dfe23fa6', '4fba38a1', '43e6138b', 'b9332f0a', '1696de11', '0a1d0adc', '6f94906b',
  'f91ba870', 'e13c836f', '7c1721e4', '17059d7c', '331455b3', '10113987', '47a08149', '50c2a991', '78469c86', '335785a4',
]);

test('the app’s sticker atlas is pre-built, up to date, and has exactly the free and earned stickers', async () => {
  const layout = decodeLayout(JSON.parse(readFileSync(join(ROOT, 'web', 'assets', 'handheld', 'stickers.json'), 'utf8')));
  assert.deepEqual(Object.keys(layout.rects).sort(), STICKERS.filter((s) => s.tier !== 'plus').map((s) => s.id).sort());
  const fresh = buildAtlas(DESIGNS);
  assert.deepEqual(encodeLayout(fresh), JSON.parse(readFileSync(join(ROOT, 'web', 'assets', 'handheld', 'stickers.json'), 'utf8')), 'run node scripts/build-handheld-atlas.mjs');
  // the pack's atlas stacks under the app's
  const two = stackAtlases([fresh, buildAtlas(DESIGNS.slice(0, 2))]);
  assert.equal(two.h, fresh.h * 2 - (fresh.h - buildAtlas(DESIGNS.slice(0, 2)).h));
  assert.equal(two.rects.heart.y >= 0, true);
});

// ---- placing ----------------------------------------------------------------------------------------------------------
const rects = decodeLayout(JSON.parse(readFileSync(join(ROOT, 'web', 'assets', 'handheld', 'stickers.json'), 'utf8'))).rects;

test('a sticker fits on a free face, keeps 0.7 mm from a button, and is moved clear of one (the nearest free spot)', () => {
  const R = regionsOf('nds')['lid:top'];
  assert.ok(fits(R.slab, R.region, rects.heart, [0, 0], 0, PX), 'the middle of the closed lid is free');
  const deck = regionsOf('nds')['deck:top'];
  const pad = surfacesOf('nds').deck.top.cuts[1].c; // the round pad
  assert.ok(stickerClearance(deck.slab, deck.region, rects.heart, pad, 0, PX) < GAP, 'over the pad it doesn’t fit');
  const U = snapSticker(deck.slab, deck.region, rects.star, pad, 0, PX);
  assert.ok(U, 'a small sticker finds a spot beside the pad');
  assert.ok(fits(deck.slab, deck.region, rects.star, U, 0, PX));
  assert.ok(Math.hypot(U[0] - pad[0], U[1] - pad[1]) > 8, 'clear of the pad (8.6 mm round)');
  // a swallowed cut-out counts: the GBA's speaker holes under a big sticker
  const front = regionsOf('gba')['body:top'];
  const hole = surfacesOf('gba').body.top.cuts.at(-1).c;
  assert.ok(stickerClearance(front.slab, front.region, rects.moon, hole, 0, PX * 1.6) < GAP);
});

test('refused where there is no room: off the face, a big sticker on the cramped deck, and over the edge only as far as it may', () => {
  const deck = regionsOf('nds')['deck:top'];
  // the logo at 160 % is ~48 mm wide: the deck between the screen and the pad/buttons has no such place
  assert.equal(snapSticker(deck.slab, deck.region, rects.logo, [0, 0], 0, PX * 1.6), null);
  const lid = regionsOf('nds')['lid:top'];
  assert.equal(fits(lid.slab, lid.region, rects.heart, [200, 0], 0, PX), false, 'far off the lid');
  assert.equal(snapSticker(lid.slab, lid.region, rects.heart, [200, 0], 0, PX), null, 'and nothing free within 14 mm');
  // over the rounded edge a little is fine (the lid lets stickers run 2.6 mm past its flat face)
  const edgeX = lid.slab.w / 2 - lid.slab.b; // where the flat face ends
  const halfW = (rects.heart.w * PX) / 2;
  assert.ok(fits(lid.slab, lid.region, rects.heart, [edgeX - halfW + 1.5, 0], 0, PX), 'a hair over the edge');
  assert.equal(fits(lid.slab, lid.region, rects.heart, [edgeX - halfW + 8, 0], 0, PX), false, 'not far down the side');
  // the deck is the one face a sticker may not run over the edge of
  assert.equal(deck.region.Ls, 0);
});

test('dragging slides along a button instead of jumping; turning snaps only within ±3° of straight', () => {
  const front = regionsOf('gba')['body:top'];
  const pad = surfacesOf('gba').body.top.cuts[1].c;
  const from = [pad[0], pad[1] - 20]; // above the pad
  assert.ok(fits(front.slab, front.region, rects.star, from, 0, PX));
  const r = slideSticker(front.slab, front.region, rects.star, from, [pad[0] + 3, pad[1]], 0, PX);
  assert.equal(r.slid, true);
  assert.ok(fits(front.slab, front.region, rects.star, r.U, 0, PX), 'where it slid to fits');
  assert.ok(r.U[0] > from[0] + 1, 'it moved sideways, along the pad');
  assert.equal(snapTurn((2 * Math.PI) / 180), 0);
  assert.equal(snapTurn(Math.PI / 2 + (2.5 * Math.PI) / 180), Math.PI / 2);
  const free = (10 * Math.PI) / 180;
  assert.equal(snapTurn(free), free, 'free rotation elsewhere');
  assert.ok(firstFree(front, rects.heart, 0, PX), 'Enter on the sheet finds a free spot');
});

test('a stored layout is made valid on load: snapped clear, dropped without room or art, at most 8', () => {
  const regions = regionsOf('nds');
  const pad = surfacesOf('nds').deck.top.cuts[1].c;
  const list = [
    st('star', 'deck:top', pad), // moved clear of the pad
    st('logo', 'deck:top', [0, 0], { scale: 1.6 }), // no room: dropped
    st('comet', 'lid:top', [0, 0]), // a souldew+ sticker whose art isn't here: dropped (the look keeps it)
    ...Array.from({ length: 10 }, (_, i) => st('dot', 'lid:top', [-50 + i * 10, 10])),
  ];
  const out = placeLayout(list, regions, rects);
  assert.equal(out.length, STICKER_MAX);
  assert.equal(out[0].id, 'star');
  assert.notDeepEqual(out[0].U, pad);
  assert.ok(!out.some((x) => x.id === 'logo' || x.id === 'comet'));
  assert.ok(insideCut(rects.heart, 0, 0), 'the middle of a sticker is inside its die-cut');
});

test('export / import: a small file with the look – an unknown file or junk is refused, unknown ids dropped', () => {
  const h = cleanHandheld({ skin: 'coral-shelf', stickers: { gba: [st('heart', 'body:top', [1, 2])] }, designs: [{ id: 'd1', name: 'A', skin: null, stickers: {} }], active: 'd1' });
  const text = JSON.stringify(exportHandheld(h));
  assert.ok(text.length < HH_BYTES_MAX);
  assert.deepEqual(importHandheld(text), h);
  assert.equal(importHandheld('{"kind":"other"}'), null);
  assert.equal(importHandheld('not json'), null);
  const future = JSON.parse(text);
  future.handheld.stickers.gba.push(st('robot-from-4-0', 'body:top', [0, 0]));
  assert.equal(importHandheld(JSON.stringify(future)).stickers.gba.length, 1);
});

test('server: POST /api/config keeps the handheld’s shape and the launch settings, /api/status hands them back', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sls-handheld-'));
  const prev = process.env.SLS_DATA_DIR;
  process.env.SLS_DATA_DIR = root;
  try {
    const { startServer } = await import('../server/app.mjs');
    const { server, url } = await startServer({ port: 0, background: false });
    try {
      const post = (body) => fetch(`${url}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-soullink': '1' }, body: JSON.stringify(body) });
      const big = Array.from({ length: 20 }, (_, i) => st('heart', 'lid:top', [i, 0]));
      assert.equal((await post({ handheld: { skin: 'aurora-fjord', stickers: { nds: big, n64: big }, designs: 'x' }, launchAnimation: 'cartridge', launchPace: 'quick', launchClear: 'jungle',
        favourites: { sticker: ['heart'], design: ['d1'] } })).status, 200);
      const cfg = (await (await fetch(`${url}/api/status`, { headers: { 'x-soullink': '1' } })).json()).config;
      assert.equal(cfg.handheld.skin, 'aurora-fjord');
      assert.equal(cfg.handheld.stickers.nds.length, STICKER_MAX);
      assert.equal(cfg.handheld.stickers.n64, undefined);
      assert.deepEqual(cfg.handheld.designs, []);
      assert.equal(cfg.launchAnimation, 'your-colours');
      assert.equal(cfg.launchPace, 'quick');
      assert.equal(cfg.launchClear, 'jungle');
      assert.deepEqual(cfg.favourites, { sticker: ['heart'], design: ['d1'] });
    } finally {
      server.close();
    }
  } finally {
    if (prev === undefined) delete process.env.SLS_DATA_DIR; else process.env.SLS_DATA_DIR = prev;
    rmSync(root, { recursive: true, force: true });
  }
});
