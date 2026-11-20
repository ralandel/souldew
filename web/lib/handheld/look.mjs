// "Your handheld" on the page: the local setting (config.json `handheld`, shared/handheld.mjs keeps the rules), what the
// launch plays from it, and the 3D scene posed still (the editor's stage, the library's tile, the souldew+ page). The
// scene and three.js are imported only here and only when something draws a device – never at the app's start.
import { useState, useEffect } from '/vendor/htm-preact.mjs';
import { api } from '../api.mjs';
import { cleanHandheld, emptyHandheld, lookToPlay, wrapById, cleanLaunchLook, cleanLaunchPace, cleanClearTint, CLEAR_TINTS, devKey, launchTier, launchRights, playableLookFor, LAUNCH_DEFAULT } from '/shared/handheld.mjs';
import { layoutKey } from './layouts.mjs';
import { packState, onChange as onCosmetics } from '../cosmetics/index.mjs';
import { accountState, onAccount } from '../account.mjs';
import { content } from '../cosmetics/state.mjs';
import { earnedTrophies } from '../trophies.mjs';
import { favourites } from '../favourites.mjs';
import { loadAtlas } from './stickers.mjs';
import { wrapComp, recipeOf, levelPreview, previewComp } from './wrap.mjs';
import { previewSrc } from '../cosmetics/previews.mjs';
import { hasLook } from './looks.mjs';
import { placeLayout } from './geometry.mjs';

let doc = emptyHandheld();
const subs = new Set();
const notify = () => { for (const fn of [...subs]) fn(doc); };

/** At boot, from /api/status config.handheld. */
export function initHandheld(raw) {
  doc = cleanHandheld(raw);
  notify();
}
export const handheld = () => doc;

/** The handheld; re-renders when it changes (here or in another view). */
export function useHandheld() {
  const [, tick] = useState(0);
  useEffect(() => {
    const fn = () => tick((n) => n + 1);
    subs.add(fn);
    return () => subs.delete(fn);
  }, []);
  return doc;
}

// saved the moment it changes, like every setting – one write at a time, always the latest look
let writing = Promise.resolve();
let pending = false;
function persist() {
  if (pending) return;
  pending = true;
  writing = writing.then(() => new Promise((r) => setTimeout(r, 250))).then(() => {
    pending = false;
    return api.post('/api/config', { handheld: doc });
  }).catch((e) => {
    pending = false;
    console.warn('handheld not saved', e);
  });
}
/** Change the handheld (a clean copy is kept and saved). */
export function setHandheld(next) {
  doc = cleanHandheld(next);
  notify();
  persist();
}
/** Waits for the last write (the editor's Done). */
export const handheldSaved = () => writing;

// ---- the launch settings ----------------------------------------------------------------------------------------------

/** { look, pace, clear, off } from the config: the animation's family id, Full / Quick / Off, the Clear shell's colour. */
export function launchConfig(cfg) {
  const look = cleanLaunchLook(cfg?.launchAnimation);
  const pace = cleanLaunchPace(cfg?.launchPace);
  return { look, pace, clear: cleanClearTint(cfg?.launchClear), off: pace === 'off' || cfg?.bootAnimation === false };
}
/**
 * The launch a preview plays (Settings, the editor, the souldew+ page): launchConfig() of the config – a caller may hand
 * either the config itself or launchConfig() of it – and Off plays Full (pressing Preview asks to see it). The look is
 * the member's pick; LaunchStage still plays only what the account's rights and the pack allow (playableLook).
 */
export function previewConfig(cfg) {
  const L = cfg && typeof cfg === 'object' && 'look' in cfg && 'pace' in cfg ? cfg : launchConfig(cfg);
  return { ...L, pace: L.pace === 'off' ? 'full' : L.pace, off: false };
}

/**
 * What this account's launch may use right now (shared/handheld.mjs launchRights): the verified tier from the account
 * store (signed out: free), souldew+ items with the pack loaded. Read at the moment a game starts – never a request.
 */
export function launchRightsNow() {
  const a = accountState();
  const entitled = !!packState().entitled;
  return launchRights(launchTier({ signedIn: !!a.session?.signedIn, tier: a.me?.entitlement?.tier || 'none', entitled }), { entitled });
}
/** launchRightsNow(), re-rendered when the account or the pack changes (a membership linked, ended, the pack loaded). */
export function useLaunchRights() {
  const [, tick] = useState(0);
  useEffect(() => {
    const fn = () => tick((n) => n + 1);
    const a = onAccount(fn), b = onCosmetics(fn);
    return () => { a(); b(); };
  }, []);
  return launchRightsNow();
}
/** souldew+ items usable (the pack is here) */
export const member = () => launchRightsNow().plus;
/** The souldew+ looks from the verified pack (looks.mjs cleanLooks) – null without the pack, or in an older one. */
export const paidLooks = () => content.handheld?.looks || null;
/**
 * The launch look this account can play: a souldew+ look needs the tier (launchRights: souldew+ with the pack loaded)
 * AND its data from the pack (Gold, Clear shell, Holo label aren't in the app) – else "Your colours" (the choice is kept).
 */
