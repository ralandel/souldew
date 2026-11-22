// The souldew account on the page: one shared store (signed in or not, the own profile, the pending counters) fed by
// the local server (/api/account – server/lib/accounts/index.mjs), plus the friends and invite lists while a screen
// shows them. The page never holds a token: every call goes to the local server, which talks to the service.
// Signed out, nothing here polls or reports anything.
import { useState, useEffect, useRef } from '/vendor/htm-preact.mjs';
import { api } from './api.mjs';
import { openExternal } from './ui.mjs';
import { ACCENTS } from '/shared/social.mjs';

// loaded: the local server answered once. known: its answer is final – the server has read the saved sign-in
// (session.loaded). Until then "signed out" only means "not read yet" (the keychain may still be asking), and nothing
// may act on it: no souldew+ pack is removed, no "signed out" decision is made (cosmeticsPackAccess waits for it).
let state = { loaded: false, known: false, session: { signedIn: false, persistent: true, condition: null, pending: false, account: null }, me: null, pending: null, service: '' };
let inflight = null;
let again = null; // a reload asked for while one was on its way – its answer may be older than what changed
let recheck = 0;
const RECHECK_MS = 1000;
const subs = new Set();
const knownSubs = new Set();
const notify = () => {
  subs.forEach((fn) => fn(state));
  if (state.known) for (const fn of [...knownSubs]) fn(state);
};
const set = (patch) => {
  state = { ...state, ...patch };
  notify();
};

/** Ask the local server again (signed in? the own profile, the counters). */
export function reloadAccount() {
  if (inflight) {
    // the server told us something changed after this request left: one more, once it is back
    again ||= inflight.then(() => {
      again = null;
      return reloadAccount();
    });
    return again;
  }
  inflight = api.get('/api/account').then((r) => {
    // a server without the flag (older) has read it before it answered
    set({ loaded: true, known: r.session?.loaded !== false, session: r.session, me: r.me, brief: r.brief, pending: r.pending, service: r.service });
    return state;
  }).catch(() => {
    set({ loaded: true }); // no answer: still not known
    return state;
  }).finally(() => {
    inflight = null;
    // the server tells the page when it has read the saved sign-in (event 'account'); the event stream may not be
    // connected yet then (or reconnecting), so ask again now and then while it isn't known
    clearTimeout(recheck);
    if (!state.known && typeof setTimeout === 'function') {
      recheck = setTimeout(() => reloadAccount(), RECHECK_MS);
      recheck?.unref?.();
    }
  });
  return inflight;
}

/** Whether the account is known (the server has read the saved sign-in) – "signed out" is final only then. */
export const accountKnown = () => !!state.known;
/** Resolves (with the state) once the account is known; asks the server if nobody has yet. */
export function whenAccountKnown() {
  if (state.known) return Promise.resolve(state);
  return new Promise((resolve) => {
    const fn = (s) => {
      knownSubs.delete(fn);
      resolve(s);
    };
    knownSubs.add(fn);
    if (!inflight && !recheck) reloadAccount();
  });
}

