// The DS, GBA and Game Boy in souldew's fast player: the native host (native/retro-host) runs a libretro core – melonDS
// DS with its JIT, mGBA, SameBoy – as a native program and speaks the 3DS host's protocol (server/lib/ctr.mjs) with a
// few more messages (see the header of native/retro-host/retrohost.c). Sessions, the page's stream and the command
// checks are the 3DS ones (CtrSessions); this module knows the cores, their memory and their settings.
//
// tools/native/<platform>-<arch>/ (bundled with the app, or in the data folder's tools):
//   retrohost[.exe]                                   the host
//   melondsds_libretro.dylib | .dll | .so             DS
//   mgba_libretro.*                                   GBA
//   sameboy_libretro.*                                Game Boy / Game Boy Color
//   linkhost[.exe]                                    the souldew engine (native/link-host): link sessions – and, with
//                                                     Settings › "souldew engine (beta)", the fast player itself
// When the host or a core is missing, the play view uses the built-in browser emulator (player.html) as before.
//
// The souldew engine (config.nativeEngine): ONE native player for these systems – the link host alone (`--solo`) runs
// the game on the emulators' own APIs, speaks retrohost's protocol (the same page, the same save-state format), and a
// trade or battle links the running game in place: the server hands the session to the same process (CMD_LINK, every
// seat from the agreed states), and back (CMD_SOLO) when it ends. retrohost stays the fallback while the engine is beta.
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { BUNDLED_TOOLS, TOOLS_DIR, DATA_DIR, DEV, APP_ROOT } from './paths.mjs';
import { httpError } from './fsutil.mjs';
import { CtrSessions, MSG, splitMessages, PLATFORM_DIR, command } from './ctr.mjs';
import { LINK_SYSTEMS, MAX_LINK_SEATS, LINK_CMD, LINK_MSG } from '../../shared/link.mjs';
import { sha1OfFile } from './linkroms.mjs';

const EXE = process.platform === 'win32' ? 'retrohost.exe' : 'retrohost';
const LINK_EXE = process.platform === 'win32' ? 'linkhost.exe' : 'linkhost';
const LIB_EXT = process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so';

/** Messages of the native host on top of the 3DS host's (MSG); LINPUT, SEATSRAM, SEATSTATE come from the link host only,
 *  WATCHED from retrohost only (16: the link host's SEATSTATE is 15). */
export const NMSG = { ...MSG, RAM: LINK_MSG.RAM, SRAM: LINK_MSG.SRAM, LINPUT: LINK_MSG.LINPUT, SEATSRAM: LINK_MSG.SEATSRAM, SEATSTATE: LINK_MSG.SEATSTATE, WATCHED: 16 };
/** Commands the page may send it. */
// (WATCH: a few RAM bytes with every picture – the Shared World overlay's camera, web/lib/worldoverlay.mjs)
export const NCMD = { INPUT: 1, SPEED: 2, SAVE: 3, LOAD: 4, QUIT: 6, RESET: 7, WRITE: 9, FLUSH: 10, SRAM: 11, RESYNC: 12, STEP: 13, WATCH: 14, DEPTH: 15 };

/** Commands a page may send a link session (native/link-host/linkhost.c): no states, cheats, steps or memory writes.
 *  SEATSTATE: the player's own console for the fast player once the session is over (it goes on alone from there).
 *  READ: a few bytes of any seat's console – how the link battle's result is read on every peer (shared/linkbattle.mjs);
 *  it changes nothing in any console. */
/** UNTIL: pause at a session frame (the e2e stops every peer where its recording ends). */
const { INPUT, SPEED, SAVE, QUIT, FLUSH, RESYNC, RINPUT, UNTIL, NEED, SEATSTATE, READ } = LINK_CMD;
export const LCMD = { INPUT, SPEED, SAVE, QUIT, FLUSH, RESYNC, RINPUT, UNTIL, NEED, SEATSTATE, READ };
/** The most a page may READ at once (the Gen 4 game records are 0x1BC bytes). */
export const LINK_READ_MAX = 4096;
export { LINK_SYSTEMS, MAX_LINK_SEATS };

export const MAX_SAVE = 4 * 1024 * 1024; // the biggest battery save of a DS game is 8 Mbit; GBA / GB far less
export const MAX_STATE = 64 * 1024 * 1024; // a save state (a DS console with its cartridge's save: ~6 MB)

