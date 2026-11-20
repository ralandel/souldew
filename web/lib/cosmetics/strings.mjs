// The catalog's words the cards show – each theme's line under its name and every collection's name – in the player's
// language. The catalog (content/catalog.mjs) is generated from the design sources in English; its words are looked up
// by these keys (web/i18n/*.json – scripts/extract-i18n.mjs adds them from cosmeticStrings(), so a new theme or
// collection shows up as missing until it is translated). The items' own names (Dusk, Brass Ring …) stay as they are:
// they are names.
import CATALOG from './content/catalog.mjs';

/** The earned banners' collection (web/lib/cosmetics/state.mjs EARNED_CATALOG) – not in the generated catalog. */
export const EARNED_COLLECTION = { id: 'earned', name: 'Earned' };

export const hintKey = (skinId) => `plus.hint.${skinId}`;
/** Banners and frames each have their own collections – the same id may be named differently (night: After Dark / Night Shift). */
export const collectionKey = (kind, id) => `plus.coll.${kind === 'frames' ? 'frames' : 'banners'}.${id}`;

/** Every key with its English words: { key: english } (scripts/extract-i18n.mjs). */
export function cosmeticStrings() {
  const out = {};
  for (const s of CATALOG.skins) if (s.hint) out[hintKey(s.id)] = s.hint;
  for (const kind of ['banners', 'frames']) for (const c of CATALOG.collections[kind] || []) out[collectionKey(kind, c.id)] = c.name;
  out[collectionKey('banners', EARNED_COLLECTION.id)] = EARNED_COLLECTION.name;
  return out;
}
