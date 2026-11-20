# Multiplayer: DS backend (Gen 4/5 Union Room, Pokémon Center 2F)

This is the DS part of the link host (`native/link-host`, docs/MULTIPLAYER.md). It covers trades and battles over DS
local wireless in Diamond/Pearl/Platinum, HeartGold/SoulSilver, Black/White and Black 2/White 2. Code:
`native/link-host/backend_melonds.cpp`, which implements `struct link_backend` from `linkbackend.h`.

## How it works

- **No libretro.** The backend links melonDS's core library (`core` + `teakra`, the same melonDS fork that
  melonDS DS v1.4.0 builds) and supplies melonDS's `Platform::` layer itself.
  - Up to 4 `melonDS::NDS` instances run in one process.
  - Each console uses FreeBIOS and a generated firmware: no Nintendo files.
  - Per seat, the firmware gets its own MAC address (`02:50:4B:53:44:1x`) and nickname (`souldewN`). Two consoles
    with the same MAC can't talk to each other.
- **The local-wireless layer is deterministic.** melonDS's own `LocalMP` lets instances run freely on threads and
  blocks the Wi-Fi chip for up to 25 ms of *wall clock* while it waits for MP replies or host frames. That is fine on
  one computer and impossible to reproduce on two.
  - This backend keeps melonDS's MP protocol (`Platform::MP_*`, the same packets and types as LocalMP) but orders
    everything by the consoles' *emulated* clocks (`NDS::SysTimestamp`).
  - One thread per console, but only one runs at a time. A baton is passed at every MP call and at every frame end.
  - The console with the smallest virtual time runs next. Virtual time is its clock when it is ready, its timeout
    horizon (4 ms emulated) when it waits for a packet, and its frame end when it is done.
  - Packets carry the sender's clock. A receive only sees packets sent at or before the receiver's clock, or before
    the horizon when it is waiting.
  - So the same ROMs, saves, RTC start and per-frame inputs give bit-identical consoles on every peer. The shared
    host's input-delay lockstep, hash checks and save exchange work unchanged.
- **Save states** (`state_size` / `save_state`) only work while every console is at a frame end. A console waiting
  mid-frame for a packet lives on its thread's stack. `state_size` then returns 0, and the host must retry on a later
  frame (or between MP exchanges). Loading a state in the middle of a Union Room session drops the link, because the
  packet queues are not part of the state. Start link sessions from battery saves, as the design already does.

## In the app (feat/multiplayer, 2026-11-15)

- **One link host.** The backend is linked into the same `linkhost` as mGBA and SameBoy (`scripts/build-native.mjs`:
  melonDS fork commit `16f127d`, `core` + `teakra`, **no JIT**, no OpenGL, no GDB stub). The JIT is compiled out: every
  peer computes with the interpreter, also arm64 ↔ x64.
- **Touch.** The fast player's pointer (INPUT bytes 12–16) over the lower half of the 256 × 384 picture becomes
  link_input's touch bits; a tap lasts at least 4 frames (as retrohost holds it).
- **Clock.** `--rtc` is the session's start, chosen by the inviter and the same on every peer.
- **Session states.** A seat's state is melonDS's own plus the wireless layer's side of it: Wi-Fi on/off, the packets
  queued for it, the last buttons, the MP host. A state loads into a fresh host and goes on identically in the middle of
  a Union Room visit (25 / 25 hashes equal after loading at frame 12,001). It can still only be taken when every console
  is at its frame end – otherwise "not now", and a rejoin then fails ("state-busy").
- **Sound.** The local seat's SPU output (48 kHz) goes to the page.
- **e2e.** Platinum ↔ Platinum Union Room trade through the whole app (invite, saves, lockstep over the peer channel):
  both run saves equal to the recording's. The sign says "Union Room" (Platinum map 466).

## Verified (spike, Apple M1, 2026-11-15)

Two Platinum (US) saves were made with the host itself (players AAAAAA / BBB, Turtwig / Chimchar, saved in the
Sandgem Pokémon Center). With FreeBIOS and generated firmware:

