// Partner screens: the other players' games, live, while you play. Each partner is a tile in the play view's dock
// (views/playdock.mjs) – two players: one tile, three or four: one per partner at once. A tile can be popped out into a
// window over the play area: it moves by its header and resizes from its corner grip (the picture keeps its aspect),
// snaps lightly to the edges and to the other windows, never leaves the play area and never covers the game bar, and
// is remembered per run and partner on this computer (popped out or not, position, size). "Back to the panel" docks it
// again. The layout math lives in lib/pslayout.mjs.
//
// Picture transport lives in SyncLink (lib/sync.mjs): WebRTC video when the direct link to that partner is up, small
// encrypted stills every ~1.5 s over the relay otherwise. Only shown pictures watch – a folded dock costs nothing, as
// does the game in the corner (this view isn't there then).
//
// Nothing here takes the keyboard or the controller from the game: presses keep the focus in the game frame
// (keepFocus) and the windows are plain page content, not dialogs – the controller reaches their buttons only when
// it is the app's anyway (lib/padnav.mjs: game paused, a menu open …).
import { html, useState, useEffect, useLayoutEffect, useRef, useCallback } from '/vendor/htm-preact.mjs';
import { useApp } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t } from '../lib/i18n.mjs';
import { othersOf, players as getPlayers } from '../lib/run.mjs';
import {
  arOf, defaultWidth, snapRect, resizeRect, resizeAnchored, gripSide, toStored, fromStored, cornerLayout, avoidRect,
  runLayout, winState, updateRun,
} from '../lib/pslayout.mjs';
import { tileColumns } from '../lib/playlayout.mjs';
import { rpsFor } from '../lib/worldrps.mjs';
import { artUrl } from '../lib/worldart.mjs';
import { keepable, pictureLayers } from '../lib/pshold.mjs';

const PREF = 'sl-partnerscreen'; // per computer – see lib/pslayout.mjs (runLayout)
const STALE_MS = 20000; // a still picture older than this means the partner stopped sending

function loadPref() {
  try {
    const p = JSON.parse(localStorage.getItem(PREF) || '{}');
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {};
  }
}

function savePref(p) {
  try {
    localStorage.setItem(PREF, JSON.stringify(p));
  } catch {
    // private mode
  }
}

/** Screen source for SyncLink.startScreenShare() backed by the emulator iframe's window.__emu. */
export function emuScreenSource(getEmu, system) {
  const emu = () => {
    try {
      const e = getEmu?.();
      return e?.ready ? e : null;
    } catch {
      return null; // iframe navigated away
    }
  };
  return {
    system,
    getStream: () => emu()?.captureStream?.(15) || null,
    getSnapshot: (opts) => emu()?.snapshot?.(opts) || null,
    isActive: () => !!emu(),
    // paused (the pause button, Shared World's A menu, rock-paper-scissors): the picture stands still but stays
    isPaused: () => !!emu()?.paused?.(),
  };
}

/** Shares our game picture with the partners while `enabled` (re-attaches when the link is replaced). */
export function useScreenShare(link, getEmu, { system, enabled = true } = {}) {
  const ref = useRef(getEmu);
  ref.current = getEmu;
  useEffect(() => {
    if (!link || !enabled || !link.startScreenShare) return undefined;
    link.startScreenShare(emuScreenSource(() => ref.current?.(), system));
    return () => link.stopScreenShare();
  }, [link, enabled, system]);
}

/** Watches one partner's picture while mounted – one per shown window, so hiding one never disturbs the others. */
export function Watch({ link, slot, onView }) {
  const cb = useRef(onView);
  cb.current = onView;
  useEffect(() => {
    if (!link?.watchPartnerScreen) return undefined;
    return link.watchPartnerScreen((v) => cb.current(slot, v), slot);
  }, [link, slot]);
  return null;
}

// Clicking here must not take the keyboard away from the game iframe.
const keepFocus = (e) => e.preventDefault();

/** A rectangle of `el` relative to the layer. */
function relRect(el, base) {
  const r = el.getBoundingClientRect();
  return { x: r.left - base.left, y: r.top - base.top, w: el.clientWidth || r.width, h: r.height };
}

/**
 * The run's partner layout on this computer (lib/pslayout.mjs) – shared by the tiles and the windows:
 * { others, nameOf, popped(slot), stored(slot), pop(slot), dock(slot), store(slot, stored) }.
 */
