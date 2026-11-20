// souldew's native host for the DS, GBA and Game Boy: runs a libretro core (melonDS DS, mGBA, SameBoy) as a native
// program – with the core's JIT and all of the computer's speed – and talks to souldew over stdin/stdout like the 3DS
// host (native/ctr-host). The game then plays inside souldew's own player (web/lib/nativeplayer.mjs). The souldew
// engine (native/link-host in solo mode) plays the same games on the same emulators' own APIs and speaks this protocol
// too; both share native/common (IPC, the RAM stream, the fast-forward sound, the frame loop's rhythm).
//
//   retrohost --core <lib> --rom <game> --system <dir> --save <dir> [--sram <file>] [--state <file>] [--ram ADDR:LEN]…
//             [--option key=value]… [--bench FRAMES [--dump out.ppm] [--speed X]]
// --state: a save state of the core, loaded before the first frame – the game goes on exactly where it was (back from a
// link session: the link host's state of this player's console, docs/MULTIPLAYER.md › "Seamless").
//
// Messages: native/common/protocol.h. This host sends VIDEO (the core's format: XRGB8888 as BGRA bytes, or RGB565),
// AUDIO (fast-forward: sped up by the real speed, resampled to real time – ffaudio.h), STATE, LOG, EVENT ('loaded' |
// 'error' | 'stateLoaded' | 'stats' {fps, speed, shown, frame, ffk, ffHoles} | 'stepped' {frame} | 'saved' {size} |
// 'written' {addr, len, ok} | 'ffrate' {k} | 'audioRate' {sampleRate}), RAM, SRAM, WATCHED, DEPTH; it takes INPUT, SPEED, SAVE, LOAD, QUIT,
// RESET, WRITE, FLUSH, SRAM, RESYNC, STEP, WATCH, DEPTH.
// Builds on macOS, Linux and Windows (../ctr-host/compat.h); scripts/build-native.mjs builds it.
#include "libretro.h"

#include <math.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "compat.h"
#include "../common/cadence.h"
#include "../common/depth.h"
#include "../common/ffaudio.h"
#include "../common/hostio.h"
#include "../common/protocol.h"
#include "../common/ramstream.h"

#define EXP RETRO_ENVIRONMENT_EXPERIMENTAL
#define IS(cmd, k) (((cmd) & ~EXP) == ((k) & ~EXP))

// ---- options ---------------------------------------------------------------------------------------------------
static const char *opt_core, *opt_rom, *opt_system, *opt_save, *opt_sram, *opt_dump, *opt_state;
static int opt_bench = 0;
static double opt_bench_speed = 0; // bench: 0 = as fast as possible, else paced like the game loop

#define MAX_OPTIONS 64
static struct { char *key, *value; } options[MAX_OPTIONS];
static int options_n;
static const char *core_option(const char *key) {
  for (int i = 0; i < options_n; i++)
    if (!strcmp(options[i].key, key)) return options[i].value;
  return NULL;
}

// ---- the core --------------------------------------------------------------------------------------------------
static struct {
  void (*init)(void);
  void (*set_environment)(retro_environment_t);
  void (*set_video_refresh)(retro_video_refresh_t);
  void (*set_audio_sample)(retro_audio_sample_t);
  void (*set_audio_sample_batch)(retro_audio_sample_batch_t);
  void (*set_input_poll)(retro_input_poll_t);
  void (*set_input_state)(retro_input_state_t);
  void (*get_system_info)(struct retro_system_info *);
  void (*get_system_av_info)(struct retro_system_av_info *);
  void (*set_controller_port_device)(unsigned, unsigned);
  bool (*load_game)(const struct retro_game_info *);
  void (*run)(void);
  void (*reset)(void);
  size_t (*serialize_size)(void);
  bool (*serialize)(void *, size_t);
  bool (*unserialize)(const void *, size_t);
  void *(*get_memory_data)(unsigned);
  size_t (*get_memory_size)(unsigned);
} core;

static struct retro_memory_descriptor *memmap;
static unsigned memmap_n;
static int memmap_dirty; // the core gave a new map (melonDS DS builds a new console on reset): find the RAM again
static enum retro_pixel_format pixfmt = RETRO_PIXEL_FORMAT_0RGB1555;

// ---- input (set between frames from INPUT, read by the core while it runs a frame – one thread) -------------------
static struct {
  uint32_t buttons;
  int16_t lx, ly, rx, ry, px, py;
  uint8_t pressed;
} input;
// A click is often shorter than games look at the touch screen: every touch counts for at least this many frames
#define TOUCH_MIN_FRAMES 4
static int touch_latch;

