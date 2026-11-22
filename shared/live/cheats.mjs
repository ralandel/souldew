// Cheats that write into the running game's memory: items into the bag (Rare Candies, Max Repels, Poké Balls, healing
// items – CHEATS) and money.
//
// Why RAM and not cheat codes: Action Replay / GameShark codes are made for one version and region each, and the
// cores in this build differ in what they accept. Writing the item where the game keeps its bag works the same for
// every build of a supported game, randomized or not (the randomizer doesn't move the bag), and every write is
// checked first: the bag must look exactly like a bag (counts, terminators, item ids and quantities in range) or
// nothing is written. Layouts: research/live_ram.md §7 (pret disassemblies, PKHeX, checked against a HeartGold RAM
// image). Works on any memory source with read(addr, len) / write(addr, bytes) on console bus addresses – the 3DS
// player's write answers later (a Promise: the native host writes between two frames), the others right away.

import { GAMES, gameOfEntry, locateMoney, camIdle } from '../linkbattle.mjs';
import { worldTable, readCamera } from '../world.mjs';
import { cheatGroups } from '../rules.mjs';

export { CHEAT_GROUPS } from '../rules.mjs';

const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const le16 = (v) => [v & 0xff, (v >> 8) & 0xff];

/** Rare Candy's item id per generation (pret item constants; PokeAPI game_indices agree). */
export const RARE_CANDY = { 1: 0x28, 2: 0x20, 3: 68, 4: 50, 5: 50, 6: 50, 7: 50 };
/**
 * Max Repel's item id per generation: pokered MAX_REPEL $39, pokecrystal/pokegold $2B, pokeemerald/pokefirered
 * ITEM_MAX_REPEL 84, pokeheartgold ITEM_MAX_REPEL 77 – the same number up to Gen 7 (PokeAPI game_indices agree).
 * Unlike Rare Candy it lives in the Items pocket in every generation.
 */
export const MAX_REPEL = { 1: 0x39, 2: 0x2b, 3: 84, 4: 77, 5: 77, 6: 77, 7: 77 };

/** Poké Ball's item id per generation (pret item constants: Gen 1 POKE_BALL 0x04, Gen 2 0x05, Gen 3–7 4). */
export const POKE_BALL = { 1: 0x04, 2: 0x05, 3: 4, 4: 4, 5: 4, 6: 4, 7: 4 };
/** Master Ball and Ultra Ball: items 1 and 2 in every generation (pret, PokeAPI game_indices). */
export const MASTER_BALL = { 1: 0x01, 2: 0x01, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1 };
export const ULTRA_BALL = { 1: 0x02, 2: 0x02, 3: 2, 4: 2, 5: 2, 6: 2, 7: 2 };
/**
 * Full Restore, Revive and Max Revive: pokered $10 / $35 / $36, pokecrystal $0E / $27 / $28, pokeemerald 19 / 24 / 25,
 * Gen 4–7 23 / 28 / 29 (PokeAPI game_indices agree; Gen 1/2 as shared/giftitems.mjs GB_GIFT_ITEMS). Medicine from Gen 4 on.
 */
export const FULL_RESTORE = { 1: 0x10, 2: 0x0e, 3: 19, 4: 23, 5: 23, 6: 23, 7: 23 };
export const REVIVE = { 1: 0x35, 2: 0x27, 3: 24, 4: 28, 5: 28, 6: 28, 7: 28 };
export const MAX_REVIVE = { 1: 0x36, 2: 0x28, 3: 25, 4: 29, 5: 29, 6: 29, 7: 29 };

/**
 * The cheats the play screen offers, in its order: the item per generation, the pocket it goes into where the game has
 * several ('balls': the Poké Ball pocket where there is one – Gen 2–4 –, else with the items; null: Medicine from Gen 4
 * on, else the Items pocket), how many one use adds unless the player picks an amount (CHEAT_AMOUNTS), the item's
 * PokeAPI identifier (its name in the app's language: web/lib/data.mjs itemNameByKey; `en`: the English one, for an
 * app that can't look it up – an older partner's log), and the group a run's rules
 * allow or not (shared/rules.mjs cheatSet). Rare Candies (99: enough for any level cap) and Max Repels (ten: 2500
 * steps) came first and are offered wherever souldew knows the bag; every other cheat (`checked`) only in the games
 * where it was checked in the running game (checkedLive) – elsewhere it is left out rather than written untried.
 * `money`: the money, added or set to the most the game holds (moneyCheat).
 */
export const CHEATS = {
  rareCandy: { items: RARE_CANDY, pocket: null, count: 99, key: 'rare-candy', en: 'Rare Candy', group: 'rareCandy' },
  maxRepel: { items: MAX_REPEL, pocket: 'items', count: 10, key: 'max-repel', en: 'Max Repel', group: 'maxRepel' },
  masterBall: { items: MASTER_BALL, pocket: 'balls', count: 1, key: 'master-ball', en: 'Master Ball', group: 'masterBall', checked: true },
  ultraBall: { items: ULTRA_BALL, pocket: 'balls', count: 10, key: 'ultra-ball', en: 'Ultra Ball', group: 'balls', checked: true },
  pokeBall: { items: POKE_BALL, pocket: 'balls', count: 10, key: 'poke-ball', en: 'Poké Ball', group: 'balls', checked: true },
  fullRestore: { items: FULL_RESTORE, pocket: null, count: 10, key: 'full-restore', en: 'Full Restore', group: 'healing', checked: true },
  revive: { items: REVIVE, pocket: null, count: 10, key: 'revive', en: 'Revive', group: 'healing', checked: true },
  maxRevive: { items: MAX_REVIVE, pocket: null, count: 10, key: 'max-revive', en: 'Max Revive', group: 'healing', checked: true },
  money: { money: true, group: 'money', checked: true },
};

/** Does a run with these rules (shared/rules.mjs cheats, cheatSet) allow this cheat? */
export const cheatAllowed = (rules, id) => !!CHEATS[id] && cheatGroups(rules).includes(CHEATS[id].group);

/** How many of an item one use adds – the play screen's choice. */
export const CHEAT_AMOUNTS = [1, 10, 99];

/** The money cheat's steps (₽ added) – and 'max', the most any of these games holds. */
export const MONEY_STEPS = [1000, 10000, 100000, 'max'];
export const MONEY_MAX = 999999;

// Gen 1/2: a count byte, then (id, quantity) pairs closed by 0xFF. Bag 20 slots, 99 per slot (pokered
// constants/menu_constants.asm BAG_ITEM_CAPACITY, pokecrystal constants/item_data_constants.asm MAX_ITEMS / MAX_ITEM_STACK).
// `money` (Gen 1, BCD) and `keyItems` (Gen 2: count + ids + 0xFF) follow right after – checked as well.
const GB = {
  red_us: { addr: 0xd31d, money: 0xd347 }, // pokered.sym wNumBagItems, wPlayerMoney
  blue_us: { addr: 0xd31d, money: 0xd347 },
  yellow_us: { addr: 0xd31c, money: 0xd346 }, // pokeyellow.sym
  gold_us: { addr: 0xd5b7, keyItems: 0xd5e1 }, // pokegold.sym wNumItems, wNumKeyItems (Silver identical)
  silver_us: { addr: 0xd5b7, keyItems: 0xd5e1 },
  crystal_us: { addr: 0xd892, keyItems: 0xd8bc }, // pokecrystal.sym
};

// Gen 3: SaveBlock1 holds the pockets as { u16 id, u16 quantity } (include/global.h). Ruby/Sapphire keep it at a fixed
// address and the quantities plain; Emerald and FireRed/LeafGreen move the save blocks around (pointers in IWRAM) and
// XOR every bag quantity with the low half of SaveBlock2's encryptionKey (src/item.c GetBagItemQuantity), money with
// all of it.
const GBA = {
  ruby: { sb1: 0x02025734, items: [0x560, 20], balls: [0x600, 16], money: 0x490, maxId: 348 }, // pokeruby(_de).sym gSaveBlock1
  emerald: { sb1Ptr: 0x03005d8c, sb2Ptr: 0x03005d90, keyOff: 0xac, items: [0x560, 30], balls: [0x650, 16], money: 0x490, maxId: 376 },
  firered: { sb1Ptr: 0x03005008, sb2Ptr: 0x0300500c, keyOff: 0xf20, items: [0x310, 42], balls: [0x430, 13], money: 0x290, maxId: 374 },
};

