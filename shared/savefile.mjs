// Battery saves brought in from elsewhere (a player on Discord: "can I import my old .sav?"): what a file is, whether
// its size fits the system, the layout souldew keeps it in, and – where it is cheap to tell – whether it is a save of
// this game at all. Pure: the server (server/lib/saveimport.mjs) backs up, writes and undoes; the page asks first.
//
// souldew keeps every battery save as the raw cartridge memory (what melonDS, mGBA, SameBoy, flash carts and most
// emulators call a .sav): a Game Boy clock cartridge with the 48-byte clock footer VBA-M, mGBA and SameBoy write
// (native/retro-host/retrohost.c), nothing else around it. What comes in is brought into that layout:
//   DeSmuME .dsv   the raw data, then a footer naming the chip – the footer goes, the data is padded to the chip's size
//   VBA-M 44 B     the older clock footer (a 32-bit time) – widened to the 48-byte one
//   mGBA +16 B     the Game Boy Advance clock mGBA appends – dropped (souldew's players take the clock from the computer)
//   flash carts    a cart that pads every save to its biggest size – the blank rest past the game's own size goes
// Checkpoint and JKSM dump DS cartridges as raw .sav files, so those are plain raw saves here too.
import { inspectSave, blankSave } from './introsave.mjs';
import { crc16ccitt } from './gen4save.mjs';

/** The file names the import picker offers (anything else is still read by its bytes). */
export const SAVE_EXTENSIONS = ['sav', 'srm', 'dsv', 'sa1', 'fla', 'eep', 'bin'];

const KB = 1024;
/** The cartridge memory sizes per system, smallest first. */
export const SAVE_SIZES = {
  // MBC2's 512 bytes, 2/8 KB SRAM, 32 KB (Pokémon), 64/128 KB (MBC5)
  gb: [512, 2 * KB, 8 * KB, 32 * KB, 64 * KB, 128 * KB],
  // EEPROM 512 B / 8 KB, SRAM 32 KB, Flash 64 KB / 128 KB (Pokémon)
  gba: [512, 8 * KB, 32 * KB, 64 * KB, 128 * KB],
  // EEPROM 512 B / 8 KB / 64 KB / 128 KB, FRAM 32 KB, Flash 256 KB / 512 KB (Pokémon) / 1 MB
  nds: [512, 8 * KB, 32 * KB, 64 * KB, 128 * KB, 256 * KB, 512 * KB, 1024 * KB],
};
SAVE_SIZES.gbc = SAVE_SIZES.gb;
SAVE_SIZES.sgb = SAVE_SIZES.gb;

/** The systems a battery save can be imported for (3DS saves are folders – see ctrImportFiles). */
export const IMPORT_SYSTEMS = ['gb', 'gbc', 'gba', 'nds'];

const GB_CLOCK = 48; // VBA-M 64-bit / mGBA / SameBoy: 5 + 5 × u32 registers (real, latched), u64 Unix seconds
const GB_CLOCK_OLD = 44; // VBA-M 32-bit: the same registers, a u32 time
const GBA_CLOCK = 16; // mGBA's GBA clock record after the flash

/** An error with a code the page words (web/lib/errors.mjs) and its values. */
export function saveFileError(code, message, vars = {}) {
  const e = new Error(message);
  e.code = code;
  e.vars = vars;
  return e;
}

// ---- DeSmuME .dsv (the same footer web/player.html writes for its DeSmuME core) ---------------------------------
const enc = (s) => new TextEncoder().encode(s);
const DSV_TXT = enc('|<--Snip above here to create a raw sav by excluding this DeSmuME savedata footer:');
const DSV_COOKIE = enc('|-DESMUME SAVE-|');
const DSV_CHIPS = new Set([0x200, 0x2000, 0x8000, 0x10000, 0x20000, 0x40000, 0x80000, 0x100000, 0x200000, 0x400000, 0x800000]);

/** Does `u8` end in DeSmuME's footer? */
export function isDsv(u8) {
  const tail = u8.length - DSV_COOKIE.length;
  return tail >= 24 && DSV_COOKIE.every((b, i) => u8[tail + i] === b);
}

