// "First steps": the tutorial after the welcome tour – a checklist from an empty app to the first linked catch.
// Each step ticks itself off from what the app sees (library, runs, live data) and has one button that leads there.
// Someone who only plays solo Nuzlockes has nobody to connect with: that step drops out for them.
// Shown on the start pages and as a pill in the side rail until every step is done or skipped – or until the player
// hides it (the card's "Hide", the pill's ×): then it is gone everywhere, remembered on this computer, and Settings ›
// General or Help › Getting started bring it back ("Show first steps again"). Every open step can be skipped, so nobody
// is stuck with a step that doesn't fit how they play.
import { html, useState, useEffect } from '/vendor/htm-preact.mjs';
import { useApp } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t } from '../lib/i18n.mjs';
import { slotsOf, runMode, runSection } from '/shared/slots.mjs';

const HIDE_KEY = 'sl-firststeps-hidden';
const SKIP_KEY = 'sl-firststeps-skipped';
const CHANGE_EVENT = 'sl-firststeps-change';
const OPEN_EVENT = 'sl-firststeps-open';

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function write(key, v) {
  try {
    if (v == null || v === false || (Array.isArray(v) && !v.length)) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // storage blocked – it just shows again next time
  }
  dispatchEvent(new Event(CHANGE_EVENT));
}
const readHidden = () => read(HIDE_KEY, false) === true || read(HIDE_KEY, false) === 1;
const readSkipped = () => {
  const v = read(SKIP_KEY, []);
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
};

/** Hide the first steps everywhere (card and rail pill) – remembered on this computer. */
export function hideFirstSteps() {
  write(HIDE_KEY, true);
}
/** "Show first steps again" (Settings, Help): shown again, with every skipped step back in the list. */
export function showFirstSteps() {
  write(HIDE_KEY, false);
  write(SKIP_KEY, []);
  setTimeout(() => dispatchEvent(new Event(OPEN_EVENT)), 0);
}
export function skipFirstStep(id) {
  write(SKIP_KEY, [...new Set([...readSkipped(), id])]);
}

/** { hidden, skipped } – and re-renders when the card, the pill, Settings or Help change it */
export function useFirstStepsPrefs() {
  const [prefs, setPrefs] = useState(() => ({ hidden: readHidden(), skipped: readSkipped() }));
  useEffect(() => {
    const sync = () => setPrefs({ hidden: readHidden(), skipped: readSkipped() });
    addEventListener(CHANGE_EVENT, sync);
    addEventListener('storage', sync);
    return () => {
      removeEventListener(CHANGE_EVENT, sync);
      removeEventListener('storage', sync);
    };
  }, []);
  return prefs;
}

/**
 * The steps and whether each is done, from the app's state. `mode` 'nuzlocke': the solo path of the Nuzlocke
 * overview – no co-players to connect, only Nuzlocke runs count.
 */
