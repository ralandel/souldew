// "What's new in 3.0" (views/whatsnew.mjs): a few cards shown once after the update from 2.x, and any time from Help.
// When it may show up is pure and testable here; the server decides who gets it (status.config.whatsNew is '3.0' only
// on an install that ran 2.x before and finished the welcome tour – a new install gets the welcome tour instead).

import { EDITION } from '../../shared/edition.mjs';

/** The version whose cards these are – the value status.config.whatsNew carries while they wait to be seen. */
export const WHATS_NEW = '3.0';

/** The page's event that opens the cards again (Help, Settings › General). */
export const WHATS_NEW_EVENT = 'souldew:whatsnew';

/**
 * The cards, in order: what's new, each with a picture of the app – souldew's own interface only, never a game's
 * picture, box art or sprites (scripts/whatsnew-media.mjs builds them from crops of the e2e scripts' screenshots). Their
 * texts live in views/whatsnew.mjs (t() calls, so scripts/extract-i18n.mjs finds them).
 */
export const WHATS_NEW_CARDS = [
  { id: 'together', icon: 'link' },
  { id: 'world', icon: 'globe' },
  { id: 'raid', icon: 'bolt' },
  { id: 'handheld', icon: 'star', account: true },
  { id: 'friends', icon: 'user', account: true },
].filter((c) => !c.account || EDITION.accounts); // (souldew Renaissance: no account, no souldew+ – those cards stay out)

/** The picture of a card (served from web/assets). */
export const cardMedia = (id) => `/assets/whatsnew/${id}.webp`;

/** Do the cards wait to be seen? Only for an onboarded install the server marked (a new user gets the welcome tour). */
export function whatsNewPending(config) {
  return !!config?.onboarded && config?.whatsNew === WHATS_NEW;
}

/**
 * May the cards open by themselves now? Not over the welcome tour, the start-up animation, a running game (full or in
 * the corner) or another dialog – they wait for a quiet moment instead.
 */
export function mayShowWhatsNew({ config, boot = false, playing = false, dialogOpen = false } = {}) {
  return whatsNewPending(config) && !boot && !playing && !dialogOpen;
}

/** What the page posts to /api/config once the cards were closed (seen, skipped or finished – they show once). */
export const whatsNewSeenPatch = () => ({ whatsNew: null });

/** The "Updated to 3.0" toast stays away while the cards say it better. */
export const skipUpdatedToast = (config) => whatsNewPending(config);

/** The next card for a key: arrows and the controller's left/right page through, without wrapping around. */
export function stepCard(index, key, count = WHATS_NEW_CARDS.length) {
  if (key === 'ArrowRight' || key === 'PageDown') return Math.min(count - 1, index + 1);
  if (key === 'ArrowLeft' || key === 'PageUp') return Math.max(0, index - 1);
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return index;
}
