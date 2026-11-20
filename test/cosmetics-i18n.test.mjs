// souldew+ cosmetics in the player's language: every theme's line under its name and every collection's name (After
// Dark, Four Seasons, Earned …) – they showed in English in every language. The generated catalog stays English; the
// words are looked up by the catalog's ids (web/lib/cosmetics/strings.mjs) and every key is translated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// web/lib/*.mjs import browser paths (/shared/…, /lib/…): map them onto the project folder.
const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('/shared/') || spec.startsWith('/vendor/')) return next(ROOT + spec.slice(1), ctx);
    if (spec.startsWith('/lib/')) return next(`${ROOT}web${spec}`, ctx);
    return next(spec, ctx);
  },
});

const I18N = (l) => JSON.parse(readFileSync(new URL(`../web/i18n/${l}.json`, import.meta.url), 'utf8'));
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.document = {
  documentElement: { dataset: {}, lang: 'en' }, head: { appendChild() {} }, createElement: () => ({ dataset: {}, remove() {} }),
  querySelector: () => null, querySelectorAll: () => [],
};
globalThis.fetch = async (url) => ({ json: async () => I18N(String(url).match(/\/i18n\/(\w+)\.json/)[1]) });

const { setLang } = await import('../web/lib/i18n.mjs');
const C = await import('../web/lib/cosmetics/index.mjs');
const { listSkins } = await import('../web/lib/cosmetics/skins.mjs');
const { cosmeticStrings } = await import('../web/lib/cosmetics/strings.mjs');

test('cosmetics: the themes\' lines and the collections\' names in the player\'s language', async () => {
  await setLang('en');
  const en = C.catalog();
  assert.equal(en.skins.find((s) => s.id === 'dusk').hint, 'Plum into midnight');
  assert.equal(en.collections.banners.find((c) => c.id === 'earned').name, 'Earned');
  await setLang('de');
  const de = C.catalog();
  assert.equal(de.skins.find((s) => s.id === 'dusk').hint, 'Pflaume bis Mitternacht');
  assert.equal(listSkins().find((s) => s.id === 'dusk').hint, 'Pflaume bis Mitternacht');
  assert.equal(de.collections.banners.find((c) => c.id === 'seasons').name, 'Vier Jahreszeiten');
  assert.equal(de.collections.banners.find((c) => c.id === 'earned').name, 'Verdient');
  // the same id, two collections: banners' "After Dark", frames' "Night Shift"
  assert.equal(de.collections.banners.find((c) => c.id === 'night').name, 'Nach Einbruch der Nacht');
  assert.equal(de.collections.frames.find((c) => c.id === 'night').name, 'Nachtschicht');
  // every item carries its collection's name in the language too – a nameplate as its banner
  const earned = de.banners.find((b) => b.earned);
  assert.equal(earned.collectionName, 'Verdient');
  assert.equal(de.nameplates.find((n) => n.id === earned.id).collectionName, 'Verdient');
  assert.ok(de.frames.filter((f) => f.collection === 'night').every((f) => f.collectionName === 'Nachtschicht'));
  for (const b of de.banners) assert.notEqual(b.collectionName, undefined, b.id);
  await setLang('en');
});

test('cosmetics: every theme line and collection name has a translation in every language', () => {
  const keys = cosmeticStrings();
  assert.ok(Object.keys(keys).length >= 17 + 2 * 13, 'the themes, the banner and the frame collections, Earned');
  for (const l of ['de', 'fr', 'es', 'it']) {
    const d = I18N(l);
    for (const [k, en] of Object.entries(keys)) {
      assert.equal(typeof d[k], 'string', `${l}: ${k}`);
      assert.ok(d[k].length <= Math.max(48, en.length * 2), `${l}: ${k} is short like the English`);
    }
  }
});

test('the battle and rock-paper-scissors cards: "Lv" and "vs" through the dictionaries', () => {
  for (const f of ['../web/views/together.mjs', '../web/views/rps.mjs']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, />vs<|[`>]Lv \$\{| · Lv /, f);
  }
  assert.equal(I18N('fr')['common.vs'], 'contre');
});