| What | Result |
|---|---|
| Pokémon Center 2F, "DS Wireless Communications will be launched", Union Room | ✅ each player sees the other's avatar and the chat log |
| Greet (Trainer Card exchange) | ✅ each sees the other's card (IDs 47379 / 50953) |
| Trade | ✅ Turtwig ↔ Chimchar, the game's post-trade synced save, parties read back from RAM with the partner's OT ID |
| Union Room battle (2 vs 2, Lv 6) | ✅ played to the end, both sides show the same HP every turn |
| 4 consoles in one Union Room | ✅ each console sees the other three (two saves used twice, four MACs) |
| Network lockstep: 2 peers, each running both consoles, 80 ms RTT ± 10 ms jitter, delay 6 | ✅ a recorded 21,978-frame session (load save → Union Room → trade): **0 / 183 hash mismatches**; final saves equal between peers **and equal to the local session** |
| Same with JIT on both peers | ✅ 0 / 183 mismatches between the peers (JIT timing differs from the interpreter, so the interpreter recording plays out differently; peers must agree on JIT on/off) |
| Black, White 2, Pearl | boot with FreeBIOS and generated firmware, 3D renders; their Union Rooms were not reached in the spike (Black's since: below) |

## Gen 5 (Black, 19 Nov 2026)

Two Black (US) saves made with the link host and the ROM matrix's plan: Tepig and a Route 1 catch each, saved upstairs
in Accumula Town's Pokémon Center in front of the Union Room counter. The Union Room only opens with the C-Gear
(`FE_CGEAR_GET`, event flag 115 – 106 in Black 2/White 2; FlagsEditorEXPlugin's flag list, "Trading Functionality
Enabled" in PKHeX), which the game gives after the first gym; for the test saves the flag was set in RAM in the save
data's event block and the game then saved itself (no other change).

| What | Result |
|---|---|
| Upper floor, left counter "Pokémon Wireless Club Union Room", the first visit's explanation, saving, entering | ✅ both consoles in zone 422, each sees the other |
| Talk → Greet / Battle / Trade / Draw / Spin | ✅ |
| Trade (Gen 5's offer screen: up to three each, pick one of the other's) | ✅ Lillipup ↔ Patrat, both games save after it; the recording replays to byte-identical saves |
| Trainer card exchange | ✅ |
| Battle → "Battles for two" → single, no restrictions | ✅ both warp to the Colosseum (zone 150); the battle starts once each stands on their mark (the host the right one, the guest the left one, row 5), team picked on the touch screen; two battles, the same winner – the Union Room's records count them (12/13/14) |
| C-Gear IR (trainer cards, the IR feature of the C-Gear) | ❌ not in melonDS: its IR cartridge (`NDSCart/CartRetailIR.cpp`, irversion 2 for HG/SS and B/W/B2/W2) answers only the ID command and passes SRAM access through – sending and receiving over IR return nothing, so two consoles never see each other over IR. The C-Gear's wireless (the same local wireless as the Union Room) is what links |

Numbers (frames per second for the whole session, 60 = real time):

| Setup | Interpreter | JIT |
|---|---|---|
| 1 console, Platinum intro | 366 | – |
| 2 consoles, intro | 196–246 | 326 |
| 4 consoles, intro | 119 | 164 |
| 2 consoles, recorded Union Room session (1 process) | 223 (3.7×) | 270 (4.5×) |
| 2 consoles idling in the Union Room, wireless on | 167 | – |
| 4 consoles in the Union Room, wireless on | 97 (1.6×) | – |
| Net test, 2 peers on one Mac (= 4 consoles on the machine) | 134 | 142 |

Scheduler cost: 2.49 M yields and 160 k baton switches in 21,978 frames, about 7 thread switches per frame on average.
They are concentrated in Union Room exchanges, which use 8 µs Wi-Fi timer ticks.

Traffic: one 12-byte input message per frame per peer. That is about 0.7 KB/s at real time, plus framing, so the
DS adds nothing over GBA link sessions.

## Integration notes for the shared link host

- **Backend list.** Add `extern const struct link_backend link_backend_melonds;` to linkhost.c's `backends[]`.
  - `probe` checks the DS header logo CRC (0xCF56).
  - `fps()` = 33513982 / 560190 ≈ 59.83.
- **Input.** `link_input` is already DS-ready: X/Y in bits 10–11, touch in bits 12/16–31.
  - linkhost's `INPUT` (retro joypad bits) needs a touch field. The spike passed bits 12–31 through as-is.
  - Platinum needs touch in the intro (the Poké Ball button), and battles and party menus are touch-first.
- **Build.** cmake melonDS (the melonds-ds fork pinned by melonDS DS v1.4.0: `JesseTG/melonDS@jtg/fix-uninitialized-opengl`)
  with `-DBUILD_QT_SDL=OFF -DENABLE_OGLRENDERER=OFF -DENABLE_GDBSTUB=OFF -DENABLE_JIT=ON`, target `core`.
  - Compile `backend_melonds.cpp` with `-std=c++17 -DJIT_ENABLED -I<melonDS>/src -I<build>/src`.
  - Link `libcore.a libteakra.a` with `c++` (+ `-framework CoreFoundation` on macOS).
  - The binary is about 3.7 MB, and no enet or slirp is needed.
  - Every peer must run the same melonDS commit and the same JIT setting.
- **JIT.** Not in the link host (the spike's `SOULDEW_DS_JIT` / `_DEBUG` / `_STATS` switches are gone). A JIT session
  would have to be a real option every peer agrees on, and only between peers of the same architecture.
  - JIT across CPU architectures (arm64 Mac ↔ x64 Windows) is **untested**. Default to the interpreter for mixed
    sessions until a cross-arch net test passes.
- **RTC.** `--rtc` must be the shared session epoch. With the default (`time(NULL)`), two runs differ.
- **Live tracking.** `mem()` maps main RAM (0x02000000–0x023FFFFF), so souldew's Gen 4/5 RAM readers work on the
  local seat as they do in retrohost.
- **4 players.** Seats 0–3 are supported (`LINK_MAX_SEATS`).
  - The Union Room shows every console, and the scheduler is N-way.
  - CPU cost is linear: 4 interpreted consoles ran at 1.6× real time on an M1, so 4-player sessions fit on mid-range
    machines.
  - Over the network, each peer sends its own seat's inputs to all others. That is the host's existing scheme;
    nothing DS-specific.

## Alternatives considered

- **melonDS DS's own netpacket support.** The v1.4.0 libretro core implements `RETRO_ENVIRONMENT_SET_NETPACKET_INTERFACE`
  (`src/libretro/net/mp.cpp`), which RetroArch netplay uses.
  - Packets are relayed in real time (unreliable, unsequenced), with 25 ms `clock()` timeouts.
  - The core itself warns that it does not work over VPNs or tunnels. Good on a LAN, not lockstep, not over the
    internet.
- **Upstream melonDS LAN** (ENet, UDP 7063/7064, local network only) and **Netplay** (unfinished, many TODOs): the
  same real-time limits.
- **Online (GTS, Wi-Fi Club) through a Nintendo WFC replacement.** Researched 2026-11-15 from secondary sources:
  wiimmfi.de refuses automated fetches, so Wiimmfi's own rules are unverified.
  - **Kaeru WFC** (DNS `178.62.43.212`, [kaeru.world](https://kaeru.world/projects/wfc)) proxies Wiimmfi
    authentication. It needs no ROM patch, because it exploits the DS's "nds-constraint" SSL bug.
  - **Poké Classic Network** ([pkmnclassic.net](https://pkmnclassic.net/)) serves the Gen 4/5 GTS, Battle Videos and
    Battle Tower/Subway. Wi-Fi Club trades and battles run through Wiimmfi.
  - **Not working:** Game Sync / Dream World / Global Link, ranked battles, and BW Random Matchup
    ([Poképédia](https://www.pokepedia.fr/Wiimmfi)).
  - **Self-hosting is not an option.** PKCN's server code is "all rights reserved", for private use only. The
    open-source [dwc_network_server_emulator](https://github.com/barronwaffles/dwc_network_server_emulator) (AGPL-3.0,
    Python 2.7) is dormant.
  - **Emulator use** reportedly works (melonDS has a built-in access point). The services' emulator and bundling
    rules are unverified: ask Wiimmfi and Kaeru before shipping a default DNS.
  - **Every user would share melonDS's default MAC** unless souldew randomises it per install. Bans are per
    identifier.
  - **The core needs network mode.** souldew's retrohost sets `melonds_network_mode=disabled`. An opt-in would turn
    on indirect (libslirp) mode for that session only.
  - It is not a substitute for partner-to-partner trades in a SoulLink: it is a different feature (the GTS, strangers).
