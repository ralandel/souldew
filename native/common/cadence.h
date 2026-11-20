// The rhythm of a native host's frame loop, shared by both hosts: frame pacing at the speed souldew asked for (1× … 4×,
// "Max" = as fast as it goes), a picture about 60 times a second while fast-forwarding (not one per emulated frame),
// the RAM ten times a second whatever the speed, the battery save once it settled, and the real speed four times a
// second (the page measures it – the speed bar, the turbo mixer, the slow-computer hint).
#ifndef SOULDEW_CADENCE_H
#define SOULDEW_CADENCE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define CADENCE_MAX_SPEED 100.0f // SPEED at or above this: no pacing at all ("Max")

struct cadence {
  double fps;            // the system's frame rate
  double next;           // when the next frame is due
  double last_picture, last_ram, last_sram, stat_t;
  uint64_t stat_frames;  // frames since the last stats
  uint64_t shown;        // pictures sent in all (the host counts them)
};

void cadence_init(struct cadence *c, double fps, double now);
/** After a pause or a wait: the next frame is due now (no racing to catch up). */
void cadence_restart(struct cadence *c, double now);
/** A frame ran. */
void cadence_frame(struct cadence *c);
/** Should this frame's picture go out? Every frame at ≤ 1×; while fast-forwarding about 62 a second. */
bool cadence_picture_due(struct cadence *c, bool turbo, double now);
/** Sleep until the next frame is due at `speed` (never long: commands are read between frames). */
void cadence_wait(struct cadence *c, float speed, double now);
/** Due now? (`*last` is moved on when it is) */
bool cadence_every(double *last, double period, double now);
/** Four times a second: the frame rate and speed reached since the last time. False when it isn't time yet. */
bool cadence_stats(struct cadence *c, double now, double *fps, double *speed);

/**
 * A battery save is sent once it changed and then held still for one look (the games write it in steps – a half-
 * written save must never reach the run), or right away when forced (FLUSH, QUIT).
 */
struct sram_watch {
  uint64_t sent; // what souldew has
  uint64_t seen; // what the last look saw
};
/** souldew has these bytes (the save given at the start, the one a state carried). */
void sram_known(struct sram_watch *w, const void *p, size_t n);
/** True: send these bytes now. */
bool sram_due(struct sram_watch *w, const void *p, size_t n, bool force);

#ifdef __cplusplus
}
#endif

#endif
