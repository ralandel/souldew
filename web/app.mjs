import { html, render, useState, useEffect, useRef, useCallback, useMemo, useErrorBoundary } from '/vendor/htm-preact.mjs';
import { api, events } from './lib/api.mjs';
import { serverErrorText } from './lib/errors.mjs';
import { RunDoc } from './lib/doc.mjs';
import { loadData, RunData, speciesName } from './lib/data.mjs';
import { SyncLink, PARTNER_TTL } from './lib/sync.mjs';
import { setLang, guessLang, t, onLangChange } from './lib/i18n.mjs';
import { applyTheme, applyStoredTheme } from './lib/theme.mjs';
import { applySkin, refreshPack, setPackAccessProvider, devPackAccess } from './lib/cosmetics/index.mjs';
import { initFavourites } from './lib/favourites.mjs';
import { initHandheld, prewarm as prewarmHandheld } from './lib/handheld/look.mjs';
import { detectLayout, resolveHotkeys, accelerator } from './lib/controls.mjs';
import { applySnapshot, applyTogether, isTogether, runSection, runStateId, togetherGames, announceGame, snapshotFromSave, players as getPlayers, areaName, feedText, othersOf, slotsOf, runMode, checks, loadLocationTables, genOfRun, wipedSlot, failRun, logLinkTrade, logLinkBattle, rules as getRules, lives as getLives, livesFor, settleLives, revealHeld, startRules, HELD_PREFIX } from './lib/run.mjs';
import { attachRps } from './lib/worldrps.mjs';
import { inviteBlock, BLOCK_CODE } from '/shared/playtogether.mjs';
import { RpsCards } from './views/rps.mjs';
import { attachRaid, detachRaid, raidFor, raidRules } from './lib/raid.mjs';
import { RaidCards } from './views/raid.mjs';
import { attachTogether } from './lib/together.mjs';
import { TogetherCards } from './views/together.mjs';
import { sessionsIn, outcomeOf, recordResult } from './lib/wager.mjs';
import { play } from './lib/sound.mjs';
import { Ctx, Toasts, Led, Modal, openExternal } from './lib/ui.mjs';
import { LINKS } from './lib/links.mjs';
import { EDITION } from '/shared/edition.mjs';
import { groupArrowKeys } from './lib/a11y.mjs';
import { startPadNav } from './lib/padnav.mjs';
import { leaveHeld } from './lib/leaveguard.mjs';
import { AppMark, NavIcon, Icon } from './lib/icons.mjs';
import { BootScreen } from './views/boot.mjs';
import { Onboarding } from './views/onboarding.mjs';
import { LibraryView } from './views/library.mjs';
import { unpackToast } from './lib/libadded.mjs';
import { SoulLinkView, NuzlockeView } from './views/soullink.mjs';
import { PlayView, GameSession, ExternalFeed } from './views/play.mjs';
import { LinkSessions } from './lib/linksession.mjs';
import { LinkBar } from './views/linkplay.mjs';
import { unsavedProgress, unsavedTexts } from './views/savestates.mjs';
import { lastMoment } from './lib/lastmoment.mjs';
import { LinkView } from './views/link.mjs';
import { SettingsView, gpuFallbackText, settingsLink } from './views/settings.mjs';
import { GuideView } from './views/guide.mjs';
import { StreamView } from './views/stream.mjs';
import { useStreamer } from './lib/streamer.mjs';
import { UpdateBanner } from './views/update.mjs';
import { DeathAlert } from './views/session-info.mjs';
import { RestartOffer, RunOverNotice } from './views/restart.mjs';
import { FirstStepsPill } from './views/firststeps.mjs';
import { useCoffeeFx, CoffeeFx } from './views/coffee.mjs';
import { LicenseNag } from './views/nag.mjs';
import { countLaunch, shouldNag } from './lib/nag.mjs';
import { WhatsNew } from './views/whatsnew.mjs';
import { mayShowWhatsNew, whatsNewPending, whatsNewSeenPatch, WHATS_NEW_EVENT } from './lib/whatsnew.mjs';
import { mySlotIn } from './lib/restart.mjs';
import { initRules, setupHostRules } from './lib/hostrules.mjs';
import { IS_MAC, IS_WIN, PLATFORM, shortcut } from './lib/platform.mjs';
import { TrophiesView, TrophyToasts } from './views/trophies.mjs';
import { syncTrophies, rememberSlots, watchRun, onTrophyUnlock } from './lib/trophies.mjs';
import { runStarted } from '/shared/trophies.mjs';
import { FriendsView } from './views/friends.mjs';
import { ProfileView } from './views/profile.mjs';
import { PlusView } from './views/plus.mjs';
import { ThanksView } from './views/thanks.mjs';
import { ThanksAsk } from './views/thanksask.mjs';
import { HandheldView } from './views/handheld.mjs';
import { railGroups, FOOT_SECTIONS } from './lib/railnav.mjs';
import { accountEvent, useAccount, signIn, cancelSignIn, cosmeticsPackAccess } from './lib/account.mjs';
import { useSocial } from './lib/socialapp.mjs';
import { Avatar } from './views/social.mjs';
import { initUiScale, watchUiScaleKeys, useUiScale, setUiScale, stepUi, suggestUiScale, uiScaleKeys } from './lib/uiscale.mjs';
import { uiScaleLabel } from '/shared/uiscale.mjs';

applyStoredTheme(); // before the first render: no flash of the wrong colours

const pref = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      // private mode
    }
  },
};

/** The emulator's shortcuts as the menu shows them (Settings › Controls): config.controls, set once the status is known. */
let menuControls = null;
const menuKeys = () => {
  const hot = resolveHotkeys(menuControls);
  // '' = no key: the menu entry shows none
  return Object.fromEntries(['pause', 'turbo', 'faster', 'slower', 'quicksave', 'quickload', 'screenshot', 'mute'].map((id) => [id, accelerator(hot[id][0]) || '']));
};

/** The desktop menu bar in the UI language (electron/main.mjs builds it from these). */
function sendMenuLabels(controls = menuControls) {
  menuControls = controls;
  if (!window.sls?.setMenuLabels) return;
  window.sls.setMenuLabels({
    keys: menuKeys(),
    settings: t('menu.settings', 'Settings …'), file: t('menu.file', 'File'), addGames: t('menu.addGames', 'Add games …'),
    revealLibrary: IS_MAC ? t('menu.revealLibrary', 'Show library folder in Finder') : IS_WIN ? t('menu.revealLibraryWin', 'Show library folder in Explorer')
      : t('menu.revealLibraryLinux', 'Show library folder in the file manager'),
    go: t('menu.go', 'Go'), quit: t('menu.quit', 'Quit'),
    library: t('nav.library', 'Library'), soullink: t('nav.soullink', 'SoulLink'), nuzlocke: t('nav.nuzlocke', 'Nuzlocke'), link: t('nav.link', 'Connection'), stream: t('nav.stream', 'Stream'),
    emulator: t('menu.emulator', 'Emulator'), pause: t('keys.pause', 'Pause / resume'), turbo: t('menu.turbo', 'Toggle turbo'),
    faster: t('menu.faster', 'Faster'), slower: t('menu.slower', 'Slower'), quicksave: t('menu.quicksave', 'Quick save'), quickload: t('menu.quickload', 'Quick load'),
    screenshot: t('keys.screenshot', 'Screenshot'), mute: t('keys.mute', 'Sound on/off'), fullscreen: t('menu.fullscreen', 'Fullscreen'),
    shortcuts: t('menu.shortcuts', 'Keyboard shortcuts'), guide: t('menu.guide', 'Guide'),
    view: t('menu.view', 'View'), uiBigger: t('menu.uiBigger', 'Bigger interface'), uiSmaller: t('menu.uiSmaller', 'Smaller interface'), uiReset: t('menu.uiReset', 'Interface at 100 %'),
  });
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [route, query = ''] = raw.split('?');
  return { route: route || 'library', params: Object.fromEntries(new URLSearchParams(query)) };
}

function useRoute() {
  const [r, setR] = useState(parseHash());
  useEffect(() => {
    let at = location.hash;
    const on = () => {
      // a screen with unsaved changes (the profile editor) may hold the change: the old address goes back, it asks
      if (location.hash !== at && leaveHeld(location.hash)) return history.replaceState(history.state, '', at || '#/library');
      at = location.hash;
      setR(parseHash());
    };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  const navigate = useCallback((route, params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== false)).toString(); // '' is kept: `new=` means "pick a game"
    location.hash = `#/${route}${q ? `?${q}` : ''}`;
  }, []);
  return [r, navigate];
}

function Boundary({ children, route }) {
  const [error, reset] = useErrorBoundary((e) => console.error(e));
  useEffect(() => reset(), [route]);
  if (error) {
    return html`<div class="panel stack"><h2>${t('err.view', 'This screen crashed')}</h2><p class="small code">${String(error.message || error)}</p>
      <div><button class="btn" onClick=${reset}>${t('err.retry', 'Try again')}</button></div></div>`;
  }
  return children;
}

const NO_INBOX = { inbox: [], alerts: [] };

/** Hover light of the rail: the pointer's spot inside the item, for the radial gradient (styles.css .nav a::before). */
function navLight(e) {
  const a = e.target.closest?.('.nav a');
  if (!a) return;
  const r = a.getBoundingClientRect();
  a.style.setProperty('--mx', `${Math.round(e.clientX - r.left)}px`);
  a.style.setProperty('--my', `${Math.round(e.clientY - r.top)}px`);
}

