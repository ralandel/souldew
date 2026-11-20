// Shared World, the play view's half (docs/MULTIPLAYER.md › 9): the local player's state from the player page goes to
// the partners over the run's peer channel (web/lib/sync.mjs `world`), the partners' states go into the player page's
// overlay (web/lib/worldoverlay.mjs), and what's picked in its menu starts a trade or battle (web/lib/linksession.mjs)
// or sends a wave, an emote or a rock-paper-scissors challenge (web/lib/worldrps.mjs: the overlay shows the picker
// and the hands when it can, else the card of web/views/rps.mjs does).
//
// Bandwidth stays small and bounded: a state is ~40 bytes, sent only on the overworld, at most 15 times a second while
// something changes and once a second while standing still; partners without a direct link get one every 2 s over the
// encrypted relay. The Pokémon following you and your map's size ride along only when they change and with the
// heartbeat (shared/world.mjs packExt). Messages (msg.t): 'p' { w: packState } · 'wave' · 'emote' { e } · 'bye' (left
// the game) · 'rps' (shared/rps.mjs). Waves and emotes are rate-limited on both ends.
import { html } from '/vendor/htm-preact.mjs';
import { packState, packExt, changed, SEND, EMOTES, EMOTE_LIMIT, RateLimit } from '/shared/world.mjs';
import { t } from './i18n.mjs';

const GONE_MS = 5000; // a partner silent this long is gone from the overlay

/** Systems with a Shared World so far (Gen 1/2 on the Game Boy, Gen 3 on the GBA, Gen 4 on the DS; the player page checks
 * the game itself). */
export const WORLD_SYSTEMS = ['gb', 'gbc', 'gba', 'nds'];

/** The per-run "Show partners in my game" switch (this computer only, default on). */
export const worldPrefKey = (runId) => `sl-world-${runId}`;
export function worldEnabled(runId) {
  try {
    return localStorage.getItem(worldPrefKey(runId)) !== 'false';
  } catch {
    return true;
  }
}
export function setWorldEnabled(runId, on) {
  try {
    localStorage.setItem(worldPrefKey(runId), on ? 'true' : 'false');
  } catch {
    // storage blocked: the switch holds for this session
  }
}

/** "Show my Pokémon following me" (this computer only, every run, default on). */
export const FOLLOW_KEY = 'sl-world-follow';
export function followEnabled() {
  try {
    return localStorage.getItem(FOLLOW_KEY) !== 'false';
  } catch {
    return true;
  }
}
export function setFollowEnabled(on) {
  try {
    localStorage.setItem(FOLLOW_KEY, on ? 'true' : 'false');
  } catch {
    // storage blocked: the switch holds for this session
  }
}

/**
 * One per play view of a SoulLink game. `sync`: the run's SyncLink; `frame()`: the player iframe; `players`: { slot:
 * { name, color } }; `actions`: { slot: { trade, battle, why } } – what the menu offers for that partner right now;
 * `onAction(act, slot)`: 'trade' | 'battle' from the menu (waves are handled here).
 */
export class SharedWorld {
  constructor({ sync, me, frame, players = {}, enabled = true, actions = {}, lead = null, follow = true, rps = null, onAction = () => {}, onNear = () => {}, onSupported = () => {}, now = () => performance.now() }) {
    Object.assign(this, { sync, me, frame, players, enabled, actions, lead, follow, rps, onAction, onNear, onSupported, now });
    this.size = null; // this map's size [w, h] (the player page reads it)
    this.extKey = null; // the ext last sent, and when
    this.extAt = 0;
    this.emoteOut = new RateLimit(EMOTE_LIMIT);
    this.emoteIn = new Map(); // slot → RateLimit
    this.rpsShown = null; // the rock-paper-scissors game the overlay shows
    this.offRps = rps?.hub.on((e) => this._rps(e)) || null;
    this.near = 0;
    this.seq = 0;
    this.sent = null; // the last state sent { st, at, relayAt }
    this.local = null;
    this.heard = new Map(); // slot → when (our clock)
    this.configured = new WeakSet(); // the player pages (window objects) told so far
    this.stats = { sent: 0, relayed: 0, received: 0, bytes: 0 };
    this.offWorld = sync?.onWorld?.((m, via) => this._in(m, via)) || null;
    this.onMsg = (e) => this._fromPlayer(e);
    addEventListener('message', this.onMsg);
    this.timer = setInterval(() => this._tick(), 500);
  }

  get world() {
    return this.frame()?.contentWindow?.__world || null;
  }

