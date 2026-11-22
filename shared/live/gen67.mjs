// Gen 6 / 7 (Nintendo 3DS: X/Y, Omega Ruby/Alpha Sapphire, Sun/Moon, Ultra Sun/Ultra Moon) – the party in the running
// game's memory, read through Azahar's RPC server (server/lib/azahar.mjs).
//
// The party lies at a fixed address in the game's process (one per game and update version), six slots of 0x1E4 bytes:
// the encrypted 232-byte PK6/PK7 box data, and at +0x158 its encrypted party stats (status, level, HP, stats – the
// PK6 bytes 0xE8…). Addresses: Citra-Tracker (kcblack42) and Pokémon Stream Tool (Readek) agree on them, and XY's /
// ORAS's update moves the party and the badges by the same distance in both.
//
// PK6/PK7 crypto (PKHeX PokeCrypto): the encryption constant (bytes 0–3) seeds the LCG over 0x08–0xE7 and, started
// again, over the party stats; the four 56-byte blocks are shuffled by ((EC >> 13) & 31) % 24 like in Gen 4/5; the
// checksum (0x06) is the 16-bit sum of 0x08–0xE7.

import { summaryPk67 } from '../monstats.mjs';
import { formSpriteId, formKind } from '../forms.mjs';

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const w16 = (b, o, v) => {
  b[o] = v & 0xff;
  b[o + 1] = (v >> 8) & 0xff;
};
const hex = (v) => (typeof v === 'string' ? parseInt(v, 16) : Number(v));

export const SLOT_STRIDE = 0x1e4;
export const BOX_SIZE = 0xe8; // 232
export const STATS_OFFSET = 0x158; // party stats inside a RAM slot
export const STATS_SIZE = 0x1c; // PK6 0xE8–0x103
export const PARTY_BYTES = 6 * SLOT_STRIDE;

const BLOCK = 56;
const BLOCK_POSITION = [
  [0, 1, 2, 3], [0, 1, 3, 2], [0, 2, 1, 3], [0, 3, 1, 2], [0, 2, 3, 1], [0, 3, 2, 1],
  [1, 0, 2, 3], [1, 0, 3, 2], [2, 0, 1, 3], [3, 0, 1, 2], [2, 0, 3, 1], [3, 0, 2, 1],
  [1, 2, 0, 3], [1, 3, 0, 2], [2, 1, 0, 3], [3, 1, 0, 2], [2, 3, 0, 1], [3, 2, 0, 1],
  [1, 2, 3, 0], [1, 3, 2, 0], [2, 1, 3, 0], [3, 1, 2, 0], [2, 3, 1, 0], [3, 2, 1, 0],
];
const BLOCK_POSITION_INVERT = [0, 1, 2, 4, 3, 5, 6, 7, 12, 18, 13, 19, 8, 10, 14, 20, 16, 22, 9, 11, 15, 21, 17, 23];

function cryptArray(u8, start, end, seed) {
  for (let i = start; i + 1 < end; i += 2) {
    seed = (Math.imul(0x41c64e6d, seed) + 0x6073) >>> 0;
    const v = (u8[i] | (u8[i + 1] << 8)) ^ (seed >>> 16);
    u8[i] = v & 0xff;
    u8[i + 1] = v >> 8;
  }
}

/** Decrypt a PK6/PK7 (232 bytes, or 260 with the party stats). */
export function decryptPK6(src) {
  const d = Uint8Array.from(src);
  const ec = u32(d, 0);
  cryptArray(d, 8, BOX_SIZE, ec);
  if (d.length > BOX_SIZE) cryptArray(d, BOX_SIZE, d.length, ec);
  const row = BLOCK_POSITION[((ec >>> 13) & 31) % 24];
  const out = d.slice();
  for (let i = 0; i < 4; i++) out.set(d.subarray(8 + row[i] * BLOCK, 8 + row[i] * BLOCK + BLOCK), 8 + i * BLOCK);
  let sum = 0;
  for (let i = 8; i < BOX_SIZE; i += 2) sum = (sum + u16(out, i)) & 0xffff;
  return { data: out, checksumOk: sum === u16(out, 6) };
}

