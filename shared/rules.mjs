// A run's rule defaults – SoulLink and solo Nuzlocke – shared by the app (web/lib/run.mjs) and the open stream API
// (shared/streamapi.mjs), which shows a run's rules with the defaults filled in.

export const DEFAULT_RULES = {
  typeClause: 'global',
  dupes: 'player',
  // a missed encounter (fled, knocked out) with a known species counts for the dupes clause like a catch – off: only
  // catches count (runs from before it have no `missedDupes`)
  missedDupes: false,
  shinyClause: true,
  gifts: 'area', // 'area' (a gift is that area's encounter) | 'free' | 'banned' – older docs say giftsCount: true/false
  giftsCount: true,
  levelCaps: true,
  failKillsPair: true,
  autoAssign: true,
  autoDeath: true,
  sounds: true,
  cheats: false, // the play screen's cheats (items into the bag, money) – off until the run allows them; every use goes to the log
  // which of them (cheatGroups): 'all', or the groups allowed, comma-separated – the host's in a SoulLink. null: a run
  // from before 3.0 (none stored), which keeps what its cheats rule said then – Rare Candies and Max Repels. A new run
  // starts with all of them (NEW_RUN_RULES).
  cheatSet: null,
  // the battle helper's type matchups (move effectiveness, what hits you, weaknesses) in the play view. The host
  // sets it when creating the run; runs from before it have no `typeHelp` and keep the help (true).
  typeHelp: true,
  // lives (shared/lives.mjs): 0 = off, else how many – every death costs one; `livesPool` 'shared' | 'player'
  lives: 0,
  livesPool: 'shared',
  // "Nothing counts before your first Poké Balls" (web/lib/run.mjs beforeBalls): until a player has a Poké Ball in the
  // bag (or caught a Pokémon), their Pokémon don't die, a whiteout doesn't end the run and no encounter is spent – the
  // standard Nuzlocke rules start once you can catch. Off here, so runs from before keep counting from the start; a new
  // run takes NEW_RUN_RULES.
  startAtBalls: false,
  // trades and battles between the players in a link session (docs/MULTIPLAYER.md): allowed unless the host switched
  // them off ('on' | 'off'); `linkBattleDeaths`: a link battle's knocked-out Pokémon count as deaths (off: just for fun)
  linkTrades: 'on',
  linkBattles: 'on',
  linkBattleDeaths: false,
  // a link battle may be for in-game money (docs/MULTIPLAYER.md › "Battle results and wagers"): 'on' | 'off', and the
  // most a wager may be (₽, 0: no limit – nobody can put in more than their game holds anyway)
  linkWagers: 'on',
  linkWagerCap: 0,
  // raids (docs/MULTIPLAYER.md › "Raid"): the players fight the same trainer together, one shared HP pool – allowed
  // unless the host switched them off ('on' | 'off'); `raidDeaths`: a raid is a real battle, so Pokémon that go down
  // in it count (off: they're taken as standing until healed)
  raids: 'on',
  raidDeaths: true,
  // items given from one player's bag to another's (docs/MULTIPLAYER.md › 9 "Playing together", web/lib/together.mjs):
  // allowed unless the host switched it off ('on' | 'off') – a strict Nuzlocke may want every player on their own
  itemGifts: 'on',
  // importing a battery save from elsewhere into a player's game (web/views/saveimport.mjs): a big change, so a SoulLink
  // allows it only when the host switched it on; every import goes to the log, and what the save brings along doesn't
  // count (no catches, badges or trophies from it). A solo Nuzlocke asks its player instead.
  saveImports: false,
  // (the Discord webhook is not a rule: it stays on this computer – GET/PUT /api/runs/:id/discord)
};

/**
 * The cheats a run's rules allow one by one (shared/live/cheats.mjs CHEATS names each cheat's group): Rare Candies, Max
 * Repels, the Master Ball, the other Poké Balls (Poké Ball, Ultra Ball), healing items (Full Restore, Revive, Max
 * Revive), money.
 */
export const CHEAT_GROUPS = ['rareCandy', 'maxRepel', 'masterBall', 'balls', 'healing', 'money'];

/**
 * What a run from before 3.0 allowed with its cheats rule – the two cheats there were ("Allow cheats (Rare Candies, Max
 * Repels)"): a host on 2.x can't pick, so a partner on 3.0 offers no more than the host's own app does.
 */
export const LEGACY_CHEAT_GROUPS = ['rareCandy', 'maxRepel'];

/**
 * The cheat groups `rules` allow: none while cheats are off, else `cheatSet` – 'all', the groups comma-separated, or
 * none stored (a run from before 3.0): LEGACY_CHEAT_GROUPS.
 */
