// Favourites in the cosmetics pickers – the page's half (the rules are shared/favourites.mjs). One pattern everywhere
// a look is listed (profile editor, Settings › Theme and Launch animation, the souldew+ page, "What souldew+ holds"):
//
//   the star   FavScope wraps an item card and puts a ☆ in its corner: shown while the card is hovered or focused,
//              always (filled ★) once it is a favourite. Click toggles it, F on the focused card toggles it, and so
//              does Y / △ on a controller (lib/padnav.mjs clicks the [data-pad-y] of the focused [data-pad-y-scope]).
//              The star is its own button next to the card – never inside it – so it never picks or tries on the item.
//   the row    FavFilter: All · ★ Favourites n · Owned · souldew+ (· Earned) – small chips on one line, the chips that
//              wouldn't narrow the list left out. Favourites keep the list's own order. The last filter per picker is
//              remembered for the session (useFavFilter).
//
// Stored in the local config (`favourites`, saved with POST /api/config like the theme): there is no account sync for
// settings, so favourites stay on this computer. Locked and souldew+ items can be starred too – a wish list.
import { html, useState, useEffect, useRef } from '/vendor/htm-preact.mjs';
import { t } from './i18n.mjs';
import { api } from './api.mjs';
import { prefersReduced } from './cosmetics/motion.mjs';
import { cleanFavourites, isFavourite, toggleFavourite, pruneFavourites, filterItems, filterCounts, filterChips, shownFilter } from '/shared/favourites.mjs';

export { FAV_KINDS, FAV_KIND_OF, isFavourite } from '/shared/favourites.mjs';

let favs = {};
const subs = new Set();
const notify = () => {
  for (const fn of [...subs]) fn(favs);
};

/** At boot, from /api/status config.favourites. */
export function initFavourites(raw) {
  favs = cleanFavourites(raw);
  notify();
}

export const favourites = () => favs;

/** The favourites object; re-renders the component when it changes. */
export function useFavourites() {
  const [, tick] = useState(0);
  useEffect(() => {
    const fn = () => tick((n) => n + 1);
    subs.add(fn);
    return () => subs.delete(fn);
  }, []);
  return favs;
}

// one write at a time, always the latest state – quick toggles never land out of order
let writing = Promise.resolve();
function persist() {
  writing = writing.then(() => api.post('/api/config', { favourites: favs })).catch((e) => console.warn('favourites not saved', e));
}

/**
 * Star or unstar `id`. `known`: every id of that kind the catalog has – the ids it doesn't know (an item retired from
 * the pack) are pruned on the way, quietly.
 */
export function toggleFav(kind, id, known = null) {
  let next = toggleFavourite(favs, kind, id);
  if (known) next = pruneFavourites(next, { [kind]: known });
  favs = next;
  notify();
  persist();
}

const lastFilter = new Map(); // picker key → its last filter, for this session

/** [filter, setFilter] for one picker (key: e.g. 'pe-banners'), remembered while the app runs. */
export function useFavFilter(key) {
  const [, tick] = useState(0);
  const set = (v) => {
    lastFilter.set(key, v);
    tick((n) => n + 1);
  };
  return [lastFilter.get(key) || 'all', set];
}

const isTyping = (el) => !!el?.closest?.('input, textarea, select, [contenteditable="true"]');

/** The star glyph: an outline ☆, filled ★ when on. */
export const StarGlyph = ({ on, size = 14 }) => html`<svg class="fav-glyph" width=${size} height=${size} viewBox="0 0 16 16" aria-hidden="true">
  <path d="M8 1.6l1.95 4.1 4.45.55-3.28 3.08.85 4.42L8 11.58l-3.97 2.17.85-4.42L1.6 6.25l4.45-.55z" fill=${on ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" /></svg>`;

