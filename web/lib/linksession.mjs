// Link sessions between the players of a run: trades and battles the in-game way (docs/MULTIPLAYER.md). This is the
// page's half – invite, answer, the check that every seat's game is here (SHA-1, never the ROM itself), the battery
// saves (encrypted by the run's channel, compressed), the start, then the buttons and hashes while it runs. Every peer's
// link host runs ALL seats; only the buttons travel – here over the run's peer channel (web/lib/sync.mjs `link`).
//
// Up to four seats (docs/MULTIPLAYER.md › "Four players"): any 2 of the run's players trade while the others play on;
// 3–4 seats for multi battles and the Union Room. Buttons go to every other seat directly (a mesh: no player is a
// relay or a clock for the others – each host waits for the inputs it lacks); the input delay comes from the slowest
// link.
//
// Messages (msg.t), all with msg.sid = the session id; every player speaks for their OWN seat's game only:
//   invite {kind, seats:[slot], sha1:{me}, crc:{me}, system,   from the one who starts it; caps: what this build knows
//           caps, wager, format}                              ('wager1'), wager: the money a battle is for (0: none),
//                                                             format: 'single' | 'double' | 'multi' (what to pick in game)
//   accept {sha1:{me}, crc:{me}, caps, wager} | refuse {reason} every invited player, to everybody in the session
//                                                             (wager: the most this player puts in – a wager counts
//                                                             only when every seat has the caps, web/lib/wager.mjs)
//   snap   {slot, sha1, i, n, data} | {slot, sha1, bin}        a seat's running game: the fast player's save state,
//                                                             deflate-raw (sha1 of the state itself) – as bytes over the
//                                                             channel's binary transfer, or in base64 parts
//   save   {slot, sha1, i, n, data, state, model}             each seat's battery save, in parts (base64 deflate-raw);
//                                                             state = the snap's sha1 (that seat starts from it) | null;
//                                                             model = a Game Boy seat's console, 'dmg' | 'cgb' (its
//                                                             player's look – every host runs that seat on it)
//   ready                                                     "every seat's game is here" (after a pick or a build)
//   ping {n} / pong {n}                                       the round trip, measured by the inviter
//   snapnow                                                   from the inviter, once it measured the round trips and
//                                                             every seat's game is everywhere: now the snaps and saves
//   got                                                       to the inviter: every seat's save and running game is here
//   go     {delay, rtc}                                       from the inviter: everybody starts the link host
//   in     {s, f, k:[…]}                                      seat s's buttons from frame f on (u32 each) – also a
//                                                             resend of any seat's, which any peer may answer
//   need   {s, f}                                             "I miss seat s's buttons from frame f" (a gap)
//   hash   {f, h}                                             every 120 frames
//   rejoin                                                    a player whose game dropped out comes back …
//   state  {i, n, data, frame} | state-busy                  … and gets the session as the others have it
//   bye    {reason}                                           a player left: the session ends for everybody
//   linked {on, seats, kind}  (no sid)                         to the run's players OUTSIDE the session, from each seat:
//                                                             "I'm linked with these seats" (every 3 s while it lasts,
//                                                             on:false when it ends) – their board shows it on the
//                                                             card and greys out Trade / Battle. Older builds drop it
//                                                             (no sid of theirs). Only ever about the sender itself.
import { serverErrorText } from './errors.mjs';
import { LINK_CMD, linkDelay, sameLinkSystem } from '/shared/link.mjs';
import { b64, unb64, deflate, inflate, sha1 } from './bytes.mjs';
import { LinkResult } from './linkresult.mjs';
import { WAGER_CAP, wagerRules, agreedWager, resultEntry } from './wager.mjs';

// Seamless (docs/MULTIPLAYER.md › "Seamless"): a player whose game runs here in the fast player doesn't restart it for
// the link. Once every seat's game is found, that game stops for a moment ("Linking…"), its save state goes to every
// partner (snap), and every link host starts that seat from it – the players go on from where they are, now linked.
// When the session ends, each one's own console goes on alone from where the session left it (resumeSolo); a session
// that fell out of step goes back to the game as it was before it (with the run's save, as before).

const PART = 12 * 1024; // bytes of base64 per message (well below the data channel's message size)
const REJOIN_KEY = (runId) => `sl-link-${runId}`;
const REJOIN_MAX_MS = 30 * 60 * 1000;
export { linkDelay };
const INVITE_TIMEOUT_MS = 60 * 1000; // an invite nobody answers ends by itself
const MAX_SAVE_BYTES = 4 * 1024 * 1024; // (server/lib/native.mjs MAX_SAVE: a partner's save can't be bigger)
// A session the others are told about ('linked'): from the moment every seat said yes until it ends. While only invited,
// a player is asked once more – the "in another link" answer covers that short moment.
const LINKED_PHASES = ['preparing', 'need', 'running', 'rejoining'];
const LINKED_TTL_MS = 10 * 1000; // a seat that went quiet (crash, closed page) is no longer shown as linked
const SLOT_RE = /^p[1-8]$/;
const newSid = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('');

const store = {
  get(k) {
    try {
      return JSON.parse(localStorage.getItem(k) || 'null');
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, JSON.stringify(v));
    } catch {
      // private mode
    }
  },
};

/** Parts of a big blob over the channel: collects { i, n, data } and gives the joined string once all are there. */
function collect(box, m) {
  if (!Number.isInteger(m.n) || m.n < 1 || m.n > 20000 || !Number.isInteger(m.i) || m.i < 0 || m.i >= m.n || typeof m.data !== 'string') return null;
  box.parts ||= [];
  box.parts[m.i] = m.data;
  box.got = box.parts.filter((x) => x !== undefined).length;
  return box.got === m.n ? box.parts.join('') : null;
}

