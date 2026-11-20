// Link battles (docs/MULTIPLAYER.md › "Battle results and wagers"): who won, read from the games themselves, and the money
// each game holds – what a wager is settled with.
//
// Every peer of a link session runs every seat's console, so every peer can read every seat's game (the link host's
// READ, the battery saves on FLUSH) and work out the same result on its own. The peers compare their results (a hash)
// and only a result every seat agrees on counts – for the log, the head-to-head record and a wager.
//
// Where each game keeps the outcome (checked against the recorded link battles in scripts/link-e2e.mjs):
//   Gen 1 (R/B/Y)   wBattleResult (0 won, 1 lost, 2 draw) once wIsInBattle drops back to 0 after a battle with
//                   wLinkState = LINK_STATE_BATTLING (4). The cartridge keeps no record of link battles.
//   Gen 2 (G/S/C)   the cartridge's link battle record: sLinkBattleStats (wins, losses, draws – u16 big-endian) in
//                   battery RAM bank 1, written by the game itself when the battle ends. Counted before and after.
//   Gen 3           gBattleOutcome (1 won, 2 lost, 3 drew; bit 7: the battle was forfeited) at the end of a battle with
//                   BATTLE_TYPE_LINK in gBattleTypeFlags. Also multi battles (2 vs 2, BATTLE_TYPE_MULTI), which write
//                   no link battle record into the save.
//   Gen 4           the game records (Platinum RECORD_LOCAL_LINK_BATTLE_WINS / _LOSSES 21, 22; HeartGold/SoulSilver
//                   GAME_STAT_LOCAL_LINK_BATTLE_WINS / _LOSSES / _DRAWS 22, 23, 24) in the save data the game keeps in
//                   RAM – Platinum and HG/SS encrypt them (pokeplatinum src/game_records.c, pokeheartgold
//                   src/game_stats.c: an LCRNG keystream seeded with the block's byte sum and a modifier, checked with
//                   that byte sum), Diamond/Pearl keep them plain (pokediamond GameStats). Counted before and after.
//   Gen 5           the trainer card records (PKHeX Record5: 68 u32 + 100 u16, the same LCRNG keystream seeded with
//                   the block's last word) in the save data in RAM. Counted before and after.

const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** The capability a souldew build announces in its link messages when it knows wagers (older 3.0 builds: none). */
export const WAGER_CAP = 'wager1';
/** The most money any of these games holds. */
export const MONEY_MAX = 999999;

// ---- which game a seat runs --------------------------------------------------------------------------------------

/** Where a console's cartridge header can be read on the bus (the link host's READ) – per link system. */
export function headerRange(system) {
  if (system === 'gba') return { addr: 0x080000a0, len: 0x20 };
  if (system === 'nds') return { addr: 0x027ffe00, len: 0x10 }; // (the header copy in main RAM)
  return { addr: 0x0134, len: 0x1c }; // gb / gbc
}

const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to)).replace(/\0+$/, '').trim();

/**
 * The game of a seat from its header bytes (headerRange): a key of GAMES, or null for a game souldew can't read link
 * battles in (another language, a hack that moved its memory – as the live tracker, by game code and title; a
 * randomized game keeps both).
 */
export function gameOf(system, bytes) {
  if (!bytes || bytes.length < headerRange(system).len) return null;
  if (system === 'gba') {
    const code = ascii(bytes, 0x0c, 0x10);
    if (/^AX[VP][ED]$/.test(code)) return 'rs';
    if (code === 'BPEE') return 'emerald';
    if (/^BP[RG]E$/.test(code)) return 'frlg';
    if (/^BP[RG][DFIS]$/.test(code)) return 'frlgEu';
    return null;
  }
  if (system === 'nds') return NDS_GAMES[ascii(bytes, 0x0c, 0x10)] || null;
  const title = ascii(bytes, 0, 0x10);
  const maker = ascii(bytes, 0x0b, 0x0f);
  if (title.startsWith('POKEMON RED') || title.startsWith('POKEMON BLUE')) return 'redblue';
  if (title.startsWith('POKEMON YELLOW')) return 'yellow';
  if (title.startsWith('POKEMON_GLD') || title.startsWith('POKEMON_SLV')) return maker === 'AAUE' || maker === 'AAXE' ? 'goldsilver' : null;
  if (title.startsWith('PM_CRYSTAL')) return ['BYTE', 'BYTU'].includes(maker) ? 'crystal' : null;
  return null;
}

