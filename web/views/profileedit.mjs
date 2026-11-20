// "Edit profile" (#/profile?edit=1 – your own profile in its edit state), design 3.0 "B · Parts drawer":
//   left   your whole profile as friends see it – laid out at its real width (1120 px) and scaled AS A WHOLE to the
//          room it has, so it never reflows; every editable element gets a calm outline and its name on hover, and a
//          click opens its picker;
//   right  the drawer: every part as a card in four groups (Look · About you · Showcase · Privacy) with its current
//          choice as a small picture, the souldew+ mark on a preview and a dot once it changed. A card opens the part's
//          picker in the drawer ("‹ All parts", one dot per part – L / R or ‹ › step, "Back to saved"); banners,
//          frames, nameplates, the trophy cabinet and the regulars widen it, the profile just scales down a little.
//          "How friends see you" (your row with the nameplate, your sidebar chip) stays at its foot.
// One session (lib/profiledraft.mjs): every pick tries itself on at once, the bar says "n changes not saved", Save /
// Cancel for everything, leaving with unsaved changes asks once. souldew+ for everyone to try on: a locked item shows
// its real art (the preview media), the profile gets a "+ Preview" tag, one quiet gold line explains – and Save is never
// blocked: it keeps the saved free item for that part and saves the rest. Keyboard and controller: every control is a
// button, the part dots are a data-pad-tabs tab list (L / R), B / Esc goes back from a picker to the list.
import { html, useState, useEffect, useMemo, useRef, useLayoutEffect } from '/vendor/htm-preact.mjs';
import { useApp, Modal, Sprite } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t } from '../lib/i18n.mjs';
import { useCatalog, accentHex, updateMe, editorChoices, isPlus } from '../lib/account.mjs';
import { setLeaveGuard } from '../lib/leaveguard.mjs';
import { PARTS, GROUPS, ORDER, LOCKABLE, draftFrom, partChanged, changedParts, revertPart, placeTrophy, nextSlot, savePatch, leaveAsks } from '../lib/profiledraft.mjs';
import { toCatalogId, fromCatalogId } from '../lib/achievementids.mjs';
import { speciesName, pokeapi, catalog as gameCatalog } from '../lib/data.mjs';
import { shortTitle } from '../lib/friendpresence.mjs';
import { useTrophies } from '../lib/trophies.mjs';
import { achText, catLabel, rarityLabel } from '../lib/trophytexts.mjs';
import { cabinetList, searchSpecies } from '../lib/showcasepick.mjs';
import { catalog as cosCatalog, has } from '../lib/cosmetics/index.mjs';
import { Banner, Nameplate, PlusMark, useCosmetics } from '../lib/cosmetics/components.mjs';
import { PreviewPicture, previewSrc, usePreviews } from '../lib/cosmetics/previews.mjs';
import { FavScope, FavEmpty, useFavList, FAV_KIND_OF } from '../lib/favourites.mjs';
import { ACCENTS, STATUS_MAX, NAME_MAX, FAVORITE_MAX, SHOWCASE_LAYOUTS } from '/shared/social.mjs';
import { ACHIEVEMENTS, CATEGORIES, RARITIES } from '/shared/trophies.mjs';
import { lineRoot, TRUSTED_NOTE_MAX, REGULARS } from '/shared/trustedlines.mjs';
import { Avatar, TitlePlate, Badges, achTitle } from './social.mjs';
import { coverForTitle } from './friends.mjs';
import { AchIcon } from './trophies.mjs';
import { ShowcaseCase, ShowcaseLcd, ShowcaseShelf, achOf, layoutLabel } from './showcase.mjs';
import { StatsStrip, NowCard, RunHistory } from './profile.mjs';

const WIDTH = 1120; // the profile's real layout width: the preview is this, scaled
const RANK = { none: 0, supporter: 1, plus: 2, patron: 2 };
const NEEDS = { free: 0, supporter: 1, plus: 2 };
const RARITY_RANK = Object.fromEntries(RARITIES.map((r, i) => [r, i]));
const DEFS = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));

const partLabel = (id) => ({
  banner: t('pe.banner', 'Banner'), frame: t('pe.frame', 'Avatar frame'), nameplate: t('pe.nameplate', 'Nameplate'), accent: t('pe.accent', 'Accent colour'),
  name: t('pe.name', 'Name & status'), title: t('pe.title', 'Title'), layout: t('pe.layout', 'Showcase layout'), trophies: t('pe.trophies', 'Trophies'),
  trusted: t('pe.trusted', 'Most trusted'), fav: t('pe.fav', 'Favourite game'), privacy: t('pe.privacy', 'Who sees what'),
}[id]);
const partWhere = (id) => ({
  banner: t('pe.whereBanner', 'Top of your profile'), frame: t('pe.whereFrame', 'Round your picture, everywhere it shows'), nameplate: t('pe.whereNameplate', 'Behind your row in friends’ lists'),
  accent: t('pe.whereAccent', 'Your picture’s backdrop, the edge of your title and the page’s rules'), name: t('pe.whereName', 'Under your banner and in your sidebar chip'),
  title: t('pe.whereTitle', 'Next to your name – a trophy you earned'), layout: t('pe.whereLayout', 'How your showcase sits on the page'), trophies: t('pe.whereTrophies', 'The three places in your showcase'),
  trusted: t('pe.whereTrusted', 'The Pokémon in your showcase'), fav: t('pe.whereFav', 'The cartridge in your showcase'), privacy: t('pe.wherePrivacy', 'Your profile, your numbers, what you’re playing'),
}[id]);
const groupLabel = (g) => ({ look: t('pe.gLook', 'Look'), about: t('pe.gAbout', 'About you'), showcase: t('pe.gShowcase', 'Showcase'), privacy: t('pe.gPrivacy', 'Privacy') }[g]);
const accentName = (key) => ({
  moss: t('pe.acMoss', 'Moss'), fern: t('pe.acFern', 'Fern'), tide: t('pe.acTide', 'Tide'), glacier: t('pe.acGlacier', 'Glacier'), ink: t('pe.acInk', 'Ink'), dusk: t('pe.acDusk', 'Dusk'),
  sakura: t('pe.acSakura', 'Sakura'), berry: t('pe.acBerry', 'Berry'), ember: t('pe.acEmber', 'Ember'), copper: t('pe.acCopper', 'Copper'), amber: t('pe.acAmber', 'Amber'), slate: t('pe.acSlate', 'Slate'),
}[key] || key || '–');
const layoutSub = (id) => ({ case: t('pe.layoutCaseSub', 'Full width under your numbers'), lcd: t('pe.layoutLcdSub', 'Your Pokémon on the LCD, beside your runs'), shelf: t('pe.layoutShelfSub', 'A slim column beside your runs') }[id]);
const visLabel = (v) => ({ friends: t('acct.visFriends', 'My friends'), link: t('acct.visLink', 'Anyone with my handle'), nobody: t('acct.visNobody', 'Only me') }[v]);

// ---- souldew+ art for everyone: live from the pack, else the item's preview picture -----------------------------------
function BannerArt({ id, shade = false, loop = false }) {
  usePreviews();
  if (!id || has('banners', id) || !previewSrc('banners', id)) return html`<${Banner} id=${id || null} size="fill" shade=${shade} intro=${false} animate=${loop ? 'always' : undefined} />`;
  return html`<div class=${`cos-banner cos-banner--fill pe-pic${shade ? ' cos-shade' : ''}`}><${PreviewPicture} kind="banners" id=${id} loop=${loop} /></div>`;
}

