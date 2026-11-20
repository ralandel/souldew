// Importing a battery save (a player on Discord: "can I bring my old .sav?"): the file is checked and brought into
// souldew's layout (shared/savefile.mjs), the save it replaces is always backed up first – next to the other save
// backups (a run's `backups` folder, the graveyard's too; the solo games' `Saves/backups/<game>`) – and one step back
// is kept: Undo puts the replaced save back (and keeps the imported one as a backup as well, nothing is lost).
//
// What it never does: write under a running game. The caller (server/app.mjs) refuses while the fast player, the 3DS
// player or an external emulator has the file open, and the page closes the browser player first.
//
// 3DS: a Checkpoint / JKSM backup (a folder of the save's files, or a zip of it) goes into the game's save folder in
// souldew's own 3DS player – only where the game already made that folder (started once and saved): Azahar formats a
// save archive itself the first time, and a folder souldew made up could be one the game refuses.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, cpSync, renameSync, mkdtempSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileAtomic, httpError } from './fsutil.mjs';
import { listZip, readZipEntry } from './zip.mjs';
import { normalizeSave, checkSaveForGame, familySize, familyClock, familyOfGame, ctrImportFiles, saveFileError, SAVE_EXTENSIONS } from '../../shared/savefile.mjs';

/** How many import backups a save keeps (the oldest go – the graveyard's backups in a run folder are never touched). */
export const KEEP_BACKUPS = 12;
const UNDO = 'last-import.json';
const PREFIX = 'import-';
const sha1 = (b) => createHash('sha1').update(b).digest('hex');
const stampNow = (now = Date.now()) => new Date(now).toISOString().replace(/[:.]/g, '-');

/**
 * A file error as the page words it: a file another program holds (Windows) or that may not be written, a full or
 * failing disk, anything else with its code. `what`: 'read' | 'write' | 'backup'.
 */
export function fsFailure(e, what = 'write') {
  if (e?.status) return e;
  const code = String(e?.code || '');
  const vars = { detail: code || String(e?.message || '').slice(0, 120), what };
  if (['EBUSY', 'EPERM', 'EACCES', 'ETXTBSY'].includes(code)) return httpError(423, `The save file is locked (${code})`, 'saveFileLocked', vars);
  if (['ENOSPC', 'EDQUOT', 'EIO', 'EROFS', 'EFBIG'].includes(code)) return httpError(507, `The disk refused the save (${code})`, 'saveDiskProblem', vars);
  return httpError(500, `The save couldn’t be written: ${vars.detail}`, 'saveWriteFailed', vars);
}

/** A shared/savefile.mjs error (a code, values) as an HTTP error; anything else as it is. */
const asHttp = (e) => (e?.status ? e : e?.code && /^saveImport/.test(e.code) ? httpError(e.code === 'saveImportNocash' ? 415 : 422, e.message, e.code, e.vars) : e);

/** A zip with one save in it (players zip their saves to send them): that save; anything else: the bytes as they are. */
export function unzipSingleSave(bytes, tmpDir) {
  if (!(bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)) return { bytes, name: null };
  const files = readZipFiles(bytes, tmpDir, { max: 1024 * 1024 * 2 });
  const saves = files.filter((f) => SAVE_EXTENSIONS.includes((f.path.split('.').pop() || '').toLowerCase()));
  const pick = saves.length === 1 ? saves[0] : files.length === 1 ? files[0] : null;
  if (!pick) throw httpError(422, 'The zip doesn’t hold exactly one save', 'saveImportZip', { n: saves.length || files.length });
  return { bytes: pick.bytes, name: basename(pick.path) };
}

/** Every file of a zip (in memory – saves are small): [{ path, bytes }]. `max`: the most one file or all may hold. */
export function readZipFiles(bytes, tmpDir, { max = 16 * 1024 * 1024 } = {}) {
  mkdirSync(tmpDir, { recursive: true });
  const dir = mkdtempSync(join(tmpDir, 'saveimport-'));
  const file = join(dir, 'upload.zip');
  try {
    writeFileSync(file, bytes);
    let entries;
    try {
      entries = listZip(file);
    } catch (e) {
      throw httpError(422, `Not a zip file: ${e.message}`, 'saveImportFormat', { detail: 'zip' });
    }
    const files = [];
    let total = 0;
    for (const en of entries) {
      if (!en.name || en.name.endsWith('/')) continue;
      if (en.uncompSize > max || (total += en.uncompSize) > max) throw httpError(422, 'Too large for a save', 'saveImportSize', { size: `${Math.round(en.uncompSize / 1024)} KB`, bytes: en.uncompSize, sizes: '' });
      files.push({ path: en.name, bytes: new Uint8Array(readZipEntry(file, en)) });
    }
    return files;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Check a file for a game: brought into souldew's layout and looked at. `game`: { system, gameId (the catalog id – a
 * hack's: null), clock } → { bytes, size, from, notes, check: { verdict, found, want, gen, party } }. Throws (with a
 * code) for a size or format no cartridge of the system has.
 */
export function checkImport(input, { system, gameId = null, tables = null }) {
  let norm;
  const family = familyOfGame(gameId);
  try {
    norm = normalizeSave(input, system, { expected: familySize(gameId), clock: familyClock(family) });
  } catch (e) {
    throw asHttp(e);
  }
  const check = checkSaveForGame(norm.bytes, system, gameId, tables);
  return { ...norm, check };
}

/** The import backups of a save in `dir` (`key`: which save), newest first: [{ file, at }]. */
export function importBackups(dir, key) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const re = new RegExp(`^${PREFIX}${key}-(.+)-(before|imported|undone)\\.sav$`);
  return names.map((n) => ({ n, m: re.exec(n) })).filter((x) => x.m)
    .map(({ n, m }) => ({ file: n, kind: m[2], at: (() => { try { return statSync(join(dir, n)).mtimeMs; } catch { return 0; } })() }))
    .sort((a, b) => b.at - a.at || b.file.localeCompare(a.file));
}

