// The souldew+ page (web/views/plus.mjs, data in web/lib/pluspage.mjs): one version per viewer – signed out, free,
// Supporter, souldew+ member, Legend – the owner's three tiers and prices, a curated handful of each kind (never the
// whole catalog), the viewer's own look on the hero card, and the tier buttons per state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const P = await import('../web/lib/pluspage.mjs');
const CATALOG = (await import('../web/lib/cosmetics/content/catalog.mjs')).default;

const acct = (tier, extra = {}) => ({ session: { signedIn: true }, me: { name: 'Robin', handle: 'robin', entitlement: { tier, until: tier === 'none' ? null : 1797559246000 }, ...extra } });

test('states: signed out, free, Supporter, souldew+, Legend', () => {
  assert.deepEqual(P.plusState({ session: { signedIn: false }, me: null }), { kind: 'signedOut', tier: 'none', name: '', until: null });
  assert.equal(P.plusState(null).kind, 'signedOut');
  assert.equal(P.plusState({ session: { signedIn: false }, me: { name: 'stale' } }).kind, 'signedOut', 'a kept profile without a session counts as signed out');
  assert.equal(P.plusState(acct('none')).kind, 'free');
  assert.equal(P.plusState(acct('supporter')).kind, 'supporter');
  assert.deepEqual(P.plusState(acct('plus')), { kind: 'member', tier: 'plus', name: 'Robin', until: 1797559246000 });
  assert.equal(P.plusState(acct('patron')).kind, 'patron');
  // who gets the looks, who is thanked
  const k = (t) => P.plusState(acct(t));
  assert.deepEqual(['none', 'supporter', 'plus', 'patron'].map((t) => P.hasPlusLooks(k(t))), [false, false, true, true]);
  assert.deepEqual(['none', 'supporter', 'plus', 'patron'].map((t) => P.isMember(k(t))), [false, true, true, true]);
  assert.equal(P.isMember(P.plusState(null)), false);
});

test('tiers: Supporter 3 €, souldew+ 5 € (the featured one), Legend 10 € – and each card\'s button per viewer', () => {
  assert.deepEqual(P.TIERS.map((x) => [x.id, x.price]), [['supporter', 3], ['plus', 5], ['patron', 10]]);
  assert.deepEqual(P.TIERS.filter((x) => x.main).map((x) => x.id), ['plus']);
  const act = (t) => P.TIERS.map((x) => P.tierAction(t === null ? P.plusState(null) : P.plusState(acct(t)), x.id));
  assert.deepEqual(act(null), ['join', 'join', 'join']);
  assert.deepEqual(act('none'), ['join', 'join', 'join']);
  assert.deepEqual(act('supporter'), ['current', 'switch', 'switch']);
  assert.deepEqual(act('plus'), ['switch', 'current', 'switch']);
  assert.deepEqual(act('patron'), ['switch', 'switch', 'current']);
});

test('the hero card: you in the page\'s look – a member in their own picks where they have them', () => {
  assert.deepEqual(P.heroLook(null, P.plusState(null)), P.HERO_LOOK);
  // a free account's own (free) picks don't replace the souldew+ look the card shows
  assert.deepEqual(P.heroLook({ banner: 'plain-dusk' }, P.plusState(acct('none'))), P.HERO_LOOK);
  assert.deepEqual(P.heroLook({ banner: 'aurora-fjord', frame: null }, P.plusState(acct('plus'))), { ...P.HERO_LOOK, banner: 'aurora-fjord' });
});

test('curated: a handful of the strongest per kind – every pick exists, is souldew+ and no unreleased drop', () => {
  const cat = { ...CATALOG, nameplates: CATALOG.banners };
  const c = P.curatedFrom(cat);
  for (const [kind, ids] of Object.entries(P.CURATED)) {
    assert.equal(c[kind].length, ids.length, `${kind}: all picks are in the catalog`);
    assert.ok(ids.length >= 2 && ids.length <= 5, `${kind}: a handful, not a wall`);
    for (const x of c[kind]) assert.ok(x.plus && !x.drop, `${kind}/${x.id}`);
  }
  assert.ok(c.skins.some((s) => s.group === 'light') && c.skins.some((s) => s.group === 'dark'), 'light and dark themes');
  for (const [k, id] of Object.entries(P.HERO_LOOK)) assert.ok(CATALOG[k === 'nameplate' ? 'banners' : `${k}s`].some((x) => x.id === id && x.plus), k);
  const n = P.plusCounts(CATALOG);
  assert.equal(n.skins, 16);
  assert.ok(n.banners > 100 && n.frames > 60);
  assert.equal(n.launch, undefined, 'the 2D launch animations are gone');
  assert.equal(c.launch, undefined);
});