export const accountState = () => state;
/** fn(state) whenever the account store changes (signed in or out, the verified tier); returns the unsubscribe. */
export function onAccount(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
export const signedIn = () => !!state.session?.signedIn;

/** The account store, loaded the first time it is used. */
export function useAccount() {
  const [s, setS] = useState(state);
  useEffect(() => {
    subs.add(setS);
    if (!state.loaded) reloadAccount();
    else setS(state);
    return () => subs.delete(setS);
  }, []);
  return s;
}

// ---- events from the local server (app.mjs passes them on from its event stream) ------------------------------------
const pendingSubs = new Set();
/** fn(pending) whenever the service's counters (friend requests, invites, join requests) change. */
export function onPending(fn) {
  pendingSubs.add(fn);
  return () => pendingSubs.delete(fn);
}
const signInSubs = new Set();
/** fn() when the browser handed a sign-in back (Settings shows "You're signed in"). */
export function onSignedIn(fn) {
  signInSubs.add(fn);
  return () => signInSubs.delete(fn);
}
export function accountEvent(p) {
  if (p?.kind === 'pending') {
    set({ pending: p.pending });
    pendingSubs.forEach((fn) => fn(p.pending));
  } else {
    reloadAccount().then(() => {
      if (p?.kind === 'signed-in') signInSubs.forEach((fn) => fn());
    });
  }
}

// ---- actions --------------------------------------------------------------------------------------------------------
export async function signIn() {
  const r = await api.post('/api/account/login');
  // the desktop app opened the system browser itself; the browser build opens a tab
  if (!r.opened) openExternal(r.url);
  await reloadAccount();
  return r;
}
export const cancelSignIn = () => api.post('/api/account/login/cancel').finally(reloadAccount);
export async function signOut(everywhere = false) {
  const r = await api.post('/api/account/logout', { everywhere });
  await reloadAccount();
  return r;
}
export async function updateMe(patch) {
  const me = await api.patch('/api/account/me', patch);
  set({ me });
  return me;
}
export async function setHandle(handle) {
  const me = await api.put('/api/account/handle', { handle });
  set({ me });
  return me;
}
export async function newFriendCode() {
  const me = await api.post('/api/account/friend-code');
  if (me) set({ me });
  return me;
}
export const exportData = () => api.get('/api/account/export');
export async function deleteAccount(handle) {
  const r = await api.del('/api/account', { confirm: handle });
  await reloadAccount();
  return r;
}
export async function linkEmail(email) {
  const r = await api.post('/api/account/link-email', { email });
  await reloadAccount();
  return r;
}
/** The VERIFIED entitlement (the local server checked the service's signed token – server/lib/accounts/enttoken.mjs). */
export const entitlements = () => api.get('/api/account/entitlements');
/** Start the 7-day souldew+ trial (§8.6: once per Discord account, nothing to pay or cancel). Errors carry vars.code
 * ('trial_used', 'trial_unavailable' with vars.reason). */
export async function startTrial() {
  const r = await api.post('/api/account/trial');
  await reloadAccount();
  return r;
}
/** "Find a SoulLink partner" (§14): the post goes up in the souldew Discord's #find-a-partner → { url }. Errors carry
 * vars.code ('lfg_active' with vars.url, 'lfg_not_member', 'lfg_unavailable', 'text_rejected', 'rate_limited'). */
export const findPartner = (post) => api.post('/api/account/lfg', post);
/** Unlink every membership from this account (§8.5): the pack key rotates, the local pack cache is wiped. */
export async function unlinkMembership() {
  const r = await api.del('/api/account/link');
  await reloadAccount();
  return r;
}
/** The account's sessions (signed-in devices, §1.7) – this computer's is `current`. */
export const listSessions = () => api.get('/api/account/sessions');
/** Signs one device out; this computer's own session is an ordinary sign-out. */
export async function signOutSession(id) {
  const r = await api.del(`/api/account/sessions/${encodeURIComponent(id)}`);
  if (r?.current) await reloadAccount();
  return r;
}
export const profileOf = (id) => api.get(`/api/account/users/${encodeURIComponent(id)}`);
export const editorChoices = () => api.get('/api/account/choices');

// friends
export const addFriend = (query) => api.post('/api/account/friends/requests', { query });
export const answerRequest = (id, accept) => api.post(`/api/account/friends/requests/${encodeURIComponent(id)}/${accept ? 'accept' : 'ignore'}`);
export const cancelRequest = (id) => api.del(`/api/account/friends/requests/${encodeURIComponent(id)}`);
export const removeFriend = (id) => api.del(`/api/account/friends/${encodeURIComponent(id)}`);
export const blockUser = (userId) => api.post('/api/account/blocks', { userId });
export const report = (body) => api.post('/api/account/reports', body);
export const askToJoin = (to) => api.post('/api/account/join-requests', { to });

// ---- catalog --------------------------------------------------------------------------------------------------------
let catalog = null;
let catalogLoading = null;
/** Cosmetics and the accent palette (no account needed; loaded on first use, kept for the session). */
export function useCatalog() {
  const [c, setC] = useState(catalog);
  useEffect(() => {
    if (catalog) return;
    // signed out the local server answers with the app's own palette (local: true) – not kept, the real list comes later
    catalogLoading ||= api.get('/api/account/catalog').then((r) => {
      if (r?.local) catalogLoading = null;
      else catalog = r;
      return r;
    }).catch(() => (catalogLoading = null));
    catalogLoading.then((r) => r && setC(r));
  }, []);
  return c;
}
/** An accent key → its colour (only from the catalog's palette – shared/social.mjs safeHex checked it). */
export const accentHex = (cat, key) => (cat?.accents?.length ? cat.accents : ACCENTS).find((a) => a.key === key)?.hex || null;

// ---- lists that a screen shows (polled while it is open) ------------------------------------------------------------
function usePolled(url, every, enabled) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const alive = useRef(true);
  const load = () => api.get(url).then((d) => {
    if (alive.current) {
      setData(d);
      setError(null);
    }
    return d;
  }).catch((e) => {
    if (alive.current) setError(e);
  });
  useEffect(() => {
    alive.current = true;
    if (!enabled) return () => { alive.current = false; };
    load();
    const id = setInterval(load, every);
    const off = onPending(() => load());
    return () => {
      alive.current = false;
      clearInterval(id);
      off();
    };
  }, [url, enabled]);
  return { data, error, reload: load };
}
/** Friends with their presence, and friend requests both ways. */
export const useFriends = (enabled = true) => usePolled('/api/account/friends', 20000, enabled);
/** Invites and join requests both ways. */
export const useInvites = (enabled = true) => usePolled('/api/account/invites', 20000, enabled);