// Gen 4/5: the bag is part of the save data the game keeps in RAM, pockets of { u16 id, u16 quantity }, 999 per slot.
// Rare Candy sits in the Medicine pocket. Gen 4: offsets in the general block (PKHeX PlayerBag4*.cs), the general
// block at SaveData + `general` (the same as for the badges and boxes in parse.mjs). Gen 5: the inventory block is
// 0xA00 before the party block, like in the .sav (PKHeX SaveBlockAccessor5*.cs: 0x18400 / 0x18E00).
const TM4 = (id) => id >= 328 && id <= 427;
const TM5 = (id) => TM4(id) || (id >= 618 && id <= 620);
const DS = {
  hgss: { gen: 4, general: 0x10, trainer: [0x64, 0x78], bag: 0x644, maxId: 536, tm: TM4, pockets: { items: [0x000, 165], key: [0x294, 50], tm: [0x35c, 101], medicine: [0x520, 40], balls: [0x6c0, 24] } },
  platinum: { gen: 4, general: 0x14, trainer: [0x68, 0x7c], bag: 0x630, maxId: 536, tm: TM4, pockets: { items: [0x000, 165], key: [0x294, 50], tm: [0x35c, 100], medicine: [0x51c, 40], balls: [0x6bc, 15] } },
  dp: { gen: 4, general: 0x214, trainer: [0x64, 0x78], bag: 0x624, maxId: 536, tm: TM4, pockets: { items: [0x000, 165], key: [0x294, 50], tm: [0x35c, 100], medicine: [0x51c, 40], balls: [0x6bc, 15] } },
  bw: { gen: 5, fromParty: -0xa00, maxId: 638, tm: TM5, pockets: { items: [0x000, 310], key: [0x4d8, 83], tm: [0x624, 109], medicine: [0x7d8, 48] } },
};

