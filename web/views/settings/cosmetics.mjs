// souldew+ in Settings: the Theme row (General › Appearance, under the colour schemes) – the Launch animation row (Play)
// is settings/launch.mjs. A theme is tried on the whole app with one click and reverts when you leave Settings or press "Back to …";
// it changes the look only, never the layout or a text. The machinery is web/lib/cosmetics (skins.mjs).
// Every theme has its favourite star and the lists their favourites row (lib/favourites.mjs).
import { EDITION } from '/shared/edition.mjs';
import { html, useState, useEffect, useRef } from '/vendor/htm-preact.mjs';
import { t } from '../../lib/i18n.mjs';
import { listSkins, previewSkin, endPreview, applySkin, skinState, onSkinChange, packState, catalog, startPackPreview } from '../../lib/cosmetics/index.mjs';
import { signedIn } from '../../lib/account.mjs';
import { useCosmetics, PlusMark } from '../../lib/cosmetics/components.mjs';
import { openPlus } from '../../lib/cosmetics/plus.mjs';
import { PreviewPicture, previewSrc, usePreviews } from '../../lib/cosmetics/previews.mjs';
import { Icon } from '../../lib/icons.mjs';
import { LaunchTiers } from '../launchtiers.mjs';
import { useLaunchRights } from '../../lib/handheld/look.mjs';
import { FavScope, FavEmpty, useFavList, FAV_KIND_OF } from '../../lib/favourites.mjs';

function useSkinState() {
  const [s, setS] = useState(skinState);
  useEffect(() => onSkinChange(setS), []);
  return s;
}

