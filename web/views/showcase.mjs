// The profile's showcase – up to three trophies, the most trusted Pokémon line and the favourite game – in the layout
// the player picked (API.md §2.2 showcase_layout, shown to friends the same way):
//   'case'  "Display case": a full-width glass case under the numbers – the trophies on lit plinths in their rarity,
//           the most trusted line on its own stand with its numbers, the favourite game as the app's cartridge
//   'lcd'   "Trainer card": the most trusted line on the handheld's screen, the trophies as pins – in the side column
//   'shelf' "Shelf": the compact side column – three trophy tiles in a row, the line on a small stand
// Its pickers – the trophy cabinet and "Most trusted" (your regulars) – live in the profile editor's drawer.
// Everything another player wrote (the note) is text, never HTML.
// In the profile editor (views/profileedit.mjs) the layouts take `edit` – all three places drawn, empty ones as quiet
// placeholders, so every part can be clicked – and `mark(part, body, opts)`, which wraps each editable element.
import { html, useMemo } from '/vendor/htm-preact.mjs';
import { t } from '../lib/i18n.mjs';
import { Icon } from '../lib/icons.mjs';
import { useApp, Sprite } from '../lib/ui.mjs';
import { speciesName, pokeapi, catalog as gameCatalog } from '../lib/data.mjs';
import { useTrophies } from '../lib/trophies.mjs';
import { achText, rarityLabel } from '../lib/trophytexts.mjs';
import { fromCatalogId } from '../lib/achievementids.mjs';
import { speciesInText, splitTrusted } from '../lib/trusted.mjs';
import { shortTitle } from '../lib/friendpresence.mjs';
import { ACHIEVEMENTS } from '/shared/trophies.mjs';
import { SHOWCASE_LAYOUTS } from '/shared/social.mjs';
import { AchIcon } from './trophies.mjs';
import { coverOf } from './library.mjs';

const DEFS = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));
const monthYear = (ms) => (ms ? new Date(ms).toLocaleDateString(document.documentElement.lang || undefined, { month: 'short', year: 'numeric' }) : '');

/**
 * A showcase trophy (catalog id) → the achievement as the tiles draw it ({ id, rarity, cat, target, ok, at }) – the
 * date only for your own (from this computer's trophies), never guessed for a friend. null for an unknown id.
 */
export function achOf(catalogId, earned = null) {
  const id = fromCatalogId(catalogId);
  const def = id && DEFS[id];
  if (!def) return null;
  const mine = earned?.find((a) => a.id === id);
  return { id, rarity: def.rarity, cat: def.cat, target: def.target || 1, hidden: false, ok: true, at: mine?.at ?? null };
}

/** The layouts in the player's words. */
export const layoutLabel = (id) => ({ case: t('sc.layoutCase', 'Display case'), lcd: t('sc.layoutLcd', 'Trainer card'), shelf: t('sc.layoutShelf', 'Shelf') }[id] || id);

/** The favourite game as the library knows it: its cover, system and cartridge colour (or just the title). */
export function gameOf(library, title) {
  if (!title) return null;
  const g = (gameCatalog().games || []).find((x) => !x.variantOf && shortTitle({ gameId: x.id }) === title);
  return { title, cover: g ? coverOf(library, { gameId: g.id }) : null, system: g?.system || null, color: g?.color || null };
}

const CART_KIND = { gb: 'gb', gbc: 'gb', gba: 'gba', nds: 'nds', '3ds': 'nds' };
const SYS = { gb: 'GB', gbc: 'GBC', gba: 'GBA', nds: 'DS', '3ds': '3DS' };
/** A cartridge to look at (not a button – the library's carts open games): the cover on the module of its system. */
function Cartridge({ game }) {
  const kind = CART_KIND[game.system] || 'gb';
  return html`<div class=${`cart cart-${kind} big sc-cart`} aria-hidden="true"><div class="cart-slot"><div class="cart-body" style=${`--cc:${game.color || '#4a4954'}`}>
    <span class="cart-grip"></span>
    <div class="cart-label">${game.cover ? html`<img class="pixel" src=${game.cover} alt="" loading="lazy" />` : html`<span class="fallback">${game.title}</span>`}</div>
    <div class="cart-foot"><div class="badge-row">${game.system && html`<span class="sys">${SYS[game.system] || game.system}</span>`}</div>${kind === 'gb' && html`<span class="cart-arrow"></span>`}</div>
  </div></div></div>`;
}

