// Raids in the app (docs/MULTIPLAYER.md › "Raid", shared/raid.mjs): the players of a run fight the same trainer, each in
// their own game, with one shared health pool. One hub per run document – attached when the run opens, like the
// rock-paper-scissors hub – holds:
//   - the raids in the doc (raid:<id>, raid:<id>:<slot>), started from the board, answered on the invite card;
//   - this build's capability and whether the game playing now can take part (raidcap:<slot>) – a partner whose
//     souldew never wrote one (an older 3.0 build) can't be invited;
//   - the game side (gameTick, from the play view's loop): this player's RaidPlayer, the writes into the game through
//     the cheat path (read back), holding the game at its first menu while the others' battles begin;
//   - the host's part: once everybody answered (or after RAID.answerMs) the raid starts with those who joined;
//   - the log entry once a raid is over (every computer writes the same one, keyed by the raid).
import { useEffect, useState } from '/vendor/htm-preact.mjs';
import {
  RAID, RAID_VERSION, raidKey, seatKey, capKey, CAP_PREFIX, raidsIn, newRaid, newRaidId, raidStatus, raidOver, raidResult,
  raidFeedEntry, nextClock, RaidPlayer, rosterOf, foldPool,
} from '/shared/raid.mjs';
import { raidSupport, raidView, raidWrites } from '/shared/live/raidhp.mjs';
import { rules as getRules, slotsOf, runMode, logRaid } from './run.mjs';

