// Verifying and patching base ROMs (cached on disk by patch hash + base CRC).
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { CACHE_DIR } from './paths.mjs';
import { loadFile, resolveId, ctrInfo } from './library.mjs';
import { crc32Hex } from '../../shared/checksum.mjs';
import { applyPatch, detectPatchFormat } from '../../shared/patchers.mjs';
import { identifyRom, isCtrExt } from '../../shared/romid.mjs';
import { writeFileAtomic, httpError, logLine } from './fsutil.mjs';

/** Known patches, keyed by SHA-1 of the patch file (exact expected results). */
export const KNOWN_PATCHES = {
  '80fa3c0b16a72240e55eeeac9a017000275d36ae': {
    name: 'Pokémon Definitive HeartGold',
    author: 'BigNation',
    hackId: 'definitive-heartgold',
    baseCrc: 'C180A0E9',
    resultCrc: '6AD2AB08',
  },
};

const sha1 = (buf) => createHash('sha1').update(buf).digest('hex');

/** File name of a library id ("dir/file.bps" or "dir/archive.zip::inner/file.bps"). */
const fileNameOf = (id) => String(id).split('::').pop().split(/[\\/]/).pop();

function extFor(id, rom) {
  const fromName = extname(String(id).split('::').pop()).slice(1).toLowerCase();
  if (['gb', 'gbc', 'gba', 'nds'].includes(fromName)) return fromName;
  // a Super Game Boy dump (.sgb) is a Game Boy ROM: cached and built as .gb (.gbc for a Color game) – the emulators,
  // the randomizer and the run's file names know those
  if (fromName === 'sgb') return identifyRom(rom.subarray(0, 0x200), 'gb')?.system || 'gb';
  return identifyRom(rom.subarray(0, 0x200))?.system || 'bin';
}

/**
 * Produce the (optionally patched) base ROM as a file on disk.
 * Returns { path, crc, sha1, size, baseCrc, header, fromCache, patchName, system }.
 */
export function preparePatchedRom(romId, patchId, onLog = () => {}, config = {}) {
  const idExt = extname(String(romId).split('::').pop()).slice(1).toLowerCase();
  if (isCtrExt(idExt)) return prepareCtr(romId, patchId, onLog, config, idExt);
  const rom = loadFile(romId, config);
  const baseCrc = crc32Hex(rom);
  const ext = extFor(romId, rom);
  const header = identifyRom(rom.subarray(0, 0x200), ext);
  const mb = (rom.length / 1048576).toFixed(1);
  onLog(logLine('romLoaded', `Base ROM loaded (${mb} MB, CRC32 ${baseCrc})`, { mb, crc: baseCrc }));
  mkdirSync(CACHE_DIR, { recursive: true });
  if (!patchId) {
    const path = join(CACHE_DIR, `vanilla-${baseCrc}.${ext}`);
    // atomic: a half-written cache file would otherwise be reused for every later build
    if (!existsSync(path)) writeFileAtomic(path, rom);
    return { path, crc: baseCrc, sha1: sha1(rom), size: rom.length, baseCrc, header, fromCache: false, patchName: null, system: header?.system || ext };
  }
  const patch = loadFile(patchId, config);
  const patchSha = sha1(patch);
  const known = KNOWN_PATCHES[patchSha];
  if (known && known.baseCrc !== baseCrc) {
    throw httpError(422, `Wrong base ROM: ${known.name} expects CRC32 ${known.baseCrc}, found ${baseCrc}.`, 'wrongBaseRom', { name: known.name, expected: known.baseCrc, found: baseCrc });
  }
  const path = join(CACHE_DIR, `patched-${patchSha.slice(0, 12)}-${baseCrc}.${ext}`);
  if (existsSync(path)) {
    const buf = readFileSync(path);
    const crc = crc32Hex(buf);
    if (!known || crc === known.resultCrc) {
      onLog(logLine('patchCached', `Patched ROM from the cache (CRC32 ${crc})`, { crc }));
      return { path, crc, sha1: sha1(buf), size: buf.length, baseCrc, header: identifyRom(new Uint8Array(buf.subarray(0, 0x200)), ext), fromCache: true, patchName: known?.name || fileNameOf(patchId), system: header?.system || ext, patchSha1: patchSha };
    }
  }
  const format = detectPatchFormat(patch);
  const patchMb = (patch.length / 1048576).toFixed(1);
  onLog(logLine('patchApplying', `Applying the patch (${format}, ${patchMb} MB) …`, { format, mb: patchMb }));
  const t = Date.now();
  let out;
  try {
    out = applyPatch(rom, patch);
  } catch (e) {
    // a patch for another copy of the game (or a damaged one) – an answer with a code, not a bare error 500 (#43: the
    // new-run assistant's check failed twice with nothing to say why)
    throw httpError(422, `The patch doesn't fit this ROM (${e.message})`, 'patchNoFit', { detail: String(e.message || '').slice(0, 200) });
  }
  const crc = crc32Hex(out);
  const s = ((Date.now() - t) / 1000).toFixed(1);
  onLog(logLine('patchApplied', `Patch applied in ${s} s – result CRC32 ${crc}`, { s, crc }));
  if (known && crc !== known.resultCrc) throw httpError(422, `Unexpected patch result (CRC32 ${crc}, expected ${known.resultCrc}).`, 'patchResult', { name: known.name, found: crc, expected: known.resultCrc });
  writeFileAtomic(path, out);
  return { path, crc, sha1: sha1(out), size: out.length, baseCrc, header: identifyRom(out.subarray(0, 0x200), ext), fromCache: false, patchName: known?.name || fileNameOf(patchId), system: header?.system || ext, patchSha1: patchSha };
}

export function fileSha1(path) {
  return sha1(readFileSync(path));
}

/**
 * A 3DS game is played from the library file itself: 1–4 GB, never read whole (no CRC32 / SHA-1, no patch, no
 * randomizer). Returns the same shape as preparePatchedRom with the checksums null and `ext` the file's own extension.
 */
function prepareCtr(romId, patchId, onLog, config, ext) {
  if (patchId) throw httpError(400, 'Nintendo 3DS games can’t be patched here', 'ctrNoPatch');
  const { abs, entry } = resolveId(romId, config);
  if (entry) throw httpError(400, 'Unpack the 3DS game from its archive into the library first', 'ctrInArchive');
  const header = ctrInfo(abs, ext);
  if (!header) throw httpError(400, 'Not a Nintendo 3DS game', 'notCtr');
  const size = statSync(abs).size;
  const code = header.productCode || header.titleId || '';
  const mb = (size / 1048576).toFixed(0);
  onLog(logLine('ctrGame', `3DS game ${code} (${mb} MB)`, { code, mb }));
  return { path: abs, crc: null, sha1: null, size, baseCrc: null, header, fromCache: false, patchName: null, system: '3ds', ext };
}
