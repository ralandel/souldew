// Pokémon data for the UI: PokeAPI-derived names/types (multi-language), the game catalog,
// and per-run randomized ROM data (types/evolutions exported by the randomizer bridge).
import { api } from './api.mjs';
import { currentLang, t } from './i18n.mjs';
import { slotsOf } from '/shared/slots.mjs';
import { speciesCeiling } from '/shared/live/romspecies.mjs';
import { setTypeChart } from '/shared/typechart.mjs';
import { formTypes, formSpriteId, formKind } from '/shared/forms.mjs';
import { gbItemKey } from '/shared/giftitems.mjs';

let P = null;
let CATALOG = { games: [], hacks: [] };
let GEN4 = null;

export async function loadData() {
  const [p, c, g] = await Promise.all([
    fetch('/shared/data/pokeapi.json').then((r) => r.json()),
    api.get('/api/catalog').catch(() => ({ games: [], hacks: [] })),
    fetch('/shared/data/gen4.json').then((r) => r.json()),
  ]);
  P = p;
  CATALOG = c;
  GEN4 = g;
}

export const pokeapi = () => P;
export const catalog = () => CATALOG;
export const gen4data = () => GEN4;

const nameLang = () => (P?.names?.[currentLang()] ? currentLang() : 'en');

// Pokémon only the running ROM knows (a ROM hack's own: shared/live/parse.mjs FAKEMON + their index in the game),
// named as the game names them (shared/live/romspecies.mjs `unknown`).
export const FAKEMON = 20000; // = shared/live/parse.mjs FAKEMON (PokeAPI's form ids run from 10001)
let ROM_SPECIES = null;
let ROM_CEILING = null; // the highest National Dex number the running ROM holds (a hack with later Pokémon)
export function setRomSpecies(sp) {
  ROM_SPECIES = sp?.unknown && Object.keys(sp.unknown).length ? sp.unknown : null;
  ROM_CEILING = speciesCeiling(sp);
}

/** The last National Dex number of each generation's games. */
export const GEN_MAX_ID = [0, 151, 251, 386, 493, 649, 721, 809];

// The running ROM's types (shared/live/romtypes.mjs via server/lib/romloc.mjs): the game's own – each Pokémon's, the
// chart, the moves', the names of types only it has (Too Many Types) – so a hack that changed them shows what it uses.
// The chart goes to shared/typechart.mjs for the battle helper.
let ROM_TYPES = null;
const TYPE_LABELS = {}; // a game's own types by key ('x-monke') → the game's name ("Monke")
export function setRomTypes(t) {
  ROM_TYPES = t?.species ? t : null;
  Object.assign(TYPE_LABELS, ROM_TYPES?.labels || {});
  setTypeChart(ROM_TYPES);
}
export const romTypesNow = () => ROM_TYPES;

export function speciesName(id, lang = nameLang()) {
  if (!id) return '';
  if (id > FAKEMON && ROM_SPECIES?.[id - FAKEMON]) return ROM_SPECIES[id - FAKEMON];
  return P?.names?.[lang]?.[id] || P?.names?.en?.[id] || `#${id}`;
}

/** What a form is called (shared/forms.mjs formKind: 'mega', 'megaX', 'megaY', 'primal', 'alola'), '' for none. */
export function formLabel(kind) {
  switch (kind) {
    case 'mega': return t('form.mega', 'Mega');
    case 'megaX': return t('form.megaX', 'Mega X');
    case 'megaY': return t('form.megaY', 'Mega Y');
    case 'primal': return t('form.primal', 'Primal');
    case 'alola': return t('form.alola', 'Alolan form');
    default: return '';
  }
}

/**
 * The species' name with the form it is in right now – "Charizard (Mega Y)", "Vulpix (Alolan form)" – where the form
 * has a name of its own (shared/forms.mjs formKind); else the species' name. Only for showing: a form is its species
 * for every rule.
 */
export function speciesFormName(id, form = 0, gen = 7, lang) {
  const name = speciesName(id, lang);
  const label = form && id < FAKEMON ? formLabel(formKind(id, form, gen)) : '';
  return label && name ? t('form.named', '{name} ({form})', { name, form: label }) : name;
}

