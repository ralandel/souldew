// Settings › Play › Launch animation – what it holds follows the membership (shared/handheld.mjs launchRights):
// - free (signed out, or no paid tier): the 2D animation – the module slides into the console (views/cartinsert.mjs) –
//   On / Off (it has no Quick form), a preview, and one quiet line that the 3D one comes with Supporter or souldew+;
// - Supporter and souldew+ (design round 6): the launch family – "Your colours" and the souldew+ shells, Gold, Clear
//   shell (four colours) and Holo label – with Full / Quick / Off, and under the choice the device it plays with: "Your
//   handheld" – a still of it, its sticker counts per device, "Dress your handheld" (the editor, web/views/handheld.mjs)
//   and "Preview". Rare start isn't a pick and has no switch: one start in 64 is one, for souldew+ members.
// A membership that ends keeps every choice here; what plays is what the tier allows now.
import { html, useState, useEffect, useRef } from '/vendor/htm-preact.mjs';
import { t } from '../../lib/i18n.mjs';
import { useApp } from '../../lib/ui.mjs';
import { packState } from '../../lib/cosmetics/index.mjs';
import { useCosmetics, PlusMark } from '../../lib/cosmetics/components.mjs';
import { openPlus } from '../../lib/cosmetics/plus.mjs';
import { Icon } from '../../lib/icons.mjs';
import { FavScope } from '../../lib/favourites.mjs';
import { LAUNCH_LOOKS, CLEAR_TINTS, STICKER_MAX, STICKERS, wrapById, launchLook, playableLookFor } from '/shared/handheld.mjs';
import { useHandheld, launchConfig, CLEAR, useCosmeticsTick, useLaunchRights, ownedLook } from '../../lib/handheld/look.mjs';
import { placeholderCanvas } from '../../lib/handheld/placeholder.mjs';
import { CartInsert } from '../cartinsert.mjs';
import { LaunchPreview } from '../launchstage.mjs';
import { DEVICE_TABS, devName, lookName } from '../handheld.mjs';
import { HandheldStillImg } from '../handheldtile.mjs';

export const launchNames = () => ({
  'your-colours': [t('launch.yourColours', 'Your colours'), t('launch.yourColoursHint', 'Your handheld in your theme’s colours – or its skin')],
  'clear-shell': [t('launch.clear', 'Clear shell'), t('launch.clearHint', 'See-through plastic, the board lit inside')],
  gold: [t('launch.gold', 'Gold'), t('launch.goldHint', 'A gold shell and a gold cartridge')],
  holo: [t('launch.holo', 'Holo label'), t('launch.holoHint', 'A holographic label on the cartridge')],
});
const clearName = (k) => ({ atomic: t('launch.clearAtomic', 'Atomic purple'), smoke: t('launch.clearSmoke', 'Smoke'), ice: t('launch.clearIce', 'Ice'), jungle: t('launch.clearJungle', 'Jungle') })[k];

/** Settings › Play › Launch animation. */
export function LaunchSetting({ cfg, save }) {
  useCosmetics();
  const R = useLaunchRights();
  if (!R.three) return html`<${LaunchSetting2D} cfg=${cfg} save=${save} />`;
  return html`<${LaunchSetting3D} cfg=${cfg} save=${save} R=${R} />`;
}

/** Free: the 2D module – On / Off and a preview; a quiet line about the 3D one. Nothing to pick, nothing locked. */
function LaunchSetting2D({ cfg, save }) {
  const { navigate } = useApp();
  const L = launchConfig(cfg);
  const on = L.pace !== 'off';
  const animsOff = cfg.bootAnimation === false;
  const [playing, setPlaying] = useState(0);
  const screen = useRef(null);
  useEffect(() => {
    const src = placeholderCanvas('gba');
    const cv = screen.current;
    cv.width = src.width;
    cv.height = src.height;
    cv.getContext('2d').drawImage(src, 0, 0);
  }, []);
  // On keeps a pace chosen earlier (a Supporter's Quick comes back with the 3D one); Off is Off for both
  const set = (v) => save({ launchPace: v ? (L.pace === 'off' ? 'full' : L.pace) : 'off' });
  return html`<div class="stack-s launch-setting launch-2d">
    <div class="row launch-head"><span class="launch-title">${t('launch.title', 'Launch animation')}</span><span class="spacer"></span>
      <div class="seg small" role="radiogroup" aria-label=${t('launch.title', 'Launch animation')}>${[[true, t('launch.on', 'On')], [false, t('launch.offPace', 'Off')]].map(([v, n]) => html`<button type="button"
        role="radio" aria-checked=${on === v} class=${on === v ? 'on' : ''} onClick=${() => set(v)}>${n}</button>`)}</div></div>
    <div class="launch-picker">
      <div class="stack-s">
        <b class="launch-2d-name">${t('launch.cartridge', 'Cartridge')}</b>
        <span class="small muted">${t('launch.cartridgeHint2', 'The module drops into the console’s slot and clicks in while the game starts – it never makes the game wait. A click or any key skips it.')}</span>
        <span class="small faint">${animsOff ? t('launch.off', 'Animations are switched off (General › Play animations) – the game starts without one.')
          : !on ? t('launch.offHint', 'Off: the game starts without an animation.') : t('launch.reduced2d', 'With reduced motion (your system’s setting) it doesn’t play – the module just clicks in when the game appears.')}</span>
        <span class="small faint plus-note"><${PlusMark} /> ${t('launch.threeFree', 'Your own handheld in 3D as the launch animation comes with Supporter or souldew+.')}
          ${' '}<a href="#/plus" onClick=${(e) => { e.preventDefault(); navigate('plus'); }}>${t('launch.seeTiers', 'What each tier gets')}</a></span>
      </div>
      <div class="launch-stage">
        <div class="launch-screen" aria-hidden="true"><canvas ref=${screen}></canvas>
          ${playing > 0 && html`<${CartInsert} key=${playing} target=${{ system: 'gba', label: 'souldew', params: {} }} sound=${false} onDone=${() => setPlaying(0)} />`}</div>
        <button type="button" class="btn small ghost" onClick=${() => setPlaying((n) => n + 1)}><${Icon} name="play" size=${14} />${t('launch.preview', 'Preview')}</button>
      </div>
    </div>
  </div>`;
}

