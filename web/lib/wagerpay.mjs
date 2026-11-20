// A won or lost wager into this player's own game (docs/MULTIPLAYER.md › "Battle results and wagers"): the play view
// asks every few hundred ms; once the player stands in the overworld of their own game (alone again – never during a
// link session, a battle, a menu or a script), the money goes into RAM through the cheat path (the fast player's WRITE
// between two frames), is read back, and the game saves it the next time the player saves.
//
// Exactly once into a save: `lbpay:<sid>:<me>` in the run says 'written' (with this game's boot) and then 'saved' once
// the game wrote its battery save after it. A game started again before that (a reset, a save state, the app closed
// without saving) is another boot: the money goes in again – the save it came from never had it.
import { owedTo, ownResultOf } from './wager.mjs';
import { addMoney, fieldIdle, readMoney, GAMES } from '/shared/linkbattle.mjs';

const VERIFY_MS = 1500;

export const newBoot = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export class WagerPay {
  /**
   * `onPaid({ sid, delta, before, after, pays })`: the money went in (the play view logs a payment and says so). `own(sid)`:
   * this computer's own result of a session (web/lib/wager.mjs ownResultOf) – the only one money follows.
   */
  constructor({ doc, me, onPaid = () => {}, own = (sid) => ownResultOf(doc?.runId, sid) }) {
    Object.assign(this, { doc, me, onPaid, own });
    this.boot = newBoot();
    this.busy = false;
    this.check = null; // { sid, after, before, at }: read again once the RAM mirror has caught up
  }

  /** The game started again (reset, a state loaded, a new start): money written but not saved goes in again. */
  restarted() {
    this.boot = newBoot();
    this.check = null;
  }

  /** The game wrote its battery save: what was written into it before is in the save now. */
  saved() {
    for (const [k, v] of Object.entries(this.doc.scan?.('lbpay:') || {})) {
      if (!k.endsWith(`:${this.me}`) || v?.status !== 'written' || v.boot !== this.boot || !v.checked) continue;
      this.doc.set(`lbpay:${k}`, { ...v, status: 'saved', savedAt: Date.now() }); // (scan gives the keys without the prefix)
    }
  }

  /**
   * One look: `game` (shared/linkbattle.mjs GAMES key of the running game), `read` / `write` (the player's memory),
   * `busyGame`: in a battle or a link session right now; `cam`: Gen 3's overworld reading (shared/world.mjs); `fresh()`
   * (the fast player): the core's whole memory into `read`'s copy – the check after a write reads what the game holds.
   */
  async tick({ game, read, write, busyGame = false, cam = undefined, fresh = null }) {
    if (this.busy || !game || !GAMES[game] || !read || !write) return null;
    this.busy = true;
    try {
      if (this.check && Date.now() - this.check.at >= VERIFY_MS) return await this._verify(game, read, fresh);
      if (this.check || busyGame) return null;
      const owed = owedTo(this.doc, this.me, { boot: this.boot, own: this.own });
      if (!owed.length || !(await fieldIdle(game, read, { cam }))) return null;
      const o = owed[0];
      const res = await addMoney(game, read, write, o.delta);
      if (!res.ok) return res;
      this.doc.set(`lbpay:${o.sid}:${this.me}`, { status: 'written', boot: this.boot, delta: o.delta, before: res.before, after: res.after, at: Date.now() });
      this.check = { sid: o.sid, before: res.before, after: res.after, at: Date.now() };
      this.onPaid({ ...o, ...res });
      return res;
    } finally {
      this.busy = false;
    }
  }

  /**
   * After the write: the money as the game holds it now (`fresh`: read from the core, not the player's copy). Still
   * the old sum – the write didn't land (Emerald moved its save blocks just then): it goes in again. The new sum: done.
   * Anything else (the player spent some at once): left as it is – better than paying twice.
   */
  async _verify(game, read, fresh = null) {
    const c = this.check;
    // (the fast player's copy of the memory takes a write at once: only the core's own memory says whether it landed)
    if (typeof fresh === 'function' && !(await fresh().catch(() => false))) return null; // (asked again next time)
    this.check = null;
    const key = `lbpay:${c.sid}:${this.me}`;
    const now = await readMoney(game, read);
    const v = this.doc.get(key);
    if (now === c.before && c.before !== c.after) {
      this.doc.set(key, null);
      return { retry: true };
    }
    if (v?.status === 'written') this.doc.set(key, { ...v, checked: true, now });
    return { checked: true, now };
  }
}