static void take_input(const uint8_t *p) {
  if (p[16] && !input.pressed) touch_latch = TOUCH_MIN_FRAMES;
  memcpy(&input.buttons, p, 4);
  memcpy(&input.lx, p + 4, 2), memcpy(&input.ly, p + 6, 2), memcpy(&input.rx, p + 8, 2), memcpy(&input.ry, p + 10, 2);
  if (p[16] || !touch_latch) memcpy(&input.px, p + 12, 2), memcpy(&input.py, p + 14, 2);
  input.pressed = p[16];
}

static void input_poll(void) {}
static int16_t input_state(unsigned port, unsigned device, unsigned index, unsigned id) {
  if (port) return 0;
  switch (device & RETRO_DEVICE_MASK) {
  case RETRO_DEVICE_JOYPAD:
    return id == RETRO_DEVICE_ID_JOYPAD_MASK ? (int16_t)(input.buttons & 0xffff) : (int16_t)((input.buttons >> id) & 1);
  case RETRO_DEVICE_ANALOG:
    if (index == RETRO_DEVICE_INDEX_ANALOG_LEFT) return id == RETRO_DEVICE_ID_ANALOG_X ? input.lx : input.ly;
    if (index == RETRO_DEVICE_INDEX_ANALOG_RIGHT) return id == RETRO_DEVICE_ID_ANALOG_X ? input.rx : input.ry;
    return 0;
  case RETRO_DEVICE_POINTER:
    if (index == 0) {
      const int down = input.pressed || touch_latch > 0;
      if (id == RETRO_DEVICE_ID_POINTER_X) return input.px;
      if (id == RETRO_DEVICE_ID_POINTER_Y) return input.py;
      if (id == RETRO_DEVICE_ID_POINTER_PRESSED) return (int16_t)down;
      if (id == RETRO_DEVICE_ID_POINTER_COUNT) return down ? 1 : 0;
    }
    return 0;
  }
  return 0;
}

// ---- audio: collected per frame, sent after it (native/common/ffaudio.h) ------------------------------------------
static int16_t *audio_buf;
static size_t audio_n, audio_cap; // int16 values (2 per stereo frame)
static int audio_on = 1;
static struct ff_audio ffa;
static void audio_push(const int16_t *d, size_t frames) {
  if (!audio_on || !frames) return;
  if (audio_n + frames * 2 > audio_cap) {
    size_t cap = (audio_n + frames * 2) * 2;
    int16_t *b = realloc(audio_buf, cap * sizeof *b);
    if (!b) return;
    audio_buf = b;
    audio_cap = cap;
  }
  memcpy(audio_buf + audio_n, d, frames * 2 * sizeof *d);
  audio_n += frames * 2;
}
static void audio_sample(int16_t l, int16_t r) {
  int16_t s[2] = {l, r};
  audio_push(s, 1);
}
static size_t audio_batch(const int16_t *d, size_t frames) {
  audio_push(d, frames);
  return frames;
}

// ---- video ---------------------------------------------------------------------------------------------------------
static int want_frame = 1;
static uint8_t *frame_buf; // 8-byte header + packed pixels of the last picture
static size_t frame_cap;
static int frame_w, frame_h, frame_fmt, frame_new;
static uint64_t frame_no;
static struct ram_stream rs;
static struct cadence cad;

static void video_refresh(const void *data, unsigned w, unsigned h, size_t pitch) {
  if (!data || !w || !h || data == RETRO_HW_FRAME_BUFFER_VALID) return; // a dupe: the last picture stays
  if (!want_frame) return;
  const int bpp = pixfmt == RETRO_PIXEL_FORMAT_XRGB8888 ? 4 : 2;
  const size_t row = (size_t)w * bpp, need = 8 + row * h;
  if (need > frame_cap) {
    uint8_t *b = realloc(frame_buf, need);
    if (!b) return;
    frame_buf = b;
    frame_cap = need;
  }
  uint8_t *px = frame_buf + 8;
  for (unsigned y = 0; y < h; y++) memcpy(px + y * row, (const uint8_t *)data + y * pitch, row);
  if (pixfmt == RETRO_PIXEL_FORMAT_0RGB1555) { // → RGB565 (the page knows two formats)
    uint16_t *p = (uint16_t *)px;
    for (size_t i = 0, n = (size_t)w * h; i < n; i++) {
      const uint16_t c = p[i];
      p[i] = (uint16_t)(((c & 0x7c00) << 1) | ((c & 0x03e0) << 1) | ((c & 0x0200) >> 4) | (c & 0x001f));
    }
  }
  frame_w = (int)w, frame_h = (int)h, frame_fmt = bpp == 4 ? 0 : 2, frame_new = 1;
}

