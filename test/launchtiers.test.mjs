// The launch animation per membership (owner's decision 18.11.26, shared/handheld.mjs launchTier / launchRights):
// free – the 2D module (On / Off), no 3D, no handheld tile in the library; Supporter – the 3D launch in "Your colours",
// the free skin and stickers, the earned ones, one saved design, no souldew+ items, no Surprise me, no Rare start;
// souldew+ and Legend – everything. A membership that ends or drops keeps the settings and plays what the tier allows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  launchTier, launchRights, playableLookFor, lookToPlay, cleanHandheld, saveAsNew, duplicateDesign, DESIGN_MAX, designNotes,
} from '../shared/handheld.mjs';
import CATALOG from '../web/lib/cosmetics/content/catalog.mjs';

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const rights = (o) => launchRights(launchTier(o), { entitled: !!o.entitled });

const FREE = rights({ signedIn: false });
const FREE_IN = rights({ signedIn: true, tier: 'none' });
const SUP = rights({ signedIn: true, tier: 'supporter' });
const MEMBER = rights({ signedIn: true, tier: 'plus', entitled: true });
const PATRON = rights({ signedIn: true, tier: 'patron', entitled: true });

test('the tier: signed out and no paid tier are free, tier 1 is Supporter, souldew+ and Legend are members', () => {
  assert.equal(launchTier({}), 'free');
  assert.equal(launchTier({ signedIn: false, tier: 'plus' }), 'free', 'signed out: nothing counts');
  assert.equal(launchTier({ signedIn: true, tier: 'none' }), 'free');
  assert.equal(launchTier({ signedIn: true }), 'free');
  assert.equal(launchTier({ signedIn: true, tier: 'something-new' }), 'free', 'an unknown tier gives nothing');
  assert.equal(launchTier({ signedIn: true, tier: 'supporter' }), 'supporter');
  assert.equal(launchTier({ signedIn: true, tier: 'plus' }), 'member');
  assert.equal(launchTier({ signedIn: true, tier: 'patron' }), 'member');
  assert.equal(launchTier({ signedIn: true, tier: 'none', entitled: true }), 'member', 'a verified, loaded pack is souldew+');
});

test('what each tier may use', () => {
  for (const r of [FREE, FREE_IN]) assert.deepEqual(r, { tier: 'free', three: false, plus: false, rare: false, surprise: false, designMax: 0, earned: false });
  assert.deepEqual(SUP, { tier: 'supporter', three: true, plus: false, rare: false, surprise: false, designMax: 1, earned: true });
  for (const r of [MEMBER, PATRON]) assert.deepEqual(r, { tier: 'member', three: true, plus: true, rare: true, surprise: true, designMax: DESIGN_MAX, earned: true });
  // a member whose pack isn't here (yet): the 3D launch and the Rare start, souldew+ items wait for their art
  const noPack = rights({ signedIn: true, tier: 'plus', entitled: false });
  assert.equal(noPack.tier, 'member');
  assert.equal(noPack.plus, false);
  assert.equal(noPack.rare, true);
  assert.equal(launchRights('nonsense').tier, 'free');
});

test('the look that plays: Gold / Clear / Holo only with souldew+ – kept, "Your colours" plays meanwhile', () => {
  for (const id of ['gold', 'clear-shell', 'holo']) {
    assert.equal(playableLookFor(id, MEMBER), id);
    assert.equal(playableLookFor(id, SUP), 'your-colours');
    assert.equal(playableLookFor(id, FREE), 'your-colours');
  }
  assert.equal(playableLookFor('your-colours', SUP), 'your-colours');
  assert.equal(playableLookFor('cartridge', MEMBER), 'your-colours', 'an old 2D id is no look');
});

// a member's handheld: a souldew+ skin, souldew+ and earned stickers, holo finishes, three designs and Surprise me
const DOC = cleanHandheld({
  skin: 'night-train',
  stickers: { nds: [
    { id: 'heart', finish: 'holo', region: 'lid:top', U: [0, 0], rot: 0, scale: 1 },
    { id: 'comet', finish: 'glitter', region: 'lid:top', U: [20, 0], rot: 0, scale: 1 },
    { id: 'thread', finish: 'vinyl', region: 'lid:top', U: [-20, 0], rot: 0, scale: 1 },
  ] },
  designs: [
    { id: 'd1', name: 'One', skin: 'plain-dusk', stickers: {} },
    { id: 'd2', name: 'Two', skin: 'coral-shelf', stickers: {} },
    { id: 'd3', name: 'Three', skin: null, stickers: {} },
  ],
  active: 'd1',
  surprise: true,
});
const play = (r, o = {}) => lookToPlay(DOC, { member: r.plus, trophies: new Set(['winSoulLink']), surprise: r.surprise, rnd: () => 0.99, ...o });

test('member and patron: everything plays, Surprise me picks a design', () => {
  for (const r of [MEMBER, PATRON]) assert.equal(play(r).design, 'd3', 'Surprise me (rnd 0.99 → the last design)');
  const look = lookToPlay({ ...DOC, surprise: false }, { member: true, trophies: new Set(['winSoulLink']), surprise: true });
  assert.equal(look.skin, 'night-train');
  assert.deepEqual(look.stickers.nds.map((x) => [x.id, x.finish]), [['heart', 'holo'], ['comet', 'glitter'], ['thread', 'vinyl']]);
});

