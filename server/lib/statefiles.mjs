// Save states of the built-in players on disk: <dir>/<key>-<slot>.state, plus a small JPEG (.jpg) and an info file
// (.json: party, core …) per state. Slots 1–8 are the player's, 99 is "where you left off", 96–98 keep older copies of 99.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const AUTO_SLOT = 99;
export const BACKUP_SLOTS = [98, 97, 96]; // newest first
export const BACKUP_EVERY = 10 * 60 * 1000;
export const STATE_EXT = ['state', 'jpg', 'json'];
/**
 * Cores whose states no player of this version loads any more – the fast player's Game Boy core before 3.0 (Gambatte;
 * since then SameBoy, docs/MULTIPLAYER.md › "Seamless"). Their states stay: a player who goes back to 2.x still has them.
 */
export const RETIRED_CORES = new Set(['gambatte-native']);
/** Where states of a retired core go when the automatic slots would replace them – kept, not listed. */
export const KEPT_DIR = 'previous-emulator';

export const statePath = (dir, key, slot, ext) => join(dir, `${key}-${slot}.${ext}`);
export const mtimeOf = (p) => {
  try {
    return Math.round(statSync(p).mtimeMs);
  } catch {
    return 0;
  }
};

/** The core a state was made with (its info file), or null. */
export function coreOf(dir, key, slot) {
  try {
    const c = JSON.parse(readFileSync(statePath(dir, key, slot, 'json'), 'utf8'))?.core;
    return typeof c === 'string' ? c : null;
  } catch {
    return null;
  }
}
const retired = (dir, key, slot) => existsSync(statePath(dir, key, slot, 'state')) && RETIRED_CORES.has(coreOf(dir, key, slot));

/** A retired core's state out of the automatic slots into KEPT_DIR (name: key, slot and its time – nothing is replaced). */
function keep(dir, key, slot) {
  const at = mtimeOf(statePath(dir, key, slot, 'state'));
  mkdirSync(join(dir, KEPT_DIR), { recursive: true });
  for (const ext of STATE_EXT) {
    const from = statePath(dir, key, slot, ext);
    if (existsSync(from)) renameSync(from, join(dir, KEPT_DIR, `${key}-${slot}-${at}.${ext}`));
  }
}

/**
 * Before "where you left off" is replaced it becomes a backup – if the newest backup is ≥ 10 min older. A state of a
 * retired core (the Game Boy player before 3.0) is never lost on the way: in slot 99 it always becomes a backup – the
 * first game after the update would replace it within minutes otherwise – and a backup of one that would fall off the
 * end (slot 96) is kept in KEPT_DIR.
 */
export function rotateAutoState(dir, key) {
  const auto = mtimeOf(statePath(dir, key, AUTO_SLOT, 'state'));
  if (!auto) return;
  if (!retired(dir, key, AUTO_SLOT) && auto - mtimeOf(statePath(dir, key, BACKUP_SLOTS[0], 'state')) < BACKUP_EVERY) return;
  const move = (from, to) => {
    for (const ext of STATE_EXT) {
      if (existsSync(statePath(dir, key, from, ext))) renameSync(statePath(dir, key, from, ext), statePath(dir, key, to, ext)); // keeps the mtime
      else rmSync(statePath(dir, key, to, ext), { force: true });
    }
  };
  const last = BACKUP_SLOTS.at(-1);
  if (retired(dir, key, last)) keep(dir, key, last);
  for (let i = BACKUP_SLOTS.length - 1; i > 0; i--) move(BACKUP_SLOTS[i - 1], BACKUP_SLOTS[i]);
  move(AUTO_SLOT, BACKUP_SLOTS[0]);
}
