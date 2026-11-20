// A raid's view of a running trainer battle, and the writes that put the shared pool into the game
// (docs/MULTIPLAYER.md › "Raid", shared/raid.mjs). One driver per engine, each checked in the running game:
//
//   view(read)        → null outside a trainer battle the raid can use, else { trainer, quiet, key, trainerId, foes,
//                       active, hud }: the opponent's whole party (idx, hp, maxHp, species, level), who is out, whether
//                       the game waits for the player's action right now (`quiet` – the only time souldew writes), and
//                       whether the HP bar on screen shows the HP the game holds (`hud`: false = draw it again)
//   writes(v, idx, hp) → [{ addr, bytes }]: the battle copy of the one out, the party copy, and the HP bar where the
//                       game keeps it in RAM (Game Boy: the tile map and its saved copy)
//
// Never written: 0 HP into the opponent that is out (shared/raid.mjs keeps it at 1 – the game's next hit knocks it out
// itself), anything outside a trainer battle, anything in a link battle. `read` is the page's memory mirror; the
// writes go through the cheat path (the fast player's WRITE between two frames) and are read back by the caller.
//
// Addresses: pret symbol files (pokered/pokeyellow/pokecrystal/pokeemerald/pokefirered `symbols` branches), every one
// used here checked in the running game (see the per-engine notes).

/** The systems whose games can take part in raids at all (which game exactly: raidSupport). */
export const RAID_SYSTEMS = ['gb', 'gbc', 'gba', 'nds'];

import { DS_DRIVERS } from './raidds.mjs';

const hex = (v) => (typeof v === 'number' ? v : Number(v));
const be16 = (b, o = 0) => (b[o] << 8) | b[o + 1];
const le16 = (b, o = 0) => b[o] | (b[o + 1] << 8);
const le32 = (b, o = 0) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const bytesBE = (n) => Uint8Array.of((n >> 8) & 0xff, n & 0xff);
const bytesLE = (n) => Uint8Array.of(n & 0xff, (n >> 8) & 0xff);
const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);

// ---- Game Boy (Gen 1 and 2) -------------------------------------------------------------------------------------
//
// The battle copy (wEnemyMon) is what the battle uses: damage is taken off it, the faint check reads it, the HUD is
// drawn from it. The party copy (wEnemyMons / wOTPartyMons) is what the next one sent out starts with – and a 0 there
// is a Pokémon the trainer can't send out any more. The HP bar is tiles in the tile map (wTileMap / wTilemap): the
// game draws it there from the battle copy at the start of every turn's menu, and souldew draws the same tiles
// (DrawHPBar / DrawBattleHPBar: "HP:", six 8-pixel tiles, the end) when it writes – so the bar shows the new value at
// once instead of at the next hit.
//
// Quiet: the battle menu (FIGHT / PKMN / ITEM / RUN) is up – its menu parameters are set (Gen 1 wTopMenuItemY/X,
// wMaxMenuItem; Gen 2 the 2D menu's) – and the bar on screen shows the battle copy's HP (no HP bar animation runs).

/** Pixels of a 48-pixel HP bar (pokered DrawEnemyHUDAndHPBar / pokecrystal DrawEnemyHUD): a sliver for any HP left. */
export function gbBarPixels(hp, maxHp) {
  if (!(hp > 0) || !(maxHp > 0)) return 0;
  let p = hp * 48;
  let m = maxHp;
  if (m > 255) {
    m >>= 2;
    p >>= 2;
  }
  const px = Math.floor(p / (m & 0xff || 1)) & 0xff;
  return px || 1;
}

/** The HP bar's tiles as the game draws them: [hp, colon, 6 × bar, end]. */
export function gbBarTiles(gen, hp, maxHp) {
  const px = gbBarPixels(hp, maxHp);
  const T = gen === 1 ? { a: 0x71, b: 0x62, empty: 0x63, full: 0x6b, end: 0x6c } : { a: 0x60, b: 0x61, empty: 0x62, full: 0x6a, end: 0x6b };
  const out = [T.a, T.b];
  for (let i = 0; i < 6; i++) {
    const f = Math.max(0, Math.min(8, px - i * 8));
    out.push(f === 8 ? T.full : T.empty + f);
  }
  out.push(T.end);
  return Uint8Array.from(out);
}

