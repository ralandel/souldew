// Playing together (docs/MULTIPLAYER.md › 9 "Playing together"): what the players of a run see of each other beyond
// walking around – who is in a battle (and watching it), the catches and deaths the run records, items given from one
// bag to the other, and "come to me". The browser side is web/lib/together.mjs (one hub per run link) with
// web/views/together.mjs (cards, the gift picker, the watch panel) and the overlay hooks in web/lib/worldoverlay.mjs.
//
// This module has no browser in it: the messages and their checks, the rate limits, the gift protocol (GiftDesk) and
// the pure geometry of the "come here" arrow – tests drive two desks against each other.
//
// Messages ride the run's peer channel as presence messages (web/lib/sync.mjs `world`, `from` added by the channel):
// { t: 'tg', op, … }. Builds from before this ignore `t: 'tg'` (web/lib/sharedworld.mjs and the rock-paper-scissors
// hub look only at their own types) – a partner that never sent a status (`st`) has no gifts offered.
//   st      { v, b, here, caps }       my activity: the battle (packBattle) or 0, the place sign, what my app can do
//   ping    { id, fam, map, x, y, z, here }   come to me (position in world pixels of my map, its size)
//   ping-x  { id }                     never mind
//   g-ask   { id, to, gen, fam, item, n, pocket }  I'd like to give you this (I picked it and confirmed)
//   g-no    { id, to, why }            not now / can't take it   (the receiver)
//   g-ok    { id, to }                 yes, I can take it        (the receiver)
//   g-go    { id, to }                 it's out of my bag now – add it  (the giver, after the removal read back)
//   g-done  { id, to }                 added and read back       (the receiver; also in the run doc)
//   g-fail  { id, to, why }            not added – take it back  (the receiver; also in the run doc)
//   g-x     { id, to, why }            the giver called it off before anything moved
//   g-q     { id, to }                 what became of it?        (the giver, when no answer came)

import { RateLimit } from './world.mjs';
import { giftable, sameItems, GIFT_MAX, GIFT_POCKETS } from './giftitems.mjs';

export const TG_V = 1;
/** Times (ms) and limits. */
export const TG = {
  statusEveryMs: 5000, // my status as a heartbeat (directly)
  statusRelayMs: 15000, // … and over the relay, for partners without a direct link
  staleMs: 20000, // a partner's status older than this is gone (closed the game, lost the link)
  battleMinMs: 500, // battle details (HP) at most twice a second
  popMs: 2600, // a catch over the catcher's head
  tombMs: 5 * 60000, // a tombstone stays on its map this long
  freshMs: 2 * 60000, // only run events this recent are shown in the world (a death from yesterday isn't news)
  gift: { burst: 3, everyMs: 10000, askMs: 30000, goMs: 20000, returnMs: 60000, queryMs: 15000, retryMs: 5000 },
  ping: { burst: 2, everyMs: 20000, keepMs: 3 * 60000, arriveTiles: 2 },
};