/**
 * Per system: the core, the memory the live reader reads (bus address, length – what player.html's read() maps:
 * DS main RAM, GBA EWRAM + IWRAM, Game Boy WRAM banks 0 and 1) and the core options souldew sets. `id` names the
 * core for save states (a state of the browser emulator's core can't be loaded here, and the other way round).
 */
export const NATIVE_CORES = {
  nds: {
    id: 'melonds-native',
    lib: 'melondsds_libretro',
    ram: [[0x02000000, 0x400000]],
    options: {
      melonds_console_mode: 'ds', // DS mode: the built-in BIOS/firmware, save states – no DSi system files needed
      melonds_sysfile_mode: 'builtin',
      melonds_boot_mode: 'direct',
      melonds_jit_enable: 'enabled',
      melonds_render_mode: 'software',
      melonds_threaded_renderer: 'enabled', // the 3D picture is drawn on its own core
      melonds_touch_mode: 'touch', // a click is a tap at that spot
      melonds_show_cursor: 'disabled',
      melonds_number_of_screen_layouts: '1',
      melonds_screen_layout1: 'top-bottom', // the page arranges the two screens itself (side by side too)
      melonds_screen_gap: '0',
      melonds_show_current_layout: 'disabled',
      melonds_show_bios_warnings: 'disabled',
      melonds_network_mode: 'disabled',
      melonds_mic_input: 'silence',
    },
  },
  gba: {
    id: 'mgba-native',
    lib: 'mgba_libretro',
    ram: [[0x02000000, 0x40000], [0x03000000, 0x8000]],
    options: { mgba_skip_bios: 'ON', mgba_use_bios: 'OFF', mgba_idle_optimization: 'Remove Known' },
  },
  // SameBoy – the link host's Game Boy emulator, the same version: a link session starts from the running game's state and
  // hands it back (docs/MULTIPLAYER.md › "Seamless"). The model comes per game (gbModel): Game Boy games on the original
  // Game Boy (classic green palette) or on a Game Boy Color (Settings › "Game Boy look"), Game Boy Color games on a GBC.
  // The cartridge clock follows the computer's. States of the older Gambatte player ('gambatte-native') aren't offered.
  gb: {
    id: 'sameboy-native',
    lib: 'sameboy_libretro',
    ram: [[0xc000, 0x2000]],
    options: { sameboy_rtc: 'sync to system clock', sameboy_border: 'never', sameboy_color_correction_mode: 'emulate hardware', sameboy_mono_palette: 'lime' },
  },
};
NATIVE_CORES.gbc = NATIVE_CORES.gb;

/** Settings › "Game Boy look" (config.gbLook): Game Boy games as on the original Game Boy, or in a Game Boy Color's colours. */
export const GB_LOOKS = ['original', 'color'];
/** The console a Game Boy family game runs on: 'dmg' (the original Game Boy) or 'cgb'; null for other systems. Game Boy
 *  Color games always on a GBC. A save state only loads into the model that made it – the model is part of its core id. */
export function gbModel(system, look) {
  if (system === 'gbc') return 'cgb';
  if (system === 'gb') return look === 'color' ? 'cgb' : 'dmg';
  return null;
}
/** The core id save states carry (the play view offers only states of the running core). */
export function nativeCoreId(system, model = null) {
  const c = NATIVE_CORES[system];
  return c && model === 'dmg' ? 'sameboy-dmg-native' : c?.id || null;
}
const SAMEBOY_MODEL = { dmg: 'Game Boy', cgb: 'Game Boy Color' };

/** Where the native tools are: the first folder with the host in it. */
export function nativeDirs() {
  return [join(BUNDLED_TOOLS, 'native', PLATFORM_DIR), join(TOOLS_DIR, 'native', PLATFORM_DIR), ...(DEV ? [join(APP_ROOT, 'tools', 'native', PLATFORM_DIR)] : [])];
}

/** { ok, dir, host, cores: { nds: path|null, gba, gb, gbc } } – ok when the host and at least one core are there. */
export function nativeTools({ dirs = nativeDirs(), exists = existsSync } = {}) {
  const dir = dirs.find((d) => exists(join(d, EXE)));
  if (!dir) return { ok: false, missing: 'host', cores: {} };
  const cores = {};
  for (const [sys, c] of Object.entries(NATIVE_CORES)) {
    const p = join(dir, `${c.lib}.${LIB_EXT}`);
    cores[sys] = exists(p) ? p : null;
  }
  return { ok: Object.values(cores).some(Boolean), dir, host: join(dir, EXE), cores };
}

