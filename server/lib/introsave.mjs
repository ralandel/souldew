// Intro saves (a community idea): "play the intro once, start every new attempt from there". A player keeps the
// battery save of one of their runs – made after the intro, before the starter – and new attempts of the same game
// (randomized or not) start from it. Each save is this computer's own: kept in the data folder, one per game, never in
// a run pack, an invite or the run's shared document (a SoulLink partner keeps their own). What a save holds and why
// it fits every randomized build of its game: shared/introsave.mjs.
//
// "The same game" is its exact release: the catalog entry of the base ROM (Emerald and the German Smaragd are two;
// Rev 0 and Rev 1 of a game share one, their saves are the same), a ROM hack by its patch file or its own checksum,
// a 3DS game by its title. Never by file name or path.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, cpSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DATA_DIR, DEV, SHARED_DIR } from './paths.mjs';
import { catalog } from './library.mjs';
import { saveDirFor } from './ctr.mjs';
import { readManifest, writeManifest } from './build.mjs';
import { writeFileAtomic, httpError } from './fsutil.mjs';
import { inspectSave, INTRO_SYSTEMS } from '../../shared/introsave.mjs';

export const INTRO_DIR = join(DATA_DIR, DEV ? 'runs/.intro-saves' : 'intro-saves');
const ID = /^[a-f0-9]{16}$/;
const SAVE = 'save.sav';
const CTR = 'ctr';
/** Inside a 3DS save folder (server/lib/ctr.mjs saveDirFor): the SD card's "Nintendo 3DS" folder. */
const CTR_ROOT = ['Azahar', 'sdmc', 'Nintendo 3DS'];

const idOf = (key) => createHash('sha1').update(String(key)).digest('hex').slice(0, 16);
const upper = (s) => String(s || '').toUpperCase();

/** The catalog game a base ROM is a dump of (its exact release: pokemon-emerald-de, not pokemon-emerald). */
export function catalogIdForCrc(crc, cat = catalog()) {
  const c = upper(crc);
  if (!c) return null;
  for (const g of cat.games || []) {
    if ((g.crc32 || []).some((x) => upper(x) === c) || (g.dumps || []).some((d) => upper(d.crc32) === c)) return g.id;
  }
  return null;
}

/**
 * The key intro saves are kept under, for a run (its manifest: base ROM, patch, game) – or null where there is none
 * (a system without battery saves, a patch without a checksum).
 */
export function introKeyFor(m, cat = catalog()) {
  const system = m?.game?.system;
  if (!INTRO_SYSTEMS.includes(system)) return null;
  return keyOf({ system, crc: m.base?.crc, patchSha1: m.patch ? m.patch.sha1 || '' : null, hacked: !!(m.game?.hackId || m.game?.hackName), ctrGame: m.game?.id }, cat);
}

/** The same key for a library ROM (+ the patch the new-run wizard picked) – before any run exists. */
export function introKeyForLibrary(rom, patch = null, cat = catalog()) {
  if (!rom || !INTRO_SYSTEMS.includes(rom.system)) return null;
  return keyOf({ system: rom.system, crc: rom.crc, patchSha1: patch ? patch.sha1 || '' : null, hacked: !!(rom.hackId || rom.customHack), ctrGame: rom.gameId }, cat);
}

function keyOf({ system, crc, patchSha1, hacked, ctrGame }, cat) {
  if (patchSha1 !== null) return /^[a-f0-9]{40}$/i.test(patchSha1) ? `patch:${patchSha1.toLowerCase()}` : null;
  if (system === '3ds') return !hacked && ctrGame ? `game:${ctrGame}` : null;
  const c = upper(crc);
  if (!/^[0-9A-F]{8}$/.test(c)) return null;
  if (hacked) return `rom:${c}`;
  const id = catalogIdForCrc(c, cat);
  return id ? `game:${id}` : `rom:${c}`;
}

let tables = null;
/** Index → National Dex for Gen 1 and Gen 3 (the species of a Pokémon in the save). */
function speciesTables() {
  if (tables) return tables;
  const load = (f) => {
    try {
      const j = JSON.parse(readFileSync(join(SHARED_DIR, 'data', f), 'utf8'));
      const src = j.map || j.table || j;
      const out = [];
      for (const [k, v] of Object.entries(src)) if (!k.startsWith('_')) out[Number(k)] = v;
      return out;
    } catch {
      return null;
    }
  };
  tables = { gen1Index: load('gen1_index_to_dex.json'), gen3Index: load('gen3_index_to_dex.json') };
  return tables;
}

