// "Share to Discord" (Live runs) in the page: the link state (from the local server – never the token), the events
// a player can share (a death, a run's end, a won run), the card model and the post's text, and the share itself:
// the card is painted here (web/lib/livecard.mjs) and handed to the local server, which posts it to the bot.
import { useState, useEffect } from '/vendor/htm-preact.mjs';
import { t, currentLang } from './i18n.mjs';
import { api } from './api.mjs';
import { speciesName, spriteUrl, gameById, hackById, gameTitle } from './data.mjs';
import {
  players as getPlayers, slotsOf, runMode, pairState, encounter, live, areaName, joinNames, counts, runStats, progression, isDefaultName,
  rules as getRules, presetOf,
} from './run.mjs';
import { eventIdFor, buildMeta } from '/shared/liveruns.mjs';
import { PLAYER_COLORS, renderCardPng } from './livecard.mjs';

// ---- link state (GET /api/liveruns): { linked, user: { id, name }, shared: { eventId: { at, url } }, limits } ----
let state = { linked: false, user: null, shared: {}, limits: null, loaded: false };
const subs = new Set();
const emit = () => {
  for (const fn of subs) fn(state);
};
let loading = null;

/** Ask the local server again; `check` also asks the bot (name, posts left today, a revoked link). */
export async function refreshLiveRuns(check = false) {
  try {
    const s = await api.get(`/api/liveruns${check ? '?check=1' : ''}`);
    state = { ...state, ...s, loaded: true };
  } catch {
    state = { ...state, loaded: true };
  }
  emit();
  return state;
}

export function setLiveRunsState(patch) {
  state = { ...state, ...patch };
  emit();
}

/** The link state, re-rendering when it changes (loaded once per app start). */
export function useLiveRuns() {
  const [s, set] = useState(state);
  useEffect(() => {
    subs.add(set);
    if (!state.loaded && !loading) loading = refreshLiveRuns().finally(() => { loading = null; });
    set(state);
    return () => subs.delete(set);
  }, []);
  return s;
}

// ---- events ----

/** A death (the group of `area`): its id is the same for every player of the run – a partner's share counts too. */
export function deathEvent(doc, manifest, area) {
  const p = doc.get(`pair:${area}`, null);
  if (p?.state !== 'dead') return null;
  return { kind: 'death', area, at: p.diedAt || 0, id: eventIdFor(manifest.id, 'death', { area, at: p.diedAt || 0 }) };
}

/** A run's end (run:status): failed → 'wipe', won → 'victory'. */
export function endEvent(manifest, status) {
  if (!status || !['failed', 'won'].includes(status.state)) return null;
  const kind = status.state === 'won' ? 'victory' : 'wipe';
  return { kind, status, at: status.at || 0, id: eventIdFor(manifest.id, kind, { at: status.at || 0 }) };
}

// ---- the card model ----

export function gameName(manifest) {
  const h = manifest?.game?.hackId ? hackById(manifest.game.hackId) : null;
  const g = manifest?.game?.id ? gameById(manifest.game.id) : null;
  return h ? h.name : g ? gameTitle(g) : manifest?.game?.title || '';
}

/** The game's name in English – the post's `game` (the Discord server is English; the card shows gameName). */
export function gameNameEn(manifest) {
  const h = manifest?.game?.hackId ? hackById(manifest.game.hackId) : null;
  const g = manifest?.game?.id ? gameById(manifest.game.id) : null;
  return h ? h.name : g ? g.title : manifest?.game?.title || '';
}

