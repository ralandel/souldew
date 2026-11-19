// 3DS game updates in souldew's own player. ctrhost points Azahar's core at one save folder per game / run player
// (server/lib/ctr.mjs saveDirFor → the core's user folder "<save>/Azahar", its SD card "<save>/Azahar/sdmc"), and the
// core starts a game with the update it finds installed on that SD card (shared/ctr/update.mjs). So before a game
// starts, souldew puts the update the library has for it into that save folder – the files Azahar's own "Install CIA"
// writes for a decrypted CIA – and takes away one it put there before when the library has none any more.
//
//   the cache   <data>/ctr/updates/<stamp>/sd/Nintendo 3DS/…/title/0004000e/<low>/content/{00000000.tmd, <id>.app}:
//               each update file unpacked once (its stamp: path, size, time); unpacked files of update files that are
//               gone from the library are deleted at the next start
//   a save      the cache's files hard-linked into "<save>/Azahar/sdmc/…" (copied where links don't work – another
//               drive, a file system without them), and souldew-update.json next to "content" says which update that is
//
// A randomized game never gets the update: UPR ZX rebuilds the game's code and RomFS from version 1.0, and the update's
// code (Azahar runs the code of an installed update, not the game file's) would undo the randomization. UPR could only
// write a randomized updated game as a LayeredFS folder (it refuses to write one .cxi with an update loaded).
import { openSync, readSync, closeSync, statSync, existsSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, linkSync, copyFileSync, renameSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DATA_DIR, DEV } from './paths.mjs';
import { freeBytes } from './zip.mjs';
import { updateLayout, updatePaths, updateStatus, gameTitleIdOf } from '../../shared/ctr/update.mjs';

export const UPDATE_CACHE = join(DATA_DIR, DEV ? 'runs/.ctr' : 'ctr', 'updates');
/** Next to an installed update's "content" folder: which update souldew installed there. */
export const MARKER = 'souldew-update.json';
const CHUNK = 4 * 1024 * 1024;
const SPACE_MARGIN = 256 * 1024 * 1024;

/** Where the update file stands, as a short name for its unpacked copy: path, size and time. */
export function updateStamp(path, st = statSync(path)) {
  return createHash('sha1').update(`${path}\0${st.size}\0${st.mtimeMs}`).digest('hex').slice(0, 16);
}

/** updateLayout over a file on disk (shared/ctr/update.mjs). Throws its coded errors; unreadable: code 'unreadable'. */
export function readUpdateLayout(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch (e) {
    throw Object.assign(new Error(`can't open the update (${e.code || e.message})`), { code: 'unreadable' });
  }
  try {
    const size = statSync(path).size;
    const readAt = (o, n) => {
      const b = Buffer.alloc(n);
      return new Uint8Array(b.buffer, b.byteOffset, readSync(fd, b, 0, n, o));
    };
    return updateLayout(readAt, extname(path).slice(1), size);
  } finally {
    closeSync(fd);
  }
}

/** Copy `size` bytes at `offset` of the open file `src` into a new file `dest` (streamed: an update is up to 1 GB). */
async function copyRange(src, offset, size, dest) {
  const out = await open(dest, 'w');
  try {
    const buf = Buffer.alloc(Math.min(CHUNK, Math.max(1, size)));
    let done = 0;
    while (done < size) {
      const n = Math.min(buf.length, size - done);
      const { bytesRead } = await src.read(buf, 0, n, offset + done);
      if (bytesRead !== n) throw Object.assign(new Error('the update file ends early'), { code: 'invalid' });
      await out.write(buf, 0, n);
      done += n;
    }
  } finally {
    await out.close();
  }
}

const unpacking = new Map(); // stamp → the running unpack (one at a time per update)

/**
 * The update file `path` unpacked into the cache (once – later calls find it there): { stamp, dir (its "sd" folder),
 * titleId, version, files: SD-relative paths }. Throws coded errors: 'encrypted', 'invalid', 'notUpdate', 'unreadable',
 * 'diskFull'.
 */
