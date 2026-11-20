// The run pack's format (the invite file, the code invite's payload, a new attempt's offer – server/lib/build.mjs
// runPack). Its id comes from the app's former name and must never change for packs every version can read.
//
// A pack that an older app would read *wrongly* gets a new format, which older apps refuse: a run with another shiny
// rate (2.8.0). 2.7.4 and older read only `soullink-studio/run-pack@1`, drop the unknown `shiny` field and would build
// a game with the normal odds without a word – with @2 they refuse the pack instead ("Not a valid run pack" for a
// file or a new attempt; a code invite ends with "The code didn't match" – their texts, which can't be changed now).
// Runs without it keep @1, so players on older versions can still join them. A pack names the version it needs
// (`minVersion`): an app that doesn't know the format says to update, to that version.
// 2.8.1 takes any shiny rate. 2.8.0 reads @2 but knows only its presets – another rate it would quietly turn into the
// normal odds – so a run with another rate travels as @3 (2.8.0 refuses it and says to update to 2.8.1). Runs with a
// preset keep @2, so 2.8.0 players can still join them.
// 2.8.3 adds "TM compatibility follows the TM moves" (@tmsFollowMoves, #81): 2.8.2 and older pass it to a bridge that
// ignores it and build another game ("the ROM differs" – a warning, not a stop). A run with it travels as @4, which they
// refuse with "update to 2.8.3"; 2.8.3 reads every shiny rate, so @4 covers shiny runs too.
// 2.8.3 also adds the SoulLink rule "nothing counts before your first Poké Balls" (rules.startAtBalls): a 2.8.2 app
// doesn't know it and would kill the linked Pokémon of everyone with its player's first knock-outs. A SoulLink with it
// travels as @4 as well – the same format and version, no second one.
// 3.0 adds "Play together" (mode 'together', shared/playtogether.mjs). Every older app would read such a pack as a
// SoulLink – 2.8 drops the unknown mode (its checkPack: "damaged") or, worse, a build that ignored it would track
// encounters and kill Pokémon in the player's own game. A Play together travels as @5, which 2.8.x refuses with
// "update to 3.0.0" (their packFormatState says 'newer').
import { shinyKnownTo280 } from './shiny.mjs';
import { TMS_FOLLOW_MOVES } from './randomizer-options.mjs';

export const PACK_FORMAT = 'soullink-studio/run-pack@1';
export const PACK_FORMAT_SHINY = 'soullink-studio/run-pack@2';
export const PACK_FORMAT_SHINY_ANY = 'soullink-studio/run-pack@3';
export const PACK_FORMAT_TMS = 'soullink-studio/run-pack@4';
export const PACK_FORMAT_TOGETHER = 'soullink-studio/run-pack@5';
/** Formats this app reads. */
export const PACK_FORMATS = [PACK_FORMAT, PACK_FORMAT_SHINY, PACK_FORMAT_SHINY_ANY, PACK_FORMAT_TMS, PACK_FORMAT_TOGETHER];
/** The first version that knows Play together. */
export const TOGETHER_MIN_VERSION = '3.0.0';
/** The first version that reads a pack with a shiny rate (one of the presets). */
export const SHINY_MIN_VERSION = '2.8.0';
/** The first version that reads a pack with any other shiny rate. */
export const SHINY_ANY_MIN_VERSION = '2.8.1';
/** The first version whose randomizer makes TM compatibility follow the TM moves. */
export const TMS_MIN_VERSION = '2.8.3';

/** Does the run's randomizer use an option older versions would quietly build without? */
export const needsTmsFollow = (m) => m?.randomizer?.enabled !== false && m?.randomizer?.values?.[TMS_FOLLOW_MOVES] === true;

/** Does the SoulLink's host want nothing to count before the first Poké Balls – a rule 2.8.2 apps don't keep? */
export const needsBallsRule = (m) => m?.mode !== 'nuzlocke' && m?.rules?.startAtBalls === true;

/** What a run pack of manifest `m` needs: its format and, for a new format, the version that reads it. */
export function packFormatOf(m) {
  if (m?.mode === 'together') return { format: PACK_FORMAT_TOGETHER, minVersion: TOGETHER_MIN_VERSION };
  if (needsTmsFollow(m) || needsBallsRule(m)) return { format: PACK_FORMAT_TMS, minVersion: TMS_MIN_VERSION };
  if (!m?.shiny) return { format: PACK_FORMAT };
  return shinyKnownTo280(m.shiny) ? { format: PACK_FORMAT_SHINY, minVersion: SHINY_MIN_VERSION } : { format: PACK_FORMAT_SHINY_ANY, minVersion: SHINY_ANY_MIN_VERSION };
}

/**
 * Is `pack` one this app reads? 'ok', 'newer' (a run pack of a format from a later version – update) or 'invalid'
 * (no run pack at all).
 */
export function packFormatState(pack) {
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) return 'invalid';
  if (PACK_FORMATS.includes(pack.format)) return 'ok';
  return typeof pack.format === 'string' && /^soullink-studio\/run-pack@\d{1,4}$/.test(pack.format) ? 'newer' : 'invalid';
}

/** The version a newer pack names (for "update to …"), or null. */
export const packMinVersion = (pack) => (typeof pack?.minVersion === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(pack.minVersion) ? pack.minVersion : null);
