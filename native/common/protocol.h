// The message numbers souldew and its native hosts (native/retro-host, native/link-host) agree on. Messages are
// { u32 type, u32 length, payload } (little-endian) in both directions over stdin / stdout. shared/link.mjs and
// server/lib/native.mjs mirror these numbers for the JavaScript side – change them together.
#ifndef SOULDEW_PROTOCOL_H
#define SOULDEW_PROTOCOL_H

// ---- host → souldew --------------------------------------------------------------------------------------------------
enum host_msg {
  MSG_VIDEO = 2,     // u16 width, u16 height, u32 format (0 XRGB8888 = BGRA bytes, 2 RGB565), packed pixels
  MSG_AUDIO = 3,     // interleaved stereo s16 at the loaded event's sampleRate (fast-forward: sped up, see ffaudio.h)
  MSG_STATE = 5,     // a save state (answer to SAVE; empty: not possible now)
  MSG_LOG = 6,       // text
  MSG_EVENT = 7,     // json { event: … }
  MSG_RAM = 8,       // u32 count, count × { u32 addr, u32 len, bytes } – what changed in the --ram regions (ramstream.h)
  MSG_SRAM = 9,      // the battery save, whole, once the game saved and it settled (and on FLUSH / QUIT)
  MSG_MEM = 11,      // link host: u32 seat, u32 addr, bytes (answer to READ, tests)
  MSG_LINPUT = 12,   // link host: u32 seat, u32 first frame, u32 inputs[] – the local seat's buttons for the peers
  MSG_SEATSRAM = 14, // link host: u32 seat, bytes – every seat's battery save (on FLUSH in a link session)
  MSG_SEATSTATE = 15, // link host: u32 seat, bytes – the local seat's console in the fast player's state format
  MSG_WATCHED = 16,  // u32 frame, the WATCH ranges' bytes – right before each VIDEO
  MSG_DEPTH = 17,    // u32 frame, i32 flags (1 | 2 W-buffered), per DEPTH rectangle { s16 x, s16 y, u16 w, u16 h, u32 depth[w×h] row
                     // by row } – right before WATCHED
};

// ---- souldew → host --------------------------------------------------------------------------------------------------
enum host_cmd_type {
  CMD_INPUT = 1,   // u32 joypad bits (RETRO_DEVICE_ID_JOYPAD_*), s16 lx, ly, rx, ry, s16 px, py (pointer over the whole
                   // picture, -0x7fff…0x7fff), u8 pressed – 17 bytes
  CMD_SPEED = 2,   // f32: 1 = normal, 0 = paused, ≥ 100 = as fast as possible
  CMD_SAVE = 3,    // → STATE
  CMD_LOAD = 4,    // state bytes → event stateLoaded
  CMD_QUIT = 6,
  CMD_RESET = 7,   // the console starts over (its battery save kept)
  CMD_WRITE = 9,   // u32 addr, bytes – a cheat, written between two frames into a --ram region → event written
  CMD_FLUSH = 10,  // send the battery save now
  CMD_SRAM = 11,   // bytes: this battery save instead, then the game starts over (the save souldew had, given late)
  CMD_RESYNC = 12, // all of the RAM with the next RAM message
  CMD_STEP = 13,   // u32 n: run exactly n frames, then pause → event stepped
  CMD_WATCH = 14,  // u32 count (≤ 16), count × { u32 addr, u32 len } (≤ 512 bytes in all; 0 = off) → WATCHED
  CMD_DEPTH = 15,  // u32 count (≤ 8), count × { s16 x, s16 y, u16 w, u16 h } (≤ 16384 pixels; 0 = off) → DEPTH (the DS's 3D)
  // link sessions (native/link-host)
  CMD_VIEW = 20,      // u32 seat – whose picture comes out (tests, spectating)
  CMD_RINPUT = 21,    // u32 seat, u32 first frame, u32 inputs[] – a peer's buttons
  CMD_READ = 22,      // u32 seat, u32 addr, u32 len → MEM (tests)
  CMD_POKE = 23,      // u32 seat, u32 addr, bytes (tests)
  CMD_UNTIL = 24,     // u32 frame: run until the session reaches it, then pause
  CMD_NEED = 25,      // u32 seat, u32 from – a peer missed buttons: send what this host knows as LINPUT
  CMD_SEATSTATE = 26, // u32 settle → SEATSTATE (the local seat for the fast player once a session is over)
  // the souldew engine: one link host plays a game alone and links it in place (only the server sends these)
  CMD_LINK = 27,      // the link session's arguments (NUL-separated, as on the command line): partners join this game
  CMD_SOLO = 28,      // optional arguments (--rom --sram --state --model): the session is over, this game goes on alone
};

#endif
