// The souldew+ page's launch animations (owner's round on 3.0, 19.11.26): ONE row of cards – the free 2D Cartridge,
// "Your colours" (Supporter) and the souldew+ shells Gold, Clear shell and Holo label – each showing the animation
// instead of describing it, its tier on the card, and exactly one of them selected. Selected first is the one that plays
// for you now; picking another shows it (the loop plays in its card) and says what it is for you: in use, "Use it" (you
// may: Supporter / souldew+ – it is the same setting as Settings › Play › Launch animation), or what it comes with. The
// Clear shell's four colours are its own small choice under its card. The tiers used to be a second row of cards
// (launchtiers.mjs – still in "What souldew+ holds"); here every card carries its tier instead.
//
// What a card shows, best first: the previews' loop and still of that look (launch/<id>.webp|png – public pictures,
// rendered from the real launch code: scripts/handheld/launch-shots.mjs); else the real launch scene where this computer
// can draw it ("Your colours" always, the souldew+ shells with the pack): a still, and the launch itself playing in the
// selected card; else the still that ships with the app (web/assets/handheld/launch/ – the same public pictures, until
// the previews carry the looks); the 2D Cartridge is its own module, live. Reduced motion: stills only.
import { html, useEffect, useRef, useState } from '/vendor/htm-preact.mjs';
import { t } from '../lib/i18n.mjs';
import { Icon } from '../lib/icons.mjs';
import { useApp } from '../lib/ui.mjs';
import { api } from '../lib/api.mjs';
import { PlusMark, useCosmetics } from '../lib/cosmetics/components.mjs';
import { previewSrc, usePreviews } from '../lib/cosmetics/previews.mjs';
import { prefersReduced } from '../lib/cosmetics/motion.mjs';
import { CLEAR_TINTS, launchLook, playableLookFor } from '/shared/handheld.mjs';
import { LOOK_CARDS, lookInUse, lookUsable, lookMedia, shippedStill } from '../lib/handheld/pluspicks.mjs';
import { launchConfig, useLaunchRights, paidLooks, CLEAR, useCosmeticsTick } from '../lib/handheld/look.mjs';
import { hasLook } from '../lib/handheld/looks.mjs';
import { placeholderCanvas } from '../lib/handheld/placeholder.mjs';
import { launchNames } from './settings/launch.mjs';
import { HandheldStillImg } from './handheldtile.mjs';
import { CartInsert } from './cartinsert.mjs';
import { LaunchPreview } from './launchstage.mjs';

const tierName = (tier) => ({ free: t('launch.tierFree', 'Free'), supporter: t('acct.supporter', 'Supporter'), plus: t('rail.plus', 'souldew+') })[tier];
const clearName = (k) => ({ atomic: t('launch.clearAtomic', 'Atomic purple'), smoke: t('launch.clearSmoke', 'Smoke'), ice: t('launch.clearIce', 'Ice'), jungle: t('launch.clearJungle', 'Jungle') })[k];

/** The 2D module: the console screen, and the cartridge clicking in again and again while `playing`. */
function CartridgeArt({ playing }) {
  const ref = useRef(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    const src = placeholderCanvas('gba');
    const cv = ref.current;
    cv.width = src.width;
    cv.height = src.height;
    cv.getContext('2d').drawImage(src, 0, 0);
  }, []);
  useEffect(() => { if (!playing) setN(0); else if (!n) setN(1); }, [playing]);
  const again = () => setTimeout(() => setN((x) => (x ? x + 1 : 0)), 1100);
  // still: the same module held at the moment it is home (plus.css .plus-look-cart.still)
  const target = { system: 'gba', label: 'souldew', params: {} };
  return html`<div class=${`launch-screen plus-look-cart ${playing && n > 0 ? '' : 'still'}`} aria-hidden="true"><canvas ref=${ref}></canvas>
    ${playing && n > 0 ? html`<${CartInsert} key=${n} target=${target} sound=${false} onDone=${again} />` : html`<${CartInsert} key="still" target=${target} sound=${false} onDone=${() => {}} />`}</div>`;
}

/** The real launch in a card, over and over (a short rest between). */
function LaunchLoop({ look, tint }) {
  const [n, setN] = useState(1);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  return html`<${LaunchPreview} key=${n} cfg=${{ look, pace: 'full', clear: tint || 'atomic', off: false }} system="gba"
    onDone=${() => { timer.current = setTimeout(() => setN((x) => x + 1), 1200); }} />`;
}

/** A card's picture (see the head of this file for what it shows when). */
function LookArt({ id, tint, playing, hover, R }) {
  useCosmeticsTick();
  usePreviews();
  const reduced = prefersReduced();
  const loop = (playing || hover) && !reduced; // pictures and the 2D module loop while pointed at too; the 3D launch only selected
  if (id === 'cartridge') return html`<${CartridgeArt} playing=${loop} />`;
  const name = lookMedia(id, tint);
  const media = previewSrc('launch', name, { loop }) || (id === 'clear-shell' ? previewSrc('launch', 'clear-shell', { loop }) : null);
  if (media) return html`<img class="plus-look-media" src=${media} alt="" loading="lazy" decoding="async" draggable="false" />`;
  if (!hasLook(id, paidLooks())) {
    const still = shippedStill(name);
    if (still) return html`<img class="plus-look-media" src=${still} alt="" loading="lazy" decoding="async" draggable="false" />`;
    return html`<span class="plus-look-none"><${PlusMark} title="" /><span class="small">${t('plus.lookNoPreview', 'Preview not available right now')}</span></span>`;
  }
  // the launch plays only what this account may play (LaunchStage): live only when that is this card's look
  if (playing && !reduced && playableLookFor(id, R) === id) return html`<${LaunchLoop} look=${id} tint=${tint} />`;
  const V = launchLook(id);
  return html`<${HandheldStillImg} sys="gba" view="back" look=${V.look} cartLook=${V.cart} clear=${tint || undefined} w=${320} h=${200} zoom=${1.05} class="plus-look-still" />`;
}

