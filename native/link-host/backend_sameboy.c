// Link backend on SameBoy (MIT, https://github.com/LIJI32/SameBoy): two Game Boy / Game Boy Color seats joined by an
// emulated link cable – Gen 1/2 Cable Club trades and battles (Red/Blue/Yellow ↔ each other, Gold/Silver/Crystal ↔ each
// other, and the Time Capsule between them).
//
// The cable is SameBoy's bit-level serial interface, as its own two-console mode wires it: whenever a console that
// drives the clock (SC bit 0 = internal clock) shifts a bit out, `bit_start` keeps it; when the bit ends, `bit_end`
// takes the partner's outgoing bit (GB_serial_get_data_bit) as the master's incoming bit and shifts the master's bit
// into the partner (GB_serial_set_data_bit) – the partner's SB/SC then behave as on an externally clocked Game Boy,
// interrupt included. Either side may be master (Pokémon decides that at run time); a lone console sees 0xFF.
//
// Both consoles run in this thread, interleaved instruction by instruction: the one that is behind in emulated time
// runs next (ties: seat 0), so they are never more than one instruction apart – what a real cable gives, and
// deterministic by construction. Seat 1's clock is 61 ppm fast, as no two real crystals match (see s_run_frame). A session frame is a fixed slice of emulated time (one LCD frame, 70224 clocks at
// 4.19 MHz), not "until vblank": a console with the LCD off or in STOP can't hold the session up, and both consoles
// take their buttons at the same emulated instant on every peer. The picture is the console's last finished frame.
//
// Determinism: no wall clock anywhere – the core's time() is redirected (a header included before each core file, see
// scripts/build-native.mjs) to the session's start time plus emulated seconds, the RTC (MBC3: Gold/Silver/Crystal) runs
// on emulated cycles (GB_RTC_MODE_ACCURATE), power-on RAM is filled from a fixed seed per seat, no threads.
//
// Alone (the souldew engine's solo seat, link_open.solo) a console is set up as the fast player's SameBoy: the cartridge
// clock follows the computer's, the Game Boy Color boots with the fast boot ROM; its states are that core's.
#include "linkbackend.h"
#include "../common/hostio.h"

#include <Core/gb.h>
#include <Core/random.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

// the boot ROMs (SameBoy's own, MIT – built from its BootROMs/ with RGBDS, embedded by scripts/build-native.mjs)
// (cgb_fast: the Game Boy Color's boot ROM without the logo animation – the fast player's, for a game played alone)
extern const unsigned char sbl_cgb_boot[], sbl_cgb_fast_boot[], sbl_dmg_boot[];
extern const unsigned sbl_cgb_boot_length, sbl_cgb_fast_boot_length, sbl_dmg_boot_length;

#define FRAME_TICKS (70224 * 2) // one LCD frame in GB_run's 8 MHz ticks (also in double speed: real time)
#define CLOCK 4194304.0

static int nseats;
static bool solo;           // one player's game alone: the computer's clock and the fast boot ROM, as the fast player
static int64_t epoch_s;     // the session's shared start (Unix seconds)
static uint64_t session_tick; // emulated time of the session (8 MHz ticks), drives sbl_time()
static struct sseat {
  GB_gameboy_t *gb;
  int index;
  uint64_t ticks;          // emulated time this console ran (8 MHz ticks)
  bool bit_out;            // the bit this console (as master) is shifting out
  uint32_t back[160 * 144];  // SameBoy draws here…
  uint32_t front[160 * 144]; // …and every finished frame is copied here (no half-drawn pictures)
  size_t ram_size;         // battery RAM size (the save souldew keeps: the RAM, then a clock cartridge's footer)
  bool has_rtc;
  bool vblank;             // a frame ended (solo frames run vblank to vblank)
} seats[2];

/**
 * The core's clock. In a link session: the session's start time + emulated time – the same on every peer, never the
 * wall clock. Alone: the computer's (the cartridge clock follows it, as with the fast player's SameBoy).
 */
time_t sbl_time(time_t *t) {
  if (solo) return time(t);
  time_t v = (time_t)(epoch_s + (int64_t)(session_tick / (uint64_t)(CLOCK * 2)));
  if (t) *t = v;
  return v;
}

