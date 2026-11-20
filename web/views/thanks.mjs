// The Thank you page (#/thanks): the people who keep souldew free – Legends, souldew+ members, Supporters and the ones
// who bought a coffee – live from the accounts service's public wall (API.md §13, through the local server). Only people
// who said yes appear by name, wearing their own banner and frame; everyone else is a number ("and 12 more"). Asked when
// the page opens and every minute while it is visible (lib/thanks.mjs); someone new arrives with a short, quiet moment.
// Offline it shows the last wall this computer saw, "as of …". Reached from Help, Settings › About and the souldew+ page.
import { html, useState, useEffect } from '/vendor/htm-preact.mjs';
import { t, currentLang } from '../lib/i18n.mjs';
import { Icon } from '../lib/icons.mjs';
import { api } from '../lib/api.mjs';
import { useApp, openExternal } from '../lib/ui.mjs';
import { LINKS } from '../lib/links.mjs';
import { useAccount } from '../lib/account.mjs';
import { settingsLink } from '../lib/settingsindex.mjs';
import { useCosmetics } from '../lib/cosmetics/components.mjs';
import { usePreviews } from '../lib/cosmetics/previews.mjs';
import { prefersReduced } from '../lib/cosmetics/motion.mjs';
import { createThanksFeed, loadCachedThanks, tierGroups, sinceDate } from '../lib/thanks.mjs';
import { BannerLook, FramedAvatar } from './plus.mjs';

/** Each tier's mark, name and words. Legend = the patron tier (its id stays "patron" elsewhere). */
export const TIER_TEXT = () => ({
  legend: { icon: 'crown', name: t('acct.patron', 'Legend'), title: t('thanks.hLegend', 'Legends'), line: t('thanks.lLegend', 'The ones who give the most, every month.') },
  plus: { icon: 'plus', name: t('rail.plus', 'souldew+'), title: t('thanks.hPlus', 'souldew+ members'), line: t('thanks.lPlus', 'Every month, for the servers and the time.') },
  supporter: { icon: 'heart', name: t('acct.supporter', 'Supporter'), title: t('thanks.hSupporter', 'Supporters'), line: t('thanks.lSupporter', 'A little every month, and it adds up.') },
  coffee: { icon: 'coffee', name: t('thanks.coffee', 'Coffee'), title: t('thanks.hCoffee', 'Bought souldew a coffee'), line: t('thanks.lCoffee', 'One coffee at a time – each one counted.') },
});

/** "New: Lena joined the Legends 🏆" – the moment for someone who just arrived (or moved up). */
export function arrivalText(a) {
  const vars = { name: a.name };
  if (a.tier === 'legend') return t('thanks.newLegend', 'New: {name} joined the Legends 🏆', vars);
  if (a.tier === 'plus') return t('thanks.newPlus', 'New: {name} joined souldew+ 🔗', vars);
  if (a.tier === 'supporter') return t('thanks.newSupporter', 'New: {name} became a Supporter 💧', vars);
  return t('thanks.newCoffee', 'New: {name} bought souldew a coffee ☕', vars);
}

