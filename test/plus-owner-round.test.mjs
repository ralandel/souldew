// The owner's round on 3.0 (19.11.26, looked at on Windows): a permanent "Sign in" at the sidebar's foot (where the
// profile picture sits once signed in); the souldew+ page's "Your handheld" puts every skin on the 3D device (a souldew+
// one without souldew+ from its public preview picture, marked, never put on); the launch animations as ONE row of cards
// that show the animation, one selected; no favourite stars on the souldew+ page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { productShot } from '../scripts/handheld/preview-shot.mjs';

const ROOT = new URL('../', import.meta.url);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '/vendor/htm-preact.mjs') return next(new URL('node_modules/htm/preact/standalone.module.js', ROOT).href, ctx);
    return spec.startsWith('/shared/') ? next(new URL(spec.slice(1), ROOT).href, ctx) : next(spec, ctx);
  },
});
const W = await import('../web/lib/handheld/wrap.mjs');
const P = await import('../web/lib/handheld/pluspicks.mjs');
const { launchRights, launchTier, WRAPS } = await import('../shared/handheld.mjs');
const src = (p) => readFileSync(new URL(p, ROOT), 'utf8');

const rights = (o) => launchRights(launchTier(o), { entitled: !!o.entitled });
const FREE = rights({ signedIn: false });
const SUP = rights({ signedIn: true, tier: 'supporter' });
const MEMBER = rights({ signedIn: true, tier: 'plus', entitled: true });
const NOPACK = rights({ signedIn: true, tier: 'plus', entitled: false });

// ---- a wrap from its preview picture --------------------------------------------------------------------------------

/** a test wrap window (112 × 74 art px) shot like scripts/plus-dev-pack.mjs handheldPreviews: ×2, turned 4°, sheen */
function shotOfTestArt() {
  const w = 112, h = 74, k = 2;
  const art = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    // a dark sky over a bright ground from row 52 on, a vertical post at column 56
    const c = x === 56 ? [220, 60, 60] : y >= 52 ? [190, 170, 90] : [20, 24, 60];
    art.set([...c, 255], i);
  }
  const big = new Uint8ClampedArray(w * k * h * k * 4);
  for (let y = 0; y < h * k; y++) for (let x = 0; x < w * k; x++) big.set(art.subarray(((y >> 1) * w + (x >> 1)) * 4, ((y >> 1) * w + (x >> 1)) * 4 + 4), (y * w * k + x) * 4);
  return productShot({ w: w * k, h: h * k, rgba: big }, { angle: W.PREVIEW_SHOT.angle, seed: 'test', opaque: true });
}
const rgb = (p) => [p & 255, (p >>> 8) & 255, (p >>> 16) & 255];

test('a preview picture is turned level again and read at its art pixels: the horizon is flat, the post upright', () => {
  const shot = shotOfTestArt();
  const lv = W.levelPreview(shot);
  assert.ok(lv.w >= 80 && lv.w <= 112 && lv.h >= 50 && lv.h <= 74, `about the window's art size (${lv.w} × ${lv.h})`);
  assert.equal(lv.base, Math.round(lv.h / 2 + 35), 'the banner\'s last row: 35 art px below the centre, as in the thumb');
  // the ground starts on the same row at the left and the right edge (a turned picture would differ by ~6 rows)
  const groundRow = (x) => { for (let y = 0; y < lv.h; y++) if (rgb(lv.px[y * lv.w + x])[0] > 120 && rgb(lv.px[y * lv.w + x])[2] < 120) return y; return -1; };
  const l = groundRow(4), r = groundRow(lv.w - 5);
  assert.ok(l > 0 && Math.abs(l - r) <= 1, `level horizon (left ${l}, right ${r})`);
  // the post: the reddest column is the same near the top and the bottom of the sky
  const post = (y) => { let best = 0, at = -1; for (let x = 0; x < lv.w; x++) { const [R, G] = rgb(lv.px[y * lv.w + x]); if (R - G > best) { best = R - G; at = x; } } return at; };
  assert.ok(Math.abs(post(4) - post(l - 4)) <= 1, `upright post (${post(4)} / ${post(l - 4)})`);
  assert.ok([...lv.px].every((p) => p >>> 24 === 255), 'opaque');
});