/**
 * The raw save inside a DeSmuME .dsv: its footer (actual size, padded size, chip type, address bytes, chip size,
 * version) tells how much of the front is the save. DeSmuME counts a save only up to the highest byte the game wrote
 * (a fresh HeartGold save: 256 KB + 1) – the rest of the chip reads as erased flash (0xFF), as on the cartridge.
 */
export function stripDsv(u8) {
  if (!isDsv(u8)) throw saveFileError('saveImportFormat', 'Not a DeSmuME save');
  const tail = u8.length - DSV_COOKIE.length;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const [size, pad, , , mem] = [0, 4, 8, 12, 16].map((o) => dv.getUint32(tail - 24 + o, true));
  // the data ends where the footer's text starts (an older DeSmuME wrote no text)
  const txt = tail - 24 - DSV_TXT.length;
  const region = txt >= 0 && DSV_TXT.every((b, i) => u8[txt + i] === b) ? txt : tail - 24;
  const want = Math.max(size, pad, DSV_CHIPS.has(mem) ? mem : 0);
  const data = u8.slice(0, Math.min(want || region, region));
  const chip = [...DSV_CHIPS].find((c) => c >= Math.max(want, data.length)) || data.length;
  if (data.length >= chip) return data;
  const out = new Uint8Array(chip).fill(0xff);
  out.set(data);
  return out;
}

// ---- No$GBA (its own container – not read here; the player is told how to get a raw .sav) ----------------------
const NOCASH = enc('NocashGbaBackupMediaSavDataFile');
const isNocash = (u8) => u8.length > NOCASH.length && NOCASH.every((b, i) => u8[i] === b);

const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const allSame = (u8, from, to = u8.length) => {
  if (from >= to) return true;
  const v = u8[from];
  if (v !== 0xff && v !== 0x00) return false;
  for (let i = from + 1; i < to; i++) if (u8[i] !== v) return false;
  return true;
};

/** The sizes a system accepts, as text for the error ("8 KB, 32 KB, 128 KB"). */
export const sizeText = (n) => (n >= KB * KB ? `${n / (KB * KB)} MB` : n >= KB ? `${n / KB} KB` : `${n} B`);
const sizesText = (system) => SAVE_SIZES[system].map(sizeText).join(', ');

/**
 * Bring a file into the layout souldew keeps battery saves in (see the top). `system`: gb/gbc/gba/nds; `expected`: the
 * game's own save size when known (familySize) – a cart's blank padding past it goes. Throws (saveFileError) for a
 * size no cartridge of the system has, an empty file, a format it doesn't read.
 * → { bytes, size, from: 'raw' | 'dsv', notes: [...] } – notes: 'dsv', 'padded' (a DS save cut short), 'clockWidened',
 *   'clockKept', 'clockDropped', 'gbaClockDropped', 'padTrimmed'
 */