export const playableLook = (id, rights = launchRightsNow()) => {
  const p = playableLookFor(id, rights);
  return hasLook(p, paidLooks()) ? p : LAUNCH_DEFAULT;
};

/** What the launch plays from the handheld right now: owned items only, Surprise me picks a design (shared/handheld.mjs). */
export function lookNow(rnd = Math.random, rights = launchRightsNow()) {
  // the trophies as the app last synced them (it does at its start) – never a sync here: that is the server's work at
  // the very moment it starts the game. Not known yet: the earned stickers wait for the next start.
  const tr = earnedTrophies();
  return lookToPlay(doc, { member: rights.plus, trophies: tr || new Set(), favDesigns: favourites().design || [], rnd, surprise: rights.surprise });
}

/**
 * The current look as this account can wear it right now – what a still of "Your handheld" shows (Settings, the library's
 * tile): souldew+ skin, stickers and finishes only with souldew+ (launchRights: the tier and the pack), holo / glitter
 * only with their data from the pack – like the launch itself. A Supporter sees the free skin, the free and the earned
 * stickers. The handheld keeps them all (the editor shows them as kept), so they are back the moment souldew+ is.
 */
export function ownedLook(d = doc, rights = launchRightsNow()) {
  const own = lookToPlay(d, { member: rights.plus, trophies: earnedTrophies() || new Set(), surprise: false });
  // holo / glitter are drawn from the pack's data (looks.mjs finishIndex) – without it the launch draws vinyl, so does this
  const fin = paidLooks()?.finishes || {};
  const stickers = {};
  for (const [k, list] of Object.entries(own.stickers)) stickers[k] = list.map((st) => (st.finish !== 'vinyl' && !fin[st.finish] ? { ...st, finish: 'vinyl' } : st));
  return { ...own, stickers };
}

/** a wrap for the scene: { skin: composition + finish, recipe } – or null (the theme colour, or its data isn't here) */
export function sceneWrap(id) {
  const meta = wrapById(id);
  const comp = meta && wrapComp(id);
  const recipe = recipeOf(comp);
  return comp && recipe ? { skin: { ...comp, finish: meta.finish }, recipe } : null;
}

const previewWraps = new Map();
/**
 * A souldew+ wrap this account can't draw (no pack) as its public preview picture, for the souldew+ page's showcase:
 * { comp (wrap.mjs previewComp), lv (levelPreview) } – null when there is no picture (the previews aren't in yet, or
 * none for this wrap). Cached per picture while the app runs.
 */
export function previewWrap(id) {
  const meta = wrapById(id);
  const src = meta && previewSrc('wraps', id);
  if (!src) return Promise.resolve(null);
  if (previewWraps.has(src)) return previewWraps.get(src);
  const p = (async () => {
    const r = await fetch(src, { headers: { 'x-soullink': '1' } });
    if (!r.ok) return null;
    const bmp = await createImageBitmap(await r.blob());
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    bmp.close?.();
    const lv = levelPreview({ w: c.width, h: c.height, rgba: g.getImageData(0, 0, c.width, c.height).data }, undefined, id);
    return { comp: previewComp(id, lv, meta.finish), lv };
  })().catch(() => null);
  previewWraps.set(src, p);
  p.then((v) => { if (!v) previewWraps.delete(src); });
  return p;
}