static void on_log(GB_gameboy_t *gb, const char *s, GB_log_attributes_t a) { (void)gb, (void)s, (void)a; } // (stdout is the protocol)
static void on_boot(GB_gameboy_t *gb, GB_boot_rom_t type) {
  // a seat is an original Game Boy (DMG-B) or a Game Boy Color (CGB-E: Game Boy games get its palettes, as on hardware)
  if (type == GB_BOOT_ROM_DMG || type == GB_BOOT_ROM_DMG_0) GB_load_boot_rom_from_buffer(gb, sbl_dmg_boot, sbl_dmg_boot_length);
  else if (solo) GB_load_boot_rom_from_buffer(gb, sbl_cgb_fast_boot, sbl_cgb_fast_boot_length);
  else GB_load_boot_rom_from_buffer(gb, sbl_cgb_boot, sbl_cgb_boot_length);
}
static uint32_t on_rgb(GB_gameboy_t *gb, uint8_t r, uint8_t g, uint8_t b) { (void)gb; return (uint32_t)r | (uint32_t)g << 8 | (uint32_t)b << 16; }
static void on_vblank(GB_gameboy_t *gb, GB_vblank_type_t type) {
  struct sseat *s = GB_get_user_data(gb);
  s->vblank = true;
  if (type == GB_VBLANK_TYPE_REPEAT) return; // (the screen keeps the previous frame)
  memcpy(s->front, s->back, sizeof s->front);
}

// the cable
static void bit_start(GB_gameboy_t *gb, bool bit) { ((struct sseat *)GB_get_user_data(gb))->bit_out = bit; }
static bool bit_end(GB_gameboy_t *gb) {
  struct sseat *s = GB_get_user_data(gb);
  if (nseats < 2) return true; // nothing plugged in: the line idles high
  GB_gameboy_t *other = seats[1 - s->index].gb;
  bool in = GB_serial_get_data_bit(other);
  GB_serial_set_data_bit(other, s->bit_out);
  return in;
}

static const char *s_system(void) { return "gb"; }

/** A Game Boy / Game Boy Color cartridge: the logo's first bytes at 0x104 and a sane size. */
static bool s_probe(const char *rom) {
  FILE *f = host_fopen(rom, "rb");
  if (!f) return false;
  uint8_t h[0x150];
  size_t n = fread(h, 1, sizeof h, f);
  fseek(f, 0, SEEK_END);
  long len = ftell(f);
  fclose(f);
  static const uint8_t logo[8] = {0xCE, 0xED, 0x66, 0x66, 0xCC, 0x0D, 0x00, 0x0B};
  return n == sizeof h && len >= 0x8000 && len <= 8 * 1024 * 1024 && !memcmp(h + 0x104, logo, sizeof logo);
}

/**
 * An RTC cartridge's save without the clock behind it (older souldew saves: the battery RAM only) gets
 * a clock that starts at day 0, 00:00:00 now – SameBoy would otherwise flag a reset clock and the game would ask for
 * the time. A save with a clock footer (VBA-M/SameBoy layout) keeps its own and catches up to the session's start.
 */
static uint8_t *with_clock(struct sseat *st, const uint8_t *save, size_t len, size_t *out_len) {
  const size_t foot = 48; // VBA-M 64-bit: 5 + 5 × u32 registers (real, latched), u64 Unix seconds
  uint8_t *b = calloc(1, st->ram_size + foot);
  if (!b) return NULL;
  memset(b, 0xFF, st->ram_size);
  if (save) memcpy(b, save, len < st->ram_size ? len : st->ram_size);
  if (save && len > st->ram_size) { // a footer of its own: as it is
    uint8_t *c = realloc(b, len);
    if (!c) { free(b); return NULL; }
    memcpy(c, save, len);
    *out_len = len;
    return c;
  }
  uint64_t t = (uint64_t)epoch_s;
  for (int i = 0; i < 8; i++) b[st->ram_size + 40 + i] = (uint8_t)(t >> (8 * i));
  *out_len = st->ram_size + foot;
  return b;
}