function EdAvatar({ user, size, presence = null, accent = null }) {
  usePreviews();
  const f = user?.frame;
  if (!f || has('frames', f) || !previewSrc('frames', f)) return html`<${Avatar} user=${user} size=${size} presence=${presence} accent=${accent} />`;
  const src = user?.avatar && user.avatar.startsWith('/api/account/avatar?') ? user.avatar : null;
  const st = presence?.state;
  const dot = st ? (st === 'offline' ? 'off' : st === 'in_run' || st === 'playing' ? 'play' : 'on') : null;
  return html`<span class="av-wrap pe-framepic" style=${`--av:${size}px;${accent ? `--acc:${accent}` : ''}`}><span class=${`av av-${size}`} style=${`--av:${size}px`}>
    ${src ? html`<img src=${src} alt="" width=${size} height=${size} loading="lazy" decoding="async" referrerpolicy="no-referrer" />` : html`<span class="av-blank" aria-hidden="true"><${Icon} name="user" size=${Math.round(size * 0.55)} /></span>`}
    ${dot && html`<span class=${`av-dot ${dot}`} aria-hidden="true"></span>`}</span><${PreviewPicture} kind="frames" id=${f} loop /></span>`;
}

function PlateArt({ id, animate, class: cls = '', children }) {
  usePreviews();
  if (!id || has('nameplates', id) || !previewSrc('nameplates', id)) return html`<${Nameplate} id=${id || null} animate=${animate} class=${cls}>${children}<//>`;
  return html`<div class=${`cos-nameplate has-plate pe-platepic ${cls}`}><${PreviewPicture} kind="nameplates" id=${id} loop=${animate === 'always'} />${children}</div>`;
}

// ---- the whole-page zoom ----------------------------------------------------------------------------------------------
/** The profile laid out at its real width and scaled as a whole to the box – it never reflows into other proportions. */
function Zoom({ children }) {
  const ref = useRef(null);
  const [z, setZ] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    const fit = () => { if (el.clientWidth) setZ(Math.min(1, el.clientWidth / WIDTH)); };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return html`<div class="pe-zoom" ref=${ref}><div class="pe-zoom-in" style=${`width:${WIDTH}px;zoom:${z || 0.5};--z:${z || 0.5};${z ? '' : 'visibility:hidden'}`}>${children}</div></div>`;
}

// ---- the profile, as friends see it, with a hook round every editable element -----------------------------------------
function ProfilePreview({ me, prof, d, accent, presence, meta, mark, tags }) {
  const Showcase = { case: ShowcaseCase, lcd: ShowcaseLcd, shelf: ShowcaseShelf }[d.layout] || ShowcaseCase;
  const sc = html`<${Showcase} prof=${prof} edit mark=${mark} />`;
  return html`<div class="stack-l profile pe-profile" style=${accent ? `--acc:${accent}` : ''}>
    <header class="pf-mast" style=${accent ? `--acc:${accent}` : ''}>
      ${mark('banner', html`<div class="pf-banner"><${BannerArt} id=${prof.banner} shade loop />${tags.banner}</div>`, { cls: 'pe-m-banner' })}
      <div class="pf-id">
        ${mark('frame', html`<${EdAvatar} user=${prof} size=${104} presence=${presence} accent=${accent} />`, { cls: 'pe-m-frame' })}
        <div class="pf-names grow">
          <div class="row tight pf-nameline">${mark('name', html`<h1 class="pf-name">${prof.name}</h1>`, { inline: true })}
            ${mark('title', prof.title ? html`<${TitlePlate} text=${achTitle(prof.title)} />` : html`<span class="pe-add">${t('pe.addTitle', '+ Title')}</span>`, { inline: true })}<${Badges} badges=${prof.badges} /></div>
          <div class="pf-metaline"><div class="small muted pf-meta">${meta}</div></div>
          ${mark('name', prof.status ? html`<p class="pf-status">“${prof.status}”</p>` : html`<p class="pf-status pe-add-line">${t('pe.addStatus', 'Add a status line')}</p>`, { inline: true, cls: 'pe-m-status', label: t('pf.status', 'Status line') })}
        </div>
      </div>
    </header>
    ${mark('privacy', d.runs && me.stats ? html`<${StatsStrip} stats=${me.stats} />`
      : html`<div class="pf-private small muted"><${Icon} name="lock" size=${12} /><span>${d.runs ? t('pe.runsAfterSave', 'Your numbers and last runs show here once you save.') : t('pe.runsPrivate', 'Your runs stay private – friends don’t see your numbers or run history.')}</span></div>`,
    { cls: 'pe-m-stats', label: t('pe.whoNumbers', 'Who sees your numbers') })}
    ${d.layout === 'case' && sc}
    <div class=${`pf-cols ${d.layout === 'case' ? 'sc-one' : ''}`}>
      <div class="pf-main stack-l">
        <${NowCard} presence=${d.presence === 'friends' ? presence : { state: 'offline' }} own=${d.presence} name=${prof.name} />
        ${d.runs && me.stats && html`<${RunHistory} stats=${me.stats} title=${t('pf.history', 'Run history')} />`}
      </div>
      ${d.layout !== 'case' && sc}
    </div>
  </div>`;
}

/** Where the nameplate lives: a friend's list with your row in it, and your chip in the sidebar. */
function FriendsScene({ prof, accent, small = false }) {
  const row = (u, plate, text, state, acc, on) => html`<${PlateArt} id=${plate} animate=${on ? 'always' : 'hover'} class=${`fr-row ${on ? 'on pe-you' : ''} ${state === 'offline' ? 'offline' : ''}`}>
    <span class="fr-pick"><${EdAvatar} user=${u} size=${small ? 30 : 36} presence=${{ state }} accent=${acc} /><span class="grow stack-s fr-text"><b class="ellipsis">${u.name}</b>${!small && html`<span class="small muted ellipsis">${text}</span>`}</span></span><//>`;
  const chip = html`<div class="rail-me pe-chip"><${EdAvatar} user=${prof} size=${30} accent=${accent} /><span class="stack-s" style="gap:0;min-width:0"><b class="ellipsis">${prof.name}</b><span class="tiny ellipsis">${prof.status || `@${prof.handle}`}</span></span></div>`;
  if (small) return html`<div class="pe-fs small"><div class="pe-fs-list">${row(prof, prof.nameplate, '', 'in_run', accent, true)}</div>${chip}</div>`;
  return html`<div class="pe-fs">
    <div class="pe-fs-col"><span class="pe-kicker">${t('pe.inFriendList', 'In a friend’s list')}</span>
      <div class="pe-fs-list">
        ${row({ name: 'Kim', frame: null }, null, t('pe.sampleKim', 'HeartGold · SoulLink'), 'in_run', '#d9739a', false)}
        ${row(prof, prof.nameplate, t('pe.sampleYou', 'Emerald · SoulLink · Route 110'), 'in_run', accent, true)}
        ${row({ name: 'Ida' }, null, t('pe.sampleIda', 'Platinum'), 'playing', '#7fb8d8', false)}
        ${row({ name: 'Mo' }, null, t('fr.offline', 'Offline'), 'offline', '#d49a2a', false)}
      </div></div>
    <div class="pe-fs-col"><span class="pe-kicker">${t('pe.inSidebar', 'In your sidebar')}</span>${chip}
      <p class="pe-hint">${t('pe.plateHint', 'The nameplate shows behind your row wherever friends list you. The sidebar chip shows your frame and status line.')}</p></div>
  </div>`;
}