/** teams · top level · fell – in pixel digits; nothing when the owner doesn't share them. */
export function TrustedStats({ tr }) {
  if (!tr || tr.teams == null) return null;
  return html`<div class="sc-tstats">
    <span><b>${tr.teams}</b>${t('sc.teams', 'team|teams', { count: tr.teams })}</span>
    <span><b>${tr.topLevel}</b>${t('sc.topLv', 'top Lv')}</span>
    <span class=${tr.fell ? 'bad' : 'ok'}>${tr.fell ? html`<b>${tr.fell}</b>${t('sc.fell', 'fell')}` : t('sc.neverFell', 'never fell')}</span>
  </div>`;
}

const lineName = (tr) => t('pf.lineOf', '{name} line', { name: speciesName(tr.species) });

/** The old free-text "most trusted" (before it was a line): the Pokémon it names, or a quiet ball, and the words. */
function LegacyTrusted({ text }) {
  const id = useMemo(() => speciesInText(text, pokeapi()?.names), [text]);
  const { head, rest } = splitTrusted(text);
  return html`<div class="pf-trusted">
    <span class=${`pf-trusted-mon${id ? '' : ' blank'}`}>${id ? html`<${Sprite} id=${id} gen=${5} size=${80} alt=${speciesName(id)} />` : html`<${Icon} name="ball" size=${26} />`}</span>
    <div class="stack-s pf-trusted-text">${head && html`<b class="pf-trusted-head">${head}</b>`}<p>${rest}</p></div>
  </div>`;
}

/** The line on its stand (side column, the picker's preview). */
export function TrustedCard({ tr, big = false }) {
  if (!tr) return null;
  return html`<div class=${`sc-tcard ${big ? 'big' : ''}`}>
    <span class="sc-stand"><${Sprite} id=${tr.species} gen=${5} size=${big ? 112 : 88} alt=${speciesName(tr.species)} /></span>
    <div class="sc-tcard-text"><b class="sc-tname">${lineName(tr)}</b><${TrustedStats} tr=${tr} />
      ${tr.note && html`<p class="sc-note">“${tr.note}”</p>`}</div>
  </div>`;
}

/** Your own profile: which layout friends see, switched right here (saved on the service). */
export function LayoutSwitch({ value, onChange, busy }) {
  return html`<div class="seg small sc-layout" role="radiogroup" aria-label=${t('sc.layout', 'Showcase layout')}>
    ${SHOWCASE_LAYOUTS.map((id) => html`<button type="button" role="radio" aria-checked=${value === id} class=${value === id ? 'on' : ''} disabled=${busy}
      onClick=${() => value !== id && onChange(id)}>${layoutLabel(id)}</button>`)}</div>`;
}

/** The showcase's parts for a profile: the trophies (as tiles), the line (or the old text) and the favourite game. */
function useParts(prof, edit = false) {
  const { library } = useApp();
  const tr = useTrophies();
  const sc = prof.showcase || {};
  // editing: the three places by position (an empty one stays empty); else just the trophies there are
  const trophies = edit ? [0, 1, 2].map((i) => (sc.trophies?.[i] ? achOf(sc.trophies[i], tr?.achievements) : null)) : (sc.trophies || []).map((id) => achOf(id, tr?.achievements)).filter(Boolean);
  return { trophies, trusted: sc.trusted || null, legacy: sc.trusted ? null : sc.trustedText || null, game: gameOf(library, sc.favoriteGame) };
}

export const isEmpty = (prof) => {
  const sc = prof?.showcase || {};
  return !(sc.trophies || []).length && !sc.trusted && !sc.trustedText && !sc.favoriteGame;
};

function Head({ title, own, layout, onLayout, busy, onEdit, tag = null }) {
  return html`<div class="pf-head"><h2>${title}</h2><span class="pf-rule"></span>${tag && html`<span class="pf-tag">${tag}</span>`}
    ${own && onLayout && html`<${LayoutSwitch} value=${layout} onChange=${onLayout} busy=${busy} />`}
    ${own && onEdit && html`<button type="button" class="btn small ghost" onClick=${onEdit}>${t('sc.arrange', 'Arrange')}</button>`}</div>`;
}

const plain = (part, body) => body;

