// What a still of "Your handheld" and the launch show for a member, a Supporter, a non-member and a member whose souldew+
// ended (web/lib/handheld/look.mjs ownedLook / playableLook): souldew+ skins, stickers, finishes and launch looks only
// with the rights (shared/handheld.mjs launchRights: the tier and the pack) AND their data from the pack – the handheld
// keeps them, so they're back when souldew+ is. Before this, Settings › Play and the library's
// tile drew the kept souldew+ skin, stickers and shell after the membership ended (or after a hand edit of config.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const ROOT = new URL('../', import.meta.url);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '/vendor/htm-preact.mjs') return next(new URL('node_modules/htm/preact/standalone.module.js', ROOT).href, ctx);
    return spec.startsWith('/shared/') ? next(new URL(spec.slice(1), ROOT).href, ctx) : next(spec, ctx);
  },
});
const L = await import('../web/lib/handheld/look.mjs');
const S = await import('../web/lib/cosmetics/state.mjs');
const { launchRights } = await import('../shared/handheld.mjs');

// the pack's looks as look.mjs reads them (content.handheld.looks, cleaned at load – looks.mjs, test/handheld-looks)
const LOOKS = { gold: { pulse: '#fff2d0' }, clear: {}, holo: {}, rare: { pulse: '#ffd080', glow: '#ffe0b0' }, finishes: { holo: {}, glitter: {} } };
const withPack = (looks = LOOKS) => { S.content.handheld = { looks }; };
const noPack = () => { S.content.handheld = null; };

const kept = { skin: 'night-train', stickers: { nds: [
  { id: 'crescent', finish: 'glitter', region: 'lid:top', U: [0, 0] }, // souldew+ sticker
  { id: 'heart', finish: 'holo', region: 'lid:top', U: [0.2, 0] }, // free sticker, souldew+ finish
], gba: [{ id: 'train', finish: 'vinyl', region: 'body:top', U: [0, 0] }] } };

test('a member wears all of it; the Gold shell plays', () => {
  S.update({ entitled: true });
  withPack();
  L.initHandheld(kept);
  const own = L.ownedLook();
  assert.equal(own.skin, 'night-train');
  assert.deepEqual(own.stickers.nds.map((x) => [x.id, x.finish]), [['crescent', 'glitter'], ['heart', 'holo']]);
  assert.equal(own.stickers.gba.length, 1);
  assert.equal(L.playableLook('gold'), 'gold');
  assert.equal(L.playableLook('clear-shell'), 'clear-shell');
  noPack();
});

test('a member whose pack has no looks data (an older pack): the still draws vinyl, the launch plays Your colours', () => {
  S.update({ entitled: true });
  withPack({ finishes: {} });
  L.initHandheld(kept);
  const own = L.ownedLook();
  assert.equal(own.skin, 'night-train', 'the skin is souldew+ by tier – its art comes with the pack');
  assert.deepEqual(own.stickers.nds.map((x) => [x.id, x.finish]), [['crescent', 'vinyl'], ['heart', 'vinyl']]);
  for (const id of ['gold', 'clear-shell', 'holo']) assert.equal(L.playableLook(id), 'your-colours', `${id} has no data`);
  noPack();
  S.update({ entitled: false });
});

test('a Supporter: the free skin, the free and earned stickers in vinyl – no souldew+ look, whatever the pack has', () => {
  withPack();
  L.initHandheld(kept);
  const sup = launchRights('supporter');
  const own = L.ownedLook(undefined, sup);
  assert.equal(own.skin, null);
  assert.deepEqual(own.stickers.nds.map((x) => [x.id, x.finish]), [['heart', 'vinyl']]);
  assert.equal(L.playableLook('gold', sup), 'your-colours');
  assert.equal(L.member(), false);
  noPack();
});

test('souldew+ ended (or never there, or written into config.json): nothing paid shows – the handheld keeps it', () => {
  S.update({ entitled: false });
  withPack(); // even with looks data in memory: no rights, nothing paid
  L.initHandheld(kept);
  const own = L.ownedLook();
  assert.equal(own.skin, null, 'the souldew+ skin is not drawn');
  assert.deepEqual(own.stickers.nds.map((x) => [x.id, x.finish]), [['heart', 'vinyl']], 'free sticker in vinyl, the souldew+ one gone');
  assert.equal(own.stickers.gba, undefined, 'a device with only souldew+ stickers shows none');
  for (const id of ['gold', 'clear-shell', 'holo']) assert.equal(L.playableLook(id), 'your-colours', `${id} plays Your colours`);
  assert.equal(L.playableLook('nonsense'), 'your-colours');
  assert.equal(L.handheld().skin, 'night-train', 'kept for when souldew+ is back');
  assert.equal(L.handheld().stickers.nds.length, 2);
  S.update({ entitled: true });
  assert.equal(L.ownedLook().skin, 'night-train', 'back the moment souldew+ is');
  S.update({ entitled: false });
  noPack();
});

test('Surprise me does not decide the still: it shows the current look', () => {
  S.update({ entitled: true });
  L.initHandheld({ ...kept, surprise: true, designs: [{ id: 'd1', name: 'A', skin: null, stickers: {} }, { id: 'd2', name: 'B', skin: null, stickers: {} }], active: 'd1' });
  assert.equal(L.ownedLook().skin, 'night-train');
  S.update({ entitled: false });
});

test('the launch preview plays the picked look – handed the config or launchConfig() of it (Settings handed the config)', () => {
  const cfg = { launchAnimation: 'gold', launchPace: 'quick', launchClear: 'jungle' };
  for (const c of [cfg, L.launchConfig(cfg)]) {
    const p = L.previewConfig(c);
    assert.equal(p.look, 'gold', 'not "Your colours" because the config has no `look`');
    assert.equal(p.pace, 'quick');
    assert.equal(p.clear, 'jungle');
  }
  assert.equal(L.previewConfig({ launchPace: 'off', bootAnimation: false }).pace, 'full', 'Preview plays even when the launch is off');
  assert.equal(L.previewConfig({}).look, 'your-colours');
  S.update({ entitled: false });
  withPack();
  assert.equal(L.playableLook(L.previewConfig(cfg).look), 'your-colours', 'and without souldew+ the stage still plays Your colours');
  S.update({ entitled: true });
  assert.equal(L.playableLook(L.previewConfig(cfg).look), 'gold', 'a member\'s Gold preview plays Gold when the pack has it');
  S.update({ entitled: false });
  noPack();
});