test('the page: one hero per state, the viewer\'s real picture through the local avatar proxy only, preview media for what isn\'t owned', () => {
  const src = readFileSync(new URL('../web/views/plus.mjs', import.meta.url), 'utf8');
  assert.match(src, /plusState\(acct\)/);
  assert.match(src, /me\.avatar\.startsWith\('\/api\/account\/avatar\?'\)/);
  assert.match(src, /PreviewPicture\} kind="banners"/);
  assert.match(src, /PreviewPicture\} kind="frames"/);
  assert.match(src, /PreviewPicture\} kind="nameplates"/);
  assert.match(src, /prefersReduced\(\)/, 'loops stay still with reduced motion');
  assert.doesNotMatch(src, /Modal|alert\(|confirm\(/, 'no pop-ups');
  assert.match(src, /openExternal\(LINKS\.membership\)/, 'joining and managing happen on Buy Me a Coffee');
  // the owner's order: banners, frames and nameplates, launch animations first – the colour themes after them, small
  const at = (re) => src.search(re);
  const g = src.slice(src.indexOf('function Gallery('));
  assert.ok(g.search(/plus\.kBanners/) < g.search(/plus\.kFrames/) && g.search(/plus\.kFrames/) < g.search(/plus\.kLaunch/) && g.search(/plus\.kLaunch/) < g.search(/<\$\{Themes\}/), 'themes come last');
  assert.ok(at(/function Themes/) > 0 && !/previewSrc\('skins'/.test(src), 'no big screenshot of the app – a small live preview');
});

test('colour themes: every souldew+ theme in the strip (dark first, no editions), each wearing a matching banner, frame and nameplate', () => {
  const cat = { skins: CATALOG.skins, banners: CATALOG.banners, frames: CATALOG.frames };
  const skins = P.plusSkins(cat);
  assert.equal(skins.length, 16);
  assert.ok(skins.every((s) => s.plus), 'souldew+ only – the free look isn’t offered as a theme');
  assert.equal(skins.findIndex((s) => s.group === 'light'), skins.filter((s) => s.group === 'dark').length, 'dark ones first');
  assert.ok(!skins.some((s) => /edition/i.test(`${s.id} ${s.name} ${s.hint}`)), 'themes are colour skins only');
  for (const s of skins) {
    const look = P.themeLook(cat, s.id);
    const b = CATALOG.banners.find((x) => x.id === look.banner);
    const f = CATALOG.frames.find((x) => x.id === look.frame);
    assert.ok(b?.plus && f?.plus, `${s.id}: real souldew+ items (${look.banner}, ${look.frame})`);
    assert.equal(look.nameplate, look.banner);
  }
  assert.equal(P.themeLook(cat, 'moss').banner, 'forest-floor', 'the banner made for the theme');
  assert.deepEqual(P.themeLook({}, 'moss'), P.HERO_LOOK, 'no catalog: the hero look');
  // the preview reads the theme's own colours
  const v = P.themeVars(CATALOG.skins.find((s) => s.id === 'soft-light').sw);
  assert.match(v, /--tp-bg:#f5f4f1;--tp-panel:#fcfbf9;--tp-ink:#1d1e22;/);
  assert.equal(P.themeVars(null), '');
});

test('“Get souldew+” without the page wired up yet opens the Buy Me a Coffee membership page, never the tip jar', () => {
  const src = readFileSync(new URL('../web/lib/cosmetics/plus.mjs', import.meta.url), 'utf8');
  assert.match(src, /openExternal\(LINKS\.membership\)/);
  assert.doesNotMatch(src, /LINKS\.coffee/);
  // (souldew Renaissance: the links live in shared/edition.mjs)
  const links = readFileSync(new URL('../shared/edition.mjs', import.meta.url), 'utf8');
  assert.match(links, /membership: 'https:\/\/buymeacoffee\.com\/souldew\/membership'/);
});