// Gen 5's link battle records (Record5 u32 ids, measured in the recorded Union Room battle in Black: both players' 12
// – the link battles – went up by one, the winner's 13, the loser's 14)
const GEN5_WINS = 13;
const GEN5_LOSSES = 14;

// The DS games by game code (US/EU English releases: the other languages keep their static data elsewhere). Each one's
// link battles, wager and in-game save checked in a recorded session (docs/MULTIPLAYER.md › "Battle results and
// wagers"). White 2 (IRDO) isn't one yet: its save data, money and records read right in a running White 2, but no link
// battle of it was recorded – no results and no wagers until one is
const NDS_GAMES = { CPUE: 'platinum', ADAE: 'dp', APAE: 'dp', IPKE: 'hgss', IPGE: 'hgss', IRBO: 'black', IRAO: 'white', IREO: 'black2' };

/**
 * Per game: how its link battles end (`kind` 'events' – watched while the session runs; 'sram' / 'records' – counted
 * at its start and its end) and where its money is. Addresses from the pret symbol files (pokered, pokeyellow, pokegold,
 * pokecrystal, pokeruby(_de), pokeemerald, pokefirered), the money's layout as shared/live/cheats.mjs reads the bag.
 */
export const GAMES = {
  redblue: { gen: 1, kind: 'events', inBattle: 0xd057, link: 0xd12b, result: 0xcf0b, party: 0xd163, money: { at: 0xd347, enc: 'bcd' } },
  yellow: { gen: 1, kind: 'events', inBattle: 0xd056, link: 0xd12a, result: 0xcf0b, party: 0xd162, money: { at: 0xd346, enc: 'bcd' } },
  // (sLinkBattleStats: bank 1 0xB1BA / 0xB260 → save file offset 0x2000 + 0x11BA / 0x1260; wBattleMode, wLinkMode and
  // wScriptRunning say whether the player stands in the overworld)
  goldsilver: { gen: 2, kind: 'sram', stats: 0x31ba, idle: [0xd116, 0xd042, 0xd15f], party: 0xda22, money: { at: 0xd573, enc: 'be24' } },
  crystal: { gen: 2, kind: 'sram', stats: 0x3260, idle: [0xd22d, 0xc2dc, 0xd438], party: 0xdcd7, money: { at: 0xd84e, enc: 'be24' } },
  rs: { gen: 3, kind: 'events', outcome: 0x02024d26, flags: 0x020239f8, money: { sb1: 0x02025734, off: 0x490 } },
  emerald: { gen: 3, kind: 'events', outcome: 0x0202433a, flags: 0x02022fec, money: { sb1Ptr: 0x03005d8c, sb2Ptr: 0x03005d90, keyOff: 0xac, off: 0x490 } },
  frlg: { gen: 3, kind: 'events', outcome: 0x02023e8a, flags: 0x02022b4c, money: { sb1Ptr: 0x03005008, sb2Ptr: 0x0300500c, keyOff: 0xf20, off: 0x290 } },
  // the other-language FireRed/LeafGreen: EWRAM as the English game, the save block pointers 0xB0 lower (addresses.json)
  frlgEu: { gen: 3, kind: 'events', outcome: 0x02023e8a, flags: 0x02022b4c, money: { sb1Ptr: 0x03004f58, sb2Ptr: 0x03004f5c, keyOff: 0xf20, off: 0x290 } },
  // Platinum (US): the save data through sApplication (addresses.json saveDataPtrAddr); money in the trainer block
  // (general block +0x14, trainer +0x68, money +0x14 – PKHeX SAV4Pt), the game records at +0x61C4 (checked live)
  // (the overworld: the battle flag's overworld value, addresses.json platinum_us inBattle)
  platinum: { gen: 4, kind: 'records', savePtr: 0x02101d40, records: 0x61c4, layout: 'pt', trainerName: 0x7c, field: { addr: 0x0224a55a, value: 0x2800 }, money: { savePtr: 0x02101d40, off: 0x90 } },
  // Diamond/Pearl and HeartGold/SoulSilver (US) the same way – the save data's general block at +0x214 / +0x10 (the
  // party offsets of addresses.json), the trainer block +0x64 (money +0x14) and the records (PKHeX SAV4DP / SAV4HGSS
  // OFS_Record 0x5F08 / 0x4B3C) – Diamond's checked live: the trainer, ₽2,400 and plain records behind 0x02106FC0; the
  // overworld: anything but the battle flag's battle values (Pearl read 0x2000 on a route, Diamond 0x2800 in a Pokémon
  // Center)
  dp: { gen: 4, kind: 'records', savePtr: 0x02106fc0, records: 0x214 + 0x5f08, layout: 'dp', trainerName: 0x214 + 0x64, field: { addr: 0x0223bb38, battle: [0x2100, 0x2101] }, money: { savePtr: 0x02106fc0, off: 0x214 + 0x78 } },
  // (HeartGold ↔ SoulSilver recorded 19 Nov 2026: the records 22/23 and the money read live, the wager paid and saved)
  hgss: { gen: 4, kind: 'records', savePtr: 0x02111880, records: 0x10 + 0x4b3c, layout: 'hgss', trainerName: 0x10 + 0x64, field: { addr: 0x02246f48, battle: [0x2100, 0x2101] }, money: { savePtr: 0x02111880, off: 0x10 + 0x78 } },
  // Gen 5 (US/EU): the game's whole save data is in RAM in the battery save's own layout (PKHeX SAV5BW / SAV5B2W2 blocks):
  // its party block at +0x18E00 – so the save data sits 0x18E08 before the party the live tracker reads (addresses.json:
  // Black 0x022349B4, White +0x20; Black 2/White 2 behind the main pointer, +0x19728) –, the trainer block +0x19400 (its
  // name +4), the trainer card records +0x1DA00, the money the misc block's first word (+0x21200 / B2W2 +0x21100).
  // Found in Black's RAM (melonDS, the link host): the event block of the battery save byte for byte at 0x0223BCAC, the
  // party at 0x022349B4 – the save data at 0x0221BBAC. The overworld: anything but the battle flag's battle values.
  // Checked live in recorded sessions (19 Nov 2026): White's save data at 0x0221BBCC (its trainer, ₽4,000 = its save
  // file's), Black 2's behind the main pointer – each one's records 12/13/14, money and in-game save after a wager
  black: { gen: 5, kind: 'records', save: { at: 0x0221bbac }, records: 0x1da00, layout: 'gen5', trainerName: 0x19404, field: { addr: 0x021d0798, battle: [0x2100, 0x2101] }, money: { off: 0x21200 } },
  white: { gen: 5, kind: 'records', save: { at: 0x0221bbcc }, records: 0x1da00, layout: 'gen5', trainerName: 0x19404, field: { addr: 0x021d07b8, battle: [0x2100, 0x2101] }, money: { off: 0x21200 } },
  black2: { gen: 5, kind: 'records', save: { ptr: 0x02000024, add: 0x920 }, records: 0x1da00, layout: 'gen5', trainerName: 0x19404, field: { addr: 0x021b5138, battle: [0x2100, 0x2101] }, money: { off: 0x21100 } },
  // White 2: kept for the cheats' money (checked live in a running White 2) – its link results and wagers stay off
  // until a session is recorded: IRDO isn't in NDS_GAMES and wagerGame leaves it out
  white2: { gen: 5, kind: 'records', save: { ptr: 0x02000024, add: 0x920 }, records: 0x1da00, layout: 'gen5', trainerName: 0x19404, field: { addr: 0x021b5178, battle: [0x2100, 0x2101] }, money: { off: 0x21100 } },
};

