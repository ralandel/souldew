// Gifts between the players of a run (docs/MULTIPLAYER.md › 9 "Playing together"): which items of a bag may be given.
//
// The bag is read and written through the cheats' layouts (shared/live/cheats.mjs bagItems / removeItem / addItem) –
// the same checks: nothing is touched unless the memory looks exactly like a bag. This module only decides what may
// change hands, the same on both computers (the receiver checks again):
//
//  - only the pockets of ordinary items: Items, Medicine, Poké Balls, Berries where the game keeps them apart. Key items
//    and TMs/HMs live in pockets of their own from Gen 2 on and are never read. TMs are one-of-a-kind rewards in Gen 1–4
//    (used up when taught), and in Gen 5+ a TM given away would be gone from the giver's game for good – neither is a
//    gift that keeps a run fair, so none of them;
//  - Gen 1 has one bag for everything: only the items on the list below (no key items, no badges, no fossils – a fossil
//    is a Pokémon waiting to be revived –, no HMs or TMs, no Safari Balls that only work in the Safari Zone);
//  - never the Master Ball (item 1 in every generation): each game has one, and passing it around would let one player
//    catch two legendaries without a fight;
//  - Gen 1/2 item numbers differ between the two generations, so a gift only goes to a game of the same generation
//    (the run's games are, but the receiver checks it), and only an item souldew knows by name.

/** Master Ball: item 1 from Gen 1 to Gen 7. */
export const MASTER_BALL = 1;

/**
 * Gen 1 and 2 items souldew may give, by the game's item number → PokeAPI identifier (pret pokered / pokecrystal
 * constants/item_constants.asm, checked against PokeAPI's item_game_indices – where those two disagree, pret is right:
 * Gen 2 0x15 is MAX_ELIXER). The names come from shared/data/pokeapi.json by the identifier (web/lib/data.mjs itemName).
 */
export const GB_GIFT_ITEMS = {
  1: {
    0x02: 'ultra-ball', 0x03: 'great-ball', 0x04: 'poke-ball', 0x0a: 'moon-stone', 0x0b: 'antidote', 0x0c: 'burn-heal', 0x0d: 'ice-heal',
    0x0e: 'awakening', 0x0f: 'paralyze-heal', 0x10: 'full-restore', 0x11: 'max-potion', 0x12: 'hyper-potion', 0x13: 'super-potion',
    0x14: 'potion', 0x1d: 'escape-rope', 0x1e: 'repel', 0x20: 'fire-stone', 0x21: 'thunder-stone', 0x22: 'water-stone', 0x23: 'hp-up',
    0x24: 'protein', 0x25: 'iron', 0x26: 'carbos', 0x27: 'calcium', 0x28: 'rare-candy', 0x2e: 'x-accuracy', 0x2f: 'leaf-stone',
    0x31: 'nugget', 0x33: 'poke-doll', 0x34: 'full-heal', 0x35: 'revive', 0x36: 'max-revive', 0x37: 'guard-spec', 0x38: 'super-repel',
    0x39: 'max-repel', 0x3a: 'dire-hit', 0x3c: 'fresh-water', 0x3d: 'soda-pop', 0x3e: 'lemonade', 0x41: 'x-attack', 0x42: 'x-defense',
    0x43: 'x-speed', 0x44: 'x-sp-atk', 0x4f: 'pp-up', 0x50: 'ether', 0x51: 'max-ether', 0x52: 'elixir', 0x53: 'max-elixir',
  },
  2: {
    0x02: 'ultra-ball', 0x03: 'bright-powder', 0x04: 'great-ball', 0x05: 'poke-ball', 0x08: 'moon-stone', 0x09: 'antidote', 0x0a: 'burn-heal',
    0x0b: 'ice-heal', 0x0c: 'awakening', 0x0d: 'paralyze-heal', 0x0e: 'full-restore', 0x0f: 'max-potion', 0x10: 'hyper-potion',
    0x11: 'super-potion', 0x12: 'potion', 0x13: 'escape-rope', 0x14: 'repel', 0x15: 'max-elixir', 0x16: 'fire-stone', 0x17: 'thunder-stone',
    0x18: 'water-stone', 0x1a: 'hp-up', 0x1b: 'protein', 0x1c: 'iron', 0x1d: 'carbos', 0x1e: 'lucky-punch', 0x1f: 'calcium',
    0x20: 'rare-candy', 0x21: 'x-accuracy', 0x22: 'leaf-stone', 0x23: 'metal-powder', 0x24: 'nugget', 0x25: 'poke-doll', 0x26: 'full-heal',
    0x27: 'revive', 0x28: 'max-revive', 0x29: 'guard-spec', 0x2a: 'super-repel', 0x2b: 'max-repel', 0x2c: 'dire-hit', 0x2e: 'fresh-water',
    0x2f: 'soda-pop', 0x30: 'lemonade', 0x31: 'x-attack', 0x33: 'x-defense', 0x34: 'x-speed', 0x35: 'x-sp-atk', 0x39: 'exp-share',
    0x3c: 'silver-leaf', 0x3e: 'pp-up', 0x3f: 'ether', 0x40: 'max-ether', 0x41: 'elixir', 0x48: 'moomoo-milk', 0x49: 'quick-claw',
    0x4a: 'pecha-berry', 0x4b: 'gold-leaf', 0x4c: 'soft-sand', 0x4d: 'sharp-beak', 0x4e: 'cheri-berry', 0x4f: 'aspear-berry',
    0x50: 'rawst-berry', 0x51: 'poison-barb', 0x52: 'kings-rock', 0x53: 'persim-berry', 0x54: 'chesto-berry', 0x55: 'red-apricorn',
    0x56: 'tiny-mushroom', 0x57: 'big-mushroom', 0x58: 'silver-powder', 0x59: 'blue-apricorn', 0x5b: 'amulet-coin', 0x5c: 'yellow-apricorn',
    0x5d: 'green-apricorn', 0x5e: 'cleanse-tag', 0x5f: 'mystic-water', 0x60: 'twisted-spoon', 0x61: 'white-apricorn', 0x62: 'black-belt',
    0x63: 'black-apricorn', 0x65: 'pink-apricorn', 0x66: 'black-glasses', 0x67: 'slowpoke-tail', 0x68: 'silk-scarf', 0x69: 'stick',
    0x6a: 'smoke-ball', 0x6b: 'never-melt-ice', 0x6c: 'magnet', 0x6d: 'lum-berry', 0x6e: 'pearl', 0x6f: 'big-pearl', 0x70: 'everstone',
    0x71: 'spell-tag', 0x72: 'rage-candy-bar', 0x75: 'miracle-seed', 0x76: 'thick-club', 0x77: 'focus-band', 0x79: 'energy-powder',
    0x7a: 'energy-root', 0x7b: 'heal-powder', 0x7c: 'revival-herb', 0x7d: 'hard-stone', 0x7e: 'lucky-egg', 0x83: 'stardust',
    0x84: 'star-piece', 0x8a: 'charcoal', 0x8b: 'berry-juice', 0x8c: 'scope-lens', 0x8f: 'metal-coat', 0x90: 'dragon-fang',
    0x92: 'leftovers', 0x96: 'leppa-berry', 0x97: 'dragon-scale', 0x9c: 'sacred-ash', 0x9d: 'heavy-ball', 0x9f: 'level-ball',
    0xa0: 'lure-ball', 0xa1: 'fast-ball', 0xa3: 'light-ball', 0xa4: 'friend-ball', 0xa5: 'moon-ball', 0xa6: 'love-ball', 0xa9: 'sun-stone',
    0xac: 'up-grade', 0xad: 'oran-berry', 0xae: 'sitrus-berry',
  },
};