/** Inverse of decryptPK6 – writes the checksum (tests, fixtures). */
export function encryptPK6(plain) {
  const d = Uint8Array.from(plain);
  const ec = u32(d, 0);
  let sum = 0;
  for (let i = 8; i < BOX_SIZE; i += 2) sum = (sum + u16(d, i)) & 0xffff;
  w16(d, 6, sum);
  const row = BLOCK_POSITION[BLOCK_POSITION_INVERT[((ec >>> 13) & 31) % 24]];
  const out = d.slice();
  for (let i = 0; i < 4; i++) out.set(d.subarray(8 + row[i] * BLOCK, 8 + row[i] * BLOCK + BLOCK), 8 + i * BLOCK);
  cryptArray(out, 8, BOX_SIZE, ec);
  if (out.length > BOX_SIZE) cryptArray(out, BOX_SIZE, out.length, ec);
  return out;
}

// Gen 6/7 text is UTF-16; the gender signs sit in the private use area.
const CHAR_FIX = { 0xe08e: '♂', 0xe08f: '♀', 0xe08d: '…' };
function text(d, off, maxChars) {
  let s = '';
  for (let i = 0; i < maxChars; i++) {
    const c = u16(d, off + i * 2);
    if (!c || c === 0xffff) break;
    s += CHAR_FIX[c] || String.fromCharCode(c);
  }
  return s;
}

// Party status. The 3DS games keep a number, not Gen 3–5's flags: 1 paralysis, 2 sleep, 3 freeze, 4 burn, 5 poison
// (checked live in Ultra Sun: a paralysed Smeargle reads 1 – as flags that would be "asleep, 1 turn"). Handed on in
// Gen 3–5's form (the app's status code reads that): paralysis 0x40, sleep 1, freeze 0x20, burn 0x10, poison 0x08.
// A flag value as in Gen 3–5 is still accepted as such.
const STATUS_CODE = [0, 0x40, 1, 0x20, 0x10, 0x08];
const statusOk = (s) => s <= 7 || s === 8 || s === 16 || s === 32 || s === 64 || s === 128;
export const statusCode = (s) => (s < STATUS_CODE.length ? STATUS_CODE[s] : s <= 7 ? 0 : s & 0xff);

/**
 * One party Pokémon from a decrypted 260-byte PK6/PK7, or null when the bytes are no Pokémon of this generation
 * (an empty slot, a struct the game is rewriting, garbage).
 */
export function pk6Mon(raw, gen) {
  const { data: d, checksumOk } = decryptPK6(raw);
  if (!checksumOk) return null;
  const species = u16(d, 0x08);
  if (!species || species > (gen >= 7 ? 807 : 721)) return null;
  const iv32 = u32(d, 0x74);
  const isEgg = !!(iv32 & 0x40000000);
  const status = u32(d, 0xe8);
  const level = d[0xec];
  const hp = u16(d, 0xf0);
  const maxHp = u16(d, 0xf2);
  if (!statusOk(status)) return null;
  if (isEgg ? level > 100 || hp > maxHp : level < 1 || level > 100 || !maxHp || hp > maxHp) return null;
  // the five other stats – a struct being rewritten reads as words far above any real stat
  for (let o = 0xf2; o < 0xfe; o += 2) if (u16(d, o) > 999) return null;
  const pid = u32(d, 0x18);
  const tid = u16(d, 0x0c);
  const sid = u16(d, 0x0e);
  const formByte = d[0x1d];
  return {
    key: `${pid.toString(16).padStart(8, '0')}-${tid}-${sid}`,
    pid, ec: u32(d, 0), species, form: formByte >> 3, nickname: text(d, 0x40, 12), isEgg, item: u16(d, 0x0a),
    moves: [u16(d, 0x5a), u16(d, 0x5c), u16(d, 0x5e), u16(d, 0x60)].filter(Boolean),
    metLocation: u16(d, 0xda), eggLocation: u16(d, 0xd8), metLevel: d[0xdd] & 0x7f,
    gender: ['M', 'F', '-'][(formByte >> 1) & 3] || '-',
    shiny: ((tid ^ sid ^ (pid >>> 16) ^ (pid & 0xffff)) >>> 0) < 16,
    status: statusCode(status), level, hp, maxHp,
    // nature, ability, IVs, EVs (shared/monstats.mjs)
    summary: summaryPk67(d, gen),
  };
}

