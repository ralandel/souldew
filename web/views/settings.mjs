// Settings: a tab per section (General, Play, Controls, Games, Online, Account, About) under a sticky bar with the settings search.
// The open tab is in the URL (#/settings?s=play – back and forward work) and remembered for next time; a deep link
// #/settings?s=play&f=turbo-audio brings one setting into view and marks it for a moment. Which setting lives in
// which section, and the words the search finds it by: lib/settingsindex.mjs. The sections: views/settings/*.mjs.
import { html, useState, useEffect, useLayoutEffect, useRef } from '/vendor/htm-preact.mjs';
import { useApp } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t, currentLang } from '../lib/i18n.mjs';
import { api } from '../lib/api.mjs';
import { shortcut } from '../lib/platform.mjs';
import { SETTINGS, VISIBLE_SECTIONS, searchSettings, settingsRoute, settingsLink, norm } from '../lib/settingsindex.mjs';
import { GeneralSection } from './settings/general.mjs';
import { PlaySection } from './settings/play.mjs';
import { ControlsSection } from './settings/controls.mjs';
import { GamesSection } from './settings/games.mjs';
import { OnlineSection } from './settings/online.mjs';
import { AboutSection } from './settings/about.mjs';
import { AccountSection } from './settings/account.mjs';

// what other screens use from here (the welcome tour, the play dock, the app's notices)
export { ThemePicker } from './settings/general.mjs';
export { usePads, FAMILY_NAMES, PAD_POS, padName } from './settings/controls.mjs';
export { GPU_LABELS, CTR_RENDERER_LABELS, gpuFallbackText } from './settings/about.mjs';
export { settingsLink };

const BODY = { general: GeneralSection, play: PlaySection, controls: ControlsSection, games: GamesSection, online: OnlineSection, account: AccountSection, about: AboutSection };

/** The tab names' i18n keys (the English one is searched too). */
const SECTION_KEYS = { general: 'set.general', play: 'set.tabPlay', controls: 'set.controls', games: 'set.tabGames', online: 'set.tabOnline', account: 'set.tabAccount', about: 'set.about' };

/** The tab names. */
export const SECTION_NAMES = () => ({
  general: t('set.general', 'General'), play: t('set.tabPlay', 'Play'), controls: t('set.controls', 'Controls'),
  games: t('set.tabGames', 'Games'), online: t('set.tabOnline', 'Online'), account: t('set.tabAccount', 'Account'), about: t('set.about', 'About'),
});

const TAB_KEY = 'sl-settings-tab';
const remembered = () => {
  try {
    return localStorage.getItem(TAB_KEY);
  } catch {
    return null;
  }
};
const remember = (id) => {
  try {
    localStorage.setItem(TAB_KEY, id);
  } catch {
    // private mode
  }
};

// The English texts, for searching English words in another app language (loaded on the first search).
let english = null;
const loadEnglish = () => (english ? Promise.resolve(english) : fetch('/i18n/en.json').then((r) => r.json()).then((d) => (english = d)).catch(() => ({})));

/** An item's own text (what it shows, without the settings nested in it – those are searched on their own). */
function ownText(el) {
  let s = '';
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.parentElement.closest('.set-item') === el) s += ` ${n.data}`;
  return s;
}

/** Lower case without accents, one character for one – so a hit's position is its position in the shown text. */
const foldSameLength = (s) => Array.from(s.split(''), (c) => {
  const f = c.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  return f.length === 1 ? f : c;
}).join('');

/**
 * Filter the rendered settings down to the hits and mark the words (CSS Highlight API). Returns the hits per
 * section in tab order: [{ section, ids }].
 */