/**
 * Where each game keeps its link battle counts inside its records block: the block's size, the encrypted part
 * [from, to) with the byte sum at `sum` and the modifier at `sum` + 2 (none: `plain`), and the record ids (u32 each).
 */
export const RECORDS = {
  pt: { size: 0x1bc, from: 4, to: 0x1b8, sum: 0x1b8, wins: 21, losses: 22 },
  hgss: { size: 0x1c0, from: 8, to: 0x1bc, sum: 0x1bc, wins: 22, losses: 23, draws: 24 },
  dp: { size: 0xb0, plain: true, wins: 21, losses: 22 }, // (measured: a Diamond ↔ Pearl battle – 20 counts the link battles)
  // Gen 5: 68 u32 + 100 u16 records encrypted from +4 to +0x1DC with the seed in the block's last word – no sum
  gen5: { size: 0x1e0, from: 4, to: 0x1dc, seed: 0x1dc, base: 4, wins: GEN5_WINS, losses: GEN5_LOSSES },
};

/** The entry ids of addresses.json (the live tracker's) → GAMES – for the play view, which knows its game that way. */
export function gameOfEntry(entry) {
  const id = String(entry?.id || '');
  // (a game found by its family or a search, or a Game Boy hack whose RAM moved: not where these addresses are)
  if (!id || id.includes('~') || entry.scan3 || entry.scanOnly || entry.wram?.delta) return null;
  if (/^(red|blue)_us$/.test(id)) return 'redblue';
  if (id === 'yellow_us') return 'yellow';
  if (/^(gold|silver)_us$/.test(id)) return 'goldsilver';
  if (id === 'crystal_us') return 'crystal';
  if (/^(ruby|sapphire)_(us|de)$/.test(id)) return 'rs';
  if (id === 'emerald_us') return 'emerald';
  if (/^(firered|leafgreen)_us$/.test(id)) return 'frlg';
  if (/^(firered|leafgreen)_eu$/.test(id)) return 'frlgEu';
  if (id === 'platinum_us') return 'platinum';
  if (/^(diamond|pearl)_us$/.test(id)) return 'dp';
  if (/^(heartgold|soulsilver)_us$/.test(id)) return 'hgss';
  if (/^(black|white|black2|white2)_us$/.test(id)) return id.slice(0, -3);
  return null;
}