/**
 * souldew+ at the foot of the rail – where "Buy me a coffee" was: the page about it (#/plus), no price, no nag. Members
 * (any tier) read "thank you" under it. Folded, a small mark in the window's bottom left corner instead. The coffee
 * button's little Pokémon moments stay with it (views/coffee.mjs).
 */
function RailPlus({ thanks = false, here = false, float = false, fx = null, onOpen }) {
  // a build without the souldew account (shared/edition.mjs): no souldew+ – "Buy me a coffee" for the original author,
  // as before 3.0
  if (!EDITION.accounts) {
    const hint = t('rail.coffeeHint', 'Support souldew on Buy Me a Coffee');
    return html`<a class=${`rail-plus no-drag ${float ? 'rail-plus-float' : ''} ${fx ? `cfx-live cfx-on-${fx.id}` : ''}`} href=${LINKS.coffee} target="_blank" rel="noopener" style="--na:#e1b05a"
      title=${hint} aria-label=${float ? hint : undefined} onClick=${(e) => { e.preventDefault(); onOpen?.(); openExternal(LINKS.coffee); }}>
      <span class="rail-plus-mark" aria-hidden="true"><${Icon} name="coffee" size=${float ? 12 : 10} /></span>
      ${!float && html`<span class="rail-plus-text"><b>${t('rail.coffee', 'Buy me a coffee')}</b></span>`}
      <${CoffeeFx} fx=${fx} /></a>`;
  }
  const label = thanks ? t('rail.plusThanksSr', 'souldew+ – thank you') : t('rail.plus', 'souldew+');
  return html`<a class=${`rail-plus no-drag ${float ? 'rail-plus-float' : ''} ${here ? (float ? 'on' : 'active') : ''} ${fx ? `cfx-live cfx-on-${fx.id}` : ''}`} href="#/plus" style="--na:#e1b05a"
    aria-current=${here ? 'page' : undefined} title=${thanks ? t('rail.plusThanksHint', 'souldew+ – thank you for supporting souldew') : t('rail.plusHint', 'What souldew+ adds – and everything that stays free')}
    aria-label=${float ? label : undefined} onClick=${() => onOpen?.()}>
    <span class="rail-plus-mark" aria-hidden="true"><${Icon} name="plus" size=${float ? 12 : 10} /></span>
    ${!float && html`<span class="rail-plus-text"><b>${t('rail.plus', 'souldew+')}</b>${thanks && html`<span class="rail-plus-thanks">${t('rail.thanks', 'thank you')}</span>`}</span>`}
    <${CoffeeFx} fx=${fx} /></a>`;
}

/**
 * Signed out: "Sign in" with the Discord mark at the rail's foot – where the profile picture sits once signed in (the
 * same chip, so every skin styles both alike). It starts the same sign-in as Settings › Account (the system browser);
 * while the browser is open it says so, a click opens the browser again and the small × stops waiting.
 */
function RailSignIn({ toast }) {
  const acct = useAccount();
  const [busy, setBusy] = useState(false);
  if (!EDITION.accounts || !acct.loaded || acct.session?.signedIn || acct.session?.off) return null;
  const pending = !!acct.session?.pending;
  const go = async () => {
    setBusy(true);
    try {
      await signIn();
    } catch (e) {
      toast({ kind: 'death', title: t('acct.signInFailed', 'Signing in didn’t start'), text: e.message });
    }
    setBusy(false);
  };
  const label = pending ? t('rail.signInPending', 'Finish signing in in your browser – click to open it again') : t('rail.signInHint', 'Sign in with Discord – opens your browser. Everything works without an account.');
  return html`<div class=${`rail-signin-wrap ${pending ? 'pending' : ''}`}>
    <button type="button" class="rail-me rail-signin" disabled=${busy} onClick=${go} title=${label} aria-label=${label}>
      <span class="rail-signin-mark" aria-hidden="true"><${Icon} name="discord" size=${18} /></span>
      <span class="stack-s" style="gap:0"><b class="ellipsis">${pending ? t('rail.signInWaiting', 'Waiting …') : t('rail.signIn', 'Sign in')}</b>
        <span class="tiny ellipsis">${pending ? t('rail.signInBrowser', 'in your browser') : t('rail.withDiscord', 'with Discord')}</span></span>
    </button>
    ${pending && html`<button type="button" class="rail-signin-x" onClick=${() => cancelSignIn()} title=${t('common.cancel', 'Cancel')} aria-label=${t('rail.signInCancel', 'Stop signing in')}><${Icon} name="close" size=${12} /></button>`}
  </div>`;
}