export function cheatGroups(rules) {
  if (!rules?.cheats) return [];
  const set = rules.cheatSet;
  if (set === undefined || set === null) return [...LEGACY_CHEAT_GROUPS];
  if (set === 'all') return [...CHEAT_GROUPS];
  const list = String(set).split(',');
  return CHEAT_GROUPS.filter((g) => list.includes(g));
}

/** The `cheatSet` value for these groups: 'all' when it is every one of them. */
export function cheatSetOf(groups) {
  const g = CHEAT_GROUPS.filter((x) => groups.includes(x));
  return g.length === CHEAT_GROUPS.length ? 'all' : g.join(',');
}

/** What a new run starts with where it differs from DEFAULT_RULES (which older runs fall back to). */
export const NEW_RUN_RULES = { startAtBalls: true, cheatSet: 'all' };

// Solo Nuzlocke rules. A preset only sets the rule toggles; tool settings (autoAssign, sounds) stay as they are.
const CLASSIC = {
  autoDeath: true, // faint = dead
  blackout: 'party', // 'party' (a whiteout ends the run) | 'box' (only when nothing alive is left anywhere) | 'off'
  deathless: false, // the first death ends the run
  dupes: 'line', // 'off' | 'species' | 'line' (dead ones count too)
  shinyClause: true,
  gifts: 'area',
  statics: 'area', // 'area' | 'free' | 'banned'
  nicknames: false,
  levelCaps: false, // false | 'warn' | 'strict'
  noBattleItems: false,
  setMode: false,
  centerLimit: 0, // Pokémon Center visits per badge, 0 = no limit (counted by hand)
  typeClause: 'off', // 'off' | 'party'
};
export const RULE_PRESETS = {
  classic: CLASSIC,
  hardcore: { ...CLASSIC, levelCaps: 'strict', noBattleItems: true, setMode: true },
};
export const NUZLOCKE_RULES = { ...CLASSIC, autoAssign: true, sounds: true };

// "Play together" (mode 'together', shared/playtogether.mjs): the players' own games, no challenge. The host decides
// only what the players can do together (TOGETHER_RULE_KEYS); everything a challenge counts is off for good
// (TOGETHER_FIXED wins over anything stored – a doc value written by hand, or a SoulLink's rules carried over, can never
// turn on deaths, encounters, caps or a run that fails).
export const TOGETHER_RULE_KEYS = ['linkTrades', 'linkBattles', 'linkWagers', 'linkWagerCap', 'raids', 'itemGifts', 'cheats', 'cheatSet', 'typeHelp'];
export const TOGETHER_FIXED = {
  typeClause: 'off', dupes: 'off', missedDupes: false, shinyClause: false, gifts: 'free', giftsCount: false, levelCaps: false,
  failKillsPair: false, autoAssign: false, autoDeath: false, lives: 0, livesPool: 'shared', startAtBalls: false,
  // a link battle or a raid is just for fun: nothing that goes down there "dies" – nothing ever does in this mode
  linkBattleDeaths: false, raidDeaths: false,
  // the save is the player's own library save (shared/playtogether.mjs › save model): importing one is done in the
  // library, never through the run – no rule for it
  saveImports: false,
  blackout: 'off', deathless: false,
};
/** A new Play together's host choices: everything together is on (wagers and gifts too), cheats off until the host says. */
export const togetherDefaults = () => Object.fromEntries(TOGETHER_RULE_KEYS.map((k) => [k, k === 'cheatSet' ? 'all' : DEFAULT_RULES[k]]));

/** The run's rules: the stored `rules` over the defaults of its mode ('soullink' | 'nuzlocke' | 'together'). */
export function rulesWithDefaults(stored, mode) {
  const s = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  if (mode === 'together') {
    const r = { ...DEFAULT_RULES, cheatSet: 'all' };
    for (const k of TOGETHER_RULE_KEYS) if (s[k] !== undefined && s[k] !== null) r[k] = s[k];
    return { ...r, ...TOGETHER_FIXED };
  }
  const r = { ...(mode === 'nuzlocke' ? { ...DEFAULT_RULES, ...NUZLOCKE_RULES } : DEFAULT_RULES), ...s };
  // `giftsCount` (true/false) came first; `gifts` is the same rule with a third option
  if (s.gifts === undefined && s.giftsCount !== undefined) r.gifts = s.giftsCount ? 'area' : 'free';
  r.giftsCount = r.gifts !== 'free';
  // the host's signature of a SoulLink's rules (shared/hostrules.mjs) is no rule
  delete r.rev;
  delete r.sig;
  return r;
}