const okId = (id) => typeof id === 'string' && /^[\w-]{6,40}$/.test(id);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const randomHex = (bytes) => [...globalThis.crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
export const newId = () => randomHex(8);

// ---- status: who is in a battle, and where ---------------------------------------------------------------------------

/** The place sign for the wire: { g, i, n } (gen, location id, name as read – ≤ 40 characters) or null. */
export function packHere(here) {
  if (!here || !Number.isFinite(here.id)) return null;
  return { g: Number.isInteger(here.gen) ? here.gen : 0, i: here.id | 0, n: String(here.name || '').slice(0, 40) };
}
export function unpackHere(h) {
  if (!h || typeof h !== 'object' || !int(h.i, 0, 0xffff) || !int(h.g, 0, 9)) return null;
  return { gen: h.g, id: h.i, name: typeof h.n === 'string' ? h.n.slice(0, 40) : '' };
}

/**
 * A live battle (shared/live/parse.mjs readLiveBattle, with the player's active Pokémon) for the wire – small, ~60
 * bytes: { k: 'wild' | 'trainer', e: [species, level, hp, maxHp, flags], a: [index, hp, maxHp] }, or 0 (no battle).
 * flags: bit 0 shiny, bits 1–5 the form. The partner's own Pokémon (species, moves) come from the run's live data.
 */
export function packBattle(battle) {
  const e = battle?.enemy;
  if (!e?.species) return 0;
  const n = (v, hi) => (Number.isFinite(v) ? Math.max(0, Math.min(hi, Math.round(v))) : -1);
  const out = { k: battle.kind === 'trainer' ? 'trainer' : 'wild', e: [e.species | 0, n(e.level, 255), n(e.hp, 9999), n(e.maxHp, 9999), (e.shiny ? 1 : 0) | (((e.form || 0) & 31) << 1)] };
  const a = battle.active;
  if (a && Number.isInteger(a.index) && a.index >= 0 && a.index < 6) out.a = [a.index, n(a.hp, 9999), n(a.maxHp, 9999)];
  return out;
}
export function unpackBattle(b) {
  if (!b || typeof b !== 'object' || (b.k !== 'wild' && b.k !== 'trainer') || !Array.isArray(b.e)) return null;
  const [species, level, hp, maxHp, flags] = b.e;
  if (!int(species, 1, 2047) || ![level, hp, maxHp].every((v) => int(v, -1, 9999)) || !int(flags ?? 0, 0, 63)) return null;
  const v = (x) => (x >= 0 ? x : null);
  const out = { kind: b.k, enemy: { species, level: v(level), hp: v(hp), maxHp: v(maxHp), shiny: !!(flags & 1), form: (flags >> 1) || 0 } };
  if (Array.isArray(b.a) && int(b.a[0], 0, 5) && int(b.a[1], -1, 9999) && int(b.a[2], -1, 9999)) out.active = { index: b.a[0], hp: v(b.a[1]), maxHp: v(b.a[2]) };
  return out;
}

/** What my app can do, for the partners (older builds send no status at all: nothing). */
export const CAPS = ['gift', 'ping', 'watch'];

export function packStatus({ battle = null, here = null, caps = CAPS } = {}) {
  return { t: 'tg', op: 'st', v: TG_V, b: packBattle(battle), here: packHere(here), caps: caps.filter((c) => CAPS.includes(c)) };
}
/** A partner's status message → { battle, here, caps } or null (malformed: it comes from the network). */
export function unpackStatus(m) {
  if (!m || m.t !== 'tg' || m.op !== 'st' || !Number.isInteger(m.v) || m.v < 1) return null;
  return {
    battle: m.b ? unpackBattle(m.b) : null,
    here: m.here ? unpackHere(m.here) : null,
    caps: Array.isArray(m.caps) ? m.caps.filter((c) => CAPS.includes(c)) : [],
  };
}
/** Has the status changed enough to send it now? (the battle's HP counts, the place sign by its id) */
export const statusKey = (st) => JSON.stringify([st.b || 0, st.here?.i ?? null, st.here?.g ?? null]);

// ---- come to me ------------------------------------------------------------------------------------------------------

/** "Come to me": my position (world pixels of my map – shared/world.mjs readPlayer) and the place sign. */
export function packPing({ id = newId(), fam = 0, map = 0, x = 0, y = 0, size = null, here = null } = {}) {
  const m = { t: 'tg', op: 'ping', id, fam: fam | 0, map: map | 0, x: Math.round(x), y: Math.round(y), here: packHere(here) };
  if (Array.isArray(size) && int(size[0], 1, 1024) && int(size[1], 1, 1024)) m.z = [size[0], size[1]];
  return m;
}
export function unpackPing(m) {
  if (!m || m.t !== 'tg' || m.op !== 'ping' || !okId(m.id)) return null;
  const pos = int(m.fam, 1, 255) && int(m.map, 0, 0xffff) && int(m.x, -0x8000, 0x8000) && int(m.y, -0x8000, 0x8000);
  return {
    id: m.id,
    // (a game without Shared World sends no position: the board says where they are)
    ...(pos ? { fam: m.fam, map: m.map, x: m.x, y: m.y } : {}),
    ...(Array.isArray(m.z) && int(m.z[0], 1, 1024) && int(m.z[1], 1, 1024) ? { size: [m.z[0], m.z[1]] } : {}),
    here: unpackHere(m.here),
  };
}

/**
 * Has the player `local` ({ fam, map, x, y } in world pixels) arrived at `ping`? Within `arriveTiles` tiles on its
 * map. (A ping without a position is only cleared by time.)
 */
export function pingArrived(ping, local, tiles = TG.ping.arriveTiles) {
  if (!ping || ping.map === undefined || !local || local.hidden) return false;
  if (local.fam !== ping.fam || local.map !== ping.map) return false;
  return Math.abs(local.x - ping.x) <= tiles * 16 && Math.abs(local.y - ping.y) <= tiles * 16;
}

/**
 * The arrow at the edge of the picture toward a spot off screen. `p`: the spot's top-left on the picture (pixels, may
 * be far outside), `screen`: { w, h }, `margin`: how far in from the edge the arrow's tip stays. → { x, y, angle,
 * onScreen } – onScreen: the spot is on the picture (no arrow: a marker over it instead).
 */
export function edgeArrow(p, screen, margin = 10, tile = 16) {
  const cx = screen.w / 2;
  const cy = screen.h / 2;
  const tx = p.x + tile / 2;
  const ty = p.y + tile / 2;
  const onScreen = tx >= 0 && tx < screen.w && ty >= 0 && ty < screen.h;
  const dx = tx - cx;
  const dy = ty - cy;
  const angle = Math.atan2(dy, dx);
  if (onScreen) return { x: tx, y: ty, angle, onScreen: true };
  // where the line from the middle meets the box `margin` inside the edge
  const hw = cx - margin;
  const hh = cy - margin;
  const k = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return { x: cx + dx * k, y: cy + dy * k, angle, onScreen: false };
}

// ---- gifts -----------------------------------------------------------------------------------------------------------

/** A gift's offer for the wire, checked on both ends. */
export function giftOk(g) {
  return !!g && int(g.gen, 1, 7) && int(g.item, 1, 2047) && int(g.n, 1, GIFT_MAX) && GIFT_POCKETS.includes(g.pocket ?? null) && giftable(g.gen, g.item, g.pocket ?? null);
}

const GIFT_OPS = ['g-ask', 'g-no', 'g-ok', 'g-go', 'g-done', 'g-fail', 'g-x', 'g-q'];
const WHY = /^[a-zA-Z]{1,20}$/;

/**
 * One player's gifts – the ones I give and the ones I get. The order makes a gift as safe as two separate games allow:
 * both confirm (I pick and confirm, they accept), then **my** game gives it up first (read back), then theirs takes it
 * (read back) – and if theirs can't, mine takes it back. Each gift has an id; the receiver decides its outcome once
 * and writes it into the run doc (`ledger.decide`), so a message sent twice, an app restarted or a link lost and
 * found again never adds it twice – and the giver takes an item back only on the receiver's word ("not added"), never
 * just because an answer is late (that would make a pulled cable a way to copy items). Without any word the giver
 * asks again (g-q) until one comes; the receiver answers from the doc, or – knowing nothing of it – decides "not
 * added" right then.
 *
 *   send(msg)        to every partner (messages carry `to`)
 *   now()            this computer's clock
 *   bag              my game, or null while it isn't running: { gen, check() → null | why (can I give or take right
 *                    now – a battle, a menu …), has(item, n, pocket) → bool, room(item, n, pocket) → bool, remove(item,
 *                    n, pocket) → result | Promise, add(item, n, pocket) → result | Promise } (results as
 *                    shared/live/cheats.mjs removeItem / addItem: { ok } or { error })
 *   ledger           the run doc's record: { sent(g) (mine, out of my bag), done(g) (theirs: added), decided(id) →
 *                    { ok, why } | null, decide(id, outcome), open() → my gifts still on their way (after a restart) }
 *   allowed()        the run's rule "Gifts between us"
 * Events (on(fn) → off): fn({ type: 'change' | 'done' | 'failed' | 'returned', gift }).
 */
export class GiftDesk {
  constructor({ me, send, now = () => Date.now(), bag = null, ledger, allowed = () => true, id = newId }) {
    Object.assign(this, { me, send, now, bag, ledger, allowed, makeId: id });
    this.gifts = new Map();
    this.listeners = new Set();
    this.out = new RateLimit({ burst: TG.gift.burst, everyMs: TG.gift.everyMs });
    this.in = new Map(); // slot → RateLimit
    this.busy = new Set(); // ids with a bag write under way
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  _emit(type, gift) {
    for (const fn of this.listeners) {
      try {
        fn({ type, gift });
      } catch (e) {
        console.warn('gift listener', e);
      }
    }
  }
  _set(g, patch, type = 'change') {
    Object.assign(g, patch, { changedAt: this.now() });
    this._emit(type, g);
    if (type !== 'change') this._emit('change', g);
  }
  _msg(op, g, extra = {}) {
    this.send({ t: 'tg', op, id: g.id, to: g.from === this.me ? g.to : g.from, ...extra });
  }

  /** The gift between me and `slot` still being decided (one at a time per pair). */
  openWith(slot) {
    for (const g of this.gifts.values()) if ((g.to === slot || g.from === slot) && !g.end) return g;
    return null;
  }
  list() {
    return [...this.gifts.values()];
  }

  /** My gifts still on their way after a restart (from the ledger): asked about until the receiver says. */
  restore() {
    for (const r of this.ledger?.open?.() || []) {
      if (!okId(r.id) || this.gifts.has(r.id) || r.from !== this.me || !giftOk(r)) continue;
      this.gifts.set(r.id, { ...r, phase: 'sent', end: null, at: this.now(), askedAt: null, changedAt: this.now() }); // (asked at once)
    }
  }

  /**
   * Give `slot` `n` of `item` from `pocket` (the player picked and confirmed it) → the gift, or { error: 'off' (the
   * run's rule) | 'busy' (a gift with them is open) | 'limit' (too many at once) | 'nogame' | 'item' | <bag's why> }.
   */
  offer(slot, { item, n = 1, pocket = null }) {
    if (!slot || slot === this.me) return { error: 'self' };
    if (!this.allowed()) return { error: 'off' };
    if (!this.bag) return { error: 'nogame' };
    const gift = { gen: this.bag.gen, fam: this.bag.fam || '', item, n, pocket: pocket ?? null };
    if (!giftOk(gift)) return { error: 'item' };
    const why = this.bag.check();
    if (why) return { error: why };
    if (!this.bag.has(item, n, gift.pocket)) return { error: 'short' };
    if (this.openWith(slot)) return { error: 'busy' };
    if (!this.out.take(this.now())) return { error: 'limit' };
    const g = { id: this.makeId(), from: this.me, to: slot, ...gift, phase: 'asked', end: null, at: this.now(), until: this.now() + TG.gift.askMs, changedAt: this.now() };
    this.gifts.set(g.id, g);
    this.send({ t: 'tg', op: 'g-ask', id: g.id, to: slot, gen: g.gen, fam: g.fam, item, n, pocket: g.pocket });
    this._emit('change', g);
    return g;
  }

  /** The giver changes their mind before the receiver said yes. */
  cancel(id) {
    const g = this.gifts.get(id);
    if (!g || g.from !== this.me || g.phase !== 'asked') return false;
    this._msg('g-x', g, { why: 'cancel' });
    this._set(g, { phase: 'cancelled', end: 'cancelled' });
    return true;
  }

  /** The receiver answers an offer: yes (if my game can take it right now) or no. */
  answer(id, yes) {
    const g = this.gifts.get(id);
    if (!g || g.to !== this.me || g.phase !== 'offered') return false;
    if (!yes) {
      this._msg('g-no', g, { why: 'declined' });
      this._set(g, { phase: 'declined', end: 'declined' });
      return true;
    }
    const why = !this.allowed() ? 'off' : !this.bag ? 'nogame' : this.bag.gen !== g.gen ? 'gen' : !sameItems(g.gen, g.fam, this.bag.fam || '', g.item) ? 'game'
      : this.bag.check() || (!this.bag.room(g.item, g.n, g.pocket) ? 'full' : null);
    if (why) {
      // (the card says why; the giver hears it and nothing moves)
      this._msg('g-no', g, { why });
      this._set(g, { phase: 'refused', end: 'refused', why });
      return true;
    }
    this._msg('g-ok', g);
    this._set(g, { phase: 'accepted', until: this.now() + TG.gift.goMs });
    return true;
  }

  /** A message from a partner (`from` set by the channel). */
  async receive(m) {
    if (!m || m.t !== 'tg' || !GIFT_OPS.includes(m.op) || !okId(m.id) || typeof m.from !== 'string' || m.from === this.me) return;
    if (m.to !== this.me) return; // (between two others)
    const g = this.gifts.get(m.id);
    if (m.op === 'g-ask') return this._asked(m);
    if (m.op === 'g-q') return this._queried(m, g);
    if (!g) return;
    // only the other side of the gift speaks for it
    const other = g.from === this.me ? g.to : g.from;
    if (m.from !== other) return;
    const why = typeof m.why === 'string' && WHY.test(m.why) ? m.why : null;
    if (g.from === this.me) {
      if (m.op === 'g-no' && g.phase === 'asked') this._set(g, { phase: m.why === 'declined' ? 'declined' : 'refused', end: m.why === 'declined' ? 'declined' : 'refused', why });
      else if (m.op === 'g-ok' && g.phase === 'asked') await this._give(g);
      else if (m.op === 'g-done' && (g.phase === 'sent' || g.phase === 'unconfirmed')) this._set(g, { phase: 'done', end: 'done' }, 'done');
      else if (m.op === 'g-fail' && (g.phase === 'sent' || g.phase === 'unconfirmed')) await this._takeBack(g, why);
    } else {
      if (m.op === 'g-x' && (g.phase === 'offered' || g.phase === 'accepted')) this._set(g, { phase: 'withdrawn', end: 'withdrawn', why });
      else if (m.op === 'g-go') await this._take(g);
    }
  }

  _asked(m) {
    const gift = { gen: m.gen, fam: typeof m.fam === 'string' && /^[\w-]{0,24}$/.test(m.fam) ? m.fam : '', item: m.item, n: m.n, pocket: m.pocket ?? null };
    if (this.gifts.has(m.id)) return; // (a repeat)
    if (!giftOk(gift)) return;
    // a decided gift (this id is in the run doc already) or too many offers: not shown
    if (this.ledger?.decided?.(m.id)) return;
    if (!this.in.has(m.from)) this.in.set(m.from, new RateLimit({ burst: TG.gift.burst + 1, everyMs: TG.gift.everyMs }));
    if (!this.in.get(m.from).take(this.now())) return;
    const g = { id: m.id, from: m.from, to: this.me, ...gift, phase: 'offered', end: null, at: this.now(), until: this.now() + TG.gift.askMs, changedAt: this.now() };
    if (!this.allowed()) {
      this._msg('g-no', g, { why: 'off' });
      return;
    }
    if (this.openWith(m.from)) {
      this._msg('g-no', g, { why: 'busy' });
      return;
    }
    this.gifts.set(g.id, g);
    this._emit('change', g);
  }

  /** The giver: they said yes – out of my bag first, read back, then "go". */
  async _give(g) {
    const why = !this.allowed() ? 'off' : !this.bag ? 'nogame' : this.bag.check();
    if (why || !this.bag.has(g.item, g.n, g.pocket)) {
      this._msg('g-x', g, { why: why || 'short' });
      return this._set(g, { phase: 'failed', end: 'failed', why: why || 'short' }, 'failed');
    }
    this._set(g, { phase: 'removing' });
    this.busy.add(g.id);
    let res;
    try {
      res = await this.bag.remove(g.item, g.n, g.pocket);
    } catch {
      res = { error: 'write' };
    } finally {
      this.busy.delete(g.id);
    }
    if (!res?.ok) {
      this._msg('g-x', g, { why: res?.error && WHY.test(res.error) ? res.error : 'write' });
      return this._set(g, { phase: 'failed', end: 'failed', why: res?.error || 'write' }, 'failed');
    }
    // (in the run doc before "go": a restart of this app still knows it is on its way)
    try {
      this.ledger?.sent?.(g);
    } catch (e) {
      console.warn('gift ledger', e);
    }
    this._set(g, { phase: 'sent', sentAt: this.now(), askedAt: this.now() });
    this._msg('g-go', g);
  }

  /** The receiver: "go" – added once (the run doc remembers), read back, and the outcome said and written. */
  async _take(g) {
    const known = this.ledger?.decided?.(g.id);
    if (known) return this._msg(known.ok ? 'g-done' : 'g-fail', g, known.ok ? {} : { why: known.why || 'failed' });
    if (this.busy.has(g.id)) return;
    if (g.phase !== 'accepted') return;
    // too late: the giver's "go" didn't come in time – decided as not added (the giver takes it back)
    if (this.now() > g.until) return this._decide(g, { ok: false, why: 'late' });
    const why = !this.bag ? 'nogame' : this.bag.check();
    if (why) return this._decide(g, { ok: false, why });
    this._set(g, { phase: 'adding' });
    this.busy.add(g.id);
    let res;
    try {
      res = await this.bag.add(g.item, g.n, g.pocket);
    } catch {
      res = { error: 'write' };
    } finally {
      this.busy.delete(g.id);
    }
    this._decide(g, res?.ok ? { ok: true } : { ok: false, why: res?.error && WHY.test(res.error) ? res.error : 'write' });
  }

  _decide(g, outcome) {
    try {
      this.ledger?.decide?.(g.id, { ...outcome, from: g.from, to: g.to, gen: g.gen, item: g.item, n: g.n, pocket: g.pocket });
    } catch (e) {
      console.warn('gift ledger', e);
    }
    if (outcome.ok) {
      this._msg('g-done', g);
      try {
        this.ledger?.done?.(g);
      } catch (e) {
        console.warn('gift ledger', e);
      }
      this._set(g, { phase: 'done', end: 'done' }, 'done');
    } else {
      this._msg('g-fail', g, { why: outcome.why });
      this._set(g, { phase: 'failed', end: 'failed', why: outcome.why }, 'failed');
    }
  }

  /** The receiver is asked what became of a gift: from the doc, or – unknown here – decided "not added" now. */
  _queried(m, g) {
    const known = this.ledger?.decided?.(m.id);
    const reply = (ok, why) => this.send({ t: 'tg', op: ok ? 'g-done' : 'g-fail', id: m.id, to: m.from, ...(ok ? {} : { why }) });
    if (known) return reply(known.ok, known.why || 'failed');
    if (g && (g.phase === 'adding' || this.busy.has(m.id))) return; // (the answer comes when the bag has it)
    if (g && g.phase === 'accepted' && this.now() <= g.until) return; // (still waiting for "go" – it may be on its way)
    // nothing known of it (this app restarted, or the "go" never came): not added – recorded, so it stays that way
    try {
      this.ledger?.decide?.(m.id, { ok: false, why: 'unknown', from: m.from, to: this.me });
    } catch (e) {
      console.warn('gift ledger', e);
    }
    if (g && !g.end) this._set(g, { phase: 'failed', end: 'failed', why: 'unknown' }, 'failed');
    reply(false, 'unknown');
  }

  /** The giver: the receiver couldn't add it – back into my bag (again later while my game can't take it). */
  async _takeBack(g, why) {
    if (this.busy.has(g.id) || g.phase === 'returned') return;
    this._set(g, { phase: 'returning', why: why || g.why || 'failed' });
    if (!this.bag || this.bag.check()) return; // (tick tries again)
    this.busy.add(g.id);
    let res;
    try {
      res = await this.bag.add(g.item, g.n, g.pocket);
    } catch {
      res = { error: 'write' };
    } finally {
      this.busy.delete(g.id);
    }
    if (res?.ok) {
      try {
        this.ledger?.returned?.(g);
      } catch (e) {
        console.warn('gift ledger', e);
      }
      this._set(g, { phase: 'returned', end: 'returned' }, 'returned');
    } else this._set(g, { retryAt: this.now() + TG.gift.retryMs, backWhy: res?.error || 'write' });
  }

  /** Timeouts, questions, retries – call a few times a second. */
  tick() {
    const now = this.now();
    for (const g of this.gifts.values()) {
      if (g.end) {
        if (now - g.changedAt > 15000) {
          this.gifts.delete(g.id); // (shown a while, then gone)
          this._emit('change', g);
        }
        continue;
      }
      if (g.from === this.me) {
        if (g.phase === 'asked' && now > g.until) {
          this._msg('g-x', g, { why: 'expired' });
          this._set(g, { phase: 'expired', end: 'expired' });
        } else if (g.phase === 'sent' || g.phase === 'unconfirmed') {
          // the run doc may know already (the receiver's message was lost, its doc entry wasn't)
          const known = this.ledger?.decided?.(g.id);
          if (known?.ok) this._set(g, { phase: 'done', end: 'done' }, 'done');
          else if (known) this._takeBack(g, known.why);
          else if (g.askedAt == null || now - g.askedAt >= (g.phase === 'sent' ? TG.gift.returnMs : TG.gift.queryMs)) {
            // no word: ask (never taken back on silence)
            this._msg('g-q', g);
            this._set(g, { phase: 'unconfirmed', askedAt: now });
          }
        } else if (g.phase === 'returning' && (!g.retryAt || now >= g.retryAt)) this._takeBack(g, g.why);
      } else if ((g.phase === 'offered' && now > g.until) || (g.phase === 'accepted' && now > g.until)) {
        // no "go" in time: decided as not added (a late one gets "fail", the giver takes it back)
        if (g.phase === 'accepted') this._decide(g, { ok: false, why: 'late' });
        else this._set(g, { phase: 'expired', end: 'expired' });
      }
    }
  }
}
