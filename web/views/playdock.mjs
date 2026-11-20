// The dock of the big play view (views/play.mjs): everything about the game next to it, in one place – right of a tall
// picture, under a wide one (lib/playlayout.mjs decides). On the right its sections sit on top of each other (title and
// place, battle helper, team / linked groups, the partners' games); at the bottom side by side. Nothing of it ever
// covers the game and nothing hides by itself: the player folds it to a slim strip (button, ⌘I / Ctrl+I – remembered
// on this computer), the strip still shows what matters (a battle, the level cap, who is online) and brings it back.
// Also here: the "something happened" card over the top of the game (useAttention) and the compact notice that this
// computer can't keep full speed (SlowChip), and the one that the 3DS resolution holds back fast-forward (FfScaleChip).
import { html, useState, useEffect, useRef, useCallback } from '/vendor/htm-preact.mjs';
import { useApp, Led } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t, ago } from '../lib/i18n.mjs';
import { shortcut } from '../lib/platform.mjs';
import { live } from '../lib/run.mjs';
import { GPU_LABELS } from './settings/about.mjs';
import { settingsLink } from '../lib/settingsindex.mjs';
import { initials } from '../lib/playlayout.mjs';

const FOLD_KEY = 'sl-dock-folded';

/** [folded, setFolded] – the dock folded to its strip, remembered on this computer. */
export function useDockFold() {
  const [folded, set] = useState(() => {
    try {
      return localStorage.getItem(FOLD_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setFolded = useCallback((v) => set((prev) => {
    const next = typeof v === 'function' ? v(prev) : !!v;
    try {
      localStorage.setItem(FOLD_KEY, next ? '1' : '0');
    } catch {
      // private mode: this session only
    }
    return next;
  }), []);
  return [folded, setFolded];
}

/** { w, h } of an element, kept up to date (null until it is measured). */
export function useSize(ref) {
  const [size, setSize] = useState(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const m = () => {
      const w = Math.round(el.clientWidth);
      const h = Math.round(el.clientHeight);
      setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }));
    };
    m();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(m) : null;
    ro?.observe(el);
    addEventListener('resize', m);
    return () => {
      ro?.disconnect();
      removeEventListener('resize', m);
    };
  }, []);
  return size;
}

/** Scrolls a dock section (and an item in it, data-area) into view and lets it light up for a moment. */
export function revealIn(root, id, area = null) {
  const sec = root?.querySelector(`[data-dock="${id}"]`);
  if (!sec) return;
  const item = area ? sec.querySelector(`[data-area="${CSS.escape(area)}"]`) : null;
  const target = item || sec;
  target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  target.classList.remove('dock-flash');
  void target.offsetWidth; // restart the animation
  target.classList.add('dock-flash');
  setTimeout(() => target.classList.remove('dock-flash'), 1800);
}

/**
 * The dock.
 *   side     – 'right' | 'bottom'
 *   folded   – only the strip; onFold(bool) folds / unfolds
 *   head     – title row (name, save age, Board, Close)
 *   sections – [{ id, label, icon, node, dot }] in order; dot: '' | 'live' | 'warn' | 'bad' – also shown on the strip
 *   who      – [{ slot, name, on }] the partners, as initials on the strip
 *   dockRef  – the element, for revealIn
 *   wide     – the right dock has room for a second column (the partners)
 */
