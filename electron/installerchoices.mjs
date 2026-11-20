// The Windows installer's privacy page (build/installer.nsh): what the player chose there, applied to config.json once.
//
// The page shows the two things souldew sends over the internet by itself – the anonymous "playing now" count
// (config.presence, server/lib/presence.mjs) and the automatic update check (config.updateCheck, electron/updater.mjs) –
// each as a checkbox, ticked as config.json has it (on unless switched off). When the page was shown, the installer
// leaves installer-choices.json in the data folder:
//
//   { "v": 1, "presence": false, "presenceShown": true, "updateCheck": true, "updateCheckShown": true }
//
// `…Shown` is how the box was ticked when the page opened, the plain key how it was ticked when "Install" was clicked.
// Only what the player changed on the page goes into config.json – a reinstall where nobody touched the boxes leaves
// a setting changed in the app since alone. A silent install (/S – the in-app update) and an update started with
// --updated never show the page and write no file, so they change nothing.
//
// The file is removed once read; the file's time goes into config.json (installerChoices) as well, so a file that
// can't be removed is still applied only once.
import { readFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const INSTALLER_CHOICES_FILE = 'installer-choices.json';
/** The settings the page offers – both on unless switched off. */
export const INSTALLER_KEYS = ['presence', 'updateCheck'];

/** The installer's answer → the config patch (only the boxes the player changed), or null. */
export function installerPatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== 1) return null;
  const patch = {};
  for (const k of INSTALLER_KEYS) {
    const chosen = raw[k];
    const shown = raw[`${k}Shown`];
    if (typeof chosen !== 'boolean') continue;
    // an older or broken page without `…Shown` counts as "the default was shown"
    if (chosen !== (typeof shown === 'boolean' ? shown : true)) patch[k] = chosen;
  }
  return Object.keys(patch).length ? patch : null;
}

/**
 * At the start of the desktop app (before the update check and the local server): reads installer-choices.json from
 * the data folder, puts what the player changed into config.json and removes the file. Returns the patch that was
 * applied (null when there was nothing to do). Never throws – the choices are not worth a failed start.
 *   dir          the data folder (userData)
 *   readConfig   () → config.json's content
 *   patchConfig  (patch) → writes the keys into config.json
 */
export function applyInstallerChoices({ dir, readConfig, patchConfig, fs = { readFileSync, statSync, rmSync }, log = console }) {
  const file = join(dir, INSTALLER_CHOICES_FILE);
  let text;
  let stamp;
  try {
    stamp = Math.round(fs.statSync(file).mtimeMs);
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // no file: no installer page this time (or not Windows)
  }
  let raw = null;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    log.warn?.('installer choices: unreadable file, ignored');
  }
  let applied = null;
  try {
    if (readConfig()?.installerChoices !== stamp) {
      applied = installerPatch(raw);
      patchConfig({ ...(applied || {}), installerChoices: stamp });
    }
  } catch (e) {
    log.warn?.('installer choices: could not apply:', e?.message || e);
    applied = null;
  }
  try {
    fs.rmSync(file, { force: true });
  } catch (e) {
    log.warn?.('installer choices: could not remove the file:', e?.message || e);
  }
  return applied;
}