/** The core folder of a game / run slot (cores keep a few files there; the battery save itself goes through souldew). */
export function nativeSaveDir(key) {
  const h = createHash('sha1').update(String(key)).digest('hex').slice(0, 16);
  return join(DATA_DIR, DEV ? 'runs/.native' : 'native', 'saves', h);
}

/** The link host (tools/native/<platform>/linkhost), or null when this build has none. */
export function linkTool({ dirs = nativeDirs(), exists = existsSync } = {}) {
  const dir = dirs.find((d) => exists(join(d, LINK_EXE)));
  return dir ? join(dir, LINK_EXE) : null;
}

/**
 * The link host's arguments: every seat's ROM and battery save (paths – the server's own), the local seat, net mode
 * with the input delay, the shared clock start, and the local seat's memory for live tracking.
 */
/**
 * scripts/link-e2e.mjs only, and only with SLS_E2E=1: each host plays its own seat's column of a recording (so a
 * session's outcome is known) and every host gets one fixed clock. The app never sets these.
 */
function e2eLink(env = process.env) {
  if (env.SLS_E2E !== '1') return {};
  return { script: env.SLS_LINK_TEST_SCRIPT || null, rtc: Number(env.SLS_LINK_TEST_RTC) || null };
}

export function linkArgs({ system, roms, saves, local, delay, rtc, state = null, states = [], models = [], env = process.env }) {
  const c = NATIVE_CORES[system];
  if (!c || !LINK_SYSTEMS.includes(system)) throw httpError(400, 'Linking isn’t available for this system yet', 'linkSystem');
  if (!Array.isArray(roms) || roms.length < 2 || roms.length > MAX_LINK_SEATS) throw httpError(400, 'Invalid seats', 'linkSeats');
  if (!Number.isInteger(local) || local < 0 || local >= roms.length) throw httpError(400, 'Invalid seat', 'linkSeats');
  const d = Math.max(1, Math.min(60, Math.round(Number(delay) || 4)));
  const args = [];
  roms.forEach((r, i) => {
    args.push('--rom', r, '--sram', saves[i] || '-', '--state', states[i] || '-');
    // (each seat as its player's console, as that player announced it – never this computer's game: Blue (gb) and Yellow
    // (gbc) link too, and every peer must form the same consoles; a GBC game's player always announces 'cgb')
    if (system === 'gb' || system === 'gbc') args.push('--model', models[i] === 'dmg' ? 'dmg' : 'cgb');
  });
  const e2e = e2eLink(env);
  const clock = e2e.rtc || Math.round(Number(rtc) || Date.now());
  args.push('--local', String(local), '--net', '--delay', String(d), '--rtc', String(clock));
  for (const [addr, len] of c.ram) args.push('--ram', `0x${addr.toString(16)}:0x${len.toString(16)}`);
  if (state) args.push('--load', state);
  if (e2e.script) args.push('--script', e2e.script);
  return args;
}

/**
 * Commands a page may send a link session: input, speed, flush, resync, view, a peer's buttons, the end frame, a
 * session state (for a partner who rejoins – never LOAD, POKE or READ) and a peer's request for buttons it missed.
 */
export function checkLinkCommands(body) {
  const { messages, rest } = splitMessages(body);
  if (rest.length || !messages.length) throw httpError(400, 'Invalid command', 'badCommand');
  const limits = {
    [LCMD.INPUT]: [17, 32], [LCMD.SPEED]: [4, 4], [LCMD.QUIT]: [0, 0], [LCMD.FLUSH]: [0, 0], [LCMD.RESYNC]: [0, 0],
    [LCMD.RINPUT]: [12, 8 + 4 * 4096], [LCMD.UNTIL]: [4, 4], [LCMD.SAVE]: [0, 0], [LCMD.NEED]: [8, 8], [LCMD.SEATSTATE]: [4, 4], [LCMD.READ]: [12, 12],
  };
  for (const m of messages) {
    const l = limits[m.type];
    if (!l || m.payload.length < l[0] || m.payload.length > l[1] || (m.type === LCMD.RINPUT && (m.payload.length - 8) % 4)) throw httpError(400, 'Invalid command', 'badCommand');
    if (m.type === LCMD.READ && m.payload.readUInt32LE(8) > LINK_READ_MAX) throw httpError(400, 'Invalid command', 'badCommand');
  }
  return body;
}