/** The star button on its own: aria-pressed, a plain label, F in the tooltip. */
export function FavStar({ kind, id, name, known, class: cls = '' }) {
  const f = useFavourites();
  const on = isFavourite(f, kind, id);
  // a short pop when it becomes a favourite (click, F or Y alike) – with reduced motion it just fills
  const [pop, setPop] = useState(false);
  const was = useRef(on);
  useEffect(() => {
    if (on && !was.current && !prefersReduced()) setPop(true);
    was.current = on;
  }, [on]);
  const flip = (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleFav(kind, id, known);
  };
  return html`<button type="button" class=${`fav-star ${on ? 'on' : ''} ${pop ? 'pop' : ''} ${cls}`} data-pad-y data-pad-skip aria-pressed=${on}
    aria-label=${t('fav.star', 'Favourite: {name}', { name })} title=${on ? t('fav.remove', 'Remove from favourites ({key})', { key: 'F' }) : t('fav.add', 'Add to favourites ({key})', { key: 'F' })}
    onClick=${flip} onAnimationEnd=${() => setPop(false)}><${StarGlyph} on=${on} /></button>`;
}

/**
 * An item card with its star: `children` is the card itself (the button or figure that picks / plays it). F on
 * anything focused inside toggles the star. `class` goes on the wrapper (it takes the card's place in the grid).
 */
export function FavScope({ kind, id, name, known, class: cls = '', starClass = '', children }) {
  const f = useFavourites();
  const on = isFavourite(f, kind, id);
  const key = (e) => {
    if ((e.key !== 'f' && e.key !== 'F') || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
    e.preventDefault();
    e.stopPropagation(); // the play view's own F (fullscreen) never sees it
    toggleFav(kind, id, known);
  };
  return html`<div class=${`fav-scope ${on ? 'is-fav' : ''} ${cls}`} data-pad-y-scope onKeyDown=${key}>${children}<${FavStar} kind=${kind} id=${id} name=${name} known=${known} class=${starClass} /></div>`;
}

const LABELS = () => ({ all: t('fav.all', 'All'), favs: t('fav.favs', 'Favourites'), owned: t('fav.owned', 'Owned'), plus: t('fav.plus', 'souldew+'), earned: t('fav.earned', 'Earned') });

/** Lists shorter than this get stars but no filter row – there is nothing to scroll through. */
export const FILTER_MIN = 9;

/**
 * Everything a picker needs for its filter: { shown (the items to list), filter, setFilter, chips, counts, row
 * (the filter row, or null for a short list) }. opts: { kind, owned(it), plus(it), earned(it) } as in
 * shared/favourites.mjs filterItems.
 */
export function useFavList(key, items, opts) {
  const f = useFavourites();
  const [want, setFilter] = useFavFilter(key);
  const o = { ...opts, favs: f };
  const counts = filterCounts(items, o);
  const chips = filterChips(counts);
  const short = (items || []).length < FILTER_MIN;
  const filter = short ? 'all' : shownFilter(want, chips);
  const shown = filterItems(items, filter, o);
  const row = short ? null : html`<${FavFilter} chips=${chips} counts=${counts} value=${filter} onChange=${setFilter} />`;
  return { shown, filter, setFilter, chips, counts, row };
}

/** The filter row: small chips on one line. */
export function FavFilter({ chips, counts, value, onChange }) {
  const L = LABELS();
  return html`<div class="fav-filter" role="radiogroup" aria-label=${t('fav.show', 'Show')}>${chips.map((k) => html`<button type="button" role="radio" key=${k}
    aria-checked=${value === k} class=${`fav-chip k-${k} ${value === k ? 'on' : ''} ${k === 'favs' && !counts.favs ? 'none' : ''}`} onClick=${() => onChange(k)}>
    ${k === 'favs' && html`<${StarGlyph} on=${counts.favs > 0} size=${11} />`}<span>${L[k]}</span>${k === 'favs' && counts.favs > 0 && html`<span class="fav-n">${counts.favs}</span>`}</button>`)}</div>`;
}

/** The Favourites filter with nothing in it. */
export const FavEmpty = () => html`<p class="fav-empty small muted">${t('fav.empty', 'Mark something with ☆ to find it here.')}</p>`;
