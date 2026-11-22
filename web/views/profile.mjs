// The souldew profile (look "A – Logbook"): banner, avatar with frame and presence, name in its nameplate, title,
// the numbers and run history (only when the player opted in to "Show my runs on my profile"), what they do now,
// most trusted, favourite game and the showcase. #/profile is your own (with "Edit profile"), #/profile?id=<user> a
// friend's (with "Invite to a run"). #/profile?edit=1 is your own in its edit state – the parts drawer of
// views/profileedit.mjs (banner, frame, nameplate, accent, name & status, title, showcase layout, trophies, most
// trusted, favourite game, who sees what), one Save / Cancel; souldew+ items can be tried on by everyone, never pushed.
import { html, useState, useEffect, useMemo } from '/vendor/htm-preact.mjs';
import { useApp, Led } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t } from '../lib/i18n.mjs';
import { settingsLink } from '../lib/settingsindex.mjs';
import { useAccount, useCatalog, accentHex, profileOf, updateMe, useFriends, askToJoin } from '../lib/account.mjs';
import { presenceFrom } from '../lib/friendpresence.mjs';
import { takenSlots } from './invitecode.mjs';
import { Avatar, presenceText, canAskToJoin, Badges, TitlePlate, achTitle } from './social.mjs';
import { SignInFirst, InviteModal, coverForTitle } from './friends.mjs';
import { Banner, PlusMark } from '../lib/cosmetics/components.mjs';
import { catalog as cosmetics } from '../lib/cosmetics/index.mjs';
import { DEFAULT_SHOWCASE_LAYOUT } from '/shared/social.mjs';
import { ShowcaseCase, ShowcaseLcd, ShowcaseShelf } from './showcase.mjs';
import { ProfileEditor } from './profileedit.mjs';

const monthYear = (ms) => (ms ? new Date(ms).toLocaleDateString(document.documentElement.lang || undefined, { month: 'long', year: 'numeric' }) : '');
const shortDate = (ms) => (ms ? new Date(ms).toLocaleDateString(document.documentElement.lang || undefined, { month: 'short', year: 'numeric' }) : '');

function Stat({ n, label, tone }) {
  return html`<div class=${`pf-stat ${tone || ''}`}><b>${n == null ? '–' : n.toLocaleString()}</b><span>${label}</span></div>`;
}

export function StatsStrip({ stats }) {
  const s = stats?.totals || {};
  return html`<div class="pf-stats">
    <${Stat} n=${s.runsStarted} label=${t('pf.runs', 'Runs')} />
    <${Stat} n=${s.runsCompleted} label=${t('pf.won', 'Won')} tone="ok" />
    <${Stat} n=${s.pokemonCaught} label=${t('pf.caught', 'Caught')} />
    <${Stat} n=${s.deaths} label=${t('pf.fallen', 'Fallen')} tone="bad" />
    <${Stat} n=${s.badgesEarned} label=${t('pf.badges', 'Badges')} />
    <${Stat} n=${s.playtimeMinutes == null ? null : Math.round(s.playtimeMinutes / 60)} label=${t('pf.hours', 'Hours')} />
  </div>`;
}

function Pips({ n, of = 8 }) {
  const total = n > 8 ? 16 : of;
  return html`<span class="pf-pips" role="img" aria-label=${t('pf.badgesN', '{n} badges', { n })}>${Array.from({ length: total }, (_, i) => html`<i class=${i < n ? 'on' : ''}></i>`)}</span>`;
}

const resultLabel = (r) => ({ won: t('pf.rWon', 'Won'), lost: t('pf.rLost', 'Wiped'), abandoned: t('pf.rEnded', 'Ended'), active: t('pf.rActive', 'Live') }[r] || r);