/** The editor's empty places: a dashed plinth / pin / tile that says what goes there. */
function EmptyPed() {
  return html`<figure class="sc-ped sc-ped-empty"><span class="sc-empty-plinth"><${Icon} name="trophy" size=${22} /></span><span class="sc-ped-top" aria-hidden="true"></span>
    <figcaption><b>${t('sc.emptyPlace', 'Empty place')}</b><span class="small faint">${t('sc.emptyPlaceHint', 'Pick a trophy for it')}</span></figcaption></figure>`;
}
const EmptySmall = ({ cls }) => html`<div class=${`${cls} sc-small-empty`}><span class="sc-empty-plinth s"><${Icon} name="trophy" size=${14} /></span><b>${t('sc.emptyShort', 'Empty')}</b></div>`;

/** 'case' – the display case, full width under the numbers. */
export function ShowcaseCase({ prof, own, onLayout, busy, onEdit, edit = false, mark = plain }) {
  const { trophies, trusted, legacy, game } = useParts(prof, edit);
  const empty = !edit && isEmpty(prof);
  if (empty && !own) return null;
  const head = html`<${Head} title=${t('pf.showcase', 'Showcase')} own=${own && !edit} layout="case" onLayout=${onLayout} busy=${busy} onEdit=${onEdit} tag=${edit ? layoutLabel('case') : null} />`;
  return html`<section class="pf-section sc-case-sec">
    ${edit ? mark('layout', head, { cls: 'pe-m-head' }) : head}
    ${empty ? html`<p class="small muted sc-empty">${t('sc.emptyOwn', 'Nothing in your showcase yet – Arrange puts up to three trophies, your most trusted Pokémon and your favourite game here.')}</p>`
      : html`<div class="sc-case">
      <span class="sc-glass" aria-hidden="true"></span>
      ${trophies.length > 0 && html`<div class="sc-case-trophies" style=${`--n:${trophies.length}`}>${trophies.map((a, i) => {
        if (!a) return mark('trophies', html`<${EmptyPed} />`, { slot: i, cls: 'pe-m-slot' });
        const tx = achText(a.id, a.target);
        return mark('trophies', html`<figure class=${`sc-ped r-${a.rarity}`}><span class="sc-light" aria-hidden="true"></span><span class="sc-ped-item"><${AchIcon} a=${a} size=${34} /></span><span class="sc-ped-top" aria-hidden="true"></span>
          <figcaption><b>${tx.name}</b><span class="small muted">${tx.desc}</span><span class="row tight sc-ped-meta"><span class=${`rarity r-${a.rarity}`}>${rarityLabel(a.rarity)}</span>${a.at && html`<span class="tiny faint">${monthYear(a.at)}</span>`}</span></figcaption></figure>`, { slot: i, cls: 'pe-m-slot' });
      })}</div>`}
      ${trusted ? mark('trusted', html`<figure class="sc-case-mon"><span class="sc-light mon" aria-hidden="true"></span><span class="sc-case-sprite"><${Sprite} id=${trusted.species} gen=${5} size=${128} alt=${speciesName(trusted.species)} /></span><span class="sc-ped-top wide" aria-hidden="true"></span>
        <figcaption><span class="pf-tag">${t('pf.trusted', 'Most trusted')}</span><b class="sc-case-monname">${lineName(trusted)}</b><${TrustedStats} tr=${trusted} />
          ${trusted.note && html`<p class="sc-note">“${trusted.note}”</p>`}</figcaption></figure>`, { cls: 'pe-m-mon' })
        : legacy ? mark('trusted', html`<div class="sc-case-legacy"><span class="pf-tag">${t('pf.trusted', 'Most trusted')}</span><${LegacyTrusted} text=${legacy} /></div>`, { cls: 'pe-m-mon' })
          : edit && mark('trusted', html`<figure class="sc-case-mon sc-case-blank"><span class="sc-empty-plinth"><${Icon} name="ball" size=${22} /></span>
            <figcaption><span class="pf-tag">${t('pf.trusted', 'Most trusted')}</span><span class="small faint">${t('sc.pickMonHint', 'Pick the Pokémon you trust most')}</span></figcaption></figure>`, { cls: 'pe-m-mon' })}
      ${game ? mark('fav', html`<figure class="sc-case-fav"><${Cartridge} game=${game} /><figcaption><span class="pf-tag">${t('pf.favorite', 'Favourite game')}</span><b>${game.title}</b></figcaption></figure>`, { cls: 'pe-m-fav' })
        : edit && mark('fav', html`<figure class="sc-case-fav sc-case-blank"><span class="sc-empty-plinth"><${Icon} name="play" size=${20} /></span>
          <figcaption><span class="pf-tag">${t('pf.favorite', 'Favourite game')}</span><span class="small faint">${t('sc.pickGameHint', 'Pick a game')}</span></figcaption></figure>`, { cls: 'pe-m-fav' })}
    </div>`}
  </section>`;
}