// The games' short names as players say them ("beat Platinum"), per language – the catalog only has full titles.
const SHORT_NAMES = {
  Red: ['Rot', 'Rouge', 'Rojo', 'Rosso'], Blue: ['Blau', 'Bleu', 'Azul', 'Blu'], Green: ['Grün', 'Verte', 'Verde', 'Verde'],
  Yellow: ['Gelb', 'Jaune', 'Amarillo', 'Giallo'], Gold: ['Gold', 'Or', 'Oro', 'Oro'], Silver: ['Silber', 'Argent', 'Plata', 'Argento'],
  Crystal: ['Kristall', 'Cristal', 'Cristal', 'Cristallo'], Ruby: ['Rubin', 'Rubis', 'Rubí', 'Rubino'], Sapphire: ['Saphir', 'Saphir', 'Zafiro', 'Zaffiro'],
  Emerald: ['Smaragd', 'Émeraude', 'Esmeralda', 'Smeraldo'], FireRed: ['Feuerrot', 'Rouge Feu', 'Rojo Fuego', 'Rosso Fuoco'],
  LeafGreen: ['Blattgrün', 'Vert Feuille', 'Verde Hoja', 'Verde Foglia'], Diamond: ['Diamant', 'Diamant', 'Diamante', 'Diamante'],
  Pearl: ['Perl', 'Perle', 'Perla', 'Perla'], Platinum: ['Platin', 'Platine', 'Platino', 'Platino'],
  HeartGold: ['HeartGold', 'Or HeartGold', 'Oro HeartGold', 'Oro HeartGold'], SoulSilver: ['SoulSilver', 'Argent SoulSilver', 'Plata SoulSilver', 'Argento SoulSilver'],
  Black: ['Schwarz', 'Noire', 'Negro', 'Nera'], White: ['Weiß', 'Blanche', 'Blanco', 'Bianca'],
  'Black 2': ['Schwarz 2', 'Noire 2', 'Negro 2', 'Nera 2'], 'White 2': ['Weiß 2', 'Blanche 2', 'Blanco 2', 'Bianca 2'],
  'Omega Ruby': ['Omega Rubin', 'Rubis Oméga', 'Rubí Omega', 'Rubino Omega'], 'Alpha Sapphire': ['Alpha Saphir', 'Saphir Alpha', 'Zafiro Alfa', 'Zaffiro Alpha'],
  Sun: ['Sonne', 'Soleil', 'Sol', 'Sole'], Moon: ['Mond', 'Lune', 'Luna', 'Luna'],
  'Ultra Sun': ['Ultrasonne', 'Ultra-Soleil', 'Ultrasol', 'Ultrasole'], 'Ultra Moon': ['Ultramond', 'Ultra-Lune', 'Ultraluna', 'Ultraluna'],
};
const SHORT_LANGS = ['de', 'fr', 'es', 'it'];

/** "Pokémon Black Version 2" → "Black 2" (German "Schwarz 2"), a ROM hack's name without "Pokémon". */
export function shortGameName(manifest, lang = currentLang()) {
  const en = gameNameEn(manifest);
  const short = String(en).replace(/^pok[eé]mon\s+/i, '').replace(/\s*[:–]\s+.*$/, '').replace(/\s+version(?=\s+\d+$|$)/i, '').trim();
  const i = SHORT_LANGS.indexOf(lang);
  if (manifest?.game?.hackId || !SHORT_NAMES[short]) return short || gameName(manifest);
  return i >= 0 ? SHORT_NAMES[short][i] : short;
}

/** A nickname that is more than the species' name in any language ('' when the Pokémon has none). */
function realNick(nick, species) {
  const n = String(nick || '').trim();
  return !n || isDefaultName(species, n) ? '' : n;
}
const monLabel = (nick, species) => realNick(nick, species) || speciesName(species);
const lvText = (lv) => `${t('common.lv', 'Lv')} ${lv}`;

/** "Ember (Lv 18 Cyndaquil)", "Cyndaquil (Lv 18)" */
function monText(nick, species, level) {
  const n = realNick(nick, species);
  const sp = speciesName(species);
  if (n) return level ? `${n} (${lvText(level)} ${sp})` : `${n} (${sp})`;
  return level ? `${sp} (${lvText(level)})` : sp;
}

/** Where it fell: the place sign stored with the death, else the player's place sign if it was read around then. */
function placeOf(doc, pair) {
  if (pair?.place?.name) return String(pair.place.name);
  const w = pair?.by ? doc.get(`where:${pair.by}`, null) : null;
  if (w?.name && pair?.diedAt && Math.abs((w.at || 0) - pair.diedAt) < 10 * 60 * 1000 && (w.at || 0) <= pair.diedAt + 5000) return String(w.name);
  return '';
}

const killerKind = (k) => (k?.kind === 'trainer' ? t('live.kTrainer', 'trainer battle') : k?.kind === 'wild' ? t('live.kWild', 'wild battle') : '');

