# Developing souldew

Building from source, releasing updates and how the code is organised. Back to the [README](../README.md).

## Building from source

Requirements: **Node.js ≥ 22.15** and git; macOS (Apple silicon) to build the DMG, Windows 10/11 x64 to build the Windows installer, Linux x64 to build the AppImage and the .deb. The server, the tests and `npm run app` run on macOS, Windows and Linux.

```sh
npm ci                 # install dependencies
npm run app            # Electron app in development mode (data in the Electron profile)
npm start              # server only, UI in the browser (data in the project folder: runs/, library/)
npm test               # all tests (node --test "test/*.test.mjs"); a test that waits forever fails after 10 min
npm run lint           # ESLint (eslint.config.mjs)
node scripts/extract-i18n.mjs   # sync UI strings, list missing/stale translations
npm run ctr            # macOS: build the 3DS part (see "Nintendo 3DS" below)
npm run native         # build the fast player part (see "Fast player" below)
npm run dist           # macOS: build the DMG (fetches the Java runtime on first run; needs the 3DS part)
npm run dist:win       # Windows: build the NSIS installer (fetches the Windows Java runtime on first run)
npm run dist:linux     # Linux: build the AppImage and the .deb (fetches the Linux Java runtime on first run)
```

**Library paths.** The page can only hand the server path strings, so the library takes them from approved places
only (`server/lib/library.mjs` `approvedImportPath` / `approvedFolder`, `server/lib/grants.mjs`): "Add files" and
"Search my Mac / PC" import from the folders discovery looks through (Downloads, Desktop, Documents, game and emulator
folders …), from folders already in the library, and from files or folders picked in the app's native dialog this
session – the Electron main process registers those from the dialog's result, the page can't. "Use a folder" /
"Include a folder" takes only a folder picked in that dialog. In the browser (`npm start`) there is no native dialog:
"Search my Mac / PC" and uploading files work as before; to include a folder, add it to `libraryFolders` in
`runs/config.json` (the data folder's `config.json` with `SLS_DATA_DIR`) while the server is stopped.

| Command | Purpose |
|---|---|
| `PORT=… SLS_DATA_DIR=… NO_OPEN=1 node server/index.mjs` | A second instance with its own data folder – e.g. to test several players on one machine |
| `npm run app -- --user-data-dir=/some/folder` | The Electron app with a separate profile and data folder (never point it at your real data while testing) |
| `npm run dist` | Runs `scripts/fetch-jre.mjs` (Temurin JRE 17 for arm64 into `tools/jre/`) and electron-builder. `scripts/dmgbuild-wrapper.mjs` moves the DMG window's hidden files below the visible area; the background image is rendered with `node scripts/render-dmg-background.mjs` from `build/dmg-background.html`. |
| `npm run dist:win` | On Windows: `scripts/fetch-jre.mjs x64` (Temurin JRE 17 for x64 into `tools/jre/win32-x64`) and electron-builder → `dist/souldew-<version>-win-x64-setup.exe` (NSIS, one click, per user, no admin rights) plus `dist/win-unpacked/`. Unsigned: there is no code-signing certificate (SmartScreen, see the README). |
| `npm run dist:linux` | On Linux: `scripts/fetch-jre.mjs x64` (Temurin JRE 17 into `tools/jre/linux-x64`) and electron-builder → `dist/souldew-<version>-linux-x86_64.AppImage`, `dist/souldew-<version>-linux-amd64.deb` and `dist/linux-unpacked/`. The [Linux workflow](../.github/workflows/linux.yml) builds both on `ubuntu-latest`. |
| `node scripts/smoke-app.mjs dist/win-unpacked/souldew.exe` | Starts a built app with a throwaway profile, checks that its server answers, the page loads and the bundled Java runs the randomizer, then quits it. Refuses to run while something already listens on port 47390 (your installed souldew). Also takes `dist/linux-unpacked/souldew`, an `.AppImage`, or `--dev` for `npm run app` from the checkout – on a Linux machine without a screen under `xvfb-run -a`. |
| `node scripts/build-icon-ico.mjs` | Rebuilds `build/icon.ico` (16–256 px) from `build/icon.png` – macOS only (uses `sips`); commit the result. |
| `npm run release` | Sign and package an update (see below) |

**Windows from a Mac:** `npx electron-builder --win nsis --x64` also works on macOS (without the Windows Java runtime, which only `fetch-jre.mjs` on Windows can build) – good for checking the packaging, not for shipping. The real installer comes from Windows or from the [Windows workflow](../.github/workflows/windows.yml), which builds it on `windows-latest`, smoke-tests the unpacked and the installed app and keeps the installer as an artifact.

**Linux** is built and tested by the [Linux workflow](../.github/workflows/linux.yml) on `ubuntu-latest` under a virtual display (xvfb): `npm run app` from the checkout, the unpacked app (incl. the one-click emulator AppImages), the AppImage (and that it recognises itself for the updater) and the .deb (install, start, removal). Chromium's sandbox needs unprivileged user namespaces; Ubuntu 24.04 restricts them, so the workflow allows them (`sysctl kernel.apparmor_restrict_unprivileged_userns=0`) – on such a machine `npm run app` needs the same, or `npm run app -- --no-sandbox`. The AppImage adds `--no-sandbox` by itself where namespaces are missing; the .deb sets up `chrome-sandbox`.

**Platform differences in the code:** the window frame and the menu (`electron/main.mjs`: traffic lights vs. Windows' title bar buttons over the page vs. the Linux desktop's own frame; no visible menu bar on Windows and Linux, the shortcuts stay), the updater (`electron/updater.mjs`: swap the .app vs. run the NSIS installer vs. replace the AppImage), "Search my Mac / PC" (`server/lib/library.mjs` → `discoverCandidates`; on Linux also EmuDeck, RetroDECK, RetroArch and SD cards), the emulator downloads (`server/lib/emulator.mjs`; on Windows/Linux unpacked in JavaScript by `server/lib/archive.mjs` / `sevenzip.mjs`), and texts and shortcuts in the UI (`web/lib/platform.mjs`: `IS_MAC` / `IS_WIN` / `IS_LINUX`, `shortcut('Mod+B')` → ⌘B / Ctrl+B; `styles.css` `.platform-win32` / `.platform-linux`). The tests run on Ubuntu and Windows in CI; `test/windows.test.mjs` and `test/linux.test.mjs` check each platform's path rules on any OS.

**Graphics backend and Chromium switches:** Settings › General › "Graphics backend" (Windows and Linux) is stored as `gpuBackend` in `config.json` and read by `electron/main.mjs` before the app is ready (`shared/gpu.mjs`): Windows `--use-angle=d3d11|vulkan|gl`, Linux `--use-gl=angle --use-angle=gl|vulkan`, "Automatic" sets nothing. A start with a chosen backend that never shows the window is remembered (`gpuStart`); after two of them in a row – or three GPU process crashes in one session – the next start uses "Automatic" again and the page says so once (`gpuFallback`). For experiments, `SOULDEW_CHROMIUM_FLAGS` takes any Chromium switches, space-separated as `name` or `name=value` (leading dashes optional, `use_angle` is read as `use-angle`); a backend chosen in Settings replaces the variable's `use-angle` / `use-gl`, "Automatic" leaves them alone. "Save diagnostics" lists the switches in effect, Chromium's GPU feature status and the graphics cards with their drivers.

```sh
SOULDEW_CHROMIUM_FLAGS="use_angle=vulkan ignore-gpu-blocklist" npm run app -- --user-data-dir=/tmp/souldew-gfx
```

(PowerShell: `$env:SOULDEW_CHROMIUM_FLAGS="use_angle=vulkan"; npm run app -- --user-data-dir="$env:TEMP\souldew-gfx"`.)

New visible text always goes through `t('area.key', 'English default', { vars })`; then translate it for de/fr/es/it – `node scripts/extract-i18n.mjs` must end with "0 missing, 0 stale" for every language. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## Fast player (DS, GBA, Game Boy)

DS, GBA and Game Boy games play in the fast player when its part is there: a native host
(`native/retro-host/retrohost.c`) runs melonDS DS (with its JIT), mGBA or SameBoy as a native program, and
`web/playernative.html` / `web/lib/nativeplayer.mjs` offer the play view the same `window.__emu` API as the
EmulatorJS player. The host speaks the 3DS host's protocol plus a few messages (header of `retrohost.c`): the game's RAM
regions are mirrored in the page (what changed, ten times a second, between two frames – the live reader reads them
synchronously as before), the battery save comes out when the game saved (and settled) and goes in at the start,
cheats are written between frames, `STEP n` runs exactly n frames (the ROM matrix). `server/lib/native.mjs` knows the
cores, their RAM and options and reuses the 3DS sessions (`/api/native/*`). Settings › "Fast player" switches it off
(`config.nativeCore`); when the host can't start a game the play view falls back to `player.html` by itself. Save
states carry the core id (`melonds-native`, `mgba-native`, `sameboy-native`) – the other player's states aren't offered (nor
the older Game Boy player's, `gambatte-native`). The GBA and Game Boy cores are built from the link host's mGBA commit and
SameBoy version: a link session starts from the running game's state and hands it back (docs/MULTIPLAYER.md › "Seamless").

```sh
brew install cmake ninja rgbds                  # (rgbds: SameBoy's boot ROM for the link host; Windows cross build: brew install mingw-w64)
npm run native                                  # host + melonDS DS v1.4.0 + mGBA (d58ea8a) + SameBoy v1.0.5 + link host, into tools/native/<platform>-<arch>/
node scripts/build-native.mjs --host-only       # only the host (after changing retrohost.c)
node scripts/build-native.mjs --platform win32-x64   # the Windows part, cross-compiled and statically linked
node --test test/native.test.mjs                # the real host on a Game Boy ROM the test makes (skipped when not built)
node scripts/rom-matrix.mjs <roms> --live --native   # the ROM matrix in the fast player
node scripts/native-e2e.mjs <roms>              # the app UI: native player taken, speeds 1×/2×/4×/Max, save states
```

Sources are cloned at their tags into `_ref/native/` (not in the repository). Two small patches are applied to them:
`native/melonds-patch/` (melonDS's software renderer keeps the depth of the 3D frame on screen while asked) and
`native/melonds-ds-patch/` (melonDS DS exports it as `souldew_depth`) – Shared World hides DS partners behind the map
with it (docs/MULTIPLAYER.md › 9). The DS core is built against the link host's melonDS checkout (the same pinned commit
of the fork's branch melonDS DS fetches), so both carry the patch. The cores are built without OpenGL (the
page draws the picture), the DS core with its Wi-Fi switched off at run time. `npm run dist` checks the folder
(`build-native.mjs --check`); `SLS_NO_NATIVE=1 npm run dist` builds without it – everything then plays in the browser
emulator. Windows and Linux: `.github/workflows/native.yml` (Ubuntu 22.04 for Linux, MinGW-w64 cross build for Windows,
checked for foreign DLLs) feeds `release.yml`, `windows.yml` and `linux.yml`. macOS: `npm run dist` signs ad hoc without
the hardened runtime; the release build (`npm run dist:mac-signed`, see "Releasing updates") signs with the Developer ID
and the hardened runtime – the JIT's executable memory (MAP_JIT) then needs `com.apple.security.cs.allow-jit`, which
`build/entitlements.mac.inherit.plist` gives every program souldew starts (Java, the hosts). The compilers get
`-ffile-prefix-map` from both build scripts (`scripts/buildpaths.mjs`), so no binary carries the build machine's paths
(the home folder holds the account name); `--check` refuses a part that does.

## Nintendo 3DS

3DS games play in souldew's own player through a small native host (`native/ctr-host/ctrhost.c`) that runs Azahar's
libretro core with Vulkan, and `web/player3ds.html` / `web/lib/ctrplayer.mjs`, which offer the play view the same
`window.__emu` API as the EmulatorJS player. `server/lib/ctr.mjs` starts the host and passes its messages through
(`/api/ctr/*`). The host's messages (pictures, sound, memory – ~25 MB/s) reach the page over a WebSocket on
`/api/ctr/stream` (the fast player: `/api/native/stream`; `server/lib/wsstream.mjs`, `web/lib/hoststream.mjs`), the
page's commands go by POST. Since 3.0.1: as one endless HTTP response, antivirus with HTTP scanning kept the whole body
in `C:\Windows\Temp` until the game closed (#38). The page says how much it has handled; the server holds the host back
while the page is more than 2 MB behind, as TCP did for the HTTP stream. The HTTP stream stays as the fallback. The binaries live in `tools/ctr/<platform>-<arch>/` (not in the repository) and go into the DMG:

```sh
brew install cmake ninja spirv-tools vulkan-headers   # as Azahar's own CI
npm run ctr                                           # host + Azahar 2126.2 core with the souldew patch + MoltenVK
node scripts/build-ctr.mjs --host-only                # only the host (after changing ctrhost.c)
node scripts/build-ctr.mjs --src ../azahar            # reuse an Azahar checkout (with submodules)
```

The core build takes a while (Azahar from source, `--target citra_libretro`). The patches in `native/azahar-patch/` are
applied in name order. `native/azahar-patch/souldew-romfs.patch` logs every RomFS read the game makes (offset, length,
which RomFS – a lock-free ring in `IVFCFile::Read`) and adds `souldew_romfs_reads`, `souldew_romfs_read` and
`souldew_romfs_size`: ctrhost sends the reads to the page (message 9) and reads RomFS bytes for it (ROMREAD/ROMDATA), so
"music from the ROM" (`shared/ctr/rommusic.mjs`, `web/lib/rommusic.mjs`, `web/lib/romvoice.mjs`) knows which stream the
game plays and where. `native/azahar-patch/souldew-sfx.patch` (`src/common/souldew_music.h`) recognises the DSP voices
that play the game's streamed music – the page names the stream files (MUSIC), the core fingerprints the game's reads
of them and matches the bytes a voice starts playing (DSP-ADPCM; X/Y's AAC through the DSP's AAC decoder's output) – and,
while the page asks (SFX) and the game fast-forwards, leaves them out of the frames it hands to the audio callback (the
game's own DSP state and final mix stay as they are). `souldew_audio_frame_flags` says per DSP frame whether a new sound
began (key-on) and whether the music was left out; ctrhost sends that sound as message 11 and the turbo mixer plays each
sound at 1× over the ROM track (`web/lib/sfxplayer.mjs`). An unknown voice streaming queued buffers for half a second
makes the core leave everything in (the page then plays no sound effects). `native/azahar-patch/souldew-state.patch`
adds `souldew_state_begin`, `souldew_state_poll` and `souldew_state_take`: a save state stops the game only while its
memory (~300 MB) is copied into one buffer, zstd and the header run on a thread, and ctrhost answers SAVE a few frames
later (Azahar's own `retro_serialize_size` packs it between two frames: 0.4 s without sound on a Windows PC – every
2 minutes, when the play view took its resume state). The play view also takes that state at a quiet moment of the
game's sound (`quietMoment` in `web/lib/ctrplayer.mjs`). `native/azahar-patch/souldew-memory.patch`
adds `souldew_read_memory`, `souldew_write_memory` and `souldew_title_id` to the core: the libretro memory map only has
what exists when the game loads, not the heaps where the Pokémon games keep their party, so without the patch the game
runs but has no live data (the status says `liveMemory: false`). `souldew_write_memory` is the Rare Candy cheat's
write – through the core's own page table, only into the game's heaps (a core without it falls back to ctrhost's page
scan). MoltenVK comes from Azahar's macOS release. `npm run dist` checks the
folder (`build-ctr.mjs --check`) and stops when it's incomplete or its core is out of date (`SOULDEW_CORE` names and
hashes the patches it was built with – a patch added or changed since means `npm run ctr` again); `SLS_NO_3DS=1 npm run dist` builds without it – 3DS
games then open in the Azahar app.

Windows and Linux: `.github/workflows/ctr.yml` builds host and core (Linux with gcc 12 on Ubuntu 22.04, Windows
cross-compiled in libretro's MXE container – as Azahar's own CI) and keeps them per source hash in the Actions cache;
`release.yml`, `windows.yml` and `linux.yml` bundle the artifact. `node scripts/build-ctr.mjs --platform win32-x64
--host-only` cross-builds the Windows host on a Mac with MinGW-w64 (`brew install mingw-w64`); the Windows core also
cross-builds with Ubuntu's MinGW-w64 (`g++-mingw-w64-x86-64-posix`, a CMake toolchain file, `-DLIBTYPE=static` and an
`x86_64-w64-mingw32.static-gcc-ar` link to the MinGW `ar` – Azahar's CMake expects MXE's names); `native/ctr-host/compat.h`
holds the few OS calls. Vulkan there is the system's loader (`vulkan-1.dll` / `libvulkan.so.1`); without it
`server/lib/ctr.mjs` reports the part as missing and 3DS games open in the Azahar app.

**Checking a Gen 1–5 game for the randomizer:** the new-run wizard's check (`POST /api/rom/inspect` →
`inspectRom` in `server/lib/toolchain.mjs`) runs `SoulLinkBridge info <rom> <settings> <seed>`: UPR's info plus a trial
run of the recommended preset – the whole randomization in memory, nothing written (under a second for a DS game). A game
UPR loads but can't randomize (a ROM hack or release whose data isn't where UPR expects it) comes back as
`reason: 'randoCrash'` and the wizard turns the randomizer off with that reason; a build that fails anyway answers
`randoFailed` with only the Java exception's class name (`randomizerError`), the bridge's output stays in the server log.

**TM compatibility follows the TM moves** (`@tmsFollowMoves`, #81 – souldew's own option, not UPR's): UPR keeps a random
TM's compatibility tied to its slot. With the option on, `SoulLinkBridge` loads the game through its handler subclass
(Gen 1–3 and 6–7 `FollowGenN`, Gen 4/5 the `SafeGen4/5RomHandler`; without it the load is unchanged), `TmFollow.snapshot`
reads every Pokémon's original TM/HM, tutor and level-up moves (with those of its pre-evolutions) before UPR runs, and
right after UPR's `randomizeTMMoves` every TM whose move changed goes to the Pokémon that could learn the new move – a
move nobody could learn to the Pokémon of its type, and with none of those the slot keeps its list. HMs and unchanged TMs
stay; UPR's own compatibility options run afterwards (the switch is only offered with "Unchanged"). The spoiler log gets
a "TM Compatibility Follows The TM Moves" section. A run with it travels as run pack `@4` (2.8.2 would build without it);
`SoulLinkBridge tmcompat <case.json>` runs the computation on test data (`test/tmfollow.test.mjs`). Gen 4's alternate
forms (Rotom, Giratina, Shaymin, Deoxys, Wormadam) are a UPR limit for every compatibility change: its Gen 4 handler
writes their compatibility to the personal-data file of their number, not their own file.

**Randomizing 3DS games** uses the same bundled UPR ZX 4.6.1 jar and `SoulLinkBridge` as Gen 1–5 – UPR's own
Gen6/Gen7RomHandler (`server/lib/ctrrando.mjs`, the 3DS branch of `server/lib/build.mjs`). Input: a decrypted `.3ds`/
`.cci`/`.cxi`/`.cia` (UPR reads the game's NCCH; an encrypted one ends with `@@CODE "encrypted"` → `ctrEncrypted` –
souldew has no keys and decrypts nothing). Output: one rebuilt, self-contained `.cxi` per world in the run folder (no
LayeredFS mod folder), hashed with a stream and compared on a join like any ROM; a shared seed builds once and hard-links
the others. The bridge runs with `-Xmx4608m` (UPR ZX's launcher value; Sun runs out below ~2 GB) and
`-Dsouldew.upr.root=<cache>/upr-3ds/<id>`: the patched `SysConstants` ahead of the jar moves UPR's `tmp_<game>` folder
out of the app (Gen 1–5 runs get `<cache>/upr-work/<id>` the same way – two runs on one game, the wizard's check during a
build, no longer take each other's unpacked files). UPR writes the `.cxi` with
`RandomAccessFile("rw")`, which doesn't truncate, so the build always deletes the target first (it may be a hard link
to the library's game). Rebuild the bridge after changing it:
`javac --release 8 -cp tools/upr/PokeRandoZX.jar:tools/upr-bridge -d tools/upr-bridge tools/upr-bridge/SoulLinkBridge.java tools/upr-bridge/TmFollow.java tools/upr-bridge/com/dabomstew/pkrandom/SysConstants.java`.
Determinism: Sun built byte-identical with Temurin 17, OpenJDK 21 and 27 ("Nuzlocke hard mode" and "Chaos"); the Gen 6/7
handlers' only enum-keyed map iteration is the weakness-berry table behind `Effectiveness.against`, already fixed.
Game updates aren't loaded (UPR could only write them as LayeredFS – it refuses one .cxi with an update loaded), and a
randomized game never gets its update in the player either (Azahar runs an installed update's code, which would undo
the randomization).

**3DS game updates** (title ID 0004000E + the game's low half, usually a `.cia`; a bare NCCH `.cxi`/`.3ds` works too):
the library lists them in `ctrUpdates`, never as games, and puts the newest one souldew can install on its game
(`rom.update`; `shared/ctr/update.mjs` `pickUpdate`) – an update added before its game waits for it. "Remove" in the
game's details deletes souldew's copy in the library folder or marks a file in an included folder
(`config.ctrUpdatesDetached`). The core finds an installed update on the emulated SD card of the save folder ctrhost
points it at (`<save>/Azahar/sdmc/Nintendo 3DS/<id0>/<id1>/title/0004000e/<low>/content/` – the smallest `.tmd` there and
the `.app` its first content record names), so `POST /api/ctr/start` installs it there before the host starts
(`server/lib/ctrupdate.mjs`): the update file is unpacked once into `<data>/ctr/updates/<stamp>/` (the CIA's TMD and
each content as it is – what Azahar's own "Install CIA" writes for a decrypted CIA; a bare NCCH gets a TMD souldew
writes) and hard-linked (copied where links fail) into the save folder, with `souldew-update.json` saying which update
it is; a save folder whose game has no update in the library any more loses the one souldew put there. Encrypted
updates (title-key content or NCCH crypto) are refused – souldew has no keys. The start's answer carries `update`
(`versionText`, `gameVersion`, `tracking` – `older` for an update before the latest, whose addresses the live data
doesn't know) for the play view. The external Azahar app is unchanged: there the player installs the update with
File › Install CIA.

Notes: New 3DS mode is on (the core's default; a savestate from Old 3DS mode would crash the core, so the play view
stores states as core `azahar-n3ds` and refuses others). The host exits with `_exit` – the core's unload crashes.
`CTRHOST_DEBUG=1` logs the input it reads; `ctrhost --bench N --dump` runs a game without souldew;
`--renderer vulkan|compat|software` (or `CTRHOST_RENDERER`) picks how the core draws – Settings › Emulators › "3DS
renderer", "Automatic" steps down by itself (server/lib/ctrrenderer.mjs). Windows and Linux
are built by CI only (see above). Research notes: [research/azahar.md](../research/azahar.md).

## Live runs ("Share to Discord")

A player links souldew to their Discord account once (Settings › Discord › "Live runs", with the code from `/live connect`)
and can then post a card of a death or a wipe to `#live-runs` on the souldew Discord – a won run becomes its own post in
the public `#hall-of-fame` forum ("Post to the Hall of Fame" in the run-won notice and the board; the bot picks the
channel by `kind: 'victory'`, titles the post from the meta and tags it from `mode` and the optional `gen`, `hack`,
`randomized`). The bot is a separate
Cloudflare Worker; its contract (v1) is: `POST /live/link` (code → token), `GET /live/me`, `DELETE /live/link` and
`POST /live/post` (multipart: `meta` JSON + `image` 1200×675 PNG ≤ 1.5 MB).

| Part | What it does |
|---|---|
| `shared/liveruns.mjs` | Event ids (`run-<runId>:<kind>:…`, the same for every player of a run – a partner's post makes the bot answer 409), the `meta` limits and filters (no links, no control characters, no file names), the link code, the PNG check |
| `server/lib/liveruns.mjs` | The only code that talks to the bot and the only code that sees the token. `/api/liveruns` (state), `/api/liveruns/link` (POST link, DELETE unlink), `/api/liveruns/post` |
| `web/lib/liveshare.mjs` | The card model from the run doc (headline, the killer from `pair.killer`, the place sign stored with the death as `pair.place`, every player's live team), the post's text, the share |
| `web/lib/livecard.mjs` | Paints the card on a canvas: the app's fonts, colours, app mark and sprites |
| `web/views/liveshare.mjs` | The "Share to Discord" button (death notice, graveyard, a wipe's notice), "Post to the Hall of Fame" with the card's preview (run-won notice, board banner) and the Settings block |

**No secrets in the app.** souldew is open source: it ships no key, token, password or signing secret – only the bot's
public address (`LIVE_RUNS_URL`, `https://api.souldew.app`; when that gives no answer at all – some DNS filters don't
know it, others block `*.workers.dev` – the same request goes to the bot's workers.dev address,
`LIVE_RUNS_FALLBACK_URL`). Each player's token comes from linking and is kept in `live-runs.json` in the data folder
(file mode 0600; in development `runs/live-runs.json`), never in `config.json`, a run folder, a run pack, diagnostics, a
log line or anything the page can read. Requests to the bot never follow redirects. `test/secrets.test.mjs` scans the
app, the scripts and the tests for anything that looks like a credential.

| Command | Purpose |
|---|---|
| `SOULDEW_LIVE_URL=http://127.0.0.1:8787 npm run app -- --user-data-dir=/tmp/souldew-live` | Against a local bot (`wrangler dev`) or a mock – https anywhere, plain http only on this computer |
| `npx electron scripts/render-live-cards.mjs <out folder> [--lang de]` | Paints the cards of `test/fixtures/livecards.mjs` (SoulLink of 2, 3 and 4, solo Nuzlocke; death, wipe, victory) with a throwaway data folder |

## Releasing updates

The app checks `https://github.com/souldewapp/souldew/releases/latest/download/latest.json` at start and every four hours (also via **Settings › About › Check for updates**). One feed serves every platform: the macOS DMG at the top level (all that souldew ≤ 2.0 reads), the Windows installer under `assets["win32-x64"]` and the Linux AppImage under `assets["linux-x64"]` (each `{ name, url, sha256, size }`). Older apps ignore `assets` (2.0) or the keys they don't know (2.1 drops `linux-x64`), and the signature covers every field, so they accept the new feed unchanged (proven in `test/update.test.mjs` and `test/linux.test.mjs` with the released code in `test/fixtures/update-2.0.0/` and `update-2.1.0/`). The .deb is uploaded to the release but isn't in the feed.

- **macOS:** downloads the DMG, verifies the feed's signature, size and SHA-256, puts the new app next to the old one and swaps them on restart.
- **Linux (AppImage):** downloads `souldew-<version>-linux-x86_64.AppImage` into the folder of the running AppImage (`$APPIMAGE`, trusted only while the app runs from inside its mount `$APPDIR`) as a hidden `.<name>.update`, verifies signature, size and SHA-256 (again before "Restart now"), makes it executable and on restart – or when the app quits after "Later" – renames it over the old file and starts it. The file keeps its name and path, even when that name carries the old version number, so desktop entries and Steam shortcuts keep working. `minVersion` doesn't apply. A folder the user can't write to gets the verified AppImage in Downloads instead (shown in the file manager); a .deb install, an unpacked build and `npm run app` get the download page.
- **Windows:** downloads `souldew-<version>-win-x64-setup.exe`, verifies signature, size and SHA-256 (again right before running it) and runs it silently once the app is really quitting (`will-quit` – after the unsaved-progress question can no longer keep the game open): on "Restart now" with `/S --updated --force-run` (it waits for souldew to close, replaces it and starts the new version), after "Later" on the next quit without `--force-run`. `minVersion` doesn't apply on Windows – the installer updates any version. A copy that wasn't installed with the installer (e.g. `win-unpacked`) gets the verified installer shown in Explorer instead.

Your data stays untouched on both.

**One-time setup** (already done for this repository: `updates.repo` and `updates.publicKey` are in `package.json`):

1. The repository must be **public** – release files have to be downloadable without login.
2. The signing key was created with `npm run release -- --init-key`: the private key lives in `~/.config/souldew-renaissance/release-key.pem` (souldew Renaissance), its public half is `updates.publicKey`. **Back the key up and never commit or share it** – without it you can't publish updates the apps accept.
3. Add the key's contents as the repository secret `SLS_RELEASE_KEY` (Settings › Secrets and variables › Actions) so GitHub Actions can sign releases.

**Publishing a version** – with GitHub Actions ([`.github/workflows/release.yml`](../.github/workflows/release.yml)):

1. Bump `version` in `package.json` and add a `## <version>` section to [CHANGELOG.md](../CHANGELOG.md) – that becomes the release notes.
2. Commit, then tag and push: `git tag v2.1.0 && git push origin main v2.1.0`.
3. The workflow runs lint and tests and builds the Windows installer on `windows-latest` and the AppImage + .deb on `ubuntu-latest` (each smoke-tested).
   - If the repository variable `MACOS_RELEASE` is `true` (macOS runners work again) and the secret `SLS_RELEASE_KEY` is set, it also builds the DMG, signs one `latest.json` for all three and publishes the release. Installed apps pick it up within a few hours.
   - Otherwise (today: macOS runners don't start for this repository) it creates a **draft** release with the Windows installer and the Linux packages – invisible to the apps. Finish it on your Mac:

     ```sh
     npm run dist:mac-signed                                             # the DMG: Developer ID, notarized, stapled
     gh release download v2.1.0 --pattern '*-win-x64-setup.exe' --pattern '*-linux-*' --dir dist   # what the workflow built
     npm run release                                                     # signs one latest.json for all three
     gh release upload v2.1.0 dist/release-2.1.0/souldew-2.1.0-arm64.dmg dist/release-2.1.0/latest.json
     gh release edit v2.1.0 --draft=false --latest
     ```

**The signed macOS build** (since 3.0.1 – `scripts/dist-mac-signed.mjs`): `npm run dist:mac-signed` builds the DMG
like `npm run dist`, but signs the app and every program and library in it (the bundled Java, the fast player, the link
host, the 3DS player, their cores) with the Developer ID Application certificate and the hardened runtime
(`build/entitlements.mac.plist`, `build/entitlements.mac.inherit.plist`), has Apple notarize the app (staple it), puts it
into the DMG and signs, notarizes and staples that too. Then it checks everything: `codesign --verify --deep --strict`,
every Mach-O file with the Team ID, the hardened runtime and a timestamp, the entitlements of the programs souldew
starts, `spctl`, `stapler validate`, `java -version` from inside the bundle, and the app started hidden with a scratch
profile (its server, the Java check; with `--roms <folder with a GBA and a DS game>` the randomizer on the GBA game and
both games in the fast player). It needs, outside the repository: `~/.souldew-keys/developer-id.p12` and its
`.p12.pass` (or `SLS_DEVID_P12` / `SLS_DEVID_PASS_FILE`) and a notarytool keychain profile `souldew` for team
VWQM7SSK3D (`xcrun notarytool store-credentials souldew --apple-id … --team-id VWQM7SSK3D`, or `SLS_NOTARY_PROFILE`).
The certificate is imported into a keychain of its own for the build (random password, its key open to codesign, put in
front of the keychain search list for the build and deleted afterwards – the list is restored), so no keychain dialog
comes up; the certificate's name never appears in the output. `--out <dir>` builds
elsewhere (a dry run), `--no-notarize` only signs, `--verify <souldew.app> [--dmg file] [--roms dir]` only checks. If
`native/` changed since the parts in `tools/` were built, rebuild them first (`npm run native`, `npm run ctr`).

**By hand** (same result, no workflow): build the DMG (`npm run dist`) on the Mac, the installer (`npm run dist:win`) on Windows and the AppImage + .deb (`npm run dist:linux`) on Linux – or download them from a run of the [Windows](../.github/workflows/windows.yml) / [Linux workflow](../.github/workflows/linux.yml) – and put them into `dist/`. Then `npm run release` (or `npm run release -- --notes "…"`; `--dmg path` / `--win-exe path` / `--appimage path` / `--deb path` for other locations) hashes them, writes and signs `latest.json` and prints the `gh release create …` command with all files. Without a Windows installer or an AppImage in `dist/` it warns and leaves that platform out of the feed (those apps then don't see that version; `--no-win` / `--no-linux` silence the warning). The release must not be a draft or prerelease, otherwise "latest" doesn't point to it.

The app verifies the Ed25519 signature of `latest.json` before using its download URL or checksum; an unsigned or altered feed is rejected. An installed build without `updates.publicKey` (a fork that never ran `--init-key`) doesn't look for updates at all – Settings says why; only `npm run app` may check an unsigned feed while you test. It only accepts HTTPS, refuses downgrades and only installs a DMG with the matching checksum, bundle ID and exact announced version, or an installer with the matching checksum and size. `"minVersion"` in the feed (`npm run release -- --min-version 2.1.0`) sends older installs to the download page instead. Pushing commits alone doesn't reach the apps – only a published release does.

## Project layout

The Electron shell (`electron/`) starts the local server (`server/`) in the same process. The UI is Preact + htm without a build step (`web/`). Code shared by server and UI – patcher, save parser, live RAM parser, routes, player slots – lives in `shared/`, data from PokeAPI and libretro-thumbnails in `shared/data/`.

| Folder / file | Contents |
|---|---|
| `electron/` | App shell: window, menu, Chromium switches (graphics backend), updater (macOS, Windows, Linux AppImage), IPC guards |
| `server/` | Local HTTP server: library, runs, saves, builds (patch + randomizer), overlay API, Pokélink bridge |
| `web/` | The UI (`app.mjs`, `views/`, `lib/`), the emulator page `player.html`, `overlay.html`, translations in `i18n/` |
| `web/lib/run.mjs` | Run logic: encounters, pairs/groups, deaths, rules, checks, stats, live reconciliation (`applySnapshot`) |
| `web/lib/sync.mjs`, `web/lib/doc.mjs` | Live sync (WebRTC + relay) and the shared run document (last writer wins per key) |
| `web/lib/invitecode.mjs` | Inviting with a 6-digit code |
| `web/lib/turboaudio.mjs`, `web/lib/sdat*.mjs` | Turbo music: recorded loops and the DS sound-archive player |
| `web/lib/pacer.mjs` | Frame pacing for the built-in emulator: runs the core's frames from the display's refresh (RetroArch's own sleeps are off – they depend on the system timer) |
| `shared/live/` | Reading team, battle and location from game memory (Gen 1–5) |
| `shared/overlay.mjs` | The overlay snapshot (what stream tools may see) |
| `shared/streamapi.mjs`, `server/lib/streamapi.mjs` | The open stream API `/api/v1` ([docs/STREAM_API.md](STREAM_API.md)): state, events, sprites, access rules |
| `shared/coffee.mjs`, `shared/legendaries.mjs`, `shared/qr.mjs` | The coffee pop-up on legendary encounters: rules, jokes (5 languages), legendary list, QR code |
| `server/lib/build.mjs` | Building runs (patch, randomizer, one ROM per player) |
| `tools/upr/`, `tools/upr-bridge/` | Universal Pokémon Randomizer ZX and souldew's Java helper for it |
| `research/` | Notes and data gathered while building the trackers |
| `build/` | App icon (`icon.icns` macOS, `icon.ico` Windows), DMG background and the README graphics (`build/readme/art.html` → `node scripts/render-readme-art.mjs` → `docs/media/`) |
| `test/` | `node --test` suites |

**Compatibility note:** the app was called "SoulLink Studio" before. Protocol identifiers keep that name on purpose so different versions can still play together: the sync app ID `soullink-studio-v1`, the invite-code salt `soullink-studio/invite-code@1`, the run-pack format `soullink-studio/run-pack@1`, the data folder `~/Library/Application Support/SoulLink Studio` (Windows: `%APPDATA%\SoulLink Studio`, Linux: `~/.config/SoulLink Studio`) and the release-key path `~/.config/soullink-studio/` (on Windows the same path under your user folder). Don't rename them.
