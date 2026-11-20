// The first start of a new major version (3.0 after 2.x): which version ran before, a backup of the player's data
// before anything of it is touched, and the "What's new" cards. Runs once in startServer, before every migration.
//
// What the backup holds: runs (run.json, the shared doc, battery saves, the host key, logs), save states, settings
// (config.json, the browser storage with each run's doc copy and which player you are), trophies, intro saves, live-run
// link, custom covers, the 3DS saves – not the ROMs (the library, the games built into run folders: a randomized one is
// built again from its seed), not caches, downloaded tools or installed 3DS game updates (souldew installs them again
// from the library). It goes next to the data, into backups/pre-<major>.0-<date>/, once per major version: the config
// remembers it (upgradeBackups), also when it was skipped – a backup made later wouldn't be from before the update.
import { copyFileSync, constants, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statfsSync, chmodSync } from 'node:fs';
import { join, extname } from 'node:path';

/** Never copied: whole top-level entries of the data folder. */
const SKIP_TOP = new Set(['backups', 'Library', 'library', 'cache', 'tools', 'plus', 'logs', 'Cache', 'Code Cache', 'GPUCache', 'DawnCache',
  'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'GraphiteDawnCache', 'ShaderCache', 'blob_storage', 'Shared Dictionary',
  'Service Worker', 'Crashpad', 'SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort']);
/** Never copied, wherever they are (relative paths with `/`): caches and copies souldew makes again by itself. */
const SKIP_PATH = [/^ctr\/updates(\/|$)/, /^runs\/\.(trash|cache)(\/|$)/, /\/shaders(\/|$)/, /\/title\/0004000e(\/|$)/i, /^runs\/[^/]+\/backups\/.*\.tmp$/];
/** Games and archives: the player's own files, kept where they are (and big). */
const ROM_EXT = new Set(['.gb', '.gbc', '.gba', '.nds', '.dsi', '.srl', '.3ds', '.cci', '.cxi', '.cia', '.3dsx', '.zip', '.7z', '.rar']);
/** Free space the backup always leaves on the disk (it should never be what fills it). */
export const HEADROOM = 512 * 1024 * 1024;

export const majorOf = (v) => {
  const m = /^(\d+)\./.exec(String(v || ''));
  return m ? Number(m[1]) : null;
};

/**
 * What this start means: `from` the version that ran before ('2.x' for an install from before versions were noted –
 * every 2.x – null for a new install), whether it's the first start of a new major version, and the config patch
 * (appVersion always; whatsNew '<major>.0' for a player who knows the app already – a new one gets the welcome tour).
 * `ranBefore`: the data folder holds what an app that ran leaves behind (ranBefore()) – a config written by hand for a
 * new install (the e2e scripts, tests) has no version and isn't an update.
 */
export function versionStep(config, current, ranBefore = true) {
  const c = config && typeof config === 'object' ? config : {};
  // an install that ran before: anything in its config beyond the graphics start marker electron/main.mjs may write first
  const used = ranBefore && Object.keys(c).some((k) => !k.startsWith('gpu'));
  const from = typeof c.appVersion === 'string' ? c.appVersion : used ? '2.x' : null;
  const to = majorOf(current);
  const was = from === '2.x' ? 2 : majorOf(from);
  const major = to != null && was != null && was < to;
  const patch = {};
  if (c.appVersion !== current) patch.appVersion = current;
  if (major && c.onboarded && !c.upgradeBackups?.[to]) patch.whatsNew = `${to}.0`;
  return { from, to, major, patch };
}

const relOf = (parts) => parts.join('/');
function skipped(parts, isDir) {
  if (parts.length === 1 && SKIP_TOP.has(parts[0])) return true;
  const rel = relOf(parts);
  if (SKIP_PATH.some((re) => re.test(rel))) return true;
  if (!isDir && (ROM_EXT.has(extname(rel).toLowerCase()) || rel.endsWith('.tmp') || rel.endsWith('.part'))) return true;
  return false;
}

/** The files a backup takes: [{ rel, size, mode }] (no symlinks followed) and their total size. */
export function backupPlan(dataDir) {
  const files = [];
  let bytes = 0;
  const walk = (parts) => {
    let names = [];
    try {
      names = readdirSync(join(dataDir, ...parts));
    } catch {
      return;
    }
    for (const n of names) {
      const p = [...parts, n];
      let st;
      try {
        st = lstatSync(join(dataDir, ...p));
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (skipped(p, st.isDirectory())) continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        files.push({ rel: relOf(p), size: st.size, mode: st.mode & 0o777 });
        bytes += st.size;
      }
    }
  };
  walk([]);
  return { files, bytes };
}

const day = (now) => new Date(now).toISOString().slice(0, 10);

