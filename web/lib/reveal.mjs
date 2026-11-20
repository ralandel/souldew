// Deaths shown when the game shows them. Live tracking reads a Pokémon's HP at 0 the moment the game writes it – while
// the game itself still drains the HP bar, plays the cry and prints "… fainted!". Revealing the death right then (the
// notice, the sound, "the run is over", the partners' toast, the stream overlay) told the player before the game did.
// The play view runs every live reading through a DeathReveal: a Pokémon that goes down is "held" – it keeps the HP the
// player last saw – until the game has shown its fall, and only then does the 0 HP go anywhere. Its death is recorded
// at once all the same (web/lib/run.mjs applySnapshot `held` → `held:<slot>:<area>`, revealHeld).
//
// When is it shown? None of the readers sees the HP the game *displays* (the healthbox's animated value – Gen 3 keeps it
// in gBattleSpritesDataPtr->battleBars[].currValue on the heap, the DS and 3DS games in their battle UI's own structs,
// at addresses souldew doesn't know for every release), so it goes by:
//  - the Pokémon has left the field: the battle is over (two readings without one – a whiteout ends it after the
//    message), or the player's next Pokémon is out in its place;
//  - else the time the game takes from that 0 HP to the end of its "… fainted!" message, per generation, at the
//    speed the game really runs at (fast-forward shortens it – at Max it is next to nothing), less the poll live
//    tracking already waited to confirm the 0 HP (#79: two fresh readings);
//  - never longer than REVEAL_CAP_MS of running game (paused time doesn't count) – a missed signal can't hold it forever;
//  - right away when the game is reset, a state is loaded or the game is closed (releaseAll), and when the Pokémon
//    shows HP again or is gone from the party (the same events, seen from the memory).

/**
 * Game time (ms at 1×) from the first reading at 0 HP to the end of the "… fainted!" message – from the pret
 * disassemblies' battle scripts and frame counts, not measured on a stopwatch:
 *  - Gen 1/2: the HP is written before the bar animates (pokered ApplyDamageToPlayerPokemon → UpdateHPBar2, two frames
 *    per pixel of a 48 px bar: up to ~1.6 s), then the slide-down and the message: ~3 s.
 *  - Gen 3: the HP is written after the bar has drained (healthbarupdate → datahpupdate), so only the cry, the
 *    slide-down and the message are left: ~2 s.
 *  - Gen 4/5: the bar animates after the HP is set; drain ~1 s plus the faint animation and message ~2 s.
 *  - Gen 6/7: drain ~1 s, the faint animation, the cry and the message ~2.2 s.
 */
export const REVEAL_MS = { 1: 3000, 2: 3000, 3: 2000, 4: 3000, 5: 3000, 6: 3200, 7: 3200 };
/** At most this much running game (real ms while not paused) between the 0 HP and its reveal. */
export const REVEAL_CAP_MS = 10000;
/** The live loop's poll (web/views/play.mjs tick): the 0 HP was read one poll before it was confirmed. */
export const POLL_MS = 700;
/** "Max" fast-forward when the computer's real reach isn't known yet. */
const MAX_SPEED = 16;

/** How fast the game runs: 0 paused, the set speed – Max (Infinity) as what this computer reaches. */
export function effectiveSpeed(set, { paused = false, reach = null } = {}) {
  if (paused) return 0;
  const s = Number(set);
  if (!Number.isFinite(s)) return Number.isFinite(reach) && reach > 1 ? reach : MAX_SPEED;
  return s > 0 ? Math.min(s, MAX_SPEED) : 1;
}

const isDown = (m) => !!m?.key && !m.isEgg && !m.egg && m.maxHp > 0 && m.hp === 0;
const outKeys = (party, battle) => new Set([battle?.active, ...(battle?.actives || [])]
  .map((a) => (a && Number.isInteger(a.index) ? party[a.index]?.key : null)).filter(Boolean));

export class DeathReveal {
  constructor({ pollMs = POLL_MS } = {}) {
    this.pollMs = pollMs;
    this.last = new Map(); // key → the HP last shown (> 0)
    this.holds = new Map(); // key → { hp, game, need, running, out, gone }
    this.at = null;
    this.noBattle = 0; // readings in a row without a battle
  }

  /** Held keys → the HP they keep showing (what applySnapshot takes as `held`). */
  get held() {
    return new Map([...this.holds].map(([k, h]) => [k, h.hp]));
  }