/** One section of the rail: its line icon, its label and what it shows on the right (playing, friends online, counts). */
function NavItem({ n, here, playingIn, session }) {
  return html`<a href=${`#/${n.id}`} class=${here === n.id ? 'active' : ''} aria-current=${here === n.id ? 'page' : undefined} style=${`--na:${n.accent}`}>
    <${NavIcon} name=${n.icon} /><span class="nav-label">${n.label}</span>
    <span class="nav-end">${n.onAir && html`<span class="nav-onair" title=${t('stream.onAirHint', 'Streamer mode is on – codes, keys, paths and spoilers are covered')}><span class="sr-only">${t('stream.mode', 'Streamer mode')}</span></span>`}${playingIn === n.id && html`<span class="nav-live" title=${t('nav.playing', 'Running now: {game}', { game: session.target.label || session.target.name || '' })}><${Led} on color="green" />
        <span class="sr-only">${t('nav.playing', 'Running now: {game}', { game: session.target.label || session.target.name || '' })}</span></span>`}
      ${n.online > 0 && html`<span class="nav-online" title=${t('nav.onlineHint', '{count} friend online|{count} friends online', { count: n.online })}><${Led} on color="green" />${n.online}<span class="sr-only"> ${t('nav.onlineSr', 'online')}</span></span>`}
      ${n.count > 0 && html`<span class="nav-badge" title=${n.countHint || t('nav.countHint', 'Things to check on the board')}>${n.count > 99 ? '99+' : n.count}<span class="sr-only"> ${t('nav.countSr', 'to check')}</span></span>`}</span>
  </a>`;
}


/** The open run at the foot of the rail: who of the others is live – or, in a solo Nuzlocke, whether you play.
 * A click opens its game (back to it while it runs) – the way into the game now that the rail has no "Play" item. */
/**
 * The first time the sidebar folds away for the game: a small note next to its button that says how it comes back
 * (the button, the window's left edge, ⌘B / Ctrl+B). Shown once per computer, gone after a few seconds or a click.
 */
function RailHint() {
  const [shown, setShown] = useState(() => {
    try {
      return localStorage.getItem('sl-rail-play-hint') !== '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (!shown) return undefined;
    try {
      localStorage.setItem('sl-rail-play-hint', '1');
    } catch {
      // private mode: it may show again
    }
    const id = setTimeout(() => setShown(false), 12000);
    return () => clearTimeout(id);
  }, [shown]);
  if (!shown) return null;
  return html`<div class="rail-hint no-drag" role="status">
    <span>${t('rail.playHint', 'The sidebar folds away while you play. This button, the left edge of the window or {key} bring it back.', { key: shortcut('Mod+B') })}</span>
    <button class="btn small ghost" onClick=${() => setShown(false)}>${t('play.slowOk', 'Got it')}</button>
  </div>`;
}

function RailRun({ manifest, names, me, onlineSlots, linkStatus, session, navigate }) {
  const playing = session?.target.runId === manifest.id;
  const built = !!manifest.outputs?.[me];
  // not built yet (joined, game still to build): the run's page has the next step
  const open = () => (built ? navigate('play', { run: manifest.id }) : navigate(runSection(manifest), { run: manifest.id }));
  const action = playing ? t('play.backToGame', 'Back to the game') : built ? t('rail.openGame', 'Click to play') : t('rail.openRun', 'Click to open the run');
  if (runMode(manifest) === 'nuzlocke') {
    return html`<button type="button" class="power" onClick=${open} title=${`${t('rail.soloHint', 'Solo Nuzlocke – nobody to connect with')} · ${action}`}>
      <${Led} on=${playing} />
      <div class="stack-s" style="gap:0"><b>${manifest.name}</b><span class="tiny">${playing ? t('rail.soloPlaying', 'Solo Nuzlocke · playing') : t('rail.solo', 'Solo Nuzlocke')}</span></div>
    </button>`;
  }
  const others = othersOf(me, manifest);
  const live = others.filter((s) => onlineSlots.has(s));
  const list = (slots) => slots.map((s) => names[s]?.name || s.toUpperCase()).join(', ');
  const text = others.length === 1
    ? live.length ? t('rail.partnerLive', '{name} is live', { name: list(others) }) : linkStatus ? t('rail.waiting', 'Waiting for {name}', { name: list(others) }) : t('rail.offline', 'Not connected')
    : live.length === others.length ? t('rail.allLive', 'Everyone is live')
      : live.length ? t('rail.someLive', '{names} live · {n} of {all}', { names: list(live), n: live.length, all: others.length })
        : linkStatus ? t('rail.waitingGroup', 'Waiting for the others') : t('rail.offline', 'Not connected');
  return html`<button type="button" class="power" onClick=${open}
    title=${`${others.length === 1 ? t('rail.liveHintGreen', 'Green light: your partner is connected') : t('rail.liveHintGroup', 'Green light: somebody of your group is connected')} · ${action}`}>
    <${Led} on=${live.length > 0} blink=${!!linkStatus && live.length < others.length} />
    <div class="stack-s" style="gap:0"><b>${manifest.name}</b><span class="tiny">${text}</span></div>
  </button>`;
}

/**
 * Just joined with a name of our own (JoinRun): it replaces the host's placeholder for our seat. Written once as the
 * newest value, so the sync hands it to every computer.
 */
function applyJoinName(doc, manifest) {
  if (!doc || !manifest?.id) return;
  try {
    const joined = JSON.parse(localStorage.getItem(`sl-joinname-${manifest.id}`) || 'null');
    if (!joined) return;
    if (joined.name && slotsOf(manifest).includes(joined.slot)) doc.set(`player:${joined.slot}`, { ...(doc.get(`player:${joined.slot}`) || {}), name: joined.name });
    localStorage.removeItem(`sl-joinname-${manifest.id}`);
  } catch {
    // storage blocked – the host's name stays
  }
}

function App() {
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState(null);
  const [boot, setBoot] = useState(true);
  const [status, setStatus] = useState(null);
  const [library, setLibrary] = useState(null);
  const [runId, setRunIdState] = useState(null);
  const [manifest, setManifest] = useState(null);
  const [missingRun, setMissingRun] = useState(null);
  const [doc, setDoc] = useState(null);
  const [docVersion, setDocVersion] = useState(0);
  const [runData, setRunData] = useState(() => new RunData());
  const [me, setMeState] = useState('p1');
  const [linkStatus, setLinkStatus] = useState(null);
  const [inbox, setInboxState] = useState(NO_INBOX);
  const [liveInfo, setLiveInfo] = useState(null);
  // the run an external emulator (mGBA, Azahar) was started for from its play view: its frames go there (ExternalFeed)
  const [externalRun, setExternalRun] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [trophyToasts, setTrophyToasts] = useState([]);
  const [deathAlert, setDeathAlert] = useState(null);
  const [restartOffer, setRestartOffer] = useState(null);
  const [runOver, setRunOver] = useState(null);
  const shownDeaths = useRef(new Set());
  const [session, setSession] = useState(null); // the running game { target } – lives across all sections
  const [pendingRun, setPendingRun] = useState(null); // run switch waiting for "close the game?"
  const sessionRef = useRef(null);
  sessionRef.current = session;
  // the game's last moment before a close from the UI (lib/lastmoment.mjs): the play view takes "where you left off" then
  const lastRef = useRef(null);
  if (!lastRef.current) lastRef.current = lastMoment();
  const [, setLangTick] = useState(0);
  const linkRef = useRef(null);
  const linkPlayRef = useRef(null); // trades and battles (web/lib/linksession.mjs)
  // the play view's reader of this player's money (views/play.mjs sets it while the run's game runs) – the wager dialogs
  const wagerRef = useRef({ money: null });
  const [linkPlay, setLinkPlay] = useState(null);
  const runIdRef = useRef(null);
  runIdRef.current = runId;
  const inboxKey = useRef('');
  const [route, navigate] = useRoute();
  const streamer = useStreamer();
  // controller navigation of the app's screens (lib/padnav.mjs) – it reads the latest settings through the ref
  const statusRef = useRef(null);
  statusRef.current = status;
  useEffect(() => startPadNav({ config: () => statusRef.current?.config || {} }), []);
  // the coffee button's little Pokémon moments – never while a game runs (full or in the corner), in the game's
  // fullscreen, during boot or onboarding (fxBusy is set further down, once those are known)
  const fxBusy = useRef(true);
  const coffee = useCoffeeFx(() => fxBusy.current);
  // The joke "please buy a license" window (lib/nag.mjs): every launch is counted once (a reload of the same window
  // isn't a launch); from the 5th on it may show up – never on top of onboarding, a game or another dialog.
  const [nag, setNag] = useState(null); // { launches } while it is open
  const nagChecked = useRef(false);
  useEffect(() => {
    if (!ready || boot || !status || nagChecked.current) return;
    nagChecked.current = true;
    try {
      if (sessionStorage.getItem('sl-nag-counted')) return;
      sessionStorage.setItem('sl-nag-counted', '1');
    } catch {
      // storage blocked: count it anyway
    }
    const next = countLaunch(status.config?.nag);
    const free = () => !!status.config?.onboarded && !sessionRef.current && !document.querySelector('dialog[open]');
    // (never on the first start after the update to 3.0 – the "What's new" cards have that moment)
    const show = free() && !whatsNewPending(status.config) && shouldNag({ ...next, off: status.config?.nagOff });
    api.post('/api/config', { nag: show ? { ...next, lastShown: Date.now() } : next }).catch(() => {});
    if (show) setTimeout(() => free() && setNag({ launches: next.launches }), 1500);
  }, [ready, boot, status]);
  // "What's new in 3.0" (views/whatsnew.mjs): once after the update from 2.x – when nothing else is in the way (the
  // welcome tour, the start-up animation, a game, another dialog: lib/whatsnew.mjs), so it may wait for the game to
  // close – and again whenever Help or Settings ask for it (WHATS_NEW_EVENT). Closing it counts as seen.
  const [whatsNew, setWhatsNew] = useState(false);
  const whatsNewDone = useRef(false);
  useEffect(() => {
    if (!ready || whatsNew || whatsNewDone.current) return undefined;
    const free = () => mayShowWhatsNew({ config: status?.config, boot, playing: !!sessionRef.current, dialogOpen: !!document.querySelector('dialog[open]') });
    if (!free()) return undefined;
    const id = setTimeout(() => { if (free() && !whatsNewDone.current) setWhatsNew(true); }, 900);
    return () => clearTimeout(id);
  }, [ready, boot, status, session, whatsNew]);
  useEffect(() => {
    const open = () => setWhatsNew(true);
    addEventListener(WHATS_NEW_EVENT, open);
    return () => removeEventListener(WHATS_NEW_EVENT, open);
  }, []);
  const closeWhatsNew = useCallback(() => {
    setWhatsNew(false);
    if (whatsNewDone.current || !whatsNewPending(status?.config)) return;
    whatsNewDone.current = true;
    api.post('/api/config', whatsNewSeenPatch()).then(() => reloadStatus()).catch(() => {});
  }, [status]);
  useEffect(() => {
    // for trying it out: dispatchEvent(new Event('souldew:nag'))
    const open = () => setNag({ launches: Math.max(5, (status?.config?.nag?.launches) || 5) });
    addEventListener('souldew:nag', open);
    return () => removeEventListener('souldew:nag', open);
  }, [status]);

  // A toast with a `key` replaces the one shown with that key (progress: "Unpacking … 40 %"); `{ key, remove: true }`
  // takes it away.
  const toastTimers = useRef({});
  const toast = useCallback((x) => {
    const id = x.key ? `key:${x.key}` : Math.random().toString(36).slice(2);
    clearTimeout(toastTimers.current[id]);
    if (x.remove) {
      setToasts((ts) => ts.filter((y) => y.id !== id));
      return;
    }
    setToasts((ts) => [...ts.filter((y) => y.id !== id).slice(-4), { id, ...x }]);
    toastTimers.current[id] = setTimeout(() => {
      delete toastTimers.current[id];
      setToasts((ts) => ts.filter((y) => y.id !== id));
    }, x.ttl || (x.kind === 'death' ? 12000 : 6000));
  }, []);

  const reloadStatus = useCallback(async () => {
    const s = await api.get('/api/status').catch(() => null);
    if (s) setStatus(s);
    return s;
  }, []);
  const reloadLibrary = useCallback(async () => {
    const l = await api.get('/api/library').catch(() => null);
    if (l) setLibrary(l);
    return l;
  }, []);
  const reloadManifest = useCallback(async (id = runIdRef.current) => {
    if (!id) return null;
    const m = await api.get(`/api/runs/${id}`).catch(() => null);
    if (id === runIdRef.current) { // a late reply for a previous run must not win
      setManifest(m);
      setMissingRun(m ? null : id);
    }
    return m;
  }, []);
  // Only re-renders when the inbox content actually changed (live snapshots arrive every frame).
  const setInbox = useCallback((x) => {
    const next = { inbox: x?.inbox || [], alerts: x?.alerts || [] };
    const key = JSON.stringify(next);
    if (key === inboxKey.current) return;
    inboxKey.current = key;
    setInboxState(next);
  }, []);

  const switchRun = useCallback((id) => {
    runIdRef.current = id;
    setRunIdState(id);
    api.post('/api/config', { lastRun: id }).catch(() => {});
  }, []);
  // The running game is bound to its run: the menu never swaps the run under it – it asks first.
  const setRunId = useCallback((id) => {
    const s = sessionRef.current;
    if (s?.target.runId && id !== s.target.runId) return setPendingRun({ id });
    switchRun(id);
  }, []);
  const startSession = useCallback((target) => setSession({ target, at: Date.now() }), []);
  const endSession = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    setSession(null);
  }, []);
  // Closing from the UI: asks first when there is progress since the last in-game save.
  const [pendingClose, setPendingClose] = useState(null); // { after } – close waiting for "not saved in-game"
  // The game ends once the play view has its last state ("where you left off" – a moment, see lib/lastmoment.mjs).
  const closeSession = useCallback((after) => {
    if (unsavedProgress()) return setPendingClose({ after });
    lastRef.current.close(() => {
      endSession();
      after?.();
    });
  }, []);
  const setMe = useCallback((slot, id = runIdRef.current) => {
    setMeState(slot);
    if (id) pref.set(`sl-me-${id}`, slot);
  }, []);

  // ---- boot ----------------------------------------------------------------------
  const bootUp = useCallback(async () => {
    setBootError(null);
    try {
      const s = await api.get('/api/status');
      setStatus(s);
      applyTheme(s.config?.theme);
      // souldew+: the chosen skin is remembered now and shows as soon as the pack is loaded and verified (in the background)
      applySkin(s.config?.skin);
      initFavourites(s.config?.favourites); // the starred looks in the cosmetics pickers
      initHandheld(s.config?.handheld); // "Your handheld" in the launch animation (a local setting)
      prewarmHandheld(); // three.js and the sticker atlas at idle, so the first launch spends no time loading them
      // the pack comes through the account – and only once the account is known: until the server has read the saved
      // sign-in (keychain, in the background) the player only looks signed out, and that must not wipe a member's pack
      setPackAccessProvider((o) => cosmeticsPackAccess({ ...o, signedOut: devPackAccess }));
      refreshPack().catch((e) => console.warn('souldew+ pack', e));
      const lang = await setLang(s.config?.lang || guessLang());
      sendMenuLabels(s.config?.controls || null);
      await detectLayout(lang); // key names in Help / Settings › Controls
      await Promise.all([loadData(), loadLocationTables(), reloadLibrary()]);
      const id = s.config?.lastRun && s.runs?.some((r) => r.id === s.config.lastRun) ? s.config.lastRun : s.runs?.[0]?.id || null;
      runIdRef.current = id;
      setRunIdState(id);
      if (s.config?.bootAnimation === false) setBoot(false);
      setReady(true);
    } catch (e) {
      console.error('boot failed', e);
      setBootError(e.message || String(e));
    }
  }, []);
  useEffect(() => {
    bootUp();
    return onLangChange((l) => { detectLayout(l); sendMenuLabels(); setLangTick((x) => x + 1); });
  }, []);
  // re-bound shortcuts (Settings › Controls): the menu shows the new keys
  const controlsSig = JSON.stringify(status?.config?.controls || null);
  useEffect(() => { if (status) sendMenuLabels(status.config?.controls || null); }, [controlsSig]);

  // ---- active run ----------------------------------------------------------------
  // a name typed when joining can arrive after the run's doc is open (the build finishes later): apply it then too
  useEffect(() => applyJoinName(doc, manifest), [doc, manifest]);
  // Play together: which game this computer's player plays, for the partners' "who can link with whom" (again after a
  // join's build – the run's game is ours from then on)
  useEffect(() => { announceGame(doc, manifest, me); }, [doc, manifest, me]);
  useEffect(() => {
    // Drop everything of the previous run before loading the next one.
    setDoc(null);
    setManifest(null);
    setMissingRun(null);
    setInbox(NO_INBOX);
    setDeathAlert(null); // it names an area of the previous run
    setRunOver(null);
    linkRef.current?.stop();
    linkRef.current = null;
    setLinkStatus(null);
    if (!runId) return;
    let cancelled = false;
    let unsub = null;
    let stopHost = () => {};
    (async () => {
      const m = await reloadManifest(runId);
      if (!m || cancelled) return;
      const d = await new RunDoc(runId).load();
      // (the ROM's own data comes later, below: its scan must not hold up the run – the board, the sync with the
      // others, their link sessions)
      const rd = await new RunData().load(m, { rom: false });
      if (cancelled) return;
      // (an invite imported without a stored choice: the first player after the host, as before)
      // (a stored slot the run doesn't have – fewer players after a rebuild – would break every name lookup)
      setMeState(mySlotIn(m));
      for (const s of slotsOf(m)) if (!d.get(`player:${s}`) && m.players?.[s]) d.set(`player:${s}`, m.players[s]);
      applyJoinName(d, m);
      initRules(d, m);
      // Older versions kept the Discord webhook in the shared rules: hand it to the server once (it moves it into
      // this computer's config) and drop it from the doc, so it no longer syncs to the partner.
      const legacy = d.get('rules');
      if (legacy && typeof legacy === 'object' && 'discordWebhook' in legacy) {
        const clean = { ...legacy };
        delete clean.discordWebhook;
        api.post(`/api/runs/${runId}/meta`, { rules: legacy }).catch(() => {});
        d.set('rules', clean);
      }
      // a SoulLink's rules are the host's: signed by its computer, checked when they come in (lib/hostrules.mjs)
      stopHost = setupHostRules(d, m, { me: mySlotIn(m), reload: () => !cancelled && reloadManifest(runId) });
      const unsubDoc = d.subscribe(() => setDocVersion((v) => v + 1));
      unsub = () => {
        unsubDoc();
        stopHost();
      };
      setDoc(d);
      setRunData(rd);
      setDocVersion((v) => v + 1);
      // The ROM's own data (its types, a hack's own Pokémon): a scan of the game file on the server – seconds for a DS
      // game, up to minutes on a slow PC the first time. Until it arrives the official types stand in. (The run used
      // to wait for it: a partner on such a PC stayed offline that long – no sync, no link session.)
      rd.romFetch(m).then((j) => {
        if (!cancelled && j) setRunData((cur) => (cur === rd ? rd.withRom(j) : cur));
      });
    })();
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [runId]);

  // doc and manifest are loaded separately – only use them together once they belong to the same run.
  const runDoc = doc && manifest && doc.runId === manifest.id ? doc : null;
  // Sounds are a per-computer preference (Settings), not a shared run rule.
  const soundOn = useRef(true);
  soundOn.current = status?.config?.sounds !== false;
  const sfx = useCallback((name) => play(name, soundOn.current), []);

  // souldew put the graphics backend back to "Automatic" (electron/main.mjs): say so once, then forget the notice.
  // (Once the app language is loaded and the start-up animation is over.)
  const gpuFallback = ready && !boot ? status?.config?.gpuFallback : null;
  useEffect(() => {
    if (!gpuFallback) return;
    toast({ kind: 'warn', title: t('set.gpuFallbackTitle', 'Graphics backend reset'), text: gpuFallbackText(gpuFallback), ttl: 20000,
      action: { label: t('play.slowSettings', 'Open Settings'), run: () => navigate('settings', settingsLink('gpu')) } });
    api.post('/api/config', { gpuFallback: null }).catch(() => {});
  }, [gpuFallback?.from, gpuFallback?.reason]);
  // A safe graphics start (--safe-graphics, electron/main.mjs): say what it is and where the backend is changed.
  useEffect(() => {
    if (!ready || boot || typeof window.sls?.gpuInfo !== 'function') return;
    window.sls.gpuInfo().then((g) => {
      if (!g?.safe) return;
      const choose = PLATFORM === 'win32' || PLATFORM === 'linux';
      toast({ kind: 'warn', title: t('set.gpuSafeTitle', 'Safe graphics mode'), ttl: 20000,
        text: choose ? t('set.gpuSafeToast', 'souldew draws without the graphics card this time (slower). Pick another graphics backend in Settings › About › Troubleshooting, then restart normally.')
          : t('set.gpuSafeToastMac', 'souldew draws without the graphics card this time (slower). Quit and start it again for the normal mode.'),
        ...(choose ? { action: { label: t('play.slowSettings', 'Open Settings'), run: () => navigate('settings', settingsLink('gpu')) } } : {}) });
    }).catch(() => {});
  }, [ready, boot]);

  // ---- partner events → toasts & sounds --------------------------------------------
  useEffect(() => {
    if (!runDoc) return;
    const doc = runDoc;
    // deaths that came in while the run wasn't open (see below) – once the notice below is listening
    queueMicrotask(() => settleLives(doc, manifest));
    return doc.subscribe((keys, remote, info) => {
      const names = getPlayers(doc, manifest);
      // The partner's timestamps come from their clock, which may be minutes off: shift them by the measured offset.
      const age = (at) => Date.now() - at - (remote ? info?.offset || 0 : 0);
      // The lives rule for deaths that didn't go through this app's spendLife: a 2.7.4 partner doesn't know the rule,
      // and two deaths made offline only use up a pool once they meet. Settled from the doc – once, and with the same
      // log line on every computer (lib/run.mjs settleLives); after this change has gone to every subscriber.
      if (keys.some((k) => k.startsWith('pair:') || k.startsWith('extra:'))) queueMicrotask(() => settleLives(doc, manifest));
      for (const k of keys) {
        // The run just ended (a wipe here or at the partner's, or marked failed / won): the notice for both.
        if (k === 'run:status') {
          const st = doc.get(k);
          // (whoever just ended it by hand in the board doesn't need to be told)
          if ((st?.state === 'failed' || st?.state === 'won') && age(st.at) < 120000 && (st.auto || st.by !== me)) {
            setDeathAlert(null); // the last death is part of the notice
            setRunOver(st);
            sfx(st.state === 'won' ? 'badge' : 'death');
          } else if (!st) setRunOver(null);
          continue;
        }
        // A pair died (here or at the partner's): a big alert for both players, once per death.
        if (k.startsWith('pair:')) {
          const p = doc.get(k);
          const id = `${k}:${p?.diedAt}`;
          if (p?.state === 'dead' && p.diedAt && age(p.diedAt) < 120000 && !shownDeaths.current.has(id)) {
            shownDeaths.current.add(id);
            setDeathAlert({ area: k.slice(5), by: p.by || othersOf(me, manifest)[0] || me });
            sfx('death');
          }
        }
        // The lives rule: a death left few lives in its pool – a quiet warning for everyone, once per death.
        if (k.startsWith('pair:') || k.startsWith('extra:')) {
          const v = doc.get(k);
          const at = (k.startsWith('pair:') ? v?.state === 'dead' : v?.dead) ? v.diedAt : 0;
          const id = `lives:${k}:${at}`;
          if (at && age(at) < 120000 && !shownDeaths.current.has(id)) {
            shownDeaths.current.add(id);
            const slot = k.startsWith('pair:') ? v.by : k.split(':')[1];
            const pool = livesFor(doc, manifest, slot);
            // (none left: the run is over – that notice says it)
            if (pool?.low) {
              const vars = { n: pool.left, count: pool.left, name: names[slot]?.name || '' };
              toast({ kind: 'warn', title: t('lives.lowTitle', 'Lives running low'), text: getLives(doc, manifest).pool !== 'player'
                ? t('lives.lowText', 'Only {n} life left.|Only {n} lives left.', vars)
                : slot === me ? t('lives.lowMine', 'You have only {n} life left.|You have only {n} lives left.', vars)
                  : t('lives.lowOther', '{name} has only {n} life left.|{name} has only {n} lives left.', vars) });
            }
          }
        }
        if (!remote) continue;
        if (k.startsWith('feed:')) {
          const f = doc.get(k);
          // (an edit by hand: whoever made it – it may be in my slot)
          if (f && (f.type === 'edit' ? f.editor && f.editor !== me : f.slot !== me) && age(f.at) < 60000 && f.type !== 'death') {
            toast({ kind: 'soul', title: names[f.editor || f.slot]?.name || t('common.partner', 'Partner'), text: feedText(doc, manifest, f) });
            if (f.type === 'catch') sfx('catch');
            if (f.type === 'badge') sfx('badge');
          }
        }
      }
    });
  }, [runDoc, me, manifest]);

  // The partner started this run over: offer to join the new one (now, or whenever this run is opened next).
  useEffect(() => {
    if (!runDoc) return undefined;
    const check = () => {
      const r = runDoc.get('run:restart');
      if (!r?.id || !r.pack || r.by === me) return;
      if ((status?.runs || []).some((x) => x.id === r.id)) return; // already joined
      try {
        if (sessionStorage.getItem(`sl-restart-seen-${r.id}`)) return;
      } catch {
        // storage blocked – ask again next time
      }
      setRestartOffer(r);
    };
    check();
    return runDoc.subscribe((keys) => keys.includes('run:restart') && check());
  }, [runDoc, me, status?.runs?.length]);

  // "New attempt" pressed in a run another player already started over (views/restart.mjs): their offer, even when
  // it was put off with "Later" before. offer.slot: our slot in that old run (it may not be the open one).
  const offerRestart = useCallback((offer) => {
    try {
      sessionStorage.removeItem(`sl-restart-seen-${offer.id}`);
    } catch {
      // storage blocked
    }
    setRestartOffer(offer);
  }, []);

  // ---- trophies: the slot played per run, live moments of the open run, unlock toasts ----
  const runCount = status?.runs?.length || 0;
  useEffect(() => {
    if (!ready || boot) return; // after the start-up animation: a back-fill note shouldn't hide behind it
    rememberSlots(status?.runs);
    syncTrophies();
  }, [ready, boot, runCount, me]);
  useEffect(() => {
    // an invite that's open but not built yet isn't this computer's run: nothing it shows counts (shared/trophies.mjs)
    // (Play together counts for no trophy – server/lib/trophies.mjs)
    if (!runDoc || !runStarted(manifest) || isTogether(manifest)) return undefined;
    return watchRun(runDoc, manifest, me, (sp) => runData?.types?.(sp, me) || []);
  }, [runDoc, manifest, me, runData]);
  useEffect(() => onTrophyUnlock(({ fresh, backfilled, state }) => {
    const byId = Object.fromEntries((state.achievements || []).map((a) => [a.id, a]));
    // the first start counted the runs that were already there: one quiet note instead of a toast each
    if (backfilled.length) toast({ kind: 'ok', title: t('trophy.backfillTitle', 'Trophies are here'), text: t('trophy.backfillText', 'Your past runs already earned {n} achievement – have a look under Trophies.|Your past runs already earned {n} achievements – have a look under Trophies.', { n: backfilled.length, count: backfilled.length }), ttl: 9000 });
    const items = fresh.map((id) => byId[id]).filter(Boolean).slice(0, 4).map((a) => ({ key: `${a.id}-${Date.now()}`, a }));
    if (!items.length) return;
    setTrophyToasts((ts) => [...ts, ...items].slice(-3));
    for (const it of items) setTimeout(() => setTrophyToasts((ts) => ts.filter((x) => x.key !== it.key)), 7000);
  }), []);

  // ---- snapshots (live RAM / save files / external bridge) ---------------------------
  // battle: what the live loop sees on the other side right now – a death in it gets its cause (opponent, level).
  // After deaths were written (a snapshot, or held deaths revealed): a wiped team ends the run, and Discord hears of
  // the catches and deaths.
  const afterDeaths = (doc, { newCatches = [], deaths = [] }, notify) => {
    // the last of my Pokémon fell → the run is over (every player gets the big notice via the doc). A solo
    // Nuzlocke goes by its blackout rule instead (with the manifest, wipedSlot asks it; applySnapshot already
    // ended the run on a blackout or a deathless death – failRun then does nothing).
    if (wipedSlot(doc, [me], manifest)) failRun(doc, manifest, me, runMode(manifest) === 'nuzlocke' ? 'blackout' : undefined);
    if (notify && newCatches.length) sfx('catch');
    // deaths: the doc subscription above shows the big alert (for both players)
    // The server posts to this computer's webhook for the run, if one is set (none → it does nothing).
    if (notify && (newCatches.length || deaths.length)) {
      const n = getPlayers(doc, manifest)[me].name;
      const lines = [...newCatches.map((a) => `🎯 **${n}** – ${areaName(doc, manifest, a)}: ${speciesName(doc.get(`enc:${a}:${me}`)?.species)}`),
        ...deaths.map((a) => `💀 **${n}** – ${areaName(doc, manifest, a)}`)];
      api.post('/api/notify/discord', { runId: manifest.id, content: lines.join('\n') }).catch(() => {});
    }
  };
  // held: the Pokémon whose fall the game hasn't shown yet (the play view's DeathReveal – key → the HP still shown)
  const applySnap = useCallback((snap, { notify = true, battle = null, held = null } = {}) => {
    if (!runDoc) return null;
    const doc = runDoc;
    // A link session (docs/MULTIPLAYER.md › rules): what the game shows meanwhile isn't the run's – a link battle (also
    // one fought in a "trade" session: the Colosseum is next door) would count deaths and wipes, a trade screen shuffles
    // the party. Nothing of it is applied; the first and the last team it showed make the trade's log entry, and the run
    // goes on from the session's in-game save. Only "Losing a link battle counts as deaths" applies a battle's team.
    // A raid (web/lib/raid.mjs) with "Deaths in a raid count" off: while this player's raid battle runs, what the game
    // shows isn't applied; a Pokémon that went down in it is taken as standing until it's healed (it is at 0 HP in the
    // game until a Pokémon Center – a raid is a real battle)
    const together = isTogether(manifest); // (Play together: only the live team is written – lib/run.mjs applyTogether)
    const rh = together ? null : raidFor(doc);
    if (rh && snap.source === 'live' && !raidRules(getRules(doc, manifest)).deaths) {
      if (rh.inRaidBattle()) {
        rh.spare(snap.party);
        return null;
      }
      const sp = rh.spared(snap.party, held);
      if (sp) {
        snap = { ...snap, party: sp.party };
        held = sp.held;
      }
    }
    const lps = linkPlayRef.current;
    if (lps?.state?.phase === 'running' && snap.source === 'live') {
      if ((snap.party || []).length) {
        lps.partyFirst ||= snap.party;
        lps.partyLast = snap.party;
      }
      if (!(lps.state.kind === 'battle' && getRules(doc, manifest)?.linkBattleDeaths)) return null;
    }
    // The game itself still in link mode after its session (left inside a Cable Club / Colosseum – Gen 2 even fights
    // the partner's team it received once more, alone): the same rule as during the session.
    if (snap.linkedGame && snap.source === 'live' && !getRules(doc, manifest)?.linkBattleDeaths) return null;
    if (together) return applyTogether(doc, manifest, me, snap);
    // An ended run stays as it ended: playing on (for fun, or after a wipe) records nothing anymore.
    if (doc.get('run:status')) return null;
    const res = applySnapshot(doc, manifest, genOfRun(manifest, runData), me, snap, { rd: runData, battle, held });
    setInbox(res);
    afterDeaths(doc, res, notify);
    return res;
  }, [runDoc, manifest, runData, me]);
  // The play view between snapshots (a reset, the title screen, the game closed): the held deaths it no longer holds
  // (`keep`: the ones it still does) are revealed now – recorded already, they never go away.
  const revealDeaths = useCallback((keep = null) => {
    if (!runDoc || !me || !Object.keys(runDoc.scan(`${HELD_PREFIX}${me}:`)).length) return null;
    const res = revealHeld(runDoc, manifest, me, { keep });
    afterDeaths(runDoc, res, true);
    return res;
  }, [runDoc, manifest, me]);
  // The play view saw the first Poké Balls in this player's bag: the run's rules start for them (lib/run.mjs startRules).
  const ballsSeen = useCallback((down = []) => !!runDoc && !!me && startRules(runDoc, manifest, me, 'bag', down), [runDoc, manifest, me]);
  // Held deaths nobody holds any more: this player's from a session that ended without revealing them (the app was
  // quit or crashed – the game's next reading reveals them sooner), a partner's whose app went away before it could
  // (older than a couple of minutes; a play view holds one for seconds, a paused game a little longer) – revealed here,
  // with the same log line the other app would write.
  useEffect(() => {
    if (!runDoc || !manifest) return undefined;
    const sweep = () => {
      for (const s of slotsOf(manifest)) {
        if (!Object.keys(runDoc.scan(`${HELD_PREFIX}${s}:`)).length) continue;
        const res = revealHeld(runDoc, manifest, s, { olderThan: s === me ? 300000 : 120000 });
        if (s === me && res.deaths.length) afterDeaths(runDoc, res, true);
      }
    };
    sweep();
    const id = setInterval(sweep, 30000);
    return () => clearInterval(id);
  }, [runDoc, manifest?.id, me]);

  // One EventSource per run; handlers read the latest applySnap through a ref.
  const applySnapRef = useRef(applySnap);
  applySnapRef.current = applySnap;
  useEffect(() => events({
    save: (p) => p.runId === runId && applySnapRef.current(snapshotFromSave(p.save)),
    live: (frame) => setLiveInfo({ ...frame, at: Date.now() }),
    'live-status': (s) => setLiveInfo((x) => ({ ...(x || {}), status: s })),
    'save-error': (p) => p.runId === runId && toast({ kind: 'death', title: t('toast.saveError', 'Save file unreadable'), text: serverErrorText(p) }),
    // a zipped 3DS game being unpacked into the library (server/lib/library.mjs unpackZipGames) – what came of it is
    // told by the page that added it (web/lib/libadded.mjs addedMessage, or the error)
    unpack: (p) => toast(unpackToast(p)),
    // the souldew account: signed in / out, new counters of friend requests and invites (server/lib/accounts)
    account: (p) => accountEvent(p),
  }), [runId]);

  // ---- raids (web/lib/raid.mjs): one hub per run document – the invites, the host's start, the log entry ----
  useEffect(() => {
    if (!runDoc || !manifest || !me) return undefined;
    const hub = attachRaid({ doc: runDoc, manifest, me });
    if (pref.get('sl-e2e', false)) window.__slRaid = hub; // (scripts/raid-e2e.mjs sets sl-e2e)
    return () => detachRaid(runDoc);
  }, [runDoc, manifest?.id, me]);

  // ---- link battles every player agreed on: the log entry (each computer writes the same, keyed by the session) ----
  useEffect(() => {
    if (!runDoc || !manifest) return undefined;
    const doc = runDoc;
    const check = () => {
      for (const [sid, entries] of Object.entries(sessionsIn(doc))) {
        if (doc.get(`feed:lb-${sid}`)) continue;
        try {
          logLinkBattle(doc, manifest, sid, outcomeOf(entries));
        } catch (e) {
          console.warn('link battle log', e);
        }
      }
    };
    check();
    return doc.subscribe((keys) => keys.some((k) => k.startsWith('lb:')) && check());
  }, [runDoc, manifest]);

  // ---- live link -----------------------------------------------------------------
  const connect = useCallback(async () => {
    if (!runDoc) return;
    const doc = runDoc;
    linkRef.current?.stop();
    const names = getPlayers(doc, manifest);
    const link = new SyncLink({
      room: manifest.room, secret: manifest.secret, slot: me, slots: slotsOf(manifest), name: names[me].name, doc,
      // TURN for strict NATs: short-lived credentials from souldew's bot through the local server (docs/MULTIPLAYER.md)
      getIceServers: () => api.get('/api/link/ice').then((r) => (r?.iceServers ? { iceServers: r.iceServers, relayOnly: !!r.relayOnly } : null)),
      onStatus: (s) => linkRef.current === link && setLinkStatus({ ...s }),
      onMessage: (msg) => {
        if (msg.payload?.type === 'ping') {
          // (the ping's text in our language – the partner's own `text` is in theirs)
          toast({ kind: 'soul', title: t('toast.ping', '{name} pings you', { name: names[msg.from]?.name || t('common.partner', 'Partner') }), text: t('log.pingText', 'Hey, take a look!') });
          sfx('ping');
        }
      },
    });
    linkRef.current = link;
    attachRps(link, { doc, manifest }); // rock-paper-scissors between the players (lib/worldrps.mjs)
    attachTogether(link, { doc, manifest }); // battles, gifts, catches and deaths, "come to me" (lib/together.mjs)
    linkPlayRef.current?.stop();
    // a link session: the play view shows the local seat (target.link); its end closes it
    // this player's game of this run, running in the fast player right now (a link session starts from it – seamless)
    const nativeEmu = () => document.querySelector('iframe[src^="/playernative.html"]')?.contentWindow?.__emu || null;
    const ownGame = () => {
      const tg = sessionRef.current?.target;
      return !!tg && tg.runId === manifest.id && !tg.link && tg.saveUrl === `/api/runs/${manifest.id}/save/${me}` && !!nativeEmu()?.ready;
    };
    const lp = new LinkSessions({
      sync: link, runId: manifest.id, me, emu: nativeEmu, ownGame,
      rules: () => getRules(doc, manifest),
      // Play together: every player has a game of their own – which of them can link (shared/playtogether.mjs)
      block: (slots, kind) => {
        if (!isTogether(manifest)) return null;
        const b = inviteBlock(togetherGames(doc, manifest, me), me, slots, kind);
        return b ? BLOCK_CODE[b.why] || 'linkSystem' : null;
      },
      // what this computer read of a session's battles (web/lib/wager.mjs): compared with the partners' in the run
      // (kept on this computer too: a payment follows only what it read itself)
      onResult: (entry) => recordResult(doc, me, entry),
      onChange: (st) => linkPlayRef.current === lp && setLinkPlay({ ...st }),
      // out of step: from now on the play view writes none of the session's saves, and the ones on their way land first
      beforeRestore: async () => {
        const tl = sessionRef.current?.target?.link;
        if (!tl) return;
        tl.discard = true;
        await Promise.race([tl.settle?.(), new Promise((res) => setTimeout(res, 15000))]);
      },
      openSession: (st) => {
        lp.partyFirst = lp.partyLast = null; // the teams the link session shows first and last (the trade's log entry)
        const out = manifest.outputs?.[me];
        if (!out) return;
        const link = { id: st.id, seats: st.seats, kind: st.kind, delay: st.delay, model: st.models?.[me] || null };
        const cur = sessionRef.current;
        if (st.seamless && cur?.target?.runId === manifest.id) { // the running game went into the session: same player, same picture
          cur.target.link = link; // (the play view's save writer reads target.link as it goes)
          setSession({ ...cur });
          return;
        }
        startSession({
          kind: 'run', key: `link-${st.id}`, soloKey: `run-${manifest.id}-${me}`, system: manifest.game?.system, code: manifest.game?.code, title: manifest.game?.title,
          rom: `/api/runs/${manifest.id}/file?inline=1&name=${encodeURIComponent(out.rom)}`, name: out.rom.replace(/\.\w+$/, ''),
          saveUrl: `/api/runs/${manifest.id}/save/${me}`, stateId: runStateId(manifest, me), label: manifest.name, gameId: manifest.game?.id,
          runId: manifest.id, params: { run: manifest.id }, link,
        });
        navigate('play', { run: manifest.id });
      },
      closeSession: (st) => {
        const cur = sessionRef.current;
        const tl = cur?.target?.link;
        // fell out of step: the run's save went back to before the session – the play view writes no last save of it
        if (st.ended?.reason === 'linkDesync' && tl) tl.discard = true;
        if (st.kind === 'trade' && st.ended?.reason !== 'linkDesync') {
          const partner = (st.seats || []).find((s) => s !== me);
          try {
            logLinkTrade(doc, manifest, me, partner, lp.partyFirst, lp.partyLast);
          } catch (e) {
            console.warn('trade log', e);
          }
        }
        // the player's own console went on alone (seamless): the same game keeps running – no restart, nothing to close
        if (st.ended?.resumed && tl && cur) {
          cur.target.link = null;
          setSession({ ...cur });
          return;
        }
        endSession();
      },
    });
    linkPlayRef.current = lp;
    if (pref.get('sl-e2e', false)) window.__slLink = { sessions: lp, sync: link }; // (scripts/link-e2e.mjs sets sl-e2e)
    if (lp.state.phase !== 'idle') {
      setLinkPlay({ ...lp.state }); // (a session this page dropped out of: the bar offers to rejoin it)
      // the run's own game came up meanwhile (a reload on the play view): it waits until the link is rejoined or left
      if (lp.state.phase === 'rejoinable' && sessionRef.current?.target?.runId === manifest.id && !sessionRef.current.target.link) endSession();
    }
    await link.start();
    if (linkRef.current === link) pref.set(`sl-autolink-${manifest.id}`, true);
  }, [runDoc, manifest, me]);
  const disconnect = useCallback(() => {
    linkPlayRef.current?.stop();
    linkPlayRef.current = null;
    setLinkPlay(null);
    linkRef.current?.stop();
    linkRef.current = null;
    setLinkStatus(null);
    if (manifest) pref.set(`sl-autolink-${manifest.id}`, false);
  }, [manifest]);
  useEffect(() => {
    // A solo Nuzlocke has nobody to sync with – no relay traffic unless connected by hand (Connection page).
    if (runDoc && runMode(manifest) !== 'nuzlocke' && pref.get(`sl-autolink-${manifest.id}`, true)) connect();
    return () => {
      linkPlayRef.current?.stop();
      linkPlayRef.current = null;
      setLinkPlay(null);
      linkRef.current?.stop();
      linkRef.current = null;
      setLinkStatus(null);
    };
  }, [runDoc, manifest?.id, me]);
  // Leaving the page (reload, navigating away, closing the window): stop() says "offline" right away and sends
  // what is queued – otherwise the partner keeps seeing us live from the retained presence until it ages out.
  // A page restored from the back/forward cache connects again.
  const connectRef = useRef(connect);
  connectRef.current = connect;
  useEffect(() => {
    const hide = () => linkRef.current?.stop();
    const show = (e) => {
      const id = runIdRef.current;
      if (e.persisted && id && pref.get(`sl-autolink-${id}`, true)) connectRef.current();
    };
    addEventListener('pagehide', hide);
    addEventListener('pageshow', show);
    return () => {
      removeEventListener('pagehide', hide);
      removeEventListener('pageshow', show);
    };
  }, []);


  // ---- native menu ----------------------------------------------------------------
  useEffect(() => {
    if (!window.sls?.on) return;
    const offs = [
      window.sls.on('navigate', (r) => navigate(r)),
      window.sls.on('menu', async (what) => {
        if (what === 'add-games') {
          const { addGamesFlow } = await import('./views/library.mjs');
          addGamesFlow({ reloadLibrary, toast });
        }
        if (what === 'reveal-library') api.post('/api/library/reveal', {});
        if (what === 'shortcuts') navigate('guide', { tab: 'keys' });
        if (what === 'ui-in' || what === 'ui-out' || what === 'ui-reset') stepUi(what.slice(3), { onLimit: uiScaleLimited });
      }),
    ];
    return () => offs.forEach((f) => f());
  }, []);

  // ---- interface size (lib/uiscale.mjs, Settings › General) ----------------------------------------------------
  // The shortcuts on the page (⌘+ / ⌘− / ⌘0, Ctrl elsewhere – the play view hands over the ones pressed in the game), the
  // window's size as it changes, and once per computer a quiet hint when the window is big on a large screen at 100 %.
  const uiScaleLimited = useCallback(() => toast({ key: 'ui-scale', title: t('ui.scaleLimitTitle', 'That’s the biggest size this window has room for'),
    text: t('ui.scaleLimitText', 'Make the window larger and the interface grows to the size you picked.') }), [toast]);
  useEffect(() => {
    const offKeys = watchUiScaleKeys({ onLimit: uiScaleLimited });
    const offState = initUiScale();
    return () => {
      offKeys();
      offState();
    };
  }, []);
  const uiScale = useUiScale();
  const uiHinted = useRef(false);
  useEffect(() => {
    if (uiHinted.current || !ready || boot || !status?.config?.onboarded || status.config.uiScaleHint) return;
    const s = suggestUiScale(uiScale);
    if (!s) return;
    uiHinted.current = true;
    api.post('/api/config', { uiScaleHint: true }).catch(() => {}); // asked once – whatever the answer
    toast({ key: 'ui-scale-hint', ttl: 30000, title: t('ui.scaleHintTitle', 'The interface looks small on this screen – make it bigger?'),
      text: t('ui.scaleHintText', '{size} suits a screen this large. You can change it any time – “Interface size” in Settings, or {bigger} and {smaller}.',
        { size: uiScaleLabel(s), ...uiScaleKeys() }),
      action: { label: t('ui.scaleHintYes', 'Make it {size}', { size: uiScaleLabel(s) }), run: () => setUiScale(s) } });
  }, [ready, boot, status, uiScale]);

  // Who of the other players is online right now (heard from within PARTNER_TTL, or a direct link is up);
  // partnerOnline: anybody at all (the two-player call sites).
  const others = manifest ? othersOf(me, manifest) : [];
  const onlineSlots = new Set(Object.entries(linkStatus?.partners || {})
    .filter(([s, p]) => others.includes(s) && (p.p2p || Date.now() - p.seen < PARTNER_TTL)).map(([s]) => s));
  if (runDoc && raidFor(runDoc)) raidFor(runDoc).online = onlineSlots; // (who can be asked to a raid, who is still there)
  const partnerOnline = onlineSlots.size > 0
    || !!(linkStatus?.partner && linkStatus.partnerSeen && Date.now() - linkStatus.partnerSeen < PARTNER_TTL);
  // checks() walks both teams and the rules – only again when the doc (docVersion) or the run changed, not on every
  // render (toasts, live frames from an external emulator …)
  const checkCount = useMemo(() => (runDoc ? checks(runDoc, manifest, runData).length : 0), [runDoc, docVersion, manifest, runData]);
  const warnCount = runDoc ? checkCount + inbox.inbox.length + inbox.alerts.length : 0;
  // the souldew account (lib/socialapp.mjs): presence, notices, the Friends entry – nothing at all while signed out
  const social = useSocial({ ready, route, session, manifest, doc: runDoc, me, linkStatus, toast, navigate });
  const ctx = {
    status, reloadStatus, library, reloadLibrary, runId, setRunId, manifest, missingRun, reloadManifest, doc: runDoc, docVersion, runData, me, setMe,
    navigate, route, link: linkRef.current, linkStatus, linkPlay, linkSessions: linkPlayRef.current, partnerOnline, onlineSlots, connect, disconnect, inbox, setInbox, applySnap, revealDeaths, ballsSeen, toast, liveInfo,
    externalRun, setExternalRun,
    session, startSession, endSession, closeSession, offerRestart, wagerRef, lastMoment: lastRef.current,
  };

  if (!ready) {
    if (bootError) {
      return html`<div class="boot" style="cursor:default"><div class="panel stack" role="alert" style="max-width:420px">
        <h2>${t('boot.failed', 'souldew could not start')}</h2>
        <p class="small muted">${t('boot.failedText', 'The local server did not answer or a data file is missing. Check that the app is still running, then try again.')}</p>
        <p class="small code">${bootError}</p>
        <div><button class="btn primary" onClick=${bootUp}>${t('err.retry', 'Try again')}</button></div>
      </div></div>`;
    }
    return html`<div class="boot"><div class="boot-screen"></div></div>`;
  }
  const showOnboarding = !!status && !status.config?.onboarded;
  const View = { library: LibraryView, soullink: SoulLinkView, nuzlocke: NuzlockeView, play: PlayView, link: LinkView, stream: StreamView, trophies: TrophiesView, settings: SettingsView, guide: GuideView, friends: FriendsView, profile: ProfileView, plus: PlusView, thanks: ThanksView, handheld: HandheldView }[route.route] || LibraryView;
  const names = runDoc ? getPlayers(runDoc, manifest) : null;
  // Fullscreen – the window's (macOS: green button, Windows: F11) or the game's (F): the side rail folds away, the game gets the room
  const [winFs, setWinFs] = useState(false);
  const [docFs, setDocFs] = useState(false);
  useEffect(() => {
    const off = window.sls?.on?.('fullscreen', (v) => setWinFs(!!v));
    const doc = () => setDocFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', doc);
    return () => { off?.(); document.removeEventListener('fullscreenchange', doc); };
  }, []);
  // The side rail: open, or folded away by hand (remembered) – and always folded in fullscreen and while the game fills
  // the Play page (the game gets the room). Folded, it slides in over the page while the pointer is at the window's left
  // edge (or a key moves the focus into it); the button at the top left and ⌘B / Ctrl+B show it too.
  // (onfocusin / onfocusout in lowercase: Preact would listen for a `FocusOut` event otherwise)
  const [railHidden, setRailHidden] = useState(() => { try { return localStorage.getItem('sl-rail-hidden') === '1'; } catch { return false; } });
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef(0);
  const fs = winFs || docFs;
  // The game fills the Play page when that page shows it, otherwise it keeps running in the corner.
  const sp = session?.target.params || {};
  const rp = route.params;
  const showsSession = route.route === 'play' && rp.home === undefined
    && (rp.run ? rp.run === sp.run : rp.rom ? rp.rom === sp.rom && (rp.patch || '') === (sp.patch || '') : true);
  const playFold = !!session && showsSession;
  const folded = railHidden || fs || playFold;
  const setHidden = useCallback((h) => {
    setRailHidden(h);
    setPeek(false);
    try { localStorage.setItem('sl-rail-hidden', h ? '1' : '0'); } catch {}
  }, []);
  const peekIn = () => { clearTimeout(peekTimer.current); setPeek(true); };
  const peekOut = () => { clearTimeout(peekTimer.current); peekTimer.current = setTimeout(() => setPeek(false), 300); };
  useEffect(() => { if (!folded) setPeek(false); }, [folded]);
  useEffect(() => {
    // ⌘B / Ctrl+B: fold or unfold (in fullscreen: show or hide it for a moment)
    const key = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'b') return;
      e.preventDefault();
      if (fs || playFold) setPeek((p) => !p);
      else setHidden(!railHidden);
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [fs, playFold, railHidden, setHidden]);
  const playing = !!session;
  useEffect(() => { window.sls?.setPlaying?.(playing); }, [playing]);
  fxBusy.current = playing || fs || boot || showOnboarding;
  const native = !!window.sls?.native;
  // The rail has no "Play" item: the game belongs to the section of what it plays – a run to SoulLink or Nuzlocke,
  // a game of the library (free play) to the library. That item carries the green "playing" light, and while the
  // game fills the page, it is the one marked as here.
  const sectionOf = (id) => {
    const r = id === manifest?.id ? manifest : status?.runs?.find((x) => x.id === id);
    return r ? runSection(r) : 'soullink';
  };
  const playingIn = session ? (session.target.runId ? sectionOf(session.target.runId) : 'library') : null;
  const here = route.route === 'handheld' ? 'settings' // (Settings › Play › Launch animation › Your handheld)
    : route.route !== 'play' ? route.route
    : showsSession && session ? playingIn : rp.run ? sectionOf(rp.run) : 'library';
  // souldew+ at the rail's foot says "thank you" to every member (supporter, souldew+, patron)
  const thanks = !!social.signedIn && (social.me?.entitlement?.tier || 'none') !== 'none';
  const NAV = [
    { id: 'library', label: t('nav.library', 'Library'), icon: 'library', accent: '#e0a458' },
    // the board's to-do count shows at the section of the open run
    { id: 'soullink', label: t('nav.soullink', 'SoulLink'), icon: 'link', count: manifest && runSection(manifest) === 'soullink' ? warnCount : 0, accent: '#d77fc6' },
    { id: 'nuzlocke', label: t('nav.nuzlocke', 'Nuzlocke'), icon: 'nuzlocke', count: manifest && runMode(manifest) === 'nuzlocke' ? warnCount : 0, accent: '#e8735f' },
    { id: 'link', label: t('nav.link', 'Connection'), icon: 'signal', accent: '#6f9bff' },
    // signed in only: the souldew account's friends (green: how many are online; the badge: requests and invites)
    ...(social.signedIn ? [{ id: 'friends', label: t('nav.friends', 'Friends'), icon: 'friends', accent: '#6fb39b', online: social.online, count: social.toAnswer, countHint: t('nav.friendsHint', 'Friend requests and invites') }] : []),
    { id: 'stream', label: t('nav.stream', 'Stream'), icon: 'stream', accent: '#ff5b6e', onAir: streamer },
    { id: 'trophies', label: t('nav.trophies', 'Trophies'), icon: 'trophy', accent: '#e7c24f' },
    { id: 'settings', label: t('nav.settings', 'Settings'), icon: 'gear', accent: '#9a8ee6' },
    { id: 'guide', label: t('nav.guide', 'Help'), icon: 'help', accent: '#4fb8c4' },
  ];

  return html`<${Ctx.Provider} value=${ctx}>
    <div class=${`frame ${native ? 'app-native' : ''} ${folded ? 'rail-folded' : ''} ${folded && peek ? 'rail-peek' : ''}`}>
      ${native && html`<div class="titlebar-drag"></div>`}
      ${folded && html`<div class="rail-edge" aria-hidden="true" onPointerEnter=${peekIn} onPointerLeave=${peekOut}></div>`}
      ${folded && !fs && !playFold && !peek && html`<${RailPlus} float thanks=${thanks} here=${here === 'plus'} fx=${coffee.fx} onOpen=${coffee.clicked} />`}
      ${(railHidden || playFold) && !fs && !peek && html`<button class="rail-open no-drag" onClick=${() => (playFold ? setPeek(true) : setHidden(false))} title=${`${t('rail.show', 'Show the sidebar')} (${shortcut('Mod+B')})`} aria-label=${t('rail.show', 'Show the sidebar')}><${Icon} name="sidebar" size=${18} /></button>`}
      ${playFold && !fs && !peek && html`<${RailHint} />`}
      <aside class=${`rail ${native ? '' : 'web'} ${native ? 'drag' : ''}`} onPointerEnter=${folded ? peekIn : undefined} onPointerLeave=${folded ? peekOut : undefined}
        onfocusin=${folded ? peekIn : undefined} onfocusout=${folded ? (e) => { if (!e.currentTarget.contains(e.relatedTarget)) peekOut(); } : undefined}>
        <div class="brand no-drag"><${AppMark} size=${34} /><div class="name">souldew</div>
          ${streamer && html`<a href="#/stream" class="onair on brand-onair" title=${t('stream.onAirHint', 'Streamer mode is on – codes, keys, paths and spoilers are covered')}>${t('stream.live', 'LIVE')}</a>`}</div>
        ${!fs && html`<button class="rail-toggle no-drag" onClick=${() => setHidden(!railHidden)} title=${`${railHidden ? t('rail.pin', 'Keep the sidebar open') : t('rail.hide', 'Hide the sidebar')} (${shortcut('Mod+B')})`}
            aria-label=${railHidden ? t('rail.pin', 'Keep the sidebar open') : t('rail.hide', 'Hide the sidebar')} aria-pressed=${!railHidden}><${Icon} name="sidebar" size=${16} /></button>`}
        <nav class="nav no-drag" aria-label=${t('nav.aria', 'Sections')} onPointerOver=${navLight} onPointerMove=${navLight}>
          ${railGroups(new Set(NAV.map((n) => n.id))).map((ids, i) => html`${i > 0 && html`<hr class="nav-rule" />`}${ids.map((id) => NAV.find((n) => n.id === id)).map((n) => html`<${NavItem} key=${n.id} n=${n} here=${here} playingIn=${playingIn} session=${session} />`)}`)}
        </nav>
        <div class="rail-foot no-drag">
          <${FirstStepsPill} />
          ${native && html`<${UpdateBanner} />`}
          ${manifest && names && html`<${RailRun} manifest=${manifest} names=${names} me=${me} onlineSlots=${onlineSlots} linkStatus=${linkStatus} session=${session} navigate=${navigate} />`}
          ${social.signedIn && social.me && html`<a class="rail-me" href="#/profile" aria-current=${route.route === 'profile' && !route.params.id ? 'page' : undefined} title=${t('pf.yours', 'Your profile')}>
            <${Avatar} user=${social.me} size=${30} /><span class="stack-s" style="gap:0"><b class="ellipsis">${social.me.name}</b><span class="tiny ellipsis">${social.me.status || `@${social.me.handle || ''}`}</span></span></a>`}
          ${!social.signedIn && html`<${RailSignIn} toast=${toast} />`}
          <div class="nav rail-tools" onPointerOver=${navLight} onPointerMove=${navLight}>
            <${RailPlus} thanks=${thanks} here=${here === 'plus'} fx=${!folded || peek ? coffee.fx : null} onOpen=${coffee.clicked} />
            ${FOOT_SECTIONS.map((id) => NAV.find((n) => n.id === id)).map((n) => html`<a key=${n.id} href=${`#/${n.id}`} class=${`rail-icon ${here === n.id ? 'active' : ''}`}
              aria-current=${here === n.id ? 'page' : undefined} title=${n.label} aria-label=${n.label} style=${`--na:${n.accent}`}><${NavIcon} name=${n.icon} /></a>`)}
          </div>
        </div>
      </aside>
      <main class="main">
        <div class=${`main-inner ${session && showsSession ? 'under-session' : ''}`}><${Boundary} route=${route.route}><${View} /><//></div>
        ${session && html`<${Boundary} route="session"><${GameSession} key=${session.target.key + session.at} session=${session} mode=${showsSession ? 'full' : 'mini'} /><//>`}
        ${externalRun && html`<${Boundary} route="external"><${ExternalFeed} /><//>`}
        <div class="cards-dock"><${RpsCards} /><${TogetherCards} /><${RaidCards} /></div>
      </main>
    </div>
    ${showOnboarding && !boot && html`<${Onboarding} onDone=${() => navigate('library')} />`}
    ${showOnboarding && !boot && native && html`<div class="titlebar-drag onb-drag"></div>`}
    ${boot && html`<${BootScreen} sound=${soundOn.current} onDone=${() => setBoot(false)} />`}
    <${Modal} open=${!!pendingRun} onClose=${() => setPendingRun(null)} title=${t('play.lockTitle', 'Your game is still running')}
      footer=${html`<button class="btn ghost" onClick=${() => {
        setPendingRun(null);
        if (route.route === 'play') navigate('play', session?.target.params);
        // a board of the other run was asked for: back to the overview instead of waiting for a run that won't open
        else if (rp.run && rp.run !== runId) navigate(route.route);
      }}>${t('play.lockKeep', 'Keep playing')}</button>
        <button class="btn primary" onClick=${() => { const id = pendingRun.id; setPendingRun(null); lastRef.current.close(() => { endSession(); switchRun(id); }); }}>${t('play.lockSwitch', 'Close game & switch')}</button>`}>
      <p class="muted">${t('play.lockTextRun', '{game} belongs to the run that is open now. To open another run, close the game first – your progress is saved and it continues where you left off.', { game: session?.target.label || '' })}</p>
      ${pendingRun && unsavedProgress() && html`<p class="warning">${unsavedTexts(unsavedProgress()).text}</p>`}
    <//>
    <${Modal} open=${!!pendingClose} onClose=${() => setPendingClose(null)} title=${unsavedTexts(unsavedProgress()).title}
      footer=${html`<button class="btn ghost" onClick=${() => { const p = pendingClose; setPendingClose(null); lastRef.current.close(() => { endSession(); p?.after?.(); }); }}>${unsavedTexts().close}</button>
        <button class="btn primary" onClick=${() => { setPendingClose(null); if (session) navigate('play', session.target.params); }}>${t('unsaved.back', 'Back to the game')}</button>`}>
      <p class="muted">${unsavedTexts(unsavedProgress()).text}</p>
    <//>
    <${LicenseNag} open=${!!nag} launches=${nag?.launches} onClose=${() => setNag(null)} />
    <${WhatsNew} open=${whatsNew} onClose=${closeWhatsNew} />
    <${ThanksAsk} busy=${boot || playing || showOnboarding || whatsNew} />
    ${manifest && linkPlay && !playFold && html`<${LinkBar} />`}
    <${Toasts} toasts=${toasts} dismiss=${(id) => setToasts((ts) => ts.filter((x) => x.id !== id))} />
    <${TrophyToasts} items=${trophyToasts} navigate=${navigate} dismiss=${(key) => setTrophyToasts((ts) => ts.filter((x) => x.key !== key))} />
    <${DeathAlert} alert=${runOver ? null : deathAlert} onClose=${() => setDeathAlert(null)} />
    <${RunOverNotice} status=${restartOffer ? null : runOver} onClose=${() => setRunOver(null)} />
    <${RestartOffer} offer=${restartOffer} onClose=${() => { try { sessionStorage.setItem(`sl-restart-seen-${restartOffer?.id}`, '1'); } catch {} setRestartOffer(null); }} />
  <//>`;
}

document.addEventListener('keydown', groupArrowKeys);
render(html`<${App} />`, document.getElementById('app'));