/** Every player's team as the card shows it: the live party (else the party areas), the event's Pokémon marked. */
function teams(doc, manifest, eventArea) {
  const slots = slotsOf(manifest);
  const names = getPlayers(doc, manifest);
  const pair = eventArea ? doc.get(`pair:${eventArea}`, null) : null;
  return slots.map((slot) => {
    const l = live(doc, slot);
    let list = (l?.party || []).filter((m) => m.species && !m.egg)
      .map((m) => ({ species: m.species, nick: m.nick, level: m.level ?? null, area: m.area || null, shiny: !!m.shiny, down: m.maxHp > 0 && m.hp === 0 }));
    if (!list.length) {
      list = (doc.get(`party:${slot}`, []) || []).map((a) => {
        const e = encounter(doc, a, slot);
        return e?.outcome === 'caught' && e.species ? { species: e.species, nick: e.nickname, level: e.level ?? null, area: a, shiny: !!e.shiny } : null;
      }).filter(Boolean);
    }
    // the fallen one of this player, also when it isn't in the party (a partner's linked Pokémon in the box)
    const e = eventArea ? encounter(doc, eventArea, slot) : null;
    if (e?.outcome === 'caught' && e.species && !list.some((m) => m.area === eventArea)) {
      list = [...list.slice(0, 5), { species: e.species, nick: e.nickname, level: (pair?.by === slot ? pair.level : null) ?? e.level ?? null, area: eventArea, shiny: !!e.shiny }];
    }
    const mons = list.slice(0, 6).map((m) => {
      const st = m.area === eventArea && eventArea ? 'fallen' : m.area && pairState(doc, m.area, slots).state === 'dead' ? 'dead' : m.down ? 'down' : 'alive';
      const nick = realNick(m.nick, m.species);
      return { species: m.species, shiny: m.shiny, name: nick || speciesName(m.species), sub: nick ? speciesName(m.species) : '', level: m.level, state: st };
    });
    const alive = mons.filter((m) => m.state === 'alive').length;
    return { slot, name: names[slot]?.name || slot.toUpperCase(), color: PLAYER_COLORS[slot], count: mons.length ? `${alive}/${mons.length}` : '', mons, empty: t('live.noTeam', 'No team seen yet') };
  });
}

/** The run in three numbers: alive, dead, badges (the best of the players). */
function statsOf(doc, manifest) {
  const solo = runMode(manifest) === 'nuzlocke';
  const slots = slotsOf(manifest);
  const badges = Math.max(0, ...slots.map((s) => live(doc, s)?.badges || 0));
  let alive;
  let dead;
  if (solo) {
    const st = runStats(doc, manifest, 'p1');
    alive = st.alive;
    dead = st.dead;
  } else {
    const c = counts(doc, manifest);
    alive = c.linked;
    dead = c.dead;
  }
  return {
    alive, dead, badges,
    boxes: [
      { value: alive, label: t('live.sAlive', 'alive'), tone: 'alive' },
      { value: dead, label: t('live.sDead', 'dead'), tone: 'dead' },
      { value: badges, label: t('live.sBadges', 'badge|badges', { count: badges }), tone: 'gold' },
    ],
  };
}

/** The death that ended a run (or the last one): its area and pair. */
function lastDeath(doc, manifest, status) {
  if (status?.area) {
    const p = doc.get(`pair:${status.area}`, null);
    if (p?.state === 'dead') return { area: status.area, pair: p };
  }
  let best = null;
  for (const a of progression(doc, manifest)) {
    if (a.kind !== 'area') continue;
    const p = doc.get(`pair:${a.key}`, null);
    if (p?.state !== 'dead') continue;
    const score = (p.diedAt || 0) + (status?.by && p.by === status.by ? 1e13 : 0);
    if (!best || score > best.score) best = { area: a.key, pair: p, score };
  }
  return best;
}

