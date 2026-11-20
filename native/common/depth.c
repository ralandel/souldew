// The DS's 3D depth for Shared World (depth.h).
#include "depth.h"

#include <stdlib.h>
#include <string.h>
#include "hostio.h"
#include "protocol.h"

void depth_set(struct depth_req *d, const uint8_t *p, uint32_t len, depth_fn fn, void *ctx) {
  uint32_t n = 0;
  if (len >= 4) memcpy(&n, p, 4);
  if (n > DEPTH_MAX_RECTS || len < 4 + 8 * n) return;
  uint32_t px = 0;
  for (uint32_t i = 0; i < n; i++) {
    uint16_t w, h;
    memcpy(&w, p + 4 + 8 * i + 4, 2);
    memcpy(&h, p + 4 + 8 * i + 6, 2);
    if (!w || !h || w > 256 || h > 192) return;
    px += (uint32_t)w * h;
  }
  if (px > DEPTH_MAX_PIXELS) return;
  if (!d->buf && !(d->buf = malloc(8 + DEPTH_MAX_RECTS * 8 + DEPTH_MAX_PIXELS * 4))) return;
  for (uint32_t i = 0; i < n; i++) memcpy(&d->r[i], p + 4 + 8 * i, 8);
  d->n = (int)n;
  if (fn) fn(ctx, d->n > 0, 0, 0, 0, 0, NULL);
}

void depth_send(struct depth_req *d, uint32_t frame, depth_fn fn, void *ctx) {
  if (!d->n || !fn || !d->buf) return;
  uint8_t *p = d->buf + 8;
  int32_t flags = 0;
  for (int i = 0; i < d->n; i++) {
    memcpy(p, &d->r[i], 8); // (each rectangle says where it is: the page may have named others meanwhile)
    flags = fn(ctx, 1, d->r[i].x, d->r[i].y, d->r[i].w, d->r[i].h, (uint32_t *)(p + 8));
    if (flags <= 0) return; // (nothing kept yet, or no software renderer)
    p += 8 + (size_t)d->r[i].w * d->r[i].h * 4;
  }
  memcpy(d->buf, &frame, 4);
  memcpy(d->buf + 4, &flags, 4);
  host_send(MSG_DEPTH, d->buf, (uint32_t)(p - d->buf));
}
