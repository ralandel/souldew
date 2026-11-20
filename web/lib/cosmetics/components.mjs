// Preact components for the profile, the friends list and the profile editor (README.md › Components):
//   <Banner id size shade intro reducedMotion />           the profile strip / friend header
//   <Frame id size>…avatar img + presence dot…</Frame>     an avatar box with its frame (useFrame for your own markup)
//   <Nameplate id>…row content…</Nameplate>                a list row with the nameplate behind it
//   <CosmeticPicker kind value onPick />                   grid with live previews, collections, rarity, locked state
// Every one of them mounts its runtime on mount and destroys it on unmount (no timers, observers or workers left behind),
// pauses off-screen and follows reduced motion.
import { html, useEffect, useRef, useState, useMemo } from '/vendor/htm-preact.mjs';
import { t } from '../i18n.mjs';
import { Icon } from '../icons.mjs';
import { mountBanner, mountNameplate } from './banners/runtime.mjs';
import { mountFrame } from './frames/runtime.mjs';
import { onChange, state, owned, has, CATALOG } from './state.mjs';
import { skinState, onSkinChange } from './skins.mjs';
import { catalog } from './index.mjs';
import { PreviewPicture, previewSrc, usePreviews } from './previews.mjs';

/** Re-renders when the pack (and with it what's owned / available) changes. */
export function useCosmetics() {
  const [gen, setGen] = useState(state.generation);
  useEffect(() => onChange((s) => setGen(s.generation)), []);
  return gen;
}
/** The skin on screen right now (a preview included) – for "matches your theme" hints. */
export function useVisibleSkin() {
  const [skin, setSkin] = useState(() => skinState().visible);
  useEffect(() => onSkinChange((s) => setSkin(s.visible)), []);
  return skin;
}

const swatchBg = (sw) => (sw?.length ? `linear-gradient(90deg, ${sw.map((c, i) => `${c} ${(i / sw.length) * 100}% ${((i + 1) / sw.length) * 100}%`).join(', ')})` : '');
const findItem = (kind, id) => (kind === 'nameplates' ? CATALOG.banners : CATALOG[kind] || []).find((x) => x.id === id);

/** The quiet souldew+ mark (one fixed gold on every skin, so a light skin's dark accent can't hide it). */
export function PlusMark({ title }) {
  return html`<span class="plus-mark" title=${title ?? t('cos.plus', 'souldew+')} aria-label=${title ?? t('cos.plus', 'souldew+')}><${Icon} name="plus" size=${10} /></span>`;
}

/**
 * The profile banner. size: 'profile' (160 px strip) | 'friend' (92 px detail header) | 'card' (picker preview) | 'fill'
 * (whatever height the parent gives). shade: the fade into the page under the name – mixed from the skin's own tokens,
 * so light skins fade to paper instead of smudging the art dark. A banner without content (locked, pack not loaded)
 * shows its palette as a quiet strip.
 */
export function Banner({ id, size = 'profile', shade = false, intro = true, reducedMotion, animate, class: cls = '', children }) {
  const ref = useRef(null);
  const gen = useCosmetics();
  const available = !!id && has('banners', id);
  useEffect(() => {
    if (!id || !ref.current) return undefined;
    const h = mountBanner(ref.current, id, { intro, reducedMotion, animate });
    return () => h.destroy();
  }, [id, reducedMotion, animate]);
  const item = id ? findItem('banners', id) : null;
  // the runtime draws into its own host element: Preact never has to reconcile around nodes it didn't create
  return html`<div class=${`cos-banner cos-banner--${size}${shade ? ' cos-shade' : ''}${cls ? ` ${cls}` : ''}`} data-banner=${id || ''}
    style=${!available && item ? `--cos-sw:${swatchBg(item.sw)}` : ''} data-gen=${gen}>
    <div class="cos-art-host" ref=${ref}></div>
    ${!available && item && html`<span class="cos-ph" aria-hidden="true"></span>`}
    ${children}
  </div>`;
}

/** Mount a frame on an avatar box you render yourself (ref to the box). */
export function useFrame(ref, id, size, { intro = true, reducedMotion, animate, hoverTarget } = {}) {
  useEffect(() => {
    if (!id || !ref.current) return undefined;
    const h = mountFrame(ref.current, id, size, { intro, reducedMotion, animate, hoverTarget: hoverTarget?.current || hoverTarget });
    return () => h.destroy();
  }, [id, size, reducedMotion, animate]);
}