/** The cause panel and the post's sentence for one death. */
function deathCause(doc, manifest, area, pair, label) {
  const slots = slotsOf(manifest);
  const caught = (s) => (encounter(doc, area, s)?.outcome === 'caught' ? encounter(doc, area, s) : null);
  const by = pair.by && slots.includes(pair.by) ? pair.by : slots.find((s) => caught(s)?.species) || slots[0];
  const enc = encounter(doc, area, by);
  const k = pair.killer?.species ? pair.killer : null;
  const place = placeOf(doc, pair);
  const typed = typeof pair.cause === 'string' ? pair.cause.trim() : '';
  const n = slots.length;
  const others = slots.filter((s) => s !== by).map((s) => [s, caught(s)]).filter(([, e]) => e?.species);
  const names = getPlayers(doc, manifest);
  const went = others.length ? t('live.dWent', '{list} went with it', {
    list: joinNames(others.map(([s, e]) => t('live.whose', '{name}’s {mon}', { name: names[s]?.name || s.toUpperCase(), mon: monLabel(e.nickname, e.species) }))),
  }) : '';
  const where = areaName(doc, manifest, area);
  const note = typed || (n === 1 ? t('live.caughtAt', 'Caught at {area}', { area: where })
    : n > 2 ? t('live.groupFrom', 'The linked group from {area}', { area: where }) : t('live.pairFrom', 'The linked pair from {area}', { area: where }));
  const cause = {
    label: k ? label.killer : label.none,
    species: k?.species || null,
    title: k ? speciesName(k.species) : t('live.noBattle', 'No battle seen'),
    level: k?.level || null,
    lvLabel: t('common.lv', 'Lv'),
    chip: k?.kind === 'trainer' ? t('live.cTrainer', 'Trainer battle') : k?.kind === 'wild' ? t('live.cWild', 'Wild battle') : '',
    chipTone: k?.kind || null,
    place,
    note,
    icon: 'grave',
  };
  const mon = enc?.species ? monText(enc.nickname, enc.species, pair.level ?? enc.level) : '';
  const foe = k ? `${speciesName(k.species)}${k.level ? ` ${lvText(k.level)}` : ''}` : '';
  const kind = killerKind(k);
  const sentence = mon && foe ? (kind ? t('live.dKilled', '{mon} fell to {foe} in a {kind}', { mon, foe, kind }) : t('live.dKilledNoKind', '{mon} fell to {foe}', { mon, foe }))
    : mon ? t('live.dDied', '{mon} died', { mon }) : '';
  const detail = [sentence, place, went, typed ? `“${typed}”` : ''].filter(Boolean).join(' · ');
  return { cause, detail, by, enc };
}

/** Play time as "41:07" from { h, m } or seconds; null when the game never told. */
function playTime(pt) {
  if (pt == null) return null;
  const v = typeof pt === 'number' ? { h: Math.floor(pt / 3600), m: Math.floor((pt % 3600) / 60) } : pt;
  if (typeof v !== 'object' || !Number.isFinite(v.h ?? 0) || !Number.isFinite(v.m ?? 0)) return null;
  return { minutes: (v.h || 0) * 60 + (v.m || 0), text: `${v.h || 0}:${String(v.m || 0).padStart(2, '0')}` };
}

/** The rules worth naming on a won run's card (short labels, at most five). */
function ruleChips(doc, manifest) {
  const r = getRules(doc, manifest);
  const solo = runMode(manifest) === 'nuzlocke';
  const out = [];
  if (solo && presetOf(r) === 'hardcore') out.push(t('hof.rHardcore', 'Hardcore'));
  else if (r.levelCaps) out.push(t('hof.rCaps', 'Level caps'));
  if (solo && r.deathless) out.push(t('hof.rDeathless', 'Deathless'));
  if (r.dupes && r.dupes !== 'off') out.push(t('hof.rDupes', 'Dupes clause'));
  if (r.typeClause && r.typeClause !== 'off') out.push(t('hof.rType', 'Type rule'));
  if (manifest.randomizer?.enabled) out.push(t('hof.rRandomized', 'Randomized'));
  // a Shinylocke: the game's own shiny rate changed (shared/shiny.mjs)
  if (manifest.shiny?.rate && manifest.shiny.rate !== 8192) out.push(t('hof.rShiny', 'Shiny 1 in {n}', { n: manifest.shiny.rate }));
  if (manifest.shiny?.trainers) out.push(t('hof.rShinyTrainers', 'Trainer shinies'));
  if (solo && presetOf(r) !== 'hardcore') {
    if (r.setMode) out.push(t('hof.rSetMode', 'Set mode'));
    if (r.noBattleItems) out.push(t('hof.rNoItems', 'No items in battle'));
  }
  if (!solo && r.failKillsPair) out.push(t('hof.rMissed', 'Missed = link lost'));
  return out.slice(0, 5);
}