export function unpackUpdate(path, { cache = UPDATE_CACHE } = {}) {
  const stamp = updateStamp(path);
  if (!unpacking.has(stamp)) {
    const run = unpackNow(path, stamp, cache).finally(() => unpacking.delete(stamp));
    unpacking.set(stamp, run);
  }
  return unpacking.get(stamp);
}

async function unpackNow(path, stamp, cache) {
  const final = join(cache, stamp);
  const meta = readMeta(join(final, 'meta.json'));
  if (meta && meta.files.every((f) => existsSync(join(final, 'sd', ...f)))) return { stamp, dir: join(final, 'sd'), ...meta };
  const layout = readUpdateLayout(path);
  const total = layout.contents.reduce((s, c) => s + c.size, 0);
  mkdirSync(cache, { recursive: true });
  const free = freeBytes(cache);
  if (free !== null && free < total + SPACE_MARGIN) throw Object.assign(new Error('not enough free disk space for the update'), { code: 'diskFull' });
  // written into a hidden folder next to it, then renamed: a failed or interrupted unpack leaves no half update behind
  const tmp = join(cache, `.${stamp}-${randomBytes(4).toString('hex')}`);
  const { tmdDir, appDir } = updatePaths(layout.titleId, layout);
  const files = [[...tmdDir, '00000000.tmd'], ...layout.contents.map((c) => [...appDir, `${c.id}.app`])];
  try {
    mkdirSync(join(tmp, 'sd', ...appDir), { recursive: true });
    writeFileSync(join(tmp, 'sd', ...files[0]), layout.tmd);
    const src = await open(path, 'r');
    try {
      for (let i = 0; i < layout.contents.length; i++) await copyRange(src, layout.contents[i].offset, layout.contents[i].size, join(tmp, 'sd', ...files[i + 1]));
    } finally {
      await src.close();
    }
    const m = { titleId: layout.titleId, version: layout.version, files };
    writeFileSync(join(tmp, 'meta.json'), JSON.stringify(m));
    rmSync(final, { recursive: true, force: true });
    renameSync(tmp, final);
    return { stamp, dir: join(final, 'sd'), ...m };
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    if (e.code === 'ENOSPC') throw Object.assign(new Error('not enough free disk space for the update'), { code: 'diskFull' });
    throw e;
  }
}

function readMeta(file) {
  try {
    const m = JSON.parse(readFileSync(file, 'utf8'));
    return m && typeof m.titleId === 'string' && Array.isArray(m.files) ? m : null;
  } catch {
    return null;
  }
}

/** Unpacked updates whose file is no longer one of `keep` (stamps) – deleted (saves keep their linked copies). */
export function pruneUpdateCache(keep, { cache = UPDATE_CACHE } = {}) {
  let names = [];
  try {
    names = readdirSync(cache);
  } catch {
    return;
  }
  const want = new Set(keep);
  for (const n of names) {
    // (hidden folders: an unpack running right now, or one a crash left – the latter after a day)
    if (n.startsWith('.')) {
      try {
        if (Date.now() - statSync(join(cache, n)).mtimeMs < 24 * 3600 * 1000) continue;
      } catch {
        continue;
      }
    } else if (want.has(n) || unpacking.has(n)) continue;
    rmSync(join(cache, n), { recursive: true, force: true });
  }
}

/** The SD card of a 3DS save folder (the core's user folder is "<save>/Azahar"). */
export const sdOf = (saveDir) => join(saveDir, 'Azahar', 'sdmc');

/** What souldew installed in a save folder for the game `gameTid`: its marker ({ stamp, titleId, version }) or null. */
export function installedUpdate(saveDir, gameTid) {
  const tid = String(gameTid || '').toUpperCase();
  const utid = `0004000E${tid.slice(8)}`;
  if (!gameTitleIdOf(utid)) return null;
  return readMarker(join(sdOf(saveDir), ...updatePaths(utid).titleDir, MARKER));
}

function readMarker(file) {
  try {
    const m = JSON.parse(readFileSync(file, 'utf8'));
    return m && typeof m.stamp === 'string' ? m : null;
  } catch {
    return null;
  }
}

