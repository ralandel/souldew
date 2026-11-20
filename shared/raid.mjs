// Raids (docs/MULTIPLAYER.md › "Raid"): the players of a run fight the same trainer together, each in their own game,
// and the trainer's Pokémon share ONE health pool. Every hit in anybody's game takes its share (a percentage of that
// game's max HP, so randomized games with other Pokémon work too) off the pool, and souldew writes the pool back into
// every game. The trainer is beaten when the pool is empty – in everyone's game at once, not once per player.
//
// This module has no browser in it (tests drive it directly):
//   - the doc entries a raid lives in, and checks for what comes from the other computers (untrusted);
//   - the pool: folded from every player's damage and heal events in one order every computer agrees on
//     (Lamport clock, then the slot, then the player's own sequence) – so every computer computes the same pool from
//     the same events, whatever order they arrived in;
//   - a raid's phase, result and log line;
//   - RaidPlayer: one game's side – what its battle shows becomes events, the pool becomes HP writes (only while the
//     game waits for the player's action, read back afterwards), and when this player is out.
//
// Doc entries (web/lib/doc.mjs – one writer per key, so nothing is lost to "last writer wins"):
//   raid:<id>          the host's: { v, id, host, at, players, boss, state: 'open'|'go'|'cancel', go, deaths }
//   raid:<id>:<slot>   each player's own: { v, join, why, b (their battle), ev (their events), out, fin }
//   raidcap:<slot>     each player's: { v, at, game: { gen, ok, why } } – this build knows raids, and whether the game
//                      they play now can take part (older 3.0 builds never write it: they get no invite)
import { ALL_SLOTS } from './slots.mjs';

/** The capability a build announces (raidcap:<slot>.v ≥ RAID_VERSION). */
export const RAID_VERSION = 1;
/** 100 % of a pool, in basis points (integers only: every computer must compute exactly the same). */
export const FULL = 10000;
/** Times (ms) and limits. */
export const RAID = {
  answerMs: 30000, // invited players answer within this (then the raid starts with those who joined)
  countdownMs: 10000, // after the start: everybody gets ready, then walks into their next trainer battle
  waitMs: 45000, // a game whose battle began waits (paused at its first menu) this long for the others' to begin
  lateMs: 300000, // a player whose battle hasn't begun this long after the start is out
  goneMs: 30000, // no partner of the raid reachable this long: this player leaves (their game is left as it is)
  verifyMs: 900, // a write is read back once the page's memory mirror has caught up
  maxEvents: 600, // per player and raid (a long battle has a few dozen)
  maxPlayers: 4,
  keepMs: 12 * 3600000, // an unfinished raid older than this is over
};
export const DOC_PREFIX = 'raid:';
export const CAP_PREFIX = 'raidcap:';
export const raidKey = (id) => `${DOC_PREFIX}${id}`;
export const seatKey = (id, slot) => `${DOC_PREFIX}${id}:${slot}`;
export const capKey = (slot) => `${CAP_PREFIX}${slot}`;

const SLOTS = ALL_SLOTS;
const okSlot = (s) => SLOTS.includes(s);
export const okId = (id) => typeof id === 'string' && /^[0-9a-f]{8,24}$/.test(id);
const int = (x, lo, hi) => (Number.isInteger(x) && x >= lo && x <= hi ? x : null);
const OUT_WHY = ['wiped', 'left', 'desync', 'quit', 'late', 'gone', 'unsupported'];
const NO_WHY = ['declined', 'busy', 'unsupported', 'rules', 'solo'];

/** A random raid id (hex). */
export const newRaidId = (rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) => [...rand(6)].map((b) => b.toString(16).padStart(2, '0')).join('');

// ---- doc entries: what we write, and what we take from the others -------------------------------------------------

/** The host's raid record for a new raid. `boss`: { mode: 'next' } – the next trainer battle every player starts. */
export function newRaid({ id, host, players, at, deaths = true }) {
  const list = [host, ...players.filter((s) => s !== host)].filter((s, i, l) => okSlot(s) && l.indexOf(s) === i).slice(0, RAID.maxPlayers);
  return { v: RAID_VERSION, id, host, at, players: list, boss: { mode: 'next' }, state: 'open', go: null, deaths: !!deaths };
}