/**
 * Copy the plan into <dataDir>/backups/pre-<label>-<date>/ – first into a hidden folder, renamed when complete, so a
 * backup that's there is whole. Copies are clones where the file system can (APFS, Btrfs: no extra space, instant).
 * Not enough free space for the plan plus HEADROOM: nothing is written. → { path, name, bytes, files, at } or
 * { skipped: 'space', need, free, at }.
 */
export function makeBackup(dataDir, { label, now = Date.now(), free = null, plan = backupPlan(dataDir) } = {}) {
  const avail = free ?? freeSpace(dataDir);
  if (avail != null && avail < plan.bytes + HEADROOM) return { skipped: 'space', need: plan.bytes, free: avail, at: now };
  const root = join(dataDir, 'backups');
  let name = `pre-${label}-${day(now)}`;
  for (let i = 2; exists(join(root, name)); i++) name = `pre-${label}-${day(now)}-${i}`;
  const tmp = join(root, `.${name}.partial`);
  rmSync(tmp, { recursive: true, force: true });
  let files = 0;
  let bytes = 0;
  for (const f of plan.files) {
    const to = join(tmp, ...f.rel.split('/'));
    mkdirSync(join(to, '..'), { recursive: true });
    try {
      copyFileSync(join(dataDir, ...f.rel.split('/')), to, constants.COPYFILE_FICLONE);
    } catch (e) {
      // gone since the plan was made (a journal or lock file another process removed meanwhile): nothing to keep –
      // one vanished file must not cost the player the whole backup
      if (e?.code === 'ENOENT') continue;
      throw e;
    }
    files++;
    bytes += f.size;
    // a private file stays private (live-runs.json, the host keys: 0600)
    if ((f.mode & 0o077) === 0) try { chmodSync(to, f.mode); } catch { /* a file system without modes */ }
  }
  mkdirSync(tmp, { recursive: true });
  renameSync(tmp, join(root, name));
  return { path: join(root, name), name, bytes, files, at: now };
}

function exists(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Free bytes for this user on the disk of `dir`, or null when the system can't tell. */
export function freeSpace(dir) {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** Leftovers of a backup that was cut off (the app quit or crashed while copying): the next start begins afresh. */
function dropPartials(dataDir) {
  let names = [];
  try {
    names = readdirSync(join(dataDir, 'backups'));
  } catch {
    return;
  }
  for (const n of names) if (/^\.pre-.+\.partial$/.test(n)) rmSync(join(dataDir, 'backups', n), { recursive: true, force: true });
}

/** Has souldew run on this data folder before? What every 2.x start leaves: the library's index, runs, trophies, states. */
export const ranBefore = (dataDir) => ['library-index.json', 'runs', 'trophies.json', 'Saves', 'Local Storage'].some((n) => exists(join(dataDir, n)));

/**
 * The whole step at start-up. `config`: the config as it is on disk (null: none); `save(patch)` writes the config.
 * → { from, to, major, backup } – backup: what upgradeBackups now says for this major version (null: nothing to do).
 */
export function upgradeStep({ dataDir, config, current, save, log = console.log, now = Date.now(), free = null, backups = true }) {
  const step = versionStep(config, current, ranBefore(dataDir));
  let backup = config?.upgradeBackups?.[step.to] || null;
  const patch = { ...step.patch };
  if (step.major && !backup && backups) {
    dropPartials(dataDir);
    const label = `${step.to}.0`;
    try {
      const made = makeBackup(dataDir, { label, now, free });
      if (made.skipped) {
        log(`[upgrade] no backup before ${label}: ${Math.round(made.need / 1048576)} MB needed, ${Math.round(made.free / 1048576)} MB free (keeps ${Math.round(HEADROOM / 1048576)} MB)`);
      } else {
        log(`[upgrade] backup before ${label}: ${made.files} files, ${Math.round(made.bytes / 1048576)} MB in ${made.path}`);
      }
      backup = { from: step.from, ...made };
    } catch (e) {
      dropPartials(dataDir);
      log(`[upgrade] no backup before ${label}: ${e.message}`);
      backup = { from: step.from, skipped: 'error', error: String(e.code || e.message).slice(0, 80), at: now };
    }
    patch.upgradeBackups = { ...(config?.upgradeBackups || {}), [step.to]: backup };
  }
  if (Object.keys(patch).length) save(patch);
  return { ...step, backup };
}

/** What the page may know of a backup (Settings › About): no paths beyond the folder's name, which it shows. */
export function backupInfo(b) {
  if (!b || typeof b !== 'object') return null;
  if (b.skipped) return { skipped: b.skipped === 'space' ? 'space' : 'error', need: Number(b.need) || null, free: Number(b.free) || null, at: Number(b.at) || null };
  return { name: typeof b.name === 'string' ? b.name : null, bytes: Number(b.bytes) || 0, files: Number(b.files) || 0, at: Number(b.at) || null, from: typeof b.from === 'string' ? b.from : null };
}