export function normalizeSave(input, system, { expected = null, clock = null } = {}) {
  let u8 = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  if (!SAVE_SIZES[system]) throw saveFileError('saveImportSystem', 'Saves of this system can’t be imported');
  if (!u8.length) throw saveFileError('saveImportEmpty', 'The file is empty');
  if (isNocash(u8)) throw saveFileError('saveImportNocash', 'No$GBA’s own save format');
  const notes = [];
  let from = 'raw';
  const sizes = SAVE_SIZES[system];
  const bad = () => saveFileError('saveImportSize', 'This size isn’t a save of this system', { size: sizeText(u8.length), bytes: u8.length, sizes: sizesText(system) });
  if (system === 'nds') {
    if (isDsv(u8)) {
      u8 = stripDsv(u8);
      from = 'dsv';
      notes.push('dsv');
    }
    if (u8.length > 1024 * KB || u8.length < 512) throw bad();
    if (!sizes.includes(u8.length)) {
      // a save DeSmuME (or an older souldew) counted only up to the last byte the game wrote – a fresh HeartGold save is
      // 256 KB + 1: the rest of the chip is erased flash
      const chip = sizes.find((c) => c > u8.length);
      const out = new Uint8Array(chip).fill(0xff);
      out.set(u8);
      u8 = out;
      notes.push('padded');
    }
  } else if (system === 'gba') {
    if (!sizes.includes(u8.length)) {
      if (sizes.includes(u8.length - GBA_CLOCK)) {
        u8 = u8.slice(0, u8.length - GBA_CLOCK);
        notes.push('gbaClockDropped');
      } else throw bad();
    }
  } else {
    // Game Boy: the cartridge memory, perhaps with a clock footer behind it
    const base = sizes.find((s) => s === u8.length || s + GB_CLOCK === u8.length || s + GB_CLOCK_OLD === u8.length);
    if (base === undefined) throw bad();
    if (u8.length !== base) {
      const foot = u8.subarray(base);
      if (clock === false) {
        u8 = u8.slice(0, base); // (a game without a clock: Red, Blue, Yellow)
        notes.push('clockDropped');
      } else if (foot.length === GB_CLOCK_OLD) {
        const out = new Uint8Array(base + GB_CLOCK);
        out.set(u8.subarray(0, base + 40));
        out.set(u8.subarray(base + 40, base + 44), base + 40); // the u32 time becomes the low half of the u64 one
        u8 = out;
        notes.push('clockWidened');
      } else notes.push('clockKept');
    }
  }
  // a flash cart's padding: the game's own size, the rest blank
  const body = system === 'gb' || system === 'gbc' || system === 'sgb' ? (notes.includes('clockKept') || notes.includes('clockWidened') ? u8.length - GB_CLOCK : u8.length) : u8.length;
  if (expected && body > expected && sizes.includes(expected) && allSame(u8, expected, body)) {
    const clockPart = u8.subarray(body);
    const out = new Uint8Array(expected + clockPart.length);
    out.set(u8.subarray(0, expected));
    out.set(clockPart, expected);
    u8 = out;
    notes.push('padTrimmed');
  }
  if (blankSave(u8)) throw saveFileError('saveImportEmpty', 'The file holds no save – nothing was ever saved in it');
  return { bytes: u8, size: u8.length, from, notes };
}

// ---- which game a save is from (a cheap look: checksums and signatures, no full parse) ---------------------------

/** The save layouts this file tells apart, with their generation and the save size the games use. */
export const FAMILIES = {
  gen1: { gen: 1, size: 32 * KB }, gs: { gen: 2, size: 32 * KB }, crystal: { gen: 2, size: 32 * KB },
  rs: { gen: 3, size: 128 * KB }, frlg: { gen: 3, size: 128 * KB }, e: { gen: 3, size: 128 * KB },
  dp: { gen: 4, size: 512 * KB }, pt: { gen: 4, size: 512 * KB }, hgss: { gen: 4, size: 512 * KB },
  bw: { gen: 5, size: 512 * KB }, b2w2: { gen: 5, size: 512 * KB }, gen5: { gen: 5, size: 512 * KB },
  xy: { gen: 6 }, oras: { gen: 6 }, sm: { gen: 7 }, usum: { gen: 7 },
};

/** The catalog game (its id, or the base game's for a hack) → its save family, or null (a Japanese release, unknown). */
export function familyOfGame(gameId) {
  const id = String(gameId || '').toLowerCase();
  const rules = [
    [/^pokemon-(red|blue|yellow)(-de|-fr|-es|-it|-eu)?$/, 'gen1'], [/^pokemon-(gold|silver)(-de|-fr|-es|-it|-eu)?$/, 'gs'], [/^pokemon-crystal(-de|-fr|-es|-it|-eu)?$/, 'crystal'],
    [/^pokemon-(ruby|sapphire)(-[a-z]{2})?$/, 'rs'], [/^pokemon-(firered|leafgreen)(-[a-z]{2})?$/, 'frlg'], [/^pokemon-emerald(-[a-z]{2})?$/, 'e'],
    [/^pokemon-(diamond|pearl)(-[a-z]{2})?$/, 'dp'], [/^pokemon-platinum(-[a-z]{2})?$/, 'pt'], [/^pokemon-(heartgold|soulsilver)(-[a-z]{2})?$/, 'hgss'],
    [/^pokemon-(black|white)-2(-[a-z]{2})?$/, 'b2w2'], [/^pokemon-(black|white)(-[a-z]{2})?$/, 'bw'],
    [/^pokemon-(x|y)$/, 'xy'], [/^pokemon-(omega-ruby|alpha-sapphire)$/, 'oras'], [/^pokemon-(sun|moon)$/, 'sm'], [/^pokemon-ultra-(sun|moon)$/, 'usum'],
  ];
  for (const [re, f] of rules) if (re.test(id)) return f;
  return null;
}

