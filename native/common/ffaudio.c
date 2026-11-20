// A native host's sound out – see ffaudio.h. The fast-forward part is the 3DS host's (../ctr-host/ffsound.h), which
// takes the frame's samples from audio_buf / audio_n and sends with send_msg / send_event.
#include "ffaudio.h"
#include "hostio.h"
#include "protocol.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

static const int16_t *audio_buf; // the frame being fast-forwarded (ffsound.h reads it)
static size_t audio_n;           // int16 values (2 per stereo frame)
#define send_msg(type, p, n) host_send((type), (p), (n))
#define send_event host_event
// (0.2 s of the queue at most, as the fast player's host had it in 2.8.2: a native core holds its speed – it keeps
// FF_TMIN, 0.12 s; test/ctrffsound.test.mjs measures the code)
#define FF_TARGET 0.2
#include "../ctr-host/ffsound.h"

void ffa_init(struct ff_audio *fa, double sample_rate) {
  *fa = (struct ff_audio){.rate = sample_rate > 0 ? sample_rate : 32768, .k = 1};
  ff_reset(1);
}

void ffa_rate(struct ff_audio *fa, double rate) {
  if (rate <= 0 || (rate > fa->rate - 0.5 && rate < fa->rate + 0.5)) return;
  *fa = (struct ff_audio){.rate = rate, .k = 1, .last = fa->last};
  ff_reset(1); // (a turbo still on starts afresh with the next frame)
  host_event("{\"event\":\"audioRate\",\"sampleRate\":%.1f}", rate);
}

void ffa_frame(struct ff_audio *fa, const int16_t *s, size_t frames, bool turbo, double asked, double now) {
  if (turbo != fa->turbo) { // a fresh start for the sped-up sound: the asked-for speed until it is measured
    fa->turbo = turbo;
    ff_reset(turbo ? (asked > FF_MAXK ? FF_MAXK : asked < 1 ? 1 : asked) : 1);
    if (turbo) send_event("{\"event\":\"ffrate\",\"k\":%.4f}", ff.k);
  } else if (turbo && ff.kin > asked) {
    ff.kin = asked < 1 ? 1 : asked; // a slower step: the game won't go faster than asked (a faster one: measured as it comes)
  }
  if (!turbo) {
    if (frames) host_send(MSG_AUDIO, s, (uint32_t)(frames * 4));
  } else {
    audio_buf = s;
    audio_n = frames * 2;
    ff_frame(now - fa->last, fa->rate);
    audio_buf = NULL;
    audio_n = 0;
  }
  fa->k = turbo ? ff.k : 1;
  fa->holes = ff.holes;
  fa->last = now;
}

void ffa_idle(struct ff_audio *fa, double now) { fa->last = now; }

void ffa_measured(struct ff_audio *fa, double real) {
  (void)fa, (void)real;
}