/** a CSS colour (any syntax, incl. color-mix and variables) → #rrggbb, resolved inside `el` */
export function cssColor(el, css) {
  const p = document.createElement('span');
  p.style.cssText = `position:absolute;visibility:hidden;color:${css}`;
  (el || document.body).appendChild(p);
  const c = getComputedStyle(p).color;
  p.remove();
  const m = c.match(/[\d.]+/g) || [0, 0, 0];
  if (/color\(srgb/.test(c)) return `#${m.slice(0, 3).map((v) => Math.round(Number(v) * 255).toString(16).padStart(2, '0')).join('')}`;
  return `#${m.slice(0, 3).map((v) => Math.round(Number(v)).toString(16).padStart(2, '0')).join('')}`;
}
/** "Your colours": the shell takes the theme's accent (the same formula as the design rounds) */
export const shellColor = (el) => cssColor(el, 'color-mix(in srgb, var(--sk-accent, var(--tri)) 58%, var(--shell-4))');
export const CLEAR = CLEAR_TINTS;

// ---- the scene, loaded on demand ----------------------------------------------------------------------------------------

let sceneMod = null;
/** three.js + the scene module (once); the sticker atlas decoded. Called at idle so a launch finds them ready. */
export function loadScene() {
  sceneMod ??= import('./scene.mjs').catch((e) => {
    sceneMod = null;
    throw e;
  });
  return Promise.all([sceneMod, loadAtlas()]).then(([m, atlas]) => ({ S: m, atlas }));
}
/** The quiet warm-up: at idle after the app is up, so the first launch spends no time importing. */
export function prewarm() {
  const go = () => loadScene().catch(() => {});
  if (globalThis.requestIdleCallback) requestIdleCallback(go, { timeout: 4000 });
  else setTimeout(go, 1500);
}

// camera poses for a still device: fold devices orbit the table (tilt from overhead), slab devices stand (yaw 0 = front)
export const VIEWS = {
  fold: { lid: { lid: 0, tilt: 36, yaw: -16, dist: 430, target: [0, 7, 4], face: 'lid:top' },
    open: { lid: 150, tilt: 44, yaw: -12, dist: 470, target: [0, 20, -26], face: 'deck:top' },
    under: { lid: 0, tilt: 146, yaw: 12, dist: 430, target: [0, 5, 2], face: 'base:bottom' } },
  slab: { front: { lid: 0, tilt: 6, yaw: 18, dist: 430, target: [0, 8, 11], face: 'body:top' },
    back: { lid: 0, tilt: 10, yaw: 162, dist: 430, target: [0, 8, 11], face: 'body:bottom' } },
};
export const isFold = (sys) => sys === 'nds' || sys === '3ds';
export const viewPlan = (sys, view, orbit = { yaw: 0, tilt: 0, zoom: 1 }) => {
  const set = VIEWS[isFold(sys) ? 'fold' : 'slab'];
  const V = set[view] || Object.values(set)[0];
  return { lid: V.lid, cam: { tilt: V.tilt + orbit.tilt, yaw: V.yaw + orbit.yaw, dist: V.dist / orbit.zoom, target: V.target } };
};

/**
 * The launch scene posed still (the editor's stage, a still of your handheld): o = { sys, look ('theme' | 'clear' |
 * 'gold'), cartLook ('holo' for the Holo label; Gold's cartridge follows the look), clear (CLEAR_TINTS key), skin (wrap id | null),
 * preview (previewWrap – used when that skin can't be drawn here), plan () → pose, w, h, el (where the theme's colours are read), reduced, keep, cover,
 * cartColor }. Resolves to the scene (scene.mjs) and the atlas.
 */
export async function poseScene(canvas, o) {
  const { S, atlas } = await loadScene();
  const fold = isFold(o.sys);
  // o.preview (previewWrap): a souldew+ skin shown from its preview picture – only when the real one can't be drawn here
  const shell = o.look === 'clear' || o.look === 'gold';
  const wrap = shell ? null : sceneWrap(o.skin) || (o.preview ? { skin: o.preview.comp, recipe: null, preview: o.preview.lv } : null);
  const w = o.w, h = o.h;
  const scene = await S.createScene(canvas, {
    sys: o.sys, lk: layoutKey(o.sys, 'tb', 'tb'), w, h, final: { x: w * 0.3, y: h * 0.2, w: w * 0.4, h: h * 0.6 }, dark: true,
    look: o.look || 'theme', looks: paidLooks(), shell: shellColor(o.el), clearTint: CLEAR[o.clear] || CLEAR.ice, cartLook: o.look === 'gold' ? 'gold' : o.cartLook === 'holo' && paidLooks()?.holo ? 'holo' : undefined,
    cartColor: o.cartColor, cover: o.cover, title: '', pulse: '#fff4e0', glow: '#dfe8ff', picture: 'placeholder', keep: !!o.keep, atlas,
    plan: () => ({ ...o.plan(), cart: fold ? 999 : 0, power: [-2000, -2000], led: 1, shadow: 1, clean: 0, canvasO: 1, glassOff: 0.35 }),
    hh: { skin: wrap?.skin || null, recipe: wrap?.recipe || null, preview: wrap?.preview || null, reduced: !!o.reduced },
  });
  return { scene, atlas };
}

const stills = new Map();
/**
 * One still of your handheld as a data: URL (rendered once, then the GPU is let go) – cached per look while the app runs.
 * o = { sys, look, skin, stickers, w, h, el, view, cartLook ('holo': the Holo label), clear (the Clear shell's colour) }
 */
export async function handheldStill(o) {
  const key = JSON.stringify([o.sys, o.look, o.skin, o.stickers, o.w, o.h, o.view, o.cartLook || '', o.clear || '', content.banners.size, packState().entitled, !!paidLooks(), shellColor(o.el)]);
  if (stills.has(key)) return stills.get(key);
  const p = (async () => {
    const cv = document.createElement('canvas');
    const fold = isFold(o.sys);
    const { scene, atlas } = await poseScene(cv, { ...o, keep: true, reduced: true,
      plan: () => viewPlan(o.sys, o.view || (fold ? 'lid' : 'back'), { yaw: fold ? 4 : -10, tilt: fold ? 4 : 2, zoom: o.zoom || 1.75 }) });
    try {
      scene.setStickers(placeLayout(o.stickers || [], scene.regions(), atlas?.rects || {}));
      scene.render(0);
      return cv.toDataURL();
    } finally {
      scene.dispose();
    }
  })();
  stills.set(key, p);
  p.catch(() => stills.delete(key));
  if (stills.size > 24) stills.delete(stills.keys().next().value);
  return p;
}

/** Re-render when the pack or the trophies change (a wrap's banner arrives, an earned sticker unlocks). */
export function useCosmeticsTick() {
  const [, tick] = useState(0);
  useEffect(() => onCosmetics(() => tick((n) => n + 1)), []);
}

export { devKey };