/**
 * A won run for the Hall of Fame card: the final team – in a SoulLink as its linked groups (one Pokémon per player,
 * side by side), in a Nuzlocke the party –, the run in numbers (deaths, play time, badges, alive) and its rules.
 */
function hallOfFame(doc, manifest, status, stats, teamList) {
  const slots = slotsOf(manifest);
  const solo = slots.length === 1;
  const parties = Object.fromEntries(slots.map((s) => [s, (live(doc, s)?.party || []).filter((m) => m.species && !m.egg)]));
  let groups;
  if (solo) {
    groups = (teamList[0]?.mons || []).filter((m) => m.state !== 'dead' && m.state !== 'fallen').slice(0, 6)
      .map((m) => ({ mons: [{ slot: 'p1', color: PLAYER_COLORS.p1, species: m.species, shiny: m.shiny, name: m.name, sub: m.sub, level: m.level }] }));
  } else {
    // the linked groups in the final teams, in the order of the first player's party
    const areas = [];
    for (const s of slots) for (const m of parties[s]) if (m.area && !areas.includes(m.area)) areas.push(m.area);
    if (!areas.length) for (const s of slots) for (const a of doc.get(`party:${s}`, []) || []) if (!areas.includes(a)) areas.push(a);
    groups = areas.filter((a) => pairState(doc, a, slots).state !== 'dead').slice(0, 6).map((area) => ({
      area,
      mons: slots.map((s) => {
        const lm = parties[s].find((m) => m.area === area);
        const e = encounter(doc, area, s);
        const species = lm?.species || (e?.outcome === 'caught' ? e.species : null);
        if (!species) return null;
        const nick = realNick(lm ? lm.nick : e?.nickname, species);
        return { slot: s, color: PLAYER_COLORS[s], species, shiny: !!(lm ? lm.shiny : e?.shiny), name: nick || speciesName(species), sub: nick ? speciesName(species) : '', level: lm?.level ?? e?.level ?? null };
      }),
    })).filter((g) => g.mons.some(Boolean));
  }
  // the longest in-game clock of the players; else the days from the run's start to the win
  const times = slots.map((s) => playTime(live(doc, s)?.playTime)).filter(Boolean).sort((a, b) => b.minutes - a.minutes);
  const started = Date.parse(manifest.createdAt || '') || 0;
  const days = started && status.at > started ? Math.max(1, Math.ceil((status.at - started) / 86400000)) : null;
  const attempt = runStats(doc, manifest, 'p1').attempt || 1;
  const time = times[0]
    ? { value: times[0].text, label: t('hof.sPlayTime', 'played'), tone: 'ink', icon: 'clock' }
    : days ? { value: String(days), label: t('hof.sDays', 'day|days', { count: days }), tone: 'ink', icon: 'clock' } : null;
  return {
    groups,
    players: slots.map((s, i) => ({ name: teamList[i]?.name || s.toUpperCase(), color: PLAYER_COLORS[s] })),
    timeText: times[0]?.text || null,
    attempt,
    boxes: [
      { value: String(stats.dead), label: t('hof.sDeaths', 'death|deaths', { count: stats.dead }), tone: 'dead', icon: 'grave' },
      time || { value: '–', label: t('hof.sPlayTime', 'played'), tone: 'ink', icon: 'clock' },
      // no badges to show (Alola's trials, a game souldew can't read them in): the catches instead
      stats.badges > 0
        ? { value: String(stats.badges), label: t('live.sBadges', 'badge|badges', { count: stats.badges }), tone: 'gold', icon: 'badge' }
        : { value: String(stats.alive + stats.dead), label: t('hof.sCaught', 'caught'), tone: 'gold', icon: 'ball' },
      { value: String(stats.alive), label: solo ? t('hof.sAlive', 'alive') : t('hof.sLinksAlive', 'links alive'), tone: 'alive', icon: solo ? 'heart' : 'link' },
    ],
    rules: ruleChips(doc, manifest),
    labels: {
      run: t('hof.lRun', 'The run'), team: solo ? t('hof.lTeam', 'Final team') : t('hof.lLinks', 'Final team · linked'),
      rules: t('hof.lRules', 'Rules'), attempt: attempt > 1 ? t('live.attempt', 'Attempt #{n}', { n: attempt }) : '',
    },
  };
}