export function usePartnerLayout() {
  const { manifest, doc, me, link } = useApp() || {};
  const [pref, setPref] = useState(loadPref);
  const runId = manifest?.id;
  const others = manifest && me ? othersOf(me, manifest) : link?.others || [];
  const names = manifest && doc ? getPlayers(doc, manifest) : manifest?.players || {};
  const layout = runLayout(pref, runId);
  const setWin = useCallback((slot, patch) => setPref((cur) => {
    const next = updateRun(cur, runId, (l) => ({ wins: { ...l.wins, [slot]: { ...(l.wins[slot] || {}), ...patch } } }));
    savePref(next);
    return next;
  }), [runId]);
  return {
    others,
    nameOf: (slot) => names[slot]?.name || slot.toUpperCase(),
    popped: (slot) => winState(layout, slot).popped,
    stored: (slot) => winState(layout, slot).stored,
    pop: (slot) => setWin(slot, { popped: true }),
    dock: (slot) => setWin(slot, { popped: false, fx: undefined, fy: undefined, w: undefined }),
    store: (slot, st) => setWin(slot, st),
  };
}

/** What a partner's view shows now: { view, stream, imageMode, age, live, ar } – null while nothing is known. */
export function viewInfo(view, system, measured, now) {
  const stream = view?.mode === 'stream' ? view.stream : null;
  const imageMode = view?.mode === 'image' && !!view.url;
  const age = imageMode ? now - view.at : 0;
  const live = !!view?.active && (!!stream || (imageMode && age < STALE_MS));
  return { view, stream, imageMode, age, live, ar: arOf(view?.system || system, measured) };
}

function message(view, name) {
  return !view?.known
    ? t('ps.noPicture', 'No picture from {name} right now', { name })
    : view.active
      ? t('ps.connecting', 'Connecting to {name}’s picture …', { name })
      : view.paused
        ? t('ps.paused', '{name}’s game is in a background tab – no picture right now', { name })
        : t('ps.notPlaying', '{name} isn’t playing right now', { name });
}

const GRAB_MS = 500; // how often the running video's frame is kept as "the last good picture"

/**
 * Copies `src` (a <video> or <img>) into the `hold` canvas when the frame isn't (nearly) black – lib/pshold.mjs.
 * `probe` is a tiny canvas for the brightness check.
 */
function grab(src, hold, probe) {
  const w = src.videoWidth || src.naturalWidth;
  const h = src.videoHeight || src.naturalHeight;
  if (!hold || !w || !h) return false;
  try {
    probe.width = 16;
    probe.height = 16;
    const p = probe.getContext('2d', { willReadFrequently: true });
    p.drawImage(src, 0, 0, 16, 16);
    if (!keepable(p.getImageData(0, 0, 16, 16).data)) return false;
    if (hold.width !== w || hold.height !== h) {
      hold.width = w;
      hold.height = h;
    }
    const x = hold.getContext('2d');
    x.imageSmoothingEnabled = false;
    x.drawImage(src, 0, 0, w, h);
    return true;
  } catch {
    return false; // no frame yet
  }
}

/**
 * The picture: video, still or why there is none. It never goes black while it is only late: the last good frame
 * stays (lib/pshold.mjs) until the next one has drawn, and under the message when the picture stopped.
 */