const GB_TABLES = {
  // pokered.sym (Red and Blue share every address)
  red: {
    gen: 1, inBattle: 0xd057, link: 0xd12b, enemyHp: 0xcfe6, enemyMaxHp: 0xcff4, enemySpecies: 0xcfe5, enemyLevel: 0xcff3,
    partyPos: 0xcfe8, partyCount: 0xd89c, party: 0xd8a4, size: 44, pHp: 1, pMax: 0x22, pLevel: 0x21, pSpecies: 0,
    trainerClass: 0xd031, trainerNo: 0xd05d, battleType: 0xd05a,
    bar: [0xc3a0 + 2 * 20 + 2, 0xc508 + 2 * 20 + 2], // wTileMap and wTileMapBackup (SaveScreenTilesToBuffer1) at hlcoord 2, 2
    menu: 0xcc24, // wTopMenuItemY, wTopMenuItemX, wCurrentMenuItem, wTileBehindCursor, wMaxMenuItem, wMenuWatchedKeys
  },
};

GB_TABLES.crystal = {
  // pokecrystal.sym
  gen: 2, inBattle: 0xd22d, link: 0xc2dc, enemyHp: 0xd216, enemyMaxHp: 0xd218, enemySpecies: 0xd206, enemyLevel: 0xd213,
  partyPos: 0xc663, partyCount: 0xd280, party: 0xd288, size: 0x30, pHp: 0x22, pMax: 0x24, pLevel: 0x1f, pSpecies: 0,
  trainerClass: 0xd22f, trainerNo: 0xd231,
  // wTilemap at hlcoord 2, 2 – the saved screen (wTempTilemap) is in WRAM bank 2, which souldew can't reach: the move
  // menu brings back the bar of the turn's start, and souldew draws it again while the menu waits (typeBox)
  bar: [0xc4a0 + 2 * 20 + 2],
  menu2d: 0xcfa1, // w2DMenuCursorInitY, w2DMenuCursorInitX, w2DMenuNumRows, w2DMenuNumCols
  // the move menu's "TYPE/" box (hlcoord 1, 9) – only there while the move menu waits for the player
  typeBox: { addr: 0xc4a0 + 9 * 20 + 1, tiles: [0x93, 0x98, 0x8f, 0x84, 0xf3] },
};

function gbTable(entry) {
  if (entry?.id === 'red_us' || entry?.id === 'blue_us') return GB_TABLES.red;
  if (entry?.id === 'crystal_us') return GB_TABLES.crystal;
  return null;
}

/**
 * The game waits for the player's action. Gen 1: the battle menu is up (DisplayBattleMenu: top item row 14, column 9
 * or 15, two rows) – the move menu's parameters stay while the move runs, so it doesn't count. Gen 2: the battle menu
 * (the 2D menu at row 14, column 9, 2 × 2) or the move menu with its "TYPE/" box on screen.
 */
function gbQuiet(T, read) {
  if (T.gen === 1) {
    const m = read(T.menu, 6);
    return !!m && m[0] === 0x0e && (m[1] === 9 || m[1] === 15) && m[4] === 1;
  }
  const m = read(T.menu2d, 4);
  if (m && m[0] === 0x0e && m[1] === 9 && m[2] === 2 && m[3] === 2) return true;
  return same(read(T.typeBox.addr, 5), Uint8Array.from(T.typeBox.tiles));
}