/**
 * The oldest import backups past KEEP_BACKUPS go (only souldew's own `import-…` files – by their exact names) – except
 * the oldest "before": the save the player had before their first import, which a few tries with other files must
 * never cost them.
 */
function prune(dir, key, keep = KEEP_BACKUPS) {
  const all = importBackups(dir, key);
  const first = all.filter((b) => b.kind === 'before').at(-1)?.file;
  for (const b of all.slice(keep)) if (b.file !== first) rmSync(join(dir, b.file), { force: true });
}

const undoPath = (dir, key) => join(dir, `${PREFIX}${key}-${UNDO}`);

/** The one step back kept for a save: { at, backup (file name | null: there was none), importedSha1, name } or null. */
export function lastImport(dir, key) {
  try {
    const u = JSON.parse(readFileSync(undoPath(dir, key), 'utf8'));
    return u && typeof u === 'object' && typeof u.at === 'number' ? u : null;
  } catch {
    return null;
  }
}

/**
 * Put `bytes` in place of the save at `path`: the save there (if any) is copied into `backupDir` first – nothing is
 * written before that copy is on disk – then the new one is written atomically (a temp file renamed over it). `key`
 * names the save among others in the same folder (a run's slot, a solo game's id hash). `name`: the imported file's
 * name, for the record. → { at, backup, replaced: bool }
 */
export function replaceSave({ path, bytes, backupDir, key, name = null, now = Date.now() }) {
  const stamp = stampNow(now);
  let backup = null;
  try {
    mkdirSync(backupDir, { recursive: true });
    if (existsSync(path)) {
      backup = `${PREFIX}${key}-${stamp}-before.sav`;
      const old = readFileSync(path);
      writeFileAtomic(join(backupDir, backup), old);
    }
    // the imported file itself is kept too: Undo, then a change of mind, has it at hand
    writeFileAtomic(join(backupDir, `${PREFIX}${key}-${stamp}-imported.sav`), bytes);
  } catch (e) {
    throw fsFailure(e, 'backup');
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomic(path, bytes);
  } catch (e) {
    throw fsFailure(e, 'write');
  }
  const record = { at: now, backup, importedSha1: sha1(bytes), name: name ? String(name).slice(0, 120) : null };
  try {
    writeFileAtomic(undoPath(backupDir, key), JSON.stringify(record));
  } catch {
    // (the import is done; only its Undo is missing – the backup is still there)
  }
  prune(backupDir, key);
  return { at: now, backup, replaced: !!backup };
}

/**
 * Undo the last import of a save: the save as it is now is backed up (`…-undone.sav` – played on since? that's kept),
 * then the replaced one goes back – or, when there was none before, the imported one is moved away. Once: the step
 * back is used up. → { restored: bool, removed: bool, playedSince: bool } or throws noImportToUndo.
 */
export function undoImport({ path, backupDir, key, now = Date.now() }) {
  const u = lastImport(backupDir, key);
  if (!u) throw httpError(409, 'There is no import to undo', 'noImportToUndo');
  let current = null;
  try {
    current = existsSync(path) ? readFileSync(path) : null;
  } catch (e) {
    throw fsFailure(e, 'read');
  }
  const playedSince = !!current && sha1(current) !== u.importedSha1;
  let restore = null;
  if (u.backup) {
    try {
      restore = readFileSync(join(backupDir, u.backup));
    } catch {
      throw httpError(410, 'The backup to go back to is gone', 'importBackupGone', { file: u.backup });
    }
  }
  try {
    if (current) writeFileAtomic(join(backupDir, `${PREFIX}${key}-${stampNow(now)}-undone.sav`), current);
    if (restore) writeFileAtomic(path, restore);
    else if (current) rmSync(path, { force: true });
  } catch (e) {
    throw fsFailure(e, 'write');
  }
  rmSync(undoPath(backupDir, key), { force: true });
  prune(backupDir, key);
  return { restored: !!restore, removed: !restore && !!current, playedSince };
}

