// Settings › About: version and updates, Troubleshooting (graphics backend, 3DS renderer, diagnostics), credits and links.
import { html, useState, useEffect } from '/vendor/htm-preact.mjs';
import { openExternal, saveDiagnostics } from '../../lib/ui.mjs';
import { LINKS } from '../../lib/links.mjs';
import { Icon } from '../../lib/icons.mjs';
import { t, currentLang } from '../../lib/i18n.mjs';
import { api } from '../../lib/api.mjs';
import { PLATFORM } from '../../lib/platform.mjs';
import { gpuBackends } from '/shared/gpu.mjs';
import { UpdateSection } from '../update.mjs';
import { Item, Group, Check } from './parts.mjs';

export const GPU_LABELS = () => ({ auto: t('set.gpuAuto', 'Automatic'), d3d11: 'Direct3D 11', vulkan: 'Vulkan', gl: 'OpenGL' });

/**
 * Graphics backend (Windows and Linux, desktop app only – shared/gpu.mjs): Chromium reads it at start, so a change
 * needs a restart. The app tells which backend this session runs with; while that differs from the saved choice,
 * the hint with "Restart now" stays.
 */
/** The graphics backend can be picked here at all (the desktop app on Windows or Linux). */
export const hasGpuChoice = () => typeof window.sls?.gpuInfo === 'function' && gpuBackends(PLATFORM).length > 1;

function GraphicsSetting({ cfg, save }) {
  const [active, setActive] = useState(null);
  const [safe, setSafe] = useState(false);
  const native = hasGpuChoice();
  useEffect(() => {
    if (native) {
      window.sls.gpuInfo().then((g) => {
        setActive(g?.backend || 'auto');
        setSafe(!!g?.safe);
      }).catch(() => {});
    }
  }, [native]);
  if (!native) return null;
  const value = cfg.gpuBackend || 'auto';
  const labels = GPU_LABELS();
  return html`<div class="stack">
    ${safe && html`<div class="note row" role="status"><span class="grow">${t('set.gpuSafeNote', 'souldew runs in safe graphics mode (software rendering, slower). If the window stays blank in a normal start, pick another graphics backend here – Vulkan or OpenGL often help – then restart normally.')}</span>
      <button class="btn small" onClick=${() => window.sls.relaunch?.()}>${t('set.gpuSafeRestart', 'Restart normally')}</button></div>`}
    <div class="grid-2"><label class="field"><span>${t('set.gpu', 'Graphics backend')}</span>
      <select value=${value} onChange=${(e) => save({ gpuBackend: e.target.value })}>
        ${gpuBackends(PLATFORM).map((b) => html`<option value=${b}>${labels[b]}</option>`)}</select></label></div>
    <span class="small faint">${t('set.gpuHint', 'If the game stutters or the sound crackles, try Vulkan. Automatic lets the system decide.')}</span>
    ${!safe && active && active !== value && html`<div class="note row" role="status"><span class="grow">${t('set.gpuRestart', 'The new graphics backend is used after a restart of souldew.')}</span>
      <button class="btn small" onClick=${() => window.sls.relaunch?.()}>${t('upd.restart', 'Restart now')}</button></div>`}
  </div>`;
}

/** The 3DS renderer's names (server/lib/ctrrenderer.mjs). */
export const CTR_RENDERER_LABELS = () => ({
  auto: t('set.ctrRendererAuto', 'Automatic'),
  vulkan: 'Vulkan',
  compat: t('set.ctrRendererCompat', 'Vulkan (compatibility)'),
  software: t('set.ctrRendererSoftware', 'Software'),
});

/**
 * How the built-in 3DS player draws. "Automatic" starts with Vulkan and steps down by itself when a graphics driver
 * can't run it (remembered for that card and driver); the others are fixed.
 */
