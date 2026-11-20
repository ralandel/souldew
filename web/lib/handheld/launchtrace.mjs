// An opt-in trace of the launch animation's frame timing (views/launchstage.mjs): every frame's rAF timestamp with the
// animation's own time, the long tasks and the long animation frames (with the scripts Chromium blames for them) from
// the stage's mount to the hand-over and a moment after it – so a hitch can be put on the thing that caused it.
// Off unless asked for: localStorage `sl-launch-trace` = '1' (or globalThis.__launchTrace = true). Read the last one
// from launchStats.last.trace (launchstage.mjs) – recordings and scripts only, never shown, never sent.

/** Is the trace asked for? (never throws: a page without storage simply has none) */
export function traceWanted() {
  try {
    return globalThis.__launchTrace === true || globalThis.localStorage?.getItem('sl-launch-trace') === '1';
  } catch {
    return false;
  }
}

/** max, p99 and the counts over 20 / 33 ms of frame intervals (ms) – the numbers a hitch is judged by */
export function frameStats(intervals) {
  const v = intervals.filter((x) => Number.isFinite(x) && x >= 0);
  if (!v.length) return { n: 0, max: 0, p99: 0, over20: 0, over33: 0, mean: 0 };
  const s = [...v].sort((a, b) => a - b);
  const p99 = s[Math.min(s.length - 1, Math.ceil(s.length * 0.99) - 1)];
  const r1 = (x) => Math.round(x * 10) / 10;
  return { n: v.length, max: r1(s[s.length - 1]), p99: r1(p99), over20: v.filter((x) => x > 20).length, over33: v.filter((x) => x > 33).length, mean: r1(v.reduce((a, b) => a + b, 0) / v.length) };
}

/**
 * Start a trace at `t0` (performance.now() of the stage's mount). Returns { anim(now, t, note), mark(what), end(after,
 * done) }, or null when it isn't wanted. Its own rAF loop keeps every frame of the page from the mount until `after` ms
 * past end() (the hand-over into the game); anim() notes the animation's frames (its time, a hold, a resize).
 */
export function startTrace(t0) {
  if (!traceWanted()) return null;
  const rel = (x) => Math.round((x - t0) * 10) / 10;
  const frames = []; // every rAF of the page: ms since mount
  const anim = []; // the animation's frames: [ms since mount, animation ms, note, ms the frame's own work took]
  const marks = [];
  const tasks = [];
  const loafs = [];
  const obs = [];
  const watch = (type, fn) => {
    try {
      const o = new PerformanceObserver((l) => l.getEntries().forEach(fn));
      o.observe({ type, buffered: false });
      obs.push([o, fn]);
    } catch {
      // (an engine without this entry type)
    }
  };
  watch('longtask', (e) => tasks.push([rel(e.startTime), Math.round(e.duration)]));
  watch('long-animation-frame', (e) => loafs.push({
    at: rel(e.startTime), dur: Math.round(e.duration), block: Math.round(e.blockingDuration || 0),
    render: Math.round(e.renderStart ? e.startTime + e.duration - e.renderStart : 0),
    style: Math.round(e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0),
    scripts: (e.scripts || []).filter((x) => x.duration >= 1).map((x) => ({ d: Math.round(x.duration), inv: x.invoker, src: (x.sourceURL || '').replace(/^.*?\/\/[^/]+/, ''), fn: x.sourceFunctionName || '', at: x.sourceCharPosition, win: x.windowAttribution })),
  }));
  let raf = 0;
  const loop = (now) => { frames.push(rel(now)); raf = requestAnimationFrame(loop); };
  raf = requestAnimationFrame(loop);
  let ended = false;
  return {
    anim(now, t, note = '', work = 0) { anim.push([rel(now), Math.round(t), note, Math.round(work * 10) / 10]); },
    mark(what) { marks.push([what, rel(performance.now())]); },
    end(after, done) {
      if (ended) return;
      ended = true;
      marks.push(['end', rel(performance.now())]);
      setTimeout(() => {
        cancelAnimationFrame(raf);
        for (const [o, fn] of obs) { try { o.takeRecords().forEach(fn); o.disconnect(); } catch { /* gone */ } }
        const gaps = (list) => list.slice(1).map((f, i) => f - list[i]);
        const endAt = marks.find((m) => m[0] === 'end')[1];
        const animStart = anim.length ? anim[0][0] : endAt;
        done({
          origin: Math.round(performance.timeOrigin + t0), // the mount on the wall clock (to line up other pages' timings)
          frames, anim, marks, tasks, loafs,
          stats: {
            anim: frameStats(gaps(anim.map((f) => f[0]))), // the animation's own frames
            setup: frameStats(gaps(frames.filter((f) => f <= animStart))), // the page's frames before its first one
            handoff: frameStats(gaps(frames.filter((f) => f >= endAt - 200))), // the last 200 ms and `after` ms of the game
            all: frameStats(gaps(frames)),
          },
        });
      }, after);
    },
  };
}