export function Dock({ side, folded, onFold, head, sections, who = [], dockRef, wide = false }) {
  const foldLabel = t('dock.fold', 'Fold the panel');
  const openLabel = t('dock.unfold', 'Show the panel');
  const key = shortcut('Mod+I');
  const shown = sections.filter((s) => s && s.node);
  if (folded) {
    const open = (id) => {
      onFold(false);
      requestAnimationFrame(() => requestAnimationFrame(() => revealIn(dockRef.current, id)));
    };
    const marks = initials(who.map((p) => p.name || p.slot));
    return html`<nav class=${`dock folded ${side}`} ref=${dockRef} aria-label=${t('dock.title', 'Game panel')}>
      <button class="dock-btn dock-unfold" title=${`${openLabel} (${key})`} aria-label=${openLabel} aria-expanded="false" onClick=${() => onFold(false)}>
        <${Icon} name=${side === 'bottom' ? 'chevUp' : 'panelRight'} size=${18} /></button>
      <span class="dock-sep" aria-hidden="true"></span>
      ${shown.map((s) => html`<button class=${`dock-btn ${s.dot ? `dot-${s.dot}` : ''}`} key=${s.id} title=${s.label} aria-label=${s.label} onClick=${() => open(s.id)}>
        <${Icon} name=${s.icon} size=${18} /></button>`)}
      ${who.length > 0 && html`<span class="dock-sep" aria-hidden="true"></span>`}
      ${who.map((p, i) => html`<button class=${`dock-who who-${p.slot} ${p.on ? 'on' : ''}`} key=${p.slot} title=${p.name} aria-label=${p.name} onClick=${() => open('partners')}>
        ${marks[i]}</button>`)}
    </nav>`;
  }
  const headEl = html`<div class="dock-head">${head}
    <button class="btn icon ghost dock-fold" title=${`${foldLabel} (${key})`} aria-label=${foldLabel} aria-expanded="true" onClick=${() => onFold(true)}>
      <${Icon} name=${side === 'bottom' ? 'chevDown' : 'panelRight'} size=${16} /></button></div>`;
  const sec = (s, i) => html`<section class=${`dock-sec ${s.id}`} key=${s.id} data-dock=${s.id} aria-label=${s.label}>
      ${side === 'bottom' && i === 0 && headEl}
      ${s.node}
    </section>`;
  // wide (spare room next to a tall picture): the partners' games get a column of their own
  if (wide && side === 'right') {
    return html`<aside class="dock right wide" ref=${dockRef} aria-label=${t('dock.title', 'Game panel')}>
      <div class="dock-col">${headEl}${shown.filter((s) => s.id !== 'partners').map(sec)}</div>
      <div class="dock-col side">${shown.filter((s) => s.id === 'partners').map(sec)}</div>
    </aside>`;
  }
  return html`<aside class=${`dock ${side}`} ref=${dockRef} aria-label=${t('dock.title', 'Game panel')}>
    ${side === 'right' && headEl}
    ${shown.map(sec)}
  </aside>`;
}

/**
 * Who is playing and whether live tracking found the team: your line first, the partners as chips under it (they wrap,
 * so four names never squeeze the status to one word per line); `extra` at its end (the Shared World switch). A link
 * session's bar has a dock section of its own (views/linkplay.mjs LinkBar inline).
 */
export function LiveStatus({ status, phase, names, me, others, extra = null }) {
  const { onlineSlots, doc } = useApp();
  const text = status === 'live' ? (names ? t('play.liveOn', 'Live tracking') : t('board.liveNow', 'live'))
    : status === 'unsupported' ? t('play.liveUnsupported', 'No live data for this game')
      : status === 'hack' ? t('play.liveHack', 'Not supported for this hack yet') : t('play.liveSearching', 'Looking for your team …');
  return html`<div class="live-status" data-hook="link-status">
    <div class="live-me"><${Led} on=${status === 'live'} color="green" blink=${status === 'searching' && phase === 'running'} />
      <b class="px">${names ? names[me]?.name : t('play.liveOn', 'Live tracking')}</b><span class="tiny faint grow">${text}</span></div>
    ${names && others.length > 0 && html`<div class="live-others">${others.map((s) => {
      const on = !!onlineSlots?.has(s);
      const seen = doc ? live(doc, s) : null;
      return html`<span class="live-who" key=${s} title=${on ? t('board.liveNow', 'live') : seen ? ago(seen.at) : t('board.offline', 'offline')}>
        <${Led} on=${on} color="green" /><b class=${`px who-${s}`}>${names[s]?.name || s.toUpperCase()}</b>
        ${others.length === 1 && html`<span class="tiny faint">${on ? t('board.liveNow', 'live') : seen ? ago(seen.at) : t('board.offline', 'offline')}</span>`}</span>`;
    })}</div>`}
    ${extra}
  </div>`;
}

// ---- "something happened": a card over the top of the game -----------------------------------------------------------

const TTL = { death: 12000, catch: 7000, cap: 9000, battle: 6000 };

/**
 * The attention card's queue: show(item) puts { kind, title, text, section, area } up (a death or a catch replaces
 * whatever is there, a battle never replaces something more important); it leaves by itself after a while – not while
 * the pointer is on it.
 */