/** An avatar box (`size` css px) with frame `id` drawn round it; children: the avatar <img> and anything on top. */
export function Frame({ id, size = 40, intro = true, reducedMotion, animate, class: cls = '', children }) {
  const ref = useRef(null);
  useCosmetics();
  useFrame(ref, id, size, { intro, reducedMotion, animate });
  return html`<span ref=${ref} class=${`cos-frame${cls ? ` ${cls}` : ''}`} style=${`--av:${size}px`} data-frame=${id || ''}>${children}</span>`;
}

/** A row with the nameplate behind it (still until hovered, like Discord). children: the row content. */
export function Nameplate({ id, reducedMotion, animate, class: cls = '', children, ...rest }) {
  const ref = useRef(null);
  useCosmetics();
  useEffect(() => {
    if (!id || !ref.current) return undefined;
    const h = mountNameplate(ref.current, id, { reducedMotion, animate, hoverTarget: ref.current.parentElement });
    return () => h.destroy();
  }, [id, reducedMotion, animate]);
  return html`<div class=${`cos-nameplate${id ? ' has-plate' : ''}${cls ? ` ${cls}` : ''}`} data-nameplate=${id || ''} ...${rest}>
    <div class="cos-art-host" ref=${ref}></div>${children}</div>`;
}

const RARITY_TEXT = () => ({
  free: t('cos.rarity.free', 'Free'), common: t('cos.rarity.common', 'Common'), rare: t('cos.rarity.rare', 'Rare'),
  epic: t('cos.rarity.epic', 'Epic'), legendary: t('cos.rarity.legendary', 'Legendary'),
});

/** mounts its preview only once the card has been on screen (a grid of 130 banners doesn't compile 130 scenes up front) */
function useSeen(ref) {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !ref.current) return undefined;
    if (typeof IntersectionObserver !== 'function') {
      setSeen(true);
      return undefined;
    }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) setSeen(true); }, { rootMargin: '120px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  return seen;
}

function Preview({ kind, item, on, reducedMotion }) {
  const animate = on ? 'always' : 'hover';
  if (kind === 'banners') return html`<${Banner} id=${item.id} size="card" intro=${false} reducedMotion=${reducedMotion} animate=${animate} />`;
  if (kind === 'nameplates') return html`<${Nameplate} id=${item.id} reducedMotion=${reducedMotion} animate=${animate} class="cos-pick-plate"><span class="cos-pick-av" aria-hidden="true"></span><b>${t('cos.sampleName', 'Your name')}</b><//>`;
  if (kind === 'frames') return html`<span class="cos-pick-frame"><${Frame} id=${item.id} size=${56} intro=${false} reducedMotion=${reducedMotion} animate=${animate}><span class="cos-pick-av" aria-hidden="true"></span><//></span>`;
  return null;
}

/** A locked item's real look from the preview media (a still; its loop while hovered / focused / chosen). */
function PickPreview({ kind, id, loop }) {
  if (kind === 'frames') return html`<span class="cos-pick-frame cos-pick-frame--pic"><span class="cos-pick-av" aria-hidden="true"></span><${PreviewPicture} kind="frames" id=${id} loop=${loop} /></span>`;
  if (kind === 'nameplates') return html`<span class="cos-pick-plate cos-pick-plate--pic"><${PreviewPicture} kind="nameplates" id=${id} loop=${loop} /><span class="cos-pick-av" aria-hidden="true"></span><b>${t('cos.sampleName', 'Your name')}</b></span>`;
  return html`<${PreviewPicture} kind=${kind} id=${id} loop=${loop} />`;
}

function PickCard({ kind, item, on, skin, onPick, reducedMotion }) {
  const ref = useRef(null);
  const seen = useSeen(ref);
  const [hot, setHot] = useState(false); // hovered or focused: a locked item's preview plays its loop
  usePreviews();
  const picture = !item.available && previewSrc(kind, item.id);
  const rarity = RARITY_TEXT()[item.rarity] || item.rarity;
  const matches = skin && item.pairsWith?.includes(skin);
  const twin = kind === 'frames' && item.pair ? CATALOG.banners.find((b) => b.id === item.pair)?.name : null;
  const locked = !item.owned;
  const label = [item.name, rarity, locked ? t('cos.locked', 'souldew+') : '', matches ? t('cos.matchesTheme', 'Matches your theme') : ''].filter(Boolean).join(' · ');
  return html`<button ref=${ref} type="button" role="radio" aria-checked=${on} aria-label=${label} data-cos-id=${item.id}
    class=${`cos-pick cos-pick--${kind}${on ? ' on' : ''}${locked ? ' locked' : ''}`} onClick=${() => onPick?.(item.id, item)}
    onPointerEnter=${() => setHot(true)} onPointerLeave=${() => setHot(false)} onFocus=${() => setHot(true)} onBlur=${() => setHot(false)}>
    <span class="cos-pick-art" style=${!item.available && !picture ? `--cos-sw:${swatchBg(item.sw)}` : ''}>
      ${seen && item.available ? html`<${Preview} kind=${kind} item=${item} on=${on} reducedMotion=${reducedMotion} />`
        : seen && picture ? html`<${PickPreview} kind=${kind} id=${item.id} loop=${hot || on} />` : html`<span class="cos-ph" aria-hidden="true"></span>`}
    </span>
    <span class="cos-pick-text">
      <b>${item.name}</b>
      <span class="cos-pick-meta small"><span class=${`cos-rarity r-${item.rarity}`}>${rarity}</span>
        ${matches ? html`<span class="cos-pair">${t('cos.matchesTheme', 'Matches your theme')}</span>` : twin ? html`<span class="cos-pair faint">${t('cos.twin', 'Twin of {name}', { name: twin })}</span>` : null}</span>
    </span>
    ${locked && html`<${PlusMark} />`}
  </button>`;
}