#define SAMPLE_RATE 48000
#define AUDIO_RING 8192 // stereo frames (a frame is ~800; more than that waits only while nobody reads – then it drops)
static struct { int16_t s[AUDIO_RING * 2]; uint32_t w, r; } audio_ring[2];
static void on_sample(GB_gameboy_t *gb, GB_sample_t *sample) {
  struct sseat *st = GB_get_user_data(gb);
  typeof(audio_ring[0]) *a = &audio_ring[st->index];
  if (a->w - a->r >= AUDIO_RING) return; // full: drop
  a->s[(a->w % AUDIO_RING) * 2] = sample->left, a->s[(a->w % AUDIO_RING) * 2 + 1] = sample->right;
  a->w++;
}
static double s_sample_rate(void) { return SAMPLE_RATE; }
/** A clock cartridge's save as souldew keeps it: the battery RAM + the 48-byte VBA-M clock footer (its time: the
 *  session clock, sbl_time) – retrohost reads that footer back into the fast player's clock (SameBoy's libretro core). */
static size_t s_battery(int seat, void **out) {
  struct sseat *st = &seats[seat];
  *out = NULL;
  if (!st->has_rtc) return 0;
  const int n = GB_save_battery_size(st->gb);
  if (n <= 0 || (size_t)n != st->ram_size + 48 || !(*out = malloc((size_t)n))) return 0;
  if (GB_save_battery_to_buffer(st->gb, *out, (size_t)n)) { free(*out); *out = NULL; return 0; }
  return (size_t)n;
}
static size_t s_audio(int seat, int16_t *out, size_t max) {
  typeof(audio_ring[0]) *a = &audio_ring[seat];
  size_t n = 0;
  while (n < max && a->r != a->w) {
    out[n * 2] = a->s[(a->r % AUDIO_RING) * 2], out[n * 2 + 1] = a->s[(a->r % AUDIO_RING) * 2 + 1];
    a->r++, n++;
  }
  return n;
}

/** A clock cartridge's save with its footer: what the clock read when it was saved (the log line the fast player has too). */
static void log_clock(const uint8_t *foot) {
  uint32_t v[5];
  uint64_t saved;
  memcpy(v, foot, sizeof v);
  memcpy(&saved, foot + 40, 8);
  if (saved < 852076800ull) return; // (no real clock data)
  const uint64_t days = (v[3] & 0xff) | (uint64_t)(v[4] & 1) << 8;
  host_log("cartridge clock from the save: %llu days %02u:%02u", (unsigned long long)days, v[2] % 24, v[1] % 60);
}

/** A state of SameBoy (its libretro core pads its own to the biggest model's size: only this model's part is read). */
static bool load_state(GB_gameboy_t *gb, const uint8_t *in, size_t len) {
  const size_t own = GB_get_save_state_size(gb);
  return !GB_load_state_from_buffer(gb, in, len > own ? own : len);
}

