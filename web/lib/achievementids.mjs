// Titles and showcase trophies of the souldew profile are the app's own achievements (shared/trophies.mjs). The
// accounts service's catalog names them in kebab case (kind "title" / "trophy"): winSoulLink ↔ win-soul-link,
// badges16 ↔ badges16. Only achievements this computer has unlocked are offered.
import { achIds } from './trophytexts.mjs';

export const toCatalogId = (achId) => String(achId).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

let reverse = null;
/** A catalog id → the achievement id, or null when the app knows no such achievement. */
export function fromCatalogId(id) {
  reverse ||= new Map(achIds().map((a) => [toCatalogId(a), a]));
  return reverse.get(id) || null;
}
