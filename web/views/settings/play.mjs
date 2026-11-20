// Settings › Play: how fast-forward behaves, what you hear while it runs, the launch animation, the picture, and which
// player runs the games.
import { html, useState, useEffect } from '/vendor/htm-preact.mjs';
import { t } from '../../lib/i18n.mjs';
import { Item, Group, Check, Elsewhere } from './parts.mjs';
import { LaunchSetting } from './launch.mjs';

/** Turbo audio: kept in this browser profile (the game's sound menu and Settings show the same value). */
export const TURBO_AUDIO = ['music', 'mute', 'original', 'plain'];
const TURBO_AUDIO_KEY = 'sl-turbo-audio';
/** Fired on window when either place changes it – a game running in the corner switches at once. */
export const TURBO_AUDIO_EVENT = 'sl-turbo-audio';

export function readTurboAudio() {
  try {
    const v = JSON.parse(localStorage.getItem(TURBO_AUDIO_KEY));
    return TURBO_AUDIO.includes(v) ? v : 'music';
  } catch {
    return 'music';
  }
}

export function writeTurboAudio(mode) {
  if (!TURBO_AUDIO.includes(mode)) return;
  try {
    localStorage.setItem(TURBO_AUDIO_KEY, JSON.stringify(mode));
  } catch {
    // private mode: this session only
  }
  window.dispatchEvent(new CustomEvent(TURBO_AUDIO_EVENT, { detail: mode }));
}

function TurboAudioSetting() {
  const [mode, setMode] = useState(readTurboAudio);
  useEffect(() => {
    const on = (e) => setMode(TURBO_AUDIO.includes(e.detail) ? e.detail : readTurboAudio());
    addEventListener(TURBO_AUDIO_EVENT, on);
    return () => removeEventListener(TURBO_AUDIO_EVENT, on);
  }, []);
  return html`<div class="stack-s">
    <div class="grid-2"><label class="field"><span>${t('play.turboAudio', 'Turbo audio')}</span>
      <select value=${mode} onChange=${(e) => { setMode(e.target.value); writeTurboAudio(e.target.value); }}>
        <option value="music">${t('play.turboAudioMusic', 'Music continues')}</option>
        <option value="mute">${t('play.turboAudioMute', 'Mute')}</option>
        <option value="original">${t('play.turboAudioOriginal', 'Sped-up original')}</option>
        <option value="plain">${t('play.turboAudioPlain', 'Plain (no extra processing)')}</option>
      </select></label></div>
    <span class="small faint">${t('play.turboAudioHint', 'What you hear while fast-forwarding. “Music continues” keeps the music at its normal speed and pitch – sound effects stay silent. Where souldew has no music of its own yet (a song not yet heard at normal speed), you hear the sped-up original. “Sped-up original” plays the game’s own sound, faster and higher.')}
      ${mode === 'plain' ? ` ${t('play.turboAudioPlainHint', 'The emulator’s sound only – no recording, no mixer. Try it if the sound crackles.')}` : ''}</span>
  </div>`;
}

/**
 * The built-in 3DS player's internal resolution (issue #59): 1× is the 3DS's own, 2× and 3× draw the games sharper and
 * cost the graphics card more. The host takes it at its start – it applies to the next 3DS game.
 */
function CtrScaleSetting({ cfg, save }) {
  const value = [1, 2, 3].includes(cfg.ctrScale) ? cfg.ctrScale : 1;
  const labels = { 1: t('set.ctrScale1', '1× (native)'), 2: '2×', 3: '3×' };
  return html`<div class="stack-s">
    <label class="field"><span>${t('set.ctrScale', '3DS resolution')}</span>
      <select value=${value} onChange=${(e) => save({ ctrScale: Number(e.target.value) })}>
        ${[1, 2, 3].map((n) => html`<option value=${n}>${labels[n]}</option>`)}</select></label>
    <span class="small faint">${t('set.ctrScaleHint', 'Draws the 3DS games at two or three times their own resolution – sharper and less pixelated, but more work for the graphics card. Applies to the next 3DS game you start. The Software renderer always plays at 1×, and so does the automatic step down after a crash.')}</span>
    <${Check} checked=${cfg.ctrFfHintOff !== true} onChange=${(v) => save({ ctrFfHintOff: !v })}
      label=${t('set.ctrFfHint', 'Tell me when it slows down fast-forward')}
      hint=${t('set.ctrFfHintHint', 'On some graphics cards fast-forward at 2× or 3× stays well below the speed you pick – the play view then says so, at most once each time souldew starts.')} />
  </div>`;
}

function GbLookSetting({ cfg, save }) {
  return html`<div class="stack-s">
    <label class="field"><span>${t('set.gbLook', 'Game Boy look')}</span>
      <select value=${cfg.gbLook === 'color' ? 'color' : 'original'} onChange=${(e) => save({ gbLook: e.target.value })}>
        <option value="original">${t('set.gbLookOriginal', 'Original Game Boy')}</option>
        <option value="color">${t('set.gbLookColor', 'Game Boy Color colours')}</option>
      </select></label>
    <span class="small faint">${t('set.gbLookHint', 'Red, Blue, Yellow and the other Game Boy games in the fast player: on the original Game Boy with its green screen, or with the colours a Game Boy Color gives them. Gold, Silver and Crystal are always in colour. Applies to the next game you start; a savestate loads only with the look it was made with.')}</span>
  </div>`;
}