/** Server → engine only (never accepted from a page, see check()): partners join the running game / it goes on alone. */
export const ENGINE_CMD = { LINK: 27, SOLO: 28 };
/** Systems the souldew engine plays alone (the link host's: its backends are the fast player's emulators). */
export const ENGINE_SYSTEMS = LINK_SYSTEMS;

/** Arguments as the engine reads them in CMD_LINK / CMD_SOLO: the command line's words, NUL-separated. */
export const engineWords = (args) => Buffer.from(args.map((a) => `${a}\0`).join(''), 'utf8');

/**
 * The souldew engine alone (`linkhost --solo`): the game, its battery save, a state to go on from, the Game Boy model,
 * and the RAM the live reader needs – the fast player's settings are the engine's own (native/link-host).
 */
export function engineArgs({ system, rom, sram = null, state = null, model = null }) {
  const c = NATIVE_CORES[system];
  if (!c || !ENGINE_SYSTEMS.includes(system)) throw httpError(400, 'The fast player doesn’t play this system', 'nativeSystem');
  const args = ['--solo', '--rom', rom];
  if (sram) args.push('--sram', sram);
  if (state) args.push('--state', state);
  if (system === 'gb' || system === 'gbc') args.push('--model', model === 'dmg' && system === 'gb' ? 'dmg' : 'cgb');
  for (const [addr, len] of c.ram) args.push('--ram', `0x${addr.toString(16)}:0x${len.toString(16)}`);
  return args;
}

/** The host's arguments for `system` (the paths are the server's own – nothing here comes from the page). */
export function hostArgs({ system, core, rom, saveDir, systemDir, sram = null, state = null, model = null }) {
  const c = NATIVE_CORES[system];
  if (!c) throw httpError(400, 'The fast player doesn’t play this system', 'nativeSystem');
  const args = ['--core', core, '--rom', rom, '--system', systemDir, '--save', saveDir];
  if (sram) args.push('--sram', sram);
  if (state) args.push('--state', state);
  for (const [addr, len] of c.ram) args.push('--ram', `0x${addr.toString(16)}:0x${len.toString(16)}`);
  for (const [k, v] of Object.entries(c.options)) args.push('--option', `${k}=${v}`);
  if (system === 'gb' || system === 'gbc') args.push('--option', `sameboy_model=${SAMEBOY_MODEL[model === 'dmg' && system === 'gb' ? 'dmg' : 'cgb']}`);
  return args;
}

/**
 * Commands a page may send the native host: known types, sane sizes. A cheat (WRITE) carries an address and at most
 * 64 KB; the host only writes inside the game's RAM regions.
 */
export function checkNativeCommands(body) {
  const { messages, rest } = splitMessages(body);
  if (rest.length || !messages.length) throw httpError(400, 'Invalid command', 'badCommand');
  const limits = {
    [NCMD.INPUT]: [17, 32], [NCMD.SPEED]: [4, 4], [NCMD.SAVE]: [0, 0], [NCMD.LOAD]: [1, 64 * 1024 * 1024], [NCMD.QUIT]: [0, 0],
    [NCMD.RESET]: [0, 0], [NCMD.WRITE]: [5, 4 + 65536], [NCMD.FLUSH]: [0, 0], [NCMD.SRAM]: [1, MAX_SAVE], [NCMD.RESYNC]: [0, 0], [NCMD.STEP]: [4, 4],
    [NCMD.WATCH]: [4, 4 + 8 * 16], [NCMD.DEPTH]: [4, 4 + 8 * 8],
  };
  for (const m of messages) {
    const l = limits[m.type];
    if (!l || m.payload.length < l[0] || m.payload.length > l[1]) throw httpError(400, 'Invalid command', 'badCommand');
  }
  return body;
}

/** A link session's files in its folder (the seats' saves and states, a rejoin's session state) – known names only. */
function clearLinkFiles(dir) {
  for (let i = 0; i < MAX_LINK_SEATS; i++) for (const f of [`seat${i}.sav`, `seat${i}.state`]) rmSync(join(dir, f), { force: true });
  rmSync(join(dir, 'session.state'), { force: true });
}