/** A raid record from the doc, checked (null: not one). */
export function cleanRaid(v, id) {
  if (!v || typeof v !== 'object' || v.v !== RAID_VERSION || v.id !== id || !okId(id) || !okSlot(v.host)) return null;
  const players = Array.isArray(v.players) ? v.players.filter((s, i, l) => okSlot(s) && l.indexOf(s) === i).slice(0, RAID.maxPlayers) : [];
  if (players[0] !== v.host || players.length < 2) return null;
  const state = ['open', 'go', 'cancel'].includes(v.state) ? v.state : 'open';
  return { v: RAID_VERSION, id, host: v.host, at: Number.isFinite(v.at) ? v.at : 0, players, boss: { mode: 'next' }, state,
    go: Number.isFinite(v.go) ? v.go : null, deaths: v.deaths !== false };
}

/** A player's seat entry from the doc, checked – damage and heal events kept only while well-formed. */
export function cleanSeat(v) {
  if (!v || typeof v !== 'object' || v.v !== RAID_VERSION) return null;
  const out = { v: RAID_VERSION, join: v.join === true ? true : v.join === false ? false : null, why: NO_WHY.includes(v.why) ? v.why : null, b: null, ev: [], out: null, fin: null };
  const b = v.b;
  if (b && typeof b === 'object') {
    const n = int(b.n, 1, 6);
    const max = Array.isArray(b.max) ? b.max.slice(0, 6).map((x) => int(x, 1, 65535) ?? 1) : [];
    if (n) out.b = { n, max, sp: Array.isArray(b.sp) ? b.sp.slice(0, 6).map((x) => int(x, 0, 2000) ?? 0) : [], lv: Array.isArray(b.lv) ? b.lv.slice(0, 6).map((x) => int(x, 0, 100) ?? 0) : [],
      at: Number.isFinite(b.at) ? b.at : 0, lc: int(b.lc, 0, 1e9) ?? 0, gen: int(b.gen, 1, 9) ?? null, tr: int(b.tr, 0, 65535) };
  }
  if (Array.isArray(v.ev)) {
    for (const e of v.ev.slice(0, RAID.maxEvents)) {
      if (!Array.isArray(e)) break;
      const [lc, k, i, bp] = e;
      // (one malformed event ends the list: the order of the rest would depend on it)
      if (int(lc, 1, 1e9) === null || (k !== 'd' && k !== 'h') || int(i, 0, 5) === null || int(bp, 1, FULL) === null) break;
      out.ev.push([lc, k, i, bp]);
    }
  }
  // what the partners show of this player: their team (Pokémon that can still fight, of how many) and the opponent
  // that is out in their game (National Dex number – randomized games have others)
  if (Array.isArray(v.tm) && int(v.tm[0], 0, 6) !== null && int(v.tm[1], 0, 6) !== null && v.tm[0] <= v.tm[1]) out.tm = [v.tm[0], v.tm[1]];
  if (int(v.bs, 1, 2000) !== null) out.bs = v.bs;
  if (v.out && typeof v.out === 'object' && OUT_WHY.includes(v.out.why)) out.out = { why: v.out.why, at: Number.isFinite(v.out.at) ? v.out.at : 0, lc: int(v.out.lc, 0, 1e9) ?? 0 };
  if (v.fin && typeof v.fin === 'object') out.fin = { at: Number.isFinite(v.fin.at) ? v.fin.at : 0, lc: int(v.fin.lc, 0, 1e9) ?? 0 };
  return out;
}

/** Every raid in the doc: { id: { raid, seats: { slot: seat } } } (unusable entries left out). */
export function raidsIn(doc) {
  const all = doc?.scan?.(DOC_PREFIX) || {};
  const out = {};
  for (const [k, v] of Object.entries(all)) {
    if (!/^[0-9a-f]{8,24}$/.test(k)) continue;
    const raid = cleanRaid(v, k);
    if (raid) out[k] = { raid, seats: {} };
  }
  for (const [k, v] of Object.entries(all)) {
    const m = k.match(/^([0-9a-f]{8,24}):(p[1-8])$/);
    if (!m || !out[m[1]] || !out[m[1]].raid.players.includes(m[2])) continue;
    const seat = cleanSeat(v);
    if (seat) out[m[1]].seats[m[2]] = seat;
  }
  return out;
}