// ---- the list cards: the current choice as a small picture ------------------------------------------------------------
function LayoutThumb({ id }) {
  // a small, true-to-layout sketch of the profile with that showcase (the page's own bands, no fake content)
  return html`<span class=${`pe-lthumb l-${id}`} aria-hidden="true"><i class="b"></i><i class="s"></i>
    ${id === 'case' ? html`<i class="case"><i></i><i></i><i></i><i class="m"></i></i><i class="rows w"></i>` : html`<i class="rows"></i><i class=${`side ${id}`}><i></i><i></i></i>`}</span>`;
}

function PartThumb({ id, d, prof, accent, earned }) {
  const { library } = useApp();
  switch (id) {
    case 'banner': return html`<span class="pe-t pe-t-banner">${d.banner ? html`<${BannerArt} id=${d.banner} />` : html`<span class="pe-none"></span>`}</span>`;
    case 'frame': return html`<span class="pe-t pe-t-av"><${EdAvatar} user=${prof} size=${34} accent=${accent} /></span>`;
    case 'nameplate': return html`<span class="pe-t pe-t-plate">${d.nameplate ? html`<${PlateArt} id=${d.nameplate} animate="hover" class="pe-t-np"><b>${prof.name}</b><//>` : html`<span class="pe-none"></span><b class="pe-t-npname">${prof.name}</b>`}</span>`;
    case 'name': return html`<span class="pe-t pe-t-glyph"><b class="pe-t-aa">Aa</b></span>`;
    case 'title': return html`<span class="pe-t pe-t-glyph"><span class="pe-t-star"><${Icon} name="star" size=${14} /></span></span>`;
    case 'accent': return html`<span class="pe-t pe-t-glyph"><i class="pe-t-sw" style=${`--sw:${accent || 'var(--ink-3)'}`}></i></span>`;
    case 'layout': return html`<span class="pe-t pe-t-layout"><${LayoutThumb} id=${d.layout} /></span>`;
    case 'trophies': return html`<span class="pe-t pe-t-tro">${[0, 1, 2].map((i) => {
      const a = d.trophies[i] ? achOf(d.trophies[i], earned) : null;
      return a ? html`<${AchIcon} a=${a} size=${12} />` : html`<i class="pe-t-empty"></i>`;
    })}</span>`;
    case 'trusted': return html`<span class="pe-t pe-t-mon">${d.trusted ? html`<${Sprite} id=${d.trusted.species} gen=${5} size=${40} alt="" />` : html`<${Icon} name="ball" size=${16} />`}</span>`;
    case 'fav': {
      const cover = d.fav ? coverForTitle(library, d.fav) : null;
      return html`<span class="pe-t pe-t-glyph">${cover ? html`<img class="pixel pe-t-cover" src=${cover} alt="" />` : html`<${Icon} name="play" size=${14} />`}</span>`;
    }
    case 'privacy': return html`<span class="pe-t pe-t-glyph"><${Icon} name=${d.vis === 'nobody' ? 'lock' : 'eye'} size=${16} /></span>`;
    default: return null;
  }
}

/** "What it is now", in words – for a list card. */
function valueOf(id, d, prof) {
  const cc = cosCatalog();
  switch (id) {
    case 'banner': return cc.banners.find((b) => b.id === d.banner)?.name || t('cos.none', 'None');
    case 'frame': return cc.frames.find((f) => f.id === d.frame)?.name || t('cos.none', 'None');
    case 'nameplate': return cc.banners.find((b) => b.id === d.nameplate)?.name || t('cos.none', 'None');
    case 'name': return d.status.trim() ? `${prof.name} · “${d.status.trim()}”` : prof.name;
    case 'title': return d.title ? achTitle(d.title) : t('pf.noTitle', 'No title');
    case 'accent': return accentName(d.accent);
    case 'layout': return layoutLabel(d.layout);
    case 'trophies': return t('pe.placesN', '{n} of 3 places', { n: d.trophies.filter(Boolean).length });
    case 'trusted': return d.trusted ? t('pf.lineOf', '{name} line', { name: speciesName(d.trusted.species) }) : d.legacy ? `“${d.legacy}”` : t('pf.noTrusted', 'Not picked yet.');
    case 'fav': return d.fav.trim() || t('pf.noTrusted', 'Not picked yet.');
    case 'privacy': return `${visLabel(d.vis)} · ${d.runs ? t('pe.runsShown', 'runs shown') : t('pe.runsHidden', 'runs private')}`;
    default: return '';
  }
}

// ---- the pickers --------------------------------------------------------------------------------------------------------
const Search = ({ value, onInput, placeholder }) => html`<label class="pe-search"><${Icon} name="search" size=${14} />
  <input type="search" data-pad-first aria-label=${placeholder} placeholder=${placeholder} value=${value} onInput=${(e) => onInput(e.target.value)} /></label>`;

function useSeen(ref) {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !ref.current) return undefined;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) setSeen(true); }, { rootMargin: '120px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  return seen;
}

const RAR = () => ({ free: t('cos.rarity.free', 'Free'), common: t('cos.rarity.common', 'Common'), rare: t('cos.rarity.rare', 'Rare'), epic: t('cos.rarity.epic', 'Epic'), legendary: t('cos.rarity.legendary', 'Legendary'), earned: t('fav.earned', 'Earned') });
/** An earned look (Summit Dawn): free with its trophy, never sold – locked, it says which trophy and how. */
const earnedHow = (it) => t('cos.earnedBy', 'Earned by {trophy} – {how}', { trophy: achText(it.trophy).name, how: achText(it.trophy, 16).desc });