/**
 * Does session `c` play exactly the game at `rom`? The same file – or a byte-identical copy: a zipped library game is
 * unpacked to one place for playing and another for linking (SHA-1, cached per file and kept on the session).
 */
function sameGame(c, rom) {
  if (!c?.rom || !rom) return false;
  if (c.rom === rom) return true;
  try {
    const own = (c.romSha1 ||= sha1OfFile(c.rom));
    return !!own && own === sha1OfFile(rom);
  } catch {
    return false;
  }
}

/** A battery save that is all 0xFF or all 0x00 is an empty cartridge, not a save. */
export const blankSave = (b) => !b?.length || b.every((x) => x === 0xff) || b.every((x) => x === 0);

export class NativeSessions extends CtrSessions {
  /**
   * `writeSave(file, bytes)`: stores a battery save the host sends after its page has gone (the player closed right
   * after the game saved – the page can't wait for the host's last word). Without it such a save is dropped.
   */
  constructor({ writeSave = null, ...opts } = {}) {
    super(opts);
    this.keepTypes = [NMSG.EVENT, NMSG.STATE, NMSG.SRAM, NMSG.LINPUT, NMSG.SEATSRAM];
    this.writeSave = writeSave;
    this.label = 'fast player';
  }

  onMessage(s, m, attached) {
    if (m.type === NMSG.EVENT && s.waiters?.length) {
      let e = null;
      try {
        e = JSON.parse(m.data.subarray(8).toString('utf8'));
      } catch {
        // not JSON
      }
      for (const w of s.waiters.slice()) if (e && w.pred(e)) w.done(null, e);
    }
    if (m.type !== NMSG.SRAM || attached || !s.saveFile || !this.writeSave) return;
    const bytes = Buffer.from(m.data.subarray(8));
    if (blankSave(bytes)) return;
    try {
      this.writeSave(s.saveFile, bytes);
    } catch {
      // best effort – the page's own copy is on disk already
    }
  }

  /**
   * Start `rom` (a path) on `system` with the core folder of `key`; `save` = the battery save souldew has for it
   * (bytes) or null. Ends a session that still runs. `engine`: the souldew engine's link host plays it (else retrohost
   * with the system's libretro core). Coming back from a link session the engine already runs (`state` given, the same
   * game): the game goes on alone in that process (CMD_SOLO) – no new player; then a promise of the id.
   */
  startNative({ rom, key, system, tools, save = null, saveFile = null, state = null, model = null, engine = null }) {
    if (engine && state?.length && this.engineLinked(rom)) return this.soloInPlace({ key, system, save, saveFile, state, model });
    const core = engine ? engine : tools.cores?.[system];
    if (!core) throw httpError(409, 'The fast player is missing for this system', 'nativeMissing');
    this.stop();
    if (this.lastLink) this.linkDone(this.lastLink.id); // (a link session before this game: over – a desync's restore came first)
    const saveDir = nativeSaveDir(key);
    const systemDir = join(DATA_DIR, DEV ? 'runs/.native' : 'native', 'system');
    mkdirSync(saveDir, { recursive: true });
    mkdirSync(systemDir, { recursive: true });
    const { sram, stateFile } = this.startFiles(saveDir, save, state);
    const args = engine ? engineArgs({ system, rom, sram, state: stateFile, model }) : hostArgs({ system, core, rom, saveDir, systemDir, sram, state: stateFile, model });
    const id = this.launch(engine || tools.host, args, saveDir);
    Object.assign(this.current, { saveFile, rom, engine: !!engine, system, model, key });
    return id;
  }

  /** The battery save and the state to start from, as files in `dir` (none: the old ones go). */
  startFiles(dir, save, state) {
    const boot = join(dir, 'boot.sav');
    let sram = null;
    if (save?.length) {
      if (save.length > MAX_SAVE) throw httpError(413, 'The save file is too large', 'saveTooLarge');
      writeFileSync(boot, save);
      sram = boot;
    } else {
      rmSync(boot, { force: true }); // no save (yet): the core starts with an empty cartridge
    }
    // a save state to go on from (back from a link session: the player's console as the link host left it)
    const stateFile = join(dir, 'resume.state');
    if (state?.length) {
      if (state.length > MAX_STATE) throw httpError(413, 'The save state is too large', 'saveTooLarge');
      writeFileSync(stateFile, state);
    } else rmSync(stateFile, { force: true });
    return { sram, stateFile: state?.length ? stateFile : null };
  }

