// Rock-paper-scissors in the app (docs/MULTIPLAYER.md › 9): the commit–reveal hub (shared/rps.mjs) on the run's peer
// channel (web/lib/sync.mjs `world`), one per link. It works for every game – in a Gen 3 game with Shared World the
// picker and the hands show inside the game (web/lib/sharedworld.mjs claims the game for the overlay), everywhere else
// in a small card (web/views/rps.mjs), started from the board's log, a partner's tile or a name tag.
//
// The log gets one line per finished game, written by the player who asked (both computers know the result; one line).
import { useEffect, useState } from '/vendor/htm-preact.mjs';
import { RpsHub } from '/shared/rps.mjs';
import { feed, feedText, msg, players as getPlayers } from './run.mjs';

const TICK_MS = 250;
const hubs = new WeakMap(); // SyncLink → { hub, claimed, … }

/** The rock-paper-scissors of a run's link (created on first use; `doc`/`manifest` for the log line). */
export function attachRps(link, { doc = null, manifest = null } = {}) {
  if (!link) return null;
  let r = hubs.get(link);
  if (r) {
    Object.assign(r, { doc: doc || r.doc, manifest: manifest || r.manifest });
    return r;
  }
  const hub = new RpsHub({
    me: link.slot,
    send: (m) => {
      // directly where there's a link, else through the encrypted relay (a few words, rarely)
      const reached = link.sendWorld(m);
      if (m.to && !reached.has(m.to)) link.sendMessage?.({ world: { ...m, from: link.slot } });
    },
  });
  r = { hub, link, doc, manifest, claimed: new Set() };
  const off = link.onWorld?.((m) => {
    if (m?.t === 'rps') hub.receive(m).catch((e) => console.warn('rps', e));
  });
  const timer = setInterval(() => hub.tick(), TICK_MS);
  hub.on((e) => {
    if (e.type === 'end') logResult(r, e.game);
    if (e.type === 'change' && !hub.games.has(e.game.id)) r.claimed.delete(e.game.id);
  });
  r.stop = () => {
    clearInterval(timer);
    off?.();
  };
  hubs.set(link, r);
  return r;
}

/** The hub of a link, if the app attached one. */
export const rpsFor = (link) => (link ? hubs.get(link) || null : null);

/** A Preact hook: the games of mine on this link ([] without one), re-rendered on every change. */
export function useRps(link) {
  const r = rpsFor(link);
  const [, set] = useState(0);
  useEffect(() => (r ? r.hub.on(() => set((n) => n + 1)) : undefined), [r]);
  useEffect(() => {
    // (the countdown)
    if (!r) return undefined;
    const id = setInterval(() => r.hub.list().some((g) => g.phase === 'pick') && set((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [r]);
  return r;
}

/** The feed line of a finished game – by the one who asked, once. */
function logResult(r, g) {
  if (!g.challenger || g.spectating || !r.doc || !r.manifest) return;
  const { winner, why } = g.end;
  const names = getPlayers(r.doc, r.manifest);
  const name = (s) => names[s]?.name || s.toUpperCase();
  let entry = null;
  if (why === 'draw') {
    entry = { type: 'rps', slot: g.a, partner: g.b, msg: msg('feed.rpsDraw', 'and {partner} drew at rock-paper-scissors', { partner: name(g.b) }) };
  } else if (winner && (why === 'won' || why === 'gaveUp' || why === 'late' || why === 'noReveal')) {
    const loser = winner === g.a ? g.b : g.a;
    const score = `${g.wins[winner]}–${g.wins[loser]}`;
    entry = {
      type: 'rps', slot: winner, partner: loser,
      msg: why !== 'won' ? msg('feed.rpsForfeit', 'beat {partner} at rock-paper-scissors ({partner} gave up)', { partner: name(loser) })
        : g.bo === 3 ? msg('feed.rpsWonBo3', 'beat {partner} {score} at rock-paper-scissors (best of 3)', { partner: name(loser), score })
          : msg('feed.rpsWon', 'beat {partner} at rock-paper-scissors', { partner: name(loser) }),
    };
  }
  if (!entry) return;
  try {
    feed(r.doc, { ...entry, text: feedText(r.doc, r.manifest, entry) });
  } catch (e) {
    console.warn('rps log', e);
  }
}