export function RunHistory({ stats, title }) {
  const { library } = useApp();
  const [filter, setFilter] = useState('all');
  const runs = (stats?.recentRuns || []).filter((r) => filter === 'all' || (filter === 'nuzlocke' ? r.mode !== 'soullink' : r.mode === 'soullink'));
  return html`<section class="pf-section">
    <div class="pf-head"><h2>${title}</h2><span class="pf-rule"></span>
      <div class="seg small" role="group">${[['all', t('pf.all', 'All')], ['soullink', t('nav.soullink', 'SoulLink')], ['nuzlocke', t('nav.nuzlocke', 'Nuzlocke')]].map(([id, label]) => html`<button class=${filter === id ? 'on' : ''} aria-pressed=${filter === id} onClick=${() => setFilter(id)}>${label}</button>`)}</div></div>
    ${runs.length ? html`<table class="pf-table">
      <thead><tr><th></th><th>${t('pf.colRun', 'Run')}</th><th>${t('pf.badges', 'Badges')}</th><th class="num">${t('pf.fallen', 'Fallen')}</th><th>${t('pf.colResult', 'Result')}</th><th class="num">${t('pf.colWhen', 'When')}</th></tr></thead>
      <tbody>${runs.map((r) => {
        const cover = coverForTitle(library, r.game);
        return html`<tr class=${`pf-run ${r.result}`}>
          <td class="pf-cover">${cover ? html`<img class="pixel" src=${cover} alt="" />` : html`<span></span>`}</td>
          <td><b class="ellipsis">${r.name}</b><span class="small muted">${r.game} · ${r.mode === 'soullink' ? t('nav.soullink', 'SoulLink') : t('nav.nuzlocke', 'Nuzlocke')}</span></td>
          <td><${Pips} n=${r.badges || 0} /></td>
          <td class=${`num ${r.deaths > 10 ? 'bad' : ''}`}>${r.deaths ?? '–'}</td>
          <td><span class=${`pf-result ${r.result}`}>${r.result === 'active' ? html`<${Led} on />` : r.result === 'won' ? html`<${Icon} name="heart" size=${11} />` : r.result === 'lost' ? html`<${Icon} name="grave" size=${11} />` : ''}${resultLabel(r.result)}</span></td>
          <td class="num small muted">${r.result === 'active' ? t('pf.nowShort', 'now') : shortDate(r.endedAt)}</td>
        </tr>`;
      })}</tbody></table>` : html`<p class="small muted">${t('pf.noRuns', 'No runs here yet.')}</p>`}
  </section>`;
}

export function NowCard({ presence, own, name, onAsk, asked }) {
  const p = presence;
  const live = p && (p.state === 'in_run' || p.state === 'playing');
  return html`<section class="pf-section">
    <div class="pf-head"><h2>${t('pf.now', 'Now')}</h2><span class="pf-rule"></span>
      ${own && html`<span class="pf-tag">${own === 'friends' ? t('pf.visibleFriends', 'Visible to friends') : t('pf.hiddenNow', 'Hidden from friends')}</span>`}</div>
    ${live ? html`<div class="lcd-card pf-now">
      <div class="row"><${Led} on /><span class="px lcd-live">${t('fr.live', 'LIVE')}</span><b class="px">${[p.game?.title, p.run?.name].filter(Boolean).join(' · ')}</b><span class="spacer"></span>
        <span class="small">${[p.location, p.run?.freeSlot ? t('pf.freeSeat', '1 free seat') : ''].filter(Boolean).join(' · ')}</span></div>
      ${!own && canAskToJoin(p) && html`<div class="row fr-live-foot"><span class="small grow">${t('fr.freeAsk', 'This run has a free seat – {name} can let you in.', { name })}</span>
        <button class="btn small primary" disabled=${asked} onClick=${onAsk}>${asked ? t('fr.askedShort', 'Asked') : t('fr.askToJoin', 'Ask to join')}</button></div>`}
    </div>` : html`<p class="small muted pf-quiet">${presenceText(p)}</p>`}
  </section>`;
}

/**
 * The masthead, design "A – Logbook": the banner on top, the avatar
 * overhanging its lower edge – the only thing that may – and below the banner the name row, then the meta row with the
 * actions on its right. test/skin-proof.test.mjs checks the banner stays clear at 1024–1440 px in every skin.
 */
