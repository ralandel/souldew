// 3DS game updates in the page: how the library shows a game's update and what the play view says about the one the
// game started with (server/lib/ctrupdate.mjs prepareUpdate, scanLibrary's rom.update / ctrUpdates).
import { t } from './i18n.mjs';

/** "v2.2.0 (game version 1.2)", or "v2.2.0" when souldew doesn't know which version the game shows for it. */
export function updateVersionLabel(u) {
  if (!u) return '';
  const v = u.versionText || '';
  return u.gameVersion ? t('ctrUpdate.versionGame', '{version} (game version {game})', { version: v, game: u.gameVersion }) : v;
}

/**
 * The play view's line about the update, or '' – `live`: the team is found (an older update then needs no warning).
 */
export function ctrUpdateNote(u, live = false) {
  if (!u) return '';
  const version = u.versionText || '';
  if (!u.installed) {
    if (u.why === 'randomized') return t('ctrUpdate.playRandomized', 'Randomized games start without their update ({version}) – the randomizer builds them from version 1.0 of the game.', { version });
    if (u.why === 'hack') return t('ctrUpdate.playHack', 'ROM hacks start without the game’s update ({version}) – the hack is built on a version of its own, and the update would replace it.', { version });
    if (u.why === 'encrypted') return t('ctrUpdate.playEncrypted', 'The update {version} is encrypted, so the game starts without it. souldew needs a decrypted copy of the update.', { version });
    return t('ctrUpdate.playFailed', 'The update {version} couldn’t be installed, so the game starts without it.', { version });
  }
  if (u.tracking === 'older' && !live) {
    return t('ctrUpdate.playOlder', 'This game runs an older update ({version}). souldew knows where version 1.0 and the latest update keep your team – if it doesn’t show up, add the latest update to your library or remove this one.', { version });
  }
  return '';
}