export function PlaySection({ cfg, status, save }) {
  const native = !!status?.native?.ok; // the fast player is part of this install
  const nativeOn = native && cfg.nativeCore !== false;
  const ctr = !!status?.ctr?.ok; // souldew's 3DS host is installed
  return html`
    <${Group} title=${t('set.speed', 'Speed & turbo')} note=${t('set.speedNote', 'How fast-forward behaves. The speed itself is picked in the game’s bar.')}>
      <${Item} id="full-turbo"><${Check} checked=${cfg.fullTurbo !== false} onChange=${(v) => save({ fullTurbo: v })}
        label=${t('set.fullTurbo', 'Full-power turbo: no brake while fast-forwarding')}
        hint=${t('set.fullTurboHint', 'The game may use almost all of the computer’s time while fast-forwarding, and DS games skip drawing frames nobody sees. Never steps down. If the app reacts sluggishly while fast-forwarding, turn it off. Normal speed stays the same.')} /><//>
      <${Item} id="speed-guard"><${Check} disabled=${cfg.fullTurbo !== false} checked=${cfg.speedGuard === true && cfg.fullTurbo === false} onChange=${(v) => save({ speedGuard: v })}
        label=${t('set.speedGuard', 'Step down when the computer can’t keep up')}
        hint=${cfg.fullTurbo !== false ? t('set.speedGuardFull', 'Not with full-power turbo.') : t('set.speedGuardHint', 'Off: the speed you pick stays as it is, the bar shows when a scene runs slower. On: a level that isn’t reached for a few seconds drops to the highest one that holds.')} /><//>
      <${Item} id="turbo-max"><${Check} checked=${cfg.turboMax === true} onChange=${(v) => save({ turboMax: v })}
        label=${t('set.turboMax', 'Turbo step “Max”: as fast as this computer can')}
        hint=${t('set.turboMaxHint', 'After 4× comes “Max” – no speed limit at all. How fast it gets depends on the game and the computer.')} /><//>
    <//>
    <${Group} title=${t('set.sound', 'Sound')}>
      <${Item} id="turbo-audio"><${TurboAudioSetting} /><//>
      <${Elsewhere} icon="sound">${t('set.volumeElsewhere', 'Game volume and mute are in the game’s sound menu (M mutes).')}<//>
    <//>
    <${Group} title=${t('set.gameStart', 'Game start')}>
      <${Item} id="launch"><${LaunchSetting} cfg=${cfg} save=${save} /><//>
    <//>
    <${Group} title=${t('set.picture', 'Picture')}>
      <${Item} id="whole-pixels"><${Check} checked=${cfg.wholePixels === true} onChange=${(v) => save({ wholePixels: v })}
        label=${t('set.wholePixels', 'Whole pixels only')}
        hint=${t('set.wholePixelsHint', 'Every game pixel exactly 2, 3, 4 … screen pixels big – the crispest picture, with a slim black border when the game doesn’t fill the space exactly. Only when that costs at most about 15 % of the picture; otherwise, and with this off, the picture fills the space with sharp pixels that are smoothed only at their edges.')} /><//>
      ${(nativeOn || ctr) && html`<div class="grid-2">
        <${Item} id="gb-look" when=${nativeOn}><${GbLookSetting} cfg=${cfg} save=${save} /><//>
        <${Item} id="ctr-scale" when=${ctr}><${CtrScaleSetting} cfg=${cfg} save=${save} /><//>
      </div>`}
    <//>
    ${native && html`<${Group} title=${t('set.player', 'Player')}>
      <${Item} id="native"><${Check} checked=${cfg.nativeCore !== false} onChange=${(v) => save({ nativeCore: v })}
        label=${t('set.native', 'Fast player for DS, GBA and Game Boy')}
        hint=${t('set.nativeHint', 'Runs the game with the real emulators (melonDS, mGBA, SameBoy) directly on your computer: full speed even on weaker PCs, and fast-forward that really reaches 4× and more. Live sync, cheats, save states and the in-game save work as before. Save states from the other player can’t be loaded here (and the other way round). Off: the browser emulator as before. Applies to the next game you start.')} /><//>
      <${Item} id="engine" when=${!!status?.native?.engine && cfg.nativeCore !== false}><${Check} checked=${cfg.nativeEngine === true} onChange=${(v) => save({ nativeEngine: v })}
        label=${t('set.engine', 'souldew engine (beta)')}
        hint=${t('set.engineHint', 'The fast player on souldew’s own engine: one player for DS, GBA and Game Boy that trades and battles straight from your running game – your partners join it, nobody’s game restarts. Same speed, save states, cheats and live sync as the fast player. Off: the fast player as before. Applies to the next game you start.')} /><//>
    <//>`}`;
}