// ---- the DS's 3D depth (Shared World: partners hide behind the map – native/common/depth.h) -------------------------
// souldew's melonDS DS (native/melonds-ds-patch) exports souldew_depth; another core has none and the page gets nothing.
static int (*core_depth)(int on, int x, int y, int w, int h, uint32_t *out);
static struct depth_req depth;
static int retro_depth(void *ctx, int on, int x, int y, int w, int h, uint32_t *out) {
  (void)ctx;
  return core_depth ? core_depth(on, x, y, w, h, out) : -1;
}

/** The last picture (right after the bytes the page watches – for exactly this picture). */
static void send_frame(void) {
  if (!frame_new) return;
  depth_send(&depth, (uint32_t)frame_no, retro_depth, NULL);
  ram_send_watched(&rs, (uint32_t)frame_no);
  frame_new = 0;
  cad.shown++;
  uint16_t ww = (uint16_t)frame_w, hh = (uint16_t)frame_h;
  uint32_t f = (uint32_t)frame_fmt;
  memcpy(frame_buf, &ww, 2);
  memcpy(frame_buf + 2, &hh, 2);
  memcpy(frame_buf + 4, &f, 4);
  host_send(MSG_VIDEO, frame_buf, (uint32_t)(8 + (size_t)frame_w * frame_h * (frame_fmt == 0 ? 4 : 2)));
}

// ---- environment -------------------------------------------------------------------------------------------------
static void core_log(enum retro_log_level level, const char *fmt, ...) {
  if (level < RETRO_LOG_WARN) return;
  char buf[2048];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  host_log("[core] %s", buf);
}

// the core's messages for the player: not the empty ones melonDS DS sends every frame, not the same one over and over
#include "coremsg.h"
static void core_message(const char *msg) {
  unsigned repeats;
  if (!core_msg_wanted(msg, compat_now(), &repeats)) return;
  if (repeats) host_log("[core message] (the one before came %u more times)", repeats);
  host_log("[core message] %s", msg);
}

static int fastforwarding;
static double new_rate; // a sound rate the core announced while running (taken after the frame)
static bool environment(unsigned cmd, void *data) {
  if (IS(cmd, RETRO_ENVIRONMENT_GET_CAN_DUPE)) { *(bool *)data = true; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY)) { *(const char **)data = opt_system; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY)) { *(const char **)data = opt_save; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_CORE_ASSETS_DIRECTORY)) { *(const char **)data = opt_system; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_PIXEL_FORMAT)) {
    enum retro_pixel_format f = *(enum retro_pixel_format *)data;
    if (f != RETRO_PIXEL_FORMAT_XRGB8888 && f != RETRO_PIXEL_FORMAT_RGB565 && f != RETRO_PIXEL_FORMAT_0RGB1555) return false;
    pixfmt = f;
    return true;
  }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS) || IS(cmd, RETRO_ENVIRONMENT_SET_CONTROLLER_INFO)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_SET_HW_RENDER)) return false; // software rendering only
  if (IS(cmd, RETRO_ENVIRONMENT_GET_PREFERRED_HW_RENDER)) return false;
  if (IS(cmd, RETRO_ENVIRONMENT_GET_VARIABLE)) {
    struct retro_variable *v = data;
    if (!v || !v->key) return false;
    v->value = core_option(v->key);
    return v->value != NULL;
  }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE)) { *(bool *)data = false; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION)) { *(unsigned *)data = 0; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_VARIABLES)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_SET_CORE_OPTIONS_DISPLAY)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_GET_LOG_INTERFACE)) { ((struct retro_log_callback *)data)->log = core_log; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_GEOMETRY)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO)) { // (mGBA: the game switched its sound rate – SOUNDBIAS)
    const struct retro_system_av_info *av = data;
    if (av && av->timing.sample_rate > 0) new_rate = av->timing.sample_rate;
    return true;
  }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_MEMORY_MAPS)) {
    const struct retro_memory_map *m = data;
    free(memmap);
    memmap_n = m->num_descriptors;
    memmap = calloc(memmap_n ? memmap_n : 1, sizeof *memmap);
    if (!memmap) { memmap_n = 0; return false; }
    memcpy(memmap, m->descriptors, memmap_n * sizeof *memmap);
    memmap_dirty = 1;
    return true;
  }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_SUPPORT_ACHIEVEMENTS) || IS(cmd, RETRO_ENVIRONMENT_SET_SERIALIZATION_QUIRKS)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_GET_INPUT_BITMASKS)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_GET_AUDIO_VIDEO_ENABLE)) { *(int *)data = 1 | 2; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_FASTFORWARDING)) { *(bool *)data = fastforwarding != 0; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_LANGUAGE)) { *(unsigned *)data = RETRO_LANGUAGE_ENGLISH; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_USERNAME)) { *(const char **)data = "souldew"; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_MESSAGE_INTERFACE_VERSION)) { *(unsigned *)data = 1; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_MESSAGE)) { core_message(data ? ((const struct retro_message *)data)->msg : NULL); return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_MESSAGE_EXT)) { core_message(data ? ((const struct retro_message_ext *)data)->msg : NULL); return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_TARGET_REFRESH_RATE)) { *(float *)data = 60.0f; return true; }
  // (SameBoy otherwise makes its sound at half the Game Boy's clock – 2 MHz, more than any sound card plays)
  if (IS(cmd, RETRO_ENVIRONMENT_GET_TARGET_SAMPLE_RATE)) { *(unsigned *)data = 48000; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SHUTDOWN)) { fflush(stdout); _exit(0); }
  return false;
}

