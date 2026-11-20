// "Your handheld" (#/handheld, design rounds 5/6): the device in your own launch animation, dressed with a skin and
// stickers – Settings › Play › Launch animation › Your handheld. Left: the device in 3D (the launch animation's own scene,
// so what you dress is what plays) – drag to turn it, scroll to zoom, drag stickers onto it, move them anywhere (they
// slide round buttons, screens and the slot, run over the edges, overlap), turn them freely (knob, ⇧-drag, scroll;
// a gentle snap within ±3° of straight), size them 70–160 %. Right: the drawer – the four handhelds (stickers per
// device, one skin for all), saved designs (up to 12, Surprise me at start), the filter row with the favourites,
// skins, stickers and what you earn instead of buy.
//
// A local setting (config.json `handheld`, lib/handheld/look.mjs): it is saved the moment it changes, like every
// setting; Undo / Redo and "Back to how it was" are the safety net. Nobody else ever sees it. souldew+ items show when
// their art is here (the pack); a design keeps them after a membership ends, and the launch plays the free parts.
// What it holds follows the membership (shared/handheld.mjs launchRights): Supporter – the free skin, the free and the
// earned stickers, one saved design, no Surprise me; souldew+ – everything. Free accounts have the 2D launch: here they
// get a short page saying so (with what is earned), and whatever they dressed before stays for when they come back.
//   #/handheld[?sys=gba|nds|3ds|gb]
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from '/vendor/htm-preact.mjs';
import { t } from '../lib/i18n.mjs';
import { useApp } from '../lib/ui.mjs';
import { settingsLink } from '../lib/settingsindex.mjs';
import { useTrophies } from '../lib/trophies.mjs';
import { achText } from '../lib/trophytexts.mjs';
import { IS_MAC, shortcut } from '../lib/platform.mjs';
import { packState } from '../lib/cosmetics/index.mjs';
import { PlusMark, useCosmetics } from '../lib/cosmetics/components.mjs';
import { openPlus } from '../lib/cosmetics/plus.mjs';
import { compile } from '../lib/cosmetics/banners/engine/index.mjs';
import { EARNED_BANNERS } from '../lib/cosmetics/state.mjs';
import { previewSrc, usePreviews } from '../lib/cosmetics/previews.mjs';
import { FavScope, FavFilter, FavEmpty, useFavourites, useFavFilter, isFavourite } from '../lib/favourites.mjs';
import { filterChips, shownFilter } from '/shared/favourites.mjs';
import {
  STICKERS, WRAPS, FINISHES, UNLOCKS, STICKER_MAX, SCALE_MIN, SCALE_MAX, stickerById, wrapById, sheetItems, sheetCounts, sheetPass, groupStickers, launchLook, devKey, playableLookFor,
  designNotes, designDirty, saveAsNew, overwriteDesign, renameDesign, duplicateDesign, deleteDesign, applyDesign, exportHandheld, importHandheld, NAME_MAX,
} from '/shared/handheld.mjs';
import { useHandheld, setHandheld, handheld, launchConfig, poseScene, viewPlan, VIEWS, isFold, useCosmeticsTick, sceneWrap, useLaunchRights } from '../lib/handheld/look.mjs';
import { PX, GAP, snapSticker, slideSticker, snapTurn, firstFree } from '../lib/handheld/geometry.mjs';
import { insideCut } from '../lib/handheld/atlas.mjs';
import { loadAtlas, atlasNow, stickerThumb } from '../lib/handheld/stickers.mjs';
import { wrapThumb, wrapReady } from '../lib/handheld/wrap.mjs';
import { launchNames } from './settings/launch.mjs';
import { LaunchPreview } from './launchstage.mjs';
import { coverOf } from './library.mjs';

export const DEVICE_TABS = ['gba', 'nds', '3ds', 'gb'];
export const devName = (id) => ({ gba: 'GBA', nds: 'DS', '3ds': '3DS', gb: 'GB', gbc: 'GB Color' })[id] || id;
export const lookName = (id) => launchNames()[id]?.[0] || id;
const deg = (r) => Math.round((((r * 180) / Math.PI) % 360 + 540) % 360 - 180);
const reducedMotion = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const finishName = (k) => ({ vinyl: t('hh.vinyl', 'Vinyl'), holo: t('hh.holoFinish', 'Holo'), glitter: t('hh.glitter', 'Glitter') })[k];
const trophyName = (id) => achText(id).name;
const trophyHow = (id) => achText(id, 16).desc;

let BT = null;
/** the earned banner, still, at its own pixels (it ships with the app: no pack needed) */
function bannerThumb() {
  if (BT) return BT;
  const b = EARNED_BANNERS[0];
  const sc = compile({ ...b, intro: false }, { width: 200 });
  sc.noIntro = true;
  const c = document.createElement('canvas');
  c.width = sc.W;
  c.height = 56;
  const g = c.getContext('2d');
  const im = g.createImageData(sc.W, 56);
  sc.frame(4, new Uint32Array(im.data.buffer));
  g.putImageData(im, 0, 0);
  BT = c.toDataURL();
  return BT;
}

export function HandheldView() {
  const R = useLaunchRights();
  return R.three ? html`<${HandheldEditor} R=${R} />` : html`<${HandheldFree} />`;
}

