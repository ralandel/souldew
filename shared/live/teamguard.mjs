// A wrong read must never end a run (#89: a German HeartGold read the beaten trainer's team as the player's, every
// Pokémon of it at 0 HP – "your team died", the Nuzlocke was over). The game never swaps the whole team at once: the PC
// moves one Pokémon at a time, a trade one, a catch adds one, and the last Pokémon can't be put away. So a team with
// none of the Pokémon of the team before it is a misread until it has stood for a while outside a battle – or a loaded
// save state / another save, which can wait that long. A team whose every Pokémon is down never comes in that way:
// that is what an opponent's party looks like after the player won.

/** How long (real ms, outside battles) a team with none of the last team's Pokémon has to stay before it counts. */
export const SWAP_HOLD_MS = 15000;

const down = (m) => !m?.isEgg && !m?.egg && m?.maxHp > 0 && m.hp === 0;

export class TeamGuard {
  constructor({ holdMs = SWAP_HOLD_MS } = {}) {
    this.holdMs = holdMs;
    this.keys = null; // the keys of the last team let through
    this.pending = null; // { sig, since } – a team with none of those, waiting
    this.held = 0; // polls held back in a row (diagnostics)
  }

  /** The game was reset, a state loaded, another game started: the next team is taken as it comes. */
  reset() {
    this.keys = null;
    this.pending = null;
    this.held = 0;
  }

  /**
   * One read team (`party`, the live reader's). → the team to use, or null while it is held back (the caller treats it
   * as no team this poll). `inBattle`: the player is in a battle (a swapped team isn't taken during one).
   */
  see(party, { now = Date.now(), inBattle = false } = {}) {
    if (!Array.isArray(party) || !party.length) return party;
    const keys = party.map((m) => m?.key).filter(Boolean);
    if (!keys.length) return party;
    if (!this.keys || keys.some((k) => this.keys.has(k))) return this.take(keys, party);
    const sig = keys.join();
    if (this.pending?.sig !== sig) this.pending = { sig, since: now };
    // (only time outside battles counts, and never for a team that is all down)
    if (inBattle || party.every((m) => down(m) || m?.isEgg || m?.egg)) this.pending.since = now;
    if (now - this.pending.since >= this.holdMs) return this.take(keys, party);
    this.held++;
    return null;
  }

  take(keys, party) {
    this.keys = new Set(keys);
    this.pending = null;
    this.held = 0;
    return party;
  }
}
