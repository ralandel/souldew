// The rhythm of a native host's frame loop – see cadence.h.
#include "cadence.h"
#include "hostio.h"

void cadence_init(struct cadence *c, double fps, double now) {
  *c = (struct cadence){.fps = fps > 1 ? fps : 60.0, .next = now, .last_sram = now, .stat_t = now};
}

void cadence_restart(struct cadence *c, double now) { c->next = now; }

void cadence_frame(struct cadence *c) { c->stat_frames++; }

bool cadence_picture_due(struct cadence *c, bool turbo, double now) {
  if (turbo && now - c->last_picture < 1.0 / 62) return false;
  c->last_picture = now;
  return true;
}

void cadence_wait(struct cadence *c, float speed, double now) {
  if (speed >= CADENCE_MAX_SPEED) {
    c->next = now;
    return;
  }
  c->next += 1.0 / (c->fps * speed);
  if (c->next < now - 0.1) c->next = now; // fell behind: don't race to catch up
  double wait = c->next - now;
  if (wait > 0.1) wait = 0.1, c->next = now + 0.1;
  host_sleep(wait);
}

bool cadence_every(double *last, double period, double now) {
  if (now - *last < period) return false;
  *last = now;
  return true;
}

bool cadence_stats(struct cadence *c, double now, double *fps, double *speed) {
  if (now - c->stat_t < 0.25) return false;
  *fps = (double)c->stat_frames / (now - c->stat_t);
  *speed = *fps / c->fps;
  c->stat_t = now;
  c->stat_frames = 0;
  return true;
}

void sram_known(struct sram_watch *w, const void *p, size_t n) { w->sent = w->seen = host_fnv(HOST_FNV0, p, n); }

bool sram_due(struct sram_watch *w, const void *p, size_t n, bool force) {
  const uint64_t h = host_fnv(HOST_FNV0, p, n);
  const bool settled = h == w->seen;
  w->seen = h;
  if (h == w->sent || (!force && !settled)) return false;
  w->sent = h;
  return true;
}