/** The 260-byte PK6/PK7 of RAM slot `i` in a 6-slot party region. */
export function slotBytes(region, i) {
  const at = i * SLOT_STRIDE;
  const out = new Uint8Array(BOX_SIZE + STATS_SIZE);
  out.set(region.subarray(at, at + BOX_SIZE), 0);
  out.set(region.subarray(at + STATS_OFFSET, at + STATS_OFFSET + STATS_SIZE), BOX_SIZE);
  return out;
}

/** Reads of the very same slot bytes failing their checksum before the slot counts as a Bad Egg (as in Gen 3). */
const BAD_EGG_READS = 3;

/**
 * The party in a 6-slot region: the slots from the first on, up to the first empty one. null when slot 0 isn't a
 * Pokémon (title screen, another update's address) or a slot after it is damaged (the game rewriting the party).
 * `bad` (one object per region, kept across polls): a slot whose very same bytes fail the checksum for several reads
 * is a Bad Egg, not a write in progress – it is skipped (no party member) instead of ending the party there (it hid
 * every Pokémon behind it – in slot 0 the whole team, for good).
 */
export function partyFromRegion(region, gen, bad = null) {
  if (!region || region.length < PARTY_BYTES) return null;
  const party = [];
  for (let i = 0; i < 6; i++) {
    const raw = slotBytes(region, i);
    if (raw.every((b) => b === 0)) break;
    const m = pk6Mon(raw, gen);
    if (!m) {
      if (bad && !decryptPK6(raw).checksumOk) {
        const sig = Array.prototype.join.call(raw.subarray(0, 64), ',');
        bad[i] = bad[i]?.sig === sig ? { sig, n: bad[i].n + 1 } : { sig, n: 1 };
        if (bad[i].n >= BAD_EGG_READS) continue;
      }
      // slot 0 must hold a Pokémon. After it, the first slot that doesn't ends the party: empty slots hold blank
      // data (encryption constant 0, species 0), zeros or what was there before (readGen67 confirms a shrink).
      if (i === 0) return null;
      break;
    }
    if (bad) delete bad[i]; // a good read: a Bad Egg there has to be seen several times anew
    // the same Pokémon twice: read while the party menu swaps two slots
    if (party.some((x) => x.pid === m.pid && x.ec === m.ec)) return null;
    party.push(m);
  }
  // (only Bad Eggs – another update's address reads as garbage that never changes: no party)
  return party.length ? party : null;
}

/** Memory regions of a 3DS address-table entry: the party at every known update's address. */
export function regions67(entry) {
  return (entry.partyAddrs || []).map((a) => ({ addr: hex(a.addr ?? a), len: PARTY_BYTES }));
}

// ---- finding the party object (Gen 6) -------------------------------------------------------------------------------
// The game keeps its team in one party object: the six RAM slots, then u32 6 (how many it holds at most) and u32 the
// count (checked live in Omega Ruby 1.0: 0x08CF727C, `06 00 00 00 01 00 00 00` right behind the slots with Torchic; the
// party menu shows what is written there). Over the whole heap of Omega Ruby 1.0 (a new game, with a cold start and
// after a loaded state alike) exactly that one place has it – the save data's copy of the team (0x08C7D4CC) has the
// box layout (0x104 per Pokémon) and no such tail. Where no known address holds the team, souldew looks for that.
export const PARTY_TAIL = 8;

/** The team of a party object at `o` in `b` (slots, then u32 6, u32 count = the Pokémon read) – or null. */
export function partyObjectAt(b, o, gen) {
  if (!b || o < 0 || o + PARTY_BYTES + PARTY_TAIL > b.length) return null;
  if (u32(b, o + PARTY_BYTES) !== 6) return null;
  const count = u32(b, o + PARTY_BYTES + 4);
  if (count < 1 || count > 6) return null;
  const party = partyFromRegion(b.subarray(o, o + PARTY_BYTES), gen);
  return party && party.length === count ? party : null;
}