/** "14:32" – the time left of a live preview, ticking every second while it runs. */
function useTimeLeft(until) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!until) return undefined;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [until]);
  if (!until) return null;
  const s = Math.max(0, Math.round((Date.parse(until) - Date.now()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Why the service said no to a live preview, in words. */
function previewError(e) {
  if (e?.code === 'rate_limited') return t('skin.previewDay', 'You’ve used today’s previews – try again tomorrow, or get souldew+ to keep every theme.');
  if (e?.code === 'limit_reached') return t('skin.previewBusy', 'Too many previews are running on your account – wait until one ends.');
  if (e?.code === 'none') return t('skin.previewNone', 'Previews aren’t available right now.');
  return t('skin.previewFailed', 'The preview couldn’t be loaded. Check your connection and try again.');
}

function SkinCard({ skin, compact, on, previewing, onClick }) {
  return html`<button type="button" role="radio" aria-checked=${on} data-skin-preview=${skin.id} title=${compact ? skin.hint : undefined}
    class=${`theme-card skin-card${compact ? ' compact' : ''}${on ? ' on' : ''}${previewing ? ' previewing' : ''}`} onClick=${onClick}>
    <span class="theme-swatches" aria-hidden="true">${skin.sw.map((c) => html`<i class="sw" style=${`background:${c}`}></i>`)}</span>
    <b>${skin.name}</b>${!compact && html`<span class="hint">${skin.hint}</span>`}
    ${skin.plus && html`<${PlusMark} />`}
  </button>`;
}

/** Settings › General › Appearance › Theme. save({ skin }) persists the committed choice. */
export function SkinSetting({ cfg, save }) {
  useCosmetics();
  usePreviews();
  const s = useSkinState();
  const pack = packState();
  const [locked, setLocked] = useState(null); // a souldew+ theme that can't be previewed here (no pack, no preview)
  const [trying, setTrying] = useState(null); // { error } after a failed "Try for 15 minutes"
  const [ended, setEnded] = useState(false);
  const left = useTimeLeft(pack.preview ? pack.previewUntil : null);
  const wasPreview = useRef(false);
  // the live preview's time is up: its skins are gone (the app's own look is back) – say so once
  useEffect(() => {
    if (wasPreview.current && !pack.preview) setEnded(true);
    wasPreview.current = pack.preview;
  }, [pack.preview]);
  const skins = listSkins();
  const byId = Object.fromEntries(skins.map((k) => [k.id, k]));
  const known = skins.map((k) => k.id);
  // the favourites row (lib/favourites.mjs): the themes keep their order and their two groups
  const fav = useFavList('settings-theme', skins, { kind: 'theme' });
  // leaving Settings puts your theme back – a preview is never saved
  useEffect(() => () => endPreview(), []);
  const committed = s.committed;
  const shown = s.previewing || committed;
  const pick = (k) => {
    setLocked(null);
    setTrying(null);
    setEnded(false);
    if (k.id === committed && !s.previewing) return;
    if (k.id === committed) return endPreview();
    if (!previewSkin(k.id)) setLocked(k.id);
  };
  const keep = async (id) => {
    if (!byId[id]?.owned) return openPlus({ reason: 'skin', id });
    applySkin(id);
    endPreview();
    await save({ skin: id === 'classic' ? null : id });
  };
  const previewName = s.previewing ? byId[s.previewing]?.name : null;
  const backName = byId[committed]?.name || 'souldew';
  const group = (label, list, compact) => list.length > 0 && html`<div class="skin-group">
    <span class="skin-group-label small faint">${label}</span>
    <div class=${`theme-picker skin-picker${compact ? ' compact' : ''}`} role="radiogroup" aria-label=${label}>
      ${list.map((k) => html`<${FavScope} key=${k.id} kind="theme" id=${k.id} name=${k.name} known=${known} class="skin-fav"><${SkinCard} skin=${k} compact=${compact} on=${k.id === (locked || shown)}
        previewing=${!!s.previewing && k.id === s.previewing} onClick=${() => pick(k)} /><//>`)}
    </div></div>`;
  const lockedName = locked ? byId[locked]?.name : null;
  const tryIt = async (id) => {
    setTrying({ busy: true });
    try {
      await startPackPreview();
      setTrying(null);
      setEnded(false);
      if (previewSkin(id)) setLocked(null);
    } catch (e) {
      setTrying({ error: e });
    }
  };
  const canTry = !pack.entitled && !pack.preview && signedIn();
  return html`<div class="stack-s skin-setting">
    <h3 class="skin-picker-head">${t('skin.title', 'Theme')} <span class="plus-mark" aria-hidden="true"><${Icon} name="plus" size=${10} /></span></h3>
    <p class="small muted">${t('skin.note', 'Changes the look, never the layout. Click a theme to try it on the whole app – leaving Settings puts yours back.')}
      ${!pack.entitled && html` <a href="#/plus" class="skin-plus-link">${t('skin.whatsInPlus', 'What’s in souldew+')}</a>`}</p>
    ${previewName && html`<div class=${`skin-preview-bar${pack.preview && !byId[s.previewing]?.owned ? ' live' : ''}`} role="status">
      ${pack.preview && !byId[s.previewing]?.owned ? html`<span class="skin-live-badge" title=${t('skin.liveHint', 'A souldew+ theme to try for 15 minutes – it goes back by itself.')}>${t('skin.live', 'Preview')} · ${t('skin.left', '{time} left', { time: left || '0:00' })}</span>`
        : html`<span class="led amber on" aria-hidden="true"></span>`}
      <span>${t('skin.previewing', 'Previewing {name} – nothing is saved.', { name: '\u0000' }).split('\u0000').flatMap((part, i) => (i ? [html`<b>${previewName}</b>`, part] : [part]))}</span>
      <span class="spacer"></span>
      <button type="button" class="btn small ghost" onClick=${() => endPreview()}>${t('skin.back', 'Back to {name}', { name: backName })}</button>
      <button type="button" class="btn small go" onClick=${() => keep(s.previewing)}>${byId[s.previewing]?.owned
        ? t('skin.keep', 'Keep {name}', { name: previewName }) : t('skin.keepPlus', 'Keep {name} with souldew+', { name: previewName })}</button>
    </div>`}
    ${lockedName && html`<div class="skin-preview-bar" role="status">
      <${PlusMark} />
      <span>${pack.loading || trying?.busy ? t('skin.loading', 'Loading souldew+ themes …') : trying?.error ? previewError(trying.error)
        : canTry ? t('skin.lockedTry', '{name} comes with souldew+ – try it on for 15 minutes.', { name: lockedName })
        : !pack.entitled && !signedIn() ? t('skin.lockedSignIn', '{name} comes with souldew+. Sign in to try it on for 15 minutes.', { name: lockedName })
        : t('skin.lockedText', '{name} comes with souldew+.', { name: lockedName })}</span>
      <span class="spacer"></span>
      <button type="button" class="btn small ghost" onClick=${() => { setLocked(null); setTrying(null); }}>${t('skin.back', 'Back to {name}', { name: backName })}</button>
      ${canTry && !trying && html`<button type="button" class="btn small" onClick=${() => tryIt(locked)}>${t('skin.try', 'Try for 15 minutes')}</button>`}
      ${EDITION.accounts && !pack.entitled && !signedIn() && html`<button type="button" class="btn small" onClick=${() => { location.hash = '#/settings?s=account'; }}>${t('acct.signIn', 'Sign in with Discord')}</button>`}
      ${!pack.loading && html`<button type="button" class="btn small go" onClick=${() => openPlus({ reason: 'skin', id: locked })}>${t('skin.getPlus', 'Get souldew+')}</button>`}
    </div>`}
    ${lockedName && !canTry && previewSrc('skins', locked) && html`<figure class="skin-shot">
      <${PreviewPicture} kind="skins" id=${locked} alt=${t('skin.shotAlt', 'souldew in {name}', { name: lockedName })} />
      <figcaption class="small faint">${t('skin.shotCaption', 'How souldew looks in {name}.', { name: lockedName })}</figcaption></figure>`}
    ${ended && !previewName && !lockedName && html`<p class="small faint" role="status">${t('skin.previewEnded', 'The preview has ended – your own theme is back.')}</p>`}
    ${fav.row && html`<div class="skin-filter">${fav.row}</div>`}
    ${group(t('skin.dark', 'Colours · dark'), fav.shown.filter((k) => k.group === 'dark'), true)}
    ${group(t('skin.light', 'Colours · light'), fav.shown.filter((k) => k.group === 'light'), true)}
    ${fav.filter === 'favs' && !fav.counts.favs && html`<${FavEmpty} />`}
    ${cfg.skin && s.pending && !pack.loading && !pack.entitled && html`<p class="small faint">${t('skin.pending', 'Your theme {name} is back as soon as souldew+ is active on this computer again.', { name: byId[s.pending]?.name || s.pending })}</p>`}
  </div>`;
}

const SHOW_KINDS = () => [
  ['skins', t('plusShow.themes', 'Themes')], ['banners', t('cos.banners', 'Banners')], ['frames', t('cos.frames', 'Avatar frames')],
  ['nameplates', t('cos.nameplates', 'Nameplates')],
];

/** One item of the showcase: its picture (the loop while hovered / focused), its name, its favourite star. */
function ShowItem({ kind, item, known }) {
  const [hot, setHot] = useState(false);
  return html`<li class="plus-show-li"><${FavScope} kind=${FAV_KIND_OF[kind]} id=${item.id} name=${item.name} known=${known} class="plus-show-fav">
    <div class=${`plus-show-item plus-show-item--${kind}`} tabIndex="0" onPointerEnter=${() => setHot(true)} onPointerLeave=${() => setHot(false)}
    onFocus=${() => setHot(true)} onBlur=${() => setHot(false)}>
    <span class="plus-show-art">${kind === 'frames' && html`<span class="cos-pick-av" aria-hidden="true"></span>`}<${PreviewPicture} kind=${kind} id=${item.id} loop=${hot} /></span>
    <span class="plus-show-name small">${item.name}</span></div><//></li>`;
}

/**
 * "What souldew+ holds": the real look of every premium theme, banner, frame and nameplate, from the signed preview
 * media – for everyone, signed in or not (nobody buys what they can't see) – and, in words, what each tier gets for the
 * launch animation (views/launchtiers.mjs). Only those words when the previews can't be reached.
 */
export function PlusShowcase() {
  const pv = usePreviews();
  const [kind, setKind] = useState('skins');
  const launchTier = useLaunchRights().tier;
  const tiers = html`<${LaunchTiers} current=${launchTier} />`;
  const bare = html`<section class="plus-show stack-s" aria-label=${t('plusShow.title', 'What souldew+ holds')}>
    <div class="row plus-show-head"><h3>${t('plusShow.title', 'What souldew+ holds')}</h3></div>${tiers}</section>`;
  if (!pv?.files) return bare;
  const cat = catalog();
  const lists = {
    skins: cat.skins.filter((s) => s.plus), banners: cat.banners.filter((b) => b.plus && !b.drop), frames: cat.frames.filter((f) => f.plus),
    nameplates: cat.nameplates.filter((n) => n.plus && !n.drop),
  };
  const kinds = SHOW_KINDS().filter(([k]) => lists[k].some((x) => previewSrc(k, x.id)));
  if (!kinds.length) return bare;
  const k = kinds.some(([x]) => x === kind) ? kind : kinds[0][0];
  const items = lists[k].filter((x) => previewSrc(k, x.id));
  const known = (cat[k] || []).map((x) => x.id);
  return html`<section class="plus-show stack-s" aria-label=${t('plusShow.title', 'What souldew+ holds')}>
    <div class="row plus-show-head"><h3>${t('plusShow.title', 'What souldew+ holds')}</h3>
      <span class="small muted">${t('plusShow.count', '{count} item|{count} items', { count: Object.entries(lists).reduce((n, [x, l]) => n + l.filter((i) => previewSrc(x, i.id)).length, 0) })}</span></div>
    <div class="seg small" role="tablist" aria-label=${t('plusShow.title', 'What souldew+ holds')}>
      ${kinds.map(([x, label]) => html`<button type="button" role="tab" aria-selected=${x === k} class=${x === k ? 'on' : ''} onClick=${() => setKind(x)}>${label}</button>`)}
    </div>
    <p class="small faint">${k === 'skins' ? t('plusShow.themesHint', 'Every theme recolours the whole app – never a box or a word.') : t('plusShow.hint', 'Hover or focus one to see it move.')}</p>
    <${ShowGrid} key=${k} k=${k} items=${items} known=${known} />
    ${tiers}
  </section>`;
}

/** One kind's items, with the favourites row (a wish list: everything here is souldew+). */
function ShowGrid({ k, items, known }) {
  const fav = useFavList(`showcase-${k}`, items, { kind: FAV_KIND_OF[k] });
  return html`${fav.row}
    ${fav.filter === 'favs' && !fav.counts.favs ? html`<${FavEmpty} />`
      : html`<ul class=${`plus-show-grid plus-show-grid--${k}`} role="list">${fav.shown.map((it) => html`<${ShowItem} key=${it.id} kind=${k} item=${it} known=${known} />`)}</ul>`}`;
}