  /** The engine runs a link session whose local seat plays `rom` (it can go on alone in place). */
  engineLinked(rom) {
    const c = this.current;
    return !!(c?.engine && !c.exit && c.link && sameGame(c, rom));
  }

  /**
   * The engine's session goes on alone in the same process: from `state` (+ `save`) – out of step: the game as it was
   * before the link – or, without them, from the local console as the session left it (its battery save first).
   * Resolves the session's id once the engine says it plays alone.
   */
  async soloInPlace({ key, system, save = null, saveFile = null, state = null, model = null }) {
    const c = this.current;
    let words = [];
    if (state?.length) {
      const dir = nativeSaveDir(key);
      mkdirSync(dir, { recursive: true });
      const { sram, stateFile } = this.startFiles(dir, save, state);
      words = engineArgs({ system, rom: c.rom, sram, state: stateFile, model: model || c.model }).filter((w, i, l) => w !== '--ram' && l[i - 1] !== '--ram' && w !== '--solo');
    }
    const loaded = this.awaitEvent(c, (e) => e.event === 'loaded' && e.mode === 'solo', 30000);
    c.child.stdin.write(command(ENGINE_CMD.SOLO, engineWords(words)));
    await loaded;
    const dir = c.link?.dir;
    Object.assign(c, { link: null, saveFile: saveFile ?? c.saveFile, key: key || c.key });
    if (dir) clearLinkFiles(dir); // (the session's saves and states are big and go stale)
    return c.id;
  }

  /** The engine's link session `id` ends, the game goes on alone in place (no state travels). Null when it can't. */
  async unlink(id) {
    const c = this.current;
    if (!c || c.id !== id || !c.engine || !c.link || c.exit) return null;
    await this.soloInPlace({ key: c.key, system: c.system });
    return { id: c.id, core: nativeCoreId(c.system, c.model), model: c.model };
  }