// Gen 6/7 (3DS): the bag is the save data's MyItem block, which the game keeps in its heap at a fixed address per
// game and update (addresses.json partyAddrs[].bag – Multi-PokemonFramework (semaj14, GPL-3) writes the pockets there
// for X/Y 1.5, ORAS 1.4, Sun/Moon 1.2 and Ultra Sun/Moon 1.2; the X/Y and ORAS 1.0 addresses moved by the same distance
// as the party and the badges; Sun 1.0 and Ultra Moon 1.0 checked live: the same address as 1.2). Pockets as in PKHeX
// PlayerBag6XY / 6AO / 7SM / 7USUM (offsets in the block, slots). Gen 6 slots are { u16 id, u16 count }; Gen 7 slots one
// u32: id (bits 0–9), count (10–19), the place in the Free Space pocket (20–29, 0: not in it), NEW (30), bit 31 unused
// (PKHeX InventoryItem7). 999 per slot. Rare Candy goes into Medicine.
// Sun/Moon and Ultra Sun/Moon keep a table of pointers to the pockets right behind the block (seen live in Sun 1.0 and
// Ultra Moon 1.0, from the intro on, in the order Medicine, Items, TMs, Berries, Key Items, Z-Crystals(, Rotom Powers)) –
// when it is there it has to point at exactly these pockets; either way every slot has to look like an item of its
// pocket. The table also tells an empty bag (a new game has nothing in it until well after the starter) from memory that
// is merely all zeros, and it is what the search finds when the bag isn't at a known address (`table: true`: the game
// is known to have it – its bag is searched for by the table alone).
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const MED67 = new Set([...range(17, 54), 65, 66, 67, 134, 504, ...range(565, 571), 591, 645, 708, 709, 852]); // PKHeX ItemStorage6XY/6AO/7SM Medicine
const TM67 = new Set([...range(328, 425), 618, 619, 620, ...range(690, 694), 737]); // TMs, HMs (ORAS: 425, 737)
const CTR = {
  xy: { gen: 6, maxId: 717, size: 0xb88, pockets: { items: [0x000, 400], key: [0x640, 96], tm: [0x7c0, 106], medicine: [0x968, 64], berries: [0xa68, 72] } },
  oras: { gen: 6, maxId: 775, size: 0xb90, pockets: { items: [0x000, 400], key: [0x640, 96], tm: [0x7c0, 108], medicine: [0x970, 64], berries: [0xa70, 72] } },
  sm: { gen: 7, maxId: 920, size: 0xde0, table: true, pockets: { items: [0x000, 430], key: [0x6b8, 184], tm: [0x998, 108], medicine: [0xb48, 64], berries: [0xc48, 72], z: [0xd68, 30] } },
  usum: { gen: 7, maxId: 959, size: 0xe28, table: true, pockets: { items: [0x000, 427], key: [0x6ac, 198], tm: [0x9c4, 108], medicine: [0xb74, 60], berries: [0xc64, 67], z: [0xd70, 35], battle: [0xdfc, 11] } },
};
const ctrLen = (L) => L.size + Object.keys(L.pockets).length * 4; // the block and the pointer table behind it
const hex = (v) => `0x${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
/**
 * The bag's addresses to try for a 3DS game: where this session found it (state.ctrBag – the search, see
 * locateCtrBag), the update the party was found at (state.g67), then the other updates'.
 */
function ctrBags(entry, state) {
  const all = (entry.partyAddrs || []).map((a) => (a?.bag ? parseInt(a.bag, 16) : 0));
  const first = [state?.ctrBag?.base || 0, state?.g67 != null ? all[state.g67] || 0 : 0];
  return [...new Set([...first, ...all].filter(Boolean))];
}
/** The memory a 3DS game's bag needs (the block and the pointer table behind it) – for the 3DS player's watch list. */
export function cheatRegions(entry) {
  const L = layoutOf(entry);
  if (L?.kind !== 'ctr') return [];
  return ctrBags(entry, null).map((addr) => ({ addr, len: ctrLen(L), name: 'bag' }));
}

function layoutOf(entry) {
  if (!entry) return null;
  if (entry.gen >= 6) return CTR[entry.id] && entry.gen === CTR[entry.id].gen ? { kind: 'ctr', ...CTR[entry.id] } : null;
  const id = String(entry.id || '').replace(/~.*$/, ''); // scanned DS relatives: "heartgold_us~IPKD"
  if (entry.gen <= 2) {
    if (!GB[id]) return null;
    // a Game Boy hack whose WRAMX bank moved (shared/live/romwram.mjs: the entry carries the shift) keeps its bag there too
    const d = entry.wram && Object.keys(entry.wram.moved || {}).some((a) => /^0xD/i.test(a)) ? entry.wram.delta : 0;
    const L = { kind: 'gb', ...GB[id] };
    for (const k of ['addr', 'money', 'keyItems']) if (L[k] >= 0xd000 && L[k] < 0xe000) L[k] += d;
    return L;
  }
  if (entry.gen === 3) {
    const key = /^(ruby|sapphire)_/.test(id) ? 'ruby' : /^emerald_/.test(id) ? 'emerald' : /^(firered|leafgreen)_/.test(id) ? 'firered' : null;
    if (!key) return null;
    // a hack whose team is searched for (parse.mjs expandedEntry): only one that kept the base game's save data and item
    // numbers (`retail3` – Modern Emerald) has the bag where the base game keeps it, its save block pointers wherever
    // the place reader found them (gbaBag: state.sb1PtrAddr). Run & Bun, pokeemerald-expansion and Complete FireRed
    // Upgrade number their items their own way or moved the bag: no cheats there (the ROM test matrix passes the save
    // block pointers it measured, `saveBlockPtrs`, to give Poké Balls in Run & Bun).
    if (entry.scan3 && !entry.saveBlockPtrs) return entry.retail3 && key !== 'ruby' ? { kind: 'gba', ...GBA[key], found: true, ...(entry.items3Max ? { maxId: entry.items3Max } : {}) } : null;
    // the other-language FireRed/LeafGreen keep the save block pointers elsewhere in IWRAM (addresses.json saveBlockPtrs)
    const P = entry.saveBlockPtrs;
    const ptrs = P ? { sb1Ptr: parseInt(P.sb1, 16), sb2Ptr: parseInt(P.sb2, 16), ...(P.keyOff ? { keyOff: parseInt(P.keyOff, 16) } : {}) } : {};
    return { kind: 'gba', ...GBA[key], ...ptrs };
  }
  const key = /^(heartgold|soulsilver)_/.test(id) ? 'hgss' : /^platinum_/.test(id) ? 'platinum' : /^(diamond|pearl)_/.test(id) ? 'dp'
    : /^(black|white|black2|white2)_/.test(id) ? 'bw' : null;
  return key ? { kind: 'ds', ...DS[key] } : null;
}

/**
 * The bag layouts the `checked` cheats were tried in, in the running game (scripts/rom-matrix.mjs --cheats: every item
 * with the amounts 1, 10, 99, 999 written the play screen's way, read back through the bag – that many more, in its
 * pocket, nothing else changed, the stack's cap –, in most games also seen in the game's own bag): Red, Blue, Yellow,
 * Gold, Silver, Crystal, Ruby (US, German) and Sapphire (German) – one layout –, Emerald (US, and German from a save),
 * FireRed (US; LeafGreen the same) and the German FireRed (the other-language pointers), Diamond (Pearl the same),
 * Platinum, HeartGold, SoulSilver, Black, White, Black 2, White 2 (the bag found from the party), Sun (in the app, the
 * game's own bag after Continue) and Ultra Moon (a new game). Not here: X/Y and Omega Ruby/Alpha Sapphire – only tried
 * in a new game's intro, where the game itself wrote over a few of the writes; nor a hack that moved the bag (a Game Boy
 * hack's shifted RAM, a found GBA build) or a DS game in another language (found through its own party search). Those
 * keep Rare Candies and Max Repels only.
 */
const CHECKED = new Set(['gb:red_us', 'gb:blue_us', 'gb:yellow_us', 'gb:gold_us', 'gb:silver_us', 'gb:crystal_us', 'gba:ruby', 'gba:emerald', 'gba:firered',
  'gba:firered-eu', 'ds:dp', 'ds:platinum', 'ds:hgss', 'ds:bw', 'ctr:sm', 'ctr:usum']);

/** This game's bag layout, as CHECKED names it ('' unknown; a moved or other-language bag gets a suffix of its own). */
export function bagLayoutKey(entry) {
  const L = layoutOf(entry);
  if (!L) return '';
  const id = String(entry.id || '');
  if (L.kind === 'ctr') return `ctr:${entry.id}`;
  if (L.kind === 'gb') return `gb:${id.replace(/~.*$/, '')}${entry.wram?.delta ? '~moved' : ''}`;
  if (L.kind === 'gba') {
    const key = Object.keys(GBA).find((k) => GBA[k].items === L.items && GBA[k].money === L.money);
    return `gba:${key}${L.found ? '~found' : entry.saveBlockPtrs ? '-eu' : ''}`;
  }
  const key = Object.keys(DS).find((k) => DS[k].pockets === L.pockets);
  return `ds:${key}${id.includes('~') ? '~lang' : ''}`;
}

/** Were the `checked` cheats tried in this game's bag layout (CHECKED)? */
export const checkedLive = (entry) => CHECKED.has(bagLayoutKey(entry));

/**
 * Can this game get this cheat (default: Rare Candies) at all? An item: a known bag that has the item, and for every
 * cheat but the first two a layout it was checked in; the money: moneySupported. (The bag or the money still has to be
 * found when it is used.) `untried`: whether it could be tried at all, checked or not – only for the ROM test matrix,
 * which is how a game gets onto the checked lists.
 */
export function cheatSupported(entry, cheat = 'rareCandy', { untried = false } = {}) {
  const c = CHEATS[cheat];
  if (!c || !entry) return false;
  if (c.money) return moneySupported(entry, { untried });
  if (!layoutOf(entry) || !c.items[entry.gen]) return false;
  return untried || !c.checked || checkedLive(entry);
}

/** The cheats this game can get, in the order the play screen lists them. */
export const cheatsFor = (entry) => Object.keys(CHEATS).filter((id) => cheatSupported(entry, id));

/**
 * Why a cheat can't be used right now – null when it can. The order is the one the player can do something about
 * last: a game without a known bag, a run whose rules don't allow cheats (host-set in a SoulLink), live tracking that
 * hasn't found the team (the DS games find the bag through it), a battle (the game keeps a copy of the bag then).
 * @param {{supported:boolean, allowed:boolean, live:boolean, inBattle:boolean, linked?:boolean}} s
 * @returns {null|'unsupported'|'off'|'linked'|'waiting'|'inBattle'}
 */
export function cheatBlock({ supported, allowed, live, inBattle, linked = false }) {
  if (!supported) return 'unsupported';
  if (!allowed) return 'off';
  // (a link session: every player's copy of the console must stay the same – the players' games never take a cheat then)
  if (linked) return 'linked';
  if (!live) return 'waiting';
  return inBattle ? 'inBattle' : null;
}

// ---------------------------------------------------------------------------
// Gen 1/2

const bcdOk = (b) => b.every((x) => (x >> 4) <= 9 && (x & 15) <= 9);
const gbItemOk = (gen, id) => (gen === 1 ? (id >= 1 && id <= 0x53) || (id >= 0xc4 && id <= 0xfe) : id >= 1 && id <= 0xfe);

function gbBag(L, gen, read) {
  const b = read(L.addr, 42);
  if (!b) return null;
  const n = b[0];
  if (n > (L.cap || 20) || b[1 + n * 2] !== 0xff) return null;
  for (let i = 0; i < n; i++) if (!gbItemOk(gen, b[1 + i * 2]) || b[2 + i * 2] < 1 || b[2 + i * 2] > 99) return null;
  if (L.money) {
    const m = read(L.money, 3);
    if (!m || !bcdOk(m)) return null;
  }
  if (L.keyItems) {
    const k = read(L.keyItems, 27);
    if (!k || k[0] > 25 || k[1 + k[0]] !== 0xff) return null;
  }
  return { n, bytes: b };
}

/** Gen 2's ball pocket: behind the key items (wNumKeyItems, 25 ids + 0xFF), 12 slots (pokecrystal wram.asm wNumBalls). */
const gbBalls = (L) => ({ ...L, addr: L.keyItems + 27, keyItems: null, money: null, cap: 12 });

function gbAdd(L, gen, mem, item, count) {
  const bag = gbBag(L, gen, mem.read);
  if (!bag) return { error: 'notFound' };
  const { n, bytes } = bag;
  for (let i = 0; i < n; i++) {
    if (bytes[1 + i * 2] !== item) continue;
    const before = bytes[2 + i * 2];
    const after = Math.min(99, before + count);
    if (after === before) return { error: 'max', before };
    return commit(mem, [[L.addr + 2 + i * 2, [after]]], before, after);
  }
  if (n >= (L.cap || 20)) return { error: 'full' };
  const after = Math.min(99, count);
  // the new pair over the old terminator, a new terminator behind it, then the count
  return commit(mem, [[L.addr + 1 + n * 2, [item, after, 0xff]], [L.addr, [n + 1]]], 0, after);
}

// ---------------------------------------------------------------------------
// Gen 3

const inEwram = (a) => a >= 0x02000000 && a < 0x02040000;

function gbaBag(L, read, pocketName = 'items') {
  let sb1 = L.sb1;
  let key = 0;
  if (L.sb1Ptr) {
    const p1 = read(L.sb1Ptr, 4);
    const p2 = read(L.sb2Ptr, 4);
    if (!p1 || !p2) return null;
    sb1 = u32le(p1, 0);
    const sb2 = u32le(p2, 0);
    if (!inEwram(sb1) || !inEwram(sb2)) return null;
    const k = read(sb2 + L.keyOff, 4);
    if (!k) return null;
    key = u32le(k, 0);
    if (L.found) {
      key = foundKey(L, read, sb1, sb2);
      if (key === null) return null;
    }
  }
  const money = read(sb1 + L.money, 4);
  if (!money || ((u32le(money, 0) ^ key) >>> 0) > 999999) return null;
  const q = (v) => (v ^ key) & 0xffff;
  const pocket = (off, n, ok) => {
    const b = read(sb1 + off, n * 4);
    if (!b) return null;
    for (let i = 0; i < n; i++) {
      const id = u16le(b, i * 4);
      if (id && (!ok(id) || q(u16le(b, i * 4 + 2)) < 1 || q(u16le(b, i * 4 + 2)) > 99)) return null;
    }
    return b;
  };
  const items = pocket(L.items[0], L.items[1], (id) => id <= L.maxId);
  const balls = pocket(L.balls[0], L.balls[1], (id) => id <= 12); // Master Ball … Premier Ball
  if (!items || !balls) return null;
  const [off, n] = L[pocketName];
  // (`money`: where the money is and the whole key it is XORed with – the money cheat)
  return { addr: sb1 + off, slots: n, bytes: pocketName === 'balls' ? balls : items, q, money: { addr: sb1 + L.money, key } };
}

/**
 * The bag key of a hack whose SaveBlock2 grew in front of encryptionKey (Modern Emerald's options – the key isn't at
 * +0xAC there): every slot's quantity is XORed with the key's low half, an empty slot's too, so an empty slot of the
 * items or the Poké Ball pocket shows it; the key is the word of SaveBlock2 with that low half that makes the money
 * (XORed with all of it) a sum of money – at +0xAC first. null: no empty slot, or no such word.
 */
function foundKey(L, read, sb1, sb2) {
  const low = (off, n) => {
    const b = read(sb1 + off, n * 4);
    if (!b) return null;
    for (let i = n - 1; i >= 0; i--) if (!u16le(b, i * 4)) return u16le(b, i * 4 + 2);
    return null;
  };
  const kl = low(L.items[0], L.items[1]) ?? low(L.balls[0], L.balls[1]);
  const m = read(sb1 + L.money, 4);
  const s2 = read(sb2, 0x1000);
  if (kl === null || !m || !s2) return null;
  const money = u32le(m, 0);
  for (const o of [L.keyOff, ...Array.from({ length: 0x400 }, (_, i) => i * 4)]) {
    const v = u32le(s2, o);
    if ((v & 0xffff) === kl && ((money ^ v) >>> 0) <= 999999) return v;
  }
  return null;
}

function slotAdd(bag, mem, item, count, cap, enc) {
  const { addr, slots, bytes, q } = bag;
  for (let i = 0; i < slots; i++) {
    if (u16le(bytes, i * 4) !== item) continue;
    const before = q(u16le(bytes, i * 4 + 2));
    const after = Math.min(cap, before + count);
    if (after === before) return { error: 'max', before };
    return commit(mem, [[addr + i * 4 + 2, le16(enc(after))]], before, after);
  }
  for (let i = 0; i < slots; i++) {
    if (u16le(bytes, i * 4) !== 0) continue;
    const after = Math.min(cap, count);
    return commit(mem, [[addr + i * 4, [...le16(item), ...le16(enc(after))]]], 0, after);
  }
  return { error: 'full' };
}

// ---------------------------------------------------------------------------
// Gen 4/5

function dsBag(L, entry, read, state, pocketName = 'medicine', allowEmpty = false) {
  let bag = null;
  if (L.gen === 4) {
    // the save data: from the pointer the party reader followed, else from where it found the party
    const save = state?.saveBase || (state?.partyAddr && entry.partyMonsOffset ? state.partyAddr + 8 - parseInt(entry.partyMonsOffset, 16) : 0);
    if (save) bag = save + L.general + L.bag;
  } else if (state?.partyAddr) bag = state.partyAddr + L.fromParty;
  if (!bag || bag < 0x02000000 || bag >= 0x02400000) return null;
  const read16 = (off, n) => read(bag + off, n * 4);
  let used = 0;
  const out = {};
  for (const [name, [off, n]] of Object.entries(L.pockets)) {
    const b = read16(off, n);
    if (!b) return null;
    for (let i = 0; i < n; i++) {
      const id = u16le(b, i * 4);
      const qty = u16le(b, i * 4 + 2);
      if (!id) {
        if (qty) return null; // the game clears a slot to 0/0
        continue;
      }
      if (id > L.maxId || qty < 1 || qty > 999 || (name === 'tm' && !L.tm(id))) return null;
      used++;
    }
    out[name] = b;
  }
  // an all-zero region passes the checks above: a real bag has something in it (a fresh game's empty bag is refused too)
  if (!used && !allowEmpty) return null;
  const name = L.pockets[pocketName] ? pocketName : 'items'; // (Gen 5 keeps the Poké Balls with the items)
  const [off, n] = L.pockets[name];
  return { addr: bag + off, slots: n, bytes: out[name], q: (v) => v };
}

/**
 * May a DS bag with nothing in it yet be taken as the bag (a new game: Diamond right after the starter, Black until the
 * Town Map)? All zeros look like an empty bag anywhere, so only where the place is confirmed another way: the save data
 * found through the game's own pointer (Gen 4: state.saveBase) or the party at the game's own address (Gen 5 – not an
 * other-language entry `~`, whose party is searched for), the party the live reader checked (its checksums) exactly
 * where that save data keeps it, and the trainer block of the same save data at its offset – a name, money of at most
 * ₽999,999. Anything else: no (addItem answers notFound, why 'empty' – pick up or buy any item first).
 */
function emptyBagOk(L, entry, state, read) {
  if (L.gen === 4) {
    const save = state?.saveBase;
    if (!save || !entry.partyMonsOffset || state.partyAddr !== save + parseInt(entry.partyMonsOffset, 16) - 8) return false;
    return trainerOk(read, save + L.general + L.trainer[0], save + L.general + L.trainer[1]);
  }
  if (L.gen !== 5 || !state?.partyAddr || String(entry?.id || '').includes('~')) return false;
  // (Gen 5: the party block at +0x18E00 of the save data, the trainer's name at +0x19404, the money in the misc block –
  // +0x21200, Black 2/White 2 +0x21100: PKHeX SAV5BW / SAV5B2W2)
  const save = state.partyAddr - 0x18e00;
  return trainerOk(read, save + 0x19404, save + (/^(black2|white2)_/.test(String(entry.id)) ? 0x21100 : 0x21200));
}
/** A trainer block's name (its first character: not 0, not the 0xFFFF terminator) and money (at most ₽999,999). */
function trainerOk(read, nameAt, moneyAt) {
  const n = read(nameAt, 2);
  const m = read(moneyAt, 4);
  return !!n && !!m && u16le(n, 0) !== 0 && u16le(n, 0) !== 0xffff && u32le(m, 0) <= 999999;
}

// ---------------------------------------------------------------------------
// Gen 6/7

const ctrSlot = (L, b, o) => (L.gen === 7 ? u32le(b, o) : u16le(b, o) | (u16le(b, o + 2) << 16)) >>> 0;
const ctrId = (L, v) => (L.gen === 7 ? v & 0x3ff : v & 0xffff);
const ctrCount = (L, v) => (L.gen === 7 ? (v >>> 10) & 0x3ff : v >>> 16);
/** One slot of `pocket`: 0 empty, 1 an item that may be in that pocket, 2 not a slot of it. */
function ctrSlotKind(L, v, pocket) {
  const id = ctrId(L, v);
  const qty = ctrCount(L, v);
  if (!id) return qty ? 2 : 0; // (an empty slot has no count)
  // Sun/Moon, Ultra Sun/Ultra Moon keep an item's id with count 0 when the last one leaves the bag (given to a Pokémon
  // to hold, used up) – a slot of the bag all the same, just not a used one (#45)
  if (L.gen === 7 && !qty && id <= L.maxId && !(v >>> 31)) return 0;
  if (id > L.maxId || qty < 1 || qty > 999 || (L.gen === 7 && v >>> 31)) return 2;
  if ((pocket === 'medicine' && !MED67.has(id)) || (pocket === 'tm' && !TM67.has(id))) return 2;
  return 1;
}
const isPtr = (p) => p >= 0x08000000 && p < 0x40000000;
/**
 * The pocket pointers behind a block at `base` (Sun/Moon, Ultra Sun/Ultra Moon): 'match' – exactly this block's pockets,
 * 'none' – no pointers there (a game without the table), 'other' – pointers to anything else. `t`: the words there.
 */
function ctrTable(L, base, t) {
  if (!t) return 'none';
  const n = Object.keys(L.pockets).length;
  const want = new Set(Object.values(L.pockets).map(([off]) => (base + off) >>> 0));
  const got = new Set(Array.from({ length: n }, (_, i) => u32le(t, i * 4)));
  if (![...got].some(isPtr)) return 'none';
  return got.size === want.size && [...got].every((p) => want.has(p)) ? 'match' : 'other';
}

/**
 * Is the block at `base` the bag? → { ok: true, used, table } or { why } – why not, for the diagnostics: 'unread'
 * (not in the memory souldew sees), 'slot <pocket>#<n> <value>' (a slot that is no item of its pocket), 'pointers'
 * (the table behind it points at other pockets), 'empty' (nothing in it and no table that says it is the bag: all
 * zeros would look the same).
 */
function ctrCheck(L, base, read) {
  const b = read(base, L.size);
  if (!b) return { why: 'unread' };
  let used = 0;
  for (const [name, [off, n]] of Object.entries(L.pockets)) {
    for (let i = 0; i < n; i++) {
      const v = ctrSlot(L, b, off + i * 4);
      const k = ctrSlotKind(L, v, name);
      if (k === 2) return { why: `slot ${name}#${i} ${hex(v)}` };
      used += k;
    }
  }
  const table = ctrTable(L, base, read(base + L.size, Object.keys(L.pockets).length * 4));
  if (table === 'other') return { why: 'pointers' };
  if (!used && table !== 'match') return { why: 'empty' };
  return { ok: true, used, table: table === 'match', b };
}