function viewGB(entry, read, T) {
  const inb = read(T.inBattle, 1)?.[0];
  if (inb !== 2) return null; // 1 wild, 2 trainer, 0xFF lost
  if (read(T.link, 1)?.[0]) return null; // a link battle: never
  const count = read(T.partyCount, 1)?.[0];
  if (!(count >= 1 && count <= 6)) return null;
  const party = read(T.party, T.size * count);
  const pos = read(T.partyPos, 1)?.[0];
  const ehp = read(T.enemyHp, 2);
  const emax = read(T.enemyMaxHp, 2);
  if (!party || pos === undefined || pos >= count || !ehp || !emax) return null;
  const foes = [];
  for (let i = 0; i < count; i++) {
    const o = i * T.size;
    const maxHp = be16(party, o + T.pMax);
    let hp = be16(party, o + T.pHp);
    if (i === pos) {
      // the one out: the battle copy (its max must be the party's – else the struct isn't this battle's yet)
      if (be16(emax) !== maxHp) return null;
      hp = be16(ehp);
    }
    if (!(maxHp > 0) || hp > maxHp) return null;
    foes.push({ idx: i, hp, maxHp, species: party[o + T.pSpecies], level: party[o + T.pLevel] });
  }
  const cls = read(T.trainerClass, 1)?.[0] ?? 0;
  const no = read(T.trainerNo, 1)?.[0] ?? 0;
  const bar = read(T.bar[0], 9);
  return {
    trainer: true, quiet: gbQuiet(T, read), hud: same(bar, gbBarTiles(T.gen, foes[pos].hp, foes[pos].maxHp)), key: `${cls}:${no}:${count}:${foes.map((f) => `${f.species}/${f.maxHp}`).join(',')}`,
    trainerId: (cls << 8) | no, foes, active: [pos],
  };
}

function writesGB(T, v, idx, hp) {
  const out = [];
  const f = v.foes.find((x) => x.idx === idx);
  if (!f) return out;
  if (v.active.includes(idx)) {
    out.push({ addr: T.enemyHp, bytes: bytesBE(hp) });
    // the bar, where the game keeps it (and its saved copy, which the move menu brings back)
    for (const a of T.bar) out.push({ addr: a, bytes: gbBarTiles(T.gen, hp, f.maxHp) });
  }
  out.push({ addr: T.party + idx * T.size + T.pHp, bytes: bytesBE(hp) });
  return out;
}

// ---- Game Boy Advance (Gen 3) ------------------------------------------------------------------------------------
//
// gBattleMons[battler] (0x58 bytes: species +0, HP +0x28, level +0x2A, max HP +0x2C, personality +0x48) is what the
// battle uses; battler 1 is the opponent's (3 the second one in a double battle), gBattlerPartyIndexes says which of
// gEnemyParty it is. The party struct (100 bytes) keeps HP at +0x56 and max HP at +0x58 outside its encrypted part (no
// checksum covers them); the battle writes the battler's HP there with every hit, and a Pokémon sent out starts from it.
// The opponent's HP bar is a sprite the game redraws only when HP changes in a move – it animates from the party
// struct's HP to the new value. So a pool written while the game waits shows on the bar with that Pokémon's next HP
// change (the animation starts from the shared value); the bar never ends on a wrong value (checked in FireRed:
// written 10/19, Scratch → the bar went to 6/19, the game's own numbers). souldew's raid bar shows the pool meanwhile.
//
// Quiet: gBattleMainFunc is HandleTurnActionSelectionState and the player's battler waits in HandleInputChooseAction /
// HandleInputChooseMove (the player controller's, or FireRed's Oak / old man controller in the first rival battle) –
// ROM addresses per revision from the pret symbol files.

