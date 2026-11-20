// Rock-paper-scissors between the players of a run (docs/MULTIPLAYER.md › 9 "Emotes and rock-paper-scissors"), over
// the run's peer channel (web/lib/sync.mjs `world`, web/lib/worldrps.mjs). Fair without anybody in the middle:
// commit–reveal. Each player first sends only a hash of their hand and a random nonce; the hands go out once both hashes
// are in, and a hand that doesn't match its hash is refused. So nobody can wait for the other's hand and counter it –
// the hash is bound to the game, the round and the player, so copying the other's hash doesn't work either – and
// whoever doesn't show their hand after both picked loses the game (walking away can't undo a loss).
//
// This module has no browser in it: the hub gets `send(msg)` (to everyone; the messages carry `to`), a clock and a
// hash; tests drive two hubs against each other. Messages ({ t: 'rps', op, id, … } plus `from`, added by the channel):
//   ask { to, bo }      a challenge (best of 1 or 3)
//   c   { r, h }        round r: my commitment (SHA-256 hex)
//   v   { r, hand, n }  round r: my hand (0 rock, 1 paper, 2 scissors) and nonce
//   x   { why }         not now / gave up / busy / your hand didn't match

import { RateLimit } from './world.mjs';

export const HANDS = ['rock', 'paper', 'scissors'];
/** Times (ms) and limits. A draw in a best of 1 is played again, `maxRounds` rounds at the most (then it's a draw). */
export const RPS = { pickMs: 10000, graceMs: 2500, revealMs: 6000, showMs: 2400, keepMs: 7000, maxRounds: 5, ask: { burst: 3, everyMs: 20000 } };

/** Does hand a beat hand b? (paper > rock, scissors > paper, rock > scissors) */
export const beats = (a, b) => (a - b + 3) % 3 === 1;
const okHand = (h) => h === 0 || h === 1 || h === 2;
const okId = (id) => typeof id === 'string' && /^[\w-]{6,40}$/.test(id);
const okHex = (h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);