/** The party objects in one window of memory (`b` read at `addr`) → [{ addr, party }]. */
export function scanPartyObjects(addr, b, gen) {
  const out = [];
  if (!b) return out;
  for (let o = 0; o + PARTY_BYTES + PARTY_TAIL <= b.length; o += 4) {
    // (the tail first: two words, cheap – the slots are decrypted only behind one)
    if (b[o + PARTY_BYTES] !== 6 || b[o + PARTY_BYTES + 1] || b[o + PARTY_BYTES + 2] || b[o + PARTY_BYTES + 3]) continue;
    const party = partyObjectAt(b, o, gen);
    if (party) out.push({ addr: (addr + o) >>> 0, party });
  }
  return out;
}

const PARTY_WINDOW = 0x10000;
const PARTY_STEP = PARTY_WINDOW - 0x1000; // (a party object is 0xB60 bytes: every one lies whole in some window)
const PARTY_PER_ROUND = 5; // windows per read (the player watches 16 regions at most: the game's own, the bag and the party found)
/** Gen 6's application heap, where the party lives (Omega Ruby 1.0 uses up to ~0x08E00000). */
const HEAP6 = [0x08000000, 0x09000000];

/** The windows to read for the search, the ones next to the known addresses first, in rounds. */
export function ctrPartyPlan(entry) {
  if (entry?.gen !== 6) return [];
  const known = (entry.partyAddrs || []).map((a) => hex(a.addr ?? a)).filter(Boolean);
  const wins = [];
  for (let w = HEAP6[0]; w < HEAP6[1]; w += PARTY_STEP) wins.push(w);
  const dist = (w) => (known.length ? Math.min(...known.map((k) => Math.abs(w + PARTY_WINDOW / 2 - k))) : 0);
  wins.sort((x, y) => dist(x) - dist(y) || x - y);
  const rounds = [];
  for (let i = 0; i < wins.length; i += PARTY_PER_ROUND) rounds.push(wins.slice(i, i + PARTY_PER_ROUND).map((addr) => ({ addr, len: PARTY_WINDOW, name: 'partySearch' })));
  return rounds;
}

const tidSid = (m) => String(m?.key || '').split('-').slice(1).join('-');

/**
 * Search a Gen 6 game's heap for its party object (when no known address holds the team, or to make sure the one read
 * is the game's own). `mem.watch(regions, key)` lets the 3DS player read more memory and resolves once it has; the found
 * party stays watched (key 'party'). Only party objects of the team's trainer count when a team is known (`team` – the
 * game builds other parties for battles), and only when exactly one of them lies away from the known addresses: kept as
 * state.g67Extra = [{ addr, version: null, found: true }] – readGen67 reads it next to the known addresses and moves to
 * it when it is the one that follows the game.
 * → { found: hex | null, why?, windows, candidates } for the diagnostics.
 */
export function locateCtrParty(entry, mem, state, { team = null } = {}) {
  if (entry?.gen !== 6 || typeof mem?.watch !== 'function' || !state) return Promise.resolve(null);
  if (state.g67Search) return state.g67Search;
  const run = async () => {
    const hits = new Map(); // addr → party
    let windows = 0;
    let why = null;
    for (const round of ctrPartyPlan(entry)) {
      if (!(await mem.watch(round, 'partySearch'))) {
        why = 'noMemory';
        break;
      }
      for (const w of round) {
        const b = mem.read(w.addr, w.len);
        if (!b) continue; // (not mapped)
        windows++;
        for (const h of scanPartyObjects(w.addr, b, entry.gen)) hits.set(h.addr, h.party);
      }
    }
    await mem.watch([], 'partySearch');
    const owner = new Set((team || []).map(tidSid).filter(Boolean));
    const knownAt = new Set((entry.partyAddrs || []).map((a) => hex(a.addr ?? a)));
    const mine = [...hits].filter(([, p]) => !owner.size || p.some((m) => owner.has(tidSid(m))));
    // one at a known address only: that is where souldew reads already. One elsewhere (with or without one at a known
    // address – a copy left there that may stand still): read next to them, readGen67 decides by what changes.
    const other = mine.filter(([a]) => !knownAt.has(a));
    const done = { windows, candidates: hits.size };
    const name = (a) => `0x${a.toString(16).toUpperCase()}`;
    if (!other.length && mine.length) return { found: name(mine[0][0]), known: true, ...done };
    if (other.length !== 1) return { found: null, why: why || (other.length ? 'ambiguous' : 'none'), ...done };
    const [addr] = other[0];
    state.g67Extra = [{ addr: name(addr), version: null, found: true }];
    await mem.watch([{ addr, len: PARTY_BYTES, name: 'party' }], 'party');
    return { found: name(addr), ...(mine.length > 1 ? { alongside: mine.length - 1 } : {}), ...done };
  };
  state.g67Search = run().finally(() => {
    state.g67Search = null;
  });
  return state.g67Search;
}