function ctrBagAt(L, base, read, pocketName = 'medicine', tried = null) {
  const c = ctrCheck(L, base, read);
  if (!c.ok) {
    tried?.push({ at: hex(base), why: c.why });
    return null;
  }
  const { b } = c;
  const [off, slots] = L.pockets[pocketName];
  const slot = (i) => ctrSlot(L, b, off + i * 4);
  return { base, addr: base + off, slots, bytes: b.subarray(off, off + slots * 4), g7: L.gen === 7, slot, idOf: (v) => ctrId(L, v), countOf: (v) => ctrCount(L, v) };
}

/** The bag at the first of the game's addresses (ctrBags) where it checks out; `tried` collects why the others didn't. */
function ctrFind(L, entry, read, state, pocketName, tried = null) {
  for (const base of ctrBags(entry, state)) {
    const bag = ctrBagAt(L, base, read, pocketName, tried);
    if (bag) return bag;
  }
  return null;
}

// ---- the search ----------------------------------------------------------------------------------------------------
// When the bag isn't at any address souldew knows (an update or a build it hasn't seen), it is searched for near them:
// the 3DS player reads windows of 64 KB (CTR_WINDOW, the host's most per region), a few at a time on top of the game's
// own regions, each overlapping the next by more than a bag, so a bag anywhere in the range lies whole in one window.
// A game with the pocket table (Sun/Moon, Ultra Sun/Ultra Moon) is found by it alone: the words at T that point at
// exactly T − size + each pocket's offset, with every slot of that block an item of its pocket. A game without it
// (X/Y, ORAS – none seen there so far) by its slots: no slot that isn't an item of its pocket, every pocket packed
// from the front (one with a gap is refused – better no bag than a wrong one), items in at least two pockets, no item
// twice (the game stacks it in one slot), and nowhere else in the
// range anything that would pass the same – two places that both look like the bag (a nearly empty one shifted by a
// slot) are refused. (Searched by its slots, the heap of Sun 1.0 and Ultra Moon 1.0 – 72 MB each – has a few hundred
// places that look like a bag with one pocket filled, none with two; by the table, exactly one: the bag.) The place
// found is kept for the session (state.ctrBag) and tried first from then on.
export const CTR_WINDOW = 0x10000;
const CTR_STEP = CTR_WINDOW - 0x1000; // (a bag and its table: at most 0xE44 bytes)
const CTR_RADIUS = 0x50000; // searched on both sides of each known address
const CTR_PER_ROUND = 6; // windows per read (the player watches 16 regions at most, the game's own included)

