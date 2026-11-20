// Which cosmetics can be KEPT (owned) – the profile editor disables Save for a pick that isn't owned. Every kind, free
// and souldew+, with and without the membership (and with only a live preview). Regression: a nameplate is a banner's
// window and is listed under the catalog's banners – looking it up under "nameplates" found nothing, so every nameplate
// (free ones too) counted as not owned and a patron could never save one.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const S = await import('../web/lib/cosmetics/state.mjs');
const { CATALOG } = S;

const freeBanner = CATALOG.banners.find((b) => !b.plus).id;
const plusBanner = CATALOG.banners.find((b) => b.plus && !b.drop).id;
const freeFrame = CATALOG.frames.find((f) => !f.plus).id;
const plusFrame = CATALOG.frames.find((f) => f.plus).id;
const plusSkin = CATALOG.skins.find((s) => s.plus).id;

/** the pack's content for the premium items above (what a member's – or a preview's – pack holds in memory) */
const loaded = () => S.setContent({ banners: [{ id: plusBanner }], frameIds: [plusFrame], skinCss: [[plusSkin, '']] });

test('free items are owned by everyone – a free nameplate too', () => {
  S.setContent(null);
  S.update({ entitled: false, preview: false });
  assert.equal(S.owned('banners', freeBanner), true);
  assert.equal(S.owned('nameplates', freeBanner), true, 'a free nameplate can be kept without souldew+');
  assert.equal(S.owned('frames', freeFrame), true);
  assert.equal(S.owned('skins', 'classic'), true);
  assert.equal(CATALOG.launch, undefined, 'the 2D launch animations (Cartridge and the 13 souldew+ ones) are gone');
  assert.equal(S.owned('launch', 'cartridge'), false);
});

test('souldew+ items: owned with the membership and the pack – banner, nameplate, frame, skin', () => {
  loaded();
  S.update({ entitled: true, preview: false });
  for (const [kind, id] of [['banners', plusBanner], ['nameplates', plusBanner], ['frames', plusFrame], ['skins', plusSkin]]) {
    assert.equal(S.owned(kind, id), true, `${kind} ${id}`);
  }
});

test('souldew+ items without the membership: not owned (also while a live preview has them in memory)', () => {
  for (const preview of [false, true]) {
    loaded();
    S.update({ entitled: false, preview });
    for (const [kind, id] of [['banners', plusBanner], ['nameplates', plusBanner], ['frames', plusFrame], ['skins', plusSkin]]) {
      assert.equal(S.owned(kind, id), false, `${kind} ${id} (preview ${preview})`);
      assert.equal(S.has(kind, id), true, `${kind} ${id} is in memory`);
    }
  }
  S.setContent(null);
  S.update({ entitled: true, preview: false });
  assert.equal(S.owned('nameplates', plusBanner), false, 'a member whose pack is not loaded yet can not keep it either');
});

test('unknown ids are never owned', () => {
  S.update({ entitled: true });
  for (const kind of ['banners', 'nameplates', 'frames', 'skins']) assert.equal(S.owned(kind, 'no-such-item'), false, kind);
  S.update({ entitled: false });
});