function Masthead({ prof, presence, accent, actions, meta, bannerNote = null }) {
  return html`<header class="pf-mast" style=${accent ? `--acc:${accent}` : ''}>
    <div class="pf-banner"><${Banner} id=${prof.banner || null} size="fill" shade />${bannerNote}</div>
    <div class="pf-id">
      <${Avatar} user=${prof} size=${104} presence=${presence} accent=${accent} />
      <div class="pf-names grow">
        <div class="row tight pf-nameline"><h1 class="pf-name">${prof.name}</h1><${TitlePlate} text=${achTitle(prof.title)} /><${Badges} badges=${prof.badges} /></div>
        <div class="pf-metaline"><div class="small muted pf-meta">${meta}</div>${actions && html`<div class="pf-actions row">${actions}</div>`}</div>
        ${prof.status && html`<p class="pf-status">“${prof.status}”</p>`}
      </div>
    </div>
  </header>`;
}

// ---- the page -------------------------------------------------------------------------------------------------------
export function ProfileView() {
  const { route, navigate, toast, session, manifest, doc, me: slot, linkStatus } = useApp();
  const acct = useAccount();
  const cat = useCatalog();
  const id = route.params.id || null;
  const own = !id || id === acct.me?.id;
  const [other, setOther] = useState(null);
  const [error, setError] = useState(null);
  const [inviting, setInviting] = useState(false);
  const [asked, setAsked] = useState(false);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const { data: friends, reload: reloadFriends } = useFriends(!!acct.session?.signedIn);
  useEffect(() => {
    setOther(null);
    setError(null);
    if (acct.session?.signedIn) reloadFriends(); // another profile: its presence fresh, not from the last poll
    if (!own && acct.session?.signedIn) profileOf(id).then(setOther, (e) => setError(e));
  }, [id, acct.session?.signedIn]);
  const ownPresence = useMemo(() => (own ? presenceFrom({ route: 'profile', session, manifest, doc, me: slot, taken: manifest ? takenSlots(manifest, { me: slot, doc, linkStatus }) : [] }) : null), [own, session, manifest]);
  if (!acct.known) return html`<div class="empty-state"><p class="muted">${t('common.loading', 'Loading …')}</p></div>`;
  if (!acct.session?.signedIn) return html`<div class="stack-l"><${SignInFirst} what=${t('pf.signInTitle', 'Your souldew profile')} /></div>`;
  const prof = own ? acct.me : other;
  if (!prof) {
    if (error) return html`<div class="panel empty-state"><${Icon} name="user" size=${48} /><h2>${t('pf.notVisible', 'This profile isn’t visible')}</h2>
      <p class="muted">${t('pf.notVisibleText', 'It may be private, or the player isn’t on souldew any more.')}</p><button class="btn" onClick=${() => navigate('friends')}>${t('nav.friends', 'Friends')}</button></div>`;
    return html`<div class="empty-state"><p class="muted">${t('common.loading', 'Loading …')}</p></div>`;
  }
  const friend = !own ? friends?.friends?.find((f) => f.user.id === prof.id) : null;
  const presence = own ? (acct.me?.privacy?.presence === 'friends' ? ownPresence : { state: 'offline' }) : friend?.presence || null;
  const accent = accentHex(cat, prof.accent);
  const friendCount = own ? friends?.friends?.length : null;
  const meta = own ? [`@${prof.handle}`, prof.createdAt && t('pf.since', 'on souldew since {date}', { date: monthYear(prof.createdAt) }), friendCount != null && t('pf.friendsN', '1 friend|{count} friends', { count: friendCount })].filter(Boolean).join(' · ')
    : [`@${prof.handle}`, prof.memberSince && t('pf.since', 'on souldew since {date}', { date: monthYear(prof.memberSince) }), friend?.since && t('fr.since', 'friends since {date}', { date: monthYear(friend.since) })].filter(Boolean).join(' · ');
  const ask = async () => {
    try {
      await askToJoin(prof.id);
      setAsked(true);
    } catch (e) {
      toast({ kind: 'death', title: t('fr.askFailed', 'Couldn’t ask to join'), text: e.message });
    }
  };
  // the showcase in the layout the player picked (friends see the same); your own is switched right on the page
  const layout = prof.showcaseLayout || DEFAULT_SHOWCASE_LAYOUT;
  const setLayout = async (showcaseLayout) => {
    setLayoutBusy(true);
    try {
      await updateMe({ showcaseLayout });
    } catch (e) {
      toast({ kind: 'death', title: t('pf.saveFailed', 'Couldn’t save the profile'), text: e.message });
    }
    setLayoutBusy(false);
  };
  const edit = (part) => navigate('profile', { edit: part || '1' });
  // your own profile in its edit state: the parts drawer (views/profileedit.mjs), one Save / Cancel
  if (own && route.params.edit) return html`<${ProfileEditor} key=${acct.me.id} me=${acct.me} presence=${presence} meta=${meta} part=${route.params.edit} onExit=${() => navigate('profile')} />`;
  const scProps = { prof, own, onLayout: own ? setLayout : null, busy: layoutBusy, onEdit: own ? () => edit('trophies') : null };
  // a friend's souldew+ banner says what it is and links to the souldew+ page (on hover / focus – never a pop-up)
  const plusBanner = !own && prof.banner ? cosmetics().banners.find((b) => b.id === prof.banner && b.plus) : null;
  const bannerNote = plusBanner ? html`<a class="pf-banner-note" href="#/plus" onClick=${(e) => { e.preventDefault(); navigate('plus'); }}>
    <${PlusMark} title="" /><span>${t('pf.plusBanner', '{name} · a souldew+ banner', { name: plusBanner.name })}</span></a>` : null;
  const actions = own ? html`<button class="btn ghost" onClick=${() => edit()}><${Icon} name="user" size=${14} />${t('pf.edit', 'Edit profile')}</button>`
    : prof.relationship === 'friend' ? html`<button class="btn go" onClick=${() => setInviting(true)}><${Icon} name="link" size=${14} />${t('fr.inviteTo', 'Invite to a run')}</button>` : null;
  return html`<div class="stack-l profile" style=${accent ? `--acc:${accent}` : ''}>
    ${!own && html`<nav class="pf-crumbs small" aria-label=${t('pf.crumbs', 'Breadcrumb')}><a href="#/friends">${t('nav.friends', 'Friends')}</a><span aria-hidden="true">›</span><span>${prof.name}</span></nav>`}
    <${Masthead} prof=${prof} presence=${presence} accent=${accent} actions=${actions} meta=${meta} bannerNote=${bannerNote} />
    ${prof.stats ? html`<${StatsStrip} stats=${prof.stats} />`
      : html`<div class="pf-private small muted"><${Icon} name="lock" size=${12} />${own ? html`<span>${t('pf.privateOwn', 'Your runs stay private. Turn on “Show my runs on my profile” to show friends your numbers and last runs.')}</span>
          <a href="#" onClick=${(e) => { e.preventDefault(); navigate('settings', settingsLink('account-privacy')); }}>${t('pf.turnOn', 'Privacy settings')}</a>`
        : html`<span>${t('pf.privateOther', '{name} keeps their runs private.', { name: prof.name })}</span>`}</div>`}
    ${layout === 'case' && html`<${ShowcaseCase} ...${scProps} />`}
    <div class=${`pf-cols ${layout === 'case' ? 'sc-one' : ''}`}>
      <div class="pf-main stack-l">
        <${NowCard} presence=${presence} own=${own ? acct.me?.privacy?.presence : null} name=${prof.name} onAsk=${ask} asked=${asked} />
        ${prof.stats && html`<${RunHistory} stats=${prof.stats} title=${own ? t('pf.history', 'Run history') : t('pf.theirRuns', '{name}’s runs', { name: prof.name })} />`}
      </div>
      ${layout === 'lcd' ? html`<${ShowcaseLcd} ...${scProps} />` : layout === 'shelf' ? html`<${ShowcaseShelf} ...${scProps} />` : null}
    </div>
    ${inviting && html`<${InviteModal} friend=${prof} onClose=${() => setInviting(false)} />`}
  </div>`;
}
