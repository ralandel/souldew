// Builds souldew's fast player part into tools/native/<platform>-<arch>/ (bundled with the app like the 3DS part, see
// package.json and server/lib/native.mjs):
//   retrohost[.exe]              native/retro-host/retrohost.c – the host that runs a libretro core for the player page
//   melondsds_libretro.*         DS: melonDS DS (JesseTG/melonds-ds) – software 3D on its own thread, the JIT on
//   mgba_libretro.*              GBA: mGBA – built from the link host's libmgba commit (the same save states both ways:
//                                a link session starts from the running game and hands it back, docs/MULTIPLAYER.md)
//   sameboy_libretro.*           Game Boy / Game Boy Color: SameBoy – the link host's GB/GBC emulator, the same version
//   SOURCES.txt                  which source each file was built from (GPL: the same tags/commits are public)
//   linkhost[.exe]               native/link-host/linkhost.c – link sessions: N linked consoles in one process, lockstep
//                                (trades and battles between players, docs/MULTIPLAYER.md); GBA on libmgba, GB/GBC on
//                                SameBoy (needs RGBDS for SameBoy's boot ROM), DS on melonDS's core library
//
//   node scripts/build-native.mjs [--platform win32-x64] [--only nds,gba,gb,link] [--host-only] [--jobs n]
//   node scripts/build-native.mjs --check      (npm run dist: fails when the part is missing; SLS_NO_NATIVE=1 builds
//                                               without it – the built-in browser emulator then plays everything)
//
// The sources are cloned at fixed tags/commits into _ref/native/. Needs git, cmake, ninja, make and a C/C++
// compiler; Windows is cross-compiled with MinGW-w64 (macOS: brew install mingw-w64; Ubuntu: apt install mingw-w64) –
// every library is linked in statically, the DLLs need nothing but Windows itself.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const has = (name) => args.includes(`--${name}`);
const plat = opt('platform', `${process.platform}-${process.arch}`);
const [os, arch] = plat.split('-');
const cross = plat !== `${process.platform}-${process.arch}`;
const win = os === 'win32';
const ext = win ? 'dll' : os === 'darwin' ? 'dylib' : 'so';
const out = join(root, 'tools', 'native', plat);
const jobs = String(opt('jobs', Math.max(2, cpus().length)));
const only = new Set(String(opt('only', 'nds,gba,gb,link')).split(','));