/** The windows to search for a 3DS game's bag, nearest to the known addresses first, in rounds of CTR_PER_ROUND. */
export function ctrScanPlan(entry, { radius = CTR_RADIUS } = {}) {
  const L = layoutOf(entry);
  if (L?.kind !== 'ctr') return [];
  const known = ctrBags(entry, null);
  // the ranges around the known addresses, merged where they overlap
  const spans = known.map((a) => [Math.max(0, a - radius), a + radius + ctrLen(L)]).sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const s of spans) {
    const last = merged.at(-1);
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  const wins = [];
  for (const [a, b] of merged) for (let w = a; w < b - 0x1000; w += CTR_STEP) wins.push(w);
  const dist = (w) => Math.min(...known.map((k) => Math.abs(w + CTR_WINDOW / 2 - k)));
  wins.sort((x, y) => dist(x) - dist(y) || x - y);
  const rounds = [];
  for (let i = 0; i < wins.length; i += CTR_PER_ROUND) rounds.push(wins.slice(i, i + CTR_PER_ROUND).map((addr) => ({ addr, len: CTR_WINDOW, name: 'bagSearch' })));
  return rounds;
}

/**
 * The places in one window of a 3DS game's memory (`b`: its bytes, read at `addr`) that look like its bag →
 * [{ base, how: 'table'|'slots' }]. `table` false searches by the slots even in a game with the pocket table (research).
 */
export function ctrScanWindow(entry, addr, b, { table } = {}) {
  const L = layoutOf(entry);
  return L?.kind === 'ctr' && b ? scanWindow(table === false ? { ...L, table: false } : L, addr, b) : [];
}
/**
 * A game with the table only by it; the others by their slots (see above), with prefix sums – every word of the window
 * is classed once, then each place costs a few lookups per pocket.
 */
function scanWindow(L, addr, b) {
  const words = b.length >> 2;
  const n = Object.keys(L.pockets).length;
  const blockWords = L.size >> 2;
  const out = [];
  const check = (base) => ctrCheck(L, base, (a, len) => (a >= addr && a + len <= addr + b.length ? b.subarray(a - addr, a - addr + len) : null));
  if (L.table) {
    // the table: its first word points at one of the pockets – the base follows, then the rest has to match
    const offs = new Set(Object.values(L.pockets).map(([off]) => off));
    for (let i = blockWords; i + n <= words; i++) {
      const base = (addr + (i - blockWords) * 4) >>> 0;
      if (!offs.has((u32le(b, i * 4) - base) >>> 0)) continue;
      if (ctrTable(L, base, b.subarray(i * 4, i * 4 + n * 4)) !== 'match') continue;
      if (check(base).ok) out.push({ base, how: 'table' });
    }
    return out;
  }
  // per word: not a slot of any pocket / an item / an item that isn't medicine / … that isn't a TM – as prefix sums
  const pre = (f) => {
    const p = new Int32Array(words + 1);
    for (let i = 0; i < words; i++) p[i + 1] = p[i] + f(ctrSlot(L, b, i * 4));
    return p;
  };
  const bad = pre((v) => (ctrSlotKind(L, v, 'items') === 2 ? 1 : 0));
  const item = pre((v) => (ctrSlotKind(L, v, 'items') === 1 ? 1 : 0));
  const notMed = pre((v) => (ctrSlotKind(L, v, 'items') === 1 && ctrSlotKind(L, v, 'medicine') !== 1 ? 1 : 0));
  const notTm = pre((v) => (ctrSlotKind(L, v, 'items') === 1 && ctrSlotKind(L, v, 'tm') !== 1 ? 1 : 0));
  const sum = (p, i, len) => p[i + len] - p[i];
  const pockets = Object.entries(L.pockets).map(([name, [off, len]]) => [name, off >> 2, len]);
  for (let s = 0; s + blockWords + n <= words; s++) {
    let filled = 0;
    let ok = true;
    for (const [name, o, len] of pockets) {
      const i = s + o;
      const k = sum(item, i, len);
      if (sum(bad, i, len) || (name === 'medicine' && sum(notMed, i, len)) || (name === 'tm' && sum(notTm, i, len)) || sum(item, i, k) !== k) {
        ok = false;
        break;
      }
      if (k) filled++;
    }
    if (!ok || filled < 2) continue;
    const base = (addr + s * 4) >>> 0;
    const c = check(base);
    if (!c.ok) continue;
    // no item twice (the game stacks it in one slot)
    const ids = [];
    for (const [, o, len] of pockets) for (let i = 0; i < len; i++) ids.push(ctrId(L, ctrSlot(L, b, (s + o + i) * 4)));
    const held = ids.filter(Boolean);
    if (new Set(held).size === held.length) out.push({ base, how: c.table ? 'table' : 'slots' });
  }
  return out;
}

/**
 * Search the bag of a 3DS game near its known addresses (when it isn't at one of them) and keep what was found for the
 * session: state.ctrBag = { base, how }. `mem.watch(regions)` lets the 3DS player read more memory and resolves once it
 * has (false: it couldn't); the windows are let go afterwards, the bag found stays watched. Several calls at once share
 * one search. → { found: hex | null, how?, why?, windows, candidates? } – what the diagnostics keep.
 */
export function locateCtrBag(entry, mem, state) {
  const L = layoutOf(entry);
  if (L?.kind !== 'ctr' || typeof mem?.watch !== 'function' || !state) return Promise.resolve(null);
  if (state.ctrBagSearch) return state.ctrBagSearch;
  const run = async () => {
    const hits = new Map(); // base → how
    let windows = 0;
    let why = null;
    for (const round of ctrScanPlan(entry)) {
      if (!(await mem.watch(round))) {
        why = 'noMemory';
        break;
      }
      for (const w of round) {
        const b = mem.read(w.addr, w.len);
        if (!b) continue; // (not mapped)
        windows++;
        for (const h of scanWindow(L, w.addr, b)) if (!hits.has(h.base) || h.how === 'table') hits.set(h.base, h.how);
      }
      if ([...hits.values()].includes('table')) break; // (nothing else could beat that)
    }
    const tables = [...hits].filter(([, how]) => how === 'table');
    const pick = tables.length ? tables : [...hits];
    const done = { windows, ...(hits.size ? { candidates: hits.size } : {}) };
    if (pick.length !== 1) {
      await mem.watch([]);
      return { found: null, why: why || (pick.length ? 'ambiguous' : 'none'), ...done };
    }
    const [base, how] = pick[0];
    // the bag found stays in the memory the player reads – checked once more there
    await mem.watch([{ addr: base, len: ctrLen(L), name: 'bag' }]);
    if (!ctrCheck(L, base, mem.read).ok) return { found: null, why: 'moved', ...done };
    state.ctrBag = { base, how };
    return { found: hex(base), how, ...done };
  };
  state.ctrBagSearch = run().finally(() => {
    state.ctrBagSearch = null;
  });
  return state.ctrBagSearch;
}

function ctrAdd(L, entry, mem, state, item, count, pocketName = 'medicine') {
  const tried = [];
  const bag = ctrFind(L, entry, mem.read, state, pocketName, tried);
  if (!bag) {
    // not at a known address: search it nearby where the player can read more memory, then once more
    const search = typeof mem.watch === 'function' ? locateCtrBag(entry, mem, state) : null;
    const notFound = (scan) => ({ error: 'notFound', why: tried.length && tried.every((t) => t.why === 'empty') ? 'empty' : 'missing', tried, ...(scan ? { scan } : {}) });
    if (!search) return notFound(null);
    return search.then((scan) => (scan?.found ? ctrAdd(L, entry, { read: mem.read, write: mem.write }, state, item, count, pocketName) : notFound(scan)));
  }
  const { addr, slots, g7, slot, idOf, countOf } = bag;
  const enc = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  for (let i = 0; i < slots; i++) {
    const v = slot(i);
    if (idOf(v) !== item) continue;
    const before = countOf(v);
    const after = Math.min(999, before + count);
    if (after === before) return { error: 'max', before };
    // the count only – Gen 7 keeps its sort index and NEW mark
    return g7 ? commit(mem, [[addr + i * 4, enc(((v & ~(0x3ff << 10)) | (after << 10)) >>> 0)]], before, after)
      : commit(mem, [[addr + i * 4 + 2, le16(after)]], before, after);
  }
  for (let i = 0; i < slots; i++) {
    if (idOf(slot(i))) continue;
    const after = Math.min(999, count);
    if (!g7) return commit(mem, [[addr + i * 4, [...le16(item), ...le16(after)]]], 0, after);
    // as the game files a new item: marked NEW, not in the Free Space pocket (index 0 – seen in Sun: the key item from
    // Hala; a higher index would put it there)
    return commit(mem, [[addr + i * 4, enc((item | (after << 10) | 0x40000000) >>> 0)]], 0, after);
  }
  return { error: 'full' };
}

// ---------------------------------------------------------------------------

// A write's answer: true, or a refusal – false, or (the 3DS player) { ok: false, why } with its host's reason
// (native/ctr-host/ctrhost.c mem_write: 'changed' – the game holds other bytes there now –, 'range', 'failed' …)
const refusal = (r) => (r === false ? {} : r && typeof r === 'object' && r.ok === false ? r : null);
const refused = ({ why }) => (why === 'changed' ? { error: 'changed' } : { error: 'write', ...(why ? { why: String(why) } : {}) });

