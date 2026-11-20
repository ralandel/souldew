// Playing together (docs/MULTIPLAYER.md › 9 "Playing together"), the app's half: one hub per run link – like the
// rock-paper-scissors hub (web/lib/worldrps.mjs) it works for every game, with or without Shared World.
//
//  - Who is in a battle: each player's app sends a small status (shared/together.mjs `st`) when its battle or place
//    changes and as a heartbeat. Partners on builds without it: their `where:<slot>` in the run doc (the stream overlay's
//    "whom you fight") says it too, without the HP.
//  - Catches and deaths: read from the run doc's log as it arrives (only fresh entries – the run's own records, nothing
//    made up); the player whose Pokémon died writes where they stood (`tomb:<slot>:<log id>`), so everyone sees the
//    same tombstone on that map for a while.
//  - Gifts: shared/together.mjs GiftDesk on the run doc (`gift:<id>` – out of the giver's bag, `giftgot:<id>` – the
//    receiver's outcome, decided once) and this computer's game (`setBag`, from the play view).
//  - "Come to me": a ping with my position and place; it clears when they arrive, after a while, or with a new one.
//
// The play view feeds it (setLocal, setBag, setPosition); the board, the cards and the Shared World overlay read it.
import { useEffect, useState } from '/vendor/htm-preact.mjs';
import {
  TG, packStatus, unpackStatus, statusKey, packPing, unpackPing, pingArrived, GiftDesk, newId,
} from '/shared/together.mjs';
import { RateLimit, worldTable, readCamera } from '/shared/world.mjs';
import { dsWorldTable, dsPointers, dsReadFrame, dsDrawable } from '/shared/worldds.mjs';
import { bagItems, removeItem, addItem, bagRoom, giftSupported, bagFamily } from '/shared/live/cheats.mjs';
import { giftList } from '/shared/giftitems.mjs';
import { feed, feedText, msg, live, encounter, players, rules as getRules, slotsOf, runMode } from './run.mjs';

const TICK_MS = 500;
/**
 * A partner whose direct connection has stood this long without one status from them runs an older souldew (2.x): every
 * 3.0 build sends its status as a heartbeat (TG.statusEveryMs) the moment the link is up. Three heartbeats' worth, so a
 * slow first message never makes a 3.0 partner look old.
 */
export const OLDER_APP_MS = 3 * TG.statusEveryMs;
const hubs = new WeakMap(); // SyncLink → TogetherHub

/** May the players of this run give each other items? The host's rule "Gifts between us" (default: yes). */
export const giftsAllowed = (doc, manifest) => !!doc && !!manifest && runMode(manifest) !== 'nuzlocke' && getRules(doc, manifest)?.itemGifts !== 'off';

/** The hub of a run's link (created on first use; `doc`/`manifest` for the log, the ledger and the rule). */
export function attachTogether(link, { doc = null, manifest = null } = {}) {
  if (!link) return null;
  let h = hubs.get(link);
  if (h) {
    h.setRun(doc, manifest);
    return h;
  }
  h = new TogetherHub(link, { doc, manifest });
  hubs.set(link, h);
  return h;
}

/** The hub of a link, if the app attached one. */
export const togetherFor = (link) => (link ? hubs.get(link) || null : null);

/** A Preact hook: the hub of this link (null without one), re-rendered on every change. */
export function useTogether(link) {
  const h = togetherFor(link);
  const [, set] = useState(0);
  useEffect(() => (h ? h.on(() => set((n) => n + 1)) : undefined), [h]);
  return h;
}