/** Types valid in a given generation (PokeAPI typesGen: smallest key ≥ gen wins). */
export function baseTypes(id, gen = 9) {
  if (!P || !id) return [];
  const past = P.typesGen?.[id];
  if (past) {
    const keys = Object.keys(past).map(Number).sort((a, b) => a - b);
    const k = keys.find((x) => x >= gen);
    if (k !== undefined) return past[k];
  }
  return P.types?.[id] || [];
}

export function typeLabel(type) {
  const t = String(type || '').toLowerCase();
  return TYPE_LABELS[t] || P?.typeNames?.[currentLang()]?.[t] || P?.typeNames?.en?.[t] || t;
}

export function moveName(id, lang = currentLang()) {
  const l = P?.moves?.[lang] ? lang : 'en';
  return P?.moves?.[l]?.[id] || '';
}

/** An ability's name by its number (the games number them alike from Gen 3 on); '' when unknown. */
export function abilityName(id, lang = currentLang()) {
  const l = P?.abilities?.[lang] ? lang : 'en';
  return (Number.isInteger(id) && id > 0 && (P?.abilities?.[l]?.[id] || P?.abilities?.en?.[id])) || '';
}

/** A nature's name by its number in the games (0 Hardy … 24 Quirky); '' when unknown. */
export function natureName(n, lang = currentLang()) {
  const l = P?.natures?.[lang] ? lang : 'en';
  return (Number.isInteger(n) && (P?.natures?.[l]?.[n] || P?.natures?.en?.[n])) || '';
}

/**
 * A held item's name: the game's item number → PokeAPI's name in the app's language (each generation from 3 to 7
 * numbers its items its own way – pokeapi.json items.gen3 … gen7). '' when unknown: Gen 1/2, an item only a ROM hack has.
 */
export function itemName(id, gen, lang = currentLang()) {
  const items = P?.items;
  const key = Number.isInteger(id) && id > 0 && gen >= 3 && gen <= 7 ? items?.[`gen${gen}`]?.[id] : null;
  return key ? items.names?.[lang]?.[key] || items.names?.en?.[key] || '' : '';
}

/** An item's name by its PokeAPI identifier ('master-ball') in the app's language – '' when unknown. */
export function itemNameByKey(key, lang = currentLang()) {
  const names = P?.items?.names;
  return (key && (names?.[lang]?.[key] || names?.en?.[key])) || '';
}

/**
 * An item's name for a gift between players (web/lib/together.mjs): Gen 3–7 as itemName, Gen 1/2 for the items a gift
 * may be (shared/giftitems.mjs – their PokeAPI identifier, the same names). '' when unknown.
 */
export function giftItemName(id, gen, lang = currentLang()) {
  if (gen >= 3) return itemName(id, gen, lang);
  const key = gbItemKey(gen, id);
  const items = P?.items;
  return key ? items?.names?.[lang]?.[key] || items?.names?.en?.[key] || '' : '';
}

/**
 * Sprite in the art style of the game's generation (served + cached by the local server). `form`: the Pokémon's
 * alternate form (shared/forms.mjs – PokeAPI's own number for it; Gen 4/5's sprite sets have them, the others show
 * today's sprite of the form: a 3DS game's Mega or Alolan form, an expanded GBA engine's Mega).
 */
export function spriteUrl(id, { gen = 4, shiny = false, form = 0 } = {}) {
  if (!id || id > FAKEMON) return ''; // (a ROM hack's own Pokémon has no sprite here)
  // (Gen 3: an expanded engine's Megas and Primal forms – shared/live/romspecies.mjs gen3Forms – in today's style)
  const fid = form && gen >= 3 ? formSpriteId(id, form) : id;
  if (fid !== id) {
    if (gen === 4 || gen === 5) return `/sprites/gen${gen}${shiny ? 'shiny' : ''}/${fid}.png`;
    return `/sprites/${shiny ? 'shiny' : 'default'}/${fid}.png`;
  }
  // Gen 6/7 (3DS games have 3D models, no sprite set of their own): the current artwork-style sprites
  if (gen >= 6) return `/sprites/${shiny ? 'shiny' : 'default'}/${id}.png`;
  const g = Math.min(Math.max(gen || 4, 1), 5);
  if (id > GEN_MAX_ID[g]) return `/sprites/${shiny ? 'shiny' : 'default'}/${id}.png`;
  const set = { 1: 'gen1', 2: shiny ? 'gen2shiny' : 'gen2', 3: shiny ? 'gen3shiny' : 'gen3', 4: shiny ? 'gen4shiny' : 'gen4', 5: shiny ? 'gen5shiny' : 'gen5' }[g];
  return `/sprites/${set}/${id}.png`;
}