/**
 * The card model for an event (deathEvent / endEvent) – every word in the app's language – and the post's `meta`
 * input (shared/liveruns.mjs buildMeta cleans and cuts it). `app`: the version on the card's corner.
 */
export function cardModel({ doc, manifest, gen = 4, event, app = '' }) {
  const slots = slotsOf(manifest);
  const n = slots.length;
  const solo = runMode(manifest) === 'nuzlocke';
  const names = getPlayers(doc, manifest);
  const playerNames = slots.map((s) => names[s]?.name || s.toUpperCase());
  const game = gameName(manifest);
  const run = manifest.name || '';
  const stats = statsOf(doc, manifest);
  const kicker = solo ? t('live.kNuzlocke', 'Nuzlocke') : t('live.kSoulLink', 'SoulLink · {n} players', { n });
  let headline = '';
  let detail = '';
  let cause = null;
  let tag = '';
  let highlights = [];
  let hof = null;
  const eventArea = event.kind === 'death' ? event.area : null;
  const teamList = teams(doc, manifest, eventArea);
  if (event.kind === 'death') {
    const pair = doc.get(`pair:${event.area}`, null) || {};
    const fallenBy = slots.map((s) => [s, encounter(doc, event.area, s)]).filter(([, e]) => e?.species);
    const fallen = fallenBy.map(([, e]) => monLabel(e.nickname, e.species));
    highlights = fallenBy.map(([s, e]) => ({ text: monLabel(e.nickname, e.species), color: PLAYER_COLORS[s] }));
    headline = fallen.length >= 3 ? t('live.hGoneN', '{names} are gone', { names: joinNames(fallen) })
      : fallen.length === 2 ? t('live.hGone2', '{a} and {b} are gone', { a: fallen[0], b: fallen[1] })
        : t('live.hGone1', '{a} is gone', { a: fallen[0] || areaName(doc, manifest, event.area) });
    const d = deathCause(doc, manifest, event.area, pair, { killer: t('live.fellTo', 'Fell to'), none: t('live.cause', 'Cause') });
    cause = d.cause;
    detail = d.detail;
    tag = t('live.tagDeath', 'Death');
  } else if (event.kind === 'wipe') {
    const st = event.status || {};
    const who = names[st.by]?.name || playerNames[0];
    if (solo || st.auto) highlights = [{ text: who, color: PLAYER_COLORS[st.by] || PLAYER_COLORS.p1 }];
    headline = st.auto && st.reason === 'lives' ? (solo ? t('live.hLivesSolo', '{name}’s Nuzlocke is out of lives', { name: who }) : t('live.hLives', 'Out of lives – the SoulLink is over'))
      : solo ? (st.reason === 'deathless' ? t('live.hDeathless', '{name}’s deathless run is over', { name: who }) : t('live.hWipeSolo', '{name}’s Nuzlocke is over', { name: who }))
        : st.auto ? t('live.hWipe', '{name}’s team was wiped', { name: who }) : t('live.hEnded', 'The SoulLink is over');
    const last = lastDeath(doc, manifest, st);
    if (last) {
      const d = deathCause(doc, manifest, last.area, last.pair, { killer: t('live.lastFellTo', 'The last one fell to'), none: t('live.lastToFall', 'The last to fall') });
      cause = d.cause;
      detail = d.detail;
    } else cause = { label: t('live.runOver', 'Run over'), title: st.auto ? t('live.wiped', 'Team wiped') : t('live.endedByHand', 'Ended by hand'), icon: 'grave' };
    detail = [t('live.dStats', '{alive} alive · {dead} dead', { alive: stats.alive, dead: stats.dead }), detail].filter(Boolean).join(' · ');
    tag = t('live.tagWipe', 'Run over');
  } else {
    const short = shortGameName(manifest);
    headline = solo ? t('hof.hWonSolo', '{name} beat {game}!', { name: playerNames[0], game: short }) : t('hof.hWon', '{names} beat {game}!', { names: joinNames(playerNames), game: short });
    highlights = slots.map((s, i) => ({ text: playerNames[i], color: PLAYER_COLORS[s] }));
    hof = hallOfFame(doc, manifest, event.status || {}, stats, teamList);
    detail = [
      t('live.dWon', 'Run won with {alive} alive and {dead} lost on the way', { alive: stats.alive, dead: stats.dead }),
      hof.timeText ? t('hof.dTime', '{time} played', { time: hof.timeText }) : '',
      hof.attempt > 1 ? t('live.attempt', 'Attempt #{n}', { n: hof.attempt }) : '',
    ].filter(Boolean).join(' · ');
    tag = t('hof.tag', 'Hall of Fame');
  }
  const model = {
    v: 1, kind: event.kind, mode: solo ? 'nuzlocke' : 'soullink', gen,
    kicker, tag, headline, highlights, run, game, cause, stats: stats.boxes,
    teams: teamList,
    ...(hof ? { hof } : {}),
    ticker: [hof ? t('hof.tag', 'Hall of Fame') : t('live.ticker', 'Live runs'), game, solo ? t('live.kNuzlocke', 'Nuzlocke') : t('live.tickPlayers', '{n} players', { n })].filter(Boolean),
    labels: { fallen: t('live.lFallen', 'Gone'), dead: t('live.lDead', 'Dead'), lv: t('common.lv', 'Lv') },
    app,
  };
  const metaInput = {
    eventId: event.id, kind: event.kind, mode: model.mode, game: gameNameEn(manifest) || game, run, players: playerNames, headline, detail,
    ...(gen >= 1 && gen <= 9 ? { gen } : {}), hack: !!(manifest.game?.hackId || manifest.patch), randomized: !!manifest.randomizer?.enabled,
  };
  return { model, metaInput };
}