function CtrRendererSetting({ cfg, status, save }) {
  if (!status?.ctr?.ok) return null;
  const value = cfg.ctrRenderer || 'auto';
  const labels = CTR_RENDERER_LABELS();
  const now = status.ctr.renderer;
  return html`<div class="stack-s">
    <div class="grid-2"><label class="field"><span>${t('set.ctrRenderer', '3DS renderer')}</span>
      <select value=${value} onChange=${(e) => save({ ctrRenderer: e.target.value })}>
        ${['auto', 'vulkan', 'compat', 'software'].map((m) => html`<option value=${m}>${labels[m]}</option>`)}</select></label></div>
    <span class="small faint">${t('set.ctrRendererHint', 'How souldew’s built-in 3DS player draws the game. Automatic starts with Vulkan; if the game stops right after starting, it switches to Vulkan (compatibility) and then to Software, and remembers that for this graphics card and driver. Software works on every PC but is much slower. Applies to the next 3DS game you start.')}</span>
    ${value === 'auto' && now && now !== 'vulkan' && html`<span class="small muted" role="status">${t('set.ctrRendererLearned', 'This graphics card currently plays 3DS games with: {mode}', { mode: labels[now] || now })}</span>`}
  </div>`;
}

/** The notice after souldew put the graphics backend back to "Automatic" itself (shown once, see app.mjs). */
export function gpuFallbackText(notice) {
  const backend = GPU_LABELS()[notice.from] || notice.from;
  return notice.reason === 'gpu-crash'
    ? t('set.gpuFallbackCrash', 'The graphics backend {backend} kept crashing. souldew uses “Automatic” again from the next start – you can change it in Settings.', { backend })
    : t('set.gpuFallbackStart', 'souldew didn’t open with the graphics backend {backend}, so it uses “Automatic” again. You can change it in Settings.', { backend });
}

const mb = (n) => `${Math.max(1, Math.round((Number(n) || 0) / 1048576)).toLocaleString(currentLang())} MB`;

/**
 * The backup souldew made before the first start of this major version (server/lib/upgrade.mjs) – where it is, or why
 * there is none. It stays until the player deletes the folder.
 */
