// Link battle results and wagers in the run document (docs/MULTIPLAYER.md › "Battle results and wagers").
//
// Every player of a session writes what their own computer read of it – every seat's battles, the wager, a hash of both –
// under a key of their own: `lb:<sid>:<slot>` (one writer per key, so nothing is lost to "last writer wins"). A result
// counts once every seat's entry is there, final, not void and with the same hash: then every computer works out the
// same winner, log entry, head-to-head record and payments from the same entries. A desync, a player who dropped out
// (rejoined, or never wrote their entry) or results that differ: nothing counts, the wager is void.
//
// The money: `lbpay:<sid>:<slot>` – this player's own game paid / was paid, written by their computer when the money is
// in their game ('written'), and 'saved' once the game saved after it. A game started again before it saved (a reset,
// a crash, a save state) gets it once more – keyed by the session, so never twice into one save.
//
// Whose word the money takes: every partner's computer writes into the run document – under any key, its own slot or
// this player's. A changed souldew could write a matching pair of entries for a battle that never was. So the money
// only ever follows this computer's own result: what it read itself, kept apart from the run document (keepOwnResult,
// in this computer's browser storage). A payment needs every partner's entry to match that – their word alone, under
// any slot, moves nothing. (The log and the head-to-head record show what the entries say; they move no money.)
import { summarize, payments, deltaOf, resultHash, WAGER_CAP } from '/shared/linkbattle.mjs';

export { WAGER_CAP };

/** The run's wager rule: 'on' (default) / 'off', and the most a wager may be (0: no limit). The host's call. */
export function wagerRules(r) {
  return { on: (r?.linkWagers ?? 'on') !== 'off' && r?.linkBattles !== 'off', cap: Math.max(0, Math.floor(Number(r?.linkWagerCap) || 0)) };
}

/** The wager two or four players agreed on: the offer, lowered to every accept and the cap; 0 when a seat can't do it. */
export function agreedWager({ offer = 0, seats = [], host, accepts = {}, caps = {}, cap = 0 }) {
  let w = Math.max(0, Math.floor(Number(offer) || 0));
  if (!w || !seats.every((s) => caps[s])) return 0;
  for (const s of seats) if (s !== host) w = Math.min(w, Math.max(0, Math.floor(Number(accepts[s]) || 0)));
  return cap ? Math.min(w, cap) : w;
}

/**
 * This computer's entry for a finished session. `found`: LinkResult.finish() ({ per, multi }) or null; `wager`: the
 * agreed amount; `money`: every seat's money when the session started (the wager can't be more than anybody has).
 */
export function resultEntry({ sid, seats, host, kind, found, wager = 0, money = {}, reason = null, at = Date.now() }) {
  const base = { version: 1, sid, seats, host, kind, at, final: true };
  if (reason) return { ...base, void: reason };
  if (!found) return { ...base, void: 'unread' };
  const known = seats.every((s) => Number.isFinite(money?.[s]));
  const stake = wager && known ? Math.min(wager, ...seats.map((s) => money[s])) : 0;
  const entry = { ...base, per: found.per, multi: !!found.multi, wager: stake };
  return { ...entry, h: resultHash({ sid, seats, per: found.per, wager: stake, multi: entry.multi }) };
}

const OWN_KEY = (runId) => `sl-lb-own-${runId}`;
const OWN_MAX = 200; // sessions kept per run (the newest)
const browserStore = () => {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
};
const ownAll = (runId, store) => {
  try {
    const v = JSON.parse(store?.getItem(OWN_KEY(runId)) || 'null');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};

/** Keep this computer's own result of a session (resultEntry) apart from the run document – what a payment follows. */
export function keepOwnResult(runId, entry, store = browserStore()) {
  if (!runId || !entry?.sid || !store) return;
  const all = ownAll(runId, store);
  all[entry.sid] = entry;
  const keep = Object.entries(all).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0)).slice(0, OWN_MAX);
  try {
    store.setItem(OWN_KEY(runId), JSON.stringify(Object.fromEntries(keep)));
  } catch {
    // (storage full or off: no payment for this session – never one on the partners' word alone)
  }
}

/** This computer's own result of session `sid` (keepOwnResult), or null. */
export function ownResultOf(runId, sid, store = browserStore()) {
  if (!runId || !sid) return null;
  const e = ownAll(runId, store)[sid];
  return e && typeof e === 'object' ? e : null;
}

/** What this computer read of a session: into the run (`lb:<sid>:<me>`, for the partners) and kept for itself. */
export function recordResult(doc, me, entry, store = browserStore()) {
  keepOwnResult(doc?.runId, entry, store);
  doc.set(`lb:${entry.sid}:${me}`, entry);
}