/**
 * Install an unpacked update (unpackUpdate) into a save folder: its files linked (or copied) onto the save folder's SD
 * card, replacing whatever update was there for that game (Azahar would pick the smallest .tmd of the folder – two
 * updates there would leave it to chance). Nothing happens when the same update is there already. → true when files
 * were written.
 */
export function installUpdate(saveDir, unpacked) {
  const sd = sdOf(saveDir);
  const { titleDir } = updatePaths(unpacked.titleId);
  const marker = join(sd, ...titleDir, MARKER);
  if (readMarker(marker)?.stamp === unpacked.stamp && unpacked.files.every((f) => existsSync(join(sd, ...f)))) return false;
  rmSync(join(sd, ...titleDir), { recursive: true, force: true });
  for (const f of unpacked.files) {
    const to = join(sd, ...f);
    mkdirSync(join(to, '..'), { recursive: true });
    try {
      linkSync(join(unpacked.dir, ...f), to);
    } catch {
      copyFileSync(join(unpacked.dir, ...f), to);
    }
  }
  writeFileSync(marker, JSON.stringify({ stamp: unpacked.stamp, titleId: unpacked.titleId, version: unpacked.version }));
  return true;
}

/**
 * Take away the update souldew installed in a save folder for the game `gameTid` (only one it installed itself – the
 * marker says so). → true when one was removed.
 */
export function removeInstalledUpdate(saveDir, gameTid) {
  if (!installedUpdate(saveDir, gameTid)) return false;
  const utid = `0004000E${String(gameTid).toUpperCase().slice(8)}`;
  rmSync(join(sdOf(saveDir), ...updatePaths(utid).titleDir), { recursive: true, force: true });
  return true;
}

/**
 * Before a 3DS game starts in souldew's player: the update it plays with. `gameTid`: the game file's title ID (only
 * a game's – 00040000…); `update`: the library's update for it (shared/ctr/update.mjs pickUpdate – a library entry
 * with { file, version, encrypted }) or null; `randomized`: a randomized run's game. Installs / removes the update in
 * `saveDir` and → what the player view and the diagnostics show: null (no update), or { titleId, version, versionText,
 * gameVersion, latest, tracking, installed: true } – or { …, installed: false, why: 'randomized' | 'encrypted' |
 * 'invalid' | 'diskFull' | … } when it isn't used. `keep`: the stamps of every update file the library has (the cache
 * keeps those). Never throws.
 */
export async function prepareUpdate({ saveDir, gameTid, update, randomized = false, hacked = false, keep = null, cache = UPDATE_CACHE }) {
  const tid = String(gameTid || '').toUpperCase();
  if (!/^00040000[0-9A-F]{8}$/.test(tid)) return null;
  const info = (u, extra) => ({ titleId: `0004000E${tid.slice(8)}`, version: u.version ?? null, ...updateStatus(tid, u.version ?? null), ...extra });
  try {
    if (keep) pruneUpdateCache(keep, { cache });
    if (!update) {
      removeInstalledUpdate(saveDir, tid);
      return null;
    }
    // (a ROM hack – Rising Ruby, built on version 1.0 – would run the update's code instead of its own)
    if (randomized || hacked || update.encrypted) {
      removeInstalledUpdate(saveDir, tid);
      return info(update, { installed: false, why: randomized ? 'randomized' : hacked ? 'hack' : 'encrypted' });
    }
    const unpacked = await unpackUpdate(update.file, { cache });
    if (unpacked.titleId.toUpperCase() !== `0004000E${tid.slice(8)}`) throw Object.assign(new Error('the update belongs to another game'), { code: 'otherGame' });
    installUpdate(saveDir, unpacked);
    return info({ version: unpacked.version }, { installed: true });
  } catch (e) {
    // the game still starts – without the update, and the player view says why
    console.warn(`[3ds] the update couldn’t be installed: ${e.code || ''} ${e.message}`);
    try {
      removeInstalledUpdate(saveDir, tid);
    } catch {
      // a file the old game still holds (Windows) – it stays until the next start
    }
    return info(update, { installed: false, why: e.code || 'failed' });
  }
}