export function gameById(id) {
  return CATALOG.games?.find((g) => g.id === id) || null;
}
export function hackById(id) {
  return CATALOG.hacks?.find((h) => h.id === id) || null;
}
/**
 * A patch in a hack picker: the hack's name – with the file name when the list holds several versions of that hack
 * (an update added next to the old file), so they can be told apart. A patch of no known hack: its file name.
 */
export function patchLabel(p, all = [], nameOf = (id) => hackById(id)?.name) {
  const hack = p.hackId ? nameOf(p.hackId) : null;
  if (!hack) return p.name;
  return all.some((x) => x !== p && x.hackId === p.hackId) ? `${hack} · ${p.name}` : hack;
}
/**
 * Can `patch` be applied to the library ROM `rom`? A BPS/UPS patch carries the CRC32 of the one ROM it is made for and
 * the patcher refuses any other. An xdelta or IPS patch carries none: its CRC32 comes from the catalog or the hack's
 * readme and names one copy of the game. A catalog hack's xdelta patch also goes with any other copy of the hack's base
 * game (another dump or release) – like the hack's Play button, which patches whatever base ROM there is (#68): xdelta
 * checks every window it writes (Adler-32), so a copy it really doesn't fit fails when the game is checked. An IPS patch
 * checks nothing – it would write its bytes into any copy, another language's too, and give a broken game –, so it keeps
 * the CRC32 it names.
 */
export function patchFits(patch, rom, cat = CATALOG) {
  if (!patch || !rom) return false;
  if (!patch.expectedCrc || patch.expectedCrc === rom.crc) return true;
  if (patch.format !== 'xdelta' || !patch.hackId || !rom.gameId || rom.hackId || rom.customHack) return false;
  const rootOf = (id) => cat.games?.find((g) => g.id === id)?.variantOf || id;
  const base = cat.hacks?.find((h) => h.id === patch.hackId)?.baseGameId;
  return !!base && rootOf(rom.gameId) === rootOf(base);
}
/**
 * A patch in the diagnostics: its hack, its format and its SHA-1 – what tells the patch apart in a report. Never its id
 * or file: a library id is the absolute path of the file (server/lib/library.mjs makeId), with the player's user name.
 */
export function patchDiag(p) {
  return p ? { hack: p.hackId || null, format: p.format || null, sha1: p.sha1 || null } : null;
}
export function gameTitle(g) {
  if (!g) return '';
  return (currentLang() === 'de' && g.titleDe) || g.title;
}

/** Per-run game data: generation, randomized types/evolutions per player. */
export class RunData {
  constructor() {
    this.gen = 4;
    this.romData = {};
    this.byId = {};
  }

  /**
   * `rom: false`: without the ROM's own data (romFetch / withRom bring it later) – the scan of a big game file takes
   * seconds (a DS game) to minutes (a slow PC, the first time), and the run must not wait for it (web/app.mjs).
   */
  async load(manifest, { rom = true } = {}) {
    const game = gameById(manifest?.game?.id) || gameById(manifest?.base?.gameId);
    this.gen = game?.generation || genFromSystem(manifest?.game) || 4;
    this.game = game;
    for (const slot of manifest ? slotsOf(manifest) : ['p1', 'p2']) {
      const d = manifest ? await api.get(`/api/runs/${manifest.id}/data/${slot}`).catch(() => null) : null;
      this.romData[slot] = d;
      this.byId[slot] = d ? new Map(d.pokemon.filter((p) => p.forme === 0).map((p) => [p.id, p])) : null;
    }
    this._applyRom(null);
    if (rom) this._applyRom(await this.romFetch(manifest));
    return this;
  }

