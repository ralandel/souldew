// The cosmetics layer's shared state: what the pack client has loaded (premium content, in memory only) next to the free
// content that ships with the app, and the subscribers that re-render when it changes.
import FREE_BANNERS from './content/banners-free.mjs';
import EARNED_BANNERS from './content/banners-earned.mjs';
import CATALOG from './content/catalog.mjs';
import { EARNED_COLLECTION } from './strings.mjs';

export { CATALOG, EARNED_BANNERS };

/** The banners shipped with the app: the free Basics and the earned ones (their art is free – the trophy is the key). */
const APP_BANNERS = [...FREE_BANNERS, ...EARNED_BANNERS];

const listeners = new Set();
export const state = {
  entitled: false, // the account owns souldew+ and its pack is loaded and verified
  preview: false, // a live theme preview is in memory (API.md §10.4): its skins can be tried, nothing can be kept
  previewUntil: null, // when the preview ends (ISO) – its content is dropped then
  previewLoading: false,
  until: null,
  packVersion: null,
  loading: false,
  error: null, // null | 'offline' | 'expired' | 'signature' | 'decrypt' | 'hash' | 'download' | …
  generation: 0, // bumps whenever the loaded content changes (instances remount)
  trophies: null, // Set of this computer's earned trophy ids (web/lib/trophies.mjs) – null until they are known
};

/** In-memory premium content (never written anywhere in plain form). */
export const content = {
  banners: new Map(APP_BANNERS.map((b) => [b.id, b])),
  skinCss: new Map(), // skin id → CSS text with pack: urls (resolved on first use)
  files: new Map(), // pack path → bytes (fonts, art the skins use)
  framesModule: null, // signed module text (frames.mjs) – runs only in a worker (sandbox.mjs)
  frameIds: new Set(),
  handheld: null, // "Your handheld"'s souldew+ part: { wraps: [composition], stickers: { layout, art, cut } } (web/lib/handheld)
};

export function setContent(next) {
  content.banners = new Map(APP_BANNERS.map((b) => [b.id, b]));
  for (const b of next?.banners || []) if (b && typeof b.id === 'string') content.banners.set(b.id, b);
  content.skinCss = new Map(next?.skinCss || []);
  content.files = new Map(next?.files || []);
  content.framesModule = next?.framesModule || null;
  content.frameIds = new Set(next?.frameIds || []);
  content.handheld = next?.handheld || null;
  state.generation++;
}

export function update(patch) {
  Object.assign(state, patch);
  for (const fn of [...listeners]) {
    try {
      fn(state);
    } catch (e) {
      console.error('cosmetics listener failed', e);
    }
  }
}

/** Subscribe to pack / content changes; returns the unsubscribe function. */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The earned banners as catalog entries: free, owned once their trophy is on this computer. (The collection's name in
 *  the player's language: catalog() in index.mjs.) */
export const EARNED_CATALOG = EARNED_BANNERS.map((b) => ({
  id: b.id, name: b.name, collection: EARNED_COLLECTION.id, collectionName: EARNED_COLLECTION.name, rarity: 'earned', plus: false, earned: true, trophy: b.trophy, pairsWith: [],
  sw: [...new Set(Object.values(b.pal))].filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 6),
}));
const EARNED_BY_ID = new Map(EARNED_CATALOG.map((b) => [b.id, b]));

/** The trophies this computer has earned (a Set of ids) – earned cosmetics are owned with them. */
export function setEarnedTrophies(set) {
  const next = set ? new Set(set) : null;
  const same = next && state.trophies && next.size === state.trophies.size && [...next].every((x) => state.trophies.has(x));
  if (same) return;
  update({ trophies: next });
}

export const FREE_FRAME_IDS = new Set(CATALOG.frames.filter((f) => !f.plus).map((f) => f.id));

/** Is this item usable right now (free, or premium with the pack loaded)? Preview content counts only for previews.
 * A nameplate is its banner's window: the catalog lists it under banners. */
export function owned(kind, id) {
  if ((kind === 'banners' || kind === 'nameplates') && EARNED_BY_ID.has(id)) return !!state.trophies?.has(EARNED_BY_ID.get(id).trophy);
  const item = CATALOG[kind === 'nameplates' ? 'banners' : kind]?.find((x) => x.id === id);
  if (!item) return false;
  if (!item.plus) return true;
  return state.entitled && has(kind, id);
}

/** Is the content for this item in memory (owned or as a preview)? */
export function has(kind, id) {
  if (kind === 'banners' || kind === 'nameplates') return content.banners.has(id);
  if (kind === 'frames') return FREE_FRAME_IDS.has(id) || content.frameIds.has(id);
  if (kind === 'skins') return id === 'classic' || content.skinCss.has(id);
  return false;
}