  /** The game was reset, a state loaded, the game closed: every death held now is shown. */
  releaseAll() {
    this.holds.clear();
  }

  /**
   * A poll without a team (a menu, the title screen, the game loading): the clocks go on, a held death is shown once
   * its time is up. → the held keys left.
   */
  idle({ now = Date.now(), speed = 1 } = {}) {
    const dt = this.at === null ? 0 : Math.max(0, Math.min(now - this.at, 5000));
    this.at = now;
    for (const [key, h] of this.holds) {
      h.game += dt * Math.max(0, speed);
      if (speed > 0) h.running += dt;
      if (h.game >= h.need || h.running >= REVEAL_CAP_MS) this.holds.delete(key);
    }
    return this.held;
  }

  /**
   * One live reading: `party` as live tracking confirmed it (confirmFaints), `battle` the player's battle (or null).
   * `speed`: how fast the game runs now (effectiveSpeed), `gen` the game's generation, `now` the clock.
   * → { party, battle, held }: the party and battle as the player sees them (held Pokémon keep their last HP), and the
   * held keys with that HP.
   */
  see(party, { now = Date.now(), speed = 1, gen = 4, battle = null } = {}) {
    const list = Array.isArray(party) ? party : [];
    const dt = this.at === null ? 0 : Math.max(0, Math.min(now - this.at, 5000));
    this.at = now;
    const game = dt * Math.max(0, speed);
    this.noBattle = battle ? 0 : this.noBattle + 1;
    const out = outKeys(list, battle);
    const present = new Set(list.map((m) => m?.key).filter(Boolean));
    for (const [key, h] of this.holds) {
      const m = list.find((x) => x?.key === key);
      h.game += game;
      if (speed > 0) h.running += dt;
      if (out.has(key)) h.out = true;
      const left = h.out && ((battle && !out.has(key) && out.size > 0) || this.noBattle >= 2); // replaced, or the battle is over
      const healed = m && !isDown(m); // HP again: a reset, a loaded state, a revive – the fall happened all the same
      if (!present.has(key) || healed || left || h.game >= h.need || h.running >= REVEAL_CAP_MS) this.holds.delete(key);
    }
    for (const m of list) {
      if (!m?.key) continue;
      if (!isDown(m)) {
        if (m.hp > 0) this.last.set(m.key, m.hp);
        continue;
      }
      const shown = this.last.get(m.key);
      // down when tracking started (nothing was shown), or revealed already
      if (!(shown > 0) || this.holds.has(m.key)) continue;
      this.last.delete(m.key);
      const need = Math.max(0, (REVEAL_MS[gen] ?? 3000) - this.pollMs * Math.max(1, speed));
      if (need <= 0) continue; // (fast-forward: the game has shown it while the 0 HP was being confirmed)
      this.holds.set(m.key, { hp: shown, game: 0, need, running: 0, out: out.has(m.key) });
    }
    if (!this.holds.size) return { party: list, battle, held: new Map() };
    const hp = (key, v) => (this.holds.has(key) ? this.holds.get(key).hp : v);
    const shownParty = list.map((m) => (m?.key && this.holds.has(m.key) ? { ...m, hp: hp(m.key, m.hp) } : m));
    const mask = (a) => {
      const key = a && Number.isInteger(a.index) ? list[a.index]?.key : null;
      return key && this.holds.has(key) && a.hp !== undefined ? { ...a, hp: hp(key, a.hp) } : a;
    };
    const shownBattle = battle && (battle.active || battle.actives)
      ? { ...battle, ...(battle.active ? { active: mask(battle.active) } : {}), ...(battle.actives ? { actives: battle.actives.map(mask) } : {}),
        ...(battle.party ? { party: (() => {
          // by PID – the n-th of a PID in the copy is the n-th of it in the team: two clones share one (as
          // shared/live/parse.mjs battleTwins)
          const seen = new Map();
          return battle.party.map((b) => {
            const n = seen.get(b.pid) || 0;
            seen.set(b.pid, n + 1);
            const m = list.filter((x) => x?.pid !== undefined && x.pid === b.pid)[n];
            return m && this.holds.has(m.key) ? { ...b, hp: hp(m.key, b.hp) } : b;
          });
        })() } : {}) }
      : battle;
    return { party: shownParty, battle: shownBattle, held: this.held };
  }
}