// ---- memory: where the --ram regions live in the core (native/common/ramstream.h mirrors them) -------------------
/**
 * Where the bus address `addr` (`len` bytes) lives in the core's memory, from its memory map: a descriptor whose
 * address bits (`select`) match for the first and the last byte, inside its first copy (no mirrors) – a descriptor's
 * `start + len` alone may reach past its window (a 32 KB cartridge RAM at 0xA000 would "cover" 0xC000 too).
 */
static uint8_t *mem_at(uint32_t addr, uint32_t len) {
  if (!len) return NULL;
  for (unsigned i = 0; i < memmap_n; i++) {
    const struct retro_memory_descriptor *d = &memmap[i];
    if (!d->ptr || !d->len || addr < d->start || (uint64_t)addr + len > (uint64_t)d->start + d->len) continue;
    const uint64_t last = (uint64_t)addr + len - 1;
    if (d->select && ((((uint64_t)addr ^ d->start) & d->select) || ((last ^ d->start) & d->select))) continue;
    return (uint8_t *)d->ptr + d->offset + (addr - d->start);
  }
  return NULL;
}
/** The memory map, else (the first region) the core's system RAM. */
static uint8_t *locate(int index, uint32_t addr, uint32_t len, void *ctx) {
  (void)ctx;
  uint8_t *p = mem_at(addr, len);
  if (!p && index == 0 && core.get_memory_data && core.get_memory_size && core.get_memory_size(RETRO_MEMORY_SYSTEM_RAM) >= len)
    p = core.get_memory_data(RETRO_MEMORY_SYSTEM_RAM);
  return p;
}
static void send_ram(void) {
  ram_locate(&rs, locate, NULL); // (cheap – and a core may move its memory without a new map, e.g. after loading a state)
  ram_send(&rs);
}