const GBA_TABLES = {
  // pokefirered.sym (FireRed / LeafGreen, rev 0 and 1: the same RAM, the code's addresses per revision)
  frlg: {
    battleMons: 0x02023be4, partyIndexes: 0x02023bce, enemyParty: 0x0202402c, typeFlags: 0x02022b4c, opponent: 0x020386ae,
    mainFunc: 0x03004f84, controllerFuncs: 0x03004fe0,
    actionSelection: [0x08014040, 0x08014054], // HandleTurnActionSelectionState: FR/LG rev 0, rev 1
    // the opponent's controller idle (OpponentBufferRunCommand) → its HP bar handler (OpponentHandleHealthBarUpdate),
    // per revision (FR and LG share these)
    barCmd: { 0x08035a98: 0x08038844, 0x08035aac: 0x08038858 },
    firstBattleOak: true, // FR/LG: the first rival battle's Oak shows his text after the first HP bar update (once)
    choose: [
      0x0802e438, 0x0802ea10, 0x080e763c, 0x080e7988, // FireRed rev 0: player (action, move), Oak / old man (action, move)
      0x0802e44c, 0x0802ea24, 0x080e7650, 0x080e799c, // FireRed rev 1
      0x080e7614, 0x080e7960, // LeafGreen rev 0 (its player controller's are FireRed rev 0's)
      0x080e7628, 0x080e7974, // LeafGreen rev 1 (player: FireRed rev 1's)
    ],
  },
  // pokeemerald.sym (Emerald US/EU rev 0)
  emerald: {
    battleMons: 0x02024084, partyIndexes: 0x0202406e, enemyParty: 0x02024744, typeFlags: 0x02022fec, opponent: 0x02038bca,
    mainFunc: 0x03005d04, controllerFuncs: 0x03005d60,
    actionSelection: [0x0803be74],
    choose: [0x08057588, 0x08057bfc],
    barCmd: { 0x0805f180: 0x08062294 },
  },
};
GBA_TABLES.frlg.bufferA = 0x02022bc4;
GBA_TABLES.frlg.battleStruct = 0x02023fe8; // gBattleStruct (a pointer)
GBA_TABLES.emerald.bufferA = 0x02023064;
const CONTROLLER_HEALTHBARUPDATE = 24;
const FIRST_BATTLE = 0x10;
const BMON = { size: 0x58, species: 0, hp: 0x28, level: 0x2a, maxHp: 0x2c, pid: 0x48 };
// gBattleTypeFlags: DOUBLE, LINK, TRAINER, … – raids only in a trainer battle that isn't a link, a recorded one, the
// Safari Zone's or one of the challenge facilities' (`facility`, per game: the bits above 8 differ – pokeemerald and
// pokefirered include/constants/battle.h). The same bits as the live reader's (shared/live/parse.mjs: bit 16 is
// Emerald's Battle Dome and FireRed's Poké Dude).
const BT = { double: 0x01, link: 0x02, trainer: 0x08, safari: 0x80, recorded: 0x01000000 };
// Emerald: BATTLE_TYPE_FRONTIER – BATTLE_TOWER (1 << 8), DOME 16, PALACE 17, ARENA 18, FACTORY 19, PIKE 20, PYRAMID 21
// (bit 22 is INGAME_PARTNER: Steven at the Space Center – an ordinary trainer battle)
GBA_TABLES.emerald.facility = 0x100 | 0x10000 | 0x20000 | 0x40000 | 0x80000 | 0x100000 | 0x200000;
// FireRed/LeafGreen: BATTLE_TOWER (1 << 8, never set) and TRAINER_TOWER (1 << 19, the Sevii Islands' challenge)
GBA_TABLES.frlg.facility = 0x100 | 0x80000;

function gbaTable(entry) {
  if (entry?.id === 'firered_us' || entry?.id === 'leafgreen_us') return GBA_TABLES.frlg;
  if (entry?.id === 'emerald_us') return GBA_TABLES.emerald;
  return null;
}

/** FR/LG's first battle: Oak's "Inflicting damage…" lesson already shown (gBattleStruct->simulatedInputState[2] bit 0,
 *  set after the first HP bar update – measured in FireRed: 0 before the first hit, 1 after). */
function oakDone(T, read) {
  const p = read(T.battleStruct, 4);
  const at = p ? le32(p) : 0;
  const b = at >= 0x02000000 && at < 0x02040000 ? read(at + 0x96, 1) : null;
  return !!b && (b[0] & 1) === 1;
}

