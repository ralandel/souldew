// souldew+ skins: apply, preview and revert; a wish waits for the pack and gives way when the membership ends; the
// pack's assets are inlined so the CSP (font-src / img-src data:) holds. A minimal document stands in for the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- a tiny document: <html data-*>, <head> with <style data-cos-skin>, querySelector(All) for those styles
const styles = [];
const el = (tag) => ({ tagName: tag, dataset: {}, textContent: '', remove() { const i = styles.indexOf(this); if (i >= 0) styles.splice(i, 1); } });
globalThis.document = {
  documentElement: { dataset: {} },
  head: { appendChild: (s) => styles.push(s) },
  createElement: el,
  querySelector: (sel) => { const m = /data-cos-skin="([^"]+)"/.exec(sel); return styles.find((s) => s.dataset.cosSkin === m?.[1]) || null; },
  querySelectorAll: () => [...styles],
};
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

const S = await import('../web/lib/cosmetics/state.mjs');
const K = await import('../web/lib/cosmetics/skins.mjs');
const html = document.documentElement;
const packWith = (entitled, skins = ['moss', 'sakura']) => {
  S.setContent({
    skinCss: skins.map((id) => [id, `html[data-skin='${id}'] { --shell: #123; } @font-face { font-family: X; src: url('pack:fonts/x.woff2') format('woff2'); } .y { background: url('pack:assets/missing.svg'); }`]),
    files: [['fonts/x.woff2', new Uint8Array([119, 79, 70, 50])]],
  });
  S.update({ entitled, preview: !entitled });
};
const noPack = () => { S.setContent(null); S.update({ entitled: false, preview: false }); };

test('a premium skin waits for the pack, then applies; classic until then', () => {
  noPack();
  assert.equal(K.applySkin('moss'), false);
  assert.equal(html.dataset.skin, undefined);
  assert.equal(K.skinState().pending, 'moss');
  packWith(true);
  assert.equal(html.dataset.skin, 'moss');
  assert.equal(K.skinState().committed, 'moss');
  assert.equal(styles.length, 1, 'only the skin on screen is injected');
  assert.equal(store.get('sl-skin'), 'moss');
});

test('the pack assets become data: URLs (the app CSP allows data: fonts and images, not blob:)', () => {
  packWith(true);
  const css = K.skinCss('moss');
  assert.match(css, /url\('data:font\/woff2;base64,d09GMg=='\)/);
  assert.doesNotMatch(css, /pack:/, 'no pack: URL left');
  assert.match(css, /background: none/, 'an asset the pack lacks is dropped, never fetched');
});

test('preview → revert puts the committed skin back; the preview is never saved', () => {
  packWith(true);
  K.applySkin('moss');
  assert.equal(K.previewSkin('sakura'), true);
  assert.equal(html.dataset.skin, 'sakura');
  assert.deepEqual([K.skinState().committed, K.skinState().previewing], ['moss', 'sakura']);
  assert.equal(store.get('sl-skin'), 'moss');
  K.previewSkin('classic');
  assert.equal(html.dataset.skin, undefined, 'previewing the plain look');
  K.endPreview();
  assert.equal(html.dataset.skin, 'moss');
  assert.equal(K.skinState().previewing, null);
  assert.equal(K.previewSkin('glacier'), false, 'a skin whose stylesheet is not loaded can not be previewed');
  assert.equal(html.dataset.skin, 'moss');
});

test('without the membership a preview pack can preview but not keep', () => {
  packWith(false);
  K.applySkin(null);
  assert.equal(K.previewSkin('moss'), true);
  assert.equal(html.dataset.skin, 'moss');
  assert.equal(K.applySkin('moss'), false, 'not owned');
  K.endPreview();
  assert.equal(html.dataset.skin, undefined);
});

test('the membership ends: back to classic, the choice is remembered for when it returns', () => {
  packWith(true);
  K.applySkin('sakura');
  assert.equal(html.dataset.skin, 'sakura');
  noPack();
  assert.equal(html.dataset.skin, undefined);
  assert.equal(styles.length, 0, 'premium CSS removed from the page');
  assert.equal(K.skinState().pending, 'sakura');
  packWith(true);
  assert.equal(html.dataset.skin, 'sakura');
});

test('listSkins: the catalog with groups, the souldew+ flag, owned / available', () => {
  packWith(true, ['moss']);
  const list = K.listSkins();
  assert.equal(list.length, 17, 'classic and the 16 colour skins – no editions');
  assert.deepEqual([...new Set(list.map((s) => s.group))].sort(), ['dark', 'light']);
  const classic = list.find((s) => s.id === 'classic');
  assert.deepEqual([classic.plus, classic.owned], [false, true]);
  const moss = list.find((s) => s.id === 'moss');
  assert.deepEqual([moss.plus, moss.owned, moss.available, moss.launch], [true, true, true, undefined], 'no paired 2D launch animation any more');
  assert.equal(list.find((s) => s.id === 'glacier').owned, false);
  for (const gone of ['fieldbook', 'clearshell', 'woodgrain', 'enamel']) assert.equal(list.some((s) => s.id === gone), false, `${gone} is not a souldew+ theme any more`);
  for (const s of list) assert.ok(s.name && s.sw.length >= 5 && ['dark', 'light'].includes(s.group), s.id);
});

test('a stored theme the catalog no longer has (the 2.x editions) is classic – not a wish that waits forever', () => {
  packWith(true, ['moss', 'fieldbook']);
  store.set('sl-skin', 'fieldbook');
  K.applyStoredSkin();
  assert.equal(html.dataset.skin, undefined);
  assert.deepEqual([K.skinState().committed, K.skinState().pending], ['classic', null]);
  assert.equal(store.has('sl-skin'), false, 'forgotten');
  assert.equal(K.applySkin('woodgrain'), true, 'classic is always owned');
  assert.equal(K.skinState().pending, null);
});