/**
 * Can a run of this catalog game (manifest.game.id) battle for a wager? The games above in the languages their
 * addresses are known for (Emerald DE and Gen 1/2 in other languages keep their memory elsewhere; Platinum: US only).
 */
export const wagerGame = (id) => /^pokemon-(red|blue|yellow|gold|silver|crystal|ruby|sapphire|emerald|firered|leafgreen|diamond|pearl|platinum|heartgold|soulsilver|black|white|black-2)$/.test(String(id || ''))
  || /^pokemon-(ruby|sapphire|firered|leafgreen)-de$/.test(String(id || ''));

/** The battle formats a link battle can be (picked in the game; the invite names it): per system and seats. */
export function battleFormats(system, seats) {
  if (seats === 4) return system === 'gba' ? ['multi'] : []; // (a Gen 3 multi battle – four DS players in the Union Room may battle in pairs)
  if (seats !== 2) return [];
  return system === 'gba' || system === 'nds' ? ['single', 'double'] : ['single'];
}

// ---- outcomes ------------------------------------------------------------------------------------------------------

const ewram = (a) => a >= 0x02000000 && a < 0x02040000;
const mainRam = (a) => a >= 0x02000000 && a < 0x02400000;

/**
 * A records block (RECORDS[layout]) decoded – { wins, losses, draws } or null when it can't be trusted: an encrypted
 * block whose byte sum doesn't match, a plain one whose counts are out of the game's range.
 */
export function decodeRecords(block, layout = 'pt') {
  const r = RECORDS[layout];
  if (!r || !block || block.length < r.size) return null;
  const b = Uint8Array.from(block.subarray(0, r.size));
  if (r.seed != null) { // (Gen 5: the keystream from the block's last word, nothing to check it with)
    let x = u32le(b, r.seed);
    for (let o = r.from; o < r.to; o += 2) {
      x = (Math.imul(x, 0x41c64e6d) + 0x6073) >>> 0;
      const v = u16le(b, o) ^ (x >>> 16);
      b[o] = v & 0xff;
      b[o + 1] = v >> 8;
    }
  } else if (!r.plain) {
    const sum = u16le(b, r.sum);
    let x = (sum + (u16le(b, r.sum + 2) << 16)) >>> 0;
    let check = 0;
    for (let o = r.from; o < r.to; o += 2) {
      x = (Math.imul(x, 0x41c64e6d) + 0x6073) >>> 0;
      const v = u16le(b, o) ^ (x >>> 16);
      b[o] = v & 0xff;
      b[o + 1] = v >> 8;
      check += b[o] + b[o + 1];
    }
    if ((check & 0xffff) !== sum) return null;
  }
  const at = (id) => (r.base || 0) + id * 4; // (Gen 5's ids count from +4)
  const out = { wins: u32le(b, at(r.wins)), losses: u32le(b, at(r.losses)), draws: r.draws != null ? u32le(b, at(r.draws)) : 0 };
  // (the games cap every count at 999,999,999: more is no records block)
  return Object.values(out).every((v) => v <= 999999999) ? out : null;
}

