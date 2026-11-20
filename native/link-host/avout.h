// Picture and sound out of the souldew engine: the viewed seat's picture as RGB565 (16-bit: half the bytes of 32-bit
// pixels on the stream) right after the bytes the page watches for it, and the local seat's sound through the
// fast-forward sound (native/common/ffaudio.h) – the other seats' sound is drained, never played.
#ifndef SOULDEW_AVOUT_H
#define SOULDEW_AVOUT_H

#include <stdbool.h>
#include <stdint.h>

struct ram_stream;

/** A new seat set (its sound rate). */
void avout_reset(double sample_rate);
/** VIDEO of `seat` (after WATCHED: the page knows those bytes for exactly this picture). */
void avout_picture(int seat, struct ram_stream *rs, uint32_t frame);
/**
 * After a frame: every seat's sound is taken from the backend; the local seat's goes out (`play`: false in bench runs
 * and frames nobody is meant to hear), sped up while `turbo` (`asked`: the speed souldew asked for).
 */
void avout_sound(int local, bool play, bool turbo, double asked, double now);
/** The speed reached while fast-forwarding (four times a second) – the sound's ratio measures itself (ffaudio.h). */
void avout_measured(double real_speed);
/** No frame ran (paused, waiting for a peer): no time the fast-forward sound owes. */
void avout_idle(double now);
/** The fast-forward sound's ratio now and how often its queue ran dry (the stats event's ffk / ffHoles). */
void avout_ff(double *k, unsigned *holes);
/** The picture's height (the DS: 384, both screens) – the pointer is relative to it. */
int avout_screen_height(int seat);

#endif