const popcount = (n) => n.toString(2).replace(/0/g, '').length;

/**
 * The update version a running game plays, as addresses.json names it ('1.0', '1.5' …), from what souldew's 3DS player
 * says it started the game with (web/lib/ctrplayer.mjs update() – server/lib/ctrupdate.mjs prepareUpdate): null – no
 * update: '1.0'; one that isn't used (randomized, encrypted, failed): '1.0'; one installed that souldew knows as the
 * latest: its game version. An older update, or a player that doesn't say (undefined): null – not known.
 */
export function runningVersion(update) {
  if (update === undefined) return null;
  if (!update || update.installed === false) return '1.0';
  return update.installed && update.gameVersion ? String(update.gameVersion) : null;
}

/** Polls in a row the locked address holds no party while another one does, before the lock moves there. */
const LOCK_MISSES = 3;
/** Changes seen at another address while the locked one stood still, before the lock moves there. */
const STALE_CHANGES = 2;

/** A 32-bit FNV-1a of a party region: did the bytes change since the last poll? */
function regionSig(b) {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193);
  return h >>> 0;
}

/**
 * Read the party of a running Gen 6/7 game: every known update's address is read on each poll, and the one that holds
 * a party is locked for the session.
 *  - `state.ctrVersion` (runningVersion): the update souldew knows the game runs – its address is taken first.
 *  - The lock is checked on every poll: when its party stands still while another address's party changes (twice), it
 *    was a leftover copy and the lock moves; when it holds no party for a few polls while another address does, too
 *    (ticket #35). Each move goes into `state.g67Log` ({ from, to, why: 'update' | 'stale' | 'invalid' | 'grew' }) for
 *    the diagnostics.
 *  - A place that holds the locked team and more, and just changed, wins at once ('grew': a catch the locked place
 *    doesn't show). `state.g67Extra`: party objects found in the heap (locateCtrParty), read like the known addresses.
 * @returns {{party, badges?, version}|null}
 */