// `mem.fresh()` (the fast player): the core's whole memory into the mirror, after the write and a frame – the read-back
// then reads what the game really holds. Without it the read-back reads the player's copy, which a write sets at once
// (the fast player) – it could never catch a write that didn't land.
function commit(mem, writes, before, after) {
  const check = (results) => {
    const no = results.map(refusal).find(Boolean);
    if (no) return refused(no);
    // read back: the emulator really holds it now
    for (const [addr, bytes] of writes) {
      const got = mem.read(addr, bytes.length);
      if (!got || bytes.some((x, i) => got[i] !== x)) return { error: 'write' };
    }
    return { ok: true, before, after, added: after - before };
  };
  const results = [];
  for (const [addr, bytes] of writes) {
    const r = mem.write(addr, Uint8Array.from(bytes));
    if (refusal(r)) return refused(refusal(r));
    results.push(r);
  }
  if (typeof mem.fresh === 'function') {
    return Promise.all(results).then(async (rs) => {
      const no = rs.map(refusal).find(Boolean);
      if (no) return refused(no);
      return (await mem.fresh().catch(() => false)) ? check(rs) : { error: 'write', why: 'unverified' };
    }, () => ({ error: 'write' }));
  }
  // the 3DS player answers once its host has written (between two frames)
  return results.some((r) => typeof r?.then === 'function') ? Promise.all(results).then(check, () => ({ error: 'write' })) : check(results);
}

/**
 * Put `count` Rare Candies into the player's bag (onto the stack they have, else into a free slot; capped at the
 * game's stack size: 99, Gen 4–7 999).
 * @param {object} entry   addresses.json entry (findEntry)
 * @param {{read:(addr:number,len:number)=>Uint8Array|null, write:(addr:number,bytes:Uint8Array)=>boolean|Promise<boolean|{ok:false,why:string}>, watch?:(regions:object[])=>Promise<boolean>, fresh?:()=>Promise<boolean>}} mem
 *                         `watch` (the 3DS player): more memory to read – a 3DS bag not at a known address is then
 *                         searched for nearby (locateCtrBag)
 * @param {object} state   the live reader's state (readLiveParty) – DS games find the bag through the party, 3DS games
 *                         try where this session found it, then the update the party was found at
 * @returns the result – a Promise of it when `mem.write` answers later (the 3DS player) or the bag is searched for:
 *          {ok:true, before:number, after:number, added:number} | {error:'unsupported'|'notFound'|'full'|'max'|'changed'}
 *          | {error:'write', why?:string} ('changed': the game changed those bytes just then; `why`: the 3DS host's reason)
 *          A 3DS game's notFound says more: why 'empty' (the bag looked empty everywhere – nothing tells it from zeros
 *          yet) or 'missing', tried [{at, why}] (each known address and why it wasn't the bag) and scan (the search).
 */
export function addRareCandies(entry, mem, state, count = 99) {
  return addItem(entry, mem, state, RARE_CANDY[entry?.gen], count);
}

/**
 * Put `count` Max Repels into the Items pocket (Gen 1/2: the one bag) – the same checks, stack sizes and answers as
 * addRareCandies.
 */
export function addMaxRepels(entry, mem, state, count = 10) {
  return addItem(entry, mem, state, MAX_REPEL[entry?.gen], count, { pocket: 'items' });
}

const worldTables = new WeakMap(); // game entry → its Shared World table (or null)
/**
 * May a cheat be written into this game right now? Gen 3: only while the player stands in the overworld with nothing
 * holding them – the same check wagers are paid by (shared/linkbattle.mjs camIdle, the Shared World's camera reader):
 * Emerald and FireRed/LeafGreen move their save blocks on a map change, and a bag or money found a moment earlier would
 * be written where the game no longer reads. A Gen 3 game without a Shared World table (a hack) and the other
 * generations: yes, as before (their bag and money don't move).
 */
export function cheatIdle(entry, read) {
  if (entry?.gen !== 3 || typeof read !== 'function') return true;
  if (!worldTables.has(entry)) worldTables.set(entry, worldTable(entry) || null);
  const t = worldTables.get(entry);
  if (!t) return true;
  let cam = null;
  try {
    cam = readCamera(t, read);
  } catch {
    cam = null;
  }
  return camIdle(cam);
}

/**
 * Use one of CHEATS by its id: its item into its pocket – `amount` of it (default: the cheat's own count) –, or the
 * money (`amount`: ₽ to add, or 'max'; moneyCheat). Only a cheat this game can get (cheatSupported): one that wasn't
 * checked in this game's bag isn't written at all. { error: 'busy' }: not now – a Gen 3 game not in the overworld
 * (cheatIdle).
 */
export function applyCheat(id, entry, mem, state, { amount, untried = false } = {}) {
  const c = CHEATS[id];
  if (!c || !cheatSupported(entry, id, { untried })) return { error: 'unsupported' };
  if (!cheatIdle(entry, mem.read)) return { error: 'busy' };
  if (c.money) return moneyCheat(entry, mem, state, amount ?? MONEY_STEPS[0], { untried });
  const n = Number.isInteger(amount) && amount > 0 ? Math.min(999, amount) : c.count;
  // (a DS bag with nothing in it yet – Diamond right after the starter, Black before the Town Map – where it can only be
  // the bag: emptyBagOk)
  return addItem(entry, mem, state, c.items[entry.gen], n, { ...(c.pocket ? { pocket: c.pocket } : {}), allowEmpty: true });
}

// ---------------------------------------------------------------------------
// Money: where each game keeps it (the Gen 1/2 and Gen 4/5 addresses: shared/linkbattle.mjs GAMES, which pays link
// battle wagers the same way; Gen 3: SaveBlock1 + money, XORed with the whole encryption key in Emerald and
// FireRed/LeafGreen – found and checked together with the bag). Every game here holds at most ₽999,999.

/**
 * The games whose money the cheat was checked in, in the running game (scripts/rom-matrix.mjs --cheats): read, added,
 * set to the most and read back. By the addresses.json entry (Pearl, LeafGreen, the other-language FireRed/LeafGreen:
 * the same addresses as the game tried). Not here: the 3DS games (their money isn't known), and any game found
 * through a search or with moved RAM (a hack, another-language DS game).
 */
const MONEY_CHECKED = new Set(['red_us', 'blue_us', 'yellow_us', 'gold_us', 'silver_us', 'crystal_us', 'ruby_us', 'sapphire_us', 'ruby_de', 'sapphire_de',
  'emerald_us', 'emerald_de', 'firered_us', 'leafgreen_us', 'firered_eu', 'leafgreen_eu', 'diamond_us', 'pearl_us', 'platinum_us', 'heartgold_us', 'soulsilver_us',
  'black_us', 'white_us', 'black2_us', 'white2_us']);

/** Can this game's money be changed (MONEY_CHECKED – `untried`: see cheatSupported –, and the game's own memory)? */
export function moneySupported(entry, { untried = false } = {}) {
  const L = layoutOf(entry);
  if (!L || (!untried && !MONEY_CHECKED.has(String(entry.id || '')))) return false;
  if (L.kind === 'gba') return !L.found;
  if (L.kind === 'gb' || L.kind === 'ds') return !!gameOfEntry(entry);
  return false;
}

/**
 * Gen 5: the money word sits this far past the party block the live reader found (state.partyAddr – the block, its
 * Pokémon 8 bytes in: the save data's party block at +0x18E00, the misc block +0x21200, B2W2 +0x21100 – PKHeX SAV5BW /
 * SAV5B2W2): the money shared/linkbattle.mjs finds has to be exactly there, or it isn't this game's.
 */
const MONEY_FROM_PARTY5 = { black: 0x21200 - 0x18e00, white: 0x21200 - 0x18e00, black2: 0x21100 - 0x18e00, white2: 0x21100 - 0x18e00 };

/**
 * Where this game's money is right now → { addr, value, encode(v) → bytes } | null (not found, or the memory around it
 * doesn't look like the game's: the bag has to read as a bag first). May answer with a Promise.
 */
async function locateMoneyFor(entry, read, state) {
  const L = layoutOf(entry);
  if (!L) return null;
  if (L.kind === 'gba') {
    const G = L.found ? null : L;
    const bag = G && gbaBag(G, read);
    if (!bag) return null;
    const { addr, key } = bag.money;
    const b = read(addr, 4);
    const value = b ? (u32le(b, 0) ^ key) >>> 0 : MONEY_MAX + 1;
    if (value > MONEY_MAX) return null;
    return { addr, value, encode: (v) => { const x = (v ^ key) >>> 0; return [x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, x >>> 24]; } };
  }
  const game = gameOfEntry(entry);
  if (!game) return null;
  // (the bag has to read as a bag first: the game's memory is where souldew expects it)
  if (L.kind === 'gb' && !gbBag(L, entry.gen, read)) return null;
  if (L.kind === 'ds' && !dsBag(L, entry, read, state, 'items', emptyBagOk(L, entry, state, read))) return null;
  const at = await locateMoney(game, read);
  if (!at) return null;
  // the save data the party reader follows (Gen 4) or the party itself (Gen 5): the money has to be at its place there
  if (L.gen === 4 && state?.saveBase && at.addr !== state.saveBase + GAMES[game].money.off) return null;
  if (L.gen === 5 && (!state?.partyAddr || at.addr !== state.partyAddr + MONEY_FROM_PARTY5[game])) return null;
  return at;
}