const hubs = new WeakMap(); // RunDoc → RaidHub
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Until the u32 at `addr` reads `value` (the page's memory mirror), at most `ms`. */
async function waitFor(read, { addr, value, ms = 3000 }) {
  const t0 = Date.now();
  for (;;) {
    const b = read(addr, 4);
    if (b && ((b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0) === value >>> 0) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(50);
  }
}
/**
 * One HP change's writes, in order (shared/live/raidhp.mjs raidWrites). A write that waits for the game first (Gen 3:
 * the party copy once the HP bar the game slides from it got there) is left out when the game doesn't get there in
 * time – written while the bar still slides, it would move the bar's start under it; the battle's own HP is in
 * already, and the bar follows the next hit. → false: the host refused a write.
 */
export async function writeInOrder(list, read, write) {
  for (const x of list) {
    if (x.wait && !(await waitFor(read, x.wait))) continue;
    const ok = await write(x.addr, x.bytes);
    if (ok === false || ok?.ok === false) return false;
  }
  return true;
}
const TICK_MS = 1000;

/** The run's raid rules: allowed at all ('raids', default on), and whether Pokémon that go down count ('raidDeaths', default on). */
export function raidRules(r) {
  return { on: (r?.raids ?? 'on') !== 'off', deaths: r?.raidDeaths !== false };
}

export class RaidHub {
  constructor({ doc, manifest, me, now = () => Date.now() }) {
    Object.assign(this, { doc, manifest, me, now });
    this.online = new Set();
    this.listeners = new Set();
    this.goSeen = new Map(); // raid id → when this computer saw it start (each computer's countdown runs on its own clock)
    this.players = new Map(); // raid id → RaidPlayer (this player's game in it)
    this.preKey = null; // the battle on screen while no raid ran (a battle already on when a raid starts isn't the raid's)
    this.lastCap = null;
    this.held = false; // this hub paused the game (waiting for the others' battles)
    this.gameState = {}; // the driver's memory for the game running now
    this.lastView = null;
    this.writing = false;
    this.unsub = doc.subscribe((keys) => {
      if (keys.some((k) => k.startsWith('raid:') || k.startsWith(CAP_PREFIX))) this._changed();
    });
    this.timer = setInterval(() => this._tick(), TICK_MS);
  }

  stop() {
    this.unsub?.();
    clearInterval(this.timer);
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  _emit() {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (e) {
        console.warn('raid listener', e);
      }
    }
  }
  _changed() {
    this._hostTick();
    this._log();
    this._emit();
  }

  rules() {
    return raidRules(getRules(this.doc, this.manifest));
  }
  /** A SoulLink with partners: raids are possible at all. */
  available() {
    return runMode(this.manifest) !== 'nuzlocke' && slotsOf(this.manifest).length > 1 && this.rules().on;
  }

  // ---- capability ----------------------------------------------------------------------------------------------------

  /** This build knows raids; `game`: whether the game playing now can take part ({ gen, ok, why }, null: none running). */
  announce(game = null) {
    const g = game ? { gen: game.gen ?? null, ok: !!game.ok, why: game.why || null } : null;
    const k = JSON.stringify(g);
    const cur = this.doc.get(capKey(this.me));
    if (k === this.lastCap && cur?.v === RAID_VERSION) return;
    this.lastCap = k;
    this.doc.set(capKey(this.me), { v: RAID_VERSION, at: this.now(), game: g });
  }

  capOf(slot) {
    const c = this.doc.get(capKey(slot));
    return c && typeof c === 'object' && Number.isInteger(c.v) && c.v >= RAID_VERSION ? c : null;
  }

  /** Can `slot` be invited now? { ok } or { ok: false, why: 'offline' | 'old' | 'game' | 'busy' }. */
  canInvite(slot) {
    if (slot === this.me) return { ok: true };
    if (!this.online.has(slot)) return { ok: false, why: 'offline' };
    const c = this.capOf(slot);
    if (!c) return { ok: false, why: 'old' };
    if (c.game && !c.game.ok) return { ok: false, why: 'game', game: c.game };
    if (this.activeFor(slot)) return { ok: false, why: 'busy' };
    return { ok: true };
  }

  // ---- raids -----------------------------------------------------------------------------------------------------------

  /** Every raid with where it stands, newest first. */
  list() {
    const now = this.now();
    return Object.entries(raidsIn(this.doc)).map(([id, { raid, seats }]) => ({ id, raid, seats, st: raidStatus(raid, seats, { now, goSeen: this._goSeen(id, raid) }) }))
      .sort((a, b) => b.raid.at - a.raid.at);
  }
  _goSeen(id, raid) {
    if (raid.state !== 'go') return null;
    if (!this.goSeen.has(id)) this.goSeen.set(id, this.now());
    return this.goSeen.get(id);
  }

  /** The raid `slot` is in right now (not over), or null. */
  activeFor(slot = this.me) {
    return this.list().find((r) => !raidOver(r.st) && r.raid.players.includes(slot) && r.st.players[slot] !== 'declined'
      && !(slot !== r.raid.host && r.st.players[slot] === 'invited' && r.raid.state !== 'open')) || null;
  }

  /** The raid to show this player: the one they're in, an invite waiting for their answer, or one that just ended. */
  current() {
    const now = this.now();
    const mine = this.list().filter((r) => r.raid.players.includes(this.me));
    const live = mine.find((r) => !raidOver(r.st) && !(r.st.players[this.me] === 'declined'));
    if (live) return live;
    // a finished raid stays up for its result card for a while (until dismissed)
    return mine.find((r) => raidOver(r.st) && r.st.phase !== 'stale' && r.st.phase !== 'cancelled' && r.st.players[this.me] !== 'declined' && r.st.players[this.me] !== 'invited'
      && now - (this._endedAt(r) || r.raid.at) < 10 * 60000 && !this.dismissed?.has(r.id)) || null;
  }
  _endedAt(r) {
    const ats = Object.values(r.seats).flatMap((s) => [s?.fin?.at, s?.out?.at]).filter((x) => x > 0);
    return ats.length ? Math.max(...ats) : null;
  }
  dismiss(id) {
    (this.dismissed ||= new Set()).add(id);
    this._emit();
  }

  /** Start a raid with `players` (slots, without me). → the raid, or { error }. */
  start(players) {
    if (!this.available()) return { error: 'rules' };
    if (this.activeFor()) return { error: 'busy' };
    const invite = players.filter((s) => s !== this.me && this.canInvite(s).ok);
    if (!invite.length) return { error: 'nobody' };
    const raid = newRaid({ id: newRaidId(), host: this.me, players: invite, at: this.now(), deaths: this.rules().deaths });
    this.doc.set(raidKey(raid.id), raid);
    this.doc.set(seatKey(raid.id, this.me), { v: RAID_VERSION, join: true, ev: [] });
    this._emit();
    return raid;
  }

  /** My answer to an invite. */
  answer(id, yes) {
    const r = this.list().find((x) => x.id === id);
    if (!r || r.raid.state !== 'open' || !r.raid.players.includes(this.me)) return false;
    if (yes && this.activeFor() && this.activeFor().id !== id) return false;
    this.doc.set(seatKey(id, this.me), { v: RAID_VERSION, join: !!yes, ...(yes ? {} : { why: 'declined' }), ev: [] });
    return true;
  }

  /** The host calls it off before it started. */
  cancel(id) {
    const r = this.list().find((x) => x.id === id);
    if (!r || r.raid.host !== this.me || r.raid.state !== 'open') return false;
    this.doc.set(raidKey(id), { ...r.raid, state: 'cancel' });
    return true;
  }

  /** I leave the raid (my game is left as it is: no more writes). */
  leave(id) {
    const r = this.list().find((x) => x.id === id);
    if (!r) return false;
    if (r.raid.state === 'open' && r.raid.host === this.me) return this.cancel(id);
    if (r.raid.state === 'open') return this.answer(id, false);
    this.players.get(id)?.quit();
    this._seat(id, (s) => ({ ...s, out: s.out || { why: 'quit', at: this.now(), lc: nextClock(r.seats) } }));
    this._resume();
    return true;
  }

  _seat(id, fn) {
    const cur = this.doc.get(seatKey(id, this.me));
    const base = cur && typeof cur === 'object' ? cur : { v: RAID_VERSION, join: true, ev: [] };
    this.doc.set(seatKey(id, this.me), fn({ ...base, ev: Array.isArray(base.ev) ? base.ev : [] }));
  }

  /** The host: once everybody answered (or after RAID.answerMs) the raid starts with those who joined – or not at all. */
  _hostTick() {
    const now = this.now();
    for (const r of this.list()) {
      if (r.raid.host !== this.me || r.raid.state !== 'open') continue;
      const others = r.raid.players.filter((s) => s !== this.me);
      const joined = others.filter((s) => r.seats[s]?.join === true);
      const answered = others.every((s) => r.seats[s]?.join === true || r.seats[s]?.join === false);
      if (!answered && now - r.raid.at < RAID.answerMs) continue;
      this.doc.set(raidKey(r.id), joined.length ? { ...r.raid, state: 'go', go: now } : { ...r.raid, state: 'cancel' });
    }
  }

  /** The log entry of a raid that is over (won or lost) – every computer writes the same one, keyed by the raid. */
  _log() {
    for (const r of this.list()) {
      if (!(r.st.phase === 'won' || r.st.phase === 'lost') || this.doc.get(`feed:raid-${r.id}`)) continue;
      // only a computer that was in it (the others may not have every seat yet)
      if (!rosterOf(r.raid, r.seats).includes(this.me)) continue;
      try {
        logRaid(this.doc, this.manifest, raidFeedEntry(r.raid, raidResult(r.raid, r.seats, r.st), this.now()));
      } catch (e) {
        console.warn('raid log', e);
      }
    }
  }

  _tick() {
    this._hostTick();
    // nobody of my raid reachable for a while: I leave it (my game is left as it is)
    const r = this.activeFor();
    if (r && r.raid.state === 'go' && rosterOf(r.raid, r.seats).length > 1) {
      const partners = rosterOf(r.raid, r.seats).filter((s) => s !== this.me && r.st.players[s] !== 'out' && r.st.players[s] !== 'done');
      if (partners.length && partners.every((s) => !this.online.has(s))) {
        this.lostSince ??= this.now();
        if (this.now() - this.lostSince > RAID.goneMs && r.st.players[this.me] !== 'out') {
          this.players.get(r.id)?.quit();
          this._seat(r.id, (s) => ({ ...s, out: s.out || { why: 'gone', at: this.now(), lc: nextClock(r.seats) } }));
          this._resume();
        }
      } else this.lostSince = null;
    }
    if (r) this._emit(); // (the countdown)
  }

  // ---- the game side (the play view's loop) ------------------------------------------------------------------------

  /**
   * One look at this player's game: `entry` (the live reader's game), `read` / `write` (the player's memory – write
   * resolves true once the host wrote it), `team` (the live party), `emu` (pause / resume / paused). Every few
   * hundred ms while a game of this run runs.
   */
  async gameTick({ entry, read, write, team = null, emu = null, ownGame = true, link = false, foe = null }) {
    if (emu) this.lastEmu = emu;
    const support = entry ? raidSupport(entry) : null;
    this.announce(entry && ownGame ? { gen: entry.gen, ok: support.ok, why: support.why } : null);
    if (!entry || !support?.ok || !ownGame || link || this.writing) return null;
    let r = this.activeFor();
    // a raid that is over (won) while this player's battle still runs: its last hit at 1 HP, then the battle's end
    if (!r) for (const [id, pl] of this.players) if (pl.key && !pl.ended) r = this.list().find((x) => x.id === id) || null;
    const view = raidView(entry, read, this.gameState);
    this.lastView = view;
    if (!r || r.raid.state !== 'go' || r.st.players[this.me] === 'out' || r.st.players[this.me] === 'done' || !rosterOf(r.raid, r.seats).includes(this.me)) {
      // no raid running for me: remember the battle on screen (one already on when a raid starts isn't the raid's)
      if (!r || r.raid.state === 'open') this.preKey = view?.key || null;
      if (this.held) this._resume(emu);
      return null;
    }
    let p = this.players.get(r.id);
    if (!p) {
      p = new RaidPlayer({ me: this.me, skipKey: this.preKey });
      this.players.set(r.id, p);
    }
    const allIn = rosterOf(r.raid, r.seats).every((s) => r.seats[s]?.b || r.seats[s]?.out || r.seats[s]?.fin);
    const res = p.tick({ view, pool: foldPool(r.raid, r.seats), now: this.now(), allIn, team });
    const seats = r.seats;
    // what the partners see of me: my team (still able to fight / all) and my opponent out now
    const tm = team?.length ? [team.filter((m) => m.hp > 0).length, Math.min(6, team.length)] : null;
    const bs = p.key && !p.ended && foe > 0 ? foe : null;
    const mine = r.seats[this.me] || {};
    const showChanged = (tm && String(tm) !== String(mine.tm || '')) || (bs && bs !== mine.bs);
    if (res.begin || res.events.length || res.out || res.fin || showChanged) {
      this._seat(r.id, (s) => {
        const next = { ...s, ...(tm ? { tm } : {}), ...(bs ? { bs } : {}) };
        if (res.begin) next.b = { ...res.begin, gen: entry.gen, lc: nextClock(seats) };
        if (res.events.length) {
          let lc = nextClock(seats);
          next.ev = [...next.ev, ...res.events.map((e) => [lc++, ...e])].slice(0, RAID.maxEvents);
        }
        if (res.out) next.out = { ...res.out, at: this.now(), lc: nextClock(seats) + res.events.length };
        if (res.fin) next.fin = { ...res.fin, lc: nextClock(seats) + res.events.length };
        return next;
      });
    }
    if (res.writes.length && view) {
      this.writing = true;
      try {
        for (const w of res.writes) {
          if (!(await writeInOrder(raidWrites(entry, read, this.gameState, view, w.idx, w.hp), read, write))) {
            // the host refused it: this game takes no more writes
            p.quit();
            this._seat(r.id, (s) => ({ ...s, out: s.out || { why: 'desync', at: this.now(), lc: nextClock(seats) } }));
            return res;
          }
        }
      } finally {
        this.writing = false;
      }
    }
    // waiting for the others' battles: the game stands at its first menu (resumed once all are in or the wait is over)
    if (res.hold && !this.held && emu && !emu.paused?.()) {
      this.held = true;
      emu.pause?.();
      this._emit();
    } else if (!res.hold && this.held) this._resume(emu);
    if (res.out || res.fin) this._resume(emu);
    return res;
  }

  /** Is this player's raid battle on right now (the "Deaths in a raid count" rule looks at it)? */
  inRaidBattle() {
    for (const p of this.players.values()) if (p.key && !p.ended) return true;
    return false;
  }

  // ---- "Deaths in a raid count" off (app.mjs applySnap) ---------------------------------------------------------
  // A raid is a real battle: a Pokémon that goes down stays at 0 HP in the game until it is healed. With the rule off
  // it is taken as standing until then – kept in the run (raidspared:<slot>, this player's own key), so it survives
  // closing the app.

  /** During this player's raid battle: the team as the game shows it (keys of those that went down in it are kept). */
  spare(party = []) {
    const r = this.activeFor();
    if (!r) return;
    // the ones standing when the battle began (a Pokémon already down before the raid is no raid's)
    if (this.spareFor !== r.id) {
      this.spareFor = r.id;
      this.standing = new Set(party.filter((m) => m?.key && m.hp > 0).map((m) => m.key));
    }
    const down = party.filter((m) => m?.key && m.maxHp > 0 && m.hp === 0 && this.standing?.has(m.key)).map((m) => m.key);
    const cur = this._spared();
    const next = [...new Set([...cur, ...down])].slice(-12);
    if (next.length !== cur.length) this.doc.set(`raidspared:${this.me}`, next);
  }

  _spared() {
    const v = this.doc.get(`raidspared:${this.me}`);
    return Array.isArray(v) ? v.filter((k) => typeof k === 'string').slice(0, 12) : [];
  }

  /** Outside the raid battle: { party, held } with the spared ones standing (1 HP) until healed – or null (nothing to do). */
  spared(party = [], held = null) {
    const keys = this._spared();
    if (!keys.length) return null;
    const set = new Set(keys);
    const healed = party.filter((m) => m?.key && set.has(m.key) && m.hp > 0).map((m) => m.key);
    if (healed.length) this.doc.set(`raidspared:${this.me}`, keys.filter((k) => !healed.includes(k)));
    if (!party.some((m) => m?.key && set.has(m.key) && m.hp === 0)) return null;
    const nextHeld = held && typeof held.has === 'function' ? new Map([...held].filter(([k]) => !set.has(k))) : held;
    return { party: party.map((m) => (m?.key && set.has(m.key) && m.hp === 0 ? { ...m, hp: 1 } : m)), held: nextHeld };
  }

  /** Is this game waiting (paused by the raid) for the others' battles? */
  holding() {
    return this.held;
  }

  _resume(emu = this.lastEmu) {
    if (!this.held) return;
    this.held = false;
    try {
      if (emu?.paused?.()) emu.resume?.();
    } catch {
      // the game is gone
    }
    this._emit();
  }
}

/** The raid hub of a run (created on first use). */
export function attachRaid({ doc, manifest, me }) {
  if (!doc || !manifest || !me) return null;
  let h = hubs.get(doc);
  if (h && h.me === me && h.manifest?.id === manifest.id) {
    h.manifest = manifest;
    return h;
  }
  h?.stop();
  h = new RaidHub({ doc, manifest, me });
  hubs.set(doc, h);
  return h;
}

export const raidFor = (doc) => (doc ? hubs.get(doc) || null : null);

/** The run closes: its hub stops. */
export function detachRaid(doc) {
  const h = doc && hubs.get(doc);
  if (!h) return;
  h._resume();
  h.stop();
  hubs.delete(doc);
}

/** A Preact hook: re-renders on every change of the run's raids. */
export function useRaid(doc) {
  const h = raidFor(doc);
  const [, set] = useState(0);
  useEffect(() => (h ? h.on(() => set((n) => n + 1)) : undefined), [h]);
  return h;
}