// ---- the battery save -------------------------------------------------------------------------------------------
static struct sram_watch sram_w;
static void sram_get(uint8_t **p, size_t *n) {
  *p = core.get_memory_data ? core.get_memory_data(RETRO_MEMORY_SAVE_RAM) : NULL;
  *n = *p && core.get_memory_size ? core.get_memory_size(RETRO_MEMORY_SAVE_RAM) : 0;
  if (!*n) *p = NULL;
}
// The cartridge clock (Game Boy MBC3: Gold/Silver/Crystal). souldew keeps it in the battery save as the 48-byte footer
// VBA-M, mGBA and SameBoy write (u32 seconds, minutes, hours, days, flags – the clock then latched – then the u64 Unix
// second it was saved): the same file then carries the clock into the link host (SameBoy) and back. SameBoy keeps it as
// RETRO_MEMORY_RTC – its "rtc" save-state section (32 bytes): the clock's 5 registers, the latched 5, at 16 the u64 Unix
// second the clock was last brought up to (it runs on the computer's clock from there). (Older souldew played the Game
// Boy on Gambatte; its saves carry the same footer.)
#define RTC_FOOTER 48
#define SAMEBOY_RTC 32
static uint8_t *rtc_mem(void) {
  uint8_t *r = core.get_memory_data ? core.get_memory_data(RETRO_MEMORY_RTC) : NULL;
  return r && core.get_memory_size && core.get_memory_size(RETRO_MEMORY_RTC) == SAMEBOY_RTC ? r : NULL;
}
static int rtc_footer(uint8_t out[RTC_FOOTER]) {
  const uint8_t *r = rtc_mem();
  if (!r) return 0;
  uint32_t v[10];
  for (int i = 0; i < 10; i++) v[i] = r[i];
  memcpy(out, v, 40);
  memcpy(out + 40, r + 16, 8);
  return 1;
}
/** A save with the clock footer: the core's clock from it (it ran on since it was saved, as a cartridge's does). */
static void rtc_from_footer(const uint8_t *f) {
  uint8_t *r = rtc_mem();
  if (!r) return;
  uint32_t v[10];
  uint64_t saved;
  memcpy(v, f, sizeof v);
  memcpy(&saved, f + 40, 8);
  if (saved < 852076800ull) return; // (no real clock data – before 1997: SameBoy keeps its own)
  for (int i = 0; i < 10; i++) r[i] = (uint8_t)v[i];
  memcpy(r + 16, &saved, 8); // (SameBoy then brings the clock up to now by itself)
  const uint64_t days = (v[3] & 0xff) | (uint64_t)(v[4] & 1) << 8;
  host_log("cartridge clock from the save: %llu days %02u:%02u", (unsigned long long)days, v[2] % 24, v[1] % 60);
}
/** The battery save as souldew keeps it: the save memory, plus the clock footer for a clock cartridge. */
static void send_sram(const uint8_t *p, size_t n) {
  uint8_t f[RTC_FOOTER];
  if (rtc_footer(f)) host_send2(MSG_SRAM, p, (uint32_t)n, f, RTC_FOOTER);
  else host_send(MSG_SRAM, p, (uint32_t)n);
}
/** Send the battery save when it changed: `force` now, else once it stopped changing (the game writes it in steps). */
static void check_sram(bool force) {
  uint8_t *p;
  size_t n;
  sram_get(&p, &n);
  if (!p || !sram_due(&sram_w, p, n, force)) return;
  send_sram(p, n);
  host_event("{\"event\":\"saved\",\"size\":%zu}", n);
}
/** The save souldew hands over at the start, into the core's save memory (as RetroArch does with .srm files). */
static void load_sram(void) {
  uint8_t *p;
  size_t n;
  sram_get(&p, &n);
  if (!p) return;
  if (opt_sram && *opt_sram) {
    FILE *f = host_fopen(opt_sram, "rb");
    if (f) {
      size_t got = fread(p, 1, n, f);
      uint8_t footer[RTC_FOOTER];
      if (got == n && fread(footer, 1, RTC_FOOTER, f) == RTC_FOOTER) rtc_from_footer(footer); // (a clock cartridge's)
      fclose(f);
      host_log("battery save: %zu of %zu bytes", got, n);
    }
  }
  sram_known(&sram_w, p, n); // souldew has this one
}

/** A state far off the core's own size is no state of this game (cores trust the sizes inside it). (SameBoy names twice
 *  the biggest of all its models' states as its size – a Game Boy Color's is under half of that) */
static bool state_fits(size_t len) {
  const size_t want = core.serialize_size();
  return want && len >= want / 4 && len <= want * 2 + 65536;
}

// ---- main --------------------------------------------------------------------------------------------------------
static void dump_ppm(const char *path) {
  if (!frame_buf || !frame_w) return;
  FILE *f = host_fopen(path, "wb");
  if (!f) return;
  fprintf(f, "P6\n%d %d\n255\n", frame_w, frame_h);
  const uint8_t *px = frame_buf + 8;
  for (int i = 0; i < frame_w * frame_h; i++) {
    uint8_t rgb[3];
    if (frame_fmt == 0) rgb[0] = px[i * 4 + 2], rgb[1] = px[i * 4 + 1], rgb[2] = px[i * 4];
    else {
      uint16_t c;
      memcpy(&c, px + i * 2, 2);
      rgb[0] = (uint8_t)((c >> 11) << 3), rgb[1] = (uint8_t)(((c >> 5) & 63) << 2), rgb[2] = (uint8_t)((c & 31) << 3);
    }
    fwrite(rgb, 1, 3, f);
  }
  fclose(f);
}

#define SYM(field, name) core.field = (void *)dlsym(lib, name); if (!core.field) host_die("%s missing in the core", name)

