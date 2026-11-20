// The Thank you page's logic (views/thanks.mjs): the live feed – asked when the page opens, then every minute while it
// is visible, never while hidden – the copy kept on this computer for offline ("as of …"), who is new since the last
// look, the tiers as the page shows them, and when to ask a new supporter (once) whether they want to appear.
// No DOM here except what is passed in, so the tests drive it with fake timers and a fake storage.

/** The wall's tiers, highest first (API.md §13; "legend" is the patron tier). */
export const THANKS_TIERS = ['legend', 'plus', 'supporter', 'coffee'];
export const POLL_MS = 60000;
const RANK = { coffee: 1, supporter: 2, plus: 3, legend: 4 };
const CACHE_KEY = 'sl-thanks';
const ASKED_KEY = 'sl-thanks-asked:';

const safeStorage = () => {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
};

/** The last wall this computer saw: { thanks, version, fetchedAt } or null. Storage can be gone or full – never throws. */
export function loadCachedThanks(storage = safeStorage()) {
  try {
    const v = JSON.parse(storage?.getItem(CACHE_KEY) || 'null');
    return v && v.thanks && Array.isArray(v.thanks.people) && v.thanks.counts ? v : null;
  } catch {
    return null;
  }
}
export function saveCachedThanks(entry, storage = safeStorage()) {
  try {
    storage?.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // full or blocked: the page still works, only offline it has nothing to show
  }
}

/**
 * The tiers the page shows, highest first, only those with supporters: { tier, people, count, more } – `more` are the
 * ones who count but aren't named (nobody is named without saying yes).
 */
export function tierGroups(thanks) {
  if (!thanks?.counts) return [];
  return THANKS_TIERS.map((tier) => {
    const people = (thanks.people || []).filter((p) => p.tier === tier);
    const count = Math.max(Number(thanks.counts[tier]) || 0, people.length);
    return { tier, people, count, more: count - people.length };
  }).filter((g) => g.count > 0);
}

/** Named people who weren't on `prev` – or are in a higher tier now (Lena went from souldew+ to Legend). */
export function arrivals(prev, next) {
  if (!prev?.people || !next?.people) return [];
  const before = new Map(prev.people.map((p) => [p.name, p.tier]));
  return next.people.filter((p) => !before.has(p.name) || RANK[p.tier] > RANK[before.get(p.name)]).map((p) => ({ name: p.name, tier: p.tier }));
}

/** "2026-11" → a Date for that month (or null). */
export function sinceDate(since) {
  const m = typeof since === 'string' && /^(\d{4})-(\d{2})$/.exec(since);
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 15)) : null;
}

/**
 * The live feed. load(have) → the local server's answer (/api/account/thanks?have=…): { thanks, version, fetchedAt,
 * stale } or { unchanged: true, … }; it throws offline. onUpdate(state) gets { thanks, fetchedAt, stale, error, fresh,
 * arrivals } after every change. visibility: { hidden() → bool, on(fn) → off } (document.visibilityState). Timers can be
 * faked. Only while the page is visible: a hidden page asks nothing, and when it comes back it asks at once if the last
 * answer is older than `every`.
 */
export function createThanksFeed({ load, onUpdate, cached = null, every = POLL_MS, visibility = documentVisibility(), timers = globalThis, now = Date.now, save = saveCachedThanks } = {}) {
  const state = { thanks: cached?.thanks || null, fetchedAt: cached?.fetchedAt || null, stale: !!cached, error: null, fresh: false, arrivals: [] };
  let version = cached?.version || null;
  let timer = null;
  let lastTry = 0;
  let stopped = false;
  let busy = false;
  let live = false; // a wall from the service was shown in this visit (arrivals are only announced after that)
  const emit = () => onUpdate?.({ ...state });

  function schedule(ms) {
    timers.clearTimeout(timer);
    timer = null;
    if (stopped || visibility.hidden()) return;
    timer = timers.setTimeout(tick, Math.max(0, ms));
  }

  async function tick() {
    if (stopped || busy) return;
    if (visibility.hidden()) return;
    busy = true;
    lastTry = now();
    try {
      const r = await load(version);
      if (stopped) return;
      if (r?.unchanged) {
        state.arrivals = [];
      } else if (r?.thanks) {
        state.arrivals = live ? arrivals(state.thanks, r.thanks) : [];
        state.thanks = r.thanks;
        version = r.version || null;
        save({ thanks: r.thanks, version, fetchedAt: r.fetchedAt || now() });
      }
      state.fetchedAt = r?.fetchedAt || state.fetchedAt || now();
      state.stale = !!r?.stale;
      state.error = null;
      state.fresh = !r?.stale;
      live = live || !!state.thanks;
    } catch (e) {
      if (stopped) return;
      state.arrivals = [];
      state.stale = true;
      state.fresh = false;
      state.error = e?.code || e?.message || 'offline';
    } finally {
      busy = false;
    }
    emit();
    schedule(every);
  }

  const off = visibility.on(() => {
    if (stopped) return;
    if (visibility.hidden()) {
      timers.clearTimeout(timer);
      timer = null;
    } else schedule(every - (now() - lastTry));
  });

  return {
    start() {
      emit();
      tick();
    },
    stop() {
      stopped = true;
      timers.clearTimeout(timer);
      off?.();
    },
    /** For tests: whether a next ask is planned. */
    get planned() {
      return timer !== null;
    },
  };
}

/** document.visibilityState as the feed wants it (a page outside a browser counts as visible). */
export function documentVisibility(doc = globalThis.document) {
  return {
    hidden: () => doc?.visibilityState === 'hidden',
    on: (fn) => {
      doc?.addEventListener?.('visibilitychange', fn);
      return () => doc?.removeEventListener?.('visibilitychange', fn);
    },
  };
}

// ---- asking once ----------------------------------------------------------------------------------------------------

/** This computer already asked this account (or the answer couldn't be saved yet) – never ask again here. */
export function askedHere(accountId, storage = safeStorage()) {
  try {
    return !!accountId && storage?.getItem(ASKED_KEY + accountId) === '1';
  } catch {
    return false;
  }
}
export function rememberAsked(accountId, storage = safeStorage()) {
  try {
    if (accountId) storage?.setItem(ASKED_KEY + accountId, '1');
  } catch {
    // blocked storage: the service's answer (show_on_thanks no longer null) still stops the question
  }
}

/**
 * Ask a supporter whether they want to appear: signed in, a live support (thanksTier – any paid tier, or a coffee
 * that was claimed), never answered (showOnThanks null), not asked on this computer before, and not now if the player is
 * busy (a game, onboarding, another dialog). A service without the wall sends no thanksTier: never asked.
 */
export function shouldAskThanks({ signedIn, me, askedBefore = false, busy = false }) {
  if (!signedIn || !me?.id || busy || askedBefore) return false;
  if (!THANKS_TIERS.includes(me.thanksTier)) return false;
  return me.privacy?.showOnThanks === null;
}