/** What is kept of an intro save (meta.json) – everything but the save itself. */
function readMeta(id) {
  try {
    const m = JSON.parse(readFileSync(join(INTRO_DIR, id, 'meta.json'), 'utf8'));
    return m && typeof m === 'object' && m.id === id && typeof m.key === 'string' ? m : null;
  } catch {
    return null;
  }
}

/**
 * The new intro save `tmp` becomes intro save `id`: the old one is moved aside first, the new one renamed into its
 * place, and only then is the old one deleted. (Until 2.8.2 the old one was deleted before the rename – a rename that
 * failed then, a virus scanner holding the folder on Windows, lost both.) A rename that fails puts the old one back; one
 * interrupted between the two renames is put back the next time the intro saves are read (recoverAside).
 */
export function swapIn(tmp, id, { rename = renameSync } = {}) {
  const dir = join(INTRO_DIR, id);
  const aside = existsSync(dir) ? join(INTRO_DIR, `.old-${id}-${randomBytes(4).toString('hex')}`) : null;
  try {
    if (aside) rename(dir, aside);
    rename(tmp, dir);
  } catch (e) {
    if (aside && !existsSync(dir) && existsSync(aside)) {
      try {
        renameSync(aside, dir);
      } catch { /* recoverAside puts it back later */ }
    }
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  if (aside) rmSync(aside, { recursive: true, force: true });
}

/** An old intro save left aside by an interrupted swapIn: back where it was when nothing took its place, else gone. */
function recoverAside() {
  if (!existsSync(INTRO_DIR)) return;
  for (const d of readdirSync(INTRO_DIR)) {
    const m = /^\.old-([a-f0-9]{16})-[a-f0-9]{8}$/.exec(d);
    if (!m) continue;
    try {
      if (existsSync(join(INTRO_DIR, m[1]))) rmSync(join(INTRO_DIR, d), { recursive: true, force: true });
      else renameSync(join(INTRO_DIR, d), join(INTRO_DIR, m[1]));
    } catch { /* (held by another program: the next time) */ }
  }
}

/** Every intro save on this computer, newest first. */
export function listIntroSaves() {
  if (!existsSync(INTRO_DIR)) return [];
  recoverAside();
  return readdirSync(INTRO_DIR).filter((d) => ID.test(d)).map(readMeta).filter(Boolean)
    .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}

/** The intro save kept for `key`, or null. */
export function introFor(key) {
  if (!key) return null;
  if (!existsSync(join(INTRO_DIR, idOf(key)))) recoverAside();
  return readMeta(idOf(key));
}

/** For the page: what it shows of an intro save (the Pokémon keys stay on this computer's server). */
export function publicIntro(meta) {
  if (!meta) return null;
  const { keys, ...rest } = meta; // eslint-disable-line no-unused-vars
  return rest;
}

/** The 3DS save folder of a run's player. */
const ctrSaveRoot = (runId, slot) => join(saveDirFor(`run-${runId}-${slot}`), ...CTR_ROOT);

/**
 * The game's own save folders under a 3DS SD card root: "<id0>/<id1>/title/00040000/<title>/data" (relative paths).
 * `titles`: the game's title ids (catalog) – only those; none known: every game's.
 */
function ctrDataDirs(root, titles = null) {
  const out = [];
  const ls = (p) => {
    try {
      return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
  };
  const want = titles?.length ? new Set(titles.map((t) => String(t).slice(-8).toLowerCase())) : null;
  for (const a of ls(root)) {
    for (const b of ls(join(root, a))) {
      for (const low of ls(join(root, a, b, 'title', '00040000'))) {
        if (want && !want.has(low.toLowerCase())) continue;
        const rel = join(a, b, 'title', '00040000', low, 'data');
        if (existsSync(join(root, rel, '00000001', 'main'))) out.push(rel);
      }
    }
  }
  return out;
}

const ctrTitles = (m) => (catalog().games || []).find((g) => g.id === m?.game?.id)?.titleIds || null;

/**
 * Keep the battery save of `slot` in run `m` as the intro save of its game (replacing the one kept before).
 * savePath(manifest, slot): where that player's battery save is (server/app.mjs defaultSavePath).
 * → the kept save's details: { id, key, system, gen, party, species, savedAt, … }. Throws (with a code) when the
 * game has none, there is no save yet or the file holds no save.
 */
export function keepIntroSave(m, slot, { savePath }) {
  const key = introKeyFor(m);
  if (!key) throw httpError(409, 'Intro saves don’t work for this game', 'introUnsupported');
  const ctr = m.game.system === '3ds';
  let info;
  let ctrDirs = null;
  let saveFile = null;
  if (ctr) {
    const root = ctrSaveRoot(m.id, slot);
    ctrDirs = ctrDataDirs(root, ctrTitles(m));
    if (!ctrDirs.length) throw httpError(404, 'No save file yet', 'noSaveYet');
    info = inspectSave(readFileSync(join(root, ctrDirs[0], '00000001', 'main')), '3ds');
  } else {
    saveFile = savePath(m, slot);
    if (!saveFile || !existsSync(saveFile)) throw httpError(404, 'No save file yet', 'noSaveYet');
    info = inspectSave(readFileSync(saveFile), m.game.system, speciesTables());
  }
  if (info.state === 'empty') throw httpError(409, 'There is no game save in this file yet – save in the game first', 'introEmpty');
  const id = idOf(key);
  const meta = {
    id, key, system: m.game.system, gen: info.gen || null,
    gameId: m.game.id || null, hackId: m.game.hackId || m.patch?.hackId || null, hackName: m.game.hackName || m.patch?.name || null,
    title: m.game.title || null,
    savedAt: new Date().toISOString(),
    // the team in it: null when the layout isn't known (the save is kept all the same)
    party: info.state === 'ok' ? info.party : null,
    species: info.state === 'ok' ? info.mons.map((x) => x.species || null) : [],
    keys: info.state === 'ok' ? info.mons.map((x) => x.key) : [],
    from: { run: m.id, name: m.name || null },
  };
  // written next to the old one, then swapped in: a failed copy leaves the old intro save as it was
  mkdirSync(INTRO_DIR, { recursive: true });
  const tmp = join(INTRO_DIR, `.new-${id}-${randomBytes(4).toString('hex')}`);
  try {
    mkdirSync(tmp);
    if (ctr) {
      const root = ctrSaveRoot(m.id, slot);
      for (const rel of ctrDirs) cpSync(join(root, rel), join(tmp, CTR, rel), { recursive: true });
    } else {
      writeFileAtomic(join(tmp, SAVE), readFileSync(saveFile));
    }
    writeFileAtomic(join(tmp, 'meta.json'), JSON.stringify(meta, null, 2));
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  swapIn(tmp, id);
  return meta;
}

/** Forget an intro save (its id). → true when there was one. */
export function removeIntroSave(id) {
  if (!ID.test(String(id || ''))) throw httpError(400, 'Invalid intro save', 'badRequest');
  const dir = join(INTRO_DIR, id);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * Start `slot` of the freshly built run `runId` from the intro save of its game: its battery save (or 3DS save folder)
 * becomes that player's save. Only where the player has no save yet – a rebuild never replaces one. Notes what it did
 * in run.json (`intro[slot]`: when the intro save was made, its team and the keys of its Pokémon – the page leaves
 * those out of the tracking; run.json stays on this computer, the run pack never carries it).
 * → the updated manifest, or null when nothing was applied.
 */
export function applyIntroSave(runId, slot, { savePath }) {
  const m = readManifest(runId);
  // (Play together plays the library game's own save – shared/playtogether.mjs: never replaced by an intro save)
  if (!m?.outputs?.[slot] || m.mode === 'together') return null;
  const meta = introFor(introKeyFor(m));
  if (!meta) return null;
  const dir = join(INTRO_DIR, meta.id);
  if (m.game.system === '3ds') {
    const root = ctrSaveRoot(m.id, slot);
    const src = join(dir, CTR);
    const rels = ctrDataDirs(src);
    if (!rels.length || ctrDataDirs(root).length) return null;
    for (const rel of rels) cpSync(join(src, rel), join(root, rel), { recursive: true });
  } else {
    const dest = savePath(m, slot);
    const from = join(dir, SAVE);
    if (!dest || existsSync(dest) || !existsSync(from)) return null;
    writeFileAtomic(dest, readFileSync(from));
  }
  m.intro = { ...(m.intro && typeof m.intro === 'object' ? m.intro : {}), [slot]: { savedAt: meta.savedAt, party: meta.party, keys: meta.keys || [] } };
  writeManifest(m);
  return m;
}

/**
 * For the board's Files menu: can `slot`'s save in run `m` become the intro save, and which one is kept for the game.
 * → { supported, hasSave, intro: (the kept one, without keys) | null }
 */
export function introState(m, slot, { savePath }) {
  const key = introKeyFor(m);
  if (!key) return { supported: false, hasSave: false, intro: null };
  let hasSave = false;
  if (m.game.system === '3ds') hasSave = ctrDataDirs(ctrSaveRoot(m.id, slot), ctrTitles(m)).length > 0;
  else {
    const p = savePath(m, slot);
    try {
      hasSave = !!p && statSync(p).size > 0;
    } catch {
      hasSave = false;
    }
  }
  return { supported: true, hasSave, intro: publicIntro(introFor(key)) };
}