int main(int argc, char **argv) {
  argv = host_utf8_argv(&argc, argv);
  for (int i = 1; i + 1 < argc; i += 2) {
    const char *k = argv[i], *v = argv[i + 1];
    if (!strcmp(k, "--core")) opt_core = v;
    else if (!strcmp(k, "--rom")) opt_rom = v;
    else if (!strcmp(k, "--system")) opt_system = v;
    else if (!strcmp(k, "--save")) opt_save = v;
    else if (!strcmp(k, "--sram")) opt_sram = v;
    else if (!strcmp(k, "--state")) opt_state = v;
    else if (!strcmp(k, "--bench")) opt_bench = atoi(v);
    else if (!strcmp(k, "--speed")) opt_bench_speed = atof(v);
    else if (!strcmp(k, "--dump")) opt_dump = v;
    else if (!strcmp(k, "--ram")) ram_add_arg(&rs, v);
    else if (!strcmp(k, "--option") && options_n < MAX_OPTIONS) {
      const char *eq = strchr(v, '=');
      if (eq && eq > v) {
        options[options_n].key = calloc(1, (size_t)(eq - v) + 1);
        memcpy(options[options_n].key, v, (size_t)(eq - v));
        options[options_n].value = strdup(eq + 1);
        options_n++;
      }
    }
  }
  if (!opt_core || !opt_rom || !opt_system || !opt_save) {
    fprintf(stderr, "usage: retrohost --core <lib> --rom <file> --system <dir> --save <dir> [--sram <file>] [--state <file>] [--ram addr:len]… [--option k=v]… [--bench frames [--speed x] [--dump out.ppm]]\n");
    return 2;
  }
  hostio_init("retrohost", !opt_bench);

  void *lib = dlopen(opt_core, RTLD_NOW | RTLD_LOCAL);
  if (!lib) host_die("core not loadable: %s", dlerror());
  SYM(init, "retro_init"); SYM(set_environment, "retro_set_environment");
  SYM(set_video_refresh, "retro_set_video_refresh"); SYM(set_audio_sample, "retro_set_audio_sample");
  SYM(set_audio_sample_batch, "retro_set_audio_sample_batch"); SYM(set_input_poll, "retro_set_input_poll");
  SYM(set_input_state, "retro_set_input_state"); SYM(get_system_info, "retro_get_system_info");
  SYM(get_system_av_info, "retro_get_system_av_info"); SYM(load_game, "retro_load_game"); SYM(run, "retro_run");
  SYM(reset, "retro_reset"); SYM(serialize_size, "retro_serialize_size"); SYM(serialize, "retro_serialize");
  SYM(unserialize, "retro_unserialize"); SYM(get_memory_data, "retro_get_memory_data");
  SYM(get_memory_size, "retro_get_memory_size");
  core.set_controller_port_device = (void *)dlsym(lib, "retro_set_controller_port_device");
  core_depth = (void *)dlsym(lib, "souldew_depth"); // (souldew's melonDS DS only: the 3D depth for Shared World)

  core.set_environment(environment);
  core.set_video_refresh(video_refresh);
  core.set_audio_sample(audio_sample);
  core.set_audio_sample_batch(audio_batch);
  core.set_input_poll(input_poll);
  core.set_input_state(input_state);
  core.init();

  struct retro_system_info sys;
  memset(&sys, 0, sizeof sys);
  core.get_system_info(&sys);
  struct retro_game_info info = {opt_rom, NULL, 0, NULL};
  void *rom_data = NULL;
  if (sys.need_fullpath == false) { // the core wants the bytes (mGBA, SameBoy)
    rom_data = host_read_file(opt_rom, &info.size);
    if (!rom_data) host_die("game not readable: %s", opt_rom);
    // A DS cartridge is a power of two in size; a trimmed or patched ROM (Renegade Platinum: 104,923,028 bytes) isn't.
    // melonDS rounds the size up and then reads past the end of the buffer – it crashes inside its fault handler and
    // hangs. Padded with 0xFF, as an unused cartridge area reads, the game starts.
    if (sys.library_name && strstr(sys.library_name, "melonDS") && info.size > 0 && (info.size & (info.size - 1))) {
      size_t want = 1;
      while (want < info.size) want <<= 1;
      void *b = realloc(rom_data, want);
      if (!b) host_die("not enough memory for the game");
      memset((uint8_t *)b + info.size, 0xff, want - info.size);
      fprintf(stderr, "retrohost: ROM padded from %zu to %zu bytes\n", info.size, want);
      rom_data = b;
      info.size = want;
    }
    info.data = rom_data;
  }
  if (!core.load_game(&info)) host_die("the core couldn't load the game");
  if (core.set_controller_port_device) core.set_controller_port_device(0, RETRO_DEVICE_JOYPAD);
  load_sram();
  int state_ok = -1; // --state: -1 none, 0 not loadable (the game starts from its battery save), 1 loaded
  if (opt_state && *opt_state) {
    size_t sl = 0;
    void *sb = host_read_file(opt_state, &sl);
    const int fits = sb && state_fits(sl);
    state_ok = fits && core.unserialize(sb, sl);
    if (fits && !state_ok) { // (a core that finishes setting up in its first frame: one frame, unseen and unheard, then again)
      want_frame = 0, audio_on = 0;
      core.run();
      want_frame = 1, audio_on = 1, audio_n = 0;
      state_ok = core.unserialize(sb, sl);
    }
    if (!state_ok) host_log("save state %s not loadable (%zu bytes, the core's are %zu)", opt_state, sl, core.serialize_size());
    free(sb);
    // the battery save as the state left it is the one souldew has (a state carries the save memory of its moment)
    uint8_t *p;
    size_t n;
    sram_get(&p, &n);
    if (p) sram_known(&sram_w, p, n);
  }
  ram_locate(&rs, locate, NULL);

  struct retro_system_av_info av;
  memset(&av, 0, sizeof av);
  core.get_system_av_info(&av);
  const double fps = av.timing.fps > 1 ? av.timing.fps : 60.0;
  uint8_t *sp;
  size_t sn;
  sram_get(&sp, &sn);
  {
    char regions[256], name[200], ver[120];
    ram_regions_json(&rs, regions, sizeof regions);
    host_json_escape(name, sizeof name, sys.library_name ? sys.library_name : "?");
    host_json_escape(ver, sizeof ver, sys.library_version ? sys.library_version : "?");
    host_event("{\"event\":\"loaded\",\"core\":\"%s\",\"version\":\"%s\",\"width\":%u,\"height\":%u,\"fps\":%.4f,\"sampleRate\":%.1f,\"ram\":[%s],\"saveSize\":%zu,\"stateSize\":%zu,\"state\":%s}",
               name, ver, av.geometry.base_width, av.geometry.base_height, fps, av.timing.sample_rate, regions, sn, core.serialize_size(), state_ok < 0 ? "null" : state_ok ? "true" : "false");
  }

  if (opt_bench) {
    double t0 = host_now(), next = t0;
    for (int i = 0; i < opt_bench; i++) {
      want_frame = i == opt_bench - 1 || (i % 60) == 0;
      core.run();
      audio_n = 0;
      if (opt_bench_speed > 0) {
        next += 1.0 / (fps * opt_bench_speed);
        host_sleep(next - host_now());
      }
    }
    double dt = host_now() - t0;
    fprintf(stderr, "bench: %d frames in %.2f s = %.1f fps (%.0f%% = %.2fx of %.2f), %dx%d fmt %d, sram %zu, state %zu\n", opt_bench, dt, opt_bench / dt,
            100.0 * opt_bench / dt / fps, opt_bench / dt / fps, fps, frame_w, frame_h, frame_fmt, sn, core.serialize_size());
    for (int i = 0; i < rs.n; i++) {
      fprintf(stderr, "  ram %08X+%X: %s", rs.r[i].addr, rs.r[i].len, rs.r[i].ptr ? "" : "missing");
      if (rs.r[i].ptr) for (int k = 0; k < 16; k++) fprintf(stderr, "%02x", rs.r[i].ptr[k]);
      fprintf(stderr, "\n");
    }
    if (opt_dump) dump_ppm(opt_dump);
    fflush(stderr);
    _exit(0);
  }

  host_start_reader(256u * 1024 * 1024);
  ffa_init(&ffa, av.timing.sample_rate);
  cadence_init(&cad, fps, host_now());
  float speed = 1.0f;
  uint32_t step_left = 0; // STEP: frames still to run before pausing
  struct host_cmd cmds[256];
  for (;;) {
    // ---- souldew's commands, in order, between two frames
    bool quit = false, wrote = false;
    for (int nc; !quit && (nc = host_take_commands(cmds, 256)) > 0;) {
      for (int i = 0; i < nc; i++) {
        struct host_cmd *c = &cmds[i];
        if (quit) { free(c->p); continue; }
        switch (c->type) {
        case CMD_INPUT:
          if (c->len >= 17) take_input(c->p);
          break;
        case CMD_SPEED:
          if (c->len >= 4) {
            float v;
            memcpy(&v, c->p, 4);
            speed = isfinite(v) ? (v <= 0 ? 0 : v < 0.05f ? 0.05f : v > 1000.0f ? 1000.0f : v) : v > 0 ? 1000.0f : 1.0f;
          }
          break;
        case CMD_SAVE: {
          const size_t n = core.serialize_size();
          uint8_t *b = n ? malloc(n) : NULL;
          if (b && core.serialize(b, n)) host_send(MSG_STATE, b, (uint32_t)n);
          else host_send(MSG_STATE, NULL, 0);
          free(b);
          break;
        }
        case CMD_LOAD: {
          const bool ok = state_fits(c->len) && core.unserialize(c->p, c->len);
          memmap_dirty = 1;
          host_event("{\"event\":\"stateLoaded\",\"ok\":%s}", ok ? "true" : "false");
          break;
        }
        case CMD_QUIT: quit = true; break;
        case CMD_RESET:
          core.reset();
          memmap_dirty = 1;
          break;
        case CMD_WRITE:
          if (c->len > 4 && c->len <= 4 + 65536) {
            uint32_t a;
            memcpy(&a, c->p, 4);
            const bool ok = ram_write(&rs, a, c->p + 4, c->len - 4);
            host_event("{\"event\":\"written\",\"addr\":%u,\"len\":%u,\"ok\":%s}", a, c->len - 4, ok ? "true" : "false");
            wrote = true;
          }
          break;
        case CMD_FLUSH: check_sram(true); break;
        case CMD_SRAM: {
          // a battery save given late: the game starts over with it. Written after the reset – melonDS DS builds a new
          // console there and copies the old one's save into its buffer; the next frame installs what is in it then.
          core.reset();
          memmap_dirty = 1;
          uint8_t *p;
          size_t n;
          sram_get(&p, &n);
          if (p) {
            memset(p, 0xff, n);
            memcpy(p, c->p, c->len < n ? c->len : n);
            if (c->len == n + RTC_FOOTER) rtc_from_footer(c->p + n);
            sram_known(&sram_w, p, n);
          }
          break;
        }
        case CMD_RESYNC: ram_resync(&rs); break;
        case CMD_STEP:
          if (c->len >= 4) {
            uint32_t n;
            memcpy(&n, c->p, 4);
            step_left = n > 100000 ? 100000 : n;
            speed = step_left ? 1000.0f : 0.0f; // as fast as it goes, then paused
          }
          break;
        case CMD_WATCH: ram_set_watch(&rs, c->p, c->len); break;
        case CMD_DEPTH: depth_set(&depth, c->p, c->len, retro_depth, NULL); break;
        }
        free(c->p);
      }
    }
    if (quit) break;
    if (memmap_dirty) memmap_dirty = 0, ram_locate(&rs, locate, NULL);
    double t = host_now();
    if (speed <= 0.0f) { // paused: the RAM and the save stay current (cheats, a save state's check)
      if (wrote || cadence_every(&cad.last_ram, 0.1, t)) cad.last_ram = t, send_ram();
      if (cadence_every(&cad.last_sram, 0.5, t)) check_sram(false); // a save made right before the pause still settles
      host_sleep(0.01);
      cadence_restart(&cad, host_now());
      ffa_idle(&ffa, host_now()); // (the pause is no time the fast-forward sound owes)
      continue;
    }
    const bool turbo = speed > 1.01f;
    fastforwarding = turbo;
    // turbo: a picture for the screen about 60 times a second, not one per emulated frame
    want_frame = cadence_picture_due(&cad, turbo, t) || step_left == 1;
    audio_on = 1;
    core.run();
    frame_no++;
    if (touch_latch > 0) touch_latch--;
    cadence_frame(&cad);
    const bool stepped = step_left && --step_left == 0;
    if (stepped) speed = 0.0f;
    t = host_now();
    if (stepped) { // the plan's next input applies from the next frame: the RAM and the picture as they are now
      send_frame();
      send_ram();
      cad.last_ram = t;
      host_event("{\"event\":\"stepped\",\"frame\":%llu}", (unsigned long long)frame_no);
    }
    if (want_frame && frame_new) send_frame();
    if (new_rate > 0) ffa_rate(&ffa, new_rate), new_rate = 0;
    ffa_frame(&ffa, audio_buf, audio_n / 2, turbo, speed, t);
    audio_n = 0;
    if (wrote || cadence_every(&cad.last_ram, 0.1, t)) cad.last_ram = t, send_ram(); // ten times a second, whatever the speed
    if (cadence_every(&cad.last_sram, 0.25, t)) check_sram(false); // (sent once it held still for a quarter second)
    double rfps, real;
    if (cadence_stats(&cad, t, &rfps, &real)) { // the page measures the real speed with the frame count
      ffa_measured(&ffa, real);
      // (ffk / ffHoles: the fast-forward sound's ratio, and how often its queue ran dry – diagnostics)
      host_event("{\"event\":\"stats\",\"fps\":%.1f,\"speed\":%.3f,\"shown\":%llu,\"frame\":%llu,\"ffk\":%.3f,\"ffHoles\":%u}", rfps, real,
                 (unsigned long long)cad.shown, (unsigned long long)frame_no, ffa.k, ffa.holes);
    }
    cadence_wait(&cad, speed, t);
  }
  check_sram(true); // the last of the game's saves
  fflush(stdout);
  _exit(0);
}
