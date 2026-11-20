// A native host's sound out, frame by frame (AUDIO): as the console made it at normal speed; while fast-forwarding
// sped up by the speed really reached and resampled to exactly real time with a steady ratio – the 3DS host's
// fast-forward sound (native/ctr-host/ffsound.h, since 2.8.2), announced with EVENT ffrate {k} right before the first
// sound made with a new ratio, so souldew's turbo mixer (web/lib/turboaudio.mjs) slows it down again by exactly that
// ratio, or plays the game's music instead (Settings › sound while fast-forwarding).
#ifndef SOULDEW_FFAUDIO_H
#define SOULDEW_FFAUDIO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define FFA_MAX_SPEEDUP 16

struct ff_audio {
  double rate;     // stereo frames per second
  double last;     // when the last frame's sound came (host_now())
  bool turbo;
  double k;        // the ratio in use while fast-forwarding (1 otherwise) – for the stats event
  uint32_t holes;  // times the fast-forward queue ran dry (diagnostics: the stats event's ffHoles)
};

void ffa_init(struct ff_audio *fa, double sample_rate);
/**
 * The console's sound rate now (a GBA game switches its sound hardware to 65536 Hz after it boots – SOUNDBIAS): when it
 * differs from the one announced, the sound starts afresh at the new rate and the page hears of it (EVENT audioRate
 * {sampleRate}: it re-creates its audio context, as for a new loaded event's rate).
 */
void ffa_rate(struct ff_audio *fa, double sample_rate);
/**
 * One emulated frame's sound (`frames` interleaved stereo frames) out as AUDIO. `turbo`: fast-forwarding at `asked`
 * (the speed souldew asked for: where the ratio starts, and the most it follows). `now`: host_now().
 */
void ffa_frame(struct ff_audio *fa, const int16_t *s, size_t frames, bool turbo, double asked, double now);
/** No frame ran (paused, a link's wait): that time is no time the fast-forward sound owes. */
void ffa_idle(struct ff_audio *fa, double now);
/** The speed reached, measured over the last stats period (the ratio measures the sound coming in itself: unused). */
void ffa_measured(struct ff_audio *fa, double real_speed);

#ifdef __cplusplus
}
#endif

#endif
