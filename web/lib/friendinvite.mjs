// Play with friends (souldew account): invite friends into a SoulLink, and let them in.
//
// The run itself keeps working exactly as before – peer to peer, with the run pack handed over by the invite-code
// handshake (lib/invitecode.mjs). The accounts service only delivers the invite: run name, game, mode and a code. For
// each friend the host's app starts its own code session with a long friend code ("F" + 22 random characters) and
// sends that code to that one friend through the service. The friend's app joins with it through the existing join
// page; the host sees "Kim wants to join" and decides with Allow, as with a typed code – only the 4 digits are filled
// in by the app (nobody without the code can get that far, see invitecode.mjs). Closing the host's app cancels its
// invites (the codes die with it anyway); the service expires them after 15 minutes like a code.
import { useState, useEffect } from '/vendor/htm-preact.mjs';
import { api } from './api.mjs';
import { CodeHost, newFriendCode, suggestSlot, CODE_TTL } from './invitecode.mjs';
import { slotsOf, runMode, wireMode } from '/shared/slots.mjs';

const TTL_MINUTES = Math.round(CODE_TTL / 60000);
const hosts = new Map(); // invite id → { id, runId, runName, friend, host, state }
const handedOut = new Map(); // run id → Set of slots suggested to friends in this app session
const subs = new Set();
const notify = () => subs.forEach((fn) => fn([...hosts.values()]));
let onRequest = null;

/** fn(entry) when a friend's app asks to join (the host decides: allow / decline) – app.mjs shows a toast. */
export function setRequestListener(fn) {
  onRequest = fn;
}

/** The game an invite names: the catalog title, or what the run calls it. */
export function runRefOf(manifest, gameTitle = '') {
  const sys = manifest?.game?.system;
  // (the accounts service knows 'soullink' and 'nuzlocke' only and refuses anything else: a Play together goes as
  // 'soullink' – a run for friends –, its default name says "… – together", and the join page shows the real mode)
  return { name: String(manifest?.name || '').slice(0, 40), game: String(gameTitle || manifest?.game?.title || '').slice(0, 60), mode: wireMode(manifest), system: sys === 'gbc' ? 'gb' : sys || undefined };
}

function startHost(manifest, friend, taken, importers) {
  const code = newFriendCode();
  const entry = { id: null, runId: manifest.id, runName: manifest.name, friend, state: null, code };
  const used = handedOut.get(manifest.id) || new Set();
  entry.host = new CodeHost({
    pack: manifest.pack, code, importers,
    seat: (name) => {
      const t = [...new Set([...(taken?.() || ['p1']), ...used])];
      return { slot: suggestSlot(manifest.pack?.players || manifest.players, t, name || friend.name), taken: t };
    },
    onState: (st) => {
      entry.state = st;
      if (st.phase === 'sending' && st.seat?.slot) {
        used.add(st.seat.slot);
        handedOut.set(manifest.id, used);
      }
      if (st.phase === 'request') onRequest?.(entry);
      // the code is spent or dead: the invite goes too (the friend already has the pack, or it can't work any more)
      if (['done', 'expired', 'locked', 'conflict', 'error'].includes(st.phase) && entry.id && !entry.closed) {
        entry.closed = true;
        if (st.phase !== 'done') api.del(`/api/account/invites/${encodeURIComponent(entry.id)}`).catch(() => {});
      }
      notify();
    },
  });
  return entry;
}

/**
 * Invite friends into a run this computer hosts. manifest: the run with its pack (GET /api/runs/<id>); friends: user
 * cards; taken(): slots that have somebody already. One code session and one invite per friend. → the entries.
 * (importers: the relay for tests – lib/invitecode.mjs.)
 */
export async function inviteFriends(manifest, friends, { gameTitle = '', taken, importers } = {}) {
  if (!manifest?.pack) throw new Error('This run has no invite pack');
  const out = [];
  for (const friend of friends) {
    const entry = startHost(manifest, friend, taken, importers);
    await entry.host.start();
    try {
      const inv = await api.post('/api/account/invites', { to: [friend.id], run: runRefOf(manifest, gameTitle), code: entry.code, ttlMinutes: TTL_MINUTES });
      entry.id = inv.id;
      entry.expiresAt = inv.expiresAt;
      hosts.set(inv.id, entry);
      out.push(entry);
    } catch (e) {
      entry.host.cancel();
      throw e;
    }
  }
  notify();
  return out;
}

