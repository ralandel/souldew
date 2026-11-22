# Multiplayer: trades, battles and a shared world

Status: **every generation from Gen 1 to Gen 5 links in the app – without restarting anybody's game** (15 November 2026, branches `feat/multiplayer` and `feat/mp-seamless`; Gen 5 on 19 November, `feat/30-link-gen5`; §1, §4a). This document is the plan for souldew 3.0: players of a run (and friends they invite) trade Pokémon and battle each other **the authentic in-game way** (Cable Club, Colosseum, Union Room), and see each other walking around in their own games.

There are no public lobbies. Multiplayer happens between the players of a run, over the peer channel the run already has – a SoulLink, or (since 19 November 2026) a **Play together** run: the same multiplayer without any challenge, every player in their own normal game (§16).

Contents:
1. [What works today](#1-what-works-today)
2. [Architecture](#2-architecture)
3. [The link host and its backends](#3-the-link-host-and-its-backends)
4. [Session lifecycle](#4-session-lifecycle) (4a seamless, 4b the souldew engine)
5. [Netcode: input delay, hashes, reconnect](#5-netcode)
6. [Transport: peer channel, TURN](#6-transport)
7. [Saves, ROMs and the tracker](#7-saves-roms-and-the-tracker)
8. [Per generation: what works, what's missing, effort](#8-per-generation)
9. [Shared World: partners walking in your game](#9-shared-world)
10. [SoulLink rules and UX](#10-soullink-rules-and-ux)
11. [Licences and legal](#11-licences-and-legal)
12. [Measurements](#12-measurements)
13. [Plan and effort](#13-plan-and-effort)
14. [Decisions for the owner](#14-decisions-for-the-owner)
15. [Raid: one trainer, one shared HP pool](#15-raid)
16. [Play together: no challenge, your own games](#16-play-together)

---

## 1. What works today

Status on 15 November 2026 (branch `feat/multiplayer`, after merging the GB/GBC and DS spikes). Measured on an M-series Mac with retail ROMs copied into a scratch folder; ROMs and saves are not in the repo.

**The app, end to end** (`scripts/link-e2e.mjs`: two to four souldew servers with scratch data folders, one run created on the first and joined on the others, every page in Electron, muted). The real flow runs: the board's invite, join, every seat's game found by SHA-1 (or picked), saves over the run's peer channel, `go`, both play views on the link session, buttons over the mesh, hashes, write-back, log. Only the buttons come from a recording of the same trade or battle (each host plays its own seat's column, `SLS_LINK_TEST_SCRIPT`, test-only), so the outcome is known: **every check below compares each player's run save after the session with the save the recording produced, byte for byte.**

| Gen | Game(s) | Trade | Battle | Notes (all with sound reaching the page) |
|---|---|---|---|---|
| 1 | Red ↔ Red (SameBoy) | ✅ saves as recorded, logged | ✅ Colosseum, saves as recorded | a gap healed by NEED/resend in the trade run |
| 2 | Crystal ↔ Silver (SameBoy) | ✅ saves as recorded | ✅ Colosseum in the same session, saves as recorded | different games in one run: each picked the other's copy by SHA-1; this run found that a battle in a "trade" session counted deaths and failed the run – fixed: nothing a link session shows is applied to the run |
| 3 | Emerald ↔ Sapphire (mGBA) | ✅ saves as recorded, logged | ✅ Colosseum single battle (Emerald wins; the battle record is in both saves) | different games: "Pick your copy" (a wrong file refused by SHA-1) |
| 3 | 4 players on 4 computers: Emerald, Sapphire, Emerald, Sapphire | | ✅ Multi Battle (2 vs 2), all four saves as recorded | "Link all of us (4)"; 4 hosts × 4 GBAs in lockstep over the mesh |
| 4 | Platinum ↔ Platinum (melonDS) | ✅ Union Room trade, saves as recorded | ✅ Union Room 2-vs-2 battle, saves as recorded | sign: "Union Room" |
| 4 | Diamond ↔ Pearl (melonDS, two saves of their own, Sandgem Town 2F) | ✅ Union Room trade, saves as recorded, logged | ✅ Union Room 2-vs-2 battle, saves as recorded; Diamond wins (records 20/21 vs 20/22), the wager paid in both games | sign: "Union Room" (map 466 read live) |
| 5 | Black ↔ Black (melonDS, two saves of their own) | ✅ Union Room trade, saves as recorded, logged ("traded Lillipup for Patrat with Tim") | ✅ Union Room → Colosseum, two single battles, saves as recorded; "won 2 : 0", the wager paid in both games and saved with an in-game save (`--save-after`: `wagerInSaves`, rerun 19 Nov – the save that first "didn't open" was the e2e pressing by the clock while the busy computer ran the games slower; it counts the games' own frames now, and a save by A or a tap works in the app's player, fast player and engine) | sign: "Union Room", "Colosseum" (zones 422, 150) |
| 4 | HeartGold ↔ SoulSilver (melonDS, a HeartGold save and its copy saved by SoulSilver under another trainer, Cherrygrove City's Pokémon Center upstairs) | ✅ Union Room trade (Chikorita ↔ Cyndaquil), saves as recorded, logged | ✅ Union Room battle, two Pokémon each, SoulSilver wins (records 22/23 read live), the wager paid in both games and saved in-game (`--save-after`, SAVE and YES on the touch screen) | sign: "Union Room" (map 2 read live) |
| 5 | Black ↔ Black 2 (a Black 2 save of its own past the C-Gear, Aspertia City's Pokémon Center upstairs) | ✅ Union Room trade, saves as recorded, logged ("traded Lillipup for Tepig with Tim") | ✅ Union Room → Colosseum, single battle, Black wins (Black 2's records 12/14 read live), the wager paid and saved in-game | sign in Black 2: "Union Room", "Colosseum" (zones 422, 150 read live) |
| 5 | Black ↔ White (Black's second save, saved again by White) | ✅ Union Room trade (Lillipup ↔ Patrat), saves as recorded, logged | ✅ Union Room → Colosseum, single battle, Black wins (White's records read live), the wager paid and saved in-game | sign in White: "Union Room", "Colosseum" |
| 4 | 4 players on 4 computers, Platinum ×4 | ✅ Union Room: all four see each other, seats 1 and 4 trade while 2 and 3 stand by – all four saves as recorded | | 4 hosts × 4 DS consoles on one loaded Mac: ~40 fps (the hosts ran as fast as they could); gaps healed by resends |

| Robustness | Result |
|---|---|
| Rejoin (GBA) | Emerald ↔ Sapphire: B's page reloaded at frame ~7,060 (in the Trade Center); A waited ("waiting for Tim … they can rejoin"); B's page offered "Rejoin" and came back from A's state ~130 frames later; **the trade still finished with both saves as recorded** (run twice, the second time with the state carrying every seat's known buttons). |
| Rejoin (DS) | Platinum in the Union Room: refused as designed – the consoles are always mid-exchange there, so no state can be taken ("the others' games are in the middle of a wireless exchange"); the link then ends for both (fixed after this run: A kept waiting). |
| Desync | B's host started with another clock (Emerald reads it): mismatch at frame 120 on both, **both run saves back to the pre-session save**, the session's last save kept as `….link-<date>.sav` on both (first run found a double restore when both sides saw it at once – fixed). |
| Sound | The local seat's sound reaches the page in every run (`audioIn > 0`). |
| Location sign | "Trade Center", "Colosseum", "Cable Club", "Union Room" instead of "Pokémon League" / "Ferry" / nothing. |
| Direct / relayed | The bar shows "direct · 1 ms" (both on one Mac); TURN servers come from the Worker (checked against the real key). |

**Seamless – from the running games, no restart** (§4a; `link-e2e.mjs --seamless`, branch `feat/mp-seamless`). Each player is in the middle of their game in the fast player – a state of a recorded session's moment F, loaded while paused (`--state1/2`); with `--prestep 4` it is F−4 and four frames run in the fast player, so the picture is the game's – then invite/accept on the board, the session runs the recording's tail from F, both leave. Checked every time: the session started from **both running games** (`seamless`, the first picture after "Linking…" is the link session's), the **same player page** before and after (a mark in it survives – no reload, no new canvas), equal hashes all along, each game **goes on alone** afterwards (the fast player's core again, frames advancing, the same page), and the run saves against the recording:

Final runs (15 November 2026, the code as committed – the state as one binary transfer, round trips before the snapshot, `go` after every partner's `got`); "Linking…" = snapshot → first linked picture, "back" = leave → first solo picture, two to four players on one Mac:

| Gen | Game(s), moment F | Result | Linking… | Back alone |
|---|---|---|---|---|
| 1 | Red ↔ Red trade, F = 1500: both at the Cable Club receptionist, mid-text ("Please appl…") | ✅ saves as recorded, logged; the text goes on in the session | 89 ms | 80 ms |
| 2 | Crystal ↔ Silver trade **and** Colosseum battle (40,138 frames), F = 1700: both at the Cable Club attendant – **with the cartridge clock** (Crystal and Silver read it) | ✅ both saves as recorded (no log entry – the known Gen 2 gap, §13) | 122 ms | 61 ms |
| 3 | Emerald ↔ Sapphire trade, F = 1707 (prestep 4): both standing in the Pokémon Center 2F | ✅ saves as recorded, logged | 206 ms | 124–126 ms |
| 3 | Emerald ↔ Sapphire Colosseum battle, F = 1700 (prestep 4): both at the attendants ("Which Battle Mode…") | ✅ saves as recorded (Emerald wins, battle record in both saves); afterwards both in the Pokémon Center 2F, playing on | 168 ms | 214–222 ms |
| 3 | **4 players** (Emerald, Sapphire, Emerald, Sapphire): Multi Battle, F = 900: all four standing in the Pokémon Center 2F | ✅ all four saves as recorded, 1,200 equal hash rounds | 604 ms | 148–166 ms |
| 4 | Platinum ↔ Platinum Union Room trade, F = 3000 (prestep 4, the fast player's JIT ran those frames): both at the attendant's "save the game?" | ✅ saves as recorded (no log entry – the known Gen 4 gap, §13); afterwards in the Union Room alone | **0.78–0.91 s** | 0.84–0.91 s |
| 5 | Black ↔ Black Union Room trade, F = 2300 (prestep 4): both upstairs in Accumula Town's Pokémon Center, in front of the Union Room counter | ✅ saves as recorded, logged; afterwards both on alone | | |
| 5 | Black ↔ Black Union Room battle, F = 2200 (prestep 4) | ✅ saves as recorded, the result read on both computers, the same, logged | | |
| 5 | Black ↔ Black 2 and Black ↔ Blaze Black 2 Redux (Black's save, a blank one for the other), nothing pressed, 4,800 frames from the running games | ✅ equal hashes, both on alone – two Gen 5 games and a hack in one session | | |
| 3 | Emerald ↔ Sapphire **relayed through Cloudflare TURN** (`--relay`: every peer connection `iceTransportPolicy: relay`, credentials from souldew's bot), RTT 36–39 ms, delay 5 | ✅ saves as recorded, logged; the bar: "relayed (TURN)" | 336–360 ms | 87–139 ms |
| 4 | Platinum over TURN (a short session; two runs) | ✅ equal hashes, both on alone | 1.41–2.0 s | 0.53–0.86 s |
| 1 | Red on the **original Game Boy** (both "Original"), and Red on a Game Boy linked with Red on a Game Boy Color (mixed looks) – nothing pressed, from the title screens | ✅ equal hashes, each back alone on its own model (`sameboy-dmg-native` / `sameboy-native`) | 86–116 ms | 73–92 ms |
| 3 | Emerald ↔ Sapphire, out of step (B's host given another state for A's seat – test-only, `--desync-state`; a game in the middle of a trade may never read its clock, so the old clock trick doesn't trigger here) | ✅ mismatch at frame 120, both run saves back to before, backups kept, **each game back at the moment it was linked from**, going on alone, same page | 207 ms | |
| 3 | Emerald ↔ Sapphire, B's peer link cut at frame 3,000 (in the Cable Club), both leave | ✅ both hosts stood still (each waits for the other's buttons), both left: **each goes on alone from its own console as it was** (in the Cable Club – the game then shows its link error, as with a pulled cable), same page | | 109–111 ms |

Notes: "prestep 4" – the state is from frame F−4 and those 4 frames run in the fast player, so the picture before the link is the game's (without it the canvas still shows what was there before the state was loaded). A Game Boy recording replayed that way differs from the recording in the play-time frame counter only (the fast player has no link host clock offset for seat 1); the Gen 2 run uses F itself, because the fast player's cartridge clock follows the computer's (a year after the recording's) and would change what Crystal saves. The 4-player recording only replays exactly from before the players talk to the attendants (F = 900): from a later moment the fresh lockstep driver starts the link at a slightly other time than the recorded session's – every peer the same, so nothing desyncs; only the recorded buttons no longer fit. Earlier runs, before the start order was reworked, stood still longer (GBA 433–462 ms, DS 1.2–4.3 s: the state's 2.3 MB as base64 JSON parts, and the round trips measured while it was on the channel – 570 ms instead of 1, delay 25).

**The link host alone** (headless, `--script`/`--bench`): every recording replays to byte-identical saves (Red trade and battle, Crystal/Silver trade+battle 41,838 frames, Emerald/Sapphire trade, battle and 4-player multi battle, Platinum trade, battle and 4-console Union Room). Whole-session states load into a fresh host and go on identically (GBA at frames 3,000–11,111, GBC at 15,001 and 30,003, DS at 12,001 in the Union Room): the basis of rejoin. Network lockstep (`scripts/link-net-test.mjs`) as before: 0 mismatches.

| Platform | Link host |
|---|---|
| macOS arm64 | built and tested (`test/linkhost.test.mjs`, all e2e runs) |
| Windows x64 | cross-compiled and linked with MinGW here (only Windows DLLs); not run on Windows yet |
| Linux x64 | `native.yml` builds it (RGBDS from source); in an Ubuntu 22.04 container mGBA and SameBoy built, the melonDS step stopped on a full disk on the build machine – the CI run is the check |

**3.0 acceptance (18–19 Nov 2026, `test/30-acceptance`, the link host built from the branch):** every row above again,
2 and 4 players, each also seamless, with `--winner` and a wager per generation (Gen 3 paid and saved; Gen 1/2 after
switching the game off and on – Gen 1's Colosseum has no exit – found and fixed: the money went in on the title screen;
Gen 4 paid in the overworld and logged once clones were read, §7), rejoin, disconnect and out of step; a third player standing by while two link (never invited, told
"in another link" and shown it on the linked players' cards at once, their game untouched, the trade in their log). Games never linked before, from the running games
(`--seamless --continue`, nothing pressed, 4,800 frames, equal hashes, both back alone): FireRed US ↔ German LeafGreen,
Ruby ↔ Sapphire, Gold ↔ Silver, Blue ↔ Yellow (also Blue on the original Game Boy – found and fixed: Yellow's player
refused every invite from Red/Blue), Diamond ↔ Pearl, HeartGold ↔ SoulSilver. Two computers: §6a.

Still open for 3.0: see §13.

## 2. Architecture

The design is hybrid. Players play apart, asynchronously, as they always do. **A link session is deterministic lockstep for the few minutes of a trade or battle.** This is the one good idea to take from linkcable.app. Its GBA-PK memory hooks are not used: they need per-ROM address tables, break on randomizers and are CC BY-NC.

```
 page (Preact, play view)                local server (Node)                 link host (C, native)
 ┌───────────────────────────┐   HTTP   ┌──────────────────────────┐ stdio ┌──────────────────────────────┐
 │ board: "Trade with Tim"   │─────────▶│ /api/link/start          │──────▶│ linkhost --rom seat0 seat1   │
 │ link session (web/lib/    │◀─stream──│ verifies every seat's ROM│◀──────│   --sram … --local k --net   │
 │   linksession.mjs)        │   cmd    │ (SHA-1), saves in/out    │       │ backend: mGBA (GBA), SameBoy │
 │ fast player shows seat k  │─────────▶│ NativeSessions (same     │       │   melonDS (DS)               │
 └─────────────┬─────────────┘          │ stream/cmd as retrohost) │       │ all seats, one thread,       │
               │ Trystero action 'link' └──────────────────────────┘       │ input-delay lockstep, hashes │
               ▼  (WebRTC data channel, TURN fallback, encrypted)          └──────────────────────────────┘
        partner's page ⇄ partner's server ⇄ partner's link host (runs the same seats)
```

- **Every peer runs every seat.** The partner's ROM is rebuilt locally from base ROM + patch + seed (`server/lib/build.mjs` builds all slots by default and records each SHA-1). The partner's battery save travels over the run's encrypted channel. After that, only buttons travel.
- **The host's picture is the local seat.** Its RAM mirror is the local seat too, so live tracking and the board keep working during the session, and the traded-in Pokémon appears like any other.
- **The link host speaks retrohost's protocol.** It uses the same VIDEO, RAM, SRAM and EVENT messages, with a few more for linking. That means the fast player page (`web/lib/nativeplayer.mjs`) can show a link session almost unchanged, and the server reuses `NativeSessions`.

## 3. The link host and its backends

`native/link-host/` is built by `npm run native` (`scripts/build-native.mjs`, part `link`). The output is `tools/native/<platform>/linkhost`.

| File | Role |
|---|---|
| `linkhost.c` | The **frame loop and the commands** (protocol: `native/common/protocol.h`), the mode changes of the souldew engine (solo ⇄ link in place, §4b), bench/record/replay for tests. |
| `seats.c` | **Seat management**: which backend, the seats' games (ROM, battery save, state, model), (re-)forming them in this process, each seat's battery save. |
| `session.c` | **The session**: whose buttons drive which console on which frame – solo / local mode, input-delay lockstep, peers' buttons (RINPUT, NEED), hashes, whole-session states (rejoin). |
| `avout.c` | **Picture and sound**: the viewed seat as RGB565, the local seat's sound through the fast-forward sound. |
| `native/common/` | Shared with retrohost: IPC and the command queue (`hostio`), the RAM stream for live tracking with cheats and WATCH (`ramstream`), the fast-forward sound (`ffaudio`), the loop's cadence and battery-save settling (`cadence`). |
| `linkbackend.h` | The **backend interface** each system implements (open/close, frames, picture, sound, memory, saves, states – the fast player's format both ways). |
| `backend_mgba.c` | GBA SIO (link cable: multiplayer and normal modes, 2–4 GBAs) on libmgba; GB/GBC as a fallback (`--backend mgba`). |
| `backend_sameboy.c` | GB/GBC serial link cable (2 consoles) on SameBoy (MIT): Gen 1/2 Cable Club, the first choice for GB/GBC. |
| *(every backend)* | `export_state` and `link_seat_config.state`: a seat starts from the player's running game and hands the console back in the fast player's state format (§4a). |
| `backend_melonds.cpp` | DS local wireless between up to 4 melonDS instances (melonDS's core library – built with the JIT, which only a console played alone uses; link seats run the interpreter) with a deterministic MP layer: Gen 4/5 Union Room. Details: [MULTIPLAYER-DS.md](MULTIPLAYER-DS.md). |
| *(later)* 3DS | Azahar rooms, or two instances. Research. |

### Backends

A backend runs **all seats in this process**, joined by the system's link, and must be deterministic: the same ROMs, saves, start time and per-frame inputs give bit-identical consoles on every peer. That means no threads racing the emulation, no wall clock and no uninitialised memory.

```c
struct link_backend {
  const char *name;                                   // "mgba"
  const char *(*system)(void);                        // "gba" | "gb" | "nds" … (after open)
  bool (*probe)(const char *rom);                     // can it run this game?
  bool (*open)(int n, const struct link_seat_config *seats, int64_t rtc_ms); // rom, save bytes, (test) state per seat
  void (*set_input)(int seat, link_input in);         // inputs for the next frame
  void (*run_frame)(void);                            // every console starts exactly one more frame
  void (*video)(int seat, const uint32_t **px, unsigned *w, unsigned *h, unsigned *stride);
  double (*fps)(void);
  size_t (*sram)(int seat, void **out);               // battery save copy
  uint64_t (*hash)(uint64_t h);                       // what must be equal on every peer (RAM, registers, clocks)
  uint8_t *(*mem)(int seat, uint32_t addr, uint32_t len);   // live reader
  uint8_t (*read8)(int seat, uint32_t addr); void (*write8)(int seat, uint32_t addr, uint8_t v);
  size_t (*state_size)(int seat); bool (*save_state)(int seat, void *out); bool (*load_state)(int seat, const void *in);
};
```

**Input format.** There is one `link_input` (u32) per seat and frame, on every system and on the wire:
- bits 0–9: A, B, Select, Start, Right, Left, Up, Down, R, L (the GBA KEYINPUT order; GB uses bits 0–7)
- bits 10–11: DS X and Y
- bit 12: touch pressed
- bits 16–23: touch x; bits 24–31: touch y

The page keeps sending retrohost's INPUT message (libretro joypad bits plus pointer). The session converts it.

**How the mGBA backend stays deterministic in one thread.**
- mGBA's master branch rewrote the GBA lockstep driver. Its `sleep`/`wake` callbacks are flags (the Qt frontend pauses threads with them).
- The scheduler steps every awake console event by event (`runLoop`) until each has started one more frame. Consoles the driver put to sleep wait. A console that has finished its frame runs on while a slower one needs it.
- The order is fixed, so the result is the same on every peer.
- GB serial uses mGBA's older lockstep (signal/wait/cycle budgets), driven the way mGBA's `MultiplayerController` drives it, with flags instead of thread pauses.
- Cartridge clocks use `RTC_FAKE_EPOCH`: one shared start time, then emulated time only.
- libmgba is pinned to a commit. Every peer must run the same build; the session's version check (§4) enforces this.

**How the SameBoy backend (GB/GBC) works.**
- **The cable.** SameBoy's bit-level serial interface, as its own two-Game-Boy mode wires it. When a console driving the clock (SC bit 0, internal) starts a bit, `bit_start` keeps the bit it shifts out. When the bit ends, `bit_end` returns the partner's outgoing bit (`GB_serial_get_data_bit`) as the master's incoming bit and shifts the master's bit into the partner (`GB_serial_set_data_bit`). The partner's SB/SC and serial interrupt then behave as on an externally clocked Game Boy. Either side can be master; Pokémon decides at run time. Bit timing is the hardware's (8 kHz internal clock; CGB fast clock included).
- **One thread, interleaved.** The console that is behind in emulated time runs the next instruction (`GB_run`), ties to seat 0. The two are never more than one instruction apart. A session frame is a fixed slice of emulated time (70,224 clocks), not "until VBlank": a console with the LCD off can't hold the session up, and both take their buttons at the same emulated moment on every peer. The picture is the last finished frame (copied on VBlank).
- **Clock drift on purpose.** Seat 1's clock runs 1/16384 (≈ 61 ppm) fast, within real crystals' spread. Two emulated consoles at exactly the same speed stay phase-locked. When both players talked to Gen 1's receptionist on the same frame, both sent "I'll drive the clock" at the same instant on every retry and the link never came up. With the drift it connects. It is deterministic and invisible to the games.
- **No wall clock.** The core's `time()` is redirected at build time to the session's start time plus emulated seconds: a header included before each core file (`sbl_time.h`: `<time.h>`, then `#define time(t) sbl_time(t)`). `-Dtime=sbl_time` would have renamed MinGW's inline `time()` in `<time.h>` itself and left the wall clock in place on Windows. The MBC3 clock (Gold/Silver/Crystal) runs on emulated cycles (`GB_RTC_MODE_ACCURATE`). Power-on RAM comes from a fixed seed per seat. Sound is on for every seat alike (48 kHz; the rate only shapes the output), only the local seat's is played.
- **Saves and the cartridge clock.** souldew keeps a clock cartridge's save as the battery RAM plus the 48-byte VBA-M clock footer (5 + 5 × u32 registers, u64 Unix second) – the format mGBA, VBA-M and SameBoy use. The fast player (retrohost on SameBoy's libretro core, §4a; earlier Gambatte) writes and reads that footer through `RETRO_MEMORY_RTC` (SameBoy's RTC section: the registers and the Unix second it last caught up to), so the in-game clock survives closing the game, and the link host takes it in and gives it back the same way (`battery()` in the backend interface). A save without a footer (older runs) gets a clock at day 0 at the session start; otherwise SameBoy would flag a reset clock and Crystal would ask for the time.
- **Model.** Every seat is a Game Boy Color (CGB-E) with SameBoy's own CGB boot ROM (MIT, assembled from source with RGBDS and embedded). DMG games get the CGB boot ROM palettes, as on hardware.
- **Memory for the live reader.** `0xC000–0xDFFF` is WRAM bank 0 + bank 1 (where the Gen 1/2 party lives, like `[0xc000, 0x2000]` in `server/lib/native.mjs`). `0xA000` is the cartridge RAM's current bank, plus VRAM and HRAM.
- **Pinned.** SameBoy v1.0.5. Every peer must run the same build.

**Protocol.** The full list is in the header of `linkhost.c`. On top of retrohost's messages:

| Message | Payload | Meaning |
|---|---|---|
| host → `12 LINPUT` | `u32 seat, u32 first, u32 inputs[]` | The local seat's inputs, to send to the peers. |
| host → `14 SEATSRAM` | `u32 seat, bytes` | Every seat's battery save (on FLUSH). |
| EVENT `hash` | `{frame, hash, done, have}` | Every 120 frames; `done`: each console's frames finished, `have`: each seat's buttons known (diagnostics). |
| EVENT `wait` | `{seats, frame, ms}` | Stalled for a peer. |
| EVENT `stuck` | `{seats, frame, behind}` | A console more than 600 frames behind the session (a backend with `frames()`, the DS) – the page ends the link with a message (§5). |
| → host `21 RINPUT` | `u32 seat, u32 first, u32 inputs[]` | A peer's inputs. Repeats and out-of-order frames are fine. |
| → host `20 VIEW` | `u32 seat` | Show another seat (tests, spectating). |
| → host `24 UNTIL` | `u32 frame` | Pause at an absolute frame, the same on every peer. |
| → host `22 READ` / `23 POKE` | — | Tests only (the server never forwards POKE). |
| → host `25 NEED` | `u32 seat, u32 from` | A peer missed a seat's buttons: this host sends what it knows (LINPUT). Any peer may answer for any seat. |
| → host `3 SAVE` → `5 STATE` | — | A whole-session state for a partner who rejoins: every console, then `'LSES'` and the frame. Empty = "not now" (DS: a console waits mid-frame for a packet). |
| `--load <state>` | — | Start from such a state (rejoin). mGBA's states include the lockstep driver's own state and the battery save; melonDS's include the wireless layer's queues. |
| `--state <file>` per seat | — | Start that seat from the player's running game (the fast player's save state, §4a) instead of booting it from its battery save. |
| → host `26 SEATSTATE` → `15 SEATSTATE` | `u32 settle` → `u32 seat, bytes` | The local seat's console in the fast player's format, after the session's end (§4a); a DS console that can't be written down yet runs on alone up to `settle` frames. Empty = not possible. |
| `--export <dir>` (with `--bench`) | — | Every seat's console in that format → `seat<k>.state` (tests: a "mid-game" moment from a recording). |
| host → `3 AUDIO` | stereo s16 | The local seat's sound at the loaded event's `sampleRate` (only at normal speed). |
| → host `1 INPUT` | 17 bytes | Buttons plus the pointer: over the DS's lower screen it becomes the touch bits (a tap lasts at least 4 frames). |

**Builds.** `scripts/build-native.mjs` builds the one `linkhost` with all three backends on macOS, Linux and Windows (MinGW-w64, static: only Windows' own DLLs). libmgba is built with `LIBMGBA_ONLY` (no epoxy needed on Windows) and without LTO (slim LTO objects in a MinGW archive have no symbol index). melonDS's core without JIT, OpenGL and GDB stub. RGBDS is needed at build time for SameBoy's boot ROM; `native.yml` builds it from its tag (v1.0.4). The Windows `linkhost.exe` is cross-compiled and linked here; it has not been run on Windows yet.

## 4. Session lifecycle

1. **Invite.** On the board, Sam clicks "Trade with Tim" (or "Battle"). His page sends `link-invite {id, kind, system, seats:[{slot, romSha1, saveSha1}], hostVersion, backend, rtc}` over the run's channel. Tim's page shows "Sam wants to trade – Join / Not now". It's an explicit opt-in; the run's rule (§10) must allow it.
2. **Check.** Each peer checks that it can produce **every seat's ROM**: its own from the run folder, the partner's from `manifest.outputs[slot]` with SHA-1 = `romSha1`, rebuilt if missing. It also checks the same link host version and backend.
   - If any check fails, the peer answers `link-refuse {reason}`. Examples: "Tim's game isn't built here – build it (2 min)" or "update souldew".
3. **Save.** Both players save in game. Gen 3 asks for it at the Cable Club counter anyway, but the session boots from the battery save, so the current one counts. souldew flushes the battery save (FLUSH → SRAM).
   - Each peer sends its save: `link-save {slot, sha1, bytes (deflate, base64, chunks ≤ 12 KB)}`. Each peer verifies the SHA-1.
4. **Start.** The initiator picks `rtc` (its clock, ms) and the input delay from the measured RTT (§5), then sends `link-go {delay, rtc}`.
   - Each server starts `linkhost --rom <seat0> --rom <seat1> --sram … --local k --net --delay D --rtc R --ram …` and replaces the single-player session.
   - The page shows the local seat in the fast player.
5. **Play.** Both games boot from their saves (title screen, then Continue) – or, since §4a, a game that was running goes on from its state, no boot. The players walk to the Pokémon Center 2F and use the Cable Club as on real hardware. Inputs and hashes flow (§5). The tracker reads the local seat live.
6. **End.** Either player clicks "Leave", or the game is back in the overworld and the players walk out (souldew suggests leaving once both have saved). `bye {reason}` is sent; each host stops where it ran out of buttons (the frames may differ by a few – since §4a each player goes on alone from their own console anyway; `UNTIL`, a common stop frame, is used by the e2e only).
   - Each server takes its **own seat's** battery save (SRAM / SEATSRAM) and writes it into the run (§7). The partner's save copy is discarded.
   - Single-player play resumes from the new save – since §4a without a restart: each player's console goes on alone from where the session left it.

**The others of the run see it.** From the moment every seat said yes until the session ends, each seat tells the run's players *outside* it `linked {on, seats, kind}` over the direct link (no session id; every 3 s, `on:false` at the end; only ever about the sender itself). Their board shows "In a link with Tim" on the linked players' cards, Trade / Battle greyed out with that as the reason, "Link all of us" leaves them out, the Shared World menu says the same; a seat silent for 10 s counts as unlinked. Older 3.0 builds drop the message (it carries no session id of theirs – tested against the build before it). An invite still reaches a linked player as before and gets "in another link" (`refuse busy`).

What if a player quits mid-trade? Gen 3 saves before a trade and again after it. A session cut in between leaves both players with their pre-trade save, which is the cartridge behaviour: nobody loses or duplicates a Pokémon.

### 4a. Seamless: linking a running game, no restart

Since November 2026 (branch `feat/mp-seamless`) a link session no longer reboots anybody's game. You're playing, you click Trade/Battle (or accept an invite), your game stands still for a moment ("Linking…" over the picture), and it goes on **where it was – now linked**; when the link ends it goes on alone from exactly where the session left it. Steps 3, 5 and 6 above change like this:

1. **Snapshot** (`web/lib/linksession.mjs` `_maybeSnap` → `_sendSave`, once every player has every seat's game – a partner who still has to pick or build one doesn't keep the others' games standing – and after the inviter measured the round trips: it says `snapnow`, because a few MB on the channel would make every ping look slow; the first DS run measured 570 ms instead of 1 and picked an input delay of 25 frames). When this player's game of the run runs in the fast player (`ownGame()`), the page pauses it and takes its save state (`__emu.linkSnapshot()`: SPEED 0, then SAVE – the host takes commands between frames, so the state is at a frame boundary, and it is what the picture shows). It goes to every partner deflated – as one binary transfer on the data channel (`SyncLink.sendLinkBinary`, a Trystero action `linkbin` with the message as its metadata; Trystero splits it into 16 KB chunks), or, where the channel can't, as `snap {slot, sha1, i, n, data}` parts in base64 – SHA-1 of the state itself; the battery save follows as before, its `save` message naming the snap (`state: sha1`). A player whose game isn't running (on the board, in the browser emulator) sends no snap: that seat boots from its battery save as before – mixed sessions are fine.
2. **Start from states.** `go` waits until every seat's save and snap are at the inviter **and** every partner said `got` (they're at every partner too – an inviter that started its host early only stood and waited, and its busy page slowed the rest of its own snap to the others: DS 4 s instead of 1.2 s). Every server gets the same snaps (`/api/link/start` `seats[i].state`, deflated, SHA-1-checked after inflating) and starts `linkhost … --rom <seat> --sram <save> --state <snap>` per seat: each backend boots the seat with its battery save, then loads the state (`link_seat_config.state`). Every peer loads the same bytes into the same build, so the consoles are identical – the hash checks (§5) compare them from frame 120 on, as before.
3. **The same picture.** The page's player (`playernative.html`) is never replaced: `__emu.attachLink(id)` switches its stream from the fast player to the link host; the canvas keeps the last picture until the session's first one arrives, the RAM mirror keeps its contents (the live reader never sees an empty party), the sound continues (a new rate restarts the audio context). The play view keeps its session (`target.link` is set on the running one) – pause, speed, save states and cheats are blocked during the link as before.
4. **Back alone** (`__emu.resumeSolo()`, from `_end`). Once the session is over: FLUSH (the session's last battery save of this seat, SEATSRAM), then `SEATSTATE` – the link host writes this seat's console in the fast player's format (`export_state`). The page starts the fast player again with that state and save (`/api/native/start` `state` → `retrohost --state`, loaded before the first frame) and switches the stream back. The battery save goes into the run as every save does (`emu-saved`). A partner who dropped out doesn't matter: each one goes on from their own console as it is. A DS console that waits mid-frame for a wireless packet can't be written down; then the link host runs on alone (nothing pressed – the session is over) up to 300 frames until it can.
5. **Out of step** (a desync): the run's save goes back to the pre-session one as before (`/api/link/restore`, backup kept), and the game goes back to **the snapshot it was linked from** – the player continues from where they were before the link, nothing of the session counts.
6. **Edge cases.** An invite can be accepted anywhere – in a menu, mid-dialogue, in a battle: the state is taken there and the session starts there; the players walk to the Cable Club / Union Room themselves (they're simply linked now). Gen 1–3 need the link only inside the club rooms; leaving the link while inside one is like pulling the cable (the game shows its link error, Gen 3 needs a soft reset) – leave after walking out, as the bar suggests. A session started from the board (no game running here) boots from the save as before, and goes on alone afterwards too (the link player page carries the game for that).

**Formats – one emulator version on both sides.** A state only loads into the emulator (and version) that wrote it, so the fast player's cores are now built from the link host's sources:

| System | Fast player (libretro) | Link host | State |
|---|---|---|---|
| GBA | mGBA at the link host's commit `d58ea8a` (was the 0.10.5 release) | libmgba `d58ea8a` | mGBA's `mCoreSaveStateNamed` (the libretro core's own); into the link host with the battery save and clock extras, back out with the battery save, without the clock (the fast player's cartridge clock follows the computer's again). 0.10.5 can't load states of this version ("too new") – hence the same commit. Older 0.10.5 save states still load in it. |
| GB / GBC | **SameBoy v1.0.5** (was Gambatte) | SameBoy v1.0.5 | `GB_save_state_to_buffer` both ways. Gambatte's states can't become SameBoy's (different internals; a converter through SameBoy's BESS format could only go one way). |
| DS | melonDS DS v1.4.0 (JIT) | melonDS `16f127d` (the commit melonDS DS v1.4.0 builds, interpreter) | melonDS's own `DoSavestate` (the link host adds its wireless layer's part for rejoin; the fast player gets melonDS's part only). JIT or not doesn't change the format. |

All three were checked headless both ways and frame-exact: a recorded session's seats exported at frame F (`linkhost --bench F --export dir`), loaded into the fast player, saved back by it while paused, then loaded into a fresh link host with the recording's tail – the battery saves at the end are byte-identical to the original session's (Emerald/Sapphire trade and battle, Red trade and battle, Platinum Union Room trade; the tail's hash equals the uninterrupted run's).

**Decision: SameBoy for the fast player's Game Boy (MIT).** The cleanest of the three options:
- *The link host as the Game Boy player all the time* would have meant re-building everything the fast player does (fast-forward sound, cheats, save-state slots, RESET, a save given late) in the link host – and Gambatte's save states would be gone just the same.
- *Converting* Gambatte ↔ SameBoy states isn't sound (PPU/APU/timer internals differ; only Gambatte → SameBoy through BESS would be thinkable, never back).
- *SameBoy's libretro core* is the link host's emulator at the same version, more accurate than Gambatte, and MIT (no GPL-2-only part in the bundle any more). Impacts, all handled: every game runs on a **Game Boy Color (CGB-E)** as in the link host – Red/Blue/Yellow get the Game Boy Color's palettes (as on a real GBC), Gold/Silver/Crystal look the same; the GBC boot ROM is SameBoy's fast one (no logo animation – a boot ROM is no part of a state, so the link host's full one doesn't matter); live tracking reads WRAM banks 0+1 as before (the system RAM, `0xC000` + 8 KB, the same layout the link host has); cheats are RAM writes and don't care; battery saves are the same bytes; **the cartridge clock** – retrohost converts SameBoy's RTC section (registers, latched registers, the Unix second it last caught up to) to and from the 48-byte VBA-M footer souldew keeps (`test/native.test.mjs`: a save whose clock read 3 days 4:05 ten minutes ago reads 3 days 4:15) – SameBoy runs the clock on the computer's time (`sameboy_rtc: sync to system clock`), the link host on emulated time from the state's clock, and the fast player catches up after the session; its sound at 48 kHz (retrohost now answers `GET_TARGET_SAMPLE_RATE` – SameBoy would make 2 MHz otherwise). **Lost:** save states made with the older Gambatte fast player (`gambatte-native`) aren't offered for GB runs any more (another core's, like the browser emulator's); battery saves and the clock carry over.

**The Game Boy look (Settings › "Game Boy look", `config.gbLook`).** Game Boy games (Red, Blue, Yellow – the catalog's `gb` system) run on the **original Game Boy** (SameBoy's DMG-B model, the classic green palette) by default, or on a Game Boy Color with its colours ("Game Boy Color colours" – Yellow's GBC colours only then); Game Boy Color games (Gold, Silver, Crystal) always on a GBC (`gbModel()` in `server/lib/native.mjs`). A save state only loads into the model that made it, so the model is part of the core id (`sameboy-dmg-native` / `sameboy-native`); a state of the other look says so ("switch Settings › Game Boy look to load it"), and one of the older Gambatte player says that it was made with the previous Game Boy emulator and the in-game saves are unaffected – nothing is ever deleted. **In a link session every Game Boy seat runs on its own player's console** – a running game's model (its state can only load into it), else that computer's setting – announced in the seat's `save` message (`model`) and passed to every link host as `--model dmg|cgb` per seat. Every peer gets the same list, so mismatched settings never desync: a Game Boy is simply linked with a Game Boy Color, as with two real consoles (tested: the same hashes on every run, `test/linkhost.test.mjs`). A rejoining page keeps the list from the session it left. The DMG boot ROM is SameBoy's own (its logo animation, ~2 s, when a Game Boy game starts on the original model; the Game Boy Color's is the fast one).

**Determinism from live states.** Everything that must be equal on every peer is in the states or agreed: RAM, CPU, timers, RNG state (all in the console state), the battery save (in the state for all three systems: mGBA's extdata, SameBoy's MBC RAM, melonDS's cartridge), the cartridge/console clock (GBA: the agreed `rtc` with mGBA's fake epoch, as before – Emerald's clock moves to the inviter's, a few ms off; GB: the RTC registers in the state, then emulated time; DS: the RTC in the state, then emulated time), the core options (the link host's own, the same on every peer), and the frame alignment (every seat's state is at its own frame end; the session counts its frames from 0 from there). The link hosts' own extras (the GBA lockstep driver, SameBoy's cable bit, the DS wireless queues) start fresh – no link is up at a snapshot (nobody is in a Cable Club exchange or a wireless exchange before the session runs).

### 4b. The souldew engine: one native player, linking in place

Since November 2026 (branch `feat/engine`, Settings › Emulators › **"souldew engine (beta)"**, `config.nativeEngine`, off by default) the link host is also the fast player: **one native host for GB/GBC, GBA and DS** on the emulators' own APIs – SameBoy, libmgba, melonDS, the backends of §3 – instead of retrohost and the libretro builds of the same emulators. A trade or battle no longer hands the game over between two programs: **the partners' consoles join the running game's process, and leave it again**.

**Alone (solo).** `linkhost --solo --rom … [--sram] [--state] [--model] --ram …` runs one seat set up the way the fast player runs it (`link_open.solo`): the cartridge and console clocks follow the computer's (GBA: no RTC override; Game Boy: SameBoy's sync-to-host clock, the 48-byte clock footer in and out; DS: local time), the DS runs melonDS's **JIT** with the threaded software renderer and melonDS DS's firmware (its default MAC, the nickname "melonDS DS"), a Game Boy Color boots with SameBoy's fast boot ROM and button bounce is emulated (SameBoy's default, as in the libretro core – it moves when a press lands and so the games' random numbers), and a Game Boy frame runs from vblank to vblank (as `GB_run_frame` – a link session's fixed slices would add up to a frame of input latency). It speaks retrohost's protocol (`native/common/protocol.h`): the same page (`web/lib/nativeplayer.mjs`), RGB565 pictures (~60 a second while fast-forwarding), the fast-forward sound sped up by the measured speed, 1×–4× and Max with the real speed four times a second (the speed bar, the turbo mixer, the slow-computer hint), RESET, a battery save given late, cheats (WRITE into the RAM regions), WATCH/WATCHED for Shared World, the RAM stream for live tracking at the same cadence. **Save states are the fast player's format** (`export_state`/`import_state` – mGBA's `mCoreSaveStateNamed` with the battery save and the clock, loaded with the clock only as `retro_unserialize`; SameBoy's own state, the libretro core's padding ignored; melonDS's own `DoSavestate`), so the core ids stay (`mgba-native`, `sameboy-native`, `sameboy-dmg-native`, `melonds-native`): every save-state slot and "where you left off" made with retrohost loads in the engine and the other way round.

**Linking in place.** When this player's game runs in the engine and a link session starts, `/api/link/start` doesn't start a link host: it sends the running process `CMD_LINK` (27) with the session's arguments – the same words as a link host's command line (every seat's ROM, battery save, state, model, the local seat, `--net --delay`, the agreed clock). The engine closes its solo seat and **forms every seat – its own game's too – from the agreed states and saves, exactly as every peer forms them** (`seats_open`, link settings: the interpreter, per-seat firmware, emulated clocks), so all consoles are identical everywhere by construction; it answers with a `loaded` event (`mode: "link"`) – or `linkRefused`, and the game goes on alone as it was (the server answers the page's start with `linkRefused`). The session's id stays the same; the page keeps its stream (`attachLink` sees the same id). When the session ends, `/api/native/unlink` sends `CMD_SOLO` (28) without arguments: the local seat's last battery save goes out (SRAM), its console is written down (a DS console waiting mid-frame for a wireless packet runs on alone up to 300 frames first), the partners' consoles go and the game goes on alone from that console – no state travels to the page and back. Out of step, the page's snapshot from before the link comes back with the arguments (`CMD_SOLO --rom --sram --state --model`, through `/api/native/start`). A session started from the board (the game wasn't running here), a rejoin (`--load`) and the e2e still start a link host; with the engine on, it goes on alone in place afterwards too.

**Modules.** `native/link-host/`: `linkhost.c` (frame loop, commands, mode changes), `seats.c` (seat management), `session.c` (solo / lockstep input), `avout.c` (picture and sound), the backends. `native/common/`, built into both hosts during the transition: `hostio` (framed IPC, a command queue taken between frames, the clock with Windows' 1 ms timer – the link host had none before, its 1× pacing on Windows was the 15.6 ms tick), `ramstream` (RAM mirror, cheats, WATCH), `ffaudio` (fast-forward sound), `cadence` (pacing, picture/RAM/save cadence, stats, battery-save settling). The server: `NativeSessions.startNative({ engine })`, `startLink` (in place when the running engine plays this player's game – the same file or a byte-identical copy by SHA-1), `unlink`, and a desync only pauses the engine's game until the snapshot comes back (it isn't stopped). Tests: `test/engine.test.mjs`.

**Parity with the fast player** (16 November 2026, M-series Mac; ROMs copied into a scratch folder, never committed):

| Check | Result |
|---|---|
| The fast player's tests on the engine (`test/engine.test.mjs`) | RAM mirror, exact STEPs, cheats in/out of the regions, save states, a battery save given late, RESET, QUIT's last save, `--state` (and a refused one), the Game Boy clock footer out and back in, WATCHED before each picture, fast-forward sound never above real time, ~60 pictures a second at 4×, a refused link keeping the game – all pass; the full suite: 926 tests, 0 failing |
| Same state, same 600 frames, then the live reader's RAM (`host-parity`) | Red, Crystal, FireRed, Black 2: **byte-identical**; Emerald: identical up to 0–3 bytes of clock-driven variables (two retrohost runs differ the same way); Platinum: 14 of 4 MB differ – two retrohost runs from the same state differ by 16 (DS RAM isn't run-to-run identical in either player) |
| Save states both ways (retrohost's into the engine and back, all six games, plus the tiny test ROMs) | all load; the RAM after loading is the same as above |
| Live tracking, `npm run matrix -- --engine` vs `--native`, one attempt each | Crystal, Emerald, Red: the same columns ✅ in both (party, place, battle, catch, types, cap); Platinum: engine ✅ everywhere, retrohost's run missed its catch (plan lost its way – a random outcome, each run boots at its own wall-clock moment); FireRed: the plan stops at the same step after the same frames in both (a plan problem); Black 2: both stuck in the same plan loop (frame ~142,000), stopped |
| Speed at Max, CPU at 1× (one core %), from the same states, one after the other | Red 22.3× / 22.3×, 23 % / 23 %; Crystal 20.3× / 19.9×, 25 % / 25 %; Emerald 50.6× / 50.5×, 12 % / 12 %; FireRed 33.3× / 31.6×, 7 % / 7 %; Platinum 8.4× / 8.5×, 48 % / 49 %; Black 2 7.9× / 7.9×, 20 % / 20 % (retrohost / engine) |
| Sound at 1×, 2×, 4×, Max | continuous in both (stereo frames a second at the stream's rate, longest gap ≤ 30 ms); found on the way, fixed for both hosts: a GBA game's switch to 65,536 Hz (SOUNDBIAS) is announced (`audioRate`) |
| In the app (`native-e2e --engine --modes` vs without; Crystal, Emerald, FireRed, Platinum, Red) | 5/5 in both: 1×, 2×, 4× reached (0.94–1.03 / 2.0 / 4.0), Max engine 9.3–45.9× vs retrohost 9.1–42×, a save state there and back; every turbo-sound mode at 4× (silent probes, the app muted): "music" plays the loop or the game's stream, "original" and "plain" the game, "mute" nothing – the same in both |
| Seamless link in place (`link-e2e --seamless --engine`) | Red trade, Crystal ↔ Silver trade, Emerald ↔ Sapphire trade and Colosseum battle, Platinum Union Room trade: every check (linked in place, the same page, equal hashes, back alone in place, saves as recorded); the Gen 2/4 trade log gap is the known one (§13). "Linking…" 42–81 ms (GB), 150–293 ms (GBA), 1.25–1.31 s (DS, a heavily loaded Mac – 0.52 s for the engine's own re-forming); back alone 32–40 ms (GB), 76–96 ms (GBA), 1.07–1.16 s (DS; 0.27–0.33 s inside the engine). Out of step (`--desync`): detected at frame 120, run saves back, backups kept, each game back to its pre-link moment in the same process |
| Recorded link sessions (headless replay) | GBA trade + battle, DS Union Room trade + battle: end saves byte-identical to the recordings; Gen 1 hashes and 4 DS consoles the same as the build before (the JIT built in doesn't change the interpreter) |
| Shared World (`world-e2e --engine`, Emerald) | partners drawn per picture (WATCHED), the A menu, Wave |
| Windows | `linkhost.exe` cross-compiled (MinGW, only Windows' DLLs) and run on Windows 11 (x64 emulated on ARM): the solo protocol (steps, cheat, state, battery, 1× = 60 pictures and 48 kHz a second), DS with the JIT; **x64 and arm64 compute the same**: the GBA trade recording's end saves byte-identical, DS hashes equal |

## 5. Netcode

**Input-delay lockstep, no rollback (for now).**
- The local input for frame *f* is taken at frame *f − D* and sent right away.
- Frame *f* runs only when every seat's input for *f* is known.
- Delay: `D = clamp(ceil(RTT/2 · 1.25 / 16.7 ms) + 3, 4, 60)`. That is 4 frames on a LAN and 6 at 80 ms (~100 ms felt latency). Menus, trades and turn-based battles tolerate this well.
- At the measured rate (§12), a session at 80 ms RTT can run 2.5× faster than real time, so 1× never stalls.

**Pacing.** Each host paces itself at 59.73 fps and waits when inputs are missing. Both start from the same frame (inputs for frames < D are "nothing pressed" for everyone). A host that falls behind never makes the other run faster: the other one simply waits.

**A stall is never silent** (since 3.0.1). Two ways a link can stand still, both end it with a message on every
computer, and each game goes on alone from where it was (`resumeSolo`, as after "Leave link"):
- *Lockstep:* our host waits at one frame for a partner's buttons (`wait`, every 250 ms) for 60 s (`STALL_MS` in
  `web/lib/linksession.mjs`; a partner rejoining restarts it) → "The link stood still for a minute …"
  (`linkStalled`, a `bye` tells the others – by then they wait for ours too).
- *A console:* frames go on but one console doesn't finish them (a DS console can stop mid-frame for a wireless packet –
  never for long by design). The link host compares each console's finished frames with the session's (`frames()` in
  the backend interface, `watch_*` in `linkhost.c`) and reports `stuck` past 600 frames; every computer computes the
  same consoles, so all see it at the same frame → `linkStuck`. Until a console has finished its first frame, the host
  sends no picture of it (the page keeps the game as it was before the link instead of a black screen).

What happened in 3.0.0 (tickets #36 and #47 HeartGold, #44 Pearl, GitHub #88 Platinum – trades and battles, Union Room and
Pokémon Center, all reported from Windows, reproduced on a Mac with the 3.0.0 binaries): the DS backend ordered the consoles by their own
emulated clocks (`SysTimestamp`, time since the console was switched on). Consoles that join from running games have
been on for very different times – minutes apart, much more with fast-forward – so the one on longer stood still
until the others caught up; its picture stayed at the link host's empty (black) buffer, frames and hashes went on
(nothing waited, nothing differed), and nobody was told. Every e2e had started both consoles at the same moment (from
saves, or states exported at one frame of a recording), so it never showed. Fixed with a session clock per console
(MULTIPLAYER-DS.md). Found on the way: in a wireless exchange the DS consoles finished only every other session
frame (half speed in the Union Room, dropped presses) – fixed too, which is what makes "behind the session" a reliable
sign of a stuck console. A 3.0.0 partner computes other DS consoles: the invite/accept carry the cap `dsclock1`, a DS
link without it on every seat doesn't start (`linkOlder`, "update souldew on both computers"); the diagnostics now carry the link (`diag('link', …)`: start, every 10 s the frame / each
console's `done` / `have` / buttons sent and received / last frame received per seat, waits, `stuck`, the end).

**Desync detection.**
- Every 120 frames (2 s) each host emits `hash`: an FNV-1a over every seat's work RAM, CPU registers and timing. The page sends it as `link-hash`.
- On a mismatch: stop both hosts at once, show "The games fell out of step – the session ended, nothing was saved", and keep the pre-session saves.
- On the same build this never happened in testing. A mismatch means different builds, a bug, or a tampered client.

**Recovery and reconnect (built):**
- **Gaps.** A host that waits for a seat emits `wait {seats, frame}`; the page asks every partner `need {s, f}`, and each partner's host answers from its ring of 4096 frames (`NEED` → `LINPUT` → `in`). Any peer can answer for any seat. Seen in the e2e as one natural gap healed without anybody noticing.
- **Rejoin.** A page that went away while its session ran (reload, crash, app restart) finds the session in `localStorage` (30 min) and offers "Rejoin". The partner with the lowest seat among those still in asks its host for the whole-session state (`SAVE`; the hosts all stand still at the first frame the missing seat's buttons are missing), deflates it and sends it in parts; the rejoiner's server starts its host with `--load`. The state carries every seat's battery save, the GBA lockstep driver's state and the DS wireless queues, so it works in the middle of a Cable Club or Union Room visit. A DS console that waits mid-frame for a wireless packet can't be written down: then the others answer `state-busy` and the link ends ("only outside a wireless exchange").
- **Desync.** Equal hashes are compared every 120 frames. A difference ends the session for everybody, and **both players' run saves go back to what they were before the session** (`/api/link/restore`; the session's last save stays next to it as `….link-<date>.sav`), so nobody keeps a Pokémon the other didn't lose. The bar explains it.

**Four players (runs have up to 4).** The session and the network layer are built for N ≤ 4 seats.
- **Who is in a session.** Any subset of the run's players. A trade is 2 seats: any 2 of the 4 can start one while the others keep playing, since each player's own game runs on their own computer and isn't part of the session. Multi battles (Emerald, FR/LG) and Record Mixing take 3–4 seats. Several sessions in one run at the same time are fine: P1+P2 trade while P3+P4 battle, each with its own `sid` and its own link host per computer.
- **Topology: a full mesh for inputs, no clock master.**
  - Every peer sends its own seat's inputs to every other seat of the session over the run's WebRTC mesh (Trystero already is a full mesh).
  - Every host waits for whatever inputs it lacks, so there is no master, and no host whose departure stops the clock for the others in a special way.
  - A star with the inviter as relay would add one hop of latency for the non-host pairs and make the inviter's upstream the bottleneck; with ≤ 4 peers the mesh is ≤ 3 connections per peer at ~3 KB/s each.
  - The inviter is only the **coordinator** of the start: it collects the accepts, measures the RTTs, picks `delay` and `rtc`, and says go. After that it has no special role.
- **Delay from the slowest link.** The inviter pings every partner; with more than 2 seats, every peer also reports its worst RTT to the others in `accept`. `D` uses the maximum, because every host waits for the slowest seat.
- **Hashes.** Each host's hash covers all seats. Every peer broadcasts its own and compares all of them; any difference ends the session for everybody.
- **Reconnect.** Missing frames are re-requested from the seat that owns them. A peer that can't come back within the timeout ends the session for all; the cartridge-like behaviour keeps everyone's last in-game save.
- **Link backend.** The mGBA backend links up to 4 GBAs (mGBA's lockstep SIO driver supports 4); GB serial joins 2. Tested so far: 4 linked GBAs run at 1.4 ms per frame (§12). A 3/4-seat net test is in §12.
- **Shared World** shows up to 3 partners (§9); each gets its own sprite and name tag.

**Rollback (phase 5).** Native save states are cheap (a GBA state is ~0.4 MB in memory), so GGPO-style prediction and re-simulation is affordable. It would remove the felt delay in battles. It is not needed for trades.

## 6. Transport

- **Channel.** The run's existing Trystero room (WebRTC full mesh, signalling over Nostr) gets a new action `link`: ordered, reliable, and encrypted by Trystero/DTLS plus the run secret.
  - Messages: `link-invite / accept / refuse / save / go / input / hash / need / bye`.
  - Inputs are batched: one message per frame when the data channel is direct, four frames per message when relayed.
  - When WebRTC is down, the MQTT fallback carries everything except inputs. A session needs a data channel (direct or TURN). Without one the UI says "No direct connection – link sessions need one (TURN off)".
- **TURN (built).** Strict NATs (mobile hotspots, some ISPs) need a relay.
  - The Worker (`souldew-discord`, feature `link`, `src/features/link.js`) serves `GET /link/ice[?run=<hex>]`: it calls Cloudflare Realtime TURN `…/turn/keys/<TURN_KEY_ID>/credentials/generate-ice-servers` with the `TURN_KEY_API_TOKEN` secret and answers `{ iceServers, ttl: 7200, turn: true }` (port-53 URLs dropped). 20 requests per IP per hour (the live feature's D1 counter); STUN only (`turn: false`) when the secrets are missing or Cloudflare fails. Checked against the real TURN key.
  - The app's server proxies it (`GET /api/link/ice`, `server/lib/linkice.mjs`, cached for 80 % of the credentials' life); the page hands the entries to Trystero as `turnConfig` (added to its default STUN servers), so the direct path is still tried first.
  - The link bar shows the route from the connection's selected ICE pair: "direct · 12 ms" or "relayed (TURN) · 80 ms" (`SyncLink.linkRoute`).
  - Where the bar is (`web/views/linkplay.mjs` LinkBar): over the page at the top; while the game is big (the play view's dock, layout C) it is a dock section of its own – first on the right, next to the place at the bottom – and with the dock folded the strip shows its dot while a bar that asks something (invite, missing game, rejoin, how it ended) waits over the top of the game.
  - Costs: inputs are ~3 KB/s per peer, so a 10-minute session is ~2 MB. The free tier (1,000 GB/month, TURN and SFU combined) covers ~500,000 sessions per month. Partner video over TURN is the real cost; keep it to stills when relayed, as today.
- **Fallback when even TURN fails:** a Durable Object WebSocket relay per session. The payload stays encrypted with the run key, so the relay sees nothing. Build it only if field data asks for it.

### 6a. Two computers: the cross-machine check (`link-e2e --host` / `--join`)

The open check before release is x64 ↔ arm64 lockstep (a Windows PC and a Mac in one session). `scripts/link-e2e.mjs`
runs one seat per computer: each side starts its own souldew server and a hidden, muted page with a scratch data folder;
the host builds the run and shows the app's **invite code** (6 digits, the public relay – web/lib/invitecode.mjs; the
script allows the request itself), the other side joins with it, builds its own game and uploads its own seat's save;
the host invites, the session runs over the run's real peer channel (direct first, TURN when that fails; `--relay` forces
TURN), and each side plays its own seat's column of the **same recording** (`SLS_LINK_TEST_SCRIPT`, as in every e2e).
Both stop at the recording's last frame. Each side prints `RESULT {…}`: `hashes` (count, first, last, sha256 over every
hash its link host computed – **must be identical on both computers**), `saveAfterSha256` of its seat's run save and,
with `--expect`, `checks.saveAsRecorded`; the session itself compares every 120-frame hash and ends as out of step on any
difference (`checks.noMismatch`). Also in the result: platform, arch, the link host's sha256, delay and route.

```
Mac (host, seat 1):  node scripts/link-e2e.mjs --host --rom <Red.gb> --save trade-seat0.sav --script trade.rec --expect trade-expect --data <scratch>/x-host
                     → INVITE CODE: 123456 (valid 15 minutes, also in <data>/out/invite-code.txt)
Windows (seat 2):    node scripts/link-e2e.mjs --join 123456 --rom <Red.gb> --save trade-seat1.sav --script trade.rec --expect trade-expect --data C:\souldew-debug\e2e\x-join
```
Two different games (Emerald ↔ Sapphire): each side adds the other's file with `--other-rom`. Without `--script` the
session runs `--frames` frames (default 7,200) with nothing pressed, from the saves. Both sides need the same souldew
build, the same ROMs (SHA-1) and internet. Checked on one Mac with two processes and separate data folders (18 Nov 2026):
Red ↔ Red trade (SameBoy), Emerald ↔ Sapphire trade (mGBA) and Platinum trade (melonDS) – both sides `saveAsRecorded`,
the same hash sha256 on both, the route "direct". The real Mac ↔ Windows run is next.

## 7. Saves, ROMs and the tracker

- **ROMs never cross the network.** Every seat's ROM must exist locally.
  - Randomized or patched runs: `build.mjs` builds every slot (default "both of us/all of us") and records `outputs[slot].sha1`. A missing partner ROM is rebuilt with one click (same base ROM, patch and seed). The SHA-1 must equal the partner's.
  - Plain runs where both play the **same** game: the player's own copy is used for both seats if the SHA-1s match.
  - Plain runs with **different** games (Emerald ↔ FireRed, HeartGold ↔ SoulSilver pair runs): each peer needs the other's game file. Decided: the player picks it from their own library, souldew checks it by SHA-1.
  - **How a seat's file is found** (`server/lib/linkroms.mjs`, every peer for every seat, only by SHA-1): the run's build for that slot → any other build of the run with that SHA-1 (both play the same file) → a file picked earlier (remembered per SHA-1 in `link-roms.json` in the run folder) → a library ROM with the partner's CRC32 (plain runs announce it with the SHA-1), confirmed by hashing; a zipped one is unpacked into the run folder. Each player announces only their own game's SHA-1 (and CRC for plain runs).
  - When a seat's file isn't found, the bar says so before the link starts: **"Pick your copy of it"** (a library game; a file that isn't in the library can be added from there – it is then found by its checksum) or, for randomized/patched runs joined before every player's game was built, **"Build Tim's game"** (`/api/link/build`: that slot from the run's base ROM, patch, settings and seed).
- **Saves.** The partner's save travels deflated and encrypted (128 KB GBA flash → ~20–40 KB) and is SHA-1-checked. It is used only inside the session and deleted at the end.
- **Write-back.**
  - The session's local-seat SRAM messages go through the **existing** fast-player path (`NativeSessions.onMessage` / the page's `emu-saved` → the run's save file).
  - A trade writes into the run's save exactly as playing does. HeartGold/SoulSilver watchers and the gen-4 graveyard writer see it as a normal save.
- **Tracker.**
  - Live tracking reads the local seat's RAM, so a traded-in Pokémon appears in the team at once.
  - The tracker marks it: the OT ID differs from the player's (Gen 3: `otid` in the party struct, `pid ^ otid` key).
  - The log gets "Traded Poochyena ↔ Wurmple with Tim" (session events plus a before/after party diff).
  - **Clones** (a cloning glitch, Gen 1–4; the Platinum recordings' trade hands a player a copy of a Pokémon they already have): the same PID twice with every lasting detail alike (species, form, met data, IVs/DVs, nature …) is two Pokémon, not a misread (`shared/live/parse.mjs` keyClones). The first keeps the key, the others get `<key>~2`, `~3`; each keeps its key while the team is reordered (matched by HP, level, status, moves, item to the last reading, the slot only breaking ties), so a clone at 0 HP never hands its 0 HP to the other. A clone new in the team counts after a second read (a party-menu swap shows one Pokémon twice for a poll); the same PID with other data is still refused. The battle's party copy goes to the team by PID, n-th with n-th. The clone itself is a new Pokémon for the tracker (inbox: its route is taken).
  - SoulLink rule checks run as usual. For example, if trades are allowed but the traded Pokémon counts as "received", the pair link moves with it, or stays, depending on the rule (§10).

## 8. Per generation

| Gen | Games | Link | Engine | Trades | Battles | Status / effort |
|---|---|---|---|---|---|---|
| 1 | R/B/Y (+hacks) | GB serial | SameBoy (link host) | Cable Club trade ✅ app | Colosseum ✅ app | Gen 1 has no exit from the Trade Center/Colosseum: the game saved, the session ends by "Leave link" (on hardware: switching off). |
| 2 | G/S/C, Polished Crystal, Crystal Legacy | GB serial | SameBoy (link host) | Trade Center ✅ app | Colosseum ✅ app | The cartridge clock travels in the save (VBA-M footer) both ways; the fast player keeps it now too. The Cable Club needs `EVENT_GAVE_MYSTERY_EGG_TO_ELM`; a trade needs a second non-egg Pokémon. Time Capsule (Gen 1 ↔ 2): both seats are CGBs in one backend – not tried yet (~1 d). |
| 3 | R/S/E, FR/LG, hacks (Unbound, Radical Red …) | GBA SIO link cable | mGBA (link host) | Cable Club ✅ app | Colosseum single ✅ app; Multi Battle (4 players) ✅ app | FR/LG: FireRed US ↔ German LeafGreen linked from the running games in the app (3.0 acceptance: lockstep, back alone; nothing traded – no recording yet) – their Cable Club works by cable, the location sign doesn't know their link rooms yet. The Union Room needs the wireless adapter: skipped (decision). Hacks: anything with the vanilla link code should work; check per hack. |
| 4 | D/P/Pt, HG/SS | DS local wireless | melonDS's core ×N in one process, deterministic MP layer (MULTIPLAYER-DS.md) | Union Room ✅ app (Platinum) | Union Room battle ✅ app | Diamond ↔ Pearl and HeartGold ↔ SoulSilver recorded and replayed in the app (trade, battle, wager; HG/SS with an in-game save after it, 19 Nov); the sign knows the Union Room and the Colosseums of D/P, Platinum and HG/SS (pret's map ids; Platinum's Union Room measured). Rejoin only between wireless exchanges. 3.0.1: consoles linked from games running for different times, or from inside the Union Room, run and see each other at once (MULTIPLAYER-DS.md › session clock). Interpreter only: 4 consoles ≈ 1.6× real time on an M1 – slow PCs may struggle with 4 players. |
| 5 | B/W, B2/W2 (+Blaze Black 2 Redux/Volt White) | DS local wireless (the C-Gear's IR: no) | as Gen 4 | Union Room ✅ app (Black ↔ Black) | Union Room → Colosseum ✅ app | Upstairs in every Pokémon Center, the left counter; it opens with the C-Gear (`FE_CGEAR_GET`, MULTIPLAYER-DS.md › Gen 5). Recorded and replayed in the app: Black ↔ Black trade and battle, each also seamless; the sign knows the Union Room (zone 422) and the Colosseum (150, 151). Black ↔ White and Black ↔ Black 2 recorded and replayed in the app too (trade, battle, wager, in-game save; 19 Nov). White 2: a save past the C-Gear (Black 2's, saved by White 2 under another trainer with other Pokémon) links and trades with Black 2 in the link host, but no session of it went through the app yet – its battles don't count and its sign stays off. Blaze Black 2 Redux: the same. Volt White: no patch here. The C-Gear's infrared doesn't link: melonDS's IR cartridge has no send/receive. |
| 6–7 | X/Y, ORAS, S/M, US/UM | 3DS local wireless | Azahar rooms (libretro core has no room client) or 2 instances | Player Search System | PSS battles | Research. Azahar's network room needs a room server (souldew's Hetzner box) and a core patch. **Later.** |

**Battles everywhere** use the same session as trades. The game's link battle runs on both consoles, so there is no extra work in the host. souldew adds:
- a "Battle" invite;
- optional battle rules (level cap = the run's cap, no items);
- a result entry in the log ("Sam won a link battle against Tim") and the head-to-head record (below);
- an optional wager in in-game money (below).
- For SoulLink, battle losses never count as deaths unless the run says so (§10). The wager is independent of it.

### 8a. Battle results and wagers

Built in November 2026 (branch `feat/30-wager`; `shared/linkbattle.mjs`, `web/lib/linkresult.mjs`, `web/lib/wager.mjs`,
`web/lib/wagerpay.mjs`).

**Who won – read from every seat on every peer.** Every peer's link host runs every console, so every peer reads every
seat's game itself (the link host's `READ`, now allowed for a page in a link session – a few bytes, read-only, at most
4 KB; the battery saves of every seat on `FLUSH`). The cartridge header (`READ` at 0x080000A0 / 0x0134 / 0x027FFE00)
says which game a seat runs. The source per generation is the one the game itself decides with, checked against the
recorded battles:

| Gen | Source | Recorded battle | Read |
|---|---|---|---|
| 1 | `wBattleResult` (0 won, 1 lost, 2 draw) once `wIsInBattle` falls to 0 after a battle with `wLinkState` = 4 (battling); the cartridge keeps no record | Red ↔ Red Colosseum | seat 0 lost, seat 1 won (the result screen: “ASH lost to RED”) |
| 2 | the cartridge's own link battle record `sLinkBattleStats` (wins, losses, draws – u16 big-endian, SRAM bank 1: save offset 0x31BA Gold/Silver, 0x3260 Crystal), before and after the session. The game writes it at the battle's end, independent of saving. (`wBattleResult` read in RAM was ambiguous during the battle in this recording.) | Crystal ↔ Silver | Crystal L+1 vs “BIG”, Silver W+1 vs “ACE” – Silver won (“YOU WIN”) |
| 3 | `gBattleOutcome` (1 won, 2 lost, 3 drew; bit 7 = forfeit) at the end of a battle with `BATTLE_TYPE_LINK`; `BATTLE_TYPE_MULTI` marks 2 vs 2. Multi battles write no link battle record into the save, so the save is no source for them. Same EWRAM addresses for every revision and the German R/S, FR/LG | Emerald ↔ Sapphire single; E, S, E, S multi | single: Emerald 1, Sapphire 2; multi: seats 0+1 lose, 2+3 win |
| 4 (Pt) | the game records `RECORD_LOCAL_LINK_BATTLE_WINS / _LOSSES` (ids 21, 22) in the save data in RAM (`*0x02101D40 + 0x61C4`), encrypted with an LCRNG keystream seeded by the block's byte sum and a modifier (pokeplatinum `src/game_records.c`), checked by that sum. Before and after. No draw record | Platinum ↔ Platinum Union Room | seat 0 W+1, seat 1 L+1 |

| 4 (D/P) | the same records, plain (pokediamond `GameStats`: u32 ids 21, 22 – the ids Platinum kept; 20 counts the link battles), PKHeX `OFS_Record` 0x5F08 in the general block → `*0x02106FC0 + 0x214 + 0x5F08`; money: trainer block +0x14 (`+0x214 + 0x78`, ₽2,400 read live) | Diamond ↔ Pearl Union Room, 2 vs 2 | Diamond 20+1, 21+1; Pearl 20+1, 22+1 – Diamond won |
| 4 (HG/SS) | `GAME_STAT_LOCAL_LINK_BATTLE_WINS / _LOSSES / _DRAWS` (22, 23, 24 – pokeheartgold `include/constants/game_stats.h`, incremented by the battle code), encrypted like Platinum's from +8 with the sum at +0x1BC (`src/game_stats.c`), at `*0x02111880 + 0x10 + 0x4B3C` (PKHeX `OFS_Record`); money `+0x10 + 0x78` (₽3,000 read live, the save file's) | HeartGold ↔ SoulSilver Union Room, two Pokémon each | HeartGold L+1, SoulSilver W+1 – SoulSilver won |
| 5 | the trainer card records (PKHeX `Record5`: 68 u32 + 100 u16 from +4, encrypted with the LCRNG keystream seeded by the block's last word – no checksum) in the save data the game keeps in RAM in the battery save's layout: Black/White fixed (Black US 0x0221BBAC = the party the tracker reads − 0x18E08; White +0x20 – 0x0221BBCC read live: its trainer and ₽4,000, the save file's), Black 2/White 2 behind the main pointer (+0x920; Black 2 read live), records block +0x1DA00, money the misc block's first word (+0x21200, B2W2 +0x21100). Measured: **12 = link battles, 13 = wins, 14 = losses** (both players' 12 went up, the winner's 13, the loser's 14 – the decoded records otherwise steps, time, encounters) | Black ↔ Black Union Room, single battle, twice; Black ↔ White and Black ↔ Black 2, once each | seat 0 W+2, seat 1 L+2 (“won 2 : 0”); Black W+1, White / Black 2 L+1 |

Not supported (no wager offered; the log gets no result): Gen 1/2 in other languages (their RAM differs), Emerald DE (its RAM is the English game's – shown in the 3.0 acceptance – but its link battles weren't recorded, so it stays off),
the DS games in other languages (their static data sits elsewhere: German Platinum, German HG/SS …), hacks whose RAM
moved, four DS players (who fought whom can't be told from counters), White 2 (its save data, money and records read
right in a running White 2 – the same pointer as Black 2's –, but no link battle of it was recorded yet: off until one
is; its link-room sign too). Gen 5 draws: the record after the losses (15) is
likely the draws but no draw was seen – a draw counts as nothing (no winner, nobody pays).

**Agreement.** At the session's end (before each console goes on alone) every peer writes what it read into the run
document under its own key: `lb:<sid>:<slot>` = `{ seats, per: { slot: { w, l, d } }, multi, wager, h }`, `h` = FNV-1a 64
over the session id, the seats, every seat's counts and the wager. A result counts only when every seat's entry is
there, none is void and all hashes are equal (`outcomeOf`). Void: the session fell out of step (`desync` – the saves go
back anyway), a player dropped out and rejoined (`rejoin` – their page can't know what happened while it was away), a
seat's game can't be read (`unread`), the counts don't fit together. A player who never writes their entry (crashed)
leaves the session pending forever: nobody pays. Two seats: who won more of the session's battles wins (several
battles in one session are fine, “won 2 : 1”); a tie is a draw. Four Game Boy Advances: two winners against two
losers of a multi battle.

**The log, the record, the stream.** `feed:lb-<sid>` (every computer writes the same entry, keyed by the session):
“Sam won a link battle against Tim” / “… won 2 : 1 in link battles against Tim” / “Sam & Lena beat Tim & Robin
in a multi battle”. The head-to-head record is computed from the agreed entries (`headToHead`) and shown on the
partner's card on the board and in the result card. The stream API has a `link-battle` event and the log entry carries
winners, losers and the wager (docs/STREAM_API.md).

**Wagers.** The challenger's Battle opens a small challenge: the format (single/double where the game lets you pick;
multi with four GBAs) and “Battle for money”: an amount up to what their game holds (read from the running game) and
the run's limit. The invite carries `caps: ['wager1']`, `wager` and `format`; the accept carries the invitee's caps and
the most they put in (their money, read when they join). The stake every peer works out at the start: the offer,
lowered to every accept and the rule's cap – 0 unless every seat announced `wager1` (a partner on an older 3.0 build
sees an invite without a wager and the bar says “no wager – Tim's souldew doesn't know wagers yet”) – then at the
session's end lowered again to what every seat's game holds then (read by every peer from every console – at the start a
game that boots for the link has no save loaded yet and reads ₽0; nothing can be spent in the Colosseum anyway). The stake is
part of the hash.

- **Currency: money only.** Game Corner coins were considered and left out: not every game has them in the same way
  (the Coin Case first; some regional versions removed the slot machines), they buy Pokémon and TMs at the prize
  counters directly – which a SoulLink's encounter rules don't expect – and a coin wager would double the per-game
  tables for little gain. Money only buys items, so it is harmless in a Nuzlocke-type run.
- **Settlement** (`WagerPay`, from the play view's live loop): once the player stands in the overworld of their own
  game, alone (no link, no battle; Gen 1 `wIsInBattle`/`wLinkState` 0, Gen 2 `wBattleMode`/`wLinkMode`/`wScriptRunning`
  0, Gen 3 the Shared World's camera reader – `camIdle`: not locked, no fade, no battle, no help screen, no FR/LG quest-log
  replay; cheats ask the same –, Gen 4 the battle flag's overworld value), the money
  goes into RAM through the cheat path (the fast player's WRITE between two frames), is read back, and read again
  1.5 s later: still the old sum (Emerald moved its save blocks just then) → it goes in again; anything else → done.
  Gen 1 3-byte BCD, Gen 2 3-byte big-endian, Gen 3 u32 XORed with SaveBlock2's key (Emerald, FR/LG; R/S plain), Gen 4
  u32 in the trainer block (save data +0x90, only when its records decode). Clamped to ₽0 … ₽999,999.
- **Exactly once into a save.** `lbpay:<sid>:<slot>` = `written` (with the game's boot id) → `saved` when the game's next
  battery save reached the run. A reset, a loaded save state or a new start before that is another boot: the money goes
  in again. The payer's computer logs “Tim paid Sam ₽2,000 (link battle)” (`feed:lbp-<sid>-<slot>`).
- **Multi battle:** each player stakes the wager; each loser pays one winner (the pot split per team).
- **Exploits considered:** a client can only change its own game's money – a tampered page could add money without any
  of this (cheats are a run rule of their own). A lie in the result voids it (the hashes differ). Writing nothing as a
  loser is possible for a tampered client – the log shows the result and the missing payment.
- **Money follows this computer's own result only.** Every partner's computer can write any key of the run document –
  its own slot's entry and this player's too. A tampered client could write a matching pair for a battle that never
  was. So each computer keeps what it read itself apart from the run document (browser storage, `sl-lb-own-<runId>`,
  `recordResult` / `ownResultOf`, the newest 200 sessions) and `WagerPay` / `owedTo` only pay a session whose
  result this computer read and every partner's entry matches – that entry stands for this player whatever the run
  document holds under their slot. A partner's entry that arrives late (a reconnect) still counts then; the log and the
  head-to-head record keep showing what the entries say, they move no money.

**Rules** (host-signed like every SoulLink rule, `shared/hostrules.mjs`): “Wagers in link battles” (`linkWagers`,
default on, only with link battles allowed) and “Highest wager” (`linkWagerCap`: no limit, ₽1,000, ₽5,000, ₽10,000,
₽50,000). “Losing a link battle counts as deaths” is independent.

**Level fairness (research, not built).** linkcable.app offers “Scale Levels”. The games' own link rules don't: the Gen 1
and 2 Colosseum have no level cap (Gen 2 only checks Pokémon that can't be traded), the Gen 3 Colosseum has none (the
Battle Tower's level-50/open rules apply only there), the Gen 4 Union Room has none. Options: (a) a run rule that
refuses the invite when either team is above the run's current level cap (the tracker knows both teams – cheap, no
memory writes); (b) a souldew-side check before the battle that only warns; (c) writing scaled levels/stats into both
consoles' battle copies at the start of each battle – deterministic on every peer, but per-game battle structs, stat
recalculation and the risk of a desync make it the expensive option. (a) fits a SoulLink best.

**Ideas not built:** a “Win 10 link battles” trophy (counted from the agreed entries – suggested, not added: trophies
are counted from run digests, which would need the head-to-head in them); an overlay alert for the `link-battle` event.

## 9. Shared World

Goal: partners walk visibly in your game, on the same map, and you can walk up to them and press A to trade or battle.

GBA-PK's approach injects NPC objects into game RAM per ROM revision, which breaks on randomizers and is CC BY-NC. souldew's version is an **overlay drawn by souldew** over the emulator picture, fed by RAM reads. Nothing is written into the game.

**Status (branches `feat/shared-world`, `feat/30-world-plus`, `feat/30-world-gb`, `feat/30-world-ds`): Gen 1, 2, 3 and 4 (Platinum, HeartGold/SoulSilver) work in the app** – Red, Blue, Yellow, Gold, Silver, Crystal, Ruby, Sapphire, Emerald, FireRed and LeafGreen (Gen 3 also in German: Rubin, Saphir, Smaragd, Feuerrote, Blattgrüne) tested end to end with two to four scratch profiles (`scripts/world-e2e.mjs`). Every player is followed by their lead Pokémon; emotes and rock-paper-scissors (commit–reveal, also from the board for every other game); partners on a connected map show across the edge. The Game Boy games: see [The Game Boy games](#the-game-boy-games-gen-12) below.

| Game | Status |
|---|---|
| Emerald (US/EU rev 0) | **Works** (tested 18 Nov 2026, 2 and 4 players): partners drawn and animated, names, followers, depth against your own player, hidden behind the map's top layer (tree tops, roofs, plants) and under the map-name popup, A → menu, Wave/emotes/rock-paper-scissors both sides, Trade/Battle into the link flow |
| Sapphire (US rev 0) | **Works** (tested, 4 players: two Sapphire players see each other and their followers, the Emerald pair doesn't – another map numbering) |
| Ruby (US rev 0) | **Works** (tested 18 Nov 2026, 2 and 4 players – also Ruby ↔ German Sapphire with followers, rock-paper-scissors, the heart, the log line). Every address of its table checked in the running game: SaveBlock1 pos = the player object, the camera offset mid-step, CB2_Overworld, the lock with the START menu, the fades on the stairs and the door, Task_MapNamePopup on entering Route 101, the backup map = layout +15/+14, the player's sprite at OAM 112/56 |
| Ruby / Sapphire German (Rubin rev 0, Saphir rev 1) | **Works** (tested 18 Nov 2026, app in German, 4 players: Rubin ↔ Saphir see each other, the German Emerald pair doesn't). Rubin: `ruby_de` from `pokeruby_de.sym`; Saphir: own `world` table in `sapphire_de` (the German Ruby's RAM – `pokesapphire_de.sym` agrees symbol for symbol – and its ROM addresses, rev 0 and 1). Every address checked in the running games like Ruby's |
| Emerald German (Smaragd rev 0) | **Works** (tested 18 Nov 2026, 2 and 4 players, also with an English Emerald partner). New entry `emerald_de`, which also turns on the live tracker (team, place, battle, catch, level caps, the bag – checked in the game): the RAM is the English Emerald's – derived by aligning the two ROMs and reading every load site of each English address (9–2372 sites per symbol, no conflicting vote), then every address checked in the running game like Ruby's; ROM addresses of its own (`rom.0`) |
| Ruby US rev 1–2, Sapphire US rev 1–2, Rubin rev 1, Saphir rev 0 | Same code and tables from the pret symbol files – not run here |
| FireRed (US rev 0) | **Works** (tested 18 Nov 2026 with a German LeafGreen partner: walking, followers, rock-paper-scissors, the log line). Every address checked in the running game (see the FR/LG notes below); rev 1 untested |
| FireRed / LeafGreen German (Feuerrote, Blattgrüne rev 0) | **Works** (tested: German LeafGreen ↔ German FireRed, app in German). Own `world` table in `firered_eu`/`leafgreen_eu` (RAM: IWRAM from gMain on 0xB0 lower, EWRAM as in English; ROM addresses per game code `BPRD:0`/`BPGD:0`), every address verified live |
| FireRed / LeafGreen French, Italian, Spanish | The same entry and RAM as German (two tracker tables say so) – untested; the overworld callback is learned, the sprite and icon tables searched, no map-name popup cut-out |
| LeafGreen US (rev 0–1) | Same as FireRed US, from `pokeleafgreen*.sym` – untested |
| Radical Red 4.1 (the "FireRed (patched)" here) | The FireRed US RAM still fits (checked by the literal pools and a live probe), the graphics table is found by the search; its expanded species (1375) have no icon table souldew recognises: **no followers**, partners untested |
| Emerald/Ruby/Sapphire FR/IT/ES, hacks with moved RAM (CFRU/Unbound …) | No overlay (no verified RAM addresses – no such ROM on the test Mac); the board keeps saying where the partner is. Randomized ROMs work (maps, RAM, sprite and icon tables unchanged). An unknown *revision* of a known game learns its overworld callback and searches the ROM for the sprite tables |
| Red / Blue (US/EU) | **Works** (tested 19 Nov 2026: Red ↔ Red, Blue ↔ Yellow, Red, Blue, Yellow and Red together, with `--plus`; on the original Game Boy, and Red ↔ Yellow with "Game Boy look" › Color – partners and followers in the green Red's own sprite has there). Every address from `pokered.sym`/`pokeblue.sym`, the camera checked frame by frame against the picture (`--frames`), the START menu lock in the running game. Partners across Pallet Town's edge: unit-tested with Route 1's real alignment; the e2e walker didn't find its way out of Pallet Town's fences, so not run across (the same code carried Crystal ↔ New Bark Town across) |
| Yellow (US/EU) | **Works** (tested with Blue, see above). Its own Pikachu walking behind you is the game's: souldew draws no second follower then, and your partners see Pikachu follow you (`gameLead`, below) |
| Gold / Silver (US/EU) | **Works** (tested 19 Nov 2026: Gold ↔ Silver, Silver ↔ Crystal, Crystal, Silver, Gold and Crystal together, with `--plus`; and Red, Blue, Crystal, Silver in one run: each pair sees only its own family). A Gold/Silver map goes out with Crystal's number (`canon`, below) |
| Crystal (US/EU rev 0) | **Works** (tested with Silver: walking, followers, rock-paper-scissors, the heart, partners across the Route 29 ↔ New Bark Town edge, the camera frame by frame). Rev 1 (`pokecrystal11.sym`) has the same addresses – not run here |
| Crystal Legacy 1.3.1 (a hack on the Crystal engine) | Partners only, from a static check (not run here): its WRAM is 11 bytes further on – found from the code like the live tracker's (`shared/live/romwram.mjs`) – and its sprite and colour tables are found by their shape; its party icon tables aren't recognised: **no followers** |
| Polished Crystal, other Gen 1/2 hacks with their own engine | No overlay (no ROM here to verify a table; Polished Crystal's RAM and graphics are its own) |
| Gen 1/2 in other languages (German …) | No overlay: no such ROM on the test Mac, so no address could be verified |
| Platinum (US) | **Works** (tested 19 Nov 2026, 2 players, branch `feat/30-world-ds`): partners drawn into the 3D field with their own overworld sprite from the ROM, names, followers (party icons), A → menu, Wave/emotes/rock-paper-scissors both sides – see "Gen 4 (DS)" below |
| HeartGold / SoulSilver (US) | **Works** (HeartGold tested 19 Nov 2026, 2 players; SoulSilver has the same addresses – xMAP – untested): as Platinum, outdoors with the perspective camera, lit like the field (evening, night, caves), followers are the game's own overworld Pokémon |
| Diamond / Pearl, other languages of Gen 4 | Not yet: no field addresses verified (pokediamond has no symbol map, and no D/P save on the overworld was at hand). Diamond, Pearl and Platinum are one family (map headers 0–558 are the same), so the rest is ready for them |
| Gen 5 | Dropped for now – see the feasibility notes below |
| 3DS | Not yet – see the feasibility notes below |

### How it works

```
 player page (iframe)                          play view                         partner's play view
 ┌──────────────────────────────────────┐  ┌───────────────────────────┐       ┌──────────────────────┐
 │ nativeplayer: WATCH → a few RAM bytes │  │ lib/sharedworld.mjs        │ world │ … → their overlay     │
 │   with every picture (camera, keys)   │  │  ≤15 msgs/s while moving,  │──────▶│                      │
 │ lib/worldoverlay.mjs                  │──│  1/s still, relay 1/2 s    │◀──────│                      │
 │   reads camera + player, draws        │  │  Trade/Battle → linksession│ (sync │                      │
 │   partners (sprites from the ROM),    │◀─│  partners' states in       │ .mjs) │                      │
 │   names, waves, the A menu            │  └───────────────────────────┘       └──────────────────────┘
 └──────────────────────────────────────┘
```

1. **Read** (`shared/world.mjs`, tables in `shared/data/addresses.json` › `world`, from the pret symbol files per revision):
   - the camera: `SaveBlock1.pos` (the camera's tile; Emerald/FR/LG through `gSaveBlock1Ptr`, R/S fixed) plus `gFieldCamera.x/y` (the sub-tile offset: `CameraMove()` counts the new tile when a step begins, the offset runs 1…15 toward it) → world pixels;
   - the player: `gPlayerAvatar` (object event id, flags: running), `gObjectEvents[id]` (facing, graphics id → avatar kind and gender via the game's `sPlayerAvatarGfxIds`), the map from `SaveBlock1.location`;
   - drawable: `gMain.callback2 == CB2_Overworld`, not `gMain.inBattle`, not `sLockFieldControls` (menus, messages, scripts), `gPaletteFade` (the overlay fades with the screen);
   - your own sprite: `gSprites[gPlayerAvatar.spriteId]` (its OAM position, animation command and flip) – so a partner behind you is drawn behind you.
   - the map for occlusion: `gMapHeader.mapLayout` (the layout in the ROM → its primary/secondary tileset) and `gBackupMapLayout` (FR/LG `VMap`: the blocks as the game holds them, with the 7-tile border of the connected maps – opened doors, cut trees and generated floors are in there). `shared/worldmap.mjs` decodes the tilesets from the ROM (LZ77), and per metatile builds a 16×16 mask of the top four tiles' opaque pixels when its layer type draws them on BG1 above the sprites (NORMAL and SPLIT; COVERED goes to BG2 under them – pokeemerald `DrawMetatile`). Emerald/RS: 512 metatiles and tiles in the primary, u16 attributes with the layer type in bits 12–15; FR/LG: 640, u32 attributes (after the tileset callback) with the layer type in bits 29–30. Masks are built on first use and kept per tileset pair.
   - the map-name popup: an active task in `gTasks` whose function is the game's `Task_MapNamePopUpWindow` / `Task_MapNamePopup` (ROM address per revision), its slide offset in `data[2]` → the rectangle at the top left (Emerald 96×40, R/S 112×32, FR/LG up to 192×24). FR/LG's help screen (`sInHelpSystem`) hides the partners like a lock.
   - **Per picture**: the native host got a `WATCH` command (`native/retro-host/retrohost.c`, cmd 14): the page names ≤16 ranges (≤512 bytes) and the host sends them (`WATCHED`, message 16 – 15 is the link host's SEATSTATE) right before each picture. The overlay draws for exactly the picture on screen – no wobble against the map while walking. An older host ignores the command: the overlay then reads the 10 Hz RAM mirror (works, a little less exact while walking). The browser player reads its emulator's memory directly every animation frame.
2. **Exchange** over the run's peer channel, a Trystero action of its own (`world`, `web/lib/sync.mjs`): `[v, seq, t, family, map, x, y, flags]` (~40 bytes of JSON; flags = facing, kind, gender, running, hidden, elevation – bits 10–13, 0 from older versions = the ground). Up to 15 a second while something changes, a heartbeat once a second while standing still, a "hidden" message when you leave the overworld (battle, menu screens). Partners without a direct link get one message every 2 s over the encrypted MQTT relay. Measured: ~45 bytes per message, so ≤ 0.7 KB/s per partner at the 15-a-second maximum while walking, ~45 B/s standing still.
3. **Interpolate** (`Track`): the picture runs ~1.5 message gaps behind the newest state (60–600 ms, adaptive – while the partner walks the delay holds, it only grows when the states run out), linear in between; past the newest it extrapolates ≤150 ms at the speed the walk had and never past the tile it was heading for, then waits there; a map change or a jump of more than 3 tiles snaps. Players move like the game moves them – along the tile grid, at a constant speed, starting and stopping on a tile – so a stretch that starts from standing begins as late as the walking speed allows (no creeping ahead), one into a stop goes on at the walk's speed (no slowing down), and one round a corner goes along the grid (no diagonal); the walking speed is measured per kind from the middle of walks.
   - **Smooth motion** (`world-e2e.mjs --smooth [--capture] [--cross]`, metrics in `scripts/world-motion.mjs`, the overlays' `trace()`): every sprite souldew draws must step like the game's own. What makes it so: (a) **one clock per game picture** (`PictureClock`): the overlay draws on every animation frame and again with every picture; partners are sampled at the picture's time (smoothed from the arrival times and the host's frame numbers, never ahead of the picture, never back), so they step when the background does, never between two pictures; (b) **in step with your walk** (`StepGate`): the Game Boy games and the DS field move the picture every other frame – while you walk, partners move on those frames only, so one walking beside you keeps their place; (c) **states stamped with their picture's time**: the page tells the play view how old a state's picture is (`age`), and the play view sends on a 66 ms beat (a state that came a millisecond early was dropped before – gaps of 66 or 133 ms at random); (d) **a straight walk evened out** (`Track._even`): the mean over two usual gaps, narrowing to nothing where a walk starts, turns or stops – HeartGold/SoulSilver move a running player 8, 4, 4, 0 units a frame, which gave states 12 and 4 apart by turns; (e) **whole pixels by the step** (`pixelSnapper`): the drawn position follows the rounded step and stays within ¾ px (a position on the half pixel rounded now up, now down), and round a corner the axes share the frame's step; (f) **your position from the picture's bytes**: the player object comes with every picture (WATCH), and a tile between the camera and the object is the same player mid-step (`readPlayer` went by the object's tile there – your follower and the partners' picture of you stood for 3–6 frames each tile, then jumped 6–7 px); (g) **followers**: crossing into a connected map moves their path along (`Follower.rekey`), and a follower is hidden only while it waits on its player after a door – not when the player turns back through it; (h) Gold/Silver/Crystal run a script for 4–6 frames when a step ends here and there (Route 29): that alone no longer hides the partners (a script running longer than 8 pictures still does).
   - Measured with two players on one Mac (see §12 for the numbers per game, before → after).
4. **Render** (`web/lib/worldoverlay.mjs`): a 240×160 canvas exactly over the picture, scaled by the same CSS size with `image-rendering: pixelated` (nearest neighbour, like the game). Sprites come from **this computer's ROM** at run time (`shared/worldsprites.mjs`: `gObjectEventGraphicsInfoPointers` → graphics info → 4bpp frames, palette by tag from `sObjectEventSpritePalettes`, the game's own animation tables; tables searched for when not at the known address). Animation follows the distance walked (walk, run, Mach/Acro bike, surf). Depth: partners behind your feet line are drawn first, then your own sprite again (its exact current frame from the ROM) where it covers them, then partners in front. Occlusion: each sprite (the partners', and your own when it is drawn again) loses the pixels under the map's top-layer masks at its spot – unless its elevation puts it above BG1 (`sElevationToPriority` < 2: bridges). Nothing is drawn on the map-name popup's rectangle while it shows (with 12 rows extra while it slides in: the tasks come from the 10 Hz mirror). Name tags are crisp HTML in the player's colour; the wave bubble is pixel art (original, no game graphics). Partners show only on the same map of the same game family (Ruby ↔ Sapphire, FireRed ↔ LeafGreen; Emerald ↔ Ruby are not mixed – their map numbering differs).
5. **Interact**: standing still, facing a partner's tile, A (from the game's own `gMain.heldKeys`, or the fast player's input) → after 110 ms, if the game didn't answer the button itself (a sign, a person: field controls locked), souldew's menu opens over the game and the game pauses: **Trade / Battle / Wave / Cancel** (arrows, Enter/Space and Escape, the mapped A/B keys in the fast player, a controller, the mouse; clicking a name tag opens it too). Trade/Battle call `LinkSessions.invite(kind, [slot])` (the existing invite → Join/Not now flow) and dispatch `sl-world-action` for other integrations; they're disabled with the reason when the run's rules, the link state or a missing direct connection don't allow them. Wave shows the bubble over your avatar on every screen that sees you.
6. **UX**: one quiet switch in the play view's side column, "Show partners in my game" (per run, this computer only, default on; shows "· 1 here" while someone is on your map). It only appears when this game is supported. Off hides the overlay; your own position still goes out so the partners can see you. Never in link sessions, solo runs or games without tables. A second switch, "Show my Pokémon following me" (every run, this computer only, default on), is independent of it: with partners off your own follower still walks.
7. **Followers** (`shared/worldicons.mjs`, `shared/world.mjs` `Follower`): Gen 3 retail has no overworld Pokémon, so a follower is the Pokémon's **party-menu icon from this computer's ROM** (32×32, two frames, 4bpp). The three tables lie together in every Gen 3 game and language – `gMonIconTable` (440 pointers by internal species, Egg 412, Unown B–? from 413), `gMonIconPaletteIndices` (440 bytes 0–5), `gMonIconPaletteTable` (6 × { palette, tag 0xDAC0+i }) – and are found by that palette table's tags in one pass (~5 ms; Emerald 0x0857BCA8, FR US 0x083D37A0, FR DE 0x083D30B4, LG DE 0x083D2EF0, Ruby US 0x083BBD20). Species on the wire are National Dex numbers, mapped to the internal index with `gen3_index_to_dex.json` (Unown by its letter, Deoxys with the game's own form icon). The lead is the first party member that isn't an egg and isn't at 0 HP – from live tracking for you, from the partner's message for them. A randomizer changes species, not tables: the icon is right. A hack with more species or other tags isn't recognised: no follower (never a wrong one).
   - **The trail**: the follower walks the leader's *path* one tile (16 px of path) behind – not a straight line – so it rounds corners, steps out of a door after them and swaps places when they turn back. Fed every picture with the leader's position (yours exact from the camera, a partner's interpolated); crossing into a connected map moves the path along with the frame (`Follower.rekey`: it walks on over a route's edge); a warp or a jump of more than three tiles puts it onto the leader (hidden until they step away – it comes out of the door after them); the first sight of a player puts it one tile behind their back. It faces where it walks (the icons look left; mirrored walking right), changes frame every 8 px walked, stands still with them. Hidden while its player surfs, dives or is hidden.
   - **Drawing**: a sprite like the partners – sorted by its feet line between them and your own sprite (your sprite is drawn again over a follower behind you), cut by the map's top layer at the leader's elevation, clipped by the map-name popup; its lowest opaque pixel stands on the tile's bottom row. A shiny lead gets a small original sparkle every 2.4 s (Gen 3 icons have no shiny colours). It **overlaps people, walls and doors**: the game doesn't know it's there (nothing is written into the game), just like the partners.
   - **On the wire**: an optional 9th element of the world message, `{ f: [species, flags], z: [w, h] }` (flags: bit 0 shiny, bits 1–5 the form; `f: 0` = nobody follows; `z` the sender's map size, for connected maps). Sent when it changes and with the once-a-second heartbeat (and every relay message), so it costs ~0 bytes while walking. 3.0 builds from before it read only elements 0–7 and never see it (`test/worldplus.test.mjs` keeps a copy of their parser). Your partners always see your follower; the switch only changes your own picture.
8. **Emotes**: Wave plus a heart, "!", "?" and "GG" – a row in the A menu, original pixel art in a speech bubble (`web/lib/worldart.mjs`). `{ t: 'wave' }` as before (older builds show it), `{ t: 'emote', e }` for the new ones (older builds ignore them). A token bucket on both ends: 4 at once, then one every 2.5 s – a partner's client that sends more gets 5 bubbles and then nothing.
9. **Rock-paper-scissors** (`shared/rps.mjs`, `web/lib/worldrps.mjs`, `web/views/rps.mjs`): from the A menu (or a name tag), the hand on a partner's tile, or the board's log ("Play against: …", best of 1 or 3) – the board works for every game, Gen 1 to 3DS, since it only needs the run's peer channel. **Commit–reveal**: each side first sends SHA-256 over `souldew-rps|game|round|slot|hand|nonce` (16 random bytes); the hands go out only once both commitments are in; a hand that doesn't match its commitment is refused (the game doesn't count, both screens say so); the slot in the hash makes copying the other's commitment useless; a reveal that arrives before your own commitment is kept back. Time: 10 s to pick (no pick in the first round = no game; later = a loss), 6 s to show your hand once both picked – **not showing it after seeing the other's is a loss**, so leaving can't undo a defeat. A draw is played again (5 rounds at most, then a draw); best of 3 goes to two wins. In a Gen 3 game on the overworld the picker opens in the picture (the game waits while you pick, ≤ 10 s; ◀ ▶, A, B to pass, a controller, the mouse) and the hands pop up over both heads (the losing one fades) – partners on the same map see them too. Otherwise (another generation, Shared World off, a battle or a menu on screen when the challenge came) a small card at the bottom of the app. One game per pair; three challenges, then one every 20 s (the receiver ignores more). The player who asked writes one line into the run's log: "Sam beat Tim at rock-paper-scissors" (best of 3 with the score; "… (Tim gave up)" for a forfeit; draws too). Messages: `{ t: 'rps', op: 'ask' | 'c' | 'v' | 'x', id, to, … }` on the world action, over the relay for partners without a direct link (older builds ignore them – the asker sees "didn't answer").
10. **Connected maps**: the local map's size (its layout in the ROM) and connections (`gMapHeader.connections` → { direction, offset, map }) place a partner on a neighbouring map in your frame (pokeemerald `Fill*Connection`: south at your height + offset, east at your width, north and west at minus *their* size – which they send in `z`). `Track.sample` interpolates in that frame, so a partner crossing the edge slides on instead of stopping; followers, the A menu and name tags work across it. Partners on older builds (no `z`) show next door only to the south and east.
11. **FR/LG's quest-log replay** ("Previously on your quest…" after loading) runs with the overworld callback, unlocked, the player walking: `gQuestLogState` (EWRAM 0x0203ADFA in every revision and language; 2/3 = playback, 1 = the recording during normal play) hides the partners and sends you as hidden while it plays (verified live in Feuerrote/Blattgrüne/FireRed).

### The Game Boy games (Gen 1/2)

`shared/worldgb.mjs` is what differs; everything else – the wire, the interpolation, the followers' trail, emotes, rock-paper-scissors, the A menu, the overlay itself – is the Gen 3 code. The tables (`addresses.json` › `world` of `red_us`, `blue_us`, `yellow_us`, `gold_us`, `silver_us`, `crystal_us`) come from the pret symbol files of the `symbols` branches (`pokered`, `pokeblue`, `pokeyellow`, `pokegold`, `pokesilver`, `pokecrystal`); the RAM fields end in `Addr`, so a hack built from the disassemblies whose WRAM moved gets the moved addresses the same way the live tracker does (`gbWramShift`).

1. **Where the player is** – everything the overlay reads is in WRAM banks 0 and 1, which the mirror and `WATCH` reach (no HRAM, no VRAM):
   - Gen 1: `wCurMap`, `wYCoord`/`wXCoord` (Red 0xD35E/0xD361/0xD362, Yellow one byte lower), `wWalkCounter` (8 → 0: `AdvancePlayerSprite` scrolls two pixels each turn of the overworld loop – which runs every other frame – four on the bike, and moves the tile coordinates at 0) with the step vector in `wSpritePlayerStateData1` (0xC103/0xC105), facing in its byte 9 (0/4/8/12), `wWalkBikeSurfState`. Before a game is loaded the player's sprite slot is empty; on CONTINUE's screen the save is loaded but the player isn't drawn (image index $FF): neither counts as the overworld.
   - Gen 2: `wMapGroup`/`wMapNumber`/`wYCoord`/`wXCoord` (Crystal 0xDCB5–8, Gold/Silver 0xDA00–3, which change at the end of a step), `wPlayerBGMapOffsetX/Y` – every object on screen is shifted by it while you step: minus the pixels walked – with `wPlayerStepVectorX/Y`, `wPlayerStepFlags` and `wPlayerStepDirection` next to it, `wPlayerStruct` (`OBJECT_FACING` 0–15, `OBJECT_FLAGS2` bit 3 = in tall grass), `wPlayerState` (bike, surf, surfing Pikachu), Crystal's `wPlayerGender`.
   - **Frame by frame** (`world-e2e.mjs --frames`: A's game run one frame at a time while A walks a step each way, the camera the overlay read against the background's shift between two pictures): a Game Boy shows the scroll its RAM had one frame earlier, so the overlay takes the bytes of the frame before each picture (by the host's frame number in front of them – a picture sent twice doesn't shift them). On top: Gen 1's first turn of a step lasts a frame longer (the new row or column is drawn), its picture doesn't move yet; Gen 2's picture shows the loop's turn before – back by the step vector, except on the step's first turn. With that, 0 of 116 picture pairs off in Red and in Crystal: a partner standing still stays put on the map while you walk.
   - **Drawable**: no battle (`wIsInBattle`, `wBattleMode`), and nothing holding the player – Gen 1: the font in VRAM (`wFontLoaded` bit 0: a text box or a menu), `wJoyIgnore`, `wStatusFlags5` bits 5/7 (buttons off, scripted movement); Gen 2: `wScriptRunning` (a person talking, a sign, the START menu, a warp) or `wMapStatus` not "handling the map". Checked in the running game: the START menu hides the partners, B brings them back (`--frames`).
2. **The picture**: 160×144, the player's square at (64, 64); every overworld sprite stands four pixels higher than its square. The partners' sheets come from this computer's ROM: Gen 1 `RedSprite`, `RedBikeSprite`, `SeelSprite` (surfing); Gen 2 the game's `OverworldSprites` table by sprite id (Chris $01, his bike $02, `SPRITE_SURF` $53, Crystal's Kris $60/$61) – 24 tiles of 2bpp, six 16×16 frames, walking as the games' facing tables do it (stand, walk, stand, walk mirrored; right is left mirrored), a phase every eight frames.
3. **Colours** – the partners have exactly the colours the game's own sprites have on screen:
   - Gen 1: every overworld sprite has OBP0, so the overlay takes the colours from **your own sprite on the picture** (the native player's last picture, `host.picture()`): the colour numbers of the frame the game shows against the picture's pixels there, its top half only (tall grass may cover the bottom). That is right on the original Game Boy ("Game Boy look" › Original, SameBoy's lime greens), in a Game Boy Color's colours for Red/Blue (the boot ROM's palette for the title), in Yellow's own colours – and through every fade. Until it has seen your sprite: the original Game Boy's shades.
   - Gen 2: the overworld OBJ palette from the ROM (`MapObjectPals`: four times of day × eight palettes, `wTimeOfDayPal`), the sprite's own palette number (Chris red, Kris and the surf sprite blue), converted the way SameBoy shows them ("emulate hardware": its colour curve and the green/blue mix, `GB_convert_rgb15`).
4. **The followers**: the party menu icon from the ROM, one step behind on the leader's path as in Gen 3. Gen 1: one of the game's generic icons (a monster, a bird, a ball, a helix …), built like its OAM writer – `MonPartyData` picks the icon, `MonPartySpritePointers` copies its tiles (some from overworld sprites), the left half mirrored except the helix – in the overworld sprites' colours. Gen 2: the Pokémon's own icon (`MonMenuIcons` → `IconPointers`) in the Pokémon's own two colours (`PokemonPalettes`, normal or shiny – a shiny follower looks shiny, no sparkle needed). **Yellow**: while the game's own Pikachu walks behind you (sprite slot 15 on screen), souldew draws no second follower, and sends Pikachu as your follower so your partners see what you see; A at a partner who stands on your Pikachu's tile is the game's (it talks to Pikachu). The A menu waits 250 ms for the game's own answer in the Game Boy games (110 ms in Gen 3): their overworld runs every other frame and opens a text box later.
5. **Occlusion – what the hardware does**: a Game Boy hides sprites behind the map in one place, the tall grass. A sprite standing in it gets the OAM priority bit on its lower half (pokered `UpdateSpriteImage` / `wSpritePlayerStateData2GrassPriority`, pokecrystal `SetTallGrassFlags`), so the grass's colours 1–3 cover those rows and colour 0 shows them. souldew does the same for partners, followers and your own sprite drawn again: Gen 1 asks whether the tile under the square's lower left is the tileset's grass tile (`wGrassTile`), Gen 2 the collision of the square's quadrant (tall and long grass, and water – as `CheckGrassTile` does); the grass's colour numbers come from the tileset in the ROM (Gen 1 2bpp as it is, Gen 2 through its LZ – `gbLz`, Crystal's second $60 tiles in VRAM bank 1 numbered $80 on), the blocks from `wOverworldMap`/`wOverworldMapBlocks` (with the three blocks of the connected maps around them). The Game Boy Color's background priority attribute isn't used by any of these games on map tiles (Crystal's and Gold/Silver's palette maps carry a palette and a VRAM bank, never the priority bit), so nothing else covers a sprite. Crystal's place sign is the window over the bottom four rows with that priority set: nothing of souldew's is drawn there while its timer runs. Your own sprite is drawn again over partners and followers that overlap you (it has the first OAM entries, so the game's own people go under you too on a Game Boy Color; the original Game Boy lets the leftmost sprite win – the rare overlap there may differ by a pixel column or two).
6. **Connected maps**: from your own RAM – the connection headers (`wNorthConnectionHeader`…, Gen 2 `wNorthMapConnection`…, 11 and 12 bytes) say where entering the neighbour puts you (its row or column alignment), so a partner there is placed without knowing their map's size.
7. **Families**: Red, Blue and Yellow share every map number (Yellow only adds the beach house). Gold/Silver and Crystal share every map but not every number – Crystal inserted maps into some groups – so a Gold/Silver map goes out with Crystal's number: `canon`, generated from the pret map constants (68 maps differ; every shared map has the same size in both, 58 have a few blocks changed; Gold/Silver's Tin Tower back entrance has none in Crystal and goes out as 0). Gen 1 and Gen 2 never meet (other maps; no Time Capsule walk).
8. **Hacks**: the ROM tables of `t.rom` are checked where the table says (`gbRomTables`) and, where one doesn't fit, found again by their shape – the player's and the bike's red walking entries before the Game Boy kid's green standing one; the icons' run of $80 steps only together with the 251 icon numbers right before it (a run alone appears in other tables too); the people's palettes ending in black after two whites in the sixth. What isn't found is left out: no partners without sheets, no followers without icons (Crystal Legacy), the overworld colours without `PokemonPalettes`.

### Limits (Gen 1/2)

- Partners walk through NPCs, walls and over ledges on your screen if they stand there in their game; the tall grass is the only map part that covers them (as it is for the game's own sprites). A Gold/Silver partner in one of the 58 maps Crystal redrew a little (some Pokémon Centers, Goldenrod, Route 36 …) may stand on a tile that looks different in your Crystal.
- Ledge jumps slide, surfing partners are drawn with the surf sprite their game uses (Seel in Gen 1, the surf Pokémon in Gen 2); Yellow's surfing Pikachu and Gen 2's surfing Pikachu show as the plain surf sprite.
- Followers walk through people and doors and stand in the void for a step after entering a room, as in Gen 3. Gen 1's generic icons are the game's own (a bird for Pidgey and Spearow alike).
- The colours of Gen 1 partners come from your own sprite: in the frame or two after a palette change (a fade starting) they may lag a little; a fade to black or white hides nothing by itself – the warp's script or text box does.
- The browser player (EmulatorJS, Settings › fast player off) shows no partners in Game Boy games: the overlay needs the native player's per-picture bytes and pictures.
- Not verified: Crystal rev 1, Crystal Legacy in a running game, other languages, Polished Crystal (no ROMs here); Gen 2's bike and surf sprites drawn in a partner's game (taken from the same table as walking, the e2e didn't ride); a Gen 1 partner across a map edge in a running game (see the table).
- Verified 19 Nov 2026 with `scripts/world-e2e.mjs` (`--plus`, `--frames`, `--edge`, `--look color`, 2 and 4 players) and battery saves made by `scripts/rom-matrix.mjs` plans (to the first Pokémon, then START › SAVE; ROM copies and saves in a scratch folder, never committed). The saves stand in Route 29's tall grass (Gen 2) and south of Oak's lab (Gen 1); the e2e keeps a Repel going so no wild Pokémon interrupt the walking.

### Gen 4 (DS): the 3D field

The DS field is 3D: a perspective camera outdoors (pitch and distance per map type – Platinum has 20 camera types, HGSS
tilts per map), an orthographic one in most houses, and a camera that eases after the player. souldew doesn't model any
of that: **it reads the two matrices the game hands to its 3D engine** – NitroSystem's `NNS_G3dGlb` (projection 4×4 at
+0x08, camera 4×3 at +0x4C; `nnsys/g3d/glbstate.h`) – and projects a world point exactly as the geometry engine does
(row vector × camera × projection, then the top screen's viewport). A camera that eases, tilts or zooms is just another
matrix. `shared/worldds.mjs`, tables in `addresses.json` › `world` (Platinum US, HeartGold/SoulSilver US, from the pret
xMAPs: `sFieldSystem`, `NNS_G3dGlb`, `gSystem`).

1. **Read** (per picture through `WATCH`, 9 ranges, ~330 bytes): the matrices; `gSystem` (vblank/frame counters, the
   keys); the `FieldSystem` (heap – its pointers move with every map load, so the overlay reads them from the RAM mirror
   now and then and watches the new addresses): the field's program and child program (menu screens, the bag, battles),
   its task (scripts, messages, warps), the location (map header) and the map matrix; the player's `MapObject` (grid
   x/y/z and the fx32 position: tile × 16 + 8 on the ground plane, y the height) and `PlayerAvatar` (walking, cycling,
   surfing; gender).
2. **Which matrices the picture shows**: the field runs at 30 fps and the picture shows the geometry of the *previous*
   main-loop iteration. `Displayed` keeps one snapshot per iteration (the first reading after `frameCounter` went back
   to 0 and up again – the VBlank interrupt counts it up, the main loop clears it; a late iteration with 2 replaces its
   snapshot) and hands out the one before the newest. **Measured** against the picture by block matching while walking,
   turning and with the camera easing (a harness stepping the fast player frame by frame, 300+ frames each): Platinum interior 0.15 px mean,
   0.55 px worst; HeartGold outdoors under a pixel (the block matcher's own rounding of the 3D rasteriser's sub-pixels).
   Taking this frame's matrices instead is off by one step of the camera (2 px) every other frame; without the
   frame-counter rule, the late iterations at every tile boundary (map streaming) are off by 2 px for one frame.
3. **Same map**: a matrix of several maps (the overworld, big caves) has coordinates running across all of them, so its
   id is the key (`0x8000 | id`); a single-map matrix (a house) is keyed by its map header. Partners on the next route
   are simply there. Families: Diamond/Pearl/Platinum (`dppt`; their map headers 0–558 are the same, Platinum adds
   559–595 – maps Platinum rebuilt can show a Diamond partner where Platinum has scenery) and HeartGold/SoulSilver.
4. **On the wire**: the Gen 3 message, `x`/`y` the ground plane in world units, plus the height as a 10th element
   (after the ext, or a 0 in its place – older builds never read past the ext).
5. **Drawing** (`web/lib/worldds.mjs`): a 256×192 canvas over the top screen (`host.screen()`: the upper half, or the left
   one side by side). Partners are billboards like the game's: their 32×32 sheet decoded from **this computer's ROM**
   (BTX0 in `data/mmodel/mmodel.narc` / `a/0/8/1`, found by texture name – `pl_boy01c`, `hero`, … – so any language or
   randomized copy works), centred on the projected point, its bottom 4 px (Platinum) / 5 px (HGSS) below it, scaled by
   the projection's pixels per world unit at that depth (whole pixels at scale 1: crisp like the game's own). The offset
   was measured by matching the decoded frame against the game's own player in the picture (error 2.7 / 3.0 per colour
   channel). Frames: four per direction walking, the running half from 1.5 px/frame, bike and surf sheets. Sorted far to
   near by the feet.
6. **The map in front – the DS's own depth buffer**: houses, trees, counters, plants, people and you hide a partner
   exactly where the game's own sprites would be hidden. souldew builds melonDS itself, so its software renderer keeps
   the depth of the 3D frame on screen (`native/melonds-patch/souldew-depth.patch`: copied in `FinishRendering`, at line
   192, when the picture's frame is done and before line 215 starts rendering the next one – deterministic, ~200 KB of
   `memcpy` a frame and only while asked). The page names up to 8 rectangles of the top screen (around the partners,
   their followers and you, on an 8-pixel grid: `DEPTH`, command 15) and gets their 24-bit depths with every picture
   (`MSG_DEPTH` 17, right before `WATCHED`; `native/common/depth.c`, in retrohost through melonDS DS's exported
   `souldew_depth` – `native/melonds-ds-patch` – and in the souldew engine through its melonDS backend). A partner's
   pixel is hidden where the depth is nearer than a game sprite on its tile would be: the game draws its billboards a
   fixed distance toward the camera – measured on the player's own sprite in the depth buffer: 8 units in Platinum, 17 in
   HeartGold (`billboardDepth`) – plus 1 for rounding. Z or W buffering as the frame used (the flag comes along). Cost
   measured in the page: 0.6–1.2 ms per picture for two partners and their followers (a loaded machine).
   Without souldew's core (an older install, the browser player) there is no depth: then only your own figure covers a
   partner behind you (your sheet's silhouette for the direction you face).
7. **Light**: HeartGold/SoulSilver light the field by the time of day, caves are darker – a partner in full colour
   would glow. souldew measures the light off your own sprite while you stand still (the picture's pixels against your
   decoded standing frame, least squares per channel – only the pixels the depth buffer says are your sprite's, so your
   HGSS follower in front of you doesn't spoil it; a poor fit is skipped) and lights
   everything it draws the same. Measured in New Bark Town in the evening: ×(0.60, 0.60, 0.88); Platinum indoors ×1.
8. **Followers**: HeartGold/SoulSilver have their own – souldew draws the partners' as **the game's own overworld
   Pokémon** (`tsure_poke` sheets at the end of `a/0/8/1`, by `sModelIndexLUT`, found in ARM9 by its shape), walking the
   partner's trail with two frames per direction; your own follower is the game's (the "Show my Pokémon following me"
   switch isn't offered there). Diamond/Pearl/Platinum: the party icon (`pl_poke_icon.narc`, the palette table found in
   ARM9 by its first entries), as in Gen 3, its lowest pixel on the feet's line.
9. **When**: the field runs (its program, no child program) and no task holds the player. The partners see you on the
   field also while a menu or a message is open on your side; a battle or a menu screen sends "hidden".
10. **A, the menu, emotes, rock-paper-scissors**: as in Gen 1–3 (`web/lib/worldui.mjs` – one set of controls for every
   generation): standing still on a tile's centre, facing a partner's tile at about your height, A (the game's
   `heldKeysRaw` or the fast player's input), and no script started by the game within 110 ms. In HeartGold/SoulSilver
   your own Pokémon on that tile wins: the game talks to it, the partner waits (as Yellow's Pikachu does in Gen 1).

### Limits (Gen 4)

- The map hides a partner as deep as a game sprite on that tile, by the 3D depth: 2D parts of the picture (the
  map-name sign, the HGSS touch menu on the top screen) never cover them – partners vanish while a script holds you
  anyway. Translucent polygons that write depth (rare) count as in front, like for the game's own sprites.
- Surfing partners sit without their Pokémon (the surf mount is a field effect, not in their sheet). Field moves,
  fishing, the Pokétch pose, saving and the like show the walking sheet.
- HGSS partners' followers: the base form/male sprite (female and form sprites are skipped). A lead your game has no
  overworld sprite for (a hack) shows none. Platinum's icons ignore forms.
- The light is measured off your sprite while you stand still: right after a change (entering a cave) partners keep
  the old light for up to half a second.
- Diamond/Pearl and other languages: no overlay yet (no verified addresses). The browser player (EmulatorJS, the
  fallback without the fast player) has no per-picture bytes: no DS overlay there.
- Verified with two players on one Mac (19 Nov 2026, a loaded machine – the games ran at 20–60 % speed): Platinum in
  the Sandgem Pokémon Center 2F (the orthographic camera), HeartGold in New Bark Town (perspective, evening light).
  Clips: `world-e2e.mjs --clip`. The DS recordings' saves hold cloned Pokémon, so live tracking can't read their team:
  the Platinum follower run used `--lead`. The depth cut (`--behind`, B walking set steps while A watches): in
  Platinum's Pokémon Center the partner disappears behind the NPC standing south of him and behind the potted plants'
  leaves, as the game's own player does; in HeartGold behind the follower Pokémon in front of him and the mailbox – both
  in retrohost and in the souldew engine (`--engine`). The depth buffer itself was dumped and compared with the picture
  (every NPC, counter, roof and tree canopy is there).

### Playing together

Owner's goal: multiplayer should feel like *playing together*, not just seeing each other. Four things, built on hooks
any generation's Shared World gets once it has its tables (a partner's position and map, "in a battle", the run's
catches and deaths) – today the Game Boy games, Gen 3 and Gen 4 (Platinum, HeartGold/SoulSilver) – and, where no picture of the game is needed, for every
game of a SoulLink.

| Part | Where |
|---|---|
| Messages, checks, rate limits, the gift protocol (`GiftDesk`), the "come here" arrow's geometry | `shared/together.mjs` |
| What may be given (no key items, TMs/HMs, Master Ball; Gen 1/2 by list) | `shared/giftitems.mjs` |
| The bag: read, take out, room – through the cheats' layouts | `shared/live/cheats.mjs` `bagItems`, `removeItem`, `bagRoom` (and `addItem`) |
| The hub per run link: statuses, pings, the run log's catches and deaths, the ledger | `web/lib/together.mjs` |
| Cards, gift picker, watch panel, battle strip, board line, "Come to me" | `web/views/together.mjs`, `web/together.css` |
| In the picture: ⚔, catch, tombstones, arrow; the art | `web/lib/togetheroverlay.mjs`, `web/lib/togetherart.mjs` (hooked into `worldoverlay.mjs` in a few lines) |

1. **Who is in a battle, and watching it.** Each player's app sends a small status on the world action when its battle
   or place changes, and every 5 s (`{ t: 'tg', op: 'st', v, b, here, caps }`, ~150 bytes; HP at most twice a second;
   over the relay every 15 s and whenever a battle begins or ends). `b` is the live battle from tracking: the foe's
   species, level, HP, shiny/form and the index and HP of the player's Pokémon out there – the partner's own Pokémon
   (name, moves) come from the run doc's live team. A partner on a build without it: the run doc's `where:<slot>.fight`
   says "in a battle" too (no HP), while their live data is under 90 s old.
   - **Board** (every game, no Shared World needed): the partner's card says "In a battle – wild Zigzagoon" with
     **Watch**.
   - **Shared World**: a partner in a battle sends "hidden" (they left the overworld); the overlay keeps drawing them
     where the battle began, standing, with a ⚔ bubble. Walking up and pressing A (or clicking the name tag) opens the
     menu with **Watch** in place of Trade / Battle / Give item.
   - **Watch** is the partner screens' live picture (`SyncLink.watchPartnerScreen`: WebRTC video on a direct link,
     encrypted stills every ~1.5 s over the relay) – in the play view their window pops out over the play area, from
     the board a panel – with a battle strip from live tracking under it: their Pokémon, its HP and moves, the
     opponent and its HP. So it works even when there is no picture (the partner switched screen sharing off, the
     game is in a background tab, or the video is still connecting – a second or more after the window opens): the
     strip still shows the battle. Partner tiles in the dock show the one-line strip
     too.
2. **Catches and deaths in the world** – only what the run records, nothing made up: the hub reads the run log as it
   arrives (entries of the last two minutes, never older ones arriving after a reconnect). A `catch` entry pops the
   Pokémon's party icon (this computer's ROM, like the followers) up over the catcher's head in a speech bubble for
   2.6 s. A `death` entry of *my* Pokémon makes *my* app write `tomb:<slot>:<log id>` with where I last stood on the
   overworld (where the battle began – `SharedWorld.position()`), and every app draws a tombstone (original pixel art,
   cut by the map's top layer like the partners) on that tile of that map for five minutes, for everyone – also for a
   partner who walks onto that map later. A death the dying player's app didn't see (game closed) has no tombstone.
3. **Gift an item.** "Give item" in the A menu (or on a partner's board card while your game runs here) opens a picker
   of what your bag may give; the partner gets a card ("Sam wants to give you this – Accept / No thanks", 30 s).
   - **Order** (shared/together.mjs `GiftDesk`): both confirm → the giver's game gives it up first (written, read
     back) and records `gift:<id>` in the run doc → "go" → the receiver's game takes it (room checked first – all of it
     or nothing, read back) and records the outcome once, `giftgot:<id>` → "done" / "fail". On "fail" the giver's game
     takes it back. The receiver decides each id once and answers repeats from the doc, so a message sent twice, a
     restart or a lost link never adds it twice. **Silence is never a "fail"**: the giver asks again (`g-q`) until an
     answer comes, and a receiver that knows nothing of the gift (restarted, "go" never came) decides "not added"
     then and there – a pulled cable can't copy items. A "go" later than 20 s after "yes" is refused (the giver gets
     it back). After a restart the giver's app restores its open gifts from the doc and asks.
   - **When:** both games running in souldew with live tracking, never during a battle or a link (a partner linked
     with others: Give item is greyed with the A menu's "In a link with …", like Trade and Battle), and – where the
     screen state is read (Gen 1–4 today) – only on the overworld with no menu, text or fade (the bag menu keeps its own
     copy of the list). One gift per pair at a time; offers 3 at once, then one every 10 s, on both ends.
   - **What:** the pockets of ordinary items only (Items, Medicine, Poké Balls, Berries where the game keeps them
     apart); Gen 1's one bag by a list (no key items, badges, fossils, Safari Balls, TMs/HMs). Never the Master Ball
     (one per game – passing it on would hand one player two legendaries), never TMs/HMs (one-of-a-kind and used up
     in Gen 1–4, and in Gen 5+ given away for good), never key items. Only to a game of the same generation, and from
     Gen 4 on of the same version family (`sameItems`: HeartGold adds items Platinum doesn't have, Black 2 items Black
     doesn't …; Gen 3's five games share every item up to 348, the rest are key items). Up to 99 at once.
   - **Rule** "Gifts between us" (`itemGifts`, host-signed like every rule, default on; a strict Nuzlocke can switch it
     off): checked by both apps. **Log:** "Sam gave Tim a gift: 3 × Potion", written once by the giver
     (`feed:gift-<id>`), in every player's language.
4. **"Come to me".** A button next to the Shared World switches (every SoulLink game) sends your position (map and
   world pixels, your map's size) and place sign to every partner. On the same map – or a connected one – their picture
   shows an arrow at the edge pointing to you, or bobbing over the spot when it is on screen; otherwise the board's
   card says "Sam is at Route 110 – come here" (and a card at the bottom of the app for a few seconds). It clears
   when they get within two tiles, after three minutes, when you take it back or call again. Two at once, then one
   every 20 s (both ends).

**On the DS** (`web/lib/worldds.mjs`, the same data): a partner in a battle stands where it began with the ⚔ (the
standing-in of `standIn`), the catch pops up over their head (the party icon from this computer's ROM – HGSS's icon NARC
`a/0/2/0` too), the tombstone stands on its tile as a billboard as deep as a game sprite there (hidden by the map like
the partners; a DS position carries its height, and the tile's centre – Gen 1–3 keep its corner), and the "come here"
arrow points along the game's own camera – off screen at the edge, over the spot when it's on the picture. A gift waits
while the DS field isn't free (`gameWhy`: a script, a menu screen, a battle). Checked 19 Nov 2026 with data handed to
A's overlay (`world-e2e.mjs --tgds`, Platinum and HeartGold) and the A menu's Give item.

Older builds ignore `t: 'tg'` (Shared World and rock-paper-scissors look only at their own types – `test/together.test.mjs`
checks both). A partner that never sent a status has no gifts offered ("their souldew needs an update"); their board
card still says "In a battle" from the run doc. Stream overlay: gifts are ordinary log entries (type `gift`), so the
overlay's feed shows them; the ⚔, catches and tombstones are drawn in the game picture only.

### Limits (Gen 3)

- Partners disappear behind the map's top layer exactly where the real player does (tree tops, roofs, the leaves of potted plants, counters). Not covered: tall grass (a field-effect sprite in the game, not the map), animated top-layer tiles (the mask is the ROM's first frame), and other sprites (NPCs) – partners walk through NPCs and walls on your screen if they stand there in their game (their own game decides where they can walk).
- The map-name popup is cut out with the mirror's lag: for about a tenth of a second after it slid away a partner under it may still miss a few rows.
- Partners next door are placed by the map connection; dive/emerge connections (another layer) and warps never count. Occlusion beyond the 7-tile border the game keeps of a connected map is not applied (it's off screen anyway).
- Followers overlap NPCs, walls and doors and stand in the void for one step after entering a room (they come in through the door with you): the game doesn't know them. Party icons are 32×32 and a little bigger than the trainer sprites; no shiny colours (the sparkle says so). Hacks with expanded species (Radical Red, Unbound …): no followers.
- Surfing partners are drawn without the surf blob (a field-effect sprite with its own palette table – a follow-up); ledge jumps slide instead of hop.
- Partners vanish while a menu, a message or a script holds your player (they would be drawn over the text box), with a short fade.
- Pair runs with different games (Emerald ↔ FireRed) never share a map, by design.
- FR/LG verified (US rev 0, German FR/LG rev 0) on 18 Nov 2026 by `scripts/world-e2e.mjs --plus` with saves made by `scripts/rom-matrix.mjs` plans (ROM copies and saves in a scratch folder, never committed). Ruby US, Rubin, Saphir rev 1 and Smaragd verified the same way in the 3.0 acceptance (18 Nov 2026, 2 and 4 players). French/Italian/Spanish FR/LG and FR/LG rev 1 are not verified (no ROMs here).
- **Stream overlay (not built)**: the stream page could show the followers and the last rock-paper-scissors result next to each player's card (the lead is already in each player's live data; a result is one feed entry), and an "emote" event could flash the bubble over the player's tile. Left for later: the overlay draws cards, not the game picture.

### Feasibility for the other generations

- **Gen 1/2:** done – see [The Game Boy games](#the-game-boy-games-gen-12). (The earlier notes here had Gen 1's `wPlayerMovingDirection` for the sub-step: the step vector in the player's sprite data is what `AdvancePlayerSprite` itself uses, and it is what the overlay reads.)
- **Gen 4:** done for Platinum and HeartGold/SoulSilver – see "Gen 4 (DS)" above, with the depth buffer hiding partners behind the map. Left: Diamond/Pearl (their `sFieldSystem`, `NNS_G3dGlb` and `gSystem` addresses, verified in a running game – `NNS_G3dGlb` can be found by its first word, `0x17101610`), other languages.
- **Gen 5 (B/W, B2/W2): dropped for now** (spike on Black 2 US, 19 Nov 2026). The camera part works the Gen 4 way:
  Black 2 also hands its field camera to NitroSystem (`NNS_G3dGlb` at 0x02143A0C, found by its first word; a
  perspective projection), and a marker on a grass tile of Route 19 stayed on its tile while walking with the camera
  following. The rest has no clean footing: there is no symbol map or decomp for B/W/B2/W2, so the player's position,
  the field's state (menus, scripts, battles) and the frame counter the timing needs would come from heap pointers found
  by scanning RAM, not from the game's own symbols as in Gen 4; and the overworld sprites are another format. By the
  owner's rule (only the clean approach, no workaround) Gen 5 keeps the board's "Tim is on Route 4".
- **3DS:** research only.

### Effort for the rest

| Item | Effort |
|---|---|
| ~~FR/LG verification with a real ROM (and the e2e)~~ | done (US rev 0, DE) |
| ~~Partners on connected maps~~, followers, emotes, rock-paper-scissors | done |
| Surf blob, ledge hop | 1–2 days |
| More languages (verify RAM per language with pret or community tables) | ½ day per language |
| ~~Gen 1/2~~ | done (English Red, Blue, Yellow, Gold, Silver, Crystal) |
| Gen 1/2 in other languages, Polished Crystal | ½ day per game with a ROM to verify |
| ~~Gen 4~~ (Platinum, HGSS) | done; Diamond/Pearl ½–1 day once a save on the overworld is at hand |

## 10. SoulLink rules and UX

- **Run rules** (built, Rules tab, every player sees them – `doc` rules): "Trades between us (link)" on/off (default on), "Battles between us (link)" on/off (default on) and, under it, "Losing a link battle counts as deaths" (default **off**: while a link battle runs, the live team isn't applied to the run at all – no deaths, no wipe). Invites are hidden when a rule is off.
- **Tracker after a trade:** the traded Pokémon moves to the receiver's team. Its pair link follows the rule: "the pair stays linked across owners" (default), or "a traded Pokémon becomes unpaired". The log gets an entry, and the board shows a small ⇄ badge on traded mons.
- **UX flow:**
  - The board's partner card has **"Trade" and "Battle"**; with 3–4 players, the own card has **"Link all of us (n)"** (Gen 3 multi battles, the DS Union Room).
  - The invitee sees the bar: "Tim wants to trade Pokémon with you! – Join / Not now".
  - Preparing: "checking the games, swapping saves …", the route ("direct · 12 ms" / "relayed (TURN)"); if a partner's game isn't here: "Pick your copy of it" / "Build Tim's game".
  - Running: "Linked with Tim · delay 4 frames · direct · Meet in the Pokémon Center, upstairs at the counter" (DS: "the Union Room counter"), "Leave link"; while a partner is missing: "waiting for Tim … (if their game dropped out, they can rejoin)".
  - The play view hides pause, reset, speed and save states during a link (the partners' copies of every console must stay the same).
  - After leaving, normal play resumes from the new save, and the log shows the trade.
  - All texts are in EN/DE/FR/ES/IT. Wording to avoid: the word "faint".
- **Partner windows** (3.0): the existing partner video stays and becomes movable (separate task).

## 11. Licences and legal

| Component | Licence | Use |
|---|---|---|
| souldew | GPL-3.0-or-later | — |
| mGBA / libmgba | MPL-2.0 | Compatible with GPL-3 (MPL §3.3 "Larger Work"); keep the MPL notice (`LICENSE-mgba-MPL-2.0.txt` ships next to the host) and offer the source, as for the libretro core. |
| melonDS | GPL-3 | Compatible. |
| SameBoy | Expat | Compatible. |
| Gambatte | GPL-2.0-only | Confirmed: its sources say "version 2" with no "or later", so it can't be linked into the GPL-3 link host. The link host uses SameBoy instead – and since the seamless link (§4a) the fast player too (SameBoy's libretro core): Gambatte isn't shipped any more (only EmulatorJS's browser build still has it). |
| TGB Dual | GPL-2.0-or-later | Compatible, but older and less accurate than SameBoy. Not used. |
| GBA-PK | CC BY-NC 4.0 | **Not used, not ported.** |
| pret decompilations | — | Used only as references for RAM layouts and scripts (as the trackers already do). |

- **Never transferred:** ROMs, BIOS, firmware. The DS backend uses melonDS's built-in BIOS/firmware replacements, as the fast player does.
- **Saves** contain only the players' own data, sent encrypted to their own partner.
- **No Nintendo servers.** WFC replacements would be third-party and opt-in.
- **Naming:** no Nintendo/Pokémon trademarks in the feature name (e.g. "Link play").

## 12. Measurements

M-series Mac, darwin-arm64, Release build:

| Run | Result |
|---|---|
| 1 GBA, free-running | 2,855 fps (0.35 ms/frame) |
| 2 GBA, linked (Emerald + Sapphire) | 1,428 fps (0.70 ms/frame, worst 1.7 ms); 0.68 ms during the trade |
| 4 GBA, linked | 726 fps (1.38 ms/frame) |
| 2 GB (Red ×2) | 4,303 fps (0.23 ms) |
| 2 GBC (Crystal + Silver) | 2,892 fps (0.35 ms) |
| 2 GB, SameBoy (Red ×2, recorded trade) | ~600–720 fps; 1.4–1.65 ms CPU per frame (M1, under load) |
| 2 GBC, SameBoy (Crystal + Silver, recorded session) | ~500 fps; ~1.9 ms CPU per frame |
| 1 GBC, SameBoy (reference) | ~1,000 fps; ~0.95 ms |
| Recorded trade session replayed headless | 12,638 frames in 8.5 s, saves byte-identical to the live session |
| 2 peers, RTT 80 ± 15 ms, D = 6, max speed | 143.6 fps, 105/105 hashes equal, saves equal (peers and local session) |
| 2 peers, RTT 40 ± 10 ms, D = 5 | 234 fps, 25/25 hashes equal |
| Bandwidth (unbatched, u32 inputs + framing) | 1.4–2.8 KB/s per peer |
| Seamless: a running game's state (the snap) | GBA (mGBA) 528,448 B → 21–32 KB deflated; GB/GBC (SameBoy) 252,682 B (the libretro core pads its ~116 KB state to its maximum) → 28 KB; DS (melonDS) 19,744,141 B → 1.7 MB deflated (2.3 MB as base64 on the channel, ~190 parts) |
| Seamless: snapshot (pause, SAVE, deflate, SHA-1) | GBA 18–54 ms, GB 46–64 ms, DS ~200 ms |
| Seamless: "Linking…" – the picture stands still from the snapshot to the first linked picture (one Mac) | GB 89–122 ms, GBA 168–206 ms (4 players: 604 ms), DS 0.78–0.91 s: snapshot ~230 ms (SAVE of 19.7 MB + deflate), the 1.7 MB transfer ~150 ms each way as one binary transfer, the hosts' start ~170 ms, the first picture |
| Seamless over TURN (Cloudflare, RTT 36–39 ms) | GBA 336–360 ms, DS 1.41–2.0 s (the transfer 0.6–1.4 s) |
| Seamless: back alone – leave to the first solo picture (FLUSH, SEATSTATE, the fast player started with the state) | GB 61–80 ms, GBA 87–222 ms, DS 0.84–0.91 s |

### Shared World motion, before → after (20 Nov 2026)

`world-e2e.mjs --smooth --capture` (`--cross` for Red and Crystal), two players on one Mac, the overlays' trace of
every shown picture, `scripts/world-motion.mjs` relative to the map (the DS: world units; your own DS follower: on the
picture). B walks off after standing, stops, turns, taps and runs while A watches; A and B side by side; A alone with
the follower; Red and Crystal: A over a map edge. Counted over both players' pictures. "Stall": standing still inside a
walk, then a catch-up step; "jump": a step over 2 px at walking speed (more for running, a pixel more where the game
moves every other frame); "vanished": gone for up to 30 pictures, then back.

| Game | Sprite | Stall → catch-up | Jumps | Steps back | Vanished | Biggest step (px) |
|---|---|---|---|---|---|---|
| Emerald | your follower | 13 → 0 | 15 → 0 | 0 → 0 | 9 → 0 | 31 → 2 |
| Emerald | partner / their follower | 5 / 3 → 0 / 0 | 3 / 5 → 2 / 2 | 0 → 0 | 0 / 5 → 0 / 0 | 4 → 3 |
| Sapphire | your follower | 12 → 0 | 20 → 0 | 0 → 0 | 12 → 0 | 31 → 2 |
| Sapphire | partner / their follower | 2 / 2 → 0 / 0 | 1 / 0 → 2 / 3 | 0 → 1 / 0 | 0 / 7 → 0 / 0 | 3 → 4 |
| Platinum | your follower | 9 → 10 | 0 → 0 | 0 → 0 | 5 → 0 | 12 → 16 |
| Platinum | partner / their follower | 0 / 0 → 0 / 0 | 2 / 0 → 2 / 2 | 0 → 0 | 0 → 0 | 7 → 4 |
| HeartGold | partner / their follower | 3 / 0 → 0 / 0 | 7 / 4 → 0 / 0 | 0 → 0 | 0 / 4 → 0 / 0 | 8 → 3 |
| Red | your follower | 0 → 0 | 0 → 0 | 0 → 0 | 10 → 0 | 2 → 6 |
| Red | partner / their follower | 2 / 2 → 0 / 0 | 0 → 0 | 0 → 0 / 1 | 0 / 10 → 0 / 0 | 3 → 3 |
| Red | over the map edge: your follower | moving 5 pictures (put back on you) → 32, 0 faults | | | | |
| Crystal | your follower | 0 → 0 | 2 → 0 | 0 → 0 | 23 → 0 | 10 → 4 |
| Crystal | partner / their follower | 0 → 0 | 0 → 0 | 0 → 0 | 16 / 23 → 0 / 0 | 2 → 3 |

Partners also moved on animation frames without a new game picture before (Emerald 21, Sapphire 33, HeartGold 70,
Red 27, Crystal 46 per run) – after, 0–11 (pictures the page drew twice). The remaining 2–3 px steps are a partner
running (2 px a frame) on a picture of yours that came a frame late. Platinum ran at 43 % / 71 % speed in the "after"
run (the computer was busy with other work): the game itself then moved you 6–8 units per picture with pauses between,
and your follower's "stalls" and 16-unit step are exactly yours (it steps with you). Red's own-follower 6 px step is a
late picture on which the game's own camera moved 6 px too. The "after" clips (60 fps, the game's picture with the
overlay as shown, A and B walking side by side) were made by the same runs.

## 13. Plan and effort

Done in this round: one link host with all three backends (macOS built and tested, Windows cross-compiled, Linux in CI), touch, sound, the cartridge clock, rejoin by state transfer, resend, TURN (Worker + app), direct/relayed, desync safety, the partner's game by SHA-1 (pick / build), DS in the app, 3–4 player invites, the location sign, rules, tests (`test/link.test.mjs`, `test/linkhost.test.mjs`, `test/native.test.mjs` clock test) and the e2e harness for 2–4 players; the Shared World overlay for Gen 1, 2 and 3 (§9).

What is left for 3.0, with effort:

| Item | Effort |
|---|---|
| Run the Windows `linkhost.exe` on a real Windows PC (and a Windows ↔ Mac session: x64 ↔ arm64 determinism) | 1 d |
| First green `native.yml` run (Linux + Windows link host; the RGBDS step is new) | ½ d |
| Release packaging: `linkhost` + its licences in the app bundles (`npm run dist` checks it now), signing/notarising one more binary on macOS | ½–1 d |
| A real two-computer test over the internet, once with TURN forced (relayed) | ½ d |
| ~~Trade log entry for Gen 2 and Gen 4~~ (done: Gen 2 – two Pokémon of the recording's saves shared trainer ID and DVs, a Pokémon is now its key and species, counted; Gen 4 – the recordings' trade leaves a clone in the team, which the live reader took for a misread; clones are two Pokémon now, §7) | – |
| ~~B/W: a recorded trade + battle through the e2e~~ (done, Black ↔ Black, also seamless; the Gen 5 Union Room and Colosseum on the sign). ~~D/P~~: Diamond ↔ Pearl trade and battle recorded (§8a). ~~HG/SS, B ↔ B2, B ↔ W~~ (done 19 Nov: saves made by setting the C-Gear / the Union Room receptionists' flags in RAM or the save, then each game saved itself). Left: FR/LG recordings (FR ↔ LG, R ↔ S, G ↔ S, Blue ↔ Yellow link from the running games – nothing pressed); White 2 through the app (a W2 ↔ B2 recording; the saves exist), then its results, wager and sign on; Platinum ↔ Diamond/Pearl; FR/LG's link rooms on the sign | 2 d |
| Gen 5 4-player Union Room ("Battles for four", trades in pairs while two stand by – the room shows up to five) and a 4-player DS recording for Gen 5 | ½ d |
| The C-Gear's infrared (Gen 5 Trainer Card exchange, Entralink invites): melonDS's IR cartridge has no send/receive; the link host could carry IR bytes between seats in its MP layer | 2–3 d |
| Gen 1 ↔ 2 Time Capsule | 1 d |
| DS rejoin during a wireless exchange (the state can't be taken while a console waits mid-frame): retry until the exchange pauses, or make the wait state serialisable | 2–3 d |
| UX polish from real players: the need/pick bar, what happens to an invite while the partner is in a menu (seamless: the link simply starts there) | 1–2 d |
| Seamless DS start over slow uplinks: 1.7 MB deflated per DS state (0.8 s on one Mac, 1.4–2.0 s over TURN at 40 ms); a delta against a reference the receiver builds itself (the same game booted from the same save) would cut it further | 1–2 d |
| Seamless DS session started while both are already inside the Union Room alone (the fast player's firmware MAC is the same for every player – the games may need to leave and re-enter the room so their wireless reads the link host's per-seat MAC); a DS 3–4-player seamless run | 1 d |
| The souldew engine (§4b) as the default, then retrohost gone: a beta with real players (Windows x64 PCs incl. 96 kHz sound cards and weak laptops, Linux), the first `native.yml` run with melonDS's JIT in the link host, the play view and Settings no longer tied to the libretro cores (`nativeOn`, `status.native.ok`), then retrohost, the libretro cores and the old hand-over path (SEATSTATE → `/api/native/start` with a state) removed | – |
| Shared World for Diamond/Pearl and Gen 5 (§9), rollback, spectating | after 3.0 |

## 14. Decisions for the owner

Decided (November 2026): TURN approved (Cloudflare Realtime key "souldew-link" on the Worker); different games in one run: the player picks the partner's file from their library, checked by SHA-1; no third-party WFC servers; rule defaults: trades allowed, link-battle losses don't count; up to 4 players; the GBA wireless adapter is skipped for now.

Decided in this round (seamless link, §4a): the fast player's Game Boy core is **SameBoy** (the link host's emulator and version, MIT) instead of Gambatte – Gambatte's save states can't go into a link session; the GBA core is built from the **link host's mGBA commit** instead of the 0.10.5 release. Cost: save states made with the older Gambatte fast player can't be loaded any more – they stay, and say so ("made with the previous Game Boy emulator – your in-game saves are unaffected"); battery saves and the cartridge clock carry over. Owner's follow-up (approved): Game Boy games on the **original Game Boy** by default (Settings › "Game Boy look": Original / Game Boy Color colours), each link seat on its own player's console.

Open: none for this round. Worth deciding before release: whether runs created before 3.0 should get "Build every player's game" offered once (randomized GB/GBA runs joined earlier have only the joiner's own game), and whether DS JIT may be offered for sessions where every peer is the same architecture (faster for 4 players; needs the JIT build and a session option).

## 15. Raid

Built in November 2026 (branch `feat/30-raid`; `shared/raid.mjs`, `shared/live/raidhp.mjs` (Game Boy, GBA),
`shared/live/raidds.mjs` (DS), `web/lib/raid.mjs`, `web/views/raid.mjs`, `scripts/raid-e2e.mjs`).

**What it is.** The players of a run fight the same trainer together, each in their own game, and the trainer's
Pokémon share **one HP pool**. Without it each player would simply beat the trainer alone; with it the trainer is
beaten only when the combined pool is empty – in everybody's game at once.

**Flow.** The board's log has “Raid” (next to rock-paper-scissors): the host of the raid ticks the partners (only
online ones whose souldew announced raids and whose running game can take part – everybody else greyed out with the
reason) and starts it. The invite shows in the partner's play view (the raid panel, first in the dock) or as a card at
the bottom of the app: Join / Not now. Once everybody answered (or after 30 s) the raid starts with those who joined,
or is called off. A 10-second countdown, then the **next trainer battle each player starts** is the raid (a battle
already on when the raid started doesn't count). A game whose battle began first is held at its first menu (paused,
at most 45 s) until the others' battles have begun; a player whose battle comes later still joins.

**The pool** (`shared/raid.mjs`). Per opponent party slot, in basis points (integers – every computer must compute
exactly the same). A player's game reports what happens to the opponent's HP as events: damage or heal of
`bp = |ΔHP| / maxHP × 10000` on slot `i` (a knock-out empties the slot whatever the rounding left). Percentages make
randomized runs work, where the trainer has other Pokémon in every game. Each player's events live in their own doc
key `raid:<id>:<slot>` (one writer per key – nothing lost to last-writer-wins; the doc carries them reliably over
the direct link and the relay), each stamped with a **Lamport clock** (past every event the computer has seen). Every
computer folds all events in the same order – clock, then slot, then the player's own sequence – so every computer
computes the same pool from the same events, whatever order they arrived in; a late event is folded where its clock
puts it. Damage takes at most what is left (the MVP gets credit for that much); a heal (a potion, a draining move)
goes back in up to 100 % but never into an empty slot. Slots: as many as the biggest party any player's battle shows
(a randomizer that adds Pokémon). Won: every slot empty, with every player's battle known; lost: everybody out.

**Into the games** (`RaidPlayer`, `shared/live/raidhp.mjs`). Three times a second the play view reads the battle; the
pool goes into the game **only while it waits for the player's action** (`quiet`), and is read back: a write that
didn't hold is tried once more, then that player is out (“out of step”) and gets no more writes. The opponent that is
out never gets 0 HP from souldew: it keeps **1 HP**, and the player's next hit knocks it out – the game's own faint,
exp, the next Pokémon or the trainer's defeat. Opponents not out get their share in the party copy – 0 for one that
went down in another game, which the trainer then never sends out. Our own writes are never counted as hits.

| Gen | Game(s) | Battle HP / party HP | Quiet (waiting for the player) | HP bar | Checked live |
|---|---|---|---|---|---|
| 1 | Red, Blue (US/EU) | `wEnemyMonHP` / `wEnemyMons` (+1) | the battle menu's parameters (`wTopMenuItemY/X`, `wMaxMenuItem`) | tiles in `wTileMap` and its saved copy `wTileMapBackup` (DrawHPBar's tiles) – drawn at once; its colour follows at the game's next redraw | rival in Oak's lab: 2 and 3 games, the app e2e |
| 2 | Crystal (US) | `wEnemyMonHP` / `wOTPartyMons` (+0x22) | the battle menu's 2D menu, or the move menu with its “TYPE/” box | tiles in `wTilemap` (the saved copy is in WRAM bank 2, out of reach: souldew draws the bar again while the move menu waits) | a wild battle on Route 29 driven as a trainer's (lab, 2 games) |
| 3 | FireRed, LeafGreen (rev 0, 1), Emerald (US) | `gBattleMons[b].hp` / `gEnemyParty` (+0x56, outside the encrypted part) | `gBattleMainFunc` = HandleTurnActionSelectionState, the player's controller in HandleInputChooseAction/Move, the opponent's idle | the game's own **HP bar update**: `CONTROLLER_HEALTHBARUPDATE` in `gBattleBufferA` and the opponent's controller pointed at its handler – the bar slides from the party HP; the party HP only after it (FR/LG's first rival battle, until Oak's first lesson was shown: no bar command – it would start his lesson in the action menu; the bar then catches up with that game's next hit) | FireRed: rival in Oak's lab, 3 games, the app e2e; Emerald: lab, 2 games (bar command) |
| 4 | Platinum, HeartGold (US) | `BattleContext.battleMons[b].curHP` / the party Pokémon (+0x8E, PID-encrypted, no checksum) | battle command 5, the player's battler in a menu, no opponent command/queue/bar task | the game's own UpdateHPGauge command (queue entry, message, command byte) | Platinum vs Barry (lab, 2 games), HeartGold vs Bug Catcher Al (incl. a party member written to 30 % and 0) |
| 5 | Black 2 (US/EU) | the server's and the client's battle copies (both, only while they agree) | the input proc in the action/move menu, single battles only | the gauge's own “HP changed” request (damage + flag) | Hugh's first battle (lab, 2 games; an extra-Pokémon variant for the party copies) |
| 6/7 | X/Y, ORAS, Sun/Moon, US/UM | – | – | – | **not supported**: in souldew's 3DS host Hau's first battle never started in Sun (7 tries, three cores, old and new 3DS mode), so no write could be checked; the app says “Not in the 3DS games” |

Not supported (the app says “not in this version yet”): other languages and revisions without verified addresses,
Yellow, Gold/Silver, Ruby/Sapphire, Diamond/Pearl, SoulSilver, Black/White, White 2, hacks whose RAM moved. A Gen 3
revision whose code addresses souldew doesn't know never reads as waiting: it would get no writes, so it is excluded
by its memory table entry up front.

**Leaving, dropping out.** A player whose team is down, who leaves the battle or the raid, whose writes don't hold,
or who can't reach any raid partner for 30 s is out – their game is left as it is, no more writes. The others
finish; the out player watches the raid panel and the partner screens. A game that loses its host (another link,
a new start) answers no writes and drops out the same way.

**Rules** (host-signed, `shared/hostrules.mjs`): “Raids” (`raids`, on) and “Deaths in a raid count” (`raidDeaths`,
on – a raid is a real battle). Off: while the player's raid battle runs, the live team isn't applied to the run, and
a Pokémon that went down in it is taken as standing (1 HP on the board) until it's healed (`raidspared:<slot>`).

**Older builds.** Every 3.0 build with raids writes `raidcap:<slot>` (version, and whether the game playing now can
take part). A partner on an older 3.0 build never wrote one: no invite (“Tim's souldew doesn't know raids yet”).
Older builds ignore the `raid:` keys.

**The log, the stream.** Every computer that was in the raid writes the same entry, keyed by the raid
(`feed:raid-<id>`): “Sam, Tim & Kim won a raid together (1:38 · most damage: Tim)” / “… lost a raid”. The stream
API has a `raid` event (`docs/STREAM_API.md`).

**Exploits considered.** A tampered client can report hits it never made (the raid is then won early) – every
damage event is in the run with its player, and the MVP shows who dealt what; it can only write into its own game.
Writes happen only in a trainer battle that isn't a link battle, while the game waits.

**End to end** (`scripts/raid-e2e.mjs`: two or three souldew servers with scratch data folders, every page in
Electron, hidden and muted, the souldew engine; every game loads the same save state from just before the battle; A
starts the raid from the board, the others press Join, everybody walks into the battle, turns of hits; `--skins` adds
the raid panel in other colours). FireRed's first rival battle is Oak's lesson: until his “Inflicting damage…” text
was shown (`gBattleStruct->simulatedInputState[2]` bit 0) the bar command is left out and the bar follows with that
game's next hit – after it, the bar slides as everywhere else:

| Game | Players | Result |
|---|---|---|
| Red (US/EU), rival in Oak's lab | 2 | won in both games; every hit mirrored (pool and both games' HP: 20 → 15 → 11 → 8 → 5 → 2, then 1 HP and the last hit in the other game); one log entry on both computers; muted clips |
| FireRed (US), rival in Oak's lab | 3 | won in all three games; every hit mirrored into the other two (19 → … → 6 → 2 → 1/0); one log entry on all three |
| FireRed (US), rival in Oak's lab | 2 | won in both games (15 → 11 → 7 → 3 → 1/0); the raid panel checked in the default colours, the high-contrast theme and five souldew+ skins (Fieldbook, Sakura, Cartridge Grey – light; Paper Lantern, Midnight Ink – dark), fighting and with the result |

**Ideas not built.** A named boss (a gym leader or the Elite Four from the game's trainer table – `romcaps.mjs`
already finds them; the games of a pair run have different tables); raids in the Shared World A menu; a “Win a raid”
trophy (trophies are counted from run digests, which don't carry raids yet).

## 16. Play together

Built in November 2026 (branch `feat/30-together-mode`; `shared/playtogether.mjs`, `web/views/playtogether.mjs`,
`scripts/link-e2e.mjs --together`, `scripts/world-e2e.mjs --play-together`, `test/playtogether.test.mjs`).

**What it is.** A third run mode next to SoulLink and Nuzlocke, `mode: 'together'` – for players who just want to play
with friends: trade, battle, see each other in the Shared World, raid, give items, play rock-paper-scissors. Everything
multiplayer has, nothing of a challenge. It is a run like a SoulLink underneath (invite code, friends invites, the run's
peer channel and doc, the host's signed choices, the board, "Link all of us"), so every multiplayer part works unchanged.

**Decisions.**

| Question | Decision |
|---|---|
| Which save each player plays | **The library game's own battery save, directly** (option a). A Play together slot records the library entry it was built from (`outputs[slot].library` – the id the free play of that game uses, `<romId>` or `<romId>\|<patchId>`), and the server's run save path for that slot *is* the library save (`server/app.mjs defaultSavePath` → `librarySavePath`). One file, no copy that could drift: what is played together is there when the game is played alone, and the other way round. Every writer of a run save goes through that one path – the play view, the link session's write-back (seamless too, `/api/link/start` reads the local seat's save from it), the out-of-step restore (`/api/link/restore`: back to the pre-session bytes, `….link-<date>.sav` kept next to the save), a save import (backups in the library's backup folder). A run copy seeded from the library save and written back (option b) was rejected: two copies, and any write-back moment (on close, on desync, after a crash, with the game open solo at the same time) is a chance to lose progress. |
| Save states, "where you left off" | The library game's (`web/lib/run.mjs runStateId`): one set with the save. "Where you left off" is only resumed while the battery save on disk is the one it was taken with (play view `sl-auto-*`), so an older state can never roll newer progress back – after a session the library's state simply isn't offered. |
| What could still write a second copy | Refused or never done for a Play together: an intro save (`applyIntroSave`, it would replace the game's progress), an outside emulator (`/api/emulators/*/launch` → 409 `togetherBuiltIn`, it writes a save next to the run's ROM), a randomizer or shiny patch (forced off in `buildInto` – the run's ROM is the library ROM byte for byte, an APFS clone), and building any slot but this computer's own (`togetherOneSlot`: two slots here would share one library save). Deleting the run moves its folder to the trash; the game's save is untouched. |
| Different games per player | Any game of a system the link host runs (GB, GBC, GBA, DS; no 3DS – no link there yet). Each player announces theirs in the doc (`game:<slot>`, `gameInfo`). `linkWith(a, b)`: the same generation trades and battles (Gen 3: all five games; Gen 4: D/P/Pt/HG/SS; Gen 5: B/W/B2/W2); Gen 1 ↔ Gen 2 only trades in the Time Capsule and is marked untested; Gen 4 ↔ Gen 5 (both DS) can't; Shared World needs the same map family with Shared World support (Ruby ↔ Sapphire, FR ↔ LG, R/B/Y, G/S/C, HG ↔ SS). The board shows every pair; Trade/Battle/"Link all of us" are disabled with the reason, and an invite that still arrives (a stale page) is refused (`LinkSessions` `block` → `linkGen`, `linkTradeOnly`, `linkSystem`). A partner whose game isn't announced yet doesn't block – their app's own check answers. ROMs still never travel: for a trade each player needs the other's game in the library (said on the board; plain games are found by CRC, else "Pick your copy"). |
| Rules | The host's choices only (`TOGETHER_RULE_KEYS`: trades, battles, wagers and their cap, raids, gifts, cheats and which, type help). Everything a challenge counts is fixed off and wins over anything stored (`TOGETHER_FIXED`: no encounter linking, deaths, failing, level caps, type or dupes clause, lives, "first Poké Balls", link-battle or raid deaths). The tracker writes only the live team, badges and play time (`applyTogether`); a new badge is the one log line it adds besides trades, battles, raids, gifts and chat. `markDead`, `failRun` and `checks` do nothing in this mode. |
| Trophies, profile stats | None. Trophies are challenge achievements, and a Play together's badges and catches are the library game's (several runs may play the same game) – counting them would double them. `server/lib/trophies.mjs` skips the mode, so the account stats do too. |
| Partners on 2.8 | The run pack is `run-pack@5` with `minVersion 3.0.0`: 2.8.x refuses it with "This run needs souldew 3.0.0 or newer" (file) or "This run needs a newer souldew" (code). The host's invite says so. |
| Stream overlay | Teams, places, the feed and badges as usual; the alive/dead/caught counters are left out. The stream API reports `mode: "together"`. |
| "Playing now" (bot) and friend presence | Both services take the mode (commit 00df0c1, 19 Nov 2026): the "playing now" heartbeat reports a Play together game as `together` (`server/lib/presence.mjs` `MODES`; the bot's `MODES` and its totals by mode have it too), and friend presence, friend invites and recent runs send `together` to the accounts service (`shared/slots.mjs` `wireMode` = the run's mode; `server/lib/accounts` cleans `soullink` / `nuzlocke` / `together` both ways). The run's default name still ends in "– together"; a friend's presence line names the mode only as Nuzlocke or SoulLink (`web/views/social.mjs` `presenceText`), so a Play together shows as "SoulLink · Sam & Tim – together" there. |
| Entry points | The SoulLink section: "Play together" next to "Join with code" (and an intro card while there are no runs), a shelf "Playing together"; a game's page in the library: "Play together" next to New SoulLink / New Nuzlocke. The wizard has three short steps (game, players, choices); joining picks your own game and shows what it can do with the host's. |

**End to end** (19 November 2026, M-series Mac, scratch profiles, muted and hidden):

| Run | Result |
|---|---|
| `link-e2e --together`, Emerald ↔ Sapphire Cable Club trade (the recording's saves put into each player's *library* game) | ✅ the run read the library save before the session (`runSaveIsLibrarySave`), equal hashes, both saves as recorded, the library games' saves are the session's (`librarySaveHasSession`), the trade in the log on both computers; the board showed "Trades ✓ Battles ✓ See each other ✗" for the pair |
| `world-e2e --play-together`, Emerald ↔ Emerald in Oldale's Pokémon Center | ✅ partners drawn with followers, the A menu (Trade, Battle, Give item, rock-paper-scissors, emotes), Wave seen on the other side; the side column shows the team, no SoulLink pairs or run strip |

Not run: 3–4 players in one Play together, mixed generations in a real session (only refused by the unit tests), the
"Pick your copy" path between two different games, a Play together over two computers.

