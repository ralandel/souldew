// "Play together" (3.0, run mode 'together'): 2–4 players in their own normal games – trades and battles by link,
// Shared World, raids, gifts, wagers, rock-paper-scissors – without a challenge. It is a run like a SoulLink (invite
// code, the run's peer channel, the board, the host's choices), with three differences:
//
// 1. No challenge. The host only says what the players can do together (shared/rules.mjs TOGETHER_RULE_KEYS); every
//    rule a challenge counts is off for good (TOGETHER_FIXED). The tracker writes each player's live team for the board
//    and the partners (web/lib/run.mjs applyTogether) – no encounters, no deaths, no level caps, no failing.
// 2. Each player plays their OWN game: any game of a system the link host runs, a different one per player if they
//    like (Emerald, Sapphire and FireRed in one run). Who can trade, battle or see whom depends on the pair of games
//    (linkWith below) – the board shows it.
// 3. The save model: the run plays the library game's own battery save, directly. A Play together run's slot records
//    the library entry it was built from (`outputs[slot].library` – the library id the free play of that game uses,
//    `<romId>` or `<romId>|<patchId>`), and the server's run save path for that slot IS the library game's save
//    (server/app.mjs defaultSavePath). There is no second copy that could drift: progress made together is there when
//    the game is played alone from the library, and the other way round. Everything that writes a run's save – the
//    play view, a link session's write-back, the out-of-step restore (with its `.link-<date>.sav` backup next to the
//    save), a save import (backups in the library's backup folder) – goes through that one path. Not done for a
//    Play together run: an intro save (it would overwrite the game's progress), an external emulator (it writes a save
//    next to the run's copy of the ROM – a second copy), a shiny patch or a randomizer (the run's ROM must stay the
//    library ROM byte for byte, so a battery save means the same game either way). Deleting the run never touches the
//    game's save. "Where you left off" and the save-state slots are the library game's too (the play view's stateId):
//    a state is only resumed while the battery save on disk is still the one it was taken with, so an older state can
//    never roll newer progress back.
import { linkUnavailable, sameLinkSystem } from './link.mjs';

/** Systems a Play together game can be on – the ones the link host runs (no 3DS link yet). */
export const TOGETHER_SYSTEMS = ['gb', 'gbc', 'gba', 'nds'];

/** The library id of a library ROM (+ patch): what its free play keys its battery save and states by. */
export const libraryIdOf = (romId, patchId = null) => (patchId ? `${romId}|${patchId}` : String(romId || ''));

/** A library id as a run keeps it (it names a file in the library – nothing else): a non-empty string, ≤ 2000 chars. */
export const okLibraryId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 2000 && ![...id].some((c) => c.charCodeAt(0) < 0x20);

/**
 * The game families whose maps share numbers (shared/world.mjs FAMILIES): Shared World draws partners only in a game
 * of the same family. By the catalog's root game id; null: no Shared World for that game yet.
 */
const WORLD_FAMILY = {
  'pokemon-red': 'rby', 'pokemon-blue': 'rby', 'pokemon-yellow': 'rby',
  'pokemon-gold': 'gsc', 'pokemon-silver': 'gsc', 'pokemon-crystal': 'gsc',
  'pokemon-ruby': 'rs', 'pokemon-sapphire': 'rs', 'pokemon-ruby-de': 'rs', 'pokemon-sapphire-de': 'rs',
  'pokemon-emerald': 'e', 'pokemon-emerald-de': 'e',
  'pokemon-firered': 'frlg', 'pokemon-leafgreen': 'frlg', 'pokemon-firered-de': 'frlg', 'pokemon-leafgreen-de': 'frlg',
  'pokemon-platinum': 'dppt', 'pokemon-heartgold': 'hgss', 'pokemon-soulsilver': 'hgss',
};

/**
 * A player's game as the partners need to know it: { id (catalog id or null), gen, system, hack (a hack's name, or
 * null) } – from a catalog game (gameById) and the run's `game` block. Written to the run doc as `game:<slot>`.
 */
export function gameInfo(game, catalogGame = null) {
  const sys = String(game?.system || catalogGame?.system || '');
  const gen = Number(catalogGame?.generation) || { gb: 1, gbc: 2, gba: 3, nds: 4, '3ds': 6 }[sys] || null;
  const hack = game?.hackId || game?.hackName ? String(game.hackName || game.hackId).slice(0, 60) : null;
  return { id: catalogGame?.id || game?.id || null, root: catalogGame?.variantOf || catalogGame?.id || game?.id || null, gen, system: sys || null,
    hack, code: String(game?.code || '').slice(0, 8) || null, quetzal: linkUnavailable(game) === 'hack' };
}