export function useAttention() {
  const [item, setItem] = useState(null);
  const timer = useRef(0);
  const held = useRef(false);
  const left = useRef(0);
  const arm = (ms) => {
    clearTimeout(timer.current);
    left.current = ms;
    timer.current = setTimeout(() => setItem(null), ms);
  };
  const rank = { death: 3, cap: 2, catch: 2, battle: 1 };
  const show = useCallback((next) => {
    setItem((cur) => {
      if (cur && (rank[cur.kind] || 0) > (rank[next.kind] || 0)) return cur;
      arm(TTL[next.kind] || 7000);
      return { ...next, id: `${next.kind}:${Date.now()}` };
    });
  }, []);
  const close = useCallback(() => {
    clearTimeout(timer.current);
    setItem(null);
  }, []);
  const hold = (on) => {
    if (on === held.current) return;
    held.current = on;
    if (on) clearTimeout(timer.current);
    else arm(Math.max(2500, left.current / 2));
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return { item, show, close, hold };
}

const ATTN_ICON = { death: 'grave', catch: 'ball', cap: 'badge', battle: 'bolt' };

/** The card itself: what happened, "Show" (unfolds the dock at the right place) and close. Never takes the focus. */
export function AttentionCard({ attn, onShow }) {
  const { item, close, hold } = attn;
  if (!item) return null;
  return html`<div class=${`attn ${item.kind}`} key=${item.id} role="status" aria-live="polite" onMouseEnter=${() => hold(true)} onMouseLeave=${() => hold(false)}
    onMouseDown=${(e) => e.preventDefault()}>
    <span class="attn-ico" aria-hidden="true"><${Icon} name=${ATTN_ICON[item.kind] || 'bell'} size=${18} /></span>
    <div class="attn-text"><b>${item.title}</b>${item.text && html`<span>${item.text}</span>`}</div>
    ${item.section && html`<button class="btn small ghost attn-show" onClick=${() => { onShow(item); close(); }}>${t('attn.show', 'Show')}</button>`}
    <button class="ps-btn attn-x" title=${t('common.close', 'Close')} aria-label=${t('common.close', 'Close')} onClick=${close}><${Icon} name="close" size=${12} /></button>
    <i class="attn-time" style=${`animation-duration:${TTL[item.kind] || 7000}ms`} aria-hidden="true"></i>
  </div>`;
}

// ---- this computer can't keep full speed ------------------------------------------------------------------------------

/**
 * The game runs clearly below full speed at 1× on this computer (lib/slowdown.mjs): a small chip in the dock with how
 * fast it really runs; "Why?" opens what causes it and what helps – the fast player, the melonDS app for DS games,
 * another graphics backend, power settings. Closable.
 */
/** The chip's details pop: open / closed, closing on a click outside or Esc. */
function usePop() {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => !wrap.current?.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    addEventListener('pointerdown', away);
    addEventListener('keydown', esc);
    return () => {
      removeEventListener('pointerdown', away);
      removeEventListener('keydown', esc);
    };
  }, [open]);
  return [open, setOpen, wrap];
}

/**
 * A 3DS game drawn at 2× or 3× whose fast-forward stays clearly below the speed asked for (lib/ffhint.mjs, ticket #30):
 * the same compact chip as SlowChip, once per app session. "Open Settings" goes to Settings › Play › 3DS resolution;
 * nothing is changed by itself. `hint`: { target, reached, scale }.
 */
export function FfScaleChip({ hint, onClose, onNever }) {
  const { navigate } = useApp();
  const [open, setOpen, wrap] = usePop();
  const title = t('play.ffScaleTitle', 'Fast-forward is held back by the 3DS resolution');
  return html`<div class="slow-chip-wrap" ref=${wrap}>
    <div class="slow-chip" role="status">
      <${Icon} name="signal" size=${14} />
      <button class="slow-chip-main" aria-expanded=${open} aria-haspopup="dialog" title=${title}
        onClick=${() => setOpen(!open)}>${t('play.ffScaleShort', 'Fast-forward ≈{n}× of {set}×', { n: hint.reached, set: hint.target })} · <u>${t('play.slowWhyShort', 'Why?')}</u></button>
      <button class="ps-btn" title=${t('common.close', 'Close')} aria-label=${t('common.close', 'Close')} onClick=${onClose}><${Icon} name="close" size=${12} /></button>
    </div>
    ${open && html`<div class="note slow-note slow-pop" role="dialog" aria-label=${title}>
      <b>${title}</b>
      <span class="small">${t('play.ffScaleWhy', 'This game is drawn at {scale}× resolution, and in fast-forward every frame costs the graphics card that much more: it reaches about {n}× instead of {set}×. Lower the resolution in Settings › Play › 3DS resolution for faster fast-forward – it applies the next time you start the game.', { scale: hint.scale, n: hint.reached, set: hint.target })}</span>
      <div class="row"><button class="btn small" onClick=${() => navigate('settings', settingsLink('ctr-scale'))}><${Icon} name="gear" size=${14} />${t('play.slowSettings', 'Open Settings')}</button>
        <button class="btn small ghost" data-pad-back onClick=${() => { setOpen(false); onClose(); }}>${t('play.slowOk', 'Got it')}</button>
        <button class="btn small ghost" onClick=${() => { setOpen(false); onNever(); }}>${t('play.ffScaleNever', 'Don’t show again')}</button></div>
    </div>`}
  </div>`;
}