/**
 * One per run and page. `sync`: the run's SyncLink; `onChange(state)` re-renders the UI; `openSession(target)` starts
 * the play view's game for a running link session; `closeSession(state)` ends it.
 * state: { phase: 'idle' | 'inviting' | 'invited' | 'preparing' | 'need' | 'running' | 'rejoinable' | 'rejoining' |
 *          'ended', sid, kind, seats, host, sha1, crc, missing, route, … }
 */
export class LinkSessions {
  constructor({ sync, runId, me, onChange = () => {}, openSession = () => {}, closeSession = () => {}, emu = () => null, ownGame = () => false, fetchImpl = null,
    rules = () => ({}), onResult = () => {}, block = () => null, beforeRestore = async () => {} }) {
    // beforeRestore(state): a desync is about to put the run's save back – the play view stops writing the session's
    // saves and waits for the ones already on their way (a write landing after the restore would undo it)
    // ownGame(): this player's game of this run runs in the fast player right now (a link starts from it, no restart)
    // rules(): the run's rules (the wager rule); onResult(entry): what this computer read of a session's battles – into
    // the run (web/lib/wager.mjs); block(seats, kind): why these players' games can't link – a refusal code (Play
    // together, where every player has a game of their own: shared/playtogether.mjs inviteBlock) – or null
    Object.assign(this, { sync, runId, me, onChange, openSession, closeSession, emu, ownGame, rules, onResult, block, beforeRestore });
    this.fetch = fetchImpl || ((...a) => fetch(...a)); // (tests give each player's page its own server)
    this.state = { phase: 'idle' };
    this.elsewhere = {}; // slot → { seats, kind, at }: players of the run linked with others right now (their 'linked')
    this.announced = null; // what this page last told the players outside its session: { seats, kind } | null
    this.off = sync.onLink((m) => this._in(m));
    this.onWindow = (e) => this._fromPlayer(e);
    addEventListener('message', this.onWindow);
    this.cmdBusy = false;
    this._fresh();
    // a session this page was in when it went away (reload, crash, app restart): offer to rejoin it
    const old = store.get(REJOIN_KEY(runId));
    if (old?.sid && Date.now() - (old.at || 0) < REJOIN_MAX_MS && Array.isArray(old.seats) && old.seats.includes(me)) {
      this.state = { phase: 'rejoinable', ...old };
    } else if (old) store.set(REJOIN_KEY(runId), null);
    this.routeTimer = setInterval(() => {
      this._routes();
      this._announce(true);
      this._expire();
    }, 3000);
    this.routeTimer?.unref?.(); // (Node, in tests: no reason to stay alive)
  }

  /** Nothing of an earlier session carries over into the next: queued commands, early buttons, resends, the snapshot. */
  _fresh() {
    this.cmdQueue = [];
    this.early = [];
    this.resendTo = [];
    this.needAt = {};
    this.going = false;
    this.measuring = this.rtt = null;
    this.own = null;
    this.snapAt = null;
    this.result?.stop();
    this.result = null;
    this.stats = {}; // (tests / diagnostics: hashes compared, inputs sent and received, resends, the start's steps)
    clearTimeout(this.inviteTimer);
  }

  /** A whole new session state (not merged into the last one's: no id, models or snaps of before). */
  _new(state) {
    this._fresh();
    this.state = { phase: 'idle' };
    this._set(state);
  }

