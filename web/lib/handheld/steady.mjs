// What keeps the launch animation's frames even (views/launchstage.mjs, scene.mjs) – each one measured in the real app
// with the opt-in trace (launchtrace.mjs), M1, Emerald and a DS game in the fast player:
//
// - glassCoat: the glass's clearcoat fades as the camera pushes in. three.js builds a material's shader with clearcoat
//   only while clearcoat > 0, so the fade reaching 0 swapped the glass to a new program in the middle of the push –
//   compiled on the main thread on that frame (60–85 ms, the hitch right before the hand-over). It stops a hair above 0:
//   the same program to the end, the coat no one can see.
// - warmAudio: the first AudioContext in the app's process starts the browser's audio service and waits for it on the
//   main thread (≈ 240 ms on an M1). The game's player made that first one – while the device faded in. The stage makes
//   (and closes) one in its set-up, before anything moves; the player's own then takes ≈ 1 ms. Silent: nothing is
//   connected to it.
// - pixelRatioFor: the camera's push-in fills the canvas with the shell's physical plastic (clearcoat, sheen, the soft
//   shadows; the Clear shell's transmission on top), drawn with MSAA – at the Retina's 2× in a 1280 × 800 window that
//   is ≈ 2.1 million pixels a frame and the GPU fell behind in the last half second (33–67 ms frames, never on the main
//   thread). The launch draws at most PIXEL_BUDGET pixels (1.5× in that window: every frame in time; the device
//   moves, the eye doesn't miss the rest); never below 1×. The Clear shell, drawn twice, has a smaller one.
// - Settle: the first frames of a new WebGL scene still do first-use work on the GPU (pipelines, uploads) – one took
//   450 ms, and the device jumped from its first frame into the middle of its fade-in. The clock starts only once two
//   frames in a row came in time (the device is still invisible then), or after SETTLE_MAX ms.
// - afterHandover: freeing the scene (its programs, textures and WebGL context: ≈ 50–60 ms) ran on the hand-over's frame;
//   now it runs once the game's picture is up, in a moment the page is idle.

/** the glass's clearcoat for the glass fade k (0 → 1): never 0, so its shader never changes during the launch */
export const GLASS_COAT = 0.35;
export const GLASS_COAT_MIN = 0.002;
export const glassCoat = (k) => Math.max(GLASS_COAT_MIN, GLASS_COAT * (1 - (Number.isFinite(k) ? Math.min(1, Math.max(0, k)) : 0)));

/** pixels a frame the launch's canvas may draw (device pixels) */
export const PIXEL_BUDGET = 1.25e6;
/** the Clear shell draws everything behind its plastic once more (three.js's transmission pass): a smaller budget –
 * measured with a DS game, its frames came at 33–35 ms with the full one, in time with this */
export const CLEAR_BUDGET = 0.55 * PIXEL_BUDGET;
/** the launch look's budget ('theme' | 'gold' | 'clear', shared/handheld.mjs launchLook().look) */
export const budgetFor = (look) => (look === 'clear' ? CLEAR_BUDGET : PIXEL_BUDGET);
/** the canvas's pixel ratio for w × h css px on a dpr screen: ≤ 2, ≤ the budget, ≥ 1 (or the screen's own, if lower) */
export function pixelRatioFor(w, h, dpr = 1, budget = PIXEL_BUDGET) {
  const d = Math.min(2, dpr > 0 && Number.isFinite(dpr) ? dpr : 1);
  if (!(w > 0 && h > 0)) return d;
  return Math.max(Math.min(1, d), Math.min(d, Math.round(Math.sqrt(budget / (w * h)) * 100) / 100));
}

/** how long the clock waits at most for the first frames to come in time */
export const SETTLE_MAX = 600;
/**
 * Settle(start): step(now) on every frame before the clock starts – true once two frame intervals in a row were ≤ `ok`
 * ms, or SETTLE_MAX ms after start.
 */
export function settle(start, { ok = 25, max = SETTLE_MAX } = {}) {
  let last = start, calm = 0;
  return {
    step(now) {
      calm = now - last <= ok ? calm + 1 : 0;
      last = now;
      return calm >= 2 || now - start >= max;
    },
  };
}

let audioWarm = false;
/**
 * Start the browser's audio service now (a closed, unconnected AudioContext), once per page. Returns true when it made
 * one. `AC` for the tests.
 */
export function warmAudio(AC = globalThis.AudioContext || globalThis.webkitAudioContext) {
  if (audioWarm || typeof AC !== 'function') return false;
  audioWarm = true;
  try {
    const c = new AC();
    Promise.resolve(c.close?.()).catch(() => {});
    return true;
  } catch {
    return false; // no audio device: the game's player copes with that on its own
  }
}
/** (tests) forget that the audio was warmed */
export const resetAudioWarm = () => { audioWarm = false; };

/**
 * Run fn after the hand-over: two frames on (the game's picture is on screen), then when the page is idle (at most
 * `within` ms later). `env` for the tests: { raf, idle, timeout }.
 */
export function afterHandover(fn, within = 500, env = globalThis) {
  const raf = env.requestAnimationFrame?.bind(env) || ((f) => env.setTimeout(f, 16));
  const idle = env.requestIdleCallback ? (f) => env.requestIdleCallback(f, { timeout: within }) : (f) => env.setTimeout(f, 50);
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  raf(() => raf(() => idle(run)));
  return run; // (call it to run now: the page is going away)
}