  /** Changes from the play view (names, colours, the switch, what the link rules allow right now). */
  update(patch) {
    Object.assign(this, patch);
    this.configured = new WeakSet();
    this._configure();
  }

  labels() {
    return {
      trade: t('world.trade', 'Trade'),
      battle: t('world.battle', 'Battle'),
      wave: t('world.wave', 'Wave'),
      emote_wave: t('world.wave', 'Wave'),
      watch: t('world.watch', 'Watch'),
      gift: t('world.gift', 'Give item'),
      cancel: t('common.cancel', 'Cancel'),
      tagHint: t('world.tagHint3', 'Trade, battle, give an item, wave or play rock-paper-scissors'),
      keys: t('world.menuKeys', 'A choose · B back'),
      rps: t('world.rps', 'Rock-paper-scissors'),
      emotes: t('world.emotes', 'Emotes'),
      emote_heart: t('world.emoteHeart', 'Heart'),
      emote_excl: t('world.emoteExcl', '!'),
      emote_quest: t('world.emoteQuest', '?'),
      emote_gg: t('world.emoteGg', 'GG'),
      hand_rock: t('rps.rock', 'Rock'),
      hand_paper: t('rps.paper', 'Paper'),
      hand_scissors: t('rps.scissors', 'Scissors'),
      rpsWith: t('rps.with', 'Rock-paper-scissors · {name}'),
      bestOf3: t('rps.bestOf3Short', 'best of 3'),
      rpsKeys: t('rps.keys', '◀ ▶ choose · A pick · B pass'),
      ...rpsTexts(),
    };
  }

  _configure() {
    const w = this.world;
    const win = this.frame()?.contentWindow;
    if (!w || !win || this.configured.has(win)) return;
    this.configured.add(win);
    // (true once the player page found this game's tables – the switch shows only then)
    Promise.resolve(w.config({ me: this.me, players: this.players, enabled: this.enabled, actions: this.actions, labels: this.labels(), lead: this.lead, follow: this.follow }))
      .then((ok) => this.onSupported(!!ok, { follow: w.ownFollower?.() !== false }), () => this.onSupported(false, {}));
    if (this.togetherData) w.together?.(this.togetherData);
  }

  /**
   * Playing together (web/lib/together.mjs → web/lib/togetheroverlay.mjs): who is in a battle, catches, tombstones,
   * a "come here" – handed to the overlay as they change.
   */
  setTogether(data) {
    this.togetherData = data;
    this.world?.together?.(data);
  }

  /** Where I last stood on the overworld: { fam, map, x, y, size } or null (not on it since this game started). */
  position() {
    const st = this.shown?.st;
    // (the DS: its height too – a tombstone stands on the bridge where it happened)
    return st && st.fam ? { fam: st.fam, map: st.map, x: st.x, y: st.y, ...(Number.isFinite(st.h) ? { h: st.h } : {}), size: this.shown.size || null } : null;
  }

  _tick() {
    this._configure();
    const now = this.now();
    for (const [slot, at] of this.heard) {
      if (now - at > GONE_MS) {
        this.heard.delete(slot);
        this.world?.gone(slot);
      }
    }
    // a heartbeat while standing still (late joiners, a relay that lost one)
    if (this.local) this._send(this.local);
  }

  _fromPlayer(e) {
    const win = this.frame()?.contentWindow;
    if (e.origin !== location.origin || !win || e.source !== win) return;
    const d = e.data;
    if (d?.type === 'emu-world' && d.st) {
      this.local = d.st;
      // (where I last stood on the overworld – "come to me", the tombstone of a Pokémon that died in a battle there)
      if (!d.st.hidden) this.shown = { st: d.st, size: Array.isArray(d.size) ? d.size : this.shown?.size || null };
      // (Yellow: the game's own Pikachu follows – the partners see that one, as you do)
      this.gameLead = d.gameLead && d.gameLead.species > 0 ? d.gameLead : null;
      if (Array.isArray(d.size)) this.size = d.size;
      // (stamped with the moment the game showed it: the page says how long ago that was)
      this._send(d.st, Number.isFinite(d.age) ? Math.max(0, Math.min(200, d.age)) : 0);
      const n = Number(d.near) || 0;
      if (n !== this.near) this.onNear((this.near = n));
    } else if (d?.type === 'emu-world-act' && typeof d.slot === 'string') {
      if (d.act === 'wave' || d.act === 'emote') this.emote(d.act === 'wave' ? 'wave' : d.emote);
      else if (d.act === 'trade' || d.act === 'battle' || d.act === 'gift' || d.act === 'watch') this.onAction(d.act, d.slot);
      else if (d.act === 'rps') this.challenge(d.slot);
      // (for integrations and tests: what was picked, wherever the link flow lives)
      dispatchEvent(new CustomEvent('sl-world-action', { detail: { act: d.act, slot: d.slot, emote: d.emote } }));
    } else if (d?.type === 'emu-world-rps' && typeof d.id === 'string' && this.rps) {
      if (d.pass) this.rps.hub.pass(d.id);
      else this.rps.hub.pick(d.id, d.hand);
    }
  }