/** Gen 4 (Platinum): the game records block (0x1BC bytes) decoded – { wins, losses } or null (decodeRecords). */
export function decodeRecords4(block) {
  const r = decodeRecords(block, 'pt');
  return r && { wins: r.wins, losses: r.losses };
}

/** Gen 2: the link battle totals from a battery save (wins, losses, draws), or null for a save too small to hold them. */
export function sramTotals(game, save) {
  const g = GAMES[game];
  if (g?.kind !== 'sram' || !save || save.length < g.stats + 6) return null;
  return { w: u16be(save, g.stats), l: u16be(save, g.stats + 2), d: u16be(save, g.stats + 4) };
}

/**
 * The counted kinds (Gen 2, Gen 4): the totals now – Gen 2 from the battery save, Gen 4 from RAM (`read(addr, len)`,
 * may answer with a Promise). null when they can't be read.
 */
export async function totals(game, { read = null, save = null } = {}) {
  const g = GAMES[game];
  if (g?.kind === 'sram') return sramTotals(game, save);
  if (g?.kind !== 'records' || !read) return null;
  const base = await saveBase(g, read);
  if (!base) return null;
  // (before Continue the save data is still blank – no trainer name yet: not the save's counts)
  const name = await read(base + g.trainerName, 2);
  if (!name || !u16le(name, 0) || u16le(name, 0) === 0xffff) return null;
  const r = decodeRecords(await read(base + g.records, RECORDS[g.layout].size), g.layout);
  return r ? { w: r.wins, l: r.losses, d: r.draws } : null;
}

/** Where a DS game's save data is in RAM (Gen 4: behind its pointer; Gen 5: fixed, or behind the main pointer), or 0. */
async function saveBase(g, read) {
  let base = 0;
  if (g.savePtr) {
    const p = await read(g.savePtr, 4);
    base = p ? u32le(p, 0) : 0;
  } else if (g.save?.at) base = g.save.at;
  else if (g.save?.ptr) {
    const p = await read(g.save.ptr, 4);
    base = p && u32le(p, 0) ? 0x02000000 + (u32le(p, 0) & 0xffffff) + g.save.add : 0; // (masked like the party pointer)
  }
  return base && mainRam(base) ? base : 0;
}

/** What one seat's counts went up by between two totals – null when they can't be compared (a reset, a missing read). */
export function countsBetween(a, b) {
  if (!a || !b) return null;
  const c = { w: b.w - a.w, l: b.l - a.l, d: b.d - a.d };
  return c.w < 0 || c.l < 0 || c.d < 0 || c.w + c.l + c.d > 50 ? null : c;
}

/**
 * The battles one seat's game finished while it was watched (Gen 1, Gen 3): feed it a reading per poll – it counts
 * each link battle once, when its outcome appears. A reading: Gen 1 { inBattle, link, result }, Gen 3 { outcome, flags }.
 */
export class BattleWatch {
  constructor(game) {
    this.game = game;
    this.g = GAMES[game];
    this.counts = { w: 0, l: 0, d: 0 };
    this.multi = false;
    this.double = false;
    this.active = false;
  }

  /** The bus ranges a reading needs. */
  ranges() {
    const g = this.g;
    if (g.gen === 1) return [{ addr: g.result, len: 1 }, { addr: g.inBattle, len: 1 }, { addr: g.link, len: 1 }];
    return [{ addr: g.outcome, len: 1 }, { addr: g.flags, len: 4 }];
  }

  /** One reading from the bytes of ranges() (in their order); null bytes (a read that failed) change nothing. */
  feed(parts) {
    if (!parts || parts.some((p) => !p)) return null;
    const g = this.g;
    if (g.gen === 1) return this.step({ result: parts[0][0], inBattle: parts[1][0], link: parts[2][0] });
    return this.step({ outcome: parts[0][0], flags: u32le(parts[1], 0) });
  }