/** Can a save of family `found` go into a game of family `want`? (Black/White when only "Gen 5" could be told.) */
export const familyFits = (found, want) => found === want || (found === 'gen5' && (want === 'bw' || want === 'b2w2'));

// Gen 1 / 2: one sum over the main data (the same layouts shared/introsave.mjs reads)
function gbFamily(u8) {
  if (u8.length < 0x8000) return null;
  let s = 0;
  for (let i = 0x2598; i < 0x3523; i++) s += u8[i];
  if (((~s) & 0xff) === u8[0x3523]) return 'gen1';
  let c = 0;
  for (let i = 0x2009; i < 0x2b83; i++) c += u8[i];
  if ((c & 0xffff) === u16(u8, 0x2d0d)) return 'crystal';
  let g = 0;
  for (let i = 0x2009; i < 0x2d69; i++) g += u8[i];
  if ((g & 0xffff) === u16(u8, 0x2d69)) return 'gs';
  return null;
}

// Gen 3: 14 sections of 4 KB per slot, each signed 0x08012025; section 0 says which game (0xAC: 0 Ruby/Sapphire,
// 1 FireRed/LeafGreen, anything else Emerald's security key – PKHeX)
function gen3Family(u8) {
  let best = null;
  for (const slot of [0, 0xe000]) {
    let s0 = -1;
    let index = -1;
    let ok = true;
    for (let i = 0; i < 14 && ok; i++) {
      const o = slot + i * 0x1000;
      if (o + 0x1000 > u8.length || u32(u8, o + 0xff8) !== 0x08012025) ok = false;
      else {
        if (u16(u8, o + 0xff4) === 0) s0 = o;
        index = u32(u8, o + 0xffc);
      }
    }
    if (ok && s0 >= 0 && (!best || index > best.index)) best = { s0, index };
  }
  if (!best) return null;
  const code = u32(u8, best.s0 + 0xac);
  return code === 0 ? 'rs' : code === 1 ? 'frlg' : 'e';
}

// Gen 4: the General block at the start of either 256 KB half, its size and a magic number in its footer, a CRC16
const G4 = [['dp', 0xc100, 0x14], ['pt', 0xcf2c, 0x14], ['hgss', 0xf628, 0x10]];
function gen4Family(u8) {
  for (const [name, size, foot] of G4) {
    for (const base of [0, 0x40000]) {
      const end = base + size;
      if (end > u8.length) continue;
      if (u32(u8, end - 0x0c) !== size || ![0x20060623, 0x20070903].includes(u32(u8, end - 0x08))) continue;
      if (crc16ccitt(u8, base, end - foot) === u16(u8, end - 0x02)) return name;
    }
  }
  return null;
}

// Gen 5: the party block's CRC16 (0x18E00, 0x534 bytes – PKHeX SAV5), then the checksum table that tells Black/White
// (0x23F00) from Black 2/White 2 (0x25F00); without it only "a Gen 5 save" is known
function gen5Family(u8) {
  if (u8.length < 0x80000 || crc16ccitt(u8, 0x18e00, 0x18e00 + 0x534) !== u16(u8, 0x19336)) return null;
  if (crc16ccitt(u8, 0x25f00, 0x25f00 + 0x94) === u16(u8, 0x25fa2)) return 'b2w2';
  if (crc16ccitt(u8, 0x23f00, 0x23f00 + 0x8c) === u16(u8, 0x23f9a)) return 'bw';
  return 'gen5';
}

/** The family of a save (normalized bytes) of a game on `system`, or null when it can't be told. */
export function saveFamily(bytes, system) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (system === 'gb' || system === 'gbc' || system === 'sgb') return gbFamily(u8);
  if (system === 'gba') return gen3Family(u8);
  if (system === 'nds') return gen4Family(u8) || gen5Family(u8);
  return null;
}

