// "Fast-forward is held back by the 3DS resolution" – noticed once and explained in the play view (support ticket #30).
//
// The built-in 3DS player can draw the games at 2× or 3× their own resolution (Settings › Play › 3DS resolution). At
// normal speed that is cheap on most graphics cards, but fast-forward draws every frame at that size too: a Windows
// player's RTX 2060 (Ultra Moon, 3×, Vulkan) reached only 1.1–3.3× of the 4× asked for, with gaps in the sound, while
// an AMD test PC still reached 3.99× at 3×. It depends on the graphics card, and players don't know the resolution
// costs fast-forward speed – so the play view watches fast-forward at more than 1× resolution and, when it stays
// clearly below the request, says once what helps. It never changes the resolution itself.
//
// Plain logic without DOM types: test/ffhint.test.mjs.

export const FF_HINT = {
  /** A sample counts as held back below this share of the speed asked for (2.8× of 4×). */
  SHARE: 0.7,
  /** How long fast-forward must stay held back before the hint (ms). */
  SUSTAIN_MS: 10000,
  /** Of the samples in that window, at least this share must be held back (a short good stretch doesn't undo it, many do). */
  MOST: 2 / 3,
  /** Samples right after fast-forward starts (or the request changes) don't count yet: the host and its sound settle. */
  SETTLE_MS: 3000,
  /**
   * Below this real speed the game is loading or stalls (a new area, a save, the HOME menu between titles) – not drawing
   * too much: the window starts over. (The ticket's player never went below 1.1×.)
   */
  MIN_REAL: 0.5,
  /** A gap between samples longer than this (paused, the window hidden, the page busy) starts the window over. */
  MAX_GAP_MS: 4500,
};

/** Shown in this app session already (shared by every game started until the app closes). */
export const ffHintSession = { shown: false };

export class FfScaleWatch {
  /**
   * @param {object} [o]
   * @param {{ shown: boolean }} [o.session] once per session: ffHintSession (tests pass their own)
   * @param {Partial<typeof FF_HINT>} [o.limits]
   */
  constructor({ session = ffHintSession, limits = {} } = {}) {
    this.session = session;
    this.lim = { ...FF_HINT, ...limits };
    this.reset();
  }

  /** Start over: fast-forward stopped or changed, paused, hidden, another game. */
  reset() {
    this.samples = [];
    this.since = null;
    this.target = null;
  }

  /**
   * One measurement. `at` ms, `target` the speed asked for (1 = no fast-forward, Infinity = "Max": no request to fall
   * short of), `reached` the real speed over the last interval, `scale` the resolution the game runs with now, `off`
   * Settings / "Don't show again". Returns { target, reached, scale } once per session when fast-forward has stayed held
   * back for SUSTAIN_MS, else null.
   */
  add({ at, target, reached, scale, off = false }) {
    const L = this.lim;
    if (off || this.session.shown || !(scale > 1) || !(target > 1) || !Number.isFinite(target) || !Number.isFinite(at)) {
      this.reset();
      return null;
    }
    if (!Number.isFinite(reached) || reached < 0) return null; // (nothing measured – no verdict either way)
    const prev = this.samples.at(-1);
    if (target !== this.target || reached < L.MIN_REAL || (prev && at - prev.at > L.MAX_GAP_MS) || (prev && at < prev.at)) {
      this.reset();
      if (reached < L.MIN_REAL) return null;
      this.target = target;
    }
    this.since ??= at;
    if (at - this.since < L.SETTLE_MS) return null;
    this.samples.push({ at, share: reached / target, reached });
    // keep just enough to cover the window: the oldest sample at least SUSTAIN_MS back
    while (this.samples.length > 1 && at - this.samples[1].at >= L.SUSTAIN_MS) this.samples.shift();
    if (at - this.samples[0].at < L.SUSTAIN_MS) return null;
    const n = this.samples.length;
    const mean = this.samples.reduce((s, x) => s + x.share, 0) / n;
    const held = this.samples.filter((x) => x.share < L.SHARE).length;
    if (mean >= L.SHARE || held < n * L.MOST) return null;
    this.session.shown = true;
    const avg = this.samples.reduce((s, x) => s + x.reached, 0) / n;
    this.reset();
    return { target, reached: Math.round(avg * 10) / 10, scale };
  }
}