test('the shot\'s sheen comes off again (mirrored, it would streak across the device)', () => {
  const shot = shotOfTestArt(); // seed 'test'
  const sky = (lv) => { const v = []; for (let y = 2; y < 20; y++) for (let x = 2; x < lv.w - 2; x++) if (Math.abs(x - lv.w / 2) > 4) v.push(rgb(lv.px[y * lv.w + x])[2]); return Math.max(...v) - Math.min(...v); };
  const withSheen = sky(W.levelPreview(shot));
  const without = sky(W.levelPreview(shot, undefined, 'test'));
  assert.ok(withSheen > 12, `the sheen shows in the sky (${withSheen})`);
  assert.ok(without <= 3, `a flat sky once it is off (${without})`);
  // the same hash as scripts/handheld/preview-shot.mjs
  assert.match(src('scripts/handheld/preview-shot.mjs'), /Math\.imul\(h \^ ch\.charCodeAt\(0\), 16777619\)[\s\S]*% 1000\) \/ 1000/);
  assert.match(src('scripts/handheld/preview-shot.mjs'), /const sheenAt = 0\.25 \+ hash\(seed\) \* 0\.5;[\s\S]*0\.16 \* Math\.exp\(-\(d \* d\) \/ 0\.006\)/);
  assert.match(src('scripts/plus-dev-pack.mjs'), /productShot\(\{ w: r\.w \* k, h: r\.h \* k, rgba \}, \{ angle: 4, seed: w\.id, opaque: true \}\)/, 'shot with the wrap\'s id, turned 4°');
});

test('the preview covers every panel – mirrored sideways, the sky above, the ground below – and never animates', () => {
  const lv = W.levelPreview(shotOfTestArt());
  const panels = [{ key: 'lid:top', w: 160, h: 130, cx: 200, base: 120, word: [20, 30] }, { key: 'base:bottom', w: 60, h: 40, cx: 200, base: 38, word: null }];
  const art = W.previewArt(lv, panels);
  assert.equal(art.animated, false);
  assert.equal(art.update(3), false);
  for (const p of panels) {
    const r = art.rects[p.key];
    assert.equal(r.w, p.w);
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) assert.equal(art.px[y * art.w + x] >>> 24, 255, `${p.key} filled at ${x},${y}`);
  }
  // the lid's top rows are sky (dark blue), its bottom rows ground (the bright yellow)
  const r = art.rects['lid:top'];
  const [R0, , B0] = rgb(art.px[r.y * art.w + r.x + 3]);
  const [R1, , B1] = rgb(art.px[(r.y + r.h - 1) * art.w + r.x + 3]);
  assert.ok(B0 > R0 && R1 > B1, 'sky above, ground below');
  assert.equal(W.previewArt(lv, []), null);
});