  /** Resolves the host's next EVENT matching `pred` on session `s` (rejects after `ms`, or when the host ends). */
  awaitEvent(s, pred, ms) {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, reject };
      const t = setTimeout(() => done(new Error('timeout')), ms);
      const done = (err, e) => {
        clearTimeout(t);
        s.waiters = (s.waiters || []).filter((x) => x !== w);
        if (err) reject(httpError(409, 'The game isn’t answering', 'nativeBusy'));
        else resolve(e);
      };
      w.done = done;
      (s.waiters ||= []).push(w);
      s.child.once('exit', () => done(new Error('ended')));
    });
  }

  /**
   * A link session (docs/MULTIPLAYER.md): `seats` = [{ rom, save (bytes|null) }] in seat order, `local` = this player's
   * seat. Every seat's ROM is a file on this computer (verified by the caller), the partners' saves came over the run's
   * channel. The local seat's battery save goes where the run keeps it (`saveFile`), as in single play. When the engine
   * plays this player's game right now, the partners join that process (CMD_LINK) – else a link host starts.
   */
  async startLink({ host, system, seats, local, delay, rtc, key, saveFile = null, state = null }) {
    // seats[i].state: that player's running game (the fast player's save state) – the session starts from it, no restart;
    // seats[i].model: a Game Boy seat's console ('dmg' | 'cgb', gbModel) – every peer gets the same list from the pages
    if (!host) throw httpError(409, 'This version has no link part', 'linkMissing');
    const c = this.current;
    const inPlace = !!(c?.engine && !c.exit && !c.link && !state?.length && sameGame(c, seats[local].rom));
    if (!inPlace) this.stop();
    const dir = join(nativeSaveDir(`link:${key}`), 'link');
    mkdirSync(dir, { recursive: true });
    clearLinkFiles(dir); // (nothing of an earlier session: its saves and states are big and go stale)
    const saves = seats.map((s, i) => {
      if (!s.save?.length) return null;
      if (s.save.length > MAX_SAVE) throw httpError(413, 'The save file is too large', 'saveTooLarge');
      const f = join(dir, `seat${i}.sav`);
      writeFileSync(f, s.save);
      return f;
    });
    const states = seats.map((s, i) => {
      if (!s.state?.length) return null;
      if (s.state.length > MAX_STATE) throw httpError(413, 'The save state is too large', 'saveTooLarge');
      const f = join(dir, `seat${i}.state`);
      writeFileSync(f, s.state);
      return f;
    });
    let stateFile = null;
    if (state?.length) { // a rejoin: the session as the partners who stayed had it (every console, the frame)
      stateFile = join(dir, 'session.state');
      let bytes;
      try {
        bytes = inflateRawSync(state, { maxOutputLength: MAX_LINK_SEATS * MAX_STATE });
      } catch {
        throw httpError(409, 'The save state is damaged', 'linkStateDiffers');
      }
      writeFileSync(stateFile, bytes);
    }
    const models = seats.map((s) => s.model || null);
    const args = linkArgs({ system, roms: seats.map((s) => s.rom), saves, local, delay, rtc, state: stateFile, states: stateFile ? [] : states, models });
    if (inPlace) {
      // the partners join the running game: the engine forms every seat from these files and says so (or refuses: the
      // game then goes on alone as it was)
      const answer = this.awaitEvent(c, (e) => (e.event === 'loaded' && e.mode === 'link') || e.event === 'linkRefused', 30000);
      c.child.stdin.write(command(ENGINE_CMD.LINK, engineWords(args.filter((w, i, l) => w !== '--ram' && l[i - 1] !== '--ram'))));
      const e = await answer;
      if (e.event === 'linkRefused') throw httpError(409, 'The games couldn’t be linked', 'linkRefused');
      Object.assign(c, { saveFile, link: { seats: seats.length, local, system, dir } });
      return c.id;
    }
    const id = this.launch(host, args, dir);
    Object.assign(this.current, { saveFile, rom: seats[local].rom, link: { seats: seats.length, local, system, dir }, engine: true, system, model: models[local], key: null });
    return id;
  }

  /** Stopping a link session keeps it as `lastLink` (a desync's restore may come right after the host was stopped). */
  stop() {
    if (this.current?.link) this.lastLink = this.current;
    super.stop();
  }

  /** The link session `id` is over for good: its files go (the run's save was written back long since). */
  linkDone(id) {
    const c = this.lastLink?.id === id ? this.lastLink : null;
    if (!c) return;
    if (c.save) clearLinkFiles(c.save); // (CtrSessions' `save`: the session's folder)
    this.lastLink = null;
  }

  /**
   * After a session fell out of step: its pre-session save (null when there was none) for /api/link/restore. The
   * session is stopped first – nothing it writes afterwards reaches the run.
   */
  linkRestore(id) {
    const c = this.current?.id === id && this.current.link ? this.current : this.lastLink?.id === id ? this.lastLink : null;
    if (!c) return null;
    c.saveFile = null; // (its last battery saves don't go into the run any more)
    if (this.current === c && c.engine && c.rom) {
      // the engine's game goes on alone from the snapshot right after (soloInPlace): it only stands still until then
      c.child.stdin.write(command(NCMD.SPEED, Buffer.from(new Float32Array([0]).buffer)));
    } else if (this.current === c) this.stop();
    return c;
  }

  /** The host gets only what it needs from the environment (no tokens or the like the app was started with). */
  hostEnv() {
    const keep = ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'windir', 'LANG', 'LC_ALL', 'DISPLAY', 'XDG_RUNTIME_DIR'];
    return Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  }

  check(body) {
    return this.current?.link ? checkLinkCommands(body) : checkNativeCommands(body);
  }

  /** The session for the status: plus the last of what the host wrote to stderr (diagnostics, the ROM matrix). */
  status() {
    const st = super.status();
    return st && { ...st, stderr: this.current.log.join('').slice(-2000) };
  }

  get(id) {
    const s = this.current;
    if (!s || s.id !== id) throw httpError(404, 'No game is running in the fast player', 'noNativeSession');
    return s;
  }

  send(id, body) {
    const s = this.get(id);
    if (s.exit) throw httpError(409, 'The game has stopped', 'nativeEnded');
    // the host reads its commands between frames – a page that floods it waits instead of piling up memory here
    if (s.child.stdin.writableLength > 128 * 1024 * 1024) throw httpError(503, 'The game is busy', 'nativeBusy');
    s.child.stdin.write(this.check(body));
  }
}