static bool s_open(const struct link_open *o) {
  if (o->n > 2) { host_log("a Game Boy link cable joins two consoles"); return false; }
  nseats = o->n;
  solo = o->solo;
  epoch_s = solo ? (int64_t)time(NULL) : o->rtc_ms / 1000;
  session_tick = 0;
  for (int s = 0; s < o->n; s++) {
    const struct link_seat_config *cfg = &o->seats[s];
    struct sseat *st = &seats[s];
    memset(st, 0, sizeof *st);
    st->index = s;
    size_t rl = 0;
    uint8_t *rom = host_read_file(cfg->rom, &rl);
    if (!rom) { host_log("seat %d: the game can't be read", s); return false; }
    const bool dmg = cfg->model && !strcmp(cfg->model, "dmg"); // (the seat's player's console – the same on every peer)
    st->gb = GB_init(GB_alloc(), dmg ? GB_MODEL_DMG_B : GB_MODEL_CGB_E);
    GB_gameboy_t *gb = st->gb;
    GB_set_user_data(gb, st);
    GB_set_log_callback(gb, on_log);
    GB_set_input_callback(gb, NULL); // (SameBoy's debugger would read stdin – the protocol's; it isn't built, but still)
    GB_set_async_input_callback(gb, NULL);
    GB_set_boot_rom_load_callback(gb, on_boot);
    GB_set_border_mode(gb, GB_BORDER_NEVER);
    GB_set_rgb_encode_callback(gb, on_rgb);
    // (the picture only, as the fast player's SameBoy shows it: GBC colour correction, the original Game Boy's green)
    GB_set_color_correction_mode(gb, GB_COLOR_CORRECTION_MODERN_BALANCED);
    if (dmg) GB_set_palette(gb, &GB_PALETTE_DMG);
    GB_set_pixels_output(gb, st->back);
    GB_set_vblank_callback(gb, on_vblank);
    // sound: every seat alike (only the local seat's is played); the rate only shapes the output, not the emulation
    GB_set_sample_rate(gb, SAMPLE_RATE);
    GB_apu_set_sample_callback(gb, on_sample);
    // the cartridge clock: emulated cycles in a link session; alone, the computer's clock (the fast player's
    // "sync to system clock" – it catches up with the time the game was closed)
    GB_set_rtc_mode(gb, solo ? GB_RTC_MODE_SYNC_TO_HOST : GB_RTC_MODE_ACCURATE);
    // (button bounce: SameBoy's default, as the fast player's core has it, alone – it moves when a press lands and so the
    // games' random numbers; link seats keep it off, as they always had)
    GB_set_emulate_joypad_bouncing(gb, solo);
    GB_load_rom_from_buffer(gb, rom, rl);
    free(rom);
    size_t cart = 0;
    GB_get_direct_access(gb, GB_DIRECT_ACCESS_CART_RAM, &cart, NULL);
    st->ram_size = cart;
    int full = GB_save_battery_size(gb);
    st->has_rtc = full > (int)cart; // SameBoy saves a clock footer exactly for clock cartridges
    if (cart) {
      if (st->has_rtc && cfg->save && cfg->save_len == cart + 48) log_clock(cfg->save + cart);
      size_t bl = 0;
      uint8_t *b = st->has_rtc ? with_clock(st, cfg->save, cfg->save_len, &bl) : NULL;
      if (b) GB_load_battery_from_buffer(gb, b, bl), free(b);
      else if (cfg->save) GB_load_battery_from_buffer(gb, cfg->save, cfg->save_len);
    }
    GB_random_seed(0x736f756c64657700ull + (uint64_t)s); // power-on RAM: the same "random" contents on every peer
    GB_reset(gb);
    // the player's running game (SameBoy's libretro core: the same format; its battery RAM comes along)
    if (cfg->state && !load_state(gb, cfg->state, cfg->state_len)) { host_log("seat %d: state not loadable", s); return false; }
    GB_set_serial_transfer_bit_start_callback(gb, bit_start);
    GB_set_serial_transfer_bit_end_callback(gb, bit_end);
  }
  return true;
}

static void s_close(void) {
  for (int s = 0; s < 2; s++) {
    if (seats[s].gb) GB_free(seats[s].gb), GB_dealloc(seats[s].gb);
    seats[s].gb = NULL;
  }
  memset(audio_ring, 0, sizeof audio_ring);
  nseats = 0;
}

static void s_set_input(int seat, link_input in) {
  // linkbackend.h's order (A B Select Start Right Left Up Down) → SameBoy's (Right Left Up Down A B Select Start)
  GB_key_mask_t m = 0;
  if (in & LINK_KEY_A) m |= GB_KEY_A_MASK;
  if (in & LINK_KEY_B) m |= GB_KEY_B_MASK;
  if (in & LINK_KEY_SELECT) m |= GB_KEY_SELECT_MASK;
  if (in & LINK_KEY_START) m |= GB_KEY_START_MASK;
  if (in & LINK_KEY_RIGHT) m |= GB_KEY_RIGHT_MASK;
  if (in & LINK_KEY_LEFT) m |= GB_KEY_LEFT_MASK;
  if (in & LINK_KEY_UP) m |= GB_KEY_UP_MASK;
  if (in & LINK_KEY_DOWN) m |= GB_KEY_DOWN_MASK;
  GB_set_key_mask(seats[seat].gb, m);
}