  /**
   * The game's own data from its ROM (server/lib/romloc.mjs, computed in a worker): its types (any game – a hack may
   * have changed them) and, for a GBA game, which Pokémon it holds (a hack with later generations' Pokémon: Run & Bun,
   * Light Platinum – also a ROM that was patched before it was added). Only needed while no player's randomizer data
   * is here. → the scan's result, or null (none needed, or it failed).
   */
  async romFetch(manifest) {
    const out = Object.entries(manifest?.outputs || {}).find(([s, o]) => !this.byId[s] && o?.rom);
    if (!out) return null;
    const src = `/api/runs/${manifest.id}/file?inline=1&name=${encodeURIComponent(out[1].rom)}`;
    return fetch(`/api/rom/locations?src=${encodeURIComponent(src)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }

  /** A copy of this run's data with the ROM's own data `j` (romFetch) in it – a new object, so whatever depends on it updates. */
  withRom(j) {
    const c = Object.assign(Object.create(RunData.prototype), this);
    c._applyRom(j);
    return c;
  }

  _applyRom(j) {
    this.romTypes = j?.types?.species ? j.types : null;
    this.romSpecies = j?.species || null;
    this.romVanilla = j ? j.vanilla !== false : null;
    Object.assign(TYPE_LABELS, this.romTypes?.labels || {});
    // a hack's own Pokémon are named as the game names them – on the board too, not only while the game runs
    if (this.romSpecies?.unknown && Object.keys(this.romSpecies.unknown).length) setRomSpecies(this.romSpecies);
  }

  /** A ROM hack's own Pokémon (no National Dex number): their ids (FAKEMON + the game's index), for the picker. */
  ownSpecies() {
    const unknown = this.romSpecies?.unknown || (this.gen === 3 ? ROM_SPECIES : null) || {};
    return Object.keys(unknown).map((i) => FAKEMON + Number(i));
  }

  /**
   * The highest National Dex number the run's game can hold – what the species picker offers. The generation's last
   * Pokémon, or more for a game that has later ones: a ROM hack's species table (Run & Bun: 1000+, Light Platinum: Gen
   * 4/5 Pokémon in a Ruby ROM), the randomizer's Pokémon list, or the ROM running right now.
   */
  maxSpecies() {
    let max = GEN_MAX_ID[this.gen] || 649;
    for (const m of Object.values(this.byId)) if (m) for (const id of m.keys()) if (id > max && id < FAKEMON) max = id;
    const own = speciesCeiling(this.romSpecies);
    if (own > max) max = own;
    // (the play view sets the running ROM's table – the same game in a run)
    if (this.gen === 3 && ROM_CEILING > max) max = ROM_CEILING;
    return max;
  }

  /** The ROM data of `slot` – or of any player this computer has it for (each one builds only their own game). */
  _map(slot) {
    return this.byId[slot] || Object.keys(this.byId).sort().map((s) => this.byId[s]).find(Boolean) || null;
  }

  /**
   * A Pokémon's types in this run's game. `form`: a DS Pokémon's alternate form (shared/live/parse.mjs reads it) – the
   * randomizer's types for that form, else the ROM's (Gen 5 keeps the forms' own entries), else the official ones;
   * a form whose types aren't known anywhere has the species'.
   */
  types(id, slot, form = 0) {
    if (form > 0) {
      const ft = this.formTypes(id, slot, form);
      if (ft) return ft;
    }
    const p = this.byId[slot]?.get(id) || Object.keys(this.byId).sort().map((s) => this.byId[s]?.get(id)).find(Boolean);
    if (p) return p.types.filter(Boolean).map((t) => t.toLowerCase());
    // the game's own types (read from the ROM: loaded with the run, or from the game running right now); a Pokémon
    // its table doesn't list (Gen 1's Mew where that entry wasn't found, a type the game doesn't name) has the official
    // ones – unless the game has types of its own, where those would be wrong
    const rt = this.romTypes || ROM_TYPES;
    if (rt) return rt.species[id] || (rt.own ? [] : baseTypes(id, this.gen));
    // no types read from the ROM (a modified one whose tables weren't found too): the official ones – the battle
    // helper then shows no matchups for a modified ROM (matchupsKnown), as they may be wrong there
    return baseTypes(id, this.gen);
  }

  /** The types of `id` in form `form` when they are the form's own (see types), or null. */
  formTypes(id, slot, form) {
    // the randomizer's list names a form "<species>-<form>" (its own number, not the species')
    const slots = [slot, ...Object.keys(this.romData).sort()];
    for (const s of slots) {
      const d = this.romData[s];
      const base = this.byId[s]?.get(id);
      if (!d || !base) continue;
      const f = d.pokemon.find((p) => p.forme === form && p.id !== id && typeof p.name === 'string' && p.name.startsWith(`${base.name}-`));
      if (f) return f.types.filter(Boolean).map((t) => t.toLowerCase());
      return null; // (randomized: the official form types would be wrong)
    }
    const rt = this.romTypes || ROM_TYPES;
    if (rt?.own) return rt.forms?.[id]?.[form] || null;
    // (a Gen 5 ROM lists every form with types of its own – one it doesn't list has the species'; Arceus's type is its
    // plate's, which the game works out itself)
    if (rt?.forms && id !== 493) return rt.forms[id]?.[form] || null;
    return formTypes(id, form, this.gen);
  }

  /** Can the battle helper tell matchups? The game's own chart, or the official one where the game has only those types. */
  get matchupsKnown() {
    const rt = this.romTypes || ROM_TYPES;
    if (!rt) return this.romVanilla !== false; // (a modified ROM whose types couldn't be read: official types, no matchups)
    return !!rt.chart || !rt.own;
  }

  /** Does the game have the Fairy type (a hack that added it)? */
  get fairy() {
    // Gen 6 brought the Fairy type; before that only a hack that added it
    return this.gen >= 6 || !!(this.romTypes || ROM_TYPES)?.fairy;
  }

  familyRoot(id, slot) {
    const map = this._map(slot);
    let cur = id;
    const seen = new Set();
    for (;;) {
      if (seen.has(cur)) break;
      seen.add(cur);
      const prev = map ? map.get(cur)?.evolvesFrom?.[0] : P?.evolvesFrom?.[cur];
      if (!prev) break;
      cur = prev;
    }
    return cur;
  }

  sprite(id, shiny, form = 0) {
    return spriteUrl(id, { gen: this.gen, shiny, form });
  }

  encounterTables(slot) {
    const d = this.romData[slot];
    if (!d) return [];
    const TOKENS = [' Morning ', ' Day ', ' Night ', ' Hoenn/Sinnoh', ' Swarms', ' Surfing', ' Old Rod', ' Good Rod', ' Super Rod',
      ' Fishing Swarm', ' Headbutt', ' Rock Smash', ' Bug Catching', ' Grass/Cave', ' Grass', ' Cave', ' Fishing', ' Surf'];
    const groups = new Map();
    for (const set of d.encounters) {
      const name = ` ${set.area} `;
      let cut = -1;
      for (const tk of TOKENS) {
        const i = name.indexOf(tk, 1);
        if (i > 0 && (cut < 0 || i < cut)) cut = i;
      }
      const area = (cut > 0 ? name.slice(0, cut) : name).trim();
      if (!groups.has(area)) groups.set(area, []);
      groups.get(area).push({ method: (cut > 0 ? name.slice(cut) : '').trim(), slots: set.slots });
    }
    return [...groups.entries()].map(([area, sets]) => ({ area, sets }));
  }

  starters(slot) {
    return this.romData[slot]?.starters || [];
  }

  /**
   * A Pokémon of the randomizer's lists (encounters, starters, statics) by its number there: UPR numbers alternate forms
   * after the last species (Gen 5 from 650, Gen 6 from 722, Gen 7 from 808 – a wild Mega Charizard Y with "Allow
   * alternate forms" is one of them), which the app's species numbers would name as another Pokémon. → { species, form,
   * name } – the species and the form's number in the game, and its name ("Charizard (Mega Y)"; UPR's own "Rotom-Heat"
   * for a form without a name of its own here).
   */
  uprMon(id, slot) {
    const list = this.romData[slot]?.pokemon || [];
    const p = list.find((x) => x.id === id);
    if (!p || !(p.forme > 0)) return { species: id, form: 0, name: speciesName(id) };
    const base = list.filter((b) => b.forme === 0 && typeof b.name === 'string' && typeof p.name === 'string' && p.name.startsWith(`${b.name}-`))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (!base) return { species: id, form: 0, name: String(p.name || speciesName(id)) };
    const kind = formKind(base.id, p.forme, this.gen);
    return { species: base.id, form: p.forme, name: kind ? speciesFormName(base.id, p.forme, this.gen) : String(p.name) };
  }
}

export function genFromSystem(game) {
  if (!game) return null;
  return { gb: 1, gbc: 2, gba: 3, nds: 4 }[game.system] || (game.system === '3ds' ? game.generation || 6 : null);
}
