// Which file on this computer plays each seat of a link session (docs/MULTIPLAYER.md › "Saves, ROMs and the tracker").
// ROMs never travel: every seat's game must be here, byte-identical (SHA-1) to the one that seat's player plays.
//   1. the run's own build for that slot (randomized / patched runs build every player's game from the same seed),
//   2. any other build of the run with that SHA-1 (a plain run where both play the same file: my own copy),
//   3. a file the player picked for it earlier ("Pick your copy of FireRed", remembered per SHA-1 in the run folder),
//   4. a library ROM with the partner's CRC32 (plain runs only – the CRC comes with the partner's SHA-1), confirmed by
//      its SHA-1; one inside a zip is unpacked into the run folder first.
// Nothing here trusts a path from a page: the server resolves every seat itself and only by SHA-1.
import { existsSync, statSync, readFileSync, mkdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { needsIdenticalRom, baseRomsFor } from '../../shared/restart.mjs';
import { writeFileAtomic } from './fsutil.mjs';

const PICKS = 'link-roms.json';
const shaCache = new Map();

/** SHA-1 of a file (hex), cached by path + size + mtime – a DS game is hundreds of MB. null when it's not there. */
export function sha1OfFile(p, { fs = { existsSync, statSync, readFileSync } } = {}) {
  if (!p || !fs.existsSync(p)) return null;
  const st = fs.statSync(p);
  const k = `${p}\0${st.size}\0${st.mtimeMs}`;
  if (!shaCache.has(k)) {
    if (shaCache.size > 200) shaCache.delete(shaCache.keys().next().value);
    shaCache.set(k, createHash('sha1').update(fs.readFileSync(p)).digest('hex'));
  }
  return shaCache.get(k);
}

/** A run build's SHA-1 as the build recorded it (no hashing a DS game of hundreds of MB while a game streams), else
 *  hashed. */
function buildSha1(manifest, slot, path, opts) {
  const rec = manifest?.outputs?.[slot]?.sha1;
  if (okSha(rec) && path && (opts.fs?.existsSync || existsSync)(path)) return rec.toLowerCase();
  return sha1OfFile(path, opts);
}

/**
 * What this computer says about its own seat `slot`: the file, its SHA-1 and – for a plain run, where the file is the
 * library ROM as it is – its CRC32 (lets partners find their copy of it in their library without hashing everything).
 */
export function ownSeat(manifest, slot, runFile, opts = {}) {
  const name = manifest?.outputs?.[slot]?.rom;
  const path = typeof name === 'string' ? runFile(manifest.id, name) : null;
  const sha1 = path ? buildSha1(manifest, slot, path, opts) : null;
  if (!sha1) return { path: null, sha1: null, crc: null };
  const crc = !needsIdenticalRom(manifest) && manifest.base?.crc ? String(manifest.base.crc).toUpperCase() : null;
  return { path, sha1, crc };
}

/** The files picked for partners' games in this run: { sha1: { path } }. */
export function loadPicks(dir, { fs = { readFileSync } } = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(join(dir, PICKS), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}
export function savePick(dir, sha1, path) {
  const picks = loadPicks(dir);
  picks[sha1] = { path, at: new Date().toISOString() };
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(join(dir, PICKS), JSON.stringify(picks, null, 2));
}

const okSha = (s) => typeof s === 'string' && /^[0-9a-f]{40}$/i.test(s);

/**
 * The file for seat `slot` whose SHA-1 is `sha1`, or null. `deps`: { runFile(runId, name), dir (the run folder),
 * libraryRoms: [{ id, file, container, crc, system }], extract(rom) → path (a zipped ROM unpacked), fs }.
 * Returns { path, how: 'build' | 'same' | 'picked' | 'library' }.
 */
export function resolveSeat(manifest, slot, sha1, crc, deps) {
  if (!okSha(sha1)) return null;
  const want = sha1.toLowerCase();
  const { runFile, dir, libraryRoms = [], extract = null } = deps;
  const opts = deps.fs ? { fs: deps.fs } : {};
  const outs = manifest?.outputs || {};
  const own = outs[slot]?.rom ? runFile(manifest.id, outs[slot].rom) : null;
  if (own && buildSha1(manifest, slot, own, opts) === want) return { path: own, how: 'build' };
  for (const [s, o] of Object.entries(outs)) {
    if (s === slot || typeof o?.rom !== 'string') continue;
    const p = runFile(manifest.id, o.rom);
    if (p && buildSha1(manifest, s, p, opts) === want) return { path: p, how: 'same' };
  }
  const pick = dir ? loadPicks(dir, opts)[want] : null;
  if (pick?.path && sha1OfFile(pick.path, opts) === want) return { path: pick.path, how: 'picked' };
  const c = typeof crc === 'string' && /^[0-9a-f]{8}$/i.test(crc) ? crc.toUpperCase() : null;
  if (c) {
    for (const r of libraryRoms) {
      if (String(r.crc || '').toUpperCase() !== c) continue;
      const p = r.container ? (extract ? extract(r) : null) : r.file;
      if (p && sha1OfFile(p, opts) === want) {
        if (dir) savePick(dir, want, p);
        return { path: p, how: 'library' };
      }
    }
  }
  return null;
}

/**
 * A library ROM the player picked for a partner's seat: its file (a zipped one unpacked into the run folder) when its
 * SHA-1 is the partner's, else null. Remembered for the next sessions.
 */
export function pickSeat(rom, sha1, { dir, extract, fs } = {}) {
  if (!rom || !okSha(sha1)) return null;
  const p = rom.container ? extract?.(rom) : rom.file;
  if (!p || sha1OfFile(p, fs ? { fs } : {}) !== sha1.toLowerCase()) return null;
  if (dir) savePick(dir, sha1.toLowerCase(), p);
  return p;
}

/** Where a zipped library ROM is unpacked for a link session: in the run folder, named after its file inside the zip and
 *  its CRC32 (two zips with a same-named entry of different games don't share one file). */
export function extractTarget(dir, rom) {
  const ext = extname(rom.entry || rom.name || '') || `.${rom.system || 'rom'}`;
  const safe = basename(String(rom.entry || rom.name || 'game')).replace(/[^\w.-]+/g, '_').slice(0, 60);
  const crc = /^[0-9a-f]{8}$/i.test(String(rom.crc || '')) ? `-${String(rom.crc).toUpperCase()}` : '';
  return join(dir, `link-${safe.replace(/\.[^.]+$/, '')}${crc}${ext}`);
}

/**
 * The build request that makes partner `slot`'s game on this computer (a randomized or patched run joined before
 * every player's game was built here): the run's own settings and seeds, only that slot. Throws (.code) when the base
 * ROM or the patch isn't in the library.
 */
export function partnerBuildRequest(manifest, slot, { roms = [], patches = [] } = {}) {
  const fits = baseRomsFor(manifest, roms);
  const rom = fits.find((r) => manifest.game?.id && r.gameId === manifest.game.id) || fits[0];
  if (!rom) throw Object.assign(new Error('The game of this run is not in your library'), { code: 'no-rom' });
  let patch = null;
  if (manifest.patch) {
    patch = patches.find((p) => manifest.patch.sha1 && p.sha1 === manifest.patch.sha1)
      || patches.find((p) => manifest.patch.hackId && p.hackId === manifest.patch.hackId && !manifest.patch.sha1);
    if (!patch) throw Object.assign(new Error('The ROM hack of this run is not in your library'), { code: 'no-patch' });
  }
  const r = manifest.randomizer || {};
  return {
    runId: manifest.id, romId: rom.id, patchId: patch?.id || null, values: r.values || {}, randomize: r.enabled !== false,
    seeds: r.seeds || {}, sharedSeed: !!r.sharedSeed, players: manifest.players, name: manifest.name, mode: manifest.mode,
    buildFor: [slot], expectedOutputs: manifest.expectedOutputs || null, gameId: manifest.game?.id || null,
    hackId: manifest.game?.hackId || null, hackName: manifest.game?.hackName || undefined,
  };
}