export function readGen67(entry, read, state = {}) {
  // (a party object found by locateCtrParty is read next to the known addresses)
  const addrs = [...(entry.partyAddrs || []), ...(state.g67Extra || [])];
  if (!addrs.length) return null;
  const seen = (state.g67Seen ||= {});
  const cands = addrs.map((a, i) => {
    const region = read(hex(a.addr ?? a), PARTY_BYTES);
    // (Bad Egg counters per address: the update's addresses are tried in turn)
    const bad = ((state.g67Bad ||= {})[i] ||= {});
    const party = partyFromRegion(region, entry.gen, bad);
    const sig = party ? regionSig(region.subarray(0, PARTY_BYTES)) : null;
    const changed = !!party && seen[i]?.sig != null && seen[i].sig !== sig;
    seen[i] = { sig };
    return { i, a, party, changed };
  });
  const valid = cands.filter((c) => c.party);
  if (!valid.length) return null;
  const pref = state.ctrVersion ? cands.find((c) => c.a.version === state.ctrVersion && c.party) : null;
  const lock = state.g67 != null ? cands[state.g67] : null;
  let pick;
  let why = null;
  if (lock?.party) {
    state.g67Miss = 0;
    const moving = valid.find((c) => c !== lock && c.changed);
    if (lock.changed) state.g67Stale = 0;
    else if (moving) state.g67Stale = (state.g67Stale || 0) + 1;
    // another place holds the locked team and more (a catch the locked place doesn't show): that one is the game's
    const keys = new Set(lock.party.map((m) => m.key));
    const grew = valid.find((c) => c !== lock && c.party.length > lock.party.length && lock.party.every((m) => c.party.some((x) => x.key === m.key)) && !c.party.every((m) => keys.has(m.key)));
    if (moving && state.g67Stale >= STALE_CHANGES) [pick, why] = [moving, 'stale'];
    else if (grew && grew.changed) [pick, why] = [grew, 'grew'];
    // (locked before the update was known – never back once a stale copy was left)
    else if (pref && pref !== lock && !state.g67Moved) [pick, why] = [pref, 'update'];
    else pick = lock;
  } else if (lock) {
    state.g67Miss = (state.g67Miss || 0) + 1;
    if (state.g67Miss < LOCK_MISSES) return null;
    [pick, why] = [pref || valid[0], 'invalid'];
  } else pick = pref || valid[0];
  if (lock && pick !== lock) {
    (state.g67Log ||= []).push({ from: lock.a.version || (lock.a.found ? 'found' : null), to: pick.a.version || (pick.a.found ? 'found' : null), why });
    if (why === 'stale' || why === 'grew') state.g67Moved = true;
    state.g67Stale = 0;
    state.g67Miss = 0;
    state.g67Len = 0;
    state.g67Shrink = null;
  }
  state.g67 = pick.i;
  const { party, a } = pick;
  // fewer Pokémon than last time: only once a second read agrees (a slot the game is rewriting ends the party early)
  const sig = party.map((m) => m.key).join();
  if (state.g67Len && party.length < state.g67Len && state.g67Shrink !== sig) {
    state.g67Shrink = sig;
    return null;
  }
  state.g67Shrink = null;
  state.g67Len = party.length;
  const res = { party, version: a.version || null };
  if (a.badges) {
    const b = read(hex(a.badges), 1);
    if (b) res.badges = popcount(b[0]);
  }
  return res;
}

// ---- battles ------------------------------------------------------------------------------------------------------
// The battle keeps its Pokémon unencrypted (Pokémon Stream Tool, Readek: Raw Pokemon Battle.mjs / Battle Pokemon.mjs –
// checked live in Omega Ruby: Torchic 17/20 and the wild Poochyena 10/15 at 0x08204200 / 0x08204444): blocks of 580
// bytes (Gen 6) / 816 (Gen 7) from the battle's base address, in each { u32 exp, u16 species +4, u16 max HP +6,
// u16 HP +8, u8 level +0x10, u8 battle slot +0x11 (0–5 the player's side, 12–17 the opponent's) }. Gen 6 has one base
// per battle kind (wild / trainer) and clears it after the battle; Gen 7 uses one base for both and leaves the last
// battle in memory, so two flags say whether a battle runs and whether it is a trainer's.
const BATTLE_BLOCKS = 12;
// The battler's form right now (a Mega Evolution, Primal Reversion, a form the battle changes – Pokémon Stream Tool,
// Readek: Raw Pokemon Battle.mjs formIndex, 1/2 for Mega X/Y): one byte at +0x14B (Gen 6) / +0x231 (Gen 7). Taken only
// when it names a form shared/forms.mjs knows of that species – shown, never counted.
const BATTLE_FORM = { 6: 0x14b, 7: 0x231 };

export function battleRegions(entry) {
  const b = entry?.battle;
  if (!b) return [];
  const len = (b.stride || 580) * (b.blocks || BATTLE_BLOCKS);
  const bases = [b.wild, b.trainer].filter(Boolean).map(hex).filter((v, i, a) => a.indexOf(v) === i);
  return [
    ...bases.map((addr) => ({ addr, len, name: 'battle' })),
    ...[b.inBattle, b.isTrainer].filter(Boolean).map((a) => ({ addr: hex(a), len: 1, name: 'battleFlag' })),
  ];
}