/** How many friends are online (or playing) – the sidebar's count. Polled slowly while signed in. */
export function useOnlineFriends(enabled) {
  const { data } = usePolled('/api/account/friends', 60000, enabled);
  return data ? data.friends.filter((f) => f.presence?.state && f.presence.state !== 'offline').length : 0;
}

// ---- presence -------------------------------------------------------------------------------------------------------
let lastPresence = '';
let lastPresenceAt = 0;
/**
 * What the player is doing now: { state: 'online'|'library'|'playing'|'in_run', game?: { title, system },
 * run?: { name, mode, freeSlot, joinable }, location? }. Sent when it changes and once a minute (the local server keeps
 * the heartbeat to the service and leaves out what the privacy settings hide). Signed out: nothing is sent.
 */
export function reportPresence(p) {
  if (!signedIn()) return;
  const key = JSON.stringify(p);
  if (key === lastPresence && Date.now() - lastPresenceAt < 55000) return;
  lastPresence = key;
  lastPresenceAt = Date.now();
  api.put('/api/account/presence', p).catch(() => {});
}

// ---- souldew+ packs (web/lib/cosmetics/ uses this) -------------------------------------------------------------------
/** souldew+ = tier plus or patron (API.md §8.0); supporter is a badge only. */
export const isPlus = (tier) => tier === 'plus' || tier === 'patron';
const PREVIEW_MAX_MS = 15 * 60000 + 60000; // 15 minutes and a minute of clock difference
const isoOf = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const accessOf = (dl, key, until) => ({
  packId: dl.packId, version: dl.version, manifest: dl.manifest, signature: dl.signature, keyId: dl.packKeyId, watermark: dl.watermarkId,
  key, files: dl.files || [], until,
});

/**
 * The cosmetics module's pack access provider (web/lib/cosmetics: setPackAccessProvider, API.md §8.2 / §10):
 *   purpose 'pack'    – a souldew+ account: the service's download answer for its pack + the account's pack key
 *                       ({ packId, version, manifest, signature, keyId, watermark, key, files, until }); offline (the
 *                       service can't be reached) the kept entitlement's key: { key, keyId, until, offline: true };
 *                       null when signed out or without souldew+.
 *   purpose 'preview' – a 15-minute live theme preview (§10.4) of the service's preview pack, with a key for this
 *                       preview only: { …, expiresAt, preview: true }. Throws with e.code ('rate_limited',
 *                       'limit_reached', 'none') when the service says no; null when signed out.
 * Throws when it can't tell (counts as offline).
 * Waits until the account is known: right after start the server may still be reading the saved sign-in, and the
 * "signed out" it says meanwhile would wipe a member's pack (which is then downloaded again). signedOut(opts): what a
 * signed-out player gets instead of null (the app: the dev pack, when the local server has one).
 */
export async function cosmeticsPackAccess({ purpose = 'pack', signedOut = null } = {}) {
  await whenAccountKnown();
  if (!signedIn()) return signedOut ? signedOut({ purpose }) : null;
  if (purpose === 'preview') {
    const packs = await api.get('/api/account/packs');
    const pack = (packs.items || []).find((p) => p.previewable);
    if (!pack) throw Object.assign(new Error('No preview pack'), { code: 'none' });
    try {
      const pv = await api.post(`/api/account/packs/${encodeURIComponent(pack.id)}/preview`);
      // a preview lasts 15 minutes (§10.4) – never longer here, whatever an answer says
      const expiresAt = new Date(Math.min(Date.parse(pv.expiresAt), Date.now() + PREVIEW_MAX_MS)).toISOString();
      return { ...accessOf(pv, pv.key, null), expiresAt, preview: true };
    } catch (e) {
      throw Object.assign(new Error(e.message), { code: e.vars?.code || e.code || 'server', retryAfter: e.vars?.retryAfter });
    }
  }
  const ent = await entitlements();
  if (!isPlus(ent.tier) || !ent.packKey) return null;
  const until = isoOf(ent.until);
  if (ent.offline) return { key: ent.packKey, keyId: ent.packKeyId, until, offline: true };
  const packs = await api.get('/api/account/packs');
  // the members' pack: the one souldew+ pack (kind "mixed" first), never the preview pack
  const items = (packs.items || []).filter((p) => p.entitled && !p.previewable);
  const pack = items.find((p) => p.kind === 'mixed') || items[0];
  if (!pack) return null;
  const dl = await api.post(`/api/account/packs/${encodeURIComponent(pack.id)}/download`);
  if (dl.packKeyId !== ent.packKeyId) throw Object.assign(new Error('pack key changed meanwhile'), { code: 'key' });
  return accessOf(dl, ent.packKey, until);
}
