// What each membership gets for the launch animation, in plain words (owner's decision 18.11.26, shared/handheld.mjs
// launchRights) – on the souldew+ page and in "What souldew+ holds" (Settings › Account). `current`: the viewer's
// launch tier ('free' | 'supporter' | 'member'), marked "Yours".
import { html } from '/vendor/htm-preact.mjs';
import { t } from '../lib/i18n.mjs';
import { Icon } from '../lib/icons.mjs';
import { STICKERS, WRAPS } from '/shared/handheld.mjs';

export function launchTierRows() {
  const plusStickers = STICKERS.filter((s) => s.tier === 'plus').length;
  const freeStickers = STICKERS.filter((s) => s.tier === 'free').length;
  const plusSkins = WRAPS.filter((w) => w.tier === 'plus').length;
  return [
    ['free', t('launch.tierFree', 'Free'), t('launch.tierFreeWhat', 'The cartridge slides into the console (2D) – on or off.')],
    ['supporter', t('acct.supporter', 'Supporter'), t('launch.tierSupWhat', 'Your own handheld in 3D, in your theme’s colours – Full, Quick or Off. Dress it with the Plain Dusk skin, the {n} free stickers and the ones you earn; one saved design.', { n: freeStickers })],
    ['member', t('launch.tierPlus', 'souldew+ and Legend'), t('launch.tierPlusWhat', 'Everything: Gold, Clear shell and Holo label, {skins} more skins, {stickers} more stickers, holo and glitter, up to 12 designs, Surprise me at start – and now and then a Rare start.', { skins: plusSkins, stickers: plusStickers })],
  ];
}

export function LaunchTiers({ current = null, title = true }) {
  return html`<div class="launch-tiers stack-s">
    ${title && html`<span class="launch-title">${t('launch.byTier', 'The launch animation, by tier')}</span>`}
    <ul class="launch-tiers-list" role="list">${launchTierRows().map(([id, name, what]) => html`<li key=${id} class=${`launch-tier ${current === id ? 'yours' : ''}`}>
      <b>${name}${current === id && html` <span class="plus-yours"><${Icon} name="check" size=${11} />${t('plus.yours', 'Yours')}</span>`}</b><span class="small muted">${what}</span></li>`)}</ul>
  </div>`;
}
