// Who plays a run: player slots p1..pN (N = shared/edition.mjs → maxPlayers) and the run mode. Shared by the server
// (builds, summaries) and the browser (web/lib/run.mjs re-exports it), so both read a manifest the same way.
import { EDITION } from './edition.mjs';

/** Most players in a run – a SoulLink or a Play together has 2..MAX_PLAYERS. */
export const MAX_PLAYERS = Math.max(2, Math.min(9, EDITION.maxPlayers || 4));
/** Every slot a run may have, in order: ['p1', 'p2', …]. (Slot patterns elsewhere are written as p[1-8]; test/slots8.test.mjs keeps them in step.) */
export const ALL_SLOTS = Object.freeze(Array.from({ length: MAX_PLAYERS }, (_, i) => `p${i + 1}`));
export const MODES = ['soullink', 'nuzlocke', 'together'];

/**
 * 'soullink' (2..MAX_PLAYERS players), 'nuzlocke' (solo) or 'together' (3.0, "Play together": 2..MAX_PLAYERS players in
 * their own normal games – trades, battles, Shared World, raids – without any challenge rules; shared/playtogether.mjs).
 * Runs from before modes existed are SoulLinks.
 */
export function runMode(manifest) {
  const m = manifest?.mode;
  return m === 'nuzlocke' || m === 'together' ? m : 'soullink';
}

/** A solo Nuzlocke (one player, no partner) rather than a SoulLink. */
export const isNuzlocke = (manifest) => runMode(manifest) === 'nuzlocke';

/** "Play together": the players' own games, no challenge – no encounters, deaths, caps or a run that can fail. */
export const isTogether = (manifest) => runMode(manifest) === 'together';

/** A challenge run (SoulLink or Nuzlocke) – the rules, the tracker's encounters and deaths apply. */
export const isChallenge = (manifest) => runMode(manifest) !== 'together';

/**
 * A run's mode as the souldew accounts service takes it (friend presence, friend invites, recent runs):
 * 'soullink' | 'nuzlocke' | 'together' (the service takes 'together' since 19 Nov 2026).
 */
export const wireMode = (manifest) => runMode(manifest);

/** The app section a run lives in (its route): Play together runs are in the SoulLink section, next to the SoulLinks. */
export const runSection = (manifest) => (runMode(manifest) === 'nuzlocke' ? 'nuzlocke' : 'soullink');

/**
 * The run's slots in order. Players are contiguous (p1..pN); a SoulLink has at least two – older manifests
 * (and packs) always had p1+p2, and a missing p2 there still means "the partner who hasn't joined yet".
 */
export function slotsOf(manifest) {
  if (runMode(manifest) === 'nuzlocke') return ['p1'];
  const players = manifest?.players && typeof manifest.players === 'object' ? manifest.players : {};
  const slots = [];
  for (const s of ALL_SLOTS) {
    if (!players[s]) break;
    slots.push(s);
  }
  return slots.length >= 2 ? slots : ['p1', 'p2'];
}

/**
 * A new run's name when none is given: "Lou & Noa", "Lou, Noa & Robin" – or "Lou – Nuzlocke" solo, "Lou & Noa –
 * together" for Play together (the mode shows in places that only carry the name, like a friend invite).
 */
export function defaultRunName(players, mode) {
  const names = ALL_SLOTS.filter((s) => players?.[s]).map((s) => players[s].name || s.toUpperCase());
  if (mode === 'nuzlocke') return `${names[0]} – Nuzlocke`;
  const all = names.length > 2 ? `${names.slice(0, -1).join(', ')} & ${names.at(-1)}` : names.join(' & ');
  return mode === 'together' ? `${all} – together` : all;
}

/** The other players of the run (empty in a solo Nuzlocke). */
export function othersOf(slot, manifest) {
  return slotsOf(manifest).filter((s) => s !== slot);
}