/** The players who are in the raid: the host and everybody who said yes. */
export const rosterOf = (raid, seats) => raid.players.filter((s) => s === raid.host || seats[s]?.join === true);

/** The next Lamport clock value for a new event of this computer: past everything it has seen of the raid. */
export function nextClock(seats) {
  let m = 0;
  for (const s of Object.values(seats || {})) {
    if (!s) continue;
    for (const e of s.ev || []) if (e[0] > m) m = e[0];
    if (s.b?.lc > m) m = s.b.lc;
    if (s.out?.lc > m) m = s.out.lc;
    if (s.fin?.lc > m) m = s.fin.lc;
  }
  return m + 1;
}

// ---- the pool ----------------------------------------------------------------------------------------------------

/**
 * The pool, folded from every roster player's events in the agreed order. → { size, pools: [bp per opponent slot],
 * dealt: { slot: bp taken off the pool }, downBy: [slot whose hit emptied each slot | null], events }
 * A slot exists once a player's battle shows that many opponents (the biggest party any of them shows). Damage takes
 * at most what is left; a heal (a potion, a draining move, the opponent's item) goes back in, up to 100 % – never into
 * a slot that is already empty (it stays down for everybody).
 */
export function foldPool(raid, seats) {
  const roster = rosterOf(raid, seats);
  const size = Math.max(0, ...roster.map((s) => seats[s]?.b?.n || 0));
  const evs = [];
  for (const s of roster) (seats[s]?.ev || []).forEach((e, n) => evs.push({ s, n, lc: e[0], k: e[1], i: e[2], bp: e[3] }));
  evs.sort((a, b) => a.lc - b.lc || (a.s < b.s ? -1 : a.s > b.s ? 1 : 0) || a.n - b.n);
  const pools = Array.from({ length: size }, () => FULL);
  const downBy = Array.from({ length: size }, () => null);
  const dealt = Object.fromEntries(roster.map((s) => [s, 0]));
  for (const e of evs) {
    if (e.i >= size) continue;
    if (e.k === 'd') {
      const take = Math.min(e.bp, pools[e.i]);
      if (take <= 0) continue;
      pools[e.i] -= take;
      dealt[e.s] += take;
      if (pools[e.i] === 0) downBy[e.i] = e.s;
    } else if (pools[e.i] > 0) pools[e.i] = Math.min(FULL, pools[e.i] + e.bp);
  }
  return { size, pools, dealt, downBy, events: evs.length };
}

/** The HP a game should show for a pool value: its share of that game's max HP – at least 1 while the slot isn't empty. */
export function hpFor(bp, maxHp) {
  if (!(maxHp > 0)) return 0;
  if (bp <= 0) return 0;
  return Math.max(1, Math.min(maxHp, Math.round((bp * maxHp) / FULL)));
}

/** A change of `delta` HP (negative: damage) in a game with `maxHp`, in basis points (at least 1 for any change). */
export function bpOf(delta, maxHp) {
  if (!(maxHp > 0) || !delta) return 0;
  return Math.max(1, Math.min(FULL, Math.round((Math.abs(delta) * FULL) / maxHp)));
}

// ---- a raid's phase and result ----------------------------------------------------------------------------------

/**
 * Where a raid stands, as every computer works it out from the same entries. `now` and `goSeen` (when this computer
 * saw the start – the countdown runs on each computer's own clock) are this computer's.
 * → { phase: 'invite' | 'countdown' | 'hunt' | 'fight' | 'won' | 'lost' | 'cancelled' | 'stale', roster, pool,
 *     players: { slot: 'invited' | 'declined' | 'ready' | 'battle' | 'done' | 'out' }, outWhy: { slot: why } }
 */
