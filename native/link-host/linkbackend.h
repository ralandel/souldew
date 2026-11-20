// The link host's backend interface: one implementation per system family; the engine around it (seats.c, session.c,
// avout.c, linkhost.c – seat management, input-delay lockstep, picture and sound, the frame loop) is shared. See
// docs/MULTIPLAYER.md › "Backends" and "The souldew engine".
//
// A backend runs ALL seats of a link session in this process, joined by the system's link (GB/GBC serial cable,
// GBA SIO, DS local wireless, …), and must be deterministic: the same ROMs, saves, start time and per-frame inputs give
// bit-identical consoles on every peer. No threads that race the emulation, no wall clock, no uninitialised memory.
//
// Backends today: backend_sameboy.c (Game Boy / Game Boy Color serial link, on SameBoy – the first choice for GB/GBC),
// backend_mgba.c (Game Boy Advance SIO, and GB/GBC as a fallback, on libmgba), backend_melonds.cpp (Nintendo DS local
// wireless between N melonDS instances with a deterministic MP layer). 3DS later.
#ifndef LINKBACKEND_H
#define LINKBACKEND_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#define LINK_MAX_SEATS 4

/**
 * One seat's input for one frame, the same 32 bits on every system and on the wire:
 *   bits 0–9   A, B, Select, Start, Right, Left, Up, Down, R, L   (the GBA's KEYINPUT order; GB uses bits 0–7)
 *   bits 10–11 X, Y (DS)
 *   bit  12    touch pressed (DS)    bits 16–23 touch x (0–255)    bits 24–31 touch y (0–191)
 */
typedef uint32_t link_input;
#define LINK_KEY_A (1u << 0)
#define LINK_KEY_B (1u << 1)
#define LINK_KEY_SELECT (1u << 2)
#define LINK_KEY_START (1u << 3)
#define LINK_KEY_RIGHT (1u << 4)
#define LINK_KEY_LEFT (1u << 5)
#define LINK_KEY_UP (1u << 6)
#define LINK_KEY_DOWN (1u << 7)
#define LINK_KEY_R (1u << 8)
#define LINK_KEY_L (1u << 9)
#define LINK_KEY_X (1u << 10)
#define LINK_KEY_Y (1u << 11)
#define LINK_TOUCH (1u << 12)

struct link_seat_config {
  const char *rom;         // path of this seat's game (the partner's rebuilt locally, checked by SHA-1 by souldew)
  const uint8_t *save;     // battery save bytes or NULL (a new cartridge)
  size_t save_len;
  const uint8_t *state;    // the player's running game as the fast player's core saves it (export_state's format), or NULL
  size_t state_len;
  const char *model;       // Game Boy family: "dmg" (the original Game Boy) or "cgb" (Game Boy Color, the default); NULL
};

/** How a set of seats starts (open). */
struct link_open {
  int n;                                // seats (1 … LINK_MAX_SEATS)
  const struct link_seat_config *seats;
  int64_t rtc_ms;                       // link session: the shared start of every cartridge / console clock (Unix ms)
  /**
   * One player's game alone (the souldew engine's solo mode): set up as the fast player has it – the clocks follow the
   * computer's, the DS runs its JIT, the GBC boots with the fast boot ROM – and save states in the fast player's format.
   * Nothing there must match another computer; a link session opens the seats again (solo false) from their states.
   */
  bool solo;
};

struct link_backend {
  const char *name; // "mgba"
  /** After open: "gba" | "gb" | "nds" … */
  const char *(*system)(void);
  /** Can this backend run `rom`? (by file contents / header) */
  bool (*probe)(const char *rom);
  /**
   * Start the seats (joined by the link when there are two or more). In a link session the clocks then advance with
   * emulated time only. Returns false (and logs why) when it can't – close() then cleans up what was started.
   */
  bool (*open)(const struct link_open *o);
  /** Every seat gone; open may come again (the engine's seat set is re-formed in place: solo ⇄ link). */
  void (*close)(void);
  /** The inputs of every seat for the next frame. */
  void (*set_input)(int seat, link_input in);
  /** Run one session frame: every console starts exactly one more frame (consoles may run ahead inside it). */
  void (*run_frame)(void);
  /** The seat's current picture as 0x00BBGGRR pixels, `*w` × `*h`, row length `*stride` pixels. */
  void (*video)(int seat, const uint32_t **px, unsigned *w, unsigned *h, unsigned *stride);
  /** The frame rate of the system (frames per second). */
  double (*fps)(void);
  /** The seat's battery save (malloc'd copy, caller frees); returns its size. */
  size_t (*sram)(int seat, void **out);
  /** A hash of everything that must be equal on every peer (RAM, CPU registers, clocks) of every seat. */
  uint64_t (*hash)(uint64_t h);
  /** Bus access for the live reader, cheats and READ / POKE (tests). */
  uint8_t *(*mem)(int seat, uint32_t addr, uint32_t len);
  uint8_t (*read8)(int seat, uint32_t addr);
  void (*write8)(int seat, uint32_t addr, uint8_t v);
  /** Whole-session save states (every seat and the link between them): rejoin / desync recovery. */
  size_t (*state_size)(int seat);
  bool (*save_state)(int seat, void *out);
  bool (*load_state)(int seat, const void *in, size_t len);
  /**
   * Sound: the output rate (stereo frames per second; 0 = silent) and the seat's sound since the last call – up to
   * `max` interleaved stereo s16 frames into `out`, returns how many. Every seat makes its sound the same way on every
   * peer (it must not change what the consoles compute); souldew plays only the local seat's.
   */
  double (*sample_rate)(void);
  size_t (*audio)(int seat, int16_t *out, size_t max);
  /**
   * Optional: the battery save as souldew keeps it on disk, when that is more than `sram` (a Game Boy clock cartridge:
   * the save memory + the 48-byte clock footer). `sram` stays what tells whether the game saved.
   */
  size_t (*battery)(int seat, void **out);
  /**
   * The seat's console as the fast player's core (native/retro-host on the libretro core of the same emulator, the same
   * version) saves it – a save-state slot while playing alone, and the console a link session hands back to its player
   * (docs/MULTIPLAYER.md › "Seamless"). malloc'd, caller frees; 0 = not now (a DS console waiting mid-frame for a
   * wireless packet).
   */
  size_t (*export_state)(int seat, void **out);
  /** A state in that format into the running seat (a save-state slot loaded while playing alone). */
  bool (*import_state)(int seat, const void *in, size_t len);
  /**
   * Optional (the DS): the 3D depth of the seat's frame on screen, for Shared World (native/common/depth.h) – `on` 0
   * stops keeping it; else a rectangle of 24-bit depths, returns 1 (| 2 W-buffered), 0 nothing kept yet, -1 none.
   */
  int (*depth)(int seat, int on, int x, int y, int w, int h, uint32_t *out);
};

extern const struct link_backend link_backend_mgba;
extern const struct link_backend link_backend_sameboy;
extern const struct link_backend link_backend_melonds;

#endif
