// souldew+ cosmetics – the public interface (README.md in this folder documents every name; keep them stable, the
// profile / friends UI and the account client import them).
import { CATALOG, EARNED_CATALOG, state, onChange, owned, has, setEarnedTrophies } from './state.mjs';
import { t } from '../i18n.mjs';
import { hintKey, collectionKey, EARNED_COLLECTION } from './strings.mjs';

export { applySkin, previewSkin, endPreview, listSkins, skinState, onSkinChange, applyStoredSkin } from './skins.mjs';
export { mountBanner, mountNameplate, bannerStats } from './banners/runtime.mjs';
export { mountFrame, frameStats, sizing as frameSizing } from './frames/runtime.mjs';
export { refreshPack, forgetPack, packState, setPackAccessProvider, getPackAccess, devPackAccess, startPackPreview, endPackPreview, GRACE_MS } from './pack/client.mjs';
export { setReducedMotion } from './motion.mjs';
export { setPlusHandler, openPlus } from './plus.mjs';
export { onChange, owned, has, setEarnedTrophies };

const KINDS = ['banners', 'frames', 'nameplates', 'skins'];
const RARITY = ['free', 'common', 'rare', 'epic', 'legendary'];

/**
 * Everything there is, owned or not – for pickers and profile editors:
 *   { banners, frames, nameplates, skins: [{ id, name, collection, collectionName, rarity, pairsWith, plus,
 *     owned, available, sw, … }], collections: { banners, frames } }
 * owned: usable now (free, or souldew+ with the pack loaded). available: its content is in memory (owned or preview).
 */
export function catalog() {
  const tag = (kind, list) => list.map((x) => ({ ...x, owned: owned(kind, x.id), available: has(kind, x.id) }));
  // (the collections' names and the themes' lines in the player's language – lib/cosmetics/strings.mjs)
  const inColl = (kind) => (x) => (x.collection ? { ...x, collectionName: t(collectionKey(kind, x.collection), x.collectionName || x.collection) } : x);
  const colls = (kind, list) => list.map((c) => ({ ...c, name: t(collectionKey(kind, c.id), c.name) }));
  // the earned banners (summit-dawn …) are part of the banner list – in a collection of their own, `earned` and `trophy` set
  const banners = [...CATALOG.banners, ...EARNED_CATALOG].map(inColl('banners'));
  const nameplates = banners.map((b) => ({ id: b.id, name: b.name, collection: b.collection, collectionName: b.collectionName, rarity: b.rarity, pairsWith: b.pairsWith, plus: b.plus, sw: b.sw, ...(b.earned ? { earned: true, trophy: b.trophy } : {}) }));
  return {
    banners: tag('banners', banners),
    frames: tag('frames', CATALOG.frames.map(inColl('frames'))),
    nameplates: tag('nameplates', nameplates),
    skins: tag('skins', CATALOG.skins.map((s) => ({ ...s, hint: t(hintKey(s.id), s.hint) }))),
    collections: { ...CATALOG.collections, banners: colls('banners', [...CATALOG.collections.banners, EARNED_COLLECTION]), frames: colls('frames', CATALOG.collections.frames) },
  };
}

export const COSMETIC_KINDS = KINDS;
export const RARITIES = RARITY;
/** current generation of loaded content (changes when a pack loads or is wiped) */
export const contentGeneration = () => state.generation;
