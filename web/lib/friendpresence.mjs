// What the player is doing, for friends (souldew account › presence) – web/lib/presence.mjs is the other, anonymous
// "Playing now" count: online, in the library, playing a game, or in a run – with whether it has a free seat and
// whether friends may ask to join it. Coarse on purpose: the game's short title, the run's name and mode, and the
// route only when the player allowed "show where I am" (the local server and the service drop it otherwise). app.mjs
// calls reportFrom() when any of it changes; account.mjs sends it only while signed in, and the local server not at all
// while the presence is hidden or "appear offline".
import { reportPresence } from './account.mjs';
import { gameById, hackById } from './data.mjs';
import { locationName } from './run.mjs';
import { slotsOf, runMode, wireMode } from '/shared/slots.mjs';
import { shortGameName } from '/shared/social.mjs';

const ASK_KEY = 'sl-ask-to-join';
/** "Friends may ask to join my SoulLink when a seat is free" (Settings › Account) – a choice of this computer. */
export function askToJoinAllowed() {
  try {
    return localStorage.getItem(ASK_KEY) === '1';
  } catch {
    return false;
  }
}
export function setAskToJoin(on) {
  try {
    localStorage.setItem(ASK_KEY, on ? '1' : '0');
  } catch {
    // private mode – stays off
  }
}

/** "Pokémon Emerald Version" → "Emerald", "Pokémon Black Version 2" → "Black 2"; a hack by its own name. */
export function shortTitle({ gameId, hackId, title } = {}) {
  const h = hackId ? hackById(hackId) : null;
  if (h) return h.name;
  const g = gameId ? gameById(gameId) : null;
  const t = g?.title || title || '';
  return Array.from(shortGameName(t)).slice(0, 60).join('');
}

/**
 * The presence for the app's state: route, the running game (session.target), the open run (manifest) with its doc
 * and this computer's slot, and the slots that have somebody (views/invitecode.mjs takenSlots).
 */
export function presenceFrom({ route, session, manifest, doc, me, taken = [] }) {
  const target = session?.target;
  if (target) {
    const game = { title: shortTitle({ gameId: target.gameId || manifest?.game?.id, hackId: target.runId ? manifest?.game?.hackId : null, title: target.label }), system: target.system };
    if (target.runId && manifest?.id === target.runId) {
      const soullink = runMode(manifest) !== 'nuzlocke'; // (a SoulLink or a Play together: friends can join)
      const freeSlot = soullink && slotsOf(manifest).some((s) => !taken.includes(s));
      const where = doc?.get?.(`where:${me}`, null);
      const location = where?.id != null ? locationName(where.gen, where.id) : null;
      return {
        state: 'in_run', game,
        run: { name: manifest.name || '', mode: wireMode(manifest), freeSlot, joinable: freeSlot && askToJoinAllowed() },
        ...(location ? { location: String(location).slice(0, 40) } : {}),
      };
    }
    return { state: 'playing', game };
  }
  return { state: route === 'library' ? 'library' : 'online' };
}

/** Send what the player does now (only while signed in – account.mjs checks). */
export const reportFrom = (ctx) => reportPresence(presenceFrom(ctx));