test('the moulded parts take the picture\'s own sky colour, like a real wrap', () => {
  const lv = W.levelPreview(shotOfTestArt());
  const c = W.previewComp('night-train', lv, 'gloss');
  assert.equal(c.preview, true);
  assert.equal(c.finish, 'gloss');
  for (const k of ['zen', 'plastic', 'keys', 'dark', 'border']) assert.match(c[k], /^#[0-9a-f]{6}$/, k);
  const lum = (h) => parseInt(h.slice(1, 3), 16) + parseInt(h.slice(3, 5), 16) + parseInt(h.slice(5, 7), 16);
  assert.ok(lum(c.border) < lum(c.dark) && lum(c.dark) < lum(c.zen) && lum(c.zen) < lum(c.plastic) && lum(c.plastic) < lum(c.keys), 'a dark sky: lighter plastic and keys, darker trims');
});

test('the scene draws the preview art instead of the recipe – only when the real wrap can\'t be drawn', () => {
  const scene = src('web/lib/handheld/scene.mjs');
  assert.match(scene, /o\.hh\.preview \? previewArt\(o\.hh\.preview, panels\) : wrapArt\(/);
  const look = src('web/lib/handheld/look.mjs');
  assert.match(look, /sceneWrap\(o\.skin\) \|\| \(o\.preview \?/, 'the real wrap first');
  assert.match(look, /previewSrc\('wraps', id\)/, 'the public preview picture, through the local server');
});

// ---- the showcase's skins -----------------------------------------------------------------------------------------

test('the showcase starts on the worn skin, else the first souldew+ skin – never a bare device', () => {
  assert.equal(P.showcaseSkin('plain-dusk'), 'plain-dusk');
  assert.equal(P.showcaseSkin('coral-shelf'), 'coral-shelf');
  const first = WRAPS.find((w) => w.tier === 'plus').id;
  assert.equal(P.showcaseSkin(null), first);
  assert.equal(P.showcaseSkin('no-such-skin'), first);
});

test('what a skin is for each account: a souldew+ skin without souldew+ is only ever a preview', () => {
  // free (signed out or no tier): no handheld to dress – the free skin is "free", a souldew+ one a preview
  assert.equal(P.showcaseState('plain-dusk', FREE, null), 'free');
  assert.equal(P.showcaseState(null, FREE, null), 'free');
  assert.equal(P.showcaseState('night-train', FREE, null), 'preview');
  // Supporter: the free skin may go on, souldew+ ones are previews
  assert.equal(P.showcaseState('plain-dusk', SUP, null), 'owned');
  assert.equal(P.showcaseState('plain-dusk', SUP, 'plain-dusk'), 'yours');
  assert.equal(P.showcaseState(null, SUP, 'plain-dusk'), 'owned', 'back to the theme colour');
  assert.equal(P.showcaseState('aurora-fjord', SUP, null), 'preview');
  // souldew+ with the pack: every skin; without the pack (yet): the art isn't here, a preview
  for (const w of WRAPS) assert.equal(P.showcaseState(w.id, MEMBER, 'coral-shelf'), w.id === 'coral-shelf' ? 'yours' : 'owned');
  assert.equal(P.showcaseState('aurora-fjord', NOPACK, null), 'preview');
  const view = src('web/views/handheldtile.mjs');
  const show = view.slice(view.indexOf('export function HandheldShowcase'));
  assert.match(show, /role="radiogroup" aria-label=\$\{t\('hh\.skins'/, 'the skins are a radio group (keys, arrows, the controller)');
  assert.match(show, /\$\{st === 'owned' && html`<button[^`]*onClick=\$\{wear\}/, 'only an owned skin can be put on');
  assert.equal((show.match(/setHandheld\(/g) || []).length, 2, 'put on (owned) and Surprise me – nothing else writes the handheld');
  assert.match(show, /hh-show-badge/, 'a souldew+ preview is marked on the stage');
});

// ---- the launch cards ---------------------------------------------------------------------------------------------

test('one row of launch cards, each with its tier; the one in use is selected first', () => {
  assert.deepEqual(P.LOOK_CARDS.map(([id]) => id), ['cartridge', 'your-colours', 'gold', 'clear-shell', 'holo']);
  assert.deepEqual(P.LOOK_CARDS.map(([, t]) => t), ['free', 'supporter', 'plus', 'plus', 'plus']);
  assert.deepEqual(P.lookInUse(FREE, { look: 'gold', clear: 'ice' }), { id: 'cartridge', tint: null }, 'free: the 2D module plays');
  assert.deepEqual(P.lookInUse(SUP, { look: 'gold', clear: 'ice' }), { id: 'your-colours', tint: null }, 'a kept souldew+ look waits');
  assert.deepEqual(P.lookInUse(MEMBER, { look: 'clear-shell', clear: 'ice' }), { id: 'clear-shell', tint: 'ice' });
  assert.deepEqual(P.lookInUse(MEMBER, { look: 'holo', clear: 'ice' }), { id: 'holo', tint: null });
});

test('who may switch to a card: never the 2D one from the page, souldew+ shells only with souldew+', () => {
  for (const R of [FREE, SUP, MEMBER]) assert.equal(P.lookUsable('cartridge', R), false);
  assert.equal(P.lookUsable('your-colours', FREE), false);
  assert.equal(P.lookUsable('your-colours', SUP), true);
  for (const id of ['gold', 'clear-shell', 'holo']) {
    assert.equal(P.lookUsable(id, SUP), false);
    assert.equal(P.lookUsable(id, NOPACK), false, 'the shell\'s data comes with the pack');
    assert.equal(P.lookUsable(id, MEMBER), true);
  }
  assert.equal(P.lookUsable('no-such-look', MEMBER), false);
  assert.equal(P.lookMedia('clear-shell', 'jungle'), 'clear-shell-jungle');
  assert.equal(P.lookMedia('clear-shell'), 'clear-shell-atomic');
  assert.equal(P.lookMedia('gold', 'ice'), 'gold');
});

test('the launch section: one radio group, a tick on the selected card, the cards show the animation (no tier row, no text list)', () => {
  const v = src('web/views/launchlooks.mjs');
  assert.equal((v.match(/role="radiogroup" aria-label=\$\{t\('plus\.kLaunch'/g) || []).length, 1);
  assert.match(v, /\$\{on && html`<span class="plus-look-check"/, 'only the selected card carries the tick');
  assert.match(v, /previewSrc\('launch', name, \{ loop \}\)/, 'the previews\' loop first');
  assert.match(v, /<\$\{LaunchLoop\}/, 'else the real launch, playing in the selected card');
  assert.match(v, /<\$\{CartInsert\}[^>]*sound=\$\{false\}/, 'the 2D module, silent');
  assert.match(v, /api\.post\('\/api\/config', \{ launchAnimation: sel/, 'the same setting as Settings › Play');
  const plus = src('web/views/plus.mjs');
  assert.doesNotMatch(plus, /LaunchTiers|plus-family/, 'the tier row and the text list are gone from the page');
  assert.match(plus, /<\$\{LaunchLooks\} \/>/);
  // the previews may hold the launch looks (and the server and the service take launch/)
  assert.match(src('web/lib/cosmetics/previews.mjs'), /launch: 'launch'/);
  assert.match(src('server/lib/pluspreviews.mjs'), /\^\(banners\|nameplates\|frames\|launch\|/);
  assert.match(src('scripts/plus-dev-pack.mjs'), /renderLaunchPreviews\(\{ looks: HH\.looks/);
});

test('no favourite stars on the souldew+ page (they stay in the profile editor and the pickers)', () => {
  const plus = src('web/views/plus.mjs');
  assert.doesNotMatch(plus, /FavScope|favourites\.mjs/);
  assert.doesNotMatch(src('web/plus.css'), /fav-star|plus-fav/);
  assert.match(src('web/views/profileedit.mjs'), /FavScope|Fav/, 'the profile editor keeps them');
});

// ---- the sidebar ------------------------------------------------------------------------------------------------

test('signed out, the sidebar\'s foot says "Sign in" with the Discord mark – the same sign-in as Settings', () => {
  const app = src('web/app.mjs');
  const fn = app.slice(app.indexOf('function RailSignIn('), app.indexOf('/** One section of the rail'));
  // (souldew Renaissance: nothing either in a build without the account, or when the server says it has none)
  assert.match(fn, /if \(!EDITION\.accounts \|\| acct\.session\?\.signedIn \|\| acct\.session\?\.off\) return null;/, 'nothing signed in, or without the account');
  // 3.0.1: while the saved sign-in is still being read, "Loading …" in the chip's place – never "Sign in" for a moment
  assert.match(fn, /if \(!acct\.known\) \{\s*return html`<div class="rail-signin-wrap"><div class="rail-me rail-signin rail-acct-loading" role="status">/, 'loading while unknown');
  assert.match(fn, /t\('common\.loading', 'Loading …'\)/);
  assert.match(fn, /await signIn\(\);/, 'lib/account.mjs signIn – what Settings › Account calls');
  assert.match(fn, /<\$\{Icon\} name="discord"/);
  assert.match(fn, /class="rail-me rail-signin"/, 'the profile chip\'s own class: every skin styles both alike');
  assert.match(fn, /cancelSignIn\(\)/, 'waiting for the browser can be stopped');
  assert.match(app, /\$\{social\.signedIn && social\.me && html`<a class="rail-me"[\s\S]*?\$\{!social\.signedIn && html`<\$\{RailSignIn\} toast=\$\{toast\} \/>`\}/, 'right where the picture sits');
  assert.match(src('web/views/settings/account.mjs'), /acct-discord[^>]*><\$\{Icon\} name="discord"/, 'Settings shows the same mark');
});

test('the Discord mark is on the icons\' 16 × 16 grid', () => {
  const icons = src('web/lib/icons.mjs');
  const m = icons.match(/ {2}discord: \[([\s\S]*?)\],/);
  assert.ok(m);
  const rows = m[1].match(/'[.#]+'/g).map((r) => r.slice(1, -1));
  assert.equal(rows.length, 16);
  assert.ok(rows.every((r) => r.length === 16));
  // optically centred: as many empty columns left as right, rows above as below
  const cols = rows[0].split('').map((_, x) => rows.some((r) => r[x] === '#'));
  const ys = rows.map((r) => r.includes('#'));
  assert.equal(cols.indexOf(true), 15 - cols.lastIndexOf(true));
  assert.equal(ys.indexOf(true), 15 - ys.lastIndexOf(true), 'vertically centred');
});

test('the souldew+ launch looks\' stills ship with the app until the previews carry them – small public pictures', async () => {
  const { existsSync, statSync } = await import('node:fs');
  const { SHIPPED_STILLS } = await import('../scripts/handheld/launch-stills.mjs');
  assert.deepEqual(P.SHIPPED_STILLS, SHIPPED_STILLS, 'the app and the script name the same pictures');
  for (const n of SHIPPED_STILLS) {
    const f = new URL(`web/assets/handheld/launch/${n}.webp`, ROOT);
    assert.ok(existsSync(f), n);
    assert.ok(statSync(f).size < 24 * 1024, `${n} stays small`);
  }
  assert.equal(P.shippedStill('gold'), '/assets/handheld/launch/gold.webp');
  assert.equal(P.shippedStill('your-colours'), null, '"Your colours" is drawn live');
  assert.equal(P.shippedStill('nope'), null);
  const v = src('web/views/launchlooks.mjs');
  assert.ok(v.indexOf("previewSrc('launch', name") < v.indexOf('shippedStill(name)'), 'the previews first');
});

// 3.0.1: at the start the saved sign-in is read in the background (the keychain may take a moment) – until then every
// account place says "Loading …", never "signed out" for a moment (lib/account.mjs `known`)
test('account at start: "Loading …" everywhere until the saved sign-in is read – Settings, Friends, the profile, souldew+', () => {
  const settings = src('web/views/settings/account.mjs');
  assert.match(settings, /const on = acct\.known && acct\.session\.signedIn;/);
  assert.match(settings, /\$\{!acct\.known \? html`<p class="muted small">\$\{t\('common\.loading', 'Loading …'\)\}/);
  assert.match(settings, /\$\{acct\.known && !on && html`<\$\{Group\} title="souldew\+">/, 'no souldew+ sign-in offer while unknown');
  for (const f of ['web/views/friends.mjs', 'web/views/profile.mjs', 'web/views/plus.mjs']) {
    assert.match(src(f), /if \(!acct\.known\) return html`<div class="empty-state"><p class="muted">\$\{t\('common\.loading', 'Loading …'\)\}<\/p><\/div>`;/, f);
    assert.doesNotMatch(src(f), /if \(!acct\.loaded\) return null;/, `${f}: not the old "answered once" check`);
  }
  // `known` is the server's word that it has read the saved sign-in (an older server: as soon as it answers)
  assert.match(src('web/lib/account.mjs'), /known: r\.session\?\.loaded !== false/);
});
