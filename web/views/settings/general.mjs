// Settings › General: language, name, the interface size, start-up animations, app sounds, the welcome tour, the colour
// scheme and the souldew+ theme.
import { html, useState, useEffect } from '/vendor/htm-preact.mjs';
import { t, LANGS, setLang, currentLang } from '../../lib/i18n.mjs';
import { applyTheme } from '../../lib/theme.mjs';
import { Item, Group, Check } from './parts.mjs';
import { SkinSetting } from './cosmetics.mjs';
import { ShowFirstStepsButton } from '../firststeps.mjs';
import { WHATS_NEW_EVENT } from '../../lib/whatsnew.mjs';
import { UI_SCALES, uiScaleLabel, uiScaleKey } from '/shared/uiscale.mjs';
import { useUiScale, setUiScale, uiScaleNative, uiScaleKeys } from '../../lib/uiscale.mjs';
import { resolveHotkeys, HOTKEY_IDS } from '../../lib/controls.mjs';
import { IS_MAC } from '../../lib/platform.mjs';
import { hotkeyLabel } from '../guide.mjs';

const THEMES = () => [
  ['classic', t('theme.classic', 'Classic'), t('theme.classicHint', 'Dark, the original colours')],
  ['contrast', t('theme.contrast', 'High contrast'), t('theme.contrastHint', 'Black background, brighter text and edges')],
  ['deutan', t('theme.deutan', 'Red-green safe'), t('theme.deutanHint', 'For deuteranopia / protanopia: blue and orange instead of green and red')],
  ['tritan', t('theme.tritan', 'Blue-yellow safe'), t('theme.tritanHint', 'For tritanopia: teal and magenta instead of blue and yellow')],
];

/** Colour scheme cards (Settings and the welcome tour); a pick applies at once. */
export function ThemePicker({ value, onPick }) {
  const cur = value || 'classic';
  return html`<div class="theme-picker" role="radiogroup" aria-label=${t('set.theme', 'Colour scheme')}>
    ${THEMES().map(([id, name, hint]) => html`<button type="button" role="radio" aria-checked=${cur === id}
      class=${`theme-card ${cur === id ? 'on' : ''}`} data-theme-preview=${id} onClick=${() => { applyTheme(id); onPick(id); }}>
      <span class="theme-swatches" aria-hidden="true"><i class="sw ok"></i><i class="sw bad"></i><i class="sw warn"></i><i class="sw p1"></i><i class="sw p2"></i><i class="sw p3"></i><i class="sw p4"></i><i class="sw p5"></i><i class="sw p6"></i><i class="sw p7"></i><i class="sw p8"></i></span>
      <b>${name}</b><span class="hint">${hint}</span></button>`)}
  </div>`;
}

function NameField({ cfg, save }) {
  const [name, setName] = useState(cfg.playerName || '');
  useEffect(() => setName(cfg.playerName || ''), [cfg.playerName]);
  const changed = name.trim() !== (cfg.playerName || '');
  return html`<label class="field"><span>${t('set.name', 'Your name')}</span>
    <div class="row nowrap"><input type="text" class="grow" value=${name} maxLength="20" onInput=${(e) => setName(e.target.value)}
      onKeyDown=${(e) => e.key === 'Enter' && changed && save({ playerName: name.trim() })} />
    <button class="btn" disabled=${!changed} onClick=${() => save({ playerName: name.trim() })}>${t('common.save', 'Save')}</button></div></label>`;
}

/**
 * Interface size (lib/uiscale.mjs): 80–175 %, applied at once. Says when the window is too small for the size picked
 * (it shows a smaller one until it grows) and which game shortcuts keep ⌘+ / ⌘− / ⌘0 while a game fills the window.
 */