/** Free: no 3D launch – what it is, what comes with which tier, what is earned; nothing to dress, nothing lost. */
function HandheldFree() {
  const { navigate } = useApp();
  const tr = useTrophies();
  const doc = useHandheld();
  const has = useMemo(() => new Set((tr?.achievements || []).filter((a) => a.ok).map((a) => a.id)), [tr]);
  const kept = !!(doc.skin || doc.designs.length || Object.keys(doc.stickers).length);
  return html`<div class="pe hh hh-free is-open">
    <div class="pe-bar hh-bar"><nav class="hh-crumbs" aria-label=${t('hh.where', 'Where you are')}><a href=${`#/settings?s=play`}>${t('nav.settings', 'Settings')}</a><span>›</span><a href=${`#/settings?s=play`}>${t('set.secPlay', 'Play')}</a><span>›</span>
        <a href=${`#/settings?s=play&f=launch`}>${t('launch.title', 'Launch animation')}</a><span>›</span><b>${t('hh.title', 'Your handheld')}</b></nav><span class="grow"></span>
      <button type="button" class="btn primary" onClick=${() => navigate('settings', settingsLink('launch'))}>${t('hh.done', 'Done')}</button></div>
    <div class="hh-free-body stack">
      <h2>${t('hh.title', 'Your handheld')}</h2>
      <p class="muted">${t('hh.freeLead', 'Your own souldew handheld in 3D – dressed with a skin and stickers – is the launch animation with Supporter or souldew+. Your games start with the cartridge sliding into the console.')}</p>
      ${kept && html`<p class="small faint">${t('hh.freeKept', 'What you dressed it in is kept on this computer – it comes back with a membership.')}</p>`}
      <div class="hh-sec"><span class="pe-kicker">${t('hh.earnedTitle', 'Earned, not bought')}</span><span class="tiny faint">${t('hh.earnedOf', '{n} of {all}', { n: UNLOCKS.filter((u) => has.has(u.trophy)).length, all: UNLOCKS.length })}</span></div>
      <div class="hh-earn">${UNLOCKS.map((u) => { const ok = has.has(u.trophy); const thumb = u.kind === 'sticker' ? stickerThumb(u.id, 4) : null; return html`<div class=${`hh-earn-row ${ok ? 'ok' : 'off'}`}>
        ${u.kind === 'banner' ? html`<span class="hh-earn-b" style=${`background-image:url(${bannerThumb()})`}></span>` : thumb ? html`<img class="hh-earn-s" src=${thumb} alt="" />` : html`<span></span>`}
        <span class="hh-earn-t"><b>${u.name}${u.kind === 'banner' ? html` <span class="tiny faint">· ${t('hh.aBanner', 'a banner')}</span>` : ''}</b><span class=${`tiny ${ok ? 'faint' : ''}`}>${ok ? t('hh.earnedByT', 'Earned by {trophy}', { trophy: trophyName(u.trophy) }) : `${trophyName(u.trophy)}: ${trophyHow(u.trophy)}`}</span>
          <span class="tiny faint">${u.kind === 'banner' ? t('hh.earnedBannerAll', 'On your profile – for everyone.') : t('hh.earned3d', 'Shows in the 3D launch – with Supporter or souldew+.')}</span></span>
        <span class=${`hh-earn-k ${ok ? 'ok' : ''}`}>${ok ? t('hh.yours', 'Yours') : t('hh.locked', 'locked')}</span></div>`; })}</div>
      <div class="row"><a class="btn" href="#/plus">${t('launch.seeTiers', 'What each tier gets')}</a></div>
    </div>
  </div>`;
}

function HandheldEditor({ R }) {
  const { route, navigate, status, library } = useApp();
  useCosmetics();
  usePreviews();
  useCosmeticsTick();
  const tr = useTrophies();
  const has = useMemo(() => new Set((tr?.achievements || []).filter((a) => a.ok).map((a) => a.id)), [tr]);
  const member = R.plus;
  const designMax = R.designMax;
  const L = launchConfig(status?.config);
  const lookId = playableLookFor(L.look, R); // a souldew+ look kept from a membership that ended: "Your colours" plays
  const look = launchLook(lookId).look;
  const shellOnly = look === 'clear' || look === 'gold'; // Clear and Gold are shells, not paint: no wrap on them
  const p0 = route.params?.sys;
  const [sys, setSys] = useState(DEVICE_TABS.includes(p0) ? p0 : 'nds');
  const fold = isFold(sys);
  const saved = useHandheld();
  const [doc, setDocState] = useState(() => handheld());
  const docRef = useRef(doc);
  docRef.current = doc;
  const setDoc = (next) => { docRef.current = next; setDocState(next); setHandheld(next); };
  useEffect(() => { if (JSON.stringify(saved) !== JSON.stringify(docRef.current)) { docRef.current = saved; setDocState(saved); } }, [saved]);
  const opened = useRef(JSON.stringify(handheld())); // "Back to how it was"
  const [hist, setHist] = useState({ undo: [], redo: [] });
  const [sel, setSel] = useState(-1);
  const [finish, setFinish] = useState('vinyl');
  const [view, setView] = useState(fold ? 'lid' : 'back');
  const [orbit, setOrbit] = useState({ yaw: 0, tilt: 0, zoom: 1 });
  const [hint, setHint] = useState(null); // { text, plus? }
  const [toast, setToast] = useState(null); // { text, undo: doc }
  const [renaming, setRenaming] = useState(null);
  const [menu, setMenu] = useState(false);
  const [playing, setPlaying] = useState(0); // "Play my launch": the launch over the stage
  const [atlas, setAtlas] = useState(atlasNow());
  const favs = useFavourites();
  const [want, setFilter] = useFavFilter('hh');
  const stageRef = useRef(null), cvs = useRef(null), sceneRef = useRef(null), ring = useRef(null), fileRef = useRef(null);
  const drag = useRef(null);
  const regionsRef = useRef({});
  const dk = devKey(sys);
  const stickers = doc.stickers[dk] || [];
  const live = useRef({});
  live.current = { stickers, sel, doc };
  const reduced = reducedMotion();
  const say = (text, extra = {}) => setHint(text ? { text, ...extra } : null);

  useEffect(() => { let a = true; loadAtlas().then((x) => a && setAtlas(x), () => {}); return () => { a = false; }; }, [packState().entitled, packState().packVersion]);
  const rects = atlas?.rects || {};
  const sys0 = useRef(sys);
  useEffect(() => {
    if (sys0.current === sys) return;
    sys0.current = sys;
    if (!VIEWS[fold ? 'fold' : 'slab'][view]) setView(fold ? 'lid' : 'back');
    setOrbit({ yaw: 0, tilt: 0, zoom: 1 });
    setSel(-1);
  }, [sys]);

  // history: one entry per gesture (a wheel turn, a held key or the size slider coalesce into one step)
  const lastKey = useRef({ k: null, t: 0 });
  const commit = (next, key = null) => {
    const now = performance.now();
    const same = key && lastKey.current.k === key && now - lastKey.current.t < 900;
    lastKey.current = { k: key, t: now };
    if (!same) setHist((h) => ({ undo: [...h.undo.slice(-60), JSON.stringify(docRef.current)], redo: [] }));
    setDoc(next);
  };
  const undo = () => setHist((h) => {
    if (!h.undo.length) return h;
    const cur = JSON.stringify(docRef.current);
    setDoc(JSON.parse(h.undo[h.undo.length - 1]));
    setSel(-1);
    return { undo: h.undo.slice(0, -1), redo: [...h.redo, cur] };
  });
  const redo = () => setHist((h) => {
    if (!h.redo.length) return h;
    const cur = JSON.stringify(docRef.current);
    setDoc(JSON.parse(h.redo[h.redo.length - 1]));
    setSel(-1);
    return { undo: [...h.undo, cur], redo: h.redo.slice(0, -1) };
  });
  const setStk = (list, key) => commit({ ...docRef.current, stickers: { ...docRef.current.stickers, [dk]: list } }, key);

  // ---- the scene: rebuilt when the handheld, the skin or the shell changes ----
  const planRef = useRef(null);
  planRef.current = () => viewPlan(sys, view, orbit);
  const draw = () => { const sc = sceneRef.current; if (!sc) return; sc.render(performance.now() - (sc.__t0 || 0)); placeRing(); };
  const skinOn = !shellOnly && doc.skin && sceneWrap(doc.skin) ? doc.skin : null;
  useLayoutEffect(() => {
    let alive = true, scene = null, raf = 0, ro = null;
    // a canvas of its own per build: a WebGL context belongs to its canvas, and the build being replaced lets its go
    const cv = document.createElement('canvas');
    cv.className = 'hh-canvas';
    stageRef.current.prepend(cv);
    (async () => {
      const box = stageRef.current.getBoundingClientRect();
      const lib = library?.roms?.find((r) => r.system === sys || (sys === 'gb' && r.system === 'gbc'));
      const r = await poseScene(cv, { sys, look, skin: skinOn, w: Math.max(80, Math.round(box.width)), h: Math.max(80, Math.round(box.height)), el: stageRef.current,
        plan: () => planRef.current(), reduced, clear: L.clear, cartColor: null, cover: lib ? coverOf(library, { gameId: lib.gameId, rom: lib }) : null });
      scene = r.scene;
      if (!alive) { scene.dispose(); return; }
      scene.__t0 = performance.now();
      cvs.current?.remove();
      cvs.current = cv;
      sceneRef.current = scene;
      regionsRef.current = scene.regions();
      // for the recordings and the end-to-end checks: where a sticker is on screen (no global – a property of the stage)
      stageRef.current.__hh = { at: (i) => { const st = live.current.stickers[i]; return st && scene.uToScreen(st.region, st.U); }, face: (key, U) => scene.uToScreen(key, U), count: () => live.current.stickers.length };
      ro = new ResizeObserver(() => { const b = stageRef.current?.getBoundingClientRect(); if (b?.width && b?.height) { scene.resize(Math.round(b.width), Math.round(b.height)); draw(); } });
      ro.observe(stageRef.current);
      syncStickers();
      // the wrap's life (stars, the train) at the banner's own 10 fps; a still when nothing moves (or reduced motion)
      let last = 0;
      const tick = (now) => { if (!alive) return; if (scene.hh.art?.animated && now - last > 95) { last = now; draw(); } raf = requestAnimationFrame(tick); };
      raf = requestAnimationFrame(tick);
      draw();
    })().catch((e) => { console.warn('handheld scene', e); say(t('hh.noGl', 'Your handheld can’t be drawn on this computer (no WebGL).')); });
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      if (scene) { // the next build takes over this canvas' place once it is drawn (no blank frame between)
        if (sceneRef.current === scene) sceneRef.current = null;
        scene.dispose();
      }
      if (cvs.current !== cv) cv.remove();
    };
  }, [sys, skinOn, look, atlas, L.clear]);

  // stickers / camera / selection → redraw (no rebuild)
  const ghostRef = useRef(null);
  const syncStickers = () => {
    const sc = sceneRef.current;
    if (!sc) return;
    const d = drag.current;
    const { stickers: cur, sel: s } = live.current;
    const lifted = d && (d.kind === 'move' || d.kind === 'turn' || d.kind === 'size') ? d.index : -1;
    const shown = cur.map((x, i) => ({ ...x, i })).filter((x) => x.i !== lifted && rects[x.id]);
    const si = shown.findIndex((x) => x.i === s);
    sc.setStickers(shown, ghostRef.current && rects[ghostRef.current.id] ? ghostRef.current : null, lifted >= 0 ? -1 : si);
    draw();
  };
  useEffect(syncStickers, [doc, sel, view, orbit, sys, atlas]);

  // ---- the selection frame (DOM over the canvas): turned with the sticker, a knob to turn it, a corner to size it ----
  const screenOf = (st) => {
    const sc = sceneRef.current;
    if (!sc) return null;
    const R = regionsRef.current[st.region];
    const [fx, fy] = R?.region.view || [1, 1];
    const c = sc.uToScreen(st.region, st.U);
    const ax = (r) => { const q = sc.uToScreen(st.region, [st.U[0] + fx * Math.cos(r) * 4, st.U[1] + fy * Math.sin(r) * 4]); return q && c ? [q[0] - c[0], q[1] - c[1]] : null; };
    const a = ax(st.rot || 0), b = ax((st.rot || 0) + 0.2), yv = ax((st.rot || 0) + Math.PI / 2);
    if (!c || !a || !b || !yv) return null;
    const ppm = Math.hypot(a[0], a[1]) / 4, ppmY = Math.hypot(yv[0], yv[1]) / 4; // (the face is seen at an angle: y shortens)
    const th = Math.atan2(a[1], a[0]);
    const sgn = Math.sign(Math.sin(Math.atan2(b[1], b[0]) - th)) || 1;
    return { c, ppm, ppmY, th, sgn };
  };
  function placeRing() {
    const el = ring.current;
    if (!el) return;
    const d = drag.current;
    const st = d && (d.kind === 'turn' || d.kind === 'size') ? ghostRef.current : live.current.stickers[live.current.sel];
    const sp = st && rects[st.id] && (!d || d.kind === 'turn' || d.kind === 'size' || d.kind === 'orbit') ? screenOf(st) : null;
    if (!sp) { el.style.opacity = '0'; el.style.pointerEvents = 'none'; return; }
    const r = rects[st.id];
    const k = PX * (st.scale || 1);
    Object.assign(el.style, { opacity: '1', pointerEvents: '', left: `${sp.c[0]}px`, top: `${sp.c[1]}px`, width: `${r.w * k * sp.ppm + 10}px`, height: `${r.h * k * sp.ppmY + 10}px`,
      transform: `translate(-50%, -50%) rotate(${sp.th}rad)` });
  }

  // ---- placing ----
  const mmpp = (st) => PX * (st.scale || 1);
  const refusal = (st, R) => {
    const A = rects[st.id];
    const big = A.area * mmpp(st) ** 2 > 0.4 * R.slab.w * R.slab.d * (R.region.Ls ? 0.35 : 0.12);
    return big ? (R.region.Ls ? t('hh.tooBigSmaller', 'No room on this face for a sticker this big – try a smaller size') : t('hh.tooBigFace', 'No room on this face for a sticker this big – try the lid or the back'))
      : t('hh.noRoom', 'No room here – it would cover a button, a screen, a speaker or the slot');
  };
  const local = (e) => { const b = (cvs.current || stageRef.current).getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top, e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom]; };
  const onSticker = (st, R, U) => {
    const [fx, fy] = R.region.view || [1, 1];
    const c = Math.cos(st.rot || 0), s = Math.sin(st.rot || 0), k = mmpp(st);
    const dx = (U[0] - st.U[0]) * fx, dy = (U[1] - st.U[1]) * fy;
    return insideCut(rects[st.id], (c * dx + s * dy) / k, (-s * dx + c * dy) / k);
  };
  const hitSticker = (h) => {
    if (!h?.key) return -1;
    const R = regionsRef.current[h.key];
    for (let i = stickers.length - 1; i >= 0; i--) { // the top one first
      const st = stickers[i];
      if (st.region === h.key && rects[st.id] && onSticker(st, R, h.U)) return i;
    }
    return -1;
  };
  const lockedWhy = (s, fin = finish) => {
    if (s.tier === 'plus' && !member) return 'plus';
    if (s.tier === 'earned' && !has.has(s.trophy)) return 'earned';
    if (FINISHES[fin]?.plus && !member) return 'plus';
    return null;
  };
  const finishFor = (s) => (s.finishes.includes(finish) && (member || !FINISHES[finish].plus) ? finish : 'vinyl');
  const plusHint = (text) => say(text, { plus: true });
  function canAdd(s) {
    if (s.tier === 'earned' && !has.has(s.trophy)) { say(t('hh.earnedBy', 'Earned by {trophy} – {how}', { trophy: trophyName(s.trophy), how: trophyHow(s.trophy) })); return false; }
    if (!rects[s.id]) { plusHint(t('hh.plusSticker', '{name} comes with souldew+.', { name: s.name })); return false; }
    if (stickers.length >= STICKER_MAX) { say(t('hh.full', '{n} stickers on your {device} already – peel one off first', { n: STICKER_MAX, device: devName(sys) })); return false; }
    return true;
  }
  function startTray(e, s) {
    if (e.button !== 0 || !canAdd(s)) return;
    e.preventDefault();
    drag.current = { kind: 'new', id: s.id, finish: finishFor(s), rot: 0, scale: 1 };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up, { once: true });
  }
  function placeNew(s) { // Enter on the sheet: the first free spot on the face in view
    if (!canAdd(s)) return;
    const key = VIEWS[fold ? 'fold' : 'slab'][view]?.face;
    const R = regionsRef.current[key];
    const P = R && firstFree(R, rects[s.id], 0, PX);
    if (!P) { say(t('hh.noRoomFace', 'No room for {name} on this face – turn the device and try again', { name: s.name })); return; }
    setStk([...stickers, { id: s.id, finish: finishFor(s), region: key, U: P, rot: 0, scale: 1 }]);
    setSel(stickers.length);
    say(t('hh.placedKeys', '{name} placed – arrows move it, Q / E turn it, + / − size it, Enter when it sits right', { name: s.name }));
  }
  function startCanvas(e) {
    if (e.button !== 0) return;
    const [x, y] = local(e);
    const h = sceneRef.current?.pick(x, y);
    const i = hitSticker(h);
    if (i >= 0) {
      setSel(i);
      const st = stickers[i];
      if (e.shiftKey) startTurn(e, i);
      else {
        drag.current = { kind: 'move', index: i, id: st.id, finish: st.finish, rot: st.rot || 0, scale: st.scale || 1, off: [st.U[0] - h.U[0], st.U[1] - h.U[1]] };
        ghostRef.current = { ...st, ok: true };
      }
    } else {
      setSel(-1);
      drag.current = { kind: 'orbit', x0: e.clientX, y0: e.clientY, o: { ...orbit } };
    }
    e.currentTarget.setPointerCapture?.(e.pointerId);
    addEventListener('pointermove', move);
    addEventListener('pointerup', up, { once: true });
  }
  function startTurn(e, i = sel, kind = 'turn') {
    const st = stickers[i];
    const sp = st && rects[st.id] && screenOf(st);
    if (!sp) return;
    e.preventDefault();
    e.stopPropagation();
    const b = (cvs.current || stageRef.current).getBoundingClientRect();
    const cx = b.left + sp.c[0], cy = b.top + sp.c[1];
    drag.current = { kind, index: i, st0: st, cx, cy, a0: Math.atan2(e.clientY - cy, e.clientX - cx), r0: Math.hypot(e.clientX - cx, e.clientY - cy), sgn: sp.sgn };
    ghostRef.current = { ...st, ok: true };
    if (e.type === 'pointerdown' && e.currentTarget !== stageRef.current) {
      addEventListener('pointermove', move);
      addEventListener('pointerup', up, { once: true });
    }
    syncStickers();
  }
  /** the same sticker turned / sized: here if it fits, else nudged a little (≤ 5 mm), else not at all */
  const refit = (st) => {
    const R = regionsRef.current[st.region];
    return R && rects[st.id] && snapSticker(R.slab, R.region, rects[st.id], st.U, st.rot || 0, mmpp(st), GAP, 5);
  };
  function move(e) {
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'orbit') {
      setOrbit({ ...d.o, yaw: d.o.yaw - (e.clientX - d.x0) * 0.35, tilt: Math.max(-40, Math.min(40, d.o.tilt - (e.clientY - d.y0) * 0.25)) });
      return;
    }
    if (d.kind === 'turn' || d.kind === 'size') {
      const nx = { ...d.st0 };
      if (d.kind === 'turn') nx.rot = snapTurn((d.st0.rot || 0) + d.sgn * (Math.atan2(e.clientY - d.cy, e.clientX - d.cx) - d.a0));
      else nx.scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, (d.st0.scale || 1) * Math.hypot(e.clientX - d.cx, e.clientY - d.cy) / Math.max(8, d.r0)));
      const U = refit(nx);
      if (U) { ghostRef.current = { ...nx, U, ok: true }; say(d.kind === 'turn' ? `${deg(nx.rot)}°` : `${Math.round(nx.scale * 100)} %`); } else say(d.kind === 'turn' ? t('hh.noTurn', 'No room to turn it further here') : t('hh.noBigger', 'That is as big as it goes here'));
      syncStickers();
      return;
    }
    const [x, y, inside] = local(e);
    const h = inside ? sceneRef.current?.pick(x, y) : null;
    if (h?.key) {
      const R = regionsRef.current[h.key];
      const rect = rects[d.id], k = PX * d.scale;
      const target = d.off ? [h.U[0] + d.off[0], h.U[1] + d.off[1]] : h.U;
      const g = ghostRef.current;
      let U = null, slid = false;
      if (g?.ok && g.region === h.key) { // glide: from where it sits towards the hand, sliding round what's in the way
        const r = slideSticker(R.slab, R.region, rect, g.U, target, d.rot, k, GAP);
        U = r.U;
        slid = r.slid;
        if (slid && Math.hypot(U[0] - target[0], U[1] - target[1]) > 9) { const f = snapSticker(R.slab, R.region, rect, target, d.rot, k, GAP, 5); if (f) { U = f; slid = false; } }
      } else U = snapSticker(R.slab, R.region, rect, target, d.rot, k, GAP, 12); // onto a new face: the nearest free spot
      const st = { id: d.id, finish: d.finish, region: h.key, U: U || target, rot: d.rot, scale: d.scale };
      ghostRef.current = { ...st, ok: !!U };
      say(U ? (slid ? t('hh.sliding', 'Sliding along – it keeps clear of buttons, screens and the slot') : null) : refusal(st, R));
    } else if (!ghostRef.current?.ok || d.kind === 'new') {
      ghostRef.current = d.kind === 'new' ? null : ghostRef.current;
      if (h?.blocked) say(t('hh.shellOnlyHere', 'Stickers go on the shell – not on screens, buttons or the cartridge'));
    }
    syncStickers();
  }
  function up() {
    removeEventListener('pointermove', move);
    const d = drag.current, g = ghostRef.current;
    drag.current = null;
    ghostRef.current = null;
    if (!d || d.kind === 'orbit') { syncStickers(); return; }
    if (g?.ok) {
      const st = { id: g.id, finish: g.finish, region: g.region, U: g.U, rot: g.rot || 0, scale: g.scale || 1 };
      const list = [...stickers];
      if (d.kind === 'turn' || d.kind === 'size') { list[d.index] = st; setStk(list); setSel(d.index); } else if (d.kind === 'move') { list.splice(d.index, 1); list.push(st); setStk(list); setSel(list.length - 1); } else { setStk([...stickers, st]); setSel(stickers.length); }
    } else syncStickers();
  }
  const edit = (fn, key) => {
    if (sel < 0) return;
    const st = stickers[sel];
    const nx = fn(st);
    const U = refit(nx);
    if (!U) { say(nx.scale !== st.scale ? t('hh.noBigger', 'That is as big as it goes here') : nx.rot !== st.rot ? t('hh.noTurn', 'No room to turn it further here') : t('hh.noRoomShort', 'No room for that here')); return; }
    const list = [...stickers];
    list[sel] = { ...nx, U };
    setStk(list, key);
  };
  const nudge = (dx, dy) => { // the keyboard path: 1 mm (⇧ 5 mm) in the face's reading directions, sliding like a drag
    if (sel < 0 || !rects[stickers[sel].id]) return;
    const st = stickers[sel], R = regionsRef.current[st.region];
    const [fx, fy] = R.region.view || [1, 1];
    const r = slideSticker(R.slab, R.region, rects[st.id], st.U, [st.U[0] + dx * fx, st.U[1] + dy * fy], st.rot || 0, mmpp(st), GAP);
    const list = [...stickers];
    list[sel] = { ...st, U: r.U };
    setStk(list, 'nudge');
    say(r.slid ? t('hh.sliding', 'Sliding along – it keeps clear of buttons, screens and the slot') : null);
  };
  const setScale = (v) => edit((s) => ({ ...s, scale: Math.max(SCALE_MIN, Math.min(SCALE_MAX, v)) }), 'size');
  const turnBy = (r) => edit((s) => ({ ...s, rot: snapTurn((s.rot || 0) + r) }), 'turn');
  const remove = () => { if (sel < 0) return; setStk(stickers.filter((_, i) => i !== sel)); setSel(-1); };
  const restack = (top) => {
    if (sel < 0) return;
    const list = [...stickers];
    const [st] = list.splice(sel, 1);
    if (top) list.push(st); else list.unshift(st);
    setStk(list);
    setSel(top ? list.length - 1 : 0);
  };
  const onWheel = (e) => {
    e.preventDefault();
    const [x, y] = local(e);
    const i = hitSticker(sceneRef.current?.pick(x, y));
    if (i >= 0 && i === sel) { // over the selected sticker: turn it (⌥: size it)
      if (e.altKey) setScale((stickers[sel].scale || 1) * (e.deltaY > 0 ? 0.97 : 1.03));
      else turnBy(e.deltaY * 0.0035);
      return;
    }
    setOrbit((o) => ({ ...o, zoom: Math.max(0.7, Math.min(2.4, o.zoom * (e.deltaY > 0 ? 0.92 : 1.08))) }));
  };
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.('input, textarea, select')) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (sel < 0) return;
      const step = e.shiftKey ? 5 : 1;
      const k = e.key;
      if (k.startsWith('Arrow')) { e.preventDefault(); nudge(k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0, k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0); } else if (k === 'q' || k === 'Q' || k === 'e' || k === 'E') turnBy(((k.toLowerCase() === 'e' ? 1 : -1) * (e.shiftKey ? 1 : 5) * Math.PI) / 180);
      else if (k === '+' || k === '=') setScale((stickers[sel].scale || 1) + 0.05);
      else if (k === '-' || k === '_') setScale((stickers[sel].scale || 1) - 0.05);
      else if (k === ']') restack(true);
      else if (k === '[') restack(false);
      else if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); remove(); } else if (k === 'Escape' || k === 'Enter') { setSel(-1); if (k === 'Enter') say(t('hh.placed', 'Placed')); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });
  useEffect(() => { if (!hint) return undefined; const tm = setTimeout(() => setHint(null), hint.plus ? 6000 : 3200); return () => clearTimeout(tm); }, [hint]);
  useEffect(() => { if (!toast) return undefined; const tm = setTimeout(() => setToast(null), 6000); return () => clearTimeout(tm); }, [toast]);

  const changed = JSON.stringify(doc) !== opened.current;

  // ---- saved designs: a design = the skin + every device's stickers; putting one on dresses DS, GBA, 3DS and GB ----
  const designs = doc.designs;
  const active = designs.find((d) => d.id === doc.active) || null;
  const dirty = designDirty(doc);
  const own = { member, trophies: has };
  const full = () => (designMax < 2 ? plusHint(t('hh.designsOne', 'With Supporter you keep one saved design – save changes to it, or delete it. souldew+ keeps up to 12.'))
    : say(t('hh.designsFull', '{n} designs saved – delete or overwrite one first', { n: designMax })));
  const saveNew = () => {
    const next = saveAsNew(doc, { name: t('hh.designN', 'Design {n}', { n: designs.length + 1 }), max: designMax });
    if (!next) return full();
    commit(next);
    setRenaming(next.active);
  };
  const putOn = (d) => {
    if (d.id === doc.active && !dirty) return;
    commit(applyDesign(doc, d.id));
    setSel(-1);
    const n = designNotes(d, own);
    say(n.plus ? t('hh.notePlus', 'one souldew+ item shows as a preview – your launch plays the free parts|{count} souldew+ items show as a preview – your launch plays the free parts', { count: n.plus })
      : n.earned ? t('hh.noteEarned', 'one earned sticker you don’t have yet waits in the design – your launch leaves it out|{count} earned stickers you don’t have yet wait in the design – your launch leaves them out', { count: n.earned })
        : n.empty.includes(dk) ? t('hh.noteBare', 'No stickers on your {device} in this design – it plays bare', { device: devName(sys) }) : t('hh.noteOn', '“{name}” is on', { name: d.name }));
  };
  const rename = (id, name) => { setRenaming(null); const next = renameDesign(doc, id, name); if (next !== doc) commit(next); };
  const duplicate = (d) => { const next = duplicateDesign(doc, d.id, { copyName: (nm) => t('hh.copyOf', '{name} copy', { name: nm }), max: designMax }); if (!next) return full(); commit(next); return undefined; };
  const del = (d) => { const before = doc; commit(deleteDesign(doc, d.id)); setToast({ text: t('hh.deleted', 'Deleted “{name}”', { name: d.name }), undo: before }); };
  // Export / Import of the look as a small file (no sync in 3.0 – this is how it goes to another computer)
  const exportFile = () => {
    setMenu(false);
    const blob = new Blob([`${JSON.stringify(exportHandheld(doc), null, 1)}\n`], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'souldew-handheld.json' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  const importFile = async (file) => {
    if (!file) return;
    const next = importHandheld(await file.text());
    if (!next) { say(t('hh.importBad', 'That file isn’t a souldew handheld.')); return; }
    commit(next);
    setSel(-1);
    say(t('hh.imported', 'Imported – Undo puts back what was here'));
  };

  // ---- the filter row: All · ★ Favourites · Owned · souldew+ · Earned – over the skins and the stickers together ----
  const both = sheetItems(own);
  const isFav = (it) => isFavourite(favs, it.kind, it.id);
  const counts = sheetCounts(both, isFav);
  const chips = filterChips(counts);
  const filter = shownFilter(want, chips);
  const pass = (it) => sheetPass(it, filter, isFav);
  const skinsShown = both.filter((x) => x.kind === 'skin' && pass(x));
  const stickersShown = both.filter((x) => x.kind === 'sticker' && pass(x));
  const knownSkins = WRAPS.map((w) => w.id), knownStickers = STICKERS.map((s) => s.id), knownDesigns = designs.map((d) => d.id);

  const st = sel >= 0 ? stickers[sel] : null;
  const views = VIEWS[fold ? 'fold' : 'slab'];
  const viewNames = { lid: t('hh.viewLid', 'Lid'), open: t('hh.viewOpen', 'Open'), under: t('hh.viewUnder', 'Underside'), front: t('hh.viewFront', 'Front'), back: t('hh.viewBack', 'Back') };
  const previews = (wrapById(doc.skin)?.tier === 'plus' && !member) || stickers.some((s) => { const m = stickerById(s.id); return m && lockedWhy(m, s.finish) === 'plus'; });
  const curFin = st ? st.finish : finish;
  const finOk = (k) => !st || stickerById(st.id)?.finishes.includes(k);
  // the sheet's groups: free, the souldew+ ones in their two sets (cosy · funny and cool – 40 in one block would be a wall), earned
  const groupName = { free: t('hh.groupFree', 'Free'), 'plus-cosy': t('hh.groupPlusCosy', 'souldew+ · cosy'), 'plus-fun': t('hh.groupPlusFun', 'souldew+ · funny and cool'), earned: t('hh.groupEarned', 'Earned with trophies') };
  const pickSkin = (w) => {
    if (w && w.tier === 'plus' && !wrapReady(w.id)) { plusHint(t('hh.plusSkin', '{name} comes with souldew+.', { name: w.name })); return; }
    commit({ ...doc, skin: w ? w.id : null });
  };
  const tile = (s) => {
    const why = lockedWhy(s, 'vinyl'), R = rects[s.id];
    const src = stickerThumb(s.id);
    const mm = R ? `${Math.round(R.w * PX)} × ${Math.round(R.h * PX)} mm` : '';
    const title = [s.name, mm, s.tier === 'earned' ? t('hh.earnedByShort', 'earned by {trophy}', { trophy: trophyName(s.trophy) }) : ''].filter(Boolean).join(' · ');
    return html`<${FavScope} key=${s.id} kind="sticker" id=${s.id} name=${s.name} known=${knownStickers} class=${`hh-cell sz-${s.size}`}>
      <button type="button" class=${`hh-stk t-${s.tier} ${why ? `locked ${why}` : ''}`} title=${`${title} – ${t('hh.dragOrEnter', 'drag it onto the shell, or press Enter')}`}
        aria-label=${`${s.name}${mm ? `, ${mm}` : ''}${why === 'earned' ? `, ${t('hh.locked', 'locked')}` : why === 'plus' ? `, ${t('cos.plus', 'souldew+')}` : ''}`}
        onPointerDown=${(e) => startTray(e, s)} onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); placeNew(s); } }} onClick=${() => why === 'plus' && !R && canAdd(s)}>
        ${src ? html`<img src=${src} alt="" draggable="false" style=${R ? `width:${R.w * 1.55}px` : ''} />` : html`<span class="tiny faint">${s.name}</span>`}
        ${why === 'plus' && html`<span class="hh-stk-m"><${PlusMark} /></span>`}
        ${s.tier === 'earned' && html`<span class=${`hh-stk-e ${why ? 'off' : ''}`}>${why ? t('hh.locked', 'locked') : t('fav.earned', 'Earned')}</span>`}</button><//>`;
  };
  const designCard = (d) => {
    const sk = wrapById(d.skin), u = sk && (wrapThumb(sk.id) || previewSrc('wraps', sk.id)), n = designNotes(d, own), on = d.id === doc.active;
    const counts2 = DEVICE_TABS.map((id) => `${devName(id)} ${(d.stickers?.[id] || []).length || '–'}`).join(' ');
    const body = html`<span class="hhd-art" style=${u ? `background-image:url(${u})` : ''}>${(d.stickers?.[dk] || []).slice(0, 4).map((x) => { const s = stickerThumb(x.id, 3); return s && html`<img src=${s} alt="" />`; })}
        ${!(d.stickers?.[dk] || []).length && html`<span class="hhd-bare">${t('hh.noneOn', 'no stickers on {device}', { device: devName(sys) })}</span>`}</span>
      ${renaming === d.id ? html`<input class="hhd-name" value=${d.name} maxLength=${NAME_MAX} aria-label=${t('hh.designName', 'Design name')} ref=${(el) => el && !el.dataset.f && (el.dataset.f = '1', el.focus(), el.select())}
          onKeyDown=${(e) => { if (e.key === 'Enter') rename(d.id, e.target.value); if (e.key === 'Escape') setRenaming(null); }} onBlur=${(e) => rename(d.id, e.target.value)} />`
        : html`<b>${d.name}${on && dirty ? html`<span class="hhd-dirty" title=${t('hh.changedSince', 'Changed since you saved it')}> •</span>` : ''}</b>`}
      <span class="tiny faint hhd-sub">${sk ? sk.name : t('hh.themeColourCap', 'Theme colour')} · ${counts2}</span>
      ${(n.plus > 0 || n.earned > 0) && html`<span class="hhd-flags">${n.plus > 0 && html`<span class="hhd-flag"><${PlusMark} /> ${t('hh.nPreview', '{n} preview', { n: n.plus })}</span>`}${n.earned > 0 && html`<span class="hhd-flag e">${t('hh.nNotEarned', '{n} not earned yet', { n: n.earned })}</span>`}</span>`}`;
    return html`<${FavScope} key=${d.id} kind="design" id=${d.id} name=${d.name} known=${knownDesigns} class=${`hhd ${on ? 'on' : ''}`}>
      ${renaming === d.id ? html`<div class="hhd-main">${body}</div>` : html`<button type="button" class="hhd-main" onClick=${() => putOn(d)} aria-label=${t('hh.putOn', '{name}: put it on', { name: d.name })}>${body}</button>`}<//>`;
  };
  const finishRow = html`<div class="hh-fin" role="radiogroup" aria-label=${t('hh.finish', 'Finish')}>${Object.entries(FINISHES).map(([k, f]) => html`<button type="button" role="radio" aria-checked=${curFin === k} disabled=${!finOk(k)}
    class=${`hh-finb ${curFin === k ? 'on' : ''} f-${k}`} onClick=${() => {
      if (f.plus && !member) return plusHint(t('hh.plusFinish', '{name} comes with souldew+.', { name: finishName(k) }));
      return st ? edit((s) => ({ ...s, finish: k })) : setFinish(k);
    }}>${finishName(k)}${f.plus && !member ? html` <${PlusMark} />` : ''}</button>`)}</div>`;
  const done = () => navigate('settings', settingsLink('launch'));

  return html`<div class="pe hh is-open">
    <div class="pe-bar hh-bar"><nav class="hh-crumbs" aria-label=${t('hh.where', 'Where you are')}><a href=${`#/settings?s=play`}>${t('nav.settings', 'Settings')}</a><span>›</span><a href=${`#/settings?s=play`}>${t('set.secPlay', 'Play')}</a><span>›</span>
        <a href=${`#/settings?s=play&f=launch`}>${t('launch.title', 'Launch animation')}</a><span>›</span><b>${t('hh.title', 'Your handheld')}</b></nav>
      <span class="small muted grow pe-bar-hint">${changed ? t('hh.savedHere', 'Saved on this computer') : t('hh.barHint', 'Dress the device in your launch animation – only you see it')}</span>
      ${changed && html`<button type="button" class="btn ghost" onClick=${() => { commit(JSON.parse(opened.current)); setSel(-1); }}>${t('hh.backToStart', 'Back to how it was')}</button>`}
      <span class="hh-menu"><button type="button" class="btn ghost" aria-haspopup="menu" aria-expanded=${menu} title=${t('hh.more', 'More')} onClick=${() => setMenu(!menu)}>⋯</button>
        ${menu && html`<div class="hh-menu-pop" role="menu"><button type="button" role="menuitem" onClick=${exportFile}>${t('hh.export', 'Export this look as a file …')}</button>
          <button type="button" role="menuitem" onClick=${() => { setMenu(false); fileRef.current?.click(); }}>${t('hh.import', 'Import a look …')}</button></div>`}
        <input ref=${fileRef} type="file" accept="application/json,.json" class="hh-sr" tabIndex="-1" aria-hidden="true" onChange=${(e) => { importFile(e.target.files?.[0]); e.target.value = ''; }} /></span>
      <button type="button" class="btn primary" onClick=${done}>${t('hh.done', 'Done')}</button></div>
    <div class="pe-grid">
      <section class="hh-stagewrap" aria-label=${t('hh.stage', 'Your handheld in 3D')}>
        <div class="hh-cap"><span class="pe-kicker">${t('hh.asItPlays', 'Your {device} · as it plays when you start a game', { device: devName(sys) })}</span>
          <span class="tiny faint">${t('hh.gestures', 'Drag a sticker anywhere · {shift}-drag or the knob turns it · scroll over it to turn, {alt}-scroll to size · drag the rest to turn the device', { shift: IS_MAC ? '⇧' : 'Shift', alt: IS_MAC ? '⌥' : 'Alt' })}</span></div>
        <div class="hh-stage" ref=${stageRef} onPointerDown=${startCanvas} onWheel=${onWheel}>
          <div class="hh-ring" ref=${ring}>
            <i class="hh-knob turn" title=${t('hh.turnKey', 'Turn (Q / E)')} onPointerDown=${(e) => startTurn(e)}></i><i class="hh-knob size" title=${t('hh.sizeKey', 'Size (+ / −)')} onPointerDown=${(e) => startTurn(e, sel, 'size')}></i></div>
          <div class="hh-views" onPointerDown=${(e) => e.stopPropagation()}>
            ${Object.keys(views).map((k) => html`<button type="button" class=${`hh-view ${view === k ? 'on' : ''}`} onClick=${() => { setView(k); setOrbit({ yaw: 0, tilt: 0, zoom: 1 }); }}>${viewNames[k]}</button>`)}
          </div>
          <div class="hh-tools" onPointerDown=${(e) => e.stopPropagation()}>
            <button type="button" class="btn small ghost" disabled=${!hist.undo.length} onClick=${undo} title=${t('hh.undoKey2', 'Undo ({key})', { key: shortcut('Mod+Z') })}>${t('hh.undo', 'Undo')}</button>
            <button type="button" class="btn small ghost" disabled=${!hist.redo.length} onClick=${redo} title=${t('hh.redoKey2', 'Redo ({key})', { key: IS_MAC ? '⇧⌘Z' : 'Ctrl+Shift+Z' })}>${t('hh.redo', 'Redo')}</button>
          </div>
          <div aria-live="polite" class="hh-live">${toast ? html`<div class="hh-hint" role="status" onPointerDown=${(e) => e.stopPropagation()}>${toast.text}<button type="button" class="btn small ghost" onClick=${() => { commit(toast.undo); setToast(null); }}>${t('hh.undo', 'Undo')}</button></div>`
            : hint && html`<div class="hh-hint" role="status" onPointerDown=${(e) => e.stopPropagation()}>${hint.text}${hint.plus && html`<button type="button" class="btn small ghost" onClick=${() => openPlus({ reason: 'handheld' })}>${t('skin.whatsInPlus', 'What’s in souldew+')}</button>`}</div>`}</div>
          ${playing > 0 && html`<div class="hh-playover" onPointerDown=${(e) => e.stopPropagation()}><${LaunchPreview} key=${playing} cfg=${L} system=${sys} onDone=${() => setPlaying(0)} /></div>`}
          ${reduced && html`<div class="hh-rm tiny">${t('hh.reduced', 'Reduced motion: your launch is a short fade, but this is your device as it shows in it.')}</div>`}
        </div>
      </section>
      <aside class="pe-drawer hh-drawer" aria-label=${t('hh.title', 'Your handheld')}>
        <div class="hh-ptitle"><h2>${t('hh.title', 'Your handheld')}</h2><span class="small muted">${t('hh.onlyYou', 'In your launch animation – only you see it')}</span></div>
        <div class="pe-body hh-body">
          <a class="hh-variant" href="#/settings?s=play&f=launch"><span class="tiny faint">${t('launch.title', 'Launch animation')}</span><b>${lookName(lookId)}</b><span class="pe-chev"></span></a>
          <div class="hh-devs" role="tablist" aria-label=${t('hh.device', 'Handheld')}>${DEVICE_TABS.map((id) => html`<button type="button" role="tab" aria-selected=${sys === id} class=${`hh-dev ${sys === id ? 'on' : ''}`} onClick=${() => setSys(id)}>
            ${devName(id)}${(doc.stickers[id] || []).length ? html`<span class="hh-dev-n">${doc.stickers[id].length}</span>` : ''}</button>`)}</div>
          <p class="tiny faint hh-note">${t('hh.perDevice', 'Each handheld keeps its own stickers. The skin is one choice for all of them.')}</p>
          ${st && rects[st.id] && html`<div class="hh-selbox" aria-label=${t('hh.selected', 'The selected sticker')}>
            <img src=${stickerThumb(st.id, 4)} alt="" />
            <div class="hh-selt"><b>${stickerById(st.id)?.name}</b><span class="tiny faint">${finishName(st.finish)} · ${deg(st.rot || 0)}° · ${Math.round((st.scale || 1) * 100)} % · ${t('hh.stackPos', '{n} of {all} from the bottom', { n: sel + 1, all: stickers.length })}</span></div>
            <label class="hh-size"><span class="tiny faint">${t('hh.size', 'Size')}</span><input type="range" min=${SCALE_MIN * 100} max=${SCALE_MAX * 100} step="1" value=${Math.round((st.scale || 1) * 100)}
              onInput=${(e) => setScale(Number(e.target.value) / 100)} aria-label=${t('hh.size', 'Size')} /><span class="tiny">${Math.round((st.scale || 1) * 100)} %</span></label>
            <div class="hh-selb">
              <button type="button" class="btn small ghost" title=${t('hh.turnLeft', 'Turn left 5° (Q)')} onClick=${() => turnBy(-Math.PI / 36)}>⟲ 5°</button>
              <button type="button" class="btn small ghost" title=${t('hh.turnRight', 'Turn right 5° (E)')} onClick=${() => turnBy(Math.PI / 36)}>⟳ 5°</button>
              <button type="button" class="btn small ghost" title=${t('hh.frontKey', 'Bring to front (])')} disabled=${sel === stickers.length - 1} onClick=${() => restack(true)}>${t('hh.toFront', 'To front')}</button>
              <button type="button" class="btn small ghost" title=${t('hh.backKey', 'Send to back ([)')} disabled=${sel === 0} onClick=${() => restack(false)}>${t('hh.toBack', 'To back')}</button>
              <button type="button" class="btn small ghost" title=${t('hh.peelKey', 'Peel off (Delete)')} onClick=${remove}>${t('hh.peel', 'Peel off')}</button></div>
            <div class="hh-selfin">${finishRow}</div></div>`}

          <div class="hh-sec"><span class="pe-kicker">${t('hh.designs', 'Your designs')}</span><span class="tiny faint">${designs.length > designMax ? t('hh.designCount', 'one saved design|{count} saved designs', { count: designs.length })
            : t('hh.designsOf', '{n} of {max} · a design dresses all four', { n: designs.length, max: designMax })}</span></div>
          ${designs.length > designMax && html`<p class="tiny faint hh-note">${t('hh.designsKept', 'Your designs from souldew+ are kept. With Supporter you can save one – delete some to save a new one.')}</p>`}
          <div class="hhd-grid">${designs.map(designCard)}
            ${designs.length < designMax && html`<button type="button" class="hhd hhd-new" onClick=${saveNew}><span>+</span><b>${t('hh.saveLook', 'Save this look')}</b><span class="tiny faint">${t('hh.asNew', 'as a new design')}</span></button>`}</div>
          ${active && html`<div class="hhd-tools">
            ${dirty && html`<button type="button" class="btn small" onClick=${() => commit(overwriteDesign(doc))}>${t('hh.saveTo', 'Save changes to “{name}”', { name: active.name })}</button>`}
            <button type="button" class="btn small ghost" onClick=${saveNew} disabled=${designs.length >= designMax}>${t('hh.saveAsNew', 'Save as new')}</button>
            <button type="button" class="btn small ghost" onClick=${() => setRenaming(active.id)}>${t('hh.rename', 'Rename')}</button>
            <button type="button" class="btn small ghost" onClick=${() => duplicate(active)} disabled=${designs.length >= designMax}>${t('hh.duplicate', 'Duplicate')}</button>
            <button type="button" class="btn small ghost" onClick=${() => del(active)}>${t('hh.delete', 'Delete')}</button></div>`}
          ${R.surprise ? html`<label class="check small hhd-surprise"><input type="checkbox" checked=${!!doc.surprise} disabled=${designs.length < 2} onChange=${(e) => commit({ ...doc, surprise: e.target.checked })} />
            <span>${t('hh.surprise', 'Surprise me at start')}<span class="hint">${designs.length < 2 ? t('hh.surpriseHint0', 'Save two designs or more and every launch picks one of them.')
              : (favs.design || []).some((id) => designs.some((d) => d.id === id)) ? t('hh.surpriseHintFav', 'Every launch picks one of your designs at random – only your ★ ones.') : t('hh.surpriseHint', 'Every launch picks one of your designs at random.')}</span></span></label>`
            : html`<span class="tiny faint hh-note"><${PlusMark} /> ${t('hh.surprisePlus', 'Up to 12 designs and “Surprise me at start” come with souldew+.')}</span>`}

          <div class="hh-filters"><${FavFilter} chips=${chips} counts=${counts} value=${filter} onChange=${setFilter} /></div>
          ${filter === 'favs' && !counts.favs && html`<div class="hh-empty"><span class="hh-empty-star">☆</span><${FavEmpty} /></div>`}

          ${(skinsShown.length > 0 || filter === 'all' || filter === 'owned') && html`<div class="hh-sec"><span class="pe-kicker">${t('hh.skin', 'Skin')}</span><span class="tiny faint">${wrapById(doc.skin)
            ? `${wrapById(doc.skin).name} · ${wrapById(doc.skin).finish === 'gloss' ? t('hh.glossVinyl', 'gloss vinyl') : t('hh.satinVinyl', 'satin vinyl')}` : t('hh.themeColourCap', 'Theme colour')}</span></div>
          ${shellOnly && html`<p class="small hh-shellnote">${t('hh.shellOnly2', 'Your launch animation is {shell}: that shell takes no skin, but your stickers go on it. The skin you pick shows with “Your colours” and Holo label.', { shell: lookName(lookId) })}</p>`}
          <div class=${`hh-skins ${shellOnly ? 'muted-skins' : ''}`}>
            ${(filter === 'all' || filter === 'owned') && html`<div class="hh-cell"><button type="button" class=${`hh-skin none ${!doc.skin ? 'on' : ''}`} onClick=${() => pickSkin(null)}><span class="hh-skin-art"></span><b>${t('cos.none', 'None')}</b><span class="tiny faint">${t('hh.themeColourCap', 'Theme colour')}</span></button></div>`}
            ${skinsShown.map((w) => { const u = wrapThumb(w.id) || previewSrc('wraps', w.id); return html`<${FavScope} key=${w.id} kind="skin" id=${w.id} name=${w.name} known=${knownSkins} class="hh-cell"><button type="button" class=${`hh-skin ${doc.skin === w.id ? 'on' : ''} ${w.finish}`} onClick=${() => pickSkin(w)}>
              <span class="hh-skin-art" style=${u ? `background-image:url(${u})` : ''}>${shellOnly && html`<span class="hh-skin-not">${look === 'gold' ? t('hh.notOnGold', 'Not on Gold') : t('hh.notOnClear', 'Not on Clear')}</span>`}</span><b>${w.name}</b>
              <span class="tiny faint">${w.finish === 'gloss' ? t('hh.gloss', 'Gloss') : t('hh.satin', 'Satin')}${w.tier === 'free' ? ` · ${t('hh.free', 'free')}` : !member ? html` <${PlusMark} />` : ''}</span></button><//>`; })}
          </div>`}

          ${(stickersShown.length > 0 || filter === 'all') && html`<div class="hh-sec"><span class="pe-kicker">${t('hh.stickers', 'Stickers')}</span><span class=${`tiny ${stickers.length >= STICKER_MAX ? 'hh-full' : 'faint'}`}>${t('hh.nOf', '{n} of {max} on your {device}', { n: stickers.length, max: STICKER_MAX, device: devName(sys) })}</span></div>
          ${!st && html`<p class="tiny faint hh-note">${t('hh.howTo', 'Drag a sticker onto the shell – anywhere, over the edges too, on top of each other. It slides round buttons, screens and the slot. Or pick one and press Enter.')}</p>`}
          ${!st && finishRow}`}
          ${groupStickers(stickersShown).map(({ key, list }) => html`<div class="hh-tgroup" data-group=${key}><span class="tiny faint">${groupName[key]} · ${list.length}</span></div>
            <div class="hh-tray">${list.map(tile)}</div>`)}

          <div class="hh-sec"><span class="pe-kicker">${t('hh.earnedTitle', 'Earned, not bought')}</span><span class="tiny faint">${t('hh.earnedOf', '{n} of {all}', { n: UNLOCKS.filter((u) => has.has(u.trophy)).length, all: UNLOCKS.length })}</span></div>
          <div class="hh-earn">${UNLOCKS.map((u) => { const ok = has.has(u.trophy); const thumb = u.kind === 'sticker' ? stickerThumb(u.id, 4) : null; return html`<div class=${`hh-earn-row ${ok ? 'ok' : 'off'}`}>
            ${u.kind === 'banner' ? html`<span class="hh-earn-b" style=${`background-image:url(${bannerThumb()})`}></span>` : thumb ? html`<img class="hh-earn-s" src=${thumb} alt="" />` : html`<span></span>`}
            <span class="hh-earn-t"><b>${u.name}${u.kind === 'banner' ? html` <span class="tiny faint">· ${t('hh.aBanner', 'a banner')}</span>` : ''}</b><span class=${`tiny ${ok ? 'faint' : ''}`}>${ok ? t('hh.earnedByT', 'Earned by {trophy}', { trophy: trophyName(u.trophy) }) : `${trophyName(u.trophy)}: ${trophyHow(u.trophy)}`}</span></span>
            <span class=${`hh-earn-k ${ok ? 'ok' : ''}`}>${ok ? t('hh.yours', 'Yours') : t('hh.locked', 'locked')}</span></div>`; })}</div>
          ${previews && html`<div class="hh-lock"><${PlusMark} /><span class="small">${t('hh.previewNote', 'souldew+ items show here as a preview. Your launch plays only what you own.')}</span></div>`}
        </div>
        <div class="hh-foot"><span class="small muted">${t('hh.footer', 'Only you see your handheld: in your own launch animation. It isn’t on your profile.')}</span>
          <button type="button" class="btn" onClick=${() => setPlaying((n) => n + 1)}>▶ ${t('hh.playMine', 'Play my launch')}</button></div>
      </aside>
    </div>
  </div>`;
}

