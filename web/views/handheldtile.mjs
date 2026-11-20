// "Your handheld" where you meet it (the owner's decision after round 6: under Settings alone it gets lost):
//   HandheldTile      a compact tile in the library's header – a small still of your device in its current design and
//                     the design's name; a click opens the editor (#/handheld). Supporter and souldew+ only (the 3D
//                     launch is theirs): a free library carries no ad. A Supporter's quiet "+" says more skins and
//                     stickers come with souldew+.
//   HandheldShowcase  the souldew+ page's featured section – your device, live and turning slowly, the skins and
//                     stickers; with Supporter or souldew+ "Dress your handheld" (and souldew+'s Surprise me). For
//                     everyone else it is the showcase: the one place a free account sees the handheld. The editor
//                     itself stays in Settings › Play › Launch animation.
//   HandheldStillImg  one still of your handheld (the launch scene, rendered once, then the GPU is let go).
import { html, useEffect, useRef, useState } from '/vendor/htm-preact.mjs';
import { t } from '../lib/i18n.mjs';
import { useApp } from '../lib/ui.mjs';
import { packState } from '../lib/cosmetics/index.mjs';
import { PlusMark } from '../lib/cosmetics/components.mjs';
import { prefersReduced } from '../lib/cosmetics/motion.mjs';
import { previewSrc, usePreviews } from '../lib/cosmetics/previews.mjs';
import { WRAPS, STICKERS, UNLOCKS, wrapById, devKey, playableLookFor, launchLook } from '/shared/handheld.mjs';
import { showcaseSkin, showcaseState } from '../lib/handheld/pluspicks.mjs';
import { useHandheld, setHandheld, handheldStill, launchConfig, poseScene, viewPlan, isFold, useCosmeticsTick, useLaunchRights, ownedLook, sceneWrap, previewWrap } from '../lib/handheld/look.mjs';
import { placeLayout } from '../lib/handheld/geometry.mjs';
import { atlasNow, loadAtlas } from '../lib/handheld/stickers.mjs';
import { wrapThumb } from '../lib/handheld/wrap.mjs';

const DEV = ['gba', 'nds', '3ds', 'gb'];

/** A still of your handheld as an <img> (cached per look while the app runs). */
export function HandheldStillImg({ sys, look, skin, stickers, w, h, view, zoom, cartLook, clear, class: cls = '' }) {
  useCosmeticsTick();
  const box = useRef(null);
  const [url, setUrl] = useState(null);
  const [, setAtlas] = useState(null);
  useEffect(() => { let a = true; loadAtlas().then((x) => a && setAtlas(x), () => {}); return () => { a = false; }; }, [packState().entitled]);
  useEffect(() => {
    let alive = true;
    handheldStill({ sys, look, skin, stickers, w, h, el: box.current, view, zoom, cartLook, clear }).then((u) => alive && setUrl(u), () => {});
    return () => { alive = false; };
  }, [sys, look, skin, JSON.stringify(stickers), w, h, view, cartLook, clear, packState().entitled, atlasNow() ? 1 : 0]);
  return html`<span class=${`hh-still ${cls}`} ref=${box}>${url ? html`<img src=${url} alt="" draggable="false" />` : html`<span class="hh-still-wait"></span>`}</span>`;
}

/** What the handheld wears, in a few words: the worn design's name, else the skin's, else "your theme colour". */
function wearing(doc, R) {
  const d = doc.designs.find((x) => x.id === doc.active);
  if (R.surprise && doc.surprise && doc.designs.length > 1) return t('hh.surpriseShort', 'Surprise me · {n} designs', { n: doc.designs.length });
  if (d) return d.name;
  const w = wrapById(doc.skin);
  return (w && (w.tier === 'free' || R.plus) ? w.name : null) || t('hh.themeColourCap', 'Theme colour');
}

/** The library header's tile. `system`: the device to show (the game you play most recently), DS without one. */
export function HandheldTile({ system }) {
  const { navigate, status } = useApp();
  const doc = useHandheld();
  const R = useLaunchRights();
  if (!R.three) return null; // free: the 2D launch – no handheld in the library (it is on the souldew+ page)
  const sys = devKey(system) || 'nds';
  const L = launchConfig(status?.config);
  const look = launchLook(playableLookFor(L.look, R)).look;
  const own = ownedLook(doc, R); // what this account wears now – a kept souldew+ skin or sticker waits (the launch plays the same)
  return html`<button type="button" class="hh-tile" onClick=${() => navigate('handheld', { sys })} title=${t('hh.dress', 'Dress your handheld')}>
    <${HandheldStillImg} sys=${sys} look=${look} skin=${own.skin} stickers=${own.stickers[sys] || []} w=${84} h=${52} zoom=${2.6} class="hh-tile-pic" />
    <span class="hh-tile-txt"><span class="hh-tile-k">${t('hh.title', 'Your handheld')}${!R.plus && html` <${PlusMark} title=${t('hh.plusQuiet', 'More skins and stickers come with souldew+')} />`}</span>
      <b class="ellipsis">${wearing(doc, R)}</b></span>
  </button>`;
}