/**
 * Two real Game Boys never run at exactly the same speed (crystal tolerance), so their frames slide past each other
 * and a link handshake that both start in the same instant still sorts out who drives the clock. Two emulated consoles
 * would stay phase-locked forever – Gen 1's Cable Club then fails when both players talk to the receptionist on the
 * same frame (both send "I'll be the master" at the same moment, every retry). So seat 1's clock runs 1/16384
 * (≈ 61 ppm, well inside real hardware's spread) fast: deterministic, invisible to the games, and the phase moves
 * ~8 ticks per frame.
 */
#define DRIFT_SHIFT 14
static uint64_t own_time(int seat, uint64_t t) { return seat ? t + (t >> DRIFT_SHIFT) : t; } // session time → the seat's clock
static uint64_t real_time(int seat, uint64_t t) { return seat ? t - (t >> DRIFT_SHIFT) : t; } // (approximately the inverse)

/**
 * Alone: one frame as the fast player's SameBoy runs it (GB_run_frame: up to the next vblank – SameBoy has one with the
 * LCD off too), so a frame's buttons apply from its start and its picture comes at its end. In a link session: one
 * slice of emulated time for every console, the one behind always running next (ties: the lower seat).
 */
static void s_run_frame(void) {
  if (solo) {
    struct sseat *st = &seats[0];
    st->vblank = false;
    for (uint64_t ran = 0; !st->vblank && ran < 2 * FRAME_TICKS;) ran += GB_run(st->gb); // (the bound: never stuck)
    return;
  }
  const uint64_t target = session_tick + FRAME_TICKS;
  for (;;) {
    int s = -1;
    uint64_t best = 0;
    for (int i = 0; i < nseats; i++) {
      if (seats[i].ticks >= own_time(i, target)) continue;
      const uint64_t r = real_time(i, seats[i].ticks);
      if (s < 0 || r < best) s = i, best = r;
    }
    if (s < 0) break;
    seats[s].ticks += GB_run(seats[s].gb);
  }
  session_tick = target;
}

static void s_video(int seat, const uint32_t **px, unsigned *w, unsigned *h, unsigned *stride) {
  *px = seats[seat].front, *w = 160, *h = 144, *stride = 160;
}
static double s_fps(void) { return CLOCK / 70224.0; }

/** The battery RAM only (what tells whether the game saved) – `battery` adds a clock cartridge's footer. */
static size_t s_sram(int seat, void **out) {
  struct sseat *st = &seats[seat];
  *out = NULL;
  if (!st->ram_size) return 0;
  size_t n = 0;
  void *p = GB_get_direct_access(st->gb, GB_DIRECT_ACCESS_CART_RAM, &n, NULL);
  if (!p || !(*out = malloc(st->ram_size))) return 0;
  memcpy(*out, p, st->ram_size);
  return st->ram_size;
}

static uint64_t s_hash(uint64_t h) {
  static const GB_direct_access_t parts[] = {GB_DIRECT_ACCESS_RAM, GB_DIRECT_ACCESS_HRAM, GB_DIRECT_ACCESS_VRAM, GB_DIRECT_ACCESS_CART_RAM,
                                             GB_DIRECT_ACCESS_OAM, GB_DIRECT_ACCESS_IE};
  for (int s = 0; s < nseats; s++) {
    GB_gameboy_t *gb = seats[s].gb;
    for (size_t i = 0; i < sizeof parts / sizeof *parts; i++) {
      size_t n = 0;
      uint16_t bank = 0;
      void *p = GB_get_direct_access(gb, parts[i], &n, &bank);
      if (p && n) h = host_fnv(h, p, n);
      h = host_fnv(h, &bank, sizeof bank);
    }
    h = host_fnv(h, GB_get_registers(gb), sizeof(GB_registers_t));
    h = host_fnv(h, &seats[s].ticks, sizeof seats[s].ticks);
  }
  return h;
}

/**
 * Memory for the live reader, as the fast player maps it: 0xC000–0xDFFF is work RAM bank 0 + bank 1 (where the Gen 1/2
 * party and boxes live), 0xA000 the cartridge RAM's current bank, 0x8000 video RAM, 0xFF80 high RAM.
 */