export function raidStatus(raid, seats, { now = Date.now(), goSeen = null } = {}) {
  if (!raid) return null;
  const roster = rosterOf(raid, seats);
  const players = {};
  const outWhy = {};
  for (const s of raid.players) {
    const seat = seats[s];
    if (s !== raid.host && seat?.join === false) players[s] = 'declined';
    else if (s !== raid.host && seat?.join !== true) players[s] = 'invited';
    else if (seat?.out) {
      players[s] = 'out';
      outWhy[s] = seat.out.why;
    } else if (seat?.fin) players[s] = 'done';
    else if (seat?.b) players[s] = 'battle';
    else players[s] = 'ready';
  }
  const pool = foldPool(raid, seats);
  const base = { roster, pool, players, outWhy };
  if (raid.state === 'cancel') return { ...base, phase: 'cancelled' };
  // (the host starts it RAID.answerMs after asking at the latest: still open long after that, their app is gone)
  if (raid.state === 'open') return { ...base, phase: now - raid.at > RAID.answerMs * 4 ? 'stale' : 'invite' };
  // won: every slot empty, with every player's battle known (a player still on their way may bring a bigger party –
  // a randomizer that adds Pokémon); lost: everybody out
  const known = roster.every((s) => seats[s]?.b || seats[s]?.out);
  if (pool.size > 0 && known && pool.pools.every((p) => p === 0)) return { ...base, phase: 'won' };
  if (roster.every((s) => players[s] === 'out' || players[s] === 'done')) return { ...base, phase: roster.some((s) => players[s] === 'done') && pool.size > 0 && pool.pools.every((p) => p === 0) ? 'won' : 'lost' };
  if (now - raid.at > RAID.keepMs) return { ...base, phase: 'stale' };
  if (goSeen !== null && now - goSeen < RAID.countdownMs && !roster.some((s) => seats[s]?.b)) return { ...base, phase: 'countdown', left: RAID.countdownMs - (now - goSeen) };
  return { ...base, phase: roster.some((s) => seats[s]?.b) ? 'fight' : 'hunt' };
}

/** Is the raid over (won, lost, cancelled or stale)? */
export const raidOver = (st) => !!st && ['won', 'lost', 'cancelled', 'stale'].includes(st.phase);

/**
 * The result of a finished raid: { won, mvp, dealt, survivors, ms, players, boss }. `ms`: from the first battle that
 * began to the last player's end, on the clock of each player's own entries (close enough – the same computer's
 * clock for most raids' first and last).
 */
export function raidResult(raid, seats, st = raidStatus(raid, seats), now = Date.now()) {
  const roster = rosterOf(raid, seats);
  const dealt = st.pool.dealt;
  let mvp = null;
  for (const s of roster) if (dealt[s] > 0 && (!mvp || dealt[s] > dealt[mvp])) mvp = s;
  const survivors = roster.filter((s) => seats[s]?.b && !['wiped', 'left', 'desync', 'gone', 'quit', 'late'].includes(seats[s]?.out?.why));
  const starts = roster.map((s) => seats[s]?.b?.at).filter((x) => x > 0);
  // (won the moment the pool emptied – before the other games' last hit: then it ended now)
  const ends = roster.map((s) => seats[s]?.fin?.at || seats[s]?.out?.at).filter((x) => x > 0);
  if (!ends.length && (st.phase === 'won' || st.phase === 'lost')) ends.push(now);
  const ms = starts.length && ends.length ? Math.max(0, Math.max(...ends) - Math.min(...starts)) : null;
  const species = roster.map((s) => seats[s]?.b?.sp?.[0]).find((x) => x > 0) || null;
  return { won: st.phase === 'won', mvp, dealt, survivors, ms, players: roster, size: st.pool.size, species };
}

/** "1:23" for a duration in ms. */
export const durationText = (ms) => (Number.isFinite(ms) ? `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}` : '');

// ---- one game's side ---------------------------------------------------------------------------------------------