/** The section's body: one row of cards, the selected one's line, the Rare start. */
export function LaunchLooks() {
  useCosmetics();
  const { status, reloadStatus, toast } = useApp();
  const R = useLaunchRights();
  const L = launchConfig(status?.config);
  const use = lookInUse(R, L);
  const [sel, setSel] = useState(use.id);
  const [tint, setTint] = useState(use.tint || L.clear);
  const [hot, setHot] = useState(null);
  const names = { ...launchNames(), cartridge: [t('launch.cartridge', 'Cartridge'), t('launch.cartridgeHint3', 'The module slides into the console’s slot and clicks in – in 2D')] };
  const tier = LOOK_CARDS.find(([id]) => id === sel)?.[1] || 'free';
  const inUse = sel === use.id && (sel !== 'clear-shell' || tint === use.tint);
  const usable = lookUsable(sel, R);
  const save = async () => {
    try {
      await api.post('/api/config', { launchAnimation: sel, ...(sel === 'clear-shell' ? { launchClear: tint } : {}) });
    } catch (e) {
      toast?.({ kind: 'death', title: t('set.saveFailed', 'Couldn’t save the setting'), text: e.message });
    }
    await reloadStatus?.();
  };
  const status1 = inUse && L.off ? html`<span class="small muted">${t('plus.lookOff2', 'Yours – but launch animations are switched off (Settings › Play)')}</span>`
    : inUse ? html`<span class="plus-look-use"><${Icon} name="check" size=${12} />${t('plus.lookInUse', 'Plays when your games start')}</span>`
    : usable ? html`<button type="button" class="btn small" onClick=${save}>${t('plus.lookUse', 'Use it for my games')}</button>`
      : sel === 'cartridge' ? html`<span class="small muted">${t('plus.lookCartFor', 'What plays without a membership')}</span>`
        : html`<span class="small muted">${tier === 'plus' ? t('plus.lookPlusPreview', 'Comes with souldew+ – this is a preview') : t('plus.lookSupPreview', 'Comes with Supporter and souldew+ – this is a preview')}</span>`;
  return html`<div class="plus-looks-wrap">
    <div class="plus-looks" role="radiogroup" aria-label=${t('plus.kLaunch', 'Launch animations')}>
      ${LOOK_CARDS.map(([id, tr]) => {
        const on = sel === id;
        const locked = tr === 'plus' ? !R.plus : tr === 'supporter' ? !R.three : false;
        return html`<div key=${id} class=${`plus-look ${on ? 'on' : ''}`} onPointerEnter=${() => setHot(id)} onPointerLeave=${() => setHot((h) => (h === id ? null : h))}>
          <button type="button" role="radio" aria-checked=${on} class="plus-look-pick" onClick=${() => setSel(id)}
            aria-label=${`${names[id][0]} · ${tierName(tr)}${on && locked ? ` · ${t('plus.lookPreviewShort', 'preview')}` : ''}`}>
            <span class="plus-look-art"><${LookArt} id=${id} tint=${id === 'clear-shell' ? tint : null} playing=${on} hover=${hot === id} R=${R} />
              ${on && html`<span class="plus-look-check" aria-hidden="true"><${Icon} name="check" size=${12} /></span>`}</span>
            <span class="plus-look-cap"><b>${names[id][0]}</b><span class=${`plus-look-tier t-${tr}`}>${tr === 'plus' && html`<${Icon} name="plus" size=${8} />`}${tierName(tr)}</span></span>
          </button>
          ${id === 'clear-shell' && html`<span class="plus-look-tints" role="radiogroup" aria-label=${t('launch.clearColour', 'Colour of the shell')}>${Object.keys(CLEAR_TINTS).map((k) => html`<button type="button" role="radio"
            aria-checked=${on && tint === k} title=${clearName(k)} aria-label=${clearName(k)} class=${`hhs-tint ${on && tint === k ? 'on' : ''}`} style=${`--tc:${CLEAR[k]}`}
            onClick=${() => { setTint(k); setSel('clear-shell'); }}></button>`)}</span>`}
        </div>`;
      })}
    </div>
    <div class="plus-look-line" aria-live="polite"><b>${names[sel][0]}${sel === 'clear-shell' ? ` · ${clearName(tint)}` : ''}</b>
      <span class="small muted">${names[sel][1]}</span>${status1}</div>
    <p class="small faint plus-look-rare"><${Icon} name="star" size=${11} /> ${t('plus.lookRare', 'With souldew+, one start in 64 is a Rare start – golden light, glints and a little dust. It isn’t a pick: it just happens.')}</p>
  </div>`;
}