/** The favourite game as a row (the side-column layouts). */
function FavRow({ game, edit = false }) {
  if (!game && edit) return html`<div class="pf-fav"><span class="pf-fav-blank"><${Icon} name="play" size=${16} /></span><div class="stack-s" style="gap:0"><b class="faint">${t('sc.pickGameHint', 'Pick a game')}</b><span class="small muted">${t('pf.favorite', 'Favourite game')}</span></div></div>`;
  if (!game) return null;
  return html`<div class="pf-fav">${game.cover ? html`<img class="pixel" src=${game.cover} alt="" />` : html`<span class="pf-fav-blank"><${Icon} name="play" size=${16} /></span>`}
    <div class="stack-s" style="gap:0"><b>${game.title}</b><span class="small muted">${t('pf.favorite', 'Favourite game')}</span></div></div>`;
}

/** 'lcd' – the trainer card: the line on the handheld's screen, trophies as pins, in the side column. */
export function ShowcaseLcd({ prof, own, onLayout, busy, onEdit, edit = false, mark = plain }) {
  const { trophies, trusted, legacy, game } = useParts(prof, edit);
  const empty = !edit && isEmpty(prof);
  if (edit) {
    return html`<div class="pf-side stack-l">
      ${mark('layout', html`<${Head} title=${t('pf.trusted', 'Most trusted')} tag=${layoutLabel('lcd')} />`, { cls: 'pe-m-head' })}
      ${mark('trusted', trusted ? html`<div class="lcd-card sc-lcd">
        <div class="sc-lcd-screen"><${Sprite} id=${trusted.species} gen=${5} size=${112} alt=${speciesName(trusted.species)} /></div>
        <div class="sc-lcd-info"><b class="px">${speciesName(trusted.species).toUpperCase()}</b>
          ${trusted.teams != null && html`<dl><dt>${t('sc.teamsShort', 'Teams')}</dt><dd>${trusted.teams}</dd><dt>${t('sc.topLv', 'top Lv')}</dt><dd>${trusted.topLevel}</dd><dt>${t('sc.fell', 'fell')}</dt><dd>${trusted.fell}</dd></dl>`}
          ${trusted.note && html`<span class="small sc-lcd-note">“${trusted.note}”</span>`}</div>
      </div>` : legacy ? html`<${LegacyTrusted} text=${legacy} />` : html`<div class="lcd-card sc-lcd sc-lcd-blank"><div class="sc-lcd-screen"></div><div class="sc-lcd-info"><span class="small">${t('sc.pickMonHint', 'Pick the Pokémon you trust most')}</span></div></div>`)}
      <section class="pf-section"><div class="pf-head"><h2>${t('pf.showcase', 'Showcase')}</h2><span class="pf-rule"></span></div>
        <div class="sc-pins">${trophies.map((a, i) => mark('trophies', a ? html`<div class=${`sc-pin r-${a.rarity}`}><${AchIcon} a=${a} size=${24} /><b>${achText(a.id, a.target).name}</b><span class=${`rarity r-${a.rarity}`}>${rarityLabel(a.rarity)}</span></div>`
          : html`<${EmptySmall} cls="sc-pin" />`, { slot: i, cls: 'pe-m-slot' }))}</div></section>
      ${mark('fav', html`<${FavRow} game=${game} edit />`)}
    </div>`;
  }
  return html`<div class="pf-side stack-l">
    ${own && html`<div class="sc-side-tools"><${LayoutSwitch} value="lcd" onChange=${onLayout} busy=${busy} />${onEdit && html`<button type="button" class="btn small ghost" onClick=${onEdit}>${t('sc.arrange', 'Arrange')}</button>`}</div>`}
    ${empty && own && html`<p class="small muted sc-empty">${t('sc.emptyOwn', 'Nothing in your showcase yet – Arrange puts up to three trophies, your most trusted Pokémon and your favourite game here.')}</p>`}
    ${(trusted || legacy) && html`<section class="pf-section"><div class="pf-head"><h2>${t('pf.trusted', 'Most trusted')}</h2><span class="pf-rule"></span></div>
      ${trusted ? html`<div class="lcd-card sc-lcd">
        <div class="sc-lcd-screen"><${Sprite} id=${trusted.species} gen=${5} size=${112} alt=${speciesName(trusted.species)} /></div>
        <div class="sc-lcd-info"><b class="px">${speciesName(trusted.species).toUpperCase()}</b>
          ${trusted.teams != null && html`<dl><dt>${t('sc.teamsShort', 'Teams')}</dt><dd>${trusted.teams}</dd><dt>${t('sc.topLv', 'top Lv')}</dt><dd>${trusted.topLevel}</dd><dt>${t('sc.fell', 'fell')}</dt><dd>${trusted.fell}</dd></dl>`}
          ${trusted.note && html`<span class="small sc-lcd-note">“${trusted.note}”</span>`}</div>
      </div>` : html`<${LegacyTrusted} text=${legacy} />`}</section>`}
    ${trophies.length > 0 && html`<section class="pf-section"><div class="pf-head"><h2>${t('pf.showcase', 'Showcase')}</h2><span class="pf-rule"></span></div>
      <div class="sc-pins">${trophies.map((a) => html`<div class=${`sc-pin r-${a.rarity}`} title=${achText(a.id, a.target).desc}><${AchIcon} a=${a} size=${24} /><b>${achText(a.id, a.target).name}</b><span class=${`rarity r-${a.rarity}`}>${rarityLabel(a.rarity)}</span></div>`)}</div></section>`}
    <${FavRow} game=${game} />
  </div>`;
}