  /** One reading: the outcome of a battle that just ended ('win' | 'lose' | 'draw'), else null. */
  step(r) {
    const g = this.g;
    let out = null;
    if (g.gen === 1) {
      // in a link battle: the Colosseum's battle state; over: the result the game shows ("YOU WIN" / "YOU LOSE" / "DRAW")
      if (r.inBattle !== 0 && r.link === 4) this.active = true;
      else if (this.active && r.inBattle === 0) {
        this.active = false;
        out = ['win', 'lose', 'draw'][r.result] || null;
      }
    } else {
      const o = r.outcome & 0x7f; // (bit 7: somebody forfeited – the outcome stands)
      if ((r.flags & 2) && o === 0) {
        this.active = true; // a link battle is on (gBattleOutcome is cleared when a battle starts)
        this.multi ||= !!(r.flags & 0x40);
        this.double ||= !!(r.flags & 1);
      } else if (this.active && o >= 1 && o <= 3) {
        this.active = false;
        out = ['win', 'lose', 'draw'][o - 1];
      }
    }
    if (out) this.counts[out[0]]++;
    return out;
  }
}

// ---- the result of a session ---------------------------------------------------------------------------------------

/**
 * What a session's battles came to, from every seat's counts { slot: { w, l, d } }: winners, losers (slots) or a draw –
 * or `valid: false` when the counts don't fit together (they come from one deterministic emulation, so that means a
 * misread, and nothing is settled). `battles`: how many were fought. Two seats: who won more of the battles; four seats
 * (Gen 3 multi battles, `multi`): two winners against two losers, every seat's counts mirrored by the other team's.
 */
export function summarize(seats, per, { multi = false } = {}) {
  const c = (s) => per?.[s] || null;
  if (!Array.isArray(seats) || !seats.every(c)) return { valid: false };
  const n = (s) => c(s).w + c(s).l + c(s).d;
  const battles = Math.max(...seats.map(n));
  const none = { valid: true, battles: 0, winners: [], losers: [], draw: false };
  if (seats.length === 2) {
    const [a, b] = seats.map(c);
    if (a.w !== b.l || a.l !== b.w || a.d !== b.d) return { valid: false };
    if (!battles) return none;
    if (a.w === a.l) return { valid: true, battles, winners: [], losers: [], draw: true, score: [a.w, a.l] };
    const [win, lose] = a.w > a.l ? seats : [seats[1], seats[0]];
    return { valid: true, battles, winners: [win], losers: [lose], draw: false, score: [Math.max(a.w, a.l), Math.min(a.w, a.l)] };
  }
  if (seats.length === 4 && multi) {
    if (!battles) return none;
    if (!seats.every((s) => n(s) === battles)) return { valid: false };
    const up = seats.filter((s) => c(s).w > c(s).l);
    const down = seats.filter((s) => c(s).l > c(s).w);
    const even = seats.filter((s) => c(s).w === c(s).l);
    if (even.length === 4) return { valid: true, battles, winners: [], losers: [], draw: true, score: [c(seats[0]).w, c(seats[0]).l] };
    if (up.length !== 2 || down.length !== 2) return { valid: false };
    const [u0, u1] = up.map(c);
    const [d0, d1] = down.map(c);
    if (u0.w !== u1.w || u0.l !== u1.l || d0.w !== u0.l || d0.l !== u0.w || d1.w !== d0.w || d1.l !== d0.l) return { valid: false };
    return { valid: true, battles, winners: up, losers: down, draw: false, multi: true, score: [u0.w, u0.l] };
  }
  return { valid: false }; // (three seats, or four without a multi battle: who fought whom isn't known)
}

/** JSON with sorted keys (every peer must hash the same text). */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** The hash two peers compare: FNV-1a (64 bit, hex) over the session, its seats, every seat's counts and the wager. */
export function resultHash({ sid, seats, per, wager = 0, multi = false }) {
  const text = canonical({ sid, seats, per, wager, multi: !!multi });
  let h = 0xcbf29ce484222325n;
  for (const ch of new TextEncoder().encode(text)) h = BigInt.asUintN(64, (h ^ BigInt(ch)) * 0x100000001b3n);
  return h.toString(16).padStart(16, '0');
}

/**
 * The money that moves: every loser pays the wager to a winner (two seats: the loser to the winner; a multi battle:
 * each of the losing team pays one of the winning team – the pot split per team). [{ from, to, amount }] – none for a
 * draw, no battle or no wager.
 */
export function payments(summary, wager) {
  const amount = Math.max(0, Math.min(MONEY_MAX, Math.floor(Number(wager) || 0)));
  if (!amount || !summary?.valid || summary.draw || !summary.winners?.length) return [];
  const win = [...summary.winners].sort();
  const lose = [...summary.losers].sort();
  return lose.map((from, i) => ({ from, to: win[i % win.length], amount }));
}