  stop() {
    this.off?.();
    this.result?.stop();
    clearInterval(this.routeTimer);
    clearTimeout(this.rejoinTimer);
    clearTimeout(this.inviteTimer);
    removeEventListener('message', this.onWindow);
    this.elsewhere = {};
    // (a running session isn't ended by closing the page: the others wait, this player may come back – rejoin)
    if (this.state.phase === 'preparing' || this.state.phase === 'need' || this.state.phase === 'inviting') this.leave('closed');
  }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
    this._announce();
  }

  /**
   * Tell the run's players outside the session that this player is linked (or no longer is) – `beat`: once more, for
   * a player who came online meanwhile. Over the direct link only: without one they can't link with us anyway.
   */
  _announce(beat = false) {
    const st = this.state;
    const now = LINKED_PHASES.includes(st.phase) && Array.isArray(st.seats) && st.seats.length > 1 ? { seats: st.seats, kind: st.kind === 'battle' ? 'battle' : 'trade' } : null;
    const prev = this.announced;
    const same = !!now && !!prev && now.kind === prev.kind && now.seats.join() === prev.seats.join();
    if ((same && !beat) || (!now && !prev)) return;
    const outside = (seats) => (this.sync.others || []).filter((s) => s !== this.me && !seats.includes(s));
    this.announced = now;
    try {
      if (prev && !same) this.sync.sendLink({ t: 'linked', on: false }, outside(prev.seats));
      if (now) this.sync.sendLink({ t: 'linked', on: true, seats: now.seats, kind: now.kind }, outside(now.seats));
    } catch (e) {
      console.warn('link announcement failed', e);
    }
  }

  /** A player of the run says they're linked with others (or not any more) – only ever about themselves. */
  _linkedIn(m) {
    const from = m.from;
    if (!SLOT_RE.test(from)) return;
    const had = this.elsewhere[from];
    if (m.on !== true) {
      if (!had) return;
      delete this.elsewhere[from];
      return this.onChange(this.state);
    }
    const seats = Array.isArray(m.seats) ? [...new Set(m.seats.filter((s) => typeof s === 'string' && SLOT_RE.test(s)))] : [];
    // (a session with us in it isn't "elsewhere": we know it ourselves)
    if (seats.length < 2 || seats.length > 4 || !seats.includes(from) || seats.includes(this.me)) return;
    const kind = m.kind === 'battle' ? 'battle' : 'trade';
    this.elsewhere[from] = { seats, kind, at: Date.now() };
    if (!had || had.kind !== kind || had.seats.join() !== seats.join()) this.onChange(this.state);
  }

  /** Linked players that went quiet: no longer shown as linked. */
  _expire() {
    const now = Date.now();
    let gone = false;
    for (const [slot, e] of Object.entries(this.elsewhere)) {
      if (now - e.at > LINKED_TTL_MS) {
        delete this.elsewhere[slot];
        gone = true;
      }
    }
    if (gone) this.onChange(this.state);
  }

  /** Is `slot` linked with other players right now? { seats, kind } (seats: the session's, `slot` among them) | null. */
  linkedElsewhere(slot) {
    const e = this.elsewhere[slot];
    return e && Date.now() - e.at <= LINKED_TTL_MS ? { seats: e.seats, kind: e.kind } : null;
  }

  /** The other seats of the session (their slots). */
  get partners() {
    return (this.state.seats || []).filter((s) => s !== this.me);
  }

  _send(msg, { relayToo = false, to = null } = {}) {
    return this.sync.sendLink({ ...msg, sid: this.state.sid }, to || this.partners, { relayToo });
  }

  /** The local server's JSON API (as web/lib/api.mjs: an error carries the server's code). */
  async _api(path, body) {
    const res = await this.fetch(path, body === undefined ? { headers: { 'x-soullink': '1' } }
      : { method: 'POST', headers: { 'content-type': 'application/json', 'x-soullink': '1' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(serverErrorText(data || {}, res.status)), { code: data?.code });
    return data;
  }

  /** What this computer has of every seat's game: { system, supported, tool, slots: { p1: { rom, sha1, crc } } }. */
  check() {
    return this._api(`/api/link/check?runId=${this.runId}`);
  }

  /**
   * Start a session with `slots` (the others; kind 'trade' | 'battle'). A battle may be for a `wager` (money, capped by
   * the run's rule) and name the `format` the players pick in the game.
   */
  async invite(kind, slots, { wager = 0, format = null } = {}) {
    if (!['idle', 'ended', 'rejoinable'].includes(this.state.phase)) throw new Error('busy');
    const c = await this.check();
    if (!c.tool || !c.supported) throw Object.assign(new Error('unsupported'), { code: c.tool ? 'linkSystem' : 'linkMissing' });
    const own = c.slots[this.me];
    if (!own?.rom) throw Object.assign(new Error('missing'), { code: 'linkOwnMissing' });
    const blocked = this.block(slots, kind);
    if (blocked) throw Object.assign(new Error('blocked'), { code: blocked });
    this.ownModel = c.model || null;
    const seats = [this.me, ...slots.filter((s) => s !== this.me)];
    const wr = wagerRules(this.rules());
    const offer = kind === 'battle' && wr.on ? Math.max(0, Math.floor(Number(wager) || 0)) : 0;
    const bet = wr.cap ? Math.min(offer, wr.cap) : offer;
    const fmt = kind === 'battle' && ['single', 'double', 'multi'].includes(format) ? format : null;
    store.set(REJOIN_KEY(this.runId), null);
    this._new({
      phase: 'inviting', sid: newSid(), kind, seats, host: this.me, sha1: { [this.me]: own.sha1 }, crc: { [this.me]: own.crc || null },
      accepted: {}, ready: {}, saves: {}, snaps: {}, missing: null, error: null, system: c.system, ended: null, route: {}, waiting: null, seamless: false,
      wager: { offer: bet, accepts: {}, caps: { [this.me]: true } }, format: fmt, outcome: null,
    });
    const sid = this.state.sid;
    this.inviteTimer = setTimeout(() => this.state.sid === sid && this.state.phase === 'inviting' && this._fail('linkNoAnswer'), INVITE_TIMEOUT_MS);
    this.inviteTimer?.unref?.();
    this._send({ t: 'invite', kind, seats, sha1: { [this.me]: own.sha1 }, crc: { [this.me]: own.crc || null }, system: c.system, caps: [WAGER_CAP], wager: bet, format: fmt }, { relayToo: true });
  }

  /** Answer an invite – `wager`: the most this player puts in (less than offered: the wager is lowered for everybody). */
  async accept({ wager = null } = {}) {
    const st = this.state;
    if (st.phase !== 'invited') return;
    const c = await this.check().catch(() => null);
    const own = c?.slots?.[this.me];
    // (Game Boy and Game Boy Color games share the cable: Blue ↔ Yellow, Gold ↔ Crystal …)
    const bad = !c?.tool ? 'linkMissing' : !c.supported || !sameLinkSystem(c.system, st.system) ? 'linkSystem' : !own?.rom ? 'linkOwnMissing'
      : this.block((st.seats || []).filter((s) => s !== this.me), st.kind);
    if (bad) {
      this._send({ t: 'refuse', reason: bad }, { relayToo: true });
      return this._set({ phase: 'ended', error: bad, ended: { reason: bad, mine: true, at: Date.now() } });
    }
    st.sha1[this.me] = own.sha1;
    st.crc[this.me] = own.crc || null;
    st.accepted[this.me] = true;
    this.ownModel = c.model || null;
    const stake = Math.max(0, Math.min(st.wager?.offer || 0, wager === null ? Infinity : Math.floor(Number(wager) || 0)));
    if (st.wager) {
      st.wager.caps[this.me] = true;
      st.wager.accepts[this.me] = stake;
    }
    this._set({ phase: 'preparing' });
    this._send({ t: 'accept', sha1: { [this.me]: own.sha1 }, crc: { [this.me]: own.crc || null }, caps: [WAGER_CAP], wager: stake }, { relayToo: true });
    this._resolve();
  }

  /** Check again whether every seat's game is here (after the player added or built one – the bar's buttons). */
  recheck() {
    return this._resolve();
  }

  /** Close the bar of a session that has ended. */
  dismiss() {
    if (['ended', 'rejoinable'].includes(this.state.phase)) this._new({ phase: 'idle', sid: null });
  }

  decline() {
    if (this.state.phase !== 'invited') return;
    this._send({ t: 'refuse', reason: 'declined' }, { relayToo: true });
    this._set({ phase: 'idle', sid: null });
  }

  /**
   * Once every seat's SHA-1 is known: are all those games on this computer? Missing ones → phase 'need' (the play view
   * asks the player to pick their copy or to build the partner's game), else 'ready' to everybody.
   */
  async _resolve() {
    const st = this.state;
    if (!['preparing', 'need'].includes(st.phase) || !st.seats.every((s) => st.sha1[s])) return;
    const seats = Object.fromEntries(st.seats.map((s) => [s, { sha1: st.sha1[s], crc: st.crc[s] || null }]));
    let r;
    try {
      r = await this._api('/api/link/resolve', { runId: this.runId, seats });
    } catch (e) {
      return this._fail(e.code || 'linkStart');
    }
    if (this.state.sid !== st.sid) return;
    if (r.missing.length) return this._set({ phase: 'need', missing: r.missing });
    this._set({ phase: 'preparing', missing: null });
    if (st.ready[this.me]) return;
    st.ready[this.me] = true;
    this._send({ t: 'ready' }, { relayToo: true });
    this._maybeSnap();
  }

  /**
   * Once every player has every seat's game: our game (as it is right now, when it runs here – it stands still from here
   * until the link runs) and our battery save to every partner. (Not earlier: a partner who still has to pick or build a
   * game would keep our game standing still all that time.)
   */
  async _maybeSnap() {
    const st = this.state;
    if (st.phase !== 'preparing' || st.saveSent || !st.seats.every((s) => st.ready[s])) return;
    // (the round trips are measured first – a state of a few MB on the channel would make them look far longer)
    if (st.host === this.me) {
      st.saveSent = true;
      this.rtt = await this._measure();
      if (this.state.sid !== st.sid) return;
      this._send({ t: 'snapnow' }, { relayToo: true });
    } else if (!st.snapNow) return;
    st.saveSent = true;
    await this._sendSave();
    if (this.state.sid === st.sid) this._maybeGo();
  }

  /** "Pick your copy of FireRed": a library ROM for a partner's seat (the server takes it only by SHA-1). */
  async pickRom(slot, romId) {
    await this._api('/api/link/pick', { runId: this.runId, slot, sha1: this.state.sha1[slot], romId });
    await this._resolve();
  }

  /** "Build Tim's game" (a randomized / patched run): that seat's game from the run's settings, then check again. */
  async buildPartner(slot) {
    this._set({ building: slot });
    try {
      await this._api('/api/link/build', { runId: this.runId, slot });
    } finally {
      this._set({ building: null });
    }
    await this._resolve();
  }

  /**
   * Our game for the session: when it runs here in the fast player, its state right now (it stands still until the link
   * runs – "Linking…") to every partner; and our battery save as it is on disk now, to every partner.
   */
  async _sendSave() {
    const st = this.state;
    let snap = null;
    if (this.ownGame()) {
      const t0 = performance.now();
      snap = await this.emu()?.linkSnapshot?.().catch(() => null);
      if (snap?.state) {
        const z = await deflate(snap.state);
        const hash = await sha1(snap.state);
        this.own = { state: snap.state, save: null, at: t0 }; // (a session that falls out of step goes back to here)
        const data = b64(z);
        st.snaps[this.me] = { sha1: hash, z: data };
        this.stats.snap = { bytes: snap.state.length, deflated: z.length, ms: Math.round(performance.now() - t0) };
        this.snapAt = t0; // (diagnostics: the steps of the start, in ms from the snapshot – stats.steps)
        this.stats.steps = {};
        // as bytes when the channel can (a DS state is 1.7 MB deflated: a third more as base64, and JSON on top), else in parts
        if (!this.sync.sendLinkBinary?.({ t: 'snap', slot: this.me, sha1: hash, sid: st.sid }, z, this.partners)) {
          const n = Math.max(1, Math.ceil(data.length / PART));
          for (let i = 0; i < n; i++) this._send({ t: 'snap', slot: this.me, sha1: hash, i, n, data: data.slice(i * PART, (i + 1) * PART) }, { relayToo: false });
        }
        this._step('sent');
      }
    }
    if (!snap?.state) { // (the game starts from its battery save: the one on disk – the running game's written first)
      // (the play view writes the running game's save to disk – its PUT finishes well within this)
      window.dispatchEvent(new Event('sl-save-now'));
      await new Promise((r) => setTimeout(r, 1200));
    }
    // (only "there is none" is a new cartridge: a save that couldn't be read would boot a blank one on the partners'
    // hosts while ours boots the real one from disk)
    let bytes = null;
    try {
      const r = await this.fetch(`/api/runs/${this.runId}/save/${this.me}`);
      bytes = r.ok ? new Uint8Array(await r.arrayBuffer()) : r.status === 404 ? new Uint8Array(0) : null;
    } catch {
      bytes = null;
    }
    if (!bytes) return this._fail('linkStart');
    const hash = bytes.length ? await sha1(bytes) : '';
    const data = bytes.length ? b64(await deflate(bytes)) : '';
    const n = Math.max(1, Math.ceil(data.length / PART));
    const state = st.snaps[this.me]?.sha1 || null;
    // our seat's console: the running game's (its state only loads into that model), else this computer's setting
    const model = snap?.model || this.ownModel || null;
    if (this.own) this.own.save = bytes.length ? bytes : null;
    st.saves[this.me] = { sha1: hash, b64: bytes.length ? b64(bytes) : '', state, model };
    for (let i = 0; i < n; i++) this._send({ t: 'save', slot: this.me, sha1: hash, i, n, data: data.slice(i * PART, (i + 1) * PART), state, model }, { relayToo: true });
    this._maybeGo();
  }

  /**
   * Leave (or cancel): the session ends for everybody. Also a session this page dropped out of and won't rejoin ("Leave
   * it"): the others still wait for it – they are told (bye), and a battle's result is void from this side (this page
   * can't know what happened while it was away – as after a rejoin), so nobody waits on it.
   */
  leave(reason = 'left') {
    const st = this.state;
    if (st.phase === 'rejoinable') {
      store.set(REJOIN_KEY(this.runId), null);
      if (st.sid && Array.isArray(st.seats)) {
        this._send({ t: 'bye', reason }, { relayToo: true });
        if (st.kind === 'battle') {
          try {
            this.onResult(resultEntry({ sid: st.sid, seats: st.seats, host: st.host, kind: st.kind, reason: 'rejoin' }));
          } catch (e) {
            console.warn('link result', e);
          }
        }
      }
      return this._set({ phase: 'idle', sid: null });
    }
    if (!st.sid || st.phase === 'idle' || st.phase === 'ended') return;
    this._send({ t: 'bye', reason }, { relayToo: true });
    this._end(reason, true);
  }

  _fail(code) {
    this._send({ t: 'bye', reason: code }, { relayToo: true });
    this._end(code, true);
  }

  /** The session is over. A desync puts the run's save back to what it was before (on every computer). */
  async _end(reason, mine = false) {
    const was = this.state.phase;
    const st = this.state;
    // once per session: both sides see a desync at the same time, and the other's bye arrives while this one ends
    if (this.endingSid && this.endingSid === st.sid) return;
    this.endingSid = st.sid;
    store.set(REJOIN_KEY(this.runId), null);
    let restored = null;
    if (reason === 'linkDesync' && st.id && (was === 'running' || was === 'rejoining')) {
      try {
        await this.beforeRestore(st);
      } catch {
        // (the restore goes ahead – the session's saves are dropped by closeSession as before)
      }
      try {
        restored = await this._api('/api/link/restore', { runId: this.runId, id: st.id, slot: this.me });
      } catch {
        restored = null;
      }
    }
    // the session's battles, read while every console still stands where the session left it (before ours goes on alone)
    if (was === 'running' || was === 'rejoining') await this._result(st, reason);
    // our own game goes on alone – from where the session left it, or (out of step) from where it was before the link.
    // A session that never ran: the snapshot's game simply goes on.
    let resumed = false;
    const emu = this.emu();
    if (was === 'running' || was === 'rejoining') {
      const back = reason === 'linkDesync' ? (this.own?.state ? { state: this.own.state, save: this.own.save } : undefined) : null;
      const t0 = performance.now();
      if (back !== undefined) resumed = !!(await emu?.resumeSolo?.(back).catch(() => false));
      if (resumed) this.stats.resume = { ms: Math.round(performance.now() - t0) };
    } else if (this.own?.state) await emu?.linkSnapshotCancel?.(this.own.state).catch(() => false);
    this._set({ phase: 'ended', ended: { reason, mine, at: Date.now(), restored, resumed } });
    if (was === 'running' || was === 'rejoining') this.closeSession(this.state);
  }

  // ---- incoming ----------------------------------------------------------------------------------------------------
  async _in(m) {
    const st = this.state;
    if (m.t === 'linked') return this._linkedIn(m);
    if (m.t === 'invite') {
      if (!Array.isArray(m.seats) || !m.seats.includes(this.me) || m.seats.length > 4) return;
      // (in another session already: say so – the inviter would wait for an answer otherwise)
      if (!['idle', 'ended', 'rejoinable'].includes(st.phase)) return st.sid !== m.sid && this.sync.sendLink({ t: 'refuse', reason: 'busy', sid: m.sid }, [m.from]);
      return this._new({
        phase: 'invited', sid: m.sid, kind: m.kind === 'battle' ? 'battle' : 'trade', seats: m.seats, host: m.from, sha1: { [m.from]: m.sha1?.[m.from] || null },
        crc: { [m.from]: m.crc?.[m.from] || null }, saves: {}, snaps: {}, accepted: { [m.from]: true }, ready: {}, missing: null, error: null, system: m.system, ended: null,
        route: {}, waiting: null, seamless: false, outcome: null,
        // (an older build sends no caps and no wager: the battle is for nothing)
        wager: { offer: m.kind === 'battle' && Array.isArray(m.caps) && m.caps.includes(WAGER_CAP) ? Math.max(0, Math.floor(Number(m.wager) || 0)) : 0, accepts: {},
          caps: { [m.from]: Array.isArray(m.caps) && m.caps.includes(WAGER_CAP) } },
        format: m.kind === 'battle' && ['single', 'double', 'multi'].includes(m.format) ? m.format : null,
      });
    }
    if (m.sid !== st.sid) return;
    if (!(st.seats || []).includes(m.from)) return;
    if (m.t === 'refuse') return this._end(m.reason || 'declined');
    if (m.t === 'bye') return this._end(m.reason || 'left');
    if (m.t === 'accept') {
      if (typeof m.sha1?.[m.from] !== 'string') return;
      st.sha1[m.from] = m.sha1[m.from];
      st.crc[m.from] = m.crc?.[m.from] || null;
      st.accepted[m.from] = true;
      if (st.wager) {
        st.wager.caps[m.from] = Array.isArray(m.caps) && m.caps.includes(WAGER_CAP);
        st.wager.accepts[m.from] = Math.max(0, Math.floor(Number(m.wager) || 0));
      }
      if (st.phase === 'inviting' && this.partners.every((s) => st.accepted[s])) {
        this._set({ phase: 'preparing' });
        this._measure(); // (the round trips meanwhile, while every player checks every seat's game)
      }
      this._resolve();
      return;
    }
    if (m.t === 'ready') {
      st.ready[m.from] = true;
      this._maybeSnap();
      return this._maybeGo();
    }
    if (m.t === 'got') {
      (st.got ||= {})[m.from] = true;
      this._step(`got-${m.from}`);
      return this._maybeGo();
    }
    if (m.t === 'snapnow' && m.from === st.host) {
      st.snapNow = true;
      return this._maybeSnap();
    }
    if (m.t === 'save') {
      const box = (st.saves[m.from] ||= { sha1: m.sha1 });
      if (typeof box.b64 === 'string') return;
      const packed = collect(box, m);
      if (packed === null) return;
      const bytes = packed ? await inflate(unb64(packed)) : new Uint8Array(0);
      delete box.parts;
      if (bytes.length > MAX_SAVE_BYTES || (bytes.length && (await sha1(bytes)) !== m.sha1)) return this._fail('linkSaveDiffers');
      box.state = typeof m.state === 'string' && /^[0-9a-f]{40}$/.test(m.state) ? m.state : null;
      box.model = m.model === 'dmg' || m.model === 'cgb' ? m.model : null;
      box.b64 = bytes.length ? b64(bytes) : '';
      return this._maybeGo();
    }
    if (m.t === 'snap') { // (kept deflated: the server inflates it and checks the SHA-1 – every peer the same bytes)
      if (typeof m.sha1 !== 'string' || !/^[0-9a-f]{40}$/.test(m.sha1)) return;
      const box = (st.snaps[m.from] ||= { sha1: m.sha1 });
      if (typeof box.z === 'string' || box.sha1 !== m.sha1) return;
      const packed = m.bin instanceof Uint8Array ? b64(m.bin) : collect(box, m); // (as bytes, or in parts)
      if (packed === null) return;
      box.z = packed;
      this._step(`snap-${m.from}`);
      delete box.parts;
      return this._maybeGo();
    }
    if (m.t === 'ping') return this._send({ t: 'pong', n: m.n }, { to: [m.from] });
    if (m.t === 'pong' && this.pings?.[m.n]) {
      (this.rtts[m.from] ||= []).push(performance.now() - this.pings[m.n]);
      return;
    }
    if (m.t === 'go' && m.from === st.host) {
      this._step('go');
      return this._start(m.delay, m.rtc);
    }
    if (m.t === 'in' && st.phase === 'running') return this._toHost(m);
    if (m.t === 'in' && (st.phase === 'preparing' || st.phase === 'rejoining')) return this.early.length < 4096 && this.early.push(m); // (our host is still starting)
    if (m.t === 'need' && st.phase === 'running') return this._need(m);
    if (m.t === 'hash' && st.phase === 'running') return this._hash(m.from, m.f, m.h);
    if (m.t === 'rejoin' && st.phase === 'running') return this._donate(m.from);
    if (m.t === 'state' && st.phase === 'rejoining') return this._stateIn(m);
    if (m.t === 'state-busy' && st.phase === 'rejoining') return this._fail('linkRejoinBusy'); // (the others stop waiting too)
  }

  /** Diagnostics: when a step of a seamless start happened, in ms after our snapshot. */
  _step(name) {
    if (this.snapAt && this.stats.steps) this.stats.steps[name] = Math.round(performance.now() - this.snapAt);
  }

  /** Inviter: the round trip to every partner (5 pings), measured while the games and saves are being exchanged. */
  _measure() {
    if (this.measuring) return this.measuring;
    this.pings = {};
    this.rtts = {};
    this.measuring = (async () => {
      for (let n = 0; n < 5; n++) {
        this.pings[n] = performance.now();
        this._send({ t: 'ping', n });
        await new Promise((r) => setTimeout(r, 60));
      }
      const got = () => this.partners.every((s) => (this.rtts[s] || []).length >= 5);
      for (let i = 0; i < 40 && !got(); i++) await new Promise((r) => setTimeout(r, 25));
      // per partner the median (one ping stuck behind other traffic doesn't count), then the slowest link (a mesh: every
      // host waits for every seat)
      const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
      const per = this.partners.map((s) => this.rtts[s]?.length ? med(this.rtts[s]) : 150);
      return per.length ? Math.max(...per) : 150;
    })();
    return this.measuring;
  }

  /** Inviter: once every seat's save (and running game) is here and every player has every game, say go. */
  async _maybeGo() {
    const st = this.state;
    const here = (s) => typeof st.saves[s]?.b64 === 'string' && (!st.saves[s].state || typeof st.snaps[s]?.z === 'string');
    // (a partner says 'got' once every seat's save and running game reached it: the start waits for that – a host
    // that started early would only stand and wait, and its page would be busy while the others still receive)
    if (st.host !== this.me && st.phase === 'preparing' && !st.gotSent && st.seats.every(here)) {
      st.gotSent = true;
      this._send({ t: 'got' }, { to: [st.host] });
    }
    if (st.host !== this.me || st.phase !== 'preparing' || this.going) return;
    if (!st.seats.every((s) => here(s) && st.ready[s])) return;
    if (st.seats.some((s) => st.saves[s].state) && !this.partners.every((s) => st.got?.[s])) return;
    this.going = true;
    const rtt = this.rtt ?? (await this._measure());
    this.measuring = null;
    this.rtt = null;
    const connected = this.partners.every((s) => this.sync.linkDirect(s));
    this.going = false;
    if (this.state.sid !== st.sid) return;
    if (!connected) return this._fail('linkNoDirect');
    const delay = linkDelay(rtt);
    const rtc = Date.now();
    this._send({ t: 'go', delay, rtc });
    this._step('go');
    this._set({ rtt: Math.round(rtt) });
    this._start(delay, rtc);
  }

  async _start(delay, rtc, state = null) {
    const st = this.state;
    // the partners' saves may still be inflating (messages are handled as they come)
    const here = (s) => s === this.me || (typeof st.saves[s]?.b64 === 'string' && (!st.saves[s].state || typeof st.snaps[s]?.z === 'string'));
    for (let i = 0; !state && i < 1200 && !st.seats.every(here); i++) await new Promise((r) => setTimeout(r, 50));
    // (a seat whose running game didn't arrive here would boot from its save here and from its state elsewhere)
    if (!state && !st.seats.every(here)) return this._fail(st.seats.some((s) => s !== this.me && st.saves[s]?.state) ? 'linkStateDiffers' : 'linkStart');
    try {
      // (a seat whose game was running starts from its state: the save's 'state' names it, the snap carries it)
      const snapOf = (slot) => (!state && st.saves[slot]?.state && st.snaps[slot]?.sha1 === st.saves[slot].state ? st.snaps[slot] : null);
      const seats = st.seats.map((slot) => ({
        slot, sha1: st.sha1[slot], crc: st.crc[slot] || null,
        save: slot === this.me || state ? null : st.saves[slot]?.b64 || null, saveSha1: state ? null : st.saves[slot]?.sha1 || null,
        state: snapOf(slot)?.z || null, stateSha1: snapOf(slot)?.sha1 || null,
        model: state ? st.models?.[slot] || null : st.saves[slot]?.model || null,
      }));
      this._step('start');
      const r = await this._api('/api/link/start', { runId: this.runId, local: this.me, seats, delay, rtc, ...(state ? { state } : {}) });
      this._step('started');
      this.hashes = {};
      // our game was running here: the player's picture switches to the link session – no new player, no restart
      const seamless = !!snapOf(this.me) && !!this.emu()?.attachLink?.(r.id);
      const models = Object.fromEntries(seats.map((x) => [x.slot, x.model]));
      // the wager every seat agreed to (each peer works it out from the same invite and accepts)
      const stake = st.wager ? agreedWager({ offer: st.wager.offer, seats: st.seats, host: st.host, accepts: st.wager.accepts, caps: st.wager.caps, cap: wagerRules(this.rules()).cap }) : 0;
      this._set({ phase: 'running', id: r.id, delay, rtc, local: r.local, waiting: null, startedAt: Date.now(), seamless, models, stake, rejoined: !!state });
      // the battles: read from every seat's console from now on (a rejoin can't know what happened while it was away)
      if (!state) {
        const startSaves = Object.fromEntries(st.seats.map((s) => [s, st.saves[s]?.b64 ? unb64(st.saves[s].b64) : null]));
        this.result = new LinkResult({ emu: this.emu, seats: st.seats, system: st.system, startSaves });
        this.result.begin();
      }
      // what a reload / crash needs to come back into this session (docs/MULTIPLAYER.md › "Rejoin")
      // (models: a rejoining host must run every Game Boy seat on the console the others run it on)
      store.set(REJOIN_KEY(this.runId), { sid: st.sid, kind: st.kind, seats: st.seats, host: st.host, sha1: st.sha1, crc: st.crc, delay, rtc, system: st.system, models, at: Date.now() });
      this.openSession(this.state);
      for (const m of this.early.splice(0)) this._toHost(m);
    } catch (e) {
      this._fail(e.code || 'linkStart');
    }
  }

  /**
   * What this computer read of the session's battles, into the run (onResult → `lb:<sid>:<me>`): every seat's battles
   * and the wager – or void (out of step, a player who dropped out and came back). A trade session only writes when a
   * battle was fought in it (the Colosseum is next door).
   */
  async _result(st, reason) {
    const res = this.result;
    this.result = null;
    if (reason === 'linkDesync' || st.rejoined) res?.stop();
    const base = { sid: st.sid, seats: st.seats, host: st.host, kind: st.kind };
    let entry = null;
    if (reason === 'linkDesync') entry = resultEntry({ ...base, reason: 'desync' });
    else if (st.rejoined) entry = resultEntry({ ...base, reason: 'rejoin' });
    else if (res) {
      const found = await Promise.race([res.finish().catch(() => null), new Promise((r) => setTimeout(() => r(null), 12000))]);
      res.stop();
      const fought = found && Object.values(found.per).some((c) => c.w + c.l + c.d > 0);
      if (st.kind === 'battle' || fought) entry = resultEntry({ ...base, found, wager: st.stake || 0, money: res.money || {} });
    } else if (st.kind === 'battle') entry = resultEntry({ ...base, reason: 'unread' });
    if (!entry) return;
    this.stats.result = entry;
    try {
      this.onResult(entry);
    } catch (e) {
      console.warn('link result', e);
    }
  }

  // ---- rejoin ------------------------------------------------------------------------------------------------------
  /** Back into a session this page dropped out of: ask the others for its state. */
  rejoin() {
    const st = this.state;
    if (st.phase !== 'rejoinable') return;
    this._set({ phase: 'rejoining', stateBox: {}, ended: null });
    this._send({ t: 'rejoin' }, { relayToo: true });
    clearTimeout(this.rejoinTimer);
    this.rejoinTimer = setTimeout(() => this.state.phase === 'rejoining' && !this.state.stateBox?.got && this._fail('linkRejoinGone'), 15000);
    this.rejoinTimer?.unref?.();
  }

  /** A partner rejoins: the one with the lowest seat among those still in sends the session's state. */
  async _donate(slot) {
    const st = this.state;
    const stay = st.seats.filter((s) => s !== slot && (s === this.me || this.sync.linkDirect(s)));
    if (stay[0] !== this.me) return;
    let bytes = null;
    for (let i = 0; i < 10 && !bytes; i++) { // (a DS console in the middle of a wireless exchange: not now – try again)
      bytes = await this.emu()?.linkState?.().catch(() => null);
      if (!bytes) await new Promise((r) => setTimeout(r, 300));
    }
    if (!bytes) return this._send({ t: 'state-busy' }, { to: [slot], relayToo: true });
    const data = b64(await deflate(bytes));
    const n = Math.max(1, Math.ceil(data.length / PART));
    this.stats.donated = (this.stats.donated || 0) + 1;
    for (let i = 0; i < n; i++) this._send({ t: 'state', i, n, data: data.slice(i * PART, (i + 1) * PART) }, { to: [slot] });
  }

  async _stateIn(m) {
    const st = this.state;
    const packed = collect(st.stateBox, m);
    if (packed === null) return;
    clearTimeout(this.rejoinTimer);
    this.stats.rejoined = (this.stats.rejoined || 0) + 1;
    this._start(st.delay, st.rtc, packed);
  }

  // ---- while it runs ---------------------------------------------------------------------------------------------------
  /** From the fast player (playernative.html): the host's buttons for the partners, hashes, waits. */
  _fromPlayer(e) {
    if (e.origin !== location.origin || this.state.phase !== 'running') return;
    const d = e.data;
    if (d?.type === 'emu-link-input' && d.bytes) {
      const v = new DataView(d.bytes.buffer, d.bytes.byteOffset, d.bytes.byteLength);
      const k = [];
      for (let o = 8; o + 4 <= d.bytes.length; o += 4) k.push(v.getUint32(o, true));
      const to = v.getUint32(0, true) !== this.state.local ? this.resendTo.splice(0) : null; // (an answer to a need)
      this._send({ t: 'in', s: v.getUint32(0, true), f: v.getUint32(4, true), k }, to?.length ? { to } : {});
      this.stats.sent = (this.stats.sent || 0) + 1;
    } else if (d?.type === 'emu-link-hash') {
      this._send({ t: 'hash', f: d.frame, h: d.hash });
      this._hash(this.me, d.frame, d.hash);
    } else if (d?.type === 'emu-link-wait') {
      this._set({ waiting: { seats: d.seats, ms: d.ms, frame: d.frame, at: Date.now() } });
      // a gap: ask every partner for the missing seats' buttons from that frame (any of them can answer)
      const now = Date.now();
      this.state.seats.forEach((slot, s) => {
        if (!(d.seats & (1 << s)) || now - (this.needAt[s] || 0) < 500) return;
        this.needAt[s] = now;
        this.stats.needs = (this.stats.needs || 0) + 1;
        this._send({ t: 'need', s, f: d.frame });
      });
    }
  }

  /** A partner misses seat m.s's buttons from frame m.f: our host sends what it has (NEED → LINPUT → 'in'). */
  _need(m) {
    if (!Number.isInteger(m.s) || m.s < 0 || m.s >= this.state.seats.length || !Number.isInteger(m.f) || m.f < 0) return;
    this.resendTo.push(m.from);
    this.stats.resends = (this.stats.resends || 0) + 1;
    this._cmd(LINK_CMD.NEED, [m.s, m.f >>> 0]);
  }

  _hash(slot, f, h) {
    const box = (this.hashes[f] ||= {});
    box[slot] = h;
    const got = Object.values(box);
    this.stats.hashes = (this.stats.hashes || 0) + 1;
    if (got.length > 1 && got.some((x) => x !== got[0])) {
      this.stats.mismatch = { frame: f, hashes: { ...box } };
      return this._fail('linkDesync');
    }
    if (got.length === this.state.seats.length) delete this.hashes[f];
    const old = Object.keys(this.hashes).map(Number).filter((x) => x < f - 1200);
    for (const x of old) delete this.hashes[x];
  }

  /** Buttons of seat m.s into our link host (any seat but our own – a resend may come from any partner). */
  _toHost(m) {
    const k = Array.isArray(m.k) ? m.k : [];
    const seat = m.s;
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.state.seats.length || seat === this.state.local || !k.length || k.length > 4096) return;
    this._cmd(LINK_CMD.RINPUT, [seat, m.f >>> 0, ...k]);
    this.stats.received = (this.stats.received || 0) + 1;
  }

  /** A command to the link host (u32 words), batched: one request at a time, what comes meanwhile goes along. */
  _cmd(type, words) {
    const b = new Uint8Array(8 + words.length * 4);
    const v = new DataView(b.buffer);
    v.setUint32(0, type, true);
    v.setUint32(4, words.length * 4, true);
    words.forEach((x, i) => v.setUint32(8 + i * 4, x >>> 0, true));
    this.cmdQueue.push(b);
    this._flushCmds();
  }

  _flushCmds() {
    if (this.cmdBusy || !this.cmdQueue.length || !this.state.id) return;
    const parts = this.cmdQueue.splice(0);
    const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) body.set(p, o), (o += p.length);
    this.cmdBusy = true;
    this.fetch(`/api/native/cmd?id=${this.state.id}`, { method: 'POST', headers: { 'x-soullink': '1' }, body })
      .then((r) => r.arrayBuffer())
      .catch(() => null)
      .then(() => {
        this.cmdBusy = false;
        this._flushCmds();
      });
  }

  /** How each partner is connected (direct / relayed through TURN), for the bar – while a session is being set up or runs. */
  async _routes() {
    const st = this.state;
    if (!['preparing', 'need', 'running', 'inviting'].includes(st.phase)) return;
    const route = {};
    for (const s of this.partners) route[s] = (await this.sync.linkRoute?.(s).catch(() => null)) || null;
    if (this.state.sid === st.sid && JSON.stringify(route) !== JSON.stringify(st.route || {})) this._set({ route });
  }
}