function applySearch(root, query, texts) {
  const items = [...root.querySelectorAll('.set-item[data-set]')];
  const byId = new Map(items.map((el) => [el.dataset.set, el]));
  const hits = searchSettings(query, texts, { available: (id) => byId.has(id), extra: (id) => ownText(byId.get(id)) });
  const on = new Set(hits.flatMap((h) => h.ids));
  const searching = !!norm(query);
  for (const el of items) el.classList.toggle('set-miss', searching && !on.has(el.dataset.set) && ![...el.querySelectorAll('.set-item')].some((x) => on.has(x.dataset.set)));
  root.querySelectorAll('.set-group').forEach((g) => g.classList.toggle('set-miss', searching && !g.querySelector('.set-item:not(.set-miss)')));
  if (window.CSS?.highlights) {
    const ranges = [];
    const words = norm(query).split(' ').filter(Boolean);
    if (words.length) {
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walk.nextNode(); node; node = walk.nextNode()) {
        const p = node.parentElement;
        if (!p.closest('.set-item') || p.closest('.set-miss, .set-off, option, select, textarea')) continue;
        const text = foldSameLength(node.data);
        for (const w of words) {
          for (let i = text.indexOf(w); i >= 0; i = text.indexOf(w, i + w.length)) {
            const r = new Range();
            r.setStart(node, i);
            r.setEnd(node, i + w.length);
            ranges.push(r);
          }
        }
      }
    }
    CSS.highlights.set('set-hit', new window.Highlight(...ranges));
  }
  return hits;
}

function SearchBox({ value, onInput, inputRef, total, onEnter }) {
  const label = t('set.search', 'Search settings');
  return html`<label class="set-search" role="search">
    <${Icon} name="search" size=${16} />
    <input ref=${inputRef} type="search" value=${value} placeholder=${label} aria-label=${label} spellcheck="false" autocomplete="off"
      onInput=${(e) => onInput(e.target.value)}
      onKeyDown=${(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          e.preventDefault();
          if (value) onInput('');
          else e.target.blur();
        }
        if (e.key === 'Enter') onEnter();
      }} />
    ${value.trim() ? html`<span class="set-count tiny" role="status">${total === 0 ? t('set.foundNone', 'nothing found') : t('set.found', '{n} found', { n: total })}</span>`
      : html`<kbd class="set-key" aria-hidden="true">${shortcut('Mod+F', { space: true })}</kbd>`}
  </label>`;
}