  /** An emote of mine – within the limits (EMOTE_LIMIT): to the partners and over my own head. */
  emote(name) {
    if (!EMOTES.includes(name) || !this.emoteOut.take(this.now())) return false;
    this.sync?.sendWorld(name === 'wave' ? { t: 'wave' } : { t: 'emote', e: name }, { relay: true });
    this.world?.emote(this.me, name);
    this.stats.waves = (this.stats.waves || 0) + 1;
    return true;
  }

  /** Rock-paper-scissors with a partner (the overlay opens the picker; a refused one says why). */
  challenge(slot, bo = 1) {
    const g = this.rps?.hub.challenge(slot, bo);
    if (g?.error) this.onAction(`rps-${g.error}`, slot);
    return g;
  }

  /** The hub changed: the overlay shows its game (or takes a new one while it can), and every round's hands. */
  _rps(e) {
    const r = this.rps;
    const w = this.world;
    if (!r || !w) return;
    if (e.type === 'round' && e.round?.result) w.rpsRound?.({ hands: e.round.result.hands, winner: e.round.result.winner });
    if (e.type !== 'change' || e.game.spectating) return;
    const id = e.game.id;
    // (a finished game on screen makes way for a new one)
    if (this.rpsShown && this.rpsShown !== id && !e.game.end && r.hub.games.get(this.rpsShown)?.end !== null) this.rpsShown = null;
    if (this.rpsShown && this.rpsShown !== id) return;
    if (!r.hub.games.has(id)) {
      if (this.rpsShown === id) {
        this.rpsShown = null;
        w.rps?.(null);
      }
      return;
    }
    if (!this.rpsShown) {
      // a new game: here when the game is on the overworld with Shared World on, else in the card
      if (r.claimed.has(id) || e.game.end || !w.canPresent?.()) return;
      r.claimed.add(id);
      this.rpsShown = id;
    }
    const v = r.hub.view(e.game);
    w.rps?.({ ...v, leftMs: v.until - Date.now() });
  }

  /** Sends the state when it changed (≤ 15/s) or as a heartbeat (1/s); the relay gets one every 2 s at most. */
  _send(st, age = 0) {
    if (!this.sync) return;
    const now = this.now();
    const s = this.sent;
    const diff = changed(st, s?.st);
    if (s && !diff && now - s.at < SEND.idleMs) return;
    // (on a 66 ms beat, not 66 ms after the last one: the page posts every 66 ms, and one that came a millisecond early
    // was dropped – the gaps were 66 or 133 ms at random, and the partners' delay jumped between them)
    if (s && diff && now < this.beat - SEND.minMs * 0.25) return;
    // standing hidden (a battle, a menu screen): one message says so, then quiet but for the heartbeat
    // (who follows me and my map's size: when they change, and with the heartbeat for whoever came later)
    const ext = packExt({ follower: this.gameLead || this.lead || null, size: this.size });
    const ek = JSON.stringify(ext);
    const extDue = ek !== this.extKey || now - this.extAt >= SEND.idleMs;
    const at = now - age; // (the moment the game showed this state)
    const w = packState(st, ++this.seq, at, extDue ? ext : null);
    if (extDue) {
      this.extKey = ek;
      this.extAt = now;
    }
    const relayDue = s?.relayAt == null || now - s.relayAt >= SEND.relayMs;
    const others = this.sync.others || [];
    const direct = this.sync.sendWorld({ t: 'p', w });
    const needRelay = others.some((slot) => !direct.has(slot) && this.sync.status?.partners?.[slot]);
    if (needRelay && relayDue) {
      this.sync.sendWorld({ t: 'p', w: extDue ? w : packState(st, this.seq, at, ext) }, { relay: true });
      this.stats.relayed++;
    }
    this.stats.sent++;
    this.stats.bytes += JSON.stringify(w).length + 20;
    this.sent = { st, at: now, relayAt: needRelay && relayDue ? now : s?.relayAt ?? null };
    this.beat = Math.max(now, this.beat || 0) + SEND.minMs;
  }

