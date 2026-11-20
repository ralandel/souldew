// The DS's 3D depth for Shared World, shared by both native hosts: the page names a few rectangles of the top screen
// (DEPTH: where it draws partners) and gets their depths with every picture (MSG_DEPTH, right before WATCHED), so a
// partner hides where the map is nearer – houses, trees, people – as the game's own sprites do. The depth comes from
// melonDS's software renderer with souldew's patch (native/melonds-patch): the frame on screen, kept when its rendering
// is done.
#ifndef SOULDEW_DEPTH_H
#define SOULDEW_DEPTH_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define DEPTH_MAX_RECTS 8
#define DEPTH_MAX_PIXELS 16384

/** The emulator's depth: `on` 0 stops keeping it; else copies a rectangle (24-bit depth per pixel) and returns its flags
 *  (1 | 2 W-buffered; 0 nothing kept yet; -1 not available). */
typedef int (*depth_fn)(void *ctx, int on, int x, int y, int w, int h, uint32_t *out);

struct depth_req {
  struct { int16_t x, y; uint16_t w, h; } r[DEPTH_MAX_RECTS];
  int n;
  uint8_t *buf;
};

/** DEPTH's payload: u32 count, count × { s16 x, s16 y, u16 w, u16 h } – kept unless malformed or too big; tells `fn`. */
void depth_set(struct depth_req *d, const uint8_t *p, uint32_t len, depth_fn fn, void *ctx);
/** MSG_DEPTH for this picture (nothing when no rectangle is asked for or the emulator has none). */
void depth_send(struct depth_req *d, uint32_t frame, depth_fn fn, void *ctx);

#ifdef __cplusplus
}
#endif
#endif