/**
 * The money cheat: `amount` ₽ more (capped at ₽999,999), or 'max' – set to ₽999,999. Written and read back like the
 * items (commit). → a Promise of { ok: true, before, after, added } | { error: 'unsupported' | 'notFound' | 'max' |
 * 'changed' | 'write', why? }. `entry`, `mem`, `state` as for addItem.
 */
export async function moneyCheat(entry, mem, state, amount, { untried = false } = {}) {
  if (!moneySupported(entry, { untried })) return { error: 'unsupported' };
  const max = amount === 'max';
  if (!max && !(Number.isInteger(amount) && amount > 0)) return { error: 'unsupported' };
  let at;
  try {
    at = await locateMoneyFor(entry, mem.read, state);
  } catch {
    at = null;
  }
  if (!at) return { error: 'notFound' };
  const after = max ? MONEY_MAX : Math.min(MONEY_MAX, at.value + amount);
  if (after <= at.value) return { error: 'max', before: at.value };
  return commit(mem, [[at.addr, at.encode(after)]], at.value, after);
}

/** The money this game holds now (null: not found) – the play screen's money cheat says it. */
export async function readMoneyFor(entry, read, state, { untried = false } = {}) {
  if (!moneySupported(entry, { untried })) return null;
  try {
    return (await locateMoneyFor(entry, read, state))?.value ?? null;
  } catch {
    return null;
  }
}

/** Gen 2's Poké Balls (pokecrystal constants/item_constants.asm): the only items of its ball pocket. */
const GB2_BALLS = new Set([0x01, 0x02, 0x04, 0x05, 0x9d, 0x9f, 0xa0, 0xa1, 0xa4, 0xa5, 0xa6, 0xb1]);

/**
 * Can `pocket` of this game hold item number `item` at all? The bounds the bag readers check a pocket against (an item
 * written past them makes the bag unreadable for every later cheat or gift – or, in Gen 7, wraps into another item):
 * Gen 1/2 never the list's 0xFF end and Gen 2's balls apart; Gen 3 balls 1–12, the rest up to the game's last item;
 * Gen 4–7 up to the game's last item (Gen 7 keeps 10 bits for it).
 */
export function itemFitsPocket(L, entry, item, pocket = null) {
  if (!L || !Number.isInteger(item) || item < 1) return false;
  if (L.kind === 'gb') {
    if (item > 0xfe) return false;
    if (entry?.gen === 2) return pocket === 'balls' ? GB2_BALLS.has(item) : !GB2_BALLS.has(item);
    return true;
  }
  if (L.kind === 'gba') return pocket === 'balls' ? item <= 12 : item > 12 && item <= L.maxId;
  if (!L.maxId || item > L.maxId) return false;
  return L.kind !== 'ctr' || L.gen !== 7 || item <= 0x3ff;
}

/**
 * Put `count` of an item into the bag – the same checks as addRareCandies. `pocket` 'balls' puts it into the Poké Ball
 * pocket where the game has one (Gen 2–4; Gen 1 and 5 keep balls with the items; the ROM test matrix –
 * scripts/rom-matrix – gives Poké Balls to catch a wild Pokémon early in a game), 'items' into the Items pocket (Max
 * Repels – where Gen 1–3 put every item without a pocket of its own anyway). Without one, Gen 4–7 put it into
 * Medicine (Rare Candies), and a 3DS game takes Medicine items only.
 * `allowEmpty` accepts a Gen 4 bag with nothing in it yet when the save data came from the pointer (not a scan).
 */
export function addItem(entry, mem, state, item, count = 1, { pocket = null, allowEmpty = false } = {}) {
  const L = layoutOf(entry);
  if (!L || !item) return { error: 'unsupported' };
  // (an item number the pocket can't hold is never written – a gift's number comes from a partner's computer)
  if (!itemFitsPocket(L, entry, item, pocket)) return { error: 'unsupported' };
  if (L.kind === 'ctr') {
    // (the Items pocket on request – the balls too: the 3DS games keep them with the items –, else Medicine items only;
    // nothing lands in the wrong pocket)
    if (pocket === 'items' || pocket === 'balls') return MED67.has(item) || TM67.has(item) ? { error: 'unsupported' } : ctrAdd(L, entry, mem, state, item, count, 'items');
    // (a gift from a partner's Berries pocket – web/lib/together.mjs: into the same pocket here)
    if (pocket === 'berries') return L.pockets.berries && !MED67.has(item) && !TM67.has(item) ? ctrAdd(L, entry, mem, state, item, count, 'berries') : { error: 'unsupported' };
    // Medicine: the Rare Candy cheat (no pocket named) and a gift from a partner's Medicine pocket
    return (pocket && pocket !== 'medicine') || !MED67.has(item) ? { error: 'unsupported' } : ctrAdd(L, entry, mem, state, item, count);
  }
  if (L.kind === 'gb') {
    // Gen 2's ball pocket follows the key items: wNumKeyItems, 25 ids + 0xFF, then wNumBalls (pokecrystal wram.asm)
    // (12 slots there: MAX_BALLS – the PC's items follow right behind them)
    const B = pocket === 'balls' && entry.gen === 2 ? gbBalls(L) : L;
    return gbAdd(B, entry.gen, mem, item, count);
  }
  // (a found build's save block pointers: where the place reader found them – none yet, no bag)
  const G = L.found ? (state?.sb1PtrAddr ? { ...L, sb1Ptr: state.sb1PtrAddr, sb2Ptr: state.sb1PtrAddr + 4 } : null) : L;
  if (!G) return { error: 'notFound' };
  const bag = L.kind === 'gba' ? gbaBag(G, mem.read, pocket === 'balls' ? 'balls' : 'items') : dsBag(L, entry, mem.read, state, pocket || 'medicine', allowEmpty && emptyBagOk(L, entry, state, mem.read));
  // (a DS bag that would read as an empty one, but whose place nothing else confirms: say so – pick up an item first)
  if (!bag) return L.kind === 'ds' && allowEmpty && dsBag(L, entry, mem.read, state, pocket || 'medicine', true) ? { error: 'notFound', why: 'empty' } : { error: 'notFound' };
  const key = L.kind === 'gba' ? bag.q(0) : 0; // q(0) = the key's low half (0 in Ruby/Sapphire)
  return slotAdd(bag, mem, item, count, L.kind === 'ds' ? 999 : 99, (v) => (v ^ key) & 0xffff);
}

// ---------------------------------------------------------------------------
// Gifts between the players of a run (web/lib/together.mjs, shared/giftitems.mjs decides what may be given): the
// ordinary pockets read as a list, and an item taken out again – through the same layouts and checks as addItem. Key
// items and TMs/HMs are in pockets of their own from Gen 2 on and are never read here.

/** The pockets a gift may come from, per layout ([null]: Gen 1's one bag). */
function giftPocketsOf(L, entry) {
  if (L.kind === 'gb') return entry.gen === 1 ? [null] : ['items', 'balls'];
  if (L.kind === 'gba') return ['items', 'balls'];
  if (L.kind === 'ds') return Object.keys(L.pockets).filter((p) => ['items', 'medicine', 'balls'].includes(p));
  return Object.keys(L.pockets).filter((p) => ['items', 'medicine', 'berries'].includes(p));
}

/** One pocket as the gift code sees it: { slots: [{ item, count }], write info } or null when it isn't a bag. */
function giftPocket(L, entry, read, state, pocket) {
  if (L.kind === 'gb') {
    const B = pocket === 'balls' ? gbBalls(L) : L;
    if (pocket === 'balls' && !gbBag(L, entry.gen, read)) return null; // (the items and key items must read as a bag first)
    const bag = gbBag(B, entry.gen, read);
    if (!bag) return null;
    return { kind: 'gb', L: B, n: bag.n, bytes: bag.bytes, slots: Array.from({ length: bag.n }, (_, i) => ({ item: bag.bytes[1 + i * 2], count: bag.bytes[2 + i * 2] })) };
  }
  if (L.kind === 'ctr') {
    const bag = ctrFind(L, entry, read, state, pocket);
    if (!bag) return null;
    return { kind: 'ctr', bag, slots: Array.from({ length: bag.slots }, (_, i) => ({ item: bag.idOf(bag.slot(i)), count: bag.countOf(bag.slot(i)) })) };
  }
  let bag = null;
  if (L.kind === 'gba') {
    const G = L.found ? (state?.sb1PtrAddr ? { ...L, sb1Ptr: state.sb1PtrAddr, sb2Ptr: state.sb1PtrAddr + 4 } : null) : L;
    bag = G && gbaBag(G, read, pocket === 'balls' ? 'balls' : 'items');
  } else {
    if (!L.pockets[pocket]) return null;
    bag = dsBag(L, entry, read, state, pocket, !!state?.saveBase);
  }
  if (!bag) return null;
  return { kind: 'slot', bag, slots: Array.from({ length: bag.slots }, (_, i) => ({ item: u16le(bag.bytes, i * 4), count: bag.q(u16le(bag.bytes, i * 4 + 2)) })) };
}

/**
 * What the bag holds in the pockets a gift may come from → [{ item, count, pocket }] (pocket null: Gen 1's one bag), or
 * null when the game has no known bag or none of its pockets reads as one right now. A 3DS bag must have been found at
 * a known address or by the cheats' search (state.ctrBag). `entry`, `read`, `state` as for addItem.
 */