/**
 * One player's game in a raid. The play view feeds it what the game's battle shows (shared/live/raidhp.mjs view)
 * every few hundred ms; it answers with what to do:
 *   begin   this player's raid battle began: their seat's `b`
 *   events  new [kind, idx, bp] (the caller stamps them with the clock and appends them to the seat)
 *   writes  [{ idx, hp }]: HP to write now (only while the game is quiet – waiting for the player's action)
 *   out     { why }: this player is out (their team is down, they left the battle, a write didn't hold)
 *   fin     this player's battle ended with the last opponent down in their game
 *   hold    the game should wait (paused) for the others' battles to begin
 * Our own writes are never counted as damage: what we wrote is what we expect to read.
 */
export class RaidPlayer {
  /** `skipKey`: the battle that was already on when the raid started (it isn't the raid's – the next one is). */
  constructor({ me, startedAt = 0, skipKey = null }) {
    Object.assign(this, { me, startedAt, skipKey });
    this.key = null; // the battle we are in (view.key)
    this.known = null; // idx → HP as last seen or written
    this.max = null;
    this.pending = new Map(); // idx → { hp, before, at, tries } – a write waiting to be read back
    this.ended = false;
    this.lastActive = null;
    this.held = null; // when this game started waiting for the others
  }

  /**
   * `view`: the driver's reading (null outside battle); `pool`: foldPool; `others`: { allIn } – every roster player's
   * battle began (or they're out); `team`: this player's live party ([{ hp, maxHp }]) – a wiped team is out.
   */
  tick({ view, pool, now = Date.now(), allIn = true, team = null }) {
    const res = { begin: null, events: [], writes: [], out: null, fin: null, hold: false };
    if (this.ended) return res;
    if (!this.key) {
      // waiting for this player's raid battle: the next trainer battle that begins after the start
      if (!view || !view.trainer || !view.foes?.length || now < this.startedAt || view.key === this.skipKey) return res;
      this.key = view.key;
      this.known = new Map(view.foes.map((f) => [f.idx, f.hp]));
      this.max = new Map(view.foes.map((f) => [f.idx, f.maxHp]));
      this.lastActive = (view.active || []).join();
      res.begin = { n: Math.min(6, view.foes.length), max: view.foes.map((f) => f.maxHp), sp: view.foes.map((f) => f.species || 0), lv: view.foes.map((f) => f.level || 0), at: now, tr: view.trainerId ?? null };
      // (a trainer's Pokémon start at full HP: anything less, seen at the first reading, was this player's first hit)
      for (const f of view.foes) if (f.hp < f.maxHp) res.events.push(['d', f.idx, f.hp === 0 ? FULL : bpOf(f.hp - f.maxHp, f.maxHp)]);
      // the pool's level goes into this game at its first quiet moment
      return res;
    }
    if (!view || view.key !== this.key) {
      // the battle is over in this game (three readings in a row – a reading in the middle of a switch can miss it):
      // won (every opponent down here) or not
      this.gone = (this.gone || 0) + 1;
      if (this.gone < 3) return res;
      this.ended = true;
      const allDown = [...this.known.values()].every((hp) => hp === 0);
      if (allDown) res.fin = { at: now };
      else res.out = { why: team && team.length && team.every((m) => !(m.hp > 0)) ? 'wiped' : 'left' };
      return res;
    }
    this.gone = 0;
    if (team && team.length && team.every((m) => !(m.hp > 0))) {
      this.ended = true;
      res.out = { why: 'wiped' };
      return res;
    }
    const active = view.active || [];
    const wasActive = new Set(this.lastActive ? this.lastActive.split(',').filter(Boolean).map(Number) : []);
    this.lastActive = active.join();
    // what the game shows now against what we knew: the difference is a hit or a heal in this game
    for (const f of view.foes) {
      if (!this.max.has(f.idx)) continue;
      const max = this.max.get(f.idx);
      if (f.maxHp !== max) continue; // (a stray reading: another struct for a moment)
      const p = this.pending.get(f.idx);
      if (p) {
        // a write of ours waits to be read back: our value (or the game already took more off it) = it held
        if (f.hp === p.hp) {
          this.pending.delete(f.idx);
          this.known.set(f.idx, f.hp);
          continue;
        }
        if (f.hp === p.before && now - p.at < RAID.verifyMs * 4) continue; // (the mirror hasn't caught up yet)
        if (f.hp === p.before) {
          // still the old value: the write didn't land – once more, then this game is out of step
          this.pending.delete(f.idx);
          if (p.tries >= 2) {
            this.ended = true;
            res.out = { why: 'desync' };
            return res;
          }
          this.known.set(f.idx, f.hp);
          this.retry = { idx: f.idx, tries: p.tries + 1 };
          continue;
        }
        // something else: the game changed it after our write (a hit right away) – from our value on
        this.pending.delete(f.idx);
        this.known.set(f.idx, p.hp);
      }
      const was = this.known.get(f.idx);
      if (f.hp === was) continue;
      // a Pokémon coming out or going back is read from another copy from now on (the battle's, or the party's):
      // a difference right at that switch is the copies, not a hit – unless it went down
      if (active.includes(f.idx) !== wasActive.has(f.idx) && f.hp > 0) {
        this.known.set(f.idx, f.hp);
        continue;
      }
      const d = f.hp - was;
      // a knock-out empties the slot whatever is left of it (the shares are rounded; what fell in one game fell)
      res.events.push([d < 0 ? 'd' : 'h', f.idx, d < 0 && f.hp === 0 ? FULL : bpOf(d, max)]);
      this.known.set(f.idx, f.hp);
    }
    // the pool into this game – only while it waits for the player's action
    const retry = this.retry;
    this.retry = null;
    if (view.quiet && !this.pending.size) {
      for (const f of view.foes) {
        if (!this.max.has(f.idx) || f.idx >= pool.size || f.maxHp !== this.max.get(f.idx)) continue;
        if (f.hp === 0) continue; // down in this game: never brought back
        const isActive = active.includes(f.idx);
        let want = hpFor(pool.pools[f.idx], f.maxHp);
        // the one out never goes to 0 by souldew: 1 HP, the game's next hit knocks it out itself
        if (isActive && want === 0) want = 1;
        if (want === f.hp) continue;
        // (a heal in the pool never lifts this game above what the pool says, and a write that would bring a
        // Pokémon down to 0 that is out is 1 instead – see above)
        res.writes.push({ idx: f.idx, hp: want, active: isActive });
        this.pending.set(f.idx, { hp: want, before: f.hp, at: now, tries: retry?.idx === f.idx ? retry.tries : 1 });
        this.known.set(f.idx, f.hp);
      }
      // the bar on screen doesn't show what the game holds (the game brought back a saved screen): draw it again
      if (!res.writes.length && view.hud === false) {
        for (const f of view.foes) if (active.includes(f.idx) && f.hp > 0) res.writes.push({ idx: f.idx, hp: f.hp, active: true, hud: true });
      }
    }
    // waiting for the others: hold this game at its first quiet moment until every battle began (or the wait is over)
    if (!allIn && view.quiet) {
      this.held ??= now;
      res.hold = now - this.held < RAID.waitMs;
    }
    return res;
  }

  /** The player leaves the raid themselves. */
  quit() {
    this.ended = true;
    return { why: 'quit' };
  }
}

// ---- log and stream ----------------------------------------------------------------------------------------------

/** The log entry of a finished raid (every computer writes the same one under `feed:raid-<id>`). */
export function raidFeedEntry(raid, res, at = Date.now()) {
  return {
    type: 'raid', at, slot: raid.host, raid: raid.id, won: res.won, players: res.players, mvp: res.mvp, survivors: res.survivors,
    ms: res.ms, size: res.size, species: res.species,
  };
}

/** A raid's log entry for stream tools (shared/streamapi.mjs): who took part, won or not, the MVP, survivors, time. */
export function raidOfFeed(v) {
  if (v?.type !== 'raid') return {};
  const slots = (a) => (Array.isArray(a) ? a.filter(okSlot).slice(0, RAID.maxPlayers) : []);
  return { won: !!v.won, players: slots(v.players), mvp: okSlot(v.mvp) ? v.mvp : null, survivors: slots(v.survivors),
    ms: Number.isFinite(v.ms) ? Math.max(0, Math.min(86400000, Math.round(v.ms))) : null, size: int(v.size, 0, 6) ?? 0 };
}