/**
 * The profile editor's picker. kind: 'banners' | 'frames' | 'nameplates'. value: the chosen id (null = none).
 * onPick(id, item): item.owned tells whether it can be kept (locked ones are offered by the caller's souldew+ flow).
 * none: show a "None" choice (default true). Grouped by collection; filter: all / owned.
 */
export function CosmeticPicker({ kind = 'banners', value = null, onPick, none = true, reducedMotion }) {
  useCosmetics();
  const skin = useVisibleSkin();
  const [filter, setFilter] = useState('all');
  const cat = catalog();
  const items = cat[kind] || [];
  const groups = useMemo(() => {
    const cols = (kind === 'frames' ? cat.collections.frames : cat.collections.banners).map((c) => ({ ...c, items: [] }));
    const byId = new Map(cols.map((c) => [c.id, c]));
    for (const it of items) {
      if (filter === 'owned' && !it.owned) continue;
      if (it.drop && !it.owned) continue; // monthly drops show up once they are out (in the pack)
      (byId.get(it.collection) || byId.get(cols[0]?.id))?.items.push(it);
    }
    // free first, then the collection that matches the skin on screen
    return cols.filter((c) => c.items.length).sort((a, b) => (a.id === 'basics' ? -1 : b.id === 'basics' ? 1 : (b.items.some((i) => i.pairsWith?.includes(skin)) ? 1 : 0) - (a.items.some((i) => i.pairsWith?.includes(skin)) ? 1 : 0)));
  }, [kind, filter, skin, state.generation]);
  const title = { banners: t('cos.banners', 'Banners'), frames: t('cos.frames', 'Avatar frames'), nameplates: t('cos.nameplates', 'Nameplates') }[kind];
  return html`<div class=${`cos-picker cos-picker--${kind}`}>
    <div class="cos-picker-head row">
      <div class="seg small" role="radiogroup" aria-label=${t('cos.show', 'Show')}>
        <button type="button" role="radio" aria-checked=${filter === 'all'} class=${filter === 'all' ? 'on' : ''} onClick=${() => setFilter('all')}>${t('cos.all', 'All')}</button>
        <button type="button" role="radio" aria-checked=${filter === 'owned'} class=${filter === 'owned' ? 'on' : ''} onClick=${() => setFilter('owned')}>${t('cos.owned', 'Yours')}</button>
      </div>
      ${!state.entitled && html`<span class="small faint cos-picker-note"><${PlusMark} /> ${t('cos.lockedNote', 'Marked ones come with souldew+.')}</span>`}
    </div>
    ${none && html`<div class="cos-group"><div class="cos-grid" role="radiogroup" aria-label=${title}>
      <button type="button" role="radio" aria-checked=${!value} class=${`cos-pick cos-pick--none${!value ? ' on' : ''}`} onClick=${() => onPick?.(null, null)}>
        <span class="cos-pick-art"></span><span class="cos-pick-text"><b>${t('cos.none', 'None')}</b></span></button></div></div>`}
    ${groups.map((g) => html`<div class="cos-group" key=${g.id}>
      <span class="cos-group-label small faint">${g.name}</span>
      <div class="cos-grid" role="radiogroup" aria-label=${`${title} · ${g.name}`}>
        ${g.items.map((it) => html`<${PickCard} key=${it.id} kind=${kind} item=${it} on=${it.id === value} skin=${skin} onPick=${onPick} reducedMotion=${reducedMotion} />`)}
      </div></div>`)}
    ${!groups.length && html`<p class="small muted">${t('cos.noneOwned', 'Nothing here yet.')}</p>`}
  </div>`;
}

export { owned };