/** The sources, at fixed versions (bump them here; SOURCES.txt in the build says which ones went in). */
// mGBA's master with the rewritten GBA lockstep driver – the link host's libmgba AND the fast player's GBA core: a link
// session starts from the player's running game (the fast player's save state, loaded into the link host) and hands the
// console back the same way, so both must speak one save-state format (mGBA refuses states from a newer version).
const MGBA_LINK = 'd58ea8a86f30598fbf3958585de3d33028535072';
export const SOURCES = {
  nds: { name: 'melonDS DS', repo: 'https://github.com/JesseTG/melonds-ds.git', ref: 'v1.4.0', file: `melondsds_libretro.${ext}`, license: ['LICENSE', 'LICENSE-melonds-ds-GPL-3.0.txt'] },
  gba: { name: 'mGBA (libretro, the link host\'s commit)', repo: 'https://github.com/mgba-emu/mgba.git', ref: MGBA_LINK, dir: 'link', file: `mgba_libretro.${ext}`, license: ['LICENSE', 'LICENSE-mgba-MPL-2.0.txt'] },
  // Game Boy / Game Boy Color: SameBoy's libretro core from the link host's SameBoy (Gambatte's save states can't go into
  // a link session – and SameBoy is the more accurate emulator anyway). Every seat is a Game Boy Color (CGB-E), as in the
  // link host.
  gb: { name: 'SameBoy (libretro)', repo: 'https://github.com/LIJI32/SameBoy.git', ref: 'v1.0.5', dir: 'sameboy', file: `sameboy_libretro.${ext}`, license: ['LICENSE', 'LICENSE-sameboy-MIT.txt'] },
  // the link host links libmgba statically: mGBA's master has the rewritten GBA lockstep driver (sleep/wake instead of
  // blocking threads – what a single-threaded, deterministic scheduler needs). Pinned: every peer must run the same
  // build, or the consoles drift apart (the session compares RAM hashes).
  // GB/GBC link sessions run on SameBoy (MIT): bit-level serial cable between two consoles, cycle-interleaved. Its boot
  // ROM is built from source with RGBDS (rgbasm/rgblink: brew install rgbds; apt install rgbds; Windows: the release zip)
  sameboy: { name: 'SameBoy (link host, Game Boy / Game Boy Color)', repo: 'https://github.com/LIJI32/SameBoy.git', ref: 'v1.0.5', file: null, license: ['LICENSE', 'LICENSE-sameboy-MIT.txt'] },
  // DS link sessions run melonDS's core library directly (several NDS instances in one process, a deterministic local-
  // wireless layer in native/link-host/backend_melonds.cpp): the melonDS fork melonDS DS v1.4.0 builds, at the commit its
  // branch jtg/fix-uninitialized-opengl had then. Interpreter only (no JIT: the same results on arm64 and x64 peers).
  melonds: { name: 'melonDS (link host, DS)', repo: 'https://github.com/JesseTG/melonDS.git', ref: '16f127dbb587a73371827ce79689c5d237c4b59b', file: null, license: ['LICENSE', 'LICENSE-melonds-GPL-3.0.txt'] },
  link: { name: 'mGBA (libmgba, link host)', repo: 'https://github.com/mgba-emu/mgba.git', ref: MGBA_LINK, file: win ? 'linkhost.exe' : 'linkhost', license: ['LICENSE', 'LICENSE-mgba-MPL-2.0.txt'] },
};
const HOST = win ? 'retrohost.exe' : 'retrohost';

if (has('check')) {
  const need = [HOST, ...Object.values(SOURCES).map((s) => s.file).filter(Boolean)]; // (the link host included: trades and battles)
  const missing = need.filter((f) => !existsSync(join(out, f)));
  if (!missing.length) {
    console.log(`fast player part: ${out} ✓`);
    process.exit(0);
  }
  const msg = `fast player part incomplete in ${out} (missing: ${missing.join(', ')}). Build it with \`npm run native\` (see docs/DEVELOPMENT.md › "Fast player").`;
  if (process.env.SLS_NO_NATIVE) {
    console.warn(`${msg}\nSLS_NO_NATIVE is set: building without it – the browser emulator plays every game.`);
    process.exit(0);
  }
  console.error(`${msg}\nOr set SLS_NO_NATIVE=1 to build without it.`);
  process.exit(1);
}