function UiScaleSetting({ cfg }) {
  const s = useUiScale();
  const label = t('set.uiScale', 'Interface size');
  const keys = uiScaleKeys();
  if (!uiScaleNative()) {
    return html`<div class="field"><span>${label}</span>
      <span class="small faint">${t('set.uiScaleBrowser', 'In the browser, its own zoom sizes souldew: {bigger} and {smaller}.', keys)}</span></div>`;
  }
  const hot = resolveHotkeys(cfg.controls);
  const game = HOTKEY_IDS.filter((id) => hot[id].some((c) => uiScaleKey(c, IS_MAC)));
  return html`<div class="field ui-scale"><span id="ui-scale-label">${label}</span>
    <div class="seg ui-scale-seg" role="radiogroup" aria-labelledby="ui-scale-label">
      ${UI_SCALES.map((v) => html`<button type="button" role="radio" aria-checked=${s.chosen === v} class=${s.chosen === v ? 'on' : ''}
        onClick=${() => setUiScale(v)}>${uiScaleLabel(v)}</button>`)}
    </div>
    <span class="small faint">${t('set.uiScaleHint', 'How big souldew draws its menus, panels, the board and text on this computer – for big, sharp screens. The game itself isn’t scaled: it keeps filling the room it has, pixel-sharp. {bigger}, {smaller} and {reset} change it anywhere.', keys)}</span>
    ${s.applied !== s.chosen && html`<span class="small warn-text">${t('set.uiScaleFit', 'This window has room for {size} – make it larger and it grows to {chosen}.', { size: uiScaleLabel(s.applied), chosen: uiScaleLabel(s.chosen) })}</span>`}
    ${game.length > 0 && html`<span class="small faint">${t('set.uiScaleGame', 'While a game fills the window, these keys stay its shortcuts: {list} (Settings › Controls).', { list: game.map((id) => hotkeyLabel(id)).join(', ') })}</span>`}
  </div>`;
}

export function GeneralSection({ cfg, save }) {
  return html`
    <${Group} title=${t('set.basics', 'Basics')}>
      <div class="grid-2">
        <${Item} id="language"><label class="field"><span>${t('set.language', 'Language')}</span>
          <select value=${currentLang()} onChange=${async (e) => { await setLang(e.target.value); await save({ lang: e.target.value }); }}>
            ${LANGS.map((l) => html`<option value=${l.id}>${l.native}</option>`)}</select></label><//>
        <${Item} id="name"><${NameField} cfg=${cfg} save=${save} /><//>
      </div>
      <${Item} id="ui-scale"><${UiScaleSetting} cfg=${cfg} /><//>
      <${Item} id="animations"><${Check} checked=${cfg.bootAnimation !== false} onChange=${(v) => save({ bootAnimation: v })}
        label=${t('set.boot', 'Play animations (start-up, inserting the cartridge)')} /><//>
      <${Item} id="sounds"><${Check} checked=${cfg.sounds !== false} onChange=${(v) => save({ sounds: v })}
        label=${t('set.soundsAll', 'Sounds on this computer (start-up chime, catches, deaths, badges, pings)')} /><//>
      <${Item} id="tour"><div class="row"><button class="btn ghost small" onClick=${() => save({ onboarded: false })}>${t('set.replayOnboarding', 'Show the welcome tour again')}</button>
        <${ShowFirstStepsButton} />
        <button class="btn ghost small" onClick=${() => dispatchEvent(new Event(WHATS_NEW_EVENT))}>${t('wn.open', 'What’s new in 3.0')}</button></div><//>
    <//>
    <${Group} title=${t('set.appearance', 'Appearance')} note=${t('set.themeText', 'Colour scheme of the whole app. The colour-blind schemes replace the green/red signals (alive, dead, warnings) with colours that stay apart with that colour vision.')}>
      <${Item} id="theme"><${ThemePicker} value=${cfg.theme} onPick=${(id) => save({ theme: id })} /><//>
      <${Item} id="skin"><${SkinSetting} cfg=${cfg} save=${save} /><//>
    <//>`;
}