export class TogetherHub {
  constructor(link, { doc, manifest, now = () => Date.now() }) {
    this.link = link;
    this.me = link.slot;
    this.now = now;
    this.listeners = new Set();
    this.statuses = new Map(); // slot → { battle, here, caps, at }
    this.pings = new Map(); // slot → { id, fam, map, x, y, size, here, at, until }
    this.myPing = null;
    this.pingOut = new RateLimit({ burst: TG.ping.burst, everyMs: TG.ping.everyMs });
    this.pingIn = new Map();
    this.pops = []; // { slot, species, shiny, form, at } – catches to show over the catcher's head
    this.local = { battle: null, here: null };
    this.sent = { key: '', b: false, at: 0, relayAt: 0, pending: false };
    this.position = null; // () → my last position on the overworld { fam, map, x, y, size } or null (the play view)
    this.seen = new Set(); // log ids looked at
    this.started = now();
    this.directSince = new Map(); // slot → since when we have a direct connection to them (olderApp)
    this.spoke = new Set(); // slots that sent a status on this link at least once – a 3.0 build
    this.older = new Set(); // slots olderApp said yes to at the last tick
    this.desk = new GiftDesk({
      me: this.me,
      send: (m) => this.send(m),
      now,
      ledger: this.ledger(),
      allowed: () => giftsAllowed(this.doc, this.manifest),
    });
    this.desk.on((e) => this._gift(e));
    this.offWorld = link.onWorld?.((m) => this._in(m)) || null;
    this.setRun(doc, manifest);
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  setRun(doc, manifest) {
    if (doc && doc !== this.doc) {
      this.offDoc?.();
      this.doc = doc;
      // what's in the log already isn't news
      for (const id of Object.keys(doc.scan('feed:'))) this.seen.add(id);
      this.offDoc = doc.subscribe((keys) => this._doc(keys));
      this.desk.restore();
    }
    if (manifest) this.manifest = manifest;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  _emit(e = { type: 'change' }) {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch (err) {
        console.warn('together listener', err);
      }
    }
  }

  /** To the partners: directly where there's a link; addressed messages and pings also over the relay. */
  send(m, { relay = false } = {}) {
    const reached = this.link.sendWorld?.(m) || new Set();
    const others = this.link.others || [];
    const missing = m.to ? !reached.has(m.to) : others.some((s) => !reached.has(s));
    if ((m.to || relay) && missing) this.link.sendMessage?.({ world: { ...m, from: this.me } });
    return reached;
  }

  // ---- my side, from the play view ---------------------------------------------------------------------------------
  /** What my game shows right now: the live battle (readLiveBattle, null outside one) and the place sign. */
  setLocal({ battle = null, here = null } = {}) {
    this.local = { battle, here };
    this._sendStatus(false);
  }
  /** My game for gifts (makeBag) – null when it stops. */
  setBag(bag) {
    this.desk.bag = bag;
    this._emit();
  }
  setPosition(fn) {
    this.position = fn;
  }

  _sendStatus(beat) {
    const st = packStatus(this.local);
    const key = statusKey(st);
    const now = this.now();
    const prev = this.sent;
    if (!beat && key === prev.key) return;
    // (a battle's HP changes several times a turn: at most twice a second – the rest goes with the next tick)
    if (!beat && st.b && prev.b && now - prev.at < TG.battleMinMs) return void (prev.pending = true);
    // a battle that begins or ends goes over the relay too (partners without a direct link); else now and then
    const relay = !!st.b !== !!prev.b || now - prev.relayAt >= TG.statusRelayMs;
    this.send(st, { relay });
    this.sent = { key, b: !!st.b, at: now, relayAt: relay ? now : prev.relayAt, pending: false };
  }

  // ---- partners ------------------------------------------------------------------------------------------------------
  _in(m) {
    if (!m || m.t !== 'tg' || typeof m.from !== 'string' || m.from === this.me) return;
    if (!(this.link.others || []).includes(m.from)) return;
    if (m.op === 'st') {
      const st = unpackStatus(m);
      if (st && !this.spoke.has(m.from)) (this.spoke.add(m.from), this._emit());
      if (st) {
        this.statuses.set(m.from, { ...st, at: this.now() });
        this._emit();
      }
    } else if (m.op === 'ping') {
      const p = unpackPing(m);
      if (!p) return;
      if (!this.pingIn.has(m.from)) this.pingIn.set(m.from, new RateLimit({ burst: TG.ping.burst + 1, everyMs: TG.ping.everyMs }));
      if (!this.pingIn.get(m.from).take(this.now())) return;
      this.pings.set(m.from, { ...p, slot: m.from, at: this.now(), until: this.now() + TG.ping.keepMs });
      this._emit({ type: 'ping', slot: m.from, ping: this.pings.get(m.from) });
    } else if (m.op === 'ping-x') {
      if (this.pings.get(m.from)?.id === m.id) (this.pings.delete(m.from), this._emit());
    } else if (m.op?.startsWith('g-')) this.desk.receive(m).catch((e) => console.warn('gift', e));
  }

  /** A partner's status while it is fresh (null: none, or too old). */
  status(slot) {
    const s = this.statuses.get(slot);
    return s && this.now() - s.at < TG.staleMs ? s : null;
  }
  /**
   * Is `slot` on an older souldew – one without link trades and battles, Shared World, raids and gifts (2.x)? true once
   * our direct connection to them has stood OLDER_APP_MS without a single status from them. false while unknown (no
   * direct connection, or not long enough) – the callers then say what they said before (offline, no connection).
   */
  olderApp(slot) {
    if (this.spoke.has(slot)) return false;
    const since = this.directSince.get(slot);
    return since != null && this.now() - since >= OLDER_APP_MS;
  }

  /** Can `slot`'s app do `cap` ('gift' | 'ping' | 'watch')? Only builds that send a status can. */
  can(slot, cap) {
    return !!this.status(slot)?.caps.includes(cap);
  }

  /**
   * Is `slot` in a battle right now → { kind, enemy, active, mon } or null. From their status; a partner on an older
   * build: from the run doc (`where:<slot>`.fight, with their live data seen within the last 90 s – no HP then).
   * `mon`: their Pokémon in the battle from the run's live data (moves, HP), when known.
   */
  battleOf(slot) {
    const st = this.statuses.get(slot);
    const fresh = st && this.now() - st.at < TG.staleMs;
    let b = fresh ? st.battle : null;
    if (!fresh && this.doc) {
      const w = this.doc.get(`where:${slot}`, null);
      const l = live(this.doc, slot);
      if (w?.fight?.species && l?.at && Math.abs(this.now() - l.at) < 90000) b = { kind: w.fight.kind || 'wild', enemy: { species: w.fight.species, level: w.fight.level ?? null } };
    }
    if (!b) return null;
    const party = (this.doc && live(this.doc, slot)?.party) || [];
    const mon = b.active && party[b.active.index] ? party[b.active.index] : party.find((m) => m && !m.egg && m.hp > 0) || null;
    return { ...b, mon };
  }

  /** Where `slot` is: their status' place sign, else the run doc's `where:<slot>` → { gen, id, name } or null. */
  placeOf(slot) {
    const st = this.status(slot);
    if (st?.here) return st.here;
    const w = this.doc?.get(`where:${slot}`, null);
    return w && Number.isFinite(w.id) ? { gen: w.gen, id: w.id, name: w.name || '' } : null;
  }

  // ---- come to me ----------------------------------------------------------------------------------------------------
  /** Send "come to me" → the ping, or { error: 'limit' | 'nobody' }. */
  ping() {
    if (!(this.link.others || []).length) return { error: 'nobody' };
    if (!this.pingOut.take(this.now())) return { error: 'limit' };
    const pos = this.position?.() || null;
    const m = packPing({ id: newId(), ...(pos ? { fam: pos.fam, map: pos.map, x: pos.x, y: pos.y, size: pos.size } : {}), here: this.local.here });
    this.send(m, { relay: true });
    this.myPing = { id: m.id, at: this.now(), until: this.now() + TG.ping.keepMs };
    this._emit();
    return this.myPing;
  }
  /** Take my ping back. */
  unping() {
    if (!this.myPing) return;
    this.send({ t: 'tg', op: 'ping-x', id: this.myPing.id }, { relay: true });
    this.myPing = null;
    this._emit();
  }
  /** A partner's ping still standing. */
  pingOf(slot) {
    const p = this.pings.get(slot);
    return p && this.now() < p.until ? p : null;
  }
  dismissPing(slot) {
    if (this.pings.delete(slot)) this._emit();
  }

  // ---- catches and deaths from the run's log -------------------------------------------------------------------------
  _doc(keys) {
    let changed = false;
    for (const k of keys) {
      if (k.startsWith('tomb:') || k.startsWith('gift:') || k.startsWith('giftgot:')) changed = true;
      if (!k.startsWith('feed:')) continue;
      const id = k.slice(5);
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      const f = this.doc.get(k, null);
      if (!f || typeof f.slot !== 'string') continue;
      // the writer's clock: only entries from about now (a partner's old entries arriving after a reconnect aren't news)
      if (Math.abs(this.now() - (f.at || 0)) > TG.freshMs) continue;
      if (f.type === 'catch' && f.species) {
        const enc = f.area ? encounter(this.doc, f.area, f.slot) : null;
        this.pops = [...this.pops.filter((p) => this.now() - p.at < TG.popMs), { slot: f.slot, species: f.species, shiny: !!enc?.shiny, form: enc?.form || 0, at: this.now() }];
        this._emit({ type: 'catch', slot: f.slot, species: f.species });
        changed = true;
      } else if (f.type === 'death' && f.slot === this.me && f.area) this._tomb(id, f);
    }
    if (changed) this._emit();
  }

  /** My Pokémon died: a tombstone where I stood when its battle began, for everyone (when I was on the overworld). */
  _tomb(id, f) {
    const pos = this.position?.();
    if (!pos || !pos.fam) return;
    const enc = encounter(this.doc, f.area, this.me);
    const tid = String(id).replace(/[^\w-]/g, '_').slice(0, 40);
    // (on the tile: Gen 1–3 coordinates are its corner, the DS's – with a height – its centre)
    const ds = Number.isFinite(pos.h);
    const snap = (v) => (ds ? Math.floor(v / 16) * 16 + 8 : Math.round(v / 16) * 16);
    this.doc.set(`tomb:${this.me}:${tid}`, { fam: pos.fam, map: pos.map, x: snap(pos.x), y: snap(pos.y), ...(ds ? { h: Math.round(pos.h) } : {}), ...(pos.size ? { z: pos.size } : {}), species: enc?.species || null, at: Date.now() });
  }

  /** The tombstones still standing: [{ id, slot, fam, map, x, y, size, species, at }]. */
  tombs() {
    if (!this.doc) return [];
    const out = [];
    for (const [k, v] of Object.entries(this.doc.scan('tomb:'))) {
      if (!v || !Number.isInteger(v.map) || !Number.isFinite(v.x) || !Number.isFinite(v.y)) continue;
      if (Math.abs(this.now() - (v.at || 0)) > TG.tombMs) continue;
      out.push({ id: k, slot: k.split(':')[0], fam: v.fam, map: v.map, x: v.x, y: v.y, ...(Number.isFinite(v.h) ? { h: v.h } : {}), size: Array.isArray(v.z) ? v.z : null, species: v.species || null, at: v.at });
    }
    return out;
  }
  /** Catches to show now. */
  popsNow() {
    return this.pops.filter((p) => this.now() - p.at < TG.popMs);
  }

  // ---- gifts ---------------------------------------------------------------------------------------------------------
  /** The run doc as the gift ledger (shared/together.mjs GiftDesk). */
  ledger() {
    return {
      sent: (g) => this.doc?.set(`gift:${g.id}`, { from: g.from, to: g.to, gen: g.gen, fam: g.fam || '', item: g.item, n: g.n, pocket: g.pocket, at: Date.now() }),
      decided: (id) => {
        const v = this.doc?.get(`giftgot:${id}`, null);
        return v && typeof v === 'object' ? { ok: !!v.ok, why: typeof v.why === 'string' ? v.why : null } : null;
      },
      decide: (id, o) => this.doc?.set(`giftgot:${id}`, { ok: !!o.ok, ...(o.why ? { why: o.why } : {}), at: Date.now() }),
      // (the log line is the giver's to write – when it hears "done", also after a restart: one line, one toast)
      done: () => {},
      returned: (g) => {
        const r = this.doc?.get(`gift:${g.id}`, null);
        if (r) this.doc.set(`gift:${g.id}`, { ...r, back: true });
      },
      // my gifts out of my bag without an outcome yet (a restart while one was on its way)
      open: () => Object.entries(this.doc?.scan('gift:') || {})
        .filter(([id, r]) => r?.from === this.me && !r.back && !this.doc.get(`giftgot:${id}`, null))
        .map(([id, r]) => ({ id, ...r })),
    };
  }

  _gift(e) {
    if (e.type === 'done' && e.gift.from === this.me) this._logGift(e.gift);
    this._emit({ type: `gift-${e.type}`, gift: e.gift });
  }

  /** "Sam gave Tim a gift: Potion" – one line, by the giver's app (a fixed key: written twice, it stays one line). */
  _logGift(g) {
    if (!this.doc || !this.manifest) return;
    const entry = { type: 'gift', slot: g.from, partner: g.to, item: g.item, gen: g.gen, count: g.n,
      msg: msg('feed.gift', 'gave {partner} a gift: {what}', { partner: players(this.doc, this.manifest)[g.to]?.name || g.to.toUpperCase(), what: { item: g.item, gen: g.gen, n: g.n } }) };
    const id = `gift-${g.id}`;
    try {
      if (!this.doc.get(`feed:${id}`, null)) feed(this.doc, { ...entry, text: feedText(this.doc, this.manifest, entry) }, id);
    } catch (err) {
      console.warn('gift log', err);
    }
  }

  /**
   * Why I can't give `slot` anything right now (null: I can): 'off' (the rule), 'old' (their souldew doesn't know
   * gifts), 'offline', 'nogame' (my game isn't running here), 'busy' (a gift with them is open), or my game's reason.
   */
  giftWhy(slot) {
    if (!giftsAllowed(this.doc, this.manifest)) return 'off';
    if (!this.status(slot)) return (this.link.others || []).includes(slot) && this.link.status?.partners?.[slot] ? 'old' : 'offline';
    if (!this.can(slot, 'gift')) return 'old';
    if (!this.desk.bag) return 'nogame';
    if (this.desk.openWith(slot)) return 'busy';
    return this.desk.bag.check() || null;
  }
  /** What my bag can give right now: [{ item, count, pocket }] or null (no game, no readable bag). */
  giftable() {
    return this.desk.bag?.list?.() || null;
  }
  offer(slot, gift) {
    return this.desk.offer(slot, gift);
  }

  tick() {
    if (this.link.stopped) return this.stop(); // (the run's link was replaced or closed)
    const now = this.now();
    if (now - this.sent.at >= TG.statusEveryMs || this.sent.pending) this._sendStatus(true);
    this.desk.tick();
    // a ping clears when I arrive (or runs out)
    let changed = false;
    const pos = this.position?.() || null;
    for (const [slot, p] of this.pings) {
      if (now >= p.until || pingArrived(p, pos)) (this.pings.delete(slot), (changed = true));
    }
    if (this.myPing && now >= this.myPing.until) (this.myPing = null), (changed = true);
    // how long each partner has been directly connected (olderApp) – the moment one counts as older is a change
    for (const slot of this.link.others || []) {
      if (!this.link.status?.partners?.[slot]?.p2p) this.directSince.delete(slot);
      else if (!this.directSince.has(slot)) this.directSince.set(slot, now);
      const older = this.olderApp(slot);
      if (older === this.older.has(slot)) continue;
      changed = true;
      if (older) (this.older.add(slot), this._olderNote(slot));
      else this.older.delete(slot);
    }
    for (const [slot, s] of this.statuses) if (now - s.at >= TG.staleMs) (this.statuses.delete(slot), (changed = true));
    if (this.pops.length && this.pops.some((p) => now - p.at >= TG.popMs)) (this.pops = this.popsNow()), (changed = true);
    if (changed) this._emit();
  }

  /**
   * One line in the run's log, once per partner on an older souldew: their 2.x app shows a new log line of someone else
   * as a notice, so this is how they learn that the others are on 3.0 and what they miss. Every 3.0 player writes the
   * same entry (keyed by the older partner's slot), so it's there once. The English text is what a 2.x app shows: it
   * doesn't know the key.
   */
  _olderNote(slot) {
    if (!this.olderApp(slot) || !this.doc || !this.manifest || runMode(this.manifest) === 'nuzlocke') return;
    const id = `older-${slot}`;
    try {
      if (this.doc.get(`feed:${id}`, null)) return;
      const name = players(this.doc, this.manifest)[slot]?.name || slot.toUpperCase();
      const entry = { type: 'note', slot: this.me, about: slot,
        msg: msg('feed.olderApp', '{name} is on an older souldew – trading, battling, raids and Shared World need souldew 3.0 on every computer of the run. Update in Settings › About.', { name }) };
      feed(this.doc, { ...entry, text: feedText(this.doc, this.manifest, entry) }, id);
    } catch (err) {
      console.warn('older app note', err);
    }
  }

  stop() {
    clearInterval(this.timer);
    this.offWorld?.();
    this.offDoc?.();
  }
}

/**
 * This computer's game as GiftDesk's bag. `get()` → { entry, state, mem: { read, write, watch? }, why } – what the play
 * view knows right now (`why`: a reason it can't give or take: 'battle', 'menu', 'link', 'waiting' …, or null).
 */
export function makeBag(get) {
  const cur = () => get() || {};
  const gen = () => cur().entry?.gen || 0;
  const pocketOpt = (pocket) => ({ pocket: pocket ?? null });
  const read = (a, n) => cur().mem?.read?.(a, n) || null;
  const bag = {
    get gen() {
      return gen();
    },
    get fam() {
      return cur().entry ? bagFamily(cur().entry) : '';
    },
    check() {
      const c = cur();
      if (!c.entry || !c.mem?.read || !giftSupported(c.entry)) return 'unsupported';
      return c.why || null;
    },
    list() {
      const c = cur();
      if (!c.entry || !c.mem?.read) return null;
      const items = bagItems(c.entry, read, c.state);
      return items ? giftList(c.entry.gen, items) : null;
    },
    has(item, n, pocket) {
      return !!bag.list()?.some((x) => x.item === item && (x.pocket ?? null) === (pocket ?? null) && x.count >= n);
    },
    room(item, n, pocket) {
      const c = cur();
      return !!c.entry && bagRoom(c.entry, read, c.state, item, n, pocketOpt(pocket)) === true;
    },
    remove(item, n, pocket) {
      const c = cur();
      return removeItem(c.entry, c.mem, c.state, item, n, pocketOpt(pocket));
    },
    async add(item, n, pocket) {
      const c = cur();
      // all of it or nothing: never part of a gift (a stack near its limit)
      if (bagRoom(c.entry, read, c.state, item, n, pocketOpt(pocket)) !== true) return { error: 'full' };
      const res = await addItem(c.entry, c.mem, c.state, item, n, pocketOpt(pocket));
      if (res?.ok && res.added !== n) {
        await removeItem(c.entry, c.mem, c.state, item, res.added, pocketOpt(pocket));
        return { error: 'changed' };
      }
      return res;
    },
  };
  return bag;
}

const worldTables = new WeakMap(); // game entry → its Shared World table (or null)
/**
 * Why my game can't give or take an item right now – null when it can. A gift is only written on the overworld:
 * never during a battle (the game keeps its own copy of the bag then), a link, before live tracking found the team,
 * and – where souldew reads the screen state (Shared World's tables: Gen 1–4 today, any generation that gets them) –
 * not while a menu, a text, a script or a screen fade holds the player (the bag menu keeps its own list of the bag).
 */
export function gameWhy({ entry, read, live = false, inBattle = false, link = false }) {
  if (link) return 'link';
  if (!live || !entry) return 'waiting';
  if (inBattle) return 'battle';
  if (!worldTables.has(entry)) worldTables.set(entry, (entry.gen === 4 ? dsWorldTable(entry) : worldTable(entry)) || null);
  const t = worldTables.get(entry);
  if (t?.gen === 4) {
    // (the DS: the field runs, nothing on top of it, no script or warp holding the player)
    const ptr = read ? dsPointers(t, read) : null;
    const r = ptr ? dsReadFrame(t, read, ptr) : null;
    return r && !dsDrawable(r) ? 'overworld' : null;
  }
  const cam = t && read ? readCamera(t, read) : null;
  if (cam && (cam.battle || cam.locked || cam.replay || cam.fade >= 16)) return 'overworld';
  return null;
}

/** The players of a run, for the views. */
export const runSlots = (manifest) => (manifest ? slotsOf(manifest) : []);