/**
 * Does the save fit the game? `gameId`: the catalog id of the game (a hack: null – hacks may lay their saves out
 * their own way, so they get the size check only). → { verdict, found, want, gen, party }
 *   'match'     the save is of this game's family
 *   'mismatch'  it is clearly a save of another game (the page warns; the player may go on)
 *   'unknown'   a save, but not one this file recognises (a hack, a Japanese release, another game entirely)
 *   'size'      the family is right but the size isn't what the game writes (warned too)
 */
export function checkSaveForGame(bytes, system, gameId, tables = null) {
  const want = familyOfGame(gameId);
  const found = saveFamily(bytes, system);
  const info = inspectSave(bytes, system, tables);
  const party = info.state === 'ok' ? info.party : null;
  const gen = found ? FAMILIES[found].gen : info.gen || null;
  let verdict = 'unknown';
  if (want && found) {
    if (!familyFits(found, want)) verdict = 'mismatch';
    else if (FAMILIES[want].size && bytes.length !== FAMILIES[want].size && !(system !== 'gba' && system !== 'nds' && bytes.length === FAMILIES[want].size + GB_CLOCK)) verdict = 'size';
    else verdict = 'match';
  } else if (want && !found && FAMILIES[want].gen !== (info.gen || 0) && info.state === 'ok') verdict = 'mismatch';
  return { verdict, found: found || null, want, gen, party };
}

/** The save size a game writes (its family's), or null. */
export const familySize = (gameId) => FAMILIES[familyOfGame(gameId)]?.size || null;

/** Does a game of this family keep a clock in its save (Gold, Silver, Crystal)? null: unknown. */
export const familyClock = (family) => (family === 'gs' || family === 'crystal' ? true : family === 'gen1' ? false : null);

// ---- 3DS: a Checkpoint / JKSM backup (a folder of the save's files) -----------------------------------------------

/** 3DS `main` sizes (shared/introsave.mjs CTR_LAYOUTS) → family. */
const CTR_MAIN = { [0x65600]: 'xy', [0x76000]: 'oras', [0x6be00]: 'sm', [0x6cc00]: 'usum' };

/**
 * The files of a Checkpoint / JKSM backup as they go into the game's save folder: `files` = [{ path, bytes }] (paths
 * with `/`, as in the folder or zip – a backup folder zipped with its parent folders is fine: what is common to all
 * paths goes). Refuses paths that leave the folder, more than 64 files, more than 16 MB.
 * → { files: [{ path, bytes }], main: bytes|null, family: 'xy'|'oras'|'sm'|'usum'|null }
 */
export function ctrImportFiles(files) {
  const list = (files || []).filter((f) => f && typeof f.path === 'string' && !/(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(f.path) && !/(^|\/)__MACOSX\//.test(f.path));
  if (!list.length) throw saveFileError('saveImportEmpty', 'The backup holds no files');
  if (list.length > 64) throw saveFileError('saveImportCtrFiles', 'Too many files for a save', { n: list.length });
  let total = 0;
  const parts = list.map((f) => {
    const p = f.path.replace(/\\/g, '/').replace(/^\/+/, '');
    const segs = p.split('/');
    if (!p || segs.some((s) => !s || s === '.' || s === '..' || /[\0:]/.test(s))) throw saveFileError('saveImportFormat', 'A path in the backup isn’t safe', { path: p.slice(0, 80) });
    total += f.bytes?.length || 0;
    return { segs, bytes: f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes || []) };
  });
  if (total > 16 * 1024 * 1024) throw saveFileError('saveImportSize', 'Too large for a 3DS save', { size: sizeText(total), bytes: total, sizes: '16 MB' });
  // the folders every file sits in go (a zip of "Checkpoint/saves/0x00055 Pokémon X/2024-01-01/main")
  let common = 0;
  for (;;) {
    const seg = parts[0].segs[common];
    if (parts.every((p) => p.segs.length > common + 1 && p.segs[common] === seg)) common++;
    else break;
  }
  const out = parts.map((p) => ({ path: p.segs.slice(common).join('/'), bytes: p.bytes }));
  const main = out.find((f) => f.path === 'main')?.bytes || null;
  if (main && blankSave(main)) throw saveFileError('saveImportEmpty', 'The backup holds no save');
  return { files: out, main, family: main ? CTR_MAIN[main.length] || null : null };
}