/** Bytes → base64 (in chunks: the card is around half a megabyte). */
function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Share `event`: paint the card, send it with its text through the local server. Returns the server's outcome
 * ({ ok, url } or { ok: false, error, … }) plus `changed` (fields that lost a link or a link word).
 */
export async function shareEvent({ doc, manifest, gen, event, app = '' }) {
  const { model, metaInput } = cardModel({ doc, manifest, gen, event, app });
  const { meta, changed } = buildMeta(metaInput);
  const png = await renderCardPng(model, (id, fallback) => spriteUrl(id, { gen: fallback ? 9 : gen }));
  const r = await api.post('/api/liveruns/post', { meta, image: base64(png) });
  if (r.ok || r.error === 'duplicate') setLiveRunsState({ shared: { ...state.shared, [event.id]: { at: Date.now(), url: r.url || null, duplicate: !r.ok } } });
  if (r.error === 'token') setLiveRunsState({ linked: false, user: null, expired: true });
  return { ...r, changed };
}

/** The outcome as one line for the player. */
export function shareErrorText(r) {
  switch (r?.error) {
    case 'rate': {
      const min = Math.max(1, Math.ceil((r.retryAfter || 60) / 60));
      return t('live.eRate', 'Too many posts – try again in {n} min.', { n: min });
    }
    case 'token': return t('live.eToken', 'The Discord link has ended – connect again in Settings › Online.');
    case 'blocked': return t('live.eBlocked', 'This Discord account can no longer post live runs.');
    case 'not-member': return t('live.eNotMember', 'Your Discord account is no longer on the souldew server – join it again to post.');
    case 'duplicate': return t('live.already', 'Already shared – by you or a partner.');
    case 'invalid': return r.reason === 'word' ? t('live.eWord', 'The server’s word filter refused a nickname or a text on this card.')
      : t('live.eInvalid', 'The server refused the post ({field}).', { field: r.field || '?' });
    case 'unavailable': return t('live.eUnavailable', 'Discord can’t be reached right now – try again in a moment.');
    case 'offline': return t('live.eOffline', 'No connection to the souldew bot – are you online?');
    default: return t('live.eServer', 'Sharing didn’t work – try again later.');
  }
}
