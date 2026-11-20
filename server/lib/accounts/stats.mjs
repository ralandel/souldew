// "Show my runs on my profile": the numbers the app uploads when – and only when – the player opted in (API.md §2.5).
// Computed here from this computer's runs (the trophy digests, shared/trophies.mjs, plus each run's in-game play time):
// totals and the five most recent runs by name, game, mode, result, badges and deaths. Never a save, a ROM, a file
// path, a run id, a room key or a partner's account. The editor's choices (titles, showcase trophies, most trusted,
// favourite game) are offered from the same data.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runDir } from '../build.mjs';
import { catalog } from '../library.mjs';
import { runDigests, unlockedAchievements } from '../trophies.mjs';
import { cleanText, withoutFileNames, shortGameName, RUN_NAME_MAX } from '../../../shared/social.mjs';
import { trustedLines, lineNumbers } from '../../../shared/trustedlines.mjs';
import { SHARED_DIR } from '../paths.mjs';

let evolvesFrom = null;
/** PokeAPI's evolvesFrom table (shared/data/pokeapi.json) – read once. */
function evolutions() {
  if (!evolvesFrom) {
    try {
      evolvesFrom = JSON.parse(readFileSync(join(SHARED_DIR, 'data', 'pokeapi.json'), 'utf8')).evolvesFrom || [];
    } catch {
      evolvesFrom = [];
    }
  }
  return evolvesFrom;
}

const clamp = (n) => Math.max(0, Math.min(10000000, Math.round(Number(n) || 0)));

/** "Pokémon Emerald Version" → "Emerald", "Pokémon Black Version 2" → "Black 2" (a hack keeps its own name). */
export function shortGameTitle(title) {
  return cleanText(shortGameName(title), 60);
}

function gameTitleOf(d) {
  const cat = catalog();
  const hack = (cat.hacks || []).find((h) => h.id === d.gameId);
  if (hack) return cleanText(hack.name, 60);
  const g = (cat.games || []).find((x) => x.id === d.gameId);
  return g ? shortGameTitle(g.title) : '';
}

/** In-game play time of this computer's player in a run, in minutes (its doc's live:<slot>.playTime), or 0. */
function playMinutes(runId, slot) {
  try {
    const p = join(runDir(runId), 'doc.json');
    if (!existsSync(p)) return 0;
    const pt = JSON.parse(readFileSync(p, 'utf8'))?.[`live:${slot}`]?.v?.playTime;
    if (typeof pt === 'number' && Number.isFinite(pt)) return Math.floor(pt / 60);
    if (pt && Number.isInteger(pt.h)) return pt.h * 60 + (Number.isInteger(pt.m) ? pt.m : 0);
  } catch {
    // unreadable doc – no time
  }
  return 0;
}

const RESULT = { won: 'won', failed: 'lost', ended: 'abandoned' };

/** The upload body of PUT /v1/me/stats, from these digests (tests pass their own). */
export function statsFrom(digests, minutesOf = (d) => (d.archived ? 0 : playMinutes(d.id, d.me))) {
  const t = { runs_started: 0, runs_completed: 0, runs_failed: 0, soullink_runs: 0, nuzlocke_runs: 0, badges_earned: 0, pokemon_caught: 0, deaths: 0, playtime_minutes: 0 };
  for (const d of digests) {
    t.runs_started++;
    if (d.status?.state === 'won') t.runs_completed++;
    if (d.status?.state === 'failed') t.runs_failed++;
    if (d.mode === 'nuzlocke') t.nuzlocke_runs++;
    else t.soullink_runs++;
    t.badges_earned += Math.max(0, Math.min(16, Number(d.badges) || 0));
    t.pokemon_caught += (d.catches || []).length;
    t.deaths += (d.deaths || []).length;
    t.playtime_minutes += minutesOf(d);
  }
  const totals = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, clamp(v)]));
  const lastActive = (d) => Math.max(d.status?.at || 0, ...(d.catches || []).map((c) => c.at || 0), Date.parse(d.createdAt || '') || 0);
  const recent_runs = [...digests].sort((a, b) => lastActive(b) - lastActive(a)).slice(0, 5).map((d) => {
    const run = {
      name: withoutFileNames(d.name, RUN_NAME_MAX) || 'Run', game: withoutFileNames(gameTitleOf(d), 60) || 'Pokémon', mode: d.mode === 'nuzlocke' ? 'nuzlocke' : 'soullink',
      result: RESULT[d.status?.state] || 'active', badges: Math.max(0, Math.min(16, Number(d.badges) || 0)), deaths: Math.min(100000, (d.deaths || []).length),
    };
    if (d.status?.at && run.result !== 'active') run.ended_at = new Date(d.status.at).toISOString();
    return run;
  });
  return { totals, recent_runs };
}

/**
 * What the profile editor offers: earned achievement ids, the most-caught species, the games played (most runs first),
 * and the "most trusted" candidates – every line of these runs, most relied-on first, with its numbers
 * (shared/trustedlines.mjs) – plus how many runs that is.
 */
export function editorChoices(digests = runDigests()) {
  const species = new Map();
  for (const d of digests) for (const c of d.catches || []) species.set(c.first || c.species, (species.get(c.first || c.species) || 0) + 1);
  const games = new Map();
  for (const d of digests) {
    const title = gameTitleOf(d);
    if (title) games.set(title, (games.get(title) || 0) + 1);
  }
  return {
    achievements: unlockedAchievements(),
    species: [...species.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([id, n]) => ({ id, n })),
    games: [...games.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([title, n]) => ({ title, n })),
    lines: trustedLines(digests, evolutions()).slice(0, 60).map((l) => ({ ...l, nicknames: l.nicknames.map((n) => cleanText(n, 20)), runs: l.runs.map((r) => withoutFileNames(r, RUN_NAME_MAX)) })),
    runs: digests.length,
  };
}

/** The numbers of one "most trusted" line from this computer's runs ({ teams, top_level, fell }), or null. */
export function trustedNumbers(line, digests = runDigests()) {
  return lineNumbers(line, digests, evolutions());
}

/** The upload body for this computer's runs now. */
export const currentStats = () => statsFrom(runDigests());
