// What the play view needs from the ROM itself, computed here from the file instead of in the page (a DS ROM is
// 64–512 MB, and the page already holds one copy for the emulator): the "where am I" sign's place names and map →
// location step (shared/live/romloc.mjs), for GBA games which Pokémon the species numbers stand for
// (shared/live/romspecies.mjs) and for Game Boy hacks where their RAM variables moved (shared/live/romwram.mjs), its
// types and level caps (romtypes.mjs, romcaps.mjs). Computed in a worker thread (romdata-worker.mjs, romDataFor) – the
// result is small and cached per file (path, size, time) in CACHE_DIR/romloc.
// `vanilla` says whether the file is an unmodified retail ROM (its CRC32 is in the catalog): a randomized game, a
// ROM hack or anything else changed shows the ROM's own place names (shared/live/location.mjs placeName).
import { readFileSync, statSync, existsSync, mkdirSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import zlib from 'node:zlib';
import { romLocations, gen3MapTable, gen3MapHeaders, gen3RamMoved, gbMapHeaders } from '../../shared/live/romloc.mjs';
import { romSpecies, gen3Forms, gen3ItemNames, gen3MoveNames, gen3MoveMap } from '../../shared/live/romspecies.mjs';
import { romTypes } from '../../shared/live/romtypes.mjs';
import { romCaps } from '../../shared/live/romcaps.mjs';
import { gbWramShift } from '../../shared/live/romwram.mjs';
import { findEntry } from '../../shared/live/parse.mjs';
import { identifyRom } from '../../shared/romid.mjs';
import { isQuetzal } from '../../shared/live/quetzal.mjs';
import { crc32 } from '../../shared/checksum.mjs';
import { resolveId } from './library.mjs';
import { isCtrExt } from '../../shared/romid.mjs';
import { identifyCtr } from '../../shared/ctr.mjs';
import { ctrZonePlaces } from '../../shared/live/ctrzones.mjs';
import { musicIndex } from '../../shared/ctr/musicindex.mjs';

const VERSION = 25; // bump when romData() / ctrData() change what they find or the shape of the result (13: types and level caps from the ROM, 14: 3DS zone tables, 15: their header, 16: Gen 3 hacks with moved RAM, badge flags by the leaders' order, 17: Black/White zone headers, 18: catch rates with the types, the Game Boy enemy's status / catch rate / battle type moved with a hack's RAM, 19: the Game Boy map headers, Gen 3 map headers, Black 2/White 2 zone headers – the place sign checks the game's copy of the current map's header against them, 20: Yellow's map headers (249 maps) and its memory table entry found from its ROM header, 21: Gen 5 forms' types, 22: a 3DS game's music streams – shared/ctr/musicindex.mjs, 23: GBA species' abilities and the ability names – romtypes.mjs gbaAbilities, 24: an expanded GBA engine's species after a gap of left-out ones and its Megas / Primal forms – romspecies.mjs gen3Forms, 25: Pokémon Quetzal – its own party struct (`layout3`), place names, item names and one species table, not two)
const memo = new Map(); // ROM id → { result, failedAt? }
/** A scan that failed is tried again after this long (a file a scanner held, a drive that slept). */
const RETRY_FAILED_MS = (process.env.NODE_TEST_CONTEXT && Number(process.env.SLS_ROMDATA_RETRY_MS)) || 30000;
let tables = null;

function opts(sharedDir) {
  if (!tables) {
    const j = (f) => JSON.parse(readFileSync(join(sharedDir, 'data', f), 'utf8'));
    const retail = new Set();
    for (const g of j('catalog.json').games || []) for (const c of g.crc32 || []) retail.add(String(c).toUpperCase());
    const gen3Index = [];
    for (const [k, v] of Object.entries(j('gen3_index_to_dex.json').map || {})) gen3Index[Number(k)] = v;
    const api = j('pokeapi.json');
    // the app's own types of a Pokémon in a generation (web/lib/data.mjs baseTypes)
    const baseTypes = (id, gen) => {
      const past = api.typesGen?.[id];
      const k = past ? Object.keys(past).map(Number).sort((a, b) => a - b).find((x) => x >= gen) : undefined;
      return k !== undefined ? past[k] : api.types?.[id] || [];
    };
    tables = { gen3Charset: j('charset_gen3.json'), gen4Chars: j('gen4.json').chars, retail, gen3Index, dexNames: api.names?.en || [], dexNamesOther: ['de', 'fr', 'es', 'it'].map((l) => api.names?.[l]).filter(Boolean), addresses: j('addresses.json'), maps: j('maps.json'), baseTypes, moveNames: ['en', 'de', 'fr', 'es', 'it'].map((l) => api.moves?.[l]).filter(Boolean), abilityNames: ['en', 'de', 'fr', 'es', 'it'].map((l) => api.abilities?.[l]).filter(Boolean) };
  }
  return tables;
}

/** CRC32 of a ROM as hex (zlib's native one where Node has it – a DS ROM is up to 512 MB). */
export function romCrc(bytes) {
  const v = typeof zlib.crc32 === 'function' ? zlib.crc32(bytes) : crc32(bytes);
  return (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

/** All results for a ROM's bytes: { data (locations or null), species, wram, gbMaps, types, caps, capsWhy, items, moves, vanilla }. */
export function romData(u8, sharedDir) {
  const o = opts(sharedDir);
  let vanilla = false;
  try {
    vanilla = o.retail.has(romCrc(u8));
  } catch {
    // no checksum: treated as modified
  }
  const data = romLocations(u8, o);
  if (data) data.vanilla = vanilla;
  const species = romSpecies(u8, o);
  // an expanded GBA engine moved gMapHeader: the place comes from SaveBlock1's map and the ROM's map table instead.
  // So did a decomp hack that kept the retail species but added variables of its own (its code never names the base
  // game's gPlayerParty): its team is searched for like an expanded engine's (`moved`, web/views/play.mjs)
  if (data && species?.engine === 'expanded') data.maps3 = gen3MapTable(u8);
  else if (data && species && !vanilla) {
    const h = identifyRom(u8.subarray(0, 0x200));
    const entry = h?.system === 'gba' ? findEntry(o.addresses, { platform: 'gba', code: h.code, title: h.title }) : null;
    if (entry?.gen === 3 && gen3RamMoved(u8, entry)) data.maps3 = { ...gen3MapTable(u8), moved: true };
  }
  // a retail engine's gMapHeader is checked against the ROM's own map headers (shared/live/location.mjs readGen3)
  if (data?.gen === 3 && !data.maps3) data.headers3 = gen3MapHeaders(u8);
  // an expanded engine numbers its items and moves its own way (Complete FireRed Upgrade: Unbound, Radical Red): the
  // game's item names (held items by name) and its moves in the app's numbering (the battle helper's moves)
  const own = species?.engine === 'expanded' ? ownTables3(u8, o) : { items: null, moves: null };
  // the game's types – names, each Pokémon's, the chart, the moves' (shared/live/romtypes.mjs): any ROM, so a hack that
  // changed them shows what it uses; a retail ROM reads as the app's own data
  const types = romTypes(u8, { gen3Charset: o.gen3Charset, speciesMap: species?.map ? species : null, vanillaIndex: o.gen3Index, baseTypes: o.baseTypes, moveMap: own.moves?.map || null, abilityNames: o.abilityNames });
  // an expanded engine's alternate forms are species of their own, mapped to their species by name: which of them are
  // Megas and Primal forms (shown as such – the rules go by the species) comes from the base stats romTypes found
  if (species?.engine === 'expanded') {
    const forms = gen3Forms(u8, species, types?.source?.baseStats != null ? { offset: types.source.baseStats, stride: types.source.stride } : null);
    if (forms) species.forms = forms;
  }
  // level caps from the game's trainers (shared/live/romcaps.mjs) – only a clean result; `capsWhy` says why not
  const c = romCaps(u8, { gen3Charset: o.gen3Charset, gen4Chars: o.gen4Chars });
  const caps = c.caps ? { caps: c.caps, leaders: c.leaders, final: c.final, badgeFlags: c.badgeFlags ?? null } : null;
  // the header (system, game code, title): which memory table entry reads it (shared/live/features.mjs)
  const h = identifyRom(u8.subarray(0, 0x200));
  const header = h?.system ? { system: h.system, code: h.code || '', title: h.title || '' } : null;
  // an engine whose party struct isn't the base game's (Pokémon Quetzal: 104 bytes – shared/live/quetzal.mjs): the live
  // readers convert it (parse.mjs LiveTables.withRom)
  const layout3 = isQuetzal(header) ? 'quetzal' : null;
  return { data, species, wram: vanilla ? null : gbShift(u8, o), gbMaps: gbMaps(u8, o), types, caps, capsWhy: caps ? null : c.why || null, ...own, header, vanilla, layout3 };
}

/**
 * Game Boy games: the ROM's map headers, which the live reader finds the game's copy of the current map's header by
 * (shared/live/romloc.mjs gbMapHeaders, shared/live/location.mjs readGen1/readGen2) – in every language.
 */
function gbMaps(u8, o) {
  // (on its own: whatever goes wrong here costs the place sign its check, never the rest of the ROM's data)
  try {
    const h = identifyRom(u8.subarray(0, 0x200));
    if (!h || (h.system !== 'gb' && h.system !== 'gbc')) return null;
    const entry = findEntry(o.addresses, { platform: h.system, code: h.code, title: h.title });
    const m = entry ? o.maps.games?.[entry.id] : null;
    return m ? gbMapHeaders(u8, m.gen, o.maps.tables?.[`gen${m.gen}`]?.[m.table]) : null;
  } catch {
    return null;
  }
}

/**
 * An expanded GBA engine's item names ({ names }) and move numbers ({ map }) – the map only for an engine that sorts its
 * moves its own way (Complete FireRed Upgrade: hundreds of known moves elsewhere); pokeemerald-expansion keeps the
 * National order and its moves stay as they are.
 */
function ownTables3(u8, o) {
  const items = gen3ItemNames(u8, o.gen3Charset);
  const mn = gen3MoveNames(u8, o.gen3Charset, o.moveNames.map((l) => l[1]).filter(Boolean));
  const m = mn ? gen3MoveMap(mn.names, o.moveNames) : null;
  return { items: items ? { names: items.names } : null, moves: m && m.moved >= 10 ? { map: m.map } : null };
}

/** Game Boy hacks: where the code says the party, the battle and the map variables are (shared/live/romwram.mjs). */
function gbShift(u8, o) {
  const h = identifyRom(u8.subarray(0, 0x200));
  if (!h || (h.system !== 'gb' && h.system !== 'gbc')) return null;
  const entry = findEntry(o.addresses, { platform: h.system, code: h.code, title: h.title });
  return entry ? gbWramShift(u8, entry, o.maps.games?.[entry.id]) : null;
}

/**
 * The ROM's data by file path or (an unpacked archive entry) by its bytes plus a key: { data, species, wram, vanilla }
 * – `data` the location data (null when the ROM has none: another engine, an unsupported layout), `species` the GBA
 * species table (null for other systems), `wram` a Game Boy hack's moved variables (null: the retail addresses),
 * `types` the game's types (shared/live/romtypes.mjs), `caps` level caps from its trainers (shared/live/romcaps.mjs).
 */
/**
 * A Nintendo 3DS game (1–4 GB – read a few KB at a time, never whole): the zone → place table of its RomFS
 * (shared/live/ctrzones.mjs) for the place sign: { gen, ctr: { family, places } }. Run in the worker like romData.
 */
export function ctrData(file) {
  let fd;
  let ioError = null;
  try {
    // (a file that's there but can't be opened – EBUSY, EPERM – throws: a failed scan isn't remembered on disk, see
    // romDataFor; no file at all is simply no data)
    try {
      fd = openSync(file, 'r');
    } catch (e) {
      if (e.code === 'ENOENT') return { ...ROMDATA_NONE };
      throw e;
    }
    const readAt = (o, n) => {
      const b = Buffer.alloc(n);
      try {
        return new Uint8Array(b.buffer, b.byteOffset, readSync(fd, b, 0, n, o));
      } catch (e) {
        ioError = e;
        throw e;
      }
    };
    const info = identifyCtr(readAt, extname(file).slice(1));
    const z = info ? ctrZonePlaces(readAt, info) : null;
    // its music streams and their loops, for "music from the ROM" (web/lib/rommusic.mjs) – a few KB of each RomFS file
    const music = info && !info.encrypted ? musicIndex(readAt) : null;
    // identifyCtr and ctrZonePlaces never throw – a read that failed on the way (a virus scanner or backup holding the
    // 3 GB file for a moment, a drive that went to sleep) read as "no zone table" and was cached on disk for good: the
    // place sign was gone in every later session of that game. It throws instead, so the next request reads again.
    if (ioError) throw ioError;
    // the header: which memory table entry reads it (shared/live/features.mjs) – the game code, else the title ID
    const header = info ? { system: '3ds', code: info.code || '', title: '', titleId: info.titleId || null } : null;
    return { ...ROMDATA_NONE, data: z ? { gen: z.gen, ctr: { family: z.family, places: z.places } } : null, header, music };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A path the worker reads in parts (a 3DS game) instead of whole. */
export const isCtrFile = (file) => Boolean(file) && isCtrExt(extname(file).slice(1));

/** What romDataFor finds when there's nothing to find – also the list of fields the disk cache must give back. */
export const ROMDATA_NONE = Object.freeze({ data: null, species: null, wram: null, gbMaps: null, types: null, caps: null, capsWhy: null, items: null, moves: null, header: null, vanilla: null, music: null, layout3: null });
/** A disk-cache entry back into romDataFor's result (every field of ROMDATA_NONE – a missing one would be lost on the
 * next start, as the own types of Too Many Types were). */
export const fromRomCache = (v) => Object.fromEntries(Object.keys(ROMDATA_NONE).map((k) => [k, v[k] ?? null]));

// ---- computed in a worker thread (server/lib/romdata-worker.mjs): a big ROM takes seconds – the server, which shares
// its thread with the app in Electron, keeps answering every other request meanwhile. One ROM at a time; a scan that
// fails or takes too long gives "unknown" (ROMDATA_NONE) – remembered in memory until the file changes, never on disk.
// (SLS_ROMDATA_TIMEOUT_MS only under node --test)
const TIMEOUT_MS = (process.env.NODE_TEST_CONTEXT && Number(process.env.SLS_ROMDATA_TIMEOUT_MS)) || 180000;
let worker = null;
let seq = 0;
const jobs = new Map(); // job id → { w (its worker), resolve, reject, timer }
const pending = new Map(); // ROM id → its promise (two requests for one ROM share a scan)
let chain = Promise.resolve();

/** The jobs of worker `w` fail (it ended): a newer worker's jobs go on. */
function failAll(w, err) {
  for (const [id, j] of jobs) {
    if (j.w !== w) continue;
    clearTimeout(j.timer);
    jobs.delete(id);
    j.reject(err);
  }
}

function getWorker() {
  if (worker) return worker;
  // (a damaged ROM must not take the app down with it: the worker's heap is capped – the ROM's bytes sit outside it)
  const w = new Worker(new URL('./romdata-worker.mjs', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 1024, maxYoungGenerationSizeMb: 64 } });
  w.on('message', ({ id, result, error }) => {
    const j = jobs.get(id);
    if (!j) return;
    jobs.delete(id);
    clearTimeout(j.timer);
    if (error) j.reject(new Error(error));
    else j.resolve(result);
  });
  const gone = (err) => {
    if (worker === w) worker = null;
    failAll(w, err);
  };
  w.on('error', gone);
  w.on('exit', (code) => gone(new Error(`ROM data worker ended (${code})`)));
  w.unref(); // (after the listeners: an idle worker never keeps the app or a test from ending)
  return (worker = w);
}

/** One job in the worker, after the ones before it; rejects on an error or after `timeoutMs` (the worker is ended). */
function runJob(msg, timeoutMs) {
  const run = () => new Promise((resolve, reject) => {
    const w = getWorker();
    const id = ++seq;
    const timer = setTimeout(() => {
      jobs.delete(id);
      reject(new Error('ROM data took too long'));
      if (worker === w) worker = null;
      w.terminate().catch(() => {});
    }, timeoutMs);
    jobs.set(id, { w, resolve, reject, timer });
    try {
      w.postMessage({ ...msg, id }, msg.bytes ? [msg.bytes] : []);
    } catch (e) {
      clearTimeout(timer);
      jobs.delete(id);
      reject(e);
    }
  });
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

/**
 * The ROM's data (see romData) for `src` – { file } (a path), { lib: { id, config } } (a library entry, maybe inside a
 * .zip: read in the worker), { patched: { romId, patchId, config } } (patched in the worker) or { bytes, key } – with the memory and disk cache in front (CACHE_DIR/romloc, per file:
 * path, size, time). Resolves to ROMDATA_NONE's shape, never rejects; `env.timeoutMs` overrides the time limit.
 */
export async function romDataFor(src, { sharedDir, cacheDir, timeoutMs = TIMEOUT_MS }) {
  const none = { ...ROMDATA_NONE };
  let id;
  let msg;
  try {
    if (src.file) {
      const st = statSync(src.file);
      id = `${src.file}|${st.size}|${st.mtimeMs}`;
      msg = { file: src.file };
    } else if (src.lib) {
      const { abs, entry } = resolveId(src.lib.id, src.lib.config);
      // a 3DS game still inside its zip (1–4 GB): never inflated into memory to be read – it is played unpacked
      if (entry && isCtrFile(entry)) return none;
      const st = statSync(abs);
      id = `${abs}::${entry || ''}|${st.size}|${st.mtimeMs}`;
      msg = { lib: { id: src.lib.id, config: src.lib.config } };
    } else if (src.patched) {
      // a library ROM with a patch: patched (or taken from the patched-ROM cache) in the worker as well
      const { romId, patchId, config } = src.patched;
      const a = resolveId(romId, config);
      const b = resolveId(patchId, config);
      const sa = statSync(a.abs);
      const sb = statSync(b.abs);
      id = `patched|${a.abs}::${a.entry || ''}|${sa.size}|${sa.mtimeMs}|${b.abs}::${b.entry || ''}|${sb.size}|${sb.mtimeMs}`;
      msg = { patched: { romId, patchId, config } };
    } else if (src.bytes) {
      id = `bytes|${src.key}|${src.bytes.length}`;
      const copy = new Uint8Array(src.bytes); // (handed over to the worker)
      msg = { bytes: copy.buffer };
    } else return none;
  } catch {
    return none;
  }
  const known = memo.get(id);
  if (known && !(known.failedAt && Date.now() - known.failedAt > RETRY_FAILED_MS)) return known.result;
  const hash = createHash('sha1').update(`${VERSION}|${id}`).digest('hex');
  const cached = cacheDir && join(cacheDir, 'romloc', `${hash}.json`);
  if (cached && existsSync(cached)) {
    try {
      const v = JSON.parse(readFileSync(cached, 'utf8'));
      if (v.version === VERSION) {
        const r = fromRomCache(v);
        memo.set(id, { result: r });
        return r;
      }
    } catch {
      // unreadable cache: compute again
    }
  }
  if (pending.has(id)) return pending.get(id);
  const p = runJob({ ...msg, sharedDir }, timeoutMs).then((result) => {
    const r = fromRomCache(result || {});
    memo.set(id, { result: r });
    if (cached) {
      try {
        mkdirSync(join(cacheDir, 'romloc'), { recursive: true });
        writeFileSync(cached, JSON.stringify({ version: VERSION, ...r }));
      } catch {
        // a read-only cache folder only costs the next start a second parse
      }
    }
    return r;
  }, () => {
    // (remembered in memory only, and only for a while: the same damaged file isn't scanned again on every click – a
    // file that couldn't be read for a moment is read again later – and nothing about it lands in the disk cache)
    memo.set(id, { result: none, failedAt: Date.now() });
    return none;
  }).finally(() => pending.delete(id));
  pending.set(id, p);
  return p;
}