export function useFirstSteps(mode) {
  const { library, status, partnerOnline, session, navigate } = useApp();
  const { hidden, skipped } = useFirstStepsPrefs();
  const nuzlocke = mode === 'nuzlocke';
  const runs = (status?.runs || []).filter((r) => !nuzlocke || runMode(r) === 'nuzlocke');
  const live = (r) => r.summary?.live || {};
  const soloOnly = nuzlocke || (runs.length > 0 && runs.every((r) => runMode(r) === 'nuzlocke'));
  const done = {
    game: (library?.roms?.length || 0) > 0,
    run: runs.length > 0,
    // joined somebody's run, or two players of one run have played
    partner: partnerOnline || runs.some((r) => runMode(r) !== 'nuzlocke' && (r.imported || slotsOf(r).filter((s) => live(r)[s]).length > 1)),
    play: !!session || runs.some((r) => Object.values(live(r)).some(Boolean)),
    catch: runs.some((r) => (r.summary?.caught || 0) > 0),
  };
  const firstRun = runs.find((r) => Object.keys(r.outputs || {}).length) || runs[0];
  // a run's board sits in the section of its mode (SoulLink or Nuzlocke)
  const toBoard = () => (firstRun ? navigate(runSection(firstRun), { run: firstRun.id }) : navigate('soullink'));
  const steps = [
    { id: 'game', title: t('fs.game', 'Add your game'), text: t('fs.gameText', 'Drop the ROM of a Pokémon game you own into the library (or pick a folder).'),
      action: t('fs.gameGo', 'Open the library'), go: () => navigate('library') },
    nuzlocke ? { id: 'run', title: t('fs.runSolo', 'Start a Nuzlocke'), text: t('fs.runSoloText', 'Pick your game, the rules (Classic, Hardcore or your own) and build – you play it on your own.'),
      action: t('runs.newSolo', 'New Nuzlocke'), go: () => navigate('nuzlocke', { new: '' }) }
    : { id: 'run', title: t('fs.runAny', 'Start a SoulLink (2–8) or a solo Nuzlocke – or join one'),
      text: t('fs.runTextNav', 'SoulLink (in the sidebar): one of you hosts (game, randomizer, rules), the others join with the 6-digit code. A Nuzlocke you start under “Nuzlocke” and play on your own.'),
      action: t('fs.runGoLink', 'SoulLink'), go: () => navigate('soullink'),
      alt: { action: t('fs.runGoSolo', 'Nuzlocke'), go: () => navigate('nuzlocke') } },
    { id: 'partner', title: t('fs.partner', 'Connect with your co-players'), text: t('fs.playersText', 'The host creates a code on the board (“Invite player”) and tells it to the others – their apps fetch the run once the host allows it.'),
      action: t('fs.playersGo', 'Invite players'), go: toBoard },
    { id: 'play', title: t('fs.play', 'Start the game'), text: soloOnly ? t('fs.playTextSoloNav', 'Press “Play” on the board or “Continue” in the overview. Your team shows up live on the board as soon as you have Pokémon.')
      : t('fs.playTextAllNav', 'Press “Play” on the board or “Continue” in the overview. Your team shows up live on everyone’s board as soon as you have Pokémon.'),
      action: t('fs.playGo', 'Play'), go: () => (firstRun ? navigate('play', { run: firstRun.id }) : navigate('play')) },
    soloOnly
      ? { id: 'catch', title: t('fs.catchSolo', 'Your first catch'), text: t('fs.catchSoloText', 'Catch the first Pokémon of an area – the app files it as that area’s encounter.'),
        action: t('fs.catchGo', 'To the board'), go: toBoard }
      : { id: 'catch', title: t('fs.catch', 'Your first linked catch'), text: t('fs.catchTextAll', 'Catch the first Pokémon of an area – the app files it, and the others’ catches there are linked to it.'),
        action: t('fs.catchGo', 'To the board'), go: toBoard },
  ].filter((s) => !(soloOnly && s.id === 'partner')).map((s) => ({ ...s, done: done[s.id], skipped: !done[s.id] && skipped.includes(s.id) }));
  const settled = (s) => s.done || s.skipped;
  return { steps, soloOnly, count: steps.filter(settled).length, complete: steps.every(settled), hidden };
}

