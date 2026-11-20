// A link session's battles, read on this peer from EVERY seat's console (shared/linkbattle.mjs): the link host runs
// all of them here, so this page reads each seat's game through the host's READ (and every seat's battery save on
// FLUSH) – the same consoles every partner reads, so every partner comes to the same result on its own. What it found
// goes into the run (web/lib/wager.mjs), where the partners' results are compared before anything counts.
import { headerRange, gameOf, GAMES, BattleWatch, totals, countsBetween, readMoney } from '/shared/linkbattle.mjs';

const POLL_MS = 500;

export class LinkResult {
  /**
   * `emu()`: the player page's __emu (linkRead, linkSeatSaves); `seats`: the session's slots in seat order;
   * `system`: the link system ('gb' | 'gbc' | 'gba' | 'nds').
   */
  constructor({ emu, seats, system, startSaves = {} }) {
    // startSaves: slot → the battery save every peer got at the session's start (Gen 2's counts when FLUSH can't answer)
    Object.assign(this, { emu, seats, system, startSaves });
    this.games = null; // seat → GAMES key | null
    this.watch = null; // seat → BattleWatch (Gen 1, 3)
    this.start = null; // seat → totals at the start (Gen 2, 4)
    this.money = null; // slot → money at the session's end | null
    this.stopped = false;
    this.ready = null;
  }

  /** Every seat's battery save now (FLUSH), asked twice before giving up. */
  async seatSaves(n) {
    for (let i = 0; i < 2; i++) {
      const got = await this.emu()?.linkSeatSaves?.(n);
      if (got && Object.keys(got).length === n) return got;
    }
    return null;
  }

  read(seat) {
    return (addr, len) => this.emu()?.linkRead?.(seat, addr, len) ?? null;
  }

  /** Which game every seat runs and the counts so far – then the watch while it runs. */
  begin() {
    this.ready ||= (async () => {
      // (a session started from the board: its player page comes up a moment after the link host)
      for (let i = 0; i < 60 && !this.stopped && !this.emu()?.linkRead; i++) await new Promise((r) => setTimeout(r, 500)?.unref?.());
      const n = this.seats.length;
      const range = headerRange(this.system);
      // (the header answers once the page's stream from the link host is up)
      let first = null;
      for (let i = 0; i < 20 && !this.stopped && !(first = await this.read(0)(range.addr, range.len)); i++) await new Promise((r) => setTimeout(r, 500)?.unref?.());
      this.games = [];
      for (let s = 0; s < n; s++) this.games.push(gameOf(this.system, s ? await this.read(s)(range.addr, range.len) : first));
      const saves = this.games.some((g) => GAMES[g]?.kind === 'sram') ? await this.seatSaves(n) : null;
      this.start = await Promise.all(this.games.map((g, s) => (g ? totals(g, { read: this.read(s), save: saves?.[s] || this.startSaves[this.seats[s]] }) : null)));
      this.watch = this.games.map((g) => (GAMES[g]?.kind === 'events' ? new BattleWatch(g) : null));
      this._loop();
    })().catch(() => {
      this.games = null;
    });
    return this.ready;
  }

  /** Can this session's battles be read at all (every seat's game known)? */
  get readable() {
    return !!this.games?.length && this.games.every(Boolean);
  }

  async _loop() {
    while (!this.stopped) {
      await this.poll();
      await new Promise((r) => setTimeout(r, POLL_MS)?.unref?.()); // (Node, in tests: no reason to stay alive)
    }
  }

  /** One reading of every watched seat. */
  async poll() {
    if (!this.watch) return;
    // (a counted game that boots for the link has its save data in RAM only after Continue: its counts from then on –
    // they only change when a link battle ends)
    for (let s = 0; s < this.start.length; s++) {
      if (!this.start[s] && GAMES[this.games[s]]?.kind === 'records') this.start[s] = await totals(this.games[s], { read: this.read(s) }).catch(() => null);
    }
    await Promise.all(this.watch.map(async (w, s) => {
      if (!w) return;
      const parts = [];
      for (const r of w.ranges()) parts.push(await this.read(s)(r.addr, r.len));
      if (!this.stopped || this.finishing) w.feed(parts);
    }));
  }

  /**
   * The session is over (the consoles stand still): a last reading, the counts at the end. Every seat's counts
   * { slot: { w, l, d } } and whether it was a multi battle – or null when a seat's game couldn't be read.
   */
  async finish() {
    if (!this.emu()?.linkRead) { // (no player page that can read the consoles – nothing was watched)
      this.stopped = true;
      return null;
    }
    await this.ready;
    this.finishing = true;
    await this.poll();
    this.stopped = true;
    if (!this.readable) return null;
    const n = this.seats.length;
    // every seat's money as the session ends: the stake can't be more than anybody holds (each player's own money was
    // checked when they challenged or joined; read at the session's start instead, a game that boots for the link has
    // no save loaded yet and a blank save block reads ₽0)
    this.money = {};
    for (let s = 0; s < n; s++) this.money[this.seats[s]] = await readMoney(this.games[s], this.read(s)).catch(() => null);
    const saves = this.games.some((g) => GAMES[g]?.kind === 'sram') ? await this.seatSaves(n) : null;
    const per = {};
    let multi = false;
    for (let s = 0; s < n; s++) {
      const g = this.games[s];
      if (this.watch[s]) {
        per[this.seats[s]] = { ...this.watch[s].counts };
        multi ||= this.watch[s].multi;
      } else {
        const c = countsBetween(this.start[s], await totals(g, { read: this.read(s), save: saves?.[s] }));
        if (!c) return null;
        per[this.seats[s]] = c;
      }
    }
    return { per, multi, games: [...this.games] };
  }

  stop() {
    this.stopped = true;
  }
}
