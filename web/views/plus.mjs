// The souldew+ page (#/plus – owner's choice "A – Showroom", made calmer): first the viewer themselves wearing souldew+
// (their real Discord picture and name when signed in, through the local avatar proxy; a neutral placeholder when
// not), then a handful of the strongest banners, frames and nameplates, "Your handheld" (live, turning slowly) with the
// launch looks and, kept small, the colour
// themes – live from the pack for members, the signed preview media (lib/cosmetics/previews.mjs) for everyone else –
// then the three tiers, what
// stays free, where the money goes, what happens when you stop, and a few questions. Members get the thank-you
// version. Every "Get souldew+" in the app leads here (lib/cosmetics/plus.mjs) – never a pop-up. Motion: the preview
// loops play while hovered or focused (the hero card always), never with reduced motion. No favourite stars here (owner,
// 19.11.26): they belong where you choose your looks – the profile editor and the pickers, with their filters.
import { html, useState } from '/vendor/htm-preact.mjs';
import { t } from '../lib/i18n.mjs';
import { Icon } from '../lib/icons.mjs';
import { useApp, openExternal } from '../lib/ui.mjs';
import { LINKS } from '../lib/links.mjs';
import { useAccount, startTrial } from '../lib/account.mjs';
import { settingsLink } from '../lib/settingsindex.mjs';
import { catalog, has, packState, previewSkin, startPackPreview, refreshPack } from '../lib/cosmetics/index.mjs';
import { Banner, Nameplate, Frame, useCosmetics } from '../lib/cosmetics/components.mjs';
import { PreviewPicture, usePreviews } from '../lib/cosmetics/previews.mjs';
import { prefersReduced } from '../lib/cosmetics/motion.mjs';
import { TIERS, CURATED, plusState, hasPlusLooks, isMember, trialOffered, heroLook, tierAction, curatedFrom, plusCounts, plusSkins, themeLook, themeVars } from '../lib/pluspage.mjs';
import { TitlePlate, achTitle, Badges } from './social.mjs';
import { HandheldShowcase } from './handheldtile.mjs';
import { LaunchLooks } from './launchlooks.mjs';