function viewGBA(entry, read, state, T) {
  // gMain.inBattle (gBattleTypeFlags stays as it was after the battle)
  const ib = entry.inBattle ? read(hex(entry.inBattle.addr), 1)?.[0] : undefined;
  if (ib === undefined || !(ib & hex(entry.inBattle.mask || '0x02'))) return null;
  const tf = read(T.typeFlags, 4);
  if (!tf) return null;
  const flags = le32(tf);
  if (!(flags & BT.trainer) || flags & (BT.link | BT.safari | BT.recorded | (T.facility || 0))) return null;
  const raw = read(T.enemyParty, 600);
  const idx = read(T.partyIndexes, 8);
  const bm = read(T.battleMons, BMON.size * 4);
  if (!raw || !idx || !bm) return null;
  const foes = [];
  for (let i = 0; i < 6; i++) {
    const o = i * 100;
    const pid = le32(raw, o);
    const level = raw[o + 0x54];
    const hp = le16(raw, o + 0x56);
    const maxHp = le16(raw, o + 0x58);
    if (!pid && !maxHp) break; // (the party ends with an empty struct)
    if (!(maxHp > 0) || hp > maxHp || !(level >= 1 && level <= 100)) return null;
    foes.push({ idx: i, hp, maxHp, level, pid });
  }
  if (!foes.length) return null;
  // who is out: battler 1 (and 3 in a double battle) – its HP from the battle struct, once it is this battle's
  const active = [];
  for (const b of flags & BT.double ? [1, 3] : [1]) {
    const pi = le16(idx, b * 2);
    const f = foes[pi];
    if (!f) continue;
    const o = b * BMON.size;
    if (le32(bm, o + BMON.pid) !== f.pid || le16(bm, o + BMON.maxHp) !== f.maxHp) continue; // (not sent out yet)
    f.hp = le16(bm, o + BMON.hp);
    f.battler = b;
    active.push(pi);
  }
  if (!active.length) return null; // the battle is being set up (or a Pokémon is being sent out)
  const main = read(T.mainFunc, 4);
  const ctl = read(T.controllerFuncs, 16);
  const mf = main ? le32(main) & ~1 : 0;
  // (and every opponent controller idle: not in the middle of an HP bar update – also one souldew asked for)
  const idle = !!ctl && active.every((pi) => !!T.barCmd[le32(ctl, foes[pi].battler * 4) & ~1]);
  const quiet = T.actionSelection.includes(mf) && !!ctl && T.choose.includes(le32(ctl) & ~1) && idle;
  // (a revision souldew has no address for never reads as waiting: no writes at all – raidhp's callers notice)
  if (T.actionSelection.includes(mf)) state.g3known = true;
  const opp = read(T.opponent, 2);
  return {
    trainer: true, quiet, key: `${opp ? le16(opp) : 0}:${foes.map((f) => f.pid.toString(16)).join(',')}`, trainerId: opp ? le16(opp) : null,
    foes: foes.map(({ pid, battler, ...f }) => f), active, battlers: Object.fromEntries(foes.filter((f) => f.battler).map((f) => [f.idx, f.battler])),
    // the bar: the game's own HP bar update for that battler – not in FR/LG's first rival battle (Oak's lesson would
    // start right in the action menu), only with the opponent's controller idle
    bar: !(T.firstBattleOak && flags & FIRST_BATTLE) || oakDone(T, read),
  };
}

/**
 * The writes for opponent `idx`. The one out: the battle struct's HP; then – the bar redrawn the game's own way – the
 * opponent controller's HP bar command (gBattleBufferA: CONTROLLER_HEALTHBARUPDATE with the change as the battle
 * script sends it after a hit, positive = damage) and the controller pointed at its handler, which slides the bar
 * from the party struct's HP by that much and goes back to idle; the party struct's HP only after that (`wait`: the
 * caller waits until the controller is idle again). Without the bar command (FR/LG's first battle, a busy controller):
 * the party struct right away – the bar then catches up with the next hit (it animates from the party struct's HP).
 */