function CosCard({ kind, it, on, locked, onPick, prof, accent }) {
  const ref = useRef(null);
  const seen = useSeen(ref);
  const name = it ? it.name : t('cos.none', 'None');
  const rarity = it ? RAR()[it.rarity] || it.rarity : '';
  const notEarned = !!it?.earned && !it.owned;
  const label = [name, it && (notEarned ? t('hh.locked', 'locked') : locked ? t('cos.plus', 'souldew+') : rarity)].filter(Boolean).join(' · ');
  return html`<button ref=${ref} type="button" role="radio" aria-checked=${on} aria-label=${label} data-cos-id=${it?.id || 'none'} title=${notEarned ? earnedHow(it) : undefined}
    aria-disabled=${notEarned ? 'true' : undefined} class=${`pe-card k-${kind} ${on ? 'on' : ''} ${locked ? 'locked' : ''} ${notEarned ? 'not-earned' : ''}`} onClick=${() => !notEarned && onPick(it?.id || null)}>
    <span class="pe-art">${!it ? html`<span class="pe-none"></span>`
      : !seen ? html`<span class="cos-ph"></span>`
        : kind === 'banners' ? html`<${BannerArt} id=${it.id} loop=${on} />`
          : kind === 'frames' ? html`<span class="pe-frame"><${EdAvatar} user=${{ ...prof, frame: it.id }} size=${56} accent=${accent} /></span>`
            : html`<${PlateArt} id=${it.id} animate=${on ? 'always' : 'hover'} class="pe-plate"><${Avatar} user=${{ ...prof, frame: null }} size=${28} accent=${accent} /><b>${prof.name}</b><//>`}
      ${locked && html`<span class="pe-card-plus"><${PlusMark} /></span>`}</span>
    <span class="pe-name"><span class="ellipsis">${name}</span>${it && (notEarned ? html`<span class="pe-earned-word">${t('hh.locked', 'locked')}</span>` : locked ? html`<span class="pe-plus-word">${t('cos.plus', 'souldew+')}</span>` : html`<span class=${`cos-rarity r-${it.rarity}`}>${rarity}</span>`)}</span>
    ${notEarned && html`<span class="pe-earned-how tiny">${earnedHow(it)}</span>`}
  </button>`;
}

/**
 * Banners, frames or nameplates: search, the favourites row (All · ★ Favourites · Owned · souldew+ – lib/favourites.mjs),
 * grouped by collection, the real art. Every card has its star; a favourite stays where it is in its collection.
 */
function CosPick({ kind, value, onPick, member, prof, accent }) {
  useCosmetics();
  const cat = cosCatalog();
  const all = (cat[kind] || []).filter((it) => !it.drop || it.owned);
  const known = (cat[kind] || []).map((it) => it.id);
  const cols = kind === 'frames' ? cat.collections.frames : cat.collections.banners;
  const fk = FAV_KIND_OF[kind];
  const [q, setQ] = useState('');
  const fav = useFavList(`pe-${kind}`, all, { kind: fk });
  const isLocked = (it) => !member && it.plus;
  const groupName = (g) => (g.id === 'earned' ? t('cos.earnedGroup', 'Earned with trophies') : g.name);
  const words = q.trim().toLowerCase();
  const list = fav.shown.filter((it) => !words || it.name.toLowerCase().includes(words));
  const groups = cols.map((c) => ({ ...c, items: list.filter((it) => it.collection === c.id) })).filter((g) => g.items.length)
    .sort((a, b) => (a.id === 'basics' ? -1 : b.id === 'basics' ? 1 : 0) || (b.items.some((i) => !i.plus) ? 1 : 0) - (a.items.some((i) => !i.plus) ? 1 : 0));
  const noun = { banners: t('pe.searchBanners', 'Search {n} banners', { n: all.length }), frames: t('pe.searchFrames', 'Search {n} frames', { n: all.length }), nameplates: t('pe.searchPlates', 'Search {n} nameplates', { n: all.length }) }[kind];
  const emptyFavs = fav.filter === 'favs' && !fav.counts.favs;
  return html`<div class="pe-pick pe-cos">
    <div class="pe-tools"><${Search} value=${q} onInput=${setQ} placeholder=${noun} />${fav.row}</div>
    <div class="pe-groups">
      ${groups.map((g, gi) => html`<div class="pe-group" key=${g.id}><span class="pe-glabel">${groupName(g)}<span class="faint">${g.items.length}</span>${!member && g.items.every((i) => i.plus) && html`<span class="pe-gplus"><${PlusMark} />${t('cos.plus', 'souldew+')}</span>`}</span>
        <div class=${`pe-grid k-${kind}`} role="radiogroup" aria-label=${groupName(g)}>
          ${gi === 0 && !words && fav.filter === 'all' && html`<${CosCard} kind=${kind} it=${null} on=${!value} onPick=${onPick} prof=${prof} accent=${accent} />`}
          ${g.items.map((it) => html`<${FavScope} key=${it.id} kind=${fk} id=${it.id} name=${it.name} known=${known} class=${`pe-fav k-${kind}`}>
            <${CosCard} kind=${kind} it=${it} on=${it.id === value} locked=${isLocked(it)} onPick=${onPick} prof=${prof} accent=${accent} /><//>`)}</div></div>`)}
      ${emptyFavs ? html`<${FavEmpty} />` : !groups.length && html`<p class="small muted">${t('cos.noneOwned', 'Nothing here yet.')}</p>`}
    </div>
  </div>`;
}

function AccentPick({ value, onPick, accents }) {
  return html`<div class="pe-pick">
    <div class="pe-swatches" role="radiogroup" aria-label=${t('pe.accent', 'Accent colour')}>${accents.map((a, i) => html`<button type="button" role="radio" aria-checked=${value === a.key}
      data-pad-first=${i === 0 ? '' : undefined} class=${`pe-swatch ${value === a.key ? 'on' : ''}`} style=${`--sw:${a.hex}`} onClick=${() => onPick(a.key)}><i></i><span class="tiny">${accentName(a.key)}</span></button>`)}</div>
    <p class="pe-hint">${t('pe.accentHint', 'Tints your picture’s backdrop, the edge of your title and the profile’s rules – never text.')}</p>
  </div>`;
}

function NamePick({ d, set, me, focus }) {
  const st = useRef(null);
  useEffect(() => { if (focus === 'status') setTimeout(() => st.current?.focus({ preventScroll: true }), 80); }, [focus]);
  const discord = me.discord?.globalName || me.discord?.username || '';
  return html`<div class="pe-pick pe-namepick">
    <label class="field"><span>${t('pf.displayName', 'Display name')}</span><div class="row nowrap"><input type="text" class="grow" data-pad-first maxLength=${NAME_MAX} value=${d.name} placeholder=${discord} onInput=${(e) => set({ name: e.target.value })} /><span class="small faint">@${me.handle}</span></div>
      <span class="hint">${t('pf.displayNameHint', 'Empty: your Discord name ({name}).', { name: discord })}</span></label>
    <label class="field"><span>${t('pf.status', 'Status line')}</span><div class="row nowrap"><input ref=${st} type="text" class="grow" maxLength=${STATUS_MAX} value=${d.status} placeholder=${t('pf.statusPh', 'e.g. grinding Victory Road')} onInput=${(e) => set({ status: e.target.value })} />
      <span class="small muted pf-count">${Array.from(d.status).length}/${STATUS_MAX}</span></div><span class="hint">${t('pe.statusHint', 'Under your name and in your sidebar chip.')}</span></label>
  </div>`;
}

function TitlePick({ value, onPick, titles }) {
  const [q, setQ] = useState('');
  const words = q.trim().toLowerCase();
  const shown = titles.filter((id) => !words || achTitle(id).toLowerCase().includes(words));
  return html`<div class="pe-pick">
    <${Search} value=${q} onInput=${setQ} placeholder=${t('pe.searchTitles', 'Search your {n} titles', { n: titles.length })} />
    <div class="pe-rows" role="radiogroup" aria-label=${t('pe.title', 'Title')}>
      ${!words && html`<button type="button" role="radio" aria-checked=${!value} class=${`pe-row ${!value ? 'on' : ''}`} onClick=${() => onPick(null)}><span class="pe-row-main faint">${t('pf.noTitle', 'No title')}</span>${!value ? html`<${Icon} name="check" size=${14} />` : html`<span></span>`}</button>`}
      ${shown.map((id) => {
        const def = DEFS[fromCatalogId(id)];
        return html`<button type="button" role="radio" aria-checked=${value === id} class=${`pe-row r-${def?.rarity || 'common'} ${value === id ? 'on' : ''}`} onClick=${() => onPick(id)}>
          <span class="pe-row-main"><${TitlePlate} text=${achTitle(id)} /></span>${def && html`<span class=${`rarity r-${def.rarity}`}>${rarityLabel(def.rarity)}</span>`}
          ${value === id ? html`<${Icon} name="check" size=${14} />` : html`<span></span>`}</button>`;
      })}
    </div>
    <p class="pe-hint">${titles.length ? t('pe.titleHint', 'The names of trophies you earned, rarest first.') : t('pf.titleNone', 'Earn trophies to unlock titles.')}</p>
  </div>`;
}

function LayoutPick({ value, onPick }) {
  return html`<div class="pe-pick"><div class="pe-layouts" role="radiogroup" aria-label=${t('pe.layout', 'Showcase layout')}>${SHOWCASE_LAYOUTS.map((id, i) => html`<button type="button" role="radio" aria-checked=${value === id}
    data-pad-first=${i === 0 ? '' : undefined} class=${`pe-layout ${value === id ? 'on' : ''}`} onClick=${() => onPick(id)}><${LayoutThumb} id=${id} /><b>${layoutLabel(id)}</b><span class="tiny muted">${layoutSub(id)}</span></button>`)}</div></div>`;
}

/** The trophy cabinet: three places on top (pick one), search, rarity counts, categories, your earned trophies. */
function Cabinet({ d, setTrophies, slot, setSlot, earned }) {
  const [cat, setCat] = useState('all');
  const [rarity, setRarity] = useState('all');
  const [q, setQ] = useState('');
  const shown = cabinetList(earned, { cat, rarity, q }, (a) => achText(a.id, a.target).name);
  const cats = CATEGORIES.filter((c) => earned.some((a) => a.cat === c));
  const placed = [0, 1, 2].map((i) => (d.trophies[i] ? achOf(d.trophies[i], earned) : null));
  const pick = (id) => {
    const next = placeTrophy(d.trophies, slot, id);
    setTrophies(next);
    setSlot(nextSlot(next, slot));
  };
  return html`<div class="pe-pick pe-cab">
    <div class="pe-places" role="tablist" aria-label=${t('pe.places', 'Places in your showcase')}>${placed.map((a, i) => {
      const tx = a ? achText(a.id, a.target) : null;
      return html`<div class=${`pe-place ${slot === i ? 'on' : ''} ${a ? `r-${a.rarity}` : 'empty'}`}>
        <button type="button" role="tab" aria-selected=${slot === i} class="pe-place-b" onClick=${() => setSlot(i)}>
          <span class="pe-place-n">${i + 1}</span>${a ? html`<span class="sc-plinth-glow" aria-hidden="true"></span><${AchIcon} a=${a} size=${26} /><b class="ellipsis">${tx.name}</b><span class=${`rarity r-${a.rarity}`}>${rarityLabel(a.rarity)}</span>`
            : html`<span class="sc-empty-plinth s"><${Icon} name="trophy" size=${14} /></span><b class="faint">${t('sc.emptyPlace', 'Empty place')}</b>`}</button>
        ${a && html`<button type="button" class="pe-place-x" aria-label=${t('sc.takeOutName', 'Take {name} out', { name: tx.name })} title=${t('sc.takeOut', 'Take out')} onClick=${() => setTrophies(placeTrophy(d.trophies, i, null))}><${Icon} name="close" size=${10} /></button>`}</div>`;
    })}</div>
    ${!earned.length ? html`<p class="small muted">${t('pf.noTrophies', 'Trophies you earn can go here.')}</p>` : html`
    <div class="pe-tools pe-cab-tools"><${Search} value=${q} onInput=${setQ} placeholder=${t('sc.searchT', 'Search your {n} trophies', { n: earned.length })} />
      <div class="pe-rarf" role="group" aria-label=${t('sc.rarity', 'Rarity')}>${[...RARITIES].reverse().map((r) => {
        const n = earned.filter((a) => a.rarity === r).length;
        return n > 0 && html`<button type="button" aria-pressed=${rarity === r} class=${`sc-rdot r-${r} ${rarity === r ? 'on' : ''}`} title=${rarityLabel(r)} onClick=${() => setRarity(rarity === r ? 'all' : r)}><i aria-hidden="true"></i><span class="pe-rname">${rarityLabel(r)}</span><span class="faint">${n}</span></button>`;
      })}</div></div>
    <div class="seg small pe-cats" role="radiogroup" aria-label=${t('sc.category', 'Category')}>${[['all', t('pf.all', 'All')], ...cats.map((c) => [c, catLabel(c)])].map(([id, label]) => html`<button type="button" role="radio" aria-checked=${cat === id} class=${cat === id ? 'on' : ''} onClick=${() => setCat(id)}>${label}</button>`)}</div>
    <div class="pe-cablist">${shown.map((a) => {
      const id = toCatalogId(a.id);
      const at = d.trophies.indexOf(id);
      const tx = achText(a.id, a.target);
      return html`<button type="button" key=${id} class=${`sc-cab-i pe-cab-i r-${a.rarity} ${at >= 0 ? 'on' : ''}`} aria-pressed=${at >= 0} onClick=${() => pick(id)}>
        <${AchIcon} a=${a} size=${18} /><span class="sc-cab-text"><b>${tx.name}</b><span class="tiny faint">${tx.desc}</span></span>
        ${at >= 0 && html`<span class="sc-cab-n" aria-hidden="true">${at + 1}</span>`}</button>`;
    })}
      ${!shown.length && html`<p class="small muted">${t('sc.noMatch', 'No trophy matches.')}</p>`}</div>`}
    <p class="pe-hint">${placed[slot] ? t('pe.placeFull', 'Place {n} holds {name} – click another trophy to swap it.', { n: slot + 1, name: achText(placed[slot].id, placed[slot].target).name })
      : t('pe.placeEmpty', 'Place {n} is empty – click a trophy to put it there.', { n: slot + 1 })}</p>
  </div>`;
}

/** "Regulars": the lines your own runs relied on most; search for any other Pokémon; your own words. */
function Regulars({ d, set, lines, runs, share }) {
  const [q, setQ] = useState('');
  const words = q.trim().toLowerCase();
  const regulars = (words ? lines.filter((l) => speciesName(l.species).toLowerCase().includes(words) || speciesName(l.line).toLowerCase().includes(words)) : lines).slice(0, REGULARS);
  const others = words ? searchSpecies(q, speciesName).filter((id) => !lines.some((l) => l.species === id)).slice(0, 8) : [];
  const pickLine = (species, line) => set({ trusted: { species, line }, legacy: null });
  return html`<div class="pe-pick pe-regs">
    <${Search} value=${q} onInput=${setQ} placeholder=${t('sc.searchMon', 'Search any Pokémon')} />
    <label class="field pe-note"><span>${t('sc.inYourWords', 'In your words (optional)')}</span>
      <input type="text" maxLength=${TRUSTED_NOTE_MAX} value=${d.note} placeholder=${t('sc.notePh', 'e.g. carried me through Victory Road')} onInput=${(e) => set({ note: e.target.value })} /></label>
    ${regulars.length > 0 ? html`<div class="pe-reglist" role="radiogroup" aria-label=${t('sc.regularsAria', 'Your regulars')}>${regulars.map((l) => {
      const on = d.trusted?.line === l.line;
      return html`<button type="button" role="radio" key=${l.line} aria-checked=${on} class=${`sc-reg pe-reg ${on ? 'on' : ''}`} onClick=${() => pickLine(l.species, l.line)}>
        <span class="sc-reg-rank" aria-hidden="true">${lines.indexOf(l) + 1}</span><${Sprite} id=${l.species} gen=${5} size=${56} alt="" />
        <b>${speciesName(l.species)}</b><span class="sc-reg-stats tiny"><span>${t('sc.teamsN', '{count} team|{count} teams', { count: l.teams })}</span><span>${t('sc.lvN', 'Lv {n}', { n: l.top })}</span>
          ${l.fell > 0 ? html`<span class="bad"><${Icon} name="grave" size=${10} />${l.fell}</span>` : html`<span class="ok">${t('sc.neverFell', 'never fell')}</span>`}</span></button>`;
    })}</div>` : !words && html`<p class="small muted">${t('sc.noLines', 'Your runs on this computer haven’t caught anything yet – search for any Pokémon.')}</p>`}
    ${others.length > 0 && html`<div class="stack-s"><span class="pf-tag">${t('sc.anyOther', 'Any other Pokémon')}</span>
      <div class="sc-others" role="radiogroup" aria-label=${t('sc.anyOther', 'Any other Pokémon')}>${others.map((id) => html`<button type="button" role="radio" key=${id} aria-checked=${d.trusted?.species === id}
        class=${`sc-other ${d.trusted?.species === id ? 'on' : ''}`} onClick=${() => pickLine(id, lineRoot(id, pokeapi()?.evolvesFrom))}><${Sprite} id=${id} gen=${5} size=${40} alt="" /><span>${speciesName(id)}</span></button>`)}</div></div>`}
    ${words && !regulars.length && !others.length && html`<p class="small muted">${t('sc.noPokemon', 'No Pokémon matches.')}</p>`}
    <div class="row pe-regs-foot"><p class="pe-hint grow">${share ? t('pe.regsHint', 'From your {n} runs on this computer. The numbers update themselves.', { n: runs }) : t('sc.wordsHintPrivate', 'Shown under the name. Teams, top level and fallen show once “Show my runs on my profile” is on.')}</p>
      ${(d.trusted || d.legacy) && html`<button type="button" class="btn small ghost" onClick=${() => set({ trusted: null, legacy: null, note: '' })}>${t('sc.clear', 'Remove')}</button>`}</div>
  </div>`;
}

/** The favourite game: the games of your runs first, then every game souldew knows; any other title by typing it. */
function FavPick({ value, onPick, played }) {
  const { library } = useApp();
  const [q, setQ] = useState('');
  const all = useMemo(() => {
    const known = (gameCatalog()?.games || []).filter((g) => !g.variantOf).map((g) => shortTitle({ gameId: g.id })).filter(Boolean);
    return [...new Set([...played, ...known])];
  }, [played.join('|')]);
  const words = q.trim().toLowerCase();
  const shown = all.filter((g) => !words || g.toLowerCase().includes(words)).slice(0, words ? 40 : 24);
  const exact = all.some((g) => g.toLowerCase() === words);
  return html`<div class="pe-pick">
    <${Search} value=${q} onInput=${setQ} placeholder=${t('pe.searchGames', 'Search any game')} />
    <div class="pe-games" role="radiogroup" aria-label=${t('pe.fav', 'Favourite game')}>${shown.map((g) => {
      const c = coverForTitle(library, g);
      return html`<button type="button" role="radio" aria-checked=${value === g} class=${`pe-game ${value === g ? 'on' : ''}`} onClick=${() => onPick(g)}>
        ${c ? html`<img class="pixel" src=${c} alt="" />` : html`<span class="pe-game-blank"><${Icon} name="play" size=${14} /></span>`}<span class="tiny ellipsis">${g}</span></button>`;
    })}</div>
    <div class="row">${words && !exact && html`<button type="button" class="btn small" onClick=${() => onPick(q.trim().slice(0, FAVORITE_MAX))}>${t('pe.useTyped', 'Use “{name}”', { name: q.trim().slice(0, FAVORITE_MAX) })}</button>`}
      <p class="pe-hint grow">${t('pe.favHint', 'The games of your runs first.')}</p>
      ${value && html`<button type="button" class="btn small ghost" onClick=${() => onPick('')}>${t('sc.clear', 'Remove')}</button>`}</div>
  </div>`;
}

function PrivacyPick({ d, set, me }) {
  const row = (k, title, sub, opts) => html`<div class="pe-prow"><div><b>${title}</b><span class="tiny faint">${sub}</span></div>
    <div class=${`pe-popts n-${opts.length}`} role="radiogroup" aria-label=${title}>${opts.map(([v, l, s], i) => html`<button type="button" role="radio" aria-checked=${d[k] === v} data-pad-first=${k === 'vis' && i === 0 ? '' : undefined}
      class=${`pe-popt ${d[k] === v ? 'on' : ''}`} onClick=${() => set({ [k]: v })}><b>${l}</b>${s && html`<span class="tiny muted">${s}</span>`}</button>`)}</div></div>`;
  return html`<div class="pe-pick pe-privacy">
    ${row('vis', t('pe.pvProfile', 'My profile'), t('pe.pvProfileSub', 'Who can open this page'), [['friends', t('acct.visFriends', 'My friends'), t('pe.pvFriendsSub', 'Only people you added')],
      ['link', t('acct.visLink', 'Anyone with my handle'), t('pe.pvLinkSub', '@{handle} opens it', { handle: me.handle })], ['nobody', t('acct.visNobody', 'Only me'), t('pe.pvNobodySub', 'Friends see your name only')]])}
    ${row('runs', t('pe.pvRuns', 'Runs and numbers'), t('pe.pvRunsSub', 'The numbers and the run history'), [[true, t('pe.pvShown', 'Shown'), null], [false, t('pe.pvPrivate', 'Private'), null]])}
    ${row('presence', t('pe.pvNow', 'What I’m playing'), t('pe.pvNowSub', 'The “Now” card and the green dot'), [['friends', t('acct.visFriends', 'My friends'), null], ['offline', t('acct.presOffline', 'Appear offline'), null], ['nobody', t('acct.presNobody', 'Hide me completely'), null]])}
    <p class="pe-hint">${t('pe.pvMore', 'Location, sign-in, devices and blocked players stay in Settings › Account.')}</p>
  </div>`;
}

// ---- the editor -----------------------------------------------------------------------------------------------------------
/**
 * me: the saved account (lib/account.mjs); presence: what friends would see now (the "Now" card); meta: the masthead's
 * meta line; part: a part to open first (#/profile?edit=trophies); onExit(): leave the edit state (back to #/profile).
 */
export function ProfileEditor({ me, presence, meta, part = null, onExit }) {
  const { toast, navigate } = useApp();
  const cat = useCatalog();
  const tr = useTrophies();
  useCosmetics();
  const [initial] = useState(() => draftFrom(me));
  const [d, setD] = useState(initial);
  const [open, setOpenS] = useState(ORDER.includes(part) ? part : null);
  const [slot, setSlot] = useState(() => Math.max(0, initial.trophies.findIndex((x) => !x)));
  const [focus, setFocus] = useState(null);
  const [choices, setChoices] = useState(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(null); // the address a leave wanted while there were unsaved changes
  const stage = useRef(null);
  const drawer = useRef(null);
  useEffect(() => {
    editorChoices().then(setChoices, () => setChoices({ achievements: [], lines: [], games: [], runs: 0 }));
  }, []);
  const set = (patch) => setD((x) => ({ ...x, ...patch }));
  const changed = changedParts(initial, d);
  const changedRef = useRef(changed);
  changedRef.current = changed;
  const released = useRef(false);
  // leaving with unsaved changes asks once (Cancel and Save don't)
  useEffect(() => setLeaveGuard((next) => {
    if (released.current || !leaveAsks(next, changedRef.current.length > 0)) return false;
    setAsking(next);
    return true;
  }), []);

  const tier = me.entitlement?.tier || 'none';
  const member = isPlus(tier);
  // a souldew+ pick that can't be kept: the service's catalog says so for this tier (or, without the catalog, the item
  // is souldew+ and the player isn't a member). What is already saved stays saved.
  const lockedPart = (k) => {
    const id = d[k];
    if (!id || id === initial[k]) return false;
    const svc = (cat?.cosmetics || []).find((c) => c.kind === k && c.id === id);
    if (svc) return (RANK[tier] || 0) < (NEEDS[svc.tier] ?? 2);
    const local = (k === 'frame' ? cosCatalog().frames : cosCatalog().banners).find((x) => x.id === id);
    return !!local?.plus && !member;
  };
  const locked = LOCKABLE.filter(lockedPart);

  const earned = useMemo(() => {
    const mine = (tr?.achievements || []).filter((a) => a.ok);
    const ok = cat ? new Set((cat.cosmetics || []).filter((c) => c.kind === 'trophy').map((c) => c.id)) : null;
    // on the profile but earned on another computer: offered too, so nothing silently disappears
    const elsewhere = initial.trophies.filter((id) => id && !mine.some((a) => toCatalogId(a.id) === id)).map((id) => achOf(id)).filter(Boolean);
    return [...mine.filter((a) => !ok || !ok.size || ok.has(toCatalogId(a.id))), ...elsewhere];
  }, [tr, cat]);
  const titles = useMemo(() => {
    const got = new Set([...(choices?.achievements || []).map(toCatalogId), ...earned.map((a) => toCatalogId(a.id))]);
    const known = cat?.cosmetics?.length ? new Set(cat.cosmetics.filter((c) => c.kind === 'title').map((c) => c.id)) : null;
    return [...got, ...(initial.title ? [initial.title] : [])].filter((id, i, a) => a.indexOf(id) === i && fromCatalogId(id) && (!known || known.has(id) || id === initial.title))
      .sort((a, b) => (RARITY_RANK[DEFS[fromCatalogId(b)]?.rarity] ?? 0) - (RARITY_RANK[DEFS[fromCatalogId(a)]?.rarity] ?? 0) || achTitle(a).localeCompare(achTitle(b)));
  }, [choices, earned, cat]);
  const lines = choices?.lines || [];

  const accent = accentHex(cat, d.accent);
  const discord = me.discord?.globalName || me.discord?.username || me.name;
  const known = d.trusted ? lines.find((l) => l.line === d.trusted.line) : null;
  const prof = {
    ...me, banner: d.banner, frame: d.frame, nameplate: d.nameplate, title: d.title, accent: d.accent,
    name: d.name.trim() || discord, status: d.status.trim() || null, showcaseLayout: d.layout,
    showcase: {
      trophies: d.trophies,
      trusted: d.trusted ? { ...d.trusted, note: d.note.trim() || null, teams: d.runs && known ? known.teams : null, topLevel: known?.top ?? null, fell: known?.fell ?? null } : null,
      trustedText: d.trusted ? null : d.legacy, favoriteGame: d.fav.trim() || null,
    },
  };

  const exit = () => {
    released.current = true;
    onExit();
  };
  const save = async () => {
    const patch = savePatch(initial, d, { locked });
    const kept = locked.map((k) => cosCatalog()[k === 'frame' ? 'frames' : 'banners'].find((x) => x.id === d[k])?.name).filter(Boolean);
    if (!patch) {
      if (kept.length) toast({ kind: 'info', title: t('pe.nothingSaved', 'Nothing to save'), text: t('pe.keptFree', '{names} stays a preview – your free one is kept.', { names: kept.join(', ') }) });
      return exit();
    }
    setBusy(true);
    try {
      await updateMe(patch);
      toast({ kind: 'ok', title: t('pf.saved', 'Profile saved'), text: kept.length ? t('pe.keptFree', '{names} stays a preview – your free one is kept.', { names: kept.join(', ') }) : undefined });
      exit();
    } catch (e) {
      toast({ kind: 'death', title: t('pf.saveFailed', 'Couldn’t save the profile'), text: e.message });
      setBusy(false);
    }
  };

  // ---- opening parts ----
  const setOpen = (id, o = {}) => {
    if (o.slot != null) setSlot(o.slot);
    else if (id === 'trophies' && open !== 'trophies') {
      const empty = d.trophies.findIndex((x) => !x);
      setSlot(empty >= 0 ? empty : 0);
    }
    setFocus(o.focus || null);
    setOpenS(id);
  };
  const back = () => {
    const was = open;
    setOpenS(null);
    setTimeout(() => drawer.current?.querySelector(`[data-card="${was}"]`)?.focus({ preventScroll: true }), 30);
  };
  // #/profile?edit=<part> while already editing (the showcase's "Arrange", a link): that part's picker
  useEffect(() => { if (ORDER.includes(part) && part !== open) setOpen(part); }, [part]);
  const step = (dir) => setOpen(ORDER[(ORDER.indexOf(open) + dir + ORDER.length) % ORDER.length]);
  // the edited part comes into view in the scaled profile (after the drawer has changed its width)
  useEffect(() => {
    if (!open || !stage.current) return undefined;
    const go = () => {
      const s = stage.current;
      const el = s?.querySelector(open === 'trophies' ? `.pe-m[data-part="trophies"][data-slot="${slot}"]` : `.pe-m[data-part="${open}"]`);
      if (!el) return;
      const sr = s.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (r.top < sr.top + 40 || r.bottom > sr.bottom - 40) s.scrollBy({ top: r.top - sr.top - Math.max(40, (sr.height - r.height) / 2.4) });
    };
    const t0 = setTimeout(go, 330);
    const t1 = setTimeout(() => {
      const ae = document.activeElement;
      if (!drawer.current?.contains(ae) || ae?.closest('.pe-phead')) return;
      drawer.current.querySelector('.pe-body [data-pad-first]')?.focus({ preventScroll: true });
    }, 60);
    return () => { clearTimeout(t0); clearTimeout(t1); };
  }, [open, slot, d.layout]);
  useEffect(() => {
    const key = (e) => {
      if (asking) return;
      if (e.key === 'Escape' && open) { e.preventDefault(); back(); }
      if (open && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); step(e.key === 'ArrowLeft' ? -1 : 1); }
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  });

  const wide = open && PARTS[open].wide;
  const mark = (part, body, o = {}) => {
    if (!body) return null;
    const sel = open === part && (part !== 'trophies' || o.slot === slot);
    return html`<div class=${`pe-m ${o.inline ? 'pe-m-inline' : ''} ${o.cls || ''} ${sel ? 'sel' : ''}`} data-part=${part} data-slot=${o.slot ?? undefined}
      onClick=${(e) => { e.stopPropagation(); setOpen(part, { slot: o.slot, focus: o.cls === 'pe-m-status' ? 'status' : null }); }}>
      <span class="pe-m-tag" aria-hidden="true">${part === 'trophies' ? t('pe.trophyN', 'Trophy {n}', { n: (o.slot ?? 0) + 1 }) : o.label || partLabel(part)}</span>${body}</div>`;
  };
  const tags = { banner: locked.includes('banner') && html`<span class="pe-preview-tag"><${PlusMark} />${t('pf.preview', 'Preview')}</span>` };
  const lockLine = (parts) => {
    if (!parts.length) return null;
    const names = parts.map((k) => cosCatalog()[k === 'frame' ? 'frames' : 'banners'].find((x) => x.id === d[k])?.name).filter(Boolean).join(', ');
    const text = parts.length > 1 ? t('pe.lockMany', '{names} come with souldew+. Try them on as long as you like – Save keeps your free ones.', { names })
      : { banner: t('pe.lockBanner', '{names} comes with souldew+. Try it on as long as you like – Save keeps your free banner.', { names }),
        frame: t('pe.lockFrame', '{names} comes with souldew+. Try it on as long as you like – Save keeps your free frame.', { names }),
        nameplate: t('pe.lockPlate', '{names} comes with souldew+. Try it on as long as you like – Save keeps your free nameplate.', { names }) }[parts[0]];
    return html`<div class="pe-lock"><${PlusMark} /><span class="small">${text}</span>
      <a class="small" href="#/plus" onClick=${(e) => { e.preventDefault(); navigate('plus'); }}>${t('pf.aboutPlus', 'About souldew+')}</a></div>`;
  };
  const card = (id) => {
    const ch = partChanged(initial, d, id);
    const value = valueOf(id, d, prof);
    return html`<button type="button" class=${`pe-pcard ${ch ? 'changed' : ''}`} data-card=${id} aria-label=${`${partLabel(id)}: ${value}${ch ? ` · ${t('pe.changedAria', 'changed, not saved yet')}` : ''}`} onClick=${() => setOpen(id)}>
      <${PartThumb} id=${id} d=${d} prof=${prof} accent=${accent} earned=${tr?.achievements} />
      <span class="pe-pcard-txt"><b>${partLabel(id)}</b><span class="small muted ellipsis">${value}</span></span>
      <span class="pe-pcard-end">${locked.includes(id) && html`<${PlusMark} title=${t('pe.plusPreview', 'souldew+ – a preview')} />`}${ch && html`<i class="pe-dot" title=${t('pe.changedAria', 'changed, not saved yet')}></i>`}<span class="pe-chev" aria-hidden="true"></span></span></button>`;
  };
  const picker = (id) => {
    switch (id) {
      case 'banner': return html`<${CosPick} kind="banners" value=${d.banner} onPick=${(x) => set({ banner: x })} member=${member} prof=${prof} accent=${accent} />`;
      case 'frame': return html`<${CosPick} kind="frames" value=${d.frame} onPick=${(x) => set({ frame: x })} member=${member} prof=${prof} accent=${accent} />`;
      case 'nameplate': return html`<${CosPick} kind="nameplates" value=${d.nameplate} onPick=${(x) => set({ nameplate: x })} member=${member} prof=${prof} accent=${accent} />`;
      case 'accent': return html`<${AccentPick} value=${d.accent} onPick=${(x) => set({ accent: x })} accents=${cat?.accents?.length ? cat.accents : ACCENTS} />`;
      case 'name': return html`<${NamePick} d=${d} set=${set} me=${me} focus=${focus} />`;
      case 'title': return html`<${TitlePick} value=${d.title} onPick=${(x) => set({ title: x })} titles=${titles} />`;
      case 'layout': return html`<${LayoutPick} value=${d.layout} onPick=${(x) => set({ layout: x })} />`;
      case 'trophies': return html`<${Cabinet} d=${d} setTrophies=${(x) => set({ trophies: x })} slot=${slot} setSlot=${setSlot} earned=${earned} />`;
      case 'trusted': return html`<${Regulars} d=${d} set=${set} lines=${lines} runs=${choices?.runs || 0} share=${d.runs} />`;
      case 'fav': return html`<${FavPick} value=${d.fav} onPick=${(x) => set({ fav: x })} played=${(choices?.games || []).map((g) => g.title)} />`;
      case 'privacy': return html`<${PrivacyPick} d=${d} set=${set} me=${me} />`;
      default: return null;
    }
  };
  const n = changed.length;
  return html`<div class=${`pe ${open ? 'is-open' : ''} ${wide ? 'is-wide' : ''}`} style=${accent ? `--acc:${accent}` : ''}>
    <div class="pe-bar"><span class=${`led amber ${n ? 'on' : ''}`} aria-hidden="true"></span><b>${t('pe.editing', 'Editing your profile')}</b>
      <span class="small muted grow pe-bar-hint" role="status">${n ? t('pe.changesN', '1 change not saved|{count} changes not saved', { count: n }) : t('pe.barHint', 'Pick a part on the right, or click it on your profile')}</span>
      <button type="button" class="btn ghost" onClick=${exit}>${t('common.cancel', 'Cancel')}</button>
      <button type="button" class="btn primary" disabled=${busy} onClick=${save}>${t('common.save', 'Save')}</button></div>
    <div class="pe-grid">
      <section class="pe-stage" ref=${stage} aria-label=${t('pe.stageAria', 'Your profile, as friends see it')}>
        ${locked.length > 0 && !open && html`<div class="pe-stage-lock">${lockLine(locked)}</div>`}
        ${open === 'nameplate' && html`<div class="pe-cap"><span class="pe-kicker">${t('pe.whereShows', 'Where your nameplate shows')}</span></div><div class="pe-scene"><${FriendsScene} prof=${prof} accent=${accent} /></div>`}
        <div class="pe-cap"><span class="pe-kicker">${t('pe.asFriends', 'Your profile · as friends see it')}</span><span class="tiny faint pe-cap-hint">${t('pe.clickAny', 'Click any part to change it')}</span></div>
        <${Zoom}><${ProfilePreview} me=${me} prof=${prof} d=${d} accent=${accent} presence=${presence} meta=${meta} mark=${mark} tags=${tags} /><//>
      </section>
      <aside class="pe-drawer" ref=${drawer} aria-label=${open ? partLabel(open) : t('pe.partsAria', 'Parts of your profile')} data-pad-layer=${open ? '' : undefined}>
        ${open ? html`
          <div class="pe-phead">
            <button type="button" class="btn small ghost pe-back" data-pad-back onClick=${back}><span class="pe-chev l" aria-hidden="true"></span>${t('pe.allParts', 'All parts')}</button>
            <span class="spacer"></span>
            <button type="button" class="btn icon ghost pe-step" aria-label=${t('pe.prevPart', 'Previous part')} onClick=${() => step(-1)}><span class="pe-chev l" aria-hidden="true"></span></button>
            <div class="pe-dots" data-pad-tabs role="tablist" aria-label=${t('pe.partsAria', 'Parts of your profile')}>${ORDER.map((id) => html`<button type="button" role="tab" aria-selected=${open === id}
              class=${`pe-pdot ${open === id ? 'on' : ''} ${partChanged(initial, d, id) ? 'changed' : ''}`} title=${partLabel(id)} aria-label=${partLabel(id)} onClick=${() => setOpen(id)}></button>`)}</div>
            <button type="button" class="btn icon ghost pe-step" aria-label=${t('pe.nextPart', 'Next part')} onClick=${() => step(1)}><span class="pe-chev" aria-hidden="true"></span></button>
          </div>
          <div class="pe-ptitle"><div class="pe-ptitle-t"><h2>${partLabel(open)}</h2><span class="small muted">${partWhere(open)}</span></div>
            ${partChanged(initial, d, open) && html`<button type="button" class="btn small ghost pe-revert" onClick=${() => setD((x) => revertPart(initial, x, open))}>${t('pe.backToSaved', 'Back to saved')}</button>`}</div>
          <div class=${`pe-body p-${open}`}>${picker(open)}</div>
          ${locked.includes(open) && html`<div class="pe-drawer-lock">${lockLine([open])}</div>`}`
        : html`<div class="pe-list">${GROUPS.map(([g, ids]) => html`<div class="pe-lgroup"><span class="pe-kicker">${groupLabel(g)}</span>${ids.map(card)}</div>`)}</div>`}
        <div class=${`pe-foot ${open === 'nameplate' || open === 'frame' || open === 'name' ? 'hot' : ''}`}><span class="pe-kicker">${t('pe.howFriends', 'How friends see you')}</span><${FriendsScene} prof=${prof} accent=${accent} small /></div>
      </aside>
    </div>
    ${asking && html`<${Modal} open onClose=${() => setAsking(null)} title=${t('pe.leaveTitle', 'Leave without saving?')}
      footer=${html`<button type="button" class="btn ghost" onClick=${() => { const to = asking; released.current = true; setAsking(null); location.hash = to; }}>${t('pe.leaveDiscard', 'Discard changes')}</button>
        <button type="button" class="btn primary" onClick=${() => setAsking(null)}>${t('pe.leaveStay', 'Keep editing')}</button>`}>
      <p>${t('pe.leaveText', '1 change to your profile isn’t saved yet.|{count} changes to your profile aren’t saved yet.', { count: n })}</p>
    <//>`}
  </div>`;
}
