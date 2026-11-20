// Pokémon Quetzal (TohmaRH's pokeemerald-based hack: Pokémon of every generation and its own, a 32 MB ROM). Its header
// still says Emerald – game code BPEE, version 0 – and only the title tells it apart ("PKM QUETZAL"), so it is recognised
// by that title (shared/live/parse.mjs findEntry, server/lib/library.mjs) and never read as Emerald: its party struct,
// its save blocks and its bag are laid out its own way. Everything below was measured in the running game (English
// Alpha 9v1, a new game: the starter, the rival's battle in Pallet Town, a wild Pidgey caught on Route 1) – the
// addresses themselves are in shared/data/addresses.json (quetzal_en).

/** The header the hack keeps: Emerald's game code, a title of its own. */
export const QUETZAL_HEADER = Object.freeze({ system: 'gba', code: 'BPEE', title: 'PKM QUETZAL' });

/**
 * Is this header (a ROM's, a run manifest's game, a live bridge's HELLO – { system | platform, code, title }) Pokémon
 * Quetzal? A run made before souldew knew the hack has the same header in its manifest.
 */
export function isQuetzal(h) {
  if (!h) return false;
  const sys = String(h.system || h.platform || '').toLowerCase();
  if (sys && sys !== 'gba') return false;
  return String(h.code || '').trim().toUpperCase() === QUETZAL_HEADER.code && String(h.title || '').trim().toUpperCase() === QUETZAL_HEADER.title;
}

/** The catalog id of the hack (shared/data/catalog.json). */
export const QUETZAL_HACK_ID = 'quetzal';

/** A party Pokémon in Quetzal: 104 bytes (the base game's 100). */
export const QUETZAL_PK3_SIZE = 104;

/**
 * One of Quetzal's 104-byte party structs as the 100-byte layout the Gen 3 readers know – the one of an engine that
 * stores the data block unencrypted (shared/live/parse.mjs plainPk3: checksum 0, Growth/Attacks/EVs/Misc in that order).
 * Quetzal's, measured:
 *   +0x00 personality, +0x04 OT ID, +0x08 nickname (10), +0x12 language, +0x13 flags (has species 0x02, egg 0x04),
 *   +0x14 OT name (7), +0x1B markings, +0x1C checksum (0)                                     – as in the base game
 *   +0x20…0x27 packed: current HP = byte 0x23 | (byte 0x24 & 3) << 8 | (byte 0x22 >> 6) << 10, the status condition
 *     = (u16 at 0x24 >> 2) & 0xFF (sleep turns 1–7, poison 0x08, burn 0x10, freeze 0x20, paralysis 0x40, bad poison
 *     0x80) – both found by writing them and reading the party menu (19/19 → 7/19, 10/19, 261/19, 517/19; SLP, PSN,
 *     BRN, PAR) and by the rival's Squirtle losing HP (13 → 7 → 0)
 *   +0x28 the data block, 48 bytes, unencrypted, always Growth, Attacks, EVs, Misc (Sprigatito: species 1214, Scratch,
 *     Tail Whip, Leafage; met in Pallet Town at level 5)
 *   +0x58 level, +0x59 mail, +0x5A max HP, +0x5C Attack, Defense, Speed, Sp. Atk, Sp. Def (u16 each), to 0x66
 * The second Pokémon of a team starts 104 bytes after the first (the starter and a Pidgey caught on Route 1).
 */
export function quetzalPk3(d) {
  const out = new Uint8Array(100);
  if (!d || d.length < QUETZAL_PK3_SIZE) return out;
  out.set(d.subarray(0, 0x20), 0);
  out.set(d.subarray(0x28, 0x58), 0x20);
  const hp = d[0x23] | ((d[0x24] & 3) << 8) | ((d[0x22] >> 6) << 10);
  const status = ((d[0x24] | (d[0x25] << 8)) >> 2) & 0xff;
  out[0x50] = status;
  out[0x54] = d[0x58];
  out[0x55] = d[0x59];
  out[0x56] = hp & 0xff;
  out[0x57] = hp >> 8;
  // max HP and the five stats, in the base game's order
  out.set(d.subarray(0x5a, 0x66), 0x58);
  return out;
}

/** The struct layout for shared/live/parse.mjs LiveTables (T.pk3). */
export const QUETZAL_PK3 = Object.freeze({ id: 'quetzal', size: QUETZAL_PK3_SIZE, conv: quetzalPk3 });