export function SettingsView() {
  const { status, reloadStatus, toast, library, reloadLibrary, route, navigate } = useApp();
  const cfg = status?.config || {};
  const { section, setting } = settingsRoute(route.params, remembered());
  const names = SECTION_NAMES();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState([]);
  const [en, setEn] = useState(english);
  const [busy, setBusy] = useState(null);
  const root = useRef(null);
  const input = useRef(null);
  const searching = !!norm(query);

  const save = async (patch) => {
    try {
      await api.post('/api/config', patch);
    } catch (e) {
      toast({ kind: 'death', title: t('set.saveFailed', 'Couldn’t save the setting'), text: e.message });
    }
    await reloadStatus(); // also puts a failed change back on screen
  };
  const folders = async (body) => {
    try {
      await api.post('/api/library/folders', body);
    } catch (e) {
      toast({ kind: 'death', title: t('set.library', 'Library'), text: e.message });
    }
    await reloadStatus();
    await reloadLibrary();
  };
  const install = async (id) => {
    setBusy(id);
    try {
      await api.post(`/api/emulators/${id}/install`);
      await reloadStatus();
      toast({ kind: 'ok', title: status.emulators[id].name, text: t('set.installed', 'Installed') });
    } catch (e) {
      toast({ kind: 'death', title: status.emulators[id].name, text: e.message });
    }
    setBusy(null);
  };
  const ctx = { cfg, status, save, toast, reloadStatus, library, folders, install, busy };
  const go = (s, f) => {
    setQuery('');
    navigate('settings', { s, f });
  };

  useEffect(() => remember(section), [section]);

  // search: filter and mark after every render that could change what matches (a setting that appears, the language …)
  useLayoutEffect(() => {
    if (!root.current) return;
    const keys = [...new Set(SETTINGS.flatMap((e) => e.keys))];
    const texts = en ? {
      english: en,
      local: currentLang() === 'en' ? {} : Object.fromEntries(keys.map((k) => [k, t(k, en[k] || '')])),
      sectionName: (id) => [en[SECTION_KEYS[id]], names[id]],
    } : { sectionName: (id) => [names[id]] };
    const h = applySearch(root.current, query, texts);
    if (JSON.stringify(h) !== JSON.stringify(hits)) setHits(h);
  });
  useEffect(() => () => window.CSS?.highlights?.delete('set-hit'), []);
  useEffect(() => {
    if (searching && !en) loadEnglish().then(setEn);
  }, [searching]);

  // ⌘F / Ctrl+F: into the search
  useEffect(() => {
    const key = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'f') return;
      e.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, []);

  // a new tab starts at the top; a deep link brings its setting into view, marks it and puts the focus on it
  const first = useRef(true);
  useEffect(() => {
    const wasFirst = first.current;
    first.current = false;
    if (!setting) {
      if (!wasFirst) {
        document.querySelector('.main')?.scrollTo({ top: 0 });
        if (document.scrollingElement?.scrollTop) document.scrollingElement.scrollTo({ top: 0 });
      }
      return undefined;
    }
    setQuery('');
    let timer = 0;
    let el = null;
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => {
      el = document.getElementById(`set-${setting}`);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.classList.remove('set-flash');
      void el.offsetWidth; // restart the animation
      el.classList.add('set-flash');
      timer = setTimeout(() => el.classList.remove('set-flash'), 2000);
      const target = el.querySelector('input:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])');
      target?.focus({ preventScroll: true });
    }));
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      el?.classList.remove('set-flash'); // or it plays again whenever its tab is shown again
    };
  }, [section, setting]);

  const counts = Object.fromEntries(hits.map((h) => [h.section, h.ids.length]));
  const total = hits.reduce((n, h) => n + h.ids.length, 0);
  const openFirst = () => {
    if (hits[0]) go(hits[0].section, hits[0].ids[0]);
  };
  const shown = (id) => (searching ? counts[id] > 0 : id === section);

  return html`<div class=${`settings ${searching ? 'set-searching' : ''}`}>
    <div class="topbar"><h1>${t('nav.settings', 'Settings')}</h1></div>
    <div class="set-bar">
      <div class="tabs set-tabs" role="tablist" aria-label=${t('nav.settings', 'Settings')} data-pad-tabs>
        ${VISIBLE_SECTIONS.map((id) => {
          const on = !searching && id === section;
          return html`<button type="button" role="tab" id=${`set-tab-${id}`} aria-controls=${`set-panel-${id}`} aria-selected=${on}
            class=${`${on ? 'on' : ''} ${searching && !counts[id] ? 'dim' : ''}`} onClick=${() => go(id)}>${names[id]}${searching && counts[id] > 0
              ? html`<span class="set-n" title=${t('set.found', '{n} found', { n: counts[id] })}>${counts[id]}</span>` : ''}</button>`;
        })}
      </div>
      <${SearchBox} value=${query} onInput=${setQuery} inputRef=${input} total=${total} onEnter=${openFirst} />
    </div>
    <div class="set-content" ref=${root}>
      ${VISIBLE_SECTIONS.map((id) => {
        const Body = BODY[id];
        return html`<div key=${id} class=${`set-sec ${shown(id) ? '' : 'set-off'}`} role="tabpanel" id=${`set-panel-${id}`} aria-labelledby=${`set-tab-${id}`} data-sec=${id}>
          ${searching && html`<div class="set-sec-head">
            <h2 class="set-sec-title">${names[id]}</h2>
            <button class="btn small ghost" onClick=${() => go(id)}>${t('set.openSection', 'Open {name}', { name: names[id] })}</button>
          </div>`}
          <div class="stack-l"><${Body} ...${ctx} /></div>
        </div>`;
      })}
      ${searching && total === 0 && html`<div class="panel set-empty stack-s" role="status">
        <b>${t('set.emptyTitle', 'No setting matches “{q}”', { q: query.trim() })}</b>
        <span class="small muted">${t('set.emptyText', 'Try a shorter word – for example turbo, controller, language or Discord.')}</span>
      </div>`}
    </div>
  </div>`;
}