test('Supporter: the free skin and stickers, the earned ones – no souldew+ items, finishes or Surprise me', () => {
  const look = play(SUP);
  assert.equal(look.design, 'd1', 'no Surprise me: the look on the device (the worn design) plays');
  assert.equal(look.skin, null, 'a souldew+ skin plays as the theme colour');
  assert.deepEqual(look.stickers.nds.map((x) => [x.id, x.finish]), [['heart', 'vinyl'], ['thread', 'vinyl']], 'holo → vinyl, the souldew+ sticker out, the earned one in');
  assert.equal(lookToPlay({ skin: 'plain-dusk' }, { member: false, surprise: false }).skin, 'plain-dusk', 'Plain Dusk is free');
  assert.equal(lookToPlay(DOC, { member: false, trophies: new Set(), surprise: false }).stickers.nds.length, 1, 'an earned sticker needs its trophy');
});

test('Supporter: one saved design – designs from souldew+ are kept, they only stop new ones', () => {
  let h = cleanHandheld({ skin: 'plain-dusk' });
  h = saveAsNew(h, { id: 'd1', now: 1, max: SUP.designMax });
  assert.equal(h.designs.length, 1);
  assert.equal(saveAsNew(h, { id: 'd2', now: 2, max: SUP.designMax }), null, 'a second one: no');
  assert.equal(duplicateDesign(h, 'd1', { newId: 'd2', max: SUP.designMax }), null);
  assert.equal(saveAsNew(cleanHandheld({}), { id: 'd1', max: FREE.designMax }), null, 'free: none (no editor)');
  // member → Supporter: the three designs stay as they are
  assert.equal(cleanHandheld(DOC).designs.length, 3);
  assert.equal(saveAsNew(DOC, { id: 'd9', max: SUP.designMax }), null);
  assert.equal(saveAsNew(DOC, { id: 'd9', max: MEMBER.designMax }).designs.length, 4);
  assert.equal(saveAsNew(DOC, { id: 'd9', max: 99 }).designs.length, 4, 'never more than 12, whatever is passed');
});

test('a membership that ends: the config is untouched, what plays follows the tier', () => {
  const kept = JSON.stringify(DOC);
  const ended = rights({ signedIn: true, tier: 'none' }); // the tier dropped, the pack was wiped
  assert.equal(ended.three, false, 'Supporter → free: the 2D launch');
  play(ended);
  play(SUP);
  assert.equal(JSON.stringify(DOC), kept, 'playing never changes the handheld');
  assert.equal(cleanHandheld(JSON.parse(kept)).surprise, true, 'Surprise me stays switched on for when they come back');
  assert.deepEqual(designNotes(DOC, { member: false, trophies: new Set(['winSoulLink']) }), { plus: 3, earned: 0, empty: ['gba', '3ds', 'gb'] });
});

test('the 2D souldew+ launch animations and the "Cartridge" catalog item are gone', () => {
  assert.equal(CATALOG.launch, undefined);
  for (const s of CATALOG.skins) assert.equal(s.launch, undefined, `${s.id}: no paired launch animation`);
  assert.doesNotMatch(src('web/lib/cosmetics/index.mjs'), /playLaunch|previewLaunch|launchAvailable/);
  assert.doesNotMatch(src('scripts/plus-dev-pack.mjs'), /launch\.mjs|launch\/anims/);
});

test('the play view: 2D without a membership, 3D with one; the library tile and the editor follow', () => {
  const play = src('web/views/play.mjs');
  assert.match(play, /launchRightsNow\(\)\.three/);
  assert.match(play, /useState\(\(\) => mode === 'full' && !launchCfg\.off && three\)/, '3D: Supporter and up');
  assert.match(play, /mode === 'full' && !launchCfg\.off && !three\s*&& !globalThis\.matchMedia\?\.\('\(prefers-reduced-motion: reduce\)'\)\.matches/, '2D: free, never with reduced motion');
  assert.match(play, /<\$\{CartInsert\} target=/);
  assert.match(src('web/views/handheldtile.mjs'), /if \(!R\.three\) return null;/, 'no handheld tile in a free library');
  assert.match(src('web/views/handheld.mjs'), /R\.three \? html`<\$\{HandheldEditor\}/, 'the editor needs Supporter or souldew+');
  assert.match(src('web/views/handheld.mjs'), /Shows in the 3D launch – with Supporter or souldew\+\./);
  const settings = src('web/views/settings/launch.mjs');
  assert.match(settings, /if \(!R\.three\) return html`<\$\{LaunchSetting2D\}/);
  assert.doesNotMatch(settings, /launchRare|rareStart/i, 'the Rare start has no switch – automatic for members');
  // the tier (rights.rare) and the Rare start's data from the pack (test/handheld-looks.test.mjs)
  assert.match(src('web/views/launchstage.mjs'), /const rare = !reduced && rights\.rare && !!LK\?\.rare && Math\.random\(\) < 1 \/ RARE_ODDS;/);
});