export function SlowChip({ slow, isDs, native, onClose }) {
  const { navigate, status } = useApp();
  const [open, setOpen, wrap] = usePop();
  const backend = GPU_LABELS()[status?.config?.gpuBackend || 'auto'] || status?.config?.gpuBackend;
  const melon = status?.emulators?.melonds;
  const tip = {
    native: t('play.slowNative', 'Turn on the fast player (Settings › Play): it runs this game with the real emulator directly on your computer – far faster, and live sync stays.'),
    external: melon?.installed
      ? t('play.slowExternalReady', 'Play with the melonDS app (installed): it runs DS games at full speed on much weaker computers. Pick it under Settings › Games – your run syncs on every in-game save.')
      : t('play.slowExternal', 'Play with the melonDS app: it runs DS games at full speed on much weaker computers. Settings › Games installs it with one click – your run syncs on every in-game save.'),
    graphics: t('play.slowGraphics', 'Try another graphics backend in Settings › About › Troubleshooting (now: {backend}) – on some PCs the emulator only runs smoothly with one of them.', { backend }),
    power: t('play.slowPower', 'On a laptop: plug it in and choose the best-performance power mode. Close other programs that keep the computer busy.'),
  };
  // "Open Settings" opens the setting of the first tip that has one
  const place = { native: 'native', external: melon?.installed ? 'emulator-for' : 'install', graphics: 'gpu' }[slow.tips.find((k) => ['native', 'external', 'graphics'].includes(k))];
  const pct = Math.round((slow.reached || 0) * 100);
  return html`<div class="slow-chip-wrap" ref=${wrap}>
    <div class="slow-chip" role="status">
      <${Icon} name="signal" size=${14} />
      <button class="slow-chip-main" aria-expanded=${open} aria-haspopup="dialog" title=${t('play.slowTitle', 'This computer runs the game at only about {pct} % of its speed', { pct })}
        onClick=${() => setOpen(!open)}>${t('play.slowShort', 'Runs at {pct} % speed', { pct })} · <u>${t('play.slowWhyShort', 'Why?')}</u></button>
      <button class="ps-btn" title=${t('common.close', 'Close')} aria-label=${t('common.close', 'Close')} onClick=${onClose}><${Icon} name="close" size=${12} /></button>
    </div>
    ${open && html`<div class="note slow-note slow-pop" role="dialog" aria-label=${t('play.slowTitle', 'This computer runs the game at only about {pct} % of its speed', { pct })}>
      <b>${t('play.slowTitle', 'This computer runs the game at only about {pct} % of its speed', { pct })}</b>
      <span class="small">${native ? t('play.slowWhyNative', 'That’s why it stutters and the sound crackles. The game already runs in the fast player – here your computer is the limit, not a setting.') : isDs ? t('play.slowWhyDs', 'That’s why it stutters and the sound crackles. The built-in emulator runs the whole DS on one processor core and can’t go faster here – your computer is the limit, not a setting.')
        : t('play.slowWhy', 'That’s why it stutters and the sound crackles. The built-in emulator runs the console on one processor core and can’t go faster here.')}</span>
      <ul class="small slow-tips">${slow.tips.map((k) => html`<li key=${k}>${tip[k]}</li>`)}</ul>
      <div class="row">${place && html`<button class="btn small" onClick=${() => navigate('settings', settingsLink(place))}><${Icon} name="gear" size=${14} />${t('play.slowSettings', 'Open Settings')}</button>`}
        <button class="btn small ghost" data-pad-back onClick=${() => { setOpen(false); onClose(); }}>${t('play.slowOk', 'Got it')}</button></div>
    </div>`}
  </div>`;
}