/** A `game:<slot>` value from the doc (a partner wrote it – untrusted) → the same shape, or null. */
export function cleanGameInfo(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const str = (x, n) => (typeof x === 'string' && x ? x.slice(0, n) : null);
  const gen = Number.isInteger(v.gen) && v.gen >= 1 && v.gen <= 9 ? v.gen : null;
  const system = TOGETHER_SYSTEMS.includes(v.system) || v.system === '3ds' ? v.system : null;
  if (!gen || !system) return null;
  return { id: str(v.id, 60), root: str(v.root, 60), gen, system, hack: str(v.hack, 60), code: str(v.code, 8), quetzal: v.quetzal === true };
}

/**
 * What two players' games can do together: { trade, battle, world } – each true, false or 'untested' (the hardware
 * allows it, souldew never ran it) – and `why` when they can't link at all: 'system' (another console family, a 3DS
 * game), 'gen' (Gen 4 and Gen 5 share the DS but not the Union Room), 'hack' (a hack whose link was never checked).
 *   Gen 1 ↔ Gen 1, Gen 2 ↔ Gen 2: the Cable Club. Gen 1 ↔ Gen 2: the Time Capsule (trades only; never run here).
 *   Gen 3 (Ruby, Sapphire, Emerald, FireRed, LeafGreen): the Cable Club between all five (FireRed/LeafGreen trade with
 *   Ruby/Sapphire/Emerald once the game's own story allows it).
 *   Gen 4 ↔ Gen 4 (Diamond, Pearl, Platinum, HeartGold, SoulSilver): the Union Room. Gen 5 ↔ Gen 5: the Union Room.
 * Shared World needs both games in the same map family with Shared World support (WORLD_FAMILY).
 */
export function linkWith(a, b) {
  const no = (why) => ({ trade: false, battle: false, world: false, why });
  if (!a || !b) return no('unknown');
  if (!TOGETHER_SYSTEMS.includes(a.system) || !TOGETHER_SYSTEMS.includes(b.system) || !sameLinkSystem(a.system, b.system)) return no('system');
  if (a.quetzal || b.quetzal) return no('hack');
  const fa = WORLD_FAMILY[a.id] || WORLD_FAMILY[a.root];
  const fb = WORLD_FAMILY[b.id] || WORLD_FAMILY[b.root];
  // (a hack of a known game keeps its maps – the overlay itself decides by the RAM it finds; here: likely)
  const world = !!fa && fa === fb;
  if (a.gen !== b.gen) {
    if (Math.min(a.gen, b.gen) === 1 && Math.max(a.gen, b.gen) === 2) return { trade: 'untested', battle: false, world: false, why: null };
    return no('gen');
  }
  return { trade: true, battle: true, world, why: null };
}

/** Every pair of players with what they can do: [{ a, b, ...linkWith }] (slots in order). */
export function linkPairs(games, slots) {
  const out = [];
  for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) {
    const a = games[slots[i]];
    const b = games[slots[j]];
    out.push({ a: slots[i], b: slots[j], ...linkWith(a, b) });
  }
  return out;
}

/**
 * Can `me` invite `others` to a link session of `kind` ('trade' | 'battle')? null (yes) or why not: the first pair
 * that can't – { slot, why } (why: 'gen' | 'system' | 'hack' | 'battle' (Gen 1 ↔ 2: trades only)).
 * Every seat must link with every other one (a 4-player Union Room needs four Gen 4 games).
 */
export function inviteBlock(games, me, others, kind) {
  const seats = [me, ...others.filter((s) => s !== me)];
  for (let i = 0; i < seats.length; i++) for (let j = i + 1; j < seats.length; j++) {
    const c = linkWith(games[seats[i]], games[seats[j]]);
    const other = seats[i] === me ? seats[j] : seats[i];
    // (a game nobody announced yet – a partner who hasn't opened the run since: the invite goes out, and their app's
    // own check answers it)
    if (c.why === 'unknown') continue;
    if (c.why) return { slot: other, why: c.why };
    if (kind === 'battle' && !c.battle) return { slot: other, why: 'battle' };
  }
  return null;
}

/** Can a library ROM start or join a Play together? null (yes) or why not: 'system' (3DS, unknown) | 'hack' (Quetzal). */
export function togetherRomBlock(rom) {
  if (!rom || !TOGETHER_SYSTEMS.includes(rom.system)) return 'system';
  if (linkUnavailable({ system: rom.system, hackId: rom.hackId, code: rom.code, title: rom.title }) === 'hack') return 'hack';
  return null;
}

/** The link session's refusal code for an inviteBlock reason (web/views/linkplay.mjs reasonText). */
export const BLOCK_CODE = { gen: 'linkGen', system: 'linkSystem', hack: 'linkHack', battle: 'linkTradeOnly' };