export function bagItems(entry, read, state = null) {
  const L = layoutOf(entry);
  if (!L) return null;
  const out = [];
  let any = false;
  for (const pocket of giftPocketsOf(L, entry)) {
    const p = giftPocket(L, entry, read, state, pocket);
    if (!p) continue;
    any = true;
    for (const s of p.slots) if (s.item && s.count > 0) out.push({ item: s.item, count: s.count, pocket });
  }
  return any ? out : null;
}

/**
 * Take `count` of `item` out of `pocket` (as bagItems names it): off its stack, and a stack that runs out leaves the
 * pocket the way the game would – the slots after it move up, the last one is emptied (Gen 1/2: the list shrinks and
 * keeps its terminator; Gen 3: an empty slot keeps the encrypted 0). One write per pocket, read back like addItem.
 * → { ok: true, before, after, removed } | { error: 'unsupported'|'notFound'|'missing'|'short'|'changed'|'write' }
 * ('missing': not in that pocket now, 'short': fewer than `count` there now) – a Promise where the write answers later.
 */
export function removeItem(entry, mem, state, item, count = 1, { pocket = null } = {}) {
  const L = layoutOf(entry);
  if (!L || !item || !(count > 0)) return { error: 'unsupported' };
  if (!giftPocketsOf(L, entry).includes(pocket)) return { error: 'unsupported' };
  const p = giftPocket(L, entry, mem.read, state, pocket);
  if (!p) return { error: 'notFound' };
  const i = p.slots.findIndex((s) => s.item === item && s.count > 0);
  if (i < 0) return { error: 'missing' };
  const before = p.slots[i].count;
  if (before < count) return { error: 'short', before };
  const after = before - count;
  const done = (r) => (r?.ok ? { ok: true, before, after, removed: count } : r);
  const then = (r) => (typeof r?.then === 'function' ? r.then(done) : done(r));
  if (p.kind === 'gb') {
    const { L: B, n, bytes } = p;
    if (after > 0) return then(commit(mem, [[B.addr + 2 + i * 2, [after]]], before, after));
    // the pairs after it move up over it, the terminator follows them, then the count
    const tail = Array.from(bytes.subarray(1 + (i + 1) * 2, 1 + n * 2));
    return then(commit(mem, [[B.addr + 1 + i * 2, [...tail, 0xff]], [B.addr, [n - 1]]], before, after));
  }
  if (p.kind === 'ctr') {
    const { bag } = p;
    const enc = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
    const v = bag.slot(i);
    if (after > 0) {
      return then(bag.g7 ? commit(mem, [[bag.addr + i * 4, enc(((v & ~(0x3ff << 10)) | (after << 10)) >>> 0)]], before, after)
        : commit(mem, [[bag.addr + i * 4 + 2, le16(after)]], before, after));
    }
    const rest = Array.from(bag.bytes.subarray((i + 1) * 4, bag.slots * 4));
    return then(commit(mem, [[bag.addr + i * 4, [...rest, 0, 0, 0, 0]]], before, after));
  }
  const { bag } = p;
  const key = L.kind === 'gba' ? bag.q(0) : 0; // the bag key's low half (0: no encryption)
  const encQ = (v) => le16((v ^ key) & 0xffff);
  if (after > 0) return then(commit(mem, [[bag.addr + i * 4 + 2, encQ(after)]], before, after));
  const rest = Array.from(bag.bytes.subarray((i + 1) * 4, bag.slots * 4));
  return then(commit(mem, [[bag.addr + i * 4, [...rest, 0, 0, ...encQ(0)]]], before, after));
}

/**
 * Is there room for `count` of `item` in `pocket` – all of it (on its stack within the game's stack size, else in a
 * free slot)? A gift is never added in part. null: the bag isn't readable right now.
 */
export function bagRoom(entry, read, state, item, count = 1, { pocket = null } = {}) {
  const L = layoutOf(entry);
  if (!L || !giftPocketsOf(L, entry).includes(pocket)) return null;
  const p = giftPocket(L, entry, read, state, pocket);
  if (!p) return null;
  const cap = L.kind === 'ds' || L.kind === 'ctr' ? 999 : 99;
  const s = p.slots.find((x) => x.item === item && x.count > 0);
  if (s) return s.count + count <= cap;
  if (count > cap) return false;
  // Gen 1/2: a list of at most 20 items (Gen 2's ball pocket 12); the others: an empty slot
  if (p.kind === 'gb') return p.n < (pocket === 'balls' ? 12 : 20);
  return p.slots.some((x) => !x.item);
}

/**
 * The version family of a game for gifts (shared/giftitems.mjs sameItems): the games that number every item alike –
 * 'rse' / 'frlg', 'dp' / 'platinum' / 'hgss', 'bw' / 'b2w2', 'xy' / 'oras' / 'sm' / 'usum', 'gb1' / 'gb2'; '' unknown.
 */
export function bagFamily(entry) {
  const L = layoutOf(entry);
  if (!L) return '';
  const id = String(entry.id || '').replace(/~.*$/, '');
  if (L.kind === 'gb') return `gb${entry.gen}`;
  if (L.kind === 'gba') return /^(firered|leafgreen)_/.test(id) ? 'frlg' : 'rse';
  if (L.kind === 'ctr') return entry.id;
  if (entry.gen === 5) return /^(black2|white2)_/.test(id) ? 'b2w2' : 'bw';
  return /^(heartgold|soulsilver)_/.test(id) ? 'hgss' : /^platinum_/.test(id) ? 'platinum' : 'dp';
}

/** Can this game take part in gifts at all (a known bag layout)? */
export const giftSupported = (entry) => !!layoutOf(entry);

// ---------------------------------------------------------------------------
// Poké Balls in the bag – the run rule "nothing counts before your first Poké Balls" (web/lib/run.mjs beforeBalls)
// starts the moment the player has one. Read with the same bag layouts and checks as the cheats.

/**
 * The ball items per generation (pret item constants, PKHeX): Gen 1 Master/Ultra/Great/Poké Ball 1–4 and the Safari
 * Ball 8 – one bag for everything; Gen 2 has a pocket of its own (anything in it is a ball); Gen 3 the Poké Ball pocket
 * (ids 1–12); Gen 4 its Poké Ball pocket; Gen 5–7 keep the balls with the items: 1–16, the Apricorn balls 492–500 (from
 * HeartGold/SoulSilver on), the Dream Ball 576 and the Beast Ball 851.
 */
const BALLS_GB1 = new Set([1, 2, 3, 4, 8]);
const isBall567 = (id) => (id >= 1 && id <= 16) || (id >= 492 && id <= 500) || id === 576 || id === 851;

/**
 * How many Poké Balls (of any kind) the player carries – or null when the bag can't be read right now (a game without
 * a known bag layout, a ROM hack on an expanded engine, the DS bag before live tracking found the save data, a read
 * that doesn't look like a bag). 0 is a bag read with no ball in it. `entry`, `read`, `state` as for addItem.
 */
export function readBalls(entry, read, state = null) {
  const L = layoutOf(entry);
  if (!L) return null;
  if (L.kind === 'gb') {
    if (entry.gen === 1) {
      const bag = gbBag(L, 1, read);
      if (!bag) return null;
      let n = 0;
      for (let i = 0; i < bag.n; i++) if (BALLS_GB1.has(bag.bytes[1 + i * 2])) n += bag.bytes[2 + i * 2];
      return n;
    }
    // Gen 2: the bag must read as a bag (items, key items), then the ball pocket behind the key items
    if (!gbBag(L, 2, read)) return null;
    const bag = gbBag(gbBalls(L), 2, read);
    if (!bag) return null;
    let n = 0;
    for (let i = 0; i < bag.n; i++) n += bag.bytes[2 + i * 2];
    return n;
  }
  if (L.kind === 'ctr') {
    // (an empty bag counts where the game's pocket table vouches for it: 0 balls; a bag elsewhere: once
    // locateCtrBag has found it)
    const bag = ctrFind(L, entry, read, state, 'items');
    if (!bag) return null;
    let n = 0;
    for (let i = 0; i < bag.slots; i++) {
      const v = bag.slot(i);
      if (isBall567(bag.idOf(v))) n += bag.countOf(v);
    }
    return n;
  }
  if (L.kind === 'gba') {
    const G = L.found ? (state?.sb1PtrAddr ? { ...L, sb1Ptr: state.sb1PtrAddr, sb2Ptr: state.sb1PtrAddr + 4 } : null) : L;
    const bag = G && gbaBag(G, read, 'balls');
    if (!bag) return null;
    let n = 0;
    for (let i = 0; i < bag.slots; i++) if (u16le(bag.bytes, i * 4)) n += bag.q(u16le(bag.bytes, i * 4 + 2));
    return n;
  }
  // Gen 4: the Poké Ball pocket (a fresh game's bag is empty – accepted where the save data came from its pointer);
  // Gen 5: the balls among the items
  const bag = dsBag(L, entry, read, state, L.pockets.balls ? 'balls' : 'items', !!state?.saveBase);
  if (!bag) return null;
  let n = 0;
  for (let i = 0; i < bag.slots; i++) {
    const id = u16le(bag.bytes, i * 4);
    if (id && (L.gen === 4 || isBall567(id))) n += u16le(bag.bytes, i * 4 + 2);
  }
  return n;
}