  _in(m) {
    if (!m || typeof m.from !== 'string' || m.from === this.me) return;
    const w = this.world;
    this.heard.set(m.from, this.now());
    this.stats.received++;
    if (m.t === 'p' && Array.isArray(m.w)) w?.partner(m.from, m.w);
    else if (m.t === 'wave' || m.t === 'emote') {
      // (a partner's bubbles within the same limits – a modified client can't flood your picture)
      const name = m.t === 'wave' ? 'wave' : m.e;
      if (!EMOTES.includes(name)) return;
      if (!this.emoteIn.has(m.from)) this.emoteIn.set(m.from, new RateLimit({ ...EMOTE_LIMIT, burst: EMOTE_LIMIT.burst + 1 }));
      if (this.emoteIn.get(m.from).take(this.now())) w?.emote ? w.emote(m.from, name) : w?.wave(m.from);
    }
    else if (m.t === 'bye') {
      this.heard.delete(m.from);
      w?.gone(m.from);
    }
  }

  stop() {
    clearInterval(this.timer);
    removeEventListener('message', this.onMsg);
    this.offWorld?.();
    this.offRps?.();
    if (this.rpsShown) this.rps?.claimed.delete(this.rpsShown);
    try {
      this.sync?.sendWorld({ t: 'bye' }, { relay: false });
    } catch {
      // the link is gone already
    }
    this.world?.config({ enabled: false });
  }
}

/** The switches in the play view's side panel: "Show partners in my game" and "Show my Pokémon following me". */
export function WorldToggle({ on, onChange, live, follow = null, onFollow = null }) {
  return html`<label class="world-toggle" title=${t('world.toggleHint2', 'Your partners walk in your game when you’re on the same map or next door, with the Pokémon at the front of their team. Walk up to them and press A to trade, battle, wave or play rock-paper-scissors.')}>
    <input type="checkbox" checked=${on} onChange=${(e) => onChange(e.currentTarget.checked)} />
    <span class="world-switch" aria-hidden="true"></span>
    <span class="tiny">${t('world.toggle', 'Show partners in my game')}</span>
    ${on && live > 0 && html`<span class="tiny faint">· ${t('world.nearby', '{n} here', { n: live })}</span>`}
  </label>
  ${onFollow && html`<label class="world-toggle" title=${t('world.followHint', 'The first Pokémon of your team that can fight walks behind you – only on this computer. Your partners see it either way. It walks through people and doors like the partners do.')}>
    <input type="checkbox" checked=${follow} onChange=${(e) => onFollow(e.currentTarget.checked)} />
    <span class="world-switch" aria-hidden="true"></span>
    <span class="tiny">${t('world.follow', 'Show my Pokémon following me')}</span>
  </label>`}`;
}

/** The words of the rock-paper-scissors picker and card (one place: the overlay gets them as labels). */
export function rpsTexts() {
  return {
    rpsPick: t('rps.pick', 'Pick your hand'),
    rpsAsked: t('rps.asked', '{name} wants to play – pick your hand'),
    rpsAgain: t('rps.again', 'Again!'),
    rpsWaiting: t('rps.waiting', 'Waiting for {name} …'),
    rpsTheyPicked: t('rps.theyPicked', '{name}: {hand}'),
    rpsRoundDraw: t('rps.roundDraw', 'A draw'),
    rpsRoundWin: t('rps.roundWin', 'You win the round'),
    rpsRoundLose: t('rps.roundLose', '{name} wins the round'),
    rpsDraw: t('rps.draw', 'It’s a draw'),
    rpsYouWin: t('rps.youWin', 'You win!'),
    rpsTheyWin: t('rps.theyWin', '{name} wins'),
    rpsYouPassed: t('rps.youPassed', 'Not this time'),
    rpsPassed: t('rps.passed', '{name} doesn’t want to play right now'),
    rpsBusy: t('rps.busy', '{name} is already playing'),
    rpsExpired: t('rps.expired', 'Time’s up'),
    rpsNoAnswer: t('rps.noAnswer', '{name} didn’t answer'),
    rpsTheyLate: t('rps.theyLate', '{name} didn’t pick in time – you win'),
    rpsYouLate: t('rps.youLate', 'You didn’t pick in time – {name} wins'),
    rpsTheyGaveUp: t('rps.theyGaveUp', '{name} gave up – you win'),
    rpsYouGaveUp: t('rps.youGaveUp', 'You gave up'),
    rpsNoReveal: t('rps.noReveal', '{name} didn’t show their hand – you win'),
    rpsMismatch: t('rps.mismatch', '{name}’s hand didn’t match the one they picked – this game doesn’t count'),
  };
}