/** The commitment: SHA-256 over game, round, player, hand and nonce (hex). */
export async function rpsHash(id, round, slot, hand, nonce) {
  const data = new TextEncoder().encode(`souldew-rps|${id}|${round}|${slot}|${hand}|${nonce}`);
  const d = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const randomHex = (bytes) => [...globalThis.crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * One player's rock-paper-scissors: the games this player is in (and, to show the hands over the avatars, the ones
 * between two partners – `spectating`). `send(msg)` goes to every partner; `now()` this computer's clock.
 * Events (on(fn) → off): fn({ type: 'change' | 'round' | 'end', game, round }).
 */
export class RpsHub {
  constructor({ me, send, now = () => Date.now(), hash = rpsHash, nonce = () => randomHex(16), id = () => randomHex(8) }) {
    Object.assign(this, { me, send, now, hash, makeNonce: nonce, makeId: id });
    this.games = new Map();
    this.listeners = new Set();
    this.askOut = new RateLimit(RPS.ask); // my challenges
    this.askIn = new Map(); // slot → RateLimit (theirs)
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  _emit(type, game, round = null) {
    for (const fn of this.listeners) {
      try {
        fn({ type, game, round });
      } catch (e) {
        console.warn('rps listener', e);
      }
    }
  }

  /** A game of mine still being played with `slot`. */
  openWith(slot) {
    for (const g of this.games.values()) if (!g.spectating && !g.end && g.other === slot) return g;
    return null;
  }

  /** Challenge `slot`: the game, or { error: 'busy' (already playing them) | 'limit' (too many asks) | 'self' }. */
  challenge(slot, bo = 1) {
    if (!slot || slot === this.me) return { error: 'self' };
    if (this.openWith(slot)) return { error: 'busy' };
    if (!this.askOut.take(this.now())) return { error: 'limit' };
    const g = this._game({ id: this.makeId(), a: this.me, b: slot, bo: bo === 3 ? 3 : 1 });
    this.send({ t: 'rps', op: 'ask', id: g.id, to: slot, bo: g.bo });
    this._emit('change', g);
    return g;
  }

  _game({ id, a, b, bo, spectating = false }) {
    const g = { id, a, b, bo, spectating, other: a === this.me ? b : a, challenger: a === this.me, rounds: [], wins: { [a]: 0, [b]: 0 }, end: null, at: this.now() };
    this.games.set(id, g);
    this._round(g);
    return g;
  }
  _round(g) {
    const r = { r: g.rounds.length + 1, started: this.now(), commits: {}, reveals: {}, mine: null, revealAt: null, result: null };
    g.rounds.push(r);
    return r;
  }
  cur(g) {
    return g.rounds[g.rounds.length - 1];
  }

  /** My hand for the round being played (0 rock, 1 paper, 2 scissors). */
  async pick(id, hand) {
    const g = this.games.get(id);
    if (!g || g.spectating || g.end || !okHand(hand)) return false;
    const r = this.cur(g);
    if (r.mine || r.result) return false;
    const nonce = this.makeNonce();
    r.mine = { hand, nonce };
    const h = await this.hash(g.id, r.r, this.me, hand, nonce);
    r.commits[this.me] = h;
    this.send({ t: 'rps', op: 'c', id: g.id, to: g.other, r: r.r, h });
    this._emit('change', g);
    await this._progress(g);
    return true;
  }

  /** Not now (before a hand), or give up (it counts as a loss once the game is under way). */
  pass(id) {
    const g = this.games.get(id);
    if (!g || g.spectating || g.end) return;
    this.send({ t: 'rps', op: 'x', id: g.id, to: g.other, why: 'pass' });
    this._finish(g, this._started(g) ? { winner: g.other, why: 'gaveUp', by: this.me } : { winner: null, why: 'passed', by: this.me });
  }

  /** Has the game begun for real (a hand was compared, or both committed)? Before that, leaving costs nothing. */
  _started(g) {
    return g.rounds.length > 1 || g.rounds.some((r) => r.result) || Object.keys(this.cur(g).commits).length === 2;
  }

  /** A message from the peer channel (`m.from` set by the channel; anything malformed is dropped). */
  async receive(m) {
    if (!m || m.t !== 'rps' || typeof m.from !== 'string' || m.from === this.me || !okId(m.id)) return;
    const now = this.now();
    let g = this.games.get(m.id);
    if (m.op === 'ask') {
      if (g || typeof m.to !== 'string' || m.to === m.from) return;
      if (m.to !== this.me) {
        // two partners play: watch, to show their hands over their avatars
        this._game({ id: m.id, a: m.from, b: m.to, bo: m.bo === 3 ? 3 : 1, spectating: true });
        return;
      }
      if (!this.askIn.has(m.from)) this.askIn.set(m.from, new RateLimit(RPS.ask));
      if (!this.askIn.get(m.from).take(now)) return; // asking too often: not even an answer
      if (this.openWith(m.from)) {
        this.send({ t: 'rps', op: 'x', id: m.id, to: m.from, why: 'busy' });
        return;
      }
      g = this._game({ id: m.id, a: m.from, b: this.me, bo: m.bo === 3 ? 3 : 1 });
      this._emit('change', g);
      return;
    }
    if (!g || g.end || (m.from !== g.a && m.from !== g.b)) return;
    if (!g.spectating && m.from !== g.other) return;
    if (m.op === 'x') {
      if (g.spectating) return void this._finish(g, { winner: null, why: 'passed', by: m.from });
      if (m.why === 'busy') return void this._finish(g, { winner: null, why: 'busy', by: m.from });
      if (m.why === 'mismatch') return void this._finish(g, { winner: null, why: 'mismatch', by: this.me });
      if (m.why === 'late' && g.rounds.length === 1) return void this._finish(g, { winner: null, why: 'noAnswer', by: m.from });
      this._finish(g, this._started(g) ? { winner: this.me, why: 'gaveUp', by: m.from } : { winner: null, why: 'passed', by: m.from });
      return;
    }
    const n = Number(m.r);
    if (!Number.isInteger(n) || n < 1 || n > RPS.maxRounds) return;
    // (a round ahead of ours: they saw the last result a moment earlier – keep it for when we get there)
    while (g.rounds.length < n && n === g.rounds.length + 1 && this.cur(g).result) this._round(g);
    const r = g.rounds[n - 1];
    if (!r) return;
    if (m.op === 'c') {
      if (!okHex(m.h) || r.commits[m.from]) return; // only the first commitment counts
      r.commits[m.from] = m.h;
    } else if (m.op === 'v') {
      if (!okHand(m.hand) || typeof m.n !== 'string' || m.n.length > 64 || r.reveals[m.from]) return;
      r.reveals[m.from] = { hand: m.hand, nonce: m.n, ok: null };
    } else return;
    this._emit('change', g);
    await this._progress(g);
  }

  /** Reveal once both commitments are in; compare once both hands are in and check out. */
  async _progress(g) {
    if (g.end) return;
    const r = this.cur(g);
    if (r.result) return;
    const [a, b] = [g.a, g.b];
    if (!g.spectating && r.mine && r.commits[a] && r.commits[b] && !r.revealAt) {
      r.revealAt = this.now();
      r.reveals[this.me] = { hand: r.mine.hand, nonce: r.mine.nonce, ok: true };
      this.send({ t: 'rps', op: 'v', id: g.id, to: g.other, r: r.r, hand: r.mine.hand, n: r.mine.nonce });
    }
    for (const s of [a, b]) {
      const v = r.reveals[s];
      if (!v || v.ok !== null || !r.commits[s]) continue;
      v.ok = (await this.hash(g.id, r.r, s, v.hand, v.nonce)) === r.commits[s];
      if (!v.ok) {
        // a hand that isn't the one they committed to: refused, the game doesn't count
        if (!g.spectating) this.send({ t: 'rps', op: 'x', id: g.id, to: g.other, why: 'mismatch' });
        this._finish(g, { winner: null, why: 'mismatch', by: s });
        return;
      }
    }
    if (!r.reveals[a]?.ok || !r.reveals[b]?.ok || r.result) return;
    const ha = r.reveals[a].hand;
    const hb = r.reveals[b].hand;
    r.result = { hands: { [a]: ha, [b]: hb }, winner: ha === hb ? null : beats(ha, hb) ? a : b, at: this.now() };
    if (r.result.winner) g.wins[r.result.winner]++;
    this._emit('round', g, r);
    const need = g.bo === 3 ? 2 : 1;
    const top = g.wins[a] >= need ? a : g.wins[b] >= need ? b : null;
    if (top) this._finish(g, { winner: top, why: 'won' });
    else if (g.rounds.length >= RPS.maxRounds) this._finish(g, { winner: g.wins[a] > g.wins[b] ? a : g.wins[b] > g.wins[a] ? b : null, why: g.wins[a] === g.wins[b] ? 'draw' : 'won' });
    else this._emit('change', g);
  }

  _finish(g, end) {
    if (g.end) return;
    g.end = { ...end, at: this.now() };
    this._emit('end', g);
    this._emit('change', g);
  }

  /** Call a few times a second: the next round after a result, the time limits, and forgetting finished games. */
  tick() {
    const now = this.now();
    for (const g of [...this.games.values()]) {
      if (g.end) {
        if (now - g.end.at > RPS.keepMs) {
          this.games.delete(g.id);
          this._emit('change', g);
        }
        continue;
      }
      if (g.spectating) {
        if (now - g.at > 120000) this.games.delete(g.id);
        continue;
      }
      const r = this.cur(g);
      if (r.result) {
        if (now - r.result.at >= RPS.showMs) {
          this._round(g);
          this._emit('change', g);
          this._progress(g); // (their commitment for it may be in already)
        }
        continue;
      }
      const first = g.rounds.length === 1;
      if (!r.mine && now - r.started > RPS.pickMs) {
        // I didn't pick in time: in the first round that's no game, later it's a loss
        this.send({ t: 'rps', op: 'x', id: g.id, to: g.other, why: 'late' });
        this._finish(g, first ? { winner: null, why: 'expired', by: this.me } : { winner: g.other, why: 'late', by: this.me });
      } else if (!r.commits[g.other] && now - r.started > RPS.pickMs + RPS.graceMs) {
        this._finish(g, first ? { winner: null, why: 'noAnswer', by: g.other } : { winner: this.me, why: 'late', by: g.other });
      } else if (r.revealAt && !r.reveals[g.other] && now - r.revealAt > RPS.revealMs) {
        // they saw my hand and didn't show theirs: that's a loss for them
        this._finish(g, { winner: this.me, why: 'noReveal', by: g.other });
      }
    }
  }

  /** What a screen shows about a game of mine (UI): see web/lib/worldrps.mjs. */
  view(g) {
    const r = this.cur(g);
    const last = [...g.rounds].reverse().find((x) => x.result) || null;
    const phase = g.end ? 'end' : r.result ? 'show' : !r.mine ? 'pick' : 'wait';
    return {
      id: g.id, other: g.other, a: g.a, b: g.b, bo: g.bo, challenger: g.challenger, spectating: g.spectating, round: r.r, phase,
      hand: r.mine?.hand ?? null, until: r.started + RPS.pickMs, wins: { me: g.wins[this.me] || 0, them: g.wins[g.other] || 0 },
      last: last ? { mine: last.result.hands[this.me], theirs: last.result.hands[g.other], hands: last.result.hands, winner: last.result.winner, at: last.result.at } : null,
      end: g.end,
    };
  }

  list() {
    return [...this.games.values()].filter((g) => !g.spectating).map((g) => this.view(g));
  }
}

/**
 * What a picker or card says about a game (`v`: RpsHub.view) to player `me`: [[labelKey, default], …] joined with
 * " – " ({name} = the other player, {hand} = their last hand). The keys are the labels of web/lib/sharedworld.mjs
 * rpsTexts – the overlay and the card say the same.
 */
export function rpsWords(v, me) {
  if (!v) return [];
  if (v.phase === 'pick') return [v.round > 1 ? ['rpsAgain', 'Again!'] : v.challenger ? ['rpsPick', 'Pick your hand'] : ['rpsAsked', '{name} wants to play – pick your hand']];
  if (v.phase === 'wait') return [['rpsWaiting', 'Waiting for {name} …']];
  if (v.phase === 'show' && v.last) {
    return [['rpsTheyPicked', '{name}: {hand}'], !v.last.winner ? ['rpsRoundDraw', 'A draw'] : v.last.winner === me ? ['rpsRoundWin', 'You win the round'] : ['rpsRoundLose', '{name} wins the round']];
  }
  const e = v.end || {};
  const mine = e.winner === me;
  const w = {
    won: !e.winner ? ['rpsDraw', 'It’s a draw'] : mine ? ['rpsYouWin', 'You win!'] : ['rpsTheyWin', '{name} wins'],
    draw: ['rpsDraw', 'It’s a draw'],
    passed: e.by === me ? ['rpsYouPassed', 'Not this time'] : ['rpsPassed', '{name} doesn’t want to play right now'],
    busy: ['rpsBusy', '{name} is already playing'],
    expired: ['rpsExpired', 'Time’s up'],
    noAnswer: ['rpsNoAnswer', '{name} didn’t answer'],
    late: mine ? ['rpsTheyLate', '{name} didn’t pick in time – you win'] : ['rpsYouLate', 'You didn’t pick in time – {name} wins'],
    gaveUp: mine ? ['rpsTheyGaveUp', '{name} gave up – you win'] : ['rpsYouGaveUp', 'You gave up'],
    noReveal: ['rpsNoReveal', '{name} didn’t show their hand – you win'],
    mismatch: ['rpsMismatch', '{name}’s hand didn’t match the one they picked – this game doesn’t count'],
  }[e.why];
  return w ? [w] : [];
}

/** rpsWords as one line, with `labels` (key → text) and the names filled in. */
export function rpsLine(v, me, labels, name, handName = (h) => HANDS[h]) {
  return rpsWords(v, me).map(([k, d]) => (labels?.[k] || d).replace(/\{name\}/g, name).replace('{hand}', v.last ? handName(v.last.theirs) : '')).join(' – ');
}