// ---- 3DS -----------------------------------------------------------------------------------------------------------

/**
 * The game's save folders ("data/00000001") under a 3DS save folder's SD card (`root` = …/Azahar/sdmc/Nintendo 3DS):
 * `titles` = the game's title ids (catalog) – only those. → absolute paths.
 */
export function ctrSaveArchives(root, titles = null) {
  const out = [];
  const dirs = (p) => {
    try {
      return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
  };
  const want = titles?.length ? new Set(titles.map((t) => String(t).slice(-8).toLowerCase())) : null;
  for (const a of dirs(root)) {
    for (const b of dirs(join(root, a))) {
      for (const low of dirs(join(root, a, b, 'title', '00040000'))) {
        if (want && !want.has(low.toLowerCase())) continue;
        const p = join(root, a, b, 'title', '00040000', low, 'data', '00000001');
        if (existsSync(p)) out.push(p);
      }
    }
  }
  return out;
}

/** Every file under `dir` as [{ path (with `/`), bytes }]. */
function filesIn(dir, rel = '') {
  const out = [];
  for (const d of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...filesIn(dir, r));
    else if (d.isFile()) out.push({ path: r, bytes: readFileSync(join(dir, r)) });
  }
  return out;
}

/**
 * Check a Checkpoint / JKSM backup against the game's save folder: `archive` (the data/00000001 folder, or null).
 * → { files, family, want, verdict: 'match'|'mismatch'|'unknown', missing: [paths the game has that the backup lacks] }
 */
export function checkCtrImport(files, { archive, gameId = null }) {
  let parsed;
  try {
    parsed = ctrImportFiles(files);
  } catch (e) {
    throw asHttp(e);
  }
  const want = familyOfGame(gameId);
  const verdict = want && parsed.family ? (parsed.family === want ? 'match' : 'mismatch') : 'unknown';
  let missing = [];
  if (archive && existsSync(archive)) {
    const have = new Set(parsed.files.map((f) => f.path));
    missing = filesIn(archive).map((f) => f.path).filter((p) => !have.has(p));
  }
  return { files: parsed.files, family: parsed.family, want, verdict, missing };
}

/**
 * Put a backup's files into the game's save folder `archive`: the folder as it is goes into `backupDir` first (a copy),
 * then the new files are written into a fresh folder next to it that is swapped in – a failure halfway leaves the old
 * save as it was. → { at, backup (folder name) }
 */
export function replaceCtrSave({ archive, files, backupDir, key, now = Date.now() }) {
  if (!archive || !existsSync(archive)) throw httpError(409, 'Start the game in souldew once and save in it first', 'ctrSaveNotStarted');
  const stamp = stampNow(now);
  const backup = `${PREFIX}${key}-${stamp}-before`;
  try {
    mkdirSync(backupDir, { recursive: true });
    cpSync(archive, join(backupDir, backup), { recursive: true });
  } catch (e) {
    throw fsFailure(e, 'backup');
  }
  const fresh = `${archive}.new-${randomBytes(4).toString('hex')}`;
  const aside = `${archive}.old-${randomBytes(4).toString('hex')}`;
  try {
    for (const f of files) {
      const to = join(fresh, ...f.path.split('/'));
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, f.bytes);
    }
    renameSync(archive, aside);
    try {
      renameSync(fresh, archive);
    } catch (e) {
      renameSync(aside, archive);
      throw e;
    }
    rmSync(aside, { recursive: true, force: true });
  } catch (e) {
    rmSync(fresh, { recursive: true, force: true });
    throw fsFailure(e, 'write');
  }
  try {
    writeFileAtomic(undoPath(backupDir, key), JSON.stringify({ at: now, backup, ctr: true }));
  } catch {
    // (only the Undo is missing)
  }
  return { at: now, backup };
}

/** Undo a 3DS import: the folder as it is now is kept as a backup, the one before the import goes back. */
export function undoCtrImport({ archive, backupDir, key, now = Date.now() }) {
  const u = lastImport(backupDir, key);
  if (!u?.ctr || !u.backup) throw httpError(409, 'There is no import to undo', 'noImportToUndo');
  const from = join(backupDir, u.backup);
  if (!existsSync(from)) throw httpError(410, 'The backup to go back to is gone', 'importBackupGone', { file: u.backup });
  try {
    if (existsSync(archive)) renameSync(archive, join(backupDir, `${PREFIX}${key}-${stampNow(now)}-undone`));
    cpSync(from, archive, { recursive: true });
  } catch (e) {
    throw fsFailure(e, 'write');
  }
  rmSync(undoPath(backupDir, key), { force: true });
  return { restored: true, removed: false, playedSince: false };
}

export { saveFileError };