export function Picture({ info, name, onMeasure }) {
  const { stream, imageMode, live, view } = info;
  const video = useRef(null);
  const img = useRef(null);
  const hold = useRef(null);
  const probe = useRef(null);
  const [hasHold, setHasHold] = useState(false);
  // { el, src }: the element that has drawn a picture of src (stream / still URL) – a new element (it went and came
  // back) has drawn nothing yet, even for the same stream
  const [drawn, setDrawn] = useState(null);
  const source = stream || (imageMode ? view.url : null);
  const keep = useCallback((el) => {
    probe.current ||= document.createElement('canvas');
    if (grab(el, hold.current, probe.current)) setHasHold(true);
  }, []);
  const ready = !!source && drawn?.src === source && !!drawn.el && drawn.el === (stream ? video.current : img.current);
  const L = pictureLayers({ live, stream, imageMode, ready, hasHold });

  useEffect(() => {
    const el = video.current;
    if (!el) return undefined;
    if (el.srcObject !== stream) {
      if (el.srcObject && el.videoWidth) keep(el); // the old stream's last frame, before it goes
      el.srcObject = stream;
    }
    if (!stream) return undefined;
    el.play?.().catch(() => {});
    // shown from its first drawn frame on; until then (and whenever it stalls) the kept frame is there
    let stop = false;
    let first = true;
    let last = 0;
    let rvfc = 0;
    const onFrame = () => {
      if (stop) return;
      if (first) setDrawn({ el, src: stream });
      first = false;
      const now = Date.now();
      if (now - last >= GRAB_MS) {
        last = now;
        keep(el);
      }
      if (el.requestVideoFrameCallback) rvfc = el.requestVideoFrameCallback(onFrame);
    };
    let iv = null;
    if (el.requestVideoFrameCallback) rvfc = el.requestVideoFrameCallback(onFrame);
    else {
      el.addEventListener('loadeddata', onFrame, { once: true });
      iv = setInterval(() => !stop && el.readyState >= 2 && keep(el), GRAB_MS);
    }
    return () => {
      stop = true;
      if (el.videoWidth) keep(el); // (the element may go now – live → not live)
      if (rvfc) el.cancelVideoFrameCallback?.(rvfc);
      el.removeEventListener('loadeddata', onFrame);
      clearInterval(iv);
    };
  }, [stream, live, keep]);

  const measure = (w, h) => w && h && onMeasure?.(w / h);
  const onImg = (e) => {
    measure(e.target.naturalWidth, e.target.naturalHeight);
    setDrawn({ el: e.target, src: view.url });
    keep(e.target);
  };
  return html`
    <canvas ref=${hold} class=${`ps-hold ${L.hold ? '' : 'off'} ${L.dim ? 'dim' : ''}`} aria-hidden="true"></canvas>
    ${L.video && html`<video ref=${video} class=${ready || !hasHold ? '' : 'wait'} autoplay muted playsinline disablepictureinpicture
      onLoadedMetadata=${(e) => measure(e.target.videoWidth, e.target.videoHeight)} onResize=${(e) => measure(e.target.videoWidth, e.target.videoHeight)}></video>`}
    ${L.img && html`<img ref=${img} src=${view.url} class=${ready || !hasHold ? '' : 'wait'} alt=${t('ps.alt', 'What {name} sees right now', { name })} onLoad=${onImg} />`}
    ${L.msg && html`<span class=${`ps-msg ${L.dim ? 'on-hold' : ''}`} role="status">${message(view, name)}</span>`}`;
}

/** Name, live dot and age of a picture – the header of a tile and of a window. */
function Label({ slot, name, info }) {
  const secs = Math.round((info?.age || 0) / 1000);
  const held = !!info?.view?.held; // their game is paused: the picture stands still
  const fresh = !held && (!!info?.stream || secs < 4);
  return html`<span class=${`ps-dot ${!info?.live ? 'off' : fresh ? '' : 'stale'}`} aria-hidden="true"></span>
    <b class=${`px ps-name who-${slot}`}>${name}</b>
    ${info?.live && html`<span class="ps-age mono">${held ? t('ps.held', 'paused') : fresh ? t('ps.live', 'live') : t('ps.ago', '{n} s ago', { n: secs })}</span>`}`;
}

