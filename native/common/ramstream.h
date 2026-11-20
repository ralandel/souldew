// The game's memory for souldew's live tracking, shared by both native hosts: the --ram regions mirrored in the page
// (RAM: what changed, in whole 1 KB blocks, between two frames – never torn), cheats written into them (WRITE), and a
// few bytes the page needs with every single picture (WATCH → WATCHED: the Shared World overlay's camera).
#ifndef SOULDEW_RAMSTREAM_H
#define SOULDEW_RAMSTREAM_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define RAM_MAX_REGIONS 4
#define RAM_MAX_WATCH 16
#define RAM_MAX_WATCH_BYTES 512

struct ram_stream {
  struct ram_region {
    uint32_t addr, len;
    uint8_t *ptr;    // where it lives in the emulator now (NULL: not found)
    uint8_t *shadow; // what the page has
  } r[RAM_MAX_REGIONS];
  int n;
  bool full; // the next RAM message carries everything (RESYNC, a new page, another console)
  struct { uint32_t addr, len; } watch[RAM_MAX_WATCH];
  int watch_n;
  uint8_t *msg;
  size_t msg_cap;
  uint8_t watched[4 + RAM_MAX_WATCH_BYTES];
};

/** "--ram ADDR:LEN" (bus address, length ≤ 16 MB): adds a region; false when the value isn't one. */
bool ram_add_arg(struct ram_stream *rs, const char *value);
/** Where region `index` (`addr`, `len` bytes) lives in the emulator now, or NULL. */
typedef uint8_t *(*ram_locate_fn)(int index, uint32_t addr, uint32_t len, void *ctx);
/** Find every region (again: a core may move its memory – a state loaded, a console rebuilt). */
void ram_locate(struct ram_stream *rs, ram_locate_fn locate, void *ctx);
/** RAM: what changed since the last message (all of it after ram_resync). */
void ram_send(struct ram_stream *rs);
void ram_resync(struct ram_stream *rs);
/** A cheat: `len` bytes at `addr`, all inside one region – or nothing. */
bool ram_write(struct ram_stream *rs, uint32_t addr, const uint8_t *bytes, uint32_t len);
/** WATCH's payload: u32 count, count × { u32 addr, u32 len }. False (list unchanged) when it is malformed. */
bool ram_set_watch(struct ram_stream *rs, const uint8_t *p, uint32_t len);
/** WATCHED: the watched ranges' bytes as they are now (0 outside the regions), tagged with `frame`. */
void ram_send_watched(struct ram_stream *rs, uint32_t frame);
/** The regions as the loaded event lists them: {"addr":…,"len":…,"ok":…},… */
size_t ram_regions_json(const struct ram_stream *rs, char *out, size_t cap);

#ifdef __cplusplus
}
#endif

#endif
