// Missed encounters in the play view: which wild battles ended without a catch, and when to ask about them.
//
// The play view feeds every battle reading (each poll of the live loop, ~0.7 s apart) and every new Pokémon it sees into a
// MissedTracker; the tracker hands back the battles to ask about. It used to be a timer in the play view that every
// change of the battle cancelled: a wild battle that got away was only asked about when no other battle began within
// the next 10 seconds – on a route full of grass (Platinum's Route 204), or with fast-forward on, the next encounter
// came first and the question never did, so the next catch there was filed as the area's encounter (a player's report
// on Discord, 2.8.1). And a prompt on the screen went away when the next battle began.
//
// Now an ended battle waits for its question on its own clock, whatever happens after it; its question stays until it
// is answered (hidden during battles), and a catch of its Pokémon counts for it until the next battle has ended (a full
// party sending it to the PC – a catch can show up late, but never after the battle after it).

/** A wild battle ended and no new Pokémon showed up this long after → it got away. */
export const MISSED_WAIT = 10000;
/**
 * The 3DS games put a catch into the team only after the Pokédex entry and the nickname screen (a player's report, X:
 * the question came while they were still typing the nickname) – they get a minute.
 */
export const MISSED_WAIT_3DS = 60000;
/** How long the play view waits before asking about a battle of a game of generation `gen`. */
export const missedWait = (gen) => (gen >= 6 ? MISSED_WAIT_3DS : MISSED_WAIT);
/** At most this many questions wait at once (the oldest go – the first encounter of an area is the oldest one). */
const MAX_QUEUE = 6;

/**
 * Was this battle a wild one? Every reading says 'wild' or 'trainer'; Gen 4 tells them apart by a guess (the opponent's
 * party and trainer ID in the battle's heap copies) that can be wrong for a read. Wild when at least three of four
 * readings with an opponent said so – one stray read no longer turns a wild battle into a trainer battle, or back.
 */
export const wildBattle = (c) => c.wild > 0 && c.wild >= 3 * c.trainer;

/**
 * The place sign read on the overworld this long before a battle's first reading (with an opponent) still says where it
 * began – nobody walks during the transition and while the battle is set up.
 */
const BEFORE_BATTLE = 10000;
const samePlace = (a, b) => a.gen === b.gen && a.id === b.id;

export class MissedTracker {
  constructor({ wait = MISSED_WAIT } = {}) {
    this.wait = wait;
    this.cur = null; // the battle going on: { from, foe, here, before, mixed, wild, trainer }
    this.last = null; // the place sign last read outside a battle: { here, at }
    this.placed = false; // this game has shown a place sign this session
    // wild battles that ended and aren't settled yet – not asked about, or the battle after them not over yet (a catch
    // of theirs can still show up): { id, foe, from, end, until, here, asked }
    this.records = [];
    this.mons = []; // when a new Pokémon showed up (ms) – the last few
    this.n = 0;
  }

  /**
   * A battle reading at `now` (playerBattle: null outside battle – a catching demo is none of the player's), `here` the
   * place sign then. A reading without an opponent (a switch, the battle being set up or torn down) keeps the battle
   * going: only "no battle" ends it. → the record of a wild battle that just ended (else null)
   *
   * The record's place (`here`) is where the battle was: the place sign read in it – the first one, nobody walks during a
   * battle –, else the one read on the overworld the moment before it began. Never the place read after it: the player
   * may have walked on into an area whose first encounter is still open, and the question asked about that one (#80).
   * A battle whose readings name two places (a reader that saw the battle go on after it ended, a place sign still
   * catching up at its start) has no known place; `placeLost` then says this game does show places – ask nothing.
   */
  see(battle, now, here = null) {
    if (here) this.placed = true;
    if (battle) {
      if (!battle.enemy?.species) return null;
      if (!this.cur) {
        const before = this.last && now - this.last.at <= BEFORE_BATTLE ? this.last.here : null;
        this.cur = { from: now, foe: null, here: null, before, mixed: false, wild: 0, trainer: 0 };
      }
      this.cur[battle.kind === 'wild' ? 'wild' : 'trainer']++;
      this.cur.foe = battle.enemy;
      if (here && !this.cur.here) this.cur.here = here;
      else if (here && !samePlace(this.cur.here, here)) this.cur.mixed = true;
      return null;
    }
    if (here) this.last = { here, at: now };
    const c = this.cur;
    if (!c) return null;
    this.cur = null;
    // the battles before this one: a catch of theirs shows up before this one is over, never later
    for (const r of this.records) if (r.until === null) r.until = now;
    const at = c.mixed ? null : c.here || c.before;
    const r = wildBattle(c) ? { id: ++this.n, foe: c.foe, from: c.from, end: now, until: null, here: at, ...(!at && this.placed ? { placeLost: true } : {}), asked: false } : null;
    if (r) this.records.push(r);
    this.prune();
    return r;
  }