/** Views of the given partners (one subscription each) and the ticking age of still pictures. */
function useViews(link, slots) {
  const [views, setViews] = useState({});
  const [measured, setMeasured] = useState({});
  const [, tick] = useState(0);
  const onView = useCallback((slot, v) => setViews((all) => ({ ...all, [slot]: v })), []);
  const anyImages = slots.some((s) => views[s]?.mode === 'image');
  useEffect(() => {
    if (!anyImages) return undefined;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [anyImages]);
  const measure = (slot) => (ar) => setMeasured((m) => (Math.abs((m[slot] || 0) - ar) > 0.01 ? { ...m, [slot]: ar } : m));
  const watchers = link ? slots.map((slot) => html`<${Watch} key=${slot} link=${link} slot=${slot} onView=${onView} />`) : null;
  return { views, measured, measure, watchers };
}

/**
 * The partners' games as tiles in the dock: a column of tiles on the right (side by side when there are several), a
 * row along the bottom. A popped-out partner leaves a small button that docks the window again.
 *   pl – usePartnerLayout()
 */
export function PartnerTiles({ link, system, side, pl, box = null, below = null }) {
  const docked = pl.others.filter((s) => !pl.popped(s));
  const away = pl.others.filter((s) => pl.popped(s));
  const { views, measured, measure, watchers } = useViews(link, docked);
  const rps = rpsFor(link); // (rock-paper-scissors from a partner's tile: lib/worldrps.mjs)
  const now = Date.now();
  if (!pl.others.length) return null;
  const infos = Object.fromEntries(docked.map((s) => [s, viewInfo(views[s], system, measured[s], now)]));
  // on the right as many side by side as leave the biggest pictures that still fit (box: the room they have)
  const ar = docked.length ? Math.min(...docked.map((s) => infos[s].ar)) : 1;
  const cols = side === 'bottom' ? docked.length : tileColumns(docked.length, ar, box || { w: 300, h: Infinity });
  const popLabel = t('ps.popOut', 'Open in a window');
  return html`<div class=${`ptiles ${side}`} style=${`--cols:${cols}`} role="group" aria-label=${t('ps.screens', 'Partner screens')}>
    ${watchers}
    ${docked.map((slot) => {
      const name = pl.nameOf(slot);
      const info = infos[slot];
      return html`<section class="pt" key=${slot} style=${`--ar:${info.ar}`} aria-label=${t('ps.title', '{name}’s game', { name })} onMouseDown=${keepFocus}>
        <header class="pt-head"><${Label} slot=${slot} name=${name} info=${info} /><span class="spacer"></span>
          ${rps && html`<button class="ps-btn" onMouseDown=${keepFocus} onClick=${() => rps.hub.challenge(slot)} title=${t('rps.challenge', 'Rock-paper-scissors with {name}', { name })}
            aria-label=${t('rps.challenge', 'Rock-paper-scissors with {name}', { name })}><img src=${artUrl('scissors', '#ebe6da', 2)} alt="" style="image-rendering:pixelated;width:12px;height:12px" /></button>`}
          <button class="ps-btn" onMouseDown=${keepFocus} onClick=${() => pl.pop(slot)} title=${popLabel} aria-label=${`${popLabel}: ${name}`}><${Icon} name="external" size=${12} /></button></header>
        <div class="pt-screen"><${Picture} info=${info} name=${name} onMeasure=${measure(slot)} /></div>
        ${below?.(slot, 'tile')}
      </section>`;
    })}
    ${away.length > 0 && html`<div class="pt-away">${away.map((slot) => html`<button class="ps-tab" key=${slot} onMouseDown=${keepFocus} onClick=${() => pl.dock(slot)}
      title=${t('ps.dock', 'Back to the panel')}><span class="ps-dot" aria-hidden="true"></span><span class="ellipsis">${t('ps.inWindow', '{name} – in a window', { name: pl.nameOf(slot) })}</span>
      <${Icon} name="panelRight" size=${12} /></button>`)}</div>`}
  </div>`;
}

/**
 * The partners popped out of the dock, each in a window over the play area (mount it as a child of .session-body).
 *   pl    – usePartnerLayout()
 *   avoid – CSS selector of what a window may never cover (the game bar), inside .session-body
 */
export function PartnerScreens({ link, system, pl, avoid = '.session-bar', below = null }) {
  const shown = pl.others.filter((s) => pl.popped(s));
  const { views, measured, measure, watchers } = useViews(link, shown);
  const [zones, setZones] = useState(null);
  const [drag, setDrag] = useState(null);
  const layer = useRef(null);

  // The play area, the stage (where new windows start) and the game bar, measured whenever any of them changes.
  useLayoutEffect(() => {
    const el = layer.current;
    const body = el?.parentElement;
    if (!body) return undefined;
    const measureAll = () => {
      const base = el.getBoundingClientRect();
      const stage = body.querySelector(':scope > .session-stage');
      const bar = body.querySelector(avoid);
      const area = { w: Math.round(base.width), h: Math.round(base.height) };
      if (!area.w || !area.h) return;
      const st = stage ? relRect(stage, base) : { x: 0, y: 0, w: area.w, h: area.h };
      const block = bar ? relRect(bar, base) : null;
      const next = { area, stage: st, block };
      setZones((z) => (JSON.stringify(z) === JSON.stringify(next) ? z : next));
    };
    measureAll();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measureAll) : null;
    if (ro) for (const x of [el, body.querySelector(':scope > .session-stage'), body.querySelector(avoid)]) if (x) ro.observe(x);
    addEventListener('resize', measureAll);
    const id = setInterval(measureAll, 1000); // the bar moves with the picture (no size change to observe)
    return () => {
      ro?.disconnect();
      removeEventListener('resize', measureAll);
      clearInterval(id);
    };
  }, [shown.length > 0]);

  const now = Date.now();
  const info = Object.fromEntries(shown.map((s) => [s, viewInfo(views[s], system, measured[s], now)]));
  // Where every window is: dragged → where the pointer has it; moved before → remembered; else the stage's corner.
  // Never on the game bar.
  const rects = {};
  if (zones) {
    const { area, stage, block } = zones;
    const follow = shown.filter((s) => !pl.stored(s) && drag?.slot !== s).map((id) => ({ id, ar: info[id].ar }));
    const start = cornerLayout(follow, stage, area);
    for (const slot of shown) {
      const r = drag?.slot === slot ? drag.rect : pl.stored(slot) ? fromStored(pl.stored(slot), info[slot].ar, area) : start[slot];
      rects[slot] = r && avoidRect(r, block, area);
    }
  }

  /** Pointer down on a window's header (move) or its grip (resize): follows the pointer until it is let go. */
  const startDrag = (e, slot, kind) => {
    if (e.button !== 0 || !zones || !rects[slot]) return;
    if (kind === 'move' && e.target.closest('button')) return;
    const el = e.currentTarget;
    const { area, block } = zones;
    const start = rects[slot];
    const ar = info[slot].ar;
    const others0 = shown.filter((s) => s !== slot).map((s) => rects[s]);
    const d = { slot, kind, start, rect: start, side: gripSide(start, area), moved: false };
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // the pointer is already gone
    }
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      const dx = ev.clientX - e.clientX;
      const dy = ev.clientY - e.clientY;
      if (!d.moved && Math.hypot(dx, dy) < 3) return; // a click, not a drag
      d.moved = true;
      const r = kind === 'move' ? snapRect({ ...start, x: start.x + dx, y: start.y + dy }, others0, area) : resizeRect(start, dx, dy, ar, area, d.side);
      d.rect = avoidRect(r, block, area);
      setDrag({ ...d });
    };
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('lostpointercapture', up);
      if (d.moved) pl.store(slot, toStored(d.rect, area));
      setDrag(null);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  };

  // (the layer stays even without a window: it is measured once when it mounts)
  return html`<div class=${`ps-layer ${drag ? 'dragging' : ''}`} ref=${layer}>
    ${watchers}
    ${zones && shown.map((slot) => rects[slot] && html`<${PartnerWindow} key=${slot} slot=${slot} name=${pl.nameOf(slot)} info=${info[slot]} rect=${rects[slot]}
      area=${zones.area} dragging=${drag?.slot === slot} grip=${gripSide(rects[slot], zones.area)} onMeasure=${measure(slot)}
      onDrag=${(e, kind) => startDrag(e, slot, kind)}
      onSize=${(r) => pl.store(slot, toStored(avoidRect(r, zones.block, zones.area), zones.area))}
      onDock=${() => pl.dock(slot)} below=${below} />`)}
  </div>`;
}