const monthYear = (since) => {
  const d = sinceDate(since);
  return d ? d.toLocaleDateString(currentLang(), { month: 'long', year: 'numeric', timeZone: 'UTC' }) : '';
};
/** "as of 14:02" today, "as of 3 November, 14:02" before. */
export function asOfText(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  const when = today ? d.toLocaleTimeString(currentLang(), { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString(currentLang(), { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  return t('thanks.asOf', 'as of {time}', { time: when });
}

/**
 * One person as the wall shows them. size: legend (a big card on their banner), plus (a card with a banner strip),
 * supporter (a row with the framed picture), coffee (a small name tag). Also the ask card's preview (views/thanksask.mjs).
 */
export function PersonCard({ p, size = p.tier, fresh = false, you = false }) {
  const [hot, setHot] = useState(false);
  const on = { onPointerEnter: () => setHot(true), onPointerLeave: () => setHot(false), onfocusin: () => setHot(true), onfocusout: () => setHot(false) };
  const who = { avatar: p.avatar, name: p.name };
  const since = p.since ? t('thanks.since', 'since {date}', { date: monthYear(p.since) }) : '';
  const cls = `ty-person ty-${size}${fresh ? ' ty-fresh' : ''}${you ? ' ty-you' : ''}`;
  const label = [p.name, TIER_TEXT()[p.tier]?.name, since].filter(Boolean).join(' · ');
  if (size === 'coffee') {
    return html`<li class=${cls} aria-label=${label}><${Icon} name="coffee" size=${12} /><span class="ty-name">${p.name}</span></li>`;
  }
  if (size === 'supporter') {
    return html`<li class=${cls} tabIndex="0" aria-label=${label} ...${on}>
      <${FramedAvatar} me=${who} frame=${p.frame} size=${40} loop=${hot} />
      <span class="ty-text"><b class="ty-name">${p.name}</b>${since && html`<span class="ty-since">${since}</span>`}</span></li>`;
  }
  const big = size === 'legend';
  return html`<li class=${cls} tabIndex="0" aria-label=${label} ...${on}>
    <div class="ty-banner">${p.banner ? html`<${BannerLook} id=${p.banner} loop=${hot && !prefersReduced()} />` : html`<span class="ty-banner-blank" aria-hidden="true"></span>`}</div>
    <div class="ty-id"><${FramedAvatar} me=${who} frame=${p.frame} size=${big ? 64 : 48} loop=${hot} />
      <span class="ty-text"><b class="ty-name">${p.name}</b>${since && html`<span class="ty-since">${since}</span>`}</span></div>
  </li>`;
}

function TierSection({ g, fresh }) {
  const tx = TIER_TEXT()[g.tier];
  const list = g.tier === 'coffee' ? 'ty-tags' : g.tier === 'supporter' ? 'ty-rows' : `ty-cards ty-cards-${g.tier}`;
  return html`<section class=${`ty-tier ty-tier-${g.tier}`} aria-labelledby=${`ty-h-${g.tier}`}>
    <div class="ty-tier-head">
      <span class="ty-mark" aria-hidden="true"><${Icon} name=${tx.icon} size=${14} /></span>
      <div class="ty-tier-words"><h2 id=${`ty-h-${g.tier}`}>${tx.title}</h2><span class="small muted">${tx.line}</span></div>
      <span class="ty-count" title=${t('thanks.countHint', 'Everyone in this tier, named or not')}>${g.count}</span>
    </div>
    ${g.people.length > 0 && html`<ul class=${list} role="list">${g.people.map((p) => html`<${PersonCard} key=${p.name} p=${p} fresh=${fresh.has(p.name)} />`)}</ul>`}
    ${g.more > 0 && html`<p class="ty-more">${g.people.length
      ? t('thanks.more', 'and {count} more who supports quietly|and {count} more who support quietly', { count: g.more })
      : t('thanks.onlyQuiet', '{count} person, supporting quietly|{count} people, supporting quietly', { count: g.more })}</p>`}
  </section>`;
}

/** The short moment for who just arrived: one at a time, a few seconds each, never with reduced motion's movement. */
function Moments({ queue, onDone }) {
  const cur = queue[0];
  useEffect(() => {
    if (!cur) return undefined;
    const id = setTimeout(onDone, 5200);
    return () => clearTimeout(id);
  }, [cur]);
  return html`<div class="ty-moment-slot" aria-live="polite">${cur && html`<div class=${`ty-moment ty-moment-${cur.tier}`} key=${cur.name + cur.tier}>
    <span class="ty-mark" aria-hidden="true"><${Icon} name=${TIER_TEXT()[cur.tier].icon} size=${12} /></span><span>${arrivalText(cur)}</span></div>`}</div>`;
}

function useThanks() {
  const [s, setS] = useState(() => {
    const c = loadCachedThanks();
    return { thanks: c?.thanks || null, fetchedAt: c?.fetchedAt || null, stale: !!c, error: null, loading: true, arrivals: [] };
  });
  useEffect(() => {
    const feed = createThanksFeed({
      cached: loadCachedThanks(),
      load: (have) => api.get(`/api/account/thanks${have ? `?have=${encodeURIComponent(have)}` : ''}`),
      onUpdate: (st) => setS((old) => ({ ...st, loading: old.loading && !st.fetchedAt && !st.error })),
    });
    feed.start();
    return () => feed.stop();
  }, []);
  return s;
}

function LiveState({ s }) {
  if (s.loading && !s.thanks) return html`<span class="ty-live small muted">${t('common.loading', 'Loading …')}</span>`;
  if (s.stale || s.error) {
    return html`<span class="ty-live ty-live-off small" role="status"><span class="ty-dot" aria-hidden="true"></span>${s.error === 'thanksMissing'
      ? t('thanks.missing', 'The Thank you page isn’t available yet.')
      : s.fetchedAt ? t('thanks.offline', 'Offline – {asOf}', { asOf: asOfText(s.fetchedAt) }) : t('thanks.offlineNone', 'Offline – the list shows up once you’re online.')}</span>`;
  }
  return html`<span class="ty-live small" title=${asOfText(s.fetchedAt)}><span class="ty-dot on" aria-hidden="true"></span>${t('thanks.live', 'Live')}</span>`;
}

function SupportCta({ signedIn, listed, navigate }) {
  return html`<section class="ty-cta">
    <div class="ty-cta-words">
      <h2>${t('thanks.ctaT', 'Want to help too?')}</h2>
      <p class="small muted">${t('thanks.ctaText', 'souldew stays free either way. If you’d like to chip in – monthly or a single coffee – it goes into the servers, the signing certificates and the time. Your name appears here only if you say so.')}</p>
    </div>
    <div class="ty-cta-actions">
      <button type="button" class="btn" onClick=${() => openExternal(LINKS.membership)}><${Icon} name="external" size=${14} />${t('thanks.ctaBtn', 'Support souldew')}</button>
      <button type="button" class="btn ghost" onClick=${() => navigate('plus')}>${t('thanks.ctaPlus', 'What souldew+ adds')}</button>
      ${signedIn && html`<a href="#" class="small" onClick=${(e) => { e.preventDefault(); navigate('settings', settingsLink('account-privacy')); }}>${listed ? t('thanks.manageMine', 'Your name is on this page – change it in Settings') : t('thanks.showMine', 'Supporting already? Show your name here')}</a>`}
    </div>
  </section>`;
}

export function ThanksView() {
  const { navigate } = useApp();
  const acct = useAccount();
  useCosmetics();
  usePreviews();
  const s = useThanks();
  const [queue, setQueue] = useState([]);
  const [fresh, setFresh] = useState(() => new Set());
  useEffect(() => {
    if (!s.arrivals?.length) return;
    // at most three moments in a row; the rest only get the soft highlight
    setQueue((q) => [...q, ...s.arrivals.slice(0, 3)]);
    setFresh(new Set(s.arrivals.map((a) => a.name)));
    const id = setTimeout(() => setFresh(new Set()), 9000);
    return () => clearTimeout(id);
  }, [s.arrivals]);
  const groups = tierGroups(s.thanks);
  const total = s.thanks?.total || 0;
  const me = acct.me;
  const listed = !!me && me.privacy?.showOnThanks === true;
  return html`<div class="ty-page">
    <header class="ty-hero">
      <span class="plus-kicker">${t('thanks.kicker', 'Thank you')}</span>
      <h1 class="ty-h1">${t('thanks.h1', 'souldew is free because of these people.')}</h1>
      <p class="ty-lede">${t('thanks.lede', 'Every name and every number here helps pay for the servers, the signing certificates and the time that keep souldew free for everyone. Thank you.')}</p>
      <div class="ty-sum">
        ${s.thanks ? html`<span class="ty-total"><b>${total.toLocaleString(currentLang())}</b><span>${t('thanks.total', 'person supports souldew right now|people support souldew right now', { count: total })}</span></span>` : null}
        <${LiveState} s=${s} />
        <${Moments} queue=${queue} onDone=${() => setQueue((q) => q.slice(1))} />
      </div>
    </header>
    ${!s.thanks && !s.loading && html`<div class="ty-empty panel"><p class="muted">${s.error === 'thanksMissing' ? t('thanks.missing', 'The Thank you page isn’t available yet.') : t('thanks.offlineNone', 'Offline – the list shows up once you’re online.')}</p></div>`}
    ${s.thanks && !groups.length && html`<div class="ty-empty panel"><p class="muted">${t('thanks.none', 'No supporters yet – the first name here could be yours.')}</p></div>`}
    ${groups.map((g) => html`<${TierSection} key=${g.tier} g=${g} fresh=${fresh} />`)}
    <p class="ty-privacy small faint">${t('thanks.privacy', 'Only people who chose to be listed appear by name – with the name, picture, banner and frame they show in souldew anyway. Everyone else is counted, never named.')}</p>
    <${SupportCta} signedIn=${!!acct.session?.signedIn} listed=${listed} navigate=${navigate} />
  </div>`;
}