/** The checklist card at the top of the start pages. */
export function FirstSteps({ mode } = {}) {
  const { toast } = useApp();
  const { steps, soloOnly, count, complete, hidden } = useFirstSteps(mode);
  const [, open] = useState(0);
  useEffect(() => {
    const show = () => open((n) => n + 1);
    addEventListener(OPEN_EVENT, show);
    return () => removeEventListener(OPEN_EVENT, show);
  }, []);
  if (hidden || complete) return null;
  const next = steps.find((s) => !s.done && !s.skipped);
  const hide = () => {
    hideFirstSteps();
    toast?.({ kind: 'ok', title: t('fs.hiddenToast', 'First steps hidden'), text: t('fs.hiddenText', 'Settings or Help bring them back.') });
  };
  return html`<section class="panel first-steps" aria-label=${t('fs.title', 'First steps')}>
    <div class="fs-head">
      <div><h2>${t('fs.title', 'First steps')}</h2><p class="small muted">${soloOnly ? t('fs.leadSolo', 'From zero to your first catch – {done} of {all} done.', { done: count, all: steps.length })
        : t('fs.lead', 'From zero to your first linked catch – {done} of {all} done.', { done: count, all: steps.length })}</p></div>
      <div class="fs-bar" role="progressbar" aria-valuemin="0" aria-valuemax=${steps.length} aria-valuenow=${count}><i style=${`width:${(count / steps.length) * 100}%`}></i></div>
      <button class="btn small ghost fs-hide" onClick=${hide} title=${t('fs.hideHint', 'Hide the first steps here and in the sidebar – Settings or Help bring them back')}>
        <${Icon} name="close" size=${14} />${t('fs.hide', 'Hide')}</button>
    </div>
    <ol class="fs-list">
      ${steps.map((s, i) => html`<li class=${`fs-step ${s.done ? 'done' : ''} ${s.skipped ? 'skipped' : ''} ${s === next ? 'next' : ''}`}>
        <span class="fs-num" aria-hidden="true">${s.done ? html`<${Icon} name="check" size=${12} />` : s.skipped ? '–' : i + 1}</span>
        <div class="fs-body"><b>${s.title}</b>${s === next && html`<span class="small muted">${s.text}</span>`}${s.skipped && html`<span class="small faint">${t('fs.skippedNote', 'Skipped')}</span>`}</div>
        ${s === next && html`<div class="fs-actions"><button class="btn small primary" onClick=${s.go}>${s.action}</button>
          ${s.alt && html`<button class="btn small" onClick=${s.alt.go}>${s.alt.action}</button>`}
          <button class="btn small ghost" onClick=${() => skipFirstStep(s.id)} title=${t('fs.skipHint', 'Mark this step as done – it doesn’t fit how you play')}>${t('fs.skip', 'Skip')}</button></div>`}
        ${s.done && html`<span class="sr-only">${t('fs.doneSr', 'done')}</span>`}
      </li>`)}
    </ol>
  </section>`;
}

/** Side-rail pill: progress at a glance, a click brings the checklist up; its × hides the first steps everywhere. */
export function FirstStepsPill() {
  const { steps, count, complete, hidden } = useFirstSteps();
  const { navigate, toast } = useApp();
  if (complete || hidden) return null;
  return html`<div class="fs-pill-wrap no-drag">
    <button class="fs-pill" onClick=${() => { navigate('library'); setTimeout(() => dispatchEvent(new Event(OPEN_EVENT)), 0); }}
      title=${t('fs.pillHint', 'Show the first steps')}>
      <span class="fs-pill-ring" style=${`--p:${count / steps.length}`}></span>
      <span><b>${t('fs.title', 'First steps')}</b><span class="tiny muted">${t('fs.pillCount', '{done} of {all}', { done: count, all: steps.length })}</span></span>
    </button>
    <button class="fs-pill-x" onClick=${() => { hideFirstSteps(); toast?.({ kind: 'ok', title: t('fs.hiddenToast', 'First steps hidden'), text: t('fs.hiddenText', 'Settings or Help bring them back.') }); }}
      title=${t('fs.hideHint', 'Hide the first steps here and in the sidebar – Settings or Help bring them back')} aria-label=${t('fs.hideAria', 'Hide the first steps')}><${Icon} name="close" size=${12} /></button>
  </div>`;
}

/** Settings › General and Help: the way back once the first steps were hidden (or skipped through). */
export function ShowFirstStepsButton({ className = 'btn ghost small' } = {}) {
  const { navigate, toast } = useApp();
  const { hidden, skipped } = useFirstStepsPrefs();
  return html`<button class=${className} onClick=${() => {
    showFirstSteps();
    navigate('library');
    toast?.({ kind: 'ok', title: t('fs.shownToast', 'First steps are back'), text: t('fs.shownText', 'In the library and in the sidebar.') });
  }} disabled=${!hidden && !skipped.length} title=${!hidden && !skipped.length ? t('fs.notHidden', 'The first steps are showing') : undefined}>${t('fs.showAgain', 'Show first steps again')}</button>`;
}