const RARITY = () => ({ common: t('cos.rarity.common', 'Common'), rare: t('cos.rarity.rare', 'Rare'), epic: t('cos.rarity.epic', 'Epic'), legendary: t('cos.rarity.legendary', 'Legendary') });
const dateOf = (ms) => (ms ? new Date(ms).toLocaleDateString(document.documentElement.lang || undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '');
const membership = () => openExternal(LINKS.membership);

/** hovered or focused (pointer or keyboard): a preview plays its loop while this is true */
function useHot() {
  const [hot, setHot] = useState(false);
  return [hot, { onPointerEnter: () => setHot(true), onPointerLeave: () => setHot(false), onfocusin: () => setHot(true), onfocusout: () => setHot(false) }];
}

/** The souldew+ mark with its name – or, for something you have, a quiet "Yours". */
function Owned({ yours }) {
  return yours ? html`<span class="plus-yours"><${Icon} name="check" size=${11} />${t('plus.yours', 'Yours')}</span>`
    : html`<span class="plus-chip"><${Icon} name="plus" size=${9} />${t('rail.plus', 'souldew+')}</span>`;
}

/** A banner: live when the pack has it, else its preview picture (the loop while `loop`). */
export function BannerLook({ id, loop }) {
  if (has('banners', id)) return html`<${Banner} id=${id} size="fill" intro=${false} animate=${loop ? 'always' : undefined} />`;
  return html`<div class="cos-banner cos-banner--fill plus-pic"><${PreviewPicture} kind="banners" id=${id} loop=${loop} /></div>`;
}

/** The viewer's avatar (or the placeholder) with a frame round it: live, or the frame's preview picture over it. */
export function FramedAvatar({ me, frame, size, loop }) {
  const src = me?.avatar && me.avatar.startsWith('/api/account/avatar?') ? me.avatar : null;
  const pic = src ? html`<img src=${src} alt="" width=${size} height=${size} loading="lazy" decoding="async" referrerpolicy="no-referrer" />`
    : html`<span class="av-blank" aria-hidden="true"><${Icon} name="user" size=${Math.round(size * 0.55)} /></span>`;
  if (frame && has('frames', frame)) return html`<span class="av-wrap"><${Frame} id=${frame} size=${size} intro=${false} animate=${loop ? 'always' : undefined} class=${`av av-${size}`}>${pic}<//></span>`;
  return html`<span class="av-wrap plus-framepic" style=${`--av:${size}px`}><span class=${`av av-${size}`} style=${`--av:${size}px`}>${pic}</span>
    ${frame && html`<${PreviewPicture} kind="frames" id=${frame} loop=${loop} />`}</span>`;
}

/** A friends-list row with a nameplate behind it: live, or the nameplate's preview picture. */
function PlateRow({ id, me, sub, loop }) {
  const body = html`<span class="plus-plate-av"><${FramedAvatar} me=${me} size=${34} /></span>
    <span class="plus-plate-text"><b>${me?.name || t('plus.you', 'You')}</b><span class="small muted">${sub}</span></span>`;
  if (has('nameplates', id)) return html`<${Nameplate} id=${id} animate=${loop ? 'always' : undefined} class="plus-plate">${body}<//>`;
  return html`<div class="plus-plate plus-plate--pic"><${PreviewPicture} kind="nameplates" id=${id} loop=${loop} />${body}</div>`;
}

/** The hero's card: you, wearing souldew+ – on your profile and in a friend's list. */
function YouCard({ me, look, signedIn }) {
  const shown = signedIn ? me : null;
  // the banner moves (as on a profile); the frame and the nameplate play while the card is pointed at, like in a list
  const [hot, on] = useHot();
  return html`<figure class="plus-you" aria-label=${t('plus.youAria', 'How you look with souldew+')} ...${on}>
    <div class="plus-you-banner"><${BannerLook} id=${look.banner} loop=${!prefersReduced()} /></div>
    <div class="plus-you-id"><${FramedAvatar} me=${shown} frame=${look.frame} size=${72} loop=${hot} />
      <div class="plus-you-names"><b class="plus-you-name">${shown?.name || t('plus.you', 'You')}</b>
        ${shown?.title ? html`<${TitlePlate} text=${achTitle(shown.title)} />` : html`<span class="small muted">${shown ? `@${shown.handle}` : t('plus.yourName', 'your name, your picture')}</span>`}</div></div>
    <figcaption class="plus-you-plate"><span class="plus-kicker">${t('plus.inLists', 'In your friends’ lists')}</span>
      <${PlateRow} id=${look.nameplate} me=${shown} sub=${t('fr.online', 'Online')} loop=${hot} /></figcaption>
  </figure>`;
}

function Head({ k, title, children }) {
  return html`<div class="plus-head"><span class="plus-kicker">${k}</span><h2>${title}</h2>${children && html`<p class="plus-head-hint">${children}</p>`}</div>`;
}

/** "Try {name} for 15 minutes": the live theme preview (§10.4), then Settings › Theme, where its bar shows the time left. */
function useTryTheme(navigate) {
  const [state, setState] = useState(null); // null | 'busy' | Error
  const run = async (id) => {
    setState('busy');
    try {
      if (!packState().preview) await startPackPreview();
      previewSkin(id);
      setState(null);
      navigate('settings', settingsLink('skin'));
    } catch (e) {
      setState(e);
    }
  };
  return [state, run];
}

function previewError(e) {
  if (e?.code === 'rate_limited') return t('skin.previewDay', 'You’ve used today’s previews – try again tomorrow, or get souldew+ to keep every theme.');
  if (e?.code === 'limit_reached') return t('skin.previewBusy', 'Too many previews are running on your account – wait until one ends.');
  if (e?.code === 'none') return t('skin.previewNone', 'Previews aren’t available right now.');
  return t('skin.previewFailed', 'The preview couldn’t be loaded. Check your connection and try again.');
}

/**
 * The colour themes, kept small (they matter least of the looks): every theme as a swatch in one strip, and a small live
 * preview – a profile dressed in souldew+ (the banner, frame and nameplate made for that theme, real pack items) in the
 * theme's own colours. Trying one on the whole app is a button away.
 */
function Themes({ skins, state, me, count, navigate }) {
  const [cur, setCur] = useState(() => (skins.find((x) => x.id === CURATED.skins[0]) || skins[0])?.id);
  const [trying, tryTheme] = useTryTheme(navigate);
  const [hot, on] = useHot();
  const k = skins.find((x) => x.id === cur) || skins[0];
  if (!k) return null;
  const look = themeLook(catalog(), k.id);
  const who = state.kind === 'signedOut' ? null : me;
  const action = hasPlusLooks(state)
    ? html`<button type="button" class="btn small go" onClick=${() => navigate('settings', settingsLink('skin'))}>${t('plus.useTheme', 'Use {name}', { name: k.name })}</button>`
    : state.kind === 'signedOut' ? html`<button type="button" class="btn small" onClick=${() => navigate('settings', settingsLink('account'))}>${t('plus.signInTry', 'Sign in to try it for 15 minutes')}</button>`
      : html`<button type="button" class="btn small" disabled=${trying === 'busy'} onClick=${() => tryTheme(k.id)}>${t('plus.tryTheme', 'Try {name} for 15 minutes', { name: k.name })}</button>`;
  const sw = (x) => `--a:${x.sw[0]};--b:${x.sw[1] || x.sw[0]};--c:${x.sw[6] || x.sw[2]}`;
  return html`<section class="plus-sec plus-themes">
    <${Head} k=${t('plus.kThemes', 'Colour themes')} title=${t('plus.themesT', 'The whole app in your colours')}>${t('plus.themesHint', 'Colours only – every layout and every word stays where you know it. {count} themes in all.', { count })}<//>
    <div class="plus-tbox">
      <div class="plus-tside">
        <div class="plus-tstrip" role="radiogroup" aria-label=${t('plus.kThemes', 'Colour themes')}>
          ${skins.map((x) => html`<button type="button" role="radio" key=${x.id} aria-checked=${x.id === k.id}
            aria-label=${x.name} title=${x.name} class=${`plus-tchip ${x.id === k.id ? 'on' : ''}`} style=${sw(x)} onClick=${() => setCur(x.id)} onFocus=${() => setCur(x.id)}><i aria-hidden="true"></i></button>`)}
        </div>
        <div class="plus-tname"><b>${k.name}</b><span class="small muted">${k.hint} · ${k.group === 'light' ? t('skin.lightShort', 'light') : t('skin.darkShort', 'dark')}</span></div>
        <div class="row">${action}</div>
        ${trying && trying !== 'busy' && html`<p class="small warning info" role="status">${previewError(trying)}</p>`}
      </div>
      <figure class="plus-tp" style=${themeVars(k.sw)} aria-label=${t('skin.shotAlt', 'souldew in {name}', { name: k.name })} ...${on}>
        <span class="plus-tp-rail" aria-hidden="true"><i></i><i class="on"></i><i></i><i></i><i></i></span>
        <div class="plus-tp-main">
          <div class="plus-tp-banner"><${BannerLook} id=${look.banner} loop=${hot} /></div>
          <div class="plus-tp-id"><${FramedAvatar} me=${who} frame=${look.frame} size=${48} loop=${hot} />
            <div class="plus-tp-names"><b>${who?.name || t('plus.you', 'You')}</b>${who?.title ? html`<span class="plus-tp-title"><${Icon} name="star" size=${9} />${achTitle(who.title)}</span>` : null}</div></div>
          <div class="plus-tp-runs" aria-hidden="true">
            <span class="plus-tp-run"><span class="plus-tp-pips"><i class="on"></i><i class="on"></i><i class="on"></i><i class="on"></i><i class="on"></i><i></i><i></i><i></i></span><span class="plus-tp-won">${t('pf.rWon', 'Won')}</span></span>
            <span class="plus-tp-run"><span class="plus-tp-pips"><i class="on"></i><i class="on"></i><i></i><i></i><i></i><i></i><i></i><i></i></span><span class="plus-tp-lost">${t('pf.rLost', 'Wiped')}</span></span>
          </div>
          <${PlateRow} id=${look.nameplate} me=${who} sub=${t('fr.online', 'Online')} loop=${hot} />
        </div>
      </figure>
    </div>
  </section>`;
}

function BannerCard({ b, yours, big }) {
  const [hot, on] = useHot();
  return html`<figure class=${`plus-banner ${big ? 'big' : ''}`} tabIndex="0" ...${on}>
    <div class="plus-banner-art"><${BannerLook} id=${b.id} loop=${hot} /></div>
    <figcaption><b>${b.name}</b><span class=${`cos-rarity r-${b.rarity}`}>${RARITY()[b.rarity] || ''}</span><span class="spacer"></span><${Owned} yours=${yours} /></figcaption>
  </figure>`;
}

function FrameItem({ f, me, yours }) {
  const [hot, on] = useHot();
  return html`<figure class="plus-frame" tabIndex="0" ...${on}><${FramedAvatar} me=${me} frame=${f.id} size=${64} loop=${hot} />
    <figcaption><b>${f.name}</b><${Owned} yours=${yours} /></figcaption></figure>`;
}

function PlateItem({ p, me, sub }) {
  const [hot, on] = useHot();
  return html`<div class="plus-plate-item" tabIndex="0" ...${on} aria-label=${p.name}><${PlateRow} id=${p.id} me=${me} sub=${sub} loop=${hot} /></div>`;
}

/** "What you get": the strongest few of each kind – the rest is in the profile editor and Settings. */
function Gallery({ state, me, navigate }) {
  useCosmetics();
  usePreviews();
  const cat = catalog();
  const c = curatedFrom(cat);
  const n = plusCounts(cat);
  const yours = hasPlusLooks(state);
  const who = state.kind === 'signedOut' ? null : me;
  return html`
    <section class="plus-sec">
      <${Head} k=${t('plus.kBanners', 'Profile banners')} title=${t('plus.bannersT', 'Pixel scenes that move')}>${t('plus.bannersHint', 'Hand-made, animated, behind your name on your profile. {count} banners in all, new ones every month.', { count: n.banners })}<//>
      <div class="plus-banners">${c.banners.map((b, i) => html`<${BannerCard} key=${b.id} b=${b} yours=${yours} big=${i === 0} />`)}</div>
    </section>
    <div class="plus-pair">
      <section class="plus-sec">
        <${Head} k=${t('plus.kFrames', 'Avatar frames')} title=${t('plus.framesT', 'Around your picture')}>${t('plus.framesHint', '{count} frames in all.', { count: n.frames })}<//>
        <div class="plus-frames">${c.frames.map((f) => html`<${FrameItem} key=${f.id} f=${f} me=${who} yours=${yours} />`)}</div>
      </section>
      <section class="plus-sec">
        <${Head} k=${t('plus.kPlates', 'Nameplates')} title=${t('plus.platesT', 'Behind your name in friends’ lists')}>${t('plus.platesHint', 'Still in the list, moving when a friend points at you.')}<//>
        <div class="plus-plates">${c.nameplates.map((p) => html`<${PlateItem} key=${p.id} p=${p} me=${who} sub=${p.name} />`)}</div>
      </section>
    </div>
    <${HandheldShowcase} />
    <section class="plus-sec">
      <${Head} k=${t('plus.kLaunch', 'Launch animations')} title=${t('plus.launchT3', 'Your handheld, in gold or see-through')}>${t('plus.launchHint5', 'What plays while your game starts – it never makes the game wait. Pick one to see it.')}<//>
      <${LaunchLooks} />
    </section>
    <${Themes} skins=${plusSkins(cat)} state=${state} me=${me} count=${n.skins} navigate=${navigate} />`;
}

function Tiers({ state }) {
  const text = {
    supporter: { name: t('acct.supporter', 'Supporter'), what: [t('plus.tSup1', 'The Supporter badge on your profile'), t('plus.tSup3', 'The 3D launch: your own handheld, in your colours'), t('plus.tSup2', 'You help keep the servers running')], cta: t('plus.tSupCta', 'Become a Supporter') },
    plus: { name: t('rail.plus', 'souldew+'), what: [t('plus.tPlus1b', 'Every theme, banner, frame and nameplate – and every launch look, skin and sticker for your handheld'), t('plus.tPlus2', 'New ones every month'), t('plus.tPlus3', 'The souldew+ badge')], cta: t('plus.tPlusCta', 'Join souldew+') },
    patron: { name: t('acct.patron', 'Legend'), what: [t('plus.tPat1', 'Everything in souldew+'), t('plus.tPat2', 'The Legend badge'), t('plus.tPat3', 'For when you want to give more')], cta: t('plus.tPatCta', 'Become a Legend') },
  };
  return html`<section class="plus-sec" id="plus-tiers">
    <${Head} k=${t('plus.kTiers', 'Pick what fits')} title=${t('plus.tiersT', 'Three ways to chip in')}>${t('plus.tiersHint', 'Monthly, through Buy Me a Coffee – cancel there any time.')}<//>
    <div class="plus-tiers">${TIERS.map((x) => {
      const act = tierAction(state, x.id);
      const tx = text[x.id];
      return html`<div class=${`plus-tier ${x.main ? 'featured' : ''} ${act === 'current' ? 'current' : ''}`}>
        <div class="plus-tier-top"><b class="plus-tier-name">${tx.name}</b>
          ${act === 'current' ? html`<span class="plus-tag ok">${t('plus.yourTier', 'Your tier')}</span>` : x.main && !isMember(state) ? html`<span class="plus-tag">${t('plus.allLooks', 'all the looks')}</span>` : null}</div>
        <div class="plus-price"><b>${x.price}</b><span class="plus-cur">€</span><span class="small muted">${t('plus.perMonth', 'a month')}</span></div>
        <ul class="plus-ticks">${tx.what.map((w) => html`<li><${Icon} name="check" size=${12} /><span>${w}</span></li>`)}</ul>
        ${act === 'current' ? html`<button type="button" class="btn" disabled>${t('plus.current', 'Your tier')}</button>`
          : html`<button type="button" class=${`btn ${x.main && !hasPlusLooks(state) ? 'go' : ''}`} onClick=${membership}><${Icon} name="external" size=${14} />${act === 'switch' ? t('plus.switch', 'Switch on Buy Me a Coffee') : tx.cta}</button>`}
      </div>`;
    })}</div>
  </section>`;
}

function FreeAndMoney() {
  const free = [t('plus.f1', 'Every emulator and every game you own'), t('plus.f2', 'SoulLink, Nuzlocke and the randomizer'), t('plus.f3', 'Live tracking, sync, Live Runs and Stream'),
    t('plus.f4', 'Trophies, titles and the Pokédex'), t('plus.f5', 'Friends, profiles and invites'), t('plus.f6', 'The accessibility colour schemes')];
  const money = [['globe', t('plus.m1', 'Servers'), t('plus.m1t', 'Friends, presence, invites and Live Runs run on them.')],
    ['lock', t('plus.m2', 'Signing certificates'), t('plus.m2t', 'So your computer trusts the app you download.')],
    ['clock', t('plus.m3', 'Time'), t('plus.m3t', 'New games, fixes and answers on Discord.')]];
  return html`<div class="plus-pair plus-ledger">
    <section class="plus-sec plus-panel">
      <${Head} k=${t('plus.kFree', 'Always free')} title=${t('plus.freeT', 'Everything that plays')} />
      <ul class="plus-ticks">${free.map((x) => html`<li><${Icon} name="check" size=${12} /><span>${x}</span></li>`)}</ul>
    </section>
    <section class="plus-sec plus-panel">
      <${Head} k=${t('plus.kMoney', 'Where the money goes')} title=${t('plus.moneyT', 'Keeping souldew going')} />
      <ul class="plus-money">${money.map(([i, a, b]) => html`<li><span class="plus-money-ico"><${Icon} name=${i} size=${14} /></span><span><b>${a}</b><span class="small muted">${b}</span></span></li>`)}</ul>
      <a class="plus-thanks-link small" href="#/thanks"><${Icon} name="heart" size=${12} /><span>${t('plus.thanksLink', 'See who already supports souldew')}</span><${Icon} name="external" size=${11} /></a>
    </section>
  </div>`;
}

function Cancel() {
  const rows = [[t('plus.c1', 'Nothing you earned goes away'), t('plus.c1t', 'Runs, trophies, titles, friends and your profile stay exactly as they are.')],
    [t('plus.c2', 'Your picks wait for you'), t('plus.c2t', 'Friends see the free banner, frame and nameplate again; your choices are remembered and come back when you rejoin.')],
    [t('plus.c3', 'The app goes back to its own colours'), t('plus.c3t', 'Your theme returns the moment souldew+ is active again.')],
    [t('plus.c4', 'A week of grace offline'), t('plus.c4t', 'No internet for a few days doesn’t take anything away.')],
    [t('plus.c5', 'Your handheld waits too'), t('plus.c5t', 'Your launch settings and designs are kept. With Supporter the free parts play; without a membership the cartridge does – until you’re back.')]];
  return html`<section class="plus-sec">
    <${Head} k=${t('plus.kCancel', 'If you stop')} title=${t('plus.cancelT', 'Cancel on Buy Me a Coffee, any time')} />
    <div class="plus-cancel">${rows.map(([a, b]) => html`<div><b>${a}</b><p class="small muted">${b}</p></div>`)}</div>
  </section>`;
}

function Faq({ navigate }) {
  const qa = [
    [t('plus.q1', 'Does souldew+ change what the app can do?'), t('plus.a1', 'No. Every feature stays free for everyone – souldew+ adds looks only: colour themes, banners, frames, nameplates and launch animations.')],
    [t('plus.q2', 'Can I try it first?'), html`${t('plus.a2', 'Signed in, you can try any theme on the whole app for 15 minutes, a few times a day. In the profile editor you can try on every banner, frame and nameplate as long as you like – saving keeps your free one.')} ${t('plus.a2Trial', 'Or try all of souldew+ free for 7 days – once per Discord account, if it’s at least 30 days old and never had souldew+. Nothing to pay, nothing renews, nothing to cancel.')}`],
    [t('plus.q3', 'I already support souldew on Buy Me a Coffee – how do I get it?'), html`${t('plus.a3', 'Link the membership in Settings › Account with the email you used there, or with /supporter claim in the souldew Discord.')} <a href="#" onClick=${(e) => { e.preventDefault(); navigate('settings', settingsLink('plus')); }}>${t('plus.a3Link', 'Link a membership')}</a>`],
    [t('plus.q4', 'What do my friends see?'), t('plus.a4', 'Your banner, frame and nameplate – on your profile and in their friends lists. Themes and launch animations are just for you.')],
  ];
  return html`<section class="plus-sec">
    <${Head} k=${t('plus.kFaq', 'Questions')} title=${t('plus.faqT', 'Good to know')} />
    <div class="plus-faq">${qa.map(([q, a]) => html`<details class="plus-q"><summary>${q}</summary><p class="small muted">${a}</p></details>`)}</div>
  </section>`;
}

function trialError(e) {
  if (e?.vars?.code === 'trial_used') return t('plus.trialUsed', 'The free trial was already used on this Discord account.');
  if (e?.vars?.reason === 'account_age') return t('plus.trialAge', 'The free trial needs a Discord account that’s at least 30 days old.');
  if (e?.vars?.reason === 'had_plus' || e?.vars?.reason === 'member') return t('plus.trialHad', 'The free trial is for accounts that never had souldew+ or Legend.');
  if (e?.vars?.code === 'rate_limited') return t('plus.trialLater', 'Too many tries – please try again later.');
  return t('plus.trialFailed', 'The trial couldn’t be started. Check your connection and try again.');
}

/** "Try souldew+ free for 7 days": starts the trial (§8.6), then loads the looks. */
function useTrial() {
  const { toast } = useApp();
  const [state, setState] = useState(null); // null | 'busy' | Error
  const run = async () => {
    setState('busy');
    try {
      const r = await startTrial();
      refreshPack().catch(() => {});
      setState(null);
      toast({ kind: 'ok', title: t('plus.trialOn', 'souldew+ is yours for 7 days'), text: r.until ? t('plus.trialEnds', 'Trial · ends {date}', { date: dateOf(r.until) }) : '' });
    } catch (e) {
      setState(e);
    }
  };
  return [state, run];
}

/** The trial offer: a clear button and, right under it, what it is – no card details, nothing renews. */
function TrialOffer({ big }) {
  const [trial, run] = useTrial();
  return html`<button type="button" class=${`btn ${big ? 'big' : ''}`} disabled=${trial === 'busy'} onClick=${run}><${Icon} name="clock" size=${14} />${t('plus.trialTry', 'Try souldew+ free for 7 days')}</button>
    ${trial && trial !== 'busy' && html`<p class="small warning info plus-trial-msg" role="status">${trialError(trial)}</p>`}`;
}

/** The hero's words and buttons for this state. */
function HeroText({ state, me, navigate }) {
  const mark = html`<div class="plus-wordmark" aria-hidden="true"><span>souldew</span><span class="plus-box"><${Icon} name="plus" size=${14} /></span></div>`;
  if (state.kind === 'trial') {
    const ends = dateOf(state.trial?.until || state.until);
    return html`${mark}<h1 class="plus-h1">${t('plus.trialH', 'Enjoy souldew+, {name}.', { name: state.name })}</h1>
      <p class="plus-lede">${t('plus.trialLede', 'Everything on this page is yours until {date}. Nothing renews and there’s nothing to cancel – afterwards souldew goes back to its free looks, and your picks wait for you.', { date: ends })}</p>
      <div class="plus-member">
        <div class="row tight"><span class="chip">${t('plus.trialEnds', 'Trial · ends {date}', { date: ends })}</span></div>
        <div class="row"><button type="button" class="btn go" onClick=${membership}><${Icon} name="external" size=${14} />${t('plus.trialKeep', 'Keep it on Buy Me a Coffee')}</button>
          <button type="button" class="btn ghost" onClick=${() => navigate('profile', { edit: '1' })}>${t('plus.dressUp', 'Dress up your profile')}</button></div>
      </div>`;
  }
  if (hasPlusLooks(state)) {
    return html`${mark}<h1 class="plus-h1">${t('plus.thanksH', 'Thank you, {name}.', { name: state.name })}</h1>
      <p class="plus-lede">${t('plus.thanksLede', 'You help keep souldew free for everyone – the servers, the signing certificates, the time. Everything on this page is yours to use.')}</p>
      <div class="plus-member">
        <div class="row tight"><${Badges} badges=${me?.badges || []} />${state.until && html`<span class="small muted">${t('plus.until', 'until {date} · renews on Buy Me a Coffee', { date: dateOf(state.until) })}</span>`}</div>
        <div class="row"><button type="button" class="btn" onClick=${membership}><${Icon} name="external" size=${14} />${t('plus.manage', 'Manage on Buy Me a Coffee')}</button>
          <button type="button" class="btn ghost" onClick=${() => navigate('profile', { edit: '1' })}>${t('plus.dressUp', 'Dress up your profile')}</button></div>
      </div>`;
  }
  const join = html`<button type="button" class="btn go big" onClick=${membership}><${Icon} name="plus" size=${14} />${t('plus.join', 'Join souldew+ · {price} € a month', { price: TIERS.find((x) => x.id === 'plus').price })}</button>`;
  if (state.kind === 'supporter') {
    return html`${mark}<h1 class="plus-h1">${t('plus.thanksH', 'Thank you, {name}.', { name: state.name })}</h1>
      <p class="plus-lede">${t('plus.supLede2', 'Your Supporter badge helps keep souldew free for everyone – and your games start on your own handheld in 3D. souldew+ adds the looks below – themes, banners, frames, nameplates, and the shells, skins and stickers for your handheld.')}</p>
      <div class="row">${join}${trialOffered(state) ? html`<${TrialOffer} big />`
        : html`<button type="button" class="btn ghost big" onClick=${() => document.getElementById('plus-tiers')?.scrollIntoView({ behavior: prefersReduced() ? 'auto' : 'smooth' })}>${t('plus.seeTiers', 'Compare the tiers')}</button>`}</div>
      ${trialOffered(state) && html`<p class="small faint plus-fine">${t('plus.trialFine', '7 days, once per Discord account. No payment details – nothing renews, nothing to cancel.')}</p>`}`;
  }
  return html`${mark}<h1 class="plus-h1">${t('plus.heroH', 'souldew stays free.')}<br /><span class="plus-h1-2">${t('plus.heroH2', 'souldew+ makes it yours.')}</span></h1>
    <p class="plus-lede">${t('plus.lede', 'Everything that plays – emulators, SoulLink, Nuzlocke tracking, sync, trophies, friends – costs nothing, forever. souldew+ is how you help pay for the servers and the time, and get a few beautiful things for it.')}</p>
    <div class="row">${join}
      ${state.kind === 'signedOut' ? html`<button type="button" class="btn ghost big" onClick=${() => navigate('settings', settingsLink('account'))}>${t('plus.signIn', 'Sign in to try a theme')}</button>`
        : trialOffered(state) ? html`<${TrialOffer} big />`
          : html`<button type="button" class="btn ghost big" onClick=${() => navigate('settings', settingsLink('skin'))}>${t('plus.tryAny', 'Try a theme for 15 minutes')}</button>`}</div>
    ${trialOffered(state) && html`<p class="small faint plus-fine">${t('plus.trialFine', '7 days, once per Discord account. No payment details – nothing renews, nothing to cancel.')}</p>`}
    <p class="small faint plus-fine">${t('plus.fine', 'Billed by Buy Me a Coffee. Cancel there whenever you like – nothing you earned in souldew goes away.')}
      ${' '}<a href="#" onClick=${(e) => { e.preventDefault(); navigate('settings', settingsLink(state.kind === 'signedOut' ? 'account' : 'plus')); }}>${t('plus.already', 'Already a member? Link it')}</a></p>`;
}

export function PlusView() {
  const { navigate } = useApp();
  const acct = useAccount();
  useCosmetics();
  if (!acct.known) return html`<div class="empty-state"><p class="muted">${t('common.loading', 'Loading …')}</p></div>`;
  const state = plusState(acct);
  const me = acct.me;
  return html`<div class="plus-page" data-state=${state.kind}>
    <header class="plus-hero">
      <div class="plus-hero-text"><${HeroText} state=${state} me=${me} navigate=${navigate} /></div>
      <${YouCard} me=${me} look=${heroLook(me, state)} signedIn=${state.kind !== 'signedOut'} />
    </header>
    <${Gallery} state=${state} me=${me} navigate=${navigate} />
    <${Tiers} state=${state} />
    <${FreeAndMoney} />
    <${Cancel} />
    <${Faq} navigate=${navigate} />
  </div>`;
}