  prune() {
    this.records = this.records.filter((r) => !(r.asked && r.until !== null));
    // (far too many waiting: the oldest go first – never one handed out already)
    while (this.records.filter((r) => !r.asked).length > MAX_QUEUE) this.records.splice(this.records.findIndex((r) => !r.asked), 1);
  }

  /** A Pokémon this session hadn't seen (a catch, a hatch, a trade) turned up at `now` – `species` where known. */
  newMon(now, species = null) {
    this.mons.push({ at: now, species });
    if (this.mons.length > 16) this.mons.shift();
  }

  /**
   * When the Pokémon of the ended battle `r` turned up (or 0): a new Pokémon of its species during that battle or after
   * it, before the battle after it was over. Its species tells it from the next battle's catch (Gen 3 puts a catch into
   * the party mid-battle) and from an egg hatching meanwhile; a Pokémon whose species isn't known counts by time alone.
   */
  caughtAt(r) {
    const sp = r.foe?.species;
    return this.mons.find((m) => m.at >= r.from && (r.until === null || m.at < r.until) && (!m.species || !sp || m.species === sp))?.at || 0;
  }

  /** In a battle right now? */
  get fighting() {
    return !!this.cur;
  }

  /**
   * The ended wild battles whose wait is over at `now`, oldest first – each handed out once (the caller decides whether
   * to ask). The records stay live: caughtAt(r) still sees a catch that shows up later.
   */
  due(now) {
    const out = this.records.filter((r) => !r.asked && now - r.end >= this.wait);
    for (const r of out) r.asked = true;
    this.prune();
    return out;
  }
}

/**
 * The question queue: the questions in `list` (MissedTracker records) still worth asking – not caught after all
 * (`caughtAt`), `stillOpen(q)` (the area has no encounter of this player yet, the run goes on, … – web/lib/run.mjs
 * missedQuestion) and one per area (`areaOf(q)`: the first encounter there is the oldest question). Oldest first.
 */
export function openQuestions(list, { caughtAt = () => 0, stillOpen = () => true, areaOf = () => null } = {}) {
  const seen = new Set();
  return list.filter((q) => {
    if (caughtAt(q) || !stillOpen(q)) return false;
    const k = areaOf(q) || `?${q.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** At most this many questions wait in the play view at once (one per area – MissedTracker keeps a few more records). */
export const MAX_WAITING = 4;

/**
 * The play view's question list after a tick: the questions in `qs` still open (`stillOpen`), then the battles `add`
 * that just became due – but one per area (`areaOf`, the oldest: the first encounter there; a question without a known
 * area counts on its own) and `max` at most (the oldest stay). A route full of grass no longer piles up a question per
 * fled battle that "No" then has to answer one by one.
 */
export function queueQuestions(qs, add, { stillOpen = () => true, areaOf = () => null, max = MAX_WAITING } = {}) {
  const seen = new Set();
  const out = [];
  for (const q of [...qs.filter((x) => stillOpen(x)), ...add]) {
    const k = areaOf(q);
    if (k) {
      if (seen.has(k)) continue;
      seen.add(k);
    }
    if (out.length < max) out.push(q);
  }
  return out;
}

/**
 * "No – doesn't count" for question `q`: it goes, and every other question waiting for its area with it (they ask the
 * same thing). The area stays open – a battle that gets away there later is asked about again.
 */
export function dropQuestion(qs, q, { areaOf = () => null } = {}) {
  const k = areaOf(q);
  return qs.filter((x) => x !== q && !(k && areaOf(x) === k));
}