static uint8_t *s_mem(int seat, uint32_t addr, uint32_t len) {
  GB_gameboy_t *gb = seats[seat].gb;
  size_t n = 0;
  uint16_t bank = 0;
  uint8_t *p;
  if (addr >= 0xC000 && addr + len <= 0xE000) {
    p = GB_get_direct_access(gb, GB_DIRECT_ACCESS_RAM, &n, &bank);
    return p && addr - 0xC000 + len <= n ? p + (addr - 0xC000) : NULL;
  }
  if (addr >= 0xA000 && addr + len <= 0xC000) {
    p = GB_get_direct_access(gb, GB_DIRECT_ACCESS_CART_RAM, &n, &bank);
    size_t at = (size_t)bank * 0x2000 + (addr - 0xA000);
    return p && at + len <= n ? p + at : NULL;
  }
  if (addr >= 0x8000 && addr + len <= 0xA000) {
    p = GB_get_direct_access(gb, GB_DIRECT_ACCESS_VRAM, &n, &bank);
    size_t at = (size_t)bank * 0x2000 + (addr - 0x8000);
    return p && at + len <= n ? p + at : NULL;
  }
  if (addr >= 0xFF80 && addr + len <= 0xFFFF) {
    p = GB_get_direct_access(gb, GB_DIRECT_ACCESS_HRAM, &n, &bank);
    return p ? p + (addr - 0xFF80) : NULL;
  }
  return NULL;
}
static uint8_t s_read8(int seat, uint32_t addr) { return addr <= 0xFFFF ? GB_safe_read_memory(seats[seat].gb, (uint16_t)addr) : 0xFF; }
static void s_write8(int seat, uint32_t addr, uint8_t v) { if (addr <= 0xFFFF) GB_write_memory(seats[seat].gb, (uint16_t)addr, v); }

// states: SameBoy's own, then this console's place in the session (its emulated time, the bit on the wire)
#define EXTRA 16
static size_t s_state_size(int seat) { return GB_get_save_state_size(seats[seat].gb) + EXTRA; }
static bool s_save_state(int seat, void *out) {
  struct sseat *st = &seats[seat];
  size_t n = GB_get_save_state_size(st->gb);
  GB_save_state_to_buffer(st->gb, out);
  uint8_t *x = (uint8_t *)out + n;
  memset(x, 0, EXTRA);
  memcpy(x, &st->ticks, 8);
  x[8] = st->bit_out;
  return true;
}
static bool s_load_state(int seat, const void *in, size_t len) {
  struct sseat *st = &seats[seat];
  size_t n = GB_get_save_state_size(st->gb);
  if (len != n + EXTRA) return false;
  if (GB_load_state_from_buffer(st->gb, in, n)) return false;
  const uint8_t *x = (const uint8_t *)in + n;
  memcpy(&st->ticks, x, 8);
  st->bit_out = x[8];
  // the session's time follows the consoles (both ran to the same slice when the state was taken)
  uint64_t t = seats[0].ticks;
  for (int s = 1; s < nseats; s++) if (seats[s].ticks < t) t = seats[s].ticks;
  session_tick = t - t % FRAME_TICKS;
  return true;
}

/** The console as SameBoy's libretro core keeps it (retro_serialize: GB_save_state_to_buffer, the same SameBoy version). */
static size_t s_export(int seat, void **out) {
  const size_t n = GB_get_save_state_size(seats[seat].gb);
  if (!(*out = malloc(n))) return 0;
  GB_save_state_to_buffer(seats[seat].gb, *out);
  return n;
}

/** A fast-player state into the running console (a save-state slot loaded while playing alone). */
static bool s_import(int seat, const void *in, size_t len) { return load_state(seats[seat].gb, in, len); }

const struct link_backend link_backend_sameboy = {
  .name = "sameboy", .system = s_system, .probe = s_probe, .open = s_open, .set_input = s_set_input, .run_frame = s_run_frame,
  .video = s_video, .fps = s_fps, .sram = s_sram, .hash = s_hash, .mem = s_mem, .read8 = s_read8, .write8 = s_write8,
  .state_size = s_state_size, .save_state = s_save_state, .load_state = s_load_state, .sample_rate = s_sample_rate, .audio = s_audio, .battery = s_battery,
  .export_state = s_export, .import_state = s_import, .close = s_close,
};