function writesGBA(T, v, idx, hp, read) {
  const out = [];
  const f = v.foes.find((x) => x.idx === idx);
  if (!f) return out;
  const party = { addr: T.enemyParty + idx * 100 + 0x56, bytes: bytesLE(hp) };
  const b = v.battlers?.[idx];
  if (!v.active.includes(idx) || !b) return [party];
  out.push({ addr: T.battleMons + b * BMON.size + BMON.hp, bytes: bytesLE(hp) });
  const raw = read(T.enemyParty + idx * 100 + 0x56, 2);
  const shown = raw ? le16(raw) : null; // what the bar shows: the party struct's HP (the last bar update went there)
  const ctl = read(T.controllerFuncs + b * 4, 4);
  const idle = ctl ? le32(ctl) : 0;
  const handler = T.barCmd[idle & ~1];
  if (v.bar && handler && shown !== null && shown !== hp && shown <= f.maxHp) {
    const d = (shown - hp) & 0xffff;
    out.push({ addr: T.bufferA + b * 0x200, bytes: Uint8Array.of(CONTROLLER_HEALTHBARUPDATE, 0, d & 0xff, d >> 8) });
    out.push({ addr: T.controllerFuncs + b * 4, bytes: Uint8Array.of((handler | 1) & 0xff, (handler >> 8) & 0xff, (handler >> 16) & 0xff, handler >>> 24) });
    out.push({ ...party, wait: { addr: T.controllerFuncs + b * 4, value: idle, ms: 4000 } });
    return out;
  }
  out.push(party);
  return out;
}

// ---- the drivers ---------------------------------------------------------------------------------------------------

const DRIVERS = [
  {
    id: 'gb',
    table: gbTable,
    view: (entry, read, state, T) => viewGB(entry, read, T),
    writes: (entry, read, state, T, v, idx, hp) => writesGB(T, v, idx, hp),
  },
  {
    id: 'gba',
    table: gbaTable,
    view: (entry, read, state, T) => viewGBA(entry, read, state, T),
    writes: (entry, read, state, T, v, idx, hp) => writesGBA(T, v, idx, hp, read),
  },
  ...DS_DRIVERS,
];

/** A game found by its family or a search, or a hack whose memory moved (Crystal Legacy keeps crystal_us, the Gen 3
 *  hacks searched for keep their base game's id): the tables' addresses aren't its – the same test as linkbattle's
 *  gameOfEntry. */
const movedGame = (entry) => !!(String(entry?.id || '').includes('~') || entry?.scan3 || entry?.scanOnly || entry?.wram?.delta);

function driverOf(entry) {
  if (movedGame(entry)) return null;
  for (const d of DRIVERS) {
    const T = d.table(entry);
    if (T) return { d, T };
  }
  return null;
}

/**
 * Can this game take part in a raid? { ok: true } or { ok: false, why } – why: 'gen5' | 'ctr' | 'version' | 'hack' | 'unknown'
 * (the reasons the UI explains: a generation souldew can't write cleanly, another language / revision not checked).
 */
export function raidSupport(entry) {
  if (!entry) return { ok: false, why: 'unknown' };
  // a ROM hack with a memory-table entry of its own (Pokémon Quetzal: addresses.json `hack`) – its battles aren't the
  // base game's: never written to
  if (entry.hack || movedGame(entry)) return { ok: false, why: 'hack' };
  if (driverOf(entry)) return { ok: true };
  return { ok: false, why: RAID_UNSUPPORTED[entry.gen] || 'version' };
}

/** Why a whole generation can't take part (the 3DS games: see docs/MULTIPLAYER.md › "Raid"). */
export const RAID_UNSUPPORTED = { 6: 'ctr', 7: 'ctr' };

/** The raid's view of the battle running now in this game (see the top), or null. `state`: per game, kept by the caller. */
export function raidView(entry, read, state = {}) {
  const x = driverOf(entry);
  if (!x || !read) return null;
  try {
    return x.d.view(entry, read, state, x.T);
  } catch {
    return null;
  }
}

/** The writes that give opponent party member `idx` `hp` HP (and its bar), for the view `v` read just now. */
export function raidWrites(entry, read, state, v, idx, hp) {
  const x = driverOf(entry);
  if (!x || !v) return [];
  return x.d.writes(entry, read, state, x.T, v, idx, hp);
}

export const _internal = { GB_TABLES, le16, le32, bytesLE, hex };
