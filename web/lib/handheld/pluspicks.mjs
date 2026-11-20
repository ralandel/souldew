// What the souldew+ page offers to pick (views/handheldtile.mjs HandheldShowcase, views/launchlooks.mjs LaunchLooks) –
// the pure part: which skin the showcase starts with, what a skin or a launch look is for this account (worn / can wear /
// a preview), and the launch looks' cards. R: shared/handheld.mjs launchRights; L: look.mjs launchConfig.
import { WRAPS, wrapById, ownsWrap, playableLookFor } from '/shared/handheld.mjs';

/**
 * Which skin the showcase puts on first: the one this account wears (Supporter / souldew+), else the first souldew+ skin
 * – the showcase is where everyone sees the skins on the device.
 */
export function showcaseSkin(worn) {
  return wrapById(worn) ? worn : (WRAPS.find((w) => w.tier === 'plus') || WRAPS[0]).id;
}

/**
 * A skin in the showcase for this account: 'yours' (worn now), 'owned' (may wear it: Supporter / souldew+ – the free one,
 * or every one with souldew+), 'preview' (shown on the device, never put on: a souldew+ skin without souldew+), 'free' (the
 * free skin, for an account without the 3D launch – it has no handheld to dress). `id` null: no skin, the theme colour.
 */
export function showcaseState(id, R, worn) {
  const w = wrapById(id);
  if (!R?.three) return w && w.tier === 'plus' ? 'preview' : 'free';
  if ((id || null) === (worn || null)) return 'yours';
  return !w || ownsWrap(w, { member: R.plus }) ? 'owned' : 'preview';
}

/** The launch looks' cards, in order: [id, the tier it comes with]. */
export const LOOK_CARDS = [['cartridge', 'free'], ['your-colours', 'supporter'], ['gold', 'plus'], ['clear-shell', 'plus'], ['holo', 'plus']];

/** What plays for this account now: the 2D Cartridge without the 3D launch, else its look as the tier allows (a kept
 * souldew+ look plays "Your colours" meanwhile) with the Clear shell's colour. */
export function lookInUse(R, L) {
  if (!R?.three) return { id: 'cartridge', tint: null };
  const id = playableLookFor(L?.look, R);
  return { id, tint: id === 'clear-shell' ? L?.clear || 'atomic' : null };
}

/** May this account switch its launch to that card? A 3D tier can't pick the 2D one; a souldew+ shell needs souldew+. */
export function lookUsable(id, R) {
  const tier = LOOK_CARDS.find(([x]) => x === id)?.[1];
  if (!tier || id === 'cartridge') return false;
  return !!R?.three && (tier !== 'plus' || !!R.plus);
}

/** The previews' picture of a card (launch/<name>.png|webp): the Clear shell once per colour. */
export const lookMedia = (id, tint) => (id === 'clear-shell' ? `clear-shell-${tint || 'atomic'}` : id);

/** The souldew+ launch looks' stills shipped with the app (web/assets/handheld/launch/, scripts/handheld/launch-stills.mjs):
 * the cards show them to someone without the pack until the previews carry the looks. */
export const SHIPPED_STILLS = ['gold', 'holo', 'clear-shell-atomic', 'clear-shell-smoke', 'clear-shell-ice', 'clear-shell-jungle'];
export const shippedStill = (name) => (SHIPPED_STILLS.includes(name) ? `/assets/handheld/launch/${name}.webp` : null);