/** Supporter and souldew+: the 3D launch family and "Your handheld". */
function LaunchSetting3D({ cfg, save, R }) {
  const member = R.plus;
  const L = launchConfig(cfg);
  // the look that plays: a souldew+ look kept from a membership that ended waits – "Your colours" plays and is marked
  const shown = playableLookFor(L.look, R);
  const names = launchNames();
  const [sys, setSys] = useState('nds');
  const [playing, setPlaying] = useState(0);
  const known = LAUNCH_LOOKS.map((l) => l.id);
  const pick = async (id) => {
    if (launchLook(id).tier === 'plus' && !member) return openPlus({ reason: 'launch', id });
    if (id !== cfg.launchAnimation) await save({ launchAnimation: id });
    setPlaying((n) => n + 1);
  };
  const animsOff = cfg.bootAnimation === false;
  const paces = [['full', t('launch.full', 'Full')], ['quick', t('launch.quick', 'Quick')], ['off', t('launch.offPace', 'Off')]];
  return html`<div class="stack-s launch-setting">
    <div class="row launch-head"><span class="launch-title">${t('launch.title', 'Launch animation')}</span><span class="spacer"></span>
      <div class="seg small" role="radiogroup" aria-label=${t('launch.length', 'Length')}>${paces.map(([k, n]) => html`<button type="button" role="radio" aria-checked=${L.pace === k}
        class=${L.pace === k ? 'on' : ''} onClick=${() => save({ launchPace: k })}>${n}</button>`)}</div></div>
    <div class="launch-cards hhs-cards" role="radiogroup" aria-label=${t('launch.title', 'Launch animation')}>
      ${LAUNCH_LOOKS.map((l) => html`<${FavScope} key=${l.id} kind="launch" id=${l.id} name=${names[l.id][0]} known=${known} class="launch-fav"><button type="button" role="radio"
        aria-checked=${l.id === shown} class=${`launch-card${l.id === shown ? ' on' : ''}`} onClick=${() => pick(l.id)}>
        <b>${names[l.id][0]}</b><span class="hint">${names[l.id][1]}</span>${l.tier === 'plus' && !member && html`<${PlusMark} />`}
        ${l.id === 'clear-shell' && html`<span class="hhs-tints" role="radiogroup" aria-label=${t('launch.clearColour', 'Colour of the shell')}>${Object.keys(CLEAR_TINTS).map((k) => html`<span role="radio" tabIndex=${member ? 0 : -1}
          aria-checked=${L.clear === k} title=${clearName(k)} aria-label=${clearName(k)} class=${`hhs-tint ${L.clear === k ? 'on' : ''}`} style=${`--tc:${CLEAR[k]}`}
          onClick=${(e) => { e.stopPropagation(); if (member) save({ launchAnimation: 'clear-shell', launchClear: k }).then(() => setPlaying((n) => n + 1)); else openPlus({ reason: 'launch', id: 'clear-shell' }); }}
          onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}></span>`)}</span>`}
      </button><//>`)}
    </div>
    <span class="small faint">${animsOff ? t('launch.off', 'Animations are switched off (General › Play animations) – the game starts without one.')
      : L.pace === 'off' ? t('launch.offHint', 'Off: the game starts without an animation.')
        : t('launch.hint3', 'Plays over the game screen while the game starts – it never makes the game wait, and it is silent. A click or any key skips it. With reduced motion (your system’s setting) it is a short fade, with your handheld in it.')}</span>
    ${shown !== L.look && !packState().loading && html`<span class="small faint">${t('launch.waits', '{look} is kept for when you have souldew+ – until then “Your colours” plays.', { look: names[L.look][0] })}</span>`}
    ${member ? html`<span class="small faint">${t('launch.rare', 'souldew+: one start in 64 is a Rare start – golden light, glints and a little dust.')}</span>`
      : html`<span class="small faint plus-note"><${PlusMark} /> ${t('launch.more3', 'Gold, Clear shell, Holo label and the Rare start come with souldew+.')}</span>`}
    <${HandheldRow} cfg=${cfg} R=${R} sys=${sys} setSys=${setSys} play=${playing} onPreview=${() => setPlaying((n) => n + 1)} />
  </div>`;
}

/** "Your handheld" under the choice: a still of it, the device tabs, what it wears, the way into the editor. */
function HandheldRow({ cfg, R, sys, setSys, play, onPreview }) {
  useCosmeticsTick();
  const { navigate } = useApp();
  const doc = useHandheld();
  const L = launchConfig(cfg);
  const V = launchLook(playableLookFor(L.look, R)); // a souldew+ shell without souldew+: the still shows what the launch plays
  const shellOnly = V.look === 'clear' || V.look === 'gold';
  // what it wears right now (a Supporter: the free skin, the free and the earned stickers; souldew+ items only with
  // souldew+) – the handheld keeps the rest, and says so when a souldew+ skin or sticker waits
  const own = ownedLook(doc, R);
  const skin = wrapById(own.skin);
  const withPlus = R.plus ? own : ownedLook(doc, { ...R, plus: true });
  const kept = own.skin !== withPlus.skin || Object.keys(withPlus.stickers).some((d) => (withPlus.stickers[d] || []).length !== (own.stickers[d] || []).length);
  const n = (d) => (own.stickers[d] || []).length;
  const active = doc.designs.find((d) => d.id === doc.active);
  const [showing, setShowing] = useState(false);
  const first = useRef(play);
  useEffect(() => { if (play !== first.current) setShowing(true); }, [play]);
  return html`<div class="hhs-hand">
    <div class="hhs-still">${showing ? html`<${LaunchPreview} key=${`${play}-${sys}`} cfg=${L} system=${sys} onDone=${() => setShowing(false)} />`
      : html`<${HandheldStillImg} sys=${sys} look=${V.look} skin=${own.skin} stickers=${own.stickers[sys] || []} w=${340} h=${210} />`}</div>
    <div class="hhs-text stack-s">
      <h3>${t('hh.title', 'Your handheld')}</h3>
      <span class="small muted">${t('hh.lead', 'The device your launch animation plays with. One skin for all of them, stickers for each – up to {n}. Only you see it: it isn’t on your profile.', { n: STICKER_MAX })}</span>
      <div class="hh-devs hhs-devs" role="tablist" aria-label=${t('hh.device', 'Handheld')}>${DEVICE_TABS.map((id) => html`<button type="button" role="tab"
        aria-selected=${sys === id} class=${`hh-dev ${sys === id ? 'on' : ''}`} onClick=${() => { setSys(id); setShowing(false); }}>${devName(id)}${n(id) ? html`<span class="hh-dev-n">${n(id)}</span>` : ''}</button>`)}</div>
      <span class="small">${devName(sys)} · ${shellOnly ? t('hh.onShell', '{shell} (no skin on it)', { shell: lookName(V.id) }) : skin ? skin.name : t('hh.themeColour', 'your theme colour')} · ${n(sys)
        ? t('hh.stickerCount', 'one sticker|{count} stickers', { count: n(sys) }) : t('hh.noStickers', 'no stickers yet')}</span>
      ${doc.designs.length > 0 && html`<span class="small faint">${t('hh.designCount', 'one saved design|{count} saved designs', { count: doc.designs.length })}${R.surprise && doc.surprise && doc.designs.length > 1
        ? ` · ${t('hh.surpriseOn', 'Surprise me at start: a different one each launch')}` : active ? ` · ${t('hh.wearing', 'wearing “{name}”', { name: active.name })}` : ''}</span>`}
      ${!R.plus && R.tier === 'supporter' && html`<span class="small faint">${t('hh.supporterHas', 'With Supporter: the Plain Dusk skin, the {n} free stickers, the earned ones and one saved design.', { n: STICKERS.filter((s) => s.tier === 'free').length })}</span>`}
      ${kept && !packState().loading && html`<span class="small faint">${t('hh.keptPlus', 'Your souldew+ skin and stickers are kept – they’re back on it as soon as souldew+ is active on this computer again.')}</span>`}
      ${shellOnly && skin && html`<span class="small faint">${t('hh.shellNote2', '{skin} shows with “Your colours” and Holo label; with {shell}, your stickers do.', { skin: skin.name, shell: lookName(V.id) })}</span>`}
      <div class="hhs-btns"><button type="button" class="btn primary" onClick=${() => navigate('handheld', { sys })}>${t('hh.dress', 'Dress your handheld')}</button>
        <button type="button" class="btn ghost" disabled=${L.off && cfg.bootAnimation === false} onClick=${onPreview}><${Icon} name="play" size=${14} />${t('launch.preview', 'Preview')}</button></div>
    </div>
  </div>`;
}