/** The souldew+ page's featured section: your device turning slowly – put any skin on it, the way into the editor. */
export function HandheldShowcase() {
  useCosmeticsTick();
  usePreviews();
  const { navigate } = useApp();
  const doc = useHandheld();
  const R = useLaunchRights();
  const member = R.plus;
  const [sys, setSys] = useState('nds');
  const box = useRef(null), cvs = useRef(null);
  // Supporter / souldew+: their own stickers on it; free: a clean device (their kept handheld waits for a membership)
  const own = R.three ? ownedLook(doc, R) : { skin: null, stickers: {} };
  const worn = own.skin;
  const [pick, setPick] = useState(() => showcaseSkin(worn));
  const stickers = own.stickers[sys] || [];
  // a skin this account can't draw (a souldew+ one without the pack): its public preview picture on the device
  const real = !pick || !!sceneWrap(pick);
  const [prev, setPrev] = useState(null); // { id, data } – data: previewWrap() or null (no picture)
  useEffect(() => {
    if (real) return undefined;
    let alive = true;
    previewWrap(pick).then((d) => alive && setPrev({ id: pick, data: d }));
    return () => { alive = false; };
  }, [pick, real, previewSrc('wraps', pick || '')]);
  const preview = !real && prev?.id === pick ? prev.data : null;
  const drawn = real ? pick : preview ? pick : null; // what the device wears on screen
  useEffect(() => {
    let alive = true, scene = null, raf = 0, io = null, seen = true;
    const reduced = prefersReduced();
    const fold = isFold(sys);
    const yaw = { v: fold ? -10 : -24 };
    const cv = document.createElement('canvas'); // one per build (a WebGL context belongs to its canvas)
    (async () => {
      const b = box.current.getBoundingClientRect();
      // the skins are the point here: always "Your colours" (a Gold or Clear shell takes no skin)
      const r = await poseScene(cv, { sys, look: 'theme', skin: real ? pick : null, preview: real ? null : preview, w: Math.round(b.width), h: Math.round(b.height), el: box.current, reduced,
        plan: () => viewPlan(sys, fold ? 'lid' : 'back', { yaw: yaw.v, tilt: fold ? 4 : 2, zoom: 1.45 }) });
      scene = r.scene;
      if (!alive) { scene.dispose(); return; }
      scene.setStickers(placeLayout(stickers, scene.regions(), r.atlas?.rects || {}));
      scene.render(0);
      cvs.current?.replaceChildren(cv); // the new build takes the old one's place once it has drawn (no blank frame)
      if (reduced) return;
      io = new IntersectionObserver((es) => { seen = es.some((e) => e.isIntersecting); });
      io.observe(box.current);
      const t0 = performance.now();
      let last = 0;
      const tick = (now) => { // slow: a full turn in about 40 s, drawn at 30 fps, never while off screen
        if (!alive) return;
        if (seen && now - last > 32) { last = now; yaw.v = (fold ? -10 : -24) + ((now - t0) / 1000) * 9; scene.render(now - t0); }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    })().catch(() => {});
    return () => { alive = false; cancelAnimationFrame(raf); io?.disconnect(); scene?.dispose(); };
  }, [sys, drawn, real ? 1 : 0, preview, JSON.stringify(stickers), packState().entitled]);
  const skins = [{ id: null, name: t('hh.themeColourCap', 'Theme colour'), tier: 'free', finish: 'theme', pic: null }, ...WRAPS.map((w) => ({ ...w, pic: wrapThumb(w.id) || previewSrc('wraps', w.id) }))];
  const cur = skins.find((x) => x.id === (pick || null)) || skins[0];
  const st = showcaseState(cur.id, R, worn);
  const plusPreview = cur.tier === 'plus' && !member;
  const nPlus = STICKERS.filter((s) => s.tier === 'plus').length;
  const wear = () => setHandheld({ ...doc, skin: cur.id || null });
  return html`<section class="plus-sec hh-show" aria-label=${t('hh.title', 'Your handheld')}>
    <div class="hh-show-stage" ref=${box}><span class="hh-show-cv" ref=${cvs}></span>
      ${plusPreview && html`<span class="hh-show-badge" role="status"><${PlusMark} title="" />${t('hh.showPreview', 'souldew+ · preview')}</span>`}
      <div class="hh-devs hh-show-devs" role="tablist" aria-label=${t('hh.device', 'Handheld')}>${DEV.map((id) => html`<button type="button" role="tab" aria-selected=${sys === id}
        class=${`hh-dev ${sys === id ? 'on' : ''}`} onClick=${() => setSys(id)}>${{ gba: 'GBA', nds: 'DS', '3ds': '3DS', gb: 'GB' }[id]}</button>`)}</div></div>
    <div class="hh-show-text stack-s">
      <span class="plus-kicker">${t('hh.showK', 'Your handheld')}</span>
      <h2>${t('hh.showT', 'Dress the device your games start on')}</h2>
      <p class="small muted">${t('hh.showP3', 'The 3D launch animation plays on your own souldew handheld. Wrap it in a skin, stick on up to 8 stickers per device and save designs. Only you see it. Pick a skin to see it on the device.')}</p>
      <div class="hh-show-skins" role="radiogroup" aria-label=${t('hh.skins', 'Skins')}>${skins.map((w) => html`<button type="button" role="radio" key=${w.id || 'theme'} aria-checked=${w === cur}
        aria-label=${`${w.name}${w.tier === 'plus' ? ` · ${t('cos.plus', 'souldew+')}` : ''}`} title=${w.name}
        class=${`hh-show-skin ${w.finish} ${w === cur ? 'on' : ''} ${w.id ? '' : 'theme'}`} style=${w.pic ? `background-image:url(${w.pic})` : ''} onClick=${() => setPick(w.id)}>
        ${w.tier === 'plus' && !member ? html`<span class="hh-show-skin-m"><${PlusMark} title="" /></span>` : w.tier === 'free' && w.id ? html`<i>${t('hh.free', 'free')}</i>` : null}</button>`)}</div>
      <div class="hh-show-cur" aria-live="polite"><b>${cur.name}</b>
        <span class="small muted">${st === 'yours' ? t('hh.showWorn', 'on your handheld now')
          : plusPreview ? (preview || real ? t('hh.showPlusSkin', 'a souldew+ skin – this is a preview, nothing changes on your handheld') : t('hh.showNoPreview', 'a souldew+ skin – its preview can’t be loaded right now'))
            : !cur.id ? t('hh.showTheme', 'your theme’s accent colour, no skin')
              : cur.tier === 'free' ? t('hh.showFreeSkin', 'free with Supporter and souldew+') : t('hh.showYours', 'yours with souldew+')}</span>
        ${st === 'owned' && html`<button type="button" class="btn small" onClick=${wear}>${t('hh.showWear', 'Put it on my handheld')}</button>`}
        ${plusPreview && html`<button type="button" class="btn small ghost" onClick=${() => document.getElementById('plus-tiers')?.scrollIntoView({ behavior: prefersReduced() ? 'auto' : 'smooth' })}>${t('hh.showGet', 'Get souldew+')}</button>`}</div>
      <span class="small faint">${t('hh.showCounts', '{skins} skins · {stickers} stickers · {earned} you can only earn', { skins: WRAPS.length, stickers: STICKERS.length, earned: UNLOCKS.length })}${member ? '' : ` · ${t('hh.showPlus', '{n} stickers, 6 skins and holo / glitter come with souldew+', { n: nPlus })}`}</span>
      ${R.three ? html`<div class="row hh-show-btns"><button type="button" class="btn primary" onClick=${() => navigate('handheld', { sys })}>${t('hh.dress', 'Dress your handheld')}</button>
        ${R.surprise && html`<label class="check small"><input type="checkbox" checked=${!!doc.surprise} disabled=${doc.designs.length < 2} onChange=${(e) => setHandheld({ ...doc, surprise: e.target.checked })} />
          <span>${t('hh.surprise', 'Surprise me at start')}<span class="hint">${doc.designs.length < 2 ? t('hh.surpriseHint0', 'Save two designs or more and every launch picks one of them.') : t('hh.surpriseHint', 'Every launch picks one of your designs at random.')}</span></span></label>`}</div>`
        : html`<p class="small hh-show-tier">${t('hh.showFree', 'The 3D launch with your own handheld comes with Supporter or souldew+. Without them, your games start with the cartridge sliding into the console.')}</p>
          <span class="small faint">${t('hh.earnedFree', 'The three earned stickers come with a hard trophy – they show in the 3D launch, with Supporter or souldew+.')}</span>`}
    </div>
  </section>`;
}