/** One partner's window: header (drag to move, Bigger / Smaller, back to the panel), the picture, the resize grip. */
function PartnerWindow({ slot, name, info, rect, area, dragging, grip, onMeasure, onDrag, onSize, onDock, below = null }) {
  const { ar } = info;
  const big = rect.w >= defaultWidth(ar, true) - 1;
  const sizeLabel = big ? t('ps.smaller', 'Smaller') : t('ps.bigger', 'Bigger');
  const dockLabel = t('ps.dock', 'Back to the panel');
  return html`<section class=${`ps ${dragging ? 'is-dragging' : ''}`} aria-label=${t('ps.title', '{name}’s game', { name })} onMouseDown=${keepFocus}
    style=${`left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px`}>
    <header class="ps-head" title=${t('ps.moveHint', 'Drag to move')} onPointerDown=${(e) => onDrag(e, 'move')}>
      <${Label} slot=${slot} name=${name} info=${info} />
      <span class="spacer"></span>
      <button class="ps-btn" onMouseDown=${keepFocus} onClick=${() => onSize(resizeAnchored(rect, defaultWidth(ar, !big), ar, area))} aria-pressed=${big}
        title=${sizeLabel} aria-label=${sizeLabel}><${Icon} name=${big ? 'shrink' : 'full'} size=${12} /></button>
      <button class="ps-btn" onMouseDown=${keepFocus} onClick=${onDock} title=${dockLabel} aria-label=${dockLabel}><${Icon} name="panelRight" size=${12} /></button>
    </header>
    <div class="ps-screen"><${Picture} info=${info} name=${name} onMeasure=${onMeasure} /></div>
    ${below?.(slot, 'window')}
    <span class=${`ps-grip ${grip}`} title=${t('ps.resize', 'Drag to resize')} aria-hidden="true" onPointerDown=${(e) => onDrag(e, 'resize')}></span>
  </section>`;
}