/** A friend's "Ask to join" for the run this computer has open: start a code session and answer with an invite. */
export async function letIn(joinRequest, manifest, { gameTitle = '', taken, importers } = {}) {
  const entry = startHost(manifest, joinRequest.from, taken, importers);
  await entry.host.start();
  try {
    const inv = await api.post(`/api/account/join-requests/${encodeURIComponent(joinRequest.id)}/accept`, { code: entry.code, run: runRefOf(manifest, gameTitle) });
    entry.id = inv.id;
    hosts.set(inv.id, entry);
  } catch (e) {
    entry.host.cancel();
    throw e;
  }
  notify();
  return entry;
}

/** Allow the friend who asked: the 4 digits come from the session itself (a friend code can't be in anyone else's hands). */
export function allowFriend(id) {
  const e = hosts.get(id);
  const req = e?.host.state.request;
  return req ? e.host.allow({ confirm: req.confirm }) : false;
}
export const declineFriend = (id) => hosts.get(id)?.host.decline();

/** Take an invite back: the code session stops, the service tells the friend. */
export async function cancelInvite(id) {
  const e = hosts.get(id);
  if (e) {
    e.closed = true;
    e.host.cancel();
    hosts.delete(id);
    notify();
  }
  await api.del(`/api/account/invites/${encodeURIComponent(id)}`).catch(() => {});
}

export const hostedInvites = () => [...hosts.values()];
/** The invites this app hosts right now, live. */
export function useHostedInvites() {
  const [list, setList] = useState(hostedInvites());
  useEffect(() => {
    subs.add(setList);
    setList(hostedInvites());
    return () => subs.delete(setList);
  }, []);
  return list;
}

/** Seats of a run nobody has yet, as far as this computer can tell (status list: who has been live). */
export function freeSeats(run, mySlot = 'p1') {
  if (!run || runMode(run) === 'nuzlocke') return 0;
  return slotsOf(run).filter((s) => s !== mySlot && !run.summary?.live?.[s]).length;
}

const OVER = ['expired', 'cancelled', 'locked', 'conflict', 'error'];
/**
 * How many more friends can be invited into a run: its seats minus those somebody has (taken) and minus this app's
 * invites for it that are still open (each holds a seat until it ends) or already handed out a seat. Keeps the picker
 * from sending a 2-seat run three invites – the extra friends would only find every seat gone.
 */
export function seatsLeft(manifest, taken = [], invites = hostedInvites()) {
  if (!manifest || runMode(manifest) === 'nuzlocke') return 0;
  const slots = slotsOf(manifest);
  const gone = new Set(taken.filter((s) => slots.includes(s)));
  let open = 0;
  for (const h of invites) {
    if (h.runId !== manifest.id || OVER.includes(h.state?.phase)) continue;
    const s = h.state?.seat?.slot;
    if (s && slots.includes(s)) gone.add(s);
    else if (!s && h.state?.phase !== 'done') open++;
  }
  return Math.max(0, slots.length - gone.size - open);
}

// Closing or reloading the host's app: the codes die with it, so the invites go too (best effort – the service
// expires them anyway).
if (typeof addEventListener === 'function') {
  addEventListener('pagehide', () => {
    for (const e of hosts.values()) {
      e.host.leave();
      if (e.id && !e.closed) fetch(`/api/account/invites/${encodeURIComponent(e.id)}`, { method: 'DELETE', keepalive: true, headers: { 'x-soullink': '1' } }).catch(() => {});
    }
  });
}

/** The joining side: accept an invite → its code for the join page (JoinCode with the code filled in). */
export async function acceptInvite(id) {
  const inv = await api.post(`/api/account/invites/${encodeURIComponent(id)}/accept`);
  return inv;
}
export const declineInvite = (id) => api.post(`/api/account/invites/${encodeURIComponent(id)}/decline`);