/** What `slot`'s money changes by: + for a winner, − for a loser. */
export const deltaOf = (pays, slot) => pays.reduce((n, p) => n + (p.to === slot ? p.amount : 0) - (p.from === slot ? p.amount : 0), 0);

// ---- money -----------------------------------------------------------------------------------------------------------

/** Gen 1 money: 3 bytes BCD, big-endian (₽999999 = 99 99 99). */
export function bcdDecode(b) {
  let v = 0;
  for (let i = 0; i < 3; i++) {
    const hi = b[i] >> 4;
    const lo = b[i] & 15;
    if (hi > 9 || lo > 9) return null;
    v = v * 100 + hi * 10 + lo;
  }
  return v;
}
export function bcdEncode(v) {
  const s = String(Math.max(0, Math.min(MONEY_MAX, Math.floor(v)))).padStart(6, '0');
  return [0, 2, 4].map((i) => (Number(s[i]) << 4) | Number(s[i + 1]));
}
/** Gen 2 money: 3 bytes binary, big-endian. */
export const be24Decode = (b) => (b[0] << 16) | (b[1] << 8) | b[2];
export const be24Encode = (v) => [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
/** Gen 3 money: a u32 XORed with SaveBlock2's encryption key (Emerald, FireRed/LeafGreen; Ruby/Sapphire: key 0). */
export const xorDecode = (b, key) => (u32le(b, 0) ^ key) >>> 0;
export const xorEncode = (v, key) => { const x = (v ^ key) >>> 0; return [x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, x >>> 24]; };

/**
 * Where `game`'s money is right now: { addr, value, encode(v) → bytes } – or null when the memory doesn't look like it
 * (a pointer outside the game's RAM, a value that isn't a sum of money). `read(addr, len)` may answer with a Promise.
 */
export async function locateMoney(game, read) {
  const m = GAMES[game]?.money;
  if (!m) return null;
  const g = GAMES[game];
  if (g.gen <= 2) {
    const b = await read(m.at, 3);
    if (!b) return null;
    const value = m.enc === 'bcd' ? bcdDecode(b) : be24Decode(b);
    if (value === null || value > MONEY_MAX) return null;
    return { addr: m.at, value, encode: m.enc === 'bcd' ? bcdEncode : be24Encode };
  }
  if (g.gen === 3) {
    let sb1 = m.sb1 || 0;
    let key = 0;
    if (m.sb1Ptr) {
      const p1 = await read(m.sb1Ptr, 4);
      const p2 = await read(m.sb2Ptr, 4);
      if (!p1 || !p2) return null;
      sb1 = u32le(p1, 0);
      const sb2 = u32le(p2, 0);
      if (!ewram(sb1) || !ewram(sb2)) return null;
      const k = await read(sb2 + m.keyOff, 4);
      if (!k) return null;
      key = u32le(k, 0);
    }
    const b = await read(sb1 + m.off, 4);
    if (!b) return null;
    const value = xorDecode(b, key);
    if (value > MONEY_MAX) return null;
    return { addr: sb1 + m.off, value, key, encode: (v) => xorEncode(v, key) };
  }
  // Gen 4/5: the save data's place; its game records must decode (the pointer really is the save data)
  const base = await saveBase(g, read);
  if (!base) return null;
  // (Gen 5's records carry no sum to check: there the trainer alone says it)
  if (g.records && RECORDS[g.layout].seed == null && !decodeRecords(await read(base + g.records, RECORDS[g.layout].size), g.layout)) return null;
  if (g.trainerName) { // (and a trainer: Diamond/Pearl's plain records prove nothing about the pointer by themselves)
    const name = await read(base + g.trainerName, 2);
    if (!name || !u16le(name, 0) || u16le(name, 0) === 0xffff) return null;
  }
  const b = await read(base + m.off, 4);
  if (!b) return null;
  const value = u32le(b, 0);
  if (value > MONEY_MAX) return null;
  return { addr: base + m.off, value, encode: (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24] };
}

/** The money `game` holds now, or null. */
export async function readMoney(game, read) {
  return (await locateMoney(game, read))?.value ?? null;
}

/**
 * Change `game`'s money by `delta` (clamped to 0 … ₽999,999) and read it back. `write(addr, bytes)` writes between two
 * frames (the fast player's cheat path). { ok, before, after } | { error: 'notFound' | 'write' }.
 */
export async function addMoney(game, read, write, delta) {
  const at = await locateMoney(game, read);
  if (!at) return { error: 'notFound' };
  const after = Math.max(0, Math.min(MONEY_MAX, at.value + Math.round(delta)));
  const bytes = Uint8Array.from(at.encode(after));
  let r;
  try {
    r = await write(at.addr, bytes);
  } catch {
    r = false;
  }
  if (r === false || (r && typeof r === 'object' && r.ok === false)) return { error: 'write' };
  const got = await read(at.addr, bytes.length);
  if (!got || [...bytes].some((x, i) => got[i] !== x)) return { error: 'write' };
  return { ok: true, before: at.value, after };
}

/**
 * Is the player standing in the overworld – no battle, no link, no menu or script holding them (where the game says
 * so)? Money only goes in then. Gen 3 asks the Shared World's reader (`cam`: shared/world.mjs readCamera's result).
 */
/**
 * Gen 3: does the Shared World's camera reading (shared/world.mjs readCamera) show the player standing in the overworld,
 * nothing holding them – no battle, no fade, no script, menu or text (locked), no help screen, no FR/LG quest-log replay?
 * Emerald and FireRed/LeafGreen move their save blocks on a map change (behind a fade): money or a bag written then
 * would land where the game no longer reads. Wagers (fieldIdle) and cheats (shared/live/cheats.mjs) both ask this.
 */
// (`field` false: another main callback than the overworld's – Emerald and FR/LG load the save at boot, so the title
// screen and the Continue menu read like a player standing still; a bag or money written there is gone with New Game)
export const camIdle = (cam) => !!cam && cam.field !== false && !cam.battle && !cam.locked && !cam.help && !cam.replay && !cam.fade;

export async function fieldIdle(game, read, { cam = undefined } = {}) {
  const g = GAMES[game];
  if (!g) return false;
  // (Gen 1/2: those flags are 0 on the title screen too, before Continue loads the save – the money there is
  // overwritten a moment later. A loaded game has a team: wPartyCount 1–6)
  const loaded = async () => {
    const p = await read(g.party, 1);
    return !!p && p[0] >= 1 && p[0] <= 6;
  };
  if (g.gen === 1) {
    const [b, l] = [await read(g.inBattle, 1), await read(g.link, 1)];
    return !!b && !!l && b[0] === 0 && l[0] === 0 && (await loaded());
  }
  if (g.gen === 2) {
    const v = await Promise.all(g.idle.map((a) => read(a, 1)));
    return v.every((b) => b && b[0] === 0) && (await loaded());
  }
  if (g.gen === 3) return camIdle(cam);
  const f = await read(g.field.addr, 2);
  if (!f) return false;
  if (g.field.battle) return !g.field.battle.includes(u16le(f, 0)) && !!(await saveBase(g, read)); // (no battle)
  return u16le(f, 0) === g.field.value;
}

/**
 * Does the game itself say it is linked – the Cable Club's mode, set when the players sit down and cleared only when they
 * walk out (Gen 1 wLinkState, Gen 2 wLinkMode, Gen 3 a battle of BATTLE_TYPE_LINK)? A game whose link session ended
 * while it was still in a link room goes on alone in that mode: in the Gen 2 Colosseum it even starts the next battle
 * against the partner's team it already received. Nothing it shows then is the run's (no deaths, no catches, no
 * party) – as during the session. Synchronous `read` (the fast player's mirror); false for the games without a table.
 */
export function gameLinked(game, read, { inBattle = false } = {}) {
  const g = GAMES[game];
  if (!g) return false;
  const b = (a) => read(a, 1)?.[0] ?? 0;
  if (g.gen === 1) return b(g.link) !== 0;
  if (g.gen === 2) return b(g.idle[1]) !== 0;
  if (g.gen === 3) { // (the flags stay from the last battle: only a battle on screen counts)
    const f = read(g.flags, 4);
    return !!inBattle && !!f && (u32le(f, 0) & 2) !== 0;
  }
  return false;
}

/** "₽2,000" – the games' own sign, the number grouped for `lang`. */
export const moneyText = (v, lang = 'en') => `₽${Math.round(v || 0).toLocaleString(lang === 'de' ? 'de-DE' : lang)}`;