const run = (cmd, a, o = {}) => {
  console.log(`$ ${cmd} ${a.join(' ')}`);
  const r = spawnSync(cmd, a, { stdio: 'inherit', ...o });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status})`);
};

const MINGW = 'x86_64-w64-mingw32';
const cc = process.env.CC || (win ? (cross ? `${MINGW}-gcc` : 'gcc') : 'cc');
const cxx = process.env.CXX || (win ? (cross ? `${MINGW}-g++` : 'g++') : 'c++');

/** A checkout of `s` at its ref in _ref/native (cloned once; `dir`: shared with another part built from the same source). */
function source(key) {
  const s = SOURCES[key];
  const dir = join(root, '_ref', 'native', `${s.dir || key}-${s.ref.slice(0, 12)}`);
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    run('git', ['init', '-q', dir]);
    run('git', ['-C', dir, 'remote', 'add', 'origin', s.repo]);
    run('git', ['-C', dir, 'fetch', '-q', '--depth', '1', 'origin', s.ref]);
    run('git', ['-C', dir, 'checkout', '-q', 'FETCH_HEAD']);
  }
  return dir;
}

/**
 * melonDS DS links `-lonecore`, but uses nothing from it (the built DLL imports only the CRT, KERNEL32, WS2_32 and
 * IPHLPAPI). Newer MinGW-w64 (Homebrew) ships libonecore.a, Ubuntu's doesn't – there an empty stand-in lets the link
 * go through. Returns the extra linker flag, or ''.
 */
function onecoreStub() {
  const found = spawnSync(cc, ['-print-file-name=libonecore.a'], { encoding: 'utf8' }).stdout?.trim() || '';
  if (found && found !== 'libonecore.a' && existsSync(found)) return '';
  const dir = join(root, '_ref', 'native', 'stub-libs');
  mkdirSync(dir, { recursive: true });
  const lib = join(dir, 'libonecore.a');
  if (!existsSync(lib)) run(cross ? `${MINGW}-ar` : 'ar', ['rcs', lib]);
  console.log(`(no libonecore.a in the toolchain – linking against an empty stand-in in ${dir})`);
  return ` -L${dir}`;
}

/** CMake arguments for the target platform (the compiler, Windows cross build, a static runtime). */
function cmakeTarget() {
  const a = ['-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_POLICY_VERSION_MINIMUM=3.5'];
  if (os === 'darwin') a.push(`-DCMAKE_OSX_ARCHITECTURES=${arch === 'arm64' ? 'arm64' : 'x86_64'}`, '-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0');
  if (win) {
    const st = `-static -static-libgcc -static-libstdc++${onecoreStub()}`;
    a.push(`-DCMAKE_C_COMPILER=${cc}`, `-DCMAKE_CXX_COMPILER=${cxx}`, `-DCMAKE_SHARED_LINKER_FLAGS=${st}`, `-DCMAKE_MODULE_LINKER_FLAGS=${st}`);
    if (cross) a.push('-DCMAKE_SYSTEM_NAME=Windows', '-DCMAKE_SYSTEM_PROCESSOR=x86_64', `-DCMAKE_RC_COMPILER=${MINGW}-windres`, `-DCMAKE_FIND_ROOT_PATH=/usr/${MINGW}`,
      '-DCMAKE_FIND_ROOT_PATH_MODE_PROGRAM=NEVER', '-DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=ONLY', '-DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=ONLY', '-DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=ONLY');
  } else if (os === 'linux') {
    a.push(`-DCMAKE_C_COMPILER=${cc}`, `-DCMAKE_CXX_COMPILER=${cxx}`, '-DCMAKE_SHARED_LINKER_FLAGS=-static-libgcc -static-libstdc++', '-DCMAKE_MODULE_LINKER_FLAGS=-static-libgcc -static-libstdc++');
  }
  return a;
}

/**
 * souldew's patches to a checkout (native/<dir>/*.patch, in name order), each applied once: one whose reverse applies is
 * in already. melonDS: the depth of the 3D frame on screen for Shared World (native/melonds-patch); melonDS DS: the
 * function that hands it out (native/melonds-ds-patch).
 */
function applyPatches(src, dir) {
  const d = join(root, 'native', dir);
  if (!existsSync(d)) return;
  for (const n of readdirSync(d).filter((f) => f.endsWith('.patch')).sort()) {
    const patch = join(d, n);
    if (spawnSync('git', ['apply', '--reverse', '--check', patch], { cwd: src }).status === 0) continue;
    run('git', ['apply', patch], { cwd: src });
  }
}

/** The core's license next to it (it ships with the app). */
function license(key, src) {
  const [from, to] = SOURCES[key].license;
  copyFileSync(join(src, from), join(out, to));
}

function buildNds() {
  const src = source('nds');
  applyPatches(src, 'melonds-ds-patch');
  // its melonDS: the link host's checkout (the pinned commit of the fork's branch melonDS DS fetches), with souldew's patch
  const melon = source('melonds');
  applyPatches(melon, 'melonds-patch');
  const build = join(src, `build-${plat}`);
  // no OpenGL (the page draws the picture), no Wi-Fi (souldew never goes online through the core), the JIT on
  run('cmake', [...cmakeTarget(), '-DENABLE_OPENGL=OFF', '-DENABLE_JIT=ON', '-DENABLE_LTO_RELEASE=OFF', '-DBUILD_TESTING=OFF', '-DTRACY_ENABLE=OFF',
    `-DFETCHCONTENT_SOURCE_DIR_MELONDS=${melon}`, '-S', src, '-B', build]);
  run('cmake', ['--build', build, '--parallel', jobs]);
  copyFileSync(join(build, 'src', 'libretro', SOURCES.nds.file), join(out, SOURCES.nds.file));
  license('nds', src);
}

function buildGba() {
  const src = source('gba');
  const build = join(src, `build-libretro-${plat}`);
  const off = ['QT', 'SDL', 'GL', 'GLES2', 'GLES3', 'EPOXY'].map((x) => `-DBUILD_${x}=OFF`);
  const no = ['FFMPEG', 'ZLIB', 'LIBZIP', 'MINIZIP', 'PNG', 'SQLITE3', 'ELF', 'LUA', 'EDITLINE', 'DISCORD_RPC', 'EPOXY', 'JSON_C'].map((x) => `-DUSE_${x}=OFF`);
  // (Windows: master's libretro target compiles the Windows directory code, which needs ENABLE_DIRECTORIES's types)
  const winDirs = win ? ['-DCMAKE_C_FLAGS=-DENABLE_DIRECTORIES'] : [];
  run('cmake', [...cmakeTarget(), '-DBUILD_LIBRETRO=ON', '-DBUILD_SHARED=OFF', '-DBUILD_STATIC=OFF', '-DSKIP_LIBRARY=ON', '-DENABLE_SCRIPTING=OFF', '-DENABLE_DEBUGGERS=OFF',
    '-DENABLE_GDB_STUB=OFF', '-DBUILD_LTO=OFF', ...winDirs, ...off, ...no, '-S', src, '-B', build]);
  run('cmake', ['--build', build, '--parallel', jobs, '--target', 'mgba_libretro']);
  copyFileSync(join(build, SOURCES.gba.file), join(out, SOURCES.gba.file));
  license('gba', src);
}

/**
 * SameBoy's libretro core (its boot ROMs assembled from source with RGBDS – needed for the link host anyway). The Game
 * Boy Color boot ROM built in is SameBoy's fast one (no logo animation: a game starts at once, as with Gambatte before);
 * a boot ROM is no part of a save state, so the link host's (the full one) and this one still trade states.
 */
function buildGb() {
  const src = source('gb');
  const platform = win ? 'win' : os === 'darwin' ? 'osx' : 'unix';
  const roms = ['agb', 'cgb', 'cgb0', 'dmg', 'mgb', 'sgb', 'sgb2'];
  const built = join(src, 'build', 'bin', 'BootROMs');
  run('make', ['-C', src, 'bootroms', join('build', 'bin', 'BootROMs', 'cgb_boot_fast.bin'), `CC=${process.env.HOST_CC || 'cc'}`]); // (pb12: a build-time helper)
  const boot = join(src, `build-libretro-bootroms`);
  mkdirSync(boot, { recursive: true });
  for (const r of roms) copyFileSync(join(built, r === 'cgb' ? 'cgb_boot_fast.bin' : `${r}_boot.bin`), join(boot, `${r}_boot.bin`));
  for (const r of roms) rmSync(join(src, 'libretro', `${r}_boot.c`), { force: true }); // (made from the .bin files above: never an older one)
  const bin = join(src, `build-libretro-${plat}`);
  mkdirSync(bin, { recursive: true });
  const extra = os === 'darwin' ? [`ARCHFLAGS=-arch ${arch === 'arm64' ? 'arm64' : 'x86_64'} -mmacosx-version-min=11.0`] : os === 'linux' ? ['LDFLAGS=-static-libgcc -lm'] : []; // (a LDFLAGS on make's command line replaces the Makefile's, -lm included)
  const mk = ['-C', join(src, 'libretro'), `platform=${platform}`, `BOOTROMS_DIR=${boot}`, `BIN=${bin}`, `CC=${cc}`, 'GIT_VERSION=" souldew"', ...extra];
  run('make', [...mk, 'clean'], { stdio: 'ignore' }); // (its objects sit next to the sources: none of another platform's)
  run('make', [...mk, `-j${jobs}`]);
  copyFileSync(join(bin, SOURCES.gb.file), join(out, SOURCES.gb.file));
  license('gb', src);
}

/**
 * The link host: native/link-host (the session + its backends) – libmgba (static, no frontends) for the GBA, SameBoy for
 * GB/GBC, melonDS's core for the DS – one executable, statically linked (Windows: nothing but Windows' own DLLs).
 */
function buildLink() {
  const src = source('link');
  const build = join(src, `build-static-${plat}`);
  const off = ['QT', 'SDL', 'GL', 'GLES2', 'GLES3', 'LIBRETRO', 'SHARED'].map((x) => `-DBUILD_${x}=OFF`);
  const no = ['FFMPEG', 'ZLIB', 'LIBZIP', 'MINIZIP', 'PNG', 'SQLITE3', 'ELF', 'LUA', 'EDITLINE', 'DISCORD_RPC', 'EPOXY', 'JSON_C'].map((x) => `-DUSE_${x}=OFF`);
  // (LIBMGBA_ONLY: the library alone – no frontends, and on Windows no epoxy/OpenGL requirement)
  run('cmake', [...cmakeTarget(), '-DBUILD_STATIC=ON', '-DLIBMGBA_ONLY=ON', '-DBUILD_LTO=OFF', '-DENABLE_SCRIPTING=OFF', '-DENABLE_DEBUGGERS=OFF', '-DENABLE_GDB_STUB=OFF', ...off, ...no, '-S', src, '-B', build]);
  run('cmake', ['--build', build, '--parallel', jobs, '--target', 'mgba']);
  // the compile definitions libmgba was built with (its structs change shape with them)
  const defs = ninjaDefines(build, /build CMakeFiles\/mgba\.dir\/src\/core\/core\.c\.o[\s\S]*?DEFINES = ([^\n]*)/);
  const flags = os === 'darwin' ? ['-arch', arch === 'arm64' ? 'arm64' : 'x86_64', '-mmacosx-version-min=11.0'] : [];
  const libs = os === 'darwin' ? ['-framework', 'CoreFoundation'] : os === 'linux' ? ['-static-libgcc', '-static-libstdc++', '-lpthread', '-lm']
    : ['-static', '-static-libgcc', '-static-libstdc++', '-lshlwapi', '-lshell32', '-luuid', '-lws2_32', '-lole32', '-lwinmm', '-lm'];
  const sb = buildSameBoy(flags);
  const ds = buildMelonDS();
  const obj = join(build, 'souldew');
  mkdirSync(obj, { recursive: true });
  const objects = [];
  // the engine (seats, session, picture/sound, the frame loop), its backends, and native/common (shared with retrohost)
  const sources = [...['linkhost.c', 'seats.c', 'session.c', 'avout.c', 'backend_mgba.c', 'backend_sameboy.c'].map((f) => join(root, 'native', 'link-host', f)), ...COMMON];
  for (const f of sources) {
    const o = join(obj, `${f.includes(join('native', 'common')) ? 'common-' : ''}${f.split(/[\\/]/).pop().replace(/\.c$/, '.o')}`);
    run(cc, ['-O2', '-std=gnu11', '-Wall', ...COMMON_FLAGS, ...flags, ...defs, '-I', join(src, 'include'), '-I', join(build, 'include'), ...sb.cflags, '-c', f, '-o', o]);
    objects.push(o);
  }
  const dso = join(obj, 'backend_melonds.o');
  run(cxx, ['-O2', '-std=c++17', '-Wall', '-Wno-unused-function', ...flags, ...ds.cflags, '-c', join(root, 'native', 'link-host', 'backend_melonds.cpp'), '-o', dso]);
  objects.push(dso);
  const exe = join(out, SOURCES.link.file);
  run(cxx, [...flags, '-o', exe, ...objects, ...sb.objects, join(build, 'libmgba.a'), ...ds.libs, ...libs]);
  if (!win) chmodSync(exe, 0o755);
  license('link', src);
}

/** The -D flags a target's object was compiled with (from a Ninja build file). */
function ninjaDefines(build, re) {
  const ninja = readFileSync(join(build, 'build.ninja'), 'utf8');
  return (ninja.match(re)?.[1] || '').split(/\s+/).filter((d) => d.startsWith('-D'));
}

/**
 * melonDS's core library for the link host's DS backend (native/link-host/backend_melonds.cpp): no frontend, no OpenGL,
 * no GDB stub. The JIT is built in for a game played alone (the souldew engine's solo mode, as fast as the fast player's
 * melonDS DS); link sessions switch it off per console (its timing differs from the interpreter's, and every peer must
 * compute the same). Returns the flags to compile against it (the same definitions – its classes change shape with
 * them) and the static libraries.
 */
function buildMelonDS() {
  const src = source('melonds');
  applyPatches(src, 'melonds-patch');
  const build = join(src, `build-core-${plat}`);
  run('cmake', [...cmakeTarget(), '-DBUILD_QT_SDL=OFF', '-DENABLE_OGLRENDERER=OFF', '-DENABLE_GDBSTUB=OFF', '-DENABLE_JIT=ON', '-DENABLE_LTO_RELEASE=OFF', '-DENABLE_LTO=OFF',
    '-DUSE_VCPKG=OFF', '-DMELONDS_EMBED_BUILD_INFO=OFF', '-S', src, '-B', build]);
  run('cmake', ['--build', build, '--parallel', jobs, '--target', 'core']);
  const defs = ninjaDefines(build, /build src\/CMakeFiles\/core\.dir\/NDS\.cpp\.o[\s\S]*?DEFINES = ([^\n]*)/);
  license('melonds', src);
  return {
    cflags: [...defs, '-I', join(src, 'src'), '-I', join(build, 'src')],
    libs: [join(build, 'src', `libcore.a`), join(build, 'src', 'teakra', 'src', 'libteakra.a')],
  };
}

/**
 * SameBoy's core for the link host's Game Boy backend (native/link-host/backend_sameboy.c): its Core/*.c without the
 * debugger, rewind, cheats and real-time pacing, the core's time() pointed at the session clock (determinism: no wall
 * clock), and its CGB and DMG boot ROMs (assembled from SameBoy's source with RGBDS) as C arrays. Returns objects + cflags.
 */
function buildSameBoy(flags) {
  const src = source('sameboy');
  const obj = join(src, `build-souldew-${plat}`);
  mkdirSync(obj, { recursive: true });
  // (pb12 is a build-time helper: host compiler)
  run('make', ['-C', src, 'build/bin/BootROMs/cgb_boot.bin', 'build/bin/BootROMs/cgb_boot_fast.bin', 'build/bin/BootROMs/dmg_boot.bin', `CC=${process.env.HOST_CC || 'cc'}`]);
  const bootC = join(obj, 'sbl_boot.c');
  const rom = (name, file = `${name}_boot.bin`) => {
    const b = readFileSync(join(src, 'build', 'bin', 'BootROMs', file));
    return `const unsigned char sbl_${name}_boot[] = {${[...b].join(',')}};\nconst unsigned sbl_${name}_boot_length = ${b.length};\n`;
  };
  // (cgb_fast: the Game Boy Color's boot ROM without the logo animation – the engine's solo mode, as the fast player)
  writeFileSync(bootC, `/* SameBoy's boot ROMs (MIT), assembled from BootROMs/cgb_boot.asm and dmg_boot.asm */\n${rom('cgb')}${rom('cgb_fast', 'cgb_boot_fast.bin')}${rom('dmg')}`);
  // the core's time() → the session clock: a header included first (time.h, then the macro) – not -Dtime=…, which on
  // Windows would rename MinGW's inline time() in <time.h> and leave the wall clock in place
  const timeH = join(obj, 'sbl_time.h');
  writeFileSync(timeH, '/* souldew: SameBoy\'s clock is the link session\'s (backend_sameboy.c) */\n#include <time.h>\ntime_t sbl_time(time_t *t);\n#define time(t) sbl_time(t)\n');
  const defs = ['-DGB_INTERNAL', '-DGB_DISABLE_TIMEKEEPING', '-DGB_DISABLE_REWIND', '-DGB_DISABLE_DEBUGGER', '-DGB_DISABLE_CHEATS', '-DGB_DISABLE_CHEAT_SEARCH',
    '-D_GNU_SOURCE', '-D_USE_MATH_DEFINES', '-DNDEBUG', `-DGB_VERSION="${SOURCES.sameboy.ref.replace(/^v/, '')}"`];
  const files = ['gb', 'sgb', 'apu', 'memory', 'mbc', 'timing', 'display', 'camera', 'sm83_cpu', 'joypad', 'save_state', 'random', 'rumble'];
  const objects = [];
  for (const f of files) {
    const o = join(obj, `${f}.o`);
    run(cc, ['-O2', '-std=gnu11', '-w', ...flags, ...defs, '-include', timeH, '-I', src, '-c', join(src, 'Core', `${f}.c`), '-o', o]);
    objects.push(o);
  }
  const bo = join(obj, 'sbl_boot.o');
  run(cc, ['-O2', ...flags, '-c', bootC, '-o', bo]);
  objects.push(bo);
  license('sameboy', src);
  return { objects, cflags: ['-I', src, '-DGB_DISABLE_REWIND', '-DGB_DISABLE_DEBUGGER', '-DGB_DISABLE_CHEATS', '-DGB_DISABLE_CHEAT_SEARCH'] };
}

/**
 * native/common: what both hosts share – IPC (hostio), the RAM stream for live tracking (ramstream), the fast-forward
 * sound (ffaudio) and the frame loop's rhythm (cadence). Plain C, its OS calls from native/ctr-host/compat.h.
 */
const COMMON = ['hostio.c', 'ramstream.c', 'ffaudio.c', 'cadence.c', 'depth.c'].map((f) => join(root, 'native', 'common', f));
// (compat.h's Windows crash-report helpers are unused by the common files: no warnings for them)
const COMMON_FLAGS = ['-Wno-unused-function'];

function buildHost() {
  const exe = join(out, HOST);
  const libs = os === 'linux' ? ['-ldl', '-lpthread', '-lm'] : win ? ['-static', '-lm'] : [];
  const flags = os === 'darwin' ? [`-arch`, arch === 'arm64' ? 'arm64' : 'x86_64', '-mmacosx-version-min=11.0'] : [];
  run(cc, ['-O2', '-Wall', ...COMMON_FLAGS, ...flags, '-I', join(root, 'native', 'ctr-host'), '-o', exe, join(root, 'native', 'retro-host', 'retrohost.c'), ...COMMON, ...libs]);
  if (!win) chmodSync(exe, 0o755);
}

mkdirSync(out, { recursive: true });
buildHost();
if (!has('host-only')) {
  if (only.has('nds')) buildNds();
  if (only.has('gba')) buildGba();
  if (only.has('gb')) buildGb();
  if (only.has('link')) buildLink();
}
const lines = Object.entries(SOURCES).filter(([, s]) => existsSync(join(out, s.file || SOURCES.link.file))).map(([, s]) => `${s.file || SOURCES.link.file}: ${s.name} ${s.ref} – ${s.repo.replace(/\.git$/, '')}`);
const prev = existsSync(join(out, 'SOURCES.txt')) ? readFileSync(join(out, 'SOURCES.txt'), 'utf8') : '';
writeFileSync(join(out, 'SOURCES.txt'), `${[`${HOST}: souldew native/retro-host/retrohost.c`, ...lines].join('\n')}\n`);
if (prev && prev !== readFileSync(join(out, 'SOURCES.txt'), 'utf8')) console.log('SOURCES.txt updated');
console.log(`fast player part: ${out}`);