/** The most of one item a single gift moves (the smallest stack any game allows). */
export const GIFT_MAX = 99;

/** Pocket names a gift may come from (shared/live/cheats.mjs layouts; null: Gen 1's one bag). */
export const GIFT_POCKETS = [null, 'items', 'medicine', 'balls', 'berries'];

/**
 * May item `id` of generation `gen`, from `pocket`, be given? (The pocket list itself – no key items, no TMs – is
 * cheats.mjs bagItems'; this is the rest of the rules above.)
 */
export function giftable(gen, id, pocket = null) {
  if (!Number.isInteger(gen) || gen < 1 || gen > 7 || !Number.isInteger(id) || id <= 0 || id === MASTER_BALL) return false;
  if (!GIFT_POCKETS.includes(pocket ?? null)) return false;
  if (gen <= 2) return !!GB_GIFT_ITEMS[gen][id];
  return pocket !== null;
}

/** The PokeAPI identifier of a Gen 1/2 item souldew may give (its name), or ''. */
export const gbItemKey = (gen, id) => GB_GIFT_ITEMS[gen]?.[id] || '';

/**
 * Do two games number this item alike? Within a generation the common items keep their numbers, but the later
 * versions add items the earlier ones don't have (HeartGold's balls and berries in Diamond, Black 2's in Black, Ultra
 * Moon's in Sun …): so from Gen 4 on a gift only goes between games of the same version family. Gen 3: Ruby, Sapphire,
 * Emerald, FireRed and LeafGreen share every item up to 348 – the ones after are key items (never given). Gen 1/2: the
 * three games of a generation number them alike. `fam`: shared/live/cheats.mjs bagFamily.
 */
export function sameItems(gen, famA, famB, item) {
  if (!famA || !famB || famA === famB) return true;
  if (gen <= 2) return true;
  if (gen === 3) return item <= 348;
  return false;
}

/** A bag read by cheats.mjs bagItems → what may be given from it: [{ item, count, pocket }], each item once. */
export function giftList(gen, items) {
  const seen = new Set();
  const out = [];
  for (const it of items || []) {
    if (!it || !giftable(gen, it.item, it.pocket ?? null) || !(it.count > 0)) continue;
    const k = `${it.pocket ?? ''}:${it.item}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ item: it.item, count: it.count, pocket: it.pocket ?? null });
  }
  return out;
}
