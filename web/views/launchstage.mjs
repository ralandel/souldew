// The 3.0 launch animation in the play view (design rounds 4–6): your souldew handheld in 3D – the DS / 3DS unfolds, the
// GBA / GB turns, the card or cartridge drops in and latches, the screens power on and the camera pushes into them; the
// last frame is the play view's own screen rectangle(s), pixel for pixel, and the real game is under it (a match-cut).
//
// It runs NEXT TO the game's start, never before it: play.mjs starts the emulator at once, as without an animation; this
// stage only covers the screen area (.session-screen – never the dock, the bar or the sidebar) and decides when the
// game's picture is uncovered. Its set-up waits for the game's first frame (≤ 300 ms), so it costs the start nothing. The device's screens show the game's own picture while it runs (the fast and the 3DS
// player draw it so it can be read), else a dark panel. When the animation reaches its hand-over before the game's first
// frame, it holds there until the frame is in. Silent – the game's sound is never touched. A click, any key or a resize
// ends it at once. Reduced motion: one still of the device that cross-fades into the game (0.8 s). Off: not mounted.
import { html, useEffect, useLayoutEffect, useRef } from '/vendor/htm-preact.mjs';
import { layoutKey, LAYOUTS } from '../lib/handheld/layouts.mjs';
import { placeholderCanvas } from '../lib/handheld/placeholder.mjs';
import { prefersReduced } from '../lib/cosmetics/motion.mjs';
import { launchLook, devKey, RARE_ODDS } from '/shared/handheld.mjs';
import { loadScene, lookNow, sceneWrap, shellColor, CLEAR, playableLook, launchRightsNow, paidLooks, previewConfig } from '../lib/handheld/look.mjs';
import { placeLayout } from '../lib/handheld/geometry.mjs';
import { coverOf } from './library.mjs';
import { startTrace } from '../lib/handheld/launchtrace.mjs';
import { warmAudio, afterHandover, settle, budgetFor } from '../lib/handheld/steady.mjs';

/** The picture on the cartridge's label: the player's own cover first, then the catalog's (a hack: its base game). */
export function insertCover(library, target, manifest) {
  if (target.runId) return coverOf(library, { gameId: target.gameId || manifest?.game?.id, hackId: manifest?.game?.hackId || manifest?.patch?.hackId });
  const rom = library?.roms?.find((r) => r.id === target.params?.rom);
  const hackId = target.params?.patch ? library?.patches?.find((p) => p.id === target.params.patch)?.hackId : null;
  return coverOf(library, { gameId: target.gameId, hackId, rom });
}