function battleMons(bytes, stride, gen, blocks = BATTLE_BLOCKS) {
  const out = [];
  if (!bytes) return out;
  for (let i = 0; i < blocks && (i + 1) * stride <= bytes.length; i++) {
    const o = i * stride;
    const species = u16(bytes, o + 4);
    const maxHp = u16(bytes, o + 6);
    const hp = u16(bytes, o + 8);
    const level = bytes[o + 0x10];
    const slot = bytes[o + 0x11];
    if (!species || species > (gen >= 7 ? 807 : 721) || !maxHp || maxHp > 999 || hp > maxHp || level < 1 || level > 100) continue;
    const f = BATTLE_FORM[gen] && BATTLE_FORM[gen] < stride ? bytes[o + BATTLE_FORM[gen]] : 0;
    const form = f > 0 && f < 32 && (formSpriteId(species, f) !== species || formKind(species, f, gen)) ? f : 0;
    out.push({ species, maxHp, hp, level, slot, block: i, ...(form ? { form } : {}) });
  }
  return out;
}

/**
 * The battle running now: { kind: 'wild' | 'trainer', enemy: { species, level, hp, maxHp }, active: { index, hp,
 * maxHp } | null } (the shape of shared/live/parse.mjs readLiveBattle) – or null outside battle. `party` maps the
 * player's battler to its party slot (species, level and max HP – the battle copy has no PID).
 */
export function readGen67Battle(entry, read, party = null) {
  const b = entry?.battle;
  if (!b) return null;
  const stride = b.stride || 580;
  // Gen 7 keeps the opponents' battlers after the player's 12 (Ultra Sun: a wild Yungoos at block 12, slot 12)
  const blocks = b.blocks || BATTLE_BLOCKS;
  let kind = null;
  let mons = [];
  if (b.inBattle) {
    // Gen 7: the flags decide, the one base holds wild and trainer battles alike
    const flag = read(hex(b.inBattle), 1);
    if (!flag || !flag[0]) return null;
    const trainer = b.isTrainer ? read(hex(b.isTrainer), 1) : null;
    kind = trainer && trainer[0] ? 'trainer' : 'wild';
    mons = battleMons(read(hex(b.wild || b.trainer), stride * blocks), stride, entry.gen, blocks);
  } else {
    for (const [k, base] of [['wild', b.wild], ['trainer', b.trainer]]) {
      if (!base) continue;
      const m = battleMons(read(hex(base), stride * blocks), stride, entry.gen, blocks);
      // a battle needs both sides
      if (m.some((x) => x.slot < 6) && m.some((x) => x.slot >= 12)) {
        kind = k;
        mons = m;
        break;
      }
    }
  }
  const mine = mons.filter((x) => x.slot < 6);
  const foes = mons.filter((x) => x.slot >= 12);
  if (!kind || !mine.length || !foes.length) return null;
  const me = mine[0];
  const foe = foes.find((x) => x.hp > 0) || foes[0];
  const index = party ? party.findIndex((p) => p.species === me.species && p.level === me.level && p.maxHp === me.maxHp) : -1;
  return {
    kind,
    enemy: { species: foe.species, level: foe.level, hp: foe.hp, maxHp: foe.maxHp, ...(foe.form ? { form: foe.form } : {}) },
    active: index >= 0 ? { index, hp: me.hp, maxHp: me.maxHp } : null,
  };
}


/**
 * Why no team is read (diagnostics – ticket #21: a team that wasn't found after reopening a game): per known update
 * address whether its memory arrived and what slot 0 holds there ('empty' – zeros, 'ok' – a Pokémon, 'checksum' – data
 * that fails its checksum – garbage, not a Pokémon; 'invalid' – passes it but isn't a party Pokémon, e.g. a blank slot
 * before the first Pokémon; 'unread' – no memory there), and the zone.
 * Nothing about the Pokémon itself.
 */
export function probeGen67(entry, read) {
  const addrs = (entry?.partyAddrs || []).map((a) => {
    const region = read(hex(a.addr ?? a), PARTY_BYTES);
    if (!region || region.length < PARTY_BYTES) return { version: a.version || null, slot0: 'unread' };
    const raw = slotBytes(region, 0);
    if (raw.every((b) => b === 0)) return { version: a.version || null, slot0: 'empty' };
    if (!decryptPK6(raw).checksumOk) return { version: a.version || null, slot0: 'checksum' };
    return { version: a.version || null, slot0: pk6Mon(raw, entry.gen) ? 'ok' : 'invalid' };
  });
  const z = entry?.zoneAddr ? read(hex(entry.zoneAddr), 2) : null;
  return { addrs, zone: z && z.length >= 2 ? u16(z, 0) : null };
}