/** Every session with a result entry: { sid: { slot: entry } }. */
export function sessionsIn(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc?.scan?.('lb:') || {})) {
    const m = k.match(/^([0-9a-f]{6,24}):(p[1-8])$/); // (scan gives the keys without the prefix)
    if (m && v && typeof v === 'object') (out[m[1]] ||= {})[m[2]] = v;
  }
  return out;
}

/**
 * What a session came to: { state: 'pending' | 'void' | 'agreed', seats, summary, wager, pays, at }. 'agreed' needs
 * every seat's final entry with the same hash and a result that fits together. With `me` and `own` (this computer's own
 * result, ownResultOf): that stands for `me` – whatever the run document holds under `me`'s slot – and the result is
 * the one it read (the others' entries only have to match it); without `own` nothing is agreed for `me`.
 */
export function outcomeOf(entries, { me = null, own } = {}) {
  if (me) {
    if (!own || typeof own !== 'object' || !Array.isArray(own.seats) || !own.seats.includes(me)) return { state: 'pending' };
    const others = Object.fromEntries(Object.entries(entries || {}).filter(([s]) => s !== me));
    entries = { [me]: own, ...others }; // (own first: the result read is this computer's)
  }
  const list = Object.values(entries || {});
  const first = list[0];
  if (!first || !Array.isArray(first.seats)) return { state: 'pending' };
  const seats = first.seats;
  const of = (s) => entries[s];
  if (list.some((e) => e.void)) return { state: 'void', seats, why: list.find((e) => e.void).void };
  if (!seats.every((s) => of(s)?.final)) return { state: 'pending', seats };
  if (!seats.every((s) => of(s).h && of(s).h === first.h)) return { state: 'void', seats, why: 'differs' };
  const summary = summarize(seats, first.per, { multi: !!first.multi });
  if (!summary.valid) return { state: 'void', seats, why: 'invalid' };
  const pays = payments(summary, first.wager);
  return { state: 'agreed', seats, summary, per: first.per, wager: first.wager || 0, pays, at: Math.max(...seats.map((s) => of(s).at || 0)), kind: first.kind, host: first.host };
}

/** Every agreed session with battles, newest first: [{ sid, …outcomeOf }]. `trust` ({ me, own(sid) }): see outcomeOf. */
export function agreedBattles(doc, trust = null) {
  return Object.entries(sessionsIn(doc)).map(([sid, e]) => ({ sid, ...outcomeOf(e, trust ? { me: trust.me, own: trust.own(sid) } : {}) }))
    .filter((o) => o.state === 'agreed' && o.summary.battles > 0).sort((a, b) => b.at - a.at);
}

/**
 * The head-to-head record of `a` against `b` over the run's agreed link battles: { a: wins, b: wins, draws }. A
 * session of several battles counts each; a multi battle counts for every winner against every loser.
 */
export function headToHead(doc, a, b) {
  const r = { a: 0, b: 0, draws: 0 };
  for (const o of agreedBattles(doc)) {
    const c = o.per?.[a];
    if (!c || !o.seats.includes(b)) continue;
    // on the same side of a multi battle (or a drawn one, whose sides aren't known): not against each other
    if (o.seats.length > 2 && (o.summary.draw || o.summary.winners.includes(a) === o.summary.winners.includes(b))) continue;
    r.a += c.w;
    r.b += c.l;
    r.draws += c.d;
  }
  return r;
}

/**
 * What a battle's wager means for `me` right now: `delta` (+ won, − lost, 0 nothing) and whether it has gone into
 * their game yet (`settled`: WagerPay wrote it – it waits for the overworld, so a Gen 1 player still in the Colosseum
 * hasn't paid until they start their game again).
 */
export function wagerStatus(doc, sid, me, pays) {
  const delta = deltaOf(pays || [], me);
  const p = doc?.get?.(`lbpay:${sid}:${me}`);
  return { delta, settled: !!delta && (p?.status === 'written' || p?.status === 'saved') };
}

/**
 * This player's money still to be put into (or taken from) their game: [{ sid, delta, pays }]. Only sessions whose
 * result this computer read itself (`own(sid)`: ownResultOf) and every partner's entry matches – see outcomeOf.
 */
export function owedTo(doc, me, { boot = null, own = (sid) => ownResultOf(doc?.runId, sid) } = {}) {
  const out = [];
  for (const o of agreedBattles(doc, { me, own })) {
    const delta = deltaOf(o.pays, me);
    if (!delta) continue;
    const p = doc.get(`lbpay:${o.sid}:${me}`);
    // done: saved; or written into the game this page runs (a game started again before saving gets it once more)
    if (p?.status === 'saved' || (p?.status === 'written' && (!boot || p.boot === boot))) continue;
    out.push({ sid: o.sid, delta, pays: o.pays, again: p?.status === 'written' });
  }
  return out;
}