const rnd = (i, s = 1) => { const x = Math.sin(i * 127.1 + s * 311.7) * 43758.5453; return x - Math.floor(x); };
const lum = (c) => { const m = (c.match(/[\d.]+/g) || [0, 0, 0]).map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; };
const mix = (a, b, k) => {
  const pa = a.match(/\w\w/g).map((x) => parseInt(x, 16));
  const pb = b.match(/\w\w/g).map((x) => parseInt(x, 16));
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * k).toString(16).padStart(2, '0')).join('')}`;
};
function bgOf(el) {
  for (let e = el; e; e = e.parentElement) {
    const c = getComputedStyle(e).backgroundColor;
    if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c;
  }
  return 'rgb(20,20,24)';
}

/** The game's own picture, when its player draws it so it can be read (the fast player, the 3DS player) and it has the
 * layout's shape – else null (the device's screens show a dark panel and the game appears at the hand-over). */
function liveCanvas(frame, L) {
  try {
    const c = frame?.contentDocument?.getElementById('screen');
    if (!c || c.tagName !== 'CANVAS' || !c.width || !c.height) return null;
    return Math.abs(c.width / c.height - L.W / L.H) / (L.W / L.H) < 0.03 ? c : null;
  } catch {
    return null;
  }
}

/** How long the set-up waits for the game's first frame before it builds anyway (a slow start: a DS / 3DS game). */
const BUILD_WAIT = 300;

/** Measurements of the last launch (set-up, frames; `trace` with the opt-in trace, lib/handheld/launchtrace.mjs) – for
 * the recordings and diagnostics. */
export const launchStats = { last: null, trace: null };

/**
 * cfg: launchConfig(status.config). target: the session's target (system). frame: the game's iframe ref. ready: the
 * core's first frame is there. cover / cartColor: the cartridge's label. onDone: the stage can go.
 */
export function LaunchStage({ cfg, system, dsLayout, ctrLayout, frame, ready, cover, cartColor, title, picture = null, onDone }) {
  const root = useRef(null);
  const live = useRef({ ready, onDone });
  live.current = { ready, onDone };
  const traced = useRef(null);
  useEffect(() => { if (ready) traced.current?.mark('game ready'); }, [ready]);

  useLayoutEffect(() => {
    const el = root.current;
    const host = el.parentElement; // .session-screen
    const cs = host.querySelector('.console-screen');
    const mounted = performance.now();
    const marks = [];
    const trace = startTrace(mounted);
    traced.current = trace;
    if (live.current.ready) trace?.mark('game ready');
    let alive = true;
    let scene = null;
    let raf = 0;
    const anims = [];
    const finish = () => {
      if (!alive) return;
      alive = false;
      cancelAnimationFrame(raf);
      for (const a of anims) a.cancel();
      if (cs) cs.style.opacity = '';
      removeEventListener('keydown', finish, true);
      removeEventListener('resize', finish);
      // the scene is freed once the game's picture is up – not on the hand-over's frame (steady.mjs)
      const gone = scene;
      scene = null;
      if (gone) afterHandover(() => gone.dispose());
      trace?.end(600, (tr) => { launchStats.trace = tr; });
      live.current.onDone?.();
    };
    // the play view's screen waits under the stage (its black box must not flash before the device is there)
    if (cs) cs.style.opacity = '0';
    addEventListener('keydown', finish, true);
    addEventListener('resize', finish);
    el.__skip = finish;

    (async () => {
      const sys = system === 'gbc' ? 'gbc' : system;
      const lk = layoutKey(system, dsLayout || 'tb', ctrLayout || 'tb');
      const L = LAYOUTS[lk];
      const reduced = prefersReduced();
      const quick = cfg.pace === 'quick';
      // what the membership allows right now (shared/handheld.mjs launchRights): a Supporter plays "Your colours" with the
      // free skin and stickers and the look on the device (no Surprise me); the Rare start is souldew+'s, automatic
      const rights = launchRightsNow();
      const lookId = playableLook(cfg.look, rights);
      const V = launchLook(lookId);
      // the souldew+ looks' data (Gold's light, the Rare start's) comes with the verified pack – without it there is none
      const LK = paidLooks();
      const rare = !reduced && rights.rare && !!LK?.rare && Math.random() < 1 / RARE_ODDS;
      const look = lookNow(Math.random, rights);
      const wrap = V.look === 'theme' ? sceneWrap(look.skin) : null;
      // the browser's audio service starts now, while nothing moves yet – not with the game's sound under the device
      // (steady.mjs warmAudio; once the play view's first picture is painted). A preview has no game: no sound to warm.
      if (!picture) {
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
        if (!alive) return;
        if (warmAudio()) trace?.mark('audio warmed');
      }
      // The set-up (≈ 100 ms of script and the GPU's shader work) waits for the game's first frame, at most BUILD_WAIT ms:
      // the player page loads in the same thread and on the same GPU, and measured on an M1 every millisecond of set-up
      // inside its start showed up in the game's first frame (GBA 160 → 300 ms). Waiting, the game starts exactly as
      // without the animation; the device fades in a moment later (a fast GBA game: ≈ 0.25 s after the click).
      const t1 = performance.now();
      while (alive && !live.current.ready && performance.now() - t1 < BUILD_WAIT) await new Promise((r) => setTimeout(r, 15));
      const { S, atlas } = await loadScene();
      if (!alive) return;
      const box = host.getBoundingClientRect();
      const r = cs.getBoundingClientRect();
      const w = Math.round(box.width), h = Math.round(box.height);
      if (w < 80 || h < 80) return finish();
      const final = { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height };
      const shell = shellColor(host);
      const dark = lum(bgOf(host)) < 0.35;
      const dev = S.DEVICES[sys] || S.DEVICES.gb;
      const fold = dev.kind === 'fold';
      const pace = S.PACES.r6;
      const plan = reduced ? S.stillPlan(dev, fold) : fold ? S.foldPlan(quick, dev, pace) : S.turnPlan(quick, dev, pace);
      const pulse = rare ? LK.rare.pulse : V.look === 'gold' && LK?.gold ? LK.gold.pulse : wrap ? mix(wrap.skin.pulse, '#fff6e6', 0.55) : mix(shell, '#fff6e6', 0.72);
      scene = await S.createScene(el.querySelector('canvas'), {
        sys, lk, w, h, final, dark, look: V.look, looks: LK, shell, cartLook: V.cart, cartColor, cover, title,
        clearTint: CLEAR[cfg.clear] || CLEAR.atomic, pulse, glow: rare ? LK.rare.glow : '#dfe8ff', warm: rare, plan: plan.plan,
        picture: picture || (() => liveCanvas(frame?.current, L)), atlas, pixelBudget: budgetFor(V.look),
        warmAt: reduced ? [] : [plan.L + 40, plan.power[0] + 200, plan.H0 - 120, plan.H0],
        hh: { skin: wrap?.skin || null, recipe: wrap?.recipe || null, reduced },
        yieldTo: () => new Promise((r) => setTimeout(r, 0)), mark: (what) => { marks.push([what, Math.round(performance.now() - mounted)]); trace?.mark(what); },
      });
      if (!alive) { scene?.dispose(); scene = null; return; }
      scene.setStickers(placeLayout(look.stickers[devKey(system)] || [], scene.regions(), atlas?.rects || {}));
      const setup = performance.now() - mounted;
      const T = plan.T;
      el.classList.toggle('dark', dark);
      el.classList.toggle('rare', rare);

      // ---- the DOM light layers, placed from the scene's camera (all on one clock with the scene) ----
      const anim = (node, keys, easing = 'linear') => {
        if (!node) return;
        const a = node.animate(keys.map(([ms, css, e]) => ({ ...css, offset: Math.max(0, Math.min(1, ms / T)), easing: e || easing })), { duration: T, fill: 'both' });
        a.pause();
        anims.push(a);
      };
      if (!reduced) {
        const [sx, sy] = scene.project(plan.L, 'slot');
        const ppm = scene.scaleAt(Math.max(0, plan.L));
        const ring = el.querySelector('.l3d-ring'), flash = el.querySelector('.l3d-flash'), flood = el.querySelector('.l3d-flood');
        const R = 190 * ppm;
        Object.assign(ring.style, { left: `${sx}px`, top: `${sy}px`, width: `${2 * R}px`, height: `${2 * R}px`, margin: `${-R}px 0 0 ${-R}px` });
        ring.style.setProperty('--rc', pulse);
        anim(ring, [[0, { opacity: 0, transform: 'scale(.12)' }], [plan.L, { opacity: 0, transform: 'scale(.12)' }, 'cubic-bezier(.1,.7,.25,1)'],
          [plan.L + 60, { opacity: 0.9, transform: 'scale(.42)' }, 'cubic-bezier(.2,.6,.3,1)'], [plan.L + 620, { opacity: 0, transform: 'scale(1.25)' }]]);
        const F = 70 * ppm;
        Object.assign(flash.style, { left: `${sx}px`, top: `${sy}px`, width: `${2 * F}px`, height: `${2 * F}px`, margin: `${-F}px 0 0 ${-F}px` });
        flash.style.setProperty('--rc', pulse);
        anim(flash, [[0, { opacity: 0, transform: 'scale(.4)' }], [plan.L - 4, { opacity: 0, transform: 'scale(.4)' }, 'cubic-bezier(.1,.8,.3,1)'],
          [plan.L + 26, { opacity: 1, transform: 'scale(1)' }, 'cubic-bezier(.3,0,.5,1)'], [plan.L + 300, { opacity: 0, transform: 'scale(1.3)' }]]);
        // the screens' light floods the room, following the top screen across the camera move
        const b0 = plan.power[0];
        const pts = [];
        for (let t = b0; t <= T; t += 50) pts.push([t, scene.project(t, 'screen')]);
        const G = Math.max(w, h) * 0.75;
        Object.assign(flood.style, { width: `${2 * G}px`, height: `${2 * G}px`, margin: `${-G}px 0 0 ${-G}px` });
        const pos = (t) => { const q = pts.reduce((a, b) => (Math.abs(b[0] - t) < Math.abs(a[0] - t) ? b : a), pts[0])[1]; return `translate(${q[0].toFixed(1)}px, ${q[1].toFixed(1)}px)`; };
        anim(flood, [[0, { opacity: 0, transform: pos(b0) }], [b0 + 40, { opacity: 0, transform: pos(b0 + 40) }, 'cubic-bezier(.2,.7,.3,1)'],
          [b0 + 160, { opacity: 1, transform: pos(b0 + 160) }], ...pts.filter(([t]) => t > b0 + 160 && t < plan.H0).map(([t]) => [t, { opacity: Math.max(0.42, 1 - (t - b0 - 160) / 900), transform: pos(t) }]),
          [plan.H0, { opacity: 0.35, transform: pos(plan.H0) }, 'cubic-bezier(.4,0,.6,1)'], [T, { opacity: 0, transform: pos(T) }]]);
        // souldew+: glints round the device on the latch (Rare start), one on the label (Holo), and light dust (Rare start)
        el.querySelectorAll('.l3d-glint').forEach((g, i) => {
          if (!(rare || (V.cart === 'holo' && LK?.holo && i === 0))) return;
          const d = i === 0 ? 20 : 30 + i * 42;
          const [gx, gy] = scene.anchors(plan.L + d + 60)[i] || [sx, sy];
          const sz = (i === 0 ? 36 : 16 + rnd(i, 5) * 14) * Math.max(0.6, ppm / 2.4);
          Object.assign(g.style, { left: `${gx}px`, top: `${gy}px`, width: `${sz}px`, height: `${sz}px`, margin: `${-sz / 2}px 0 0 ${-sz / 2}px` });
          anim(g, [[0, { opacity: 0, transform: 'scale(.2) rotate(0deg)' }], [plan.L + d, { opacity: 0, transform: 'scale(.2) rotate(0deg)' }, 'cubic-bezier(.2,.8,.3,1)'],
            [plan.L + d + 70, { opacity: 1, transform: 'scale(1) rotate(30deg)' }, 'ease-in'], [plan.L + d + 260, { opacity: 0, transform: 'scale(.3) rotate(70deg)' }]]);
        });
        if (rare) {
          el.querySelectorAll('.l3d-mote').forEach((m, i) => {
            const dx = (rnd(i, 7) - 0.5) * 120 * ppm, dy = -(50 + rnd(i, 8) * 90) * ppm;
            const d = rnd(i, 9) * 160;
            const sz = 2 + rnd(i, 11) * 3;
            Object.assign(m.style, { left: `${sx + (rnd(i, 12) - 0.5) * 30 * ppm}px`, top: `${sy}px`, width: `${sz}px`, height: `${sz}px` });
            anim(m, [[0, { opacity: 0, transform: 'translate(0,0)' }], [plan.L + d, { opacity: 0, transform: 'translate(0,0)' }, 'cubic-bezier(.1,.6,.3,1)'],
              [plan.L + d + 90, { opacity: 1, transform: `translate(${dx * 0.3}px, ${dy * 0.35}px)` }, 'cubic-bezier(.3,.3,.4,1)'], [plan.L + d + 780, { opacity: 0, transform: `translate(${dx}px, ${dy}px)` }]]);
          });
        }
        // the focus pull at the start
        anim(el.querySelector('.l3d-lens'), quick ? [[0, { filter: 'blur(0px)' }], [T, { filter: 'blur(0px)' }]]
          : [[0, { filter: 'blur(9px)' }, 'cubic-bezier(.25,.6,.3,1)'], [330, { filter: 'blur(0px)' }], [T, { filter: 'blur(0px)' }]]);
      }
      // the hand-over: the play view's screen is there under the canvas, the canvas leaves
      if (cs) {
        cs.style.opacity = '';
        anim(cs, reduced ? [[0, { opacity: 0 }], [450, { opacity: 0 }, 'cubic-bezier(.4,0,.6,1)'], [750, { opacity: 1 }], [T, { opacity: 1 }]]
          : [[0, { opacity: 0 }], [plan.H0 - 1, { opacity: 0 }], [plan.H0, { opacity: 1 }], [T, { opacity: 1 }]]);
      }
      const lens = el.querySelector('.l3d-lens');
      lens.style.opacity = '';
      anim(lens, reduced ? [[0, { opacity: 1 }], [450, { opacity: 1 }, 'cubic-bezier(.4,0,.6,1)'], [750, { opacity: 0 }], [T, { opacity: 0 }]]
        : [[0, { opacity: 1 }], [plan.H0, { opacity: 1 }, 'cubic-bezier(.4,0,.6,1)'], [T - 10, { opacity: 0 }], [T, { opacity: 0 }]]);

      // ---- the clock: one for the scene and the layers. At the hand-over it waits for the game's first frame. ----
      const hold = reduced ? 400 : plan.H0;
      const geo = { w, h, f: final };
      let t0 = null; // the clock starts on the first frame that shows (not before render(0) below)
      let held = 0;
      const frames = [];
      let prev = 0;
      const tick = (now) => {
        if (!alive) return;
        const w0 = trace ? performance.now() : 0;
        if (t0 === null) t0 = prev = now;
        let t = now - t0;
        let note = '';
        if (t >= hold && !live.current.ready && held < 20000) { // the game isn't there yet: the lit panel holds
          held += now - prev;
          t0 += now - prev;
          t = hold;
          note = 'hold';
        }
        frames.push(now - prev);
        prev = now;
        // the play view's layout may still settle (the dock, the bar): the last frame must land on the screen as it is
        const b2 = host.getBoundingClientRect(), r2 = cs.getBoundingClientRect();
        const W2 = Math.round(b2.width), H2 = Math.round(b2.height);
        if (W2 !== geo.w || H2 !== geo.h) { geo.w = W2; geo.h = H2; scene.resize(W2, H2); note += ' resize'; }
        const f2 = { x: r2.left - b2.left, y: r2.top - b2.top, w: r2.width, h: r2.height };
        if (Math.abs(f2.x - geo.f.x) + Math.abs(f2.y - geo.f.y) + Math.abs(f2.w - geo.f.w) + Math.abs(f2.h - geo.f.h) > 0.5) { geo.f = f2; scene.setFinal(f2); note += ' final'; }
        t = Math.min(T, t);
        scene.render(t);
        for (const a of anims) a.currentTime = t;
        if (trace) { // a shader built on this frame (renderer.info: the programs three.js holds)
          const np = scene.renderer.info.programs?.length || 0, nt = scene.renderer.info.memory?.textures || 0;
          if (np > programs) note += ` +${np - programs} program (${scene.renderer.info.programs.slice(programs).map((q) => q.name || String(q.cacheKey).slice(0, 60)).join(' / ')})`;
          if (nt > textures) note += ` +${nt - textures} texture`;
          programs = np;
          textures = nt;
          trace.anim(now, t, note.trim(), performance.now() - w0);
        }
        if (t >= T) {
          const at = scene.screensAt(plan.H0);
          const r4 = (q) => [q.x, q.y, q.w, q.h].map((v) => Math.round(v * 10) / 10);
          launchStats.last = { system, look: lookId, pace: cfg.pace, reduced, rare, setup: Math.round(setup), marks, T, held: Math.round(held), frames, final: r4(geo.f), landed: r4(at) };
          finish();
          return;
        }
        raf = requestAnimationFrame(tick);
      };
      scene.render(0);
      for (const a of anims) a.currentTime = 0;
      trace?.mark('first render');
      // the clock waits for the first frames to come in time (the GPU's first-use work – the device is invisible at t = 0)
      const calm = settle(performance.now());
      const steady = (now) => {
        if (!alive) return;
        if (calm.step(now)) {
          trace?.mark('settled');
          raf = requestAnimationFrame(tick);
          return;
        }
        scene.render(0);
        raf = requestAnimationFrame(steady);
      };
      let programs = scene.renderer.info.programs?.length || 0, textures = scene.renderer.info.memory?.textures || 0;
      raf = requestAnimationFrame(steady);
    })().catch((e) => {
      console.warn('launch animation', e);
      finish(); // no WebGL, a module that didn't load …: the game simply shows
    });
    return () => {
      if (alive) { live.current.onDone = null; finish(); }
    };
  }, []);

  return html`<div class="l3d" ref=${root} aria-hidden="true" onClick=${() => root.current?.__skip?.()}>
    <div class="l3d-fx back"><span class="l3d-flood"></span><span class="l3d-ring"></span></div>
    <div class="l3d-lens"><canvas class="l3d-canvas"></canvas></div>
    <div class="l3d-fx front"><span class="l3d-flash"></span>
      ${[0, 1, 2, 3, 4, 5, 6].map((i) => html`<span class="l3d-glint" key=${`g${i}`}></span>`)}
      ${[...Array(16)].map((_, i) => html`<span class="l3d-mote" key=${`m${i}`}></span>`)}</div>
  </div>`;
}

/**
 * The launch as a preview (Settings, the editor's "Play my launch", the souldew+ page): a small play area with a screen
 * in the game's shape showing the neutral placeholder picture, and the stage over it. cfg: launchConfig() or the config
 * itself (previewConfig); Off plays Full.
 */
export function LaunchPreview({ cfg, system, onDone }) {
  const lk = layoutKey(system, 'tb', 'tb');
  const L = LAYOUTS[lk];
  const ref = useRef(null);
  useEffect(() => {
    const src = placeholderCanvas(lk);
    const cv = ref.current;
    cv.width = src.width;
    cv.height = src.height;
    cv.getContext('2d').drawImage(src, 0, 0);
  }, [lk]);
  return html`<div class="hhs-prev"><div class="console-screen hhs-prev-cs" style=${`--arn:${L.W / L.H}`}><canvas ref=${ref}></canvas></div>
    <${LaunchStage} cfg=${previewConfig(cfg)} system=${system} ready picture="placeholder" title="souldew" onDone=${onDone} /></div>`;
}