/** 'shelf' – the compact side column: three trophy tiles in a row, the line on a stand. */
export function ShowcaseShelf({ prof, own, onLayout, busy, onEdit, edit = false, mark = plain }) {
  const { trophies, trusted, legacy, game } = useParts(prof, edit);
  const empty = !edit && isEmpty(prof);
  if (edit) {
    return html`<div class="pf-side stack-l">
      <section class="pf-section">${mark('layout', html`<${Head} title=${t('pf.showcase', 'Showcase')} tag=${layoutLabel('shelf')} />`, { cls: 'pe-m-head' })}
        <div class="sc-tiles">${trophies.map((a, i) => mark('trophies', a ? html`<div class=${`sc-tile r-${a.rarity}`}><${AchIcon} a=${a} size=${26} /><b>${achText(a.id, a.target).name}</b><span class=${`rarity r-${a.rarity}`}>${rarityLabel(a.rarity)}</span></div>`
          : html`<${EmptySmall} cls="sc-tile" />`, { slot: i, cls: 'pe-m-slot' }))}</div></section>
      <section class="pf-section"><div class="pf-head"><h2>${t('pf.trusted', 'Most trusted')}</h2><span class="pf-rule"></span></div>
        ${mark('trusted', trusted ? html`<${TrustedCard} tr=${trusted} />` : legacy ? html`<${LegacyTrusted} text=${legacy} />`
          : html`<div class="sc-tcard"><span class="sc-stand sc-stand-blank"><${Icon} name="ball" size=${22} /></span><span class="small faint">${t('sc.pickMonHint', 'Pick the Pokémon you trust most')}</span></div>`)}</section>
      ${mark('fav', html`<${FavRow} game=${game} edit />`)}
    </div>`;
  }
  return html`<div class="pf-side stack-l">
    ${own && html`<div class="sc-side-tools"><${LayoutSwitch} value="shelf" onChange=${onLayout} busy=${busy} />${onEdit && html`<button type="button" class="btn small ghost" onClick=${onEdit}>${t('sc.arrange', 'Arrange')}</button>`}</div>`}
    ${empty && own && html`<p class="small muted sc-empty">${t('sc.emptyOwn', 'Nothing in your showcase yet – Arrange puts up to three trophies, your most trusted Pokémon and your favourite game here.')}</p>`}
    ${trophies.length > 0 && html`<section class="pf-section"><div class="pf-head"><h2>${t('pf.showcase', 'Showcase')}</h2><span class="pf-rule"></span></div>
      <div class="sc-tiles">${trophies.map((a) => html`<div class=${`sc-tile r-${a.rarity}`} title=${achText(a.id, a.target).desc}><${AchIcon} a=${a} size=${26} /><b>${achText(a.id, a.target).name}</b><span class=${`rarity r-${a.rarity}`}>${rarityLabel(a.rarity)}</span></div>`)}</div></section>`}
    ${(trusted || legacy) && html`<section class="pf-section"><div class="pf-head"><h2>${t('pf.trusted', 'Most trusted')}</h2><span class="pf-rule"></span></div>
      ${trusted ? html`<${TrustedCard} tr=${trusted} />` : html`<${LegacyTrusted} text=${legacy} />`}</section>`}
    <${FavRow} game=${game} />
  </div>`;
}
