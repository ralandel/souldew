// Picture and sound out of the souldew engine – see avout.h.
#include "avout.h"
#include "seats.h"
#include "../common/ffaudio.h"
#include "../common/hostio.h"
#include "../common/protocol.h"
#include "../common/ramstream.h"

#include <stdlib.h>
#include <string.h>

static uint8_t *frame_msg;
static size_t frame_cap;
static struct ff_audio ffa;
static int16_t *snd;      // the local seat's sound of one frame
static size_t snd_cap;    // stereo frames

void avout_reset(double sample_rate) { ffa_init(&ffa, sample_rate); }

int avout_screen_height(int seat) {
  const uint32_t *px;
  unsigned w, h, stride;
  B->video(seat, &px, &w, &h, &stride);
  return (int)h;
}

void avout_picture(int seat, struct ram_stream *rs, uint32_t frame) {
  const uint32_t *px;
  unsigned w, h, stride;
  B->video(seat, &px, &w, &h, &stride);
  const size_t need = 8 + (size_t)w * h * 2;
  if (need > frame_cap) {
    uint8_t *b = realloc(frame_msg, need);
    if (!b) return;
    frame_msg = b, frame_cap = need;
  }
  const uint16_t ww = (uint16_t)w, hh = (uint16_t)h;
  const uint32_t fmt = 2;
  memcpy(frame_msg, &ww, 2), memcpy(frame_msg + 2, &hh, 2), memcpy(frame_msg + 4, &fmt, 4);
  uint16_t *o = (uint16_t *)(frame_msg + 8);
  for (unsigned y = 0; y < h; y++) {
    const uint32_t *row = px + (size_t)y * stride;
    for (unsigned x = 0; x < w; x++) { // 0x00BBGGRR → RRRRRGGGGGGBBBBB
      const uint32_t c = row[x];
      *o++ = (uint16_t)(((c & 0xf8) << 8) | ((c >> 5) & 0x7e0) | ((c >> 19) & 0x1f));
    }
  }
  if (rs) ram_send_watched(rs, frame);
  host_send(MSG_VIDEO, frame_msg, (uint32_t)need);
}

void avout_sound(int local, bool play, bool turbo, double asked, double now) {
  if (!B->audio) return;
  size_t have = 0;
  for (int s = 0; s < seats_n; s++) {
    for (;;) {
      if (s == local && snd_cap - have < 1024) { // (room for more of the local seat's frame)
        int16_t *b = realloc(snd, (snd_cap + 4096) * 2 * sizeof *b);
        if (!b) break;
        snd = b, snd_cap += 4096;
      }
      static int16_t sink[4096 * 2];
      int16_t *to = s == local ? snd + have * 2 : sink;
      const size_t room = s == local ? snd_cap - have : 4096;
      const size_t n = B->audio(s, to, room);
      if (s == local) have += n;
      if (n < room) break;
    }
  }
  if (B->sample_rate) ffa_rate(&ffa, B->sample_rate()); // (a GBA game switches its sound rate after it boots)
  if (play) ffa_frame(&ffa, snd, have, turbo, asked, now);
  else ffa_idle(&ffa, now); // (drained, never played: no time the fast-forward sound owes)
}

void avout_idle(double now) { ffa_idle(&ffa, now); }

void avout_ff(double *k, unsigned *holes) { *k = ffa.k, *holes = ffa.holes; }

void avout_measured(double real) { ffa_measured(&ffa, real); }