function BackupNote({ backup }) {
  const [error, setError] = useState(null);
  if (!backup) return null;
  if (backup.skipped) {
    return html`<p class="small muted" role="status">${backup.skipped === 'space'
      ? t('set.backupNoSpace', 'souldew didn’t make a backup before 3.0: the disk had {free} free, the backup needs {need} and leaves room for your games. Your data is as it was – nothing was changed for lack of space.', { free: mb(backup.free), need: mb(backup.need) })
      : t('set.backupFailed', 'souldew couldn’t make a backup before 3.0. Your data is as it was.')}</p>`;
  }
  const date = backup.at ? new Date(backup.at).toLocaleDateString(currentLang(), { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const open = async () => {
    setError(null);
    try {
      await api.post('/api/backup/reveal', {});
    } catch (e) {
      setError(e.message);
    }
  };
  return html`<div class="stack-s">
    <div class="row"><span class="grow small">${t('set.backupMade', 'Before its first start, souldew 3.0 backed up your runs, saves, save states, settings and trophies ({size}, {date}) – not your games, which stay where they are.', { size: mb(backup.bytes), date })}</span>
      <button class="btn small" onClick=${open}><${Icon} name="folder" size=${14} />${t('set.backupOpen', 'Open backup folder')}</button></div>
    <span class="small faint">${t('set.backupHint', 'The folder “{name}” is in the “backups” folder inside souldew’s data folder. souldew never touches it again – delete it once you’re sure you don’t need it.', { name: backup.name || '' })}</span>
    ${error && html`<span class="small warning error" role="alert">${error}</span>`}
  </div>`;
}

/**
 * "Check for updates automatically" (config.json updateCheck, electron/updater.mjs) – the desktop app only, the browser
 * version has no updater. Off: no request at the start or every 4 hours, only "Check for updates" asks. Switched on
 * again, it checks right away.
 */
export function AutoUpdateCheck({ cfg, save }) {
  if (!window.sls?.update) return null;
  const change = async (on) => {
    await save({ updateCheck: on });
    if (on) window.sls.update.check().catch(() => {});
  };
  return html`<${Check} checked=${cfg.updateCheck !== false} onChange=${change}
    label=${t('upd.auto', 'Check for updates automatically')}
    hint=${t('upd.autoHint', 'At start and every 4 hours souldew asks GitHub whether there is a new version – nothing about you is sent. When off, souldew only checks when you click “Check for updates”.')} />`;
}

export function AboutSection({ cfg, status, save }) {
  return html`
    <${Group} title=${t('set.versionUpdates', 'Version & updates')}><${Item} id="updates"><div class="stack-s"><${UpdateSection} /><${AutoUpdateCheck} cfg=${cfg} save=${save} /></div><//>
      <${Item} id="backup" when=${!!status?.upgradeBackup}><${BackupNote} backup=${status?.upgradeBackup} /><//><//>
    <${Group} title=${t('set.trouble', 'Troubleshooting')} note=${t('set.troubleNote', 'Only needed when something doesn’t work – the defaults are right for most computers.')}>
      <${Item} id="gpu" when=${hasGpuChoice()}><${GraphicsSetting} cfg=${cfg} save=${save} /><//>
      <${Item} id="ctr-renderer" when=${!!status?.ctr?.ok}><${CtrRendererSetting} cfg=${cfg} status=${status} save=${save} /><//>
      <${Item} id="diagnostics"><div class="row">
        <button class="btn small" onClick=${() => saveDiagnostics()}><${Icon} name="save" size=${14} />${t('play.diag', 'Save diagnostics')}</button>
        <span class="small faint grow">${t('play.diagHint', 'Saves what souldew recorded about the music and live tracking this session – attach the file to a bug report. No ROM, save or invite data.')}</span></div><//>
    <//>
    <${Group} title="souldew">
      <${Item} id="credits"><div class="stack">
        <dl class="facts small">
          <dt>${t('set.randomizer', 'Randomizer')}</dt><dd>Universal Pokémon Randomizer ZX ${status?.upr?.version} · Java ${status?.java?.version || (status?.java?.crashed ? t('set.javaCrashed', 'crashes on start') : t('set.javaMissing', 'not found'))}${status?.java?.bundled ? ` (${t('set.bundled', 'bundled')})` : ''}</dd>
          <dt>${t('set.data', 'Pokémon data')}</dt><dd>PokeAPI · ${t('set.covers', 'covers')}: libretro-thumbnails</dd>
          <dt>${t('set.emuCore', 'Built-in emulator')}</dt><dd>EmulatorJS (melonDS, DeSmuME, mGBA, Gambatte) · ${t('set.nativeShort', 'Fast player')}: melonDS DS, mGBA, SameBoy (libretro) · 3DS: Azahar (libretro)</dd>
        </dl>
        <div class="row">
          <button class="btn small" onClick=${() => openExternal(LINKS.github)}><${Icon} name="external" size=${14} />${t('set.github', 'souldew on GitHub')}</button>
          <button class="btn small" onClick=${() => openExternal(LINKS.issues)}><${Icon} name="external" size=${14} />${t('set.reportBug', 'Report a bug')}</button>
          <button class="btn small" onClick=${() => openExternal(LINKS.coffee)}><${Icon} name="coffee" size=${14} />${t('rail.coffee', 'Buy me a coffee')}</button>
          <a class="btn small" href="#/thanks"><${Icon} name="heart" size=${14} />${t('thanks.who', 'Who supports souldew')}</a>
        </div>
      </div><//>
      <${Item} id="nag"><${Check} checked=${cfg.nagOff !== true} onChange=${(v) => save({ nagOff: !v })}
        label=${t('set.nag', 'Show the joke license window now and then')}
        hint=${t('set.nagHint', 'A parody of old shareware nag screens. souldew stays free either way.')} /><//>
      <p class="tiny faint set-legal">${t('set.legal', 'Pokémon and all related names are trademarks of Nintendo, Game Freak and The Pokémon Company. souldew is a fan project and does not include or download games.')}</p>
    <//>`;
}
